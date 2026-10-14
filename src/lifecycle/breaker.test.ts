/**
 * Per-provider circuit breaker (T6.4; FR-CAP-04, FRD WF-5 and T4 guard, BR-3, LLD §16.4, ADR-0043 item 3). The pure
 * state machine, then fault injection through the lifecycle with the fake adapter (no provider CLI, no network).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ProviderAdapter, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import {
  applyBreakerOutcome,
  type BreakerSnapshot,
  breakerAdmission,
  breakerOutcome,
  CLOSED_BREAKER,
  capacityProjection,
} from "../capacity/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle } from "./index.js";

const SETTINGS = { failureThreshold: 2, openSeconds: 300 };
const T0 = new Date("2026-10-14T12:00:00.000Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);

describe("breaker state machine (LLD §16.4)", () => {
  const run = (state: string, code: string | null, started = true, detail: string | null = null) => ({
    state,
    failure_code: code,
    failure_detail: detail,
    started_at: started ? "t" : null,
  });

  it("classifies outcomes: counted, healthy and neutral", () => {
    expect(breakerOutcome(run("SUCCEEDED", null))).toBe("healthy");
    for (const c of ["RATE_LIMIT_TRANSIENT", "PROVIDER_OVERLOADED", "PROCESS_CRASH"]) {
      expect(breakerOutcome(run("FAILED", c))).toBe("counted");
    }
    // A spawn failure (never started) still counts; a crash after a controller restart never does.
    expect(breakerOutcome(run("FAILED", "PROCESS_CRASH", false))).toBe("counted");
    expect(breakerOutcome(run("FAILED", "PROCESS_CRASH", true, "orphaned (cause controller_restart)"))).toBe("neutral");
    for (const c of ["TEST_FAILURE", "TOOL_FAILURE", "PERMISSION_BLOCKED", "SANDBOX_VIOLATION"]) {
      expect(breakerOutcome(run("FAILED", c))).toBe("healthy");
      expect(breakerOutcome(run("FAILED", c, false))).toBe("neutral");
    }
    for (const c of ["QUOTA_EXHAUSTED", "PROCESS_TIMEOUT", "AUTH_REQUIRED", "ELIGIBILITY_NONE"]) {
      expect(breakerOutcome(run("FAILED", c))).toBe("neutral");
    }
    expect(breakerOutcome(run("CANCELLED", null))).toBe("neutral");
  });

  it("opens at the threshold, re-opens on a failed probe, closes on a healthy probe", () => {
    const one = applyBreakerOutcome(CLOSED_BREAKER, "counted", "RATE_LIMIT_TRANSIENT", SETTINGS, T0);
    expect(one).toEqual({
      next: { ...CLOSED_BREAKER, consecutiveFailures: 1, lastFailureCode: "RATE_LIMIT_TRANSIENT" },
    });
    const two = applyBreakerOutcome(one.next, "counted", "PROVIDER_OVERLOADED", SETTINGS, T0);
    expect(two).toEqual({
      next: {
        state: "OPEN",
        until: later(300).toISOString(),
        consecutiveFailures: 2,
        lastFailureCode: "PROVIDER_OVERLOADED",
      },
      transition: "breaker_opened",
    });
    // A healthy run in between resets the count.
    const reset = applyBreakerOutcome(one.next, "healthy", null, SETTINGS, T0);
    expect(reset.next.consecutiveFailures).toBe(0);
    expect(reset.transition).toBeUndefined();

    const half: BreakerSnapshot = { ...two.next, state: "HALF_OPEN" };
    const reopened = applyBreakerOutcome(half, "counted", "PROCESS_CRASH", SETTINGS, later(400));
    expect(reopened.transition).toBe("breaker_opened");
    expect(reopened.next).toMatchObject({ state: "OPEN", until: later(700).toISOString() });
    const closed = applyBreakerOutcome(half, "healthy", null, SETTINGS, later(400));
    expect(closed).toEqual({
      next: { ...CLOSED_BREAKER, lastFailureCode: "PROVIDER_OVERLOADED" },
      transition: "breaker_closed",
    });
    // A straggler while OPEN changes the count only; neutral outcomes change nothing (same object).
    const straggler = applyBreakerOutcome(two.next, "healthy", null, SETTINGS, T0);
    expect(straggler.next).toMatchObject({ state: "OPEN", consecutiveFailures: 0 });
    expect(applyBreakerOutcome(two.next, "neutral", null, SETTINGS, T0).next).toBe(two.next);
  });

  it("admission: closed allows, open denies until the cool-down ends, then one probe", () => {
    const open: BreakerSnapshot = { ...CLOSED_BREAKER, state: "OPEN", until: later(300).toISOString() };
    expect(breakerAdmission(CLOSED_BREAKER, T0)).toBe("allow");
    expect(breakerAdmission(open, later(299))).toBe("deny");
    expect(breakerAdmission(open, later(300))).toBe("probe");
    expect(breakerAdmission({ ...open, state: "HALF_OPEN" }, T0)).toBe("probe");
  });
});

// ---- through the lifecycle -------------------------------------------------------------------------------------

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

/** The objective names the fake scenario of each run, so one `fake` adapter plays several outcomes. */
function scenarioAdapter(): ProviderAdapter {
  const base = new FakeAdapter({ timeouts: PATIENT });
  return {
    id: base.id,
    transports: base.transports,
    gitWriteControl: base.gitWriteControl,
    resumeCwd: base.resumeCwd,
    gitCapabilities: { commitChannel: "none", detail: "test double" },
    probe: (r) => base.probe(r),
    authPreflight: (r) => base.authPreflight(r),
    compile: (req, p) =>
      new FakeAdapter({ scenario: req.objective as FakeScenario, timeouts: PATIENT }).compile(req, p),
    resumeArgs: (b, req, p) => base.resumeArgs(b, req, p),
    parseEvent: (i, s) => base.parseEvent(i, s),
    extractResult: (e, x) => base.extractResult(e, x),
    classifyFailure: (e) => base.classifyFailure(e),
  };
}

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(openSeconds: number): RunLifecycle {
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(scenarioAdapter()),
    allowedRoots: [root],
    globalConcurrency: 4,
    perProviderConcurrency: 4,
    resolveProfile: profileFor,
    breaker: { failureThreshold: 2, openSeconds },
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
  });
}

