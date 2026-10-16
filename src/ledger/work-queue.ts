import type Database from "better-sqlite3";
import type { IdGenerator } from "../ids/index.js";

export type WorkItemState = "PENDING" | "READY" | "ADMITTING" | "ADMITTED" | "DONE" | "CANCELLED" | "FAILED_ADMISSION";

export type WorkSourceKind = "mcp" | "schedule" | "ci_trigger";

export type WorkEventType = "enqueued" | "ready" | "admitted" | "done" | "cancelled" | "admission_failed";

export interface WorkItemRow {
  id: string;
  project_id: string;
  creator_client_id: string;
  state: WorkItemState;
  priority: number;
  request_json: string;
  source_kind: WorkSourceKind;
  source_id: string | null;
  idempotency_key: string | null;
  admitted_run_id: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export interface EnqueueWorkItemInput {
  projectId: string;
  creatorClientId: string;
  request: unknown;
  sourceKind: WorkSourceKind;
  sourceId?: string | null;
  idempotencyKey?: string | null;
  priority?: number;
  predecessorIds?: readonly string[];
  /** When set, enqueue returns the existing row if the key matches (same creator). */
  idempotentReturnExisting?: boolean;
}

export interface WorkListFilter {
  clientId: string;
  projectId?: string;
  states?: readonly WorkItemState[];
  limit: number;
}

export interface WorkQueueLedgerSlice {
  enqueueWorkItem(input: EnqueueWorkItemInput): WorkItemRow;
  getWorkItem(id: string): WorkItemRow | undefined;
  findWorkItemByIdempotency(creatorClientId: string, key: string): WorkItemRow | undefined;
  findWorkItemByAdmittedRunId(runId: string): WorkItemRow | undefined;
  listWorkItems(filter: WorkListFilter): WorkItemRow[];
  cancelWorkItem(workItemId: string, byClientId: string, operator?: boolean): WorkItemRow | undefined;
  claimReadyWorkItem(projectId: string): WorkItemRow | undefined;
  releaseAdmittingToReady(workItemId: string): boolean;
  completeWorkAdmission(
    workItemId: string,
    outcome: { kind: "admitted"; runId: string } | { kind: "retry" } | { kind: "failed"; code: string },
  ): WorkItemRow | undefined;
  markWorkItemDone(workItemId: string): WorkItemRow | undefined;
  reconcileAdmittingWorkItems(): number;
  countWorkItemsForProject(projectId: string): number;
  listDistinctProjectIdsWithReadyWork(): string[];
}

const ITEM_COLS = `id, project_id, creator_client_id, state, priority, request_json, source_kind, source_id,
  idempotency_key, admitted_run_id, last_error_code, created_at, updated_at, terminal_at`;

function rowFromDb(r: WorkItemRow): WorkItemRow {
  return r;
}

export function createWorkQueueLedgerSlice(
  db: Database.Database,
  deps: { ids: IdGenerator; ts: () => string; immediate: <T>(fn: () => T) => T },
): WorkQueueLedgerSlice {
  const { ids, ts, immediate } = deps;

  const getWorkItemFixed = (id: string): WorkItemRow | undefined => {
    const row = db.prepare(`SELECT ${ITEM_COLS} FROM project_work_item WHERE id = ?`).get(id) as
      | WorkItemRow
      | undefined;
    return row === undefined ? undefined : rowFromDb(row);
  };

  const appendEvent = (workItemId: string, type: WorkEventType, detail?: unknown, when?: string) => {
    const at = when ?? ts();
    db.prepare(
      `INSERT INTO project_work_event (id, work_item_id, type, detail_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(ids.id("pwe"), workItemId, type, detail === undefined ? null : JSON.stringify(detail), at);
  };

  const setState = (
    id: string,
    state: WorkItemState,
    patch: {
      admitted_run_id?: string | null;
      last_error_code?: string | null;
      terminal_at?: string | null;
    } = {},
    event: WorkEventType,
    detail?: unknown,
  ): WorkItemRow | undefined => {
    const at = ts();
    const sets = ["state = ?", "updated_at = ?"];
    const args: unknown[] = [state, at];
    if (patch.admitted_run_id !== undefined) {
      sets.push("admitted_run_id = ?");
      args.push(patch.admitted_run_id);
    }
    if (patch.last_error_code !== undefined) {
      sets.push("last_error_code = ?");
      args.push(patch.last_error_code);
    }
    if (patch.terminal_at !== undefined) {
      sets.push("terminal_at = ?");
      args.push(patch.terminal_at);
    }
    args.push(id);
    const n = db.prepare(`UPDATE project_work_item SET ${sets.join(", ")} WHERE id = ?`).run(...args).changes;
    if (n === 0) return undefined;
    appendEvent(id, event, detail, at);
    return getWorkItemFixed(id);
  };

  const unblockDependents = (predecessorId: string) => {
    const successors = db
      .prepare(`SELECT successor_id FROM project_work_dependency WHERE predecessor_id = ?`)
      .all(predecessorId) as { successor_id: string }[];
    for (const { successor_id } of successors) {
      const item = getWorkItemFixed(successor_id);
      if (item === undefined || item.state !== "PENDING") continue;
      const preds = db
        .prepare(`SELECT predecessor_id FROM project_work_dependency WHERE successor_id = ?`)
        .all(successor_id) as { predecessor_id: string }[];
      const blocking = preds.some((p) => {
        const pred = getWorkItemFixed(p.predecessor_id);
        return pred !== undefined && pred.state !== "DONE" && pred.state !== "CANCELLED";
      });
      if (!blocking) setState(successor_id, "READY", {}, "ready");
    }
  };

  const ancestorsOf = (successorId: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [successorId];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      const parents = db
        .prepare(`SELECT predecessor_id FROM project_work_dependency WHERE successor_id = ?`)
        .all(cur) as { predecessor_id: string }[];
      for (const p of parents) {
        if (!seen.has(p.predecessor_id)) {
          seen.add(p.predecessor_id);
          stack.push(p.predecessor_id);
        }
      }
    }
    return seen;
  };

  const wouldCycle = (predecessorIds: readonly string[]): boolean => {
    for (const p of predecessorIds) {
      const anc = ancestorsOf(p);
      for (const other of predecessorIds) {
        if (other !== p && anc.has(other)) return true;
      }
    }
    return false;
  };

  return {
    getWorkItem: getWorkItemFixed,

    findWorkItemByIdempotency(creatorClientId, key) {
      return db
        .prepare(`SELECT ${ITEM_COLS} FROM project_work_item WHERE creator_client_id = ? AND idempotency_key = ?`)
        .get(creatorClientId, key) as WorkItemRow | undefined;
    },

    findWorkItemByAdmittedRunId(runId) {
      return db.prepare(`SELECT ${ITEM_COLS} FROM project_work_item WHERE admitted_run_id = ?`).get(runId) as
        | WorkItemRow
        | undefined;
    },

    countWorkItemsForProject(projectId) {
      return (
        db.prepare("SELECT COUNT(*) AS n FROM project_work_item WHERE project_id = ?").get(projectId) as {
          n: number;
        }
      ).n;
    },

    listDistinctProjectIdsWithReadyWork() {
      return (
        db
          .prepare("SELECT DISTINCT project_id FROM project_work_item WHERE state = 'READY' ORDER BY project_id")
          .all() as {
          project_id: string;
        }[]
      ).map((r) => r.project_id);
    },

    enqueueWorkItem(input) {
      return immediate(() => {
        if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
          const existing = db
            .prepare(`SELECT ${ITEM_COLS} FROM project_work_item WHERE creator_client_id = ? AND idempotency_key = ?`)
            .get(input.creatorClientId, input.idempotencyKey) as WorkItemRow | undefined;
          if (existing !== undefined) {
            if (!input.idempotentReturnExisting) throw new Error("idempotency conflict");
            return existing;
          }
        }
        const priority = input.priority ?? 0;
        if (priority < -1000 || priority > 1000) throw new Error("priority out of range");
        const at = ts();
        const id = ids.id("que");
        const preds = input.predecessorIds ?? [];
        const initialState: WorkItemState = preds.length === 0 ? "READY" : "PENDING";
        db.prepare(
          `INSERT INTO project_work_item (id, project_id, creator_client_id, state, priority, request_json, source_kind,
            source_id, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.projectId,
          input.creatorClientId,
          initialState,
          priority,
          JSON.stringify(input.request),
          input.sourceKind,
          input.sourceId ?? null,
          input.idempotencyKey ?? null,
          at,
          at,
        );
        if (preds.length > 0 && wouldCycle(preds)) throw new Error("dependency cycle");
        for (const pred of preds) {
          if (getWorkItemFixed(pred) === undefined) throw new Error(`unknown predecessor ${pred}`);
          db.prepare(`INSERT INTO project_work_dependency (successor_id, predecessor_id) VALUES (?, ?)`).run(id, pred);
        }
        appendEvent(id, "enqueued", { state: initialState }, at);
        if (initialState === "READY") appendEvent(id, "ready", undefined, at);
        return getWorkItemFixed(id) as WorkItemRow;
      });
    },

