/**
 * Open-work derivation (T5.3; LLD §15.3, ADR-0038 item 4; FR-SES-02). PURE: no I/O, no clock, no ledger import. The
 * controller's open work is never stored as input; this function derives it from terminal-run records, and
 * `meta_session.open_work_json` is a current-state projection of its result (rewritten when a run becomes terminal).
 *
 * The item kinds are a closed list (`OPEN_WORK_KINDS`). `detail` holds controller values only (a failure code, a count, a
 * run id) plus, for `verification_not_passing`, the argv the orchestrator supplied. No provider text is read or produced.
 */

/** The closed vocabulary of LLD §15.3, in output order. */
export const OPEN_WORK_KINDS = [
  "last_run_failed",
  "last_run_cancelled",
  "verification_not_passing",
  "instruction_not_completed",
  "nested_repositories_skipped",
  "git_policy_violation",
] as const;
export type OpenWorkKind = (typeof OPEN_WORK_KINDS)[number];

/** LLD §15.1 bound for `open_work` (a constant, an Assumption of T5.1). */
export const OPEN_WORK_MAX_ITEMS = 20;

export interface OpenWorkVerificationCommand {
  readonly index: number;
  /** `passed`, `failed`, `timeout`, `cancelled`, `error` or `not_run` (the verification stage's vocabulary). */
  readonly outcome: string;
  /** The argv the orchestrator supplied for this command, when recorded. */
  readonly argv: readonly string[] | null;
}

/** What the derivation needs from one terminal run. */
export interface OpenWorkRun {
  readonly runId: string;
  readonly state: "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly failureCode: string | null;
  /** Empty when the run ran no verification. */
  readonly verification: readonly OpenWorkVerificationCommand[];
  /** Count of nested repositories the finalize step skipped (its `workspace_assessment` event). */
  readonly nestedRepositoriesSkipped: number;
  /** The terminal `state_transition` payload carried `git_policy_violation`. */
  readonly gitPolicyViolation: boolean;
}

export type OpenWorkDetail =
  | null
  | string
  | number
  | { readonly index: number; readonly outcome: string; readonly argv: readonly string[] | null };

export interface OpenWorkItem {
  readonly kind: OpenWorkKind;
  readonly run_id: string;
  readonly detail: OpenWorkDetail;
}

/**
 * `runs` are the meta-session's terminal runs in `(created_at, id)` order, oldest first. "Newest run" is the last one.
 * Items come out in the order of {@link OPEN_WORK_KINDS}, at most {@link OPEN_WORK_MAX_ITEMS}. No runs: no items.
 */
export function deriveOpenWork(runs: readonly OpenWorkRun[]): OpenWorkItem[] {
  const newest = runs.at(-1);
  if (newest === undefined) return [];
  const items: OpenWorkItem[] = [];
  const push = (kind: OpenWorkKind, runId: string, detail: OpenWorkDetail) =>
    items.push({ kind, run_id: runId, detail });

  if (newest.state === "FAILED") push("last_run_failed", newest.runId, newest.failureCode);
  if (newest.state === "CANCELLED") push("last_run_cancelled", newest.runId, null);

  // The newest run that ran verification (not necessarily the newest run).
  const verified = runs.findLast((r) => r.verification.length > 0);
  if (verified !== undefined) {
    for (const c of verified.verification) {
      if (c.outcome !== "passed")
        push("verification_not_passing", verified.runId, { index: c.index, outcome: c.outcome, argv: c.argv });
    }
  }

  if (newest.state !== "SUCCEEDED") push("instruction_not_completed", newest.runId, newest.runId);
  if (newest.nestedRepositoriesSkipped > 0) {
    push("nested_repositories_skipped", newest.runId, newest.nestedRepositoriesSkipped);
  }
  if (newest.gitPolicyViolation) push("git_policy_violation", newest.runId, null);
  return items.slice(0, OPEN_WORK_MAX_ITEMS);
}
