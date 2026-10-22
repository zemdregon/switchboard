/**
 * Migration 0034 (ADR-0071): the project setup step's log.
 *
 * Widens the `artifact.kind` check to allow `'setup_log'`: the redacted, bounded output of a run's dependency setup
 * commands (argv, exit status, stdout and stderr per command). SQLite cannot alter a CHECK, so this is the table-rebuild
 * step of migrations 0016, 0022 and 0027 (LLD §1), applied with foreign keys off and a `foreign_key_check` before commit
 * (`Migration.foreignKeysOff`); rows, ids and order are kept and the `artifact_run` index is recreated.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE artifact_new (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'art\\_%' ESCAPE '\\'),
  run_id      TEXT REFERENCES run(id),
  meta_session_id TEXT REFERENCES meta_session(id),
  kind        TEXT NOT NULL CHECK (kind IN ('provider_stdout','provider_stderr','diff','test_report',
                'changed_files','log_summary','handoff_view','pr_draft','handoff_condense','seed_log',
                'docs_alignment','setup_log')),
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
