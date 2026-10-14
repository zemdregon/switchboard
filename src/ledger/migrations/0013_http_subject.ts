/**
 * Migration 0013 (T13.5; FR-MCP-15, LLD §3.3, Q-78): `http_subject`, the OAuth client (token subject) that opened each
 * meta-session over the network MCP transport. A meta-session with a row here is reachable only by MCP requests whose
 * token belongs to that OAuth client; a meta-session without one was opened over stdio and is reachable only over stdio.
 * A run belongs to its meta-session, so automatic retry successors (T6.5) inherit the binding.
 *
 * No foreign key: retention GC removes meta-sessions without knowing about this table, and a binding to a removed
 * meta-session names nothing. The table holds identifiers only, never a token.
 *
 * Additive and forward-only; no existing table changes. A released migration is immutable (ADR-0005): the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE http_subject (
  meta_session_id TEXT PRIMARY KEY,
  oauth_client_id TEXT NOT NULL CHECK (oauth_client_id GLOB 'sbc_*'),
  created_at      TEXT NOT NULL
) STRICT;
`;
