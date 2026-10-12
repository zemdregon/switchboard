import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import {
  createLedger,
  currentSchemaVersion,
  LEDGER_FILE_NAME,
  MIGRATIONS,
  MigrationError,
  migrate,
  openLedger,
  openLedgerFile,
} from "./index.js";

const EXPECTED_TABLES = [
  "adapter_version",
  "approval",
  "artifact",
  "decision",
  "meta_session",
  "provider_binding",
  "provider_health",
  "route_decision",
  "run",
  "run_event",
  "schema_migrations",
  "usage_observation",
  "workspace_checkpoint",
];

let dir: string;
let db: Database.Database | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-ledger-"));
});
afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function tables(d: Database.Database): string[] {
  return (
    d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function seed(d: Database.Database) {
  const ledger = createLedger(d, { ids: createIdGenerator() });
  const session = ledger.createMetaSession({ objective: "test" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
  return { ledger, session, run };
}

describe("ledger migrations", () => {
  it("creates all tables from an empty database and records the version", () => {
    db = openLedger(dir);
    expect(tables(db)).toEqual(EXPECTED_TABLES);
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS.length);
    const row = db.prepare("SELECT version, name, checksum FROM schema_migrations").get() as { checksum: string };
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent when re-opened", () => {
    db = openLedger(dir);
    db.close();
    db = openLedger(dir);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: MIGRATIONS.length });
    expect(migrate(db)).toEqual([]);
  });

  it("applies only pending migrations in order", () => {
    db = openLedger(dir);
    const extra = { version: 2, name: "extra", sql: "CREATE TABLE extra (id INTEGER PRIMARY KEY) STRICT;" };
    expect(migrate(db, undefined, [...MIGRATIONS, extra])).toEqual([2]);
    expect(tables(db)).toContain("extra");
  });

  it("refuses a database with a newer, unknown schema version", () => {
    db = openLedger(dir);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', 'now')",
    ).run();
    db.close();
    db = undefined;
    expect(() => openLedger(dir)).toThrow(MigrationError);
    expect(() => openLedger(dir)).toThrow(/newer/);
  });

  it("aborts on a checksum mismatch of an applied migration", () => {
    db = openLedger(dir);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    db.close();
    db = undefined;
    expect(() => openLedger(dir)).toThrow(/checksum mismatch/);
  });

  it("rolls back a failing migration and records nothing", () => {
    db = openLedgerFile(path.join(dir, LEDGER_FILE_NAME));
    const bad = { version: 2, name: "bad", sql: "CREATE TABLE ok (id INTEGER) STRICT; SELECT * FROM nope;" };
    expect(() => migrate(db as Database.Database, undefined, [...MIGRATIONS, bad])).toThrow();
    expect(tables(db)).not.toContain("ok");
    expect(currentSchemaVersion(db)).toBe(1);
  });
});

describe("ledger pragmas", () => {
  it("enables WAL, foreign keys and full synchronous", () => {
    db = openLedger(dir);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
  });

  it("enforces foreign keys", () => {
    db = openLedger(dir);
    const d = db;
    expect(() =>
      d
        .prepare(
          `INSERT INTO run_event (id, run_id, seq, ts, type, payload_json) VALUES ('evt_X', 'run_missing', 1, 't', 'x', '{}')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("append-only tables", () => {
  it("run_event rejects UPDATE and DELETE", () => {
    db = openLedger(dir);
    const { ledger, run } = seed(db);
    const evt = ledger.appendRunEvent({ runId: run.id, type: "state_transition", payload: { to: "QUEUED" } });
    expect(() => (db as Database.Database).prepare("UPDATE run_event SET type = 'x' WHERE id = ?").run(evt.id)).toThrow(
      /append-only/,
    );
    expect(() => (db as Database.Database).prepare("DELETE FROM run_event WHERE id = ?").run(evt.id)).toThrow(
      /append-only/,
    );
    expect(ledger.listRunEvents(run.id)).toHaveLength(1);
  });

  it("decision rejects UPDATE and DELETE", () => {
    db = openLedger(dir);
    const { session } = seed(db);
    db.prepare(
      "INSERT INTO decision (id, meta_session_id, decision, reason_summary, created_at) VALUES ('dec_1', ?, 'd', 'r', 't')",
    ).run(session.id);
    expect(() => (db as Database.Database).prepare("UPDATE decision SET decision = 'x'").run()).toThrow(/append-only/);
    expect(() => (db as Database.Database).prepare("DELETE FROM decision").run()).toThrow(/append-only/);
  });

  it("approval changes only from PENDING", () => {
    db = openLedger(dir);
    const d = db;
    const { run } = seed(d);
    d.prepare(
      "INSERT INTO approval (id, run_id, scope_json, scope_hash, status, requested_at) VALUES ('apv_1', ?, '{}', 'h', 'PENDING', 't')",
    ).run(run.id);
    d.prepare("UPDATE approval SET status = 'APPROVED', decided_at = 't2' WHERE id = 'apv_1'").run();
    expect(() => d.prepare("UPDATE approval SET status = 'DENIED' WHERE id = 'apv_1'").run()).toThrow(
      /already decided/,
    );
    expect(() => d.prepare("DELETE FROM approval").run()).toThrow(/append-only/);
  });
});

describe("repository helpers", () => {
  it("assigns gapless per-run event sequence numbers starting at 1", () => {
    db = openLedger(dir);
    const { ledger, session, run } = seed(db);
    const other = ledger.createRun({
      metaSessionId: session.id,
      trustProfile: "inspect-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h2",
      clientId: "c",
    });
    for (let i = 0; i < 3; i++) ledger.appendRunEvent({ runId: run.id, type: "t" });
    ledger.appendRunEvent({ runId: other.id, type: "t" });
    expect(ledger.listRunEvents(run.id).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(ledger.listRunEvents(other.id).map((e) => e.seq)).toEqual([1]);
  });

  it("generates prefixed IDs and enforces the run FAILED/failure_code check", () => {
    db = openLedger(dir);
    const { session, run } = seed(db);
    expect(session.id).toMatch(/^sess_/);
    expect(run.id).toMatch(/^run_/);
    expect(() => (db as Database.Database).prepare("UPDATE run SET state = 'FAILED' WHERE id = ?").run(run.id)).toThrow(
      /CHECK/,
    );
    expect(() =>
      (db as Database.Database)
        .prepare(
          "INSERT INTO meta_session (id, objective, status, created_at, updated_at) VALUES ('bad_1','o','ACTIVE','t','t')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("enforces idempotency-key uniqueness per client", () => {
    db = openLedger(dir);
    const { ledger, session } = seed(db);
    const mk = (client: string) =>
      ledger.createRun({
        metaSessionId: session.id,
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: "h",
        clientId: client,
        idempotencyKey: "k",
      });
    mk("a");
    expect(() => mk("a")).toThrow(/UNIQUE/);
    expect(() => mk("b")).not.toThrow();
  });
});
