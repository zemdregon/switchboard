/**
 * Migration 0005 (T11.1; FR-INN-15, FR-INN-16, LLD §13.3, ADR-0016, ADR-0005): the append-only `inner_call` table, one
 * row per inner-agent call outcome. Additive and forward-only; no existing table changes.
 *
 * Deliberately NOT in this migration (Delegated; LLD §1 "M11 additions" describes one migration for all of it, but a
 * released migration is immutable, ADR-0005, so each piece ships as its own forward migration with the ROADMAP task that
 * first needs it): `inner_task_state`, the mutable per-task suspension state (FR-INN-09; T11.6); the `git_commit`
 * columns (T11.4); the `inner_agent` value of the `usage_observation.source` check (T11.5); and the `pr_draft` value of
 * the `artifact.kind` check (T11.8). The two check widenings need the migration runner's table-rebuild step.
 *
 * No prompt or response body is stored in any column (FR-INN-16): sizes and a hash only. `reason` is a short code, never
 * free text. The table has the `BEFORE UPDATE` / `BEFORE DELETE` guards of the other append-only tables. Immutable once
 * released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = String.raw`
CREATE TABLE inner_call (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'inc\_%' ESCAPE '\'),
  task            TEXT NOT NULL CHECK (task IN ('commit_message','pr_draft','route_features','handoff_condense',
                    'log_summary','run_title')),
  backend_kind    TEXT NOT NULL CHECK (backend_kind IN ('http','cli')),
  model_id        TEXT NOT NULL,
  locality        TEXT NOT NULL CHECK (locality IN ('local','remote')),
  template_version TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('accepted','rejected_validator','rejected_sanitiser',
                    'fallback_unavailable','fallback_suspended','fallback_disabled')),
  reason          TEXT,
  attempts        INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 2),
  latency_ms      INTEGER NOT NULL CHECK (latency_ms >= 0),
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  input_bytes     INTEGER NOT NULL CHECK (input_bytes >= 0),
  output_bytes    INTEGER NOT NULL CHECK (output_bytes >= 0),
  input_sha256    TEXT NOT NULL,
  run_id          TEXT REFERENCES run(id),
  meta_session_id TEXT REFERENCES meta_session(id),
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX inner_call_task_time ON inner_call(task, created_at);
CREATE INDEX inner_call_run ON inner_call(run_id);

CREATE TRIGGER inner_call_no_update BEFORE UPDATE ON inner_call
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER inner_call_no_delete BEFORE DELETE ON inner_call
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
