import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { OPERATOR_CANCEL_APPLIED, requestCancel, requestDecision } from "../cli/operator.js";
import { groupAlive } from "../exec/index.js";
import { createIdGenerator } from "../ids/index.js";
import {
  createLedger,
  type Ledger,
  openLedger,
  type RunRecord,
  type RunState,
  type TrustProfile,
} from "../ledger/index.js";
import { procStartTicks, RunLifecycle, SLOT_STATES, TERMINAL_STATES } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { reconcile } from "./index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
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

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** Fake CLI that writes into its worktree, then hangs: a provider killed half-way through an edit. */
const WRITE_THEN_HANG_CLI = `
import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  emit({ type: "session", session_id: "partial-1" });
  writeFileSync("partial.txt", "half-written\\n");
  setInterval(() => {}, 1000);
}
`;

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let workspace: WorkspaceManager;
let artifacts: ArtifactStore;
const cleanup: (() => void)[] = [];

/** A fresh database handle and components, as a restarted controller would open them. */
function openController(): void {
  db = openLedger(dataDir);
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
}

const runReconcile = () => reconcile({ db, ledger, workspace, killGraceMs: 300 });

function lifecycleWith(adapter: FakeAdapter): RunLifecycle {
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
  });
}

const events = (runId: string) => ledger.listRunEvents(runId).map((e) => ({ ...e, p: JSON.parse(e.payload_json) }));
const eventCount = () => (db.prepare("SELECT COUNT(*) AS n FROM run_event").get() as { n: number }).n;
const sessionRow = (id: string) =>
  db.prepare("SELECT head_commit, lease_run_id FROM meta_session WHERE id = ?").get(id) as {
    head_commit: string | null;
    lease_run_id: string | null;
  };
const run = (id: string) => ledger.getRunRecord(id) as RunRecord;

