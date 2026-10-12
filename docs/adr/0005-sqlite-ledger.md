# ADR-0005: SQLite ledger with append-only run events

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-SES-05, FR-TEL-01, NFR-REL-01, [LLD §1](../design/LLD.md#1-data-model)

## Context

The original blueprint suggested "SQLite or RocksDB". The verified research recommends SQLite for a local, relational,
transactional, modest-volume workload, with an append-only event table plus materialized current-state tables.

## Decision

One SQLite database file in WAL mode under the operator's data directory. `run_event` and `decision` are append-only.
Current-state tables (`run`, `meta_session`, `provider_health`, capacity) are updated in the same transaction as the
event that changes them. Large payloads go to a content-addressed artifact directory, referenced by SHA-256. Schema
changes use numbered forward-only migrations.

## Alternatives considered

- **RocksDB.** Rejected: loses relational queries, no need at expected volume.
- **PostgreSQL.** Rejected: adds a server to a single-operator local tool.
- **Flat JSON files.** Rejected: no transactions, poor crash safety.

## Consequences

- One long-running `serve` process per data directory, enforced by an exclusive lock file. Short-lived operator CLI
  commands write only operator records (approvals, denials, cancel requests) through the same ledger module, relying on
  SQLite WAL locking with a busy timeout; the daemon performs every side effect. Only Switchboard code writes the
  database.
- One orchestrator per data directory at a time follows from this; a second orchestrator needs its own data directory.
- Multi-host deployment would need a different store (out of scope, ADR-0011).

## Revisit when

Event volume or multi-host operation makes a single local file a bottleneck.
