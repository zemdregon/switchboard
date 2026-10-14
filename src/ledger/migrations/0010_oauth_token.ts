/**
 * Migration 0010 (T13.3; FR-MCP-13, LLD §3.3, ADR-0041 items 4, 5 and 8, Q-73): `oauth_token`, the access and refresh
 * tokens issued by the embedded OAuth 2.1 authorization server. Tokens are opaque random values; only the SHA-256 hash
 * of each one is stored (`token_hash`, lower-case hex), never the value. Each row carries the client, the audience
 * (`resource`, RFC 8707), the granted scopes, the expiry and a revoked flag. Lookup is by hash.
 *
 * - `kind` separates access from refresh tokens, so a refresh token presented as a bearer token is refused.
 * - `revoked` is set in place (with `revoked_at`); a row is never deleted by this migration's users, so a revoked token
 *   stays refused.
 *
 * Additive and forward-only; no existing table changes. A released migration is immutable (ADR-0005): the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE oauth_token (
  token_hash  TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id   TEXT NOT NULL,
  resource    TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  revoked_at  TEXT
) STRICT;

CREATE INDEX oauth_token_client ON oauth_token(client_id, kind);
`;
