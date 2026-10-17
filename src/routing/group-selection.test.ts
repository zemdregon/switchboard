/**
 * T7.15 group-aware two-stage selection with the `pacing` term (FR-RTE-01, 02, 03, 06, 07, 08, FR-RTE-11, FR-CAP-10,
 * BR-49, BR-45, ADR-0055, LLD §17.7, §16.9). Pure decision tests over member-level stage-1 results, and tests through
 * the MCP server on the scripted fake adapters (`fake`, `fake-b`, `grok`). No provider CLI, no network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PacingDeferral } from "../capacity/pacing-gate.js";
import type { PacingSettings } from "../config/capacity.js";
import type { Ledger, RouteDecisionRow } from "../ledger/index.js";
import type { AffinityFacts, AffinityRecord } from "./affinity.js";
import {
  buildRouteDecision,
  collectPacingInputs,
  type RouteDecisionRequest,
  type RoutePacingInputs,
  replayRouteDecision,
} from "./decision.js";
import type { EligibilityInput } from "./eligibility.js";
import { compiled, type Harness, type Json, refusesModel, startHarness } from "./fixtures/harness.js";
import { FIXTURE } from "./fixtures/v2-golden-input.js";
import { groupEligibility, type MemberPass, memberKey } from "./groups.js";
import { EMPTY_INPUTS, type ScoreInputs, scoreCandidates, type Weights } from "./score.js";

const W: Weights = { success: 1, latency: 1, capacity: 1, security: 1, handoff: 1, cost: 1 };
const UNTIL = "2026-10-17T01:00:00.000Z";
const LATER = "2026-10-17T02:00:00.000Z";
const deferral = (until = UNTIL): PacingDeferral => ({
  subscription: "s",
  window: "hour",
  until,
  source: "controller_estimated",
});

interface M {
  provider: string;
  model: string;
  refuse?: boolean;
  deferred?: PacingDeferral;
}

/** One member's stage-1 pass as `checkEligibility` returns it (provider required, model requested). */
function pass(m: M, order: number): MemberPass {
  const input: EligibilityInput = {
    candidates: [m.provider] as EligibilityInput["candidates"],
    requiredProvider: m.provider as EligibilityInput["candidates"][number],
    trustProfile: "edit-untrusted",
    clientMaxProfile: "edit-untrusted",
    requirements: { network: "off", writable: true, model: m.model },
    platform: "linux",
    facts: [
      {
        provider: m.provider as EligibilityInput["candidates"][number],
        registered: true,
        enabled: true,
        ...(m.refuse ? {} : { model: m.model }),
        ...(m.deferred !== undefined ? { pacingDeferred: m.deferred } : {}),
      },
    ],
  };
  const reason = { code: "CAPABILITY_MISSING" as const, detail: `${m.provider} refuses models`, evidence: {} };
  return {
    member: { provider: m.provider, model: m.model, order },
    input,
    decision: m.refuse
      ? {
          eligible: [],
          excluded: [
            { provider: m.provider as never, primary: reason, reasons: [reason], failureCode: "ELIGIBILITY_NONE" },
          ],
          outcome: {
            kind: "required_provider_ineligible",
            provider: m.provider as never,
            failureCode: "ELIGIBILITY_NONE",
            message: "x",
          },
        }
      : {
          eligible: [m.provider as never],
          excluded: [],
          outcome: { kind: "eligible", providers: [m.provider as never] },
        },
  };
}

function groupRequest(
  members: M[],
  extra: Partial<RouteDecisionRequest> & { required?: string | null; row?: AffinityFacts["row"] } = {},
): RouteDecisionRequest {
  const ge = groupEligibility(
    members.map((m, i) => pass(m, i)),
    extra.required ?? null,
    false,
  );
  const { required: _r, row, ...rest } = extra;
  return {
    input: ge.input,
    decision: ge.decision,
    admissible: ge.admissible,
    preference: null,
    features: null,
    scoreInputs: {},
    weights: W,
    group: { name: "g", requestedModel: null, members: ge.members },
    ...(row !== undefined
      ? {
          affinity: {
            enabled: true,
            applies: true,
            projectKey: "proj",
            row,
            requiredProvider: extra.required ?? null,
            admissible: ge.admissible,
            excluded: ge.decision.excluded.map((e) => ({ provider: e.provider, codes: e.reasons.map((r) => r.code) })),
            latestOnAffine: null,
            estimate: null,
            thresholds: { lowWaterMark: null, minConfidence: null },
          },
        }
      : {}),
    ...rest,
  };
}

