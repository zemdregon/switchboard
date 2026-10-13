import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { type GcStep, runRetentionGc } from "./gc.js";
import { WorkspaceManager } from "./index.js";

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

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let store: ArtifactStore;
let ids: ReturnType<typeof createIdGenerator>;

function ledgerAt(d: Date): Ledger {
  return createLedger(db, { ids, now: () => d });
}

/** A session with one run and a real worktree, branch and diff artifact. */
async function unit(at: Date, state: "SUCCEEDED" | "RUNNING" = "SUCCEEDED") {
  const ledger = ledgerAt(at);
  const sess = ledger.createMetaSession({ objective: "o", repoRoot: repo });
  const run = ledger.createRun({
    metaSessionId: sess.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
    state,
  });
  const m = new WorkspaceManager({ db, artifacts: store, dataDir, allowedRoots: [root], ids, now: () => at });
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
  db.prepare("UPDATE run SET updated_at = ?, created_at = ? WHERE id = ?").run(
    at.toISOString(),
    at.toISOString(),
    run.id,
  );
  db.prepare("UPDATE meta_session SET updated_at = ?, lease_run_id = NULL WHERE id = ?").run(at.toISOString(), sess.id);
  return { sess: sess.id, run: run.id, wt: ws.worktreePath, branch: ws.branch };
}

const gc = (days = 30, onStep?: (s: GcStep, id: string) => void) =>
  runRetentionGc({ db, artifacts: store, dataDir, days, now: NOW, ...(onStep ? { onStep } : {}) });
const branches = () => g(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);
const status = (id: string) =>
  (db.prepare("SELECT status FROM meta_session WHERE id = ?").get(id) as { status: string }).status;
const artifacts = (sess: string) =>
  db.prepare("SELECT sha256, deleted_at FROM artifact WHERE meta_session_id = ?").all(sess) as {
    sha256: string;
    deleted_at: string | null;
  }[];
