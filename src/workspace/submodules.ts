/**
 * Run worktree wiring of the submodule library (ADR-0079 item 3). The workspace manager calls these after the umbrella's
 * own `git worktree add` when the run's project has a primary context with `submodules.mode: "recursive"`; `gc`,
 * rollback and the partial-worktree repair call the removal half. A context without recursive mode never reaches this
 * module, so its worktrees are exactly as before.
 *
 * - **Attach**: the manifest of the base commit is read (effective `project_sources`, the context's `writable_paths`
 *   and `exclude`), each store is made ready (bounded parallel clone or fetch of only missing commits), every declared
 *   path is attached, and the {@link attachRecordFile} record is written beside the worktree. A store that could not be
 *   made or a commit still missing is a {@link SubmoduleError} with the first affected path (never the URL).
 * - **Refresh** (a resumed worktree, `continue_task` in the origin directory): the existing record is reused. A path
 *   still declared for the same repository, whose link verifies, is re-pointed in place with `resetSubmodule` when its
 *   gitlink moved and left alone otherwise; other recorded paths are detached and new ones attached. Nothing is
 *   attached twice.
 * - **Removal**: the record is read (its stores must lie under `clone_root`), every entry is detached, the stores are
 *   pruned and the record is deleted. Best effort; never throws.
 */
import { rm } from "node:fs/promises";
import type { ProjectSourcesSettings } from "../config/index.js";
import { type GitRunner, parseRepositoryUrl, type RepositorySource } from "../projects/clone.js";
import {
  type AttachedSubmodule,
  type AttachRecord,
  attachRecordFile,
  attachSubmodules,
  type DetachResult,
  detachSubmodules,
  dropCheckpointRefs,
  type PreparedStore,
  prepareStores,
  readAttachRecord,
  readSubmoduleManifest,
  resetSubmodule,
  SubmoduleError,
  type SubmoduleManifest,
  verifySubmoduleLink,
  writeAttachRecord,
} from "../submodules/index.js";
import { git } from "./git.js";

/** The parts of a primary context's `submodules` setting a run worktree needs (ADR-0079 item 1). */
export interface SubmodulePlan {
  /** Worktree-relative POSIX paths, or exactly `["*"]`. */
  readonly writablePaths: readonly string[];
  readonly exclude: readonly string[];
  /** The context's base remote; its https URL resolves `../<repo>` submodule URLs. Absent: such a URL is refused. */
  readonly baseRemote?: string;
}

