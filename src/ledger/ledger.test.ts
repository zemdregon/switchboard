import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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
  "git_commit",
  "git_push",
  "inner_call",
  "meta_session",
  "project_event",
  "project_revision",
  "project_revision_decision",
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

  it("0002 adds nullable project_id to meta_session and run; existing rows keep NULL (ADR-0024)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 1))).toEqual([1]); // a database as 0001 left it
    const cols = (t: string) =>
      (db as Database.Database).prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[];
    expect(cols("run").map((c) => c.name)).not.toContain("project_id");
    const now = "2026-10-13T00:00:00.000Z";
    const session = { id: `sess_${"0".repeat(26)}` };
    const run = { id: `run_${"0".repeat(26)}` };
    db.prepare(
      "INSERT INTO meta_session (id, objective, status, created_at, updated_at) VALUES (?, 'before', 'ACTIVE', ?, ?)",
    ).run(session.id, now, now);
    db.prepare(
      `INSERT INTO run (id, meta_session_id, state, trust_profile, policy_snapshot_json, request_json, request_hash,
                        client_id, created_at, updated_at)
       VALUES (?, ?, 'QUEUED', 'edit-untrusted', '{}', '{}', 'h', 'c', ?, ?)`,
    ).run(run.id, session.id, now, now);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 2))).toEqual([2]);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 2))).toEqual([]); // idempotent
    for (const t of ["meta_session", "run"]) {
      const col = (db
        .prepare(`SELECT type, "notnull" AS nn FROM pragma_table_info('${t}') WHERE name = 'project_id'`)
        .get() ?? {}) as { type?: string; nn?: number };
      expect(col).toEqual({ type: "TEXT", nn: 0 });
    }
    const upgraded = createLedger(db, { ids: createIdGenerator() });
    expect(upgraded.getMetaSession(session.id)?.project_id).toBeNull();
    expect(upgraded.getRun(run.id)?.project_id).toBeNull();
    const s2 = upgraded.createMetaSession({ objective: "after", projectId: "web-app" });
    expect(upgraded.getMetaSession(s2.id)?.project_id).toBe("web-app");
    expect(
      upgraded.createRun({
        metaSessionId: s2.id,
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: "h2",
        clientId: "c",
        projectId: "web-app",
      }).project_id,
    ).toBe("web-app");
  });

  it("0003 adds git_commit and git_push to a version 2 database and keeps existing rows (ADR-0025)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 2))).toEqual([1, 2]); // a database as 0002 left it
    expect(tables(db)).not.toContain("git_commit");
    const now = "2026-10-13T00:00:00.000Z";
    const session = { id: `sess_${"0".repeat(26)}` };
    const run = { id: `run_${"0".repeat(26)}` };
    db.prepare(
      "INSERT INTO meta_session (id, objective, status, project_id, created_at, updated_at) VALUES (?, 'before', 'ACTIVE', 'web', ?, ?)",
    ).run(session.id, now, now);
    db.prepare(
      `INSERT INTO run (id, meta_session_id, state, trust_profile, policy_snapshot_json, request_json, request_hash,
                        client_id, project_id, created_at, updated_at)
       VALUES (?, ?, 'RUNNING', 'edit-untrusted', '{}', '{}', 'h', 'c', 'web', ?, ?)`,
    ).run(run.id, session.id, now, now);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 3))).toEqual([3]);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 3))).toEqual([]); // idempotent
    expect(currentSchemaVersion(db)).toBe(3);
    expect(tables(db)).toEqual(expect.arrayContaining(["git_commit", "git_push"]));
    expect(db.prepare("SELECT project_id FROM run WHERE id = ?").get(run.id)).toEqual({ project_id: "web" });

    // the new tables work through the repository helper and are linked to the existing rows
    const upgraded = createLedger(db, { ids: createIdGenerator() });
    const sha = "a".repeat(40);
    const rec = {
      commitSha: sha,
      treeSha: "b".repeat(40),
      repoRoot: "/repo",
      publishRef: `refs/heads/switchboard/pub/${session.id}`,
      projectId: "web",
      contextId: "main",
      metaSessionId: session.id,
      runId: run.id,
      provider: "fake",
      harness: "fake",
      origin: "commit_tool" as const,
      sanitizer: { rules: { "trailer.co-author": 1 } },
      eventPayload: { commit_sha: sha },
    };
    const first = upgraded.recordGitCommit(rec);
    expect(first.created).toBe(true);
    expect(first.row.id).toMatch(/^gcm_[0-9A-Z]{26}$/u);
    expect(first.row.tool_event_id).toBe(upgraded.listRunEvents(run.id)[0]?.id);
    expect(upgraded.recordGitCommit(rec)).toMatchObject({ created: false, row: { id: first.row.id } }); // idempotent
    expect(upgraded.listRunEvents(run.id)).toHaveLength(1);
    expect(upgraded.findGitCommitsBySha(sha).map((r) => r.run_id)).toEqual([run.id]);
  });

  it("git_commit and git_push are append-only and enforce their foreign keys and checks (LLD §1)", () => {
    db = openLedger(dir);
    const { ledger, session, run } = seed(db);
    const sha = "c".repeat(40);
    ledger.recordGitCommit({
      commitSha: sha,
      treeSha: "d".repeat(40),
      repoRoot: "/repo",
      publishRef: "refs/heads/switchboard/pub/x",
      projectId: "web",
      contextId: "main",
      metaSessionId: session.id,
      runId: run.id,
      provider: "fake",
      harness: "fake",
      origin: "commit_tool",
      sanitizer: { rules: {} },
      eventPayload: {},
    });
    expect(() => (db as Database.Database).prepare("UPDATE git_commit SET model = 'x'").run()).toThrow(/append-only/u);
    expect(() => (db as Database.Database).prepare("DELETE FROM git_commit").run()).toThrow(/append-only/u);
    const insertCommit = (runId: string, origin: string, json: string) =>
      (db as Database.Database)
        .prepare(
          `INSERT INTO git_commit (id, commit_sha, tree_sha, repo_root, publish_ref, project_id, context_id,
             meta_session_id, run_id, provider, harness, origin, sanitizer_json, created_at)
           VALUES ('gcm_x', 'e', 'f', '/r', 'refs/heads/p', 'web', 'main', ?, ?, 'p', 'p', ?, ?, 'now')`,
        )
        .run(session.id, runId, origin, json);
    expect(() => insertCommit("run_missing", "commit_tool", "{}")).toThrow(/FOREIGN KEY/u);
    expect(() => insertCommit(run.id, "magic", "{}")).toThrow(/CHECK/u);
    expect(() => insertCommit(run.id, "finalize_only", "not json")).toThrow(/CHECK/u);

    let n = 0;
    const insertPush = (outcome: string, by: string, runId: string | null) =>
      (db as Database.Database)
        .prepare(
          `INSERT INTO git_push (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, requested_by, created_at)
           VALUES (?, ?, 'web', 'main', 'origin', 'refs/heads/p', ?, ?, ?, 'now')`,
        )
        .run(`gps_${n++}`, runId, sha, outcome, by);
    insertPush("ACCEPTED", "operator", null); // an operator push has no run
    expect(() => insertPush("MAYBE", "operator", null)).toThrow(/CHECK/u);
    expect(() => insertPush("ACCEPTED", "nobody", null)).toThrow(/CHECK/u);
    expect(() => insertPush("ACCEPTED", "agent_tool", "run_missing")).toThrow(/FOREIGN KEY/u);
    expect(() => (db as Database.Database).prepare("UPDATE git_push SET detail = 'x'").run()).toThrow(/append-only/u);
    expect(() => (db as Database.Database).prepare("DELETE FROM git_push").run()).toThrow(/append-only/u);
  });

  it("inner_call (T11.1, LLD §13.3) upgrades from version 4, is append-only and enforces its checks and keys", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 4))).toEqual([1, 2, 3, 4]);
    expect(tables(db)).not.toContain("inner_call");
    expect(migrate(db)).toEqual([5]);
    expect(migrate(db)).toEqual([]);
    expect(currentSchemaVersion(db)).toBe(5);
    expect(tables(db)).toContain("inner_call");
    expect(tables(db)).not.toContain("inner_task_state"); // owned by T11.6

    const d = db;
    const { run } = seed(d);
    let n = 0;
    const insert = (over: Record<string, unknown> = {}) => {
      const row = {
        id: `inc_${String(n++).padStart(26, "0")}`,
        task: "run_title",
        backend_kind: "http",
        model_id: "m",
        locality: "local",
        template_version: "run_title.v1",
        outcome: "accepted",
        reason: null,
        attempts: 1,
        latency_ms: 5,
        tokens_in: null,
        tokens_out: null,
        input_bytes: 10,
        output_bytes: 4,
        input_sha256: "a".repeat(64),
        run_id: null,
        meta_session_id: null,
        created_at: "2026-10-13T00:00:00.000Z",
        ...over,
      };
      const cols = Object.keys(row);
      d.prepare(`INSERT INTO inner_call (${cols.join(",")}) VALUES (${cols.map((c) => `@${c}`).join(",")})`).run(row);
    };
    insert(); // outside a run
    insert({ run_id: run.id, outcome: "fallback_unavailable", reason: "TIMEOUT", attempts: 0 });
    expect(() => insert({ id: "bad_id" })).toThrow(/CHECK/u);
    expect(() => insert({ task: "shell" })).toThrow(/CHECK/u);
    expect(() => insert({ backend_kind: "ssh" })).toThrow(/CHECK/u);
    expect(() => insert({ locality: "lan" })).toThrow(/CHECK/u);
    expect(() => insert({ outcome: "maybe" })).toThrow(/CHECK/u);
    expect(() => insert({ attempts: 3 })).toThrow(/CHECK/u);
    expect(() => insert({ run_id: "run_missing" })).toThrow(/FOREIGN KEY/u);
    expect(() => insert({ meta_session_id: "sess_missing" })).toThrow(/FOREIGN KEY/u);
    expect(() => d.prepare("UPDATE inner_call SET reason = 'x'").run()).toThrow(/append-only/u);
    expect(() => d.prepare("DELETE FROM inner_call").run()).toThrow(/append-only/u);
    expect(d.prepare("SELECT COUNT(*) AS n FROM inner_call").get()).toEqual({ n: 2 });
  });

  it("applies only pending migrations in order", () => {
    db = openLedger(dir);
    const extra = {
      version: MIGRATIONS.length + 1,
      name: "extra",
      sql: "CREATE TABLE extra (id INTEGER PRIMARY KEY) STRICT;",
    };
    expect(migrate(db, undefined, [...MIGRATIONS, extra])).toEqual([extra.version]);
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
    const bad = {
      version: MIGRATIONS.length + 1,
      name: "bad",
      sql: "CREATE TABLE ok (id INTEGER) STRICT; SELECT * FROM nope;",
    };
    expect(() => migrate(db as Database.Database, undefined, [...MIGRATIONS, bad])).toThrow();
    expect(tables(db)).not.toContain("ok");
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS.length);
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

describe("approval helpers (T3.3, LLD §1 and §3.1)", () => {
  const mkRun = (ledger: ReturnType<typeof createLedger>, metaSessionId: string, clientId: string, snapshot = {}) =>
    ledger.createRun({
      metaSessionId,
      state: "AWAITING_APPROVAL",
      trustProfile: "privileged",
      policySnapshot: snapshot,
      request: {},
      requestHash: `h-${Math.random()}`,
      clientId,
    });

  it("creates, reads, lists and looks up approvals by meta-session and client", () => {
    db = openLedger(dir);
    const ledger = createLedger(db, { ids: createIdGenerator() });
    const s1 = ledger.createMetaSession({ objective: "a" });
    const s2 = ledger.createMetaSession({ objective: "b" });
    const id = ledger.newApprovalId();
    expect(id).toMatch(/^apv_[0-9A-HJKMNP-TV-Z]{26}$/);
    const r1 = mkRun(ledger, s1.id, "c1", { privilegedScope: { approvalId: id } });
    const a1 = ledger.createApproval({ id, runId: r1.id, scopeJson: '{"bypass":false}', scopeHash: "h1" });
    expect(a1).toMatchObject({ id, run_id: r1.id, status: "PENDING", decided_at: null, decided_by: null });
    const r2 = mkRun(ledger, s2.id, "c1");
    const a2 = ledger.createApproval({ runId: r2.id, scopeJson: "{}", scopeHash: "h2" });
    expect(ledger.getApproval(id)).toEqual(a1);
    expect(ledger.getApprovalForRun(r2.id)?.id).toBe(a2.id);
    expect(ledger.getApprovalForRun("run_nope")).toBeUndefined();
    expect(ledger.listApprovals().map((a) => a.id)).toEqual([a1.id, a2.id]);
    expect(ledger.listApprovals({ limit: 1 }).map((a) => a.id)).toEqual([a1.id]);
    expect(ledger.findApprovalForMetaSession(s1.id, "c1")?.id).toBe(a1.id);
    expect(ledger.findApprovalForMetaSession(s1.id, "c2")).toBeUndefined(); // another client never matches
    expect(ledger.findApprovalForMetaSession(s2.id, "c1")?.id).toBe(a2.id);
    // A later run of the meta-session names the approval in its snapshot and is listed as covered.
    const later = mkRun(ledger, s1.id, "c1", { privilegedScope: { approvalId: id } });
    expect(ledger.listRunsCoveredByApproval(id).map((r) => r.id)).toEqual([r1.id, later.id]);
    expect(ledger.findApprovalForMetaSession(s1.id, "c1")?.id).toBe(a1.id); // still one row per meta-session
    // A second row for one meta-session is an invariant violation: fail closed.
    ledger.createApproval({ runId: later.id, scopeJson: "{}", scopeHash: "h3" });
    expect(() => ledger.findApprovalForMetaSession(s1.id, "c1")).toThrow(/more than one approval/);
  });

  it("decides once: PENDING to APPROVED or DENIED, never again, never other columns", () => {
    db = openLedger(dir);
    const ledger = createLedger(db, { ids: createIdGenerator(), now: () => new Date("2026-10-13T00:00:00Z") });
    const s = ledger.createMetaSession({ objective: "a" });
    const a = ledger.createApproval({ runId: mkRun(ledger, s.id, "c1").id, scopeJson: "{}", scopeHash: "h" });
    const approved = ledger.decideApproval({ id: a.id, status: "APPROVED", decidedBy: "op" });
    expect(approved).toMatchObject({
      status: "APPROVED",
      decided_by: "op",
      decided_at: "2026-10-13T00:00:00.000Z",
      scope_json: "{}",
      scope_hash: "h",
    });
    expect(ledger.decideApproval({ id: a.id, status: "DENIED", decidedBy: "op" })).toBeUndefined();
    expect(ledger.getApproval(a.id)?.status).toBe("APPROVED");
    expect(ledger.decideApproval({ id: "apv_missing", status: "DENIED", decidedBy: "op" })).toBeUndefined();
    const b = ledger.createApproval({ runId: mkRun(ledger, s.id, "c1").id, scopeJson: "{}", scopeHash: "h" });
    expect(() => ledger.decideApproval({ id: b.id, status: "EXPIRED" as never, decidedBy: "op" })).toThrow();
    expect(() => ledger.decideApproval({ id: b.id, status: "DENIED", decidedBy: "" })).toThrow();
    expect(ledger.decideApproval({ id: b.id, status: "DENIED", decidedBy: "cancel_run" })?.status).toBe("DENIED");
    expect(ledger.listApprovals({ status: "DENIED" }).map((x) => x.id)).toEqual([b.id]);
  });
});
