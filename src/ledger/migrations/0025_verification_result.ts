/**
 * Migration 0025 (T8.10; FR-EXE-10, FR-SKL-11, LLD §20.6): head-pinned verification evidence.
 *
 * `verification_result`: one row per finished verification stage (FR-EXE-08) that stored its `test_report`. It records
 * the run's publish ref, the commit the controller read before the stage (`head_sha`, NULL when the worktree's tree
 * differed from that commit's tree or could not be read) and the worktree tree (`tree_sha`, NULL when it could not be
 * computed). Results are keyed by `(publish_ref, head_sha)`, never by a file name (LLD §20.6). Append-only.
 *
 * It also widens the `artifact.kind` check to allow `'docs_alignment'` (the report of the example docs-alignment skill,
 * FR-SKL-11). SQLite cannot alter a CHECK, so that part is the table-rebuild step of migrations 0016 and 0022 (LLD §1),
 * applied with foreign keys off and a `foreign_key_check` before commit (`Migration.foreignKeysOff`).
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
                'docs_alignment')),
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

CREATE TABLE verification_result (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'vrs\\_%' ESCAPE '\\'),
  run_id          TEXT NOT NULL REFERENCES run(id),
  meta_session_id TEXT NOT NULL REFERENCES meta_session(id),
  publish_ref     TEXT NOT NULL,
  head_sha        TEXT,
  tree_sha        TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('passed','failed','cancelled','timeout')),
  artifact_id     TEXT REFERENCES artifact(id),
  created_at      TEXT NOT NULL,
  CHECK (head_sha IS NULL OR tree_sha IS NOT NULL)
) STRICT;

CREATE INDEX verification_result_head ON verification_result(publish_ref, head_sha);
CREATE INDEX verification_result_run ON verification_result(run_id, created_at);
`;
