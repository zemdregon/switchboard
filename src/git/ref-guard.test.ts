/**
 * T9.5 unit tests for `RefGuard` (FR-GIT-03, BR-27, LLD §12.5, ADR-0027) on temporary local repositories: the snapshot
 * cap with a tail digest, other runs' and sessions' controller-owned refs, idempotence, fail-closed paths and profile
 * independence. The fake-agent end-to-end cases are in `src/lifecycle/ref-guard.test.ts`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type TrustProfile } from "../ledger/index.js";
import { compactEvents } from "../mcp/envelope.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  DEFAULT_REF_GUARD_LIMITS,
  GIT_POLICY_VIOLATION_EVENT,
  GIT_REF_CHECK_EVENT,
  GIT_REF_SNAPSHOT_EVENT,
  RefGuard,
  type ViolationEntry,
} from "./ref-guard.js";

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
const gIn = (cwd: string, input: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, input, encoding: "utf8" });

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let workspace: WorkspaceManager;

const profile = (name: TrustProfile, bypassApproved = false): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved,
});

/** A run with a prepared worktree, walked to `RUNNING` (or left at LEASED). */
async function preparedRun(opts: { trust?: TrustProfile; running?: boolean; sessionId?: string } = {}) {
  const trust = opts.trust ?? "edit-untrusted";
  const sessionId = opts.sessionId ?? ledger.createMetaSession({ objective: "t" }).id;
  const created = ledger.createRun({
    metaSessionId: sessionId,
    trustProfile: trust,
    policySnapshot: profile(trust, trust === "privileged"),
    request: { objective: "t", workspace: repo, constraints: [], trust_profile: trust, provider: "fake" },
    requestHash: "h",
    clientId: "c",
    provider: "fake",
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
  await workspace.prepare({ metaSessionId: sessionId, runId: cur.id, workspace: repo, trustProfile: trust });
  cur = ledger.getRunRecord(cur.id) as RunRecord;
  if (opts.running !== false) {
    cur = ledger.casRunState({
      runId: cur.id,
      from: cur.state,
      to: "RUNNING",
      expectedVersion: cur.version,
      payload: { rule: "T9" },
    }) as RunRecord;
  }
  return { run: cur, sessionId, branch: `refs/heads/${cur.branch}`, worktree: cur.worktree_path as string };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, json: e.payload_json, p: JSON.parse(e.payload_json) }));
