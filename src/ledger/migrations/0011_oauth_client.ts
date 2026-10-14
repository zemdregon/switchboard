/**
 * Migration 0011 (T13.7; FR-MCP-16, LLD §3.3, ADR-0041 item 3, Q-74): `oauth_client`, the public clients registered
 * with the embedded authorization server through Dynamic Client Registration (RFC 7591). A client is created `pending`;
 * only the operator's consent decision (a later M13 task) moves it to `approved` or `denied`, and operator revocation
 * moves it to `revoked`. No client secret exists (public clients, `token_endpoint_auth_method` `none`), so the table
 * holds no credential.
 *
 * Additive and forward-only; no existing table changes. A released migration is immutable (ADR-0005): the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE oauth_client (
  client_id          TEXT PRIMARY KEY CHECK (client_id GLOB 'sbc_*'),
  client_name        TEXT,
  redirect_uris_json TEXT NOT NULL CHECK (json_valid(redirect_uris_json) AND json_type(redirect_uris_json) = 'array'),
  grant_types_json   TEXT NOT NULL CHECK (json_valid(grant_types_json) AND json_type(grant_types_json) = 'array'),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','revoked')),
  created_at         TEXT NOT NULL,
  decided_at         TEXT
) STRICT;

CREATE INDEX oauth_client_status ON oauth_client(status, created_at);
`;
