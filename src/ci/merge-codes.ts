/**
 * Closed vocabularies of the merge policy and ref events (T15.8; FR-SUB-01, FR-SUB-02, LLD §20.7, migration 0030). No
 * imports, so the notification sinks can share them without a module cycle.
 */

/** `ref_event.kind` (FR-SUB-01 first delivery). */
export const REF_EVENT_KINDS = ["ci_passed", "ci_failed", "foreign_commit", "conflicting", "merged", "closed"] as const;
export type RefEventKind = (typeof REF_EVENT_KINDS)[number];

/** `merge_event.reason` of a refusal: LLD §20.7's list plus `base_mismatch` (Delegated, T15.8). */
export const MERGE_REFUSAL_REASONS = [
  "head_moved",
  "check_failed",
  "check_pending",
  "no_required_checks",
  "not_mergeable",
  "unverified_at_head",
  "report_missing",
  "draft",
  "policy_off",
  "gh_error",
  "base_mismatch",
] as const;
export type MergeRefusalReason = (typeof MERGE_REFUSAL_REASONS)[number];

/** Reason codes of a `merge_event` sink event: `merged` or the refusal reason. */
export const MERGE_SINK_REASONS = ["merged", ...MERGE_REFUSAL_REASONS] as const;

/** `run_event` types appended to the publishing run (what `get_digest` reads). */
export const REF_EVENT_TYPE = "ref_event";
export const MERGE_EVENT_TYPE = "merge_event";
