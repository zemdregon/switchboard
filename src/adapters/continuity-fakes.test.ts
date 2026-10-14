/**
 * T5.2 "Done when" (FR-ADP-11, NFR-MAINT-01, FR-EXE-07): two fake providers for continuity tests. Both pass the
 * conformance suite (every `REQUIRED_CASE_KINDS` case, including `resume`); a test delegates to each through the run
 * lifecycle; the second is registered at runtime with `registerProvider` (no production source names it); each canary
 * path is reported to the test and lies outside every worktree, the data directory and the repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { missingRequiredKinds, REQUIRED_CASE_KINDS, runConformanceSuite } from "./conformance.js";
import {
  continuityConformanceCases,
  FIRST_FAKE_STATE_DIR,
  firstFake,
  SECOND_FAKE_ID,
  SECOND_FAKE_RESUME_FLAG,
  SECOND_FAKE_SESSION_ID,
  SECOND_FAKE_STATE_DIR,
  type StatefulFake,
  secondFake,
  secondFakeProvider,
} from "./fixtures/continuity-fakes.js";
import { providerEntry, registerProvider } from "./providers.js";
import { AdapterRegistry } from "./registry.js";
import type { ResolvedProfile } from "./types.js";

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
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** True when `p` is `dir` or lies under it. */
const under = (p: string, dir: string) => {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

let root: string;
let home: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;
let unregister: (() => void) | undefined;
const cwds: string[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cont-")));
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
  unregister = registerProvider(secondFakeProvider(home));
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  unregister?.();
  db.close();
  rmSync(root, { recursive: true, force: true });
  cwds.length = 0;
});

const makeCwd = () => {
  const d = mkdtempSync(path.join(root, "case-"));
  cwds.push(d);
  return d;
};

function startLifecycle(adapters: StatefulFake[]): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const registry = new AdapterRegistry();
  for (const a of adapters) registry.register(a);
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
  });
  lifecycle.start();
  return lifecycle;
}

describe("the second fake provider is registered by the test alone", () => {
  it("is absent from the built-in table until registered, and removal is exact", () => {
    expect(providerEntry(SECOND_FAKE_ID)).toBeDefined();
    unregister?.();
    unregister = undefined;
    expect(providerEntry(SECOND_FAKE_ID)).toBeUndefined();
  });
});