const eventCount = () => (db.prepare("SELECT COUNT(*) AS n FROM run_event").get() as { n: number }).n;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-gc-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "original\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(repo, "branch", "operator/feature");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(path.join(root, "ledger"));
  ids = createIdGenerator();
  store = new ArtifactStore(path.join(dataDir, "artifacts"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("retention GC (T3.12)", () => {
  it("removes an expired unit completely: worktree, switchboard branch, artifact files, deleted_at, ARCHIVED", async () => {
    const u = await unit(OLD);
    const hashes = artifacts(u.sess).map((a) => a.sha256);
    expect(hashes.length).toBe(2);
    expect(existsSync(u.wt)).toBe(true);
    const eventsBefore = eventCount();

    const res = await gc();
    expect(res.errors).toEqual([]);
    expect(res.collected.map((c) => c.sessionId)).toEqual([u.sess]);
    expect(existsSync(u.wt)).toBe(false);
    expect(branches()).not.toContain(u.branch);
    for (const h of hashes) expect(existsSync(store.pathFor(h))).toBe(false);
    expect(artifacts(u.sess).every((a) => a.deleted_at !== null)).toBe(true);
    expect(status(u.sess)).toBe("ARCHIVED");
    expect(g(repo, "worktree", "list", "--porcelain")).not.toContain(u.sess);
    // run_event rows are kept (append-only); intent and outcome were appended.
    expect(eventCount()).toBe(eventsBefore + 2);
    const types = (db.prepare("SELECT type FROM run_event WHERE run_id = ?").all(u.run) as { type: string }[]).map(
      (e) => e.type,
    );
    expect(types.filter((t) => t.startsWith("gc_"))).toEqual(["gc_intent", "gc_outcome"]);
  });

  it("leaves recent, non-terminal and leased units alone, and the operator's branches and checkout", async () => {
    const recent = await unit(RECENT);
    const running = await unit(OLD, "RUNNING");
    const leased = await unit(OLD);
    db.prepare("UPDATE meta_session SET lease_run_id = ?, lease_expires_at = ? WHERE id = ?").run(
      leased.run,
      "2099-01-01T00:00:00.000Z",
      leased.sess,
    );
    const expired = await unit(OLD);
    const headBefore = g(repo, "rev-parse", "HEAD");
    writeFileSync(path.join(repo, "dirty.txt"), "operator work\n");

    const res = await gc();
    expect(res.collected.map((c) => c.sessionId)).toEqual([expired.sess]);
    for (const u of [recent, running, leased]) {
      expect(existsSync(u.wt)).toBe(true);
      expect(branches()).toContain(u.branch);
      expect(status(u.sess)).toBe("ACTIVE");
      expect(artifacts(u.sess).every((a) => a.deleted_at === null && existsSync(store.pathFor(a.sha256)))).toBe(true);
    }
    expect(branches()).toEqual(expect.arrayContaining(["main", "operator/feature"]));
    expect(g(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(g(repo, "branch", "--show-current").trim()).toBe("main");
    expect(existsSync(path.join(repo, "dirty.txt"))).toBe(true);
    expect(existsSync(path.join(repo, "a.txt"))).toBe(true);
  });

  it("never deletes a branch outside the session's switchboard/ namespace", async () => {
    const u = await unit(OLD);
    g(repo, "branch", "switchboard/sess_other/run_x");
    g(repo, "branch", `switchboard/${u.sess}x/run_y`);
    await gc();
    expect(branches()).toEqual(
      expect.arrayContaining([
        "main",
        "operator/feature",
        "switchboard/sess_other/run_x",
        `switchboard/${u.sess}x/run_y`,
      ]),
    );
    expect(branches()).not.toContain(u.branch);
  });

  it("does not follow a symlink inside a worktree out to an outside directory", async () => {
    const u = await unit(OLD);
    const canary = path.join(root, "canary");
    mkdirSync(canary);
    writeFileSync(path.join(canary, "keep.txt"), "canary\n");
    symlinkSync(canary, path.join(u.wt, "link-to-outside"));
    symlinkSync(path.join(canary, "keep.txt"), path.join(u.wt, "link-to-file"));

    const res = await gc();
    expect(res.errors).toEqual([]);
    expect(existsSync(u.wt)).toBe(false);
    expect(existsSync(path.join(canary, "keep.txt"))).toBe(true);
  });

  it("does not follow a symlinked worktree path itself", async () => {
    const u = await unit(OLD);
    const canary = path.join(root, "canary2");
    mkdirSync(canary);
    writeFileSync(path.join(canary, "keep.txt"), "canary\n");
    g(repo, "worktree", "remove", "--force", u.wt);
    symlinkSync(canary, u.wt);
    await gc();
    expect(existsSync(path.join(canary, "keep.txt"))).toBe(true);
    expect(existsSync(u.wt)).toBe(false);
  });

  it("keeps an artifact file still referenced by a live row of another session", async () => {
    const a = await unit(OLD);
    const b = await unit(RECENT);
    const shared = (await store.put("shared content")).sha256;
    const ledger = ledgerAt(OLD);
    for (const u of [a, b]) {
      ledger.insertArtifact({
        runId: u.run,
        metaSessionId: u.sess,
        kind: "log_summary",
        sha256: shared,
        sizeBytes: 14,
        mediaType: "text/plain",
      });
    }
    const res = await gc();
    expect(res.collected[0]?.artifactFilesKept).toBeGreaterThanOrEqual(1); // the shared file (changed_files JSON is also identical across units)
    expect(existsSync(store.pathFor(shared))).toBe(true);
    expect(artifacts(a.sess).every((r) => r.deleted_at !== null)).toBe(true);
    expect(artifacts(b.sess).every((r) => r.deleted_at === null)).toBe(true);
    // Once the other session also expires, the shared file goes.
    await runRetentionGc({ db, artifacts: store, dataDir, days: 30, now: new Date("2027-01-01T00:00:00Z") });
    expect(existsSync(store.pathFor(shared))).toBe(false);
  });

  it.each(["intent", "worktrees", "branches", "artifacts", "ledger"] as GcStep[])(
    "converges after a crash following the %s step",
    async (crashAfter) => {
      const u = await unit(OLD);
      const hashes = artifacts(u.sess).map((a) => a.sha256);
      let thrown = false;
      const first = await gc(30, (s) => {
        if (s === crashAfter && !thrown) {
          thrown = true;
          throw new Error("injected crash");
        }
      });
      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]?.message).toBe("injected crash");
      // The injected crash after the final transaction leaves a finished unit; earlier ones leave work to roll forward.
      expect(status(u.sess)).toBe(crashAfter === "ledger" ? "ARCHIVED" : "ACTIVE");

      const second = await gc();
      expect(second.errors).toEqual([]);
      expect(second.collected).toHaveLength(crashAfter === "ledger" ? 0 : 1);
      expect(existsSync(u.wt)).toBe(false);
      expect(branches()).not.toContain(u.branch);
      for (const h of hashes) expect(existsSync(store.pathFor(h))).toBe(false);
      expect(artifacts(u.sess).every((a) => a.deleted_at !== null)).toBe(true);
      expect(status(u.sess)).toBe("ARCHIVED");
      const outcomes = db.prepare("SELECT COUNT(*) AS n FROM run_event WHERE type = 'gc_outcome'").get() as {
        n: number;
      };
      expect(outcomes.n).toBe(1);
    },
  );

  it("is idempotent: a second run is a no-op and keeps every run_event", async () => {
    await unit(OLD);
    await gc();
    const events = eventCount();
    const second = await gc();
    expect(second.collected).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(eventCount()).toBe(events);
  });

  it("run_event stays append-only for GC (rows cannot be deleted)", async () => {
    const u = await unit(OLD);
    await gc();
    expect(() => db.prepare("DELETE FROM run_event WHERE run_id = ?").run(u.run)).toThrow(/append-only/);
  });
});
