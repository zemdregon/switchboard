/**
 * ADR-0074 (LLD §3.4.15, §5.2.1): `refresh_project_base` and `rebase_session` on real temporary repositories with a
 * bare `file://` remote. The controller fetches with the ADR-0067 refresh and replays the meta-session's commits in the
 * object store; every refusal leaves the session, its refs and the ledger as they were.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ProjectConfig, ResolvedProject } from "../config/index.js";
import { BASE_REFRESH_EVENT, SESSION_REBASED_EVENT } from "../git/index.js";
import { createIdGenerator, type IdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord } from "../ledger/index.js";
import { toResolved } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { type BaseToolDeps, rebaseSessionTool, refreshProjectBase } from "./base-tools.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Agent Author",
  GIT_AUTHOR_EMAIL: "author@example.test",
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
const IDENTITY = { name: "Switchboard Bot", email: "sb@example.test" };

let root: string;
let bare: string;
let pusher: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ids: IdGenerator;
let ledger: Ledger;
let deps: BaseToolDeps;

function remoteCommit(name: string, content = `${name}\n`): string {
  writeFileSync(path.join(pusher, name), content);
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
      identity: IDENTITY,
      ...over,
    },
  ],
});
const project = (over: Partial<ProjectConfig["contexts"][number]> = {}): ResolvedProject =>
  toResolved(definition(over));
const pathProject = (): ResolvedProject => {
  const { clone_url: _drop, ...ctx } = definition().contexts[0] as ProjectConfig["contexts"][number];
  return toResolved({ ...definition(), contexts: [ctx] });
};

function newRun(sessionId: string): RunRecord {
  const created = ledger.createRun({
    metaSessionId: sessionId,
    trustProfile: "edit-untrusted",
    policySnapshot: profile,
    request: { objective: "t", workspace: repo, constraints: [], trust_profile: "edit-untrusted", provider: "fake" },
    requestHash: "h",
    clientId: "orch",
    provider: "fake",
    projectId: "whumpo-website",
  });
  return ledger.getRunRecord(created.id) as RunRecord;
}
const finish = (run: RunRecord) =>
  ledger.casRunState({ runId: run.id, from: run.state, to: "CANCELLED", expectedVersion: run.version, payload: {} });

/** Commit `files` on a side branch starting at `from` (the repository's `main` is never moved) and return the tip. */
function sideCommits(from: string, files: Record<string, string>[], branch = "work"): string {
  g(repo, "checkout", "-q", "-B", branch, from);
  for (const set of files) {
    for (const [f, c] of Object.entries(set)) writeFileSync(path.join(repo, f), c);
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", `change ${Object.keys(set).join(",")}`);
  }
  const tip = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "main");
  return tip;
}

/** A meta-session whose finished first run left `head` on top of the clone's (stale) `main`. */
function session(head: (base: string) => string): { id: string; runId: string; base: string; head: string } {
  const id = ledger.createMetaSession({ objective: "t" }).id;
  const run = newRun(id);
  finish(run);
  const base = g(repo, "rev-parse", "refs/heads/main");
  const h = head(base);
  db.prepare(
    "UPDATE meta_session SET repo_root = ?, project_id = ?, base_commit = ?, head_commit = ? WHERE id = ?",
  ).run(repo, "whumpo-website", base, h, id);
  return { id, runId: run.id, base, head: h };
}
const sessionRow = (id: string) =>
  db.prepare("SELECT base_commit, head_commit FROM meta_session WHERE id = ?").get(id) as {
    base_commit: string;
    head_commit: string;
  };