/** NFR-REL-01: the ledger is consistent and every run is terminal or correctly queued. */
function expectConsistentLedger(): void {
  expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(db.pragma("foreign_key_check")).toEqual([]);
  const runs = db.prepare("SELECT * FROM run").all() as RunRecord[];
  for (const r of runs) {
    expect(TERMINAL_STATES.has(r.state) || ["AWAITING_APPROVAL", "QUEUED", "WAITING_CAPACITY"].includes(r.state)).toBe(
      true,
    );
    expect(r.state === "FAILED").toBe(r.failure_code !== null);
    const seqs = ledger.listRunEvents(r.id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  }
  for (const lease of ledger.listLeases()) {
    expect(SLOT_STATES).toContain(run(lease.lease_run_id).state);
  }
}

/** Start the controller in a child process; resolve once its provider is RUNNING (pid committed). */
async function startChildController(extra: Record<string, unknown> = {}) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--no-warnings",
      "--import",
      path.join(FIXTURES, "ts-register.mjs"),
      path.join(FIXTURES, "controller-child.ts"),
      JSON.stringify({ dataDir, root, repo, ...extra }),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  cleanup.push(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  type Running = { runId: string; metaSessionId: string; pgid: number; privilegedRunId?: string };
  const running = await new Promise<Running>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never reached RUNNING: ${stderr}`)), 20_000);
    lines.on("line", (line) => {
      const msg = JSON.parse(line) as { running?: Running };
      if (msg.running) {
        clearTimeout(timer);
        resolve(msg.running);
      }
    });
    child.on("exit", (code) => reject(new Error(`child exited early (${code}): ${stderr}`)));
  });
  cleanup.push(() => {
    try {
      process.kill(-running.pgid, "SIGKILL");
    } catch {
      // gone
    }
  });
  return { child, running };
}

async function sigkill(child: ChildProcess): Promise<void> {
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A synthetic run walked through the FRD edges to `state` (worktree prepared from LEASED on). */
async function inFlight(state: RunState, opts: { pid?: number; ticks?: number | null } = {}): Promise<RunRecord> {
  const sess = ledger.createMetaSession({ objective: "synthetic" });
  const created = ledger.createRun({
    metaSessionId: sess.id,
    trustProfile: "edit-untrusted",
    policySnapshot: profileFor("edit-untrusted"),
    request: {
      objective: "synthetic",
      workspace: repo,
      constraints: [],
      trust_profile: "edit-untrusted",
      provider: "fake",
      priority: "normal",
    },
    requestHash: "h",
    clientId: "client-a",
    provider: "fake",
  });
  const path_: [RunState, string][] = [
    ["PREFLIGHT", "T4"],
    ["LEASED", "T5"],
    ["RUNNING", "T9"],
    ["FINALIZING", "T13"],
  ];
  let cur = run(created.id);
  for (const [to, rule] of path_) {
    if (cur.state === state) break;
    if (to === "RUNNING") {
      await workspace.prepare({
        metaSessionId: sess.id,
        runId: cur.id,
        workspace: repo,
        trustProfile: "edit-untrusted",
      });
      cur = run(cur.id);
    }
    const set =
      to === "RUNNING" && opts.pid !== undefined
        ? { pid: opts.pid, pgid: opts.pid, proc_start_ticks: opts.ticks ?? null }
        : {};
    cur = ledger.casRunState({
      runId: cur.id,
      from: cur.state,
      to,
      expectedVersion: cur.version,
      set,
      payload: { rule, ...(to === "FINALIZING" ? { pending: "success" } : {}) },
    }) as RunRecord;
  }
  expect(cur.state).toBe(state);
  return cur;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-recon-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  openController();
});

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("fault injection: SIGKILL the controller during RUNNING (T1.9, NFR-REL-01)", () => {
  it("T9.5: the LEASED ref snapshot survives a SIGKILL restart; reconciliation flags and restores before the evidence checkpoint", async () => {
    const refSha = (ref: string) => {
      try {
        return g(repo, "rev-parse", "--verify", "--quiet", ref);
      } catch {
        return "";
      }
    };
    const plan = {
      steps: [
        { op: "write", path: "agent.txt", content: "agent\n" },
        { op: "commit", message: "agent commit" },
        { op: "update_ref", ref: "@publish", to: "HEAD" },
        { op: "tag", name: "agent-tag" },
      ],
      hang: true,
    };
    db.close();
    const { child, running } = await startChildController({
      scenario: "git_attempts",
      objective: JSON.stringify(plan),
    });
    await until(() => refSha("refs/tags/agent-tag") !== "", 20_000);
    await sigkill(child);

    openController();
    const snapshot = events(running.runId).find((e) => e.type === "git_ref_snapshot");
    expect(snapshot?.p).toMatchObject({ v: 1, phase: "leased" });
    const pub = `refs/heads/switchboard/pub/${running.metaSessionId}`;
    expect(refSha(pub)).not.toBe(""); // the agent's publish-ref write is in place before the restart

    await runReconcile();
    const after = run(running.runId);
    expect(after.state).toBe("FAILED");
    expect(after.failure_code).toBe("PROCESS_CRASH"); // BR-27: the violation does not change the outcome
    const ev = events(running.runId);
    const violations = ev
      .filter((e) => e.type === "git_policy_violation")
      .flatMap((e) => e.p.violations as { scope: string; ref: string }[]);
    expect(violations.map((v) => v.scope).sort()).toEqual(["other", "publish_ref", "run_branch"]);
    expect(violations.find((v) => v.scope === "other")?.ref).toBe("refs/tags/agent-tag");
    expect(refSha(pub)).toBe("");
    const pre = ledger.getRunCheckpointCommit(running.runId, "pre") as string;
    const post = ledger.getRunCheckpointCommit(running.runId, "post") as string;
    expect(g(repo, "rev-parse", `${post}^`)).toBe(pre);
    expect(g(repo, "show", `${post}:agent.txt`)).toBe("agent");
    const order = ev.map((e) => e.type);
    expect(order.indexOf("git_policy_violation")).toBeLessThan(order.indexOf("workspace_assessment"));
    expectConsistentLedger();

    const n = eventCount();
    expect((await runReconcile()).actions).toEqual([]);
    expect(eventCount()).toBe(n);
  }, 60_000);

  it("restart reconciles the run to FAILED/PROCESS_CRASH, kills the orphan, releases the lease and accepts new work", async () => {
    db.close(); // the child is the only controller while it lives
    const { child, running } = await startChildController({ scenario: "hang" });
    await sigkill(child);
    expect(groupAlive(running.pgid)).toBe(true); // the provider outlived its controller

    openController();
    const before = run(running.runId);
    expect(before.state).toBe("RUNNING");
    expect(sessionRow(running.metaSessionId).lease_run_id).toBe(running.runId);

    const report = await runReconcile();
    expect(report.terminated).toEqual([running.pgid]);
    expect(groupAlive(running.pgid)).toBe(false);

    const after = run(running.runId);
    expect(after.state).toBe("FAILED");
    expect(after.failure_code).toBe("PROCESS_CRASH");
    expect(after.failure_detail).toMatch(/controller_restart/);
    const ev = events(running.runId);
    const transitions = ev.filter((e) => e.type === "state_transition").map((e) => `${e.p.to}:${e.p.rule}`);
    expect(transitions.slice(-2)).toEqual(["FINALIZING:T13", "FAILED:T16"]);
    expect(ev.find((e) => e.p.to === "FINALIZING")?.p).toMatchObject({
      pending: "failure",
      failure_code: "PROCESS_CRASH",
      cause: "controller_restart",
      reconciled: true,
    });
    // Kill (intent, then outcome) happens before the workspace is assessed (FR-EXE-06).
    const order = ev.map((e) => (e.type === "reconciliation" ? `${e.p.step}:${e.p.phase}` : e.type));
    expect(order.indexOf("terminate_orphan:done")).toBeLessThan(order.indexOf("workspace_assessment"));
    expect(ev.find((e) => e.type === "workspace_assessment")?.p).toMatchObject({
      mutated: false,
      retry_eligible: true,
      auto_retry: false,
    });
    expect(sessionRow(running.metaSessionId)).toEqual({
      head_commit: g(repo, "rev-parse", "HEAD"),
      lease_run_id: null,
    });
    expectConsistentLedger();

    // Idempotent: a second pass is a no-op.
    const n = eventCount();
    const again = await runReconcile();
    expect(again.actions).toEqual([]);
    expect(eventCount()).toBe(n);

    // A new run on the same meta-session is accepted and runs (no LEASE_STALE, no active-run conflict).
    const lifecycle = lifecycleWith(new FakeAdapter({ scenario: "success" }));
    try {
      const next = await lifecycle.submit({
        clientId: "client-a",
        objective: "continue",
        metaSessionId: running.metaSessionId,
        trustProfile: "edit-untrusted",
        provider: "fake",
      });
      lifecycle.start();
      expect((await lifecycle.waitForTerminal(next.runId)).state).toBe("SUCCEEDED");
    } finally {
      await lifecycle.shutdown();
    }
  }, 60_000);

  it("partial mutation: evidence checkpoint kept on the run branch, head rolled back, not retry-eligible", async () => {
    const script = path.join(root, "write-then-hang.mjs");
    writeFileSync(script, WRITE_THEN_HANG_CLI);
    db.close();
    const { child, running } = await startChildController({ script });
    openController();
    const wt = run(running.runId).worktree_path as string;
    await until(() => existsSync(path.join(wt, "partial.txt")));
    db.close();
    await sigkill(child);

    openController();
    await runReconcile();
    expect(groupAlive(running.pgid)).toBe(false);
    const after = run(running.runId);
    expect(after).toMatchObject({ state: "FAILED", failure_code: "PROCESS_CRASH" });
    const ev = events(running.runId);
    expect(ev.find((e) => e.type === "workspace_assessment")?.p).toMatchObject({
      mutated: true,
      replay_eligible: false,
      retry_eligible: false,
    });
    const base = g(repo, "rev-parse", "HEAD");
    expect(ev.find((e) => e.type === "rollback")?.p.head).toBe(base);
    expect(sessionRow(running.metaSessionId)).toEqual({ head_commit: base, lease_run_id: null });
    expect(g(repo, "show", `switchboard/${running.metaSessionId}/${running.runId}:partial.txt`)).toBe("half-written");
    expect(existsSync(path.join(repo, "partial.txt"))).toBe(false); // operator tree untouched (FR-WS-05)
    expectConsistentLedger();
  }, 60_000);
});

describe("orphan identity (LLD §8)", () => {
  it("does not signal a reused PID whose start ticks differ", async () => {
    const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    cleanup.push(() => other.kill("SIGKILL"));
    const pid = other.pid as number;
    await until(() => procStartTicks(pid) !== null);
    const ticks = procStartTicks(pid) as number;
    const r = await inFlight("RUNNING", { pid, ticks: ticks + 1 });

    const report = await runReconcile();
    expect(report.terminated).toEqual([]);
    expect(() => process.kill(pid, 0)).not.toThrow(); // still alive
    expect(events(r.id).find((e) => e.type === "reconciliation")?.p).toMatchObject({
      step: "orphan_not_signalled",
      reason: "pid_reused",
    });
    expect(run(r.id)).toMatchObject({ state: "FAILED", failure_code: "PROCESS_CRASH" });
  });

  it("terminates a live group whose leader matches the recorded start ticks", async () => {
    const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    cleanup.push(() => orphan.kill("SIGKILL"));
    const pid = orphan.pid as number;
    await until(() => procStartTicks(pid) !== null);
    const r = await inFlight("RUNNING", { pid, ticks: procStartTicks(pid) });
    const report = await runReconcile();
    expect(report.terminated).toEqual([pid]);
    expect(groupAlive(pid)).toBe(false);
    expect(run(r.id).state).toBe("FAILED");
  });
});

describe("state-by-state outcomes (FRD WF-8)", () => {
  it("keeps queued runs untouched and writes nothing for them", async () => {
    const queued = await inFlight("QUEUED");
    const n = eventCount();
    const report = await runReconcile();
    expect(report).toMatchObject({ examined: 1, actions: [] });
    expect(run(queued.id).state).toBe("QUEUED");
    expect(eventCount()).toBe(n);
  });

  it("PREFLIGHT and LEASED without a worktree go back to QUEUED with the lease released, and then run normally", async () => {
    const pre = await inFlight("PREFLIGHT");
    const leased = await inFlight("LEASED");
    db.prepare("UPDATE meta_session SET lease_run_id = ?, lease_expires_at = ? WHERE id = ?").run(
      leased.id,
      "2000-01-01T00:00:00.000Z",
      leased.meta_session_id,
    );
    const report = await runReconcile();
    expect(report.actions.map((a) => `${a.from}>${a.to}`)).toEqual(["PREFLIGHT>QUEUED", "LEASED>QUEUED"]);
    expect(events(leased.id).at(-1)?.p).toMatchObject({ to: "QUEUED", rule: "T20", cause: "controller_restart" });
    expect(sessionRow(leased.meta_session_id).lease_run_id).toBeNull();
    expectConsistentLedger();

    const lifecycle = lifecycleWith(new FakeAdapter({ scenario: "success" }));
    try {
      lifecycle.start();
      expect((await lifecycle.waitForTerminal(pre.id)).state).toBe("SUCCEEDED");
      expect((await lifecycle.waitForTerminal(leased.id)).state).toBe("SUCCEEDED");
    } finally {
      await lifecycle.shutdown();
    }
  });

  it("resolves a stale lease (LEASE_STALE) held by a LEASED run whose worktree exists", async () => {
    const leased = await inFlight("LEASED");
    await workspace.prepare({
      metaSessionId: leased.meta_session_id,
      runId: leased.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
      leaseTtlMs: -1000, // already expired
    });
    const second = ledger.createRun({
      metaSessionId: leased.meta_session_id,
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h2",
      clientId: "client-a",
    });
    const prep = {
      metaSessionId: leased.meta_session_id,
      runId: second.id,
      workspace: repo,
      trustProfile: "edit-untrusted" as const,
    };
    await expect(workspace.prepare(prep)).rejects.toMatchObject({ code: "LEASE_STALE" });

    await runReconcile();
    expect(run(leased.id)).toMatchObject({ state: "FAILED", failure_code: "PROCESS_CRASH" });
    expect(events(leased.id).find((e) => e.p.to === "FAILED")?.p.rule).toBe("T10");
    await expect(workspace.prepare(prep)).resolves.toMatchObject({ mode: "worktree" });
  });

  it("FINALIZING applies the recorded pending outcome: success checkpoints the work and advances the head", async () => {
    const r = await inFlight("FINALIZING");
    writeFileSync(path.join(r.worktree_path as string, "done.txt"), "work\n");
    await runReconcile();
    const after = run(r.id);
    expect(after.state).toBe("SUCCEEDED");
    const head = sessionRow(r.meta_session_id).head_commit as string;
    expect(g(repo, "show", `${head}:done.txt`)).toBe("work");
    expect(events(r.id).at(-1)?.p).toMatchObject({ to: "SUCCEEDED", rule: "T15" });
    expectConsistentLedger();
  });

  it("a missing worktree ends the run FAILED/TOOL_FAILURE", async () => {
    const r = await inFlight("RUNNING");
    rmSync(r.worktree_path as string, { recursive: true, force: true });
    await runReconcile();
    expect(run(r.id)).toMatchObject({ state: "FAILED", failure_code: "TOOL_FAILURE" });
    expect(sessionRow(r.meta_session_id).lease_run_id).toBeNull();
    expectConsistentLedger();
  });

  it("never touches terminal runs", async () => {
    const r = await inFlight("RUNNING");
    await runReconcile();
    const done = run(r.id);
    const n = eventCount();
    await runReconcile();
    expect(run(r.id)).toEqual(done);
    expect(eventCount()).toBe(n);
  });
});

describe("operator cancel requests recorded while the controller was down (T1.10 convention)", () => {
  it("applies them: queued → CANCELLED, running → CANCELLED via FINALIZING, each marked applied once", async () => {
    const queued = await inFlight("QUEUED");
    const running = await inFlight("RUNNING");
    writeFileSync(path.join(running.worktree_path as string, "partial.txt"), "x\n");
    for (const id of [queued.id, running.id]) {
      expect(requestCancel(db, ledger, id, { requestedBy: "op", direct: false }).outcome).toBe("requested");
    }

    const report = await runReconcile();
    expect(report.cancelsApplied).toHaveLength(2);
    expect(run(queued.id).state).toBe("CANCELLED");
    expect(run(running.id).state).toBe("CANCELLED");
    const rules = events(running.id)
      .filter((e) => e.type === "state_transition")
      .map((e) => `${e.p.to}:${e.p.rule}`);
    expect(rules.slice(-2)).toEqual(["FINALIZING:T13", "CANCELLED:T17"]);
    for (const id of [queued.id, running.id]) {
      const applied = events(id).filter((e) => e.type === OPERATOR_CANCEL_APPLIED);
      expect(applied).toHaveLength(1);
      expect(applied[0]?.p).toMatchObject({ state_after: "CANCELLED", applied_by: "reconciliation" });
    }
    // Evidence of the cancelled run is kept; head stays at the pre-run checkpoint (FRD §4.4).
    expect(sessionRow(running.meta_session_id).head_commit).toBe(g(repo, "rev-parse", "HEAD"));
    expectConsistentLedger();
    const n = eventCount();
    await runReconcile();
    expect(eventCount()).toBe(n);
  });

  it("a run awaiting approval is cancelled and its PENDING approval closed DENIED by the requester (T3.3, Q-15)", async () => {
    const sess = ledger.createMetaSession({ objective: "synthetic" });
    const waiting = ledger.createRun({
      metaSessionId: sess.id,
      state: "AWAITING_APPROVAL",
      trustProfile: "privileged",
      policySnapshot: {},
      request: {},
      requestHash: "priv",
      clientId: "c",
      provider: "fake",
    });
    const approval = ledger.createApproval({ runId: waiting.id, scopeJson: "{}", scopeHash: "h" });
    expect(requestCancel(db, ledger, waiting.id, { requestedBy: "op", direct: false }).outcome).toBe("requested");
    const report = await runReconcile();
    expect(report.cancelsApplied).toHaveLength(1);
    expect(run(waiting.id).state).toBe("CANCELLED");
    expect(ledger.getApproval(approval.id)).toMatchObject({ status: "DENIED", decided_by: "op" });
  });
});

describe("privileged approvals across restarts (T3.4, FRD WF-7, WF-8; owner decision 17)", () => {
  const SCOPE = {
    files: { access: "worktree" },
    shell: { mode: "none" },
    network: { mode: "off" },
    repository_config: { mode: "disabled" },
    bypass: true,
  };
  const DAY_MS = 24 * 60 * 60 * 1000;
  const submitPrivileged = (lc: RunLifecycle) =>
    lc.submit({
      clientId: "client-a",
      objective: "privileged work",
      workspace: repo,
      trustProfile: "privileged",
      provider: "fake",
      privileged: { scope: SCOPE },
    });

  it("a run AWAITING_APPROVAL survives a SIGKILL restart unchanged, 24 h later: no expiry, no automatic approval", async () => {
    db.close(); // the child is the only controller while it lives
    const { child, running } = await startChildController({ scenario: "hang", privilegedScope: SCOPE });
    const waitingId = running.privilegedRunId as string;
    expect(waitingId).toMatch(/^run_/);
    await sigkill(child);

    openController();
    const before = run(waitingId);
    expect(before.state).toBe("AWAITING_APPROVAL");
    const approval = ledger.getApprovalForRun(waitingId);
    expect(approval?.status).toBe("PENDING");
    const evBefore = ledger.listRunEvents(waitingId).length;

    const later = () => new Date(Date.now() + DAY_MS);
    const report = await reconcile({ db, ledger, workspace, killGraceMs: 300, now: later });
    expect(report.actions.map((a) => a.runId)).toEqual([running.runId]); // only the crashed run changed
    expect(report.decisionsApplied).toEqual([]);
    expect(groupAlive(running.pgid)).toBe(false);
    expect(run(waitingId)).toEqual(before);
    expect(ledger.listRunEvents(waitingId)).toHaveLength(evBefore);
    expect(ledger.getApproval(approval?.id as string)).toEqual(approval);

    // A restarted controller dispatching with its clock a day later still leaves it waiting.
    const lc = new RunLifecycle({
      ledger,
      workspace,
      artifacts,
      adapters: new AdapterRegistry().register(new FakeAdapter()),
      allowedRoots: [root],
      globalConcurrency: 2,
      resolveProfile: profileFor,
      now: later,
    });
    lc.start();
    await new Promise((r) => setTimeout(r, 200));
    await lc.drain();
    expect(run(waitingId)).toEqual(before);
    expect(ledger.getApproval(approval?.id as string)?.status).toBe("PENDING");
    expectConsistentLedger();
  }, 60_000);

  it("an approve recorded while the daemon was down is applied at startup (T3), once, and dispatch lets the adapter's compile decide", async () => {
    const r = await submitPrivileged(lifecycleWith(new FakeAdapter()));
    const rec = requestDecision(db, ledger, r.runId, { decision: "APPROVED", requestedBy: "op", direct: false });
    expect(rec).toMatchObject({ outcome: "requested", state: "AWAITING_APPROVAL" });
    expect(ledger.getApprovalForRun(r.runId)?.status).toBe("PENDING");

    const report = await runReconcile();
    expect(report.decisionsApplied).toEqual([rec.requestEventId]);
    expect(run(r.runId).state).toBe("QUEUED");
    expect(ledger.getApprovalForRun(r.runId)).toMatchObject({
      status: "APPROVED",
      decided_by: "op",
      decided_at: rec.decidedAt,
    });
    const applied = events(r.runId).filter((e) => e.type === "operator_decision_applied");
    expect(applied.map((e) => e.p)).toEqual([
      { request_event_id: rec.requestEventId, state_after: "QUEUED", applied_by: "reconciliation" },
    ]);
    expect(events(r.runId).find((e) => e.p.to === "QUEUED")?.p).toMatchObject({ rule: "T3" });
    expectConsistentLedger();
    const n = eventCount();
    await runReconcile();
    expect(eventCount()).toBe(n);

    // Approved, it is dispatched; the fake adapter cannot compile privileged, so its compile refuses the run with the
    // BR-3 code before any process starts (owner decision 19 removed the blanket dispatch refusal, T3.18).
    const lc = lifecycleWith(new FakeAdapter());
    lc.start();
    const done = await lc.waitForTerminal(r.runId);
    expect(done).toMatchObject({ state: "FAILED", failure_code: "ELIGIBILITY_NONE", pid: null });
    expect(done.failure_detail).toContain("PROFILE_UNSUPPORTED");
  });

  it("a deny recorded while down, followed by a cancel, ends CANCELLED with both records applied", async () => {
    const r = await submitPrivileged(lifecycleWith(new FakeAdapter()));
    const d = requestDecision(db, ledger, r.runId, { decision: "DENIED", requestedBy: "op", direct: false });
    const c = requestCancel(db, ledger, r.runId, { requestedBy: "op2", direct: false });
    expect(c.outcome).toBe("requested");
    const report = await runReconcile();
    expect(report.decisionsApplied).toEqual([d.requestEventId]);
    expect(report.cancelsApplied).toEqual([c.requestEventId]);
    expect(run(r.runId).state).toBe("CANCELLED");
    // The operator's deny decided the row; the later cancel found nothing PENDING to close.
    expect(ledger.getApprovalForRun(r.runId)).toMatchObject({ status: "DENIED", decided_by: "op" });
    expectConsistentLedger();
  });
});
