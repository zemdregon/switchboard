/**
 * Privileged approval rules shared by the operator CLI, the `serve` daemon, startup reconciliation and dispatch
 * (FRD WF-7, BR-14, T3, T19; LLD §3.1 "Approve" and "Bypass"; ADR-0017; owner decisions 13 and 17).
 *
 * T3.3: a run cancelled while AWAITING_APPROVAL closes its own `PENDING` approval as `DENIED`, in the caller's
 * transaction; `decided_by` names the cancel source (`cancel_run` for the MCP tool, the requesting OS user for an operator
 * cancel). ROADMAP Q-15, Proposed default. No migration is needed: the `approval` CHECK allows `DENIED` and the
 * update-once trigger allows any change from `PENDING` (LLD §1).
 *
 * Only the approval the run itself requested is touched, and only from AWAITING_APPROVAL: cancelling a later run of an
 * approved meta-session leaves the approval unchanged (owner decision 17, T3.4).
 *
 * T3.4 (Proposed, Delegated):
 * - `approve`/`deny` act only on the run that requested the approval, while it is AWAITING_APPROVAL and its row is
 *   `PENDING`, and only when the scope hash checks in {@link scopeHashProblem} pass ({@link checkDecidable}). Anything
 *   else is an {@link ApprovalRefusedError} and nothing is written.
 * - {@link applyApprovalDecision} writes the decision (update-once `decideApproval`) and the run's transition (T3 to
 *   QUEUED, or T19 to CANCELLED) in one transaction, so the row and the run state never disagree.
 * - {@link evaluateBypass} is the only source of `bypassApproved` for a run: `true` only for an `APPROVED` row of the
 *   run's own meta-session and client whose hash equals the snapshot's hash and both recomputed hashes, and whose scope
 *   sets `bypass: true`. Any mismatch is reported so dispatch fails the run `PERMISSION_BLOCKED` before spawn.
 *
 * ADR-0019 (owner decision 22, mechanism Delegated): a row written `APPROVED` at admission for a client configured
 * `privileged_approval: "not_required"` (`decided_by = "client_policy:<client_id>"`) is an ordinary `APPROVED` row
 * here: the same hash checks and ownership checks apply to it, at dispatch and for continuations. Its run never waits
 * in AWAITING_APPROVAL, so `approve`/`deny` refuse it (and say why).
 */
import type { ApprovalRow, Ledger, RunRecord } from "../ledger/index.js";
import { parsePrivilegedScope, privilegedScopeHash } from "../policy/index.js";
import type { PrivilegedScopeBinding } from "../policy/types.js";
import { assertTransition } from "./states.js";

/** `run_event` type recording the closure (payload `{ approval_id, status, reason }`; never the scope or hash). */
export const APPROVAL_CLOSED_EVENT = "approval_closed";
/** `decided_by` prefix of an approval granted by a client's `privileged_approval: "not_required"` (ADR-0019). */
export const CLIENT_POLICY_DECIDER_PREFIX = "client_policy:";
/** `run_event` type recording an operator decision written to the row (payload `{ approval_id, status }`). */
export const APPROVAL_DECIDED_EVENT = "approval_decided";

/**
 * Operator decision records (T3.4, same convention as the T1.10 cancel records in `src/cli/operator.ts`): append-only
 * `run_event` rows. A request is pending while no applied/rejected event references its event id.
 *   - `operator_decision_requested` payload `{ decision, approval_id, requested_by, scope_hash }`
 *   - `operator_decision_applied`   payload `{ request_event_id, state_after, applied_by }`
 *   - `operator_decision_rejected`  payload `{ request_event_id, detail }`
 * `requested_by` and `scope_hash` are operator-only: the MCP envelope strips them (LLD §3.1 "What is shown where").
 */
export const OPERATOR_DECISION_REQUESTED = "operator_decision_requested";
export const OPERATOR_DECISION_APPLIED = "operator_decision_applied";
export const OPERATOR_DECISION_REJECTED = "operator_decision_rejected";

export type OperatorDecision = "APPROVED" | "DENIED";

/** Who applied a decision (event payload `applied_by`). */
export type DecisionApplier = "cli_direct" | "serve" | "reconciliation";

/** `approve`/`deny` refused: the run, row or hash does not allow the decision. Nothing was written. */
export class ApprovalRefusedError extends Error {
  override readonly name = "ApprovalRefusedError";
}

/**
 * Call inside the transaction that moves `run` from AWAITING_APPROVAL to CANCELLED. Returns the closed approval's id,
 * or undefined when the run was not waiting or had no `PENDING` row.
 */
export function denyApprovalOnCancel(ledger: Ledger, run: RunRecord, decidedBy: string): string | undefined {
  if (run.state !== "AWAITING_APPROVAL") return undefined;
  const approval = ledger.getApprovalForRun(run.id);
  if (approval?.status !== "PENDING") return undefined;
  const denied = ledger.decideApproval({ id: approval.id, status: "DENIED", decidedBy });
  if (!denied) return undefined;
  ledger.appendRunEvent({
    runId: run.id,
    type: APPROVAL_CLOSED_EVENT,
    payload: { approval_id: denied.id, status: denied.status, reason: "cancelled" },
  });
  return denied.id;
}

