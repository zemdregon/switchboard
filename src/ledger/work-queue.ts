import type Database from "better-sqlite3";
import type { IdGenerator } from "../ids/index.js";
import { hotPathsOverlap, hotPathsProblem, storedHotPaths } from "../queue/hot-paths.js";

export type WorkItemState = "PENDING" | "READY" | "ADMITTING" | "ADMITTED" | "DONE" | "CANCELLED" | "FAILED_ADMISSION";

/** Every {@link WorkItemState}, in migration 0017's CHECK order. */
export const WORK_ITEM_STATES: readonly WorkItemState[] = [
  "PENDING",
  "READY",
  "ADMITTING",
  "ADMITTED",
  "DONE",
  "CANCELLED",
  "FAILED_ADMISSION",
];

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
  /** T15.7 (migration 0029): per-project dedupe key, `null` when unset. */
  dedupe_key: string | null;
  /** T15.7: JSON array of path globs, `null` when unset. */
  hot_paths_json: string | null;
  /** T15.7: the re-implementation item that superseded the ref this item worked on. */
  superseded_by: string | null;
}

/** Bounds of a `dedupe_key` (T15.7). */
export const DEDUPE_KEY_MIN = 1;
export const DEDUPE_KEY_MAX = 200;

/**
 * T15.7 (FR-QUE-07, LLD §20.4): a second item with the same `dedupe_key` in a project while one is live, or published
 * (`DONE`) and not superseded. The MCP layer reports it as `CONFLICT`.
 */
export class WorkItemDedupeConflictError extends Error {
  override readonly name = "WorkItemDedupeConflictError";
  constructor(readonly dedupeKey: string) {
    super("a work item with this dedupe_key is already live or published in the project");
  }
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
  /** T15.7: refused with {@link WorkItemDedupeConflictError} while another item holds the key. */
  dedupeKey?: string | null;
  /** T15.7: up to 32 relative path globs (`src/queue/hot-paths.ts`). */
  hotPaths?: readonly string[] | null;
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
  /** The item's predecessors (`project_work_dependency`), sorted by id. */
  listWorkItemPredecessors(workItemId: string): string[];
  cancelWorkItem(workItemId: string, byClientId: string, operator?: boolean): WorkItemRow | undefined;
  claimReadyWorkItem(projectId: string): WorkItemRow | undefined;
  releaseAdmittingToReady(workItemId: string): boolean;
  completeWorkAdmission(
    workItemId: string,
    outcome: { kind: "admitted"; runId: string } | { kind: "retry" } | { kind: "failed"; code: string },
  ): WorkItemRow | undefined;
  markWorkItemDone(workItemId: string): WorkItemRow | undefined;
  /**
   * LLD §18.2: close the ADMITTED item whose run just reached a terminal state. `SUCCEEDED` makes it `DONE`; `FAILED`
   * and `CANCELLED` set `terminal_at` and leave it `ADMITTED`, the only state §18.2 defines for an item with a run.
   */
  closeWorkItemForRun(runId: string, runState: "SUCCEEDED" | "FAILED" | "CANCELLED"): WorkItemRow | undefined;
  reconcileAdmittingWorkItems(): number;
  countWorkItemsForProject(projectId: string): number;
  listDistinctProjectIdsWithReadyWork(): string[];
  /**
   * T15.4 (FR-QUE-04, LLD §18.8): count of admissible work items for a project (items in READY, or PENDING whose
   * dependencies can still be met).
   */
  countAdmissibleWorkItems(projectId: string): number;
  /**
   * T15.4: registers an optional callback notified whenever work items in a project change state.
   */
  setQueueChangeListener(listener?: (projectId: string) => void): void;
  /** T14.16 (FR-CTL-14, LLD §20.5): the ledger facts the `stalled_progress` derivation reads for one project. */
  readProgressStallFacts(projectId: string): ProgressStallFacts;
  /** T14.16 (FR-CTL-14, LLD §20.5): work items of every project by state (integer counts for the pushed digest). */
  countWorkItemsByState(): Partial<Record<WorkItemState, number>>;
  /** T15.7 (LLD §20.4): the `pending` controller Git preparation of a rebase run; call inside the admission transaction. */
  insertRunRebase(input: { runId: string; workItemId: string; publishRef: string; headSha: string }): void;
  getRunRebase(runId: string): RunRebaseRow | undefined;
  /** T15.7: the rebase run already admitted for a work item, if any (admission idempotency after a crash). */
  findRunRebaseForWorkItem(workItemId: string): RunRebaseRow | undefined;
  /** T15.7: the `ci_ref_conflict` row that enqueued a work item, if any. */
  getRefConflictForWorkItem(workItemId: string): RefConflictRow | undefined;
}

