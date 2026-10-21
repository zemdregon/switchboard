/**
 * MCP `refresh_project_base` and `rebase_session` (ADR-0074; LLD §3.4.15, §5.2.1). Both act on the client's own
 * projects and meta-sessions only (resolved and scoped by the server exactly as `search_project_context` and
 * `continue_task` are), and only on a **remote-backed** project: one whose primary context has an effective base remote
 * (a configured `base_remote`, or ADR-0074's default for a `clone_url` context). Every fetch is the ADR-0067 hardened
 * fetch (`refreshBase`) under the per-repository worktree serialisation; nothing runs in an agent's environment.
 *
 * `refresh_project_base` records its `base_refresh` event on the client's newest run of the project in that
 * repository; with none, nothing is recorded and the fetched value is not trusted by a later failed refresh
 * (**Delegated**, fail closed: a run event needs a run, and no new table is added for this).
 */
import { realpath } from "node:fs/promises";
import type Database from "better-sqlite3";
import { primaryContext, type ResolvedContext, type ResolvedProject, submodulesEnabled } from "../config/index.js";
import {
  type BaseRefreshOptions,
  type BaseRefreshReason,
  rebaseSession,
  refreshBase,
  SessionRebaseError,
  type SessionRebaseRefusal,
} from "../git/index.js";
import { SubmoduleError } from "../submodules/errors.js";
import { gitText } from "../workspace/git.js";
import { serialisedWorktreeCreate } from "../workspace/manager.js";
import {
  planManifest,
  presenceOf,
  readyStores,
  type SubmoduleDeps,
  type SubmodulePlan,
  type SubmodulePresence,
} from "../workspace/submodules.js";
import { invalid, ToolError } from "./errors.js";

/** What `serve` wires: the ledger handle, ids and the fetch environment of the controller's own push (ADR-0028). */
export interface BaseToolDeps {
  readonly db: Database.Database;
  readonly ids: { id(prefix: string): string };
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  /** Test seam of {@link refreshBase}. */
  readonly runFetch?: BaseRefreshOptions["runFetch"];
  /**
   * ADR-0087 item 3: the submodule stores of a recursive context (live `project_sources`, store runner). Absent: a
   * recursive context's sources are empty, so every submodule URL is refused.
   */
  readonly submodules?: SubmoduleDeps;
}

export interface RefreshProjectBaseResult {
  project_id: string;
  base_ref: string;
  remote: string;
  base_commit: string;
  previous_commit: string | null;
  remote_commit: string;
  reason: BaseRefreshReason;
  /** ADR-0087 item 3: only for a recursive context; distinct gitlink commits of `base_commit` and their presence. */
  submodules?: SubmodulePresence;
}

export interface RebaseSessionResult {
  session_id: string;
  previous_head: string;
  new_head: string;
  base_commit: string;
  rebased_commits: number;
  publish?: { previous_tip: string; new_tip: string };
}

/** Fetch outcomes worth retrying as is (the repository is busy, or the network failed). */
const RETRYABLE_FETCH: ReadonlySet<string> = new Set(["REPO_BUSY", "FETCH_TIMEOUT", "FETCH_FAILED"]);

/** The project's primary context and base remote, or `NOT_REMOTE_BACKED`. */
function remoteBacked(project: ResolvedProject) {
  const ctx = primaryContext(project);
  if (ctx.baseRemote === undefined) {
    throw invalid(
      `project ${project.id} is not remote-backed (no clone_url and no base_remote on its primary context)`,
      { reason: "NOT_REMOTE_BACKED", project: project.id },
    );
  }
  return { ctx, remote: ctx.baseRemote };
}

async function repoRootOf(contextPath: string): Promise<string> {
  try {
    return await realpath(await gitText(["rev-parse", "--show-toplevel"], { cwd: await realpath(contextPath) }));
  } catch {
    throw new ToolError("TOOL_FAILURE", "the project's repository could not be read", { reason: "GIT_FAILED" });
  }
}

/** ADR-0087 item 3: the context's submodule plan, or undefined unless it sets `submodules.mode: "recursive"`. */
function submodulePlan(ctx: ResolvedContext): SubmodulePlan | undefined {
  if (!submodulesEnabled(ctx) || ctx.submodules === undefined) return undefined;
  return {
    writablePaths: ctx.submodules.writablePaths,
    exclude: ctx.submodules.exclude,
    ...(ctx.baseRemote !== undefined ? { baseRemote: ctx.baseRemote } : {}),
  };
}

