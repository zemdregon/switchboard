/**
 * `CiStatusPort` (T15.3; FR-QUE-03, LLD §18.6, ADR-0050). The trigger depends on this narrow port only: production uses
 * {@link GhCiStatusPort} (`gh-port.ts`), which runs the operator's logged-in `gh` as an external subprocess; tests inject
 * a fake. Observations carry structured facts only (ids, conclusion, ref, SHA), never free text from `gh`.
 */

/** Conclusions a `gh` workflow run may report; anything else is read as not actionable. */
export type CiConclusion = "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral" | "pending";

/** LLD §18.6 trigger step 2: only these conclusions may enqueue fix-up work. */
export const FAILING_CONCLUSIONS: ReadonlySet<CiConclusion> = new Set(["failure", "cancelled", "timed_out"]);

/**
 * T15.6 (FR-QUE-06, LLD §20.1): the class of a terminal conclusion. `CI_INFRA` is a transient host fault, not a code
 * failure: it never enqueues a fix-up by itself and never counts toward the FR-QUE-05 cap. No allowlisted `gh` JSON field
 * reliably marks a runner fault inside a `failure` (Delegated, settled in T15.6), so only `cancelled` and `timed_out`
 * are `CI_INFRA`; every other `failure` stays a code failure.
 */
export type CiConclusionClass = "success" | "failure" | "CI_INFRA" | "other";

export function classifyConclusion(c: CiConclusion): CiConclusionClass {
  if (c === "success") return "success";
  if (c === "failure") return "failure";
  if (c === "cancelled" || c === "timed_out") return "CI_INFRA";
  return "other";
}

/** Job conclusions a rerun may be asked for (the rerun allowlist); any other job conclusion is never rerun. */
export const RERUNNABLE_JOB_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "cancelled", "timed_out"]);

export interface CiStatusObservation {
  /** Stable host id for dedup: the workflow run (or check run) `databaseId`, as a decimal string. */
  readonly externalId: string;
  readonly conclusion: CiConclusion;
  /** The `refs/heads/...` ref that was evaluated; must equal the published ref asked about. */
  readonly publishRef: string;
  /** Commit the conclusion is for (40 hex); audit and staleness check only, never a dedup key. */
  readonly headSha: string;
}

export interface CiStatusQuery {
  readonly owner: string;
  readonly repo: string;
  /** `refs/heads/<branch>`. */
  readonly publishRef: string;
  /** Tip SHA Switchboard published on that ref. */
  readonly headSha: string;
}

export interface CiStatusPort {
  /**
   * Latest terminal CI state for one published ref's tip commit, or null when nothing applies yet (no run, still
   * running, or the latest run is for another commit). Throws {@link CiStatusError}; its message never holds `gh` output.
   */
  latestForPublishedRef(query: CiStatusQuery): Promise<CiStatusObservation | null>;
}

/** One run on the CI host, by id (T15.6). */
export interface CiRunQuery {
  readonly owner: string;
  readonly repo: string;
  /** Workflow run `databaseId`, decimal. */
  readonly runId: string;
}

export interface CiRunJob {
  /** Untrusted text from the workflow file; used only as a dedup key and an audit field. */
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
}

export interface CiQueuedRun {
  readonly runId: string;
  readonly status: string;
  readonly headSha: string;
  readonly headBranch: string;
}

/**
 * The T15.6 write side of the CI host (ADR-0050 amendment 1, items 7 and 8). The trigger calls it only for a project
 * whose `rerun_failed` or `cancel_stale_queued` switch is on. Every method throws {@link CiStatusError}.
 */
export interface CiActionsPort {
  /** The run's current attempt and jobs (G4). */
  runJobs(q: CiRunQuery): Promise<{ attempt: number; jobs: readonly CiRunJob[] }>;
  /** `gh run rerun <id> --failed` (G5). */
  rerunFailed(q: CiRunQuery): Promise<void>;
  /** Queued runs on one branch (G6). */
  queuedRuns(q: { owner: string; repo: string; publishRef: string }): Promise<readonly CiQueuedRun[]>;
  /** Re-read of one run's status and head immediately before a cancel (G7). */
  runHead(q: CiRunQuery): Promise<{ status: string; headSha: string }>;
  /** `gh run cancel <id>` (G8). */
  cancelRun(q: CiRunQuery): Promise<void>;
}

export type CiStatusErrorReason = "AUTH_REQUIRED" | "GH_FAILED" | "GH_MISSING" | "PARSE_FAILED" | "TIMEOUT";

export class CiStatusError extends Error {
  constructor(
    readonly reason: CiStatusErrorReason,
    message: string = reason,
  ) {
    super(message);
    this.name = "CiStatusError";
  }
}
