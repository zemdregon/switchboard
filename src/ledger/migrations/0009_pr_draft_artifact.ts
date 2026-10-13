/**
 * Migration 0009 (T11.8; FR-INN-11, LLD §3 `get_artifacts`, LLD §13.3 T11.1 note, ADR-0016, ADR-0005): widens the
 * `artifact.kind` check from the seven kinds of migration 0001 to also allow `'pr_draft'`, the kind of the pull-request
 * title and description the PR-draft task stores. The number 0009 is reserved for this task; 0008 belongs to
 * `inner_task_state` (T11.6) and is applied in version order whichever lands first.
 *
 * SQLite cannot alter a CHECK, so this is the table-rebuild step (LLD §1): create the widened table, copy every row
 * unchanged (ids, timestamps and order preserved), drop the old table (its index goes with it), rename, then recreate
 * `artifact_run` exactly as in migration 0001. Unlike 0006, `artifact` IS referenced (`run_event.artifact_id`), so the
 * runner must apply this migration with foreign keys switched off (the SQLite-documented procedure) and verify
 * `foreign_key_check` before commit: see `Migration.foreignKeysOff` in `src/ledger/migrate.ts`. No other table changes
 * and `artifact` has no append-only trigger (retention GC sets `deleted_at`). Immutable once released: the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE artifact_new (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'art\\_%' ESCAPE '\\'),
  run_id      TEXT REFERENCES run(id),
  meta_session_id TEXT REFERENCES meta_session(id),
  kind        TEXT NOT NULL CHECK (kind IN ('provider_stdout','provider_stderr','diff','test_report',
                'changed_files','log_summary','handoff_view','pr_draft')),
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
