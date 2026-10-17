/**
 * T16.6 end to end (FR-SKL-05, FR-SKL-06, FR-SKL-10, FR-GIT-02; LLD §19.6, §19.8, §19.11; TDD §3.16.2 properties 2, 4, 5
 * and 6): the fake adapter declares its native location (`.fake/skills/switchboard-<name>.md`), the lifecycle writes the
 * run's skills there before spawn, and the fake agent edits, renames and `git add`s its skill files and calls the real
 * injected `commit` tool through the shim. Real Git in temporary repositories; no provider CLI, login or network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type Ineligible,
  type Invocation,
  type ResolvedProfile,
} from "../adapters/index.js";
import type { PromptSkill } from "../adapters/prompt.js";
import { ArtifactStore } from "../artifacts/index.js";
import { needsAttentionOf } from "../control/needs-attention.js";
import { ChannelOpenError, GitToolService } from "../git/channel.js";
import { GitPublisher, publishRefFor } from "../git/index.js";
import { GitPusher } from "../git/push.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { runRetentionGc, WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle, type SkillAdmissionPort, type SkillDeliveryPort } from "./index.js";

const SHORT_TMP = process.platform === "darwin" ? "/tmp" : tmpdir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "cli", "bin.ts");
const TS_REGISTER = path.join(HERE, "..", "reconcile", "fixtures", "ts-register.mjs");
const SHIM_COMMAND = [
  process.execPath,
  "--experimental-transform-types",
  "--no-warnings",
  "--import",
  TS_REGISTER,
  BIN,
  "tool-shim",
];
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
/** A planted canary in every body (TDD §3.16.2 property 6): it must reach the files and nothing else. */
const CANARY = "CANARY-T166-6b1f0c";
const SKILLS: PromptSkill[] = [
  { name: "alpha-docs", version: 1, sha256: "a".repeat(64), body: `Alpha body ${CANARY}.\n` },
  { name: "beta-review", version: 2, sha256: "b".repeat(64), body: `Beta body ${CANARY}.\n` },
];
const ALPHA = ".fake/skills/switchboard-alpha-docs.md";
const BETA = ".fake/skills/switchboard-beta-review.md";

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let service: GitToolService;
let lifecycle: RunLifecycle | undefined;
/** Invocations the adapter compiled, by run (argv and environment comparison). */
let compiled: Map<string, Invocation>;

function project(): ProjectSnapshot {
  return {
    id: "web",
    name: "Web",
    environment_kind: "host",
    context_id: "main",
    base_ref: "main",
    effective_max_profile: "edit-untrusted",
    writable: true,
    identity: { name: "Ada Maintainer", email: "ada@example.test" },
    push: { policy: "none" },
  };
}

/** The lifecycle's skill port over in-memory bodies (the production port reads the store, `skillDeliveryPort`). */
const port: SkillDeliveryPort = {
  load: (runId) => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM run_skill WHERE run_id = ?").get(runId) as { n: number }).n;
    return SKILLS.slice(0, n);
  },
  record: (runId, delivery, at) => {
    db.prepare("UPDATE run_skill SET delivery = ?, delivered_at = ? WHERE run_id = ?").run(delivery, at, runId);
  },
};

/** Admission stand-in: pins both skills with the run (`run_skill` rows and the `skill_resolved` event). */
const admission: SkillAdmissionPort = {
  fields: { skills: SKILLS.map((s) => s.name) },
  resolve: () => ({
    event: { entries: SKILLS.map((s) => ({ name: s.name, version: s.version, sha256: s.sha256, source: "request" })) },
    write: (runId) => {
      SKILLS.forEach((s, i) => {
        db.prepare(
          `INSERT INTO run_skill (run_id, position, name, version, sha256, source, delivery)
           VALUES (?, ?, ?, ?, ?, 'request', 'prompt_prefix')`,
        ).run(runId, i, s.name, s.version, s.sha256);
      });
    },
  }),
};

/** The real fake adapter; only `compile` is extended, to keep what it produced. */
class CapturingFake extends FakeAdapter {
  override compile(req: CompileRequest, p: ResolvedProfile): Invocation | Ineligible {
    const inv = super.compile(req, p);
    if (!("ineligible" in inv)) compiled.set(req.runId, inv);
    return inv;
  }
}

