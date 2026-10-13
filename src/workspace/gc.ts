import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ArtifactStore } from "../artifacts/index.js";
import { createLedger, type Ledger } from "../ledger/index.js";
import { git } from "./git.js";

/**
 * Retention GC core (T3.12; FR-WS-07, NFR-DATA-01, BR-12, LLD §5, ADR-0006). Proposed per Q-18: the unit is a whole
 * ACTIVE-status meta-session that is idle (no lease), has only terminal runs and whose newest activity is older than
 * `days`. Per unit the order is: intent event, worktrees, `switchboard/<sess>/` branches, artifact files, then one
 * ledger transaction (artifact `deleted_at`, meta-session `ARCHIVED`, outcome event). Every step is idempotent, so
 * re-running after a crash at any point rolls forward. `run_event` rows are kept (Q-19, Proposed): the table is
 * append-only by trigger (ADR-0005) and is the audit record.
 *
 * Never touched: non-terminal runs, leased or recent sessions, the operator's checkout, branches outside
 * `switchboard/<sess>/`, artifact files still referenced by a live row of another session.
 */

export type GcStep = "intent" | "worktrees" | "branches" | "artifacts" | "ledger";

export interface GcOptions {
  readonly db: Database.Database;
  readonly artifacts: ArtifactStore;
  /** Controller data directory; worktrees live in `<dataDir>/worktrees/<sess>/<run>`. */
  readonly dataDir: string;
  /** Retention in days (config key arrives with T3.2). */
  readonly days: number;
  readonly now?: Date;
  /**
   * Test seam: awaited after each completed step of a unit; a throw simulates a crash at that point. The failing unit
   * is reported in `errors` and the pass continues with other units.
   */
  readonly onStep?: (step: GcStep, sessionId: string) => void | Promise<void>;
}

export interface GcUnitResult {
  readonly sessionId: string;
  readonly worktreesRemoved: number;
  readonly branchesDeleted: string[];
  readonly artifactFilesDeleted: number;
  readonly artifactFilesKept: number;
  readonly warnings: string[];
}

export interface GcResult {
  readonly cutoff: string;
  readonly collected: GcUnitResult[];
  readonly errors: { sessionId: string; step: GcStep | "unknown"; message: string }[];
}