const replay = (r: ReturnType<typeof buildRouteDecision>) =>
  replayRouteDecision({ ...r.record, weights_json: r.record.weights_json ?? null });
const reasonsOf = (r: ReturnType<typeof buildRouteDecision>) =>
  JSON.parse(r.record.reasons_json) as { affinity?: AffinityRecord; selection?: Json; pacing?: Json };
const candidatesOf = (r: ReturnType<typeof buildRouteDecision>) => JSON.parse(r.record.candidates_json) as Json[];

const good: ScoreInputs = { ...EMPTY_INPUTS, healthy: 20 };

/** Pacing inputs: `p1` in subscription `s1` with the given allowance, `p2` in `s2`, `p3` in none. */
function pacing(a1: number | null, a2: number | null, mode: PacingSettings["mode"] = "score"): RoutePacingInputs {
  const sub = (allowance: number | null) => ({
    mode,
    T: 0.95,
    B: 0.1,
    binding_window: "hour",
    used: allowance === null ? null : 0.4,
    used_source: allowance === null ? "unknown" : "controller_estimated",
    confidence: allowance === null ? 0 : 0.8,
    elapsed: allowance === null ? null : 0.4,
    allowance,
    defers: false,
    until: null,
  });
  return {
    mode,
    subscriptions: { s1: sub(a1), s2: sub(a2) },
    candidateSubscription: { p1: "s1", p2: "s2", p3: null },
  };
}