interface Make {
  scenario?: FakeScenario;
  nativeSkills?: boolean;
  mode?: "native_preferred" | "prefix_only";
  failUnlinks?: number;
  gitTools?: "service" | "none" | "broken";
}

function makeLifecycle(o: Make = {}): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  let failures = o.failUnlinks ?? 0;
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir,
    allowedRoots: [root],
    ids,
    nativeSkillFs: {
      unlink: async (file) => {
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("injected"), { code: "EACCES" });
        }
        const { unlink } = await import("node:fs/promises");
        await unlink(file);
      },
    },
  });
  const adapter = new CapturingFake({
    scenario: o.scenario ?? "git_attempts",
    nativeSkills: o.nativeSkills ?? true,
    ...((o.scenario ?? "").startsWith("hang") ? {} : { timeouts: PATIENT }),
  });
  const tools =
    o.gitTools === "none"
      ? {}
      : o.gitTools === "broken"
        ? {
            gitTools: {
              pushAvailable: false,
              open: async () => {
                throw new ChannelOpenError("injected channel failure");
              },
            } as unknown as GitToolService,
          }
        : { gitTools: service };
  const lc = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: () => PROFILE,
    skillDelivery: port,
    ...(o.mode ? { skillDeliveryMode: o.mode } : {}),
    ...tools,
  });
  lc.start();
  lifecycle = lc;
  return lc;
}

async function runPlan(
  lc: RunLifecycle,
  objective: string,
  extra: { verificationCommands?: string[][]; skills?: boolean } = {},
) {
  const { runId, metaSessionId } = await lc.submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    project: project(),
    ...(extra.skills === false ? {} : { skills: admission }),
    ...(extra.verificationCommands ? { verificationCommands: extra.verificationCommands } : {}),
  });
  return { runId, metaSessionId, done: await lc.waitForTerminal(runId) };
}

const plan = (steps: unknown[], hang = false) => JSON.stringify({ steps, hang });
const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const ofType = (runId: string, type: string) => events(runId).filter((e) => e.type === type);
const rows = (runId: string) =>
  db
    .prepare(
      `SELECT name, delivery, native_path, written_sha256, delivered_at, removed_at, removal FROM run_skill
       WHERE run_id = ? ORDER BY position`,
    )
    .all(runId) as {
    name: string;
    delivery: string;
    native_path: string | null;
    written_sha256: string | null;
    delivered_at: string | null;
    removed_at: string | null;
    removal: string | null;
  }[];
const worktreeOf = (runId: string) => ledger.getRunRecord(runId)?.worktree_path as string;
const treeOf = (rev: string) => g(repo, "ls-tree", "-r", "--name-only", rev).split("\n");

/** No ledger row of the run carries a skill body (TDD §3.16.2 property 6). */
function expectNoCanary(runId: string): void {
  for (const e of ledger.listRunEvents(runId)) expect(e.payload_json).not.toContain(CANARY);
  const run = ledger.getRunRecord(runId);
  expect(JSON.stringify(run)).not.toContain(CANARY);
}

