/**
 * Per-run submodule worktrees (ADR-0087 item 3). After the umbrella's own `git worktree add`, each declared,
 * non-excluded submodule path is checked out at its gitlink commit as a detached linked worktree of its shared store
 * (`git -C <store> worktree add --detach <run worktree>/<path> <sha>`), through the hardened helper: scrubbed
 * environment, so no global or system filter, hook or fsmonitor runs, and `driverOverrides` of the store's own
 * configuration, so no repository-configured filter runs either.
 *
 * - The umbrella checkout leaves an empty directory at each gitlink path. Attach accepts a missing or empty directory
 *   and refuses (`SUBMODULE_PATH_UNSAFE`) a target that is a symbolic link, is not a directory, is not empty, or has a
 *   symbolic link or non-directory as an ancestor inside the run worktree.
 * - An {@link AttachRecord} lists what was attached; the caller keeps it beside the run worktree under the data
 *   directory ({@link writeAttachRecord}, mode 0600) so removal ({@link detachSubmodules}) works after a restart.
 * - Before every controller Git call inside a submodule worktree, {@link verifySubmoduleLink} checks its `.git` link
 *   against the store's worktree record (as `src/workspace/git-link.ts` does for the run worktree). A link that does
 *   not verify is never used (`SUBMODULE_LINK_INVALID`; fail closed); a verified one is then used through explicit
 *   `--git-dir=<admin directory>` and `--work-tree`, so Git does not read the `.git` file again.
 * - Nothing here resolves a path through the run worktree (`realpath` of an agent-writable directory follows links the
 *   agent planted): the run worktree is canonicalised once at attach, and admin directories are matched lexically
 *   against `<worktree>/<path>/.git`.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isUnderAllowedRoot } from "../config/index.js";
import { sourceKey } from "../projects/clone.js";
import { git, gitText } from "../workspace/git.js";
import { findNestedRepositories } from "../workspace/nested.js";
import { isFullSha, isSafeSubmodulePath, MAX_SUBMODULES, SubmoduleError } from "./errors.js";
import type { SubmoduleManifest } from "./manifest.js";
import { hasCommit, mapBounded, SUBMODULE_FETCH_CONCURRENCY, withStoreLock } from "./store.js";

/** One attached submodule worktree. */
export interface AttachedSubmodule {
  /** Umbrella-relative path. */
  readonly path: string;
  /** Store key (`host/owner/repo`). */
  readonly key: string;
  /** Canonical store path. */
  readonly store: string;
  /** The commit it was attached at. */
  readonly sha: string;
  readonly writable: boolean;
  readonly wiki: boolean;
  /**
   * The name of its admin directory under the store's `.git/worktrees/`, found at attach time. Detach removes only
   * that directory; records written before it was kept have none and are matched lexically.
   */
  readonly admin?: string;
}

export interface AttachRecord {
  readonly version: 1;
  /** Canonical run worktree. */
  readonly worktree: string;
  readonly entries: readonly AttachedSubmodule[];
}

/** The part of an entry the per-worktree operations need. */
export type SubmoduleLocation = Pick<AttachedSubmodule, "path" | "store">;

export interface AttachDeps {
  /** The store path of a manifest key (normally {@link import("./store.js").prepareStores}' result). */
  storeFor(key: string): string;
  /** Parallel attaches (default {@link SUBMODULE_FETCH_CONCURRENCY}). */
  readonly concurrency?: number;
}

/** Command-scope settings of every Git call inside a store or submodule worktree. */
const WORKTREE_CONFIG = ["-c", "submodule.recurse=false"] as const;

/**
 * Attach every entry of `manifest` below `runWorktree`. On any failure the entries already attached are detached and
 * the error is thrown: `SUBMODULE_PATH_UNSAFE`, `SUBMODULE_COMMIT_MISSING` (the commit is not in its store; attach
 * never fetches) or `SUBMODULE_ATTACH_FAILED`.
 */
