/**
 * Base refresh tests (FR-PRJ-02 note, LLD §5.2, ADR-0067) on temporary local repositories with a `file` remote: the
 * daemon fetches the base branch into its remote-tracking ref only, a first worktree starts from the fetched commit
 * when it fast-forwards the local branch, the refresh is skipped while another run of the repository is leased, and the
 * ref guard accepts exactly the recorded fetch while an agent-made tracking-ref move stays a violation.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator, type IdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord } from "../ledger/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { BASE_REFRESH_EVENT, fetchArgs, refreshBase } from "./base-refresh.js";
import { GIT_POLICY_VIOLATION_EVENT, RefGuard, type ViolationEntry } from "./ref-guard.js";

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

let root: string;
let upstream: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ids: IdGenerator;
let ledger: Ledger;

const profile: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

function manager(remote: string | undefined): WorkspaceManager {
  return new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
    ...(remote !== undefined
      ? {
          baseRefresh: async (input) =>
            (await refreshBase(db, { ...input, remote }, { ids, sourceEnv: { PATH: process.env.PATH } })).baseCommit,
        }
      : {}),
  });
}

/** A project run of a new meta-session walked to LEASED, then prepared with `base_ref: main`. */
async function preparedRun(ws: WorkspaceManager, opts: { running?: boolean } = {}) {
  const sessionId = ledger.createMetaSession({ objective: "t" }).id;
  const created = ledger.createRun({
    metaSessionId: sessionId,
    trustProfile: "edit-untrusted",
    policySnapshot: profile,
    request: { objective: "t", workspace: repo, constraints: [], trust_profile: "edit-untrusted", provider: "fake" },
    requestHash: "h",
    clientId: "c",
    provider: "fake",
    projectId: "p",
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
  if (opts.running !== false) {
    cur = ledger.getRunRecord(cur.id) as RunRecord;
    ledger.casRunState({
      runId: cur.id,
      from: cur.state,
      to: "RUNNING",
      expectedVersion: cur.version,
      payload: { rule: "T9" },
    });
  }
  return { runId: cur.id, prepared };
}

const refreshEvents = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === BASE_REFRESH_EVENT)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

function upstreamCommit(name: string): string {
  writeFileSync(path.join(upstream, name), `${name}\n`);
  g(upstream, "add", "-A");
  g(upstream, "commit", "-q", "-m", name);
  return g(upstream, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-bref-")));
  upstream = path.join(root, "upstream");
  mkdirSync(upstream);
  g(upstream, "init", "-q", "-b", "main");
  upstreamCommit("README.md");
  repo = path.join(root, "repo");
  g(root, "clone", "-q", upstream, repo);
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ids = createIdGenerator();
  ledger = createLedger(db, { ids });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("base refresh (LLD §5.2)", () => {
  it("builds a fetch of one non-forced refspec into the remote-tracking ref, with hooks off and no tags", () => {
    const args = fetchArgs("origin", "main");
    expect(args.slice(-3)).toEqual(["--", "origin", "refs/heads/main:refs/remotes/origin/main"]);
    expect(args).toContain("core.hooksPath=/dev/null");
    expect(args).toContain("--no-tags");
    expect(args.some((a) => a.startsWith("+"))).toBe(false);
    expect(() => fetchArgs("https://example.test/x", "main")).toThrow();
    expect(() => fetchArgs("origin", "+main")).toThrow();
  });

  it("starts a first worktree at the fetched remote tip and never moves the local branch", async () => {
    const localMain = g(repo, "rev-parse", "refs/heads/main");
    const ahead = upstreamCommit("new.txt");
    const { runId, prepared } = await preparedRun(manager("origin"));
    expect(prepared.mode === "worktree" && prepared.baseCommit).toBe(ahead);
    expect(g(repo, "rev-parse", "refs/heads/main")).toBe(localMain);
    expect(g(repo, "rev-parse", "refs/remotes/origin/main")).toBe(ahead);
    expect(refreshEvents(runId)).toEqual([
      expect.objectContaining({
        outcome: "fetched",
        reason: "ADVANCED",
        remote: "origin",
        tracking_ref: "refs/remotes/origin/main",
        local_sha: localMain,
        tracking_before: localMain,
        tracking_after: ahead,
        base_commit: ahead,
      }),
    ]);
    // Never a URL in the record.
    expect(JSON.stringify(refreshEvents(runId))).not.toContain(upstream);
  });

  it("keeps the local branch when it is ahead of the remote, and without base_remote does nothing", async () => {
    writeFileSync(path.join(repo, "local.txt"), "x\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "local");
    const localMain = g(repo, "rev-parse", "HEAD");
    const a = await preparedRun(manager("origin"));
    expect(a.prepared.mode === "worktree" && a.prepared.baseCommit).toBe(localMain);
    expect(refreshEvents(a.runId)).toEqual([expect.objectContaining({ outcome: "fetched", reason: "LOCAL_AHEAD" })]);

    upstreamCommit("later.txt");
    const before = g(repo, "rev-parse", "refs/remotes/origin/main");
    const b = await preparedRun(manager(undefined));
    expect(b.prepared.mode === "worktree" && b.prepared.baseCommit).toBe(localMain);
    expect(refreshEvents(b.runId)).toEqual([]);
    expect(g(repo, "rev-parse", "refs/remotes/origin/main")).toBe(before);
  });

  it("does not use a tracking ref left by a failed fetch", async () => {
    const ahead = upstreamCommit("ahead.txt");
    const a = await preparedRun(
      new WorkspaceManager({
        db,
        artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
        dataDir,
        allowedRoots: [root],
        ids,
        baseRefresh: async (input) =>
          (
            await refreshBase(
              db,
              { ...input, remote: "origin" },
              {
                ids,
                runFetch: async (cwd) => {
                  // The fetch moves the ref, then reports failure: the moved value is not trusted.
                  execFileSync("git", ["fetch", "-q", "origin", "main:refs/remotes/origin/main"], {
                    cwd,
                    env: GIT_ENV,
                  });
                  return { code: 1, stdout: "", stderr: "", timedOut: false, spawnError: false };
                },
              },
            )
          ).baseCommit,
      }),
    );
    expect(g(repo, "rev-parse", "refs/remotes/origin/main")).toBe(ahead);
    expect(a.prepared.mode === "worktree" && a.prepared.baseCommit).toBe(g(repo, "rev-parse", "main"));
    expect(refreshEvents(a.runId)).toEqual([expect.objectContaining({ outcome: "failed", reason: "FETCH_FAILED" })]);
  });

  it("skips the fetch while another run of the repository holds a lease, using only a recorded fetched value", async () => {
    const ws = manager("origin");
    const first = upstreamCommit("one.txt");
    const a = await preparedRun(ws);
    expect(a.prepared.mode === "worktree" && a.prepared.baseCommit).toBe(first);
    upstreamCommit("two.txt");
    const b = await preparedRun(ws);
    // Run A still holds its lease: no fetch, the tracking ref stays where the controller recorded it.
    expect(refreshEvents(b.runId)).toEqual([expect.objectContaining({ outcome: "skipped", reason: "REPO_BUSY" })]);
    expect(b.prepared.mode === "worktree" && b.prepared.baseCommit).toBe(first);
    expect(g(repo, "rev-parse", "refs/remotes/origin/main")).toBe(first);
  });

  it("does not trust a tracking ref the controller did not record", async () => {
    const ws = manager("origin");
    await preparedRun(ws);
    // Something other than the controller (an agent) points the tracking ref at a commit of its choosing that would
    // fast-forward the local branch.
    const evil = g(repo, "commit-tree", "-p", "main", "-m", "evil", "main^{tree}");
    g(repo, "update-ref", "refs/remotes/origin/main", evil);
    const b = await preparedRun(ws);
    expect(refreshEvents(b.runId)).toEqual([expect.objectContaining({ outcome: "skipped", reason: "REPO_BUSY" })]);
    expect(b.prepared.mode === "worktree" && b.prepared.baseCommit).toBe(g(repo, "rev-parse", "main"));
  });

  it("refuses unsafe repository configuration and credential-carrying URLs before any fetch", async () => {
    g(repo, "config", "core.sshCommand", "true");
    const a = await preparedRun(manager("origin"));
    expect(refreshEvents(a.runId)).toEqual([
      expect.objectContaining({ outcome: "skipped", reason: "REPO_CONFIG_UNSAFE" }),
    ]);
    manager(undefined).releaseLease(a.runId);
    g(repo, "config", "--unset", "core.sshCommand");
    g(repo, "remote", "set-url", "origin", "https://user:secret@example.test/r.git");
    const b = await preparedRun(manager("origin"));
    expect(refreshEvents(b.runId)).toEqual([
      expect.objectContaining({ outcome: "skipped", reason: "REMOTE_URL_CREDENTIALS" }),
    ]);
    expect(JSON.stringify(refreshEvents(b.runId))).not.toContain("secret");
  });

  it("ref guard: accepts exactly the recorded fetch, and an agent-made tracking-ref move stays a violation", async () => {
    const ws = manager("origin");
    const guard = new RefGuard({ ledger });
    const a = await preparedRun(ws);
    await guard.snapshotAtLeased(a.runId);
    // A concurrent controller refresh (as if A's lease check raced it): recorded, then the tracking ref moves, and with
    // it the symbolic `refs/remotes/origin/HEAD` the clone created.
    const ahead = upstreamCommit("ahead.txt");
    const other = ledger.createMetaSession({ objective: "o" }).id;
    const otherRun = ledger.createRun({
      metaSessionId: other,
      trustProfile: "edit-untrusted",
      policySnapshot: profile,
      request: { objective: "o", workspace: repo, constraints: [], trust_profile: "edit-untrusted", provider: "fake" },
      requestHash: "h",
      clientId: "c",
      provider: "fake",
    });
    db.prepare("UPDATE meta_session SET lease_run_id = NULL WHERE lease_run_id = ?").run(a.runId);
    const r = await refreshBase(
      db,
      { runId: otherRun.id, metaSessionId: other, repoRoot: repo, baseRef: "main", remote: "origin" },
      { ids, sourceEnv: { PATH: process.env.PATH } },
    );
    expect(r).toMatchObject({ outcome: "fetched", reason: "ADVANCED", baseCommit: ahead });
    const checkA = await guard.checkAtFinalizing(a.runId);
    expect(checkA.result).toBe("clean");

    // A second run whose agent rewinds the tracking ref to an OLDER controller-fetched value (the clone's first commit,
    // recorded by run A's refresh): only the newest recorded fetch is accepted, so it and its symref are violations.
    const b = await preparedRun(ws);
    await guard.snapshotAtLeased(b.runId);
    const main = g(repo, "rev-parse", "main");
    g(repo, "update-ref", "refs/remotes/origin/main", main);
    expect((await guard.checkAtFinalizing(b.runId)).result).toBe("violation");
    const violations = ledger
      .listRunEvents(b.runId)
      .filter((e) => e.type === GIT_POLICY_VIOLATION_EVENT)
      .flatMap((e) => (JSON.parse(e.payload_json) as { violations: ViolationEntry[] }).violations);
    expect(violations).toEqual([
      expect.objectContaining({ scope: "other", ref: "refs/remotes/origin/HEAD", old: ahead, new: main }),
      expect.objectContaining({
        scope: "other",
        ref: "refs/remotes/origin/main",
        old: ahead,
        new: main,
        action: "report",
      }),
    ]);
  });
});
