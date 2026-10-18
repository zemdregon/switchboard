/**
 * T16.6 removal point 3 (FR-SKL-06, FR-EXE-06; LLD §19.8, TDD §3.16.2 property 5): after a controller restart, a run
 * found in each non-terminal state that can hold a worktree (LEASED with its worktree, RUNNING, VERIFYING, FINALIZING)
 * has its native skill files removed before its worktree is assessed and checkpointed; the checkpoint never contains a
 * recorded path, even one the agent staged. Synthetic runs walked through the FRD edges; real Git in temporary
 * repositories; no provider CLI.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_NATIVE_SKILL_LOCATION } from "../adapters/fake/adapter.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type RunState } from "../ledger/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { reconcile } from "./index.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const ALPHA = ".fake/skills/switchboard-alpha-docs.md";

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let workspace: WorkspaceManager;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-nsr-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  workspace = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A synthetic run walked to `state`, its worktree prepared at LEASED and one skill delivered natively there. */
async function inFlight(state: RunState): Promise<{ run: RunRecord; wt: string }> {
  const sess = ledger.createMetaSession({ objective: "synthetic" });
  const created = ledger.createRun({
    metaSessionId: sess.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {
      objective: "synthetic",
      workspace: repo,
      constraints: [],
      trust_profile: "edit-untrusted",
      provider: "fake",
    },
    requestHash: "h",
    clientId: "client-a",
    provider: "fake",
  });
  const edges: [RunState, string][] = [
    ["PREFLIGHT", "T4"],
    ["LEASED", "T5"],
    ["RUNNING", "T9"],
    state === "VERIFYING" ? ["VERIFYING", "T11"] : ["FINALIZING", "T13"],
  ];
  let cur = ledger.getRunRecord(created.id) as RunRecord;
  let wt = "";
  for (const [to, rule] of edges) {
    cur = ledger.casRunState({
      runId: cur.id,
      from: cur.state,
      to,
      expectedVersion: cur.version,
      payload: { rule, ...(to === "FINALIZING" ? { pending: "success" } : {}) },
    }) as RunRecord;
    if (to === "LEASED") {
      const ws = await workspace.prepare({
        metaSessionId: sess.id,
        runId: cur.id,
        workspace: repo,
        trustProfile: "edit-untrusted",
      });
      if (ws.mode !== "worktree") throw new Error("expected a worktree");
      wt = ws.worktreePath;
      db.prepare(
        `INSERT INTO run_skill (run_id, position, name, version, sha256, source, delivery)
         VALUES (?, 0, 'alpha-docs', 1, ?, 'request', 'prompt_prefix')`,
      ).run(cur.id, "a".repeat(64));
      const out = await workspace.writeNativeSkills(cur.id, FAKE_NATIVE_SKILL_LOCATION, [
        { name: "alpha-docs", version: 1, sha256: "a".repeat(64), body: "Alpha body.\n" },
      ]);
      expect(out[0]?.delivery).toBe("native");
      workspace.markNativeDelivered(cur.id, new Date().toISOString());
      cur = ledger.getRunRecord(cur.id) as RunRecord;
    }
    if (cur.state === state) break;
  }
  expect(cur.state).toBe(state);
  return { run: cur, wt };
}

describe("startup reconciliation removes native skill files (T16.6, LLD §19.8 point 3)", () => {
  for (const state of ["LEASED", "RUNNING", "VERIFYING", "FINALIZING"] as const) {
    it(`a run found ${state}: removed and verified before the checkpoint, which never contains the path`, async () => {
      const { run, wt } = await inFlight(state);
      // The agent edited its file, staged it and wrote work of its own before the controller died.
      writeFileSync(path.join(wt, ALPHA), "edited\n");
      g(wt, "add", "-f", ALPHA);
      writeFileSync(path.join(wt, "work.txt"), "work\n");

      await reconcile({ db, ledger, workspace, killGraceMs: 300 });

      const after = ledger.getRunRecord(run.id) as RunRecord;
      expect(["FAILED", "SUCCEEDED"]).toContain(after.state);
      expect(existsSync(path.join(wt, ALPHA))).toBe(false);
      const row = db.prepare("SELECT removal, removed_at FROM run_skill WHERE run_id = ?").get(run.id) as {
        removal: string;
        removed_at: string | null;
      };
      expect(row.removal).toBe("verified");
      expect(row.removed_at).not.toBeNull();
      const types = ledger.listRunEvents(run.id).map((e) => e.type);
      expect(types).toContain("skill_tampered");
      const removed = ledger.listRunEvents(run.id).filter((e) => e.type === "skill_removed");
      expect(removed.map((e) => JSON.parse(e.payload_json).point)).toEqual(["reconciliation"]);
      expect(types.indexOf("skill_removed")).toBeLessThan(types.indexOf("workspace_assessment"));
      const post = ledger.getRunCheckpointCommit(run.id, "post") as string;
      const tree = g(repo, "ls-tree", "-r", "--name-only", post).split("\n");
      expect(tree).toContain("work.txt");
      expect(tree).not.toContain(ALPHA);

      // Idempotent: a second pass over the reconciled ledger writes nothing.
      const n = ledger.listRunEvents(run.id).length;
      await reconcile({ db, ledger, workspace, killGraceMs: 300 });
      expect(ledger.listRunEvents(run.id)).toHaveLength(n);
    });
  }
});
