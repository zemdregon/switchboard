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
  "ci_ref_conflict",
  "ci_rerun",
  "ci_run_cancel",
  "ci_trigger_event",
  "ci_trigger_ref_state",
  "control_plane_event",
  "control_plane_state",
  "decision",
  "decision_request",
  "dependency_seed",
  "dependency_seed_use",
  "eval_result",
  "gc_orphan",
  "git_commit",
  "git_push",
  "http_subject",
  "inner_call",
  "inner_task_state",
  "merge_event",
  "meta_session",
  "oauth_cimd_client",
  "oauth_client",
  "oauth_pairing_code",
  "oauth_token",
  "project_affinity",
  "project_event",
  "project_revision",
  "project_revision_decision",
  "project_schedule",
  "project_work_dependency",
  "project_work_event",
  "project_work_item",
  "provider_binding",
  "provider_health",
  "pull_request",
  "rag_record",
  "rag_request",
  "ref_event",
  "route_decision",
  "run",
  "run_event",
  "run_rebase",
  "run_skill",
  "schema_migrations",
  "skill_event",
  "skill_version",
  "usage_observation",
  "verification_result",
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

// Versions are not contiguous (0008 is reserved for T11.6), so the newest version is not the migration count.
const LATEST_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

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
  it("0022 keeps every artifact row, adds the seed_log kind and the dependency seed tables (T9.13)", () => {
    const d = new Database(path.join(dir, "m22.sqlite"));
    try {
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 21),
      );
      const { ledger, session, run } = seed(d);
      ledger.insertArtifact({
        runId: run.id,
        metaSessionId: session.id,
        kind: "diff",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        mediaType: "text/x-diff",
      });
      expect(
        migrate(
          d,
          undefined,
          MIGRATIONS.filter((m) => m.version <= 22),
        ),
      ).toEqual([22]);
      expect(d.prepare("SELECT kind FROM artifact").all()).toEqual([{ kind: "diff" }]);
      ledger.insertArtifact({
        runId: run.id,
        metaSessionId: session.id,
        kind: "seed_log",
        sha256: "b".repeat(64),
        sizeBytes: 1,
        mediaType: "application/json",
      });
      expect(() =>
        d
          .prepare(
            `INSERT INTO dependency_seed_use (run_id, seed_key, worktree_path, directory, method, populated_at)
             VALUES (?, 'k', '/w', 'node_modules', 'hardlink', 'x')`,
          )
          .run(run.id),
      ).toThrow(/CHECK/u);
      expect(() =>
        d
          .prepare(
            `INSERT INTO dependency_seed (seed_key, project_id, seed_id, lockfile_sha256, profile, environment, state,
               created_at) VALUES (?, 'p', 's', 'l', 'edit-untrusted', '{}', 'ready', 'x')`,
          )
          .run("short"),
      ).toThrow(/CHECK/u);
    } finally {
      d.close();
    }
  });

  it("creates all tables from an empty database and records the version", () => {
    db = openLedger(dir);
    expect(tables(db)).toEqual(EXPECTED_TABLES);
    expect(currentSchemaVersion(db)).toBe(LATEST_VERSION);
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

    // the new tables work through the repository helper (which writes the current schema, so the later migrations are
    // applied first; T11.4 added git_commit columns in 0007) and are linked to the existing rows
    migrate(db);
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

  it("0009 widens artifact.kind to pr_draft, keeping rows, references and foreign keys (T11.8)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo8 = MIGRATIONS.filter((m) => m.version < 9);
    expect(migrate(d, undefined, upTo8)).toEqual(upTo8.map((m) => m.version));
    const { ledger, session, run } = seed(d);
    const art = ledger.insertArtifact({
      runId: run.id,
      metaSessionId: session.id,
      kind: "diff",
      sha256: "e".repeat(64),
      sizeBytes: 3,
      mediaType: "text/plain",
    });
    // A plain insert, as a writer of this schema version did (the chained writer needs migration 26's columns).
    d.prepare(
      "INSERT INTO run_event (id, run_id, seq, ts, type, payload_json, artifact_id) VALUES ('evt_old', ?, 1, 't', 'x', '{}', ?)",
    ).run(run.id, art);
    expect(() =>
      ledger.insertArtifact({
        runId: run.id,
        metaSessionId: session.id,
        kind: "pr_draft",
        sha256: "f".repeat(64),
        sizeBytes: 1,
        mediaType: "application/json",
      }),
    ).toThrow(/CHECK/u);
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 9),
      ),
    ).toEqual([9]);
    expect(d.pragma("foreign_keys", { simple: true })).toBe(1); // restored after the rebuild
    expect(d.pragma("foreign_key_check")).toEqual([]);
    expect(d.prepare("SELECT id, kind, deleted_at FROM artifact").all()).toEqual([
      { id: art, kind: "diff", deleted_at: null },
    ]);
    expect(ledger.listRunEvents(run.id)[0]?.artifact_id).toBe(art);
    const draft = ledger.insertArtifact({
      runId: run.id,
      metaSessionId: session.id,
      kind: "pr_draft",
      sha256: "f".repeat(64),
      sizeBytes: 1,
      mediaType: "application/json",
    });
    expect(ledger.listArtifactsForRun(run.id).map((a) => a.id)).toEqual([art, draft]);
    expect(() =>
      d
        .prepare(
          "INSERT INTO artifact (id, kind, sha256, size_bytes, media_type, created_at) VALUES ('art_x','nope','a',1,'t','t')",
        )
        .run(),
    ).toThrow(/CHECK/u);
    // the index and the foreign key from run_event still hold
    expect(d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='artifact_run'").all()).toHaveLength(
      1,
    );
    expect(() => d.prepare("DELETE FROM artifact WHERE id = ?").run(art)).toThrow(/FOREIGN KEY/u);
  });

  it("0016 widens artifact.kind to handoff_condense, keeping rows, references and foreign keys (T11.10)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo15 = MIGRATIONS.filter((m) => m.version < 16);
    expect(migrate(d, undefined, upTo15)).toEqual(upTo15.map((m) => m.version));
    const { ledger, session, run } = seed(d);
    const art = ledger.insertArtifact({
      runId: run.id,
      metaSessionId: session.id,
      kind: "handoff_view",
      sha256: "a".repeat(64),
      sizeBytes: 3,
      mediaType: "application/json",
    });
    // A plain insert, as a writer of this schema version did (the chained writer needs migration 26's columns).
    d.prepare(
      "INSERT INTO run_event (id, run_id, seq, ts, type, payload_json, artifact_id) VALUES ('evt_old', ?, 1, 't', 'handoff_built', '{}', ?)",
    ).run(run.id, art);
    expect(() =>
      ledger.insertArtifact({
        runId: run.id,
        metaSessionId: session.id,
        kind: "handoff_condense",
        sha256: "b".repeat(64),
        sizeBytes: 1,
        mediaType: "application/json",
      }),
    ).toThrow(/CHECK/u);
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 16),
      ),
    ).toEqual([16]);
    expect(d.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(d.pragma("foreign_key_check")).toEqual([]);
    expect(d.prepare("SELECT id, kind, deleted_at FROM artifact").all()).toEqual([
      { id: art, kind: "handoff_view", deleted_at: null },
    ]);
    expect(ledger.listRunEvents(run.id)[0]?.artifact_id).toBe(art);
    const condensed = ledger.insertArtifact({
      runId: run.id,
      metaSessionId: session.id,
      kind: "handoff_condense",
      sha256: "b".repeat(64),
      sizeBytes: 1,
      mediaType: "application/json",
    });
    expect(ledger.listArtifactsForRun(run.id).map((a) => a.kind)).toEqual(["handoff_view", "handoff_condense"]);
    expect(condensed).toMatch(/^art_/u);
    expect(() =>
      d
        .prepare(
          "INSERT INTO artifact (id, kind, sha256, size_bytes, media_type, created_at) VALUES ('art_x','nope','a',1,'t','t')",
        )
        .run(),
    ).toThrow(/CHECK/u);
    expect(d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='artifact_run'").all()).toHaveLength(
      1,
    );
    expect(() => d.prepare("DELETE FROM artifact WHERE id = ?").run(art)).toThrow(/FOREIGN KEY/u);
  });

  it("0017 adds project work queue tables on a version 16 database (T15.1, FR-QUE-01)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo15 = MIGRATIONS.filter((m) => m.version < 16);
    expect(migrate(d, undefined, upTo15)).toEqual(upTo15.map((m) => m.version));
    const { ledger, run } = seed(d);
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 17),
      ),
    ).toEqual([16, 17]);
    expect(ledger.getRun(run.id)?.id).toBe(run.id);
    expect(() =>
      d
        .prepare(
          `INSERT INTO project_work_item (id, project_id, creator_client_id, state, priority, request_json, source_kind,
            created_at, updated_at) VALUES ('que_x','p','c','NOT_A_STATE',0,'{}','mcp','t','t')`,
        )
        .run(),
    ).toThrow(/CHECK/u);
    // The current writer reads migration 29's columns (T15.7), so the ledger behaviour is checked on the latest schema.
    migrate(d);
    const item = ledger.enqueueWorkItem({
      projectId: "p",
      creatorClientId: "c",
      request: { objective: "x", trust_profile: "edit-untrusted", project: "p" },
      sourceKind: "mcp",
      idempotencyKey: "k1",
      idempotentReturnExisting: true,
    });
    expect(
      ledger.enqueueWorkItem({
        projectId: "p",
        creatorClientId: "c",
        request: { objective: "x", trust_profile: "edit-untrusted", project: "p" },
        sourceKind: "mcp",
        idempotencyKey: "k1",
        idempotentReturnExisting: true,
      }).id,
    ).toBe(item.id);
    expect(() =>
      ledger.enqueueWorkItem({
        projectId: "p",
        creatorClientId: "other",
        request: {},
        sourceKind: "mcp",
        idempotencyKey: "k1",
        idempotentReturnExisting: true,
      }),
    ).not.toThrow();
    expect(() =>
      d
        .prepare("INSERT INTO project_work_dependency (successor_id, predecessor_id) VALUES ('que_missing','que_x')")
        .run(),
    ).toThrow(/FOREIGN KEY/u);
  });

  it("0020 adds project_schedule table on a version 19 database (T15.2, FR-QUE-02, LLD §18.5)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo19 = MIGRATIONS.filter((m) => m.version <= 19);
    expect(migrate(d, undefined, upTo19)).toEqual(upTo19.map((m) => m.version));
    const ledger = createLedger(d);

    // Existing work queue item on v19: a plain insert, as a writer of this schema version did (the current writer
    // needs migration 29's columns, T15.7).
    d.prepare(
      `INSERT INTO project_work_item (id, project_id, creator_client_id, state, priority, request_json, source_kind,
         created_at, updated_at) VALUES ('que_v19', 'proj-1', 'client-a', 'READY', 0, '{}', 'mcp', 't', 't')`,
    ).run();
    const item = { id: "que_v19" };

    // Migrate to 20
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 20),
      ),
    ).toEqual([20]);

    // Existing work item preserved
    expect(d.prepare("SELECT id FROM project_work_item WHERE id = ?").get(item.id)).toEqual({ id: item.id });

    // Table constraints on project_schedule
    expect(() =>
      d
        .prepare(
          `INSERT INTO project_schedule (id, project_id, creator_client_id, cron_expr, enabled, template_json, created_at, approval_state)
           VALUES ('sch_bad','p','c','* * * * *',2,'{}','2026-10-16T11:00:00Z','APPROVED')`,
        )
        .run(),
    ).toThrow(/CHECK/u);

    expect(() =>
      d
        .prepare(
          `INSERT INTO project_schedule (id, project_id, creator_client_id, cron_expr, enabled, template_json, created_at, approval_state)
           VALUES ('sch_bad2','p','c','* * * * *',0,'{}','2026-10-16T11:00:00Z','INVALID_STATE')`,
        )
        .run(),
    ).toThrow(/CHECK/u);

    // Helper functions: createSchedule off by default
    const sch = ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "0 * * * *",
      template: { objective: "hourly cleanup" },
    });
    expect(sch.enabled).toBe(0); // Off by default (FR-QUE-02)
    expect(sch.approval_state).toBe("APPROVED");
    expect(sch.cron_expr).toBe("0 * * * *");
    expect(ledger.getSchedule(sch.id)?.id).toBe(sch.id);

    // enableSchedule and disableSchedule
    const enabled = ledger.enableSchedule(sch.id);
    expect(enabled?.enabled).toBe(1);
    expect(enabled?.disabled_at).toBeNull();

    const disabled = ledger.disableSchedule(sch.id);
    expect(disabled?.enabled).toBe(0);
    expect(disabled?.disabled_at).not.toBeNull();

    // PENDING_APPROVAL schedule cannot be enabled until approved
    const pending = ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "chat-bot",
      cronExpr: "*/5 * * * *",
      template: { objective: "widened task" },
      approvalState: "PENDING_APPROVAL",
    });
    expect(pending.enabled).toBe(0);
    expect(pending.approval_state).toBe("PENDING_APPROVAL");
    expect(() => ledger.enableSchedule(pending.id)).toThrow(
      /cannot enable schedule in approval_state PENDING_APPROVAL/u,
    );

    // approveSchedule
    const approved = ledger.approveSchedule(pending.id);
    expect(approved?.approval_state).toBe("APPROVED");
    expect(approved?.enabled).toBe(0); // Remains off by default
    expect(ledger.enableSchedule(pending.id)?.enabled).toBe(1);

    // denySchedule
    const denied = ledger.denySchedule(pending.id);
    expect(denied?.approval_state).toBe("REJECTED");
    expect(denied?.enabled).toBe(0);
    expect(() => ledger.enableSchedule(pending.id)).toThrow(/cannot enable schedule in approval_state REJECTED/u);

    // Invalid cron rejected
    expect(() =>
      ledger.createSchedule({
        projectId: "proj-1",
        creatorClientId: "c",
        cronExpr: "invalid cron expr",
        template: {},
      }),
    ).toThrow();
  });

  it("0024 adds ci_rerun and ci_run_cancel on a version 23 database; one rerun per (ref, head SHA, job) (T15.6, FR-QUE-06)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo23 = MIGRATIONS.filter((m) => m.version <= 23);
    expect(migrate(d, undefined, upTo23)).toEqual(upTo23.map((m) => m.version));
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 24),
      ),
    ).toEqual([24]);
    const rerun = d.prepare(
      `INSERT INTO ci_rerun (project_id, publish_ref, head_sha, job_name, run_id, attempt, outcome, requested_at)
       VALUES ('p', 'refs/heads/b', ?, 'linux', ?, 1, ?, '2026-10-19T00:00:00Z')`,
    );
    rerun.run("a".repeat(40), "1", "requested");
    expect(() => rerun.run("a".repeat(40), "2", "requested")).toThrow(/UNIQUE|PRIMARY/u);
    expect(() => rerun.run("b".repeat(40), "3", "done")).toThrow(/CHECK/u);
    const cancel = d.prepare(
      `INSERT INTO ci_run_cancel (id, project_id, publish_ref, head_sha, run_id, outcome, cancelled_at)
       VALUES (?, 'p', 'refs/heads/b', ?, '9', 'cancelled', '2026-10-19T00:00:00Z')`,
    );
    cancel.run("crc_1", "a".repeat(40));
    expect(() => cancel.run("crc_2", "a".repeat(40))).toThrow(/UNIQUE/u);
  });

  it("0028 adds oauth_cimd_client on a version 27 database: one URL per derived sbc_ id, cascading from oauth_client (T13.11, FR-MCP-19)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo27 = MIGRATIONS.filter((m) => m.version <= 27);
    expect(migrate(d, undefined, upTo27)).toEqual(upTo27.map((m) => m.version));
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 28),
      ),
    ).toEqual([28]);
    const client = d.prepare(
      `INSERT INTO oauth_client (client_id, redirect_uris_json, grant_types_json, status, created_at)
       VALUES (?, '["https://app.example/cb"]', '["authorization_code"]', 'pending', '2026-10-19T00:00:00Z')`,
    );
    client.run("sbc_a");
    client.run("sbc_b");
    const cimd = d.prepare(
      "INSERT INTO oauth_cimd_client (client_id, url, fetched_at) VALUES (?, ?, '2026-10-19T00:00:00Z')",
    );
    cimd.run("sbc_a", "https://app.example/client");
    expect(() => cimd.run("sbc_b", "https://app.example/client")).toThrow(/UNIQUE/u); // one row per URL
    expect(() => cimd.run("sbc_b", "http://app.example/client")).toThrow(/CHECK/u); // https only
    expect(() => cimd.run("sbc_c", "https://app.example/other")).toThrow(/FOREIGN KEY/u); // needs the client row
    expect(() => cimd.run("x_b", "https://app.example/other")).toThrow(/CHECK|FOREIGN KEY/u);
    d.prepare("DELETE FROM oauth_client WHERE client_id = 'sbc_a'").run();
    expect(d.prepare("SELECT COUNT(*) AS n FROM oauth_cimd_client").get()).toEqual({ n: 0 });
  });

  it("0030 adds decision_request and PARKED_DECISION on a version 29 database, keeping every work item, event and T15.7 column (T14.15, FR-CTL-13)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo29 = MIGRATIONS.filter((m) => m.version <= 29);
    expect(migrate(d, undefined, upTo29)).toEqual(upTo29.map((m) => m.version));
    const at = "2026-10-20T00:00:00.000Z";
    const item = d.prepare(
      `INSERT INTO project_work_item (id, project_id, creator_client_id, state, request_json, source_kind, created_at,
         updated_at, dedupe_key, hot_paths_json) VALUES (?, 'web', 'orch', ?, '{}', 'mcp', ?, ?, ?, ?)`,
    );
    item.run("que_A", "READY", at, at, "ref:a", '["src/**"]');
    item.run("que_B", "PENDING", at, at, null, null);
    d.prepare("INSERT INTO project_work_dependency (successor_id, predecessor_id) VALUES ('que_B', 'que_A')").run();
    d.prepare(
      "INSERT INTO project_work_event (id, work_item_id, type, created_at) VALUES ('pwe_1', 'que_A', 'enqueued', ?)",
    ).run(at);
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 30),
      ),
    ).toEqual([30]);

    // Rows, dependencies, events and the 0029 columns survive the rebuild; the foreign keys still hold.
    expect(
      d.prepare("SELECT id, state, dedupe_key, hot_paths_json, superseded_by FROM project_work_item ORDER BY id").all(),
    ).toEqual([
      { id: "que_A", state: "READY", dedupe_key: "ref:a", hot_paths_json: '["src/**"]', superseded_by: null },
      { id: "que_B", state: "PENDING", dedupe_key: null, hot_paths_json: null, superseded_by: null },
    ]);
    // The 0029 dedupe index is recreated: a second live item with the same key is refused.
    expect(() => item.run("que_C", "READY", at, at, "ref:a", null)).toThrow(/UNIQUE/u);
    expect(d.prepare("SELECT COUNT(*) AS n FROM project_work_dependency").get()).toEqual({ n: 1 });
    expect(d.prepare("SELECT type FROM project_work_event").all()).toEqual([{ type: "enqueued" }]);
    expect(d.pragma("foreign_key_check")).toEqual([]);
    const setState = (s: string) => d.prepare("UPDATE project_work_item SET state = ? WHERE id = 'que_A'").run(s);
    setState("PARKED_DECISION");
    expect(() => setState("PARKED")).toThrow(/CHECK/u);
    d.prepare(
      "INSERT INTO project_work_event (id, work_item_id, type, created_at) VALUES ('pwe_2', 'que_A', 'parked', ?)",
    ).run(at);

    const decision = d.prepare(
      `INSERT INTO decision_request (id, project_id, work_item_id, requester_client_id, question, options_json,
         recommended_option, state, created_at) VALUES (?, 'web', ?, 'orch', ?, '[]', 1, 'open', ?)`,
    );
    decision.run("dec_1", "que_A", "Which way?", at);
    // At most one open decision per work item; the item must exist; the question is capped.
    expect(() => decision.run("dec_2", "que_A", "Again?", at)).toThrow(/UNIQUE/u);
    expect(() => decision.run("dec_3", "que_Z", "Unknown item?", at)).toThrow(/FOREIGN KEY/u);
    expect(() => decision.run("dec_4", null, "x".repeat(2001), at)).toThrow(/CHECK/u);
    expect(() => decision.run("bad_5", null, "Prefix?", at)).toThrow(/CHECK/u);
    // A closed decision names who closed it and when; an open one names neither.
    const close = d.prepare(
      "UPDATE decision_request SET state = 'decided', decided_option = 1, decided_by = ?, decided_at = ? WHERE id = ?",
    );
    expect(() => close.run(null, null, "dec_1")).toThrow(/CHECK/u);
    close.run("cli", at, "dec_1");
    decision.run("dec_6", "que_A", "A new question once the first is decided", at);
  });

  it("0023 adds ci_trigger_event and ci_trigger_ref_state on a version 22 database (T15.5, FR-QUE-05, LLD §18.6)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo22 = MIGRATIONS.filter((m) => m.version <= 22);
    expect(migrate(d, undefined, upTo22)).toEqual(upTo22.map((m) => m.version));

    // Migrate to 23
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 23),
      ),
    ).toEqual([23]);

    // Table constraints on ci_trigger_ref_state
    expect(() =>
      d
        .prepare(
          `INSERT INTO ci_trigger_ref_state (project_id, publish_ref, consecutive_fixes, stuck, updated_at)
           VALUES ('p','refs/heads/b',0,2,'2026-10-17T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/u);

    // Can insert and query state and events
    d.prepare(
      `INSERT INTO ci_trigger_ref_state (project_id, publish_ref, consecutive_fixes, stuck, updated_at)
       VALUES ('p','refs/heads/b',1,0,'2026-10-17T00:00:00Z')`,
    ).run();

    d.prepare(
      `INSERT INTO ci_trigger_event (id, project_id, publish_ref, external_id, conclusion, untrusted_summary, observed_at, work_item_id)
       VALUES ('cie_1','p','refs/heads/b','101','failure',NULL,'2026-10-17T00:00:00Z',NULL)`,
    ).run();

    // Unique constraint on (project_id, external_id)
    expect(() =>
      d
        .prepare(
          `INSERT INTO ci_trigger_event (id, project_id, publish_ref, external_id, conclusion, untrusted_summary, observed_at, work_item_id)
           VALUES ('cie_2','p','refs/heads/b','101','failure',NULL,'2026-10-17T00:00:00Z',NULL)`,
        )
        .run(),
    ).toThrow(/UNIQUE/u);
  });

  it("0025 adds eval_result on a version 24 database; pass needs exit code 0 (T8.14, FR-OPS-06, LLD §20.13)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const d = db;
    const upTo24 = MIGRATIONS.filter((m) => m.version <= 24);
    expect(migrate(d, undefined, upTo24)).toEqual(upTo24.map((m) => m.version));
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 25),
      ),
    ).toEqual([25]);
    const insert = d.prepare(
      `INSERT INTO eval_result (id, suite, task_id, provider, run_id, run_state, pass, test_exit_code, grade_error,
         wall_clock_ms, created_at) VALUES (?, 's', 't', 'fake', NULL, NULL, ?, ?, NULL, 5, '2026-10-19T00:00:00Z')`,
    );
    insert.run("evl_1", 1, 0);
    insert.run("evl_2", 0, 1);
    expect(() => insert.run("evl_3", 1, 1)).toThrow(/CHECK/u);
    expect(() => insert.run("evl_4", 2, 0)).toThrow(/CHECK/u);
    expect(d.prepare("SELECT usage_json FROM eval_result WHERE id = 'evl_1'").get()).toEqual({ usage_json: "[]" });
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

  it("0006 widens usage_observation.source with inner_agent, keeps rows, index and append-only guards (T11.5)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 5))).toEqual([1, 2, 3, 4, 5]);
    const d = db;
    const ins = (id: string, source: string, at = "2026-10-13T00:00:00.000Z") =>
      d
        .prepare(
          `INSERT INTO usage_observation (id, run_id, provider, harness, source, metrics_json, observed_at)
           VALUES (?, NULL, 'claude-code', 'claude-code', ?, '{"input_tokens":3}', ?)`,
        )
        .run(id, source, at);
    ins("use_a", "provider_reported");
    expect(() => ins("use_x", "inner_agent")).toThrow(/CHECK/u);
    const before = d.prepare("SELECT * FROM usage_observation ORDER BY rowid").all();
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 6))).toEqual([6]);
    expect(d.prepare("SELECT * FROM usage_observation ORDER BY rowid").all()).toEqual(before);
    ins("use_b", "inner_agent");
    ins("use_c", "controller_estimated");
    expect(() => ins("use_d", "made_up")).toThrow(/CHECK/u);
    expect(() => d.prepare("UPDATE usage_observation SET model = 'x'").run()).toThrow(/append-only/u);
    expect(() => d.prepare("DELETE FROM usage_observation").run()).toThrow(/append-only/u);
    const idx = d
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_observation'")
      .all();
    expect(idx).toContainEqual({ name: "usage_provider_time" });
    expect(tables(d)).not.toContain("usage_observation_new");
  });

  it("0007 adds message_source and inner_call_id to git_commit, keeps rows and guards (T11.4, LLD §12.7)", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
    const d = db;
    const { session, run } = seed(d);
    let n = 0;
    const insert = (extra: Record<string, unknown> = {}) => {
      const row = {
        id: `gcm_${String(n++).padStart(26, "0")}`,
        commit_sha: String(n).padStart(40, "a"),
        tree_sha: "b".repeat(40),
        repo_root: "/repo",
        publish_ref: "refs/heads/switchboard/pub/x",
        project_id: "web",
        context_id: "main",
        meta_session_id: session.id,
        run_id: run.id,
        provider: "fake",
        harness: "fake",
        origin: "commit_tool",
        sanitizer_json: "{}",
        created_at: "2026-10-13T00:00:00.000Z",
        ...extra,
      };
      const cols = Object.keys(row);
      d.prepare(`INSERT INTO git_commit (${cols.join(",")}) VALUES (${cols.map((c) => `@${c}`).join(",")})`).run(row);
      return row.id;
    };
    const old = insert();
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 7))).toEqual([7]);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 7))).toEqual([]);
    expect(currentSchemaVersion(db)).toBe(7);
    // the existing row reads as an agent message with no inner call
    expect(d.prepare("SELECT message_source, inner_call_id FROM git_commit WHERE id = ?").get(old)).toEqual({
      message_source: "agent",
      inner_call_id: null,
    });
    expect(() => insert({ message_source: "model" })).toThrow(/CHECK/u);
    expect(() => insert({ message_source: "agent", inner_call_id: "inc_x" })).toThrow(/CHECK/u);
    expect(() => insert({ message_source: "inner", inner_call_id: "inc_missing" })).toThrow(/FOREIGN KEY/u);
    insert({ message_source: "inner" }); // an accepted draft whose call row was not recorded
    expect(() => d.prepare("UPDATE git_commit SET message_source = 'inner'").run()).toThrow(/append-only/u);
    expect(() => d.prepare("DELETE FROM git_commit").run()).toThrow(/append-only/u);
  });

  it("inner_task_state (T11.6, LLD §13.3) upgrades from version 7, is mutable and enforces its checks", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(tables(db)).not.toContain("inner_task_state");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 8))).toEqual([8]);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 8))).toEqual([]);
    expect(currentSchemaVersion(db)).toBeGreaterThanOrEqual(8);
    const d = db;
    expect(tables(d)).toContain("inner_task_state");
    d.prepare("INSERT INTO inner_task_state (task) VALUES ('run_title')").run();
    expect(d.prepare("SELECT suspended, version, resumed_at FROM inner_task_state").get()).toEqual({
      suspended: 0,
      version: 0,
      resumed_at: null,
    });
    // mutable, unlike inner_call
    d.prepare("UPDATE inner_task_state SET suspended = 1, suspended_basis_json = '{\"total\":20}'").run();
    expect(() => d.prepare("INSERT INTO inner_task_state (task) VALUES ('made_up')").run()).toThrow(/CHECK/u);
    expect(() => d.prepare("INSERT INTO inner_task_state (task) VALUES ('run_title')").run()).toThrow(
      /UNIQUE|PRIMARY/u,
    );
    expect(() => d.prepare("UPDATE inner_task_state SET suspended = 2").run()).toThrow(/CHECK/u);
    expect(() => d.prepare("UPDATE inner_task_state SET suspended_basis_json = 'not json'").run()).toThrow();
  });

  it("inner_call (T11.1, LLD §13.3) upgrades from version 4, is append-only and enforces its checks and keys", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 4))).toEqual([1, 2, 3, 4]);
    expect(tables(db)).not.toContain("inner_call");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 5))).toEqual([5]);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 6))).toEqual([6]);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 6))).toEqual([]);
    expect(currentSchemaVersion(db)).toBe(6);
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
      version: LATEST_VERSION + 1,
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
      version: LATEST_VERSION + 1,
      name: "bad",
      sql: "CREATE TABLE ok (id INTEGER) STRICT; SELECT * FROM nope;",
    };
    expect(() => migrate(db as Database.Database, undefined, [...MIGRATIONS, bad])).toThrow();
    expect(tables(db)).not.toContain("ok");
    expect(currentSchemaVersion(db)).toBe(LATEST_VERSION);
  });
});

describe("ledger pragmas", () => {
  it("enables WAL, foreign keys, full synchronous and recursive triggers", () => {
    db = openLedger(dir);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    // Q-96: REPLACE conflict resolution fires the BEFORE DELETE guards only when this is on.
    expect(db.pragma("recursive_triggers", { simple: true })).toBe(1);
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

  it("run_event rejects INSERT OR REPLACE and REPLACE INTO on an existing id (Q-96, recursive_triggers)", () => {
    db = openLedger(dir);
    const d = db;
    const { ledger, run } = seed(d);
    const evt = ledger.appendRunEvent({ runId: run.id, type: "state_transition", payload: { to: "QUEUED" } });
    const before = d.prepare("SELECT * FROM run_event WHERE id = ?").get(evt.id);
    // SQLite resolves a REPLACE on a colliding primary key by deleting the old row first. With recursive_triggers on,
    // that delete fires the BEFORE DELETE guard, so the whole statement aborts and the row is untouched.
    for (const spelling of ["INSERT OR REPLACE INTO", "REPLACE INTO"]) {
      expect(() =>
        d
          .prepare(
            `${spelling} run_event (id, run_id, seq, ts, type, payload_json) VALUES (?, ?, 1, 't', 'rewritten', '{}')`,
          )
          .run(evt.id, run.id),
      ).toThrow(/append-only/);
    }
    expect(d.prepare("SELECT * FROM run_event WHERE id = ?").get(evt.id)).toEqual(before);
    expect(ledger.listRunEvents(run.id)).toHaveLength(1);
    // The guard is on the guarded tables only: a REPLACE on a mutable table still works under the pragma.
    const upsert = d.prepare(
      `INSERT OR REPLACE INTO provider_health (provider, auth_state, version_state, breaker_state, updated_at)
       VALUES ('claude-code', 'OK', 'UNVERIFIED', ?, 't')`,
    );
    upsert.run("CLOSED");
    upsert.run("OPEN");
    expect(d.prepare("SELECT breaker_state FROM provider_health WHERE provider = 'claude-code'").all()).toEqual([
      { breaker_state: "OPEN" },
    ]);
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

describe("project_affinity (T7.4; migration 0014, LLD §3.2, §17.6)", () => {
  it("applies on a ledger at the previous version and keeps its rows", () => {
    db = new Database(path.join(dir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    const before = MIGRATIONS.filter((m) => m.version < 14);
    migrate(db, undefined, before);
    expect(tables(db)).not.toContain("project_affinity");
    const { run } = seed(db);
    expect(migrate(db)).toEqual(MIGRATIONS.filter((m) => m.version >= 14).map((m) => m.version));
    expect(tables(db)).toContain("project_affinity");
    expect(db.prepare("SELECT id FROM run").get()).toEqual({ id: run.id });
  });

  it("refuses a reason outside the closed list (FR-RTE-07)", () => {
    db = openLedger(dir);
    const insert = (reason: string | null) =>
      (db as Database.Database)
        .prepare(
          `INSERT INTO project_affinity (project_key, provider, since, last_switch_reason, updated_at)
           VALUES (?, 'fake', 'now', ?, 'now')`,
        )
        .run(`p-${reason}`, reason);
    for (const ok of [null, "user_request", "capacity_exhausted", "ineligible", "failed_after_retry"]) insert(ok);
    for (const bad of ["better_score", "lower_cost", "lower_load", "unrecorded", ""]) {
      expect(() => insert(bad)).toThrow(/CHECK constraint/u);
    }
  });

  it("writes, reads and version-checks a row; a reset is recorded and cleared by the next write", () => {
    db = openLedger(dir);
    const { ledger, run } = seed(db);
    expect(ledger.getProjectAffinity("proj")).toBeUndefined();
    const first = { projectKey: "proj", provider: "fake", model: null, lastRunId: run.id, reason: null };
    expect(ledger.writeProjectAffinity({ ...first, expectedVersion: undefined })).toBe(true);
    expect(ledger.writeProjectAffinity({ ...first, expectedVersion: undefined })).toBe(false); // a row exists now
    const row = ledger.getProjectAffinity("proj");
    expect(row).toMatchObject({
      provider: "fake",
      model: null,
      last_run_id: run.id,
      last_switch_reason: null,
      version: 1,
    });
    // Held: same provider, reason null keeps `since` and the last reason; a stale version writes nothing.
    expect(ledger.writeProjectAffinity({ ...first, model: "m1", expectedVersion: 0 })).toBe(false);
    expect(ledger.writeProjectAffinity({ ...first, model: "m1", expectedVersion: 1 })).toBe(true);
    expect(ledger.getProjectAffinity("proj")).toMatchObject({ model: "m1", since: row?.since, version: 2 });
    // A switch: provider and reason change.
    const switched = { ...first, provider: "fake-b", reason: "capacity_exhausted" as const, expectedVersion: 2 };
    expect(ledger.writeProjectAffinity(switched)).toBe(true);
    expect(ledger.getProjectAffinity("proj")).toMatchObject({
      provider: "fake-b",
      last_switch_reason: "capacity_exhausted",
      version: 3,
    });
    // Reset: only on an existing row; cleared by the next write.
    expect(ledger.requestAffinityReset("nope", "op")).toBe(false);
    expect(ledger.getProjectAffinity("nope")).toBeUndefined();
    expect(ledger.requestAffinityReset("proj", "op")).toBe(true);
    expect(ledger.getProjectAffinity("proj")).toMatchObject({ reset_by: "op", version: 4 });
    expect(ledger.getProjectAffinity("proj")?.reset_requested_at).not.toBeNull();
    expect(ledger.writeProjectAffinity({ ...switched, reason: "user_request", expectedVersion: 4 })).toBe(true);
    expect(ledger.getProjectAffinity("proj")).toMatchObject({
      reset_requested_at: null,
      reset_by: null,
      last_switch_reason: "user_request",
    });
    expect(ledger.listProjectAffinities().map((r) => r.project_key)).toEqual(["proj"]);
  });

  it("does not block retention GC of the run it names (no foreign key)", () => {
    db = openLedger(dir);
    const { ledger, run } = seed(db);
    ledger.writeProjectAffinity({
      projectKey: "proj",
      provider: "fake",
      model: null,
      lastRunId: run.id,
      reason: null,
      expectedVersion: undefined,
    });
    db.prepare("DELETE FROM run WHERE id = ?").run(run.id);
    expect(ledger.getProjectAffinity("proj")?.last_run_id).toBe(run.id);
  });
});
