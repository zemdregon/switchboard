/**
 * M7 model-group acceptance on fake adapters (T7.16; ROADMAP §6 M7 row, FR-RTE-10, FR-RTE-11, FR-MCP-02, ADR-0055,
 * LLD §17.7 and §16.9). Everything goes through the MCP server as an orchestrator would:
 *
 * - two configured groups (`low-cost`, `flagship`) over the three scripted fake providers with placeholder models;
 * - a `low-cost` and a `flagship` request each land on an eligible member of their group (a member whose placeholder
 *   model the provider's registry does not list is excluded with `CAPABILITY_MISSING`);
 * - an explicit model routes to the one provider whose registry resolves it;
 * - a project keeps its member across meta-sessions until its subscription is deferred by the pacing gate, then moves
 *   with `capacity_exhausted` (`pacing_gate`) and keeps the new member once the gate has opened again;
 * - `explain_route` lists the group, the member and the deciding factors;
 * - replay reproduces every stored decision from its row alone.
 *
 * No provider CLI is installed or called; the providers are one scripted fake CLI under three ids. The clock is
 * injected (ledger, lifecycle and servers) and runs at real speed from an offset the test sets, as in the T6.8 tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PACING_DEFERRED } from "../capacity/index.js";
import type { PacingSettings, SubscriptionSettings } from "../config/capacity.js";
import type { RouteDecisionRow } from "../ledger/index.js";
import { ModelRegistry } from "../models/registry.js";
import type { AffinityRecord } from "../routing/affinity.js";
import { replayRouteDecision } from "../routing/decision.js";
import { compiled, type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";

const CLOSED = ["user_request", "capacity_exhausted", "ineligible", "failed_after_retry"];

// Placeholder models only (LLD §17.7): no real model id is named here or in the groups below.
const GROUPS = {
  "low-cost": {
    members: [
      { provider: "fake", model: "fake-mini" },
      { provider: "fake-b", model: "fake-b-mini" },
      { provider: "grok", model: "grok-mini" },
    ],
  },
  flagship: {
    members: [
      // Listed first, but `fake-b`'s registry does not know this model: excluded at stage 1 (registry resolution).
      { provider: "fake-b", model: "fake-b-max" },
      { provider: "grok", model: "grok-max" },
    ],
  },
};
const REGISTRY = new ModelRegistry(
  new Map([
    ["fake", { ids: ["fake-mini"] }],
    ["fake-b", { ids: ["fake-b-mini"] }],
    ["grok", { ids: ["grok-mini", "grok-max"] }],
  ]),
);

// Pacing (LLD §16.9): `fake` alone in a subscription with a budget of 5 runs per fixed hour, the spares in a wide one.
// At 600 s into the window the pace line is T × elapsed + B = 0.95 × (600 / 3600) + 0.1 ≈ 0.258: one run on `fake`
// (used 0.2) is under it, two runs (used 0.4) are over it, so the gate defers `fake` after the second run.
const ANCHOR = "2026-10-17T00:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR);
const LENGTH = 3600;
const GATE: PacingSettings = { mode: "gate", targetFraction: 0.95, burstFraction: 0.1, minConfidence: 0.5 };
const sub = (name: string, adapterIds: string[], budget: number): SubscriptionSettings => ({
  name,
  providers: [...adapterIds],
  adapterIds,
  windows: [
    {
      id: "hour",
      lengthSeconds: LENGTH,
      reset: { kind: "fixed", anchor: ANCHOR },
      budget: { unit: "runs", value: budget },
    },
  ],
});
const SUBSCRIPTIONS = [sub("alpha", ["fake"], 5), sub("beta", ["fake-b", "grok"], 100)];
/** `start + L × (used − B) / T`, to the millisecond, written independently of the gate (LLD §16.9). */
const gateOpen = (used: number) =>
  new Date(Math.round(ANCHOR_MS + LENGTH * 1000 * ((used - GATE.burstFraction) / GATE.targetFraction))).toISOString();

let offset = 0;
const clock = () => new Date(Date.now() + offset);
const setClock = (ms: number) => {
  offset = ms - Date.now();
};

let h: Harness;
afterEach(async () => {
  await h.close();
  offset = 0;
});

async function harness(): Promise<Harness> {
  setClock(ANCHOR_MS + 600_000);
  h = await startHarness({
    now: clock,
    models: REGISTRY,
    config: {
      model_groups: GROUPS,
      capacity: { windowSeconds: 3600, confidenceRuns: 10, subscriptions: SUBSCRIPTIONS, pacing: GATE },
    },
    lifecycle: { pacing: { subscriptions: SUBSCRIPTIONS, pacing: GATE } },
  });
  return h;
}

