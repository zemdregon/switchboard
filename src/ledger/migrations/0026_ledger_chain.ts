/**
 * Migration 0026 (T8.13; FR-TEL-05, ADR-0064, LLD §20.13): hash-chained `run_event` and `approval` rows.
 *
 * Adds `chain_seq` (the gapless position in the table's chain, unique) and `chain_hash` (hex SHA-256 of the previous
 * link's hash followed by the row's canonical JSON) to both tables. Two independent chains: every `run_event` row is
 * linked, an approval row once it is decided. The update guards are dropped here, the existing rows are linked in
 * insertion order by the backfill (`backfillChains`, `src/ledger/chain.ts`), and `postSql` recreates the guards with
 * their migration 0001 text, all in the one migration transaction.
 *
 * Immutable once released: the checksum of `sql` and `postSql` is recorded in `schema_migrations`.
 */
export const sql = `
ALTER TABLE run_event ADD COLUMN chain_seq INTEGER CHECK (chain_seq IS NULL OR chain_seq >= 1);
ALTER TABLE run_event ADD COLUMN chain_hash TEXT CHECK (chain_hash IS NULL OR length(chain_hash) = 64);
ALTER TABLE approval ADD COLUMN chain_seq INTEGER CHECK (chain_seq IS NULL OR chain_seq >= 1);
ALTER TABLE approval ADD COLUMN chain_hash TEXT CHECK (chain_hash IS NULL OR length(chain_hash) = 64);

CREATE UNIQUE INDEX run_event_chain_seq ON run_event (chain_seq);
CREATE UNIQUE INDEX approval_chain_seq ON approval (chain_seq);

DROP TRIGGER run_event_no_update;
DROP TRIGGER approval_update_once;
`;

export const postSql = `
CREATE TRIGGER run_event_no_update BEFORE UPDATE ON run_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER approval_update_once BEFORE UPDATE ON approval
WHEN OLD.status <> 'PENDING'
BEGIN SELECT RAISE(ABORT, 'approval already decided'); END;
`;
