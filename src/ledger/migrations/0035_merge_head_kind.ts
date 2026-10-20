/**
 * Migration 0035 (ADR-0073; FR-SUB-02, LLD §20.7.1): the pull request head the merge gate accepted.
 *
 * `merge_event` gains two nullable columns, set together on a row written after the gate's head check held:
 * `head_kind` is `published` (the pull request head is the tip Switchboard published) or `base_merge` (a chain of pure
 * base merges on that tip, verified by the controller with local Git), and `pr_head_sha` is that head, the commit G12
 * pins with `--match-head-commit`. `head_sha` stays the published tip. Both are NULL on rows written before the head
 * check (`gh_error`, `draft`, `head_moved`, `base_mismatch`, ...), on step 1 refusals wherever they are read, and on
 * every row written before this migration.
 *
 * The refusal-once index now also keys on `pr_head_sha`, so a refusal at a new accepted head (for example
 * `check_pending` after a second "Update branch") is recorded again. Adding a column fires no trigger; the table stays
 * append-only. Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
ALTER TABLE merge_event ADD COLUMN head_kind TEXT CHECK (head_kind IN ('published', 'base_merge'));
ALTER TABLE merge_event ADD COLUMN pr_head_sha TEXT CHECK ((head_kind IS NULL) = (pr_head_sha IS NULL));

DROP INDEX merge_event_refusal_once;
CREATE UNIQUE INDEX merge_event_refusal_once ON merge_event (project_id, publish_ref, head_sha, ifnull(pr_head_sha, ''),
  reason) WHERE outcome = 'refused';
`;
