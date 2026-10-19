# ADR-0064: Hash-chained `run_event` and approval rows, verified by `doctor`

- Status: Accepted (2026-10-19, Delegated agent work under owner decision 77 and the WORK QUEUE v10 Linus decisions; not
  owner-approved). Built by ROADMAP T8.13 (migration 25, `src/ledger/chain.ts`, the `ledger_chain` check of `doctor`)
- Date: 2026-10-19
- Decided by: Delegated (agent, 2026-10-19). Linus decisions relayed with the task (WORK QUEUE v10, Delegated, not
  owner-approved): the ADR is in the same change as the code and committed first (v10-D1), and there is one chain per
  table, not one global chain, so approval and event writers never contend on one hash (row T8.13 (b)).
- Related: FR-TEL-05, FR-TEL-01, FR-POL-09, FR-OPS-01, BO-5, CAP-8, [ADR-0005](0005-sqlite-ledger.md), Q-96,
  [LLD §20.13](../design/LLD.md#2013-tamper-evident-ledger-provider-telemetry-evaluation-brief-and-critic-t813-t815-t814-t514-t1417)

## Context

`run_event` is append-only and `approval` may change once, from `PENDING` to a decision. Both are enforced by
`BEFORE UPDATE` and `BEFORE DELETE` triggers ([ADR-0005](0005-sqlite-ledger.md)), and since Q-96 `openLedger` sets
`recursive_triggers = ON` so `REPLACE` is refused too. The triggers stop Switchboard's own code and an accidental
statement. They do not stop anyone who opens the ledger file with any SQLite client, drops a trigger and edits a row:
afterwards nothing shows that the row changed. FR-TEL-05 asks for a hash chain per table that `doctor` verifies. This
changes the persistence format, so it needs an ADR before code.

## Decision

1. **Two columns per chained table.** Migration 25 adds `chain_seq INTEGER` and `chain_hash TEXT` to `run_event` and to
   `approval`, with a unique index on `chain_seq` per table. `chain_seq` is the position in the table's chain, 1, 2, 3,
   and so on without gaps; it does not use `rowid`, which `VACUUM` may renumber.
2. **Two independent chains** (Linus decision (b)). `run_event` rows are linked to the previous `run_event` row,
   approval rows to the previous approval row. Neither chain reads the other.
3. **What is chained.**
   - Every `run_event` row is linked when it is inserted.
   - An approval row is linked when it is decided (its one allowed update, `PENDING` to `APPROVED` or `DENIED`, or
     `EXPIRED` should a later change write it). A `PENDING` row carries no link (`chain_seq` and `chain_hash` are
     `NULL`): it is still meant to change once, and FR-TEL-05 asks for a hash on each approval *decision*. Approval
     chain order is decision order.
4. **Canonical JSON.** A row's canonical JSON is a JSON object with exactly the table's chained columns as keys, in
   ascending code-unit order, without whitespace, as `JSON.stringify` writes it. Values are as stored: `TEXT` as a
   JSON string, `INTEGER` as a JSON number, `NULL` as `null`. JSON text columns (`payload_json`, `scope_json`) are
   chained as the stored string, not re-parsed. The chained columns are fixed by this ADR (chain format version 1):
   - `run_event`: `artifact_id`, `chain_seq`, `id`, `payload_json`, `run_id`, `seq`, `ts`, `type`.
   - `approval`: `chain_seq`, `decided_at`, `decided_by`, `id`, `requested_at`, `run_id`, `scope_hash`, `scope_json`,
     `status`.

   A column a later migration adds to either table is not chained unless a new ADR changes the format.
5. **Hash.** `chain_hash` is the lowercase hex SHA-256 of the UTF-8 bytes of the previous row's `chain_hash` (64 hex
   characters) followed directly by the row's canonical JSON. The genesis value, the "previous hash" of `chain_seq` 1,
   is 64 zeros (`000…000`). Including `chain_seq` in the canonical JSON binds each row to its position.
6. **Append path.** The code that inserts a `run_event` row, or decides an approval, reads the table's last link
   (`MAX(chain_seq)` and its hash), computes the new link and writes it in the same statement as the insert or the
   decision, inside one transaction. The unique index on `chain_seq` makes a concurrent writer that read the same last
   link fail its insert instead of forking the chain (fail closed). Every production writer of `run_event` goes
   through one helper (`insertChainedRunEvent`, `src/ledger/chain.ts`).
