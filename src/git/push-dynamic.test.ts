/**
 * ADR-0069 (supersedes the Q-46 answer of owner decision 62 for approved branch-policy dynamic projects): a push from
 * an approved dynamic project whose in-force revision sets push policy `branch` reaches the remote, through the agent
 * `push` tool's and `publish_run`'s pusher in `serve` and through `switchboard git push`. Both build their `GitPusher`
 * with `projectPushContextResolver`: configuration first, then the dynamic store's in-force revision, while the creating
 * client keeps `manage_projects` and `max_push_policy: branch`. Every other state (pending, rejected, never created,
 * deleted, a revision in force with policy `none`, a creator whose push maximum was lowered) is refused before any Git
 * call, and nothing reaches the remote.
 *
 * Temporary repositories and a LOCAL bare remote only; no provider CLI, no network, no real credential.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import type { ProjectConfig } from "../config/index.js";
import { loadConfig } from "../config/load.js";
import { GitPublisher, GitPusher, projectPushContextResolver, pushContextResolver } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };

let tmp: string;
let repo: string;
let bare: string;
let home: string;
let dataDir: string;
let configPath: string;
let env: Record<string, string | undefined>;
let db: Database.Database;

function writeConfig(client: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.dirname(repo)],
      mcp_clients: [
        {
          id: "mgr",
          max_trust_profile: "edit-untrusted",
          manage_projects: true,
          max_push_policy: "branch",
          ...client,
        },
      ],
      projects: [
        {
          id: "web",
          name: "Web",
          contexts: [
            {
              id: "main",
              kind: "repository",
              path: repo,
              base_ref: "main",
              push: { policy: "branch", remote: "origin", branch_prefix: "sb/" },
              identity: IDENTITY,
            },
          ],
        },
      ],
    }),
  );
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env,
    user: "operator1",
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

const definition = (policy: "branch" | "none" = "branch"): ProjectConfig => ({
  id: "dyn-app",
  name: "Dynamic app",
  contexts: [
    {
      id: "main",
      kind: "repository",
      path: repo,
      base_ref: "main",
      push: policy === "branch" ? { policy, remote: "origin", branch_prefix: "sb/" } : { policy },
      identity: IDENTITY,
    },
  ],
});

const store = () => new DynamicProjectStore(db, { ids: createIdGenerator() });

/** Revision 1 of `dyn-app`, waiting for the operator (FR-PRJ-10: push policy and identity need approval). */
function seedPending(policy: "branch" | "none" = "branch"): void {
  store().appendRevision(
    {
      projectId: "dyn-app",
      clientId: "mgr",
      definition: definition(policy),
      status: "PENDING_APPROVAL",
      approvalReasons: ["push_policy", "commit_identity"],
      action: "create_project",
    },
    () => undefined,
  );
}

function seedDecided(decision: "APPROVED" | "REJECTED", policy: "branch" | "none" = "branch"): void {
  seedPending(policy);
  store().decide({ projectId: "dyn-app", decision, decidedBy: "operator1" });
}

/** A meta-session of `projectId` with one published commit on its publish ref. */
async function seedCommit(projectId = "dyn-app"): Promise<{ sessionId: string; runId: string; sha: string }> {
  const ledger = createLedger(db, { ids: createIdGenerator() });
  const mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [path.dirname(repo)],
    ids: createIdGenerator(),
  });
  const session = ledger.createMetaSession({ objective: "dynamic work", repoRoot: repo, projectId });
  const r = ledger.createRun({
    metaSessionId: session.id,
    state: "RUNNING",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "mgr",
    provider: "fake",
    projectId,
  });
  const ws = await mgr.prepare({
    metaSessionId: session.id,
    runId: r.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
  });
  if (ws.mode !== "worktree") throw new Error("expected a worktree");
  writeFileSync(path.join(ws.worktreePath, "feature.txt"), "feature\n");
  const c = await new GitPublisher({ db, scratchDir: path.join(tmp, "scratch") }).commit({
    runId: r.id,
    message: "Add the feature",
    identity: IDENTITY,
    projectId,
    contextId: "main",
  });
  return { sessionId: session.id, runId: r.id, sha: c.sha };
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-push-dyn-")));
  const repos = path.join(tmp, "repos");
  repo = path.join(repos, "web");
  bare = path.join(tmp, "remote.git");
  home = path.join(tmp, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: GIT_ENV });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g("add", "-A");
  g("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: GIT_ENV });
  g("remote", "add", "origin", bare);
  g("push", "-q", "origin", "main");
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  env = { PATH: process.env.PATH, HOME: home };
  writeConfig();
  db = openLedger(dataDir);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const remoteRefs = (cwd: string): string[] =>
  execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd, env: GIT_ENV, encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "");

/** The pusher exactly as `serve` builds it: the loaded configuration, the ledger's dynamic store. */
function servePusher(): GitPusher {
  const config = loadConfig({ configPath, env });
  return new GitPusher({
    db,
    resolveContext: projectPushContextResolver({
      projects: config.projects,
      store: store(),
      clients: config.mcpClients,
    }),
    sourceEnv: { PATH: process.env.PATH, HOME: home },
    ids: createIdGenerator(),
  });
}