export async function attachSubmodules(
  runWorktree: string,
  manifest: SubmoduleManifest,
  deps: AttachDeps,
): Promise<AttachRecord> {
  const worktree = await realpath(runWorktree);
  const attached: AttachedSubmodule[] = [];
  try {
    await mapBounded(manifest.entries, deps.concurrency ?? SUBMODULE_FETCH_CONCURRENCY, async (e) => {
      if (!isSafeSubmodulePath(e.path)) throw new SubmoduleError("SUBMODULE_PATH_UNSAFE", { path: e.path });
      let store: string;
      try {
        store = await realpath(deps.storeFor(e.key));
      } catch {
        throw new SubmoduleError("SUBMODULE_ATTACH_FAILED", { path: e.path });
      }
      if (!(await safeTarget(worktree, e.path, "attach"))) {
        throw new SubmoduleError("SUBMODULE_PATH_UNSAFE", { path: e.path });
      }
      if (!(await hasCommit(store, e.sha))) throw new SubmoduleError("SUBMODULE_COMMIT_MISSING", { path: e.path });
      const target = path.join(worktree, e.path);
      let admin: string | undefined;
      try {
        // Duplicate-URL paths share a store: their worktree additions are serialised with its fetches.
        admin = await withStoreLock(store, async () => {
          await git([...WORKTREE_CONFIG, "worktree", "add", "--quiet", "--detach", target, e.sha], { cwd: store });
          return findAdminDir(store, path.join(target, ".git"));
        });
      } catch {
        throw new SubmoduleError("SUBMODULE_ATTACH_FAILED", { path: e.path });
      }
      const entry = { path: e.path, key: e.key, store, sha: e.sha, writable: e.writable, wiki: e.wiki };
      if (admin === undefined) {
        attached.push(entry); // detached lexically on rollback
        throw new SubmoduleError("SUBMODULE_ATTACH_FAILED", { path: e.path });
      }
      attached.push({ ...entry, admin: path.basename(admin) });
    });
  } catch (err) {
    await detachSubmodules({ version: 1, worktree, entries: attached });
    throw err;
  }
  attached.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: 1, worktree, entries: attached };
}

/** Write `rec` as JSON to `file` (mode 0600, written to a temporary file and renamed into place). */
export async function writeAttachRecord(file: string, rec: AttachRecord): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Read an attach record. Undefined when `file` does not exist; `SUBMODULE_RECORD_INVALID` when it is not a record this
 * library wrote: the shape, a path that is not safe, a key, a SHA, or a store or worktree path that is not absolute
 * and normalised, or a store outside `allowedRoot` (the `clone_root`).
 */
export async function readAttachRecord(file: string, allowedRoot: string): Promise<AttachRecord | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SubmoduleError("SUBMODULE_RECORD_INVALID");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SubmoduleError("SUBMODULE_RECORD_INVALID");
  }
  const rec = parseRecord(raw, allowedRoot);
  if (rec === undefined) throw new SubmoduleError("SUBMODULE_RECORD_INVALID");
  return rec;
}

function parseRecord(raw: unknown, allowedRoot: string): AttachRecord | undefined {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const absNormal = (v: unknown): v is string =>
    typeof v === "string" && path.isAbsolute(v) && path.resolve(v) === v && !v.includes("\0");
  if (!isObj(raw) || raw.version !== 1 || !absNormal(raw.worktree) || !Array.isArray(raw.entries)) return undefined;
  if (raw.entries.length > MAX_SUBMODULES) return undefined;
  const entries: AttachedSubmodule[] = [];
  for (const e of raw.entries as unknown[]) {
    if (!isObj(e)) return undefined;
    const { path: p, key, store, sha, writable, wiki, admin } = e;
    if (typeof p !== "string" || !isSafeSubmodulePath(p)) return undefined;
    if (typeof key !== "string" || !isSourceKey(key)) return undefined;
    if (!absNormal(store) || !isUnderAllowedRoot(store, [allowedRoot])) return undefined;
    if (typeof sha !== "string" || !isFullSha(sha)) return undefined;
    if (typeof writable !== "boolean" || typeof wiki !== "boolean" || (wiki && writable)) return undefined;
    if (admin !== undefined && (typeof admin !== "string" || !isAdminName(admin))) return undefined;
    entries.push({ path: p, key, store, sha, writable, wiki, ...(admin !== undefined ? { admin } : {}) });
  }
  return { version: 1, worktree: raw.worktree, entries };
}

/** A worktree admin directory name as Git makes it: one path segment. */
function isAdminName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,255}$/u.test(name) && name !== "." && name !== "..";
}

