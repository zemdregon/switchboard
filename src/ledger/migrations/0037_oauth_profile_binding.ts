/**
 * Migration 0037 (MCP OAuth profile-bound one-time codes; ADR-0041 items 3 and 4, LLD §3.3): bind an OAuth client to a
 * configured MCP client (`mcp_clients` entry) through a one-time code the operator issued for that profile.
 *
 * - `oauth_pairing_code.mcp_client`: the profile a code was issued for by `switchboard mcp oauth issue-code`; NULL for a
 *   legacy `switchboard consent pair` code, which approves a client exactly as before and binds nothing.
 * - `oauth_client.mcp_client` and `bound_at`: the ledger binding written when a profile-bound code approves the client
 *   on the consent page. Both NULL or both set. The config map (`transport.http.clients`) still wins over it.
 * - `oauth_token.grant_id`: the authorization grant a token belongs to (`sbg_...`), carried across refresh rotation, so
 *   revoking a refresh token at `/revoke` (RFC 7009) also revokes the access tokens of the same grant. NULL on every row
 *   written before this migration; such a token is revoked alone.
 * - `oauth_event`: the append-only audit of grants and revocations (code issued, consent approved, token issued or
 *   refreshed, token or client revoked), written by `serve` and by the operator CLI. It never holds a token, code,
 *   passphrase, hash or pairing-code value: only event kind, client id, profile, method, actor, peer address and a
 *   reason code.
 *
 * Additive and forward-only. Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
ALTER TABLE oauth_pairing_code ADD COLUMN mcp_client TEXT CHECK (mcp_client IS NULL OR length(mcp_client) BETWEEN 1 AND 128);

ALTER TABLE oauth_client ADD COLUMN mcp_client TEXT CHECK (mcp_client IS NULL OR length(mcp_client) BETWEEN 1 AND 128);
ALTER TABLE oauth_client ADD COLUMN bound_at TEXT CHECK ((mcp_client IS NULL) = (bound_at IS NULL));

ALTER TABLE oauth_token ADD COLUMN grant_id TEXT CHECK (grant_id IS NULL OR grant_id GLOB 'sbg_*');
CREATE INDEX oauth_token_grant ON oauth_token (grant_id) WHERE grant_id IS NOT NULL;

CREATE TABLE oauth_event (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('code_issued','consent_approved','token_issued','token_refreshed',
                                           'token_revoked','client_revoked','tokens_revoked')),
  client_id  TEXT,
  mcp_client TEXT,
  method     TEXT,
  actor      TEXT NOT NULL,
  ip         TEXT,
  reason     TEXT
) STRICT;

CREATE INDEX oauth_event_client ON oauth_event (client_id, at);

CREATE TRIGGER oauth_event_no_update BEFORE UPDATE ON oauth_event
BEGIN SELECT RAISE(ABORT, 'oauth_event is append-only'); END;

CREATE TRIGGER oauth_event_no_delete BEFORE DELETE ON oauth_event
BEGIN SELECT RAISE(ABORT, 'oauth_event is append-only'); END;
`;
