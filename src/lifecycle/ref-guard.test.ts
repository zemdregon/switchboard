/**
 * T9.5 end to end (FR-GIT-01, FR-GIT-03, FRD BR-27, LLD §12.5; ADR-0027): the fake CLI plays an agent that writes to Git
 * by itself with PLAIN Git commands inside its run worktree, against temporary local repositories only (a local bare
 * repository stands in for a remote). The lifecycle snapshots refs at LEASED and compares at FINALIZING. No provider
 * CLI, login, network or credential is used. Adversarial escape scenarios are out of scope here (T3.8b).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { GitToolService } from "../git/channel.js";
import {
  GIT_POLICY_VIOLATION_EVENT,
  GIT_REF_CHECK_EVENT,
  GIT_REF_SNAPSHOT_EVENT,
  GitPublisher,
  publishRefFor,
  type ViolationEntry,
} from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle } from "./index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_COMMAND = [
  process.execPath,
  "--experimental-transform-types",
  "--no-warnings",
  "--import",
  path.join(HERE, "..", "reconcile", "fixtures", "ts-register.mjs"),
  path.join(HERE, "..", "cli", "bin.ts"),
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
const refSha = (cwd: string, ref: string): string => {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
const PROJECT: ProjectSnapshot = {
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

let root: string;
let repo: string;
let remote: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let service: GitToolService;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(scenario: FakeScenario): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ scenario, timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: () => PROFILE,
    gitTools: service,
  });
}

type Step = Record<string, unknown> & { op: string };

/** Run one fake-agent plan to a terminal state; returns ids and the run's events. */
async function runPlan(steps: Step[], opts: { project?: boolean; scenario?: FakeScenario } = {}) {
  lifecycle = makeLifecycle(opts.scenario ?? "git_attempts");
  lifecycle.start();
  const { runId, metaSessionId } = await lifecycle.submit({
    clientId: "c",
    objective: JSON.stringify({ steps }),
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...(opts.project === false ? {} : { project: PROJECT }),
  });
  const done = await lifecycle.waitForTerminal(runId);
  await lifecycle.shutdown();
  lifecycle = undefined;
  const run = ledger.getRunRecord(runId);
  return { runId, metaSessionId, done, run, branch: `refs/heads/${run?.branch ?? ""}` };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const violationsOf = (runId: string): ViolationEntry[] =>
  events(runId)
    .filter((e) => e.type === GIT_POLICY_VIOLATION_EVENT)
    .flatMap((e) => e.p.violations as ViolationEntry[]);
const checkOf = (runId: string) => events(runId).find((e) => e.type === GIT_REF_CHECK_EVENT)?.p;
/** Messages the fake agent emitted are not stored (content-free events); the outcome is checked through Git instead. */
const preCommit = (runId: string) => ledger.getRunCheckpointCommit(runId, "pre") as string;
const postCommit = (runId: string) => ledger.getRunCheckpointCommit(runId, "post") as string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-refg-")));
  repo = path.join(root, "repo");
  remote = path.join(root, "remote.git");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  writeFileSync(path.join(repo, "second.txt"), "second\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "second");
  g(root, "init", "-q", "--bare", remote);
  g(repo, "remote", "add", "origin", remote);
  g(repo, "push", "-q", "origin", "main");
  g(repo, "tag", "v1");
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

describe("ref snapshots and Git policy violations, end to end with the fake adapter (T9.5)", () => {
  it("a no-op run records a LEASED snapshot and a clean check, and no violation", async () => {
    const mainBefore = refSha(repo, "main");
    const { runId, done } = await runPlan([], { scenario: "success" });
    expect(done.state).toBe("SUCCEEDED");
    const snap = events(runId).find((e) => e.type === GIT_REF_SNAPSHOT_EVENT)?.p;
    expect(snap).toMatchObject({ v: 1, phase: "leased", truncated: false, repo_head: { symref: "refs/heads/main" } });
    const names = ((snap?.refs ?? []) as [string, string][]).map(([n]) => n);
    expect(names).toEqual(
      expect.arrayContaining([
        "refs/heads/main",
        "refs/remotes/origin/main",
        "refs/tags/v1",
        `refs/heads/${done.branch}`,
      ]),
    );
    expect(checkOf(runId)).toMatchObject({ result: "clean" });
    expect(violationsOf(runId)).toEqual([]);
    // The snapshot is taken before spawn, the check before the checkpoint.
    const order = events(runId).map((e) => (e.type === "state_transition" ? `to:${e.p.to}` : e.type));
    expect(order.indexOf(GIT_REF_SNAPSHOT_EVENT)).toBeLessThan(order.indexOf("to:RUNNING"));
    expect(order.indexOf(GIT_REF_CHECK_EVENT)).toBeLessThan(order.indexOf("checkpoint"));
    expect(refSha(repo, "main")).toBe(mainBefore);
  });

  it("legitimate tool commits (T9.4 channel) and the controller checkpoint are not flagged", async () => {
    const steps: Step[] = [
      { op: "write", path: "a.txt", content: "a\n" },
      { op: "tool_commit", arguments: { message: "Add a", paths: ["a.txt"] } },
      { op: "write", path: "b.txt", content: "b\n" },
      { op: "tool_commit", arguments: { message: "Add b", paths: ["b.txt"] } },
      { op: "write", path: "c.txt", content: "uncommitted\n" },
    ];
    const { runId, metaSessionId, done, branch } = await runPlan(steps);
    expect(done.state).toBe("SUCCEEDED");
    const rows = ledger.listGitCommits(runId);
    expect(rows).toHaveLength(2);
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe(rows[1]?.commit_sha);
    expect(checkOf(runId)).toMatchObject({ result: "clean" });
    expect(violationsOf(runId)).toEqual([]);
    // The checkpoint moved the run branch after the check, on top of the pre-run commit.
    expect(refSha(repo, `${branch}^`)).toBe(preCommit(runId));
  });

  it("`git commit` on the run branch: flagged, run branch put back, content kept as checkpoint content, not failed", async () => {
    const steps: Step[] = [
      { op: "write", path: "agent.txt", content: "agent work\n" },
      { op: "commit", message: "agent commit\n\nCo-authored-by: Agent <a@example.test>" },
    ];
    const { runId, metaSessionId, done, branch } = await runPlan(steps);
    expect(done.state).toBe("SUCCEEDED"); // BR-27: not failed for that reason alone
    const v = violationsOf(runId);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ scope: "run_branch", kind: "moved", old: preCommit(runId), action: "restore" });
    const agentSha = v[0]?.new as string;
    expect(v[0]?.foreign_commits).toEqual([agentSha]);
    expect(checkOf(runId)).toMatchObject({ result: "violation", restored: [{ scope: "run_branch", ok: true }] });
    // The agent's commit is not in the run branch history; its tree is the checkpoint's content.
    expect(g(repo, "rev-parse", `${branch}^`)).toBe(preCommit(runId));
    expect(() => g(repo, "merge-base", "--is-ancestor", agentSha, branch)).toThrow();
    expect(g(repo, "show", `${postCommit(runId)}:agent.txt`)).toBe("agent work");
    expect(g(repo, "log", "-1", "--format=%ae", postCommit(runId))).toBe("switchboard@localhost");
    // Never published; the terminal event and payload say so; no message text in the event.
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    expect(events(runId).find((e) => e.p.to === "SUCCEEDED")?.p).toMatchObject({ git_policy_violation: true });
    expect(JSON.stringify(violationsOf(runId))).not.toContain("agent commit");
  });

  it("`git branch` and `git tag`: new refs are flagged and reported (not deleted: operator refs are never touched)", async () => {
    const { runId, done } = await runPlan([
      { op: "branch", name: "agent-branch" },
      { op: "tag", name: "agent-tag" },
    ]);
    expect(done.state).toBe("SUCCEEDED");
    const v = violationsOf(runId);
    expect(v.map((x) => [x.scope, x.kind, x.ref, x.action])).toEqual([
      ["other", "created", "refs/heads/agent-branch", "report"],
      ["other", "created", "refs/tags/agent-tag", "report"],
    ]);
    expect(v.every((x) => x.old === null && x.new === preCommit(runId))).toBe(true);
  });

  it("`git update-ref` on the publish ref with no tool commit: flagged and deleted again", async () => {
    const { runId, metaSessionId, done } = await runPlan([
      { op: "write", path: "x.txt", content: "x\n" },
      { op: "commit", message: "sneak" },
      { op: "update_ref", ref: "@publish", to: "HEAD" },
    ]);
    expect(done.state).toBe("SUCCEEDED");
    const pub = publishRefFor(metaSessionId);
    expect(refSha(repo, pub)).toBe("");
    const v = violationsOf(runId);
    expect(v.find((x) => x.scope === "publish_ref")).toMatchObject({
      ref: pub,
      kind: "created",
      old: null,
      restore_to: null,
      action: "restore",
    });
    expect(v.find((x) => x.scope === "run_branch")).toBeDefined();
  });

  it("`git update-ref` on the publish ref after a tool commit: put back to the tool commit; the tool commit is not flagged", async () => {
    const { runId, metaSessionId, done } = await runPlan([
      { op: "write", path: "a.txt", content: "a\n" },
      { op: "tool_commit", arguments: { message: "Add a", paths: ["a.txt"] } },
      { op: "write", path: "evil.txt", content: "e\n" },
      { op: "commit", message: "agent" },
      { op: "update_ref", ref: "@publish", to: "HEAD" },
    ]);
    expect(done.state).toBe("SUCCEEDED");
    const toolSha = ledger.listGitCommits(runId)[0]?.commit_sha as string;
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe(toolSha);
    const pubV = violationsOf(runId).filter((x) => x.scope === "publish_ref");
    expect(pubV).toHaveLength(1);
    expect(pubV[0]).toMatchObject({ kind: "created", restore_to: toolSha });
    // The foreign commit is named; the controller's own commit is not.
    expect(pubV[0]?.foreign_commits).not.toContain(toolSha);
    expect(pubV[0]?.foreign_commit_count).toBe(1);
  });

  it("a tool commit parented on an agent-moved publish ref is not accepted as a published head", async () => {
    const { runId, metaSessionId, done } = await runPlan([
      { op: "write", path: "evil.txt", content: "e\n" },
      { op: "commit", message: "agent" },
      { op: "update_ref", ref: "@publish", to: "HEAD" },
      { op: "write", path: "a.txt", content: "a\n" },
      { op: "tool_commit", arguments: { message: "Add a", paths: ["a.txt"] } },
    ]);
    expect(done.state).toBe("SUCCEEDED");
    // The tool commit's parent is the agent commit, so its chain does not reach the base: nothing valid to keep.
    expect(ledger.listGitCommits(runId)).toHaveLength(1);
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    expect(violationsOf(runId).find((x) => x.scope === "publish_ref")).toMatchObject({ restore_to: null });
  });

  it("`git update-ref` on the default branch: flagged and reported; the operator's HEAD symref is unchanged", async () => {
    const mainBefore = refSha(repo, "main");
    const { runId, done } = await runPlan([
      { op: "write", path: "x.txt", content: "x\n" },
      { op: "commit", message: "agent" },
      { op: "update_ref", ref: "refs/heads/main", to: "HEAD" },
    ]);
    expect(done.state).toBe("SUCCEEDED");
    const mainV = violationsOf(runId).find((x) => x.ref === "refs/heads/main");
    expect(mainV).toMatchObject({ scope: "other", kind: "moved", old: mainBefore, action: "report" });
    expect(mainV?.new).not.toBe(mainBefore);
    expect(g(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  });

  it("`git push` to a local bare remote: the remote-tracking ref is flagged; the push itself cannot be undone (BR-27)", async () => {
    const { runId, done } = await runPlan([
      { op: "write", path: "x.txt", content: "x\n" },
      { op: "commit", message: "agent" },
      { op: "push", remote: "origin", refspec: "HEAD:refs/heads/agent-pushed" },
    ]);
    expect(done.state).toBe("SUCCEEDED");
    const v = violationsOf(runId);
    expect(v.find((x) => x.ref === "refs/remotes/origin/agent-pushed")).toMatchObject({
      scope: "other",
      kind: "created",
      action: "report",
    });
    expect(refSha(remote, "refs/heads/agent-pushed")).not.toBe(""); // reached the remote: detection only
    expect(v.find((x) => x.scope === "run_branch")).toBeDefined();
  });

  it("`git reset --hard` of the run branch to an older commit: flagged, put back; the checkpoint records the reversion", async () => {
    const { runId, done, branch } = await runPlan([{ op: "reset_hard", to: "HEAD~1" }]);
    expect(done.state).toBe("SUCCEEDED");
    const older = g(repo, "rev-parse", "main~1");
    const v = violationsOf(runId);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ scope: "run_branch", kind: "moved", new: older, foreign_commit_count: 0 });
    expect(g(repo, "rev-parse", `${branch}^`)).toBe(preCommit(runId));
    expect(g(repo, "diff", "--name-status", preCommit(runId), postCommit(runId))).toBe("D\tsecond.txt");
  });

  it("`git checkout -b` in the worktree: HEAD pointed back at the run branch, the new branch reported", async () => {
    const { runId, done, branch, run } = await runPlan([
      { op: "checkout_new", name: "agent-side" },
      { op: "write", path: "x.txt", content: "x\n" },
    ]);
    expect(done.state).toBe("SUCCEEDED");
    const v = violationsOf(runId);
    expect(v.find((x) => x.scope === "worktree_head")).toMatchObject({ new: "refs/heads/agent-side" });
    expect(v.find((x) => x.ref === "refs/heads/agent-side")).toMatchObject({ scope: "other", kind: "created" });
    expect(g(run?.worktree_path as string, "symbolic-ref", "HEAD")).toBe(branch);
    expect(g(repo, "show", `${postCommit(runId)}:x.txt`)).toBe("x");
    expect(refSha(repo, "refs/heads/agent-side")).toBe(preCommit(runId)); // the checkpoint did not land there
  });

  it("a workspace-path run (no project, no channel) is checked the same way", async () => {
    const { runId, done } = await runPlan(
      [
        { op: "write", path: "x.txt", content: "x\n" },
        { op: "commit", message: "agent" },
      ],
      { project: false },
    );
    expect(done.state).toBe("SUCCEEDED");
    expect(violationsOf(runId).map((x) => x.scope)).toEqual(["run_branch"]);
  });

  it("T10.3 (ADR-0053): a .git link pointed at the repository is restored first; the operator's HEAD and index are untouched", async () => {
    const indexBefore = g(repo, "ls-files", "-s");
    const { runId, done, branch } = await runPlan([
      { op: "write", path: "evil.txt", content: "evil\n" },
      { op: "write", path: ".git", content: `gitdir: ${path.join(repo, ".git")}\n` },
    ]);
    expect(done.state).toBe("SUCCEEDED");
    // Before ADR-0053 the worktree HEAD "restore" ran through the link and switched the operator's HEAD to the run
    // branch, and the checkpoint staged evil.txt in the operator's index.
    expect(violationsOf(runId).map((x) => [x.scope, x.kind])).toEqual([["worktree_link", "link_changed"]]);
    expect(g(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(g(repo, "ls-files", "-s")).toBe(indexBefore);
    expect(g(repo, "status", "--porcelain")).toBe("");
    expect(g(repo, "show", `${postCommit(runId)}:evil.txt`)).toBe("evil");
    expect(refSha(repo, `${branch}^`)).toBe(preCommit(runId));
  });
});
