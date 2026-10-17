/**
 * M6 pacing acceptance on fake adapters (T6.16; ROADMAP §6 M6 row, FR-CAP-09, FR-CAP-10, FR-RTE-11 pacing term,
 * ADR-0055, LLD §16.9 and §17.7). Everything goes through the MCP server as an orchestrator would: three scripted fake
 * providers (`fake`, `fake-b`, `grok`) in two subscriptions with `fixed` windows and run budgets, and one injected clock
 * (ledger, lifecycle and MCP servers) that the test steps across the window:
 *
 * - work shifts to the subscription with the larger allowance (the `pacing` term);
 * - an ahead-of-pace subscription is deferred and its held run dispatches at the gate-open time;
 * - usage of each subscription approaches the target by its reset without exceeding `T + B` from Switchboard's own
 *   dispatches;
 * - `get_capacity` labels every figure by source.
 *
 * No provider CLI is installed or called. The clock runs at real speed from an offset the test sets, so the lifecycle's
 * wake timer fires at the gate-open time.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PACING_DEFERRED, PACING_HOLD_EVENT, type PacingGateSettings } from "../capacity/index.js";
import type { PacingSettings } from "../config/capacity.js";
import type { RouteDecisionRow } from "../ledger/index.js";
import { replayRouteDecision } from "../routing/decision.js";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";

const ANCHOR = "2026-10-17T00:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR);
const LENGTH = 3600;
const RESET = new Date(ANCHOR_MS + LENGTH * 1000).toISOString();
const T = 0.95;
const B = 0.1;
const GATE: PacingSettings = { mode: "gate", targetFraction: T, burstFraction: B, minConfidence: 0.5 };
/** Run budgets per window: `beta` has twice `alpha`'s allowance. One dispatch is at most `1 / 5` of a share. */
const BUDGET = { alpha: 5, beta: 10 } as const;
const SUB_OF: Record<string, keyof typeof BUDGET> = { fake: "alpha", "fake-b": "beta", grok: "beta" };

const window = (budget: number) => ({
  id: "hour",
  lengthSeconds: LENGTH,
  reset: { kind: "fixed" as const, anchor: ANCHOR },
  budget: { unit: "runs" as const, value: budget },
});
const PACING: PacingGateSettings = {
  subscriptions: [
    { name: "alpha", providers: ["fake"], adapterIds: ["fake"], windows: [window(BUDGET.alpha)] },
    { name: "beta", providers: ["fake-b", "grok"], adapterIds: ["fake-b", "grok"], windows: [window(BUDGET.beta)] },
  ],
  pacing: GATE,
};
/** The pacing weight dominates the six other terms, so the subscription with the larger allowance wins on score. */
const ROUTING = {
  weights: { success: 1, latency: 1, capacity: 1, security: 1, handoff: 1, cost: 1, pacing: 1000 },
  affinity: { enabled: true, lowWaterMark: null, minConfidence: null },
};

let offset = 0;
const clock = () => new Date(Date.now() + offset);
const setClock = (ms: number) => {
  offset = ms - Date.now();
};
const atElapsed = (e: number) => setClock(ANCHOR_MS + e * LENGTH * 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `window_start + L × (used − B) / T`, capped at the reset; written independently of the gate. */
const gateOpen = (used: number) =>
  new Date(Math.round(Math.min(Date.parse(RESET), ANCHOR_MS + LENGTH * 1000 * ((used - B) / T)))).toISOString();
/** How far before the gate-open time a held run is submitted: longer than admission takes. */
const MARGIN_MS = 2500;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  offset = 0;
});

async function harness(configured = true): Promise<Harness> {
  h = await startHarness({
    now: clock,
    config: {
      routing: ROUTING,
      ...(configured ? { capacity: { windowSeconds: 3600, confidenceRuns: 10, ...PACING } } : {}),
    },
    ...(configured ? { lifecycle: { pacing: PACING } } : {}),
  });
  return h;
}

