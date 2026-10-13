/**
 * Operator records (SDD §3.1, ADR-0005): the short-lived CLI writes requests, the `serve` daemon applies them.
 *
 * Proposed: LLD §1 has no operator-request table, and the task forbids inventing a schema change, so cancel requests
 * are stored as append-only `run_event` rows (`type` is free text in LLD §1):
 *   - `operator_cancel_requested`  payload `{ requested_by, reason }`
 *   - `operator_cancel_applied`    payload `{ request_event_id, state_after, applied_by }`
 *   - `operator_cancel_rejected`   payload `{ request_event_id, detail }`
 * A request is pending while no `applied`/`rejected` event references its event id. This is a gap in the owning
 * specification; a dedicated `operator_request` table (new migration plus LLD §1 and an ADR) is the alternative.
 *
 * T3.4 `approve`/`deny` use the same convention (`operator_decision_requested|applied|rejected`, defined in
 * `src/lifecycle/approval.ts`): the CLI records the decision (OS user, the scope hash it checked, the event timestamp);
 * the daemon, the CLI itself under the data-directory lock, or startup reconciliation applies it.
 */
import type Database from "better-sqlite3";
import type { Ledger, RunRecord, RunState } from "../ledger/index.js";
import {
  ApprovalRefusedError,
  applyApprovalDecision,
  checkDecidable,
  type DecisionToApply,
  denyApprovalOnCancel,
  OPERATOR_DECISION_APPLIED,
  OPERATOR_DECISION_REJECTED,
  OPERATOR_DECISION_REQUESTED,
  type OperatorDecision,
} from "../lifecycle/approval.js";
import { assertTransition, isTerminal } from "../lifecycle/states.js";

export const OPERATOR_CANCEL_REQUESTED = "operator_cancel_requested";
export const OPERATOR_CANCEL_APPLIED = "operator_cancel_applied";
export const OPERATOR_CANCEL_REJECTED = "operator_cancel_rejected";

/** States that have no process or workspace, so cancel is a direct ledger edge (FRD T19, same set as RunLifecycle). */
export const DIRECT_CANCEL_STATES: ReadonlySet<RunState> = new Set(["AWAITING_APPROVAL", "QUEUED", "WAITING_CAPACITY"]);

export interface PendingCancel {
  readonly requestEventId: string;
  readonly runId: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
}

interface PendingRow {
  id: string;
  run_id: string;
  ts: string;
  payload_json: string;
}

