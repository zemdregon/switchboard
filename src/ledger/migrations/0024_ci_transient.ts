/**
 * Migration 0024 (T15.6; FR-QUE-06, LLD §20.1, ADR-0050 amendment 1): CI transient handling ledger events.
 *
 * `ci_rerun`: one row per (project, published ref, head SHA, job) whose failed jobs Switchboard asked `gh run rerun
 * --failed` to rerun. The primary key makes the rerun happen at most once per key, also across a restart: the row is
 * written before the `gh` call, so a crash between the two can never cause a second rerun. `attempt` is the run attempt
 * the rerun was requested from (an older or equal attempt seen later is the rerun not yet visible); `outcome` is
 * `requested`, or `gh_failed` when the `gh` call itself failed (the key is still spent: fail closed).
 *
 * `ci_run_cancel`: one row per queued run on a superseded head that Switchboard cancelled with `gh run cancel`.
 *
 * Both are audit rows: job names come from `gh` JSON and are untrusted; nothing else from `gh` is stored.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE ci_rerun (
  project_id    TEXT NOT NULL,
  publish_ref   TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  job_name      TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  attempt       INTEGER NOT NULL CHECK (attempt >= 1),
  outcome       TEXT NOT NULL CHECK (outcome IN ('requested', 'gh_failed')),
  requested_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, publish_ref, head_sha, job_name)
) STRICT;

CREATE INDEX ci_rerun_run ON ci_rerun (project_id, run_id);

CREATE TABLE ci_run_cancel (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  publish_ref   TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('cancelled', 'gh_failed')),
  cancelled_at  TEXT NOT NULL,
  UNIQUE (project_id, run_id)
) STRICT;
`;
