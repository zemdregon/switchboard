import type Database from "better-sqlite3";
import { GitError, git, gitText, parseGitVersion, versionAtLeast } from "../workspace/git.js";

/**
 * Controller-side preparation of a rebase run (T15.7; FR-QUE-07, LLD §20.4; FR-GIT-01). When a published ref has become
 * `CONFLICTING` with its base, the admission writes a `run_rebase` row (`pending`, migration 0027). Before the agent
 * starts, the controller (never the agent) merges the current base into the run's worktree files with
 * `git merge-tree --write-tree` (Git >= 2.38), leaving conflict markers for the agent to resolve, and records the base
 * commit as `merge_parent_sha` (`prepared`). The commit tool (`src/git/commit.ts`) then records that commit as the
 * second parent of the run's first commit, through the same sanitiser and provenance path.
 *
 * The worktree's own `HEAD` and index are left exactly as they were: the merged tree is written into the files with
 * `read-tree -u --reset` and the index is put back with `reset -q`, so the merge result shows as ordinary worktree
 * changes. Every Git call goes through the hardened helper in `src/workspace/git.ts`. The ledger receives reason codes
 * and counts only, never Git's output.
 */

/** `git merge-tree --write-tree` first shipped in Git 2.38.0. */
export const MIN_MERGE_TREE_GIT_VERSION = [2, 38, 0] as const;

export type RebasePrepFailure = "NO_PENDING" | "BASE_UNRESOLVED" | "GIT_TOO_OLD" | "MERGE_FAILED" | "WORKTREE_DIRTY";

export interface PrepareRebaseMergeInput {
  readonly runId: string;
  /** The run's worktree (created at the meta-session's publish head). */
  readonly worktreePath: string;
  /** The repository the base ref is resolved in. */
  readonly repoRoot: string;
  /** The published ref's base (a branch name or commit), resolved to a commit here. */
  readonly baseRef: string;
  readonly nowIso?: string;
}

export type PrepareRebaseMergeResult =
  | { readonly ok: true; readonly mergeParentSha: string; readonly conflictedPaths: number }
  | { readonly ok: false; readonly reason: RebasePrepFailure };

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;

/**
 * Merge the current base into the worktree of a `pending` rebase run and mark the row `prepared` (or `failed` with a
 * reason code). A run without a `pending` row is `NO_PENDING` and nothing is written.
 */
export async function prepareRebaseMerge(
  db: Database.Database,
  input: PrepareRebaseMergeInput,
): Promise<PrepareRebaseMergeResult> {
  const row = db.prepare("SELECT state FROM run_rebase WHERE run_id = ?").get(input.runId) as
    | { state: string }
    | undefined;
  if (row?.state !== "pending") return { ok: false, reason: "NO_PENDING" };
  const now = () => input.nowIso ?? new Date().toISOString();
  const fail = (reason: Exclude<RebasePrepFailure, "NO_PENDING">): PrepareRebaseMergeResult => {
    db.prepare("UPDATE run_rebase SET state = 'failed', updated_at = ? WHERE run_id = ? AND state = 'pending'").run(
      now(),
      input.runId,
    );
    return { ok: false, reason };
  };

  const version = parseGitVersion(await gitText(["--version"]).catch(() => ""));
  if (!version || !versionAtLeast(version, MIN_MERGE_TREE_GIT_VERSION)) return fail("GIT_TOO_OLD");

  let base: string;
  try {
    base = await gitText(["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`], {
      cwd: input.repoRoot,
    });
  } catch (err) {
    if (err instanceof GitError) return fail("BASE_UNRESOLVED");
    throw err;
  }
  if (!FULL_SHA.test(base)) return fail("BASE_UNRESOLVED");

  const cwd = input.worktreePath;
  let head: string;
  try {
    head = await gitText(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], { cwd });
    const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
    if (status.stdout.length > 0) return fail("WORKTREE_DIRTY");
  } catch (err) {
    if (err instanceof GitError) return fail("MERGE_FAILED");
    throw err;
  }

  let conflictedPaths: number;
  try {
    // Exit 0: clean merge; exit 1: conflicts (the tree is still written, conflicted files carry markers).
    const merged = await git(["merge-tree", "--write-tree", "--no-messages", "--name-only", "-z", head, base], {
      cwd,
      okCodes: [1],
    });
    const tokens = merged.stdout.toString("utf8").split("\0");
    const tree = tokens[0] ?? "";
    if (!FULL_SHA.test(tree)) return fail("MERGE_FAILED");
    conflictedPaths = new Set(tokens.slice(1).filter((t) => t !== "")).size;
    if (merged.code === 0 && conflictedPaths !== 0) return fail("MERGE_FAILED");
    if (merged.code === 1 && conflictedPaths === 0) return fail("MERGE_FAILED");
    // Files to the merged tree (deleted files removed), then the index back to HEAD; HEAD itself never moves.
    await git(["read-tree", "-u", "--reset", tree], { cwd });
    await git(["reset", "-q"], { cwd });
    const after = await gitText(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], { cwd });
    if (after !== head) return fail("MERGE_FAILED");
  } catch (err) {
    if (err instanceof GitError) return fail("MERGE_FAILED");
    throw err;
  }

  const updated = db
    .prepare(
      `UPDATE run_rebase SET state = 'prepared', merge_parent_sha = ?, conflicted_paths = ?, updated_at = ?
       WHERE run_id = ? AND state = 'pending'`,
    )
    .run(base, conflictedPaths, now(), input.runId);
  if (updated.changes !== 1) return { ok: false, reason: "NO_PENDING" };
  return { ok: true, mergeParentSha: base, conflictedPaths };
}