/** Submit one task through `delegate_task` in a fresh project (no affinity row), so the score decides. */
let projects = 0;
async function submit(hh: Harness, routing: Json = {}): Promise<string> {
  const repo = hh.newRepo(`p${++projects}`);
  const body = await hh.ok("delegate_task", {
    objective: "ok",
    workspace_path: repo,
    trust_profile: "edit-untrusted",
    routing,
  });
  return body.run_id as string;
}
const decisionOf = (hh: Harness, runId: string) => hh.decisions().find((d) => d.run_id === runId) as RouteDecisionRow;
type Candidate = { provider: string; eligible: boolean; terms?: { pacing?: number } | null; pacing?: Json };
const candidates = (d: RouteDecisionRow) => JSON.parse(d.candidates_json) as Candidate[];
const capacity = async (hh: Harness) => hh.ok("get_capacity", {});
const pacingOf = (body: Json, sub: string) => (body.pacing as Json[]).find((p) => p.subscription === sub) as Json;

/** Runs Switchboard dispatched in the window, per subscription, as a share of its budget (from the ledger). */
function dispatchedShare(hh: Harness): Record<keyof typeof BUDGET, number> {
  const rows = hh.db.prepare("SELECT provider, started_at FROM run WHERE started_at IS NOT NULL").all() as {
    provider: string;
    started_at: string;
  }[];
  const count = { alpha: 0, beta: 0 };
  for (const r of rows) {
    const t = Date.parse(r.started_at);
    const sub = SUB_OF[r.provider];
    if (sub !== undefined && t >= ANCHOR_MS && t < Date.parse(RESET)) count[sub] += 1;
  }
  return { alpha: count.alpha / BUDGET.alpha, beta: count.beta / BUDGET.beta };
}

/** Every figure in the pacing block carries its source (FR-CAP-03, LLD §16.9). */
function expectLabelled(body: Json): void {
  for (const p of body.providers as Json[]) {
    expect(p.explicit_remaining).toBeNull();
    expect(p.estimate_source).toBe("controller_estimated");
  }
  for (const sub of body.pacing as Json[]) {
    for (const w of sub.windows as Json[]) {
      expect(w.reset_at).toEqual({ at: expect.any(String), source: "operator_declared" });
      expect(w.window_start).toEqual({ at: expect.any(String), source: "operator_declared" });
      expect(w.used_fraction).toMatchObject({ source: "controller_estimated", basis: "runs", lower_bound: true });
      expect(typeof w.used_fraction.note).toBe("string");
    }
  }
  // Generic walk: any object holding a numeric or ISO `value`/`at` figure names its source.
  const walk = (x: unknown): void => {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return;
    }
    const o = x as Json;
    if ("value" in o || "at" in o) expect(typeof o.source).toBe("string");
    for (const v of Object.values(o)) walk(v);
  };
  walk(body.pacing);
}