const eventsOf = (runId: string, type: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-rebase-")));
  const seed = path.join(root, "seed");
  g(root, "init", "-q", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "init");
  bare = path.join(root, "remote.git");
  g(root, "clone", "-q", "--bare", seed, bare);
  repo = path.join(root, "clone");
  g(root, "clone", "-q", `file://${bare}`, repo);
  pusher = path.join(root, "pusher");
  g(root, "clone", "-q", `file://${bare}`, pusher);
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  deps = { db, ids, sourceEnv: { PATH: process.env.PATH } };
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("refresh_project_base (ADR-0074)", () => {
  it("fetches the remote tip now and returns base, previous and remote commits, recorded on the anchor run", async () => {
    const s = session((b) => b);
    const before = g(repo, "rev-parse", "refs/remotes/origin/main");
    const tip = remoteCommit("pr-301.txt");
    const r = await refreshProjectBase(deps, project(), () => s.runId);
    expect(r).toEqual({
      project_id: "whumpo-website",
      base_ref: "main",
      remote: "origin",
      base_commit: tip,
      previous_commit: before,
      remote_commit: tip,
      reason: "ADVANCED",
    });
    expect(g(repo, "rev-parse", "refs/heads/main")).toBe(before);
    expect(eventsOf(s.runId, BASE_REFRESH_EVENT)).toEqual([expect.objectContaining({ outcome: "fetched" })]);
  });

  it("refuses a project that is not remote-backed, and reports a failed fetch with its reason", async () => {
    await expect(refreshProjectBase(deps, pathProject(), () => undefined)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "NOT_REMOTE_BACKED" },
    });
    g(repo, "remote", "set-url", "origin", `file://${path.join(root, "gone.git")}`);
    await expect(refreshProjectBase(deps, project(), () => undefined)).rejects.toMatchObject({
      code: "TOOL_FAILURE",
      retryable: true,
      details: { reason: "BASE_REFRESH_FAILED", fetch_reason: "FETCH_FAILED" },
    });
  });
});

