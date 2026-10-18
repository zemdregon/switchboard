import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { PromptSkill } from "../adapters/prompt.js";
import { type NativeSkillLocation, nativeSkillPath } from "../adapters/types.js";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import { createLedger } from "../ledger/index.js";
import { git } from "./git.js";
import { excludePathspec } from "./nested.js";

/**
 * Native skill files (T16.6; FR-SKL-05, FR-SKL-06, FR-SKL-10; LLD §19.6 step 2, §19.8, §19.11; ADR-0056 items 6, 8 and
 * 9). TDD §3.16 places the writer and the cleaner in the workspace manager beside checkpoints, because they share the
 * base-checkpoint and path rules; `WorkspaceManager` delegates here, and the commit tool (`src/git/commit.ts`), `push`
 * (`src/git/push.ts`) and retention GC (`./gc.ts`) call the exported helpers over the same ledger handle. Nothing here
 * imports `src/skills/` (the T16.4 import boundary): `run_skill` is read and written with plain SQL, as `serve` does.
 *
 * A "recorded path" is a `run_skill.native_path` whose `removal` is not `verified`. It is written as an intent before the
 * file is created, so a crash between the two leaves a path the next removal point clears, never an unrecorded file.
 *
 * Delegated choices (T16.6, not owner-approved):
 * - The path, every parent and the `switchboard-` directory must be absent on disk, not only in Git: a pre-existing
 *   untracked file or directory is someone else's (`path_taken`), so the cleaner only ever removes what the writer made.
 * - A recorded path whose parent is no longer a real directory (the agent moved or replaced it), or that is gone, counts
 *   as removed (`verified`): the bytes may live on under another name inside the worktree, which R-69 accepts.
 * - A recorded path that is a symbolic link or another non-regular file at removal is tampering (`found_sha256: null`);
 *   a link is unlinked without being followed, a directory is never removed (`removal = failed`, `EISDIR`).
 * - `needs_attention` reads the newest `skill_removed` event (written in the same transaction as the `run_skill` update),
 *   so `src/control/needs-attention.ts` keeps reading ledger events only.
 */

/** LLD §19.11 event types. */
export const SKILL_REMOVED_EVENT = "skill_removed";
export const SKILL_TAMPERED_EVENT = "skill_tampered";
export const SKILL_CLEANUP_FAILED_EVENT = "skill_cleanup_failed";

/** LLD §19.6 step 2 fallback reasons (the `skill_delivered` entry's `fallback_reason`). */
export type NativeFallbackReason = "path_taken" | "write_failed";

/** The four LLD §19.8 removal points, recorded on the `skill_removed` event. */
export type SkillRemovalPoint = "before_verifying" | "terminal" | "reconciliation" | "gc";

/** One entry's outcome at dispatch. Names, versions and paths only; never a body. */
export interface NativeDeliveryEntry {
  readonly name: string;
  readonly version: number;
  readonly delivery: "native" | "prompt_prefix";
  readonly native_path?: string;
  readonly fallback_reason?: NativeFallbackReason;
}

/** Test seam (fault injection on unlink, TDD §3.16.2 property 5). Production uses `fs.promises.unlink`. */
export interface NativeSkillFs {
  unlink(file: string): Promise<void>;
}

const DEFAULT_FS: NativeSkillFs = { unlink };

interface RecordedRow {
  readonly position: number;
  readonly name: string;
  readonly native_path: string;
  readonly written_sha256: string | null;
}

/** Rows of `runId` whose native file may still exist (recorded, not verified removed), in position order. */
export function pendingNativeSkills(db: Database.Database, runId: string): RecordedRow[] {
  return db
    .prepare(
      `SELECT position, name, native_path, written_sha256 FROM run_skill
       WHERE run_id = ? AND native_path IS NOT NULL AND (removal IS NULL OR removal = 'failed') ORDER BY position`,
    )
    .all(runId) as RecordedRow[];
}

/** The recorded paths of `runId` (LLD §19.8 "while a run has rows ... and no `removal = 'verified'`"). */
export function recordedNativePaths(db: Database.Database, runId: string): string[] {
  return pendingNativeSkills(db, runId).map((r) => r.native_path);
}

