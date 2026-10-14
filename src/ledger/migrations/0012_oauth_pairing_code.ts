/**
 * Migration 0012 (T13.8; LLD §3.3, ADR-0041 items 3 and 8, Q-76): `oauth_pairing_code`, the one-time pairing codes that
 * `switchboard consent pair` creates as the fallback for the consent-page passphrase. Only the SHA-256 hash of each code is
 * stored (`code_hash`, lower-case hex), never the value. A code is usable once, until `expires_at` (at most 10 minutes
 * after creation); `used_at` is set when it is redeemed or when a newer code supersedes it, and a row with `used_at`
 * set is never accepted again.
 *
 * Additive and forward-only; no existing table changes. A released migration is immutable (ADR-0005): the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE oauth_pairing_code (
  code_hash  TEXT PRIMARY KEY CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
) STRICT;
`;
