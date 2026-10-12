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
 */
import type Database from "better-sqlite3";
import type { Ledger, RunRecord, RunState } from "../ledger/index.js";
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
      const state = cancelDirect(ledger, run, opts.now);
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

function cancelDirect(ledger: Ledger, run: RunRecord, now: () => Date = () => new Date()): RunState {
  const rule = assertTransition(run.state, "CANCELLED");
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
  cancel(runId: string, reason?: string): Promise<RunState>;
}

export interface AppliedCancel {
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
  for (const req of listPendingCancels(db)) {
    try {
      const stateAfter = await lifecycle.cancel(req.runId, "operator_cancel");
      ledger.appendRunEvent({
        runId: req.runId,
        type: OPERATOR_CANCEL_APPLIED,
        payload: { request_event_id: req.requestEventId, state_after: stateAfter, applied_by: "serve" },
      });
      out.push({ requestEventId: req.requestEventId, runId: req.runId, stateAfter });
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      ledger.appendRunEvent({
        runId: req.runId,
        type: OPERATOR_CANCEL_REJECTED,
        payload: { request_event_id: req.requestEventId, detail: error },
      });
      out.push({ requestEventId: req.requestEventId, runId: req.runId, stateAfter: null, error });
    }
  }
  return out;
}
