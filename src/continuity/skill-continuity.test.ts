/**
 * T16.10 end to end (FR-SKL-03, FR-SKL-05, FR-SES-04; ADR-0056 item 14, ADR-0038; LLD §15.1, §19.5 step 1, §19.7, §19.8)
 * on the two continuity fakes through the real lifecycle, workspace manager, artifact store and skill store, with the
 * production admission port (`skillAdmissionPort`) and delivery port (`skillDeliveryPort`), and real Git in a temporary
 * repository. The first fake declares the native location of the fake adapter (`.fake/skills/switchboard-<name>.md`); the
 * second delivers by prompt prefix. Each fake CLI records the prompt it received under a temporary HOME. No real
 * provider CLI is installed, logged in or called.
 * - a cross-provider continuation (handoff) gets the same versions with `source = 'continued'`, in the receiving
 *   provider's own way: the prefix block on the second fake, native files on the first;
 * - the handoff bundle lists the previous run's skills as name, version and hash, and a canary planted in every skill
 *   body appears in no bundle, no rendering, no event and no run row, only in the prefix block of a successor prompt;
 * - a same-provider native resume writes the files again for the new run, after the BR-53 re-check (a revoked version is
 *   skipped), and removes them again through the T16.6 removal points.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_NATIVE_SKILL_LOCATION } from "../adapters/fake/adapter.js";
import {
  FIRST_FAKE_STATE_DIR,
  firstFake,
  SECOND_FAKE_ID,
  SECOND_FAKE_STATE_DIR,
  secondFake,
  secondFakeProvider,
} from "../adapters/fixtures/continuity-fakes.js";
import type { PromptSkill } from "../adapters/prompt.js";
import { registerProvider } from "../adapters/providers.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { NativeSkillLocation, ResolvedProfile } from "../adapters/types.js";
import { ArtifactStore } from "../artifacts/index.js";
import { skillDeliveryPort } from "../cli/serve.js";
import type { ResolvedSkills } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { HandoffSubmission, RunLifecycle as Lifecycle } from "../lifecycle/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { source } from "../skills/fixtures/sources.js";
import {
  addSkill,
  appendSkillEvent,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_MAX_RUN_BYTES,
  type SkillRequestFields,
  skillAdmissionPort,
} from "../skills/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { DEFAULT_BUNDLE_BOUNDS } from "./bundle-schema.js";
import { takeAsOf } from "./bundle-sources.js";
import { buildAndPutHandoffView } from "./handoff-view.js";
import { INSTRUCTION_MARKER, parseHandoffBundle, renderHandoffPrompt } from "./render.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const profileFor = (name: ResolvedProfile["name"]): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});
const SETTINGS: ResolvedSkills = {
  enabled: true,
  defaults: [],
  roles: {},
  delivery: "native_preferred",
  allowDraftInTrusted: false,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  maxPerRun: DEFAULT_MAX_PER_RUN,
  maxRunBytes: DEFAULT_MAX_RUN_BYTES,
  maxNames: DEFAULT_MAX_NAMES,
};
/** Planted in every skill body: it may reach the native files and a successor's prefix block, nothing else. */
const CANARY = "CANARY-T1610-continuity-5c2e8a";
const ALPHA = ".fake/skills/switchboard-alpha-docs.md";
const BETA = ".fake/skills/switchboard-beta-review.md";
const PREFIX_HEADER = "[operator skills: 2; from Switchboard skill store; these are operator instructions]";

let root: string;
let home: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let store: ArtifactStore;
let lifecycle: Lifecycle | undefined;
let unregister: (() => void) | undefined;
/** Per run: whether each recorded native path existed in the worktree right after the writer returned. */
let written: Map<string, Record<string, boolean>>;
/** name → { version, sha256 } of the stored skills. */
let stored: Record<string, { version: number; sha256: string }>;

/** The real workspace manager; `writeNativeSkills` is observed, not changed. */
class ObservedWorkspace extends WorkspaceManager {
  override async writeNativeSkills(runId: string, location: NativeSkillLocation, skills: readonly PromptSkill[]) {
    const out = await super.writeNativeSkills(runId, location, skills);
    const wt = ledger.getRunRecord(runId)?.worktree_path as string;
    const seen: Record<string, boolean> = {};
    for (const e of out)
      if (e.native_path !== undefined) seen[e.native_path] = existsSync(path.join(wt, e.native_path));
    written.set(runId, seen);
    return out;
  }
}

