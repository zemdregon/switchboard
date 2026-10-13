/**
 * Migration 0003 (T9.3; ADR-0025): the append-only provenance table `git_commit` (FR-GIT-07) and the append-only push
 * table `git_push` (FR-GIT-05). The DDL is copied from LLD §1 "M9 additions", which owns it, with two additions the LLD
 * records in its as-built note: a unique index on `(run_id, commit_sha)` (recovery after a crash can then re-insert
 * idempotently) and an index on `git_push(run_id)`. Both tables get the same `BEFORE UPDATE`/`DELETE` guards as the other
 * append-only tables (`<table>_no_update` / `<table>_no_delete`). Additive and forward-only: no existing table changes.
 * `project_revision` (T9.9) is not created here.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE git_commit (
  id              TEXT PRIMARY KEY,
  commit_sha      TEXT NOT NULL,
  tree_sha        TEXT NOT NULL,
  patch_id        TEXT,
  repo_root       TEXT NOT NULL,
  publish_ref     TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  context_id      TEXT NOT NULL,
  meta_session_id TEXT NOT NULL REFERENCES meta_session(id),
  run_id          TEXT NOT NULL REFERENCES run(id),
  provider        TEXT NOT NULL,
  harness         TEXT NOT NULL,
  model           TEXT,
  adapter_version_id TEXT REFERENCES adapter_version(id),
  origin          TEXT NOT NULL CHECK (origin IN ('commit_tool','finalize_only')),
  tool_event_id   TEXT REFERENCES run_event(id),
  sanitizer_json  TEXT NOT NULL CHECK (json_valid(sanitizer_json)),
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX git_commit_sha ON git_commit(commit_sha);
CREATE INDEX git_commit_run ON git_commit(run_id);
CREATE UNIQUE INDEX git_commit_run_sha ON git_commit(run_id, commit_sha);

CREATE TABLE git_push (
  id            TEXT PRIMARY KEY,
  run_id        TEXT REFERENCES run(id),
  project_id    TEXT NOT NULL,
  context_id    TEXT NOT NULL,
  remote        TEXT NOT NULL,
  ref           TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','REFUSED_POLICY','REJECTED_REMOTE','ERROR')),
  detail        TEXT,
  requested_by  TEXT NOT NULL CHECK (requested_by IN ('agent_tool','operator')),
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX git_push_run ON git_push(run_id);

CREATE TRIGGER git_commit_no_update BEFORE UPDATE ON git_commit
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER git_commit_no_delete BEFORE DELETE ON git_commit
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER git_push_no_update BEFORE UPDATE ON git_push
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER git_push_no_delete BEFORE DELETE ON git_push
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
