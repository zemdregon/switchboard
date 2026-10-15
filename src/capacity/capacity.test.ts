import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLedger, type Ledger, openLedger, type RunState } from "../ledger/index.js";
import { RECONCILE_CAUSE } from "../reconcile/reconcile.js";
import {
  CAPACITY_NOTE,
  type CapacityInputs,
  type CapacityProviderInfo,
  capacityJson,
  capacityProjection,
  collectCapacityInputs,
  estimateCapacity,
  REMAINING_KEYS,
  RESTART_MARKER,
} from "./index.js";

const SETTINGS = { windowSeconds: 3600, confidenceRuns: 10 };
const NOW = new Date("2026-10-14T12:00:00.000Z");

const inputs = (over: Partial<CapacityInputs> = {}): CapacityInputs => ({
  provider: "fake",
  enabled: true,
  weight: null,
  runs: [],
  rateLimitSignals: [],
  usage: [],
  breaker: { state: "CLOSED", until: null, consecutiveFailures: 0 },
  slots: { inUse: 0, limit: 1 },
  ...over,
});
const ok = { state: "SUCCEEDED" as const, failureCode: null, started: true, controllerRestart: false };
const failed = (code: string, extra: Partial<typeof ok> = {}) => ({
  ...ok,
  state: "FAILED" as const,
  failureCode: code,
  ...extra,
});

