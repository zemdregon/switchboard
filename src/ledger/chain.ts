/**
 * Hash-chained ledger rows (T8.13; FR-TEL-05, ADR-0064, LLD §20.13). Two independent chains, one per table: every
 * `run_event` row is linked when it is inserted, an `approval` row when it is decided. `chain_hash` is the hex SHA-256
 * of the previous link's hash followed by the row's canonical JSON; `chain_seq` is the gapless position in the chain.
 *
 * This is a detective control: it shows an in-place edit or deletion made without this code. It does not stop anyone
 * with write access to the ledger file from rewriting the whole chain, nor show a truncated tail (ADR-0064).
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type ChainedTable = "run_event" | "approval";

/** The "previous hash" of `chain_seq` 1 (ADR-0064 item 5). */
export const CHAIN_GENESIS = "0".repeat(64);

/** Chain format version 1 (ADR-0064 item 4): the chained columns of each table, in canonical (code-unit) order. */
export const CHAIN_COLUMNS: Readonly<Record<ChainedTable, readonly string[]>> = {
  run_event: ["artifact_id", "chain_seq", "id", "payload_json", "run_id", "seq", "ts", "type"],
  approval: [
    "chain_seq",
    "decided_at",
    "decided_by",
    "id",
    "requested_at",
    "run_id",
    "scope_hash",
    "scope_json",
    "status",
  ],
};

type ChainValue = string | number | null;
type ChainRow = Readonly<Record<string, unknown>>;

/** Sorted-key, whitespace-free JSON of exactly the table's chained columns; a missing column is `null`. */
export function canonicalJson(table: ChainedTable, row: object): string {
  const values = row as ChainRow;
  const out: Record<string, ChainValue> = {};
  for (const col of CHAIN_COLUMNS[table]) out[col] = (values[col] ?? null) as ChainValue;
  return JSON.stringify(out);
}

export function chainHash(previous: string, canonical: string): string {
  return createHash("sha256")
    .update(previous + canonical, "utf8")
    .digest("hex");
}

export interface ChainLink {
  readonly chain_seq: number;
  readonly chain_hash: string;
}

/**
 * The link for `row` as the next entry of `table`'s chain. Call it inside the transaction that writes the row: the
 * unique index on `chain_seq` makes a writer that read a stale head fail instead of forking the chain.
 */
export function nextChainLink(db: Database.Database, table: ChainedTable, row: object): ChainLink {
  const head = db
    .prepare(`SELECT chain_seq, chain_hash FROM ${table} WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1`)
    .get() as { chain_seq: number; chain_hash: string | null } | undefined;
  const chain_seq = (head?.chain_seq ?? 0) + 1;
  return {
    chain_seq,
    chain_hash: chainHash(head?.chain_hash ?? CHAIN_GENESIS, canonicalJson(table, { ...row, chain_seq })),
  };
}

export interface ChainedRunEventInput {
  readonly id: string;
  readonly runId: string;
  readonly ts: string;
  readonly type: string;
  readonly payloadJson: string;
  readonly artifactId?: string | null;
}

export interface ChainedRunEventRow {
  readonly id: string;
  readonly run_id: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly payload_json: string;
  readonly artifact_id: string | null;
}

/**
 * The one production writer of `run_event` rows (ADR-0064 item 6): the next per-run `seq` and the chain link are read
 * and the row inserted in one transaction (the caller's, or an `IMMEDIATE` one of its own).
 */
