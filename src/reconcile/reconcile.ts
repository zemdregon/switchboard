/**
 * Startup reconciliation (T1.9; FR-EXE-06, NFR-REL-01, FRD WF-8, LLD §5/§8/§10). Runs after the ledger is open and the
 * data-directory lock is held, and before `RunLifecycle.start()` (and, from M2, before the MCP server accepts calls).
 *
 * Per non-terminal run found at startup (FRD WF-8 owns the outcomes; T20 "controller restart"):
 *
 * | State | Action |
 * | --- | --- |
 * | AWAITING_APPROVAL, QUEUED, WAITING_CAPACITY | Kept, order preserved; a pending operator cancel is applied (T19). |
 * | PREFLIGHT, LEASED without a worktree | Lease released, back to QUEUED (WF-8, rule T20). |
 * | LEASED with a worktree (pre checkpoint recorded) | Assessed and checkpointed; FAILED `PROCESS_CRASH` (T10). |
 * | RUNNING, VERIFYING | Live orphan group terminated; → FINALIZING (T13/T14, pending `PROCESS_CRASH`, cause `controller_restart`) → finalization below. |
 * | FINALIZING | Finalization redone from the worktree; the recorded pending outcome is applied (T15–T17). |
 *
 * Finalization mirrors the lifecycle (FRD §4.4, ADR-0006): mutation check, evidence checkpoint and diff, meta-session
 * head kept at / returned to the pre-run checkpoint unless the pending outcome is success, lease released together with
 * the terminal transition. A missing worktree ends the run FAILED `TOOL_FAILURE` (WF-8 failure path). Nothing is ever
 * replayed; M1 records retry eligibility (BR-7) only.
 *
 * Proposed choices (Delegated, not owner-approved):
 * - A LEASED run whose pre checkpoint already exists is not requeued: WF-8's requeue rests on "preflight and lease are
 *   repeatable without side effects", which no longer holds once checkpoint rows and a worktree exist (a second
 *   `prepare` would append a second `pre` row). It ends FAILED `PROCESS_CRASH` through T10 instead.
 * - A pending operator cancel (T1.10 `operator_cancel_requested` events) wins over the crash classification for runs
 *   that had not reached FINALIZING: they end CANCELLED (via FINALIZING when a process existed, FRD §4.3). In
 *   FINALIZING the recorded outcome stands (FRD §4.3) and the request is marked applied with that outcome.
 * - A FINALIZING run whose pending outcome cannot be read is treated as a pending `PROCESS_CRASH` (fail closed).
 * - Orphan identity rules are in ./process.ts; an unverifiable or reused PID is never signalled.
 *
 * Idempotent (LLD §10): every step is conditional on the current state; a second pass over a reconciled ledger writes
 * nothing. A crash during reconciliation leaves the last committed step, which the next pass continues from.
 */
import { stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import { listPendingCancels, OPERATOR_CANCEL_APPLIED } from "../cli/operator.js";
import type { Ledger, RunFieldPatch, RunRecord, RunState } from "../ledger/index.js";
import { denyApprovalOnCancel } from "../lifecycle/approval.js";
import { RUN_STATES, SLOT_STATES, TERMINAL_STATES, TRANSITIONS } from "../lifecycle/states.js";
import type { WorkspaceManager } from "../workspace/index.js";
import { inspectOrphan, type OrphanStatus, terminateGroup } from "./process.js";

export const RECONCILE_CAUSE = "controller_restart";
const CRASH_DETAIL = "provider process orphaned by a controller restart (cause controller_restart)";
const RETRYABLE = new Set(["RATE_LIMIT_TRANSIENT", "PROVIDER_OVERLOADED", "PROCESS_CRASH"]);

/** WF-8 outcomes that are not FRD §4.2 edges of their own; they are recorded under rule T20. */
const RESTART_EDGES: ReadonlySet<string> = new Set(["PREFLIGHT>QUEUED", "LEASED>QUEUED"]);

export interface ReconcileOptions {
  readonly db: Database.Database;
  readonly ledger: Ledger;
  /** Must share `db`. */
  readonly workspace: WorkspaceManager;
  /** SIGTERM → SIGKILL grace for orphan groups (LLD §8, default 10 s). */
  readonly killGraceMs?: number;
  readonly now?: () => Date;
}

export interface ReconcileAction {
  readonly runId: string;
  readonly from: RunState;
  readonly to: RunState;
  readonly orphan?: OrphanStatus["kind"];
  readonly mutated?: boolean;
  readonly failureCode?: string;
}

export interface ReconcileReport {
  /** Non-terminal runs found. */
  readonly examined: number;
  /** Runs whose state changed. */
  readonly actions: readonly ReconcileAction[];
  /** Orphan process groups terminated (pgids). */
  readonly terminated: readonly number[];
  /** Run ids whose stale lease was released by the final sweep. */
  readonly leasesReleased: readonly string[];
  /** Operator cancel request event ids applied. */
  readonly cancelsApplied: readonly string[];
}

type Pending =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly code: string; readonly detail: string }
  | { readonly kind: "cancelled" };

