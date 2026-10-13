/**
 * T9.6 end to end (FR-GIT-02, FR-GIT-05, FR-GIT-06; FRD BR-29, BR-31; LLD §12.1, §12.6; ADR-0028): the run lifecycle
 * offers `push` on the per-run channel only for a frozen `branch` policy whose run keeps credentials out of the agent's
 * reach; the fake CLI starts the real `switchboard tool-shim` and calls `commit` then `push` over MCP. Temporary
 * repositories and a LOCAL bare remote only; no provider CLI, no network, no real credential (the push's HOME is a
 * temporary directory).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { GIT_CHANNEL_CLOSED, GIT_CHANNEL_OPENED, GIT_TOOL_DENIED, GitToolService } from "../git/channel.js";
import { GitPublisher, GitPusher, type PushContextConfig, publishRefFor } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { GIT_PUSH_WITHHELD_EVENT, RunLifecycle } from "./index.js";

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
const refSha = (cwd: string, ref: string): string => {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};
const remoteRefs = (bare: string) =>
  g(bare, "for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter((l) => l !== "");

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const NO_SHELL: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "allowlist",
  shellAllowlist: [],
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
const BROAD_SHELL: ResolvedProfile = { ...NO_SHELL, name: "trusted-development", shell: "broad" };
const PLAN = JSON.stringify({
  files: { "feature.txt": "a feature\n" },
  calls: [
    { name: "commit", arguments: { message: "Add the feature" } },
    { name: "push", arguments: {} },
  ],
});

let root: string;
let repo: string;
let bare: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let service: GitToolService;
let lifecycle: RunLifecycle;
let ctx: PushContextConfig;

function project(policy: "none" | "branch"): ProjectSnapshot {
  return {
    id: "web",
    name: "Web",
    environment_kind: "host",
    context_id: "main",
    base_ref: "main",
    effective_max_profile: "trusted-development",
    writable: true,
    identity: IDENTITY,
    push: { policy },
  };
}

function makeLifecycle(profile: ResolvedProfile): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ scenario: "git_commit", timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 1,
    resolveProfile: () => profile,
    gitTools: service,
  });
}

async function runPlan(profile: ResolvedProfile, policy: "none" | "branch", plan = PLAN) {
  lifecycle = makeLifecycle(profile);
  lifecycle.start();
  const { runId, metaSessionId } = await lifecycle.submit({
    clientId: "c",
    objective: plan,
    workspace: repo,
    trustProfile: profile.name,
    provider: "fake",
    project: project(policy),
  });
  const done = await lifecycle.waitForTerminal(runId);
  expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
  return { runId, metaSessionId };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) }));

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? allFiles(full) : d.isFile() ? [full] : [];
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-gpush-")));
  repo = path.join(root, "repo");
  bare = path.join(root, "remote.git");
  mkdirSync(repo);
  mkdirSync(path.join(root, "home"));
  g(repo, "init", "-q", "-b", "main");
  execFileSync("sh", ["-c", "printf 'hello\\n' > README.md"], { cwd: repo });
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(repo, "remote", "add", "origin", bare);
  g(repo, "push", "-q", "origin", "main");
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  ctx = {
    projectId: "web",
    contextId: "main",
    path: repo,
    baseRef: "main",
    policy: "branch",
    remote: "origin",
    branchPrefix: "agent/",
  };
  const publisher = new GitPublisher({ db, scratchDir: path.join(dataDir, "git-scratch") });
  const pusher = new GitPusher({
    db,
    resolveContext: (id) => (id === "web" ? ctx : undefined),
    sourceEnv: { PATH: process.env.PATH, HOME: path.join(root, "home") },
  });
  service = new GitToolService({
    db,
    dataDir,
    publisher,
    pusher,
    shimCommand: SHIM_COMMAND,
    fallbackDirs: [root],
  });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  await service.closeAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("injected push tool (T9.6)", () => {
  it("policy branch + a profile without shell: commit then push through the shim publishes only the publish ref", async () => {
    const { runId, metaSessionId } = await runPlan(NO_SHELL, "branch");
    const head = refSha(repo, publishRefFor(metaSessionId));
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    const target = `refs/heads/agent/${metaSessionId}`;
    expect(remoteRefs(bare).sort()).toEqual(["refs/heads/main", target].sort());
    expect(refSha(bare, target)).toBe(head);
    const ev = events(runId);
    expect(ev.find((e) => e.type === GIT_CHANNEL_OPENED)?.p.tools).toEqual(["commit", "push"]);
    expect(ev.some((e) => e.type === GIT_PUSH_WITHHELD_EVENT)).toBe(false);
    const push = ev.filter((e) => e.type === "git_push");
    expect(push).toHaveLength(1);
    expect(push[0]?.p).toMatchObject({
      outcome: "ACCEPTED",
      requested_by: "agent_tool",
      remote: "origin",
      ref: target,
      head_sha: head,
      commits: [head],
    });
    expect(ev.find((e) => e.type === GIT_CHANNEL_CLOSED)?.p).toMatchObject({ commits: 1, pushes: 1, refused: 0 });
    // The remote-tracking ref the push updated is the controller's own change, not a violation (T9.5 guard).
    expect(refSha(repo, `refs/remotes/origin/agent/${metaSessionId}`)).toBe(head);
    expect(ev.some((e) => e.type === "git_policy_violation")).toBe(false);
    expect(ev.find((e) => e.type === "git_ref_check")?.p.result).toBe("clean");
    const row = db.prepare("SELECT * FROM git_push").get() as Record<string, unknown>;
    expect(row).toMatchObject({ run_id: runId, requested_by: "agent_tool", outcome: "ACCEPTED", remote: "origin" });
    // The operator's checkout is untouched (FR-WS-05) and no run branch or tag reached the remote.
    expect(g(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(g(repo, "status", "--porcelain")).toBe("");
    // Neither the remote's path (its "URL") nor any credential-like value is in the data directory.
    db.pragma("wal_checkpoint(TRUNCATE)");
    for (const f of allFiles(dataDir)) expect(readFileSync(f).includes(bare), f).toBe(false);
  });

  it("a profile with shell access withholds push (BR-31), records the reason, and a call is refused", async () => {
    const { runId, metaSessionId } = await runPlan(BROAD_SHELL, "branch");
    const ev = events(runId);
    expect(ev.find((e) => e.type === GIT_PUSH_WITHHELD_EVENT)?.p).toEqual({ reason: "shell_broad" });
    expect(ev.find((e) => e.type === GIT_CHANNEL_OPENED)?.p.tools).toEqual(["commit"]);
    expect(ev.filter((e) => e.type === GIT_TOOL_DENIED).map((e) => e.p)).toEqual([{ code: "UNKNOWN_TOOL" }]);
    // The commit still worked; nothing reached the remote.
    expect(refSha(repo, publishRefFor(metaSessionId))).toMatch(/^[0-9a-f]{40}$/u);
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
    expect(ev.some((e) => e.type === "git_push")).toBe(false);
  });

  it("a non-empty shell allowlist also withholds push", async () => {
    const { runId } = await runPlan({ ...NO_SHELL, shellAllowlist: ["npm test"] }, "branch");
    expect(events(runId).find((e) => e.type === GIT_PUSH_WITHHELD_EVENT)?.p).toEqual({ reason: "shell_allowlist" });
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("policy none offers no push tool and records no withheld event (the default)", async () => {
    const { runId } = await runPlan(NO_SHELL, "none");
    const ev = events(runId);
    expect(ev.find((e) => e.type === GIT_CHANNEL_OPENED)?.p.tools).toEqual(["commit"]);
    expect(ev.some((e) => e.type === GIT_PUSH_WITHHELD_EVENT)).toBe(false);
    expect(ev.filter((e) => e.type === GIT_TOOL_DENIED).map((e) => e.p.code)).toEqual(["UNKNOWN_TOOL"]);
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("the current configuration is re-read at call time: an operator who sets policy none stops the push", async () => {
    ctx = { ...ctx, policy: "none" };
    const { runId } = await runPlan(NO_SHELL, "branch");
    const push = events(runId).filter((e) => e.type === "git_push");
    expect(push.map((e) => [e.p.outcome, e.p.reason])).toEqual([["REFUSED_POLICY", "POLICY_NONE"]]);
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("push arguments are refused, and attempts beyond the per-run limit are refused without a push", async () => {
    const plan = JSON.stringify({
      files: { "f.txt": "f\n" },
      calls: [
        { name: "commit", arguments: { message: "F" } },
        { name: "push", arguments: { remote: "https://evil.invalid/x.git" } },
        ...Array.from({ length: 11 }, () => ({ name: "push", arguments: {} })),
      ],
    });
    const { runId } = await runPlan(NO_SHELL, "branch", plan);
    const ev = events(runId);
    const denied = ev.filter((e) => e.type === GIT_TOOL_DENIED).map((e) => e.p.code);
    expect(denied).toEqual(["INVALID_ARGUMENTS", "PUSH_LIMIT_REACHED"]);
    const pushes = ev.filter((e) => e.type === "git_push").map((e) => e.p.reason);
    expect(pushes).toHaveLength(10);
    expect(pushes[0]).toBe("ACCEPTED");
    expect(pushes.slice(1).every((r) => r === "UP_TO_DATE")).toBe(true);
    // The refused argument is not echoed into any record (the objective itself holds the plan, so search the records).
    const records = JSON.stringify([ev, db.prepare("SELECT * FROM git_push").all()]);
    expect(records).not.toContain("evil.invalid");
  });
});
