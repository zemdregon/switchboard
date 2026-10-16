/**
 * Loop breaker, stall flag and successor cap (T14.5; FR-CTL-07, FR-CAP-05, FR-MCP-10, LLD §3.4.5 to §3.4.7). Fake
 * provider CLI only (no provider, no network). One injected clock drives both the ledger and the lifecycle, and the
 * backoff jitter is 0, so retry successors are due at once and the stall check moves only when the test moves it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { resolveControlPlane } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle, type RunLifecycleOptions } from "../lifecycle/index.js";
import { buildEnvelope } from "../mcp/envelope.js";
import { WorkspaceManager } from "../workspace/index.js";
import { findStalledRuns, loopBreakerAttention } from "./loop-attention.js";
import {
  DEFAULT_LOOP_BREAKER,
  failureFingerprints,
  LOOP_PARKED_EVENT,
  type LoopBreakerSettings,
  recordLoopPark,
} from "./loop-breaker.js";
import { DEFAULT_MAX_SUCCESSORS_PER_META_SESSION, DEFAULT_STALL_MINUTES } from "./needs-attention.js";

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
const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/**
 * Fake provider CLI. The prompt picks the behaviour: `throttled` (a rate limit, retryable), `tool_fail` (a tool error,
 * not retryable), `quota` (quota exhausted, no reported reset), `hang` (a session event, then silence for 10 minutes of
 * real time; cancelled at shutdown), anything else succeeds.
 */
const CLI = `
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { prompt += c; });
  process.stdin.on("end", () => {
    const p = prompt.trim();
    emit({ type: "session", session_id: "s-1" });
    if (p === "throttled") {
      emit({ type: "error", category: "rate_limit", message: "slow down" });
      process.exitCode = 1;
      return;
    }
    if (p === "tool_fail") {
      emit({ type: "error", category: "tool", message: "tool broke" });
      process.exitCode = 2;
      return;
    }
    if (p === "quota") {
      emit({ type: "error", category: "quota", message: "limit reached" });
      process.exitCode = 1;
      return;
    }
    if (p === "hang") {
      setTimeout(() => emit({ type: "result", ok: true, summary: "late" }), 600_000);
      return;
    }
    emit({ type: "result", ok: true, summary: "ok" });
  });
}
`;

const T0 = Date.parse("2026-10-16T09:00:00.000Z");
let clockMs = T0;
const clock = () => new Date(clockMs);

let root: string;
let repo: string;
let dataDir: string;
let script: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(loopBreaker: LoopBreakerSettings, over: Partial<RunLifecycleOptions> = {}): RunLifecycle {
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ script, timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    breaker: { failureThreshold: 50, openSeconds: 300 },
    retry: { maxAttempts: 10, baseMs: 50, capMs: 200 },
    random: () => 0,
    now: clock,
    loopBreaker,
    ...over,
  });
}
const live = (): RunLifecycle => {
  if (!lifecycle) throw new Error("no lifecycle");
  return lifecycle;
};
const submit = (objective: string, extra: Record<string, unknown> = {}) =>
  live().submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...extra,
  });
const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const event = (runId: string, type: string) => events(runId).find((e) => e.type === type)?.p;
const sessionRuns = (sess: string) => ledger.listRunsForMetaSession(sess);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
};
const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"];
/** Wait until the meta-session has no non-terminal run and no pending successor, then return its runs oldest first. */
async function settled(sess: string): Promise<RunRecord[]> {
  await until(() => sessionRuns(sess).every((r) => TERMINAL.includes(r.state)));
  await sleep(50); // a successor is created in the terminal transaction; a short pause catches a late quota ladder
  await until(() => sessionRuns(sess).every((r) => TERMINAL.includes(r.state)));
  return sessionRuns(sess);
}
const attention = (run: RunRecord, settings: LoopBreakerSettings) =>
  buildEnvelope(
    ledger,
    ledger.getRunRecord(run.id) as RunRecord,
    (s) => s,
    loopBreakerAttention(ledger, clock(), settings),
  ).needs_attention;

