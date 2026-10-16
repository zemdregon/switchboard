/**
 * Control-plane pause persistence (T14.6; FR-CTL-05, LLD §3.4.4, §3.4.7): the `control_plane_state` rows and the
 * append-only `control_plane_event` operator signals of migration 0018. A ledger slice as `work-queue.ts`, spread into
 * {@link Ledger}. The admission gate, the MCP tools and the CLI live in `src/control/pause.ts`; this file only reads and
 * writes rows.
 *
 * Proposed (Delegated, T14.6):
 * - The global row is `project_id = '*'` ({@link GLOBAL_PAUSE_SCOPE}); the LLD's `control_plane.global_paused` is that
 *   row, not a configuration key.
 * - `setPaused` upserts and never touches `budget_flags_json` (T14.4's column). On resume `paused_by` and `paused_at`
 *   record who resumed and when, so the row always says who last changed it.
 * - A pending operator request is a `*_requested` event with no `operator_pause_applied` event naming it in
 *   `payload.request_event_id`, the convention of `src/cli/operator.ts`.
 */

import type Database from "better-sqlite3";
import type { IdGenerator } from "../ids/index.js";

/** `control_plane_state.project_id` of the operator's global pause (LLD §3.4.7). */
export const GLOBAL_PAUSE_SCOPE = "*";

export const OPERATOR_PAUSE_REQUESTED = "operator_pause_requested";
export const OPERATOR_RESUME_REQUESTED = "operator_resume_requested";
export const OPERATOR_PAUSE_APPLIED = "operator_pause_applied";

export type ControlPlaneEventType =
  | typeof OPERATOR_PAUSE_REQUESTED
  | typeof OPERATOR_RESUME_REQUESTED
  | typeof OPERATOR_PAUSE_APPLIED;

export interface ControlPlaneStateRow {
  project_id: string;
  paused: 0 | 1;
  paused_by: string | null;
  paused_at: string | null;
  budget_flags_json: string | null;
}

export interface ControlPlaneEventRow {
  id: string;
  ts: string;
  type: ControlPlaneEventType;
  scope: string;
  payload_json: string;
}

/** An operator `pause` / `resume` recorded by the CLI and not yet applied. */
export interface PendingPauseRequest {
  readonly requestEventId: string;
  readonly scope: string;
  readonly paused: boolean;
  readonly requestedAt: string;
  readonly requestedBy: string;
}

export interface ControlPlaneLedgerSlice {
  /** T14.6: the row of `projectId` (or `'*'`), or undefined when none was ever written (not paused). Read-only. */
  getControlPlaneState(projectId: string): ControlPlaneStateRow | undefined;
  /** T14.6: set the pause flag of `projectId` (or `'*'`), recording who and when; `budget_flags_json` is untouched. */
  setPaused(input: { projectId: string; paused: boolean; by: string }): ControlPlaneStateRow;
  /** T14.6: append one operator signal. */
  appendControlPlaneEvent(input: {
    type: ControlPlaneEventType;
    scope: string;
    payload?: unknown;
  }): ControlPlaneEventRow;
  /** T14.6: every event of `scope`, oldest first. Read-only. */
  listControlPlaneEvents(scope: string): ControlPlaneEventRow[];
  /** T14.6: recorded `pause` / `resume` requests with no `operator_pause_applied` event yet, oldest first. Read-only. */
  listPendingPauseRequests(scope?: string): PendingPauseRequest[];
}

const STATE_COLS = "project_id, paused, paused_by, paused_at, budget_flags_json";
const EVENT_COLS = "id, ts, type, scope, payload_json";

export function createControlPlaneLedgerSlice(
  db: Database.Database,
  deps: { ids: IdGenerator; ts: () => string; immediate: <T>(fn: () => T) => T },
): ControlPlaneLedgerSlice {
  const { ids, ts, immediate } = deps;
  const get = (projectId: string) =>
    db.prepare(`SELECT ${STATE_COLS} FROM control_plane_state WHERE project_id = ?`).get(projectId) as
      | ControlPlaneStateRow
      | undefined;

  return {
    getControlPlaneState: get,

    setPaused({ projectId, paused, by }) {
      return immediate(() => {
        db.prepare(
          `INSERT INTO control_plane_state (project_id, paused, paused_by, paused_at, budget_flags_json)
           VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT (project_id) DO UPDATE SET paused = excluded.paused, paused_by = excluded.paused_by,
             paused_at = excluded.paused_at`,
        ).run(projectId, paused ? 1 : 0, by, ts());
        return get(projectId) as ControlPlaneStateRow;
      });
    },

    appendControlPlaneEvent({ type, scope, payload }) {
      const row: ControlPlaneEventRow = {
        id: ids.id("cpe"),
        ts: ts(),
        type,
        scope,
        payload_json: JSON.stringify(payload ?? {}),
      };
      db.prepare(`INSERT INTO control_plane_event (${EVENT_COLS}) VALUES (?, ?, ?, ?, ?)`).run(
        row.id,
        row.ts,
        row.type,
        row.scope,
        row.payload_json,
      );
      return row;
    },

    listControlPlaneEvents(scope) {
      return db
        .prepare(`SELECT ${EVENT_COLS} FROM control_plane_event WHERE scope = ? ORDER BY ts, id`)
        .all(scope) as ControlPlaneEventRow[];
    },

    listPendingPauseRequests(scope) {
      const rows = db
        .prepare(
          `SELECT ${EVENT_COLS} FROM control_plane_event e
           WHERE e.type IN (?, ?) ${scope === undefined ? "" : "AND e.scope = ?"}
             AND NOT EXISTS (SELECT 1 FROM control_plane_event a
                             WHERE a.type = ? AND a.scope = e.scope
                               AND json_extract(a.payload_json, '$.request_event_id') = e.id)
           ORDER BY e.ts, e.id`,
        )
        .all(
          OPERATOR_PAUSE_REQUESTED,
          OPERATOR_RESUME_REQUESTED,
          ...(scope === undefined ? [] : [scope]),
          OPERATOR_PAUSE_APPLIED,
        ) as ControlPlaneEventRow[];
      return rows.map((r) => {
        const p = JSON.parse(r.payload_json) as { requested_by?: unknown };
        return {
          requestEventId: r.id,
          scope: r.scope,
          paused: r.type === OPERATOR_PAUSE_REQUESTED,
          requestedAt: r.ts,
          requestedBy: typeof p.requested_by === "string" && p.requested_by !== "" ? p.requested_by : "unknown",
        };
      });
    },
  };
}
