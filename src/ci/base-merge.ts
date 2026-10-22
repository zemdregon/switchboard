/**
 * Pure base merges (ADR-0073; FR-SUB-02, LLD §20.7.1). GitHub's "Update branch" button (and MCP `update_run_branch`)
 * adds a "Merge branch '<base>' into <branch>" commit on top of the tip Switchboard published, so the pull request's
 * head is no longer that tip. The merge gate accepts such a head when it is a chain of one to
 * {@link MAX_BASE_MERGE_CHAIN} pure base merges on the published tip, verified here by the controller with local Git:
 *
 * - every commit of the chain has exactly two parents; its first parent is the published tip or the previous commit of
 *   the chain;
 * - its second parent is reachable from the base branch head on the remote, fetched now;
 * - its tree equals the tree of a clean merge of its two parents computed locally (`git merge-tree --write-tree`, no
 *   conflicts), so it adds base content only.
 *
 * Anything else (another file change, a conflict resolution, a non-merge commit, an octopus merge, a second parent not
 * on base, a longer chain) is `foreign` (`head_moved` at the gate).
 *
 * The only write is one fetch into the project's repository, of `refs/pull/<n>/head` and `refs/heads/<base>` from the
 * published ref's remote into the controller-owned namespace {@link MERGE_GATE_REF_PREFIX} (forced refspecs, no
 * opportunistic remote-tracking update, no `FETCH_HEAD`, no tags), never into an agent worktree or the operator's
 * branches. The ref guard ignores that namespace, and the SHAs used are the ones the fetch itself printed
 * (`--porcelain`), never a later read of those refs. The fetch is hardened like the base refresh (ADR-0067, ADR-0028):
 * allowlisted environment, its own session, a timeout, hooks off, the `https`, `ssh` and `file` transports only, and
 * the same refusal of unsafe repository configuration and of URLs that carry credentials. Every other step is a
 * read-only command through the hardened `git` helper.
 */
import { FETCH_CONFIG } from "../git/base-refresh.js";
import { classifyRemoteUrl, type GitPushRun, pushEnv, repoConfigUnsafe, runGitPush } from "../git/push.js";
import { isRemoteName } from "../git/push-names.js";
import { MERGE_GATE_REF_PREFIX } from "../git/ref-guard.js";
import { git, gitText, parseGitVersion, versionAtLeast } from "../workspace/git.js";
import { isFullLowerSha, isSafeBranch } from "./gh-argv.js";

export { MERGE_GATE_REF_PREFIX };
/** Most pure base merges accepted on top of the published tip (Delegated, ADR-0073). */
export const MAX_BASE_MERGE_CHAIN = 10;
export const DEFAULT_PULL_FETCH_TIMEOUT_MS = 60_000;
/** `git fetch --porcelain` (2.41) and `git merge-tree --write-tree` (2.38). */
export const MIN_BASE_MERGE_GIT_VERSION = [2, 41, 0] as const;

/** How the gate accepted a pull request's head (`merge_event.head_kind`, migration 0035). */
export type HeadKind = "published" | "base_merge";

export interface PullHeadQuery {
  readonly projectId: string;
  /** The published ref's remote. */
  readonly remote: string;
  readonly prNumber: number;
  /** The pull request's base branch (no `refs/heads/`). */
  readonly baseBranch: string;
  /** The tip Switchboard published. */
  readonly publishedSha: string;
  /** The pull request's head as `gh` reported it. */
  readonly prHeadSha: string;
}

export type PullHeadInspection =
  /** The fetch failed or timed out, or Git failed: a read failure, retried like `gh_error`. */
  | { readonly kind: "error" }
  | {
      readonly kind: "read";
      /** `foreign` also when the fetched head is not `prHeadSha` or the repository cannot be checked safely. */
      readonly head: HeadKind | "foreign";
      /** The base branch head is an ancestor of the pull request's head (nothing to update). */
      readonly upToDate: boolean;
      /** Merging the base head into the pull request's head conflicts (only computed when not up to date). */
      readonly conflicts: boolean;
    };

/** The controller's read of a pull request's head and base (the gate and `update_run_branch`). Never throws. */
export interface PullHeadPort {
  inspect(q: PullHeadQuery): Promise<PullHeadInspection>;
}

/** The local refs one pull request's fetch writes, under {@link MERGE_GATE_REF_PREFIX}. */
export function mergeGateRefs(remote: string, prNumber: number): { head: string; base: string } {
  const dir = `${MERGE_GATE_REF_PREFIX}${remote}/pr-${prNumber}`;
  return { head: `${dir}/head`, base: `${dir}/base` };
}

/** argv of the fetch (after `git`): the pull request's head and the base branch into the controller namespace only. */
export function pullFetchArgs(remote: string, prNumber: number, baseBranch: string): string[] {
  if (!isRemoteName(remote)) throw new Error("invalid remote name");
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error("invalid pull request number");
  if (!isSafeBranch(baseBranch)) throw new Error("invalid branch");
  const refs = mergeGateRefs(remote, prNumber);
  return [
    ...FETCH_CONFIG,
    "fetch",
    "--porcelain",
    "--verbose",
    "--no-tags",
    "--no-prune",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    // No opportunistic `refs/remotes/<remote>/<base>` update: only the two refspecs below are written.
    "--refmap=",
    "--",
    remote,
    `+refs/pull/${prNumber}/head:${refs.head}`,
    `+refs/heads/${baseBranch}:${refs.base}`,
  ];
}

/** The new SHA `git fetch --porcelain` printed for `localRef`; undefined when it was rejected or not listed. */
export function fetchedSha(stdout: string, localRef: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const flag = line.charAt(0);
    const [, next, ref] = line.slice(2).split(" ");
    if (ref !== localRef || flag === "!" || flag === "-" || next === undefined) continue;
    return isFullLowerSha(next) ? next : undefined;
  }
  return undefined;
}

