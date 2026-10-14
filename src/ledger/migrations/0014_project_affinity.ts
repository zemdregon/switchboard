/**
 * Migration 0014 (T7.4; FR-RTE-06, FR-RTE-07, LLD §3.2, §17.6, ADR-0032, ADR-0044): `project_affinity`, the provider and
 * model each project is routed to (one mutable row per project key). History stays in the append-only `route_decision`
 * rows and the `routing_affinity_*` run events. The reason column holds only the closed `affinity_switch_reason` list
 * (FR-RTE-07); `reset_requested_at` and `reset_by` record a pending operator `affinity reset` (LLD §17.6).
 *
 * `last_run_id` has no foreign key (Delegated, T7.4): retention GC deletes old runs without knowing about this table, and
 * a row naming a removed run must not block it; the run id is informational.
 *
 * Additive and forward-only; no existing table changes. A released migration is immutable (ADR-0005): the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE project_affinity (
  project_key        TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  model              TEXT,
  since              TEXT NOT NULL,
  last_run_id        TEXT,
  last_switch_reason TEXT CHECK (last_switch_reason IS NULL OR last_switch_reason IN
                       ('user_request','capacity_exhausted','ineligible','failed_after_retry')),
  reset_requested_at TEXT,
  reset_by           TEXT,
  updated_at         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 0
) STRICT;
`;
