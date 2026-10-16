/**
 * T14.4 (FR-CTL-06, FR-CAP-04, NFR-PERF-03, ADR-0007; LLD §3.4.3, §3.4.6): operator budget caps evaluated over planted
 * ledger rows at an injected clock. At each of the four caps admission is refused with the needs-attention reason
 * `budget_exhausted`; an unset cap is reported as unset (`limit: null`), never as a number; refusal text and status
 * carry operator wording only, never a provider limit. No provider CLI, no network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BudgetSettings } from "../config/budgets.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type RunState } from "../ledger/index.js";
import { buildEnvelope } from "../mcp/envelope.js";
import {
  BudgetEvaluator,
  type BudgetRefusal,
  budgetControlFacts,
  budgetRefusalDetails,
  budgetRefusalMessage,
  budgetStatusFor,
  registerBudgets,
  reportedTokens,
  utcDayWindow,
} from "./budgets.js";
import { needsAttentionOf } from "./needs-attention.js";

const T0 = Date.parse("2026-10-16T10:00:00.000Z");
let dir: string;
let db: Database.Database;
let ledger: Ledger;
let clock: number;
const now = () => new Date(clock);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-budgets-"));
  db = openLedger(dir);
  clock = T0;
  ledger = createLedger(db, { ids: createIdGenerator(), now });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const settings = (global: BudgetSettings["global"] = {}, projects: Record<string, BudgetSettings["global"]> = {}) =>
  ({ global, projects: new Map(Object.entries(projects)) }) satisfies BudgetSettings;
const evaluator = (s: BudgetSettings) => new BudgetEvaluator({ ledger, settings: s, now });

/** A run row planted in `state` for `projectId` (null: a workspace-path run), created at the current clock. */
function run(state: RunState, projectId: string | null = "web", startedSecondsAgo?: number): RunRecord {
  const session = ledger.createMetaSession({ objective: "o", projectId });
  const created = ledger.createRun({
    metaSessionId: session.id,
    state: state === "SUCCEEDED" ? "RUNNING" : state,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "orch",
    projectId,
  });
  if (startedSecondsAgo !== undefined) {
    ledger.updateRunFields(
      created.id,
      { started_at: new Date(clock - startedSecondsAgo * 1000).toISOString() },
      { type: "test_started" },
    );
  }
  if (state === "SUCCEEDED") {
    ledger.casRunState({
      runId: created.id,
      from: "RUNNING",
      to: "SUCCEEDED",
      expectedVersion: created.version,
      payload: { to: "SUCCEEDED" },
    });
  }
  return ledger.getRunRecord(created.id) as RunRecord;
}

const finish = (r: RunRecord) => {
  const fresh = ledger.getRunRecord(r.id) as RunRecord;
  ledger.casRunState({
    runId: r.id,
    from: fresh.state,
    to: "CANCELLED",
    expectedVersion: fresh.version,
    payload: { to: "CANCELLED" },
  });
};

const usage = (r: RunRecord, metrics: Record<string, number | string | null>) =>
  ledger.insertUsageObservation({
    runId: r.id,
    provider: "fake",
    harness: "fake",
    source: "provider_reported",
    metrics,
  });

const PROVIDER_LIMIT_WORDS = /provider|quota|\btpm\b|\brpm\b|subscription|rate.?limit|remaining/i;

