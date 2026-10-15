import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { LedgerError } from "./errors.js";
import { migrate } from "./migrate.js";

export const LEDGER_FILE_NAME = "ledger.sqlite";

/** Proposed: 5 s busy timeout for short-lived operator CLI writers (ADR-0005); only `serve` is a long-lived writer. */
export const BUSY_TIMEOUT_MS = 5000;

export interface OpenLedgerOptions {
  /** Injectable clock for `schema_migrations.applied_at`. */
  now?: () => Date;
}

/**
 * Open (creating if needed) the ledger at `<dataDir>/ledger.sqlite` with WAL, `synchronous=FULL` (Proposed in LLD §1),
 * foreign keys on, recursive triggers on (so `REPLACE` cannot bypass the append-only guards, Q-96) and a busy timeout,
 * then apply pending migrations. Throws {@link LedgerError} if WAL cannot be enabled. The caller is responsible for
 * holding the data-directory lock (src/lock).
 */
export function openLedger(dataDir: string, options: OpenLedgerOptions = {}): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  return openLedgerFile(path.join(dataDir, LEDGER_FILE_NAME), options);
}

export function openLedgerFile(file: string, options: OpenLedgerOptions = {}): Database.Database {
  const db = new Database(file);
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const mode = db.pragma("journal_mode = WAL", { simple: true });
    if (mode !== "wal") throw new LedgerError(`could not enable WAL journal mode (got ${String(mode)})`);
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    // Q-96 (Delegated, fail closed): without this, SQLite's REPLACE conflict resolution deletes a colliding row
    // without firing the BEFORE DELETE guards, so `INSERT OR REPLACE` could rewrite an append-only row (ADR-0005).
    db.pragma("recursive_triggers = ON");
    migrate(db, options.now);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