const SESSION_ID_RE = /^sess_[0-9A-Za-z]{1,40}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runRetentionGc(options: GcOptions): Promise<GcResult> {
  if (!Number.isFinite(options.days) || options.days < 0) throw new RangeError("days must be a non-negative number");
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.days * DAY_MS).toISOString();
  const ledger = createLedger(options.db);
  const collected: GcUnitResult[] = [];
  const errors: GcResult["errors"] = [];
  for (const candidate of ledger.listGcCandidates(cutoff)) {
    let step: GcStep | "unknown" = "unknown";
    try {
      collected.push(
        await collectUnit(ledger, options, candidate, now.toISOString(), (s) => {
          step = s;
        }),
      );
    } catch (err) {
      errors.push({ sessionId: candidate.id, step, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { cutoff, collected, errors };
}

async function collectUnit(
  ledger: Ledger,
  o: GcOptions,
  c: { id: string; repo_root: string | null; newest_run_id: string | null },
  at: string,
  entering: (s: GcStep) => void,
): Promise<GcUnitResult> {
  const sessionId = c.id;
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid meta-session id ${sessionId}`);
  const warnings: string[] = [];
  const hook = async (s: GcStep) => {
    await o.onStep?.(s, sessionId);
  };
  const targets = ledger.gcSessionTargets(sessionId);

  // 1. Intent. A re-run after a crash appends another intent; the events are an audit trail, not a state machine.
  entering("intent");
  if (c.newest_run_id !== null) {
    ledger.appendRunEvent({
      runId: c.newest_run_id,
      type: "gc_intent",
      payload: { sessionId, worktrees: targets.worktreePaths.length, branches: targets.branches },
    });
  }
  await hook("intent");

  // 2. Worktrees.
  entering("worktrees");
  const worktreesRemoved = await removeWorktrees(o.dataDir, sessionId, c.repo_root, targets.worktreePaths, warnings);
  await hook("worktrees");

  // 3. Branches (only `switchboard/<sess>/`).
  entering("branches");
  const branchesDeleted = await deleteBranches(c.repo_root, sessionId, targets.branches, warnings);
  await hook("branches");

  // 4. Artifact files not referenced by any other live row.
  entering("artifacts");
  const plan = ledger.gcArtifactPlan(sessionId);
  let artifactFilesDeleted = 0;
  for (const hash of plan.deletableHashes) if (await o.artifacts.remove(hash)) artifactFilesDeleted++;
  await hook("artifacts");

  // 5. Ledger: deleted_at, ARCHIVED, outcome event, atomically.
  entering("ledger");
  ledger.completeGc(sessionId, at, {
    runId: c.newest_run_id,
    payload: {
      sessionId,
      worktreesRemoved,
      branchesDeleted,
      artifactFilesDeleted,
      artifactFilesKept: plan.keptHashes.length,
    },
  });
  await hook("ledger");

  return {
    sessionId,
    worktreesRemoved,
    branchesDeleted,
    artifactFilesDeleted,
    artifactFilesKept: plan.keptHashes.length,
    warnings,
  };
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

async function isRepo(dir: string | null): Promise<boolean> {
  if (dir === null || !(await exists(dir))) return false;
  const r = await git(["rev-parse", "--git-dir"], { cwd: dir, okCodes: [128] });
  return r.code === 0;
}

/**
 * Remove each recorded worktree that lives under `<dataDir>/worktrees/<sess>/`. `git worktree remove --force` unlinks
 * symlinks rather than following them; the fallback `fs.rm` likewise never follows them. A path outside that
 * directory, or one that is itself a symlink, is skipped with a warning and never deleted.
 */
async function removeWorktrees(
  dataDir: string,
  sessionId: string,
  repoRoot: string | null,
  recorded: readonly string[],
  warnings: string[],
): Promise<number> {
  const base = path.join(await realpath(dataDir).catch(() => path.resolve(dataDir)), "worktrees", sessionId);
  const repoOk = await isRepo(repoRoot);
  if (repoOk) await git(["worktree", "prune"], { cwd: repoRoot as string });
  let removed = 0;
  // Recorded paths plus anything left under the session's own directory (e.g. a partial `worktree add`).
  const candidates = new Set(recorded.map((p) => path.resolve(p)));
  for (const name of await readdir(base).catch(() => [] as string[])) candidates.add(path.join(base, name));
  for (const wt of candidates) {
    const rel = path.relative(base, wt);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      warnings.push(`skipped worktree outside the data directory: ${wt}`);
      continue;
    }
    const st = await lstat(wt).catch(() => undefined);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      warnings.push(`worktree path is a symlink, unlinked without following: ${wt}`);
      await rm(wt, { force: true });
      removed++;
      continue;
    }
    if (repoOk)
      await git(["worktree", "remove", "--force", "--force", wt], { cwd: repoRoot as string }).catch(() => undefined);
    if (await exists(wt)) await rm(wt, { recursive: true, force: true });
    removed++;
  }
  if (repoOk) await git(["worktree", "prune"], { cwd: repoRoot as string });
  await rmdir(base).catch(() => undefined);
  return removed;
}

async function deleteBranches(
  repoRoot: string | null,
  sessionId: string,
  recorded: readonly string[],
  warnings: string[],
): Promise<string[]> {
  if (!(await isRepo(repoRoot))) {
    if (recorded.length > 0) warnings.push("repository unavailable; branches not deleted");
    return [];
  }
  const prefix = `switchboard/${sessionId}/`;
  const live = (
    await git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`], { cwd: repoRoot as string })
  ).stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const deleted: string[] = [];
  for (const b of new Set([...recorded, ...live])) {
    if (!b.startsWith(prefix)) continue; // belt and braces: never outside this meta-session's namespace
    const has = await git(["show-ref", "--verify", "--quiet", `refs/heads/${b}`], {
      cwd: repoRoot as string,
      okCodes: [1],
    });
    if (has.code !== 0) continue;
    await git(["branch", "-D", b], { cwd: repoRoot as string });
    deleted.push(b);
  }
  return deleted;
}