describe("both fakes pass the conformance suite", () => {
  for (const which of ["first", "second"] as const) {
    it(`${which} fake: every required case kind, including resume`, async () => {
      const cases = continuityConformanceCases(which, home, makeCwd);
      expect(missingRequiredKinds(cases)).toEqual([]);
      expect(cases.map((c) => c.kind)).toEqual(expect.arrayContaining([...REQUIRED_CASE_KINDS]));
      const report = await runConformanceSuite(cases);
      const failing = report.cases.flatMap((c) => c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name}`));
      expect(failing).toEqual([]);
      expect(report.ok).toBe(true);
    }, 30_000);
  }

  it("the second fake resumes with its own flag and reports its own session ids", async () => {
    const cases = continuityConformanceCases("second", home, makeCwd);
    const success = cases.find((c) => c.kind === "success");
    const resume = cases.find((c) => c.kind === "resume");
    expect(success?.expect.nativeSessionId).toBe(SECOND_FAKE_SESSION_ID);
    if (resume === undefined) throw new Error("no resume case");
    const inv = resume.adapter.resumeArgs(
      resume.binding ?? { provider: "fake", nativeSessionId: "x" },
      resume.request,
      resume.profile,
    );
    expect(inv && "argv" in inv ? inv.argv : []).toEqual(
      expect.arrayContaining([SECOND_FAKE_RESUME_FLAG, "fake-b-session-42"]),
    );
    expect(inv && "argv" in inv ? inv.argv : []).not.toContain("--resume");
    // A binding for the other provider is refused.
    const first = firstFake({ home });
    expect(
      secondFake({ home }).resumeArgs({ provider: first.id, nativeSessionId: "s" }, resume.request, resume.profile),
    ).toMatchObject({ ineligible: true });
  });
});

describe("a test delegates to each fake", () => {
  const specs = [
    { name: "first", make: firstFake, provider: "fake", dir: FIRST_FAKE_STATE_DIR, session: "fake-session-1" },
    {
      name: "second",
      make: secondFake,
      provider: SECOND_FAKE_ID,
      dir: SECOND_FAKE_STATE_DIR,
      session: SECOND_FAKE_SESSION_ID,
    },
  ] as const;

  for (const spec of specs) {
    it(`${spec.name} fake: canary and prompt under the provider state directory, outside worktree, data and repo`, async () => {
      const fake = spec.make({ home, timeouts: PATIENT });
      const lc = startLifecycle([fake]);
      const objective = `canary prompt for ${spec.name}`;
      const sub = await lc.submit({
        clientId: "client-a",
        objective,
        workspace: repo,
        trustProfile: "edit-untrusted",
        provider: spec.provider,
      });
      expect((await lc.waitForTerminal(sub.runId)).state).toBe("SUCCEEDED");

      // The canary path is reported to the test, and is the provider-state path under the temporary HOME.
      expect(fake.reports).toHaveLength(1);
      const report = fake.reports[0];
      if (report === undefined) throw new Error("no state report");
      const stateRoot = path.join(home, spec.dir);
      expect(report.session_id).toBe(spec.session);
      expect(report.canary_path).toBe(path.join(stateRoot, "sessions", `${spec.session}.jsonl`));
      expect(report.prompt_log).toBe(path.join(stateRoot, "prompts.log"));
      expect(existsSync(report.canary_path)).toBe(true);
      expect(JSON.parse(readFileSync(report.canary_path, "utf8"))).toEqual({
        canary: "switchboard-canary",
        session_id: spec.session,
      });
      expect(
        readFileSync(report.prompt_log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l)),
      ).toEqual([{ session_id: spec.session, prompt: objective }]);

      // The canary lies outside every worktree, the data directory and the repository.
      const run = ledger.getRunRecord(sub.runId);
      const worktrees = [run?.worktree_path ?? ""];
      expect(worktrees[0]).not.toBe("");
      for (const dir of [...worktrees, dataDir, repo]) {
        expect(under(report.canary_path, dir)).toBe(false);
        expect(under(report.prompt_log, dir)).toBe(false);
      }
      expect(under(report.canary_path, home)).toBe(true);

      // The native session id is the provider's own and is bound to the meta-session.
      expect(ledger.latestProviderBinding(sub.metaSessionId, spec.provider)?.native_session_id).toBe(spec.session);
    }, 30_000);

    it(`${spec.name} fake: a continuation resumes the same native session and its prompt is recorded`, async () => {
      const fake = spec.make({ home, timeouts: PATIENT });
      const lc = startLifecycle([fake]);
      const first = await lc.submit({
        clientId: "client-a",
        objective: "first prompt",
        workspace: repo,
        trustProfile: "edit-untrusted",
        provider: spec.provider,
      });
      expect((await lc.waitForTerminal(first.runId)).state).toBe("SUCCEEDED");
      const second = await lc.submit({
        clientId: "client-a",
        objective: "second prompt",
        metaSessionId: first.metaSessionId,
        trustProfile: "edit-untrusted",
        provider: spec.provider,
        resume: { nativeSessionId: spec.session },
      });
      expect((await lc.waitForTerminal(second.runId)).state).toBe("SUCCEEDED");
      expect(fake.reports.map((r) => r.session_id)).toEqual([spec.session, spec.session]);
      const prompts = readFileSync(path.join(home, spec.dir, "prompts.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { prompt: string });
      expect(prompts.map((p) => p.prompt)).toEqual(["first prompt", "second prompt"]);
    }, 30_000);
  }

  it("the two fakes keep separate state directories", async () => {
    const a = firstFake({ home, timeouts: PATIENT });
    const b = secondFake({ home, timeouts: PATIENT });
    const lc = startLifecycle([a, b]);
    for (const provider of ["fake", SECOND_FAKE_ID] as const) {
      const sub = await lc.submit({
        clientId: "client-a",
        objective: `to ${provider}`,
        workspace: repo,
        trustProfile: "edit-untrusted",
        provider,
      });
      expect((await lc.waitForTerminal(sub.runId)).state).toBe("SUCCEEDED");
    }
    expect(a.reports[0]?.canary_path).not.toBe(b.reports[0]?.canary_path);
    expect(existsSync(path.join(home, FIRST_FAKE_STATE_DIR, "sessions", "fake-session-1.jsonl"))).toBe(true);
    expect(existsSync(path.join(home, SECOND_FAKE_STATE_DIR, "sessions", `${SECOND_FAKE_SESSION_ID}.jsonl`))).toBe(
      true,
    );
  }, 30_000);
});