const violationsOf = (runId: string): ViolationEntry[] =>
  events(runId)
    .filter((e) => e.type === GIT_POLICY_VIOLATION_EVENT)
    .flatMap((e) => e.p.violations as ViolationEntry[]);

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-refu-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  workspace = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("RefGuard (T9.5)", () => {
  it("caps a large ref listing: bounded payload, exact names inside the cap, a tail digest beyond it", async () => {
    const head = g(repo, "rev-parse", "HEAD");
    const lines = Array.from({ length: 3000 }, (_, i) => `create refs/tags/t${String(i).padStart(5, "0")} ${head}\n`);
    gIn(repo, lines.join(""), "update-ref", "--stdin");
    const guard = new RefGuard({ ledger, limits: { maxListedRefs: 100 } });
    const { run } = await preparedRun();
    const started = Date.now();
    const snap = await guard.snapshotAtLeased(run.id);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(snap.ref_count).toBeGreaterThan(3000);
    expect(snap.refs).toHaveLength(100);
    expect(snap.truncated).toBe(true);
    expect(snap.tail?.count).toBeGreaterThan(2900);
    const stored = events(run.id).find((e) => e.type === GIT_REF_SNAPSHOT_EVENT);
    expect(stored?.json.length).toBeLessThan(20_000);

    // A ref inside the listed range is named exactly; one in the tail is caught by the digest.
    g(repo, "branch", "aaa-agent"); // sorts before every tag, inside the listed range
    g(repo, "tag", "-d", "t02999");
    const r = await guard.checkAtFinalizing(run.id);
    expect(r).toMatchObject({ result: "violation", violations: 2 });
    expect(violationsOf(run.id).map((v) => [v.scope, v.kind, v.ref])).toEqual([
      ["other", "created", "refs/heads/aaa-agent"],
      ["unlisted", "unlisted_refs_changed", null],
    ]);
  });

  it("the default limits stop at 5000 listed refs and about 1 MiB", async () => {
    const head = g(repo, "rev-parse", "HEAD");
    const lines = Array.from({ length: 6000 }, (_, i) => `create refs/tags/t${String(i).padStart(5, "0")} ${head}\n`);
    gIn(repo, lines.join(""), "update-ref", "--stdin");
    const { run } = await preparedRun();
    const snap = await new RefGuard({ ledger }).snapshotAtLeased(run.id);
    expect(snap.refs).toHaveLength(DEFAULT_REF_GUARD_LIMITS.maxListedRefs);
    expect(snap.truncated).toBe(true);
    const stored = events(run.id).find((e) => e.type === GIT_REF_SNAPSHOT_EVENT);
    expect(stored?.json.length).toBeLessThan(DEFAULT_REF_GUARD_LIMITS.maxListedBytes + 64 * 1024);
    expect(await new RefGuard({ ledger }).checkAtFinalizing(run.id)).toMatchObject({ result: "clean" });
  }, 30_000);

  it("other runs' controller moves are not flagged; the same refs moved elsewhere are", async () => {
    const guard = new RefGuard({ ledger });
    const a = await preparedRun();
    const b = await preparedRun();
    await guard.snapshotAtLeased(b.run.id);
    // Run A's own controller checkpoint while B runs (concurrent controller activity on A's run branch).
    writeFileSync(path.join(a.worktree, "a.txt"), "a\n");
    await workspace.finalize(a.run.id);
    // A third run created meanwhile (its branch appears at its base checkpoint).
    const c = await preparedRun();
    expect(await guard.checkAtFinalizing(b.run.id)).toMatchObject({ result: "clean" });

    const d = await preparedRun();
    await guard.snapshotAtLeased(d.run.id);
    const foreign = g(repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "not a checkpoint");
    g(repo, "update-ref", a.branch, foreign); // not one of A's checkpoints
    g(repo, "update-ref", "refs/heads/switchboard/not-a-run", "main");
    expect(await guard.checkAtFinalizing(d.run.id)).toMatchObject({ result: "violation", violations: 2 });
    expect(violationsOf(d.run.id).map((v) => [v.scope, v.kind, v.ref, v.action])).toEqual([
      ["switchboard", "created", "refs/heads/switchboard/not-a-run", "report"],
      ["switchboard", "moved", a.branch, "report"],
    ]);
    expect(c.branch).not.toBe(a.branch);
  });

  it("ADR-0073: the merge gate's fetch namespace may change during a run; the ref next to it may not", async () => {
    const guard = new RefGuard({ ledger });
    const a = await preparedRun();
    g(repo, "update-ref", "refs/switchboard/merge-gate/origin/pr-1/head", "main");
    await guard.snapshotAtLeased(a.run.id);
    const other = g(repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "fetched");
    g(repo, "update-ref", "refs/switchboard/merge-gate/origin/pr-1/head", other);
    g(repo, "update-ref", "refs/switchboard/merge-gate/origin/pr-1/base", other);
    g(repo, "update-ref", "refs/switchboard/merge-gate-not/x", other);
    expect(await guard.checkAtFinalizing(a.run.id)).toMatchObject({ result: "violation", violations: 1 });
    expect(violationsOf(a.run.id).map((v) => [v.scope, v.kind, v.ref])).toEqual([
      ["other", "created", "refs/switchboard/merge-gate-not/x"],
    ]);
  });

  it("get_run events show the MCP client the snapshot digest and counts, not the repository's ref names", async () => {
    g(repo, "branch", "operator-private-topic");
    const { run } = await preparedRun();
    await new RefGuard({ ledger }).snapshotAtLeased(run.id);
    const shown = compactEvents(ledger, run.id, 0, 100, (x) => x).find((e) => e.type === GIT_REF_SNAPSHOT_EVENT);
    expect(shown?.payload).toMatchObject({ v: 1, phase: "leased", refs_listed: 3 });
    expect(JSON.stringify(shown)).not.toContain("operator-private-topic");
  });

  it("is idempotent: a second check writes nothing", async () => {
    const guard = new RefGuard({ ledger });
    const { run } = await preparedRun();
    await guard.snapshotAtLeased(run.id);
    await guard.snapshotAtLeased(run.id);
    expect(events(run.id).filter((e) => e.type === GIT_REF_SNAPSHOT_EVENT)).toHaveLength(1);
    g(repo, "tag", "agent-tag");
    expect((await guard.checkAtFinalizing(run.id)).result).toBe("violation");
    const n = events(run.id).length;
    expect(await guard.checkAtFinalizing(run.id)).toEqual({ result: "already_checked", violations: 0 });
    expect(events(run.id)).toHaveLength(n);
  });

  it("fails closed: an unreadable repository is a check_failed violation, not a silent pass", async () => {
    const guard = new RefGuard({ ledger });
    const { run } = await preparedRun();
    await guard.snapshotAtLeased(run.id);
    renameSync(repo, `${repo}-moved`);
    try {
      expect(await guard.checkAtFinalizing(run.id)).toMatchObject({ result: "failed", violations: 1 });
      expect(violationsOf(run.id)).toMatchObject([{ scope: "guard", kind: "check_failed" }]);
      expect(events(run.id).find((e) => e.type === GIT_REF_CHECK_EVENT)?.p).toMatchObject({ result: "failed" });
    } finally {
      renameSync(`${repo}-moved`, repo);
    }
  });

  it("a run that reached RUNNING without a snapshot is flagged snapshot_missing and its own refs are still checked", async () => {
    const guard = new RefGuard({ ledger });
    const { run, branch, worktree } = await preparedRun();
    writeFileSync(path.join(worktree, "x.txt"), "x\n");
    g(worktree, "add", "-A");
    g(worktree, "commit", "-q", "-m", "agent");
    expect((await guard.checkAtFinalizing(run.id)).result).toBe("violation");
    expect(violationsOf(run.id).map((v) => [v.scope, v.kind])).toEqual([
      ["guard", "snapshot_missing"],
      ["run_branch", "moved"],
    ]);
    expect(g(repo, "rev-parse", branch)).toBe(ledger.getRunCheckpointCommit(run.id, "pre"));
  });

  it("skips (with an event) a run that never reached RUNNING and has no snapshot", async () => {
    const { run } = await preparedRun({ running: false });
    expect(await new RefGuard({ ledger }).checkAtFinalizing(run.id)).toEqual({ result: "skipped", violations: 0 });
    expect(events(run.id).find((e) => e.type === GIT_REF_CHECK_EVENT)?.p).toMatchObject({
      result: "skipped",
      reason: "no_snapshot_before_spawn",
    });
  });

  it("does not depend on the trust profile: a privileged bypass run is checked and restored the same way", async () => {
    const guard = new RefGuard({ ledger });
    const { run, branch, worktree } = await preparedRun({ trust: "privileged" });
    expect(JSON.parse(run.policy_snapshot_json).bypassApproved).toBe(true);
    await guard.snapshotAtLeased(run.id);
    writeFileSync(path.join(worktree, "x.txt"), "x\n");
    g(worktree, "add", "-A");
    g(worktree, "commit", "-q", "-m", "agent");
    g(worktree, "tag", "bypass-tag");
    expect(await guard.checkAtFinalizing(run.id)).toMatchObject({ result: "violation", violations: 2 });
    expect(g(repo, "rev-parse", branch)).toBe(ledger.getRunCheckpointCommit(run.id, "pre"));
  });
});