describe("estimateCapacity (T6.2, LLD §16.2)", () => {
  it("no evidence: unknown, null score, confidence 0, never headroom; only the slot count is a source", () => {
    const e = estimateCapacity(inputs(), SETTINGS, NOW);
    expect(e).toMatchObject({
      capacity_score: null,
      confidence: 0,
      throttle_risk: "unknown",
      estimate_source: "controller_estimated",
      explicit_remaining: null,
      reset_at: null,
      sources: ["controller:concurrency"],
      concurrency_available: 1,
      concurrency_limit: 1,
    });
    // A weight alone is a prior, not evidence.
    expect(estimateCapacity(inputs({ weight: 0.8 }), SETTINGS, NOW).capacity_score).toBeNull();
    // A cancelled or pre-spawn run is not evidence either.
    const notStarted = { ...failed("AUTH_REQUIRED"), started: false };
    expect(estimateCapacity(inputs({ runs: [notStarted] }), SETTINGS, NOW).throttle_risk).toBe("unknown");
  });

  it("healthy runs: low risk, score = weight prior (1 when unset), confidence scales with runs", () => {
    const e = estimateCapacity(inputs({ runs: [ok, ok, ok] }), SETTINGS, NOW);
    expect(e).toMatchObject({ throttle_risk: "low", capacity_score: 1, confidence: 0.3 });
    expect(e.sources).toEqual(["controller:concurrency", "controller:run_outcomes"]);
    const w = estimateCapacity(inputs({ runs: [ok], weight: 0.6 }), SETTINGS, NOW);
    expect(w).toMatchObject({ capacity_score: 0.6, confidence: 0.1 });
    expect(w.sources).toContain("operator:weight");
    const many = estimateCapacity(inputs({ runs: Array(25).fill(ok) }), SETTINGS, NOW);
    expect(many.confidence).toBe(1);
    // Test and tool failures after spawn are healthy for capacity.
    expect(estimateCapacity(inputs({ runs: [failed("TEST_FAILURE")] }), SETTINGS, NOW).throttle_risk).toBe("low");
  });

  it("rate-limit and overload failures, or a rate_limit signal, give elevated risk and half the prior", () => {
    for (const code of ["RATE_LIMIT_TRANSIENT", "PROVIDER_OVERLOADED"]) {
      const e = estimateCapacity(inputs({ runs: [ok, failed(code)], weight: 0.8 }), SETTINGS, NOW);
      expect(e).toMatchObject({ throttle_risk: "elevated", capacity_score: 0.4, confidence: 0.2 });
      expect(e.window.counted_failures).toBe(1);
    }
    const signal = estimateCapacity(inputs({ rateLimitSignals: [{ resetAt: null }] }), SETTINGS, NOW);
    expect(signal).toMatchObject({ throttle_risk: "elevated", capacity_score: 0.5, confidence: 0 });
    expect(signal.sources).toContain("provider_reported:rate_limit");
  });

  it("quota exhaustion gives high risk and score 0; a future reported reset gives confidence 1 and reset_at", () => {
    const q = estimateCapacity(inputs({ runs: [ok, failed("QUOTA_EXHAUSTED")] }), SETTINGS, NOW);
    expect(q).toMatchObject({ throttle_risk: "high", capacity_score: 0, confidence: 0.2, reset_at: null });
    expect(q.window.quota_exhausted).toBe(1);

    const future = "2026-10-14T13:30:00Z";
    const r = estimateCapacity(
      inputs({ rateLimitSignals: [{ resetAt: "2026-10-14T12:30:00.000Z" }, { resetAt: future }] }),
      SETTINGS,
      NOW,
    );
    expect(r).toMatchObject({
      throttle_risk: "high",
      capacity_score: 0,
      confidence: 1,
      reset_at: { at: "2026-10-14T13:30:00.000Z", source: "provider_reported" },
    });
    // A reset in the past, or an unparseable one, is not a reset.
    const past = estimateCapacity(
      inputs({ rateLimitSignals: [{ resetAt: "2026-10-14T11:00:00Z" }, { resetAt: "soon" }] }),
      SETTINGS,
      NOW,
    );
    expect(past).toMatchObject({ throttle_risk: "elevated", reset_at: null });
  });

  it("an open or half-open breaker gives high risk with confidence 1, labelled controller:breaker", () => {
    for (const state of ["OPEN", "HALF_OPEN"] as const) {
      const e = estimateCapacity(
        inputs({ breaker: { state, until: "2026-10-14T12:05:00.000Z", consecutiveFailures: 3 } }),
        SETTINGS,
        NOW,
      );
      expect(e).toMatchObject({ throttle_risk: "high", capacity_score: 0, confidence: 1 });
      expect(e.breaker).toEqual({ state, until: "2026-10-14T12:05:00.000Z", consecutive_failures: 3 });
      expect(e.sources).toContain("controller:breaker");
    }
  });

  it("slots: available = limit - in use, never negative", () => {
    expect(estimateCapacity(inputs({ slots: { inUse: 1, limit: 3 } }), SETTINGS, NOW).concurrency_available).toBe(2);
    expect(estimateCapacity(inputs({ slots: { inUse: 5, limit: 3 } }), SETTINGS, NOW).concurrency_available).toBe(0);
  });

  it("a crash recorded by reconciliation after a controller restart is not a counted failure", () => {
    const restart = failed("PROCESS_CRASH", { controllerRestart: true });
    expect(estimateCapacity(inputs({ runs: [restart] }), SETTINGS, NOW).window.counted_failures).toBe(0);
    expect(estimateCapacity(inputs({ runs: [failed("PROCESS_CRASH")] }), SETTINGS, NOW).window.counted_failures).toBe(
      1,
    );
  });

  it("explicit_remaining is null for every input without a declared key (property over generated inputs)", () => {
    expect(REMAINING_KEYS).toEqual({});
    expect(Object.isFrozen(REMAINING_KEYS)).toBe(true);
    // Deterministic generator (mulberry32) so a failure reproduces.
    let seed = 0x5eed;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const keys = [
      "remaining",
      "quota_remaining",
      "remaining_fraction",
      "usage.remaining",
      "explicit_remaining",
      "left",
    ];
    const providers = ["fake", "claude", "codex", "grok", "antigravity", "cursor", "opencode"];
    const codes = [null, "RATE_LIMIT_TRANSIENT", "QUOTA_EXHAUSTED", "PROCESS_CRASH", "TEST_FAILURE"];
    for (let i = 0; i < 500; i++) {
      const usage = Array.from({ length: Math.floor(rnd() * 4) }, () => ({
        metrics: Object.fromEntries(keys.filter(() => rnd() < 0.5).map((k) => [k, Math.floor(rnd() * 1e6)])),
        observedAt: NOW.toISOString(),
      }));
      const runs = Array.from({ length: Math.floor(rnd() * 5) }, () => {
        const code = pick(codes);
        return code === null ? ok : failed(code);
      });
      const e = estimateCapacity(
        inputs({ provider: pick(providers), usage, runs, weight: rnd() < 0.5 ? null : rnd() }),
        SETTINGS,
        NOW,
      );
      expect(e.explicit_remaining).toBeNull();
      if (e.capacity_score !== null) {
        expect(e.capacity_score).toBeGreaterThanOrEqual(0);
        expect(e.capacity_score).toBeLessThanOrEqual(1);
      }
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("capacity projection over the ledger (T6.2, LLD §16.2 and §16.3)", () => {
  let dir: string;
  let db: Database.Database;
  let ledger: Ledger;
  const fake: CapacityProviderInfo = { id: "fake", enabled: true, weight: null, concurrencyLimit: 2 };
  const other: CapacityProviderInfo = { id: "fake-b", enabled: false, weight: 0.5, concurrencyLimit: 1 };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sb-capacity-"));
    db = openLedger(dir);
    ledger = createLedger(db, { now: () => NOW });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (
    provider: string,
    state: RunState,
    opts: { code?: string; detail?: string; finishedAt?: string; started?: boolean } = {},
  ): string => {
    const ms = ledger.createMetaSession({ objective: "o", constraints: [] });
    const r = ledger.createRun({
      metaSessionId: ms.id,
      trustProfile: "inspect-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c",
      provider,
    });
    db.prepare(
      `UPDATE run SET state = ?, failure_code = ?, failure_detail = ?, started_at = ?, finished_at = ? WHERE id = ?`,
    ).run(
      state,
      opts.code ?? null,
      opts.detail ?? null,
      opts.started === false ? null : "2026-10-14T11:50:00.000Z",
      ["SUCCEEDED", "FAILED", "CANCELLED"].includes(state) ? (opts.finishedAt ?? "2026-10-14T11:55:00.000Z") : null,
      r.id,
    );
    return r.id;
  };
  const project = () => capacityProjection(ledger, [fake, other], SETTINGS, NOW);

  it("an empty ledger: every provider unknown, in the order given, with the note and as_of", () => {
    const p = project();
    expect(p).toMatchObject({ as_of: NOW.toISOString(), window_seconds: 3600, note: CAPACITY_NOTE });
    expect(p.providers.map((x) => [x.provider, x.enabled, x.throttle_risk, x.capacity_score, x.confidence])).toEqual([
      ["fake", true, "unknown", null, 0],
      ["fake-b", false, "unknown", null, 0],
    ]);
    expect(p.providers[0]?.concurrency_available).toBe(2);
  });

  it("reads runs inside the window only, rate_limit events, slots and the breaker row", () => {
    run("fake", "SUCCEEDED");
    run("fake", "FAILED", { code: "RATE_LIMIT_TRANSIENT" });
    run("fake", "SUCCEEDED", { finishedAt: "2026-10-14T10:00:00.000Z" }); // outside the 1 h window
    run("fake", "RUNNING");
    const limited = run("fake", "FAILED", { code: "RATE_LIMIT_TRANSIENT" });
    ledger.appendRunEvent({
      runId: limited,
      type: "provider_event",
      payload: { kind: "rate_limit", reset_at: "2026-10-14T12:20:00.000Z" },
    });
    ledger.appendRunEvent({ runId: limited, type: "provider_event", payload: { kind: "tool_call", tool: "Read" } });
    run("fake-b", "FAILED", { code: "PROCESS_CRASH", detail: "x (cause controller_restart)" });
    db.prepare(
      `INSERT INTO provider_health (provider, auth_state, version_state, breaker_state, breaker_until,
         consecutive_failures, updated_at) VALUES ('fake-b', 'UNKNOWN', 'UNVERIFIED', 'OPEN', ?, 3, ?)`,
    ).run("2026-10-14T12:05:00.000Z", NOW.toISOString());

    const [a, b] = project().providers;
    expect(a).toMatchObject({
      throttle_risk: "high",
      capacity_score: 0,
      confidence: 1,
      reset_at: { at: "2026-10-14T12:20:00.000Z", source: "provider_reported" },
      concurrency_available: 1,
      window: { terminal_runs: 3, counted_failures: 2, rate_limit_signals: 1, quota_exhausted: 0 },
    });
    expect(b).toMatchObject({
      throttle_risk: "high",
      breaker: { state: "OPEN", until: "2026-10-14T12:05:00.000Z", consecutive_failures: 3 },
      window: { terminal_runs: 1, counted_failures: 0 },
    });
  });

  it("the restart marker equals the one reconciliation writes", () => {
    expect(RESTART_MARKER).toBe(`cause ${RECONCILE_CAUSE}`);
  });

  it("is deterministic: the same ledger and clock give byte-identical canonical JSON", () => {
    run("fake", "SUCCEEDED");
    run("fake", "FAILED", { code: "PROVIDER_OVERLOADED" });
    expect(capacityJson(project())).toBe(capacityJson(project()));
  });

  it("inner-agent calls change nothing, with or without shared subscription (BR-41, FR-INN-15; closes the T11.5 clause)", () => {
    const r = run("fake", "SUCCEEDED");
    ledger.insertUsageObservation({
      runId: r,
      provider: "fake",
      harness: "fake",
      source: "provider_reported",
      metrics: { "usage.input_tokens": 10 },
    });
    const before = capacityJson(project());
    expect(JSON.parse(before).providers[0].window.usage_observations).toBe(1);

    // 1. Without shared subscription: recorded in inner_call only, usage_observation untouched.
    for (let i = 0; i < 3; i++) {
      ledger.recordInnerCall({
        task: "run_title",
        backend_kind: "http",
        model_id: "m",
        locality: "local",
        template_version: "1",
        outcome: "accepted",
        reason: null,
        attempts: 1,
        latency_ms: 5,
        tokens_in: 100,
        tokens_out: 10,
        input_bytes: 10,
        output_bytes: 5,
        input_sha256: "0".repeat(64),
        run_id: i === 0 ? r : null,
        meta_session_id: null,
      });
    }
    const innerUnshared = db
      .prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'inner_agent'")
      .get() as {
      n: number;
    };
    expect(innerUnshared.n).toBe(0);
    expect(capacityJson(project())).toBe(before);

    // 2. With shared subscription naming the provider: labelled observations written, capacity remains byte-identical.
    for (let i = 0; i < 3; i++) {
      ledger.recordInnerCall(
        {
          task: "run_title",
          backend_kind: "http",
          model_id: "m",
          locality: "local",
          template_version: "1",
          outcome: "accepted",
          reason: null,
          attempts: 1,
          latency_ms: 5,
          tokens_in: 100,
          tokens_out: 10,
          input_bytes: 10,
          output_bytes: 5,
          input_sha256: "0".repeat(64),
          run_id: i === 0 ? r : null,
          meta_session_id: null,
        },
        { sharedSubscriptionWith: "fake" },
      );
    }
    const innerShared = db
      .prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'inner_agent'")
      .get() as {
      n: number;
    };
    expect(innerShared.n).toBe(3);
    expect(capacityJson(project())).toBe(before);

    // 3. With shared subscription naming another provider: neither provider's capacity changes.
    ledger.recordInnerCall(
      {
        task: "run_title",
        backend_kind: "http",
        model_id: "m",
        locality: "local",
        template_version: "1",
        outcome: "accepted",
        reason: null,
        attempts: 1,
        latency_ms: 5,
        tokens_in: 50,
        tokens_out: 5,
        input_bytes: 10,
        output_bytes: 5,
        input_sha256: "0".repeat(64),
        run_id: null,
        meta_session_id: null,
      },
      { sharedSubscriptionWith: "fake-b" },
    );
    expect(capacityJson(project())).toBe(before);
  });

  it("collectCapacityInputs ignores inner_agent and controller_estimated observations (BR-41, FR-INN-15)", () => {
    const r = run("fake", "SUCCEEDED");
    ledger.insertUsageObservation({
      runId: r,
      provider: "fake",
      harness: "fake",
      source: "provider_reported",
      metrics: { "usage.input_tokens": 100 },
    });
    db.prepare(
      `INSERT INTO usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json, observed_at)
       VALUES (?, ?, 'fake', 'fake', NULL, NULL, 'controller_estimated', ?, ?)`,
    ).run("use-est", r, JSON.stringify({ "usage.input_tokens": 500 }), NOW.toISOString());
    ledger.recordInnerCall(
      {
        task: "run_title",
        backend_kind: "http",
        model_id: "m",
        locality: "local",
        template_version: "1",
        outcome: "accepted",
        reason: null,
        attempts: 1,
        latency_ms: 5,
        tokens_in: 250,
        tokens_out: 25,
        input_bytes: 10,
        output_bytes: 5,
        input_sha256: "0".repeat(64),
        run_id: r,
        meta_session_id: null,
      },
      { sharedSubscriptionWith: "fake" },
    );
    const inputs = collectCapacityInputs(ledger, fake, SETTINGS.windowSeconds, NOW);
    expect(inputs.usage).toEqual([
      {
        metrics: { "usage.input_tokens": 100 },
        observedAt: "2026-10-14T12:00:00.000Z",
      },
    ]);
  });

  it("excludes inner_agent rows by source alone: a provider-shaped, in-window, huge-count row changes nothing (ADR-0007)", () => {
    // The collector's filter is `source = 'provider_reported'` (collect.ts), not the metric keys or the figure. An
    // inner_agent row written with the very key names a provider-reported row uses, a remaining-style key, and a
    // count large enough to dominate any estimate still leaves the projection byte-identical and the usage input
    // unchanged; nothing in the projection names the inner agent as a source.
    const r = run("fake", "SUCCEEDED");
    ledger.insertUsageObservation({
      runId: r,
      provider: "fake",
      harness: "fake",
      source: "provider_reported",
      metrics: { "usage.input_tokens": 100, "usage.output_tokens": 20 },
    });
    const before = capacityJson(project());
    expect(JSON.parse(before).providers[0].window.usage_observations).toBe(1);
    const insert = db.prepare(
      `INSERT INTO usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json, observed_at)
       VALUES (?, ?, 'fake', 'fake', NULL, 'm', 'inner_agent', ?, ?)`,
    );
    insert.run(
      "use-inner-shaped",
      r,
      JSON.stringify({ "usage.input_tokens": 2 ** 53 - 1, "usage.output_tokens": 2 ** 53 - 1, remaining: 0 }),
      NOW.toISOString(),
    );
    insert.run("use-inner-null-run", null, JSON.stringify({ "usage.input_tokens": 1 }), NOW.toISOString());
    expect(collectCapacityInputs(ledger, fake, SETTINGS.windowSeconds, NOW).usage).toEqual([
      { metrics: { "usage.input_tokens": 100, "usage.output_tokens": 20 }, observedAt: NOW.toISOString() },
    ]);
    const after = capacityJson(project());
    expect(after).toBe(before);
    expect(JSON.parse(after).providers[0]).toMatchObject({ capacity_score: 1, explicit_remaining: null });
    const sources = (JSON.parse(after) as { providers: { sources: string[] }[] }).providers.flatMap((p) => p.sources);
    expect(sources).toContain("controller:run_outcomes");
    expect(sources.filter((s) => /inner/u.test(s))).toEqual([]);
  });
});
