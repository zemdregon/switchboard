/**
 * Migration 0015 (T12.4; FR-RAG-11, FR-RAG-12, FR-RAG-14, LLD §14.10, ADR-0031, ADR-0046): the retrieval index's ledger
 * tables. Additive and forward-only; no existing table changes.
 *
 * `rag_record` is the LLD §14.10 table: append-only (the `BEFORE UPDATE` / `BEFORE DELETE` guards of the other
 * append-only tables), counts, durations and hashes only, never chunk text, a query or a vector (FR-RAG-12). `run_id`
 * has no foreign key (Delegated, as `project_affinity.last_run_id` in 0014): retention GC deletes old runs without
 * knowing about this table, and a record naming a removed run must not block it.
 *
 * `rag_request` holds the operator's `index rebuild` and `index clear` requests (ADR-0046): the CLI inserts a row, and the
 * `serve` daemon (or the CLI itself, for `clear`, when it holds the data-directory lock) applies it and sets
 * `applied_at`, `outcome` and `detail` once. A request is pending while `applied_at` is NULL.
 *
 * A released migration is immutable (ADR-0005): the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = String.raw`
CREATE TABLE rag_record (
  id               TEXT PRIMARY KEY CHECK (id LIKE 'rag\_%' ESCAPE '\'),
  kind             TEXT NOT NULL CHECK (kind IN ('index_built','retrieval','clear')),
  project_key      TEXT,
  run_id           TEXT,
  backend_kind     TEXT CHECK (backend_kind IS NULL OR backend_kind IN ('local','http')),
  model_id         TEXT,
  locality         TEXT CHECK (locality IS NULL OR locality IN ('local','remote')),
  outcome          TEXT NOT NULL,
  reason           TEXT,
  revision         INTEGER,
  files            INTEGER CHECK (files IS NULL OR files >= 0),
  chunks           INTEGER CHECK (chunks IS NULL OR chunks >= 0),
  bytes            INTEGER CHECK (bytes IS NULL OR bytes >= 0),
  snippet_ids_json TEXT CHECK (snippet_ids_json IS NULL OR json_valid(snippet_ids_json)),
  duration_ms      INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  embed_calls      INTEGER CHECK (embed_calls IS NULL OR embed_calls >= 0),
  created_at       TEXT NOT NULL
) STRICT;
CREATE INDEX rag_record_project_time ON rag_record(project_key, created_at);

CREATE TRIGGER rag_record_no_update BEFORE UPDATE ON rag_record
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER rag_record_no_delete BEFORE DELETE ON rag_record
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE rag_request (
  id           TEXT PRIMARY KEY CHECK (id LIKE 'rrq\_%' ESCAPE '\'),
  kind         TEXT NOT NULL CHECK (kind IN ('rebuild','clear')),
  store_kind   TEXT NOT NULL CHECK (store_kind IN ('project','global')),
  project_key  TEXT,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  applied_at   TEXT,
  outcome      TEXT CHECK (outcome IS NULL OR outcome IN ('applied','rejected')),
  detail       TEXT,
  CHECK ((store_kind = 'global') = (project_key IS NULL)),
  CHECK ((applied_at IS NULL) = (outcome IS NULL))
) STRICT;
CREATE INDEX rag_request_pending ON rag_request(applied_at, requested_at);
`;