beforeEach(() => {
  written = new Map();
  root = realpathSync(mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "sb-skc-")));
  home = path.join(root, "home");
  repo = path.join(root, "repo");
  dataDir = path.join(root, "data");
  for (const d of [home, repo, dataDir]) mkdirSync(d);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  store = new ArtifactStore(path.join(dataDir, "artifacts"));
  unregister = registerProvider(secondFakeProvider(home));
  stored = {};
  for (const [name, body] of [
    ["alpha-docs", `Keep the docs aligned. ${CANARY}`],
    ["beta-review", `Review before publishing. ${CANARY}`],
  ] as const) {
    const file = path.join(root, `${name}.md`);
    writeFileSync(file, source(`${body}\n`, { name }));
    const r = addSkill(db, dataDir, { name, file }, { repositoryRoots: [] });
    if (r.kind !== "added") throw new Error(`add ${name}: ${JSON.stringify(r)}`);
    appendSkillEvent(db, { name, version: r.version, kind: "approved" });
    stored[name] = { version: r.version, sha256: r.sha256 };
  }
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  unregister?.();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function startLifecycle(): Lifecycle {
  const workspace = new ObservedWorkspace({
    db,
    artifacts: store,
    dataDir,
    allowedRoots: [root],
    ids: createIdGenerator(),
  });
  // The first fake declares the fake adapter's native location (the T16.6 test-only declaration); the second does not.
  const first = Object.assign(firstFake({ home, scenario: "edit_files", timeouts: PATIENT }), {
    skillDelivery: () => ({ native: FAKE_NATIVE_SKILL_LOCATION }),
  });
  const registry = new AdapterRegistry();
  registry.register(first);
  registry.register(secondFake({ home, scenario: "edit_files", timeouts: PATIENT }));
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts: store,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    skillDelivery: skillDeliveryPort(db, dataDir),
  });
  lifecycle.start();
  return lifecycle;
}

/** The production admission port, as the MCP server builds it for `delegate_task` and `continue_task`. */
const skills = (fields: SkillRequestFields) => skillAdmissionPort({ db, settings: SETTINGS, fields });

