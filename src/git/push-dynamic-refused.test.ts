/**
 * T9.9 / Q-46 pin (owner decision 62): a push from an approved dynamic project is refused by design.
 *
 * The `push` tool (served over MCP through `GitToolService`, wired in `src/cli/serve.ts`) and `switchboard git push`
 * (`src/cli/git-push.ts`) both build their `GitPusher` with `pushContextResolver(config.projects)`: push targets
 * (remote, prefix, path) resolve from the configuration only. An approved dynamic project lives in the ledger (its
 * in-force revision may declare push policy `branch` per FR-PRJ-10), never in the configuration, so the resolver
 * returns `undefined` and the push is refused `CONTEXT_UNKNOWN` before any Git call. Nothing reaches the remote.
 *
 * Temporaryrepositories and a LOCAL bare remote only; no provider CLI, no network, no real credential.
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
import { loadConfig } from "../config/load.js";
import { GitPublisher, GitPusher, pushContextResolver } from "../git/index.js";
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

function writeConfig(): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.dirname(repo)],
      mcp_clients: [
        { id: "mgr", max_trust_profile: "edit-untrusted", manage_projects: true, max_push_policy: "branch" },
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

/** The approved dynamic revision declares push policy `branch` (FR-PRJ-10); approval enables runs, not push. */
function seedApprovedDynamicRevision(): void {
  const store = new DynamicProjectStore(db, { ids: createIdGenerator() });
  store.appendRevision(
    {
      projectId: "dyn-app",
      clientId: "mgr",
      definition: {
        id: "dyn-app",
        name: "Dynamic app",
        contexts: [
          {
            id: "main",
            kind: "repository",
            path: repo,
            base_ref: "main",
            push: { policy: "branch" as const, remote: "origin", branch_prefix: "sb/" },
            identity: IDENTITY,
          },
        ],
      },
      status: "PENDING_APPROVAL",
      approvalReasons: ["push_policy", "commit_identity"],
      action: "create_project",
    },
    () => undefined,
  );
  const decided = store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "operator1" });
  expect(decided.state.inForce?.revision).toBe(1);
  expect(decided.state.inForce?.definition.contexts[0]?.push?.policy).toBe("branch");
}

/** A meta-session of the approved dynamic project with one published commit on the publish ref. */
async function seedDynamicCommit(): Promise<{ sessionId: string; runId: string; sha: string }> {
  const ledger = createLedger(db, { ids: createIdGenerator() });
  const mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [path.dirname(repo)],
    ids: createIdGenerator(),
  });
  const session = ledger.createMetaSession({ objective: "dynamic work", repoRoot: repo, projectId: "dyn-app" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    state: "RUNNING",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "mgr",
    provider: "fake",
    projectId: "dyn-app",
  });
  const ws = await mgr.prepare({
    metaSessionId: session.id,
    runId: run.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
  });
  if (ws.mode !== "worktree") throw new Error("expected a worktree");
  writeFileSync(path.join(ws.worktreePath, "feature.txt"), "feature\n");
  const c = await new GitPublisher({ db, scratchDir: path.join(tmp, "scratch") }).commit({
    runId: run.id,
    message: "Add the feature",
    identity: IDENTITY,
    projectId: "dyn-app",
    contextId: "main",
  });
  return { sessionId: session.id, runId: run.id, sha: c.sha };
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
  seedApprovedDynamicRevision();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const remoteRefs = (cwd: string): string[] =>
  execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd, env: GIT_ENV, encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "");

describe("push from an approved dynamic project is refused by design (Q-46, owner decision 62)", () => {
  it("the MCP push tool path refuses CONTEXT_UNKNOWN: the production resolver sees configuration only", async () => {
    // The same construction as serve.ts: the resolver reads the loaded configuration, never the ledger.
    const config = loadConfig({ configPath, env });
    expect(config.projects.some((p) => p.id === "dyn-app")).toBe(false);
    const { sessionId, runId } = await seedDynamicCommit();
    const pusher = new GitPusher({
      db,
      resolveContext: pushContextResolver(config.projects),
      sourceEnv: { PATH: process.env.PATH, HOME: home },
      ids: createIdGenerator(),
    });
    const r = await pusher.push({
      metaSessionId: sessionId,
      requestedBy: "agent_tool",
      runId,
      agentReach: { ok: true },
    });
    expect(r).toMatchObject({ outcome: "REFUSED_POLICY", reason: "CONTEXT_UNKNOWN", pushed: false });
    expect(r.toolCode).toBe("PUSH_NOT_ALLOWED");
    expect(r.remote).toBe("");
    expect(r.ref).toBe("");
    // Nothing reached the bare remote, and the refusal is recorded in the ledger.
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
    const row = db.prepare("SELECT outcome, detail FROM git_push").get() as { outcome: string; detail: string };
    expect(row).toMatchObject({ outcome: "REFUSED_POLICY", detail: "CONTEXT_UNKNOWN" });
  });

  it("switchboard git push refuses CONTEXT_UNKNOWN and records the attempt; the remote is unchanged", async () => {
    const { sessionId, runId } = await seedDynamicCommit();
    db.close();
    try {
      const r = await run(["git", "push", sessionId]);
      expect(r.code, r.out + r.err).toBe(1);
      expect(r.out).toContain("push refused (CONTEXT_UNKNOWN)");
      expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
      const show = JSON.parse((await run(["runs", "show", runId, "--json"])).out);
      expect(show.run.pushes).toEqual([
        expect.objectContaining({ outcome: "REFUSED_POLICY", reason: "CONTEXT_UNKNOWN" }),
      ]);
      expect(show.run.commits[0].pushed_to).toEqual([]);
    } finally {
      db = openLedger(dataDir);
    }
  });
});