describe("at each cap admission is refused with the needs-attention reason (T14.4, FR-CTL-06)", () => {
  it("runs_per_day: the cap counts run rows created this UTC day in the scope and resets at UTC midnight", () => {
    const b = evaluator(settings({}, { web: { runsPerDay: 2 } }));
    clock = T0 - 86_400_000; // yesterday's run never counts
    run("SUCCEEDED");
    clock = T0;
    expect(b.refusal("web", now())).toBeUndefined();
    run("SUCCEEDED");
    run("AWAITING_APPROVAL"); // every admitted row counts, whatever its state
    const refusal = b.refusal("web", now());
    expect(refusal).toEqual({
      scope: "project",
      project_id: "web",
      cap: "runs_per_day",
      limit: 2,
      used: 2,
      window_ends_at: "2026-10-17T00:00:00.000Z",
    });
    expect(budgetRefusalDetails(refusal as BudgetRefusal)).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      needs_attention_reason: "budget_exhausted",
      cap: "runs_per_day",
    });
    expect(b.refusal("api", now())).toBeUndefined(); // another project, no override, no global cap
    clock = Date.parse("2026-10-17T00:00:00.000Z");
    expect(b.refusal("web", now())).toBeUndefined(); // the day rolled over: cleared by itself, nothing stored
    expect(utcDayWindow(new Date("2026-10-16T23:59:59.999Z"))).toEqual({
      start: "2026-10-16T00:00:00.000Z",
      end: "2026-10-17T00:00:00.000Z",
    });
  });

  it("concurrent_runs: non-terminal runs in the scope hold the cap until one ends", () => {
    const b = evaluator(settings({ concurrentRuns: 1 }));
    const running = run("RUNNING", null); // a workspace-path run counts toward the global cap
    expect(b.refusal(undefined, now())).toEqual({
      scope: "global",
      project_id: "*",
      cap: "concurrent_runs",
      limit: 1,
      used: 1,
      window_ends_at: null,
    });
    expect(b.refusal("web", now())?.cap).toBe("concurrent_runs"); // the global cap applies to every project
    finish(running);
    expect(b.refusal("web", now())).toBeUndefined();
    run("SUCCEEDED"); // a terminal run never counts
    expect(b.refusal(undefined, now())).toBeUndefined();
  });

  it("wall_clock_per_run: a run in the scope past the cap since LEASED refuses admission until it ends", () => {
    const b = evaluator(settings({}, { web: { wallClockPerRunSeconds: 60 } }));
    run("RUNNING", "web", 30);
    expect(b.refusal("web", now())).toBeUndefined();
    const slow = run("RUNNING", "web", 61);
    expect(b.refusal("web", now())).toEqual({
      scope: "project",
      project_id: "web",
      cap: "wall_clock_per_run",
      limit: 60,
      used: 61,
      window_ends_at: null,
      run_id: slow.id,
    });
    run("RUNNING", "api", 600); // another project's run is outside the override's scope
    expect(b.refusal("api", now())).toBeUndefined();
    finish(slow);
    expect(b.refusal("web", now())).toBeUndefined();
    run("QUEUED", "web"); // not started: no wall clock yet
    expect(b.refusal("web", now())).toBeUndefined();
  });

  it("usage_per_window: provider-reported tokens in the rolling window; clears as observations age out", () => {
    const b = evaluator(settings({ usagePerWindow: { windowSeconds: 3600, maxReportedTokens: 100 } }));
    const r = run("SUCCEEDED");
    clock = T0 - 20 * 60_000;
    usage(r, { input_tokens: 30, output_tokens: 20, model: "m" }); // 50: summed `*_tokens`, the string ignored
    clock = T0 - 10 * 60_000;
    usage(r, { total_tokens: 60, input_tokens: 999 }); // 60: `total_tokens` wins over the parts
    db.prepare(
      `INSERT INTO usage_observation (id, run_id, provider, harness, source, metrics_json, observed_at)
       VALUES ('use_est', ?, 'fake', 'fake', 'controller_estimated', '{"total_tokens":100000}', ?)`,
    ).run(r.id, now().toISOString()); // an estimate is never budget usage
    clock = T0;
    expect(b.refusal("web", now())).toEqual({
      scope: "global",
      project_id: "*",
      cap: "usage_per_window",
      limit: 100,
      used: 110,
      window_ends_at: new Date(T0 - 20 * 60_000 + 3600_000).toISOString(),
    });
    clock = T0 + 41 * 60_000; // the first observation left the window: 60 < 100
    expect(b.refusal("web", now())).toBeUndefined();
    expect(b.globalStatus(now()).caps.find((c) => c.key === "usage_per_window")).toEqual({
      key: "usage_per_window",
      limit: 100,
      used: 60,
      window_ends_at: new Date(T0 - 10 * 60_000 + 3600_000).toISOString(),
    });
  });

  it("reportedTokens: total_tokens first, else every `tokens`/`*_tokens` number; anything else counts nothing", () => {
    expect(reportedTokens('{"total_tokens": 12.7, "input_tokens": 5}')).toBe(12);
    expect(reportedTokens('{"tokens": 3, "cache_read_tokens": 4, "thinking_tokens": 5, "cost_usd": 9, "x": "7"}')).toBe(
      12,
    );
    expect(reportedTokens('{"input_tokens": -1, "output_tokens": null}')).toBe(0);
    expect(reportedTokens("not json")).toBe(0);
    expect(reportedTokens("[1]")).toBe(0);
  });

  it("a project override and the global cap are both enforced: the project's own count first, then every run", () => {
    const b = evaluator(settings({ runsPerDay: 3 }, { web: { runsPerDay: 1 } }));
    run("SUCCEEDED", "web");
    expect(b.refusal("web", now())).toMatchObject({ scope: "project", project_id: "web", used: 1, limit: 1 });
    expect(b.refusal("api", now())).toBeUndefined();
    run("SUCCEEDED", "api");
    run("SUCCEEDED", null);
    expect(b.refusal("api", now())).toMatchObject({ scope: "global", project_id: "*", used: 3, limit: 3 });
    expect(b.refusal(undefined, now())).toMatchObject({ scope: "global" });
    expect(b.facts.budgetExhausted("web")).toBe(true);
    expect(b.facts.budgetExhausted("api")).toBe(false); // the project scope only; the T14.2 reader asks '*' as well
    expect(b.facts.budgetExhausted("*")).toBe(true);
    expect(b.facts.metaSessionParked("ms_x")).toBe(false);
  });

  it("a cap of 0 admits nothing in its scope, as written", () => {
    const b = evaluator(settings({}, { web: { concurrentRuns: 0 } }));
    expect(b.refusal("web", now())).toMatchObject({ cap: "concurrent_runs", limit: 0, used: 0 });
    expect(b.refusal("api", now())).toBeUndefined();
  });

  it("with no cap configured admission is never refused and the ledger is not consulted", () => {
    const b = evaluator(settings());
    expect(b.configured).toBe(false);
    db.close(); // any read would throw
    expect(b.refusal("web", now())).toBeUndefined();
    expect(b.facts.budgetExhausted("web")).toBe(false);
    expect(b.facts.budgetExhausted("*")).toBe(false);
    db = openLedger(dir); // for afterEach
  });
});

