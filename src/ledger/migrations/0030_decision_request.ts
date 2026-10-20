/**
 * Migration 0030 (T14.15; FR-CTL-13, LLD §20.3): `decision_request`, one row per decision an MCP client asked the
 * operator for, and the work-queue changes that parking needs.
 *
 * - `decision_request`: the question, the two to six options (each a label and an action `resume`, `reroute`,
 *   `cancel` or `none`), the recommended option, the work items to enqueue on resolution (`enqueue_json`, the
 *   `enqueue_work` shape), the state (`open`, `decided`, `withdrawn`) and who resolved it. Question, option labels and
 *   note are untrusted client text, length-capped here as well as at the MCP boundary. At most one open decision per
 *   work item (partial unique index).
 * - `project_work_item.state` gains `PARKED_DECISION` (not admitted while its decision is open, LLD §18.2) and
 *   `source_kind` gains `decision` (an item a decision enqueued; `source_id` is the decision id).
 * - `project_work_event.type` gains `parked` and `unparked`.
 *
 * SQLite cannot alter a CHECK, so both work-queue tables are rebuilt with the step of migration 0016 (LLD §1), applied
 * with foreign keys off and a `foreign_key_check` before commit (`Migration.foreignKeysOff`); rows, ids and order are
 * kept, and the 0017 indexes and the T15.7 columns and dedupe index of migration 0029 are recreated as they were. Immutable once released: the checksum of this text is recorded
 * in `schema_migrations`.
 */
export const sql = `
CREATE TABLE project_work_item_new (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  creator_client_id TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
                      'PENDING','READY','ADMITTING','ADMITTED','DONE','CANCELLED','FAILED_ADMISSION',
                      'PARKED_DECISION')),
  priority          INTEGER NOT NULL DEFAULT 0,
  request_json      TEXT NOT NULL,
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('mcp','schedule','ci_trigger','decision')),
  source_id         TEXT,
  idempotency_key   TEXT,
  admitted_run_id   TEXT,
  last_error_code   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  terminal_at       TEXT,
  dedupe_key        TEXT,
  hot_paths_json    TEXT,
  superseded_by     TEXT
) STRICT;

INSERT INTO project_work_item_new (id, project_id, creator_client_id, state, priority, request_json, source_kind,
  source_id, idempotency_key, admitted_run_id, last_error_code, created_at, updated_at, terminal_at, dedupe_key,
  hot_paths_json, superseded_by)
SELECT id, project_id, creator_client_id, state, priority, request_json, source_kind, source_id, idempotency_key,
  admitted_run_id, last_error_code, created_at, updated_at, terminal_at, dedupe_key, hot_paths_json, superseded_by
FROM project_work_item ORDER BY rowid;

CREATE TABLE project_work_event_new (
  id            TEXT PRIMARY KEY,
  work_item_id  TEXT NOT NULL REFERENCES project_work_item(id),
  type          TEXT NOT NULL CHECK (type IN (
                  'enqueued','ready','admitted','done','cancelled','admission_failed','parked','unparked')),
  detail_json   TEXT,
  created_at    TEXT NOT NULL
) STRICT;

INSERT INTO project_work_event_new (id, work_item_id, type, detail_json, created_at)
SELECT id, work_item_id, type, detail_json, created_at FROM project_work_event ORDER BY rowid;

DROP TABLE project_work_event;
DROP TABLE project_work_item;
ALTER TABLE project_work_item_new RENAME TO project_work_item;
ALTER TABLE project_work_event_new RENAME TO project_work_event;

CREATE INDEX project_work_item_project_state_prio
  ON project_work_item (project_id, state, priority DESC, created_at, id);

CREATE UNIQUE INDEX project_work_item_creator_idem
  ON project_work_item (creator_client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX project_work_item_dedupe
  ON project_work_item (project_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND superseded_by IS NULL
    AND state NOT IN ('CANCELLED', 'FAILED_ADMISSION')
    AND (state = 'DONE' OR terminal_at IS NULL);

CREATE INDEX project_work_event_item ON project_work_event (work_item_id, created_at);

CREATE TABLE decision_request (
  id                  TEXT PRIMARY KEY CHECK (id LIKE 'dec\\_%' ESCAPE '\\'),
  project_id          TEXT NOT NULL,
  work_item_id        TEXT REFERENCES project_work_item(id),
  requester_client_id TEXT NOT NULL,
  question            TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  options_json        TEXT NOT NULL,
  recommended_option  INTEGER NOT NULL CHECK (recommended_option BETWEEN 1 AND 6),
  enqueue_json        TEXT NOT NULL DEFAULT '[]',
  state               TEXT NOT NULL CHECK (state IN ('open','decided','withdrawn')),
  decided_option      INTEGER CHECK (decided_option IS NULL OR decided_option BETWEEN 1 AND 6),
  decided_by          TEXT,
  note                TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at          TEXT NOT NULL,
  decided_at          TEXT,
  CHECK ((state = 'open') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK ((state = 'decided') = (decided_option IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX decision_request_open_item
  ON decision_request (work_item_id)
  WHERE state = 'open' AND work_item_id IS NOT NULL;

CREATE INDEX decision_request_project_state ON decision_request (project_id, state, created_at, id);
`;