export function listPendingCancels(db: Database.Database, runId?: string): PendingCancel[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.run_id, e.ts, e.payload_json FROM run_event e
       WHERE e.type = ? ${runId === undefined ? "" : "AND e.run_id = ?"}
         AND NOT EXISTS (SELECT 1 FROM run_event a
                         WHERE a.run_id = e.run_id AND a.type IN (?, ?)
                           AND json_extract(a.payload_json, '$.request_event_id') = e.id)
       ORDER BY e.ts, e.id`,
    )
    .all(
      ...(runId === undefined ? [OPERATOR_CANCEL_REQUESTED] : [OPERATOR_CANCEL_REQUESTED, runId]),
      OPERATOR_CANCEL_APPLIED,
      OPERATOR_CANCEL_REJECTED,
    ) as PendingRow[];
  return rows.map((r) => ({
    requestEventId: r.id,
    runId: r.run_id,
    requestedAt: r.ts,
    requestedBy: String((JSON.parse(r.payload_json) as { requested_by?: unknown }).requested_by ?? "unknown"),
  }));
}

export type CancelOutcome =
  /** Cancelled by the CLI itself (no daemon, run had no process). */
  | "cancelled"
  /** Request recorded for the daemon to apply. */
  | "requested"
  /** An earlier request is still pending; nothing new written. */
  | "already_requested"
  /** Run was already terminal; nothing written. */
  | "already_terminal";

export interface CancelResult {
  readonly outcome: CancelOutcome;
  readonly runId: string;
  readonly state: RunState;
  readonly requestEventId: string | null;
}

export class UnknownRunError extends Error {
  override readonly name = "UnknownRunError";
}

/**
 * Record a cancel request. With `direct` (the caller holds the data-dir lock, so no daemon exists) a run without a
 * process is moved to CANCELLED at once through the FRD T19 edge and the request is marked applied in the same
 * transaction. In-flight runs are only recorded, even then: process and workspace cleanup belongs to the daemon.
 */
export function requestCancel(
  db: Database.Database,
  ledger: Ledger,
  runId: string,
  opts: { requestedBy: string; direct: boolean; now?: () => Date },
): CancelResult {
  return ledger.immediate(() => {
    const run = ledger.getRunRecord(runId);
    if (!run) throw new UnknownRunError(`unknown run ${runId}`);
    if (isTerminal(run.state)) return { outcome: "already_terminal", runId, state: run.state, requestEventId: null };

    const pending = listPendingCancels(db, runId)[0];
    if (pending && !(opts.direct && DIRECT_CANCEL_STATES.has(run.state))) {
      return { outcome: "already_requested", runId, state: run.state, requestEventId: pending.requestEventId };
    }

    const requestEventId =
      pending?.requestEventId ??
      ledger.appendRunEvent({
        runId,
        type: OPERATOR_CANCEL_REQUESTED,
        payload: { requested_by: opts.requestedBy, reason: "operator_cli" },
      }).id;

    if (opts.direct && DIRECT_CANCEL_STATES.has(run.state)) {
      const state = cancelDirect(ledger, run, opts.requestedBy, opts.now);
      ledger.appendRunEvent({
        runId,
        type: OPERATOR_CANCEL_APPLIED,
        payload: { request_event_id: requestEventId, state_after: state, applied_by: "cli_direct" },
      });
      return { outcome: "cancelled", runId, state, requestEventId };
    }
    return { outcome: "requested", runId, state: run.state, requestEventId };
  });
}

function cancelDirect(
  ledger: Ledger,
  run: RunRecord,
  requestedBy: string,
  now: () => Date = () => new Date(),
): RunState {
  const rule = assertTransition(run.state, "CANCELLED");
  // FRD §4.3 / Q-15 (T3.3): a waiting privileged run's PENDING approval is closed DENIED, decided by the operator.
  denyApprovalOnCancel(ledger, run, requestedBy);
  const moved = ledger.casRunState({
    runId: run.id,
    from: run.state,
    to: "CANCELLED",
    expectedVersion: run.version,
    set: { finished_at: now().toISOString() },
    payload: { rule: rule.id, reason: "operator_cli" },
  });
  if (!moved) throw new Error(`run ${run.id} changed concurrently`);
  return moved.state;
}

export interface CancelApplier {
  /** `decidedBy` closes a waiting run's PENDING approval (Q-15): the OS user who requested the cancel. */
  cancel(runId: string, reason?: string, decidedBy?: string): Promise<RunState>;
  /**
   * Applies a recorded `approve`/`deny` and lets dispatch see the result (`RunLifecycle.applyApprovalDecision`). When
   * absent, the decision is applied straight to the ledger (`applied_by: serve`).
   */
  applyApprovalDecision?(req: DecisionToApply): RunState;
}

export interface AppliedCancel {
  /** `decision` for an `approve`/`deny` record (T3.4); `cancel` otherwise. */
  readonly kind: "cancel" | "decision";
  readonly requestEventId: string;
  readonly runId: string;
  readonly stateAfter: RunState | null;
  readonly error?: string;
}

/**
 * Daemon side (wired into `serve` in M2): apply every pending operator cancel through the lifecycle, then mark it
 * applied (or rejected with the error). Safe to call repeatedly; each request is applied once.
 */
export async function applyOperatorRequests(
  db: Database.Database,
  ledger: Ledger,
  lifecycle: CancelApplier,
): Promise<AppliedCancel[]> {
  const out: AppliedCancel[] = [];
  // Decisions first: the CLI refuses a decision while a cancel is pending, so a pending decision always predates any
  // pending cancel of the same run.
  for (const req of listPendingDecisions(db)) {
    try {
      const stateAfter = lifecycle.applyApprovalDecision
        ? lifecycle.applyApprovalDecision(req)
        : applyApprovalDecision(ledger, req, { appliedBy: "serve" }).state;
      out.push({ kind: "decision", requestEventId: req.requestEventId, runId: req.runId, stateAfter });
    } catch (err) {
      const error = rejectDecision(ledger, req, err);
      out.push({ kind: "decision", requestEventId: req.requestEventId, runId: req.runId, stateAfter: null, error });
    }
  }
  for (const req of listPendingCancels(db)) {
    try {
      const stateAfter = await lifecycle.cancel(req.runId, "operator_cancel", req.requestedBy);
      ledger.appendRunEvent({
        runId: req.runId,
        type: OPERATOR_CANCEL_APPLIED,
        payload: { request_event_id: req.requestEventId, state_after: stateAfter, applied_by: "serve" },
      });
      out.push({ kind: "cancel", requestEventId: req.requestEventId, runId: req.runId, stateAfter });
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      ledger.appendRunEvent({
        runId: req.runId,
        type: OPERATOR_CANCEL_REJECTED,
        payload: { request_event_id: req.requestEventId, detail: error },
      });
      out.push({ kind: "cancel", requestEventId: req.requestEventId, runId: req.runId, stateAfter: null, error });
    }
  }
  return out;
}

// ---- T3.4: approve / deny ---------------------------------------------------------------------------------------

export interface PendingDecision extends DecisionToApply {
  readonly approvalId: string;
}

/** Recorded `approve`/`deny` decisions not yet applied or rejected, oldest first. */
export function listPendingDecisions(db: Database.Database, runId?: string): PendingDecision[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.run_id, e.ts, e.payload_json FROM run_event e
       WHERE e.type = ? ${runId === undefined ? "" : "AND e.run_id = ?"}
         AND NOT EXISTS (SELECT 1 FROM run_event a
                         WHERE a.run_id = e.run_id AND a.type IN (?, ?)
                           AND json_extract(a.payload_json, '$.request_event_id') = e.id)
       ORDER BY e.ts, e.id`,
    )
    .all(
      ...(runId === undefined ? [OPERATOR_DECISION_REQUESTED] : [OPERATOR_DECISION_REQUESTED, runId]),
      OPERATOR_DECISION_APPLIED,
      OPERATOR_DECISION_REJECTED,
    ) as PendingRow[];
  return rows.map((r) => {
    const p = JSON.parse(r.payload_json) as Record<string, unknown>;
    return {
      requestEventId: r.id,
      runId: r.run_id,
      requestedAt: r.ts,
      decision: p.decision === "APPROVED" ? "APPROVED" : "DENIED", // fail closed: anything else denies
      requestedBy: typeof p.requested_by === "string" && p.requested_by !== "" ? p.requested_by : "unknown",
      scopeHash: typeof p.scope_hash === "string" ? p.scope_hash : "",
      approvalId: typeof p.approval_id === "string" ? p.approval_id : "",
    };
  });
}