const WAITING: ReadonlySet<RunState> = new Set(["AWAITING_APPROVAL", "QUEUED", "WAITING_CAPACITY"]);

export async function reconcile(opts: ReconcileOptions): Promise<ReconcileReport> {
  return new Reconciler(opts).run();
}

class Reconciler {
  private readonly ledger: Ledger;
  private readonly actions: ReconcileAction[] = [];
  private readonly terminated: number[] = [];
  private readonly cancelsApplied: string[] = [];

  constructor(private readonly opts: ReconcileOptions) {
    this.ledger = opts.ledger;
  }

  async run(): Promise<ReconcileReport> {
    const runs = RUN_STATES.filter((s) => !TERMINAL_STATES.has(s))
      .flatMap((s) => this.ledger.listRunsInState(s))
      .sort((a, b) => (a.created_at === b.created_at ? cmp(a.id, b.id) : cmp(a.created_at, b.created_at)));
    for (const run of runs) await this.reconcileRun(run);
    const leasesReleased = this.sweepLeases();
    return {
      examined: runs.length,
      actions: this.actions,
      terminated: this.terminated,
      leasesReleased,
      cancelsApplied: this.cancelsApplied,
    };
  }

  private async reconcileRun(run0: RunRecord): Promise<void> {
    const cancelRequested = listPendingCancels(this.opts.db, run0.id).length > 0;

    if (WAITING.has(run0.state)) {
      if (!cancelRequested) return; // WF-8: keep; queue order preserved.
      this.ledger.immediate(() => {
        // FRD §4.3 / Q-15 (T3.3): a waiting privileged run's PENDING approval is closed DENIED by the requester.
        const requestedBy = listPendingCancels(this.opts.db, run0.id)[0]?.requestedBy ?? "operator";
        denyApprovalOnCancel(this.ledger, run0, requestedBy);
        const moved = this.transition(run0, "CANCELLED", "T19", { finished_at: this.nowIso() }, { code: "CANCELLED" });
        this.markCancelsApplied(moved);
      });
      this.actions.push({ runId: run0.id, from: run0.state, to: "CANCELLED" });
      return;
    }

    // FR-EXE-06: a still-live provider group is terminated before the worktree is assessed.
    const orphan = await this.handleOrphan(run0);
    const run = this.current(run0.id);

    switch (run.state) {
      case "PREFLIGHT":
      case "LEASED": {
        const hasWorktree = this.ledger.getRunCheckpointCommit(run.id, "pre") !== undefined;
        if (run.state === "PREFLIGHT" || !hasWorktree) {
          const to: RunState = cancelRequested ? "CANCELLED" : "QUEUED";
          this.ledger.immediate(() => {
            this.opts.workspace.releaseLease(run.id);
            const set: RunFieldPatch = to === "CANCELLED" ? { finished_at: this.nowIso() } : {};
            const moved = this.transition(run, to, to === "CANCELLED" ? "T19" : "T20", set, {
              ...(to === "CANCELLED" ? { code: "CANCELLED" } : { lease: "released" }),
            });
            if (to === "CANCELLED") this.markCancelsApplied(moved);
          });
          this.actions.push({ runId: run.id, from: run.state, to, orphan: orphan.kind });
          return;
        }
        const pending: Pending = cancelRequested
          ? { kind: "cancelled" }
          : { kind: "failure", code: "PROCESS_CRASH", detail: CRASH_DETAIL };
        await this.finalize(run, pending, orphan);
        return;
      }
      case "RUNNING":
      case "VERIFYING": {
        const pending: Pending = cancelRequested
          ? { kind: "cancelled" }
          : { kind: "failure", code: "PROCESS_CRASH", detail: CRASH_DETAIL };
        // Intent before action (LLD §10): FINALIZING with its pending outcome is committed before any Git work.
        const fin = this.transition(
          run,
          "FINALIZING",
          run.state === "RUNNING" ? "T13" : "T14",
          {},
          pendingPayload(pending),
        );
        await this.finalize(fin, pending, orphan);
        return;
      }
      case "FINALIZING":
        await this.finalize(run, readPending(this.ledger, run.id), orphan);
        return;
      default:
        return; // terminal: never touched
    }
  }

