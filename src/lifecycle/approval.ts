/**
 * Approval side effects shared by every cancel path (T3.3; FRD §4.3 "approval record closed as not granted"; ROADMAP
 * Q-15, Proposed default). A run cancelled while AWAITING_APPROVAL closes its own `PENDING` approval as `DENIED`, in the
 * caller's transaction; `decided_by` names the cancel source (`cancel_run` for the MCP tool, the requesting OS user for
 * an operator cancel). No migration is needed: the `approval` CHECK allows `DENIED` and the update-once trigger allows
 * any change from `PENDING` (LLD §1).
 *
 * Only the approval the run itself requested is touched, and only from AWAITING_APPROVAL: cancelling a later run of an
 * approved meta-session leaves the approval unchanged (owner decision 14, T3.4).
 */
import type { Ledger, RunRecord } from "../ledger/index.js";

/** `run_event` type recording the closure (payload `{ approval_id, status, reason }`; never the scope or hash). */
export const APPROVAL_CLOSED_EVENT = "approval_closed";

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
