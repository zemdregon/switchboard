/**
 * Migration 0027 (T15.7; FR-QUE-07, FR-QUE-05, LLD §20.4, ADR-0050 amendment 1): published-ref conflicts and supersede.
 *
 * `project_work_item` gains three columns:
 * - `dedupe_key`: optional per-project key. The partial unique index refuses a second item with the same key while one
 *   is live (not terminal) or published (`DONE`) and not superseded; a `CANCELLED`, `FAILED_ADMISSION` or closed
 *   `ADMITTED` item (its run failed or was cancelled) releases the key.
 * - `hot_paths_json`: optional JSON array of up to 32 path globs; the dequeue skips an item that overlaps a running item
 *   of the same project.
 * - `superseded_by`: the re-implementation item that superseded the ref this item worked on (releases `dedupe_key`).
 *
 * `ci_trigger_ref_state` gains `superseded_by` and `superseded_at`: a superseded ref is no longer watched.
 *
 * `ci_ref_conflict`: one row per rebase or re-implementation item the poller enqueued for a `CONFLICTING` published ref
 * (the `gh pr view` facts only: PR number and head SHA; no `gh` free text).
 *
 * `run_rebase`: the controller's Git preparation of a rebase run. Written `pending` in the admission transaction; the
 * lifecycle merges the current base into the worktree and sets `prepared` with `merge_parent_sha` (the base commit the
 * commit tool records as the second parent) or `failed`.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
ALTER TABLE project_work_item ADD COLUMN dedupe_key TEXT;
ALTER TABLE project_work_item ADD COLUMN hot_paths_json TEXT;
ALTER TABLE project_work_item ADD COLUMN superseded_by TEXT;

CREATE UNIQUE INDEX project_work_item_dedupe
  ON project_work_item (project_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND superseded_by IS NULL
    AND state NOT IN ('CANCELLED', 'FAILED_ADMISSION')
    AND (state = 'DONE' OR terminal_at IS NULL);

ALTER TABLE ci_trigger_ref_state ADD COLUMN superseded_by TEXT;
ALTER TABLE ci_trigger_ref_state ADD COLUMN superseded_at TEXT;

CREATE TABLE ci_ref_conflict (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  remote           TEXT NOT NULL,
  publish_ref      TEXT NOT NULL,
  head_sha         TEXT NOT NULL,
  pr_number        INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('rebase', 'reimplement')),
  meta_session_id  TEXT,
  work_item_id     TEXT NOT NULL UNIQUE,
  observed_at      TEXT NOT NULL
) STRICT;

CREATE INDEX ci_ref_conflict_ref ON ci_ref_conflict (project_id, publish_ref, observed_at);

CREATE TABLE run_rebase (
  run_id            TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL,
  publish_ref       TEXT NOT NULL,
  head_sha          TEXT NOT NULL,
  merge_parent_sha  TEXT,
  state             TEXT NOT NULL CHECK (state IN ('pending', 'prepared', 'failed')),
  conflicted_paths  INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;
`;
