/**
 * Wiring tests for retention GC (T3.12; FR-WS-07, NFR-DATA-01, LLD §5): `doctor` reporting and `switchboard gc`.
 * In process, real Git in a temp repository, no provider CLI. The GC algorithm itself is tested in
 * src/workspace/gc.test.ts (including crash-and-roll-forward at every step); `serve` startup is in serve.test.ts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import type { CliIo } from "./io.js";
import { main } from "./main.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });

const NOW = new Date("2026-10-12T00:00:00.000Z");
const OLD = new Date("2026-08-01T00:00:00.000Z");
const RECENT = new Date("2026-10-11T00:00:00.000Z");

let tmp: string;
let repo: string;
let dataDir: string;
let configPath: string;

function writeConfig(retention?: Record<string, unknown>): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      ...(retention ? { retention } : {}),
    }),
  );
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-gc-cli-")));
  repo = path.join(tmp, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeConfig();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: { PATH: process.env.PATH ?? "" },
    user: "tester",
    now: () => NOW,
    adapters: new AdapterRegistry().register(new FakeAdapter()),
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

/** A meta-session with one run, a real worktree and a `switchboard/` branch, last active at `at`. */
async function unit(at: Date, state: "SUCCEEDED" | "AWAITING_APPROVAL" = "SUCCEEDED") {
  const db = openLedger(dataDir);
  try {
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids, now: () => at });
    const sess = ledger.createMetaSession({ objective: "o", repoRoot: repo });
    const run = ledger.createRun({
      metaSessionId: sess.id,
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c1",
      state: "SUCCEEDED",
    });
    const m = new WorkspaceManager({
      db,
      artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
      dataDir,
      allowedRoots: [tmp],
      ids,
      now: () => at,
    });
    const ws = await m.prepare({
      metaSessionId: sess.id,
      runId: run.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
    });
    if (ws.mode !== "worktree") throw new Error("expected worktree");
    writeFileSync(path.join(ws.worktreePath, "new.txt"), `change ${run.id}\n`);
    await m.finalize(run.id);
    m.releaseLease(run.id);
    db.prepare("UPDATE run SET updated_at = ?, created_at = ?, state = ? WHERE id = ?").run(
      at.toISOString(),
      at.toISOString(),
      state,
      run.id,
    );
    db.prepare("UPDATE meta_session SET updated_at = ?, lease_run_id = NULL WHERE id = ?").run(
      at.toISOString(),
      sess.id,
    );
    return { sess: sess.id, run: run.id, wt: ws.worktreePath, branch: ws.branch };
  } finally {
    db.close();
  }
}

function query<T>(sql: string, ...args: unknown[]): T[] {
  const db: Database.Database = openLedger(dataDir);
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}
const sessionStatus = (id: string) =>
  query<{ status: string }>("SELECT status FROM meta_session WHERE id = ?", id)[0]?.status;
const gcEvents = () => query<{ type: string }>("SELECT type FROM run_event WHERE type LIKE 'gc_%'");
const branches = () => g(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);

describe("doctor reports retention and the orphan sweep (read-only)", () => {
  it("lists what the configured retention would collect and an orphan worktree and branch, and deletes nothing", async () => {
    writeConfig({ days: 30 });
    const expired = await unit(OLD);
    const recent = await unit(RECENT);
    const orphanDir = path.join(dataDir, "worktrees", expired.sess, "run_ghost");
    mkdirSync(orphanDir, { recursive: true });
    g(repo, "branch", `switchboard/${expired.sess}/run_ghost`);

    const r = await cli(["doctor"]);
    expect(r.code).toBe(0); // orphans are a warning, not a failure
    expect(r.out).toContain(`Retention GC: retention 30 days; 1 meta-session(s) would be collected: ${expired.sess}`);
    expect(r.out).not.toContain(recent.sess);
    expect(r.out).toContain("[warn] Orphan sweep: 2 orphan(s)");
    expect(r.out).toContain(orphanDir);
    expect(r.out).toContain(`branch switchboard/${expired.sess}/run_ghost`);

    // Read-only: everything is still there and the ledger has no GC event.
    expect(existsSync(orphanDir)).toBe(true);
    expect(existsSync(expired.wt)).toBe(true);
    expect(branches()).toEqual(expect.arrayContaining([expired.branch, `switchboard/${expired.sess}/run_ghost`]));
    expect(sessionStatus(expired.sess)).toBe("ACTIVE");
    expect(gcEvents()).toEqual([]);

    const json = JSON.parse((await cli(["doctor", "--json"])).out) as { checks: { id: string; status: string }[] };
    expect(json.checks.find((c) => c.id === "orphans")?.status).toBe("warn");
    expect(json.checks.find((c) => c.id === "gc")?.status).toBe("ok");
  });

  it("says nothing is collected when retention.days is not set, and reports no orphans for a clean directory", async () => {
    const expired = await unit(OLD);
    const r = await cli(["doctor"]);
    expect(r.out).toContain("retention.days is not set, so nothing is collected");
    expect(r.out).toContain(expired.sess);
    expect(r.out).toContain("[ok]   Orphan sweep: no orphans found");
  });
});

