/**
 * Migration 0018 (T14.6; FR-CTL-05, LLD §3.4.4, §3.4.7, ADR-0005): control-plane pause persistence.
 *
 * `control_plane_state` is the LLD §3.4.7 table as written there: one mutable current-state row per project id, or
 * `'*'` for the operator's global pause. T14.6 owns the `paused*` columns; `budget_flags_json` is reserved for T14.4.
 *
 * `control_plane_event` is the append-only operator signal the LLD §3.4.4 leaves T14.6 to choose ("a dedicated
 * `control_plane_event` table"): the short-lived CLI records `operator_pause_requested` / `operator_resume_requested`
 * for scope `'*'`; the `serve` daemon (or the CLI itself when no daemon holds the data directory) applies it and records
 * the paired `operator_pause_applied`. `run_event` was not used because its rows reference a run and a global pause has
 * none. Append-only is enforced by the same `BEFORE UPDATE/DELETE` guards as `run_event` (LLD §1).
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = String.raw`
CREATE TABLE control_plane_state (
  project_id        TEXT PRIMARY KEY,
  paused            INTEGER NOT NULL CHECK (paused IN (0,1)),
  paused_by         TEXT,
  paused_at         TEXT,
  budget_flags_json TEXT CHECK (budget_flags_json IS NULL OR json_valid(budget_flags_json))
) STRICT;

CREATE TABLE control_plane_event (
  id            TEXT PRIMARY KEY CHECK (id LIKE 'cpe\_%' ESCAPE '\'),
  ts            TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN (
                  'operator_pause_requested','operator_resume_requested','operator_pause_applied')),
  scope         TEXT NOT NULL,
  payload_json  TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX control_plane_event_scope_ts ON control_plane_event (scope, ts, id);

CREATE TRIGGER control_plane_event_no_update BEFORE UPDATE ON control_plane_event
BEGIN SELECT RAISE(ABORT, 'control_plane_event is append-only'); END;

CREATE TRIGGER control_plane_event_no_delete BEFORE DELETE ON control_plane_event
BEGIN SELECT RAISE(ABORT, 'control_plane_event is append-only'); END;
`;
