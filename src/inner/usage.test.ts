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
  tasks?: Record<string, { enabled: boolean; timeout_ms?: number }>;
  breaker?: { failure_threshold: number; open_ms: number };
  suspension?: { window_calls: number; min_calls: number; rejection_threshold: number };
  /** Wraps the scripted fake (e.g. to slow `resolveLocality`); receives the fake built from `script`. */
  wrapBackend?: (fake: InnerBackend) => InnerBackend;
  logger?: (e: InnerLogEntry) => void;
}

function setup(script: readonly FakeStep[], opts: SetupOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-usage-"));
  dirs.push(dir);
  const db = openLedger(dir);
  dbs.push(db);
  const ledger = createLedger(db, { ids: createIdGenerator() });
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
  return { db, ledger, run, settings, backend, svc, call, snapshot, usageRows, runEventCount };
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
