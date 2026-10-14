/**
 * Dynamic-project store and rules (T9.9; FR-PRJ-10, FRD BR-32, ADR-0030). Real SQLite ledgers and real temporary Git
 * repositories; no provider CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { currentSchemaVersion, LEDGER_FILE_NAME, MIGRATIONS, migrate, openLedger } from "../ledger/index.js";
import {
  approvalReasons,
  checkClientLimits,
  checkFilesystem,
  checkStrings,
  checkStructure,
  DynamicProjectStore,
  ProjectRuleError,
  ProjectStoreError,
} from "./index.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });

let tmp: string;
let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-dynprj-")));
  root = path.join(tmp, "root");
  repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "x\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(tmp, "data");
});
afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

const def = (over: Partial<ProjectConfig> = {}, ctxOver: Record<string, unknown> = {}): ProjectConfig => ({
  id: "dyn-app",
  name: "Dynamic app",
  contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main", ...ctxOver }],
  ...over,
});

const ruleError = async (fn: () => unknown): Promise<ProjectRuleError> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProjectRuleError) return err;
    throw err;
  }
  throw new Error("expected a ProjectRuleError");
};

describe("migration 0004 (ADR-0030)", () => {
  it("adds the three tables to a version 3 database and keeps existing rows", () => {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(path.join(dataDir, LEDGER_FILE_NAME));
    db.pragma("foreign_keys = ON");
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 3))).toEqual([1, 2, 3]);
    const now = "2026-10-13T00:00:00.000Z";
    db.prepare(
      "INSERT INTO meta_session (id, objective, status, created_at, updated_at) VALUES (?, 'before', 'ACTIVE', ?, ?)",
    ).run(`sess_${"0".repeat(26)}`, now, now);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 4))).toEqual([4]);
    expect(migrate(db, undefined, MIGRATIONS.slice(0, 4))).toEqual([]);
    expect(currentSchemaVersion(db)).toBe(4);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toEqual(expect.arrayContaining(["project_revision", "project_revision_decision", "project_event"]));
    expect(db.prepare("SELECT COUNT(*) AS n FROM meta_session").get()).toEqual({ n: 1 });
  });

  it("all three tables are append-only and enforce their checks", () => {
    db = openLedger(dataDir);
    const store = new DynamicProjectStore(db, { ids: createIdGenerator() });
    store.appendRevision(
      {
        projectId: "dyn-app",
        clientId: "c1",
        definition: def({ environment: { kind: "container", image_digest: `sha256:${"a".repeat(64)}` } }),
        status: "PENDING_APPROVAL",
        approvalReasons: ["container_environment"],
        action: "create_project",
      },
      () => undefined,
    );
    store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" });
    const d = db;
    for (const t of ["project_revision", "project_revision_decision", "project_event"]) {
      expect(() => d.prepare(`UPDATE ${t} SET project_id = 'x'`).run(), t).toThrow(/append-only/u);
      expect(() => d.prepare(`DELETE FROM ${t}`).run(), t).toThrow(/append-only/u);
    }
    expect(() =>
      d
        .prepare(
          `INSERT INTO project_revision (id, project_id, revision, client_id, definition_json, status, created_at)
           VALUES ('prv_x', 'p', 1, 'c', '{}', 'APPROVED', 'now')`,
        )
        .run(),
    ).toThrow(/CHECK/u);
    expect(() =>
      d
        .prepare(
          `INSERT INTO project_revision (id, project_id, revision, client_id, definition_json, status, created_at)
           VALUES ('prv_y', 'p', 1, 'c', 'not json', 'ACTIVE', 'now')`,
        )
        .run(),
    ).toThrow(/CHECK/u);
    // a decision must name an existing revision, and a revision is decided at most once
    expect(() =>
      d
        .prepare(
          `INSERT INTO project_revision_decision (id, project_id, revision, decision, decided_by, decided_at)
           VALUES ('prd_x', 'nope', 1, 'APPROVED', 'op', 'now')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/u);
    expect(() =>
      d
        .prepare(
          `INSERT INTO project_revision_decision (id, project_id, revision, decision, decided_by, decided_at)
           VALUES ('prd_y', 'dyn-app', 1, 'REJECTED', 'op', 'now')`,
        )
        .run(),
    ).toThrow(/UNIQUE/u);
    // a refused event needs a code
    expect(() =>
      d
        .prepare(
          `INSERT INTO project_event (id, ts, actor, action, outcome) VALUES ('pev_x', 'now', 'mcp_client', 'create_project', 'REFUSED')`,
        )
        .run(),
    ).toThrow(/CHECK/u);
  });
});

describe("DynamicProjectStore states", () => {
  const append = (
    store: DynamicProjectStore,
    status: "ACTIVE" | "PENDING_APPROVAL" | "DELETED",
    over: Partial<ProjectConfig> = {},
    clientId = "c1",
  ) =>
    store.appendRevision(
      {
        projectId: "dyn-app",
        clientId,
        definition: def(over),
        status,
        approvalReasons: status === "PENDING_APPROVAL" ? ["push_policy"] : [],
        action: status === "DELETED" ? "delete_project" : "update_project",
      },
      () => undefined,
    );

  it("derives in-force, pending, approved, rejected and deleted, and survives a reopen", () => {
    db = openLedger(dataDir);
    const store = new DynamicProjectStore(db, { ids: createIdGenerator() });
    append(store, "ACTIVE", { name: "one" });
    expect(store.state("dyn-app")).toMatchObject({ clientId: "c1", deleted: false, inForce: { revision: 1 } });
    append(store, "PENDING_APPROVAL", { name: "two" });
    let st = store.state("dyn-app");
    expect(st?.inForce?.revision).toBe(1); // the previous revision stays in force
    expect(st?.pending?.revision).toBe(2);
    expect(st?.latest.state).toBe("pending_approval");
    store.decide({ projectId: "dyn-app", revision: 2, decision: "REJECTED", decidedBy: "op" });
    st = store.state("dyn-app");
    expect(st?.latest.state).toBe("rejected");
    expect(st?.inForce?.revision).toBe(1);
    append(store, "PENDING_APPROVAL", { name: "three" });
    store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" });
    expect(store.state("dyn-app")?.inForce).toMatchObject({ revision: 3, state: "approved" });

    db.close();
    db = openLedger(dataDir); // restart: the same state comes back from the ledger
    const again = new DynamicProjectStore(db, { ids: createIdGenerator() });
    expect(again.state("dyn-app")?.inForce?.definition.name).toBe("three");
    append(again, "DELETED");
    expect(again.state("dyn-app")).toMatchObject({ deleted: true });
    expect(again.state("dyn-app")?.inForce).toBeUndefined();
    expect(again.listEvents("dyn-app").map((e) => [e.action, e.outcome])).toEqual([
      ["update_project", "ACCEPTED"],
      ["update_project", "ACCEPTED"],
      ["reject", "ACCEPTED"],
      ["update_project", "ACCEPTED"],
      ["approve", "ACCEPTED"],
      ["delete_project", "ACCEPTED"],
    ]);
  });

  it("decides only the latest undecided pending revision, once", () => {
    db = openLedger(dataDir);
    const store = new DynamicProjectStore(db, { ids: createIdGenerator() });
    append(store, "ACTIVE");
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err instanceof ProjectStoreError ? err.reason : String(err);
      }
      return "none";
    };
    expect(code(() => store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" }))).toBe(
      "NOT_PENDING",
    );
    append(store, "PENDING_APPROVAL");
    append(store, "PENDING_APPROVAL");
    expect(code(() => store.decide({ projectId: "dyn-app", revision: 2, decision: "APPROVED", decidedBy: "op" }))).toBe(
      "SUPERSEDED",
    );
    expect(code(() => store.decide({ projectId: "dyn-app", revision: 9, decision: "APPROVED", decidedBy: "op" }))).toBe(
      "UNKNOWN_REVISION",
    );
    expect(code(() => store.decide({ projectId: "nope", decision: "APPROVED", decidedBy: "op" }))).toBe(
      "UNKNOWN_PROJECT",
    );
    store.decide({ projectId: "dyn-app", revision: 3, decision: "APPROVED", decidedBy: "op" });
    expect(code(() => store.decide({ projectId: "dyn-app", revision: 3, decision: "REJECTED", decidedBy: "op" }))).toBe(
      "ALREADY_DECIDED",
    );
  });

  it("never lets a second client write a revision of another client's project", () => {
    db = openLedger(dataDir);
    const store = new DynamicProjectStore(db, { ids: createIdGenerator() });
    append(store, "ACTIVE");
    expect(() => append(store, "ACTIVE", {}, "c2")).toThrow(ProjectStoreError);
    expect(store.state("dyn-app")?.revisions).toHaveLength(1);
  });
});

describe("definition rules", () => {
  it("refuses control, separator and bidirectional characters, including NUL", async () => {
    for (const bad of ["a\u0000b", "a\nb", "a‮b", "a b", "a\u0085b", "a\ud800b", "a\udc00", "‏"]) {
      const err = await ruleError(() => checkStrings(def({ name: bad })));
      expect(err).toMatchObject({ code: "INVALID_REQUEST", reason: "CONTROL_CHARACTER", field: "$.project.name" });
    }
    expect(() => checkStrings(def({ name: "Café 😀 Ünïcode" }))).not.toThrow();
  });

  it("applies the configuration's structural rules", async () => {
    const err = await ruleError(() =>
      checkStructure(def({}, { push: { policy: "branch", remote: "origin", branch_prefix: "sb/" } })),
    );
    expect(err).toMatchObject({ code: "INVALID_REQUEST", field: "$.project.contexts[0].identity" });
  });

  it("refuses limits wider than the client's", async () => {
    const client = { maxTrustProfile: "edit-untrusted" as const, maxPushPolicy: "none" as const };
    expect(
      await ruleError(() => checkClientLimits(def({ max_trust_profile: "trusted-development" }), client, new Set())),
    ).toMatchObject({ code: "PERMISSION_BLOCKED", reason: "CEILING_ABOVE_CLIENT" });
    expect(
      await ruleError(() =>
        checkClientLimits(def({ allowed_providers: ["claude-code", "codex"] }), client, new Set(["codex"])),
      ),
    ).toMatchObject({
      code: "PERMISSION_BLOCKED",
      reason: "PROVIDER_OUTSIDE_CLIENT",
      field: "$.project.allowed_providers[1]",
    });
    expect(
      await ruleError(() =>
        checkClientLimits(
          def({}, { push: { policy: "branch", remote: "origin", branch_prefix: "sb/" } }),
          client,
          new Set(),
        ),
      ),
    ).toMatchObject({ code: "PERMISSION_BLOCKED", reason: "PUSH_ABOVE_CLIENT" });
    expect(() => checkClientLimits(def({ max_trust_profile: "inspect-untrusted" }), client, new Set())).not.toThrow();
  });

  it("names every reason a revision needs approval, and widening against the revision in force", () => {
    const branch = {
      push: { policy: "branch", remote: "origin", branch_prefix: "sb/" },
      identity: { name: "A", email: "a@b.c" },
    };
    expect(approvalReasons(def(), undefined, "trusted-development")).toEqual([]);
    expect(
      approvalReasons(
        def(
          { environment: { kind: "container", image_digest: `sha256:${"a".repeat(64)}` } },
          { ...branch, sign: true },
        ),
        undefined,
        "trusted-development",
      ),
    ).toEqual(["container_environment", "push_policy", "commit_identity", "commit_signing"]);
    const before = def({ max_trust_profile: "inspect-untrusted", allowed_providers: ["codex"] });
    expect(
      approvalReasons(
        def({ max_trust_profile: "edit-untrusted", allowed_providers: ["codex"] }),
        before,
        "trusted-development",
      ),
    ).toEqual(["widened_trust_ceiling"]);
    // absent ceiling = the client's own, which is wider than inspect-untrusted
    expect(approvalReasons(def({ allowed_providers: ["codex"] }), before, "trusted-development")).toEqual([
      "widened_trust_ceiling",
    ]);
    expect(approvalReasons(def({ max_trust_profile: "inspect-untrusted" }), before, "trusted-development")).toEqual([
      "widened_providers",
    ]);
    expect(
      approvalReasons(
        def({ max_trust_profile: "inspect-untrusted", allowed_providers: ["claude-code"] }),
        before,
        "trusted-development",
      ),
    ).toEqual(["widened_providers"]);
    // narrowing needs nothing
    expect(
      approvalReasons(
        def({ max_trust_profile: "inspect-untrusted", allowed_providers: [] }),
        before,
        "trusted-development",
      ),
    ).toEqual([]);
  });

  it("checks the filesystem: outside roots (also through .. and symlinks), not Git, missing ref, data dir", async () => {
    const roots = [root];
    await expect(checkFilesystem(def(), roots, dataDir)).resolves.toBeUndefined();
    const outside = path.join(tmp, "outside");
    mkdirSync(outside);
    g(outside, "init", "-q", "-b", "main");
    expect(await ruleError(() => checkFilesystem(def({}, { path: outside }), roots, dataDir))).toMatchObject({
      code: "PERMISSION_BLOCKED",
      reason: "OUTSIDE_ALLOWED_ROOT",
      field: "$.project.contexts[0].path",
    });
    expect(
      await ruleError(() => checkFilesystem(def({}, { path: path.join(root, "..", "outside") }), roots, dataDir)),
    ).toMatchObject({ reason: "OUTSIDE_ALLOWED_ROOT" });
    const link = path.join(root, "link");
    symlinkSync(outside, link);
    const viaLink = await ruleError(() => checkFilesystem(def({}, { path: link }), roots, dataDir));
    expect(viaLink).toMatchObject({ reason: "OUTSIDE_ALLOWED_ROOT" });
    expect(viaLink.message).not.toContain(outside); // the resolved target is never echoed
    expect(await ruleError(() => checkFilesystem(def({}, { path: "relative/path" }), roots, dataDir))).toMatchObject({
      code: "INVALID_REQUEST",
      reason: "PATH_NOT_ABSOLUTE",
    });
    expect(
      await ruleError(() => checkFilesystem(def({}, { path: path.join(root, "missing") }), roots, dataDir)),
    ).toMatchObject({ code: "INVALID_REQUEST", reason: "PATH_NOT_FOUND" });
    const plain = path.join(root, "plain");
    mkdirSync(plain);
    expect(await ruleError(() => checkFilesystem(def({}, { path: plain }), [plain], dataDir))).toMatchObject({
      reason: "NOT_A_GIT_REPO",
    });
    expect(await ruleError(() => checkFilesystem(def({}, { base_ref: "nope" }), roots, dataDir))).toMatchObject({
      code: "INVALID_REQUEST",
      reason: "BASE_REF_NOT_FOUND",
    });
    // a repository inside the controller's data directory (worktrees live there) is refused
    const inData = path.join(root, "data", "repo");
    mkdirSync(inData, { recursive: true });
    g(inData, "init", "-q", "-b", "main");
    writeFileSync(path.join(inData, "f"), "x");
    g(inData, "add", "-A");
    g(inData, "commit", "-q", "-m", "x");
    expect(
      await ruleError(() => checkFilesystem(def({}, { path: inData }), roots, path.join(root, "data"))),
    ).toMatchObject({ code: "PERMISSION_BLOCKED", reason: "INSIDE_DATA_DIR" });
  });
});
