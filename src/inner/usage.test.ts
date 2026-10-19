/**
 * T11.5 (FR-INN-15, ADR-0007, LLD §13.4 step 13): inner-agent usage is recorded in `inner_call` only. Nothing reaches
 * `usage_observation`, provider health or what the envelope reports as usage, unless the operator declared
 * `shares_subscription_with`, in which case each call that reached the backend adds exactly one `inner_agent` row.
 * Scripted fake backend only; no network, no provider CLI. The `get_capacity` and `switchboard capacity` surfaces are
 * covered in `usage-surfaces.test.ts`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { buildEnvelope } from "../mcp/envelope.js";
import {
  createClassifyRouteFeaturesHook,
  createCommitMessageTask,
  createFakeBackend,
  createHttpBackend,
  createInnerAgent,
  type FakeStep,
  type InnerBackend,
  type InnerLogEntry,
  type InnerTaskContract,
  tokenCount,
} from "./index.js";

const contract: InnerTaskContract<{ title: string }, { title: string }> = {
  task: "run_title",
  template_version: "run_title.v1",
  system: "Write a title.",
  response_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  },
  sends_source_content: false,
  fallback: () => ({ title: "fallback" }),
  accept: (v) => v as { title: string },
};

const GOOD: FakeStep = { kind: "text", text: '{"title":"Fix login"}', usage: { in: 10, out: 4 } };
const dirs: string[] = [];
const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface SetupOptions {
  shares?: string;
  allowRemote?: boolean;
  locality?: "local" | "remote";
  timeoutMs?: number;
  maxConcurrency?: number;
  /** Extra task rows beside the always-enabled `run_title`. */
  tasks?: Record<string, { enabled: boolean; timeout_ms?: number; allow_source_content?: boolean }>;
  breaker?: { failure_threshold: number; open_ms: number };
  suspension?: { window_calls: number; min_calls: number; rejection_threshold: number };
  /** Wraps the scripted fake (e.g. to slow `resolveLocality`); receives the fake built from `script`. */
  wrapBackend?: (fake: InnerBackend) => InnerBackend;
  logger?: (e: InnerLogEntry) => void;
  /** The ledger's clock (every `created_at`, `observed_at` and event `ts`); the default is the wall clock. */
  now?: () => Date;
  /** The breaker's clock in ms (the pipeline's `now`); the default is the wall clock. */
  breakerNow?: () => number;
}

function setup(script: readonly FakeStep[], opts: SetupOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-usage-"));
  dirs.push(dir);
  const db = openLedger(dir);
  dbs.push(db);
  const ledger = createLedger(db, { ids: createIdGenerator(), ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const session = ledger.createMetaSession({ objective: "o" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
    provider: "claude-code",
  });
  const settings = resolveInnerAgent({
    enabled: true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:1",
      model: "cfg-model",
      ...(opts.shares !== undefined ? { shares_subscription_with: opts.shares } : {}),
      ...(opts.allowRemote !== undefined ? { allow_remote: opts.allowRemote } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout_ms: opts.timeoutMs } : {}),
      ...(opts.maxConcurrency !== undefined ? { max_concurrency: opts.maxConcurrency } : {}),
    },
    tasks: { run_title: { enabled: true }, ...opts.tasks },
    ...(opts.breaker !== undefined ? { breaker: opts.breaker } : {}),
    ...(opts.suspension !== undefined ? { suspension: opts.suspension } : {}),
  });
  const fake = createFakeBackend({ script, ...(opts.locality !== undefined ? { locality: opts.locality } : {}) });
  const backend = opts.wrapBackend !== undefined ? opts.wrapBackend(fake) : fake;
  const svc = createInnerAgent(settings, {
    backend,
    ledger,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.breakerNow !== undefined ? { now: opts.breakerNow } : {}),
  });
  const call = () => svc.call(contract, { user: "objective: tidy", run_id: run.id });
  const usageRows = () =>
    db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Record<string, unknown>[];
  const runEventCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM run_event WHERE run_id = ?").get(run.id) as { n: number }).n;
  /** Every usage-related table and read model, serialised, for a byte comparison. */
  const snapshot = () =>
    JSON.stringify({
      usage: usageRows(),
      health: db.prepare("SELECT * FROM provider_health ORDER BY provider").all(),
      forRun: ledger.listUsageObservationsForRun(run.id),
    });
  return { db, ledger, run, settings, backend, fake, svc, call, snapshot, usageRows, runEventCount };
}

/**
 * A trigger that refuses every `inner_agent` observation. The ledger writes the `inner_call` row, the observation and the
 * run event inside one `BEGIN IMMEDIATE` transaction (`recordInnerCall`); a refused observation must therefore take the
 * call row and the event down with it, and a call that writes no observation must be untouched by the trigger.
 */
const REFUSE_OBSERVATION = "observation-refused-7f2e";
function refuseInnerObservations(db: { exec(sql: string): unknown }, on: boolean): void {
  db.exec(
    on
      ? `CREATE TRIGGER refuse_inner_observation BEFORE INSERT ON usage_observation WHEN NEW.source = 'inner_agent'
           BEGIN SELECT RAISE(ABORT, '${REFUSE_OBSERVATION}'); END;`
      : "DROP TRIGGER refuse_inner_observation;",
  );
}