/** Repository configuration that would make `git merge-tree` run a program: a custom merge driver. */
async function hasMergeDriver(repo: string): Promise<boolean> {
  const r = await git(["config", "--name-only", "--get-regexp", String.raw`^merge\..*\.driver$`], {
    cwd: repo,
    okCodes: [1],
  });
  return r.code === 0 && r.stdout.toString("utf8").trim() !== "";
}

async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  const r = await git(["merge-base", "--is-ancestor", a, b], { cwd: repo, okCodes: [1] });
  return r.code === 0;
}

/** The tree of a clean merge of `a` and `b`, or undefined when it conflicts. */
async function cleanMergeTree(repo: string, a: string, b: string): Promise<string | undefined> {
  const r = await git(["merge-tree", "--write-tree", "--no-messages", a, b], { cwd: repo, okCodes: [1] });
  if (r.code !== 0) return undefined;
  const tree = r.stdout.toString("utf8").split("\n")[0]?.trim() ?? "";
  return isFullLowerSha(tree) ? tree : undefined;
}

/**
 * Whether `head` is `published` itself, a chain of pure base merges on it ({@link MAX_BASE_MERGE_CHAIN} at most)
 * against `baseHead`, or anything else. Read-only; every SHA must be present in `repo`. Throws on a Git failure.
 */
export async function classifyPullHead(
  repo: string,
  publishedSha: string,
  headSha: string,
  baseHead: string,
): Promise<HeadKind | "foreign"> {
  if (headSha === publishedSha) return "published";
  let c = headSha;
  for (let i = 0; i < MAX_BASE_MERGE_CHAIN; i++) {
    const parents = (await gitText(["rev-list", "--parents", "-n", "1", c], { cwd: repo })).split(" ").slice(1);
    if (parents.length !== 2) return "foreign";
    const [first, second] = parents as [string, string];
    if (!(await isAncestor(repo, second, baseHead))) return "foreign";
    const merged = await cleanMergeTree(repo, first, second);
    if (merged === undefined || merged !== (await gitText(["rev-parse", `${c}^{tree}`], { cwd: repo }))) {
      return "foreign";
    }
    if (first === publishedSha) return "base_merge";
    c = first;
  }
  return "foreign";
}

export interface GitPullHeadPortOptions {
  /** The project's repository (its primary context's path); undefined for an unknown project. */
  readonly repoOf: (projectId: string) => string | undefined;
  /** Source of the allowlisted fetch environment (default `process.env`). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** Test seam: runs the fetch (default {@link runGitPush} with the fetch environment). */
  readonly runFetch?: (cwd: string, args: readonly string[]) => Promise<GitPushRun>;
}

/** Production {@link PullHeadPort}: one hardened fetch, then read-only Git in the project's repository. */
export class GitPullHeadPort implements PullHeadPort {
  private versionOk: Promise<boolean> | undefined;

  constructor(private readonly options: GitPullHeadPortOptions) {}

  async inspect(q: PullHeadQuery): Promise<PullHeadInspection> {
    const foreign: PullHeadInspection = { kind: "read", head: "foreign", upToDate: false, conflicts: false };
    try {
      const repo = this.options.repoOf(q.projectId);
      if (
        repo === undefined ||
        !isRemoteName(q.remote) ||
        !isSafeBranch(q.baseBranch) ||
        !isFullLowerSha(q.publishedSha) ||
        !isFullLowerSha(q.prHeadSha)
      ) {
        return foreign;
      }
      // Conditions that would not change on a retry fail closed as `foreign`, not as a read failure.
      if (!(await this.gitVersionOk())) return foreign;
      if ((await repoConfigUnsafe(repo)) || (await hasMergeDriver(repo))) return foreign;
      const urls = (await gitText(["remote", "get-url", "--all", q.remote], { cwd: repo }))
        .split("\n")
        .filter((u) => u !== "");
      if (urls.length === 0 || urls.some((u) => classifyRemoteUrl(u) !== "ok")) return foreign;

      const args = pullFetchArgs(q.remote, q.prNumber, q.baseBranch);
      const run = await (this.options.runFetch
        ? this.options.runFetch(repo, args)
        : runGitPush(
            repo,
            args,
            pushEnv(this.options.sourceEnv ?? process.env),
            this.options.timeoutMs ?? DEFAULT_PULL_FETCH_TIMEOUT_MS,
          ));
      if (run.timedOut || run.spawnError || run.code !== 0) return { kind: "error" };
      const refs = mergeGateRefs(q.remote, q.prNumber);
      const head = fetchedSha(run.stdout, refs.head);
      const base = fetchedSha(run.stdout, refs.base);
      if (head === undefined || base === undefined) return { kind: "error" };
      // The head moved between the `gh` read and the fetch: the next read decides.
      if (head !== q.prHeadSha) return foreign;
      const kind = await classifyPullHead(repo, q.publishedSha, head, base);
      const upToDate = await isAncestor(repo, base, head);
      const conflicts = upToDate ? false : (await cleanMergeTree(repo, head, base)) === undefined;
      return { kind: "read", head: kind, upToDate, conflicts };
    } catch {
      return { kind: "error" };
    }
  }

  private gitVersionOk(): Promise<boolean> {
    this.versionOk ??= gitText(["--version"])
      .then((out) => {
        const v = parseGitVersion(out);
        return v !== undefined && versionAtLeast(v, MIN_BASE_MERGE_GIT_VERSION);
      })
      .catch(() => false);
    return this.versionOk;
  }
}
