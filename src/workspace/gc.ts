import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ArtifactStore } from "../artifacts/index.js";
import { type ContainerRuntime, removeRunContainers } from "../environment/index.js";
import { DEFAULT_PUBLISH_PREFIX } from "../git/publish-ref.js";
import { createLedger, type Ledger } from "../ledger/index.js";
import { assessDiskFloor, type DiskFloor, type DiskFloorStatus } from "./disk.js";
import { git } from "./git.js";

/**
 * Retention GC core (T3.12; FR-WS-07, NFR-DATA-01, BR-12, LLD §5, ADR-0006). Q-18 (Delegated, owner decision 25): the
 * unit is a whole ACTIVE-status meta-session that is idle (no lease), has only terminal runs and whose newest activity
 * is older than `days`. Per unit the order is: one ledger transaction that re-checks idleness, marks the meta-session
 * `ARCHIVED` (admission refuses it from then on, R-42) and appends the intent event; then the runs' containers (T10.3,
 * FR-PRJ-09: before the worktrees they may mount; a runtime failure stops the unit and keeps them), then worktrees,
 * `switchboard/<sess>/` branches, artifact files; then one ledger transaction (artifact `deleted_at`, outcome event).
 * Every step is idempotent and an `ARCHIVED` session with collection pending is a candidate again, so re-running after
 * a crash at any point rolls forward. `run_event` rows are kept (Q-19, Delegated): the table is append-only by trigger
 * (ADR-0005) and is the audit record.
 *
 * Never touched: non-terminal runs, leased or recent sessions, the operator's checkout, branches outside
 * `switchboard/<sess>/`, artifact files still referenced by a live row of another session.
 */

export type GcStep = "intent" | "containers" | "worktrees" | "branches" | "artifacts" | "ledger";

export interface GcOptions {
  readonly db: Database.Database;
  readonly artifacts: ArtifactStore;
  /** Controller data directory; worktrees live in `<dataDir>/worktrees/<sess>/<run>`. */
  readonly dataDir: string;
  /** Retention in days (config key arrives with T3.2). */
  readonly days: number;
  readonly now?: Date;
  /**
   * T10.3 (FR-PRJ-09): the container runtime whose containers labelled with the unit's run ids are removed with its
   * worktrees. Absent: no container step (no `container` project is configured).
   */
  readonly containerRuntime?: ContainerRuntime;
  /**
   * Test seam: awaited after each completed step of a unit; a throw simulates a crash at that point. The failing unit
   * is reported in `errors` and the pass continues with other units.
   */
  readonly onStep?: (step: GcStep, sessionId: string) => void | Promise<void>;
  /**
   * T3.23 (FR-WS-11): asked before each candidate unit; `true` leaves the remaining candidates uncollected. The early
   * disk sweep stops as soon as free space is back above the floor. Unset (every retention pass): collect every unit.
   */
  readonly stopWhen?: () => boolean;
}

export interface GcUnitResult {
  readonly sessionId: string;
  /** Names of the containers removed (T10.3); empty without a container runtime. */
  readonly containersRemoved: string[];
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
    if (options.stopWhen?.() === true) break;
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

  // 2. Containers of the session's runs (T10.3, FR-PRJ-09), before the worktrees they mount. Throws on a runtime
  // failure, so the worktrees are kept and the next pass rolls forward.
  entering("containers");
  const containersRemoved =
    o.containerRuntime !== undefined ? await removeRunContainers(o.containerRuntime, targets.runIds) : [];
  await hook("containers");

  // 3. Worktrees.
  entering("worktrees");
  const worktreesRemoved = await removeWorktrees(o.dataDir, sessionId, c.repo_root, targets.worktreePaths, warnings);
  await hook("worktrees");

  // 4. Branches (only `switchboard/<sess>/`).
  entering("branches");
  const branchesDeleted = await deleteBranches(c.repo_root, sessionId, targets.branches, warnings);
  await hook("branches");

  // 5. Artifact files not referenced by any other live row.
  entering("artifacts");
  const plan = ledger.gcArtifactPlan(sessionId);
  let artifactFilesDeleted = 0;
  for (const hash of plan.deletableHashes) if (await o.artifacts.remove(hash)) artifactFilesDeleted++;
  await hook("artifacts");

  // 6. Ledger: deleted_at and the outcome event, atomically (the session was marked ARCHIVED in step 1).
  entering("ledger");
  ledger.completeGc(sessionId, at, {
    runId: c.newest_run_id,
    payload: {
      sessionId,
      ...(containersRemoved.length > 0 ? { containersRemoved } : {}),
      worktreesRemoved,
      branchesDeleted,
      artifactFilesDeleted,
      artifactFilesKept: plan.keptHashes.length,
    },
  });
  await hook("ledger");

