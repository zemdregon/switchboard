/**
 * Migration 0017 (T15.1; FR-QUE-01, LLD §18.2–18.3, ADR-0005): durable per-project work queue tables
 * (`project_work_item`, `project_work_dependency`, `project_work_event`). Immutable once released: the checksum of this
 * text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE project_work_item (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  creator_client_id TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
                      'PENDING','READY','ADMITTING','ADMITTED','DONE','CANCELLED','FAILED_ADMISSION')),
  priority          INTEGER NOT NULL DEFAULT 0,
  request_json      TEXT NOT NULL,
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('mcp','schedule','ci_trigger')),
  source_id         TEXT,
  idempotency_key   TEXT,
  admitted_run_id   TEXT,
  last_error_code   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  terminal_at       TEXT
) STRICT;

CREATE INDEX project_work_item_project_state_prio
  ON project_work_item (project_id, state, priority DESC, created_at, id);

CREATE UNIQUE INDEX project_work_item_creator_idem
  ON project_work_item (creator_client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE project_work_dependency (
  successor_id    TEXT NOT NULL REFERENCES project_work_item(id),
  predecessor_id  TEXT NOT NULL REFERENCES project_work_item(id),
  PRIMARY KEY (successor_id, predecessor_id)
) STRICT;

CREATE TABLE project_work_event (
  id            TEXT PRIMARY KEY,
  work_item_id  TEXT NOT NULL REFERENCES project_work_item(id),
  type          TEXT NOT NULL CHECK (type IN (
                  'enqueued','ready','admitted','done','cancelled','admission_failed')),
  detail_json   TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX project_work_event_item ON project_work_event (work_item_id, created_at);
`;
