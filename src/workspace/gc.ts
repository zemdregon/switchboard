import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ArtifactStore } from "../artifacts/index.js";
import { DEFAULT_PUBLISH_PREFIX } from "../git/publish-ref.js";
import { createLedger, type Ledger } from "../ledger/index.js";
import { git } from "./git.js";

/**
 * Retention GC core (T3.12; FR-WS-07, NFR-DATA-01, BR-12, LLD §5, ADR-0006). Q-18 (Delegated, owner decision 25): the
 * unit is a whole ACTIVE-status meta-session that is idle (no lease), has only terminal runs and whose newest activity
 * is older than `days`. Per unit the order is: one ledger transaction that re-checks idleness, marks the meta-session
 * `ARCHIVED` (admission refuses it from then on, R-42) and appends the intent event; then worktrees,
 * `switchboard/<sess>/` branches, artifact files; then one ledger transaction (artifact `deleted_at`, outcome event).
 * Every step is idempotent and an `ARCHIVED` session with collection pending is a candidate again, so re-running after
 * a crash at any point rolls forward. `run_event` rows are kept (Q-19, Delegated): the table is append-only by trigger
 * (ADR-0005) and is the audit record.
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
      const unit = await collectUnit(ledger, options, candidate, now.toISOString(), cutoff, (s) => {
        step = s;
      });
      if (unit) collected.push(unit);
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
  cutoff: string,
  entering: (s: GcStep) => void,
): Promise<GcUnitResult | undefined> {
  const sessionId = c.id;
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid meta-session id ${sessionId}`);
  const warnings: string[] = [];
  const hook = async (s: GcStep) => {
    await o.onStep?.(s, sessionId);
  };
  const targets = ledger.gcSessionTargets(sessionId);

  // 1. Mark and intent, in one ledger transaction (R-42). Idleness is re-checked inside it, so a run admitted since the
  // candidate list was read keeps the session; once ARCHIVED, admission refuses it. A re-run after a crash appends
  // another intent; the events are an audit trail, not a state machine.
  entering("intent");
  const marked = ledger.beginGc(sessionId, cutoff, at, {
    sessionId,
    worktrees: targets.worktreePaths.length,
    branches: targets.branches,
  });
  if (!marked) return undefined;
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

  // 5. Ledger: deleted_at and the outcome event, atomically (the session was marked ARCHIVED in step 1).
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

// ---- Read-only reporting (T3.12 wiring: `doctor`, `gc` dry run). Nothing below writes to the ledger, Git or disk. ----

export interface GcPlanUnit {
  readonly sessionId: string;
  readonly repoRoot: string | null;
  /** Newest activity of the unit (ISO), the value compared with the cutoff. */
  readonly lastActivity: string;
  readonly worktrees: number;
  readonly branches: string[];
}

export interface GcPlan {
  readonly cutoff: string;
  readonly units: GcPlanUnit[];
}

/** What {@link runRetentionGc} would collect for `days` at `now`, using the same candidate query. Read-only. */
export function planRetentionGc(options: {
  readonly db: Database.Database;
  readonly days: number;
  readonly now?: Date;
}): GcPlan {
  if (!Number.isFinite(options.days) || options.days < 0) throw new RangeError("days must be a non-negative number");
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.days * DAY_MS).toISOString();
  const ledger = createLedger(options.db);
  const units = ledger.listGcCandidates(cutoff).map((c) => {
    const t = ledger.gcSessionTargets(c.id);
    return {
      sessionId: c.id,
      repoRoot: c.repo_root,
      lastActivity: c.last_activity,
      worktrees: t.worktreePaths.length,
      branches: t.branches,
    };
  });
  return { cutoff, units };
}

export interface OrphanReport {
  /** Directories under `<dataDir>/worktrees/` with no matching `run` row (`<sess>/<run>`, or just `<sess>`). */
  readonly worktrees: string[];
  /**
   * `switchboard/*` branches (per recorded repository) that no `run` or `workspace_checkpoint` row names and that are
   * not the publish ref of a meta-session in the ledger (`<publishPrefix><sess>`, FR-GIT-08, LLD §12.3).
   */
  readonly branches: { readonly repoRoot: string; readonly branch: string }[];
  /** Why part of the sweep could not be done (unreadable repository, ...). */
  readonly warnings: string[];
}

/**
 * Orphan sweep (LLD §5): worktree directories and `switchboard/*` branches with no matching ledger row. A publish ref
 * whose meta-session exists is not an orphan (it is the deliverable); one whose session is unknown still is. Report
 * only; nothing is removed (T3.12: removal of orphans is not implemented). Symlinks are listed, never followed. A run
 * being prepared at this very moment can appear briefly as an orphan, so treat the report as advice, not as a delete
 * list.
 */
export async function findOrphans(options: {
  readonly db: Database.Database;
  readonly dataDir: string;
  /** Local publish ref prefix; must match the publisher's (default `switchboard/pub/`). */
  readonly publishPrefix?: string;
}): Promise<OrphanReport> {
  const { db } = options;
  const warnings: string[] = [];
  const worktrees: string[] = [];
  const base = path.join(await realpath(options.dataDir).catch(() => path.resolve(options.dataDir)), "worktrees");
  const publishPrefix = options.publishPrefix ?? DEFAULT_PUBLISH_PREFIX;
  const runsOf = db.prepare("SELECT id FROM run WHERE meta_session_id = ?");
  const sessionExists = db.prepare("SELECT 1 AS x FROM meta_session WHERE id = ?");
  for (const sess of await readdir(base).catch(() => [] as string[])) {
    const sessDir = path.join(base, sess);
    if (!sessionExists.get(sess)) {
      worktrees.push(sessDir);
      continue;
    }
    const known = new Set((runsOf.all(sess) as { id: string }[]).map((r) => r.id));
    for (const name of await readdir(sessDir).catch(() => [] as string[])) {
      if (!known.has(name)) worktrees.push(path.join(sessDir, name));
    }
  }

  const named = new Set<string>();
  for (const r of db.prepare("SELECT branch FROM run WHERE branch IS NOT NULL").all() as { branch: string }[])
    named.add(r.branch);
  for (const r of db.prepare("SELECT branch FROM workspace_checkpoint").all() as { branch: string }[])
    named.add(r.branch);
  const branches: OrphanReport["branches"][number][] = [];
  const repos = (
    db.prepare("SELECT DISTINCT repo_root FROM meta_session WHERE repo_root IS NOT NULL ORDER BY repo_root").all() as {
      repo_root: string;
    }[]
  ).map((r) => r.repo_root);
  for (const repoRoot of repos) {
    if (!(await isRepo(repoRoot))) {
      warnings.push(`repository unavailable, branches not checked: ${repoRoot}`);
      continue;
    }
    const refs = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/switchboard/"], {
      cwd: repoRoot,
    });
    for (const b of refs.stdout.toString("utf8").split("\n").filter(Boolean)) {
      if (named.has(b)) continue;
      if (b.startsWith(publishPrefix) && sessionExists.get(b.slice(publishPrefix.length))) continue;
      branches.push({ repoRoot, branch: b });
    }
  }
  return { worktrees, branches, warnings };
}