  return {
    sessionId,
    containersRemoved,
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
 * only; removal is {@link collectOrphans}, which marks first and waits out the retention period. Symlinks are listed,
 * never followed. A run being prepared at this very moment can appear briefly as an orphan, so treat the report as
 * advice, not as a delete list.
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

// ---- Orphan collection (T3.12, LLD §5, ADR-0054): mark first, remove only after the retention period. ----

export type OrphanGcStep = "intent" | "remove" | "outcome";

export interface OrphanGcOptions {
  readonly db: Database.Database;
  /** Controller data directory; orphan worktree directories are only ever removed under `<dataDir>/worktrees/`. */
  readonly dataDir: string;
  /** Retention in days, counted from the orphan's first sighting by a collecting pass (its mark). */
  readonly days: number;
  readonly now?: Date;
  readonly publishPrefix?: string;
  /** Test seam, as {@link GcOptions.onStep}: a throw simulates a crash after that step for that orphan. */
  readonly onStep?: (step: OrphanGcStep, target: string) => void | Promise<void>;
}

export interface OrphanGcResult {
  readonly cutoff: string;
  /** Orphans first seen by this pass (their retention clock starts now). */
  readonly marked: number;
  /** Orphans marked earlier and still inside the retention period. */
  readonly waiting: number;
  readonly removedWorktrees: string[];
  readonly removedBranches: { readonly repoRoot: string; readonly branch: string }[];
  readonly warnings: string[];
  readonly errors: { target: string; step: OrphanGcStep | "unknown"; message: string }[];
}

interface OrphanKey {
  readonly kind: "worktree" | "branch";
  /** `''` for a worktree directory. */
  readonly repoRoot: string;
  readonly target: string;
}

interface OrphanRow {
  kind: "worktree" | "branch";
  repo_root: string;
  target: string;
  first_seen_at: string;
  intent_at: string | null;
  removed_at: string | null;
}

const orphanKey = (k: OrphanKey): string => `${k.kind}\0${k.repoRoot}\0${k.target}`;
const rowKey = (r: OrphanRow): OrphanKey => ({ kind: r.kind, repoRoot: r.repo_root, target: r.target });

/**
 * Remove orphans after the retention period, with the same crash-safe order as session GC. Per pass:
 *
 * 1. Mark (one transaction): every orphan {@link findOrphans} reports gets a `gc_orphan` row with its first sighting;
 *    one that reappears after removal starts a new clock. A mark whose target is no longer an orphan (a ledger row
 *    appeared, or the operator removed it) and whose removal had not begun is forgotten.
 * 2. Per orphan whose mark is older than `days` (worktree directories first, then `git worktree prune`, then
 *    branches): intent (one transaction that re-checks the ledger and sets `intent_at`), then the removal, then the
 *    outcome (`removed_at`). A row with an intent and no outcome rolls forward on the next pass.
 *
 * So nothing is removed on its first sighting, whatever `days` is. Branches outside `switchboard/` are never touched;
 * worktree removal is refused when `<dataDir>/worktrees` or the session directory is a symlink, and a symlinked orphan
 * is unlinked, never followed. Read-only callers (`doctor`, `gc` dry run) use {@link findOrphans}, which writes nothing.
 */
export async function collectOrphans(options: OrphanGcOptions): Promise<OrphanGcResult> {
  if (!Number.isFinite(options.days) || options.days < 0) throw new RangeError("days must be a non-negative number");
  const { db } = options;
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - options.days * DAY_MS).toISOString();
  const publishPrefix = options.publishPrefix ?? DEFAULT_PUBLISH_PREFIX;
  const base = path.join(await realpath(options.dataDir).catch(() => path.resolve(options.dataDir)), "worktrees");
  const report = await findOrphans({ db, dataDir: options.dataDir, publishPrefix });
  const warnings = [...report.warnings];
  const errors: OrphanGcResult["errors"] = [];
  const found: OrphanKey[] = [
    ...report.worktrees.map((target) => ({ kind: "worktree" as const, repoRoot: "", target })),
    ...report.branches.map((b) => ({ kind: "branch" as const, repoRoot: b.repoRoot, target: b.branch })),
  ];
  const foundKeys = new Set(found.map(orphanKey));

  // 1. Mark.
  let marked = 0;
  let waiting = 0;
  const due: OrphanKey[] = [];
  const unfinished: OrphanKey[] = [];
  db.transaction(() => {
    const rows = db
      .prepare("SELECT kind, repo_root, target, first_seen_at, intent_at, removed_at FROM gc_orphan")
      .all() as OrphanRow[];
    const byKey = new Map(rows.map((r) => [orphanKey(rowKey(r)), r]));
    const mark = db.prepare(
      `INSERT INTO gc_orphan (kind, repo_root, target, first_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (kind, repo_root, target) DO UPDATE
         SET first_seen_at = excluded.first_seen_at, intent_at = NULL, removed_at = NULL`,
    );
    for (const k of found) {
      const r = byKey.get(orphanKey(k));
      if (!r || r.removed_at !== null) {
        mark.run(k.kind, k.repoRoot, k.target, at);
        marked++;
      } else if (r.intent_at !== null || r.first_seen_at < cutoff) due.push(k);
      else waiting++;
    }
    for (const r of rows) {
      if (r.removed_at !== null || foundKeys.has(orphanKey(rowKey(r)))) continue;
      if (r.intent_at === null) forgetMark(db, rowKey(r));
      else unfinished.push(rowKey(r));
    }
  }).immediate();

  // A started removal whose target the sweep no longer reports: finished if the target is gone, else forgotten.
  for (const k of unfinished) {
    const gone =
      k.kind === "worktree" ? !(await exists(k.target)) : !(await branchExists(k.repoRoot, k.target).catch(() => true));
    if (gone) {
      db.prepare("UPDATE gc_orphan SET removed_at = ? WHERE kind = ? AND repo_root = ? AND target = ?").run(
        at,
        k.kind,
        k.repoRoot,
        k.target,
      );
    } else forgetMark(db, k);
  }

  // 2. Intent, removal, outcome per due orphan; worktrees before branches so a branch is no longer checked out.
  const removedWorktrees: string[] = [];
  const removedBranches: OrphanGcResult["removedBranches"][number][] = [];
  const stillOrphan = orphanRecheck(db, base, publishPrefix);
  const collect = async (k: OrphanKey, remove: () => Promise<void>): Promise<boolean> => {
    let step: OrphanGcStep | "unknown" = "unknown";
    try {
      step = "intent";
      const go = db
        .transaction(() => {
          if (!stillOrphan(k)) {
            forgetMark(db, k);
            return false;
          }
          db.prepare(
            "UPDATE gc_orphan SET intent_at = COALESCE(intent_at, ?) WHERE kind = ? AND repo_root = ? AND target = ?",
          ).run(at, k.kind, k.repoRoot, k.target);
          return true;
        })
        .immediate();
      if (!go) return false;
      await options.onStep?.("intent", k.target);
      step = "remove";
      await remove();
      await options.onStep?.("remove", k.target);
      step = "outcome";
      db.prepare("UPDATE gc_orphan SET removed_at = ? WHERE kind = ? AND repo_root = ? AND target = ?").run(
        at,
        k.kind,
        k.repoRoot,
        k.target,
      );
      await options.onStep?.("outcome", k.target);
      return true;
    } catch (err) {
      errors.push({ target: k.target, step, message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };
  for (const k of due.filter((d) => d.kind === "worktree")) {
    if (await collect(k, () => removeOrphanWorktree(base, k.target))) removedWorktrees.push(k.target);
  }
  if (removedWorktrees.length > 0 || due.some((d) => d.kind === "branch")) {
    for (const repoRoot of knownRepos(db)) {
      if (await isRepo(repoRoot)) await git(["worktree", "prune"], { cwd: repoRoot }).catch(() => undefined);
    }
  }
  for (const k of due.filter((d) => d.kind === "branch")) {
    if (await collect(k, () => removeOrphanBranch(k.repoRoot, k.target)))
      removedBranches.push({ repoRoot: k.repoRoot, branch: k.target });
  }
  return { cutoff, marked, waiting, removedWorktrees, removedBranches, warnings, errors };
}

function forgetMark(db: Database.Database, k: OrphanKey): void {
  db.prepare("DELETE FROM gc_orphan WHERE kind = ? AND repo_root = ? AND target = ?").run(k.kind, k.repoRoot, k.target);
}

function knownRepos(db: Database.Database): string[] {
  return (
    db.prepare("SELECT DISTINCT repo_root FROM meta_session WHERE repo_root IS NOT NULL").all() as {
      repo_root: string;
    }[]
  ).map((r) => r.repo_root);
}

/** The ledger half of {@link findOrphans} for one target, run inside the intent transaction. */
function orphanRecheck(db: Database.Database, base: string, publishPrefix: string): (k: OrphanKey) => boolean {
  const sessionExists = db.prepare("SELECT 1 AS x FROM meta_session WHERE id = ?");
  const runExists = db.prepare("SELECT 1 AS x FROM run WHERE id = ? AND meta_session_id = ?");
  const branchNamed = db.prepare(
    "SELECT 1 AS x FROM run WHERE branch = ? UNION ALL SELECT 1 FROM workspace_checkpoint WHERE branch = ? LIMIT 1",
  );
  return (k) => {
    if (k.kind === "worktree") {
      const parts = path.relative(base, k.target).split(path.sep);
      if (parts.length < 1 || parts.length > 2 || parts.some((p) => p === "" || p === "..")) return false;
      const [sess, run] = parts as [string, string | undefined];
      if (!sessionExists.get(sess)) return true;
      return run !== undefined && !runExists.get(run, sess);
    }
    if (!k.target.startsWith("switchboard/")) return false;
    if (branchNamed.get(k.target, k.target)) return false;
    return !(k.target.startsWith(publishPrefix) && sessionExists.get(k.target.slice(publishPrefix.length)));
  };
}

/**
 * Remove one orphan directory `<base>/<sess>` or `<base>/<sess>/<name>`. Refused (throws) when `base` or the session
 * directory is a symlink or not a directory, so nothing outside the data directory is reached through a link; the
 * orphan itself, if a symlink, is unlinked and its target left alone (`fs.rm` never follows links inside the tree).
 */
async function removeOrphanWorktree(base: string, target: string): Promise<void> {
  const rel = path.relative(base, target);
  const parts = rel.split(path.sep);
  if (rel === "" || path.isAbsolute(rel) || parts.length > 2 || parts.some((p) => p === "" || p === "..")) {
    throw new Error(`refused: ${target} is not a worktree directory under ${base}`);
  }
  const notRealDir = async (p: string) => {
    const st = await lstat(p).catch(() => undefined);
    return !st || st.isSymbolicLink() || !st.isDirectory();
  };
  if (await notRealDir(base)) throw new Error(`refused: ${base} is a symlink or not a directory`);
  if (parts.length === 2 && (await notRealDir(path.join(base, parts[0] as string)))) {
    throw new Error(`refused: session directory of ${target} is a symlink or not a directory`);
  }
  const st = await lstat(target).catch(() => undefined);
  if (!st) return;
  await rm(target, { recursive: !st.isSymbolicLink(), force: true });
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  if (!(await isRepo(repoRoot))) return false;
  const r = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot, okCodes: [1] });
  return r.code === 0;
}

async function removeOrphanBranch(repoRoot: string, branch: string): Promise<void> {
  if (!branch.startsWith("switchboard/")) throw new Error(`refused: ${branch} is outside switchboard/`);
  if (!(await isRepo(repoRoot))) throw new Error(`repository unavailable: ${repoRoot}`);
  if (!(await branchExists(repoRoot, branch))) return;
  await git(["branch", "-D", branch], { cwd: repoRoot });
}

// ---- Early disk sweep (T3.23; FR-WS-11, BR-51): an ordered list of reclaimers, run only while under the floor. ----

/** What a reclaimer may ask while it works. */
export interface ReclaimContext {
  /** True once free space is back at or above the floor; a reclaimer stops at its next unit boundary. */
  readonly enough: () => boolean;
  /**
   * Worktree paths of the runs that hold a write lease right now (`meta_session.lease_run_id`). A reclaimer never
   * touches one of them, nor the meta-session that holds it (FR-WS-11); the retention reclaimer below never sees them
   * because its candidate query and its intent transaction both require no lease.
   */
  readonly leasedWorktrees: ReadonlySet<string>;
  readonly now: Date;
}

export interface ReclaimOutcome {
  /** Units this reclaimer removed (meta-sessions; seed directories once T9.13 registers its reclaimer). */
  readonly reclaimed: number;
  /** Why nothing or less was done (`retention.days` not set, a repository unavailable, a unit that failed, ...). */
  readonly notes: string[];
}

/**
 * One step of the early sweep. The order of the list is the order of reclaiming: dependency seeds of idle worktrees
 * (FR-WS-10, registered by T9.13 as `dependency_seeds`; absent until then) before retention-eligible meta-sessions
 * (`meta_sessions`). A reclaimer stops as soon as `enough()` is true and never touches a leased worktree.
 */
export interface DiskReclaimer {
  readonly name: string;
  reclaim(ctx: ReclaimContext): Promise<ReclaimOutcome>;
}

export interface EarlySweepOptions {
  readonly db: Database.Database;
  readonly floor: DiskFloor;
  /** Ordered; see {@link earlySweepReclaimers}. */
  readonly reclaimers: readonly DiskReclaimer[];
  readonly now?: Date;
}

export interface EarlySweepStep {
  readonly name: string;
  readonly outcome: ReclaimOutcome | { readonly error: string };
}

export interface EarlySweepResult {
  readonly before: DiskFloorStatus;
  readonly after: DiskFloorStatus;
  /** True when free space is at or above the floor at the end, or the floor could not be assessed. */
  readonly satisfied: boolean;
  /** Reclaimers that ran, in order; empty when the sweep found free space already above the floor. */
  readonly steps: EarlySweepStep[];
  /** The leased worktrees the sweep told every reclaimer to leave alone. */
  readonly leasedWorktrees: string[];
}

/** Worktree paths of the runs holding a write lease. Read-only. */
export function leasedWorktrees(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT r.worktree_path AS p FROM meta_session m JOIN run r ON r.id = m.lease_run_id
         WHERE m.lease_run_id IS NOT NULL AND r.worktree_path IS NOT NULL ORDER BY p`,
      )
      .all() as { p: string }[]
  ).map((r) => r.p);
}

/**
 * Run the reclaimers in order while free space is under the floor, re-probing between them. A reclaimer that throws
 * is recorded and the next one runs. Nothing runs when the floor is already met, and nothing here ever holds, fails or
 * refuses a run: the lifecycle's hold is separate and lifts on its own re-probe.
 */
export async function runEarlySweep(o: EarlySweepOptions): Promise<EarlySweepResult> {
  const now = o.now ?? new Date();
  const before = assessDiskFloor(o.floor);
  const leased = leasedWorktrees(o.db);
  const steps: EarlySweepStep[] = [];
  if (before.below) {
    const enough = (): boolean => !assessDiskFloor(o.floor).below;
    const ctx: ReclaimContext = { enough, leasedWorktrees: new Set(leased), now };
    for (const r of o.reclaimers) {
      if (enough()) break;
      try {
        steps.push({ name: r.name, outcome: await r.reclaim(ctx) });
      } catch (err) {
        steps.push({ name: r.name, outcome: { error: err instanceof Error ? err.message : String(err) } });
      }
    }
  }
  const after = assessDiskFloor(o.floor);
  return { before, after, satisfied: !after.below, steps, leasedWorktrees: leased };
}

export interface MetaSessionReclaimerOptions {
  /** The retention pass settings (`days` is `retention.days`, default 30). */
  readonly gc: Omit<GcOptions, "now" | "stopWhen">;
  /**
   * `ResolvedConfig.retentionEnabled`: collection happens only when the config sets `retention.days` itself, the same
   * switch as every other collecting pass (T3.12). False: the reclaimer removes nothing and says why.
   */
  readonly enabled: boolean;
}

/**
 * The `meta_sessions` reclaimer: {@link runRetentionGc} with `stopWhen` bound to the floor, so it collects idle,
 * retention-eligible meta-sessions oldest first and stops once free space is back above the floor. Leased sessions are
 * never candidates (ledger `listGcCandidates`, re-checked by `beginGc`).
 */
export function metaSessionReclaimer(o: MetaSessionReclaimerOptions): DiskReclaimer {
  return {
    name: "meta_sessions",
    async reclaim(ctx) {
      if (!o.enabled) {
        return { reclaimed: 0, notes: ["retention.days is not set, so no meta-session is collected"] };
      }
      const r = await runRetentionGc({ ...o.gc, now: ctx.now, stopWhen: ctx.enough });
      const notes = [
        ...r.errors.map((e) => `meta-session ${e.sessionId} failed at ${e.step}: ${e.message}`),
        ...r.collected.flatMap((c) => c.warnings.map((w) => `meta-session ${c.sessionId}: ${w}`)),
      ];
      return { reclaimed: r.collected.length, notes };
    },
  };
}

/**
 * The ordered reclaimer list of the early sweep (FR-WS-11): dependency seeds of idle worktrees first (`seeds`, the
 * FR-WS-10 reclaimer T9.13 registers; the list has none until then), then retention-eligible meta-sessions.
 */
export function earlySweepReclaimers(
  o: MetaSessionReclaimerOptions & { readonly seeds?: DiskReclaimer },
): DiskReclaimer[] {
  return [...(o.seeds !== undefined ? [o.seeds] : []), metaSessionReclaimer(o)];
}
