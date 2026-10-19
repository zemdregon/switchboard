import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAIN_COLUMNS,
  CHAIN_GENESIS,
  canonicalJson,
  chainHash,
  createLedger,
  hasChainColumns,
  insertChainedRunEvent,
  type Ledger,
  MIGRATIONS,
  migrate,
  migrationChecksum,
  nextChainLink,
  openLedger,
  verifyChain,
} from "./index.js";

let dir: string;
let db: Database.Database;
let ledger: Ledger;
let runId: string;

/** A meta-session and one run, the parents every event and approval row needs. */
function seedRun(d: Database.Database): { ledger: Ledger; runId: string } {
  const l = createLedger(d);
  const s = l.createMetaSession({ objective: "o" });
  const run = l.createRun({
    metaSessionId: s.id,
    state: "QUEUED",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c1",
    provider: "fake",
  });
  return { ledger: l, runId: run.id };
}

const events = (n: number) =>
  Array.from({ length: n }, (_, i) => ledger.appendRunEvent({ runId, type: "note", payload: { i } }));

/** What someone editing the file with any SQLite client can do: drop a guard (ADR-0005) and change rows. */
const tamper = (sql: string, ...args: unknown[]) => {
  db.exec("DROP TRIGGER IF EXISTS run_event_no_update; DROP TRIGGER IF EXISTS run_event_no_delete;");
  db.exec("DROP TRIGGER IF EXISTS approval_update_once; DROP TRIGGER IF EXISTS approval_no_delete;");
  db.prepare(sql).run(...args);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-chain-"));
  db = openLedger(dir);
  ({ ledger, runId } = seedRun(db));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("chain format (ADR-0064 items 4 and 5)", () => {
  it("canonical JSON has the chained columns in code-unit order, and every one exists in its table", () => {
    for (const table of ["run_event", "approval"] as const) {
      const cols = CHAIN_COLUMNS[table];
      expect([...cols].sort()).toEqual(cols);
      const present = (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      for (const c of cols) expect(present).toContain(c);
      expect(cols).not.toContain("chain_hash");
    }
  });

  it("matches a known-answer vector computed outside this code (sha256sum over genesis + canonical JSON)", () => {
    const canonical = canonicalJson("run_event", {
      type: "note",
      ts: "2026-10-19T00:00:00.000Z",
      seq: 1,
      run_id: "run_A",
      payload_json: '{"k":"é"}',
      id: "evt_A",
      chain_seq: 1,
      extra_column: "not chained",
    });
    expect(canonical).toBe(
      '{"artifact_id":null,"chain_seq":1,"id":"evt_A","payload_json":"{\\"k\\":\\"é\\"}","run_id":"run_A","seq":1,' +
        '"ts":"2026-10-19T00:00:00.000Z","type":"note"}',
    );
    expect(CHAIN_GENESIS).toBe("0".repeat(64));
    expect(chainHash(CHAIN_GENESIS, canonical)).toBe(
      "3280c662e6bdd69ede3a792a5fd2590b79e0477f6a0124a7d6ac1ec156625fe1",
    );
  });
});

describe("append path (ADR-0064 item 6)", () => {
  it("links every run_event row in insertion order and each decided approval in decision order", () => {
    const before = verifyChain(db, "run_event").length;
    const appended = events(3);
    const rows = db.prepare("SELECT id, chain_seq, chain_hash FROM run_event ORDER BY chain_seq").all() as {
      id: string;
      chain_seq: number;
      chain_hash: string;
    }[];
    expect(rows.slice(-3).map((r) => r.id)).toEqual(appended.map((e) => e.id));
    expect(rows.map((r) => r.chain_seq)).toEqual(rows.map((_, i) => i + 1));

    const a1 = ledger.createApproval({ runId, scopeJson: "{}", scopeHash: "h1" });
    const a2 = ledger.createApproval({ runId, scopeJson: "{}", scopeHash: "h2" });
    // A PENDING approval is not linked yet: it may still change once.
    expect(db.prepare("SELECT chain_seq, chain_hash FROM approval WHERE id = ?").get(a1.id)).toEqual({
      chain_seq: null,
      chain_hash: null,
    });
    ledger.decideApproval({ id: a2.id, status: "DENIED", decidedBy: "op" });
    ledger.decideApproval({ id: a1.id, status: "APPROVED", decidedBy: "op" });
    expect(db.prepare("SELECT id FROM approval ORDER BY chain_seq").all()).toEqual([{ id: a2.id }, { id: a1.id }]);
    // A second decision is still refused by the guard and does not touch the link.
    expect(ledger.decideApproval({ id: a1.id, status: "DENIED", decidedBy: "op" })).toBeUndefined();

    expect(verifyChain(db, "run_event")).toMatchObject({ length: before + 3 });
    expect(verifyChain(db, "run_event").broken).toBeUndefined();
    expect(verifyChain(db, "approval")).toEqual({
      table: "approval",
      length: 2,
      head: (db.prepare("SELECT chain_hash FROM approval WHERE id = ?").get(a1.id) as { chain_hash: string })
        .chain_hash,
    });
  });

  it("a writer holding a stale head fails on the unique chain_seq instead of forking the chain", () => {
    events(1);
    const stale = nextChainLink(db, "run_event", { id: "evt_stale" });
    events(1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_event (id, run_id, seq, ts, type, payload_json, chain_seq, chain_hash)
           VALUES ('evt_stale', ?, 99, 't', 'x', '{}', ?, ?)`,
        )
        .run(runId, stale.chain_seq, stale.chain_hash),
    ).toThrow(/UNIQUE/u);
    expect(verifyChain(db, "run_event").broken).toBeUndefined();
  });

  it("the guards still refuse an UPDATE of a linked row (migration 26 recreated them)", () => {
    const [e] = events(1);
    expect(() => db.prepare("UPDATE run_event SET chain_hash = ? WHERE id = ?").run("f".repeat(64), e?.id)).toThrow(
      /append-only/u,
    );
  });
});

describe("verifyChain names the first broken row (ADR-0064 item 8)", () => {
  it("an untouched ledger verifies", () => {
    events(5);
    const apv = ledger.createApproval({ runId, scopeJson: "{}", scopeHash: "h" });
    ledger.decideApproval({ id: apv.id, status: "APPROVED", decidedBy: "op" });
    ledger.createApproval({ runId, scopeJson: "{}", scopeHash: "pending" });
    expect(verifyChain(db, "run_event").broken).toBeUndefined();
    expect(verifyChain(db, "approval")).toMatchObject({ length: 1 });
    expect(verifyChain(db, "approval").broken).toBeUndefined();
  });

  it("an in-place edit of one event names exactly that row", () => {
    const e = events(4);
    tamper("UPDATE run_event SET payload_json = ? WHERE id = ?", '{"i":99}', e[1]?.id);
    const v = verifyChain(db, "run_event");
    expect(v.broken).toMatchObject({ id: e[1]?.id, reason: expect.stringContaining("chain_hash does not match") });
  });

  it("deleting a middle event names the row after the gap", () => {
    const e = events(4);
    tamper("DELETE FROM run_event WHERE id = ?", e[1]?.id);
    expect(verifyChain(db, "run_event").broken).toMatchObject({
      id: e[2]?.id,
      reason: expect.stringContaining("a linked row is missing"),
    });
  });

  it("an event inserted by hand without a link is named", () => {
    events(2);
    db.prepare(
      "INSERT INTO run_event (id, run_id, seq, ts, type, payload_json) VALUES ('evt_byhand', ?, 50, 't', 'x', '{}')",
    ).run(runId);
    expect(verifyChain(db, "run_event").broken).toEqual({
      id: "evt_byhand",
      chain_seq: null,
      reason: "the row has no chain link",
    });
  });

  it("an edited approval decision, or a decision reset to PENDING, is named", () => {
    const a = ledger.createApproval({ runId, scopeJson: "{}", scopeHash: "h" });
    ledger.decideApproval({ id: a.id, status: "DENIED", decidedBy: "op" });
    tamper("UPDATE approval SET status = 'APPROVED' WHERE id = ?", a.id);
    expect(verifyChain(db, "approval").broken).toMatchObject({ id: a.id, chain_seq: 1 });
    tamper(
      "UPDATE approval SET status = 'PENDING', decided_at = NULL, decided_by = NULL, chain_seq = NULL WHERE id = ?",
      a.id,
    );
    expect(verifyChain(db, "approval").broken).toEqual({
      id: a.id,
      chain_seq: null,
      reason: "a PENDING approval carries a chain link",
    });
  });
});

describe("migration 26 backfill (ADR-0064 item 7)", () => {
  it("links the rows of a pre-migration ledger in insertion order and leaves PENDING approvals unlinked", () => {
    const d = new Database(path.join(dir, "m24.sqlite"));
    try {
      d.pragma("foreign_keys = ON");
      d.pragma("recursive_triggers = ON");
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 24),
      );
      expect(hasChainColumns(d)).toBe(false);
      const { runId: r } = seedRun(d);
      // Ids deliberately out of insertion order: the backfill follows insertion (rowid), not id text.
      const ids = ["evt_C", "evt_A", "evt_B"];
      for (const [i, id] of ids.entries()) {
        d.prepare("INSERT INTO run_event (id, run_id, seq, ts, type, payload_json) VALUES (?, ?, ?, 't', 'x', ?)").run(
          id,
          r,
          i + 1,
          JSON.stringify({ i }),
        );
      }
      d.prepare(
        `INSERT INTO approval (id, run_id, scope_json, scope_hash, status, requested_at, decided_at, decided_by)
         VALUES ('apv_2', ?, '{}', 'h', 'APPROVED', 't', 't2', 'op'), ('apv_1', ?, '{}', 'h', 'PENDING', 't', NULL, NULL),
                ('apv_0', ?, '{}', 'h', 'DENIED', 't', 't3', 'op')`,
      ).run(r, r, r);

      expect(migrate(d, undefined, MIGRATIONS)).toEqual(MIGRATIONS.filter((m) => m.version > 24).map((m) => m.version));
      expect(d.prepare("SELECT id, chain_seq FROM run_event ORDER BY chain_seq").all()).toEqual(
        ids.map((id, i) => ({ id, chain_seq: i + 1 })),
      );
      expect(d.prepare("SELECT id, chain_seq FROM approval ORDER BY rowid").all()).toEqual([
        { id: "apv_2", chain_seq: 1 },
        { id: "apv_1", chain_seq: null },
        { id: "apv_0", chain_seq: 2 },
      ]);
      expect(verifyChain(d, "run_event")).toMatchObject({ length: 3 });
      expect(verifyChain(d, "run_event").broken).toBeUndefined();
      expect(verifyChain(d, "approval")).toMatchObject({ length: 2 });
      expect(verifyChain(d, "approval").broken).toBeUndefined();
      // The guards are back after the backfill.
      expect(() => d.prepare("UPDATE run_event SET type = 'y' WHERE id = 'evt_A'").run()).toThrow(/append-only/u);
      expect(() => d.prepare("UPDATE approval SET decided_by = 'x' WHERE id = 'apv_2'").run()).toThrow(
        /already decided/u,
      );
      // The new append path continues the backfilled chain.
      insertChainedRunEvent(d, { id: "evt_D", runId: r, ts: "t", type: "x", payloadJson: "{}" });
      expect(verifyChain(d, "run_event")).toMatchObject({ length: 4 });
    } finally {
      d.close();
    }
  });

  it("a failed backfill rolls the whole migration back, guards included", () => {
    const d = new Database(path.join(dir, "m24-fail.sqlite"));
    try {
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 24),
      );
      const m26 = MIGRATIONS.find((m) => m.version === 26);
      if (m26 === undefined) throw new Error("migration 26 missing");
      const failing = {
        ...m26,
        backfill: () => {
          throw new Error("boom");
        },
      };
      expect(() => migrate(d, undefined, [...MIGRATIONS.filter((m) => m.version <= 24), failing])).toThrow("boom");
      expect(hasChainColumns(d)).toBe(false);
      const triggers = d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
      expect(triggers).toContainEqual({ name: "run_event_no_update" });
      expect(triggers).toContainEqual({ name: "approval_update_once" });
    } finally {
      d.close();
    }
  });

  it("the checksum covers postSql, and migrations without it keep their old checksum", () => {
    const m26 = MIGRATIONS.find((m) => m.version === 26);
    if (m26 === undefined) throw new Error("migration 26 missing");
    expect(migrationChecksum(m26)).not.toBe(migrationChecksum({ ...m26, postSql: "" }));
    const { postSql: _drop, ...withoutPost } = m26;
    expect(migrationChecksum(withoutPost)).not.toBe(migrationChecksum(m26));
    const m24 = MIGRATIONS.find((m) => m.version === 24);
    if (m24 === undefined) throw new Error("migration 24 missing");
    expect(migrationChecksum(m24)).toBe(createHash("sha256").update(m24.sql).digest("hex"));
  });
});