/** A backend whose locality resolution never answers until the deadline aborts it; `complete` is the fake's. */
const slowLocality = (fake: InnerBackend): InnerBackend => ({
  ...fake,
  resolveLocality: (signal) =>
    new Promise((_, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
});

describe("inner-agent usage accounting (T11.5; FR-INN-15)", () => {
  it("without shares_subscription_with, calls are recorded in inner_call only: usage and health are byte-identical", async () => {
    const h = setup([GOOD, GOOD, { kind: "text", text: "not json" }, { kind: "text", text: "still not" }]);
    const before = h.snapshot();
    await h.call();
    await h.call();
    await h.call(); // rejected after its re-ask: still a call that reached the backend
    expect(h.ledger.listInnerCalls()).toHaveLength(3);
    expect(h.snapshot()).toBe(before);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get()).toEqual({ n: 0 });
  });

  it("with shares_subscription_with, each call that reached the backend adds one labelled observation", async () => {
    const h = setup([GOOD, { kind: "text", text: "bad" }, { kind: "text", text: "bad again" }], {
      shares: "claude-code",
    });
    const r1 = await h.call();
    const r2 = await h.call(); // one call, two attempts (re-ask): still one observation
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(false);
    const rows = h.usageRows();
    expect(rows).toHaveLength(2);
    expect(rows).toHaveLength(h.ledger.listInnerCalls().length);
    expect(rows[0]).toMatchObject({
      run_id: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      backing_provider: null,
      model: "fake-model",
      source: "inner_agent",
      metrics_json: JSON.stringify({ input_tokens: 10, output_tokens: 4 }),
    });
    expect(JSON.parse(String(rows[1]?.metrics_json))).toEqual({}); // tokens unknown: empty, never estimated
    // the run's provider-reported view is unchanged and provider health is untouched
    expect(h.ledger.listUsageObservationsForRun(h.run.id).map((x) => x.source)).toEqual(["inner_agent", "inner_agent"]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });

  it("writes no observation for a call the privacy gate refused (no request was made)", async () => {
    const h = setup([GOOD], { shares: "claude-code", allowRemote: false, locality: "remote" });
    const r = await h.call();
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_disabled", reason: "REMOTE_NOT_ALLOWED" });
    expect(h.ledger.listInnerCalls()).toHaveLength(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get()).toEqual({ n: 0 });
  });

  it("writes no observation for a call the open breaker denied, and one for the failed calls that opened it", async () => {
    const h = setup([{ kind: "error" }], { shares: "claude-code", breaker: { failure_threshold: 2, open_ms: 60_000 } });
    expect(await h.call()).toMatchObject({ reason: "BACKEND_ERROR" });
    expect(await h.call()).toMatchObject({ reason: "BACKEND_ERROR" });
    expect(await h.call()).toMatchObject({ outcome: "fallback_unavailable", reason: "CIRCUIT_OPEN" });
    const calls = h.ledger.listInnerCalls();
    expect(calls.map((c) => [c.reason, c.attempts])).toEqual([
      ["BACKEND_ERROR", 1],
      ["BACKEND_ERROR", 1],
      ["CIRCUIT_OPEN", 0],
    ]);
    // A request that failed may still have consumed the subscription: one row each, with unknown (empty) metrics.
    const rows = h.usageRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => JSON.parse(String(r.metrics_json)))).toEqual([{}, {}]);
    expect(rows.every((r) => r.source === "inner_agent")).toBe(true);
  });

  it("a call that timed out after reaching the backend yields one observation with unknown metrics", async () => {
    const h = setup([{ kind: "hang" }], { shares: "claude-code", timeoutMs: 50 });
    expect(await h.call()).toMatchObject({ outcome: "fallback_unavailable", reason: "TIMEOUT" });
    expect(h.ledger.listInnerCalls().map((c) => c.attempts)).toEqual([1]);
    expect(h.usageRows().map((r) => JSON.parse(String(r.metrics_json)))).toEqual([{}]);
  });

  it("a re-ask that timed out keeps the counts the first attempt reported: one call, one observation, attempts 2", async () => {
    // "tokens as reported or unknown" (FR-INN-15): the first attempt consumed the subscription and reported its counts;
    // the deadline hit during the re-ask does not make them unknown, and the timed-out call is still exactly one row.
    const h = setup([{ kind: "text", text: "bad", usage: { in: 7, out: 2 } }, { kind: "hang" }], {
      shares: "claude-code",
      timeoutMs: 1000, // generous: the first attempt must land before the deadline even on a loaded CI runner
    });
    expect(await h.call()).toMatchObject({ outcome: "fallback_unavailable", reason: "TIMEOUT" });
    expect(h.ledger.listInnerCalls().map((c) => [c.attempts, c.tokens_in, c.tokens_out])).toEqual([[2, 7, 2]]);
    expect(h.usageRows().map((r) => [r.source, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", { input_tokens: 7, output_tokens: 2 }],
    ]);
  });

  it("a suspended task (T11.6) denies without a request: no observation; the rejected calls that suspended it wrote one each", async () => {
    const h = setup([{ kind: "text", text: "bad" }], {
      shares: "claude-code",
      suspension: { window_calls: 10, min_calls: 2, rejection_threshold: 0.4 },
    });
    expect(await h.call()).toMatchObject({ outcome: "rejected_validator" }); // 1/1 rejected, below min_calls
    expect(await h.call()).toMatchObject({ outcome: "rejected_validator" }); // 2/2 > 0.4: suspends in this transaction
    expect(h.svc.isSuspended("run_title")).toBe(true);
    expect(await h.call()).toMatchObject({ outcome: "fallback_suspended", reason: "TASK_SUSPENDED" });
    expect(h.ledger.listInnerCalls().map((c) => [c.outcome, c.attempts])).toEqual([
      ["rejected_validator", 2],
      ["rejected_validator", 2],
      ["fallback_suspended", 0],
    ]);
    // Two rows (the two rejected calls reached the backend, counts unknown), none for the denied third call.
    expect(h.usageRows().map((r) => [r.source, r.run_id, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", h.run.id, {}],
      ["inner_agent", h.run.id, {}],
    ]);
    // The operator's resume (FR-INN-09) writes no usage either: the ledger's usage rows are a function of calls made.
    expect(h.svc.resumeTask("run_title")).toMatchObject({ suspended: false });
    expect(h.usageRows()).toHaveLength(2);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });

  it("a project or context set to off (T11.3 gate, step 1) writes no observation: no request was made", async () => {
    const h = setup([GOOD], { shares: "claude-code" });
    expect(
      await h.svc.call(contract, { user: "objective: tidy", run_id: h.run.id, project_setting: "off" }),
    ).toMatchObject({ outcome: "fallback_disabled", reason: "PROJECT_OFF" });
    expect(h.ledger.listInnerCalls().map((c) => [c.reason, c.attempts])).toEqual([["PROJECT_OFF", 0]]);
    expect(h.usageRows()).toHaveLength(0);
  });

  it("the label follows the configured provider, not the run's provider (observation carries the run id)", async () => {
    // The run is on claude-code; the operator declared the backend shares the codex subscription. The row charges
    // codex (that is the subscription consumed), still under the run that caused it, and claude-code's provider-reported
    // view and envelope are untouched.
    const h = setup([GOOD], { shares: "codex" });
    h.ledger.insertUsageObservation({
      runId: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      source: "provider_reported",
      metrics: { "usage.input_tokens": 100 },
    });
    const record = () => h.ledger.getRunRecord(h.run.id);
    const envelope = () =>
      JSON.stringify(buildEnvelope(h.ledger, record() as NonNullable<ReturnType<typeof record>>, (s) => s));
    const before = envelope();
    expect(await h.call()).toMatchObject({ accepted: true });
    expect(h.usageRows().filter((r) => r.source === "inner_agent")).toEqual([
      expect.objectContaining({
        run_id: h.run.id,
        provider: "codex",
        harness: "codex",
        backing_provider: null,
        model: "fake-model",
        source: "inner_agent",
        metrics_json: JSON.stringify({ input_tokens: 10, output_tokens: 4 }),
      }),
    ]);
    expect(envelope()).toBe(before);
    const since = "1970-01-01T00:00:00.000Z";
    expect(h.ledger.listProviderReportedUsageSince("claude-code", since)).toHaveLength(1);
    expect(h.ledger.listProviderReportedUsageSince("codex", since)).toHaveLength(0);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });

  it("sums the counts of a re-ask, and records only non-negative safe integers; anything else is unknown", async () => {
    const h = setup(
      [
        { kind: "text", text: "bad", usage: { in: 7, out: 2 } },
        { kind: "text", text: '{"title":"ok"}', usage: { in: 5, out: 3 } }, // re-ask of call 1: 12 in, 5 out
        { kind: "text", text: '{"title":"ok"}', usage: { in: 3, out: null } }, // call 2: out unknown
        { kind: "text", text: '{"title":"ok"}', usage: { in: -1, out: 2.5 } }, // call 3: both bogus
        { kind: "text", text: '{"title":"ok"}', usage: { in: Number.NaN, out: Number.POSITIVE_INFINITY } }, // call 4
        // call 5: a backend that does not honour the port's number type is still a backend
        { kind: "text", text: '{"title":"ok"}', usage: { in: "12" as unknown as number, out: 2 ** 53 } },
      ],
      { shares: "claude-code" },
    );
    for (let i = 0; i < 5; i++) await h.call();
    expect(h.ledger.listInnerCalls().map((c) => [c.tokens_in, c.tokens_out])).toEqual([
      [12, 5],
      [3, null],
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(h.usageRows().map((r) => JSON.parse(String(r.metrics_json)))).toEqual([
      { input_tokens: 12, output_tokens: 5 },
      { input_tokens: 3 },
      {},
      {},
      {},
    ]);
    expect([0, 1, 2 ** 53 - 1].map(tokenCount)).toEqual([0, 1, 2 ** 53 - 1]);
    expect([-0.5, 1.5, 2 ** 53, Number.NaN, -1, "3", null, undefined, true].map(tokenCount)).toEqual(
      Array(9).fill(null),
    );
  });

  it("the run's envelope and provider-reported view are byte-identical with and without shared-subscription calls", async () => {
    const h = setup([GOOD, { kind: "text", text: "bad" }, { kind: "text", text: "bad again" }], {
      shares: "claude-code",
    });
    h.ledger.insertUsageObservation({
      runId: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      source: "provider_reported",
      metrics: { "usage.input_tokens": 100 },
    });
    const record = () => h.ledger.getRunRecord(h.run.id);
    const envelope = () =>
      JSON.stringify(buildEnvelope(h.ledger, record() as NonNullable<ReturnType<typeof record>>, (s) => s));
    const before = envelope();
    expect(JSON.parse(before).usage.reported).toEqual([expect.objectContaining({ source: "provider_reported" })]);
    await h.call();
    await h.call();
    expect(h.usageRows().filter((r) => r.source === "inner_agent")).toHaveLength(2);
    // The envelope reads provider_reported rows only (envelope.ts): the inner_agent rows do not appear as provider usage.
    expect(envelope()).toBe(before);
    expect(h.ledger.listProviderReportedUsageSince("claude-code", "1970-01-01T00:00:00.000Z")).toHaveLength(1);
  });

  it("a call with no run_id still writes one labelled observation when shares_subscription_with is set", async () => {
    // inner test and T11.11 admission classification have no run_id (#330 named those as live callers).
    const h = setup([GOOD], { shares: "claude-code" });
    expect(await h.svc.call(contract, { user: "objective: tidy" })).toMatchObject({ accepted: true });
    expect(h.ledger.listInnerCalls()).toEqual([expect.objectContaining({ run_id: null, attempts: 1 })]);
    expect(h.usageRows()).toEqual([
      expect.objectContaining({
        run_id: null,
        provider: "claude-code",
        harness: "claude-code",
        source: "inner_agent",
        metrics_json: JSON.stringify({ input_tokens: 10, output_tokens: 4 }),
      }),
    ]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });

  it("without shares_subscription_with, a call with no run_id writes inner_call only", async () => {
    const h = setup([GOOD]);
    const before = h.snapshot();
    expect(await h.svc.call(contract, { user: "objective: tidy" })).toMatchObject({ accepted: true });
    expect(h.ledger.listInnerCalls()).toHaveLength(1);
    expect(h.snapshot()).toBe(before);
  });

  it("createCommitMessageTask (T11.4 serve path) writes one labelled observation and leaves provider usage unchanged", async () => {
    const h = setup([GOOD]);
    h.ledger.insertUsageObservation({
      runId: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      source: "provider_reported",
      metrics: { "usage.input_tokens": 100 },
    });
    const settings = resolveInnerAgent({
      enabled: true,
      backend: {
        kind: "http",
        base_url: "http://127.0.0.1:1",
        model: "cfg-model",
        shares_subscription_with: "claude-code",
      },
      tasks: { commit_message: { enabled: true } },
    });
    const svc = createInnerAgent(settings, {
      backend: createFakeBackend({
        script: [{ kind: "text", text: '{"subject":"Fix login"}', usage: { in: 8, out: 3 } }],
      }),
      ledger: h.ledger,
    });
    const drafted = await createCommitMessageTask(svc, {
      mode: "draft_if_missing",
      runId: h.run.id,
      metaSessionId: h.run.meta_session_id,
      projectSetting: "inherit",
      nativeSessionIds: [],
    }).draft({
      numstat: "1\t0\texample.ts",
      diff: "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -0,0 +1 @@\n+x\n",
      recentSubjects: ["Init"],
      sanitise: (text) => text,
    });
    expect(drafted).toMatchObject({ ok: true, text: "Fix login" });
    expect(h.ledger.listInnerCalls()).toEqual([
      expect.objectContaining({ task: "commit_message", run_id: h.run.id, attempts: 1 }),
    ]);
    expect(h.usageRows().filter((r) => r.source === "inner_agent")).toEqual([
      expect.objectContaining({
        run_id: h.run.id,
        provider: "claude-code",
        source: "inner_agent",
        metrics_json: JSON.stringify({ input_tokens: 8, output_tokens: 3 }),
      }),
    ]);
    expect(h.ledger.listProviderReportedUsageSince("claude-code", "1970-01-01T00:00:00.000Z")).toHaveLength(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });

  it("createClassifyRouteFeaturesHook (T11.11 serve path) labels admission (no run_id) and continuation", async () => {
    const h = setup([GOOD]);
    const settings = resolveInnerAgent({
      enabled: true,
      backend: {
        kind: "http",
        base_url: "http://127.0.0.1:1",
        model: "cfg-model",
        shares_subscription_with: "claude-code",
      },
      tasks: { route_features: { enabled: true } },
    });
    const reply = '{"context_volume":"small","autonomy":"low","reasoning_depth":"low","task_kind":"docs"}';
    const svc = createInnerAgent(settings, {
      backend: createFakeBackend({
        script: [
          { kind: "text", text: reply, usage: { in: 4, out: 2 } },
          { kind: "text", text: reply, usage: { in: 6, out: 1 } },
        ],
      }),
      ledger: h.ledger,
    });
    const hook = createClassifyRouteFeaturesHook(svc, () => "inherit");
    const input = { objective: "Fix a typo", constraints: [] as const, verificationCommands: 0, writable: true };
    const admitted = await hook(input, {});
    expect(admitted.task_kind).toMatchObject({ value: "docs", source: "inner" });
    const continued = await hook(input, { runId: h.run.id, metaSessionId: h.run.meta_session_id });
    expect(continued.task_kind.source).toBe("inner");
    expect(h.ledger.listInnerCalls().map((c) => [c.task, c.run_id, c.attempts])).toEqual([
      ["route_features", null, 1],
      ["route_features", h.run.id, 1],
    ]);
    expect(h.usageRows().map((r) => [r.run_id, r.source, JSON.parse(String(r.metrics_json))])).toEqual([
      [null, "inner_agent", { input_tokens: 4, output_tokens: 2 }],
      [h.run.id, "inner_agent", { input_tokens: 6, output_tokens: 1 }],
    ]);
  });

  it("createCommitMessageTask (T11.4 serve path) without shares_subscription_with writes inner_call only and leaves usage_observation empty", async () => {
    const h = setup([GOOD]);
    h.ledger.insertUsageObservation({
      runId: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      source: "provider_reported",
      metrics: { "usage.input_tokens": 100 },
    });
    const before = h.snapshot();
    const settings = resolveInnerAgent({
      enabled: true,
      backend: {
        kind: "http",
        base_url: "http://127.0.0.1:1",
        model: "cfg-model",
      },
      tasks: { commit_message: { enabled: true } },
    });
    const svc = createInnerAgent(settings, {
      backend: createFakeBackend({
        script: [{ kind: "text", text: '{"subject":"Fix login"}', usage: { in: 8, out: 3 } }],
      }),
      ledger: h.ledger,
    });
    const drafted = await createCommitMessageTask(svc, {
      mode: "draft_if_missing",
      runId: h.run.id,
      metaSessionId: h.run.meta_session_id,
      projectSetting: "inherit",
      nativeSessionIds: [],
    }).draft({
      numstat: "1\t0\texample.ts",
      diff: "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -0,0 +1 @@\n+x\n",
      recentSubjects: ["Init"],
      sanitise: (text) => text,
    });
    expect(drafted).toMatchObject({ ok: true, text: "Fix login" });
    expect(h.ledger.listInnerCalls()).toEqual([
      expect.objectContaining({ task: "commit_message", run_id: h.run.id, attempts: 1 }),
    ]);
    expect(h.usageRows().filter((r) => r.source === "inner_agent")).toHaveLength(0);
    expect(h.snapshot()).toBe(before);
    expect(h.ledger.listProviderReportedUsageSince("claude-code", "1970-01-01T00:00:00.000Z")).toHaveLength(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });

  it("createClassifyRouteFeaturesHook (T11.11 serve path) without shares_subscription_with writes inner_call only and leaves usage_observation empty", async () => {
    const h = setup([GOOD]);
    const settings = resolveInnerAgent({
      enabled: true,
      backend: {
        kind: "http",
        base_url: "http://127.0.0.1:1",
        model: "cfg-model",
      },
      tasks: { route_features: { enabled: true } },
    });
    const reply = '{"context_volume":"small","autonomy":"low","reasoning_depth":"low","task_kind":"docs"}';
    const svc = createInnerAgent(settings, {
      backend: createFakeBackend({
        script: [
          { kind: "text", text: reply, usage: { in: 4, out: 2 } },
          { kind: "text", text: reply, usage: { in: 6, out: 1 } },
        ],
      }),
      ledger: h.ledger,
    });
    const hook = createClassifyRouteFeaturesHook(svc, () => "inherit");
    const input = { objective: "Fix a typo", constraints: [] as const, verificationCommands: 0, writable: true };
    const admitted = await hook(input, {});
    expect(admitted.task_kind).toMatchObject({ value: "docs", source: "inner" });
    const continued = await hook(input, { runId: h.run.id, metaSessionId: h.run.meta_session_id });
    expect(continued.task_kind.source).toBe("inner");
    expect(h.ledger.listInnerCalls().map((c) => [c.task, c.run_id, c.attempts])).toEqual([
      ["route_features", null, 1],
      ["route_features", h.run.id, 1],
    ]);
    expect(h.usageRows()).toHaveLength(0);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });
});

describe("the labelled observation and the inner_call row are one transaction (T11.5; FR-INN-15, ADR-0005)", () => {
  it("a refused observation takes the call row and its run event with it; the caller still gets the accepted value", async () => {
    const logs: InnerLogEntry[] = [];
    const h = setup([GOOD, GOOD], { shares: "claude-code", logger: (e) => logs.push(e) });
    refuseInnerObservations(h.db, true);
    const r = await h.call();
    // The pipeline's result is not the ledger's business: the value is accepted and used, but there is no call id,
    // because nothing was recorded.
    expect(r).toMatchObject({ accepted: true, value: { title: "Fix login" } });
    expect(r.call_id).toBeUndefined();
    expect(h.ledger.listInnerCalls()).toEqual([]);
    expect(h.usageRows()).toEqual([]);
    expect(h.runEventCount()).toBe(0);
    expect(logs.filter((l) => l.event === "inner.record_failed")).toEqual([
      { event: "inner.record_failed", task: "run_title", outcome: "accepted" },
    ]);
    expect(JSON.stringify(logs)).not.toContain(REFUSE_OBSERVATION); // the database's message is not a log field
    // Prove the guard was the only cause: without it the same call records one row, one observation, one event.
    refuseInnerObservations(h.db, false);
    expect((await h.call()).call_id).toEqual(expect.any(String));
    expect(h.ledger.listInnerCalls()).toHaveLength(1);
    expect(h.usageRows().map((x) => x.source)).toEqual(["inner_agent"]);
    expect(h.runEventCount()).toBe(1);
  });

  it("without shares_subscription_with no observation insert is attempted at all: the refusing trigger never fires", async () => {
    const logs: InnerLogEntry[] = [];
    const h = setup([GOOD], { logger: (e) => logs.push(e) });
    refuseInnerObservations(h.db, true);
    const before = h.snapshot();
    const r = await h.call();
    expect(r).toMatchObject({ accepted: true });
    expect(r.call_id).toEqual(expect.any(String));
    expect(h.ledger.listInnerCalls()).toHaveLength(1);
    expect(h.runEventCount()).toBe(1);
    expect(h.snapshot()).toBe(before);
    expect(logs.some((l) => l.event === "inner.record_failed")).toBe(false);
  });
});

/**
 * The pin above refuses the observation itself. `recordInnerCall` writes the observation second (after the `inner_call`
 * row, before the run events and the step 11 suspension state), so the other direction matters too: a write that fails
 * *after* the observation went in must take the observation back out, or a labelled row would survive for a call the
 * ledger otherwise knows nothing about. The two later writes that exist only on some calls are the ones exercised: the
 * `inner_degraded` event of the call that opens the breaker, and the `inner_task_state` write of the call that suspends
 * its task. Each trigger is narrow (it fires on that one write), so the calls around it show the refusal was the only
 * cause.
 */
describe("a later write in the same transaction takes the labelled observation back with it (T11.5; FR-INN-15, ADR-0005)", () => {
  const REFUSE_LATER_WRITE = "later-write-refused-3c9a";
  const recordFailures = (logs: readonly InnerLogEntry[]) => logs.filter((l) => l.event === "inner.record_failed");

  it("a refused inner_degraded event (the failed call that opens the breaker) rolls back its observation and call row; the denied call after it records with no observation", async () => {
    const logs: InnerLogEntry[] = [];
    const h = setup([{ kind: "error" }], {
      shares: "claude-code",
      breaker: { failure_threshold: 1, open_ms: 60_000 },
      logger: (e) => logs.push(e),
    });
    h.db.exec(
      `CREATE TRIGGER refuse_degraded BEFORE INSERT ON run_event WHEN NEW.type = 'inner_degraded'
         BEGIN SELECT RAISE(ABORT, '${REFUSE_LATER_WRITE}'); END;`,
    );
    const r = await h.call();
    // The caller's view is the pipeline's: the fallback, the reason, and no call id because nothing was recorded.
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_unavailable", reason: "BACKEND_ERROR" });
    expect(r.call_id).toBeUndefined();
    expect(h.ledger.listInnerCalls()).toEqual([]);
    expect(h.usageRows()).toEqual([]);
    expect(h.runEventCount()).toBe(0);
    expect(recordFailures(logs)).toEqual([
      { event: "inner.record_failed", task: "run_title", outcome: "fallback_unavailable" },
    ]);
    expect(JSON.stringify(logs)).not.toContain(REFUSE_LATER_WRITE);
    // The breaker is in-memory state and opened all the same (as built: the ledger does not drive it). The denied call
    // has no transition, so no degraded event, and records as every denied call does: attempts 0, no observation.
    expect(h.svc.breakerState).toBe("open");
    expect(await h.call()).toMatchObject({ outcome: "fallback_unavailable", reason: "CIRCUIT_OPEN" });
    expect(h.ledger.listInnerCalls().map((c) => [c.reason, c.attempts])).toEqual([["CIRCUIT_OPEN", 0]]);
    expect(h.usageRows()).toEqual([]);
    expect(h.runEventCount()).toBe(1);
    expect(recordFailures(logs)).toHaveLength(1);
    // Prove the trigger was the only cause: without it, a fresh breaker's opening call writes all four rows together.
    h.db.exec("DROP TRIGGER refuse_degraded");
    const fresh = createInnerAgent(h.settings, {
      backend: createFakeBackend({ script: [{ kind: "error" }] }),
      ledger: h.ledger,
      logger: (e) => logs.push(e),
    });
    const again = await fresh.call(contract, { user: "objective: tidy", run_id: h.run.id });
    expect(again).toMatchObject({ outcome: "fallback_unavailable", reason: "BACKEND_ERROR" });
    expect(again.call_id).toEqual(expect.any(String));
    expect(h.ledger.listInnerCalls().map((c) => [c.reason, c.attempts])).toEqual([
      ["CIRCUIT_OPEN", 0],
      ["BACKEND_ERROR", 1],
    ]);
    expect(h.usageRows().map((x) => [x.source, JSON.parse(String(x.metrics_json))])).toEqual([["inner_agent", {}]]);
    expect(
      (
        h.db.prepare("SELECT type FROM run_event WHERE run_id = ? ORDER BY seq").all(h.run.id) as { type: string }[]
      ).map((e) => e.type),
    ).toEqual(["inner_call", "inner_call", "inner_degraded"]);
    expect(recordFailures(logs)).toHaveLength(1);
  });

  it("a refused inner_task_state write (the rejection that suspends the task) rolls back that call's observation and row; the task stays unsuspended until the same call records", async () => {
    const logs: InnerLogEntry[] = [];
    const bad: FakeStep = { kind: "text", text: "bad", usage: { in: 3, out: 1 } };
    const h = setup([bad], {
      shares: "claude-code",
      suspension: { window_calls: 10, min_calls: 2, rejection_threshold: 0.4 },
      logger: (e) => logs.push(e),
    });
    expect(await h.call()).toMatchObject({ outcome: "rejected_validator" }); // 1/1 rejected, below min_calls
    expect(h.usageRows()).toHaveLength(1);
    // The suspension write is an upsert; a row never existed, so the INSERT is the write that is refused.
    h.db.exec(
      `CREATE TRIGGER refuse_suspend BEFORE INSERT ON inner_task_state
         BEGIN SELECT RAISE(ABORT, '${REFUSE_LATER_WRITE}'); END;`,
    );
    const r = await h.call(); // 2/2 > 0.4: this call would suspend the task in its own transaction
    expect(r).toMatchObject({ accepted: false, outcome: "rejected_validator", reason: "NOT_JSON" });
    expect(r.call_id).toBeUndefined();
    // The re-ask's summed counts (6 in, 2 out) reached the backend and were reported; the row that would have carried
    // them is gone with the call row and the event, and the first call's row is untouched.
    expect(h.ledger.listInnerCalls().map((c) => [c.outcome, c.attempts, c.tokens_in, c.tokens_out])).toEqual([
      ["rejected_validator", 2, 6, 2],
    ]);
    expect(h.usageRows().map((x) => [x.source, JSON.parse(String(x.metrics_json))])).toEqual([
      ["inner_agent", { input_tokens: 6, output_tokens: 2 }],
    ]);
    expect(h.runEventCount()).toBe(1);
    expect(h.svc.isSuspended("run_title")).toBe(false);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM inner_task_state").get()).toEqual({ n: 0 });
    expect(recordFailures(logs)).toEqual([
      { event: "inner.record_failed", task: "run_title", outcome: "rejected_validator" },
    ]);
    expect(logs.some((l) => l.event === "inner.task_suspended")).toBe(false);
    expect(JSON.stringify(logs)).not.toContain(REFUSE_LATER_WRITE);
    // Without the trigger the same call records everything at once: its row, its observation, its event, the
    // suspension state and the suspension event. The window still counts 2/2, because the refused call left no row.
    h.db.exec("DROP TRIGGER refuse_suspend");
    const recorded = await h.call();
    expect(recorded).toMatchObject({ outcome: "rejected_validator" });
    expect(recorded.call_id).toEqual(expect.any(String));
    expect(h.svc.isSuspended("run_title")).toBe(true);
    expect(logs.filter((l) => l.event === "inner.task_suspended")).toHaveLength(1);
    expect(h.ledger.listInnerCalls().map((c) => [c.outcome, c.attempts])).toEqual([
      ["rejected_validator", 2],
      ["rejected_validator", 2],
    ]);
    expect(h.usageRows().map((x) => [x.source, x.run_id, JSON.parse(String(x.metrics_json))])).toEqual([
      ["inner_agent", h.run.id, { input_tokens: 6, output_tokens: 2 }],
      ["inner_agent", h.run.id, { input_tokens: 6, output_tokens: 2 }],
    ]);
    expect(
      (
        h.db.prepare("SELECT type FROM run_event WHERE run_id = ? ORDER BY seq").all(h.run.id) as { type: string }[]
      ).map((e) => e.type),
    ).toEqual(["inner_call", "inner_call", "inner_task_suspended"]);
    expect(recordFailures(logs)).toHaveLength(1);
  });
});

/**
 * The labelled row carries no `inner_call_id`; what ties it to its call is the transaction it was written in. So its
 * shape must be the call row's: the same instant (`observed_at` is the `created_at` the ledger stamped on the call row
 * and the `ts` of the call's event), the model the row recorded (the backend's reported one, not the configured one),
 * the ledger's `use` id namespace, and under concurrency the nth observation belonging to the nth *recorded* call, not
 * the nth started one. A ticking clock makes every instant distinct, so "the same instant" is a real equality.
 */
describe("the labelled row is stamped with its call row (T11.5; FR-INN-15, ADR-0005)", () => {
  it("observed_at equals the call row's created_at and the event's ts; model, id namespace and pairing follow the recorded call under concurrency", async () => {
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
    const h = setup(
      [
        { kind: "text", text: '{"title":"slow"}', usage: { in: 1, out: 11 }, model_id: "model-slow", delay_ms: 150 },
        { kind: "text", text: '{"title":"fast"}', usage: { in: 2, out: 22 }, model_id: "model-fast" },
      ],
      { shares: "claude-code", maxConcurrency: 2, now },
    );
    const [slow, fast] = await Promise.all([h.call(), h.call()]);
    expect(slow).toMatchObject({ accepted: true, value: { title: "slow" } });
    expect(fast).toMatchObject({ accepted: true, value: { title: "fast" } });
    const calls = h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Record<string, unknown>[];
    const rows = h.usageRows();
    const events = h.db.prepare("SELECT * FROM run_event WHERE run_id = ? ORDER BY seq").all(h.run.id) as Record<
      string,
      unknown
    >[];
    // The fast call finished first and was recorded first, in every table, although it was started second.
    expect(calls.map((c) => [c.model_id, c.tokens_in, c.tokens_out])).toEqual([
      ["model-fast", 2, 22],
      ["model-slow", 1, 11],
    ]);
    expect(rows.map((r) => [r.model, JSON.parse(String(r.metrics_json))])).toEqual([
      ["model-fast", { input_tokens: 2, output_tokens: 22 }],
      ["model-slow", { input_tokens: 1, output_tokens: 11 }],
    ]);
    expect(
      events.map((e) => [e.type, (JSON.parse(String(e.payload_json)) as { inner_call_id: string }).inner_call_id]),
    ).toEqual([
      ["inner_call", calls[0]?.id],
      ["inner_call", calls[1]?.id],
    ]);
    // One instant per transaction, distinct between the two, shared by the three rows of each.
    expect(calls.map((c) => c.created_at)).toEqual(rows.map((r) => r.observed_at));
    expect(calls.map((c) => c.created_at)).toEqual(events.map((e) => e.ts));
    expect(new Set(calls.map((c) => c.created_at)).size).toBe(2);
    expect(calls.map((c) => c.created_at)).toEqual([...calls.map((c) => c.created_at)].sort());
    // Ids: the observation is a `use` id (the namespace provider-reported rows use), never the call's `inc` id, and the
    // call list (ordered by id) agrees with insertion order.
    expect(rows.map((r) => String(r.id).slice(0, 4))).toEqual(["use_", "use_"]);
    expect(calls.map((c) => String(c.id).slice(0, 4))).toEqual(["inc_", "inc_"]);
    expect(h.ledger.listInnerCalls().map((c) => c.id)).toEqual(calls.map((c) => c.id));
    expect(rows.map((r) => r.id)).not.toContain(calls[0]?.id);
    // The row's shape, column by column, for the first pair: the label from config, the model from the backend.
    expect(rows[0]).toEqual({
      id: rows[0]?.id,
      run_id: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      backing_provider: null,
      model: "model-fast",
      source: "inner_agent",
      metrics_json: JSON.stringify({ input_tokens: 2, output_tokens: 22 }),
      observed_at: calls[0]?.created_at,
    });
    expect(h.settings.backend?.model).toBe("cfg-model");
    expect(JSON.stringify(rows)).not.toContain("cfg-model");
  });
});

describe("the observation follows `attempts >= 1`, not the reason code (T11.5; FR-INN-15)", () => {
  it("a TIMEOUT while resolving locality made no request: inner_call row with attempts 0, no observation", async () => {
    const h = setup([GOOD], { shares: "claude-code", timeoutMs: 100, wrapBackend: slowLocality });
    expect(await h.call()).toMatchObject({ outcome: "fallback_unavailable", reason: "TIMEOUT" });
    expect(h.ledger.listInnerCalls().map((c) => [c.reason, c.attempts, c.tokens_in])).toEqual([["TIMEOUT", 0, null]]);
    expect(h.usageRows()).toEqual([]);
  });

  it("a TIMEOUT after the request was sent writes one; a BUSY call that never got the slot writes none", async () => {
    // One slot, one hanging request: the first call (run_title, the backend's 400 ms bound) reaches the backend and
    // times out there (attempts 1, one observation with unknown counts); the second (log_summary, a 100 ms task bound)
    // waits for the slot until its own deadline and is BUSY (attempts 0, no observation).
    const h = setup([{ kind: "hang" }], {
      shares: "claude-code",
      timeoutMs: 400,
      maxConcurrency: 1,
      tasks: { log_summary: { enabled: true, timeout_ms: 100 } },
    });
    const first = h.call();
    await new Promise((r) => setTimeout(r, 20));
    const second = await h.svc.call(
      { ...contract, task: "log_summary" },
      { user: "objective: tidy", run_id: h.run.id },
    );
    expect(second).toMatchObject({ outcome: "fallback_unavailable", reason: "BUSY" });
    expect(await first).toMatchObject({ outcome: "fallback_unavailable", reason: "TIMEOUT" });
    const calls = h.ledger
      .listInnerCalls()
      .map((c) => [c.task, c.reason ?? "", c.attempts] as const)
      .sort((a, b) => a[1].localeCompare(b[1]));
    expect(calls).toEqual([
      ["log_summary", "BUSY", 0],
      ["run_title", "TIMEOUT", 1],
    ]);
    expect(h.usageRows().map((r) => [r.source, JSON.parse(String(r.metrics_json))])).toEqual([["inner_agent", {}]]);
  });

  it("STATE_UNREADABLE (the suspension state cannot be read) fails closed without a request: no observation", async () => {
    const h = setup([GOOD], { shares: "claude-code" });
    const svc = createInnerAgent(h.settings, {
      backend: h.backend,
      ledger: {
        recordInnerCall: (row, events) => h.ledger.recordInnerCall(row, events),
        getInnerTaskState: () => {
          throw new Error("database is locked");
        },
      },
    });
    const r = await svc.call(contract, { user: "objective: tidy", run_id: h.run.id });
    expect(r).toMatchObject({ outcome: "fallback_unavailable", reason: "STATE_UNREADABLE" });
    expect(h.ledger.listInnerCalls().map((c) => [c.reason, c.attempts])).toEqual([["STATE_UNREADABLE", 0]]);
    expect(h.usageRows()).toEqual([]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });
});

describe("the http backend's reported usage reaches the labelled observation as reported or unknown (T11.5; FR-INN-03)", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  /** A loopback chat-completions server that answers each request with the next scripted `usage` block (or none). */
  async function serve(usages: readonly (object | undefined)[]): Promise<number> {
    let i = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const usage = usages[Math.min(i, usages.length - 1)];
        i++;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            model: "served-model",
            choices: [{ index: 0, message: { role: "assistant", content: '{"title":"Fix login"}' } }],
            ...(usage !== undefined ? { usage } : {}),
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return (server.address() as AddressInfo).port;
  }

  it("prompt_tokens/completion_tokens are the only figures read; absent, fractional, negative, string or unsafe ones are unknown", async () => {
    const port = await serve([
      { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }, // total_tokens is never recorded
      undefined, // no usage block at all
      { prompt_tokens: 7.5, completion_tokens: 3 },
      { prompt_tokens: "9", completion_tokens: -1 },
      { prompt_tokens: 2 ** 53, completion_tokens: 4 }, // an integer, but not a safe one
      { input_tokens: 12, output_tokens: 6 }, // the Anthropic-style keys are not the OpenAI-style ones this backend reads
    ]);
    const h = setup([], { shares: "claude-code" });
    const settings = resolveInnerAgent({
      enabled: true,
      backend: {
        kind: "http",
        base_url: `http://127.0.0.1:${port}`,
        model: "cfg-model",
        shares_subscription_with: "codex",
        timeout_ms: 2000,
      },
      tasks: { run_title: { enabled: true } },
    });
    const svc = createInnerAgent(settings, {
      backend: createHttpBackend(settings.backend as NonNullable<typeof settings.backend>),
      ledger: h.ledger,
    });
    for (let i = 0; i < 6; i++) {
      expect(await svc.call(contract, { user: "objective: tidy", run_id: h.run.id })).toMatchObject({ accepted: true });
    }
    expect(h.ledger.listInnerCalls().map((c) => [c.backend_kind, c.model_id, c.tokens_in, c.tokens_out])).toEqual([
      ["http", "served-model", 11, 5],
      ["http", "served-model", null, null],
      ["http", "served-model", null, 3],
      ["http", "served-model", null, null],
      ["http", "served-model", null, 4],
      ["http", "served-model", null, null],
    ]);
    expect(
      h.usageRows().map((r) => [r.provider, r.harness, r.model, r.source, JSON.parse(String(r.metrics_json))]),
    ).toEqual([
      ["codex", "codex", "served-model", "inner_agent", { input_tokens: 11, output_tokens: 5 }],
      ["codex", "codex", "served-model", "inner_agent", {}],
      ["codex", "codex", "served-model", "inner_agent", { output_tokens: 3 }],
      ["codex", "codex", "served-model", "inner_agent", {}],
      ["codex", "codex", "served-model", "inner_agent", { output_tokens: 4 }],
      ["codex", "codex", "served-model", "inner_agent", {}],
    ]);
    // The exact metrics above are the whole story: no total, no estimate, no default and no clamp appears anywhere.
    expect(
      h
        .usageRows()
        .map((r) => String(r.metrics_json))
        .join("\n"),
    ).not.toMatch(/total|9007199254740991/u);
    expect(h.ledger.listProviderReportedUsageSince("codex", "1970-01-01T00:00:00.000Z")).toHaveLength(0);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });
});

/**
 * T11.5 says "no code path outside `Ledger.recordInnerCall` writes usage for an inner call". Two things make that true:
 * the ledger's public insert (`insertUsageObservation`, the lifecycle's provider-reported writer) refuses every source
 * but `provider_reported` (FR-CAP-01), and no production module other than the ledger repository writes the table at
 * all. Until now the refusal was pinned for `controller_estimated` only (`src/usage/usage.test.ts`, written before
 * migration 0006 added the `inner_agent` value), so a guard loosened to let `inner_agent` through the general path
 * would have passed every test. The scan below is textual and simple, like `run-path-reach.test.ts`: word-bounded,
 * so the migration's `usage_observation_new` does not match, and checked on a synthetic tree so it cannot be vacuous.
 *
 * Post-#432: the scan covers every spelling SQLite accepts for a write, not `INSERT INTO` alone, because one of them
 * used to get past the table's append-only guards. `INSERT OR REPLACE` / `REPLACE INTO` resolve a colliding id by
 * deleting the old row, and SQLite fires no `BEFORE DELETE` trigger for that delete unless `recursive_triggers` is on.
 * Q-96 (answered 2026-10-15, Delegated): `openLedger` now sets it on, so the REPLACE spelling is refused by the same
 * guards as `UPDATE` and `DELETE`. The last-but-one test pins that on the real ledger; the widened scan stays as the
 * sole-writer pin and as defence in depth should the pragma ever be dropped.
 */
describe("recordInnerCall under the flag is the only writer of inner_agent rows (T11.5; FR-INN-15, FR-CAP-01)", () => {
  it("the public insert refuses an inner_agent row shaped exactly like a labelled one, and writes nothing", async () => {
    const h = setup([GOOD], { shares: "claude-code" });
    const before = h.snapshot();
    const labelledShape = {
      runId: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      backingProvider: null,
      model: "fake-model",
      metrics: { input_tokens: 10, output_tokens: 4 },
    };
    expect(() =>
      h.ledger.insertUsageObservation({
        ...labelledShape,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the type to prove the runtime guard
        source: "inner_agent" as any,
      }),
    ).toThrow(/accepts only provider_reported rows \(FR-CAP-01\)/u);
    expect(h.snapshot()).toBe(before);
    expect(h.usageRows()).toEqual([]);
    // The same shape reaches the table through the pipeline's own record, and only there: one call, one labelled row.
    expect(await h.call()).toMatchObject({ accepted: true });
    expect(h.usageRows()).toHaveLength(1);
    expect(h.usageRows()[0]).toMatchObject({
      run_id: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      backing_provider: null,
      model: "fake-model",
      source: "inner_agent",
      metrics_json: JSON.stringify({ input_tokens: 10, output_tokens: 4 }),
    });
    // The accepted provider-reported form still goes through, so the guard is on the source and nothing else.
    h.ledger.insertUsageObservation({ ...labelledShape, source: "provider_reported" });
    expect(h.usageRows().map((r) => r.source)).toEqual(["inner_agent", "provider_reported"]);
  });

  const SRC = path.resolve(import.meta.dirname, "..");
  /**
   * Every write spelling SQLite accepts: `INSERT`, `INSERT OR <conflict clause>` and the `REPLACE` alias, with an
   * optional schema qualifier, case-insensitive. `INSERT ... ON CONFLICT DO UPDATE` is still an `INSERT INTO` and matches.
   */
  const INSERT_RE =
    /(?:INSERT(?:\s+OR\s+(?:REPLACE|ROLLBACK|ABORT|FAIL|IGNORE))?|REPLACE)\s+INTO\s+(?:\w+\s*\.\s*)?usage_observation(?![\w$])/giu;

  function productionTree(): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts") && !full.endsWith(".test.ts")) {
          files.set(path.relative(SRC, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
        }
      }
    };
    walk(SRC);
    return files;
  }

  /** `[file, statement count]` for every file whose text writes the table. Pure over a map. */
  const writers = (files: ReadonlyMap<string, string>): [string, number][] =>
    [...files]
      .map(([rel, text]): [string, number] => [rel, [...text.matchAll(INSERT_RE)].length])
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b));

  it("the scanner finds a planted write in a synthetic tree in every spelling and ignores the migration's rebuilt table (not vacuous)", () => {
    const synthetic = new Map<string, string>([
      ["ledger/migrations/0006_usage_inner_agent.ts", "INSERT INTO usage_observation_new (id) SELECT id FROM x;"],
      ["cli/planted.ts", "db.prepare(`INSERT   INTO\n usage_observation (id) VALUES (?)`).run(id);"],
      ["cli/comment.ts", "// usage_observation is read here, never written"],
      [
        "cli/other-table.ts",
        "INSERT OR REPLACE INTO inner_call (id) VALUES (?); REPLACE INTO usage_observation_x (id) VALUES (?)",
      ],
      [
        "ledger/replace.ts",
        "INSERT OR REPLACE INTO usage_observation (id) VALUES (?); REPLACE INTO main.usage_observation (id) VALUES (?); INSERT OR IGNORE INTO usage_observation (id) VALUES (?)",
      ],
      [
        "cli/lower.ts",
        "insert into usage_observation (id) values (?) on conflict (id) do update set model = excluded.model",
      ],
    ]);
    expect(writers(synthetic)).toEqual([
      ["cli/lower.ts", 1],
      ["cli/planted.ts", 1],
      ["ledger/replace.ts", 3],
    ]);
  });

  it("the append-only guards refuse UPDATE, DELETE and a REPLACE of a labelled row under the ledger's pragmas (as-built, Q-96 answered)", async () => {
    const h = setup([GOOD], { shares: "claude-code" });
    expect(await h.call()).toMatchObject({ accepted: true });
    const [row] = h.usageRows();
    expect(row).toMatchObject({ source: "inner_agent", provider: "claude-code" });
    const since = "2000-01-01T00:00:00.000Z";
    // Plain rewrites are refused by the two triggers migration 0006 recreated, and the labelled row never reaches the
    // capacity collector's one usage read.
    expect(() =>
      h.db.prepare("UPDATE usage_observation SET source = 'provider_reported' WHERE id = ?").run(row?.id as string),
    ).toThrow(/append-only/u);
    expect(() => h.db.prepare("DELETE FROM usage_observation WHERE id = ?").run(row?.id as string)).toThrow(
      /append-only/u,
    );
    expect(h.ledger.listProviderReportedUsageSince("claude-code", since)).toEqual([]);
    // SQLite's REPLACE conflict resolution deletes the colliding row, and fires the BEFORE DELETE guard for that
    // delete only when `recursive_triggers` is on. `openLedger` sets it (Q-96, answered 2026-10-15, Delegated, fail
    // closed), so the same relabelling spelled as a REPLACE is refused too, the row is untouched and it never reaches
    // the capacity collector's read. Before the pragma this statement went through and relabelled the row.
    expect(h.db.pragma("recursive_triggers", { simple: true })).toBe(1);
    expect(() =>
      h.db
        .prepare(
          `INSERT OR REPLACE INTO usage_observation (id, run_id, provider, harness, backing_provider, model, source,
                                                     metrics_json, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'provider_reported', ?, ?)`,
        )
        .run(
          row?.id as string,
          row?.run_id as string,
          row?.provider as string,
          row?.harness as string,
          row?.backing_provider as string | null,
          row?.model as string,
          row?.metrics_json as string,
          row?.observed_at as string,
        ),
    ).toThrow(/append-only/u);
    expect(h.usageRows()).toEqual([row]);
    expect(h.ledger.listProviderReportedUsageSince("claude-code", since)).toEqual([]);
  });

  it("both REPLACE spellings are refused on each of the three rows one recorded call writes: inner_call, the labelled observation and the inner_call event (post-#442)", async () => {
    // `recordInnerCall` writes three guarded rows in one transaction (`src/ledger/repo.ts`): the `inner_call` row the
    // inner diagnostics read, the labelled observation and the run's `inner_call` event. The pin above covers one
    // spelling on one of them. Under the pragma a rewrite of any of the three, in either spelling SQLite accepts, is
    // refused with the same guard, and what the consumers read (the envelope's provider usage, the capacity collector's
    // read, the call list) is byte-identical. The rewrites chosen are the ones that would matter: counts the inner
    // diagnostics report, the label the capacity collector filters on, and the event payload `runs show` prints.
    const h = setup([GOOD], { shares: "claude-code" });
    h.ledger.insertUsageObservation({
      runId: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      source: "provider_reported",
      metrics: { "usage.input_tokens": 100 },
    });
    expect(await h.call()).toMatchObject({ accepted: true });
    const since = "1970-01-01T00:00:00.000Z";
    const record = () => h.ledger.getRunRecord(h.run.id);
    const envelope = () =>
      JSON.stringify(buildEnvelope(h.ledger, record() as NonNullable<ReturnType<typeof record>>, (s) => s));
    const state = () => ({
      calls: h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Record<string, unknown>[],
      usage: h.usageRows(),
      events: h.db.prepare("SELECT * FROM run_event WHERE run_id = ? ORDER BY seq").all(h.run.id) as Record<
        string,
        unknown
      >[],
      listed: h.ledger.listInnerCalls(),
      envelope: envelope(),
      reported: h.ledger.listProviderReportedUsageSince("claude-code", since),
    });
    const before = state();
    const [call] = before.calls;
    const labelled = before.usage.find((r) => r.source === "inner_agent");
    const event = before.events.find((e) => e.type === "inner_call");
    expect(call).toMatchObject({ outcome: "accepted", tokens_in: 10, tokens_out: 4 });
    expect(labelled).toMatchObject({ provider: "claude-code", run_id: h.run.id });
    expect(event).toMatchObject({ type: "inner_call" });
    expect(before.reported).toHaveLength(1);
    expect(JSON.parse(before.envelope).usage.reported).toHaveLength(1);
    expect(h.db.pragma("recursive_triggers", { simple: true })).toBe(1);

    for (const spelling of ["INSERT OR REPLACE INTO", "REPLACE INTO"]) {
      expect(() =>
        h.db
          .prepare(
            `${spelling} inner_call (id, task, backend_kind, model_id, locality, template_version, outcome, reason,
               attempts, latency_ms, tokens_in, tokens_out, input_bytes, output_bytes, input_sha256, run_id,
               meta_session_id, created_at)
             VALUES (@id, @task, @backend_kind, @model_id, @locality, @template_version, @outcome, @reason, @attempts,
               @latency_ms, @tokens_in, @tokens_out, @input_bytes, @output_bytes, @input_sha256, @run_id,
               @meta_session_id, @created_at)`,
          )
          .run({ ...call, outcome: "rejected_validator", tokens_in: 999_999, tokens_out: 999_999 }),
      ).toThrow(/append-only/u);
      expect(() =>
        h.db
          .prepare(
            `${spelling} usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json,
                                            observed_at)
             VALUES (@id, @run_id, @provider, @harness, @backing_provider, @model, @source, @metrics_json, @observed_at)`,
          )
          .run({ ...labelled, source: "provider_reported" }),
      ).toThrow(/append-only/u);
      expect(() =>
        h.db
          .prepare(
            `${spelling} run_event (id, run_id, seq, ts, type, payload_json, artifact_id)
             VALUES (@id, @run_id, @seq, @ts, @type, @payload_json, @artifact_id)`,
          )
          .run({ ...event, payload_json: JSON.stringify({ rewritten: true, tokens_in: 999_999 }) }),
      ).toThrow(/append-only/u);
    }
    expect(state()).toEqual(before);
    expect(JSON.stringify(state())).not.toContain("999999");
  });

  it("only the ledger repository writes usage_observation: its two statements, the provider-reported insert and recordInnerCall", () => {
    const files = productionTree();
    expect(writers(files)).toEqual([["ledger/repo.ts", 2]]);
    const repo = files.get("ledger/repo.ts") as string;
    const [general, labelled] = [...repo.matchAll(INSERT_RE)].map((m) => m.index);
    const guard = repo.indexOf('throw new Error("usage_observation accepts only provider_reported rows (FR-CAP-01)")');
    const record = repo.indexOf("recordInnerCall(input, events) {");
    expect(guard).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(-1);
    // The first statement is the guarded general insert; the second is recordInnerCall's, the only one that writes
    // the label as a literal.
    expect(guard).toBeLessThan(general as number);
    expect(general as number).toBeLessThan(record);
    expect(record).toBeLessThan(labelled as number);
    expect(repo.slice(general, record)).not.toContain("'inner_agent'");
    expect(repo.slice(labelled, (labelled as number) + 400)).toContain("'inner_agent'");
  });
});

/**
 * Post-#501 pipeline residual. The channel pins (#482, #501) drove `PROJECT_OFF`, `REMOTE_NOT_ALLOWED` and
 * `CIRCUIT_OPEN` at the production callers; the two remaining rows of the LLD §13.5 gate table, `PROJECT_LOCAL_ONLY`
 * and `SOURCE_CONTENT_NOT_ALLOWED`, had their outcome pinned (`pipeline.test.ts`, the task tests) but never what they
 * write under the flag. A gate row is the one `inner_call` row written *after* the locality lookup and *before* the
 * redaction, so its shape is fixed: the resolved locality, nothing counted, nothing sent, no observation.
 */
describe("gate rows after the locality lookup (LLD §13.5 rows 3 and 5; T11.5, FR-INN-15)", () => {
  const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const countLookups = (counter: { n: number }) => (fake: InnerBackend) => ({
    ...fake,
    resolveLocality: (signal: AbortSignal) => {
      counter.n++;
      return fake.resolveLocality(signal);
    },
  });
  const gateShape = (c: Record<string, unknown>) => [
    c.outcome,
    c.reason,
    c.locality,
    c.attempts,
    c.latency_ms,
    c.input_bytes,
    c.output_bytes,
    c.input_sha256,
    c.tokens_in,
    c.tokens_out,
    c.model_id,
  ];

  it("PROJECT_LOCAL_ONLY is one lookup and a row at the resolved locality with no observation; PROJECT_OFF makes no lookup; local_only on a local backend charges", async () => {
    const lookups = { n: 0 };
    const h = setup([GOOD], {
      shares: "claude-code",
      allowRemote: true,
      locality: "remote",
      wrapBackend: countLookups(lookups),
    });
    const at = (project_setting: "off" | "local_only" | "inherit") =>
      h.svc.call(contract, { user: "objective: tidy", run_id: h.run.id, project_setting });
    expect(await at("off")).toMatchObject({ outcome: "fallback_disabled", reason: "PROJECT_OFF" });
    expect(lookups.n).toBe(0); // step 1: not even a name lookup for an `off` project
    expect(await at("local_only")).toMatchObject({ outcome: "fallback_disabled", reason: "PROJECT_LOCAL_ONLY" });
    expect(lookups.n).toBe(1); // the gate needs the locality, so this row is written after the lookup
    expect(h.fake.requests).toHaveLength(0);
    const calls = h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Record<string, unknown>[];
    // `PROJECT_OFF` carries the pipeline's initial `remote` (no lookup); `PROJECT_LOCAL_ONLY` the resolved one. Both
    // rows are otherwise the shape of a call that sent nothing: empty hash, zero bytes, counts unknown, configured model.
    expect(calls.map(gateShape)).toEqual([
      ["fallback_disabled", "PROJECT_OFF", "remote", 0, 0, 0, 0, EMPTY_SHA, null, null, "cfg-model"],
      ["fallback_disabled", "PROJECT_LOCAL_ONLY", "remote", 0, 0, 0, 0, EMPTY_SHA, null, null, "cfg-model"],
    ]);
    expect(h.usageRows()).toEqual([]);
    const events = h.db
      .prepare("SELECT type, payload_json FROM run_event WHERE run_id = ? ORDER BY seq")
      .all(h.run.id) as { type: string; payload_json: string }[];
    expect(events.map((e) => [e.type, JSON.parse(e.payload_json).reason, JSON.parse(e.payload_json).attempts])).toEqual(
      [
        ["inner_call", "PROJECT_OFF", 0],
        ["inner_call", "PROJECT_LOCAL_ONLY", 0],
      ],
    );
    // The setting, not the flag, was the cause: the same `local_only` project on a local backend is an ordinary call.
    h.fake.locality = "local";
    expect(await at("local_only")).toMatchObject({ accepted: true });
    expect(lookups.n).toBe(2);
    expect(h.fake.requests).toHaveLength(1);
    expect(h.ledger.listInnerCalls().map((c) => [c.reason, c.locality, c.attempts])).toEqual([
      ["PROJECT_OFF", "remote", 0],
      ["PROJECT_LOCAL_ONLY", "remote", 0],
      [null, "local", 1],
    ]);
    expect(h.usageRows().map((r) => [r.source, r.run_id, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", h.run.id, { input_tokens: 10, output_tokens: 4 }],
    ]);
  });

  it("SOURCE_CONTENT_NOT_ALLOWED keys on the contract's flag: the source-content task is a gate row with no observation, run_title on the same remote backend charges, and the opt-in lets the task charge at locality remote", async () => {
    const h = setup([GOOD, GOOD], {
      shares: "claude-code",
      allowRemote: true,
      locality: "remote",
      tasks: { log_summary: { enabled: true } }, // `allow_source_content` defaults to false
    });
    const sourceContract: InnerTaskContract<{ title: string }, { title: string }> = {
      ...contract,
      task: "log_summary",
      sends_source_content: true,
    };
    const user = "objective: tidy\n+++ b/example.ts\n+x";
    expect(await h.svc.call(sourceContract, { user, run_id: h.run.id })).toMatchObject({
      outcome: "fallback_disabled",
      reason: "SOURCE_CONTENT_NOT_ALLOWED",
    });
    expect(h.fake.requests).toHaveLength(0);
    expect(await h.svc.call(contract, { user, run_id: h.run.id })).toMatchObject({ accepted: true });
    expect(h.fake.requests).toHaveLength(1);
    const calls = h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Record<string, unknown>[];
    expect(calls.map((c) => [c.task, ...gateShape(c)])).toEqual([
      [
        "log_summary",
        "fallback_disabled",
        "SOURCE_CONTENT_NOT_ALLOWED",
        "remote",
        0,
        0,
        0,
        0,
        EMPTY_SHA,
        null,
        null,
        "cfg-model",
      ],
      [
        "run_title",
        "accepted",
        null,
        "remote",
        1,
        expect.any(Number),
        Buffer.byteLength(user),
        21,
        expect.any(String),
        10,
        4,
        "fake-model",
      ],
    ]);
    expect(calls[1]?.input_sha256).not.toBe(EMPTY_SHA);
    expect(h.usageRows().map((r) => [r.source, r.model, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", "fake-model", { input_tokens: 10, output_tokens: 4 }],
    ]);
    // With the per-task opt-in the same contract passes row 6 of the table and charges like any remote call.
    const optedIn = createInnerAgent(
      resolveInnerAgent({
        enabled: true,
        backend: {
          kind: "http",
          base_url: "http://127.0.0.1:1",
          model: "cfg-model",
          shares_subscription_with: "claude-code",
          allow_remote: true,
        },
        tasks: { log_summary: { enabled: true, allow_source_content: true } },
      }),
      { backend: h.fake, ledger: h.ledger },
    );
    expect(await optedIn.call(sourceContract, { user, run_id: h.run.id })).toMatchObject({ accepted: true });
    expect(h.fake.requests).toHaveLength(2);
    expect(h.ledger.listInnerCalls().map((c) => [c.task, c.reason, c.locality, c.attempts, c.tokens_in])).toEqual([
      ["log_summary", "SOURCE_CONTENT_NOT_ALLOWED", "remote", 0, null],
      ["run_title", null, "remote", 1, 10],
      ["log_summary", null, "remote", 1, 10],
    ]);
    expect(h.usageRows()).toHaveLength(2);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });

  it("a locality lookup that fails is remote (fail closed): with allow_remote the call charges at locality remote, without it the gate row writes nothing; the lookup's message reaches no row, event or log", async () => {
    const MESSAGE = "dns-failure-5b1c";
    const failingLookup = (fake: InnerBackend): InnerBackend => ({
      ...fake,
      resolveLocality: async () => {
        throw new Error(MESSAGE);
      },
    });
    const logs: InnerLogEntry[] = [];
    const allowed = setup([GOOD], {
      shares: "claude-code",
      allowRemote: true,
      locality: "local", // what the fake would have said: the failed lookup must not fall back to it
      wrapBackend: failingLookup,
      logger: (e) => logs.push(e),
    });
    expect(await allowed.call()).toMatchObject({ accepted: true });
    expect(allowed.ledger.listInnerCalls().map((c) => [c.locality, c.attempts, c.tokens_in, c.tokens_out])).toEqual([
      ["remote", 1, 10, 4],
    ]);
    expect(allowed.usageRows().map((r) => [r.source, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", { input_tokens: 10, output_tokens: 4 }],
    ]);
    const denied = setup([GOOD], {
      shares: "claude-code",
      allowRemote: false,
      locality: "local",
      wrapBackend: failingLookup,
      logger: (e) => logs.push(e),
    });
    expect(await denied.call()).toMatchObject({ outcome: "fallback_disabled", reason: "REMOTE_NOT_ALLOWED" });
    expect(denied.fake.requests).toHaveLength(0);
    expect(denied.ledger.listInnerCalls().map((c) => [c.locality, c.attempts, c.reason])).toEqual([
      ["remote", 0, "REMOTE_NOT_ALLOWED"],
    ]);
    expect(denied.usageRows()).toEqual([]);
    for (const h of [allowed, denied]) {
      expect(JSON.stringify(h.db.prepare("SELECT * FROM inner_call").all())).not.toContain(MESSAGE);
      expect(JSON.stringify(h.db.prepare("SELECT * FROM run_event").all())).not.toContain(MESSAGE);
    }
    expect(JSON.stringify(logs)).not.toContain(MESSAGE);
  });
});

/**
 * Re-ask aggregation beyond the summed counts. The sum (#317), the first attempt's counts surviving a timed-out re-ask
 * and a bogus first count making the total unknown (#491) are pinned; what the row and the labelled observation carry
 * when the re-ask *errors*, which model id a two-attempt call records, and which attempt's `output_bytes` is kept were
 * not. The last is an as-built choice: `tokens_*` are summed across attempts, `output_bytes` is the last attempt's.
 */
describe("re-ask aggregation: the erroring re-ask, the model id across attempts and output_bytes (T11.5; FR-INN-15)", () => {
  it("a re-ask whose request errors keeps the first attempt's counts and model under attempts 2, counts as the transport failure that opens the breaker, and the denial after it writes no observation", async () => {
    const h = setup([{ kind: "text", text: "bad", usage: { in: 7, out: 2 }, model_id: "model-a" }, { kind: "error" }], {
      shares: "claude-code",
      breaker: { failure_threshold: 1, open_ms: 60_000 },
    });
    expect(await h.call()).toMatchObject({ accepted: false, outcome: "fallback_unavailable", reason: "BACKEND_ERROR" });
    expect(h.fake.requests).toHaveLength(2);
    expect(h.svc.breakerState).toBe("open");
    expect(
      h.ledger
        .listInnerCalls()
        .map((c) => [c.outcome, c.attempts, c.tokens_in, c.tokens_out, c.model_id, c.output_bytes]),
    ).toEqual([["fallback_unavailable", 2, 7, 2, "model-a", 3]]);
    expect(h.usageRows().map((r) => [r.source, r.model, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", "model-a", { input_tokens: 7, output_tokens: 2 }],
    ]);
    const events = h.db
      .prepare("SELECT type, payload_json FROM run_event WHERE run_id = ? ORDER BY seq")
      .all(h.run.id) as { type: string; payload_json: string }[];
    expect(events.map((e) => e.type)).toEqual(["inner_call", "inner_degraded"]);
    expect(JSON.parse(events[1]?.payload_json ?? "")).toEqual({
      state: "degraded",
      reason: "BACKEND_ERROR",
      breaker_state: "open",
      backend_kind: "http",
    });
    expect(JSON.stringify(events)).not.toMatch(/tokens|fake backend error/u);
    expect(await h.call()).toMatchObject({ outcome: "fallback_unavailable", reason: "CIRCUIT_OPEN" });
    expect(h.ledger.listInnerCalls().map((c) => [c.reason, c.attempts])).toEqual([
      ["BACKEND_ERROR", 2],
      ["CIRCUIT_OPEN", 0],
    ]);
    expect(h.usageRows()).toHaveLength(1);
  });

  it("the recorded model is the last attempt that reported one, else the configured id; output_bytes is the last attempt's, tokens the sum", async () => {
    const big = JSON.stringify({ title: "x".repeat(400) }); // over run_title's 320-byte cap: too_long, re-asked
    const h = setup(
      [
        // call 1: the re-ask reports no model id, so the first attempt's stands
        { kind: "text", text: "bad", usage: { in: 1, out: 1 }, model_id: "model-a" },
        { kind: "text", text: '{"title":"Fix login"}', usage: { in: 2, out: 2 }, model_id: "" },
        // call 2: the re-ask reports another model: the last report stands
        { kind: "text", text: "bad", usage: { in: 1, out: 1 }, model_id: "model-a" },
        { kind: "text", text: '{"title":"Fix login"}', usage: { in: 2, out: 2 }, model_id: "model-b" },
        // call 3: one attempt reporting no model id: the configured one
        { kind: "text", text: '{"title":"Fix login"}', usage: { in: 1, out: 1 }, model_id: "" },
        // call 4: an oversized first answer, then a good one: bytes are the re-ask's, counts the sum
        { kind: "text", text: big, usage: { in: 5, out: 5 } },
        { kind: "text", text: '{"title":"Fix login"}', usage: { in: 2, out: 2 } },
        // call 5: rejected twice, the second answer shorter than the first
        { kind: "text", text: big, usage: { in: 5, out: 5 } },
        { kind: "text", text: "bad", usage: { in: 1, out: 1 } },
      ],
      { shares: "claude-code" },
    );
    for (let i = 0; i < 5; i++) await h.call();
    expect(
      h.ledger
        .listInnerCalls()
        .map((c) => [c.outcome, c.reason, c.attempts, c.model_id, c.tokens_in, c.tokens_out, c.output_bytes]),
    ).toEqual([
      ["accepted", null, 2, "model-a", 3, 3, 21],
      ["accepted", null, 2, "model-b", 3, 3, 21],
      ["accepted", null, 1, "cfg-model", 1, 1, 21],
      ["accepted", null, 2, "fake-model", 7, 7, 21],
      ["rejected_validator", "NOT_JSON", 2, "fake-model", 6, 6, 3],
    ]);
    expect(h.usageRows().map((r) => [r.model, JSON.parse(String(r.metrics_json))])).toEqual([
      ["model-a", { input_tokens: 3, output_tokens: 3 }],
      ["model-b", { input_tokens: 3, output_tokens: 3 }],
      ["cfg-model", { input_tokens: 1, output_tokens: 1 }],
      ["fake-model", { input_tokens: 7, output_tokens: 7 }],
      ["fake-model", { input_tokens: 6, output_tokens: 6 }],
    ]);
    expect(Buffer.byteLength(big)).toBeGreaterThan(320);
    expect(JSON.stringify(h.db.prepare("SELECT output_bytes FROM inner_call").all())).not.toContain(
      String(Buffer.byteLength(big)),
    );
  });
});

/**
 * Failures *after* the request. Every pin so far charged on `attempts >= 1` for transport outcomes and the validator;
 * the three outcomes the contract layer produces after a request was answered (`rejected_sanitiser`, `PERSIST_FAILED`
 * and a `PIPELINE_ERROR` thrown by a contract hook) had their outcome pinned in the task tests and nothing about their
 * accounting. The subscription was consumed whether or not the value was usable, so each writes one labelled row with
 * the reported counts; only the quality outcome counts in the suspension window; none moves the breaker.
 */
describe("post-request contract failures still charge the subscription (T11.5; FR-INN-15)", () => {
  it("rejected_sanitiser: counts and the labelled row like a validator rejection, and it is a quality outcome that can suspend the task", async () => {
    const h = setup([GOOD], {
      shares: "claude-code",
      suspension: { window_calls: 10, min_calls: 2, rejection_threshold: 0.4 },
      breaker: { failure_threshold: 1, open_ms: 60_000 },
    });
    const sanitising: InnerTaskContract<{ title: string }, { title: string }> = { ...contract, sanitise: () => null };
    const at = () => h.svc.call(sanitising, { user: "objective: tidy", run_id: h.run.id });
    expect(await at()).toMatchObject({
      accepted: false,
      outcome: "rejected_sanitiser",
      reason: "EMPTY_AFTER_SANITISER",
    });
    expect(h.svc.isSuspended("run_title")).toBe(false);
    expect(await at()).toMatchObject({ outcome: "rejected_sanitiser" }); // 2/2 > 0.4: suspends
    expect(h.svc.isSuspended("run_title")).toBe(true);
    expect(h.svc.breakerState).toBe("closed");
    expect(await at()).toMatchObject({ outcome: "fallback_suspended", reason: "TASK_SUSPENDED" });
    expect(h.fake.requests).toHaveLength(2);
    expect(
      h.ledger.listInnerCalls().map((c) => [c.outcome, c.attempts, c.tokens_in, c.tokens_out, c.output_bytes]),
    ).toEqual([
      ["rejected_sanitiser", 1, 10, 4, 21],
      ["rejected_sanitiser", 1, 10, 4, 21],
      ["fallback_suspended", 0, null, null, 0],
    ]);
    expect(h.usageRows().map((r) => [r.source, r.run_id, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", h.run.id, { input_tokens: 10, output_tokens: 4 }],
      ["inner_agent", h.run.id, { input_tokens: 10, output_tokens: 4 }],
    ]);
    expect(
      (
        h.db.prepare("SELECT type FROM run_event WHERE run_id = ? ORDER BY seq").all(h.run.id) as { type: string }[]
      ).map((e) => e.type),
    ).toEqual(["inner_call", "inner_call", "inner_task_suspended", "inner_call"]);
  });

  it("PERSIST_FAILED (a null or throwing persist): the value is withheld, the row charges at attempts 1 with the counts and no artifact, the window and the breaker are unmoved", async () => {
    const MESSAGE = "store-failure-9d4e";
    const logs: InnerLogEntry[] = [];
    const h = setup([GOOD], {
      shares: "claude-code",
      suspension: { window_calls: 10, min_calls: 2, rejection_threshold: 0.4 },
      breaker: { failure_threshold: 1, open_ms: 60_000 },
      logger: (e) => logs.push(e),
    });
    const persisting = (
      persist: () => Promise<string | null>,
    ): InnerTaskContract<{ title: string }, { title: string }> => ({
      ...contract,
      persist,
    });
    const nulled = await h.svc.call(
      persisting(async () => null),
      { user: "objective: tidy", run_id: h.run.id },
    );
    const thrown = await h.svc.call(
      persisting(async () => {
        throw new Error(MESSAGE);
      }),
      { user: "objective: tidy", run_id: h.run.id },
    );
    for (const r of [nulled, thrown]) {
      expect(r).toMatchObject({ accepted: false, outcome: "fallback_unavailable", reason: "PERSIST_FAILED" });
      expect(r.call_id).toEqual(expect.any(String));
      expect(JSON.stringify(r)).not.toContain("Fix login"); // the fallback, never the unstored value
    }
    expect(h.fake.requests).toHaveLength(2);
    expect(h.svc.breakerState).toBe("closed");
    expect(h.svc.isSuspended("run_title")).toBe(false); // not a quality outcome: 0/2 rejected
    expect(h.ledger.listInnerCalls().map((c) => [c.outcome, c.reason, c.attempts, c.tokens_in, c.tokens_out])).toEqual([
      ["fallback_unavailable", "PERSIST_FAILED", 1, 10, 4],
      ["fallback_unavailable", "PERSIST_FAILED", 1, 10, 4],
    ]);
    expect(h.usageRows().map((r) => [r.source, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", { input_tokens: 10, output_tokens: 4 }],
      ["inner_agent", { input_tokens: 10, output_tokens: 4 }],
    ]);
    const events = h.db
      .prepare("SELECT type, artifact_id, payload_json FROM run_event WHERE run_id = ? ORDER BY seq")
      .all(h.run.id) as { type: string; artifact_id: string | null; payload_json: string }[];
    expect(events.map((e) => [e.type, e.artifact_id, JSON.parse(e.payload_json).reason])).toEqual([
      ["inner_call", null, "PERSIST_FAILED"],
      ["inner_call", null, "PERSIST_FAILED"],
    ]);
    expect(JSON.stringify(events)).not.toContain("Fix login");
    expect(JSON.stringify([events, logs, h.ledger.listInnerCalls()])).not.toContain(MESSAGE);
  });

  it("a contract hook that throws after the answer (accept, validate) is PIPELINE_ERROR at attempts 1 with the counts and one labelled row; a throwing event_payload loses the record (as built) but never the value", async () => {
    const MESSAGE = "hook-failure-2a7c";
    const logs: InnerLogEntry[] = [];
    const h = setup([GOOD], { shares: "claude-code", logger: (e) => logs.push(e) });
    const boom = () => {
      throw new Error(MESSAGE);
    };
    const user = { user: "objective: tidy", run_id: h.run.id };
    expect(await h.svc.call({ ...contract, accept: boom }, user)).toMatchObject({
      accepted: false,
      outcome: "fallback_unavailable",
      reason: "PIPELINE_ERROR",
    });
    expect(await h.svc.call({ ...contract, validate: boom }, user)).toMatchObject({
      accepted: false,
      outcome: "fallback_unavailable",
      reason: "PIPELINE_ERROR",
    });
    expect(h.fake.requests).toHaveLength(2);
    expect(h.svc.breakerState).toBe("closed"); // a hook failure is not a transport failure
    expect(
      h.ledger.listInnerCalls().map((c) => [c.reason, c.attempts, c.tokens_in, c.tokens_out, c.output_bytes]),
    ).toEqual([
      ["PIPELINE_ERROR", 1, 10, 4, 21],
      ["PIPELINE_ERROR", 1, 10, 4, 21],
    ]);
    expect(h.usageRows().map((r) => [r.source, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", { input_tokens: 10, output_tokens: 4 }],
      ["inner_agent", { input_tokens: 10, output_tokens: 4 }],
    ]);
    expect(logs.filter((l) => l.event === "inner.pipeline_exception")).toHaveLength(2);
    // As built, `event_payload` runs inside the ledger write (`finish`), so a throw there is a record failure: the
    // subscription was consumed and the caller gets the accepted value, but no row, observation or event says so.
    // `event_payload` is controller code over a schema-validated value (`run_title`), never backend input; the pin
    // records the behaviour so a change to it is deliberate.
    const r = await h.svc.call({ ...contract, event_payload: boom }, user);
    expect(r).toMatchObject({ accepted: true, value: { title: "Fix login" } });
    expect(r.call_id).toBeUndefined();
    expect(h.fake.requests).toHaveLength(3);
    expect(h.ledger.listInnerCalls()).toHaveLength(2);
    expect(h.usageRows()).toHaveLength(2);
    expect(h.runEventCount()).toBe(2);
    expect(logs.filter((l) => l.event === "inner.record_failed")).toEqual([
      { event: "inner.record_failed", task: "run_title", outcome: "accepted" },
    ]);
    expect(logs.filter((l) => l.event === "inner.pipeline_exception")).toHaveLength(2);
    expect(
      JSON.stringify([logs, h.ledger.listInnerCalls(), h.db.prepare("SELECT * FROM run_event").all()]),
    ).not.toContain(MESSAGE);
  });
});

/**
 * The half-open probe (LLD §13.4 step 6). The breaker pins charge the calls that open the circuit and deny while it is
 * open; the probe that is let through once `open_ms` has passed is a request like any other and had no accounting pin:
 * a failed probe re-opens the circuit with a row and a labelled row with unknown counts and no second `inner_degraded`
 * event (still degraded, one transition per change), a successful probe charges with its counts and writes the
 * `recovered` transition with no count, and the call denied beside the probe writes a row with no observation.
 */
describe("the half-open probe is charged like any request (T11.5; FR-INN-15, LLD §13.4 step 6)", () => {
  it("failed probe: one labelled row with unknown counts and no new transition; successful probe: counts and the recovered event; the call denied beside it: no observation", async () => {
    const clock = { t: 1_000_000 };
    const h = setup([{ kind: "error" }], {
      shares: "claude-code",
      breaker: { failure_threshold: 1, open_ms: 1000 },
      maxConcurrency: 2,
      breakerNow: () => clock.t,
    });
    expect(await h.call()).toMatchObject({ reason: "BACKEND_ERROR" }); // opens
    expect(h.svc.breakerState).toBe("open");
    clock.t += 1000;
    expect(await h.call()).toMatchObject({ reason: "BACKEND_ERROR" }); // the probe fails: open again, timer restarted
    expect(h.svc.breakerState).toBe("open");
    expect(await h.call()).toMatchObject({ reason: "CIRCUIT_OPEN" }); // the restarted timer has not run out
    clock.t += 1000;
    h.fake.setScript([{ kind: "text", text: '{"title":"probe"}', usage: { in: 3, out: 1 }, delay_ms: 150 }]);
    const [a, b] = await Promise.all([h.call(), h.call()]);
    const probe = [a, b].find((r) => r.accepted);
    const denied = [a, b].find((r) => !r.accepted);
    expect(probe).toMatchObject({ accepted: true, value: { title: "probe" } });
    expect(denied).toMatchObject({ outcome: "fallback_unavailable", reason: "CIRCUIT_OPEN" });
    expect(h.svc.breakerState).toBe("closed");
    expect(h.fake.requests).toHaveLength(3); // open, failed probe, successful probe
    const calls = h.ledger.listInnerCalls().map((c) => [c.reason, c.attempts, c.tokens_in, c.tokens_out] as const);
    // The denied call records before the probe (it was decided at once; the probe waited on the fake's delay).
    expect(calls).toEqual([
      ["BACKEND_ERROR", 1, null, null],
      ["BACKEND_ERROR", 1, null, null],
      ["CIRCUIT_OPEN", 0, null, null],
      ["CIRCUIT_OPEN", 0, null, null],
      [null, 1, 3, 1],
    ]);
    expect(h.usageRows().map((r) => [r.source, JSON.parse(String(r.metrics_json))])).toEqual([
      ["inner_agent", {}],
      ["inner_agent", {}],
      ["inner_agent", { input_tokens: 3, output_tokens: 1 }],
    ]);
    expect(h.usageRows()).toHaveLength(calls.filter((c) => c[1] >= 1).length);
    const events = h.db
      .prepare("SELECT type, payload_json FROM run_event WHERE run_id = ? ORDER BY seq")
      .all(h.run.id) as { type: string; payload_json: string }[];
    expect(events.map((e) => e.type)).toEqual([
      "inner_call",
      "inner_degraded",
      "inner_call", // the failed probe: still degraded, no second transition
      "inner_call",
      "inner_call",
      "inner_call",
      "inner_degraded",
    ]);
    expect(events.filter((e) => e.type === "inner_degraded").map((e) => JSON.parse(e.payload_json))).toEqual([
      { state: "degraded", reason: "BACKEND_ERROR", breaker_state: "open", backend_kind: "http" },
      { state: "recovered", reason: "", breaker_state: "closed", backend_kind: "http" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/tokens|fake backend error/u);
  });
});
