import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { parseGitVersion, versionAtLeast } from "./git.js";
import { MIN_GIT_VERSION, parseNameStatus, WorkspaceError, WorkspaceManager } from "./index.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
}

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;
let store: ArtifactStore;

function newRun(sessionId: string, profile: TrustProfile = "edit-untrusted") {
  return ledger.createRun({
    metaSessionId: sessionId,
    trustProfile: profile,
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-ws-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "original\n");
  writeFileSync(path.join(repo, "b.txt"), "bee\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(path.join(root, "ledger"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  store = new ArtifactStore(path.join(dataDir, "artifacts"));
  mgr = new WorkspaceManager({ db, artifacts: store, dataDir, allowedRoots: [root], ids: createIdGenerator() });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function prepared(profile: TrustProfile = "edit-untrusted") {
  const session = ledger.createMetaSession({ objective: "o", repoRoot: repo });
  const run = newRun(session.id, profile);
  const ws = await mgr.prepare({
    metaSessionId: session.id,
    runId: run.id,
    workspace: repo,
    trustProfile: profile,
  });
  if (ws.mode !== "worktree") throw new Error("expected worktree");
  return { session, run, ws };
}

describe("workspace manager", () => {
  it("documents a minimum git version", () => {
    expect(MIN_GIT_VERSION).toEqual([2, 32, 0]);
  });

  it("the version gate rejects Git 2.31 and accepts 2.32 (ADR-0023)", () => {
    const gate = (out: string) => {
      const v = parseGitVersion(out);
      return v !== undefined && versionAtLeast(v, MIN_GIT_VERSION);
    };
    expect(gate("git version 2.30.2")).toBe(false);
    expect(gate("git version 2.31.0")).toBe(false);
    expect(gate("git version 2.31.9")).toBe(false);
    expect(gate("git version 2.32.0")).toBe(true);
    expect(gate("git version 2.43.0")).toBe(true);
    expect(gate("git version 3.0.0")).toBe(true);
    expect(gate("git version 2.39.5 (Apple Git-154)")).toBe(true);
    expect(gate("not git")).toBe(false);
  });

  it("creates a worktree on a controller branch from a recorded base checkpoint", async () => {
    const { session, run, ws } = await prepared();
    expect(ws.branch).toBe(`switchboard/${session.id}/${run.id}`);
    expect(ws.worktreePath).toBe(path.join(dataDir, "worktrees", session.id, run.id));
    expect(g(ws.worktreePath, "rev-parse", "HEAD").trim()).toBe(g(repo, "rev-parse", "main").trim());
    const kinds = db.prepare("SELECT kind FROM workspace_checkpoint WHERE run_id = ? ORDER BY kind").all(run.id) as {
      kind: string;
    }[];
    expect(kinds.map((k) => k.kind)).toEqual(["base", "pre"]);
    const row = db.prepare("SELECT worktree_path, branch, base_checkpoint_id FROM run WHERE id = ?").get(run.id) as {
      worktree_path: string;
      branch: string;
      base_checkpoint_id: string;
    };
    expect(row.branch).toBe(ws.branch);
    expect(row.base_checkpoint_id).toBe(ws.baseCheckpointId);
  });

  it("refuses a second lease on the same worktree chain and allows it after release", async () => {
    const { session, run } = await prepared();
    const second = newRun(session.id);
    await expect(
      mgr.prepare({ metaSessionId: session.id, runId: second.id, workspace: repo, trustProfile: "edit-untrusted" }),
    ).rejects.toMatchObject({ code: "LEASE_HELD" });
    // the refused run created no worktree or branch
    expect(g(repo, "branch", "--list", "switchboard/*").trim()).toContain(run.id);
    expect(g(repo, "branch", "--list", `switchboard/${session.id}/${second.id}`).trim()).toBe("");
    expect(mgr.releaseLease(run.id)).toBe(true);
    const ok = await mgr.prepare({
      metaSessionId: session.id,
      runId: second.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
    });
    expect(ok.mode).toBe("worktree");
  });

  it("leaves the operator branch and working tree untouched", async () => {
    writeFileSync(path.join(repo, "dirty.txt"), "operator wip\n");
    const headBefore = g(repo, "rev-parse", "HEAD");
    const statusBefore = g(repo, "status", "--porcelain=v2", "--untracked-files=all");
    const { run, ws } = await prepared();
    writeFileSync(path.join(ws.worktreePath, "a.txt"), "changed\n");
    writeFileSync(path.join(ws.worktreePath, "new.txt"), "new\n");
    await mgr.finalize(run.id);
    expect(g(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(g(repo, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
    expect(g(repo, "status", "--porcelain=v2", "--untracked-files=all")).toBe(statusBefore);
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("original\n");
    expect(existsSync(path.join(repo, "new.txt"))).toBe(false);
    expect(readFileSync(path.join(repo, "dirty.txt"), "utf8")).toBe("operator wip\n");
  });

  it("commits a post checkpoint and stores retrievable diff and changed_files artifacts", async () => {
    const { session, run, ws } = await prepared();
    writeFileSync(path.join(ws.worktreePath, "a.txt"), "changed\n");
    writeFileSync(path.join(ws.worktreePath, "new.txt"), "new\n");
    writeFileSync(path.join(ws.worktreePath, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    const res = await mgr.finalize(run.id);
    expect(res.committed).toBe(true);
    expect(g(ws.worktreePath, "rev-parse", "HEAD").trim()).toBe(res.postCommit);
    expect(g(ws.worktreePath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(ws.branch);
    expect(res.changedFiles.map((f) => f.path).sort()).toEqual(["a.txt", "bin.dat", "new.txt"]);

    const art = db.prepare("SELECT kind, sha256, run_id FROM artifact WHERE id = ?").get(res.diffArtifactId) as {
      kind: string;
      sha256: string;
      run_id: string;
    };
    expect(art.kind).toBe("diff");
    expect(art.run_id).toBe(run.id);
    const diff = (await store.get(art.sha256)).toString("utf8");
    expect(diff).toContain("+changed");
    expect(diff).toContain("GIT binary patch");
    const cf = db.prepare("SELECT sha256 FROM artifact WHERE id = ?").get(res.changedFilesArtifactId) as {
      sha256: string;
    };
    expect(JSON.parse((await store.get(cf.sha256)).toString("utf8"))).toHaveLength(3);

    const head = db.prepare("SELECT head_commit FROM meta_session WHERE id = ?").get(session.id) as {
      head_commit: string;
    };
    expect(head.head_commit).toBe(res.postCommit);
    const post = db.prepare("SELECT post_checkpoint_id FROM run WHERE id = ?").get(run.id) as {
      post_checkpoint_id: string;
    };
    expect(post.post_checkpoint_id).toBe(res.postCheckpointId);
  });

  it("skips the commit when the tree is clean", async () => {
    const { run, ws } = await prepared();
    const res = await mgr.finalize(run.id);
    expect(res.committed).toBe(false);
    expect(res.postCommit).toBe(ws.baseCommit);
    expect(res.changedFiles).toEqual([]);
  });

  it("flags a non-mutating failure as not mutated and replay-eligible", async () => {
    const { run } = await prepared();
    const a = await mgr.assessMutation(run.id);
    expect(a).toEqual({ mutated: false, replayEligible: true, reasons: [], nestedRepositories: [] });
  });

  it.each([
    ["modified tracked file", (w: string) => writeFileSync(path.join(w, "a.txt"), "x\n")],
    ["untracked file", (w: string) => writeFileSync(path.join(w, "u.txt"), "x\n")],
    [
      "commit inside the worktree",
      (w: string) => {
        writeFileSync(path.join(w, "c.txt"), "x\n");
        g(w, "add", "-A");
        g(w, "commit", "-q", "-m", "x");
      },
    ],
  ])("detects mutation: %s", async (_name, mutate) => {
    const { run, ws } = await prepared();
    mutate(ws.worktreePath);
    const a = await mgr.assessMutation(run.id);
    expect(a.mutated).toBe(true);
    expect(a.replayEligible).toBe(false);
  });

  it("treats an unreadable worktree as mutated (fail closed)", async () => {
    const { run, ws } = await prepared();
    rmSync(ws.worktreePath, { recursive: true, force: true });
    expect((await mgr.assessMutation(run.id)).mutated).toBe(true);
  });

  it("rolls a mutated failure back to the base checkpoint and keeps the diff as evidence", async () => {
    const { run, ws } = await prepared();
    writeFileSync(path.join(ws.worktreePath, "a.txt"), "broken\n");
    g(ws.worktreePath, "rm", "-q", "b.txt");
    mkdirSync(path.join(ws.worktreePath, "sub"));
    writeFileSync(path.join(ws.worktreePath, "sub", "junk.txt"), "junk\n");
    expect((await mgr.assessMutation(run.id)).mutated).toBe(true);

    const res = await mgr.rollback(run.id);
    expect(res.restoredTo).toBe(ws.baseCommit);
    expect(readFileSync(path.join(ws.worktreePath, "a.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(path.join(ws.worktreePath, "b.txt"), "utf8")).toBe("bee\n");
    expect(existsSync(path.join(ws.worktreePath, "sub", "junk.txt"))).toBe(false);
    expect(g(ws.worktreePath, "rev-parse", "HEAD").trim()).toBe(ws.baseCommit);
    expect((await mgr.assessMutation(run.id)).mutated).toBe(false);

    const art = db.prepare("SELECT sha256 FROM artifact WHERE id = ?").get(res.diffArtifactId) as { sha256: string };
    const diff = (await store.get(art.sha256)).toString("utf8");
    expect(diff).toContain("+broken");
    expect(diff).toContain("junk.txt");
  });

  it("rolls back a failed attempt that committed inside the worktree", async () => {
    const { run, ws } = await prepared();
    writeFileSync(path.join(ws.worktreePath, "c.txt"), "x\n");
    g(ws.worktreePath, "add", "-A");
    g(ws.worktreePath, "commit", "-q", "-m", "x");
    await mgr.rollback(run.id);
    expect(existsSync(path.join(ws.worktreePath, "c.txt"))).toBe(false);
    expect(g(ws.worktreePath, "rev-parse", "HEAD").trim()).toBe(ws.baseCommit);
  });

  it("refuses a non-Git workspace for write profiles but allows read-only inspect", async () => {
    const plain = path.join(root, "plain");
    mkdirSync(plain);
    const session = ledger.createMetaSession({ objective: "o" });
    const run = newRun(session.id);
    await expect(
      mgr.prepare({ metaSessionId: session.id, runId: run.id, workspace: plain, trustProfile: "edit-untrusted" }),
    ).rejects.toMatchObject({ code: "NOT_A_GIT_REPO" });
    const ro = await mgr.prepare({
      metaSessionId: session.id,
      runId: run.id,
      workspace: plain,
      trustProfile: "inspect-untrusted",
    });
    expect(ro).toEqual({ mode: "read-only", path: plain });
    expect(db.prepare("SELECT lease_run_id FROM meta_session WHERE id = ?").get(session.id)).toEqual({
      lease_run_id: null,
    });
  });

  it("requires the workspace to be under an allowed root", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-out-")));
    try {
      g(outside, "init", "-q", "-b", "main");
      const session = ledger.createMetaSession({ objective: "o" });
      const run = newRun(session.id);
      for (const profile of ["edit-untrusted", "inspect-untrusted"] as const) {
        await expect(
          mgr.prepare({ metaSessionId: session.id, runId: run.id, workspace: outside, trustProfile: profile }),
        ).rejects.toMatchObject({ code: "WORKSPACE_NOT_ALLOWED" });
      }
      // a sibling directory sharing the root's prefix is not under the root
      const sibling = `${root}-evil`;
      mkdirSync(sibling);
      try {
        await expect(
          mgr.prepare({ metaSessionId: session.id, runId: run.id, workspace: sibling, trustProfile: "edit-untrusted" }),
        ).rejects.toBeInstanceOf(WorkspaceError);
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a plain subdirectory whose parent repository is outside the allowed roots", async () => {
    const narrow = new WorkspaceManager({
      db,
      artifacts: store,
      dataDir,
      allowedRoots: [path.join(repo, "sub")],
    });
    mkdirSync(path.join(repo, "sub"));
    const session = ledger.createMetaSession({ objective: "o" });
    const run = newRun(session.id);
    await expect(
      narrow.prepare({
        metaSessionId: session.id,
        runId: run.id,
        workspace: path.join(repo, "sub"),
        trustProfile: "edit-untrusted",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_ALLOWED" });
  });

  it("starts a follow-up run from the session head (linear chain)", async () => {
    const { session, run, ws } = await prepared();
    writeFileSync(path.join(ws.worktreePath, "a.txt"), "v2\n");
    const fin = await mgr.finalize(run.id);
    mgr.releaseLease(run.id);
    const run2 = newRun(session.id);
    const ws2 = await mgr.prepare({
      metaSessionId: session.id,
      runId: run2.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
    });
    if (ws2.mode !== "worktree") throw new Error("expected worktree");
    expect(ws2.baseCommit).toBe(fin.postCommit);
    expect(readFileSync(path.join(ws2.worktreePath, "a.txt"), "utf8")).toBe("v2\n");
  });

  it("refuses stealing an expired lease whose holder is still non-terminal", async () => {
    let t = Date.parse("2026-01-01T00:00:00Z");
    const clocked = new WorkspaceManager({
      db,
      artifacts: store,
      dataDir,
      allowedRoots: [root],
      now: () => new Date(t),
    });
    const session = ledger.createMetaSession({ objective: "o" });
    const r1 = newRun(session.id);
    const r2 = newRun(session.id);
    await clocked.prepare({
      metaSessionId: session.id,
      runId: r1.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
      leaseTtlMs: 1000,
    });
    t += 5000;
    await expect(
      clocked.prepare({ metaSessionId: session.id, runId: r2.id, workspace: repo, trustProfile: "edit-untrusted" }),
    ).rejects.toMatchObject({ code: "LEASE_STALE" });
  });

  it("creates worktrees for concurrent runs on one repository one at a time (T9.11)", async () => {
    // Git takes no lock on `.git/worktrees/` during `git worktree add`; overlapping adds failed intermittently with
    // `fatal: failed to read .git/worktrees/<id>/commondir`. A `git` shim on PATH records any overlap of two adds
    // deterministically (each add is held open for 150 ms) and then runs the real Git.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const shimDir = path.join(root, "shim");
    const marks = path.join(root, "marks");
    mkdirSync(shimDir);
    mkdirSync(marks);
    const q = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      path.join(shimDir, "git"),
      [
        "#!/bin/sh",
        'case " $* " in',
        '*" worktree add "*)',
        `  if mkdir ${q(path.join(marks, "active"))} 2>/dev/null; then mine=1; else mine=0;`,
        `    : > ${q(path.join(marks, "overlap"))}; fi`,
        "  sleep 0.15",
        `  ${q(realGit)} "$@"; status=$?`,
        `  if [ "$mine" = 1 ]; then rmdir ${q(path.join(marks, "active"))}; fi`,
        '  exit "$status" ;;',
        "esac",
        `exec ${q(realGit)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ""}`;
    try {
      const jobs = Array.from({ length: 6 }, () => {
        const session = ledger.createMetaSession({ objective: "o", repoRoot: repo });
        const run = newRun(session.id);
        return mgr.prepare({
          metaSessionId: session.id,
          runId: run.id,
          workspace: repo,
          trustProfile: "edit-untrusted",
        });
      });
      const results = await Promise.allSettled(jobs);
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(existsSync(path.join(marks, "overlap"))).toBe(false);
    expect(g(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(7);
  });

  it("parses name-status -z output", () => {
    expect(parseNameStatus("M\0a b.txt\0A\0n\tl.txt\0")).toEqual([
      { status: "M", path: "a b.txt" },
      { status: "A", path: "n\tl.txt" },
    ]);
  });
});
