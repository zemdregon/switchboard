/**
 * Shared submodule object stores (ADR-0079 item 3, G3, G9). Each distinct submodule repository has one clone at its
 * ADR-0068 clone target `<clone_root>/<host>/<owner>/<repo>`, made by {@link ensureClone} with `--no-checkout` and the
 * store hardening ({@link STORE_CLONE_CONFIG}); two paths that reference one repository share it, and stores persist
 * between runs (the cache).
 *
 * - **Network Git** (clone, fetch, `remote set-head`) runs through the injected {@link GitRunner}, by default
 *   {@link defaultGitRunner}: the server's own environment, so the operator's credential helper or `gh` login works,
 *   and Switchboard never reads or passes a credential. Every such call carries command-scope `-c` settings that allow
 *   only the `https` transport (`protocol.allow=never`, `protocol.https.allow=always`), turn off hooks, fsmonitor,
 *   submodule recursion, commit-graph writes and automatic maintenance. Before any fetch the store's own configuration
 *   is checked with the push hardening's {@link repoConfigUnsafe} (credential helpers, `insteadOf`, transport
 *   commands, `protocol.*` set in the store refuse the fetch) and its `origin` must still be the store's https source.
 * - **Local Git** (`cat-file`, `symbolic-ref`) runs through the hardened helper (scrubbed environment).
 * - **Tests** cannot reach an https remote. They inject a runner that adds `-c url.<local>.insteadOf=<https URL>` and
 *   `-c protocol.file.allow=always` in front of the argv, so the store's `origin` stays the https URL and the
 *   production argv stays https-only. There is deliberately no production seam that changes the URL or the protocol
 *   allowlist.
 * - **Serialisation**: every operation on one store runs under an in-process promise-chain lock keyed by the store
 *   path, so two runs never fetch into one store at once; different stores run in parallel, at most
 *   {@link SUBMODULE_FETCH_CONCURRENCY} at a time in {@link prepareStores} (**Delegated**).
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ProjectSourcesSettings } from "../config/index.js";
import { repoConfigUnsafe } from "../git/push.js";
import {
  CloneError,
  type CloneRefusal,
  cloneTarget,
  DEFAULT_CLONE_TIMEOUT_MS,
  defaultGitRunner,
  ensureClone,
  type GitRunner,
  parseRepositoryUrl,
  type RepositorySource,
  sourceAllowed,
  sourceKey,
} from "../projects/clone.js";
import { git } from "../workspace/git.js";
import { isFullSha } from "./errors.js";
import type { SubmoduleManifest } from "./manifest.js";

/** **Delegated** (ADR-0079 item 3): stores prepared (cloned or fetched) at once. */
export const SUBMODULE_FETCH_CONCURRENCY = 8;

/** Command-scope settings added to the ADR-0068 clone (and its reuse fetch, which stores turn off). */
export const STORE_CLONE_CONFIG: readonly string[] = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
];

/** Command-scope settings of every store fetch: the base-refresh FETCH_CONFIG, but https only. */
export const STORE_FETCH_CONFIG: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.writeCommitGraph=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
];

const FETCH_FLAGS = [
  "fetch",
  "--quiet",
  "--no-tags",
  "--no-recurse-submodules",
  "--no-write-fetch-head",
  "--no-auto-maintenance",
] as const;

/** Where a store keeps a commit it fetched by id, so it stays reachable (**Delegated**). */
export const FETCHED_COMMIT_REF_PREFIX = "refs/switchboard/submodule-commits/";

/** argv (after `git`) that fetches every branch of `origin` into `refs/remotes/origin/*`. */
export function storeFetchBranchesArgs(): string[] {
  return [...STORE_FETCH_CONFIG, ...FETCH_FLAGS, "--", "origin", "+refs/heads/*:refs/remotes/origin/*"];
}

/** argv (after `git`) that fetches one commit by id into {@link FETCHED_COMMIT_REF_PREFIX}`<sha>`. */
export function storeFetchCommitArgs(sha: string): string[] {
  if (!isFullSha(sha)) throw new Error("invalid commit id");
  return [...STORE_FETCH_CONFIG, ...FETCH_FLAGS, "--", "origin", `${sha}:${FETCHED_COMMIT_REF_PREFIX}${sha}`];
}