export function insertChainedRunEvent(db: Database.Database, input: ChainedRunEventInput): ChainedRunEventRow {
  const write = (): ChainedRunEventRow => {
    const next = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_event WHERE run_id = ?")
      .get(input.runId) as {
      n: number;
    };
    const row: ChainedRunEventRow = {
      id: input.id,
      run_id: input.runId,
      seq: next.n,
      ts: input.ts,
      type: input.type,
      payload_json: input.payloadJson,
      artifact_id: input.artifactId ?? null,
    };
    const link = nextChainLink(db, "run_event", row);
    db.prepare(
      `INSERT INTO run_event (id, run_id, seq, ts, type, payload_json, artifact_id, chain_seq, chain_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.run_id,
      row.seq,
      row.ts,
      row.type,
      row.payload_json,
      row.artifact_id,
      link.chain_seq,
      link.chain_hash,
    );
    return row;
  };
  return db.inTransaction ? write() : db.transaction(write).immediate();
}

/**
 * Migration 26's backfill (ADR-0064 item 7): links every `run_event` row and every decided approval row in insertion
 * (`rowid`) order. Runs inside the migration transaction while the update guards are dropped.
 */
export function backfillChains(db: Database.Database): void {
  const fill = (table: ChainedTable, where: string) => {
    const rows = db.prepare(`SELECT rowid AS rid, * FROM ${table} WHERE ${where} ORDER BY rowid`).all() as (ChainRow & {
      rid: number;
    })[];
    const update = db.prepare(`UPDATE ${table} SET chain_seq = ?, chain_hash = ? WHERE rowid = ?`);
    let previous = CHAIN_GENESIS;
    let seq = 0;
    for (const row of rows) {
      seq += 1;
      previous = chainHash(previous, canonicalJson(table, { ...row, chain_seq: seq }));
      update.run(seq, previous, row.rid);
    }
  };
  fill("run_event", "1");
  fill("approval", "status <> 'PENDING'");
}

export interface ChainBreak {
  /** The broken row's `id`. */
  readonly id: string;
  readonly chain_seq: number | null;
  readonly reason: string;
}

export interface ChainVerification {
  readonly table: ChainedTable;
  /** Linked rows checked before the first break (all of them when `broken` is absent). */
  readonly length: number;
  /** The last verified link's hash; the genesis value for an empty chain. */
  readonly head: string;
  readonly broken?: ChainBreak;
}

/**
 * Walks one chain in `chain_seq` order and returns the first broken row (ADR-0064 item 8): a gap or repeat in
 * `chain_seq`, or a `chain_hash` that does not match; then a row that should carry a link but does not (any
 * `run_event` row, a decided approval) or a `PENDING` approval that carries one. Read-only.
 */
export function verifyChain(db: Database.Database, table: ChainedTable): ChainVerification {
  const cols = CHAIN_COLUMNS[table].join(", ");
  const linked = db
    .prepare(`SELECT ${cols}, chain_hash FROM ${table} WHERE chain_seq IS NOT NULL ORDER BY chain_seq`)
    .iterate() as IterableIterator<ChainRow & { id: string; chain_seq: number; chain_hash: string | null }>;
  let previous = CHAIN_GENESIS;
  let length = 0;
  for (const row of linked) {
    const expected = length + 1;
    let reason: string | undefined;
    if (row.chain_seq !== expected) {
      reason =
        row.chain_seq > expected
          ? `chain_seq ${row.chain_seq} where ${expected} was expected: a linked row is missing`
          : `chain_seq ${row.chain_seq} repeats or goes back (expected ${expected})`;
    } else if (row.chain_hash !== chainHash(previous, canonicalJson(table, row))) {
      reason = "chain_hash does not match the row's content and the previous link";
    }
    if (reason !== undefined) {
      linked.return?.();
      return { table, length, head: previous, broken: { id: row.id, chain_seq: row.chain_seq, reason } };
    }
    previous = row.chain_hash as string;
    length = expected;
  }
  const unlinked = (
    table === "run_event"
      ? db.prepare("SELECT id FROM run_event WHERE chain_seq IS NULL OR chain_hash IS NULL ORDER BY rowid LIMIT 1")
      : db.prepare(
          `SELECT id FROM approval WHERE (status <> 'PENDING' AND (chain_seq IS NULL OR chain_hash IS NULL))
             OR (status = 'PENDING' AND (chain_seq IS NOT NULL OR chain_hash IS NOT NULL)) ORDER BY rowid LIMIT 1`,
        )
  ).get() as { id: string } | undefined;
  if (unlinked !== undefined) {
    const status =
      table === "approval"
        ? (db.prepare("SELECT status FROM approval WHERE id = ?").get(unlinked.id) as { status: string }).status
        : undefined;
    const reason =
      status === "PENDING"
        ? "a PENDING approval carries a chain link"
        : table === "approval"
          ? "a decided approval has no chain link"
          : "the row has no chain link";
    return { table, length, head: previous, broken: { id: unlinked.id, chain_seq: null, reason } };
  }
  return { table, length, head: previous };
}

/** True when the ledger has the chain columns (migration 26 applied). */
export function hasChainColumns(db: Database.Database): boolean {
  const cols = db.prepare("SELECT name FROM pragma_table_info('run_event')").all() as { name: string }[];
  return cols.some((c) => c.name === "chain_hash");
}
