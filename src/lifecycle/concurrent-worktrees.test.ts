/**
 * T9.11 (FR-WS-08, FR-WS-02, owner decision 42; LLD §5): concurrent runs of one project, in different meta-sessions,
 * each get their own controller-created worktree, controller branch and write lease, and nothing is shared. The runs go
 * through the real run lifecycle with a fake provider CLI (no provider, no network, no credential) against a temporary
 * Git repository. The fake CLI writes one file named after its objective and then waits for a per-run gate file, so
 * both runs are provably RUNNING at the same time.
 *
 * Not covered here, and not testable before M10: that a `container` run mounts only its own worktree (FR-PRJ-05).
 * Container environments are not built; a `container` project fails `projects validate` and admission today
 * (`ENVIRONMENT_NOT_IMPLEMENTED`, tested in `src/cli/projects.test.ts` and the MCP server tests).
 *
 * FR-WS-09 (removal of a concurrent run's worktree on merge or abandon) is Proposed and not accepted by the owner; its
 * merge trigger is open question Q-55. Its tests below are skipped placeholders until the owner accepts it; until then
 * FRD §4.4 applies unchanged (worktrees stay until retention GC).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { GIT_POLICY_VIOLATION_EVENT } from "../git/ref-guard.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunState } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { runRetentionGc, WorkspaceManager } from "../workspace/index.js";
import { LifecycleError, RunLifecycle } from "./index.js";

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
const hasBranch = (cwd: string, branch: string): boolean => {
  try {
    g(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
/** One project, one writable primary context; no identity, so no commit tool and no finalize-only commit. */
const PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "trusted-development",
  writable: true,
};

/**
 * Fake CLI: the objective (stdin) is a short name; it writes `<name>.txt` in its working directory, then waits until
 * `<gates>/<name>.go` exists and ends successfully. `GATES` is replaced with the gate directory's path.
 */
