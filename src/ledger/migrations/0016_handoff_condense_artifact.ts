/**
 * Migration 0016 (T11.10; FR-INN-13, LLD §13.6 `handoff_condense`, ADR-0016, ADR-0005): widens the `artifact.kind`
 * check to allow `'handoff_condense'`, the labelled condensation stored beside a `handoff_view`. The raw handoff view
 * is not rewritten (FR-SES-05). SQLite cannot alter a CHECK, so this is the table-rebuild step (LLD §1): create the
 * widened table, copy every row unchanged, drop the old table, rename, then recreate `artifact_run` as in migration
 * 0001. `artifact` is referenced by `run_event.artifact_id`, so the runner applies this with foreign keys off and
 * verifies `foreign_key_check` before commit (`Migration.foreignKeysOff`). No other table changes. Immutable once
 * released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE artifact_new (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'art\\_%' ESCAPE '\\'),
  run_id      TEXT REFERENCES run(id),
  meta_session_id TEXT REFERENCES meta_session(id),
  kind        TEXT NOT NULL CHECK (kind IN ('provider_stdout','provider_stderr','diff','test_report',
                'changed_files','log_summary','handoff_view','pr_draft','handoff_condense')),
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  media_type  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
) STRICT;

INSERT INTO artifact_new (id, run_id, meta_session_id, kind, sha256, size_bytes, media_type, created_at, deleted_at)
SELECT id, run_id, meta_session_id, kind, sha256, size_bytes, media_type, created_at, deleted_at
FROM artifact ORDER BY rowid;

DROP TABLE artifact;
ALTER TABLE artifact_new RENAME TO artifact;

CREATE INDEX artifact_run ON artifact(run_id, kind);
`;