const submoduleDeps = (deps: BaseToolDeps): SubmoduleDeps => deps.submodules ?? { sources: () => undefined };

/**
 * ADR-0087 item 3: make every gitlink commit of `commits` present in its store (bounded parallel; only missing commits
 * are fetched) and count them. Never fails for a missing commit; a manifest refusal is a ToolError with the library's
 * reason and path (never the URL), after the umbrella refresh already happened.
 */
export async function ensureSubmoduleCommits(
  deps: BaseToolDeps,
  repoRoot: string,
  commits: readonly string[],
  plan: SubmodulePlan,
): Promise<SubmodulePresence> {
  const sub = submoduleDeps(deps);
  const shasByKey = new Map<string, string[]>();
  let manifest: Awaited<ReturnType<typeof planManifest>> | undefined;
  const entries = new Map<string, Awaited<ReturnType<typeof planManifest>>["entries"][number]>();
  try {
    for (const commit of [...new Set(commits)]) {
      const m = await planManifest(repoRoot, commit, plan, sub);
      manifest ??= m;
      for (const e of m.entries) {
        if (!entries.has(e.key)) entries.set(e.key, e);
        const list = shasByKey.get(e.key) ?? [];
        if (!list.includes(e.sha)) list.push(e.sha);
        shasByKey.set(e.key, list);
      }
    }
  } catch (err) {
    if (!(err instanceof SubmoduleError)) throw err;
    throw new ToolError(err.code, `the submodule manifest of the base was refused: ${err.message}`, {
      reason: err.reason,
      ...(err.path !== undefined ? { path: err.path } : {}),
    });
  }
  if (manifest === undefined) return { total: 0, present: 0, fetched: 0, missing: 0 };
  // One manifest whose keys cover every commit read (the first entry of each key names its source).
  const all = [...entries.values()];
  const byKey = new Map(all.map((e) => [e.key, [e]]));
  return presenceOf(await readyStores({ ...manifest, entries: all, byKey }, sub, shasByKey));
}

function options(deps: BaseToolDeps): BaseRefreshOptions {
  return {
    ids: deps.ids,
    sourceEnv: deps.sourceEnv,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.runFetch !== undefined ? { runFetch: deps.runFetch } : {}),
  };
}

/**
 * `refresh_project_base`: fetch now. `anchorRun` picks the run the event is recorded on (the client's newest run of
 * the project in this repository that the caller may see), or undefined.
 */
export async function refreshProjectBase(
  deps: BaseToolDeps,
  project: ResolvedProject,
  anchorRun: (repoRoot: string) => string | undefined,
): Promise<RefreshProjectBaseResult> {
  const { ctx, remote } = remoteBacked(project);
  const repoRoot = await repoRootOf(ctx.path);
  const runId = anchorRun(repoRoot);
  const r = await serialisedWorktreeCreate(repoRoot, () =>
    refreshBase(
      deps.db,
      { ...(runId !== undefined ? { runId } : {}), metaSessionId: "", repoRoot, baseRef: ctx.baseRef, remote },
      options(deps),
    ),
  );
  const start = r.baseCommit ?? r.facts?.localSha ?? null;
  const fetchedTip = r.facts?.trackingAfter ?? null;
  if (r.outcome !== "fetched" || start === null || fetchedTip === null) {
    const te = new ToolError("TOOL_FAILURE", `the base of project ${project.id} could not be fetched (${r.reason})`, {
      reason: "BASE_REFRESH_FAILED",
      fetch_reason: r.reason,
      project: project.id,
    });
    if (RETRYABLE_FETCH.has(r.reason)) te.retryable = true;
    throw te;
  }
  // ADR-0087 item 3: the stores are warmed after the refresh, which a missing commit never undoes.
  const plan = submodulePlan(ctx);
  const submodules = plan !== undefined ? await ensureSubmoduleCommits(deps, repoRoot, [start], plan) : undefined;
  return {
    project_id: project.id,
    base_ref: ctx.baseRef,
    remote,
    base_commit: start,
    previous_commit: r.facts?.trackingBefore ?? null,
    remote_commit: fetchedTip,
    reason: r.reason,
    ...(submodules !== undefined ? { submodules } : {}),
  };
}

