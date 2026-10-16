import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { containerName, probeContainerName, SWITCHBOARD_RUN_LABEL } from "../environment/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { fileRuntime, plantContainer } from "../reconcile/fixtures/file-runtime.js";
import { collectOrphans, findOrphans, type GcStep, type OrphanGcStep, runRetentionGc } from "./gc.js";
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

  it.each(["intent", "containers", "worktrees", "branches", "artifacts", "ledger"] as GcStep[])(
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
      expect(status(u.sess)).toBe("ARCHIVED"); // marked in the first transaction (R-42)

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

  it("skips a session whose run was admitted after the candidate list was read, and collects the rest (R-42)", async () => {
    const a = await unit(OLD);
    const b = await unit(OLD);
    const [first, second] = a.sess < b.sess ? [a, b] : [b, a]; // candidates are ordered by activity, then id
    let admitted = false;
    const res = await gc(30, (s, id) => {
      if (s === "ledger" && id === first.sess && !admitted) {
        admitted = true;
        ledgerAt(NOW).createRun({
          metaSessionId: second.sess,
          trustProfile: "edit-untrusted",
          policySnapshot: {},
          request: {},
          requestHash: "h2",
          clientId: "c",
          state: "QUEUED",
        });
      }
    });
    expect(res.errors).toEqual([]);
    expect(res.collected.map((u) => u.sessionId)).toEqual([first.sess]);
    expect(status(second.sess)).toBe("ACTIVE");
    expect(existsSync(second.wt)).toBe(true);
    expect(branches()).toContain(second.branch);
    expect(artifacts(second.sess).every((r) => r.deleted_at === null)).toBe(true);
  });

  it("marks the session ARCHIVED before any worktree, branch or file is removed (R-42)", async () => {
    const u = await unit(OLD);
    let seen: { status: string; worktree: boolean } | undefined;
    await gc(30, (s) => {
      if (s === "intent") seen = { status: status(u.sess), worktree: existsSync(u.wt) };
    });
    expect(seen).toEqual({ status: "ARCHIVED", worktree: true });
  });
});

describe("retention GC of container environments (T10.3, FR-PRJ-09)", () => {
  const runtimeDir = () => path.join(root, "runtime");
  const plant = (runId: string) => {
    plantContainer(runtimeDir(), containerName(runId), { [SWITCHBOARD_RUN_LABEL]: runId, "switchboard.role": "run" });
    plantContainer(runtimeDir(), probeContainerName(runId), {
      [SWITCHBOARD_RUN_LABEL]: runId,
      "switchboard.role": "probe",
    });
  };
  const left = () => readdirSync(runtimeDir()).sort();

  it("removes the containers of a collected session's runs together with its worktrees, before them", async () => {
    const u = await unit(OLD);
    const keep = await unit(RECENT);
    plant(u.run);
    plant(keep.run);
    plantContainer(runtimeDir(), "unlabelled-by-switchboard", { other: "x" });
    const order: string[] = [];
    const runtime = fileRuntime(runtimeDir(), { onRemove: (n) => order.push(`remove:${n}:${existsSync(u.wt)}`) });
    const res = await runRetentionGc({ db, artifacts: store, dataDir, days: 30, now: NOW, containerRuntime: runtime });
    expect(res.errors).toEqual([]);
    expect(res.collected).toHaveLength(1);
    expect(res.collected[0]?.containersRemoved).toEqual([containerName(u.run), probeContainerName(u.run)].sort());
    expect(existsSync(u.wt)).toBe(false);
    // The worktree still existed when each container was removed: never a container mounting a deleted worktree.
    expect(order).toEqual([containerName(u.run), probeContainerName(u.run)].sort().map((n) => `remove:${n}:true`));
    // The recent session's containers, and anything not labelled by Switchboard, are untouched.
    expect(left()).toEqual(
      [
        `${containerName(keep.run)}.json`,
        `${probeContainerName(keep.run)}.json`,
        "unlabelled-by-switchboard.json",
      ].sort(),
    );
    const outcome = db.prepare("SELECT payload_json FROM run_event WHERE type = 'gc_outcome'").get() as {
      payload_json: string;
    };
    expect(JSON.parse(outcome.payload_json)).toMatchObject({ containersRemoved: res.collected[0]?.containersRemoved });
  });

  it("a runtime that cannot list keeps the worktrees and rolls forward on the next pass", async () => {
    const u = await unit(OLD);
    plant(u.run);
    const broken = fileRuntime(runtimeDir(), { listFails: true });
    const first = await runRetentionGc({ db, artifacts: store, dataDir, days: 30, now: NOW, containerRuntime: broken });
    expect(first.errors).toMatchObject([{ sessionId: u.sess, step: "containers" }]);
    expect(existsSync(u.wt)).toBe(true);
    expect(status(u.sess)).toBe("ARCHIVED");
    const second = await runRetentionGc({
      db,
      artifacts: store,
      dataDir,
      days: 30,
      now: NOW,
      containerRuntime: fileRuntime(runtimeDir()),
    });
    expect(second.errors).toEqual([]);
    expect(second.collected[0]?.containersRemoved).toHaveLength(2);
    expect(existsSync(u.wt)).toBe(false);
    expect(left()).toEqual([]);
  });

  it("without a container runtime (host-only configuration) the step removes nothing", async () => {
    const u = await unit(OLD);
    plant(u.run);
    const res = await gc();
    expect(res.collected[0]?.containersRemoved).toEqual([]);
    expect(left()).toHaveLength(2);
  });
});