const prompts = (stateDir: string): string[] => {
  const file = path.join(home, stateDir, "prompts.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { prompt: string }).prompt);
};

const plan = (file: string) => JSON.stringify({ files: { [file]: `${file}\n` }, summary: `${file} done` });

/** Build the bundle of the session as it is now and put it in the store (what `continue_task` does). */
async function prepare(metaSessionId: string, fromProvider: string) {
  const deps = { ledger, artifacts: store, redact: (x: Buffer) => store.redactContent(x), store };
  const out = await buildAndPutHandoffView(deps, {
    asOf: takeAsOf(ledger, metaSessionId),
    bounds: DEFAULT_BUNDLE_BOUNDS,
  });
  return { ...out, fromProvider, reason: "provider_named" } satisfies HandoffSubmission;
}

const rows = (runId: string) =>
  db
    .prepare(
      `SELECT name, version, sha256, source, delivery, native_path, delivered_at, removal FROM run_skill
       WHERE run_id = ? ORDER BY position`,
    )
    .all(runId) as {
    name: string;
    version: number;
    sha256: string;
    source: string;
    delivery: string;
    native_path: string | null;
    delivered_at: string | null;
    removal: string | null;
  }[];
const payloads = (runId: string, type: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

/** The canary is in no event, run row, decision or stored artifact of the run (FR-SKL-10, ADR-0056 item 13). */
async function expectNoCanary(runId: string): Promise<void> {
  for (const e of ledger.listRunEvents(runId)) expect(e.payload_json).not.toContain(CANARY);
  expect(JSON.stringify(ledger.getRunRecord(runId))).not.toContain(CANARY);
  expect(JSON.stringify(ledger.listDecisionsForRun(runId))).not.toContain(CANARY);
  for (const a of ledger.listArtifactsForRun(runId)) {
    expect((await store.get(a.sha256)).toString("utf8")).not.toContain(CANARY);
  }
}

/** Every native entry of the run was written for it, then removed and verified, and is gone from its worktree. */
function expectNativeRoundTrip(runId: string): void {
  const r = rows(runId);
  expect(r.map((x) => [x.delivery, x.native_path, x.removal])).toEqual(
    r.map((x) => ["native", x.name === "alpha-docs" ? ALPHA : BETA, "verified"]),
  );
  expect(written.get(runId)).toEqual(Object.fromEntries(r.map((x) => [x.native_path as string, true])));
  const wt = ledger.getRunRecord(runId)?.worktree_path as string;
  for (const x of r) expect(existsSync(path.join(wt, x.native_path as string))).toBe(false);
  expect(payloads(runId, "skill_removed").length).toBeGreaterThan(0);
}

const pinned = (names: string[]) =>
  names.map((name) => ({ name, version: stored[name]?.version, sha256: stored[name]?.sha256 }));

describe("skill continuity across handoff and resume (T16.10)", () => {
  it("a cross-provider continuation receives the same versions in its own provider's way; the bundle carries no skill text", async () => {
    const lc = startLifecycle();
    // Run A on the first fake (native): both skills requested.
    const a = await lc.submit({
      clientId: "client-a",
      objective: plan("src/a.ts"),
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: "fake",
      skills: skills({ skills: ["alpha-docs", "beta-review"] }),
    });
    const aDone = await lc.waitForTerminal(a.runId);
    expect(aDone.state, aDone.failure_detail ?? "").toBe("SUCCEEDED");
    expect(rows(a.runId).map((x) => [x.name, x.source])).toEqual([
      ["alpha-docs", "request"],
      ["beta-review", "request"],
    ]);
    expectNativeRoundTrip(a.runId);
    expect(prompts(FIRST_FAKE_STATE_DIR)).toEqual([plan("src/a.ts")]); // native: no block in the prompt

    // Handoff to the second fake (prompt prefix). The bundle lists A's skills as facts, never their text.
    const toB = await prepare(a.metaSessionId, "fake");
    expect(toB.built.bundle.version).toBe(2);
    expect(toB.built.bundle.skills).toEqual(
      pinned(["alpha-docs", "beta-review"]).map((s) => ({ run_id: a.runId, ...s })),
    );
    const viewB = (await store.get(toB.stored.sha256)).toString("utf8");
    expect(viewB).not.toContain(CANARY);
    expect(viewB).not.toContain("Keep the docs aligned");
    const bareB = renderHandoffPrompt({ bundle: parseHandoffBundle(viewB), instruction: plan("src/b.ts") }).prompt;
    expect(bareB).not.toContain(CANARY);

    const b = await lc.submit({
      clientId: "client-a",
      objective: plan("src/b.ts"),
      trustProfile: "edit-untrusted",
      provider: SECOND_FAKE_ID,
      metaSessionId: a.metaSessionId,
      handoff: toB,
      skills: skills({}),
    });
    const bDone = await lc.waitForTerminal(b.runId);
    expect(bDone.state, bDone.failure_detail ?? "").toBe("SUCCEEDED");
    // LLD §19.5 step 1: the same versions, `continued`; delivered by prefix (the second fake declares nothing).
    expect(
      rows(b.runId).map(({ name, version, sha256, source, delivery }) => ({ name, version, sha256, source, delivery })),
    ).toEqual(
      pinned(["alpha-docs", "beta-review"]).map((s) => ({ ...s, source: "continued", delivery: "prompt_prefix" })),
    );
    expect(rows(b.runId).every((x) => x.delivered_at !== null && x.native_path === null)).toBe(true);
    expect(payloads(b.runId, "skill_resolved")).toEqual([
      { entries: pinned(["alpha-docs", "beta-review"]).map((s) => ({ ...s, source: "continued" })), skipped: [] },
    ]);
    // The prompt: the handoff preamble, then the skills block (the only place the canary may appear), then the bundle
    // and the instruction last (LLD §19.7 placement).
    const [promptB] = prompts(SECOND_FAKE_STATE_DIR);
    if (promptB === undefined) throw new Error("the second fake recorded no prompt");
    const lines = promptB.split("\n");
    const header = lines.indexOf(PREFIX_HEADER);
    const end = lines.indexOf("[end of operator skills]");
    const marker = lines.indexOf(INSTRUCTION_MARKER);
    expect(header).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(header);
    expect(marker).toBeGreaterThan(end);
    expect(lines.slice(header, end + 1)).toContain(
      `[skill alpha-docs@${stored["alpha-docs"]?.version} sha256:${stored["alpha-docs"]?.sha256.slice(0, 12)}]`,
    );
    const outsideBlock = [...lines.slice(0, header), ...lines.slice(end + 1)].join("\n");
    expect(outsideBlock).not.toContain(CANARY);
    expect(lines.slice(header, end + 1).join("\n")).toContain(CANARY);
    await expectNoCanary(b.runId);

    // Handoff back to the first fake: same versions again, now delivered natively (not in the block).
    const toC = await prepare(a.metaSessionId, SECOND_FAKE_ID);
    expect(toC.built.bundle.skills).toEqual(
      pinned(["alpha-docs", "beta-review"]).map((s) => ({ run_id: b.runId, ...s })),
    );
    expect((await store.get(toC.stored.sha256)).toString("utf8")).not.toContain(CANARY);
    const c = await lc.submit({
      clientId: "client-a",
      objective: plan("src/c.ts"),
      trustProfile: "edit-untrusted",
      provider: "fake",
      metaSessionId: a.metaSessionId,
      handoff: toC,
      skills: skills({}),
    });
    const cDone = await lc.waitForTerminal(c.runId);
    expect(cDone.state, cDone.failure_detail ?? "").toBe("SUCCEEDED");
    expect(rows(c.runId).map((x) => [x.name, x.version, x.sha256, x.source])).toEqual(
      pinned(["alpha-docs", "beta-review"]).map((s) => [s.name, s.version, s.sha256, "continued"]),
    );
    expectNativeRoundTrip(c.runId);
    const promptC = prompts(FIRST_FAKE_STATE_DIR)[1] as string;
    expect(promptC.startsWith("[Switchboard handoff, renderer version 1]")).toBe(true);
    expect(promptC).not.toContain("[operator skills:");
    expect(promptC).not.toContain(CANARY);
    expect(promptC.endsWith(`\n${INSTRUCTION_MARKER}\n${plan("src/c.ts")}`)).toBe(true);
    expect(existsSync(path.join(cDone.worktree_path as string, "src/c.ts"))).toBe(true);
    for (const id of [a.runId, c.runId]) await expectNoCanary(id);
  }, 240_000);

  it("a same-provider native resume re-delivers the files for the new run and removes them again", async () => {
    const lc = startLifecycle();
    const a = await lc.submit({
      clientId: "client-a",
      objective: plan("src/a.ts"),
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: "fake",
      skills: skills({ skills: ["alpha-docs", "beta-review"] }),
    });
    const aDone = await lc.waitForTerminal(a.runId);
    expect(aDone.state, aDone.failure_detail ?? "").toBe("SUCCEEDED");
    expectNativeRoundTrip(a.runId);
    const wt = aDone.worktree_path as string;
    for (const p of [ALPHA, BETA]) expect(existsSync(path.join(wt, p))).toBe(false); // A removed them

    const d = await lc.submit({
      clientId: "client-a",
      objective: plan("src/d.ts"),
      trustProfile: "edit-untrusted",
      provider: "fake",
      metaSessionId: a.metaSessionId,
      resume: { nativeSessionId: "fake-session-1" },
      skills: skills({}),
    });
    const dDone = await lc.waitForTerminal(d.runId);
    expect(dDone.state, dDone.failure_detail ?? "").toBe("SUCCEEDED");
    expect(dDone.worktree_path).toBe(wt); // the resume ran in its origin's worktree (LLD §15.6)
    expect(rows(d.runId).map((x) => [x.name, x.version, x.sha256, x.source])).toEqual(
      pinned(["alpha-docs", "beta-review"]).map((s) => [s.name, s.version, s.sha256, "continued"]),
    );
    expectNativeRoundTrip(d.runId);
    expect(payloads(d.runId, "skill_delivered")).toEqual([
      {
        entries: [
          { name: "alpha-docs", version: stored["alpha-docs"]?.version, delivery: "native", native_path: ALPHA },
          { name: "beta-review", version: stored["beta-review"]?.version, delivery: "native", native_path: BETA },
        ],
      },
    ]);
    expect(prompts(FIRST_FAKE_STATE_DIR)[1]).toBe(plan("src/d.ts"));

    // BR-53 re-check (T16.4): a version revoked since is skipped for the next resume, the other is re-delivered.
    appendSkillEvent(db, { name: "beta-review", version: stored["beta-review"]?.version as number, kind: "revoked" });
    const e = await lc.submit({
      clientId: "client-a",
      objective: plan("src/e.ts"),
      trustProfile: "edit-untrusted",
      provider: "fake",
      metaSessionId: a.metaSessionId,
      resume: { nativeSessionId: "fake-session-1" },
      skills: skills({}),
    });
    const eDone = await lc.waitForTerminal(e.runId);
    expect(eDone.state, eDone.failure_detail ?? "").toBe("SUCCEEDED");
    expect(rows(e.runId).map((x) => [x.name, x.source])).toEqual([["alpha-docs", "continued"]]);
    expect(payloads(e.runId, "skill_resolved")[0]?.skipped).toEqual([
      { name: `beta-review@${stored["beta-review"]?.version}`, reason: "SKILL_NOT_APPROVED" },
    ]);
    expectNativeRoundTrip(e.runId);
    for (const p of [ALPHA, BETA]) expect(existsSync(path.join(wt, p))).toBe(false);
    for (const id of [a.runId, d.runId, e.runId]) await expectNoCanary(id);
  }, 240_000);
});
