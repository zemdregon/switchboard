/**
 * Migration 0021 (T16.1; FR-SKL-01, FR-SKL-07, FR-SKL-10, LLD §19.2, ADR-0056 item 11): the skill store tables.
 *
 * `skill_version` and `skill_event` are append-only (BEFORE UPDATE / DELETE triggers, as for `run_event`); with
 * `recursive_triggers = ON` (db.ts, Q-96) an `INSERT OR REPLACE` cannot rewrite a row either. `run_skill` is written
 * at admission (T16.4) and its delivery and removal columns are filled in later (T16.6), so it is not append-only.
 * Columns are exactly LLD §19.2. Skill content is a file under `<data_dir>/skills/<sha256>.md`, never a column.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE skill_version (
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL CHECK (version >= 1),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes  INTEGER NOT NULL,
  description TEXT NOT NULL,
  applies_to  TEXT,
  origin      TEXT NOT NULL CHECK (origin IN ('operator_file','repository_path')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

CREATE TABLE skill_event (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  version     INTEGER,
  kind        TEXT NOT NULL CHECK (kind IN ('added','approved','revoked','retired','unretired')),
  actor       TEXT NOT NULL,
  note        TEXT,
  at          TEXT NOT NULL
);

CREATE TABLE run_skill (
  run_id        TEXT NOT NULL REFERENCES run(id),
  position      INTEGER NOT NULL,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('global_default','global_role','project_default','project_role',
                                                'request','continued')),
  delivery      TEXT NOT NULL CHECK (delivery IN ('prompt_prefix','native','skipped')),
  native_path   TEXT,
  written_sha256 TEXT,
  delivered_at  TEXT,
  removed_at    TEXT,
  removal       TEXT CHECK (removal IN ('verified','failed','not_needed')),
  PRIMARY KEY (run_id, position)
);

CREATE TRIGGER skill_version_no_update BEFORE UPDATE ON skill_version
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER skill_version_no_delete BEFORE DELETE ON skill_version
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER skill_event_no_update BEFORE UPDATE ON skill_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER skill_event_no_delete BEFORE DELETE ON skill_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