/** The `privilegedScope` binding of a run's policy snapshot, or undefined when absent or unreadable (fail closed). */
export function snapshotBinding(run: RunRecord): PrivilegedScopeBinding | undefined {
  try {
    const b = (JSON.parse(run.policy_snapshot_json) as { privilegedScope?: Partial<PrivilegedScopeBinding> })
      .privilegedScope;
    if (!b || typeof b.scopeHash !== "string" || typeof b.approvalId !== "string" || b.scope === undefined) {
      return undefined;
    }
    return b as PrivilegedScopeBinding;
  } catch {
    return undefined;
  }
}

/**
 * LLD §3.1 hash checks for `run` against approval `row`, or undefined when all pass: the snapshot names the row; the
 * row's `scope_hash` equals the snapshot's `scopeHash`, the hash recomputed from the run's client, meta-session and
 * snapshot scope, and (Proposed, defence in depth) the hash recomputed from the row's stored `scope_json`. The returned
 * text names the failed check, never a hash value or scope content.
 */
export function scopeHashProblem(run: RunRecord, row: ApprovalRow): string | undefined {
  const binding = snapshotBinding(run);
  if (!binding) return "the run's policy snapshot names no privileged scope";
  if (binding.approvalId !== row.id) return "the run's policy snapshot names another approval";
  const snap = parsePrivilegedScope(binding.scope);
  if (!snap.ok) return "the run's policy snapshot holds an invalid scope";
  let stored: unknown;
  try {
    stored = JSON.parse(row.scope_json) as unknown;
  } catch {
    return "the approval's stored scope is unreadable";
  }
  const rowScope = parsePrivilegedScope(stored);
  if (!rowScope.ok) return "the approval's stored scope is invalid";
  const ids = { clientId: run.client_id, metaSessionId: run.meta_session_id };
  if (binding.scopeHash !== row.scope_hash) return "the approval's scope hash differs from the run's policy snapshot";
  if (privilegedScopeHash({ ...ids, scope: snap.scope }) !== row.scope_hash) {
    return "the scope hash recomputed from the run's client, meta-session and snapshot scope differs from the approval";
  }
  if (privilegedScopeHash({ ...ids, scope: rowScope.scope }) !== row.scope_hash) {
    return "the scope hash recomputed from the approval's stored scope differs from the approval";
  }
  return undefined;
}

/**
 * Refuses unless `approve`/`deny` may decide `run` now (LLD §3.1 "Approve", FRD WF-7 failure paths): a `privileged` run
 * in AWAITING_APPROVAL that requested its own `PENDING` approval, whose hashes all check, and (when given) whose hash
 * equals the one the operator recorded. Returns that approval row. Writes nothing.
 */
export function checkDecidable(ledger: Ledger, run: RunRecord, expectedHash?: string): ApprovalRow {
  const refuse = (msg: string): never => {
    throw new ApprovalRefusedError(`${msg}; nothing changed`);
  };
  if (run.trust_profile !== "privileged") {
    return refuse(`run ${run.id} is a ${run.trust_profile} run, not privileged: there is no approval to decide`);
  }
  if (run.state !== "AWAITING_APPROVAL") {
    const covering = snapshotBinding(run);
    const row = covering ? ledger.getApproval(covering.approvalId) : undefined;
    const reuse =
      row && row.run_id !== run.id
        ? ` (it runs under approval ${row.id}, which run ${row.run_id} requested and is ${row.status}; ` +
          "approve and deny act only on the run that requested an approval)"
        : "";
    const byPolicy =
      row && row.run_id === run.id && row.decided_by?.startsWith(CLIENT_POLICY_DECIDER_PREFIX)
        ? " (its approval was granted by client policy: the client is configured privileged_approval not_required)"
        : "";
    return refuse(`run ${run.id} is ${run.state}, not AWAITING_APPROVAL${reuse}${byPolicy}`);
  }
  const row = ledger.getApprovalForRun(run.id);
  if (!row) return refuse(`run ${run.id} requested no approval`);
  if (row.status !== "PENDING") return refuse(`approval ${row.id} of run ${run.id} is already ${row.status}`);
  const problem = scopeHashProblem(run, row);
  if (problem) return refuse(`scope hash check failed for run ${run.id}: ${problem}`);
  if (expectedHash !== undefined && expectedHash !== row.scope_hash) {
    return refuse(`scope hash check failed for run ${run.id}: the approval changed after the decision was recorded`);
  }
  return row;
}

export interface DecisionToApply {
  readonly requestEventId: string;
  readonly runId: string;
  readonly decision: OperatorDecision;
  /** OS user of the operator CLI; becomes `decided_by`. */
  readonly requestedBy: string;
  /** When the CLI recorded the decision; becomes `decided_at`. */
  readonly requestedAt: string;
  /** The scope hash the operator decided on (re-checked here). */
  readonly scopeHash: string;
}

