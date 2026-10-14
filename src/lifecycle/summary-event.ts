/**
 * The `log_summary` run event: the record of a verification-output summary that the envelope displays (T11.9; FR-INN-13,
 * LLD §13.6 `log_summary`, §13.8). It lives here, not under `src/inner/`, so the envelope builder (which the import-boundary
 * test keeps from importing the inner-agent service) can read it by type and constant alone.
 *
 * The event is DISPLAY-ONLY. Statuses, exit codes and counts in the envelope come from the run row and the `verification`
 * summaries of the terminal transition; nothing in this payload is read back into any of them. The visible `label` is
 * derived from `source` by {@link summaryLabel}, never taken from the payload, so no text can forge a label.
 */

/** `run_event` type written by the verification-summary entry point (`src/inner/log-summary.ts`). */
export const LOG_SUMMARY_EVENT = "log_summary";

/** Who produced the text: the inner agent (`inner`) or the deterministic head and tail excerpt (`heuristic`). */
export type LogSummarySource = "inner" | "heuristic";

/** Bounded payload of a `log_summary` event (no prompt, no raw output beyond the capped excerpt). */
export interface LogSummaryEventPayload {
  source: LogSummarySource;
  /** The summary prose (`inner`) or the head and tail excerpt with counts (`heuristic`). */
  text: string;
  /** Up to five short notes (`inner` only). */
  notable?: string[];
  /** The `test_report` artifact the text condenses, by ID and SHA-256. */
  raw_artifact_id: string;
  raw_sha256: string;
  /** The stored `log_summary` artifact. */
  summary_artifact_id?: string;
  /** The `inner_call` row of an `inner` summary (or of the call that fell back). */
  inner_call_id?: string;
  template_version?: string;
  model_id?: string;
}

/** The visible label of a summary (LLD §13.6: "a visible source label so a reader can tell inner prose from facts"). */
export function summaryLabel(source: LogSummarySource): string {
  return source === "inner"
    ? "inner-agent generated summary; may be inaccurate; statuses, exit codes and counts are controller records, see the raw artifact"
    : "heuristic head and tail excerpt of the raw output (no model); statuses, exit codes and counts are controller records";
}
