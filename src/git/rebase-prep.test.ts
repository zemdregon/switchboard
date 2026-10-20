/**
 * T15.7 (FR-QUE-07, LLD §20.4): the controller merges the current base into a rebase run's worktree files, leaving the
 * worktree's HEAD and index alone and conflict markers for the agent. Real Git in temporary directories.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger/index.js";
import { prepareRebaseMerge } from "./index.js";

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
function gRc(cwd: string, ...args: string[]): number {
  try {
    execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

const RUN = "run_01J9ZABCDEFGHJKMNPQRSTVWXY";
const NOW_ISO = "2026-10-19T10:00:00.000Z";

let root: string;
let repo: string;
let wt: string;
let db: Database.Database;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-rebase-prep-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "gone.txt"), "deleted on main\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  // The published branch (the worktree's HEAD) diverges from main.
  wt = path.join(root, "wt");
  g(repo, "worktree", "add", "-q", "-b", "pub", wt);
  writeFileSync(path.join(wt, "pub.txt"), "published work\n");
  g(wt, "add", "-A");
  g(wt, "commit", "-q", "-m", "published");
  db = openLedger(path.join(root, "ledger"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function pending(): void {
  db.prepare(
    `INSERT INTO run_rebase (run_id, work_item_id, publish_ref, head_sha, state, created_at, updated_at)
     VALUES (?, 'pwi_1', 'refs/heads/pub', ?, 'pending', ?, ?)`,
  ).run(RUN, g(wt, "rev-parse", "HEAD"), NOW_ISO, NOW_ISO);
}

const rowOf = () =>
  db.prepare("SELECT * FROM run_rebase WHERE run_id = ?").get(RUN) as
    | { state: string; merge_parent_sha: string | null; conflicted_paths: number | null; updated_at: string }
    | undefined;

const prep = (baseRef = "main") =>
  prepareRebaseMerge(db, { runId: RUN, worktreePath: wt, repoRoot: repo, baseRef, nowIso: NOW_ISO });

describe("prepareRebaseMerge (T15.7, FR-QUE-07, LLD §20.4)", () => {
  it("clean merge: prepared with 0 conflicts, base changes in the files, HEAD and index unchanged", async () => {
    writeFileSync(path.join(repo, "base.txt"), "from base\n");
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\nfour\n");
    rmSync(path.join(repo, "gone.txt"));
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "base moves");
    const base = g(repo, "rev-parse", "main");
    pending();
    const head = g(wt, "rev-parse", "HEAD");

    const r = await prep();

    expect(r).toEqual({ ok: true, mergeParentSha: base, conflictedPaths: 0 });
    expect(rowOf()).toMatchObject({ state: "prepared", merge_parent_sha: base, conflicted_paths: 0 });
    expect(readFileSync(path.join(wt, "base.txt"), "utf8")).toBe("from base\n");
    expect(readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\n");
    expect(readFileSync(path.join(wt, "pub.txt"), "utf8")).toBe("published work\n");
    expect(existsSync(path.join(wt, "gone.txt"))).toBe(false);
    expect(g(wt, "rev-parse", "HEAD")).toBe(head);
    expect(gRc(wt, "diff", "--cached", "--quiet")).toBe(0);
    // The merge result shows as ordinary worktree changes.
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: wt, env: GIT_ENV, encoding: "utf8" });
    expect(
      status
        .split("\0")
        .filter((l) => l !== "")
        .sort(),
    ).toEqual([" D gone.txt", " M a.txt", "?? base.txt"]);
  });

  it("conflicting merge: prepared with conflicted_paths >= 1 and conflict markers in the file", async () => {
    writeFileSync(path.join(repo, "a.txt"), "one\nTWO on main\nthree\n");
    g(repo, "commit", "-q", "-am", "main edits a");
    writeFileSync(path.join(wt, "a.txt"), "one\nTWO on pub\nthree\n");
    g(wt, "commit", "-q", "-am", "pub edits a");
    pending();
    const head = g(wt, "rev-parse", "HEAD");

    const r = await prep();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflictedPaths).toBe(1);
    expect(r.mergeParentSha).toBe(g(repo, "rev-parse", "main"));
    expect(rowOf()).toMatchObject({ state: "prepared", conflicted_paths: 1, merge_parent_sha: r.mergeParentSha });
    const text = readFileSync(path.join(wt, "a.txt"), "utf8");
    expect(text).toContain("<<<<<<<");
    expect(text).toContain(">>>>>>>");
    expect(g(wt, "rev-parse", "HEAD")).toBe(head);
    expect(gRc(wt, "diff", "--cached", "--quiet")).toBe(0);
  });

  it("no pending row: NO_PENDING and nothing is written", async () => {
    expect(await prep()).toEqual({ ok: false, reason: "NO_PENDING" });
    expect(rowOf()).toBeUndefined();
    pending();
    db.prepare("UPDATE run_rebase SET state = 'prepared' WHERE run_id = ?").run(RUN);
    expect(await prep()).toEqual({ ok: false, reason: "NO_PENDING" });
    expect(rowOf()).toMatchObject({ state: "prepared", merge_parent_sha: null });
  });

  it("unresolvable base: failed with BASE_UNRESOLVED, worktree untouched; Git text is not recorded", async () => {
    pending();
    const head = g(wt, "rev-parse", "HEAD");
    expect(await prep("no-such-branch")).toEqual({ ok: false, reason: "BASE_UNRESOLVED" });
    expect(rowOf()).toMatchObject({ state: "failed", merge_parent_sha: null, conflicted_paths: null });
    expect(g(wt, "rev-parse", "HEAD")).toBe(head);
    expect(g(wt, "status", "--porcelain")).toBe("");
    // An option-shaped ref is a revision, never an option.
    db.prepare("UPDATE run_rebase SET state = 'pending' WHERE run_id = ?").run(RUN);
    expect(await prep("--output=x")).toEqual({ ok: false, reason: "BASE_UNRESOLVED" });
    expect(JSON.stringify(rowOf())).not.toMatch(/fatal|unknown revision/u);
  });

  it("a dirty worktree is refused (WORKTREE_DIRTY) and left as it was", async () => {
    writeFileSync(path.join(repo, "base.txt"), "from base\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "base moves");
    writeFileSync(path.join(wt, "scratch.txt"), "untracked\n");
    pending();
    expect(await prep()).toEqual({ ok: false, reason: "WORKTREE_DIRTY" });
    expect(rowOf()?.state).toBe("failed");
    expect(existsSync(path.join(wt, "base.txt"))).toBe(false);
  });
});
