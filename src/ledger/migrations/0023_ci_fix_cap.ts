/**
 * Migration 0023 (T15.5; FR-QUE-05, LLD §18.6, ADR-0050): CI-fix cap and trigger audit trail.
 *
 * `ci_trigger_event`: records observations for dedup and audit (LLD §18.6). If a fix-up item is enqueued,
 * `work_item_id` points to the `que_*` row; when consecutive fixes reach `ci_trigger.max_consecutive_fixes`,
 * further failures are recorded here with `work_item_id IS NULL` and no work item is enqueued.
 *
 * `ci_trigger_ref_state`: mutable per-(project, publish_ref) consecutive fix counter and stuck flag.
 * Counter resets to 0 when CI passes on the ref or when the operator resets it.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE ci_trigger_event (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  publish_ref       TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  conclusion        TEXT NOT NULL,
  untrusted_summary TEXT,
  observed_at       TEXT NOT NULL,
  work_item_id      TEXT,
  UNIQUE (project_id, external_id)
) STRICT;

CREATE INDEX ci_trigger_event_project_ref
  ON ci_trigger_event (project_id, publish_ref, observed_at);

CREATE TABLE ci_trigger_ref_state (
  project_id        TEXT NOT NULL,
  publish_ref       TEXT NOT NULL,
  consecutive_fixes INTEGER NOT NULL DEFAULT 0,
  stuck             INTEGER NOT NULL DEFAULT 0 CHECK (stuck IN (0, 1)),
  last_external_id  TEXT,
  last_conclusion   TEXT,
  reset_at          TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (project_id, publish_ref)
) STRICT;
`;