describe("rebase_session (ADR-0074)", () => {
  it("replays the session onto the fresh base; the next run starts from the rebased head", async () => {
    const s = session((b) => sideCommits(b, [{ "feature.txt": "one\n" }, { "feature.txt": "two\n" }]));
    const merged299 = remoteCommit("pr-299.txt");
    const merged300 = remoteCommit("pr-300.txt");
    const r = await rebaseSessionTool(deps, { id: s.id, repoRoot: repo }, project(), s.head);
    expect(r).toMatchObject({ session_id: s.id, previous_head: s.head, base_commit: merged300, rebased_commits: 2 });
    expect(r.publish).toBeUndefined();
    expect(g(repo, "rev-parse", `${r.new_head}~2`)).toBe(merged300);
    expect(g(repo, "merge-base", "--is-ancestor", merged299, r.new_head)).toBe("");
    expect(g(repo, "show", `${r.new_head}:feature.txt`)).toBe("two");
    expect(g(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>", r.new_head)).toBe(
      "Agent Author <author@example.test>|Switchboard <switchboard@localhost>",
    );
    expect(sessionRow(s.id)).toEqual({ base_commit: merged300, head_commit: r.new_head });
    expect(eventsOf(s.runId, SESSION_REBASED_EVENT)).toEqual([
      expect.objectContaining({
        previous_head: s.head,
        new_head: r.new_head,
        previous_base_commit: s.base,
        base_commit: merged300,
        rebased_commits: 2,
        publish: null,
      }),
    ]);

    // The next run of the meta-session continues from the rebased head.
    const ws = new WorkspaceManager({
      db,
      artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
      dataDir,
      allowedRoots: [root],
      ids,
    });
    let next = newRun(s.id);
    for (const [to, rule] of [
      ["PREFLIGHT", "T4"],
      ["LEASED", "T5"],
    ] as const) {
      next = ledger.casRunState({
        runId: next.id,
        from: next.state,
        to,
        expectedVersion: next.version,
        payload: { rule },
      }) as RunRecord;
    }
    const prepared = await ws.prepare({
      metaSessionId: s.id,
      runId: next.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
      baseRef: "main",
    });
    expect(prepared.mode === "worktree" && prepared.baseCommit).toBe(r.new_head);
  });

  it("refuses a conflict with the conflicting paths and changes nothing", async () => {
    const s = session((b) => sideCommits(b, [{ "README.md": "session edit\n" }]));
    remoteCommit("README.md", "upstream edit\n");
    const trackingBefore = g(repo, "rev-parse", "refs/remotes/origin/main");
    await expect(rebaseSessionTool(deps, { id: s.id, repoRoot: repo }, project(), undefined)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "CONFLICT", conflicting_paths: ["README.md"] },
    });
    expect(sessionRow(s.id)).toEqual({ base_commit: s.base, head_commit: s.head });
    expect(eventsOf(s.runId, SESSION_REBASED_EVENT)).toEqual([]);
    // Only the recorded fetch moved the tracking ref (as any refresh does); no session ref moved.
    expect(g(repo, "rev-parse", "refs/remotes/origin/main")).not.toBe(trackingBefore);
  });

  it("refuses while a run of the session is active, before any fetch", async () => {
    const s = session((b) => sideCommits(b, [{ "a.txt": "a\n" }]));
    const active = newRun(s.id);
    remoteCommit("later.txt");
    const before = g(repo, "rev-parse", "refs/remotes/origin/main");
    await expect(rebaseSessionTool(deps, { id: s.id, repoRoot: repo }, project(), undefined)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "ACTIVE_RUN", run_id: active.id },
    });
    expect(g(repo, "rev-parse", "refs/remotes/origin/main")).toBe(before);
    expect(sessionRow(s.id)).toEqual({ base_commit: s.base, head_commit: s.head });
  });

  it("refuses a moved expected head and a project that is not remote-backed", async () => {
    const s = session((b) => sideCommits(b, [{ "a.txt": "a\n" }]));
    remoteCommit("later.txt");
    await expect(rebaseSessionTool(deps, { id: s.id, repoRoot: repo }, project(), s.base)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "HEAD_MOVED" },
    });
    await expect(rebaseSessionTool(deps, { id: s.id, repoRoot: repo }, pathProject(), undefined)).rejects.toMatchObject(
      { code: "INVALID_REQUEST", details: { reason: "NOT_REMOTE_BACKED" } },
    );
    expect(sessionRow(s.id)).toEqual({ base_commit: s.base, head_commit: s.head });
  });

  it("replays the publish chain with provenance and the project identity; refuses when signing is required", async () => {
    const s = session((b) => sideCommits(b, [{ "a.txt": "a\n" }]));
    const published = sideCommits(s.base, [{ "a.txt": "a\n" }], "pub");
    const publishRef = `refs/switchboard/publish/${s.id}`;
    g(repo, "update-ref", publishRef, published);
    db.prepare(
      `INSERT INTO git_commit (id, commit_sha, tree_sha, repo_root, publish_ref, project_id, context_id, meta_session_id,
         run_id, provider, harness, origin, sanitizer_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'whumpo-website', 'main', ?, ?, 'fake', 'fake', 'commit_tool', '{}', ?)`,
    ).run(
      ids.id("gcm"),
      published,
      g(repo, "rev-parse", `${published}^{tree}`),
      repo,
      publishRef,
      s.id,
      s.runId,
      new Date().toISOString(),
    );
    const fresh = remoteCommit("pr-300.txt");

    await expect(
      rebaseSessionTool(deps, { id: s.id, repoRoot: repo }, project({ sign: true }), undefined),
    ).rejects.toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "SIGNING_UNAVAILABLE" } });
    expect(g(repo, "rev-parse", publishRef)).toBe(published);

    const r = await rebaseSessionTool(deps, { id: s.id, repoRoot: repo }, project(), undefined);
    expect(r.publish).toEqual({ previous_tip: published, new_tip: expect.any(String) });
    const tip = r.publish?.new_tip as string;
    expect(g(repo, "rev-parse", publishRef)).toBe(tip);
    expect(g(repo, "rev-parse", `${tip}^`)).toBe(fresh);
    expect(g(repo, "log", "-1", "--format=%cn <%ce>", tip)).toBe(`${IDENTITY.name} <${IDENTITY.email}>`);
    expect(ledger.latestPublishedHead(publishRef)).toBe(tip);
    expect(ledger.listGitCommitsForMetaSession(s.id).map((c) => c.commit_sha)).toEqual([published, tip]);
  });
});