beforeEach(() => {
  clockMs = T0;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-loop-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  script = path.join(root, "cli.mjs");
  writeFileSync(script, CLI);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator(), now: clock });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("loop breaker (T14.5, FR-CTL-07)", () => {
  it("N identical failures park the meta-session: no retry successor, no new run, parked_loop on the newest run", async () => {
    const settings = { identicalFailureThreshold: 3, stallMinutes: 30, maxSuccessorsPerMetaSession: 8 };
    lifecycle = makeLifecycle(settings);
    live().start();
    const r = await submit("throttled");
    const runs = await settled(r.metaSessionId);
    // FR-CAP-05 would retry up to max_attempts 10; the third identical RATE_LIMIT_TRANSIENT parks the chain instead.
    expect(runs.map((x) => [x.state, x.failure_code, x.attempt])).toEqual([
      ["FAILED", "RATE_LIMIT_TRANSIENT", 1],
      ["FAILED", "RATE_LIMIT_TRANSIENT", 2],
      ["FAILED", "RATE_LIMIT_TRANSIENT", 3],
    ]);
    const [first, second, third] = runs as [RunRecord, RunRecord, RunRecord];
    expect(event(first.id, LOOP_PARKED_EVENT)).toBeUndefined();
    expect(event(second.id, LOOP_PARKED_EVENT)).toBeUndefined();
    expect(event(third.id, LOOP_PARKED_EVENT)).toEqual({
      meta_session_id: r.metaSessionId,
      threshold: 3,
      fingerprint: "code:RATE_LIMIT_TRANSIENT",
      run_ids: [first.id, second.id, third.id],
    });
    expect(event(third.id, "retry_not_scheduled")).toEqual({
      reason: "meta_session_parked",
      fingerprint: "code:RATE_LIMIT_TRANSIENT",
      threshold: 3,
    });
    expect(event(third.id, "retry_scheduled")).toBeUndefined();

    // No successor is admitted by any path: a continuation into the parked meta-session is refused and writes nothing.
    await expect(submit("ok", { metaSessionId: r.metaSessionId })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringMatching(/parked by the loop breaker/),
    });
    expect(sessionRuns(r.metaSessionId)).toHaveLength(3);

    // T14.2 wiring: the newest run shows parked_loop through the default envelope facts and the configured ones; the
    // older runs are failed in a parked meta-session (failed_after_retry).
    const plain = buildEnvelope(ledger, third, (s) => s, { now: clock() }).needs_attention;
    expect(plain).toEqual({ active: true, reason: "parked_loop" });
    expect(attention(third, settings)).toEqual({ active: true, reason: "parked_loop" });
    expect(attention(first, settings)).toEqual({ active: true, reason: "failed_after_retry" });

    // Parking is per meta-session: a new task still runs.
    const fresh = await submit("ok");
    expect((await settled(fresh.metaSessionId)).map((x) => x.state)).toEqual(["SUCCEEDED"]);
  });

  it("non-retryable identical failures continued by hand park on the Nth; mixed codes below N do not", async () => {
    const settings = { identicalFailureThreshold: 2, stallMinutes: 30, maxSuccessorsPerMetaSession: 8 };
    lifecycle = makeLifecycle(settings);
    live().start();
    const r = await submit("throttled");
    await settled(r.metaSessionId);
    // RATE_LIMIT_TRANSIENT ×2 parked it already (N = 2); a different session shows mixed codes do not count together.
    expect(event(sessionRuns(r.metaSessionId)[1]?.id ?? "", LOOP_PARKED_EVENT)).toMatchObject({ threshold: 2 });

    const s = await submit("tool_fail");
    await settled(s.metaSessionId);
    await submit("ok", { metaSessionId: s.metaSessionId });
    await settled(s.metaSessionId);
    await submit("tool_fail", { metaSessionId: s.metaSessionId });
    const runs = await settled(s.metaSessionId);
    expect(runs.map((x) => [x.state, x.failure_code])).toEqual([
      ["FAILED", "TOOL_FAILURE"],
      ["SUCCEEDED", null],
      ["FAILED", "TOOL_FAILURE"],
    ]);
    expect(event((runs[2] as RunRecord).id, LOOP_PARKED_EVENT)).toMatchObject({ fingerprint: "code:TOOL_FAILURE" });
    await expect(submit("ok", { metaSessionId: s.metaSessionId })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("a silent RUNNING run is flagged stalled after T minutes on the injected clock, and is never cancelled", async () => {
    const settings = { identicalFailureThreshold: 3, stallMinutes: 5, maxSuccessorsPerMetaSession: 8 };
    lifecycle = makeLifecycle(settings);
    live().start();
    const r = await submit("hang");
    await until(() => ledger.getRunRecord(r.runId)?.state === "RUNNING");
    await sleep(500); // let the adapter's one session event land; it is silent afterwards
    const run = () => ledger.getRunRecord(r.runId) as RunRecord;
    const before = events(r.runId).length;

    expect(findStalledRuns(ledger, clock(), settings)).toEqual([]);
    expect(attention(run(), settings)).toEqual({ active: false });
    clockMs = T0 + 5 * 60_000 - 1; // one millisecond short of T
    expect(findStalledRuns(ledger, clock(), settings)).toEqual([]);
    clockMs = T0 + 5 * 60_000;
    expect(findStalledRuns(ledger, clock(), settings).map((x) => x.id)).toEqual([r.runId]);
    expect(attention(run(), settings)).toEqual({ active: true, reason: "stalled" });

    // Flag only: no state change, no event (no cancel request, no signal), and the adapter process is still running.
    await sleep(200);
    expect(run().state).toBe("RUNNING");
    expect(events(r.runId)).toHaveLength(before);
    expect(events(r.runId).some((e) => /cancel/i.test(e.type) || e.p.to === "CANCELLED")).toBe(false);

    // Any run_event resets the inactivity clock.
    ledger.appendRunEvent({ runId: r.runId, type: "steer_requested", payload: { length: 1 } });
    expect(findStalledRuns(ledger, clock(), settings)).toEqual([]);
    expect(attention(run(), settings)).toEqual({ active: false });
  });

  it("a QUEUED run with no events is never flagged stalled", () => {
    const sess = ledger.createMetaSession({ objective: "x", constraints: [] });
    const queued = ledger.createRun({
      metaSessionId: sess.id,
      state: "QUEUED",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: { objective: "x" },
      requestHash: "h",
      clientId: "c",
      provider: "fake",
      priority: 1,
    });
    clockMs = T0 + 24 * 3600_000;
    expect(findStalledRuns(ledger, clock(), DEFAULT_LOOP_BREAKER)).toEqual([]);
    expect(attention(ledger.getRunRecord(queued.id) as RunRecord, DEFAULT_LOOP_BREAKER)).toEqual({ active: false });
  });
});

describe("successor cap (T14.5, FR-CTL-07, FR-MCP-10)", () => {
  it("the cap refuses the next retry successor with a reason; the last failed run shows failed_after_retry", async () => {
    const settings = { identicalFailureThreshold: 10, stallMinutes: 30, maxSuccessorsPerMetaSession: 2 };
    lifecycle = makeLifecycle(settings);
    live().start();
    const r = await submit("throttled");
    const runs = await settled(r.metaSessionId);
    expect(runs.map((x) => [x.state, x.attempt])).toEqual([
      ["FAILED", 1],
      ["FAILED", 2],
    ]);
    const [first, last] = runs as [RunRecord, RunRecord];
    expect(event(first.id, "retry_scheduled")).toMatchObject({ successor_run_id: last.id, attempt: 2 });
    expect(event(last.id, "retry_not_scheduled")).toEqual({
      reason: "successor_cap",
      attempt: 2,
      max_successors_per_meta_session: 2,
    });
    expect(event(last.id, LOOP_PARKED_EVENT)).toBeUndefined();
    // FR-MCP-10: the chain ends on the last FAILED run, which names its predecessor and no successor.
    const env = buildEnvelope(ledger, last, (s) => s, loopBreakerAttention(ledger, clock(), settings));
    expect(env).toMatchObject({ retry_of: first.id, needs_attention: { active: true, reason: "failed_after_retry" } });
    expect(env).not.toHaveProperty("superseded_by");
  });

  it("a quota failover or wait successor is refused by the same cap", async () => {
    lifecycle = makeLifecycle({ identicalFailureThreshold: 10, stallMinutes: 30, maxSuccessorsPerMetaSession: 1 });
    live().start();
    const r = await submit("quota");
    await until(() => event(r.runId, "quota_ladder") !== undefined);
    const runs = await settled(r.metaSessionId);
    expect(runs.map((x) => [x.state, x.failure_code])).toEqual([["FAILED", "QUOTA_EXHAUSTED"]]);
    expect(event(r.runId, "quota_ladder")).toEqual({
      outcome: "returned",
      reason: "successor_cap",
      attempt: 1,
      max_successors_per_meta_session: 1,
      not_taken: [],
    });
  });
});

describe("loop breaker units (T14.5)", () => {
  it("resolves control_plane.loop_breaker with the LLD §3.4.6 Assumption defaults, shared with T14.2", () => {
    expect(resolveControlPlane(undefined).loopBreaker).toEqual({
      identicalFailureThreshold: 3,
      stallMinutes: 30,
      maxSuccessorsPerMetaSession: 8,
    });
    expect(DEFAULT_LOOP_BREAKER.stallMinutes).toBe(DEFAULT_STALL_MINUTES);
    expect(DEFAULT_LOOP_BREAKER.maxSuccessorsPerMetaSession).toBe(DEFAULT_MAX_SUCCESSORS_PER_META_SESSION);
    expect(
      resolveControlPlane({ loop_breaker: { identical_failure_threshold: 4, stall_minutes: 9 } }).loopBreaker,
    ).toEqual({ identicalFailureThreshold: 4, stallMinutes: 9, maxSuccessorsPerMetaSession: 8 });
  });

  it("the same failing verification command parks even when the failure codes differ", () => {
    const sess = ledger.createMetaSession({ objective: "x", constraints: [] });
    const request = {
      objective: "x",
      verification_commands: [
        ["npm", "test"],
        ["npm", "run", "lint"],
      ],
    };
    const failedRun = (code: string): RunRecord => {
      const run = ledger.createRun({
        metaSessionId: sess.id,
        state: "QUEUED",
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request,
        requestHash: "h",
        clientId: "c",
        provider: "fake",
        priority: 1,
      });
      ledger.appendRunEvent({ runId: run.id, type: "verification_command", payload: { index: 0, outcome: "passed" } });
      ledger.appendRunEvent({ runId: run.id, type: "verification_command", payload: { index: 1, outcome: "timeout" } });
      db.prepare("UPDATE run SET state = 'FAILED', failure_code = ? WHERE id = ?").run(code, run.id);
      return ledger.getRunRecord(run.id) as RunRecord;
    };
    const a = failedRun("TEST_FAILURE");
    const fps = failureFingerprints(a, ledger.listRunEvents(a.id));
    expect(fps[0]).toBe("code:TEST_FAILURE");
    expect(fps[1]).toMatch(/^verification:[0-9a-f]{16}$/);
    expect(recordLoopPark(ledger, a)).toBeUndefined();
    expect(recordLoopPark(ledger, failedRun("PROCESS_TIMEOUT"))).toBeUndefined();
    const c = failedRun("TOOL_FAILURE");
    expect(recordLoopPark(ledger, c)).toMatchObject({ fingerprint: fps[1], threshold: 3 });
    // Parking happens once per meta-session.
    expect(recordLoopPark(ledger, failedRun("TEST_FAILURE"))).toBeUndefined();
    expect(
      sessionRuns(sess.id)
        .flatMap((x) => events(x.id))
        .filter((e) => e.type === LOOP_PARKED_EVENT),
    ).toHaveLength(1);
  });
});