interface Settled {
  runId: string;
  metaSessionId: string;
  provider: string;
  model: string | undefined;
  decision: RouteDecisionRow;
  features: Json;
  candidates: Json[];
  affinity: AffinityRecord | undefined;
}

/** One `delegate_task` through the SDK client, settled, with the run's stored decision unpacked. */
async function delegate(routing: Json, workspace = h.repo): Promise<Settled> {
  const started = await h.ok("delegate_task", {
    objective: "ok",
    workspace_path: workspace,
    trust_profile: "edit-untrusted",
    routing,
  });
  const runId = started.run_id as string;
  const run = await h.settle(runId);
  expect(run.status, JSON.stringify(run)).toBe("SUCCEEDED");
  const record = h.ledger.getRunRecord(runId);
  const decision = h.decisions().find((d) => d.run_id === runId) as RouteDecisionRow;
  const reasons = JSON.parse(decision.reasons_json) as { affinity?: AffinityRecord };
  return {
    runId,
    metaSessionId: started.meta_session_id as string,
    provider: record?.provider as string,
    model: (JSON.parse(record?.request_json ?? "{}") as { model?: string }).model,
    decision,
    features: JSON.parse(decision.features_json) as Json,
    candidates: JSON.parse(decision.candidates_json) as Json[],
    affinity: reasons.affinity,
  };
}

const explain = (runId: string) => h.ok("explain_route", { run_id: runId });

/** Every stored decision replays exactly from its row alone; every run was submitted by the test and ran once. */
function replayEverything(expectedRuns: string[]): void {
  const rows = h.decisions();
  expect(rows.map((r) => r.run_id).sort()).toEqual([...expectedRuns].sort());
  for (const row of rows) {
    expect(replayRouteDecision(row), row.id).toEqual({ schemaVersion: 3, ok: true, differences: [] });
  }
  expect((h.db.prepare("SELECT id FROM run ORDER BY created_at").all() as { id: string }[]).map((r) => r.id)).toEqual(
    expectedRuns,
  );
  expect(compiled.map((c) => c.runId)).toEqual(expectedRuns);
}

