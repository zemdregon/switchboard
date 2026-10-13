/**
 * Migration 0002 (T9.2; ADR-0024): the project the work belongs to (FR-PRJ-03). Two nullable columns, copied from
 * LLD §1 "M9 additions", which owns the DDL. Additive and backwards compatible: existing rows keep `NULL`, which means
 * "delegated by workspace path". No index (LLD names none) and no CHECK (a configured project may later leave the
 * configuration while its history stays, FR-PRJ-09, so the column cannot reference a table). The environment kind and the
 * resolved project live in `run.policy_snapshot_json`, not in a column.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
ALTER TABLE meta_session ADD COLUMN project_id TEXT;
ALTER TABLE run ADD COLUMN project_id TEXT;
`;