const GATED_CLI = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  const name = readFileSync(0, "utf8").trim();
  if (!/^[a-z0-9]+$/.test(name)) { emit({ type: "result", ok: false, summary: "bad name" }); process.exit(1); }
  emit({ type: "session", session_id: "gated-" + name });
  writeFileSync(name + ".txt", name + "\\n");
  emit({ type: "tool", tool: "edit", name: "write_file", target: name + ".txt" });
  const gate = path.join(GATES, name + ".go");
  const timer = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(timer);
    emit({ type: "result", ok: true, summary: "wrote " + name });
  }, 20);
}
`;

let root: string;
let repo: string;
let dataDir: string;
let gates: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle;
/**
 * Test seam: awaited by the workspace manager's artifact store before each write. The manager writes its first artifact
 * of a run (the diff) after the checkpoint commit has moved the run branch and before the `post` row is recorded.
 */
let beforeWorkspacePut: (() => Promise<void>) | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-conc-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  gates = path.join(root, "gates");
  mkdirSync(gates);
  const script = path.join(root, "gated-cli.mjs");
  writeFileSync(script, GATED_CLI.replace("GATES", JSON.stringify(gates)));
  db = openLedger(path.join(root, "ledger"));
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const wsArtifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const put = wsArtifacts.put.bind(wsArtifacts);
  (wsArtifacts as { put: typeof put }).put = async (content) => {
    await beforeWorkspacePut?.();
    return put(content);
  };
  beforeWorkspacePut = undefined;
  const workspace = new WorkspaceManager({ db, artifacts: wsArtifacts, dataDir, allowedRoots: [root], ids });
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ script, commitChannel: "none", timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: () => PROFILE,
  });
  lifecycle.start();
});

afterEach(async () => {
  // Open every gate so no fake process outlives the test.
  for (const name of ["alpha", "beta", "gamma"]) writeFileSync(path.join(gates, `${name}.go`), "");
  await lifecycle.shutdown();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const open = (name: string) => writeFileSync(path.join(gates, `${name}.go`), "");

async function until(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const state = (runId: string): RunState | undefined => ledger.getRunRecord(runId)?.state;
const runRow = (runId: string) =>
  db.prepare("SELECT meta_session_id, worktree_path, branch FROM run WHERE id = ?").get(runId) as {
    meta_session_id: string;
    worktree_path: string | null;
    branch: string | null;
  };
const leaseOf = (metaSessionId: string) =>
  db.prepare("SELECT lease_run_id, lease_expires_at FROM meta_session WHERE id = ?").get(metaSessionId) as {
    lease_run_id: string | null;
    lease_expires_at: string | null;
  };
const leaseEvents = (runId: string) => ledger.listRunEvents(runId).filter((e) => e.type === "lease");
const violations = (runId: string) => ledger.listRunEvents(runId).filter((e) => e.type === GIT_POLICY_VIOLATION_EVENT);

/** Submit a project run (new meta-session unless `metaSessionId`) and wait until its CLI has written its file. */
async function startGated(name: string, metaSessionId?: string) {
  const { runId, metaSessionId: sess } = await lifecycle.submit({
    clientId: "c",
    objective: name,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    project: PROJECT,
    ...(metaSessionId !== undefined ? { metaSessionId } : {}),
  });
  await until(`${name} to write its file`, () => {
    const wt = runRow(runId).worktree_path;
    return state(runId) === "RUNNING" && wt !== null && existsSync(path.join(wt, `${name}.txt`));
  });
  const row = runRow(runId);
  return { runId, sess, worktree: row.worktree_path as string, branch: row.branch as string };
}

describe("concurrent-run worktrees per project (T9.11, FR-WS-08)", () => {
  it("two concurrent runs of a project: own worktrees, branches and leases; GC of one keeps the other", async () => {
    const operatorHead = g(repo, "rev-parse", "HEAD");
    const a = await startGated("alpha");
    const b = await startGated("beta");

    // Both are RUNNING at once, in different meta-sessions of the same project and primary context.
    expect(state(a.runId)).toBe("RUNNING");
    expect(state(b.runId)).toBe("RUNNING");
    expect(a.sess).not.toBe(b.sess);
    expect(ledger.getMetaSession(a.sess)?.project_id).toBe("web");
    expect(ledger.getMetaSession(b.sess)?.project_id).toBe("web");
    expect(ledger.getMetaSession(a.sess)?.repo_root).toBe(ledger.getMetaSession(b.sess)?.repo_root);

    // Distinct worktrees and controller branches, on the documented naming (LLD §5).
    expect(a.worktree).not.toBe(b.worktree);
    expect(a.worktree).toBe(path.join(dataDir, "worktrees", a.sess, a.runId));
    expect(b.worktree).toBe(path.join(dataDir, "worktrees", b.sess, b.runId));
    expect(a.branch).toBe(`switchboard/${a.sess}/${a.runId}`);
    expect(b.branch).toBe(`switchboard/${b.sess}/${b.runId}`);
    expect(g(a.worktree, "symbolic-ref", "HEAD")).toBe(`refs/heads/${a.branch}`);
    expect(g(b.worktree, "symbolic-ref", "HEAD")).toBe(`refs/heads/${b.branch}`);
    const listed = g(repo, "worktree", "list", "--porcelain");
    expect(listed).toContain(`worktree ${a.worktree}`);
    expect(listed).toContain(`worktree ${b.worktree}`);

    // One write lease each, held at the same time on separate meta-session rows (FR-WS-02, FR-WS-08).
    expect(leaseOf(a.sess).lease_run_id).toBe(a.runId);
    expect(leaseOf(b.sess).lease_run_id).toBe(b.runId);
    expect(leaseEvents(a.runId)).toHaveLength(1);
    expect(leaseEvents(b.runId)).toHaveLength(1);

    // Nothing is shared: each run's write is visible only in its own worktree, never in the operator's checkout.
    expect(existsSync(path.join(a.worktree, "beta.txt"))).toBe(false);
    expect(existsSync(path.join(b.worktree, "alpha.txt"))).toBe(false);
    expect(existsSync(path.join(repo, "alpha.txt"))).toBe(false);
    expect(existsSync(path.join(repo, "beta.txt"))).toBe(false);

    // The first run ends; the second keeps its lease and worktree.
    open("alpha");
    const doneA = await lifecycle.waitForTerminal(a.runId);
    expect(doneA.state, doneA.failure_detail ?? "").toBe("SUCCEEDED");
    expect(leaseOf(a.sess).lease_run_id).toBeNull();
    expect(leaseOf(b.sess).lease_run_id).toBe(b.runId);
    expect(state(b.runId)).toBe("RUNNING");
    expect(g(repo, "show", "--name-only", "--format=", a.branch).split("\n")).toEqual(["alpha.txt"]);

    // Cleanup of one: retention GC collects the first, idle meta-session while the second run still runs. The second
    // run's meta-session is leased, so it is not a candidate; its worktree, branch, file and lease are untouched.
    const gc = await runRetentionGc({
      db,
      artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
      dataDir,
      days: 1,
      now: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    expect(gc.errors).toEqual([]);
    expect(gc.collected.map((u) => u.sessionId)).toEqual([a.sess]);
    expect(existsSync(a.worktree)).toBe(false);
    expect(hasBranch(repo, a.branch)).toBe(false);
    expect(existsSync(b.worktree)).toBe(true);
    expect(readFileSync(path.join(b.worktree, "beta.txt"), "utf8")).toBe("beta\n");
    expect(hasBranch(repo, b.branch)).toBe(true);
    expect(leaseOf(b.sess).lease_run_id).toBe(b.runId);
    expect(state(b.runId)).toBe("RUNNING");

    open("beta");
    const doneB = await lifecycle.waitForTerminal(b.runId);
    expect(doneB.state, doneB.failure_detail ?? "").toBe("SUCCEEDED");
    expect(leaseOf(b.sess).lease_run_id).toBeNull();
    expect(g(repo, "show", "--name-only", "--format=", b.branch).split("\n")).toEqual(["beta.txt"]);
    // The other run's controller branches appearing and disappearing are not Git policy violations (FR-GIT-03).
    expect(violations(a.runId)).toEqual([]);
    expect(violations(b.runId)).toEqual([]);
    // The operator's checkout and branch are untouched (FR-WS-05).
    expect(g(repo, "rev-parse", "HEAD")).toBe(operatorHead);
    expect(g(repo, "status", "--porcelain")).toBe("");
  });

  it("no sharing across meta-sessions: a continuation gets its own worktree, an active session refuses", async () => {
    const a = await startGated("alpha");
    open("alpha");
    expect((await lifecycle.waitForTerminal(a.runId)).state).toBe("SUCCEEDED");

    const b = await startGated("beta");
    // A second writer cannot join a meta-session with an active run (FR-SES-06), so it can never share B's worktree.
    await expect(
      lifecycle.submit({
        clientId: "c",
        objective: "gamma",
        workspace: repo,
        trustProfile: "edit-untrusted",
        provider: "fake",
        project: PROJECT,
        metaSessionId: b.sess,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof LifecycleError && e.code === "INVALID_REQUEST");

    // Continuing the finished meta-session while B runs: a new worktree and branch for the new run, under its own
    // meta-session, built from that session's head (alpha's checkpoint), with its own lease.
    const a2 = await startGated("gamma", a.sess);
    expect(a2.sess).toBe(a.sess);
    expect(new Set([a.worktree, b.worktree, a2.worktree]).size).toBe(3);
    expect(new Set([a.branch, b.branch, a2.branch]).size).toBe(3);
    expect(a2.worktree).toBe(path.join(dataDir, "worktrees", a.sess, a2.runId));
    expect(existsSync(path.join(a2.worktree, "alpha.txt"))).toBe(true);
    expect(existsSync(path.join(a2.worktree, "beta.txt"))).toBe(false);
    expect(existsSync(path.join(b.worktree, "gamma.txt"))).toBe(false);
    expect(leaseOf(a.sess).lease_run_id).toBe(a2.runId);
    expect(leaseOf(b.sess).lease_run_id).toBe(b.runId);

    open("gamma");
    open("beta");
    expect((await lifecycle.waitForTerminal(a2.runId)).state).toBe("SUCCEEDED");
    expect((await lifecycle.waitForTerminal(b.runId)).state).toBe("SUCCEEDED");
    for (const id of [a.runId, a2.runId, b.runId]) expect(violations(id)).toEqual([]);
  });
});

describe("finalization of concurrent runs in one repository (T9.11 regression)", () => {
  it("a ref check never sees another run's checkpoint before its post row (no false violation)", async () => {
    const a = await startGated("alpha");
    const b = await startGated("beta");
    // Pause run A's finalization inside the window (checkpoint commit made, `post` row not yet recorded) and let run B
    // reach FINALIZING meanwhile. Before the fix, B's ref check ran in that window and reported A's run branch as
    // moved by a non-controller (`switchboard` scope), which BR-27 then holds against B's meta-session.
    let paused = false;
    beforeWorkspacePut = async () => {
      if (paused) return;
      paused = true;
      open("beta");
      await until("beta to reach FINALIZING", () => state(b.runId) !== "RUNNING");
      await new Promise((r) => setTimeout(r, 500));
    };
    open("alpha");
    const [doneA, doneB] = await Promise.all([lifecycle.waitForTerminal(a.runId), lifecycle.waitForTerminal(b.runId)]);
    expect(paused).toBe(true);
    expect(doneA.state, doneA.failure_detail ?? "").toBe("SUCCEEDED");
    expect(doneB.state, doneB.failure_detail ?? "").toBe("SUCCEEDED");
    expect(violations(a.runId)).toEqual([]);
    expect(violations(b.runId)).toEqual([]);
  });
});

/**
 * FR-WS-09 is Proposed (owner decision 42, Delegated) and NOT accepted by the owner; how a merge is detected is open
 * question Q-55. These placeholders stay skipped until the owner accepts FR-WS-09 and Q-55 is answered; until then FRD
 * §4.4 applies unchanged. Flipping the flag without implementing the behaviour makes them fail on purpose.
 */
const FR_WS_09_ACCEPTED = false;
const PENDING_FR_WS_09 = "FR-WS-09 is Proposed and awaits owner acceptance; the merge trigger is open question Q-55";

describe.skipIf(!FR_WS_09_ACCEPTED)(
  `FR-WS-09 worktree removal on merge or abandon (skipped: ${PENDING_FR_WS_09})`,
  () => {
    it("removes the worktree when the meta-session is abandoned, keeping branch and diff", () => {
      throw new Error(`placeholder: ${PENDING_FR_WS_09}`);
    });
    it("removes the worktree when the run's changes are merged, keeping branch and diff", () => {
      throw new Error(`placeholder: ${PENDING_FR_WS_09}`);
    });
    it("never removes the worktree of a run that is not terminal or of another meta-session", () => {
      throw new Error(`placeholder: ${PENDING_FR_WS_09}`);
    });
  },
);