beforeEach(() => {
  compiled = new Map();
  root = realpathSync(mkdtempSync(path.join(SHORT_TMP, "sb-nsk-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  execFileSync("sh", ["-c", "printf 'hello\\n' > README.md"], { cwd: repo });
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  const publisher = new GitPublisher({ db, scratchDir: path.join(dataDir, "git-scratch") });
  service = new GitToolService({ db, dataDir, publisher, shimCommand: SHIM_COMMAND, fallbackDirs: [root] });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  await service.closeAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("native skill delivery and leak prevention (T16.6)", () => {
  it("edited, renamed and staged skill files never reach a commit, checkpoint, artifact or changed_files; gone before VERIFYING", async () => {
    const lc = makeLifecycle();
    const steps = [
      { op: "append", path: ALPHA, content: "agent edit\n" },
      { op: "add", path: ALPHA },
      { op: "write", path: "feature.txt", content: "feature\n" },
      // `commit` with no paths: everything changed (`add -A`) except the recorded paths.
      { op: "tool_commit", arguments: { message: "Add the feature" } },
      // `commit` naming the skill file explicitly, with a real change: the skill file is left out.
      { op: "write", path: "second.txt", content: "second\n" },
      { op: "tool_commit", arguments: { message: "Add second", paths: [ALPHA, "second.txt"] } },
      // `commit` naming only the skill file: nothing left to commit.
      { op: "tool_commit", arguments: { message: "Only the skill", paths: [ALPHA] } },
      // R-69: a renamed copy is not detected (it is ordinary content now); the recorded path is still excluded.
      { op: "rename", from: BETA, to: "notes/moved.md" },
    ];
    // Verification runs after removal point 1: the command fails if a recorded path is still there.
    const probe = `process.exit(${JSON.stringify([ALPHA, BETA])}.some((p) => require("fs").existsSync(p)) ? 1 : 0)`;
    const { runId, metaSessionId, done } = await runPlan(lc, plan(steps), {
      verificationCommands: [[process.execPath, "-e", probe]],
    });
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

    // Delivery: both entries native, recorded with the written hash; the prompt carries no block (the plan parsed).
    const delivered = ofType(runId, "skill_delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.p.entries).toEqual([
      { name: "alpha-docs", version: 1, delivery: "native", native_path: ALPHA },
      { name: "beta-review", version: 2, delivery: "native", native_path: BETA },
    ]);
    const stdin = compiled.get(runId)?.stdin;
    expect(stdin).toEqual({ kind: "text", value: plan(steps) });

    // The commit tool: two commits, neither containing a recorded path.
    const pub = publishRefFor(metaSessionId);
    expect(g(repo, "rev-list", "--count", `main..${pub}`)).toBe("2");
    for (const sha of g(repo, "rev-list", `main..${pub}`).split("\n")) {
      const tree = treeOf(sha);
      expect(tree).not.toContain(ALPHA);
      expect(tree).not.toContain(BETA);
    }
    expect(treeOf(pub)).toEqual(expect.arrayContaining(["feature.txt", "second.txt"]));

    // Checkpoint, artifacts and changed_files: the renamed copy is there (R-69), the recorded paths are not.
    const post = ledger.getRunCheckpointCommit(runId, "post") as string;
    expect(treeOf(post)).toEqual(expect.arrayContaining(["feature.txt", "notes/moved.md"]));
    expect(treeOf(post)).not.toContain(ALPHA);
    expect(treeOf(post)).not.toContain(BETA);
    const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
    for (const a of ledger.listArtifactsForRun(runId).filter((x) => x.kind === "diff" || x.kind === "changed_files")) {
      const text = (await artifacts.get(a.sha256)).toString("utf8");
      expect(text).not.toContain("switchboard-alpha-docs");
      expect(text).not.toContain("switchboard-beta-review");
    }
    const changed = (
      await artifacts.get(ledger.listArtifactsForRun(runId).find((x) => x.kind === "changed_files")?.sha256 as string)
    ).toString("utf8");
    expect(JSON.parse(changed)).toEqual(expect.arrayContaining([{ status: "A", path: "notes/moved.md" }]));

    // Removal point 1, before VERIFYING: alpha was edited (tampered), beta was moved away (nothing left to remove).
    const types = events(runId).map((e) => e.type);
    const removed = ofType(runId, "skill_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.p).toEqual({
      point: "before_verifying",
      entries: [
        { name: "alpha-docs", native_path: ALPHA, removal: "verified" },
        { name: "beta-review", native_path: BETA, removal: "verified" },
      ],
    });
    const verifying = events(runId).findIndex((e) => e.type === "state_transition" && e.p.to === "VERIFYING");
    expect(types.indexOf("skill_removed")).toBeLessThan(verifying);
    const tampered = ofType(runId, "skill_tampered");
    expect(tampered).toHaveLength(1);
    expect(tampered[0]?.p).toMatchObject({ name: "alpha-docs", native_path: ALPHA });
    expect(tampered[0]?.p.found_sha256).not.toBe(tampered[0]?.p.written_sha256);
    for (const r of rows(runId)) {
      expect(r).toMatchObject({ delivery: "native", removal: "verified" });
      expect(r.written_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(r.delivered_at).not.toBeNull();
      expect(r.removed_at).not.toBeNull();
    }
    expect(existsSync(path.join(worktreeOf(runId), ALPHA))).toBe(false);
    expect(needsAttentionOf(ledger, done, { now: new Date() })).toEqual({ active: false });
    expectNoCanary(runId);
  }, 90_000);

  it("argv, environment and prompt are byte-identical with and without native skills (LLD §19.6)", async () => {
    const lc = makeLifecycle({ gitTools: "none" });
    const steps = [{ op: "write", path: "probe.txt", content: "x\n" }];
    const withSkills = await runPlan(lc, plan(steps));
    const without = await runPlan(lc, plan(steps), { skills: false });
    expect(withSkills.done.state).toBe("SUCCEEDED");
    expect(without.done.state).toBe("SUCCEEDED");
    expect(rows(withSkills.runId).map((r) => r.delivery)).toEqual(["native", "native"]);
    const a = compiled.get(withSkills.runId) as Invocation;
    const b = compiled.get(without.runId) as Invocation;
    expect(a.argv).toEqual(b.argv);
    expect(a.env).toEqual(b.env);
    expect(a.envAllowlist).toEqual(b.envAllowlist);
    expect(a.policyFlags).toEqual(b.policyFlags);
    expect(a.stdin).toEqual(b.stdin);
  }, 90_000);

  it("is gone after each terminal state: FAILED, CANCELLED, a failure before spawn, and a retried removal at terminal entry", async () => {
    // FAILED after the provider ran (removal point 1).
    let lc = makeLifecycle({ scenario: "task_failure", gitTools: "none" });
    const failed = await runPlan(lc, "fail");
    expect(failed.done.state).toBe("FAILED");
    expect(rows(failed.runId).map((r) => r.removal)).toEqual(["verified", "verified"]);
    expect(existsSync(path.join(worktreeOf(failed.runId), ALPHA))).toBe(false);

    // CANCELLED while the provider runs (removal point 1 after the group is gone).
    await lifecycle?.shutdown();
    lc = makeLifecycle({ scenario: "hang", gitTools: "none" });
    const hang = await lc.submit({
      clientId: "c",
      objective: "hang",
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: "fake",
      project: project(),
      skills: admission,
    });
    const pending = lc.waitForTerminal(hang.runId);
    const until = Date.now() + 20_000;
    while (ledger.getRunRecord(hang.runId)?.state !== "RUNNING" && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(path.join(worktreeOf(hang.runId), ALPHA))).toBe(true);
    await lc.cancel(hang.runId);
    expect((await pending).state).toBe("CANCELLED");
    expect(rows(hang.runId).map((r) => r.removal)).toEqual(["verified", "verified"]);
    expect(existsSync(path.join(worktreeOf(hang.runId), ALPHA))).toBe(false);
    await lifecycle?.shutdown();

    // FAILED before spawn, after the files were written: removal point 2 (terminal entry).
    lc = makeLifecycle({ gitTools: "broken" });
    const early = await runPlan(lc, plan([]));
    expect(early.done.state).toBe("FAILED");
    expect(ledger.getRunRecord(early.runId)?.pid ?? null).toBeNull();
    expect(rows(early.runId).map((r) => r.removal)).toEqual(["verified", "verified"]);
    expect(ofType(early.runId, "skill_removed").map((e) => e.p.point)).toEqual(["terminal"]);
    expect(existsSync(path.join(worktreeOf(early.runId), ALPHA))).toBe(false);
    await lifecycle?.shutdown();

    // A failed unlink at point 1 is retried at terminal entry, which verifies it.
    lc = makeLifecycle({ gitTools: "none", failUnlinks: 1 });
    const retried = await runPlan(lc, plan([]));
    expect(retried.done.state).toBe("SUCCEEDED");
    const removed = ofType(retried.runId, "skill_removed");
    expect(removed.map((e) => e.p.point)).toEqual(["before_verifying", "terminal"]);
    expect((removed[0]?.p.entries as { removal: string }[] | undefined)?.map((e) => e.removal)).toEqual([
      "failed",
      "verified",
    ]);
    expect(ofType(retried.runId, "skill_cleanup_failed").map((e) => e.p)).toEqual([
      { name: "alpha-docs", native_path: ALPHA, errno: "EACCES" },
    ]);
    expect(rows(retried.runId).map((r) => r.removal)).toEqual(["verified", "verified"]);
    expect(needsAttentionOf(ledger, ledger.getRunRecord(retried.runId) as never, { now: new Date() })).toEqual({
      active: false,
    });
    for (const r of [failed, hang, early, retried]) expectNoCanary(r.runId);
  }, 120_000);

  it("prefix_only and a cell without a native declaration deliver as a prompt prefix and write nothing", async () => {
    for (const o of [{ mode: "prefix_only" as const }, { nativeSkills: false }]) {
      const lc = makeLifecycle({ ...o, scenario: "success", gitTools: "none" });
      const { runId, done } = await runPlan(lc, "do it");
      expect(done.state).toBe("SUCCEEDED");
      expect(rows(runId).map((r) => [r.delivery, r.native_path])).toEqual([
        ["prompt_prefix", null],
        ["prompt_prefix", null],
      ]);
      const stdin = compiled.get(runId)?.stdin as { value: string };
      expect(stdin.value.startsWith("[operator skills: 2;")).toBe(true);
      expect(existsSync(path.join(worktreeOf(runId), ".fake"))).toBe(false);
      expect(ofType(runId, "skill_removed")).toEqual([]);
      await lifecycle?.shutdown();
    }
  }, 90_000);

  it("a failed removal flags skill_cleanup_failed and refuses push until retention GC removes the file", async () => {
    const lc = makeLifecycle({ gitTools: "none", failUnlinks: 1_000 });
    const { runId, metaSessionId, done } = await runPlan(
      lc,
      plan([
        { op: "add", path: ALPHA },
        { op: "write", path: "work.txt", content: "work\n" },
      ]),
    );
    expect(done.state).toBe("SUCCEEDED");
    await lifecycle?.shutdown();
    lifecycle = undefined;
    expect(rows(runId).map((r) => r.removal)).toEqual(["failed", "failed"]);
    expect(ofType(runId, "skill_removed").map((e) => e.p.point)).toEqual(["before_verifying", "terminal"]);
    expect(ofType(runId, "skill_cleanup_failed")).toHaveLength(4);
    expect(existsSync(path.join(worktreeOf(runId), ALPHA))).toBe(true);
    expect(needsAttentionOf(ledger, ledger.getRunRecord(runId) as never, { now: new Date() })).toEqual({
      active: true,
      reason: "skill_cleanup_failed",
    });
    // The checkpoint left the still-present (and agent-staged) files out, and the artifacts with it.
    const post = treeOf(ledger.getRunCheckpointCommit(runId, "post") as string);
    expect(post).toContain("work.txt");
    expect(post).not.toContain(ALPHA);
    expect(post).not.toContain(BETA);
    const store = new ArtifactStore(path.join(dataDir, "artifacts"));
    for (const a of ledger.listArtifactsForRun(runId).filter((x) => x.kind === "diff" || x.kind === "changed_files")) {
      expect((await store.get(a.sha256)).toString("utf8")).not.toContain("switchboard-");
    }

    const pusher = new GitPusher({
      db,
      resolveContext: () => ({ projectId: "web", contextId: "main", path: repo, baseRef: "main", policy: "branch" }),
    });
    const refused = await pusher.push({ metaSessionId, requestedBy: "operator" });
    expect(refused).toMatchObject({ pushed: false, outcome: "REFUSED_POLICY", reason: "SKILL_PATH_PRESENT" });

    const gc = await runRetentionGc({
      db,
      artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
      dataDir,
      days: 0,
      now: new Date(Date.now() + 86_400_000),
    });
    expect(gc.errors).toEqual([]);
    expect(rows(runId).map((r) => r.removal)).toEqual(["verified", "verified"]);
    expect(ofType(runId, "skill_removed").at(-1)?.p.point).toBe("gc");
    expect(needsAttentionOf(ledger, ledger.getRunRecord(runId) as never, { now: new Date() })).toEqual({
      active: false,
    });
    const after = await pusher.push({ metaSessionId, requestedBy: "operator" });
    expect(after.reason).not.toBe("SKILL_PATH_PRESENT");
    expectNoCanary(runId);
  }, 90_000);
});