describe("M6 pacing acceptance (T6.16)", () => {
  it("work shifts to the larger allowance; an ahead-of-pace subscription is deferred and its held run dispatches at the gate-open time", async () => {
    atElapsed(0.2);
    const hh = await harness();

    // One run on alpha (require_provider): used 1/5 = 0.2, under the pace line 0.95 × 0.2 + 0.1 = 0.29.
    const seeded = await submit(hh, { provider_preference: "fake", require_provider: true });
    expect((await hh.settle(seeded)).status).toBe("SUCCEEDED");
    let cap = await capacity(hh);
    expectLabelled(cap);
    expect(pacingOf(cap, "alpha")).toMatchObject({ verdict: "clear", deferred_until: null });
    const allowance = (sub: string) => pacingOf(cap, sub).windows[0].allowance as number;
    expect(allowance("beta")).toBeGreaterThan(allowance("alpha"));

    // Unpinned work goes to beta on the pacing term, though alpha is clear and first in configured order.
    const shifted = await submit(hh);
    expect((await hh.settle(shifted)).status).toBe("SUCCEEDED");
    const d1 = decisionOf(hh, shifted);
    expect(SUB_OF[d1.selected_provider ?? ""]).toBe("beta");
    const terms = Object.fromEntries(candidates(d1).map((c) => [c.provider, c.terms?.pacing]));
    expect(terms["fake-b"]).toBeGreaterThan(terms.fake as number);
    expect(candidates(d1).some((c) => c.pacing !== undefined)).toBe(false);
    expect(replayRouteDecision(d1)).toMatchObject({ ok: true, differences: [] });
    const explained = await hh.ok("explain_route", { run_id: shifted });
    expect(explained.selected_provider).toBe(d1.selected_provider);

    // A second alpha run: used 0.4 is ahead of the line, so alpha defers until start + L × (0.4 − B) / T.
    const ahead = await submit(hh, { provider_preference: "fake", require_provider: true });
    expect((await hh.settle(ahead)).status).toBe("SUCCEEDED");
    const OPEN = gateOpen(0.4);
    expect(OPEN).toBe("2026-10-17T00:18:56.842Z");
    cap = await capacity(hh);
    expectLabelled(cap);
    expect(pacingOf(cap, "alpha")).toMatchObject({ verdict: "deferred", deferred_until: OPEN });
    expect(pacingOf(cap, "alpha").windows[0]).toMatchObject({ pace: "ahead", defers: true });
    expect(pacingOf(cap, "beta")).toMatchObject({ verdict: "clear", deferred_until: null });

    // Preferring alpha does not reach it: the deferred candidate is left out while beta is eligible.
    const preferred = await submit(hh, { provider_preference: "fake" });
    expect((await hh.settle(preferred)).status).toBe("SUCCEEDED");
    const d2 = decisionOf(hh, preferred);
    expect(SUB_OF[d2.selected_provider ?? ""]).toBe("beta");
    expect(candidates(d2).find((c) => c.provider === "fake")?.pacing).toEqual({
      verdict: PACING_DEFERRED,
      until: OPEN,
      subscription: "alpha",
      window: "hour",
      source: "controller_estimated",
    });
    expect(JSON.parse(d2.reasons_json).pacing).toEqual({
      deferred: [{ provider: "fake", verdict: PACING_DEFERRED, until: OPEN }],
      hold_until: null,
    });

    // A run that must use alpha is held in QUEUED and dispatches no earlier than the gate-open time.
    setClock(Date.parse(OPEN) - MARGIN_MS);
    const held = await submit(hh, { provider_preference: "fake", require_provider: true });
    expect(hh.ledger.getRunRecord(held)?.state).toBe("QUEUED");
    expect(JSON.parse(decisionOf(hh, held).reasons_json).pacing.hold_until).toBe(OPEN);
    await sleep(200);
    expect(hh.ledger.getRunRecord(held)?.state).toBe("QUEUED");
    expect(
      hh.ledger
        .listRunEvents(held)
        .filter((e) => e.type === PACING_HOLD_EVENT)
        .map((e) => JSON.parse(e.payload_json)),
    ).toEqual([{ subscription: "alpha", window: "hour", until: OPEN, source: "controller_estimated" }]);
    expect((await hh.settle(held)).status).toBe("SUCCEEDED");
    const run = hh.ledger.getRunRecord(held);
    expect(run?.provider).toBe("fake");
    expect(Date.parse(run?.started_at ?? "")).toBeGreaterThanOrEqual(Date.parse(OPEN));
    // Nothing ran that was not submitted: five runs, no probe run.
    expect((hh.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n).toBe(5);
    cap = await capacity(hh);
    expectLabelled(cap);
  });

  it("stepped across the window, each subscription approaches T by its reset and never exceeds T + B", async () => {
    const steps = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 0.99];
    atElapsed(steps[0] as number);
    const hh = await harness();
    let runs = 0;
    for (const e of steps) {
      atElapsed(e);
      // The orchestrator submits while get_capacity shows a clear subscription, as it would to use its allowance.
      for (let guard = 0; ; guard++) {
        expect(guard).toBeLessThan(20);
        const cap = await capacity(hh);
        expectLabelled(cap);
        const now = clock().getTime();
        const views = cap.pacing as Json[];
        // get_capacity and the gate agree: a deferred subscription names a gate-open time still ahead.
        for (const v of views) if (v.verdict === "deferred") expect(Date.parse(v.deferred_until)).toBeGreaterThan(now);
        const clear = views.filter((v) => v.verdict === "clear").map((v) => v.subscription as string);
        if (clear.length === 0) break;
        const runId = await submit(hh);
        const done = await hh.settle(runId);
        runs++;
        expect(done.status).toBe("SUCCEEDED");
        const d = decisionOf(hh, runId);
        const chosen = SUB_OF[d.selected_provider ?? ""] as string;
        // Only a clear subscription is dispatched to, and never a held run.
        expect(clear).toContain(chosen);
        expect(JSON.parse(d.reasons_json).pacing?.hold_until ?? null).toBeNull();
        // Work goes to the larger allowance: the chosen candidate's pacing term is the largest among the admissible.
        const admissible = new Set((JSON.parse(d.features_json) as { admissible: string[] }).admissible);
        const best = Math.max(
          ...candidates(d)
            .filter((c) => admissible.has(c.provider))
            .map((c) => c.terms?.pacing ?? 0),
        );
        expect(candidates(d).find((c) => c.provider === d.selected_provider)?.terms?.pacing).toBe(best);
        // Switchboard's own dispatches never take a subscription past T + B.
        const share = dispatchedShare(hh);
        expect(share.alpha).toBeLessThanOrEqual(T + B + 1e-9);
        expect(share.beta).toBeLessThanOrEqual(T + B + 1e-9);
      }
      // Mid-window, usage follows the pace line: at most one dispatch above min(T, T × e + B).
      const share = dispatchedShare(hh);
      const line = Math.min(T, T * e + B);
      expect(share.alpha).toBeLessThanOrEqual(line + 1 / BUDGET.alpha + 1e-9);
      expect(share.beta).toBeLessThanOrEqual(line + 1 / BUDGET.beta + 1e-9);
    }
    // By the reset both subscriptions have reached the target, and neither has passed T + B.
    const final = dispatchedShare(hh);
    for (const sub of ["alpha", "beta"] as const) {
      expect(final[sub]).toBeGreaterThanOrEqual(T);
      expect(final[sub]).toBeLessThanOrEqual(T + B);
    }
    expect(runs).toBe(BUDGET.alpha + BUDGET.beta);
    // At the last step both are deferred until the reset.
    const cap = await capacity(hh);
    for (const v of cap.pacing as Json[]) expect(v).toMatchObject({ verdict: "deferred", deferred_until: RESET });
  });

  it("without subscriptions configured the decisions, outcomes and get_capacity are byte-identical to the unconfigured server", async () => {
    const scenario = async (pacing?: PacingGateSettings) => {
      atElapsed(0.2);
      h = await startHarness({
        now: clock,
        config: {
          routing: ROUTING,
          ...(pacing !== undefined ? { capacity: { windowSeconds: 3600, confidenceRuns: 10, ...pacing } } : {}),
        },
        ...(pacing !== undefined ? { lifecycle: { pacing } } : {}),
      });
      const hh = h;
      const runId = await submit(hh, { provider_preference: "fake" });
      await hh.settle(runId);
      const strip = (s: string) =>
        s
          .split(hh.root)
          .join("<root>")
          .replace(/"ws:[0-9a-f]{64}"/g, '"ws:<key>"')
          .replace(/"(run|ms|rd)_[0-9A-Za-z]+"/g, '"<id>"');
      const d = decisionOf(hh, runId);
      const run = hh.ledger.getRunRecord(runId);
      const cap = await capacity(hh);
      const out = {
        decision: [d.features_json, d.weights_json, d.candidates_json, d.selected_provider, d.reasons_json].map((x) =>
          strip(String(x)),
        ),
        outcome: [run?.state, run?.provider, run?.failure_code],
        events: hh.ledger.listRunEvents(runId).map((e) => e.type),
        capacityKeys: Object.keys(cap).sort(),
      };
      await hh.close();
      h = undefined;
      return out;
    };
    const unconfigured = await scenario();
    const empty = await scenario({ subscriptions: [], pacing: GATE });
    expect(empty).toEqual(unconfigured);
    expect(JSON.stringify(unconfigured)).not.toContain("pacing");
    expect(unconfigured.capacityKeys).not.toContain("pacing");
  });
});