const agentPush = (pusher: GitPusher, s: { sessionId: string; runId: string }) =>
  pusher.push({ metaSessionId: s.sessionId, requestedBy: "agent_tool", runId: s.runId, agentReach: { ok: true } });

describe("push from an approved dynamic project (ADR-0069, superseding the Q-46 answer for branch policy)", () => {
  it("approved with policy branch: the serve pusher pushes to the local bare remote", async () => {
    seedDecided("APPROVED");
    const s = await seedCommit();
    const r = await agentPush(servePusher(), s);
    expect(r).toMatchObject({ outcome: "ACCEPTED", reason: "ACCEPTED", pushed: true, remote: "origin" });
    expect(r.ref).toBe(`refs/heads/sb/${s.sessionId}`);
    expect(remoteRefs(bare)).toContain(`refs/heads/sb/${s.sessionId}`);
    const row = db.prepare("SELECT outcome, project_id, requested_by FROM git_push").get();
    expect(row).toEqual({ outcome: "ACCEPTED", project_id: "dyn-app", requested_by: "agent_tool" });
  });

  it("approved with policy branch: switchboard git push pushes and records the operator push", async () => {
    seedDecided("APPROVED");
    const s = await seedCommit();
    db.close();
    try {
      const r = await run(["git", "push", s.sessionId]);
      expect(r.code, r.out + r.err).toBe(0);
      expect(r.out).toContain("pushed 1 commit(s)");
      expect(remoteRefs(bare)).toContain(`refs/heads/sb/${s.sessionId}`);
      const show = JSON.parse((await run(["runs", "show", s.runId, "--json"])).out);
      expect(show.run.pushes).toEqual([expect.objectContaining({ outcome: "ACCEPTED" })]);
    } finally {
      db = openLedger(dataDir);
    }
  });

  it.each([
    ["pending (never decided)", () => seedPending()],
    ["rejected", () => seedDecided("REJECTED")],
    ["never created", () => undefined],
  ])("%s: refused CONTEXT_UNKNOWN before any Git call; the remote is unchanged", async (_label, seed) => {
    seed();
    const s = await seedCommit();
    const r = await agentPush(servePusher(), s);
    expect(r).toMatchObject({
      outcome: "REFUSED_POLICY",
      reason: "CONTEXT_UNKNOWN",
      pushed: false,
      remote: "",
      ref: "",
    });
    expect(r.toolCode).toBe("PUSH_NOT_ALLOWED");
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("deleted after approval: refused CONTEXT_UNKNOWN", async () => {
    seedDecided("APPROVED");
    const s = await seedCommit();
    store().appendRevision(
      {
        projectId: "dyn-app",
        clientId: "mgr",
        definition: definition(),
        status: "DELETED",
        approvalReasons: [],
        action: "delete_project",
      },
      () => undefined,
    );
    expect(store().state("dyn-app")?.deleted).toBe(true);
    const r = await agentPush(servePusher(), s);
    expect(r).toMatchObject({ outcome: "REFUSED_POLICY", reason: "CONTEXT_UNKNOWN", pushed: false });
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("approved, but the revision in force sets policy none: refused POLICY_NONE", async () => {
    seedDecided("APPROVED", "none");
    const s = await seedCommit();
    const r = await agentPush(servePusher(), s);
    expect(r).toMatchObject({ outcome: "REFUSED_POLICY", reason: "POLICY_NONE", pushed: false });
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it.each([
    ["max_push_policy lowered to none", { max_push_policy: "none" }],
    ["manage_projects removed", { manage_projects: false, max_push_policy: undefined }],
  ])("approved, but the creator's %s: refused CONTEXT_UNKNOWN", async (_label, change) => {
    seedDecided("APPROVED");
    const s = await seedCommit();
    writeConfig(change);
    const r = await agentPush(servePusher(), s);
    expect(r).toMatchObject({ outcome: "REFUSED_POLICY", reason: "CONTEXT_UNKNOWN", pushed: false });
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
    db.close();
    try {
      const cli = await run(["git", "push", s.sessionId]);
      expect(cli.code).toBe(1);
      expect(cli.out).toContain("push refused (CONTEXT_UNKNOWN)");
    } finally {
      db = openLedger(dataDir);
    }
  });

  it("a configured project of the same id wins over a dynamic one; the configuration-only resolver still sees none", async () => {
    seedDecided("APPROVED");
    const config = loadConfig({ configPath, env });
    const resolve = projectPushContextResolver({
      projects: config.projects,
      store: store(),
      clients: config.mcpClients,
    });
    expect(resolve("web")).toMatchObject({ projectId: "web", policy: "branch" });
    expect(resolve("web")?.dynamicCreator).toBeUndefined();
    expect(resolve("dyn-app")).toMatchObject({ projectId: "dyn-app", policy: "branch", dynamicCreator: "mgr" });
    expect(pushContextResolver(config.projects)("dyn-app")).toBeUndefined();
  });
});