describe("switchboard gc", () => {
  it("is a dry run by default: it lists the expired unit and changes nothing", async () => {
    writeConfig({ days: 30 });
    const expired = await unit(OLD);
    const recent = await unit(RECENT);
    const r = await cli(["gc"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("dry run");
    expect(r.out).toContain(expired.sess);
    expect(r.out).not.toContain(recent.sess);
    expect(existsSync(expired.wt)).toBe(true);
    expect(branches()).toContain(expired.branch);
    expect(sessionStatus(expired.sess)).toBe("ACTIVE");
    expect(gcEvents()).toEqual([]);
    const dry = await cli(["gc", "--dry-run", "--json"]);
    expect(JSON.parse(dry.out)).toMatchObject({ mode: "dry-run", units: [{ session_id: expired.sess }] });
    expect(gcEvents()).toEqual([]);
  });

  it("--apply removes the expired unit completely and leaves recent and non-terminal units alone", async () => {
    writeConfig({ days: 30 });
    const expired = await unit(OLD);
    const recent = await unit(RECENT);
    const pending = await unit(OLD, "AWAITING_APPROVAL");
    const r = await cli(["gc", "--apply", "--json"]);
    expect(r.code, r.err).toBe(0);
    const report = JSON.parse(r.out) as {
      collected: { session_id: string; branches_deleted: string[] }[];
      errors: unknown[];
    };
    expect(report.collected.map((c) => c.session_id)).toEqual([expired.sess]);
    expect(report.errors).toEqual([]);
    expect(existsSync(expired.wt)).toBe(false);
    expect(branches()).not.toContain(expired.branch);
    expect(sessionStatus(expired.sess)).toBe("ARCHIVED");
    expect(gcEvents().map((e) => e.type)).toEqual(expect.arrayContaining(["gc_intent", "gc_outcome"]));
    for (const keep of [recent, pending]) {
      expect(existsSync(keep.wt)).toBe(true);
      expect(branches()).toContain(keep.branch);
      expect(sessionStatus(keep.sess)).toBe("ACTIVE");
    }
    expect(branches()).toContain("main"); // the operator's branch is untouched
  });

  it("--apply is refused, and changes nothing, when retention.days is not configured", async () => {
    const expired = await unit(OLD);
    const r = await cli(["gc", "--apply"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("retention is not configured");
    expect(existsSync(expired.wt)).toBe(true);
    expect(sessionStatus(expired.sess)).toBe("ACTIVE");
    // A dry run still works and says so.
    const dry = await cli(["gc"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("retention.days is not set");
  });

  it("--apply is refused while another controller instance holds the data-directory lock", async () => {
    writeConfig({ days: 30 });
    const expired = await unit(OLD);
    const lock = acquireDataDirLock(dataDir); // this process is a live owner, like a running serve
    try {
      const r = await cli(["gc", "--apply", "--json"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out).error.code).toBe("LOCKED");
      expect(existsSync(expired.wt)).toBe(true);
      expect(sessionStatus(expired.sess)).toBe("ACTIVE");
      // A dry run only reads, so it works while the daemon runs.
      expect((await cli(["gc"])).code).toBe(0);
    } finally {
      lock.release();
    }
  });

  it("rolls forward: a second --apply after a partial first pass finishes the unit", async () => {
    writeConfig({ days: 30 });
    const expired = await unit(OLD);
    // State a crash after the worktree step would leave (core coverage per step: src/workspace/gc.test.ts).
    g(repo, "worktree", "remove", "--force", expired.wt);
    const r = await cli(["gc", "--apply"]);
    expect(r.code, r.err).toBe(0);
    expect(branches()).not.toContain(expired.branch);
    expect(sessionStatus(expired.sess)).toBe("ARCHIVED");
  });

  it("validates its flags", async () => {
    expect((await cli(["gc", "--apply", "--dry-run"])).code).toBe(2);
    expect((await cli(["gc", "extra"])).code).toBe(2);
    expect((await cli(["doctor", "--apply"])).code).toBe(2);
  });
});
