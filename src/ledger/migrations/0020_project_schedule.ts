/**
 * Migration 0019 (T15.2; FR-QUE-02, LLD §18.5, ADR-0005): project schedule table (`project_schedule`).
 *
 * Implements cron-style schedules firing into the project work queue. Schedules are off by default (`enabled = 0`).
 * Widening schedules from chat clients start in `approval_state = 'PENDING_APPROVAL'` and wait for operator approval
 * (discovery §8, LLD §18.5).
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE project_schedule (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  creator_client_id TEXT NOT NULL,
  cron_expr         TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  template_json     TEXT NOT NULL,
  last_fire_at      TEXT,
  created_at        TEXT NOT NULL,
  disabled_at       TEXT,
  approval_state    TEXT NOT NULL DEFAULT 'APPROVED' CHECK (approval_state IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED'))
) STRICT;

CREATE INDEX project_schedule_project
  ON project_schedule (project_id, created_at, id);
`;