/** `:(exclude,top,literal)` pathspecs for the recorded paths (`./nested.ts` `excludePathspec`). */
export function nativeExcludePathspecs(paths: readonly string[]): string[] {
  return paths.map(excludePathspec);
}

/**
 * Whether a recorded path of any run of the meta-session exists in that run's worktree (LLD §19.8 `push` refusal). A
 * path that cannot be checked counts as present (fail closed).
 */
export async function nativeSkillPresent(db: Database.Database, metaSessionId: string): Promise<boolean> {
  const rows = db
    .prepare(
      `SELECT r.worktree_path AS worktree_path, s.native_path AS native_path FROM run_skill s JOIN run r ON r.id = s.run_id
       WHERE r.meta_session_id = ? AND s.native_path IS NOT NULL AND (s.removal IS NULL OR s.removal = 'failed')`,
    )
    .all(metaSessionId) as { worktree_path: string | null; native_path: string }[];
  for (const row of rows) {
    if (row.worktree_path === null) continue;
    try {
      if ((await locate(row.worktree_path, row.native_path)).kind !== "absent") return true;
    } catch {
      return true;
    }
  }
  return false;
}

export interface WriteNativeSkillsInput {
  readonly db: Database.Database;
  readonly runId: string;
  readonly worktreePath: string;
  /** The run's base checkpoint commit (LLD §19.6 step 2 "exists in the base checkpoint"). */
  readonly baseCommit: string;
  readonly location: NativeSkillLocation;
  /** The run's entries in position order (position = index), as the lifecycle loaded them. */
  readonly skills: readonly PromptSkill[];
}

/**
 * LLD §19.6 step 2 for every entry: refuse a taken path (`path_taken`), else create the parents (0700) and the file
 * (0600) exclusively with `O_CREAT|O_EXCL|O_NOFOLLOW`, write, `fsync`, and record `native_path` and `written_sha256`.
 * Any error falls back to the prefix (`write_failed`); this never throws for one entry and never fails the run.
 * `delivery` and `delivered_at` are set by {@link markNativeDelivered} in the dispatch transaction.
 */
export async function writeNativeSkills(input: WriteNativeSkillsInput): Promise<NativeDeliveryEntry[]> {
  const out: NativeDeliveryEntry[] = [];
  let root: string | undefined;
  try {
    root = await realpath(input.worktreePath);
  } catch {
    root = undefined;
  }
  for (const [position, skill] of input.skills.entries()) {
    const base = { name: skill.name, version: skill.version };
    const rel = nativeSkillPath(input.location, skill.name);
    if (rel === undefined || root === undefined) {
      out.push({ ...base, delivery: "prompt_prefix", fallback_reason: "path_taken" });
      continue;
    }
    let taken: boolean;
    try {
      taken = await pathTaken(root, input.baseCommit, rel);
    } catch {
      taken = true; // a check that cannot complete refuses native (fail closed)
    }
    if (taken) {
      out.push({ ...base, delivery: "prompt_prefix", fallback_reason: "path_taken" });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.location.render(skill), "utf8");
    } catch {
      out.push({ ...base, delivery: "prompt_prefix", fallback_reason: "write_failed" });
      continue;
    }
    // Intent first: the path is recorded before anything exists at it.
    setRow(input.db, input.runId, position, "native_path = ?", rel);
    const created: string[] = [];
    let fileCreated = false;
    try {
      const parts = rel.split("/");
      let dir = root;
      for (const seg of parts.slice(0, -1)) {
        dir = path.join(dir, seg);
        const st = await lstat(dir).catch(() => undefined);
        if (st === undefined) {
          await mkdir(dir, { mode: 0o700 });
          created.push(dir);
          if (!(await lstat(dir)).isDirectory()) throw new Error("parent is not a directory");
        } else if (st.isSymbolicLink() || !st.isDirectory()) {
          throw new Error("parent is not a directory");
        }
      }
      const file = path.join(root, ...parts);
      const handle = await open(
        file,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        0o600,
      );
      fileCreated = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      setRow(input.db, input.runId, position, "written_sha256 = ?", sha256(bytes));
      out.push({ ...base, delivery: "native", native_path: rel });
    } catch {
      // Undo what this attempt made; the recorded path is cleared only when nothing of it is left.
      const file = path.join(root, ...rel.split("/"));
      if (fileCreated) await unlink(file).catch(() => undefined);
      for (const d of created.reverse()) await rmdir(d).catch(() => undefined);
      const left = await lstat(file).then(
        () => true,
        () => false,
      );
      if (!left) setRow(input.db, input.runId, position, "native_path = ?", null);
      out.push({ ...base, delivery: "prompt_prefix", fallback_reason: "write_failed" });
    }
  }
  return out;
}

