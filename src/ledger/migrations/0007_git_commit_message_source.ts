/**
 * Migration 0007 (T11.4; FR-INN-10, FR-GIT-07, LLD §12.7 "Inner-agent provenance" and §13.3 T11.1 note, ADR-0016,
 * ADR-0005): the two `git_commit` columns the LLD names for the commit-message task.
 *
 * - `message_source`: `agent` (the agent's own message, or a finalize-only summary) or `inner` (a message drafted by the
 *   inner agent and sanitised exactly like any other). Default `agent`, so every existing row reads as before.
 * - `inner_call_id`: the `inner_call` row of the accepted draft; NULL for an agent message, and allowed only with
 *   `message_source = 'inner'` (a column CHECK may name another column of the same row).
 *
 * `ALTER TABLE ... ADD COLUMN` changes no existing row and fires no `BEFORE UPDATE` trigger, so the append-only guards of
 * migration 0003 stay in force unchanged. The message text itself is never stored (LLD §12.7). A released migration is
 * immutable (ADR-0005), hence this new forward migration rather than an edit of 0003; no other table changes.
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
ALTER TABLE git_commit ADD COLUMN message_source TEXT NOT NULL DEFAULT 'agent'
  CHECK (message_source IN ('agent','inner'));
ALTER TABLE git_commit ADD COLUMN inner_call_id TEXT REFERENCES inner_call(id)
  CHECK (inner_call_id IS NULL OR message_source = 'inner');
`;