export interface StoreDeps {
  /** `project_sources` (its `clone_root` holds the stores). */
  readonly settings: ProjectSourcesSettings;
  /** Network Git runner (default {@link defaultGitRunner}). */
  readonly git?: GitRunner;
  readonly timeoutMs?: number;
  /** {@link prepareStores} parallelism (default {@link SUBMODULE_FETCH_CONCURRENCY}). */
  readonly concurrency?: number;
}

/** The store of `src`: its ADR-0068 clone target. */
export function storePath(src: RepositorySource, settings: ProjectSourcesSettings): string {
  return cloneTarget(src, settings);
}

/**
 * Clone the store of `src` (`--no-checkout`, {@link STORE_CLONE_CONFIG}) or reuse it without fetching. Throws
 * {@link CloneError} (`CLONE_SOURCE_NOT_ALLOWED` when `src` left `project_sources`, `CLONE_TARGET_CONFLICT`,
 * `CLONE_FAILED`).
 */
export async function ensureStore(
  src: RepositorySource,
  deps: StoreDeps,
): Promise<{ path: string; outcome: "cloned" | "reused" }> {
  if (!sourceAllowed(src, deps.settings)) throw new CloneError("CLONE_SOURCE_NOT_ALLOWED");
  return withStoreLock(path.resolve(storePath(src, deps.settings)), () =>
    ensureClone(src, {
      settings: deps.settings,
      ...(deps.git !== undefined ? { git: deps.git } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      noCheckout: true,
      extraConfig: STORE_CLONE_CONFIG,
      fetchOnReuse: false,
    }),
  );
}

export interface EnsureCommitsDeps {
  readonly git?: GitRunner;
  readonly timeoutMs?: number;
  /** The store's expected {@link sourceKey}; when set, `origin` must name that repository before a fetch. */
  readonly key?: string;
}

export interface CommitPresence {
  /** Already in the store. */
  readonly present: string[];
  /** Fetched by this call. */
  readonly fetched: string[];
  /** Still not in the store (or not a full commit id). */
  readonly missing: string[];
}

/**
 * Make `shas` present in the store: look each up (`cat-file -e`); only when one is missing fetch the store's `origin`
 * branches, then each still-missing commit by id. Never throws for a missing commit or a failed fetch: it is returned
 * in `missing`. Serialised per store.
 */
export async function ensureCommits(
  store: string,
  shas: readonly string[],
  deps: EnsureCommitsDeps = {},
): Promise<CommitPresence> {
  const wanted = [...new Set(shas)];
  const invalid = wanted.filter((s) => !isFullSha(s));
  const valid = wanted.filter(isFullSha);
  let canonical: string;
  try {
    canonical = await realpath(store);
  } catch {
    return { present: [], fetched: [], missing: wanted };
  }
  return withStoreLock(canonical, async () => {
    const present: string[] = [];
    let need: string[] = [];
    for (const sha of valid) ((await hasCommit(canonical, sha)) ? present : need).push(sha);
    const fetched: string[] = [];
    if (need.length > 0 && (await fetchAllowed(canonical, deps.key))) {
      const runner = deps.git ?? defaultGitRunner;
      const timeoutMs = deps.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
      await runner(storeFetchBranchesArgs(), { cwd: canonical, timeoutMs });
      need = await partition(canonical, need, fetched);
      for (const sha of [...need]) {
        await runner(storeFetchCommitArgs(sha), { cwd: canonical, timeoutMs });
        if (await hasCommit(canonical, sha)) {
          fetched.push(sha);
          need = need.filter((s) => s !== sha);
        }
      }
    }
    return { present, fetched, missing: [...need, ...invalid] };
  });
}

/**
 * The store's default branch: the short name of `refs/remotes/origin/HEAD` (set by the clone). When it is absent,
 * `git remote set-head origin --auto` runs once through the runner (same fetch hardening). Undefined when unknown.
 */
export async function defaultBranchOf(store: string, deps: EnsureCommitsDeps = {}): Promise<string | undefined> {
  const canonical = await realpath(store).catch(() => undefined);
  if (canonical === undefined) return undefined;
  const first = await readOriginHead(canonical);
  if (first !== undefined) return first;
  return withStoreLock(canonical, async () => {
    if (!(await fetchAllowed(canonical, deps.key))) return undefined;
    await (deps.git ?? defaultGitRunner)([...STORE_FETCH_CONFIG, "remote", "set-head", "origin", "--auto"], {
      cwd: canonical,
      timeoutMs: deps.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS,
    });
    return readOriginHead(canonical);
  });
}

/**
 * `fn` over `items` with at most `limit` calls in flight; results in input order. Every item is attempted; when any
 * call rejects, the first rejection is rethrown after all calls settled.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failure: { err: unknown } | undefined;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  if (failure !== undefined) throw failure.err;
  return results;
}

export interface PreparedStore {
  readonly key: string;
  /** Canonical store path; undefined when the store could not be made. */
  readonly path?: string;
  readonly outcome: "cloned" | "reused" | "failed";
  /** Why the store could not be made (`outcome: "failed"`). */
  readonly reason?: CloneRefusal;
  readonly present: readonly string[];
  readonly fetched: readonly string[];
  readonly missing: readonly string[];
}