/** Sets `delivery = 'native'` and `delivered_at` on the run's written rows (inside the caller's transaction). */
export function markNativeDelivered(db: Database.Database, runId: string, at: string): void {
  db.prepare(
    `UPDATE run_skill SET delivery = 'native', delivered_at = ?
     WHERE run_id = ? AND native_path IS NOT NULL AND written_sha256 IS NOT NULL AND removal IS NULL`,
  ).run(at, runId);
}

export interface RemoveNativeSkillsInput {
  readonly db: Database.Database;
  readonly runId: string;
  readonly point: SkillRemovalPoint;
  readonly fs?: NativeSkillFs;
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
}

export interface NativeRemovalResult {
  /** Recorded paths examined (0: nothing to do, no event). */
  readonly examined: number;
  readonly failed: number;
}

/**
 * One LLD §19.8 removal pass over the run's recorded paths: hash (`skill_tampered` when it differs from
 * `written_sha256`), unlink, remove the now-empty `switchboard-` directory, verify with `lstat`. Sets `removal` and
 * `removed_at`, and appends `skill_tampered`, `skill_cleanup_failed` and one `skill_removed` event, in one transaction.
 * Idempotent: a verified path is not examined again; a failed one is retried by the next point. Never throws.
 */
export async function removeNativeSkills(input: RemoveNativeSkillsInput): Promise<NativeRemovalResult> {
  let rows: RecordedRow[];
  let worktree: string | null;
  try {
    rows = pendingNativeSkills(input.db, input.runId);
    if (rows.length === 0) return { examined: 0, failed: 0 };
    worktree =
      (
        input.db.prepare("SELECT worktree_path FROM run WHERE id = ?").get(input.runId) as
          | { worktree_path: string | null }
          | undefined
      )?.worktree_path ?? null;
  } catch {
    return { examined: 0, failed: 0 };
  }
  const fs = input.fs ?? DEFAULT_FS;
  const results: { row: RecordedRow; outcome: RemovalOutcome }[] = [];
  for (const row of rows) results.push({ row, outcome: await removeOne(worktree, row, fs) });
  const now = (input.now ?? (() => new Date()))().toISOString();
  try {
    const ledger = createLedger(input.db, { ids: input.ids ?? defaultIds, ...(input.now ? { now: input.now } : {}) });
    ledger.immediate(() => {
      const update = input.db.prepare(
        "UPDATE run_skill SET removal = ?, removed_at = ? WHERE run_id = ? AND position = ?",
      );
      for (const { row, outcome } of results) {
        if (outcome.tampered !== undefined) {
          ledger.appendRunEvent({
            runId: input.runId,
            type: SKILL_TAMPERED_EVENT,
            payload: {
              name: row.name,
              native_path: row.native_path,
              written_sha256: row.written_sha256,
              found_sha256: outcome.tampered.found,
            },
          });
        }
        if (outcome.removal === "failed") {
          ledger.appendRunEvent({
            runId: input.runId,
            type: SKILL_CLEANUP_FAILED_EVENT,
            payload: { name: row.name, native_path: row.native_path, errno: outcome.errno },
          });
        }
        update.run(outcome.removal, outcome.removal === "verified" ? now : null, input.runId, row.position);
      }
      ledger.appendRunEvent({
        runId: input.runId,
        type: SKILL_REMOVED_EVENT,
        payload: {
          point: input.point,
          entries: results.map(({ row, outcome }) => ({
            name: row.name,
            native_path: row.native_path,
            removal: outcome.removal,
          })),
        },
      });
    });
  } catch {
    return { examined: rows.length, failed: rows.length };
  }
  return { examined: rows.length, failed: results.filter((r) => r.outcome.removal === "failed").length };
}

// ---- internals ------------------------------------------------------------------------------------------------

interface RemovalOutcome {
  readonly removal: "verified" | "failed";
  readonly errno?: string;
  readonly tampered?: { readonly found: string | null };
}

