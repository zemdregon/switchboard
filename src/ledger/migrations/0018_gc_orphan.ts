/**
 * Migration 0018 (T3.12; FR-WS-07, NFR-DATA-01, LLD §5, ADR-0053): `gc_orphan`, the mark-first record of the orphan
 * sweep. An orphan (a worktree directory or `switchboard/*` branch with no ledger row) has no row of its own to age, so
 * its first sighting by a collecting GC pass is recorded here; it is removed only once that mark is older than
 * `retention.days`. `intent_at` is set in the transaction that re-checks the orphan before removal, `removed_at` after
 * it: a row with an intent and no outcome rolls forward on the next pass. `repo_root` is `''` for a worktree directory.
 *
 * Additive and forward-only; no existing table changes. A released migration is immutable (ADR-0005): the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE gc_orphan (
  kind          TEXT NOT NULL CHECK (kind IN ('worktree','branch')),
  repo_root     TEXT NOT NULL,
  target        TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  intent_at     TEXT,
  removed_at    TEXT,
  PRIMARY KEY (kind, repo_root, target)
) STRICT;
`;
