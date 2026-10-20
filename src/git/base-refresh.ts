import type Database from "better-sqlite3";
import { BASE_REFRESH_EVENT, hasBaseRefreshFetch, insertChainedRunEvent } from "../ledger/index.js";
import { git, gitText } from "../workspace/git.js";
import { classifyRemoteUrl, type GitPushRun, pushEnv, repoConfigUnsafe, runGitPush } from "./push.js";
import { isRemoteName } from "./push-names.js";

/**
 * Controller-side base refresh (FR-PRJ-02 note, LLD §5.2, ADR-0067). A repository's local base branch (`main`) is never
 * updated by Switchboard, so without this every first run of a meta-session starts from whatever the operator last
 * pulled, however far the remote has moved. When the project's primary context sets `base_remote`, the daemon (never
 * the agent, FR-GIT-01) fetches `refs/heads/<base>` from that remote into the remote-tracking ref
 * `refs/remotes/<remote>/<base>` before the worktree is created, and the run starts from that commit when it
 * fast-forwards the local branch.
 *
 * - **Only the remote-tracking ref is written** (Delegated): the local branch, the operator's checkout and every other
 *   ref are left alone (FR-WS-05). The refspec is not forced, so a remote that rewound or rewrote the branch is a
 *   failed fetch, not a moved ref.
 * - **Only when no other run of the repository holds a write lease** (Delegated): a run already past its LEASED
 *   snapshot would otherwise see the tracking ref move. The refresh runs under the per-repository worktree
 *   serialisation, so no other run of the repository can create its worktree (or snapshot after one) meanwhile.
 * - **Recorded**: one `base_refresh` run event per attempt (remote name, ref names, SHAs and a reason code; never a URL
 *   or Git's output). The ref guard (`src/git/ref-guard.ts`) accepts a tracking-ref move to exactly the SHA the newest
 *   `fetched` event here recorded for the same repository; any other value stays a violation (fail closed).
 * - **A tracking ref is trusted only when this controller recorded fetching it**: after a skipped or failed fetch, the
 *   current tracking ref is used only if the newest recorded `fetched` event for this repository names that SHA, so a value an
 *   agent wrote never becomes a later run's base.
 * - **Degrade, never fail**: any problem records its reason and the run starts from the configured `base_ref` as
 *   before. The fetch itself is hardened like the push (ADR-0028): the operator's own configuration (for the SSH agent
 *   or credential helper), an allowlisted environment, no prompts, its own session, a timeout, hooks off, only the
 *   `https`, `ssh` and `file` transports, and the same refusal of unsafe repository configuration and of URLs that
 *   carry credentials.
 */

export { BASE_REFRESH_EVENT };
export const DEFAULT_BASE_REFRESH_TIMEOUT_MS = 60_000;

export type BaseRefreshOutcome = "fetched" | "skipped" | "failed";

/** Fixed reason vocabulary of a `base_refresh` event. */
export type BaseRefreshReason =
  | "ADVANCED"
  | "CURRENT"
  | "LOCAL_AHEAD"
  | "REPO_BUSY"
  | "BASE_NOT_BRANCH"
  | "REMOTE_INVALID"
  | "REMOTE_UNKNOWN"
  | "REPO_CONFIG_UNSAFE"
  | "REMOTE_URL_CREDENTIALS"
  | "REMOTE_TRANSPORT_NOT_ALLOWED"
  | "FETCH_TIMEOUT"
  | "FETCH_FAILED"
  | "GIT_FAILED";

/** Command-scope configuration of the fetch (overrides every configuration file). */
export const FETCH_CONFIG: readonly string[] = [
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
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "protocol.file.allow=always",
];

/** argv of the fetch (after `git`): one non-forced refspec into the remote-tracking ref, nothing else. */
export function fetchArgs(remote: string, branch: string): string[] {
  if (!isRemoteName(remote)) throw new Error("invalid remote name");
  if (branch.startsWith("-") || branch.startsWith("+") || branch.includes(":")) throw new Error("invalid branch");
  return [
    ...FETCH_CONFIG,
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-prune",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "--",
    remote,
    `refs/heads/${branch}:${trackingRefOf(remote, branch)}`,
  ];
}

export function trackingRefOf(remote: string, branch: string): string {
  return `refs/remotes/${remote}/${branch}`;
}

export interface BaseRefreshInput {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly repoRoot: string;
  /** The project's `base_ref`. Only a local branch name (`main` or `refs/heads/main`) is refreshed. */
  readonly baseRef: string;
  readonly remote: string;
}

export interface BaseRefreshResult {
  readonly outcome: BaseRefreshOutcome;
  readonly reason: BaseRefreshReason;
  /** The commit the run starts from instead of `baseRef`, or undefined to keep `baseRef`. */
  readonly baseCommit?: string;
}

export interface BaseRefreshOptions {
  /** Source of the allowlisted fetch environment (default `process.env`). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly ids: { id(prefix: string): string };
  /** Test seam: runs the fetch (default {@link runGitPush} with the fetch environment). */
  readonly runFetch?: (cwd: string, args: readonly string[]) => Promise<GitPushRun>;
}

/**
 * Refresh the base of a run's first worktree and record one `base_refresh` event. Never throws for a Git or remote
 * problem; the caller (the workspace manager, under the per-repository worktree serialisation) uses `baseCommit` when
 * set and `baseRef` otherwise.
 */