describe("M7 model-group acceptance (T7.16)", () => {
  it("low-cost and flagship requests land on an eligible member of their group, an explicit model routes to its provider, explain_route lists group, member and factors, and every decision replays", async () => {
    await harness();
    const flagshipRepo = h.newRepo("flagship");
    const explicitRepo = h.newRepo("explicit");

    // 1. `low-cost`: every member is eligible and ties on the ledger terms; member order picks fake/fake-mini. The
    // member's placeholder model goes to request_json.model and to the adapter's compile.
    const low = await delegate({ model_group: "low-cost" });
    expect(low.provider).toBe("fake");
    expect(low.model).toBe("fake-mini");
    expect(compiled.find((c) => c.runId === low.runId)?.model).toBe("fake-mini");
    expect(low.features).toMatchObject({
      schema_version: 3,
      model_group: "low-cost",
      requested_model: null,
      candidate_order: ["fake/fake-mini", "fake-b/fake-b-mini", "grok/grok-mini"],
      pacing_mode: "gate",
      candidate_subscription: { fake: "alpha", "fake-b": "beta", grok: "beta" },
    });
    expect(low.candidates.map((c) => [c.member, c.eligible, c.model])).toEqual([
      ["fake/fake-mini", true, "fake-mini"],
      ["fake-b/fake-b-mini", true, "fake-b-mini"],
      ["grok/grok-mini", true, "grok-mini"],
    ]);
    const lowExplained = await explain(low.runId);
    expect(lowExplained.selected_provider).toBe("fake");
    expect(lowExplained.features.schema_version).toBe(3);
    expect(lowExplained.candidates.map((c: Json) => c.provider)).toEqual([
      "fake/fake-mini",
      "fake-b/fake-b-mini",
      "grok/grok-mini",
    ]);
    expect(lowExplained.deciding_factors).toContain("model group low-cost: member fake/fake-mini chosen");
    expect(lowExplained.deciding_factors).toContain(`selected fake by ${lowExplained.selection.rule}`);
    // One pacing line per candidate provider in a subscription, from the stored figures.
    for (const provider of ["fake", "fake-b", "grok"]) {
      expect(
        lowExplained.deciding_factors.some((s: string) => s.startsWith(`pacing: ${provider} `)),
        JSON.stringify(lowExplained.deciding_factors),
      ).toBe(true);
    }

    // 2. `flagship` on another project: the first member's model is not in fake-b's registry, so it is excluded with
    // CAPABILITY_MISSING and the request lands on the next eligible member, grok/grok-max.
    const flag = await delegate({ model_group: "flagship" }, flagshipRepo);
    expect(flag.provider).toBe("grok");
    expect(flag.model).toBe("grok-max");
    expect(compiled.find((c) => c.runId === flag.runId)?.model).toBe("grok-max");
    expect(flag.features).toMatchObject({
      model_group: "flagship",
      candidate_order: ["fake-b/fake-b-max", "grok/grok-max"],
    });
    const excluded = flag.candidates.find((c) => c.member === "fake-b/fake-b-max");
    expect(excluded).toMatchObject({ provider: "fake-b", eligible: false, score: null });
    expect(excluded?.reasons[0].code).toBe("CAPABILITY_MISSING");
    const flagExplained = await explain(flag.runId);
    expect(flagExplained.deciding_factors).toContain("model group flagship: member grok/grok-max chosen");
    expect(flagExplained.deciding_factors).toContain("fake-b/fake-b-max excluded: CAPABILITY_MISSING");

    // 3. An explicit model on a third project, no provider named: it resolves in exactly one registry (grok's) and
    // routes there as the single member grok/grok-max.
    const explicit = await delegate({ model: "grok-max" }, explicitRepo);
    expect(explicit.provider).toBe("grok");
    expect(explicit.model).toBe("grok-max");
    expect(explicit.features).toMatchObject({ model_group: null, requested_model: "grok-max" });
    expect(explicit.features.members.map((m: Json) => m.key)).toEqual(["grok/grok-max"]);
    expect((await explain(explicit.runId)).deciding_factors).toContain("requested model grok-max: grok/grok-max");

    replayEverything([low.runId, flag.runId, explicit.runId]);
  }, 120_000);

  it("a project keeps its member across meta-sessions until its subscription is deferred, then moves with capacity_exhausted (pacing_gate), and every decision replays", async () => {
    await harness();
    const spare = h.newRepo("spare");

    // 1. First `low-cost` request: fake/fake-mini (member order among tied members).
    const r1 = await delegate({ model_group: "low-cost" });
    expect(r1.provider).toBe("fake");
    expect(r1.model).toBe("fake-mini");
    expect(r1.affinity).toMatchObject({ applies: true, provider: null });

    // 2. Another project uses the spares, so `beta` has usage too; alpha is at 1/5 after r1, beta at 1/100.
    const other = await delegate({ model_group: "low-cost", provider_preference: "grok" }, spare);
    expect(other.provider).toBe("grok");

    // 3. Same project, a new meta-session: affinity holds fake/fake-mini, unscored. The gate has not deferred alpha
    // (used 0.2 is under the pace line), and a member with a better pacing term exists but is not a reason to move.
    const r2 = await delegate({ model_group: "low-cost" });
    expect(r2.metaSessionId).not.toBe(r1.metaSessionId);
    expect(r2.provider).toBe("fake");
    expect(r2.model).toBe("fake-mini");
    expect(r2.affinity).toMatchObject({
      held: true,
      provider: "fake",
      model: "fake-mini",
      member: "fake/fake-mini",
      scored: false,
      affinity_switch_reason: null,
    });
    expect(r2.candidates.find((c) => c.member === "fake/fake-mini")?.pacing_verdict).toBeNull();
    const pacingTerms = Object.fromEntries(r2.candidates.map((c) => [c.member, c.terms?.pacing]));
    expect(pacingTerms["fake-b/fake-b-mini"]).toBeGreaterThan(pacingTerms["fake/fake-mini"]);
    const held = await explain(r2.runId);
    expect(held.affinity).toMatchObject({ held: true, provider: "fake", model: "fake-mini" });
    expect(held.deciding_factors).toContain("affinity held (fake)");
    expect(held.deciding_factors).toContain("model group low-cost: member fake/fake-mini chosen");

    // 4. Two runs on `fake` put alpha at 0.4, over the pace line: the gate defers `fake` until the formula's time.
    // The affine member is deferred and undeferred eligible members remain, so the project moves with
    // `capacity_exhausted` (`pacing_gate`) to the highest-scoring undeferred member (grok, which has success history
    // from the other project, or fake-b), and the affine member is left out of the score.
    const OPEN = gateOpen(0.4);
    expect(OPEN).toBe("2026-10-17T00:18:56.842Z");
    const r3 = await delegate({ model_group: "low-cost" });
    expect(r3.metaSessionId).not.toBe(r2.metaSessionId);
    expect(["fake-b", "grok"]).toContain(r3.provider);
    const movedTo = r3.provider;
    const movedMember = `${movedTo}/${movedTo}-mini`;
    expect(r3.model).toBe(`${movedTo}-mini`);
    expect(compiled.find((c) => c.runId === r3.runId)?.model).toBe(`${movedTo}-mini`);
    expect(r3.decision.selected_provider).toBe(movedTo);
    const scored = r3.candidates.filter((c) => c.eligible && c.score !== null);
    expect(scored.map((c) => c.member).sort()).toEqual(["fake-b/fake-b-mini", "grok/grok-mini"]);
    expect(Math.max(...scored.map((c) => c.score as number))).toBe(scored.find((c) => c.member === movedMember)?.score);
    expect(r3.affinity).toMatchObject({
      held: false,
      provider: "fake",
      model: "fake-mini",
      affinity_switch_reason: "capacity_exhausted",
      detail: "pacing_gate",
      excluded_from_score: "fake/fake-mini",
    });
    const deferred = r3.candidates.find((c) => c.member === "fake/fake-mini");
    expect(deferred).toMatchObject({
      eligible: true,
      score: null,
      pacing_verdict: { verdict: PACING_DEFERRED, until: OPEN },
    });
    expect(JSON.parse(r3.decision.reasons_json).pacing).toEqual({
      deferred: [{ provider: "fake", member: "fake/fake-mini", verdict: PACING_DEFERRED, until: OPEN }],
      hold_until: null,
    });
    expect(r3.features.pacing_inputs.alpha).toMatchObject({
      binding_window: "hour",
      used: 0.4,
      used_source: "controller_estimated",
      defers: true,
      until: OPEN,
    });
    expect(h.ledger.listRunEvents(r3.runId).some((e) => e.type === "pacing_hold")).toBe(false);
    const moved = await explain(r3.runId);
    expect(moved.affinity).toMatchObject({ affinity_switch_reason: "capacity_exhausted" });
    expect(moved.deciding_factors).toContain("affinity switched from fake (capacity_exhausted, pacing_gate)");
    expect(moved.deciding_factors).toContain(`model group low-cost: member ${movedMember} chosen`);
    expect(moved.deciding_factors).toContain(`pacing: fake ahead of pace until ${OPEN}`);
    expect(moved.deciding_factors.some((s: string) => /^pacing: fake-b (on pace|behind pace)$/.test(s))).toBe(true);
    expect(moved.deciding_factors.some((s: string) => /^pacing: grok (on pace|behind pace)$/.test(s))).toBe(true);

    // 5. After the gate has opened (1200 s: the pace line is ≈ 0.417, over alpha's 0.4) the project keeps the member
    // it moved to; a recovered `fake` is not a reason to move back.
    setClock(ANCHOR_MS + 1_200_000);
    const r4 = await delegate({ model_group: "low-cost" });
    expect(r4.provider).toBe(movedTo);
    expect(r4.model).toBe(`${movedTo}-mini`);
    expect(r4.affinity).toMatchObject({ held: true, provider: movedTo, model: `${movedTo}-mini`, member: movedMember });
    expect(r4.candidates.find((c) => c.member === "fake/fake-mini")?.pacing_verdict).toBeNull();
    expect((await explain(r4.runId)).deciding_factors).toContain(`affinity held (${movedTo})`);

    // The other project kept its own provider throughout (no project is spread without a listed reason).
    const spareAgain = await delegate({ model_group: "low-cost" }, spare);
    expect(spareAgain.provider).toBe("grok");
    expect(spareAgain.affinity).toMatchObject({ held: true, member: "grok/grok-mini" });

    // Replay every stored decision; per project, a member change carries a reason from the closed list.
    const runs = [r1, other, r2, r3, r4, spareAgain].map((r) => r.runId);
    replayEverything(runs);
    const reasonsSeen = new Set<string>();
    for (const row of h.decisions()) {
      const a = (JSON.parse(row.reasons_json) as { affinity?: AffinityRecord }).affinity;
      if (a === undefined || !a.applies || a.provider === null) continue;
      if (row.selected_provider !== a.provider) {
        expect(CLOSED).toContain(a.affinity_switch_reason);
        reasonsSeen.add(a.affinity_switch_reason as string);
      } else {
        expect(a.affinity_switch_reason === null || a.affinity_switch_reason === "user_request").toBe(true);
      }
    }
    expect(reasonsSeen).toEqual(new Set(["capacity_exhausted"]));
  }, 120_000);
});