const INVALID_REASONS: ReadonlySet<SessionRebaseRefusal> = new Set([
  "NOTHING_TO_REBASE",
  "ACTIVE_RUN",
  "HEAD_MOVED",
  "MERGE_COMMIT",
  "TOO_MANY_COMMITS",
  "CONFLICT",
]);
const BLOCKED_REASONS: ReadonlySet<SessionRebaseRefusal> = new Set([
  "REPO_CONFIG_UNSAFE",
  "PUBLISH_HISTORY_UNVERIFIED",
  "IDENTITY_REQUIRED",
  "SIGNING_UNAVAILABLE",
]);
const RETRYABLE_REASONS: ReadonlySet<SessionRebaseRefusal> = new Set(["REPO_BUSY", "PUBLISH_REF_MOVED"]);

/** `rebase_session` for a meta-session the server has already checked is this client's, in `project`. */
export async function rebaseSessionTool(
  deps: BaseToolDeps,
  session: { readonly id: string; readonly repoRoot: string | null },
  project: ResolvedProject,
  expectedHeadSha: string | undefined,
): Promise<RebaseSessionResult> {
  const { ctx, remote } = remoteBacked(project);
  const plan = submodulePlan(ctx);
  if (session.repoRoot === null) {
    throw invalid(`meta-session ${session.id} has no recorded repository yet`, { reason: "NOTHING_TO_REBASE" });
  }
  const repoRoot = await repoRootOf(ctx.path);
  const sessionRoot = await realpath(session.repoRoot).catch(() => session.repoRoot);
  if (sessionRoot !== repoRoot) {
    throw invalid(`meta-session ${session.id} is not in the repository of project ${project.id}`, {
      reason: "NOT_REMOTE_BACKED",
    });
  }
  try {
    const r = await rebaseSession(
      deps.db,
      {
        metaSessionId: session.id,
        ...(expectedHeadSha !== undefined ? { expectedHeadSha } : {}),
        baseRef: ctx.baseRef,
        remote,
        ...(ctx.identity !== undefined ? { identity: ctx.identity } : {}),
        sign: ctx.sign,
        ...(plan !== undefined ? { submodules: true } : {}),
      },
      { ...options(deps), serialise: serialisedWorktreeCreate },
    );
    // ADR-0087 item 3: the new base's (and the rebased head's) gitlinks are made present in their stores, best effort:
    // the rebase is already recorded, and the next run's worktree re-points its attached submodules from its record.
    if (plan !== undefined && r.newHead !== r.previousHead) {
      await ensureSubmoduleCommits(deps, repoRoot, [r.baseCommit, r.newHead], plan).catch(() => undefined);
    }
    return {
      session_id: session.id,
      previous_head: r.previousHead,
      new_head: r.newHead,
      base_commit: r.baseCommit,
      rebased_commits: r.rebasedCommits,
      ...(r.publish !== undefined
        ? { publish: { previous_tip: r.publish.previousTip, new_tip: r.publish.newTip } }
        : {}),
    };
  } catch (err) {
    if (!(err instanceof SessionRebaseError)) throw err;
    const details = {
      reason: err.reason,
      ...(err.extra.conflictingPaths !== undefined ? { conflicting_paths: [...err.extra.conflictingPaths] } : {}),
      ...(err.extra.fetchReason !== undefined ? { fetch_reason: err.extra.fetchReason } : {}),
      ...(err.extra.runId !== undefined ? { run_id: err.extra.runId } : {}),
    };
    if (INVALID_REASONS.has(err.reason)) throw invalid(err.message, details);
    const te = new ToolError(
      BLOCKED_REASONS.has(err.reason) ? "PERMISSION_BLOCKED" : "TOOL_FAILURE",
      err.message,
      details,
    );
    if (
      RETRYABLE_REASONS.has(err.reason) ||
      (err.reason === "BASE_REFRESH_FAILED" && RETRYABLE_FETCH.has(err.extra.fetchReason ?? ""))
    ) {
      te.retryable = true;
    }
    throw te;
  }
}