describe("an unset cap is reported as unset (T14.4; LLD §3.4.3 `budget.caps[]`)", () => {
  it("every dimension is listed; `limit` is null when unset, the project's own or the global cap when set", () => {
    run("RUNNING", "web", 10);
    run("RUNNING", "api", 10);
    const none = evaluator(settings());
    expect(none.status("web", now())).toEqual({
      exhausted: false,
      caps: [
        { key: "runs_per_day", limit: null, used: 1, window_ends_at: "2026-10-17T00:00:00.000Z" },
        { key: "concurrent_runs", limit: null, used: 1, window_ends_at: null },
        { key: "wall_clock_per_run", limit: null, used: 10, window_ends_at: null },
        { key: "usage_per_window", limit: null, used: 0, window_ends_at: null },
      ],
    });
    const mixed = evaluator(settings({ concurrentRuns: 4 }, { web: { runsPerDay: 1 } }));
    const status = mixed.status("web", now());
    expect(status.exhausted).toBe(true); // web's own runs_per_day (1 of 1)
    expect(status.caps).toEqual([
      { key: "runs_per_day", limit: 1, used: 1, window_ends_at: "2026-10-17T00:00:00.000Z" }, // the override, own count
      { key: "concurrent_runs", limit: 4, used: 2, window_ends_at: null }, // the global cap, every run counted
      { key: "wall_clock_per_run", limit: null, used: 10, window_ends_at: null },
      { key: "usage_per_window", limit: null, used: 0, window_ends_at: null },
    ]);
    expect(mixed.status("api", now()).exhausted).toBe(false);
    expect(mixed.globalStatus(now()).caps[0]).toEqual({
      key: "runs_per_day",
      limit: null,
      used: 2,
      window_ends_at: "2026-10-17T00:00:00.000Z",
    });
  });
});

