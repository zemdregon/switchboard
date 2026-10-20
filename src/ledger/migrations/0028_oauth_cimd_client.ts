/**
 * Migration 0028 (T13.11; FR-MCP-19, LLD §20.11, ADR-0065): `oauth_cimd_client`, the Client Identifier URL of each
 * OAuth client that identified itself with a Client ID Metadata Document. The client's row in `oauth_client` is keyed
 * by the `sbc_` identifier derived from the URL (128 bits of its SHA-256), so tokens, meta-session bindings and the
 * `transport.http.clients` mapping keep the identifier form every existing table checks; this table keeps the URL
 * beside it. `fetched_at` is the last time the document was fetched and the row's metadata refreshed (every consent
 * fetches afresh; nothing is cached across consents). The table holds identifiers only, never a credential.
 *
 * Additive and forward-only; no existing table changes. A released migration is immutable (ADR-0005): the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE oauth_cimd_client (
  client_id  TEXT PRIMARY KEY CHECK (client_id GLOB 'sbc_*') REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  url        TEXT NOT NULL UNIQUE CHECK (url GLOB 'https://*' AND length(url) <= 2048),
  fetched_at TEXT NOT NULL
) STRICT;
`;