export async function refreshBase(
  db: Database.Database,
  input: BaseRefreshInput,
  options: BaseRefreshOptions,
): Promise<BaseRefreshResult> {
  const branch = input.baseRef.startsWith("refs/heads/") ? input.baseRef.slice("refs/heads/".length) : input.baseRef;
  const tracking = isRemoteName(input.remote) ? trackingRefOf(input.remote, branch) : null;
  const facts: { local: string | null; before: string | null; after: string | null } = {
    local: null,
    before: null,
    after: null,
  };
  const record = (r: BaseRefreshResult): BaseRefreshResult => {
    insertChainedRunEvent(db, {
      id: options.ids.id("evt"),
      runId: input.runId,
      ts: (options.now?.() ?? new Date()).toISOString(),
      type: BASE_REFRESH_EVENT,
      payloadJson: JSON.stringify({
        v: 1,
        outcome: r.outcome,
        reason: r.reason,
        repo_root: input.repoRoot,
        remote: tracking !== null ? input.remote : null,
        branch: `refs/heads/${branch}`,
        tracking_ref: tracking,
        local_sha: facts.local,
        tracking_before: facts.before,
        tracking_after: facts.after,
        base_commit: r.baseCommit ?? null,
      }),
    });
    return r;
  };
  const skip = (reason: BaseRefreshReason, outcome: BaseRefreshOutcome = "skipped") =>
    record({ outcome, reason, ...trusted() });
  // After a skipped or failed fetch: the tracking ref only if this controller recorded fetching exactly that SHA.
  let trustedBase: string | undefined;
  const trusted = () => (trustedBase !== undefined ? { baseCommit: trustedBase } : {});

  try {
    if (tracking === null) return skip("REMOTE_INVALID");
    if (!(await isLocalBranch(input.repoRoot, branch))) return skip("BASE_NOT_BRANCH");
    facts.local = await resolve(input.repoRoot, `refs/heads/${branch}`);
    facts.before = await resolve(input.repoRoot, tracking);
    if (facts.local === null) return skip("BASE_NOT_BRANCH");
    if (facts.before !== null && hasBaseRefreshFetch(db, input.repoRoot, tracking, facts.before)) {
      trustedBase = (await fastForwards(input.repoRoot, facts.local, facts.before)) ? facts.before : undefined;
    }
    if (otherLeaseOnRepo(db, input.repoRoot, input.runId)) return skip("REPO_BUSY");
    const remotes = (await gitText(["remote"], { cwd: input.repoRoot })).split("\n").filter((r) => r !== "");
    if (!remotes.includes(input.remote)) return skip("REMOTE_UNKNOWN");
    if (await repoConfigUnsafe(input.repoRoot)) return skip("REPO_CONFIG_UNSAFE");
    const urls = (await gitText(["remote", "get-url", "--all", input.remote], { cwd: input.repoRoot }))
      .split("\n")
      .filter((u) => u !== "");
    if (urls.length === 0) return skip("REMOTE_UNKNOWN");
    for (const u of urls) {
      const cls = classifyRemoteUrl(u);
      if (cls === "credentials") return skip("REMOTE_URL_CREDENTIALS");
      if (cls === "transport") return skip("REMOTE_TRANSPORT_NOT_ALLOWED");
    }

    const args = fetchArgs(input.remote, branch);
    const run = await (options.runFetch
      ? options.runFetch(input.repoRoot, args)
      : runGitPush(
          input.repoRoot,
          args,
          pushEnv(options.sourceEnv ?? process.env),
          options.timeoutMs ?? DEFAULT_BASE_REFRESH_TIMEOUT_MS,
        ));
    facts.after = await resolve(input.repoRoot, tracking);
    if (run.timedOut) return skip("FETCH_TIMEOUT", "failed");
    if (run.spawnError || run.code !== 0 || facts.after === null) return skip("FETCH_FAILED", "failed");

    // Recorded with outcome `fetched` whatever the comparison says: the ref guard accepts exactly this SHA.
    if (facts.after === facts.local) return record({ outcome: "fetched", reason: "CURRENT" });
    if (await fastForwards(input.repoRoot, facts.local, facts.after)) {
      return record({ outcome: "fetched", reason: "ADVANCED", baseCommit: facts.after });
    }
    return record({ outcome: "fetched", reason: "LOCAL_AHEAD" });
  } catch {
    return skip("GIT_FAILED", "failed");
  }
}

function otherLeaseOnRepo(db: Database.Database, repoRoot: string, runId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM meta_session WHERE repo_root = ? AND lease_run_id IS NOT NULL AND lease_run_id <> ?")
      .get(repoRoot, runId) !== undefined
  );
}

async function isLocalBranch(repoRoot: string, branch: string): Promise<boolean> {
  if (branch === "" || branch.startsWith("-") || /^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(branch)) return false;
  const r = await git(["check-ref-format", `refs/heads/${branch}`], { cwd: repoRoot, okCodes: [1] });
  return r.code === 0;
}

async function resolve(repoRoot: string, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "-q", "--verify", "--end-of-options", `${ref}^{commit}`], {
    cwd: repoRoot,
    okCodes: [1, 128],
  });
  return r.code === 0 ? r.stdout.toString("utf8").trim() || null : null;
}

async function fastForwards(repoRoot: string, from: string, to: string): Promise<boolean> {
  if (from === to) return true;
  const r = await git(["merge-base", "--is-ancestor", from, to], { cwd: repoRoot, okCodes: [1] });
  return r.code === 0;
}
