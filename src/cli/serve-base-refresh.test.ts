/**
 * ADR-0074 (LLD §5.2): `serveBaseRefresh` on real temporary repositories with a bare `file://` remote. A dynamic
 * project whose primary context has a `clone_url` (and no `base_remote`) fetches before a meta-session's first worktree
 * and the worktree starts from the fetched remote tip, not the stale local `main`; a configured project without
 * `base_remote` is unchanged (no fetch, no event); a failed fetch keeps the local base and leaves a `base_refresh`
 * event with outcome `failed` that `get_run` shows in its events.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ProjectConfig } from "../config/index.js";
import { BASE_REFRESH_EVENT } from "../git/index.js";
import { createIdGenerator, type IdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord } from "../ledger/index.js";
import { compactEvents } from "../mcp/envelope.js";
import { DynamicProjectStore, toResolved } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { serveBaseRefresh, serveSubmodulePlan } from "./serve.js";

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

const profile: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

let root: string;
let bare: string;
let pusher: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ids: IdGenerator;
let ledger: Ledger;
let store: DynamicProjectStore;

/** Advance the remote's `main` by one commit (as a merged pull request would) and return it. */
function remoteCommit(name: string): string {
  writeFileSync(path.join(pusher, name), `${name}\n`);
  g(pusher, "add", "-A");
  g(pusher, "commit", "-q", "-m", name);
  g(pusher, "push", "-q", "origin", "main");
  return g(pusher, "rev-parse", "HEAD");
}

const definition = (over: Partial<ProjectConfig["contexts"][number]> = {}): ProjectConfig => ({
  id: "whumpo-website",
  name: "Whumpo website",
  contexts: [
    {
      id: "main",
      kind: "repository",
      path: repo,
      base_ref: "main",
      clone_url: "https://github.com/digifender-llc/whumpo-website",
      push: { policy: "branch", remote: "origin", branch_prefix: "sb/" },
      identity: { name: "Switchboard", email: "sb@example.test" },
      ...over,
    },
  ],
});

function manager(configured: readonly ProjectConfig[] = []): WorkspaceManager {
  return new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
    baseRefresh: serveBaseRefresh({ projects: configured.map((p) => toResolved(p)) }, store, db, ids, {
      PATH: process.env.PATH,
    }),
  });
}

/** A first run of a new meta-session of `projectId`, walked to LEASED and prepared with `base_ref: main`. */
async function firstRun(ws: WorkspaceManager, projectId: string) {
  const sessionId = ledger.createMetaSession({ objective: "t" }).id;
  const created = ledger.createRun({
    metaSessionId: sessionId,
    trustProfile: "edit-untrusted",
    policySnapshot: profile,
    request: { objective: "t", workspace: repo, constraints: [], trust_profile: "edit-untrusted", provider: "fake" },
    requestHash: "h",
    clientId: "orch",
    provider: "fake",
    projectId,
  });
  let cur = ledger.getRunRecord(created.id) as RunRecord;
  for (const [to, rule] of [
    ["PREFLIGHT", "T4"],
    ["LEASED", "T5"],
  ] as const) {
    cur = ledger.casRunState({
      runId: cur.id,
      from: cur.state,
      to,
      expectedVersion: cur.version,
      payload: { rule },
    }) as RunRecord;
  }
  const prepared = await ws.prepare({
    metaSessionId: sessionId,
    runId: cur.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
    baseRef: "main",
  });
  return { runId: cur.id, baseCommit: prepared.mode === "worktree" ? prepared.baseCommit : undefined };
}

const refreshEvents = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === BASE_REFRESH_EVENT)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-bfresh-")));
  const seed = path.join(root, "seed");
  g(root, "init", "-q", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "init");
  bare = path.join(root, "remote.git");
  g(root, "clone", "-q", "--bare", seed, bare);
  // The controller's clone (as `ensureClone` leaves it: `origin` is the source) and an outside contributor.
  repo = path.join(root, "clone");
  g(root, "clone", "-q", `file://${bare}`, repo);
  pusher = path.join(root, "pusher");
  g(root, "clone", "-q", `file://${bare}`, pusher);
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  store = new DynamicProjectStore(db, { ids });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const activate = (def: ProjectConfig) =>
  store.appendRevision(
    {
      projectId: def.id,
      clientId: "orch",
      definition: def,
      status: "ACTIVE",
      approvalReasons: [],
      action: "create_project",
    },
    () => {},
  );

