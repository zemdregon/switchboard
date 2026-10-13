/**
 * Migration 0006 (T11.5; FR-INN-15, LLD §1 "M11 additions" and §13.3 T11.5 note, ADR-0016, ADR-0005): widens the
 * `usage_observation.source` check from `('provider_reported','controller_estimated')` to also allow `'inner_agent'`, the
 * label of the one observation written when an operator declares `inner_agent.backend.shares_subscription_with`.
 *
 * SQLite cannot alter a CHECK, so this is the table-rebuild step (LLD §1): create the widened table, copy every row
 * unchanged (ids, timestamps and order preserved), drop the old table (its index and append-only triggers go with it),
 * rename, then recreate the index and the two guards exactly as in migration 0001. Nothing references
 * `usage_observation`, so no foreign key is affected. A released migration is immutable (ADR-0005), hence a new forward
 * migration rather than an edit of 0001. No other table changes.
 *
 * The widened value is written only by the inner-agent call recorder; readers of provider-reported usage (the MCP
 * envelope, `runs show`) already filter on `source = 'provider_reported'`. Immutable once released: the checksum of this
 * text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE usage_observation_new (
  id               TEXT PRIMARY KEY,
  run_id           TEXT REFERENCES run(id),
  provider         TEXT NOT NULL,
  harness          TEXT NOT NULL,
  backing_provider TEXT,
  model            TEXT,
  source           TEXT NOT NULL CHECK (source IN ('provider_reported','controller_estimated','inner_agent')),
  metrics_json     TEXT NOT NULL CHECK (json_valid(metrics_json)),
  observed_at      TEXT NOT NULL
) STRICT;

INSERT INTO usage_observation_new (id, run_id, provider, harness, backing_provider, model, source, metrics_json, observed_at)
SELECT id, run_id, provider, harness, backing_provider, model, source, metrics_json, observed_at
FROM usage_observation ORDER BY rowid;

DROP TABLE usage_observation;
ALTER TABLE usage_observation_new RENAME TO usage_observation;

CREATE INDEX usage_provider_time ON usage_observation(provider, observed_at);

CREATE TRIGGER usage_observation_no_update BEFORE UPDATE ON usage_observation
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER usage_observation_no_delete BEFORE DELETE ON usage_observation
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
