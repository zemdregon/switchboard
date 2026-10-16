import type Database from "better-sqlite3";
import type { IdGenerator } from "../ids/index.js";
import { validateCronExpr } from "../schedule/cron.js";

export type ScheduleApprovalState = "PENDING_APPROVAL" | "APPROVED" | "REJECTED";

export interface ScheduleRow {
  id: string;
  project_id: string;
  creator_client_id: string;
  cron_expr: string;
  enabled: number;
  template_json: string;
  last_fire_at: string | null;
  created_at: string;
  disabled_at: string | null;
  approval_state: ScheduleApprovalState;
}

export interface CreateScheduleInput {
  id?: string;
  projectId: string;
  creatorClientId: string;
  cronExpr: string;
  template: unknown;
  enabled?: boolean;
  approvalState?: ScheduleApprovalState;
}

export interface ScheduleListFilter {
  projectId?: string;
  enabled?: boolean;
  approvalState?: ScheduleApprovalState;
}

export interface ScheduleLedgerSlice {
  createSchedule(input: CreateScheduleInput): ScheduleRow;
  getSchedule(id: string): ScheduleRow | undefined;
  listSchedules(filter?: ScheduleListFilter): ScheduleRow[];
  disableSchedule(id: string): ScheduleRow | undefined;
  enableSchedule(id: string): ScheduleRow | undefined;
  approveSchedule(id: string): ScheduleRow | undefined;
  denySchedule(id: string): ScheduleRow | undefined;
  updateScheduleLastFire(id: string, lastFireAt: string): ScheduleRow | undefined;
}

const SCHEDULE_COLS = `id, project_id, creator_client_id, cron_expr, enabled, template_json, last_fire_at,
  created_at, disabled_at, approval_state`;

export function createScheduleLedgerSlice(
  db: Database.Database,
  deps: { ids: IdGenerator; ts: () => string; immediate: <T>(fn: () => T) => T },
): ScheduleLedgerSlice {
  const { ids, ts, immediate } = deps;

  const getScheduleFixed = (id: string): ScheduleRow | undefined => {
    return db.prepare(`SELECT ${SCHEDULE_COLS} FROM project_schedule WHERE id = ?`).get(id) as ScheduleRow | undefined;
  };

  return {
    getSchedule: getScheduleFixed,

    createSchedule(input) {
      validateCronExpr(input.cronExpr);

      const templateJson =
        typeof input.template === "string"
          ? JSON.stringify(JSON.parse(input.template))
          : JSON.stringify(input.template);

      const approvalState = input.approvalState ?? "APPROVED";
      // Off by default (FR-QUE-02): enabled = 0 unless explicitly passed, and PENDING_APPROVAL is always 0
      const enabled = approvalState === "PENDING_APPROVAL" ? 0 : input.enabled === true ? 1 : 0;

      const id = input.id ?? ids.id("sch");
      const at = ts();

      return immediate(() => {
        db.prepare(
          `INSERT INTO project_schedule (
            id, project_id, creator_client_id, cron_expr, enabled, template_json,
            last_fire_at, created_at, disabled_at, approval_state
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
        ).run(id, input.projectId, input.creatorClientId, input.cronExpr, enabled, templateJson, at, approvalState);

        const created = getScheduleFixed(id);
        if (!created) {
          throw new Error(`failed to retrieve schedule row after insert: ${id}`);
        }
        return created;
      });
    },

    listSchedules(filter) {
      const where: string[] = [];
      const args: unknown[] = [];

      if (filter?.projectId !== undefined) {
        where.push("project_id = ?");
        args.push(filter.projectId);
      }
      if (filter?.enabled !== undefined) {
        where.push("enabled = ?");
        args.push(filter.enabled ? 1 : 0);
      }
      if (filter?.approvalState !== undefined) {
        where.push("approval_state = ?");
        args.push(filter.approvalState);
      }

      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      return db
        .prepare(`SELECT ${SCHEDULE_COLS} FROM project_schedule ${clause} ORDER BY created_at ASC, id ASC`)
        .all(...args) as ScheduleRow[];
    },

    disableSchedule(id) {
      return immediate(() => {
        const at = ts();
        const n = db
          .prepare("UPDATE project_schedule SET enabled = 0, disabled_at = ? WHERE id = ?")
          .run(at, id).changes;
        if (n === 0) return undefined;
        return getScheduleFixed(id);
      });
    },

    enableSchedule(id) {
      return immediate(() => {
        const existing = getScheduleFixed(id);
        if (existing === undefined) return undefined;
        if (existing.approval_state !== "APPROVED") {
          throw new Error(`cannot enable schedule in approval_state ${existing.approval_state}`);
        }
        const n = db
          .prepare("UPDATE project_schedule SET enabled = 1, disabled_at = NULL WHERE id = ?")
          .run(id).changes;
        if (n === 0) return undefined;
        return getScheduleFixed(id);
      });
    },

    approveSchedule(id) {
      return immediate(() => {
        const existing = getScheduleFixed(id);
        if (existing === undefined) return undefined;
        if (existing.approval_state !== "PENDING_APPROVAL") return existing;
        const n = db
          .prepare(
            "UPDATE project_schedule SET approval_state = 'APPROVED' WHERE id = ? AND approval_state = 'PENDING_APPROVAL'",
          )
          .run(id).changes;
        if (n === 0) return undefined;
        return getScheduleFixed(id);
      });
    },

    denySchedule(id) {
      return immediate(() => {
        const existing = getScheduleFixed(id);
        if (existing === undefined) return undefined;
        const at = ts();
        const n = db
          .prepare("UPDATE project_schedule SET approval_state = 'REJECTED', enabled = 0, disabled_at = ? WHERE id = ?")
          .run(at, id).changes;
        if (n === 0) return undefined;
        return getScheduleFixed(id);
      });
    },

    updateScheduleLastFire(id, lastFireAt) {
      return immediate(() => {
        const n = db.prepare("UPDATE project_schedule SET last_fire_at = ? WHERE id = ?").run(lastFireAt, id).changes;
        if (n === 0) return undefined;
        return getScheduleFixed(id);
      });
    },
  };
}