/** Record that a pending decision cannot be applied (its own event, outside the failed transaction). Returns the text. */
export function rejectDecision(ledger: Ledger, req: PendingDecision | DecisionToApply, err: unknown): string {
  const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  ledger.appendRunEvent({
    runId: req.runId,
    type: OPERATOR_DECISION_REJECTED,
    payload: { request_event_id: req.requestEventId, detail },
  });
  return detail;
}

export type DecisionOutcome =
  /** Applied by the CLI itself (no daemon was running): the run is QUEUED. */
  | "approved"
  /** Applied by the CLI itself: the run is CANCELLED. */
  | "denied"
  /** Recorded for the daemon (or the next startup reconciliation) to apply. */
  | "requested";

export interface DecisionResult {
  readonly outcome: DecisionOutcome;
  readonly runId: string;
  readonly state: RunState;
  readonly approvalId: string;
  readonly requestEventId: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly scopeHash: string;
}

/**
 * Record an operator `approve`/`deny` (FRD WF-7, LLD §3.1 "Approve"). Every check runs first, in one `BEGIN IMMEDIATE`
 * transaction with the write, so a refusal ({@link ApprovalRefusedError}, or {@link UnknownRunError}) writes nothing:
 * the run must be a `privileged` run in AWAITING_APPROVAL that requested its own `PENDING` approval, every scope hash
 * check must pass, and no other decision or cancel may be pending for it. With `direct` (the caller holds the data-dir
 * lock, so no daemon exists) the decision is applied in the same transaction.
 */
export function requestDecision(
  db: Database.Database,
  ledger: Ledger,
  runId: string,
  opts: { decision: OperatorDecision; requestedBy: string; direct: boolean; now?: () => Date },
): DecisionResult {
  return ledger.immediate(() => {
    const run = ledger.getRunRecord(runId);
    if (!run) throw new UnknownRunError(`unknown run ${runId}`);
    const pending = listPendingDecisions(db, runId)[0];
    if (pending) {
      throw new ApprovalRefusedError(
        `a ${pending.decision === "APPROVED" ? "approve" : "deny"} decision for run ${runId} is already recorded ` +
          `(event ${pending.requestEventId}) and waits for the serve daemon; nothing changed`,
      );
    }
    if (listPendingCancels(db, runId).length > 0) {
      throw new ApprovalRefusedError(`a cancel request for run ${runId} is pending; nothing changed`);
    }
    const row = checkDecidable(ledger, run);
    const event = ledger.appendRunEvent({
      runId,
      type: OPERATOR_DECISION_REQUESTED,
      payload: {
        decision: opts.decision,
        approval_id: row.id,
        requested_by: opts.requestedBy,
        scope_hash: row.scope_hash,
      },
    });
    const base = {
      runId,
      approvalId: row.id,
      requestEventId: event.id,
      decidedBy: opts.requestedBy,
      decidedAt: event.ts,
      scopeHash: row.scope_hash,
    };
    if (!opts.direct) return { ...base, outcome: "requested", state: run.state };
    const moved = applyApprovalDecision(
      ledger,
      {
        requestEventId: event.id,
        runId,
        decision: opts.decision,
        requestedBy: opts.requestedBy,
        requestedAt: event.ts,
        scopeHash: row.scope_hash,
      },
      { appliedBy: "cli_direct", ...(opts.now ? { now: opts.now } : {}) },
    );
    return { ...base, outcome: opts.decision === "APPROVED" ? "approved" : "denied", state: moved.state };
  });
}