function isSourceKey(key: string): boolean {
  const parts = key.split("/");
  if (parts.length !== 3) return false;
  const [host, owner, repo] = parts as [string, string, string];
  return (
    sourceKey({ host, owner, repo }) === key && /^[a-z0-9.-]+$/u.test(host) && /^[a-z0-9._-]+$/u.test(owner + repo)
  );
}

export interface DetachResult {
  /** Removed with `git worktree remove`. */
  readonly removed: number;
  /** The store's worktree record was dropped without touching the files (path unsafe or remove refused). */
  readonly unlinked: number;
  /** The store had no worktree record for the path. */
  readonly missing: number;
  /** Stores where `git worktree prune` failed (or the store is gone). */
  readonly pruneFailed: number;
}

/**
 * Detach every entry of `rec` (best effort; never throws). Its admin directory is the one recorded at attach (or, for
 * an older record, the one whose `gitdir` names `<worktree>/<path>/.git` lexically) and must still name that file
 * lexically: nothing is resolved through the run worktree, so a path the agent replaced with a link into another run's
 * worktree never selects that run's admin directory. A target that is still a real directory with no symbolic link on
 * its way is removed with `git worktree remove --force --force`; otherwise (tampered, gone, or refused by Git) only
 * this entry's admin directory is dropped, so Git never follows a link the agent planted. Then each store is pruned.
 */
export async function detachSubmodules(rec: AttachRecord): Promise<DetachResult> {
  let removed = 0;
  let unlinked = 0;
  let missing = 0;
  let pruneFailed = 0;
  const stores = new Set<string>();
  for (const e of rec.entries) {
    stores.add(e.store);
    try {
      const target = path.join(rec.worktree, e.path);
      const admin = await adminDirOf(e.store, path.join(target, ".git"), e.admin);
      if (admin === undefined) {
        missing++;
        continue;
      }
      if (isSafeSubmodulePath(e.path) && (await safeTarget(rec.worktree, e.path, "existing"))) {
        const r = await git([...WORKTREE_CONFIG, "worktree", "remove", "--force", "--force", target], {
          cwd: e.store,
          okCodes: [128],
        }).catch(() => undefined);
        if (r?.code === 0) {
          removed++;
          continue;
        }
      }
      await rm(admin, { recursive: true, force: true });
      unlinked++;
    } catch {
      missing++;
    }
  }
  for (const store of stores) {
    try {
      await git(["worktree", "prune"], { cwd: store });
    } catch {
      pruneFailed++;
    }
  }
  return { removed, unlinked, missing, pruneFailed };
}

/**
 * Whether `<runWorktree>/<path>/.git` is a regular file `gitdir: <store>/.git/worktrees/<id>` whose admin directory is
 * a direct child of the store's `.git/worktrees/` and whose `gitdir` file points back at that `.git` file, with no
 * symbolic link on the way inside the run worktree. False on any mismatch or error.
 */
export async function verifySubmoduleLink(runWorktree: string, entry: SubmoduleLocation): Promise<boolean> {
  return (await verifiedLink(runWorktree, entry)) !== undefined;
}

/** {@link verifySubmoduleLink}'s check; the canonical worktree path and admin directory when it holds. */
async function verifiedLink(
  runWorktree: string,
  entry: SubmoduleLocation,
): Promise<{ readonly workTree: string; readonly gitDir: string } | undefined> {
  try {
    if (!isSafeSubmodulePath(entry.path)) return undefined;
    const worktree = await realpath(runWorktree);
    if (!(await safeTarget(worktree, entry.path, "existing"))) return undefined;
    const link = path.join(worktree, entry.path, ".git");
    const st = await lstat(link);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 4096) return undefined;
    const m = /^gitdir: (.+?)\r?\n?$/u.exec(await readFile(link, "utf8"));
    if (m?.[1] === undefined) return undefined;
    const admin = await realpath(path.resolve(path.dirname(link), m[1]));
    const base = await realpath(path.join(entry.store, ".git", "worktrees"));
    if (path.dirname(admin) !== base) return undefined;
    const adminSt = await lstat(admin);
    if (!adminSt.isDirectory()) return undefined;
    // Lexical: the store's record must name this very `.git` file, never one reached through a link.
    if (!(await recordsLink(admin, link))) return undefined;
    return { workTree: path.join(worktree, entry.path), gitDir: admin };
  } catch {
    return undefined;
  }
}