    listWorkItems(filter) {
      const where = ["creator_client_id = ?"];
      const args: unknown[] = [filter.clientId];
      if (filter.projectId !== undefined) {
        where.push("project_id = ?");
        args.push(filter.projectId);
      }
      if (filter.states !== undefined) {
        if (filter.states.length === 0) return [];
        where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        args.push(...filter.states);
      }
      return db
        .prepare(
          `SELECT ${ITEM_COLS} FROM project_work_item WHERE ${where.join(" AND ")}
           ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`,
        )
        .all(...args, filter.limit) as WorkItemRow[];
    },

    cancelWorkItem(workItemId, byClientId, operator = false) {
      return immediate(() => {
        const item = getWorkItemFixed(workItemId);
        if (item === undefined) return undefined;
        if (!operator && item.creator_client_id !== byClientId) return undefined;
        if (item.state === "DONE" || item.state === "CANCELLED" || item.state === "FAILED_ADMISSION") return undefined;
        if (item.state === "ADMITTED") return undefined;
        const at = ts();
        return setState(workItemId, "CANCELLED", { terminal_at: at }, "cancelled");
      });
    },

    claimReadyWorkItem(projectId) {
      return immediate(() => {
        const row = db
          .prepare(
            `SELECT ${ITEM_COLS} FROM project_work_item
             WHERE project_id = ? AND state = 'READY'
             ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1`,
          )
          .get(projectId) as WorkItemRow | undefined;
        if (row === undefined) return undefined;
        const at = ts();
        const n = db
          .prepare(`UPDATE project_work_item SET state = 'ADMITTING', updated_at = ? WHERE id = ? AND state = 'READY'`)
          .run(at, row.id).changes;
        if (n === 0) return undefined;
        return getWorkItemFixed(row.id);
      });
    },