describe("serveBaseRefresh (ADR-0074)", () => {
  it("a dynamic clone_url project's new worktree starts from the remote tip after the remote advanced", async () => {
    activate(definition());
    const staleLocal = g(repo, "rev-parse", "refs/heads/main");
    const merged299 = remoteCommit("pr-299.txt");
    const merged300 = remoteCommit("pr-300.txt");
    expect(merged299).not.toBe(staleLocal);
    const run = await firstRun(manager(), "whumpo-website");
    expect(run.baseCommit).toBe(merged300);
    expect(g(repo, "rev-parse", "refs/heads/main")).toBe(staleLocal); // the local branch is never written
    expect(refreshEvents(run.runId)).toEqual([
      expect.objectContaining({ outcome: "fetched", reason: "ADVANCED", remote: "origin", base_commit: merged300 }),
    ]);
  });

  it("a configured project without base_remote is unchanged: no fetch, no event, the local base", async () => {
    const { clone_url: _drop, ...pathCtx } = definition().contexts[0] as ProjectConfig["contexts"][number];
    const configured: ProjectConfig = { ...definition(), id: "configured-site", contexts: [pathCtx] };
    const staleLocal = g(repo, "rev-parse", "refs/heads/main");
    const trackingBefore = g(repo, "rev-parse", "refs/remotes/origin/main");
    remoteCommit("later.txt");
    const run = await firstRun(manager([configured]), "configured-site");
    expect(run.baseCommit).toBe(staleLocal);
    expect(refreshEvents(run.runId)).toEqual([]);
    expect(g(repo, "rev-parse", "refs/remotes/origin/main")).toBe(trackingBefore);
  });

  it("a failed fetch falls back to the local base and leaves a failed base_refresh event get_run shows", async () => {
    activate(definition());
    const staleLocal = g(repo, "rev-parse", "refs/heads/main");
    remoteCommit("unreachable.txt");
    g(repo, "remote", "set-url", "origin", `file://${path.join(root, "gone.git")}`);
    const run = await firstRun(manager(), "whumpo-website");
    expect(run.baseCommit).toBe(staleLocal);
    expect(refreshEvents(run.runId)).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "FETCH_FAILED", base_commit: null }),
    ]);
    const shown = compactEvents(ledger, run.runId, 0, 100, (s) => s).filter((e) => e.type === BASE_REFRESH_EVENT);
    expect(shown).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ outcome: "failed", reason: "FETCH_FAILED" }) }),
    ]);
  });
});

describe("serveSubmodulePlan (ADR-0087 item 3)", () => {
  const def = (id: string, ctx: Partial<ProjectConfig["contexts"][number]> = {}): ProjectConfig => ({
    id,
    name: id,
    contexts: [{ id: "main", kind: "repository", path: "/srv/x", base_ref: "main", ...ctx }],
  });

  it("plans only a primary context with mode recursive, for configured and in-force dynamic projects", () => {
    const dynamic = def("dyn", {
      clone_url: "https://github.test/acme/umbrella",
      submodules: { mode: "recursive", writable_paths: ["libs/a"], exclude: ["vendor"] },
    });
    const state = (id: string) =>
      id === "dyn" ? ({ inForce: { definition: dynamic } } as ReturnType<DynamicProjectStore["state"]>) : undefined;
    const plan = serveSubmodulePlan(
      {
        projects: [
          toResolved(def("conf", { base_remote: "upstream", submodules: { mode: "recursive" } })),
          toResolved(def("off", { submodules: { mode: "off" } })),
          toResolved(def("plain")),
        ],
      },
      { state },
    );
    expect(plan("conf")).toEqual({ writablePaths: [], exclude: [], baseRemote: "upstream" });
    expect(plan("dyn")).toEqual({ writablePaths: ["libs/a"], exclude: ["vendor"], baseRemote: "origin" });
    expect(plan("off")).toBeUndefined();
    expect(plan("plain")).toBeUndefined();
    expect(plan("unknown")).toBeUndefined();
  });
});
