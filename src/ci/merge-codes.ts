/**
 * Closed vocabularies of the merge policy and ref events (T15.8; FR-SUB-01, FR-SUB-02, LLD §20.7, migration 0031). No
 * imports, so the notification sinks can share them without a module cycle.
 */

/** `ref_event.kind` (FR-SUB-01 first delivery). */
export const REF_EVENT_KINDS = ["ci_passed", "ci_failed", "foreign_commit", "conflicting", "merged", "closed"] as const;
export type RefEventKind = (typeof REF_EVENT_KINDS)[number];

/** `merge_event.reason` of a refusal: LLD §20.7's list plus `base_mismatch` (Delegated, T15.8) and `no_checks_reported` (ADR-0080 item 7). */
export const MERGE_REFUSAL_REASONS = [
  "head_moved",
  "check_failed",
  "check_pending",
  "no_required_checks",
  "no_checks_reported",
  "not_mergeable",
  "unverified_at_head",
  "report_missing",
  "draft",
  "policy_off",
  "gh_error",
  "base_mismatch",
] as const;
export type MergeRefusalReason = (typeof MERGE_REFUSAL_REASONS)[number];

/**
 * ADR-0080 item 7: refusals of the ordered merge's own steps (`submodule_merge.reason` and `details.reason`), beside
 * {@link MERGE_REFUSAL_REASONS}: `merge_failed` (G12 of a submodule pull request failed; the poller does not retry that
 * head), `store_unavailable` (the repository's store could not be made), `merge_commit_missing` (the merge commit could
 * not be fetched), `merge_commit_off_default_branch`, `gitlink_mismatch` (the published umbrella does not point at the
 * pushed head), `repoint_not_fast_forward`, `repoint_push_failed`, `secret_scan_blocked` and
 * `submodule_merge_unavailable` (the server has no submodule merge inputs).
 */
export const SUBMODULE_MERGE_REFUSAL_REASONS = [
  "merge_failed",
  "store_unavailable",
  "merge_commit_missing",
  "merge_commit_off_default_branch",
  "gitlink_mismatch",
  "repoint_not_fast_forward",
  "repoint_push_failed",
  "secret_scan_blocked",
  "submodule_merge_unavailable",
] as const;
export type SubmoduleMergeRefusalReason = (typeof SUBMODULE_MERGE_REFUSAL_REASONS)[number];

/** ADR-0080 item 7: the phases of the ordered merge (`details.submodule_merge.phase`). */
export const SUBMODULE_MERGE_PHASES = ["submodules", "repoint", "umbrella", "merged"] as const;
export type SubmoduleMergePhase = (typeof SUBMODULE_MERGE_PHASES)[number];

/** ADR-0080 item 7: a linked repository's state (`waiting` until the repositories before it are merged). */
export const SUBMODULE_MERGE_REPO_STATES = ["waiting", "refused", "merged"] as const;
export type SubmoduleMergeRepoState = (typeof SUBMODULE_MERGE_REPO_STATES)[number];

/** ADR-0080 item 7: `ref_event` run-event kinds of the ordered merge (run events only; no `ref_event` row). */
export const SUBMODULE_REF_EVENT_KINDS = ["submodule_merged", "gitlinks_repointed"] as const;

/** Reason codes of a `merge_event` sink event: `merged` or the refusal reason. */
export const MERGE_SINK_REASONS = ["merged", ...MERGE_REFUSAL_REASONS] as const;

/** `run_event` types appended to the publishing run (what `get_digest` reads). */
export const REF_EVENT_TYPE = "ref_event";
export const MERGE_EVENT_TYPE = "merge_event";