describe("orphan sweep and publish refs (T9.7 follow-up)", () => {
  it("does not report the publish ref of a known session, but still reports one of an unknown session", async () => {
    const u = await unit(RECENT);
    const head = g(repo, "rev-parse", "HEAD").trim();
    g(repo, "update-ref", `refs/heads/switchboard/pub/${u.sess}`, head);
    g(repo, "update-ref", "refs/heads/switchboard/pub/sess_unknown1", head);
    g(repo, "update-ref", "refs/heads/switchboard/stray", head);
    const o = await findOrphans({ db, dataDir });
    expect(o.branches.map((b) => b.branch).sort()).toEqual(["switchboard/pub/sess_unknown1", "switchboard/stray"]);
  });

  it("honours a custom publish prefix", async () => {
    const u = await unit(RECENT);
    const head = g(repo, "rev-parse", "HEAD").trim();
    g(repo, "update-ref", `refs/heads/switchboard/out/${u.sess}`, head);
    const o = await findOrphans({ db, dataDir, publishPrefix: "switchboard/out/" });
    expect(o.branches).toEqual([]);
  });
});

describe("orphan collection after the retention period (T3.12, LLD §5, ADR-0054)", () => {
  const LATER = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
  const collect = (now: Date, days = 30, onStep?: (s: OrphanGcStep, target: string) => void) =>
    collectOrphans({ db, dataDir, days, now, ...(onStep ? { onStep } : {}) });
  const marks = () =>
    db.prepare("SELECT kind, target, first_seen_at, intent_at, removed_at FROM gc_orphan ORDER BY target").all() as {
      kind: string;
      target: string;
      first_seen_at: string;
      intent_at: string | null;
      removed_at: string | null;
    }[];

  /** A live unit plus an orphan worktree (registered with Git), an orphan session directory and orphan branches. */
  async function scene() {
    const live = await unit(RECENT);
    const base = path.join(realpathSync(dataDir), "worktrees");
    const ghostWt = path.join(base, live.sess, "run_ghost");
    g(repo, "worktree", "add", "-q", "-b", `switchboard/${live.sess}/run_ghost`, ghostWt);
    const ghostSess = path.join(base, "sess_ghost");
    mkdirSync(path.join(ghostSess, "run_x"), { recursive: true });
    writeFileSync(path.join(ghostSess, "run_x", "f.txt"), "x\n");
    const head = g(repo, "rev-parse", "HEAD").trim();
    g(repo, "update-ref", "refs/heads/switchboard/pub/sess_unknown1", head);
    g(repo, "branch", "operator/switchboard-lookalike");
    return { live, ghostWt, ghostSess, ghostBranch: `switchboard/${live.sess}/run_ghost` };
  }

  it("marks orphans on first sighting and removes nothing, even with days = 0", async () => {
    const s = await scene();
    const first = await collect(NOW, 0);
    expect(first.errors).toEqual([]);
    expect(first.marked).toBe(4);
    expect(first.removedWorktrees).toEqual([]);
    expect(first.removedBranches).toEqual([]);
    expect(existsSync(s.ghostWt)).toBe(true);
    expect(existsSync(s.ghostSess)).toBe(true);
    expect(branches()).toEqual(expect.arrayContaining([s.ghostBranch, "switchboard/pub/sess_unknown1"]));
    expect(marks().every((m) => m.first_seen_at === NOW.toISOString() && m.intent_at === null)).toBe(true);
  });

  it("keeps marked orphans inside the retention period and removes them after it; live and outside branches stay", async () => {
    const s = await scene();
    await collect(NOW);
    const waiting = await collect(RECENT_PLUS(10));
    expect(waiting.waiting).toBe(4);
    expect(waiting.removedWorktrees).toEqual([]);
    expect(existsSync(s.ghostWt)).toBe(true);

    const res = await collect(LATER);
    expect(res.errors).toEqual([]);
    expect(res.removedWorktrees.sort()).toEqual([s.ghostWt, s.ghostSess].sort());
    expect(res.removedBranches.map((b) => b.branch).sort()).toEqual(
      [s.ghostBranch, "switchboard/pub/sess_unknown1"].sort(),
    );
    expect(existsSync(s.ghostWt)).toBe(false);
    expect(existsSync(s.ghostSess)).toBe(false);
    expect(g(repo, "worktree", "list", "--porcelain")).not.toContain("run_ghost");
    // The live unit, the operator's branches (including a lookalike outside switchboard/) and checkout are untouched.
    expect(existsSync(s.live.wt)).toBe(true);
    expect(branches()).toEqual(
      expect.arrayContaining(["main", "operator/feature", "operator/switchboard-lookalike", s.live.branch]),
    );
    expect(g(repo, "branch", "--show-current").trim()).toBe("main");
    expect(marks().every((m) => m.intent_at !== null && m.removed_at === LATER.toISOString())).toBe(true);
    expect((await findOrphans({ db, dataDir })).worktrees).toEqual([]);
    // Idempotent: nothing left to do.
    const again = await collect(LATER);
    expect([again.marked, again.removedWorktrees.length, again.removedBranches.length, again.errors.length]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("forgets the mark of a target that gained a ledger row, and never removes it", async () => {
    const live = await unit(RECENT);
    const ghost = `switchboard/${live.sess}/run_later`;
    g(repo, "branch", ghost);
    await collect(NOW);
    expect(marks().map((m) => m.target)).toEqual([ghost]);
    db.prepare("UPDATE run SET branch = ? WHERE id = ?").run(ghost, live.run); // now named by a run row
    const res = await collect(LATER);
    expect(res.removedBranches).toEqual([]);
    expect(branches()).toContain(ghost);
    expect(marks()).toEqual([]);
  });

  it("re-checks the ledger in the intent transaction: a row written after the sweep wins", async () => {
    const live = await unit(RECENT);
    const ghost = `switchboard/${live.sess}/run_race`;
    g(repo, "branch", ghost);
    await collect(NOW);
    // A run row names the branch after the sweep and mark pass but before the intent transaction: the re-check is
    // prepared at exactly that point, so the row is written when its statement is prepared.
    const orig = db.prepare.bind(db);
    let injected = false;
    const spy = (sql: string) => {
      if (!injected && sql.startsWith("SELECT 1 AS x FROM run WHERE branch")) {
        injected = true;
        orig("UPDATE run SET branch = ? WHERE id = ?").run(ghost, live.run);
      }
      return orig(sql);
    };
    (db as unknown as { prepare: typeof spy }).prepare = spy;
    try {
      const res = await collect(LATER);
      expect(res.removedBranches).toEqual([]);
    } finally {
      (db as unknown as { prepare: typeof orig }).prepare = orig;
    }
    expect(branches()).toContain(ghost);
  });

  it("refuses to remove through a symlinked session directory and unlinks a symlinked orphan without following it", async () => {
    const live = await unit(RECENT);
    const base = path.join(realpathSync(dataDir), "worktrees");
    const outside = path.join(root, "outside");
    mkdirSync(path.join(outside, "victim"), { recursive: true });
    writeFileSync(path.join(outside, "victim", "keep.txt"), "canary\n");
    // An unknown session directory that is a symlink to outside: the link is the orphan.
    symlinkSync(outside, path.join(base, "sess_linked"));
    // A known session whose directory is replaced by a symlink: its entries are listed through the link.
    rmSync(path.join(base, live.sess), { recursive: true, force: true });
    g(repo, "worktree", "prune");
    symlinkSync(outside, path.join(base, live.sess));

    await collect(NOW);
    const res = await collect(LATER);
    expect(res.removedWorktrees).toEqual([path.join(base, "sess_linked")]);
    expect(res.errors.map((e) => [e.target, e.step])).toEqual([[path.join(base, live.sess, "victim"), "remove"]]);
    expect(res.errors[0]?.message).toMatch(/refused/);
    expect(existsSync(path.join(outside, "victim", "keep.txt"))).toBe(true);
    expect(existsSync(path.join(base, "sess_linked"))).toBe(false);
  });

  it("refuses worktree removal when <dataDir>/worktrees itself is a symlink", async () => {
    await unit(RECENT);
    const base = path.join(realpathSync(dataDir), "worktrees");
    const outside = path.join(root, "outside-wt");
    mkdirSync(path.join(outside, "sess_far"), { recursive: true });
    writeFileSync(path.join(outside, "sess_far", "keep.txt"), "canary\n");
    rmSync(base, { recursive: true, force: true });
    g(repo, "worktree", "prune");
    symlinkSync(outside, base);
    await collect(NOW);
    const res = await collect(LATER);
    expect(res.removedWorktrees).toEqual([]);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.every((e) => /refused/.test(e.message))).toBe(true);
    expect(existsSync(path.join(outside, "sess_far", "keep.txt"))).toBe(true);
  });

  it.each(["intent", "remove", "outcome"] as OrphanGcStep[])(
    "rolls forward after a crash following the %s step",
    async (crashAfter) => {
      const s = await scene();
      await collect(NOW);
      let thrown = false;
      const first = await collect(LATER, 30, (step) => {
        if (step === crashAfter && !thrown) {
          thrown = true;
          throw new Error("injected crash");
        }
      });
      // A crash before the ghost worktree is removed can also leave its branch checked out there; that branch fails
      // too and rolls forward with it.
      const injected = first.errors.filter((e) => e.message === "injected crash");
      expect(injected.map((e) => e.step)).toEqual([crashAfter]);
      const crashed = marks().find((m) => m.target === injected[0]?.target);
      expect(crashed?.intent_at).not.toBeNull(); // the intent was recorded before anything was removed
      // The outcome hook runs after the final write, like the session GC "ledger" step.
      if (crashAfter === "outcome") expect(crashed?.removed_at).not.toBeNull();
      else expect(crashed?.removed_at).toBeNull();

      const second = await collect(new Date(LATER.getTime() + 60_000));
      expect(second.errors).toEqual([]);
      expect(existsSync(s.ghostWt)).toBe(false);
      expect(existsSync(s.ghostSess)).toBe(false);
      expect(branches()).not.toContain(s.ghostBranch);
      expect(branches()).not.toContain("switchboard/pub/sess_unknown1");
      expect(branches()).toEqual(expect.arrayContaining(["main", "operator/feature", s.live.branch]));
      expect(marks().every((m) => m.intent_at !== null && m.removed_at !== null)).toBe(true);
    },
  );

  it("records the intent before the orphan is removed", async () => {
    const s = await scene();
    await collect(NOW);
    const seen: { target: string; exists: boolean; intent: string | null }[] = [];
    await collect(LATER, 30, (step, target) => {
      if (step !== "intent" || target !== s.ghostSess) return;
      seen.push({
        target,
        exists: existsSync(target),
        intent: marks().find((m) => m.target === target)?.intent_at ?? null,
      });
    });
    expect(seen).toEqual([{ target: s.ghostSess, exists: true, intent: LATER.toISOString() }]);
  });
});

function RECENT_PLUS(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
}