/**
 * Roll the submodule worktree back to `sha` (`reset --hard`, then `clean -fd`), after {@link verifySubmoduleLink};
 * throws `SUBMODULE_LINK_INVALID` when the link does not verify (nothing is run).
 */
export async function resetSubmodule(runWorktree: string, entry: SubmoduleLocation, sha: string): Promise<void> {
  if (!isFullSha(sha)) throw new SubmoduleError("SUBMODULE_COMMIT_MISSING", { path: entry.path });
  const { cwd, pin } = await verifiedCwd(runWorktree, entry);
  await git([...WORKTREE_CONFIG, ...pin, "reset", "-q", "--hard", sha], { cwd });
  await git([...WORKTREE_CONFIG, ...pin, "clean", "-fdq"], { cwd });
}

/**
 * Paths changed in the submodule worktree against its `HEAD` and index (`status --porcelain=v2 -z`, untracked files
 * listed one by one, nested repositories excluded as ADR-0022 does for the umbrella). A rename lists its new path.
 * Throws `SUBMODULE_LINK_INVALID` when the link does not verify.
 */
export async function submoduleStatus(runWorktree: string, entry: SubmoduleLocation): Promise<string[]> {
  const { cwd, pin } = await verifiedCwd(runWorktree, entry);
  const nested = await findNestedRepositories(cwd);
  const out = await git(
    [
      ...WORKTREE_CONFIG,
      ...pin,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--",
      ".",
      ...nested.excludes,
    ],
    { cwd },
  );
  return parseStatusPaths(out.stdout.toString("utf8"));
}

/** Paths of `status --porcelain=v2 -z` records (ordinary, rename/copy, unmerged, untracked). */
export function parseStatusPaths(raw: string): string[] {
  const recs = raw.split("\0");
  const paths: string[] = [];
  const after = (rec: string, fields: number) => {
    let at = -1;
    for (let i = 0; i < fields; i++) {
      at = rec.indexOf(" ", at + 1);
      if (at === -1) return undefined;
    }
    return rec.slice(at + 1);
  };
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i] as string;
    let p: string | undefined;
    if (rec.startsWith("1 ")) p = after(rec, 8);
    else if (rec.startsWith("2 ")) {
      p = after(rec, 9);
      i++; // the original path follows as its own NUL-terminated field
    } else if (rec.startsWith("u ")) p = after(rec, 10);
    else if (rec.startsWith("? ")) p = rec.slice(2);
    if (p !== undefined && p !== "") paths.push(p);
  }
  return paths;
}

export interface WriteTreeOptions {
  /** Extra exclude pathspecs (for example `:(exclude,top,literal)<skill path>`), appended after the nested ones. */
  readonly excludes?: readonly string[];
  /** Where the temporary index is made (default the OS temporary directory). */
  readonly scratchDir?: string;
  /**
   * ADR-0087 item 4: submodule-relative literal paths to add instead of every change (an explicit commit path inside
   * the submodule), checked by the caller. `excludes` do not apply to them (literal pathspecs carry no magic).
   */
  readonly paths?: readonly string[];
  /** Literal paths whose entries are put back to `parentSha`'s after the add (recorded skill paths). */
  readonly restorePaths?: readonly string[];
}

/**
 * The tree of the submodule worktree as a commit would record it: a temporary index (`GIT_INDEX_FILE` in a scratch
 * directory) is read from `parentSha`, `add -A -- . <nested excludes> <excludes>` (or a literal add of
 * {@link WriteTreeOptions.paths}) runs, {@link WriteTreeOptions.restorePaths} are put back to the parent's entries,
 * and `write-tree` returns the tree id. The worktree's own index is not touched. Throws `SUBMODULE_LINK_INVALID` when the link does not verify.
 */