const live = (): RunLifecycle => {
  if (!lifecycle) throw new Error("no lifecycle");
  return lifecycle;
};
const submit = (scenario: FakeScenario) =>
  live().submit({
    clientId: "c",
    objective: scenario,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
  });
const health = () => ledger.getProviderHealth("fake");
const eventTypes = (runId: string) => ledger.listRunEvents(runId).map((e) => e.type);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runToEnd(scenario: FakeScenario) {
  const r = await submit(scenario);
  return { id: r.runId, run: await live().waitForTerminal(r.runId) };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-breaker-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("breaker through the lifecycle (T6.4)", () => {
  it("counted failures open it; a non-counted outcome in between resets the count", async () => {
    lifecycle = makeLifecycle(300);
    live().start();
    expect((await runToEnd("rate_limit")).run.failure_code).toBe("RATE_LIMIT_TRANSIENT");
    expect(health()).toMatchObject({ breaker_state: "CLOSED", consecutive_failures: 1 });
    // task_failure is a failure after the provider ran, not a throttle: healthy for the breaker.
    expect((await runToEnd("task_failure")).run.state).toBe("FAILED");
    expect(health()).toMatchObject({ breaker_state: "CLOSED", consecutive_failures: 0 });
    await runToEnd("rate_limit");
    const second = await runToEnd("rate_limit");
    expect(health()).toMatchObject({
      breaker_state: "OPEN",
      consecutive_failures: 2,
      last_failure_code: "RATE_LIMIT_TRANSIENT",
    });
    expect(eventTypes(second.id)).toContain("breaker_opened");
    const opened = ledger.listRunEvents(second.id).find((e) => e.type === "breaker_opened");
    expect(JSON.parse(opened?.payload_json ?? "{}")).toMatchObject({ provider: "fake", consecutive_failures: 2 });
    // The capacity projection (get_capacity, doctor) shows it.
    const p = capacityProjection(
      ledger,
      [{ id: "fake", enabled: true, weight: null, concurrencyLimit: 4 }],
      { windowSeconds: 3600, confidenceRuns: 10 },
      new Date(),
    );
    expect(p.providers[0]).toMatchObject({
      throttle_risk: "high",
      breaker: { state: "OPEN", consecutive_failures: 2 },
    });
  });

  it("while open: admission excludes the provider (CIRCUIT_OPEN, BR-3 ELIGIBILITY_NONE) and queued runs wait", async () => {
    lifecycle = makeLifecycle(300);
    live().start();
    await runToEnd("rate_limit");
    await runToEnd("rate_limit");
    const answer = await live().checkEligibility({
      candidates: ["fake"],
      requiredProvider: "fake",
      trustProfile: "edit-untrusted",
      clientMaxProfile: "edit-untrusted",
      cwd: repo,
    });
    expect(answer.decision.outcome).toMatchObject({
      kind: "required_provider_ineligible",
      failureCode: "ELIGIBILITY_NONE",
    });
    expect(answer.decision.excluded[0]?.primary.code).toBe("CIRCUIT_OPEN");
    // Without require_provider and no other provider: still no eligible provider.
    const any = await live().checkEligibility({
      candidates: ["fake"],
      trustProfile: "edit-untrusted",
      clientMaxProfile: "edit-untrusted",
      cwd: repo,
    });
    expect(any.decision.eligible).toEqual([]);
    const waiting = await submit("success");
    await sleep(300);
    expect(ledger.getRunRecord(waiting.runId)?.state).toBe("QUEUED");
  });

  it("after the cool-down exactly one probe runs; success closes the breaker and the rest follow", async () => {
    lifecycle = makeLifecycle(1);
    live().start();
    await runToEnd("rate_limit");
    await runToEnd("rate_limit");
    const a = await submit("success");
    const b = await submit("success");
    await sleep(200);
    expect(ledger.getRunRecord(a.runId)?.state).toBe("QUEUED");
    expect(ledger.getRunRecord(b.runId)?.state).toBe("QUEUED");
    const doneA = await live().waitForTerminal(a.runId); // woken by the timer at the cool-down end
    expect(doneA.state).toBe("SUCCEEDED");
    expect(eventTypes(a.runId)).toContain("breaker_half_open");
    expect(eventTypes(a.runId)).toContain("breaker_closed");
    expect(eventTypes(b.runId)).not.toContain("breaker_half_open");
    // b was held while a was the probe: it started only after a finished.
    const doneB = await live().waitForTerminal(b.runId);
    expect(doneB.state).toBe("SUCCEEDED");
    expect((doneB.started_at ?? "") >= (doneA.finished_at ?? "")).toBe(true);
    expect(health()).toMatchObject({ breaker_state: "CLOSED", consecutive_failures: 0 });
  });

  it("a failed probe re-opens it; the next queued run waits for the new cool-down", async () => {
    lifecycle = makeLifecycle(1);
    live().start();
    await runToEnd("rate_limit");
    await runToEnd("rate_limit");
    const probe = await submit("rate_limit");
    const next = await submit("success");
    const done = await live().waitForTerminal(probe.runId);
    expect(done.failure_code).toBe("RATE_LIMIT_TRANSIENT");
    expect(eventTypes(probe.runId)).toEqual(expect.arrayContaining(["breaker_half_open", "breaker_opened"]));
    expect(health()?.breaker_state).toBe("OPEN");
    expect(ledger.getRunRecord(next.runId)?.state).toBe("QUEUED");
    expect((await live().waitForTerminal(next.runId)).state).toBe("SUCCEEDED");
    expect(health()?.breaker_state).toBe("CLOSED");
  });

  it("survives a controller restart: a new lifecycle on the same ledger keeps holding the provider", async () => {
    lifecycle = makeLifecycle(300);
    live().start();
    await runToEnd("rate_limit");
    await runToEnd("rate_limit");
    const before = health();
    await live().shutdown();
    lifecycle = makeLifecycle(300);
    live().start();
    expect(health()).toEqual(before);
    const r = await submit("success");
    await sleep(300);
    expect(ledger.getRunRecord(r.runId)?.state).toBe("QUEUED");
  });
});