describe("no output presents a cap as a provider limit (T14.4, ADR-0007)", () => {
  it("the refusal message and details use operator budget wording only", () => {
    const b = evaluator(
      settings({ runsPerDay: 0, concurrentRuns: 0, wallClockPerRunSeconds: 0 }, { web: { runsPerDay: 0 } }),
    );
    const refusals: BudgetRefusal[] = [
      b.refusal("web", now()) as BudgetRefusal,
      b.refusal(undefined, now()) as BudgetRefusal,
    ];
    run("RUNNING", null, 5);
    refusals.push(
      evaluator(settings({ wallClockPerRunSeconds: 1 })).refusal(undefined, now()) as BudgetRefusal,
      evaluator(settings({ usagePerWindow: { windowSeconds: 60, maxReportedTokens: 0 } })).refusal(
        undefined,
        now(),
      ) as BudgetRefusal,
    );
    expect(refusals.map((r) => r.cap)).toEqual([
      "runs_per_day",
      "runs_per_day",
      "wall_clock_per_run",
      "usage_per_window",
    ]);
    for (const r of refusals) {
      const message = budgetRefusalMessage(r);
      expect(message).toMatch(/^operator budget cap /);
      expect(message).not.toMatch(PROVIDER_LIMIT_WORDS);
      expect(JSON.stringify(budgetRefusalDetails(r))).not.toMatch(PROVIDER_LIMIT_WORDS);
    }
    expect(JSON.stringify(b.status("web", now()))).not.toMatch(PROVIDER_LIMIT_WORDS);
  });
});

describe("the read path reuses the evaluation that refuses admission (T14.4; T14.2 `ControlPlaneFacts`)", () => {
  it("needs_attention shows budget_exhausted on the project's non-terminal runs through the registered evaluator", () => {
    const open = run("QUEUED", "web");
    const done = run("SUCCEEDED", "web");
    const elsewhere = run("QUEUED", "api");
    const unregistered = budgetControlFacts(ledger);
    expect(needsAttentionOf(ledger, open, { now: now(), control: unregistered })).toEqual({ active: false });
    const b = evaluator(settings({}, { web: { concurrentRuns: 1 } }));
    registerBudgets(ledger, b);
    expect(b.refusal("web", now())?.cap).toBe("concurrent_runs");
    const control = budgetControlFacts(ledger);
    expect(needsAttentionOf(ledger, open, { now: now(), control })).toEqual({
      active: true,
      reason: "budget_exhausted",
    });
    expect(needsAttentionOf(ledger, done, { now: now(), control })).toEqual({ active: false });
    expect(needsAttentionOf(ledger, elsewhere, { now: now(), control })).toEqual({ active: false });
    // `buildEnvelope` fills the facts in when the caller passes none (the MCP server passes `now` only).
    expect(buildEnvelope(ledger, open, (s) => s, { now: now() }).needs_attention).toEqual({
      active: true,
      reason: "budget_exhausted",
    });
    expect(budgetStatusFor(ledger, "web", now())?.exhausted).toBe(true);
    finish(open);
    expect(needsAttentionOf(ledger, ledger.getRunRecord(open.id) as RunRecord, { now: now(), control })).toEqual({
      active: false,
    });
    expect(budgetStatusFor(ledger, "web", now())?.exhausted).toBe(false);
  });

  it("a caller's own facts compose with the registered evaluator; a parked flag is never answered here", () => {
    registerBudgets(ledger, evaluator(settings({ concurrentRuns: 0 })));
    const control = budgetControlFacts(ledger, {
      metaSessionParked: (id) => id === "ms_p",
      budgetExhausted: () => false,
    });
    expect(control.budgetExhausted("*")).toBe(true);
    expect(control.budgetExhausted("web")).toBe(false);
    expect(control.metaSessionParked("ms_p")).toBe(true);
    expect(control.metaSessionParked("ms_q")).toBe(false);
  });
});
