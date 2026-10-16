/**
 * `CiStatusPort` (T15.3; FR-QUE-03, LLD §18.6, ADR-0050). The trigger depends on this narrow port only: production uses
 * {@link GhCiStatusPort} (`gh-port.ts`), which runs the operator's logged-in `gh` as an external subprocess; tests inject
 * a fake. Observations carry structured facts only (ids, conclusion, ref, SHA), never free text from `gh`.
 */

/** Conclusions a `gh` workflow run may report; anything else is read as not actionable. */
export type CiConclusion = "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral" | "pending";

/** LLD §18.6 trigger step 2: only these conclusions may enqueue fix-up work. */
export const FAILING_CONCLUSIONS: ReadonlySet<CiConclusion> = new Set(["failure", "cancelled", "timed_out"]);

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