/** T15.7 (migration 0029): one `run_rebase` row. */
export interface RunRebaseRow {
  run_id: string;
  work_item_id: string;
  publish_ref: string;
  head_sha: string;
  merge_parent_sha: string | null;
  state: "pending" | "prepared" | "failed";
  conflicted_paths: number | null;
  created_at: string;
  updated_at: string;
}

/** T15.7 (migration 0029): one `ci_ref_conflict` row. */
export interface RefConflictRow {
  id: string;
  project_id: string;
  remote: string;
  publish_ref: string;
  head_sha: string;
  pr_number: number;
  kind: "rebase" | "reimplement";
  meta_session_id: string | null;
  work_item_id: string;
  observed_at: string;
}

/** T14.16: one project's `READY` count, the oldest `READY` item's `created_at` and the newest `DONE` `terminal_at`. */
export interface ProgressStallFacts {
  readyCount: number;
  oldestReadyCreatedAt: string | null;
  lastDoneAt: string | null;
}

const ITEM_COLS = `id, project_id, creator_client_id, state, priority, request_json, source_kind, source_id,
  idempotency_key, admitted_run_id, last_error_code, created_at, updated_at, terminal_at, dedupe_key, hot_paths_json,
  superseded_by`;

/** The partial unique index `project_work_item_dedupe` of migration 0029, as a predicate. */
const DEDUPE_HELD = `dedupe_key IS NOT NULL AND superseded_by IS NULL
  AND state NOT IN ('CANCELLED', 'FAILED_ADMISSION') AND (state = 'DONE' OR terminal_at IS NULL)`;

function rowFromDb(r: WorkItemRow): WorkItemRow {
  return r;
}

