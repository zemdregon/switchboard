/**
 * Migration 0022 (T9.13; FR-WS-10, LLD §5.1, ADR-0057, ADR-0005): the dependency seed store's records. `dependency_seed`
 * is one row per store entry (key, state `building | ready | evicting`, the builder's process for reconciliation, size
 * and last use); `dependency_seed_use` is one row per seeded directory of a run (method, and when the early disk sweep
 * removed a private copy). A use has no foreign key to its entry: the entry row is deleted on eviction, the use is
 * history. `directory` (the seeded directory, worktree-relative) is recorded on the use so the early sweep can remove
 * the private copy without the project's configuration.
 *
 * It also widens the `artifact.kind` check to allow `'seed_log'` (the build output of a seed, like a `test_report`).
 * SQLite cannot alter a CHECK, so that part is the table-rebuild step of migration 0016 (LLD §1), applied with foreign
 * keys off and a `foreign_key_check` before commit (`Migration.foreignKeysOff`). No other table changes. Immutable once
 * released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE artifact_new (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'art\\_%' ESCAPE '\\'),
  run_id      TEXT REFERENCES run(id),
  meta_session_id TEXT REFERENCES meta_session(id),
  kind        TEXT NOT NULL CHECK (kind IN ('provider_stdout','provider_stderr','diff','test_report',
                'changed_files','log_summary','handoff_view','pr_draft','handoff_condense','seed_log')),
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

CREATE TABLE dependency_seed (
  seed_key            TEXT PRIMARY KEY CHECK (length(seed_key) = 64),
  project_id          TEXT NOT NULL,
  seed_id             TEXT NOT NULL,
  lockfile_sha256     TEXT NOT NULL,
  profile             TEXT NOT NULL,
  environment         TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('building','ready','evicting')),
  builder_run_id      TEXT,
  builder_pid         INTEGER,
  builder_pgid        INTEGER,
  builder_start_ticks TEXT,
  size_bytes          INTEGER,
  created_at          TEXT NOT NULL,
  ready_at            TEXT,
  last_used_at        TEXT,
  evict_intent_at     TEXT
) STRICT;

CREATE INDEX dependency_seed_lru ON dependency_seed(state, last_used_at, created_at);

CREATE TABLE dependency_seed_use (
  run_id        TEXT NOT NULL REFERENCES run(id),
  seed_key      TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  directory     TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('clone','copy','mount','existing')),
  populated_at  TEXT NOT NULL,
  removed_at    TEXT,
  PRIMARY KEY (run_id, seed_key)
) STRICT;

CREATE INDEX dependency_seed_use_key ON dependency_seed_use(seed_key);
`;