  private async handleOrphan(run: RunRecord): Promise<OrphanStatus> {
    const status = inspectOrphan(run);
    if (status.kind === "none") return status;
    if (status.kind === "alive") {
      this.event(run.id, {
        step: "terminate_orphan",
        phase: "intent",
        pgid: status.pgid,
        leader_alive: status.leaderAlive,
      });
      const res = await terminateGroup(status.pgid, this.opts.killGraceMs);
      this.terminated.push(status.pgid);
      this.event(run.id, {
        step: "terminate_orphan",
        phase: "done",
        pgid: status.pgid,
        escalated: res.escalated,
        group_empty: res.groupEmpty,
      });
    } else {
      this.event(run.id, { step: "orphan_not_signalled", pgid: status.pgid, reason: status.kind });
    }
    return status;
  }

  /** FINALIZING (or LEASED with a worktree) → terminal; mirrors RunLifecycle.finalize. */
  private async finalize(run: RunRecord, pending: Pending, orphan: OrphanStatus): Promise<void> {
    let outcome = pending;
    let mutated: boolean | undefined;
    if (run.worktree_path !== null) {
      const present = await stat(run.worktree_path).then(
        () => true,
        () => false,
      );
      if (!present) {
        // WF-8 failure path: worktree missing → TOOL_FAILURE; nothing to assess; head untouched.
        outcome = {
          kind: "failure",
          code: "TOOL_FAILURE",
          detail: `worktree missing at reconciliation (pending ${describe(pending)})`,
        };
        this.event(run.id, { step: "workspace_assessment", worktree: "missing" });
      } else {
        try {
          mutated = await this.checkpoint(run, outcome);
        } catch (err) {
          if (outcome.kind !== "failure") {
            outcome = { kind: "failure", code: "TOOL_FAILURE", detail: `finalization failed: ${errorText(err)}` };
          }
        }
      }
    }

    const finished = this.nowIso();
    const to: RunState =
      outcome.kind === "success" ? "SUCCEEDED" : outcome.kind === "cancelled" ? "CANCELLED" : "FAILED";
    const fromLeased = run.state === "LEASED";
    const rule = fromLeased
      ? to === "CANCELLED"
        ? "T19"
        : "T10"
      : to === "SUCCEEDED"
        ? "T15"
        : to === "FAILED"
          ? "T16"
          : "T17";
    this.ledger.immediate(() => {
      this.opts.workspace.releaseLease(run.id);
      const cur = this.current(run.id);
      const set: RunFieldPatch =
        outcome.kind === "failure"
          ? { failure_code: outcome.code, failure_detail: outcome.detail, finished_at: finished }
          : { finished_at: finished };
      const moved = this.transition(cur, to, rule, set, outcome.kind === "cancelled" ? { code: "CANCELLED" } : {});
      this.markCancelsApplied(moved);
    });
    this.actions.push({
      runId: run.id,
      from: run.state,
      to,
      orphan: orphan.kind,
      ...(mutated !== undefined ? { mutated } : {}),
      ...(outcome.kind === "failure" ? { failureCode: outcome.code } : {}),
    });
  }

  /** Mutation check, evidence/post checkpoint and head disposition (FRD §4.4, LLD §5). Returns `mutated`. */
  private async checkpoint(run: RunRecord, outcome: Pending): Promise<boolean> {
    const ws = this.opts.workspace;
    const assessment = await ws.assessMutation(run.id);
    const success = outcome.kind === "success";
    const fin = await ws.finalize(run.id, { advanceHead: success });
    const code = outcome.kind === "failure" ? outcome.code : undefined;
    this.ledger.appendRunEvent({
      runId: run.id,
      type: "workspace_assessment",
      payload: {
        mutated: assessment.mutated,
        reasons: assessment.reasons,
        replay_eligible: assessment.replayEligible,
        retry_eligible: code !== undefined && RETRYABLE.has(code) && !assessment.mutated,
        auto_retry: false,
        reconciled: true,
        cause: RECONCILE_CAUSE,
      },
    });
    this.ledger.appendRunEvent({
      runId: run.id,
      type: "checkpoint",
      artifactId: fin.diffArtifactId,
      payload: {
        kind: "post",
        commit: fin.postCommit,
        committed: fin.committed,
        changed_files: fin.changedFiles.length,
        reconciled: true,
      },
    });
    if (!success) {
      const pre = this.ledger.getRunCheckpointCommit(run.id, "pre");
      if (pre !== undefined) {
        // FRD §4.4: head returns to the pre-run checkpoint; the mutated state is evidence only (FR-WS-04, ADR-0006).
        this.ledger.setMetaSessionHead(run.meta_session_id, pre);
        this.ledger.appendRunEvent({
          runId: run.id,
          type: "rollback",
          payload: { head: pre, evidence_commit: fin.postCommit, mutated: assessment.mutated, reconciled: true },
        });
      }
    }
    return assessment.mutated;
  }