/** What `serve` wires into the workspace manager (and the base tools) for recursive contexts. */
export interface SubmoduleDeps {
  /** The live effective `project_sources` (configured owners plus approved grants); absent: every URL is refused. */
  readonly sources: () => ProjectSourcesSettings | undefined;
  /** Network Git runner of the stores (test seam; default the library's). */
  readonly git?: GitRunner;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

/** Settings that allow nothing: a recursive context on a server without `project_sources` refuses every URL. */
const NO_SOURCES: ProjectSourcesSettings = { cloneRoot: "/nonexistent", allowedHosts: [], allowedOwners: [] };

/** Summary of a store preparation (`refresh_project_base`'s `submodules` field). */
export interface SubmodulePresence {
  /** Distinct gitlink commits of the manifest. */
  readonly total: number;
  readonly present: number;
  readonly fetched: number;
  readonly missing: number;
}

/** The umbrella's own repository source: the single https URL of `remote`, when it is an ADR-0068 URL. */
export async function umbrellaSource(
  repoRoot: string,
  remote: string | undefined,
): Promise<RepositorySource | undefined> {
  if (remote === undefined || remote === "" || remote.startsWith("-") || /[\s\0]/u.test(remote)) return undefined;
  try {
    const r = await git(["config", "--get-all", `remote.${remote}.url`], { cwd: repoRoot, okCodes: [1] });
    const urls = r.stdout
      .toString("utf8")
      .split("\n")
      .filter((u) => u !== "");
    return urls.length === 1 ? parseRepositoryUrl(urls[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** Read and check the manifest of `commit` with the plan's lists and the live sources. Throws {@link SubmoduleError}. */
export async function planManifest(
  repoRoot: string,
  commit: string,
  plan: SubmodulePlan,
  deps: Pick<SubmoduleDeps, "sources">,
): Promise<SubmoduleManifest> {
  const umbrella = await umbrellaSource(repoRoot, plan.baseRemote);
  return readSubmoduleManifest(repoRoot, commit, {
    sources: () => deps.sources() ?? NO_SOURCES,
    ...(umbrella !== undefined ? { umbrella } : {}),
    exclude: plan.exclude,
    writable: plan.writablePaths,
  });
}

/** Make every store of `manifest` and the commits it needs ready (bounded parallel). Never throws. */
export function readyStores(
  manifest: SubmoduleManifest,
  deps: SubmoduleDeps,
  shasByKey?: ReadonlyMap<string, readonly string[]>,
): Promise<PreparedStore[]> {
  return prepareStores(manifest, shasByKey, {
    settings: deps.sources() ?? NO_SOURCES,
    ...(deps.git !== undefined ? { git: deps.git } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
  });
}

/** Counts over prepared stores (each commit counted once per store). */
export function presenceOf(stores: readonly PreparedStore[]): SubmodulePresence {
  let present = 0;
  let fetched = 0;
  let missing = 0;
  for (const s of stores) {
    present += s.present.length;
    fetched += s.fetched.length;
    missing += s.missing.length;
  }
  return { total: present + fetched + missing, present, fetched, missing };
}

/**
 * The store path of each key, or a {@link SubmoduleError} naming the first path of a store that could not be made
 * (`SUBMODULE_SOURCE_NOT_ALLOWED` when its source left `project_sources`, else `SUBMODULE_ATTACH_FAILED`) or whose
 * commit is still missing (`SUBMODULE_COMMIT_MISSING`).
 */
function storesOrThrow(manifest: SubmoduleManifest, stores: readonly PreparedStore[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const s of stores) {
    const entries = manifest.byKey.get(s.key) ?? [];
    if (s.path === undefined) {
      const reason =
        s.reason === "CLONE_SOURCE_NOT_ALLOWED" ? "SUBMODULE_SOURCE_NOT_ALLOWED" : "SUBMODULE_ATTACH_FAILED";
      throw new SubmoduleError(reason, { path: entries[0]?.path ?? "" });
    }
    const missing = entries.find((e) => s.missing.includes(e.sha));
    if (missing !== undefined) throw new SubmoduleError("SUBMODULE_COMMIT_MISSING", { path: missing.path });
    byKey.set(s.key, s.path);
  }
  return byKey;
}

function subset(manifest: SubmoduleManifest, entries: SubmoduleManifest["entries"]): SubmoduleManifest {
  const byKey = new Map<string, SubmoduleManifest["entries"][number][]>();
  for (const e of entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  return {
    commit: manifest.commit,
    entries,
    byKey,
    readOnlyPaths: entries.filter((e) => !e.writable).map((e) => e.path),
  };
}

export interface RunSubmoduleInput {
  readonly repoRoot: string;
  readonly worktreePath: string;
  /** The umbrella commit the worktree is checked out at. */
  readonly commit: string;
  readonly plan: SubmodulePlan;
}

/**
 * Attach the submodules of a fresh run worktree and write its record; with `reuse`, refresh the record an earlier run
 * left in the same worktree instead (see the module comment). Throws {@link SubmoduleError}; nothing it attached stays
 * attached when it throws.
 */
export async function attachRunSubmodules(
  input: RunSubmoduleInput,
  deps: SubmoduleDeps,
  opts: { readonly reuse?: boolean } = {},
): Promise<AttachRecord> {
  const manifest = await planManifest(input.repoRoot, input.commit, input.plan, deps);
  const stores = storesOrThrow(manifest, await readyStores(manifest, deps));
  const storeFor = (key: string) => stores.get(key) ?? "/nonexistent";
  const file = attachRecordFile(input.worktreePath);
  const cloneRoot = deps.sources()?.cloneRoot;
  const previous =
    opts.reuse === true && cloneRoot !== undefined
      ? await readAttachRecord(file, cloneRoot).catch(() => undefined)
      : undefined;

  const kept: AttachedSubmodule[] = [];
  const stale: AttachedSubmodule[] = [];
  const fresh: SubmoduleManifest["entries"][number][] = [];
  const wanted = new Map(manifest.entries.map((e) => [e.path, e]));
  for (const old of previous?.entries ?? []) {
    const e = wanted.get(old.path);
    if (
      e !== undefined &&
      e.key === old.key &&
      old.store === storeFor(e.key) &&
      (await verifySubmoduleLink(input.worktreePath, old))
    ) {
      if (old.sha !== e.sha) await resetSubmodule(input.worktreePath, old, e.sha);
      kept.push({ ...old, sha: e.sha, writable: e.writable, wiki: e.wiki });
      wanted.delete(old.path);
    } else stale.push(old);
  }
  for (const e of manifest.entries) if (wanted.has(e.path)) fresh.push(e);
  if (previous !== undefined && stale.length > 0) await detachSubmodules({ ...previous, entries: stale });

  const added = await attachSubmodules(input.worktreePath, subset(manifest, fresh), { storeFor });
  const entries = [...kept, ...added.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const record: AttachRecord = { version: 1, worktree: added.worktree, entries };
  try {
    await writeAttachRecord(file, record);
  } catch {
    await detachSubmodules(record);
    await rm(file, { force: true }).catch(() => undefined);
    throw new SubmoduleError("SUBMODULE_ATTACH_FAILED", { path: entries[0]?.path ?? "" });
  }
  return record;
}

/**
 * Detach the submodules recorded for `worktreePath` and delete the record (best effort; never throws). Undefined when
 * there is no record. Without `cloneRoot` (no `project_sources`) a record cannot be checked and is left in place.
 */
export async function detachRunSubmodules(
  worktreePath: string,
  cloneRoot: string | undefined,
  /**
   * Collection (`gc`) only: runs whose `refs/switchboard/checkpoints/<run>/*` refs are dropped from the record's stores
   * first, because nothing can resume from them any more. Absent (repair, rollback): every checkpoint ref is kept.
   */
  dropCheckpointsOf?: (runId: string) => boolean,
): Promise<DetachResult | undefined> {
  const file = attachRecordFile(worktreePath);
  if (cloneRoot === undefined) return undefined;
  let rec: AttachRecord | undefined;
  try {
    rec = await readAttachRecord(file, cloneRoot);
  } catch {
    // Not a record this controller wrote: nothing in it is acted on (fail closed); the file goes.
    await rm(file, { force: true }).catch(() => undefined);
    return undefined;
  }
  if (rec === undefined) return undefined;
  if (dropCheckpointsOf !== undefined) {
    for (const store of new Set(rec.entries.map((e) => e.store))) await dropCheckpointRefs(store, dropCheckpointsOf);
  }
  const result = await detachSubmodules(rec);
  await rm(file, { force: true }).catch(() => undefined);
  return result;
}

/**
 * Roll every recorded submodule worktree of `worktreePath` back to its recorded commit (rollback of a failed run).
 * Best effort: an entry whose link does not verify is not touched. Returns the paths rolled back.
 */
export async function resetRunSubmodules(worktreePath: string, cloneRoot: string | undefined): Promise<string[]> {
  if (cloneRoot === undefined) return [];
  const rec = await readAttachRecord(attachRecordFile(worktreePath), cloneRoot).catch(() => undefined);
  const done: string[] = [];
  for (const e of rec?.entries ?? []) {
    try {
      await resetSubmodule(worktreePath, e, e.sha);
      done.push(e.path);
    } catch {
      // A tampered link is never used (SUBMODULE_LINK_INVALID); nothing is run for it.
    }
  }
  return done;
}