export async function writeWorktreeTree(
  runWorktree: string,
  entry: SubmoduleLocation,
  parentSha: string,
  opts: WriteTreeOptions = {},
): Promise<string> {
  if (!isFullSha(parentSha)) throw new SubmoduleError("SUBMODULE_COMMIT_MISSING", { path: entry.path });
  const { cwd, pin } = await verifiedCwd(runWorktree, entry);
  const nested = await findNestedRepositories(cwd);
  const tmp = await mkdtemp(path.join(opts.scratchDir ?? tmpdir(), "sb-subidx-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    await git([...WORKTREE_CONFIG, ...pin, "read-tree", parentSha], { cwd, env });
    if (opts.paths === undefined) {
      await git([...WORKTREE_CONFIG, ...pin, "add", "-A", "--", ".", ...nested.excludes, ...(opts.excludes ?? [])], {
        cwd,
        env,
      });
    } else if (opts.paths.length > 0) {
      await git(
        [...WORKTREE_CONFIG, ...pin, "--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"],
        {
          cwd,
          env,
          input: `${opts.paths.join("\0")}\0`,
        },
      );
    }
    if (opts.restorePaths !== undefined && opts.restorePaths.length > 0) {
      await git(
        [...WORKTREE_CONFIG, ...pin, "--literal-pathspecs", "reset", "-q", parentSha, "--", ...opts.restorePaths],
        {
          cwd,
          env,
        },
      );
    }
    return await gitText([...WORKTREE_CONFIG, ...pin, "write-tree"], { cwd, env });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * The verified submodule worktree and the Git options that pin it: `--git-dir=<verified admin directory>` and
 * `--work-tree=<path>`, so the `.git` file is not read again after the check.
 */
async function verifiedCwd(
  runWorktree: string,
  entry: SubmoduleLocation,
): Promise<{ readonly cwd: string; readonly pin: readonly string[] }> {
  const v = await verifiedLink(runWorktree, entry);
  if (v === undefined) throw new SubmoduleError("SUBMODULE_LINK_INVALID", { path: entry.path });
  return { cwd: v.workTree, pin: [`--git-dir=${v.gitDir}`, `--work-tree=${v.workTree}`] };
}

/**
 * Walk `<worktree>/<rel>` without following links. `attach`: every existing component is a real directory and the
 * target, when it exists, is empty. `existing`: every component exists and is a real directory.
 */
async function safeTarget(worktree: string, rel: string, mode: "attach" | "existing"): Promise<boolean> {
  const segs = rel.split("/");
  let p = worktree;
  for (let i = 0; i < segs.length; i++) {
    p = path.join(p, segs[i] as string);
    const st = await lstat(p).catch(() => undefined);
    if (st === undefined) return mode === "attach";
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (i === segs.length - 1 && mode === "attach" && (await readdir(p)).length > 0) return false;
  }
  return true;
}

/** Whether the admin directory's `gitdir` file names `linkPath` exactly (lexically; nothing is resolved). */
async function recordsLink(admin: string, linkPath: string): Promise<boolean> {
  const recorded = await readFile(path.join(admin, "gitdir"), "utf8").catch(() => undefined);
  return recorded !== undefined && path.resolve(admin, recorded.trim()) === linkPath;
}

/** The store's worktree admin directory whose `gitdir` file names `linkPath` lexically. */
async function findAdminDir(store: string, linkPath: string): Promise<string | undefined> {
  const base = path.join(store, ".git", "worktrees");
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (await recordsLink(path.join(base, name), linkPath)) return path.join(base, name);
  }
  return undefined;
}

/**
 * The admin directory of an attached entry: the recorded one when it still names `linkPath` (a name Git reused for
 * another worktree does not), else for a record without a name the lexical match; undefined when there is none.
 */
async function adminDirOf(store: string, linkPath: string, recorded: string | undefined): Promise<string | undefined> {
  if (recorded === undefined) return findAdminDir(store, linkPath);
  if (!isAdminName(recorded)) return undefined;
  const admin = path.join(store, ".git", "worktrees", recorded);
  const st = await lstat(admin).catch(() => undefined);
  if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) return undefined;
  return (await recordsLink(admin, linkPath)) ? admin : undefined;
}

/**
 * ADR-0087 item 3: where a run worktree's attach record lives, beside the worktree under the data directory
 * (`<dataDir>/worktrees/<sess>/<run>.submodules.json`). Derived from the worktree path alone, so every consumer (the
 * workspace manager, the commit tool, `finalize_commit`, `gc`, publication) finds it without extra state.
 */
export function attachRecordFile(runWorktree: string): string {
  return `${runWorktree.replace(/\/+$/, "")}.submodules.json`;
}