type Located =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly full: string }
  | { readonly kind: "other"; readonly full: string; readonly link: boolean };

/**
 * Where the recorded path is now, walking from the worktree with `lstat` and never following a link. A parent that is
 * missing, a link or not a directory means the recorded path is not in the worktree any more (`absent`).
 */
async function locate(worktree: string, rel: string): Promise<Located> {
  const parts = rel.split("/");
  let dir = worktree;
  for (const seg of [null, ...parts.slice(0, -1)]) {
    if (seg !== null) dir = path.join(dir, seg);
    const st = await lstatOrUndefined(dir);
    if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) return { kind: "absent" };
  }
  const full = path.join(dir, parts[parts.length - 1] as string);
  const st = await lstatOrUndefined(full);
  if (st === undefined) return { kind: "absent" };
  if (st.isFile()) return { kind: "file", full };
  return { kind: "other", full, link: st.isSymbolicLink() };
}

async function lstatOrUndefined(p: string) {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return undefined;
    }
    throw err;
  }
}

async function removeOne(worktree: string | null, row: RecordedRow, fs: NativeSkillFs): Promise<RemovalOutcome> {
  if (worktree === null) return { removal: "verified" };
  let tampered: { found: string | null } | undefined;
  try {
    const at = await locate(worktree, row.native_path);
    if (at.kind === "absent") return { removal: "verified" };
    if (at.kind === "other") {
      tampered = { found: null };
      if (!at.link) return { removal: "failed", errno: "EISDIR", tampered };
    } else {
      const found = await hashNoFollow(at.full);
      if (row.written_sha256 !== null && found !== row.written_sha256) tampered = { found };
    }
    await fs.unlink(at.full);
    const parent = path.dirname(at.full);
    // Only the `switchboard-<name>` directory of the `<dir>/switchboard-<name>/<file>` layout, and only when empty.
    if (path.basename(parent).startsWith("switchboard-") && row.native_path.includes("/switchboard-")) {
      await rmdir(parent).catch(() => undefined);
    }
    const after = await locate(worktree, row.native_path);
    if (after.kind !== "absent")
      return { removal: "failed", errno: "STILL_PRESENT", ...(tampered ? { tampered } : {}) };
    return { removal: "verified", ...(tampered ? { tampered } : {}) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { removal: "failed", errno: typeof code === "string" ? code : "UNKNOWN", ...(tampered ? { tampered } : {}) };
  }
}

async function hashNoFollow(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return sha256(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function setRow(db: Database.Database, runId: string, position: number, assignment: string, value: unknown): void {
  db.prepare(`UPDATE run_skill SET ${assignment} WHERE run_id = ? AND position = ?`).run(value, runId, position);
}

/**
 * LLD §19.6 step 2 refusal: the path or any parent exists in the base checkpoint, is tracked, is matched by the
 * repository's ignore rules, is a symbolic link, exists on disk (Delegated, see the module comment) or resolves outside
 * the worktree. `root` is the worktree's real path.
 */
async function pathTaken(root: string, baseCommit: string, rel: string): Promise<boolean> {
  const parts = rel.split("/");
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  // On disk: every existing component must be a real directory inside the worktree; the file and the
  // `switchboard-` directory must not exist at all.
  let dir = root;
  for (const [i, seg] of parts.entries()) {
    dir = path.join(dir, seg);
    const st = await lstatOrUndefined(dir);
    if (st === undefined) break;
    const last = i === parts.length - 1;
    if (last || seg.startsWith("switchboard-") || st.isSymbolicLink() || !st.isDirectory()) return true;
    const real = await realpath(dir);
    if (real !== dir && !real.startsWith(`${root}${path.sep}`)) return true;
  }
  const inBase = await git(["--literal-pathspecs", "ls-tree", "-z", "--name-only", baseCommit, "--", ...prefixes], {
    cwd: root,
  });
  if (inBase.stdout.length > 0) return true;
  const tracked = await git(["--literal-pathspecs", "ls-files", "-z", "--", ...prefixes], { cwd: root });
  if (tracked.stdout.length > 0) return true;
  const dirs = prefixes.slice(0, -1).map((p) => `${p}/`);
  const ignored = await git(["check-ignore", "--no-index", "--", ...prefixes, ...dirs], { cwd: root, okCodes: [1] });
  return ignored.code === 0;
}