  /** Release leases whose holder is gone or no longer in a lease-holding state (LLD §5 stale lease). */
  private sweepLeases(): string[] {
    const released: string[] = [];
    for (const lease of this.ledger.listLeases()) {
      const holder = this.ledger.getRunRecord(lease.lease_run_id);
      if (holder && SLOT_STATES.includes(holder.state)) continue; // unreachable after the pass above
      this.ledger.immediate(() => {
        this.opts.workspace.releaseLease(lease.lease_run_id);
        if (holder) {
          this.ledger.appendRunEvent({
            runId: holder.id,
            type: "lease",
            payload: { action: "released", reason: "stale", reconciled: true, cause: RECONCILE_CAUSE },
          });
        }
      });
      released.push(lease.lease_run_id);
    }
    return released;
  }

  private markCancelsApplied(run: RunRecord): void {
    for (const req of listPendingCancels(this.opts.db, run.id)) {
      this.ledger.appendRunEvent({
        runId: run.id,
        type: OPERATOR_CANCEL_APPLIED,
        payload: { request_event_id: req.requestEventId, state_after: run.state, applied_by: "reconciliation" },
      });
      this.cancelsApplied.push(req.requestEventId);
    }
  }

  /** Guarded CAS transition plus `state_transition` event (LLD §10); FRD edge or a WF-8 T20 outcome only. */
  private transition(
    run: RunRecord,
    to: RunState,
    rule: string,
    set: RunFieldPatch,
    payload: Record<string, unknown>,
  ): RunRecord {
    const legal =
      rule === "T20"
        ? RESTART_EDGES.has(`${run.state}>${to}`)
        : TRANSITIONS.some((t) => t.id === rule && t.from === run.state && t.to === to);
    if (!legal) throw new Error(`reconciliation: illegal transition ${run.state} -> ${to} (${rule})`);
    const moved = this.ledger.casRunState({
      runId: run.id,
      from: run.state,
      to,
      expectedVersion: run.version,
      set,
      payload: { rule, reconciled: true, cause: RECONCILE_CAUSE, ...payload },
    });
    if (!moved) throw new Error(`reconciliation: run ${run.id} changed concurrently (is another controller running?)`);
    return moved;
  }

  private event(runId: string, payload: Record<string, unknown>): void {
    this.ledger.appendRunEvent({ runId, type: "reconciliation", payload: { ...payload, cause: RECONCILE_CAUSE } });
  }

  private current(runId: string): RunRecord {
    const run = this.ledger.getRunRecord(runId);
    if (!run) throw new Error(`run ${runId} vanished`);
    return run;
  }

  private nowIso(): string {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }
}

function pendingPayload(p: Pending): Record<string, unknown> {
  return {
    pending: p.kind,
    ...(p.kind === "failure" ? { failure_code: p.code, failure_detail: p.detail } : {}),
  };
}

/** The pending outcome recorded on the latest transition into FINALIZING (T1.8 payload); fail closed if absent. */
export function readPending(ledger: Ledger, runId: string): Pending {
  const into = ledger
    .listRunEvents(runId)
    .filter((e) => e.type === "state_transition")
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
    .filter((p) => p.to === "FINALIZING")
    .at(-1);
  const kind = into?.pending;
  if (kind === "success") return { kind: "success" };
  if (kind === "cancelled") return { kind: "cancelled" };
  if (kind === "failure" && typeof into?.failure_code === "string") {
    const detail =
      typeof into.failure_detail === "string"
        ? into.failure_detail
        : `${into.failure_code}: finalization completed by startup reconciliation`;
    return { kind: "failure", code: into.failure_code, detail };
  }
  return { kind: "failure", code: "PROCESS_CRASH", detail: `${CRASH_DETAIL}; pending outcome unreadable` };
}

function describe(p: Pending): string {
  return p.kind === "failure" ? `failure ${p.code}` : p.kind;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