/**
 * Apply one recorded operator decision in one transaction: re-check ({@link checkDecidable}), decide the row
 * (update-once, only while `PENDING`), append `approval_decided`, move the run (APPROVED: T3 → QUEUED; DENIED: T19 →
 * CANCELLED) and mark the request applied. Throws {@link ApprovalRefusedError} (nothing written) when the decision no
 * longer applies; the caller records the rejection.
 */
export function applyApprovalDecision(
  ledger: Ledger,
  req: DecisionToApply,
  opts: { appliedBy: DecisionApplier; now?: () => Date },
): RunRecord {
  return ledger.immediate(() => {
    const run = ledger.getRunRecord(req.runId);
    if (!run) throw new ApprovalRefusedError(`unknown run ${req.runId}; nothing changed`);
    const row = checkDecidable(ledger, run, req.scopeHash);
    const decided = ledger.decideApproval({
      id: row.id,
      status: req.decision,
      decidedBy: req.requestedBy,
      decidedAt: req.requestedAt,
    });
    if (!decided) throw new ApprovalRefusedError(`approval ${row.id} was decided concurrently; nothing changed`);
    ledger.appendRunEvent({
      runId: run.id,
      type: APPROVAL_DECIDED_EVENT,
      payload: { approval_id: decided.id, status: decided.status },
    });
    // T5.3 (LLD §15.3): the decision row, before a denial makes the run terminal (the helper refuses terminal runs).
    ledger.appendDecision({
      kind: "approval_decided",
      runId: run.id,
      approvalId: decided.id,
      status: decided.status === "APPROVED" ? "APPROVED" : "DENIED",
      by: "operator",
    });
    const to = req.decision === "APPROVED" ? "QUEUED" : "CANCELLED";
    const rule = assertTransition(run.state, to);
    const moved = ledger.casRunState({
      runId: run.id,
      from: run.state,
      to,
      expectedVersion: run.version,
      set: to === "CANCELLED" ? { finished_at: (opts.now ?? (() => new Date()))().toISOString() } : {},
      payload: {
        rule: rule.id,
        reason: req.decision === "APPROVED" ? "operator_approve" : "operator_deny",
        approval_id: decided.id,
        applied_by: opts.appliedBy,
      },
    });
    // Rolls back the row decision too: the row and the run state always change together.
    if (!moved) throw new ApprovalRefusedError(`run ${run.id} changed concurrently; nothing changed`);
    ledger.appendRunEvent({
      runId: run.id,
      type: OPERATOR_DECISION_APPLIED,
      payload: { request_event_id: req.requestEventId, state_after: moved.state, applied_by: opts.appliedBy },
    });
    return moved;
  });
}

export type BypassVerdict =
  | { readonly ok: true; readonly approvalId: string; readonly bypassApproved: boolean }
  | { readonly ok: false; readonly approvalId: string | undefined; readonly mismatch: string };

/**
 * LLD §3.1 "Bypass", evaluated for one `privileged` run before anything is compiled or spawned. `ok` with
 * `bypassApproved: true` only when the snapshot's approval row is `APPROVED`, was requested by a run of this run's own
 * meta-session and client, passes every {@link scopeHashProblem} check, and its scope sets `bypass: true`. `ok` with
 * `bypassApproved: false` for a matching `APPROVED` row whose scope does not set `bypass`. Anything else is a mismatch
 * (the caller fails the run `PERMISSION_BLOCKED`). Reads only.
 */
export function evaluateBypass(ledger: Ledger, run: RunRecord): BypassVerdict {
  const binding = snapshotBinding(run);
  const approvalId = binding?.approvalId;
  const mismatch = (text: string): BypassVerdict => ({ ok: false, approvalId, mismatch: text });
  if (!binding) return mismatch("the run's policy snapshot names no privileged scope");
  const row = ledger.getApproval(binding.approvalId);
  if (!row) return mismatch("the approval named by the run's policy snapshot does not exist");
  if (row.status !== "APPROVED") return mismatch(`the approval is ${row.status}, not APPROVED`);
  const owner = ledger.getRunRecord(row.run_id);
  if (!owner || owner.meta_session_id !== run.meta_session_id || owner.client_id !== run.client_id) {
    return mismatch("the approval belongs to another meta-session or client");
  }
  const problem = scopeHashProblem(run, row);
  if (problem) return mismatch(problem);
  const scope = parsePrivilegedScope(JSON.parse(row.scope_json) as unknown);
  return { ok: true, approvalId: row.id, bypassApproved: scope.ok && scope.scope.bypass === true };
}

/** `bypassApproved` for a run: true only for an `ok` {@link evaluateBypass} verdict that approves the bypass. */
export function bypassApprovedFor(ledger: Ledger, run: RunRecord): boolean {
  const v = evaluateBypass(ledger, run);
  return v.ok && v.bypassApproved;
}
