/**
 * ADR-0079 item 3: the workspace manager attaches the submodules of a recursive context's run worktree, refreshes them
 * in a resumed worktree, rolls them back with the run, and every removal path (retention gc, partial-worktree repair)
 * detaches them through the attach record. Git runs for real against local "remote" repositories (the fixture runner
 * maps the https URLs with command-scope `insteadOf`); nothing leaves the host.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  commitFiles,
  type Fixture,
  g,
  gIn,
  gitmodulesText,
  HOST,
  makeFixture,
  makeRemote,
  makeUmbrella,
  OWNER,
} from "../submodules/fixtures/repos.js";
import { attachRecordFile, storePath } from "../submodules/index.js";
import { collectOrphans, findOrphans, runRetentionGc } from "./gc.js";
import { SubmodulePreparationError, WorkspaceManager } from "./manager.js";
import type { SubmodulePlan } from "./submodules.js";

let fx: Fixture;
let db: Database.Database;
let ledger: Ledger;
let dataDir: string;
let artifacts: ArtifactStore;

beforeEach(() => {
  fx = makeFixture("sb-ws-sub-");
  dataDir = path.join(fx.root, "data");
  db = openLedger(path.join(fx.root, "ledger"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
});
afterEach(() => {
  db.close();
  rmSync(fx.root, { recursive: true, force: true });
});

const url = (repo: string) => `https://${HOST}/${OWNER}/${repo}.git`;
const PLAN: SubmodulePlan = { writablePaths: ["mods/a"], exclude: [] };

function manager(plan: SubmodulePlan | null = PLAN, sources = () => fx.settings) {
  return new WorkspaceManager({
    db,
    artifacts,
    dataDir,
    allowedRoots: [fx.root],
    ids: createIdGenerator(),
    submodules: { sources, git: fx.runner, plan: (id) => (id === "umb" && plan !== null ? plan : undefined) },
  });
}

function umbrella() {
  const a = makeRemote(fx, "lib-a", { "a.txt": "a1\n" });
  const b = makeRemote(fx, "lib-b", { "b.txt": "b1\n" });
  const u = makeUmbrella(
    fx,
    { "mods/a": a.head, "mods/b": b.head },
    gitmodulesText([
      ["a", "mods/a", url("lib-a")],
      ["b", "mods/b", url("lib-b")],
    ]),
  );
  return { a, b, u };
}

function newRun(sessionId: string, projectId: string | null = "umb") {
  return ledger.createRun({
    metaSessionId: sessionId,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
    ...(projectId !== null ? { projectId } : {}),
  });
}

async function prepare(mgr: WorkspaceManager, repo: string, sessionId?: string, resumeIn?: string) {
  const session = sessionId ?? ledger.createMetaSession({ objective: "o", repoRoot: repo }).id;
  const run = newRun(session);
  const ws = await mgr.prepare({
    metaSessionId: session,
    runId: run.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
    ...(resumeIn !== undefined ? { resumeIn: { originPath: resumeIn } } : {}),
  });
  if (ws.mode !== "worktree") throw new Error("expected worktree");
  return { session, run, ws };
}

/** Worktree paths a store lists (its own main worktree excluded). */
function storeWorktrees(repo: string): string[] {
  const store = storePath({ host: HOST, owner: OWNER, repo }, fx.settings);
  return g(store, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .slice(1);
}

describe("run worktree submodules (ADR-0079 item 3)", () => {
  it("attaches every declared submodule at its gitlink commit and records it beside the worktree", async () => {
    const { a, b, u } = umbrella();
    const { ws } = await prepare(manager(), u.dir);
    expect(readFileSync(path.join(ws.worktreePath, "mods/a/a.txt"), "utf8")).toBe("a1\n");
    expect(g(path.join(ws.worktreePath, "mods/b"), "rev-parse", "HEAD")).toBe(b.head);
    const rec = JSON.parse(readFileSync(attachRecordFile(ws.worktreePath), "utf8")) as {
      entries: { path: string; sha: string; writable: boolean }[];
    };
    expect(rec.entries.map((e) => [e.path, e.sha, e.writable])).toEqual([
      ["mods/a", a.head, true],
      ["mods/b", b.head, false],
    ]);
    expect(attachRecordFile(ws.worktreePath).startsWith(path.join(dataDir, "worktrees"))).toBe(true);
    // The umbrella's own state is untouched: no change, and the gitlinks are what the base commit says.
    expect(g(ws.worktreePath, "status", "--porcelain", "--ignore-submodules=all")).toBe("");
    expect(fx.calls.filter((c) => c.includes("clone"))).toHaveLength(2);
  });

  it("a context without recursive mode gets exactly the old worktree: empty gitlink directories, no record, no Git", async () => {
    const { u } = umbrella();
    const { ws } = await prepare(manager(null), u.dir);
    expect(readdirSync(path.join(ws.worktreePath, "mods/a"))).toEqual([]);
    expect(existsSync(attachRecordFile(ws.worktreePath))).toBe(false);
    expect(fx.calls).toEqual([]);
    // A run without a project is never planned either.
    const session = ledger.createMetaSession({ objective: "o", repoRoot: u.dir });
    const run = newRun(session.id, null);
    const plain = await manager().prepare({
      metaSessionId: session.id,
      runId: run.id,
      workspace: u.dir,
      trustProfile: "edit-untrusted",
    });
    if (plain.mode !== "worktree") throw new Error("expected worktree");
    expect(existsSync(attachRecordFile(plain.worktreePath))).toBe(false);
    expect(fx.calls).toEqual([]);
  });

  it("a submodule refusal fails prepare with its closed reason and path, never the URL, and releases the lease", async () => {
    const { u } = umbrella();
    const mgr = manager(PLAN, () => ({ ...fx.settings, allowedOwners: ["someone-else"] }));
    const session = ledger.createMetaSession({ objective: "o", repoRoot: u.dir });
    const run = newRun(session.id);
    const err = await mgr
      .prepare({ metaSessionId: session.id, runId: run.id, workspace: u.dir, trustProfile: "edit-untrusted" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmodulePreparationError);
    const spe = err as SubmodulePreparationError;
    expect(spe.reason).toBe("SUBMODULE_SOURCE_NOT_ALLOWED");
    expect(spe.failureCode).toBe("PERMISSION_BLOCKED");
    expect(spe.path).toBe("mods/a");
    expect(spe.message).not.toContain(HOST);
    expect(spe.message).toContain('"mods/a"');
    const lease = db.prepare("SELECT lease_run_id FROM meta_session WHERE id = ?").get(session.id) as {
      lease_run_id: string | null;
    };
    expect(lease.lease_run_id).toBeNull();
    expect(fx.calls).toEqual([]);
  });

  it("a commit missing from its repository fails prepare with SUBMODULE_COMMIT_MISSING and leaves nothing attached", async () => {
    const a = makeRemote(fx, "lib-a", { "a.txt": "a1\n" });
    makeRemote(fx, "lib-b", { "b.txt": "b1\n" });
    const u = makeUmbrella(
      fx,
      { "mods/a": a.head, "mods/b": `${"0".repeat(39)}1` },
      gitmodulesText([
        ["a", "mods/a", url("lib-a")],
        ["b", "mods/b", url("lib-b")],
      ]),
    );
    const err = (await prepare(manager(), u.dir).catch((e: unknown) => e)) as SubmodulePreparationError;
    expect(err).toBeInstanceOf(SubmodulePreparationError);
    expect(err.reason).toBe("SUBMODULE_COMMIT_MISSING");
    expect(err.path).toBe("mods/b");
    expect(storeWorktrees("lib-a")).toEqual([]);
  });

  it("a resumed worktree refreshes its record: a moved gitlink is re-pointed in place, nothing is attached twice", async () => {
    const { a, b, u } = umbrella();
    const mgr = manager();
    const first = await prepare(mgr, u.dir);
    const wt = first.ws.worktreePath;
    const aDir = path.join(wt, "mods/a");
    const linkBefore = readFileSync(path.join(aDir, ".git"), "utf8");
    mgr.releaseLease(first.run.id);
    db.prepare("UPDATE run SET state = 'SUCCEEDED' WHERE id = ?").run(first.run.id);

    // The meta-session's head moves to an umbrella commit whose mods/a gitlink is a newer lib-a commit.
    const a2 = commitFiles(a.dir, { "a.txt": "a2\n" }, "second");
    gIn(u.dir, `160000 ${a2}\tmods/a\n`, "update-index", "--index-info");
    g(u.dir, "commit", "-q", "-m", "bump a");
    const head = g(u.dir, "rev-parse", "HEAD");
    db.prepare("UPDATE meta_session SET head_commit = ? WHERE id = ?").run(head, first.session);

    const second = await prepare(mgr, u.dir, first.session, wt);
    expect(second.ws.worktreePath).toBe(wt);
    expect(g(aDir, "rev-parse", "HEAD")).toBe(a2);
    expect(readFileSync(path.join(aDir, "a.txt"), "utf8")).toBe("a2\n");
    expect(readFileSync(path.join(aDir, ".git"), "utf8")).toBe(linkBefore); // the same linked worktree
    expect(g(path.join(wt, "mods/b"), "rev-parse", "HEAD")).toBe(b.head);
    expect(storeWorktrees("lib-a")).toHaveLength(1);
    expect(storeWorktrees("lib-b")).toHaveLength(1);
    const rec = JSON.parse(readFileSync(attachRecordFile(wt), "utf8")) as { entries: { path: string; sha: string }[] };
    expect(rec.entries.map((e) => [e.path, e.sha])).toEqual([
      ["mods/a", a2],
      ["mods/b", b.head],
    ]);
  });

  it("rollback also rolls attached submodule worktrees back to their recorded commits", async () => {
    const { a, u } = umbrella();
    const mgr = manager();
    const { run, ws } = await prepare(mgr, u.dir);
    const aDir = path.join(ws.worktreePath, "mods/a");
    writeFileSync(path.join(aDir, "a.txt"), "edited\n");
    writeFileSync(path.join(aDir, "new.txt"), "new\n");
    await mgr.rollback(run.id);
    expect(readFileSync(path.join(aDir, "a.txt"), "utf8")).toBe("a1\n");
    expect(existsSync(path.join(aDir, "new.txt"))).toBe(false);
    expect(g(aDir, "rev-parse", "HEAD")).toBe(a.head);
  });

  it("re-creating a gone worktree at the same path detaches the old record first (partial-worktree repair)", async () => {
    const { u } = umbrella();
    const mgr = manager();
    const first = await prepare(mgr, u.dir);
    const wt = first.ws.worktreePath;
    mgr.releaseLease(first.run.id);
    db.prepare("UPDATE run SET state = 'SUCCEEDED' WHERE id = ?").run(first.run.id);
    rmSync(wt, { recursive: true, force: true });
    const second = await prepare(mgr, u.dir, first.session, wt);
    expect(readFileSync(path.join(second.ws.worktreePath, "mods/a/a.txt"), "utf8")).toBe("a1\n");
    expect(storeWorktrees("lib-a")).toEqual([path.join(wt, "mods/a")]);
  });

  it("retention gc detaches the submodule worktrees through the record and prunes the stores", async () => {
    const { u } = umbrella();
    const mgr = manager();
    const { session, run, ws } = await prepare(mgr, u.dir);
    mgr.releaseLease(run.id);
    db.prepare("UPDATE run SET state = 'SUCCEEDED' WHERE id = ?").run(run.id);
    expect(storeWorktrees("lib-a")).toHaveLength(1);
    const r = await runRetentionGc({
      db,
      artifacts,
      dataDir,
      days: 0,
      now: new Date(Date.now() + 86_400_000),
      cloneRoot: fx.settings.cloneRoot,
    });
    expect(r.errors).toEqual([]);
    expect(r.collected.map((c) => c.sessionId)).toEqual([session]);
    expect(existsSync(ws.worktreePath)).toBe(false);
    expect(existsSync(attachRecordFile(ws.worktreePath))).toBe(false);
    expect(storeWorktrees("lib-a")).toEqual([]);
    expect(storeWorktrees("lib-b")).toEqual([]);
  });

  it("the orphan sweep does not report a live run's attach record, and detaches an orphan worktree's submodules", async () => {
    const { u } = umbrella();
    const mgr = manager();
    const { session, run, ws } = await prepare(mgr, u.dir);
    expect((await findOrphans({ db, dataDir })).worktrees).toEqual([]);

    // The run row disappears from the ledger's view (an orphan): the directory and its record are collected together.
    mgr.releaseLease(run.id);
    const orphanDir = path.join(dataDir, "worktrees", session, "run_orphan1");
    renameSync(ws.worktreePath, orphanDir);
    writeFileSync(
      attachRecordFile(orphanDir),
      readFileSync(attachRecordFile(ws.worktreePath), "utf8").replaceAll(ws.worktreePath, orphanDir),
    );
    rmSync(attachRecordFile(ws.worktreePath));
    for (const [repo, p] of [
      ["lib-a", "mods/a"],
      ["lib-b", "mods/b"],
    ] as const) {
      g(storePath({ host: HOST, owner: OWNER, repo }, fx.settings), "worktree", "repair", path.join(orphanDir, p));
    }
    expect(storeWorktrees("lib-a")).toEqual([path.join(orphanDir, "mods/a")]);
    expect((await findOrphans({ db, dataDir })).worktrees).toEqual([orphanDir]);
    await collectOrphans({ db, dataDir, days: 0, cloneRoot: fx.settings.cloneRoot });
    const later = new Date(Date.now() + 86_400_000);
    const o = await collectOrphans({ db, dataDir, days: 0, now: later, cloneRoot: fx.settings.cloneRoot });
    expect(o.errors).toEqual([]);
    expect(o.removedWorktrees).toEqual([orphanDir]);
    expect(existsSync(attachRecordFile(orphanDir))).toBe(false);
    expect(storeWorktrees("lib-a")).toEqual([]);
  });
});