    releaseAdmittingToReady(workItemId) {
      return immediate(() => {
        const item = getWorkItemFixed(workItemId);
        if (item === undefined || item.state !== "ADMITTING") return false;
        setState(workItemId, "READY", {}, "ready", { retry: true });
        return true;
      });
    },

    completeWorkAdmission(workItemId, outcome) {
      return immediate(() => {
        const item = getWorkItemFixed(workItemId);
        if (item === undefined || item.state !== "ADMITTING") return undefined;
        if (outcome.kind === "retry") {
          setState(workItemId, "READY", {}, "ready", { admission_retry: true });
          return getWorkItemFixed(workItemId);
        }
        if (outcome.kind === "failed") {
          const at = ts();
          return setState(
            workItemId,
            "FAILED_ADMISSION",
            { last_error_code: outcome.code, terminal_at: at },
            "admission_failed",
            { code: outcome.code },
          );
        }
        const admitted = setState(workItemId, "ADMITTED", { admitted_run_id: outcome.runId }, "admitted", {
          run_id: outcome.runId,
        });
        return admitted;
      });
    },

    markWorkItemDone(workItemId) {
      return immediate(() => {
        const item = getWorkItemFixed(workItemId);
        if (item === undefined || item.state !== "ADMITTED") return undefined;
        const at = ts();
        const done = setState(workItemId, "DONE", { terminal_at: at }, "done");
        if (done !== undefined) unblockDependents(done.id);
        return done;
      });
    },

    reconcileAdmittingWorkItems() {
      return immediate(() => {
        const rows = db
          .prepare(`SELECT id FROM project_work_item WHERE state = 'ADMITTING' AND admitted_run_id IS NULL`)
          .all() as { id: string }[];
        let n = 0;
        for (const { id } of rows) {
          if (setState(id, "READY", {}, "ready", { reconcile: true }) !== undefined) n++;
        }
        return n;
      });
    },
  };
}
