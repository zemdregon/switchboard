/**
 * T11.5 (FR-INN-15, ADR-0007, LLD §13.4 step 13): inner-agent usage is recorded in `inner_call` only. Nothing reaches
 * `usage_observation`, provider health or what the envelope reports as usage, unless the operator declared
 * `shares_subscription_with`, in which case each call that reached the backend adds exactly one `inner_agent` row.
 * Scripted fake backend only; no network, no provider CLI. The `get_capacity` and `switchboard capacity` surfaces are
 * covered in `usage-surfaces.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
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
  createInnerAgent,
  type FakeStep,
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
  breaker?: { failure_threshold: number; open_ms: number };
  suspension?: { window_calls: number; min_calls: number; rejection_threshold: number };
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
    },
    tasks: { run_title: { enabled: true } },
    ...(opts.breaker !== undefined ? { breaker: opts.breaker } : {}),
    ...(opts.suspension !== undefined ? { suspension: opts.suspension } : {}),
  });
  const svc = createInnerAgent(settings, {
    backend: createFakeBackend({ script, ...(opts.locality !== undefined ? { locality: opts.locality } : {}) }),
    ledger,
  });
  const call = () => svc.call(contract, { user: "objective: tidy", run_id: run.id });
  const usageRows = () =>
    db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Record<string, unknown>[];
  /** Every usage-related table and read model, serialised, for a byte comparison. */
  const snapshot = () =>
    JSON.stringify({
      usage: usageRows(),
      health: db.prepare("SELECT * FROM provider_health ORDER BY provider").all(),
      forRun: ledger.listUsageObservationsForRun(run.id),
    });
  return { db, ledger, run, svc, call, snapshot, usageRows };
}

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
