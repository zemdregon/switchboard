/**
 * Migration 0031 (T15.8; FR-SUB-01, FR-SUB-02, LLD §20.7, ADR-0060): the opt-in merge policy and ref events.
 *
 * `merge_event`: one row per merge decision of the merge policy for a published ref's pull request. `outcome` is
 * `attempted` (written before `gh pr merge` runs, so a crash between the merge and its record still leaves a trace),
 * `merged` or `refused`; `reason` is from the closed list of LLD §20.7 (NULL for `attempted` and `merged`); `pr_number`
 * is NULL only for a refusal recorded before the pull request could be read (`gh_error`). A refusal is recorded once
 * per `(project_id, publish_ref, head_sha, reason)`: a later poll that refuses for the same reason at the same head
 * writes nothing, a new head or another reason writes a new row. Controller facts only (ids, SHAs, codes); no `gh` text.
 *
 * `ref_event` (FR-SUB-01 first delivery): one row per `(project_id, publish_ref, kind, head_sha)`, kinds `ci_passed`,
 * `ci_failed`, `foreign_commit`, `conflicting`, `merged`, `closed`. `run_id` is the run whose push published the ref
 * (NULL for an operator push), the run the matching `run_event` is appended to so `get_digest` reaches the publishing
 * client only.
 *
 * Both tables are append-only (triggers). Immutable once released: the checksum of this text is recorded in
 * `schema_migrations`.
 */
export const sql = `
CREATE TABLE merge_event (
  id           TEXT PRIMARY KEY CHECK (id LIKE 'mge\\_%' ESCAPE '\\'),
  project_id   TEXT NOT NULL,
  publish_ref  TEXT NOT NULL,
  pr_number    INTEGER,
  head_sha     TEXT NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('squash', 'merge', 'rebase')),
  outcome      TEXT NOT NULL CHECK (outcome IN ('attempted', 'merged', 'refused')),
  reason       TEXT CHECK (reason IN ('head_moved', 'check_failed', 'check_pending', 'no_required_checks',
                 'not_mergeable', 'unverified_at_head', 'report_missing', 'draft', 'policy_off', 'gh_error',
                 'base_mismatch')),
  run_id       TEXT,
  created_at   TEXT NOT NULL,
  CHECK ((outcome = 'refused') = (reason IS NOT NULL))
) STRICT;

CREATE INDEX merge_event_ref ON merge_event (project_id, publish_ref, created_at);
CREATE UNIQUE INDEX merge_event_refusal_once ON merge_event (project_id, publish_ref, head_sha, reason)
  WHERE outcome = 'refused';

CREATE TRIGGER merge_event_no_update BEFORE UPDATE ON merge_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER merge_event_no_delete BEFORE DELETE ON merge_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE ref_event (
  id           TEXT PRIMARY KEY CHECK (id LIKE 'rfe\\_%' ESCAPE '\\'),
  project_id   TEXT NOT NULL,
  publish_ref  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('ci_passed', 'ci_failed', 'foreign_commit', 'conflicting', 'merged',
                 'closed')),
  head_sha     TEXT NOT NULL,
  pr_number    INTEGER,
  run_id       TEXT,
  observed_at  TEXT NOT NULL,
  UNIQUE (project_id, publish_ref, kind, head_sha)
) STRICT;

CREATE TRIGGER ref_event_no_update BEFORE UPDATE ON ref_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER ref_event_no_delete BEFORE DELETE ON ref_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