7. **Backfill.** Migration 25 links existing rows in insertion (`rowid`) order: every `run_event` row, and every
   approval row that is no longer `PENDING`. The `run_event_no_update` and `approval_update_once` guards are dropped for
   the backfill and recreated with their original text in the same migration transaction, so a failed backfill leaves
   the ledger as it was. Ledger ids are clock-prefixed, so insertion order is id order except between ids from the
   same millisecond, whose random suffixes do not reflect the order they were written in.
8. **Verification.** `switchboard doctor` opens the ledger read-only and walks both chains in `chain_seq` order. It
   reports `ok` with each chain's length and head hash, or `fail` naming the table, the first broken row's `id` and
   the reason: a `run_event` row or decided approval row without a link, a `PENDING` row with one, a gap or a
   repeat in `chain_seq`, or a `chain_hash` that does not match the recomputed value. The first broken row is the
   lowest `chain_seq` that fails; a row with no link is reported after every linked row has been checked.

## What this detects, and what it does not

This is a detective control, not a preventive one. It is stated here plainly so no document claims more.

- **Detected:** an in-place edit of any chained column of a linked row (the row's hash no longer matches); deleting
  a linked row other than the last ones (a gap in `chain_seq`, or the next row's hash no longer matches); inserting
  a row by hand without computing a link; resetting a decided approval to `PENDING` or clearing its link; reordering
  rows by editing `chain_seq`. All of these hold for someone who edits the file without running Switchboard's chain
  code.
- **Not detected:** a rewrite of the chain. The chain has no secret key and the algorithm is published here, so anyone
  with write access to the ledger file can edit a row and recompute every later link; `doctor` then reports `ok`.
  Switchboard does not prevent this and does not claim to.
- **Not detected:** deleting the newest rows (truncating the tail). The shorter chain is still valid. `doctor` prints
  each chain's length and head hash so an operator can record them outside the host; comparing a later report with
  that record is the operator's step, not something Switchboard enforces.
- **Not detected:** edits to other tables, to an approval row while it is still `PENDING`, or to a column added after
  chain format version 1.
- `doctor` reports; nothing refuses to start on a broken chain. `serve` keeps running so a damaged ledger can still
  be inspected; the operator decides what to do.

## Alternatives considered

- **One global chain over both tables.** Rejected (Linus decision (b)): every approval decision and every event write
  would contend on one hash.
- **A keyed MAC (HMAC) with a key outside the ledger.** It would also detect a rewrite by someone without the key. Not
  chosen for this change: Switchboard would have to create, store and protect a new secret, which is a new credential
  boundary and needs its own decision. It can be added later as chain format version 2.
- **Chain approval rows on insert.** Rejected: the one allowed decision update would then break the link, or the
  decided columns would have to be left out of the hash, which leaves the decision itself unprotected.
- **Order by `rowid` without a `chain_seq` column.** Rejected: `VACUUM` may renumber `rowid` in tables without an
  `INTEGER PRIMARY KEY`, and the order must survive it.
- **A trigger that computes the hash.** Not possible without a custom SQL function registered on every connection,
  including read-only CLI openers; SQLite has no built-in SHA-256.

## Consequences

- Each `run_event` insert and each approval decision costs one indexed `MAX(chain_seq)` read, one row read and one
  SHA-256; the cost is measured with the T2.7 benchmark (`scripts/bench-perf.mjs`) and recorded with T8.13.
- Event writers in different processes now also serialise on the chain head; a concurrent append that loses the race
  fails rather than forks. Every production writer already appends inside an `IMMEDIATE` transaction or a single
  synchronous connection.
- A test or tool that inserts `run_event` rows with plain SQL leaves them unlinked, and `doctor` reports them.
- The migration runner gains an optional backfill step that runs inside the migration's transaction, plus trailing SQL
  covered by the migration checksum.

## Revisit when

- An operator needs rewrite detection without an external record (a keyed chain, version 2).
- A column is added to either table that should be protected.