export function createWorkQueueLedgerSlice(
  db: Database.Database,
  deps: { ids: IdGenerator; ts: () => string; immediate: <T>(fn: () => T) => T },
): WorkQueueLedgerSlice {
  const { ids, ts, immediate } = deps;

  let queueChangeListener: ((projectId: string) => void) | undefined;
  const notifyQueueChange = (projectId: string) => {
    try {
      queueChangeListener?.(projectId);
    } catch {
      // Best effort: a listener problem must never affect ledger operations
    }
  };

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

  const isBlockingPredecessor = (predecessorId: string): boolean => {
    const pred = getWorkItemFixed(predecessorId);
    // LLD §18.3, §18.8: only DONE satisfies an edge; a CANCELLED predecessor blocks (fail closed).
    return pred !== undefined && pred.state !== "DONE";
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
      const blocking = preds.some((p) => isBlockingPredecessor(p.predecessor_id));
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

  const markWorkItemDone = (workItemId: string): WorkItemRow | undefined =>
    immediate(() => {
      const item = getWorkItemFixed(workItemId);
      if (item === undefined || item.state !== "ADMITTED" || item.terminal_at !== null) return undefined;
      const at = ts();
      const done = setState(workItemId, "DONE", { terminal_at: at }, "done");
      if (done !== undefined) {
        unblockDependents(done.id);
        notifyQueueChange(item.project_id);
      }
      return done;
    });

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
        const dedupeKey = input.dedupeKey ?? null;
        if (dedupeKey !== null) {
          if (dedupeKey.length < DEDUPE_KEY_MIN || dedupeKey.length > DEDUPE_KEY_MAX) {
            throw new Error("dedupe_key length out of range");
          }
          const held = db
            .prepare(`SELECT 1 FROM project_work_item WHERE project_id = ? AND dedupe_key = ? AND ${DEDUPE_HELD}`)
            .get(input.projectId, dedupeKey);
          if (held !== undefined) throw new WorkItemDedupeConflictError(dedupeKey);
        }
        const hotPaths = input.hotPaths ?? null;
        if (hotPaths !== null) {
          const problem = hotPathsProblem(hotPaths);
          if (problem !== undefined) throw new Error(problem);
        }
        const at = ts();
        const id = ids.id("que");
        const preds = input.predecessorIds ?? [];
        // A predecessor that is already DONE never transitions again, so unblockDependents would not promote this
        // item later; apply the same rule here.
        const initialState: WorkItemState = preds.some(isBlockingPredecessor) ? "PENDING" : "READY";
        db.prepare(
          `INSERT INTO project_work_item (id, project_id, creator_client_id, state, priority, request_json, source_kind,
            source_id, idempotency_key, created_at, updated_at, dedupe_key, hot_paths_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          dedupeKey,
          hotPaths === null || hotPaths.length === 0 ? null : JSON.stringify(hotPaths),
        );
        if (preds.length > 0 && wouldCycle(preds)) throw new Error("dependency cycle");
        for (const pred of preds) {
          if (getWorkItemFixed(pred) === undefined) throw new Error(`unknown predecessor ${pred}`);
          db.prepare(`INSERT INTO project_work_dependency (successor_id, predecessor_id) VALUES (?, ?)`).run(id, pred);
        }
        appendEvent(id, "enqueued", { state: initialState }, at);
        if (initialState === "READY") appendEvent(id, "ready", undefined, at);
        notifyQueueChange(input.projectId);
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

    listWorkItemPredecessors(workItemId) {
      return (
        db
          .prepare(`SELECT predecessor_id FROM project_work_dependency WHERE successor_id = ? ORDER BY predecessor_id`)
          .all(workItemId) as { predecessor_id: string }[]
      ).map((r) => r.predecessor_id);
    },

    cancelWorkItem(workItemId, byClientId, operator = false) {
      return immediate(() => {
        const item = getWorkItemFixed(workItemId);
        if (item === undefined) return undefined;
        if (!operator && item.creator_client_id !== byClientId) return undefined;
        if (item.state === "DONE" || item.state === "CANCELLED" || item.state === "FAILED_ADMISSION") return undefined;
        // ADMITTING: the scheduler is admitting it now; cancelling here could leave a run behind a CANCELLED item.
        if (item.state === "ADMITTED" || item.state === "ADMITTING") return undefined;
        const at = ts();
        const res = setState(workItemId, "CANCELLED", { terminal_at: at }, "cancelled");
        if (res !== undefined) notifyQueueChange(item.project_id);
        return res;
      });
    },

    claimReadyWorkItem(projectId) {
      return immediate(() => {
        // T15.7 (LLD §20.4): skip a READY item whose hot paths overlap those of a running item of the project
        // (ADMITTING, or ADMITTED with its run not yet terminal). Items without hot paths never overlap.
        const running = (
          db
            .prepare(
              `SELECT hot_paths_json FROM project_work_item
               WHERE project_id = ? AND hot_paths_json IS NOT NULL
                 AND (state = 'ADMITTING' OR (state = 'ADMITTED' AND terminal_at IS NULL))`,
            )
            .all(projectId) as { hot_paths_json: string }[]
        ).map((r) => storedHotPaths(r.hot_paths_json));
        const ready = db
          .prepare(
            `SELECT ${ITEM_COLS} FROM project_work_item
             WHERE project_id = ? AND state = 'READY'
             ORDER BY priority DESC, created_at ASC, id ASC`,
          )
          .all(projectId) as WorkItemRow[];
        let row: WorkItemRow | undefined;
        for (const candidate of ready) {
          const mine = storedHotPaths(candidate.hot_paths_json);
          if (mine.length > 0 && running.some((r) => hotPathsOverlap(mine, r))) continue;
          row = candidate;
          break;
        }
        if (row === undefined) return undefined;
        const at = ts();
        const n = db
          .prepare(`UPDATE project_work_item SET state = 'ADMITTING', updated_at = ? WHERE id = ? AND state = 'READY'`)
          .run(at, row.id).changes;
        if (n === 0) return undefined;
        notifyQueueChange(projectId);
        return getWorkItemFixed(row.id);
      });
    },

    releaseAdmittingToReady(workItemId) {
      return immediate(() => {
        const item = getWorkItemFixed(workItemId);
        if (item === undefined || item.state !== "ADMITTING") return false;
        setState(workItemId, "READY", {}, "ready", { retry: true });
        notifyQueueChange(item.project_id);
        return true;
      });
    },

    completeWorkAdmission(workItemId, outcome) {
      return immediate(() => {
        const item = getWorkItemFixed(workItemId);
        if (item === undefined || item.state !== "ADMITTING") return undefined;
        if (outcome.kind === "retry") {
          setState(workItemId, "READY", {}, "ready", { admission_retry: true });
          notifyQueueChange(item.project_id);
          return getWorkItemFixed(workItemId);
        }
        if (outcome.kind === "failed") {
          const at = ts();
          const res = setState(
            workItemId,
            "FAILED_ADMISSION",
            { last_error_code: outcome.code, terminal_at: at },
            "admission_failed",
            { code: outcome.code },
          );
          notifyQueueChange(item.project_id);
          return res;
        }
        const admitted = setState(workItemId, "ADMITTED", { admitted_run_id: outcome.runId }, "admitted", {
          run_id: outcome.runId,
        });
        notifyQueueChange(item.project_id);
        return admitted;
      });
    },

    markWorkItemDone,

    closeWorkItemForRun(runId, runState) {
      return immediate(() => {
        const item = db.prepare(`SELECT ${ITEM_COLS} FROM project_work_item WHERE admitted_run_id = ?`).get(runId) as
          | WorkItemRow
          | undefined;
        if (item === undefined || item.state !== "ADMITTED" || item.terminal_at !== null) return undefined;
        if (runState === "SUCCEEDED") return markWorkItemDone(item.id);
        // No state or event fits (the 0017 CHECKs are closed): stamp terminal_at only. Successors stay PENDING.
        const at = ts();
        db.prepare(`UPDATE project_work_item SET terminal_at = ?, updated_at = ? WHERE id = ?`).run(at, at, item.id);
        notifyQueueChange(item.project_id);
        return getWorkItemFixed(item.id);
      });
    },

    reconcileAdmittingWorkItems() {
      return immediate(() => {
        const rows = db
          .prepare(`SELECT id FROM project_work_item WHERE state = 'ADMITTING' AND admitted_run_id IS NULL`)
          .all() as { id: string }[];
        let n = 0;
        const pids = new Set<string>();
        for (const { id } of rows) {
          const item = getWorkItemFixed(id);
          if (setState(id, "READY", {}, "ready", { reconcile: true }) !== undefined) {
            n++;
            if (item) pids.add(item.project_id);
          }
        }
        for (const pid of pids) notifyQueueChange(pid);
        return n;
      });
    },

    setQueueChangeListener(listener) {
      queueChangeListener = listener;
    },

    readProgressStallFacts(projectId) {
      const ready = db
        .prepare(
          "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM project_work_item WHERE project_id = ? AND state = 'READY'",
        )
        .get(projectId) as { n: number; oldest: string | null };
      const done = db
        .prepare("SELECT MAX(terminal_at) AS last FROM project_work_item WHERE project_id = ? AND state = 'DONE'")
        .get(projectId) as { last: string | null };
      return { readyCount: ready.n, oldestReadyCreatedAt: ready.oldest, lastDoneAt: done.last };
    },

    countWorkItemsByState() {
      const rows = db.prepare("SELECT state, COUNT(*) AS n FROM project_work_item GROUP BY state").all() as {
        state: WorkItemState;
        n: number;
      }[];
      return Object.fromEntries(rows.map((r) => [r.state, r.n]));
    },

    insertRunRebase(input) {
      const at = ts();
      db.prepare(
        `INSERT INTO run_rebase (run_id, work_item_id, publish_ref, head_sha, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(input.runId, input.workItemId, input.publishRef, input.headSha, at, at);
    },

    getRunRebase(runId) {
      return db.prepare("SELECT * FROM run_rebase WHERE run_id = ?").get(runId) as RunRebaseRow | undefined;
    },

    findRunRebaseForWorkItem(workItemId) {
      return db
        .prepare("SELECT * FROM run_rebase WHERE work_item_id = ? ORDER BY created_at, run_id LIMIT 1")
        .get(workItemId) as RunRebaseRow | undefined;
    },

    getRefConflictForWorkItem(workItemId) {
      return db.prepare("SELECT * FROM ci_ref_conflict WHERE work_item_id = ?").get(workItemId) as
        | RefConflictRow
        | undefined;
    },

    countAdmissibleWorkItems(projectId) {
      return immediate(() => {
        const items = db
          .prepare(
            `SELECT ${ITEM_COLS} FROM project_work_item
             WHERE project_id = ? AND state IN ('READY', 'PENDING')`,
          )
          .all(projectId) as WorkItemRow[];
        if (items.length === 0) return 0;

        const canSucceedMemo = new Map<string, boolean>();

        const canItemSucceed = (id: string, visited: Set<string>): boolean => {
          const cached = canSucceedMemo.get(id);
          if (cached !== undefined) return cached;
          if (visited.has(id)) return false;
          visited.add(id);

          const item = getWorkItemFixed(id);
          if (item === undefined) {
            canSucceedMemo.set(id, false);
            return false;
          }
          if (
            item.state === "DONE" ||
            item.state === "READY" ||
            item.state === "ADMITTING" ||
            (item.state === "ADMITTED" && item.terminal_at === null)
          ) {
            canSucceedMemo.set(id, true);
            return true;
          }
          // A closed ADMITTED item (its run FAILED or was CANCELLED) never becomes DONE either.
          if (item.state === "CANCELLED" || item.state === "FAILED_ADMISSION" || item.state === "ADMITTED") {
            canSucceedMemo.set(id, false);
            return false;
          }
          if (item.state === "PENDING") {
            const preds = db
              .prepare(`SELECT predecessor_id FROM project_work_dependency WHERE successor_id = ?`)
              .all(id) as { predecessor_id: string }[];
            for (const { predecessor_id } of preds) {
              if (!canItemSucceed(predecessor_id, visited)) {
                canSucceedMemo.set(id, false);
                return false;
              }
            }
            canSucceedMemo.set(id, true);
            return true;
          }
          canSucceedMemo.set(id, false);
          return false;
        };

        let count = 0;
        for (const item of items) {
          if (item.state === "READY") {
            count++;
          } else if (item.state === "PENDING") {
            const preds = db
              .prepare(`SELECT predecessor_id FROM project_work_dependency WHERE successor_id = ?`)
              .all(item.id) as { predecessor_id: string }[];
            let met = true;
            for (const { predecessor_id } of preds) {
              if (!canItemSucceed(predecessor_id, new Set<string>([item.id]))) {
                met = false;
                break;
              }
            }
            if (met) count++;
          }
        }
        return count;
      });
    },
  };
}