describe("group-aware selection (T7.15, LLD §17.7), pure", () => {
  it("a group request picks the eligible member with the highest score and ties by member order", () => {
    const members: M[] = [
      { provider: "p1", model: "m1" },
      { provider: "p2", model: "m2" },
      { provider: "p3", model: "m3" },
    ];
    const best = buildRouteDecision(groupRequest(members, { scoreInputs: { p2: good } }));
    expect(best.provider).toBe("p2");
    expect(best.member?.key).toBe("p2/m2");
    expect(best.member?.model).toBe("m2");
    expect(best.rule).toBe("score");
    expect(reasonsOf(best).selection).toMatchObject({ provider: "p2", member: "p2/m2", model: "m2", rule: "score" });
    expect(replay(best)).toEqual({ schemaVersion: 3, ok: true, differences: [] });

    // Every member ties: member order decides, not the configured provider order.
    const reordered = [members[2], members[0], members[1]] as M[];
    const tie = buildRouteDecision(groupRequest(reordered));
    expect(tie.member?.key).toBe("p3/m3");
    expect(tie.rule).toBe("configured_order");
    expect(replay(tie).ok).toBe(true);

    // Two members of one provider share its ledger terms: the earlier member wins the tie.
    const same = buildRouteDecision(
      groupRequest(
        [
          { provider: "p1", model: "m1" },
          { provider: "p2", model: "late" },
          { provider: "p2", model: "early" },
        ],
        { scoreInputs: { p2: good } },
      ),
    );
    expect(same.member?.key).toBe("p2/late");
    expect(replay(same).ok).toBe(true);
  });

  it("a member whose adapter refuses any model is excluded with CAPABILITY_MISSING and the next one is chosen", () => {
    const r = buildRouteDecision(
      groupRequest([
        { provider: "p1", model: "m1", refuse: true },
        { provider: "p2", model: "m2" },
      ]),
    );
    expect(r.member?.key).toBe("p2/m2");
    const p1 = candidatesOf(r).find((c) => c.member === "p1/m1");
    expect(p1).toMatchObject({ provider: "p1", eligible: false, score: null, model: "m1", pacing_verdict: null });
    expect(p1?.reasons[0].code).toBe("CAPABILITY_MISSING");
    expect(replay(r).ok).toBe(true);
  });

  it("a better pacing score never moves an affine project", () => {
    const members: M[] = [
      { provider: "p1", model: "m1" },
      { provider: "p2", model: "m2" },
    ];
    const heavy: Weights = { ...W, pacing: 100 };
    // Without a row, the pacing term decides: p1 has allowance to spare, p2 none.
    const free = buildRouteDecision(groupRequest(members, { weights: heavy, pacing: pacing(2, 0) }));
    expect(free.member?.key).toBe("p1/m1");
    const terms = candidatesOf(free).map((c) => c.terms?.pacing);
    expect(terms).toEqual([1, 0]);
    // With the project affine to p2/m2, the better pacing score of p1 does not move it.
    const row = { provider: "p2", model: "m2", reset_requested_at: null };
    const held = buildRouteDecision(groupRequest(members, { weights: heavy, pacing: pacing(2, 0), row }));
    expect(held.member?.key).toBe("p2/m2");
    expect(held.rule).toBe("affinity");
    expect(held.affinity).toMatchObject({ held: true, affinity_switch_reason: null, scored: false, member: "p2/m2" });
    expect(replay(held)).toEqual({ schemaVersion: 3, ok: true, differences: [] });
  });

  it("a deferred affine member switches with capacity_exhausted (pacing_gate)", () => {
    const row = { provider: "p2", model: "m2", reset_requested_at: null };
    const r = buildRouteDecision(
      groupRequest(
        [
          { provider: "p1", model: "m1" },
          { provider: "p2", model: "m2", deferred: deferral() },
        ],
        { row },
      ),
    );
    expect(r.member?.key).toBe("p1/m1");
    expect(r.affinity).toMatchObject({
      held: false,
      affinity_switch_reason: "capacity_exhausted",
      detail: "pacing_gate",
      excluded_from_score: "p2/m2",
    });
    const p2 = candidatesOf(r).find((c) => c.member === "p2/m2");
    expect(p2?.pacing_verdict).toEqual({ verdict: "PACING_DEFERRED", until: UNTIL });
    expect(reasonsOf(r).pacing).toEqual({
      deferred: [{ provider: "p2", member: "p2/m2", verdict: "PACING_DEFERRED", until: UNTIL }],
      hold_until: null,
    });
    expect(replay(r).ok).toBe(true);

    // Every member deferred: affinity holds and the run waits for the affine member's gate.
    const all = buildRouteDecision(
      groupRequest(
        [
          { provider: "p1", model: "m1", deferred: deferral(UNTIL) },
          { provider: "p2", model: "m2", deferred: deferral(LATER) },
        ],
        { row },
      ),
    );
    expect(all.member?.key).toBe("p2/m2");
    expect(all.affinity).toMatchObject({ held: true, affinity_switch_reason: null });
    expect(reasonsOf(all).pacing?.hold_until).toBe(LATER);
    expect(replay(all).ok).toBe(true);
  });

  it("the pacing_gate rule applies to a provider request too", () => {
    const [request] = FIXTURE as unknown as RouteDecisionRequest[];
    const r = buildRouteDecision({
      ...(request as RouteDecisionRequest),
      input: {
        ...(request as RouteDecisionRequest).input,
        facts: [{ provider: "p2" as never, registered: true, enabled: true, pacingDeferred: deferral() }],
      },
      affinity: {
        enabled: true,
        applies: true,
        projectKey: "proj",
        row: { provider: "p2", model: null, reset_requested_at: null },
        requiredProvider: null,
        admissible: ["p1", "p2"],
        excluded: [],
        latestOnAffine: null,
        estimate: null,
        thresholds: { lowWaterMark: null, minConfidence: null },
      },
    });
    expect(r.provider).toBe("p1");
    expect(r.affinity).toMatchObject({ affinity_switch_reason: "capacity_exhausted", detail: "pacing_gate" });
    expect(r.affinity).not.toHaveProperty("member");
  });

  it("a group without the affine pair gives user_request", () => {
    // The affine provider is a member only with another model.
    const row = { provider: "p2", model: "m2", reset_requested_at: null };
    const other = buildRouteDecision(
      groupRequest(
        [
          { provider: "p1", model: "m1" },
          { provider: "p2", model: "other" },
        ],
        { row, scoreInputs: { p1: good } },
      ),
    );
    expect(other.affinity).toMatchObject({ affinity_switch_reason: "user_request", held: false, member: null });
    expect(other.member?.key).toBe("p1/m1");
    expect(other.rule).toBe("score");
    // The affine provider is not a member at all.
    const absent = buildRouteDecision(groupRequest([{ provider: "p3", model: "m3" }], { row }));
    expect(absent.affinity?.affinity_switch_reason).toBe("user_request");
    expect(replay(other).ok && replay(absent).ok).toBe(true);
  });

  it("with no subscription configured the pacing term is absent and every version 2 score is unchanged", async () => {
    // No subscription, or none of the candidates in one: no pacing inputs, so no term (and no ledger read).
    const noLedger = {} as Ledger;
    expect(collectPacingInputs(noLedger, undefined, ["p1"], new Date())).toBeUndefined();
    const settings = {
      subscriptions: [{ name: "s", providers: ["x"], adapterIds: ["x"], windows: [] }],
      pacing: { mode: "gate", targetFraction: 0.95, burstFraction: 0.1, minConfidence: 0.5 } as PacingSettings,
    };
    expect(collectPacingInputs(noLedger, settings, ["p1", "p2"], new Date())).toBeUndefined();

    // A provider decision without pacing inputs is version 2, with the six terms only, as on main.
    const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/v2-golden.json"), "utf8"));
    for (const [i, req] of FIXTURE.entries()) {
      const r = buildRouteDecision(req as unknown as RouteDecisionRequest);
      expect(JSON.stringify(r.record), `fixture ${i}`).toBe(golden[i]);
      expect(JSON.parse(r.record.features_json).schema_version).toBe(2);
      for (const c of candidatesOf(r)) if (c.terms !== null) expect(c.terms).not.toHaveProperty("pacing");
    }
    // A group without pacing inputs scores each member exactly as the six-term score of its provider.
    const inputs = { p1: good, p2: { ...EMPTY_INPUTS, median_ms: 1000 } };
    const g = buildRouteDecision(
      groupRequest(
        [
          { provider: "p1", model: "m1" },
          { provider: "p2", model: "m2" },
        ],
        { scoreInputs: inputs, weights: { ...W, pacing: 50 } },
      ),
    );
    const six = scoreCandidates(["p1", "p2"], inputs, W);
    expect(candidatesOf(g).map((c) => c.score)).toEqual(six.map((c) => c.score));
    expect(candidatesOf(g).map((c) => c.terms)).toEqual(six.map((c) => c.terms));
    expect(JSON.parse(g.record.weights_json ?? "{}")).not.toHaveProperty("pacing");
  });

  it("every version 3 decision replays exactly from the row alone, and version 1 and 2 rows still replay", () => {
    const members: M[] = [
      { provider: "p1", model: "m1" },
      { provider: "p2", model: "m2" },
      { provider: "p3", model: "m3" },
    ];
    for (const mode of ["gate", "score", "off"] as const) {
      const r = buildRouteDecision(
        groupRequest(members, {
          pacing: pacing(0.3, null, mode),
          weights: { ...W, pacing: 3 },
          scoreInputs: { p3: good },
        }),
      );
      expect(replay(r), mode).toEqual({ schemaVersion: 3, ok: true, differences: [] });
      const terms = candidatesOf(r).map((c) => c.terms?.pacing);
      expect(terms).toEqual(mode === "off" ? [0.5, 0.5, 0.5] : [0.3 / 1.9, 0, 0]);
      expect(JSON.parse(r.record.weights_json ?? "{}").pacing).toBe(3);
      // The pacing term comes from pacing_inputs in the row: changing them is a replay difference.
      if (mode !== "off") {
        const f = JSON.parse(r.record.features_json);
        f.pacing_inputs.s1.allowance = 1.9;
        const tampered = replayRouteDecision({
          ...r.record,
          features_json: JSON.stringify(f),
          weights_json: r.record.weights_json ?? null,
        });
        expect(tampered.ok).toBe(false);
        expect(tampered.differences.some((d) => d.includes(".pacing"))).toBe(true);
      }
    }
    // A provider decision with pacing inputs is version 3 too and replays (default pacing weight 1 recorded).
    const [request] = FIXTURE as unknown as RouteDecisionRequest[];
    const { pacing: _w, ...six } = (request as RouteDecisionRequest).weights;
    const pv = buildRouteDecision({ ...(request as RouteDecisionRequest), weights: six, pacing: pacing(1, 0.2) });
    expect(replay(pv)).toEqual({ schemaVersion: 3, ok: true, differences: [] });
    expect(JSON.parse(pv.record.weights_json ?? "{}").pacing).toBe(1);
    // Version 2 rows (the golden records) and an M2 eligibility-only row still replay.
    const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/v2-golden.json"), "utf8"));
    for (const g of golden as string[]) {
      const row = JSON.parse(g);
      expect(replayRouteDecision({ ...row, weights_json: row.weights_json ?? null })).toEqual({
        schemaVersion: 2,
        ok: true,
        differences: [],
      });
    }
    const m2 = {
      features_json: JSON.stringify({ trust_profile: "edit-untrusted" }),
      weights_json: null,
      candidates_json: "[]",
      selected_provider: null,
      reasons_json: JSON.stringify({ outcome: { kind: "eligible" } }),
    };
    expect(replayRouteDecision(m2)).toEqual({ schemaVersion: 1, ok: true, differences: [] });
  });

  it("member keys and require_provider: selection stays among the required provider's members", () => {
    const r = buildRouteDecision(
      groupRequest(
        [
          { provider: "p1", model: "m1" },
          { provider: "p2", model: "a" },
          { provider: "p2", model: "b" },
        ],
        { required: "p2", scoreInputs: { p1: good } },
      ),
    );
    expect(r.member?.key).toBe("p2/a");
    expect(r.rule).toBe("required_provider");
    expect(memberKey("p2", "a")).toBe("p2/a");
    expect(replay(r).ok).toBe(true);
  });
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const GROUPS = {
  ordered: {
    members: [
      { provider: "fake", model: "ma" },
      { provider: "fake-b", model: "mb" },
      { provider: "grok", model: "mc" },
    ],
  },
  spares: {
    members: [
      { provider: "fake-b", model: "mb" },
      { provider: "grok", model: "mc" },
    ],
  },
  back: {
    members: [
      { provider: "grok", model: "mc" },
      { provider: "fake-b", model: "mb" },
    ],
  },
};
const decisionOf = (hh: Harness, runId: string) => hh.decisions().find((d) => d.run_id === runId) as RouteDecisionRow;
const delegateOn = async (hh: Harness, routing: Json) =>
  hh.settle(
    (
      await hh.ok("delegate_task", {
        objective: "ok",
        workspace_path: hh.repo,
        trust_profile: "edit-untrusted",
        routing,
      })
    ).run_id as string,
  );

describe("group-aware selection through the MCP server on fake adapters (T7.15)", () => {
  it("skips a member whose adapter refuses any model, takes the next by member order, runs its model; explain_route shows it", async () => {
    const hh = await startHarness({ config: { model_groups: GROUPS } });
    h = hh;
    refusesModel.add("fake");
    const run = await delegateOn(hh, { model_group: "ordered" });
    expect(run.status).toBe("SUCCEEDED");
    const id = run.run_id as string;
    expect(hh.ledger.getRunRecord(id)?.provider).toBe("fake-b");
    // The chosen member's resolved model goes to request_json.model and to the adapter's compile.
    expect(JSON.parse(hh.ledger.getRunRecord(id)?.request_json ?? "{}").model).toBe("mb");
    expect(compiled.find((c) => c.runId === id)?.model).toBe("mb");
    const d = decisionOf(hh, id);
    expect(JSON.parse(d.features_json)).toMatchObject({
      schema_version: 3,
      model_group: "ordered",
      requested_model: null,
      candidate_order: ["fake/ma", "fake-b/mb", "grok/mc"],
    });
    expect(replayRouteDecision(d)).toEqual({ schemaVersion: 3, ok: true, differences: [] });
    const fake = (JSON.parse(d.candidates_json) as Json[]).find((c) => c.member === "fake/ma");
    expect(fake?.eligible).toBe(false);
    expect(fake?.reasons[0].code).toBe("CAPABILITY_MISSING");
    const ex = await hh.ok("explain_route", { run_id: id });
    expect(ex.schema_version).toBe(2);
    expect(ex.features.schema_version).toBe(3);
    expect(ex.deciding_factors).toContain("model group ordered: member fake-b/mb chosen");
    expect(ex.deciding_factors).toContain("fake/ma excluded: CAPABILITY_MISSING");
  }, 120_000);

  it("a group without the affine pair is user_request; a group with it holds the affine member", async () => {
    const hh = await startHarness({ config: { model_groups: GROUPS } });
    h = hh;
    const first = await delegateOn(hh, {});
    expect(first.status).toBe("SUCCEEDED");
    expect(JSON.parse(decisionOf(hh, first.run_id).features_json).schema_version).toBe(2);
    // The project is affine to fake with the model its session reported; this group does not contain that pair.
    const moved = await delegateOn(hh, { model_group: "spares" });
    const a = JSON.parse(decisionOf(hh, moved.run_id).reasons_json).affinity as AffinityRecord;
    expect(a).toMatchObject({ provider: "fake", affinity_switch_reason: "user_request", held: false, member: null });
    expect(hh.ledger.getRunRecord(moved.run_id)?.provider).toBe("fake-b");
    // The row moved to fake-b/mb on success; a group that lists it later in order still holds it.
    const held = await delegateOn(hh, { model_group: "back" });
    const b = JSON.parse(decisionOf(hh, held.run_id).reasons_json).affinity as AffinityRecord;
    expect(b).toMatchObject({ provider: "fake-b", model: "mb", held: true, member: "fake-b/mb" });
    expect(hh.ledger.getRunRecord(held.run_id)?.provider).toBe("fake-b");
    for (const d of hh.decisions()) expect(replayRouteDecision(d).ok).toBe(true);
  }, 120_000);

  it("with a subscription configured the pacing term is recorded (version 3), replays, and explain_route shows it", async () => {
    const anchor = new Date(Date.now() - 600_000).toISOString();
    const subscriptions = [
      {
        name: "alpha",
        providers: ["fake"],
        adapterIds: ["fake"],
        windows: [
          { id: "hour", lengthSeconds: 3600, reset: { kind: "fixed", anchor }, budget: { unit: "runs", value: 10 } },
        ],
      },
    ];
    const pacingSettings: PacingSettings = {
      mode: "score",
      targetFraction: 0.95,
      burstFraction: 0.1,
      minConfidence: 0.5,
    };
    const hh = await startHarness({
      lifecycle: { pacing: { subscriptions, pacing: pacingSettings } },
      config: { capacity: { windowSeconds: 3600, confidenceRuns: 10, subscriptions, pacing: pacingSettings } },
    });
    h = hh;
    const run = await delegateOn(hh, {});
    const d = decisionOf(hh, run.run_id);
    const f = JSON.parse(d.features_json);
    expect(f).toMatchObject({ schema_version: 3, model_group: null, members: [], pacing_mode: "score" });
    expect(f.candidate_subscription).toEqual({ fake: "alpha", "fake-b": null, grok: null });
    expect(f.pacing_inputs.alpha).toMatchObject({
      binding_window: "hour",
      used: 0,
      used_source: "controller_estimated",
    });
    const terms = (JSON.parse(d.candidates_json) as Json[]).map((c) => [c.provider, c.terms.pacing]);
    expect(terms).toEqual([
      ["fake", expect.any(Number)],
      ["fake-b", 0],
      ["grok", 0],
    ]);
    expect(JSON.parse(d.weights_json ?? "{}").pacing).toBe(1);
    expect(replayRouteDecision(d)).toEqual({ schemaVersion: 3, ok: true, differences: [] });
    const ex = await hh.ok("explain_route", { run_id: run.run_id });
    expect(ex.deciding_factors.some((s: string) => /^pacing: fake (behind pace|on pace|ahead of pace)/.test(s))).toBe(
      true,
    );
  }, 120_000);
});