/**
 * Ensure every store of `manifest` and the commits it needs, in parallel (bounded). `shasByKey` names the commits per
 * key (default: the manifest's gitlink SHAs of that key). Never throws: a store that cannot be made is `failed` with
 * every wanted commit in `missing`. Results in `manifest.byKey` order.
 */
export async function prepareStores(
  manifest: SubmoduleManifest,
  shasByKey: ReadonlyMap<string, readonly string[]> | undefined,
  deps: StoreDeps,
): Promise<PreparedStore[]> {
  const keys = [...manifest.byKey.keys()];
  return mapBounded(keys, deps.concurrency ?? SUBMODULE_FETCH_CONCURRENCY, async (key) => {
    const entries = manifest.byKey.get(key) ?? [];
    const shas = [...new Set(shasByKey?.get(key) ?? entries.map((e) => e.sha))];
    const src = (entries[0] as (typeof entries)[number]).source;
    let made: { path: string; outcome: "cloned" | "reused" };
    try {
      made = await ensureStore(src, deps);
    } catch (err) {
      const reason: CloneRefusal = err instanceof CloneError ? err.reason : "CLONE_FAILED";
      return { key, outcome: "failed", reason, present: [], fetched: [], missing: shas };
    }
    const presence = await ensureCommits(made.path, shas, {
      key,
      ...(deps.git !== undefined ? { git: deps.git } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
    return { key, path: made.path, outcome: made.outcome, ...presence };
  });
}

/** Whether the store holds commit `sha` (hardened local Git; never a network call). */
export async function hasCommit(store: string, sha: string): Promise<boolean> {
  if (!isFullSha(sha)) return false;
  try {
    const r = await git(["cat-file", "-e", `${sha}^{commit}`], { cwd: store, okCodes: [1, 128] });
    return r.code === 0;
  } catch {
    return false;
  }
}

async function partition(store: string, need: readonly string[], fetched: string[]): Promise<string[]> {
  const still: string[] = [];
  for (const sha of need) ((await hasCommit(store, sha)) ? fetched : still).push(sha);
  return still;
}

/** The store's configuration is safe to fetch with and its `origin` is still its https source. */
async function fetchAllowed(store: string, key: string | undefined): Promise<boolean> {
  try {
    if (await repoConfigUnsafe(store)) return false;
    const r = await git(["config", "--get-all", "remote.origin.url"], { cwd: store, okCodes: [1] });
    const urls = r.stdout
      .toString("utf8")
      .split("\n")
      .filter((u) => u !== "");
    if (urls.length !== 1) return false;
    const src = parseRepositoryUrl(urls[0]);
    return src !== undefined && (key === undefined || sourceKey(src) === key);
  } catch {
    return false;
  }
}

async function readOriginHead(store: string): Promise<string | undefined> {
  try {
    const r = await git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { cwd: store, okCodes: [1, 128] });
    if (r.code !== 0) return undefined;
    const ref = r.stdout.toString("utf8").trim();
    const prefix = "refs/remotes/origin/";
    if (!ref.startsWith(prefix)) return undefined;
    const branch = ref.slice(prefix.length);
    if (branch === "" || branch === "HEAD" || branch.startsWith("-")) return undefined;
    const ok = await git(["check-ref-format", `refs/heads/${branch}`], { cwd: store, okCodes: [1] });
    return ok.code === 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

const locks = new Map<string, Promise<unknown>>();

/** In-process per-store mutex (promise chain). */
export async function withStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}
