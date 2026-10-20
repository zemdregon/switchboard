/**
 * T15.7 (FR-QUE-07, LLD §20.4; FR-GIT-04, FR-GIT-07, FR-GIT-08): a rebase run's first commit records the merged base
 * as its second parent, through the same sanitiser, compare-and-swap and provenance path. Real Git in temporary
 * directories; the signed case uses a throwaway key and skips without `gpg`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createThrowawaySigner, gpgAvailable } from "./fixtures/throwaway-gpg.js";
import { type CommitInput, GitPublisher, prepareRebaseMerge, publishRefFor } from "./index.js";

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

const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const NOW = new Date("2026-10-19T10:00:00Z");

let root: string;
let repo: string;
let scratch: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-mergepar-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  scratch = path.join(root, "scratch");
  mkdirSync(dataDir);
  db = openLedger(path.join(root, "ledger"));
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
    now: () => NOW,
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function running() {
  const session = ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    state: "RUNNING",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
    provider: "fake",
    projectId: "web",
  });
  const ws = await mgr.prepare({
    metaSessionId: session.id,
    runId: run.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
  });
  if (ws.mode !== "worktree") throw new Error("expected a worktree");
  return { session, run, ws, wt: ws.worktreePath };
}

/** The base moves on `main` after the run's worktree was made; returns the new base commit. */
function moveBase(content = "one\ntwo\nthree\nfour from base\n"): string {
  writeFileSync(path.join(repo, "a.txt"), content);
  writeFileSync(path.join(repo, "base.txt"), "from base\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "base moves");
  return g(repo, "rev-parse", "main");
}

function pendingRow(runId: string, headSha: string): void {
  db.prepare(
    `INSERT INTO run_rebase (run_id, work_item_id, publish_ref, head_sha, state, created_at, updated_at)
     VALUES (?, 'pwi_1', 'refs/heads/x', ?, 'pending', ?, ?)`,
  ).run(runId, headSha, NOW.toISOString(), NOW.toISOString());
}

async function preparedRebaseRun(baseContent?: string) {
  const r = await running();
  const base = moveBase(baseContent);
  pendingRow(r.run.id, r.ws.baseCommit);
  const prep = await prepareRebaseMerge(db, {
    runId: r.run.id,
    worktreePath: r.wt,
    repoRoot: repo,
    baseRef: "main",
    nowIso: NOW.toISOString(),
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.reason}`);
  expect(prep.mergeParentSha).toBe(base);
  return { ...r, base, conflicted: prep.conflictedPaths };
}

const publisher = (extra: Partial<ConstructorParameters<typeof GitPublisher>[0]> = {}) =>
  new GitPublisher({ db, scratchDir: scratch, now: () => NOW, ...extra });
const input = (runId: string, extra: Partial<CommitInput> = {}): CommitInput => ({
  runId,
  message: "Change things",
  identity: IDENTITY,
  projectId: "web",
  contextId: "main",
  ...extra,
});
const parentsOf = (sha: string) => g(repo, "rev-list", "--parents", "-n1", sha).split(" ").slice(1);
const eventsOf = (runId: string, type: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

describe("two-parent commit of a rebase run (T15.7, FR-QUE-07)", () => {
  it("records the merged base as parent 2, through the sanitiser and the provenance path", async () => {
    const { session, run, ws, wt, base } = await preparedRebaseRun();
    writeFileSync(path.join(wt, "agent.txt"), "agent work\n");

    const res = await publisher().commit(
      input(run.id, {
        message:
          "Merge the base\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      }),
    );

    expect(parentsOf(res.sha)).toEqual([ws.baseCommit, base]);
    expect(res.parentSha).toBe(ws.baseCommit);
    expect(res.mergeParentSha).toBe(base);
    expect(g(repo, "rev-parse", publishRefFor(session.id))).toBe(res.sha);
    // The sanitiser ran exactly as for a single-parent commit.
    expect(res.sanitizer.rules).toEqual({ "footer.generated-by": 1, "trailer.co-author": 1 });
    const body = g(repo, "log", "-1", "--format=%B", res.sha);
    expect(body).toBe("Merge the base");
    // The tree holds the base change and the agent's change; the files changed are counted against parent 1.
    expect(g(repo, "show", `${res.sha}:base.txt`)).toBe("from base");
    expect(g(repo, "show", `${res.sha}:agent.txt`)).toBe("agent work");
    expect(res.filesChanged).toBe(3);
    // Lineage check (FR-GIT-08): exactly one new commit on top of the base, the old head and the merge parent.
    expect(g(repo, "rev-list", "--count", res.sha, "--not", ws.baseCommit, base)).toBe("1");
    // Provenance: intent and git_commit event carry the second parent; the git_commit row is written.
    expect(eventsOf(run.id, "git_commit_intent")[0]).toMatchObject({
      parent_sha: ws.baseCommit,
      merge_parent_sha: base,
    });
    expect(eventsOf(run.id, "git_commit")[0]).toMatchObject({
      commit_sha: res.sha,
      parent_sha: ws.baseCommit,
      merge_parent_sha: base,
      sanitizer: { rules: { "footer.generated-by": 1, "trailer.co-author": 1 } },
    });
    expect(ledger.listGitCommits(run.id).map((r) => r.commit_sha)).toEqual([res.sha]);
  });

  it("a conflicted merge is committed with two parents once the agent resolves the markers", async () => {
    const r = await running();
    writeFileSync(path.join(r.wt, "a.txt"), "one\nTWO on run\nthree\n");
    // The worktree must be clean for the preparation: record the run's own change on its branch first.
    g(r.wt, "commit", "-q", "-am", "run edits a");
    const base = moveBase("one\nTWO on base\nthree\n");
    pendingRow(r.run.id, r.ws.baseCommit);
    const prep = await prepareRebaseMerge(db, { runId: r.run.id, worktreePath: r.wt, repoRoot: repo, baseRef: "main" });
    expect(prep).toMatchObject({ ok: true, conflictedPaths: 1 });
    expect(readFileSync(path.join(r.wt, "a.txt"), "utf8")).toContain("<<<<<<<");
    writeFileSync(path.join(r.wt, "a.txt"), "one\nTWO resolved\nthree\n");

    const res = await publisher().commit(input(r.run.id));

    expect(parentsOf(res.sha)).toEqual([r.ws.baseCommit, base]);
    expect(g(repo, "show", `${res.sha}:a.txt`)).toBe("one\nTWO resolved\nthree");
  });

  it("the second commit of the same run has a single parent", async () => {
    const { run, wt, base } = await preparedRebaseRun();
    const first = await publisher().commit(input(run.id));
    expect(parentsOf(first.sha)).toEqual([expect.any(String), base]);
    writeFileSync(path.join(wt, "later.txt"), "later\n");

    const second = await publisher().commit(input(run.id, { message: "Later change" }));

    expect(parentsOf(second.sha)).toEqual([first.sha]);
    expect(second.mergeParentSha).toBeUndefined();
    expect(eventsOf(run.id, "git_commit")[1]).not.toHaveProperty("merge_parent_sha");
    expect(eventsOf(run.id, "git_commit_intent")[1]).not.toHaveProperty("merge_parent_sha");
  });

  it("without a run_rebase row (or with one that is not prepared or names no commit) the commit is single parent", async () => {
    const { run, ws, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "changed\n");
    const plain = await publisher().commit(input(run.id));
    expect(parentsOf(plain.sha)).toEqual([ws.baseCommit]);
    expect(plain.mergeParentSha).toBeUndefined();
    expect(eventsOf(run.id, "git_commit")[0]).not.toHaveProperty("merge_parent_sha");

    // A pending row and a prepared row whose SHA is not a commit are both ignored.
    const base = moveBase();
    pendingRow(run.id, ws.baseCommit);
    db.prepare("UPDATE run_rebase SET merge_parent_sha = ? WHERE run_id = ?").run(base, run.id);
    writeFileSync(path.join(wt, "b.txt"), "b\n");
    const pendingCommit = await publisher().commit(input(run.id));
    expect(parentsOf(pendingCommit.sha)).toEqual([plain.sha]);
    db.prepare("UPDATE run_rebase SET state = 'prepared', merge_parent_sha = ? WHERE run_id = ?").run(
      "f".repeat(40),
      run.id,
    );
    writeFileSync(path.join(wt, "c.txt"), "c\n");
    const bogus = await publisher().commit(input(run.id));
    expect(parentsOf(bogus.sha)).toEqual([pendingCommit.sha]);
  });

  describe.skipIf(!gpgAvailable())("signed", () => {
    it("a signed rebase commit has both parents and a signature", async () => {
      const signer = createThrowawaySigner();
      try {
        const { run, ws, wt, base } = await preparedRebaseRun();
        writeFileSync(path.join(wt, "agent.txt"), "agent work\n");
        const res = await publisher({ signingEnv: signer.env }).commit(
          input(run.id, { sign: { reach: { ok: true } } }),
        );
        expect(parentsOf(res.sha)).toEqual([ws.baseCommit, base]);
        execFileSync("git", ["verify-commit", res.sha], { cwd: repo, env: signer.verifyEnv, stdio: "ignore" });
        expect(eventsOf(run.id, "git_commit")[0]).toMatchObject({ signed: true, merge_parent_sha: base });
      } finally {
        signer.dispose();
      }
    });
  });
});
