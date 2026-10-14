/**
 * T7.1 (FR-RTE-02, FR-RTE-04, BR-4, LLD §17.2, §17.3, ADR-0044): the heuristic classifier and the stage-2 scorer are
 * pure and deterministic, unsourced terms never decide, unknown capacity is never headroom, and with the default weights
 * and no history the configured order decides (no behaviour change from M2).
 */
import { describe, expect, it } from "vitest";
import { classifyRequest } from "./features.js";
import {
  DEFAULT_WEIGHTS,
  EMPTY_INPUTS,
  SCORE_TERMS,
  type ScoreInputs,
  type SelectionInput,
  scoreCandidates,
  selectRoute,
  type Weights,
} from "./score.js";

const inputs = (over: Partial<ScoreInputs> = {}): ScoreInputs => ({ ...EMPTY_INPUTS, ...over });

const base = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  candidateOrder: ["a", "b", "c"],
  eligible: ["a", "b", "c"],
  requiredProvider: null,
  preference: null,
  affinityProvider: null,
  excludeFromScore: null,
  scoreInputs: {},
  weights: DEFAULT_WEIGHTS,
  ...over,
});

/** A small deterministic generator (mulberry32) so the property checks are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInputs(r: () => number): ScoreInputs {
  return {
    healthy: Math.floor(r() * 20),
    counted: Math.floor(r() * 20),
    median_ms: r() < 0.3 ? null : Math.floor(r() * 600_000),
    capacity_score: r() < 0.3 ? null : r(),
    capacity_confidence: r(),
    session_bound: r() < 0.5,
  };
}

function randomWeights(r: () => number): Weights {
  return Object.fromEntries(SCORE_TERMS.map((t) => [t, Math.floor(r() * 101)])) as Weights;
}

describe("heuristic classifier (FR-RTE-04, LLD §17.2)", () => {
  it("gives the §13.6 enumeration, each value tagged heuristic, with the classifier version", () => {
    const f = classifyRequest({
      objective: "Fix the crash in the parser",
      constraints: [],
      verificationCommands: 1,
      writable: true,
    });
    expect(f).toEqual({
      classifier: "heuristic.v1",
      context_volume: { value: "small", source: "heuristic" },
      autonomy: { value: "high", source: "heuristic" },
      reasoning_depth: { value: "low", source: "heuristic" },
      task_kind: { value: "bug_fix", source: "heuristic" },
    });
  });

  it("applies the documented thresholds and first-match keyword order", () => {
    const c = (objective: string, extra: Partial<Parameters<typeof classifyRequest>[0]> = {}) =>
      classifyRequest({ objective, constraints: [], verificationCommands: 0, writable: true, ...extra });
    expect(c("x".repeat(399)).context_volume.value).toBe("small");
    expect(c("x".repeat(400)).context_volume.value).toBe("medium");
    expect(c("x".repeat(300), { constraints: ["y".repeat(100)] }).context_volume.value).toBe("medium");
    expect(c("x".repeat(2000)).context_volume.value).toBe("large");
    expect(c("look", { writable: false, verificationCommands: 3 }).autonomy.value).toBe("low");
    expect(c("look").autonomy.value).toBe("medium");
    // "explain" (investigation) wins over "fix" (bug_fix): first match in the documented order.
    expect(c("Explain why the fix fails").task_kind.value).toBe("investigation");
    expect(c("Add tests for the cache").task_kind.value).toBe("test");
    expect(c("Update the README").task_kind.value).toBe("docs");
    expect(c("Rename the module").task_kind.value).toBe("refactor");
    expect(c("Implement OAuth").task_kind.value).toBe("feature");
    expect(c("prefix fixture additions").task_kind.value).toBe("other"); // whole words only
    expect(c("Rename the module").reasoning_depth.value).toBe("high");
    expect(c("x".repeat(500)).reasoning_depth.value).toBe("medium");
  });

  it("is deterministic", () => {
    const req = {
      objective: "Refactor the ledger",
      constraints: ["keep API"],
      verificationCommands: 2,
      writable: true,
    };
    expect(JSON.stringify(classifyRequest(req))).toBe(JSON.stringify(classifyRequest({ ...req })));
  });
});

describe("scorer (FR-RTE-02, LLD §17.3)", () => {
  it("computes each term from its documented source", () => {
    const [a, b] = scoreCandidates(
      ["a", "b"],
      {
        a: inputs({ healthy: 3, counted: 1, median_ms: 1000, capacity_score: 0.8, session_bound: true }),
        b: inputs({ healthy: 0, counted: 0, median_ms: 4000, capacity_score: null, session_bound: false }),
      },
      DEFAULT_WEIGHTS,
    );
    expect(a?.terms).toEqual({ success: 4 / 6, latency: 1, capacity: 0.8, security: 0.5, handoff: 1, cost: 0.5 });
    expect(b?.terms).toEqual({ success: 0.5, latency: 0.25, capacity: 0, security: 0.5, handoff: 0, cost: 0.5 });
    expect(a?.score).toBe((4 / 6 + 1 + 0.8 + 0.5 + 1 + 0.5) / 6);
  });

  it("gives an unsourced term (security, cost) the same value for every candidate, so it cannot change the order", () => {
    const r = rng(7);
    for (let n = 0; n < 300; n++) {
      const providers = ["a", "b", "c", "d"];
      const inp = Object.fromEntries(providers.map((p) => [p, randomInputs(r)]));
      const w = randomWeights(r);
      const scored = scoreCandidates(providers, inp, w);
      expect(new Set(scored.map((s) => s.terms.security))).toEqual(new Set([0.5]));
      expect(new Set(scored.map((s) => s.terms.cost))).toEqual(new Set([0.5]));
      const order = (ws: Weights) =>
        selectRoute(base({ candidateOrder: providers, eligible: providers, scoreInputs: inp, weights: ws })).provider;
      expect(order({ ...w, security: 100, cost: 100 })).toBe(order({ ...w, security: 0, cost: 0 }));
    }
  });

  it("never ranks an unknown capacity estimate above a known one with headroom (Q-69)", () => {
    const r = rng(11);
    for (let n = 0; n < 300; n++) {
      const shared = randomInputs(r);
      const known = { ...shared, capacity_score: 0.01 + r() * 0.99 };
      const unknown = { ...shared, capacity_score: null };
      const [k, u] = scoreCandidates(["k", "u"], { k: known, u: unknown }, randomWeights(r));
      expect(u?.terms.capacity).toBe(0);
      expect(u?.score ?? 0).toBeLessThanOrEqual(k?.score ?? 0);
    }
  });

  it("is byte-identical for the same input", () => {
    const r = rng(3);
    const inp = { a: randomInputs(r), b: randomInputs(r), c: randomInputs(r) };
    const w = randomWeights(r);
    const once = JSON.stringify(selectRoute(base({ scoreInputs: inp, weights: w })));
    expect(JSON.stringify(selectRoute(base({ scoreInputs: structuredClone(inp), weights: { ...w } })))).toBe(once);
  });

  it("scores 0 for every candidate when every weight is 0, so the configured order decides", () => {
    const w = Object.fromEntries(SCORE_TERMS.map((t) => [t, 0])) as Weights;
    const s = selectRoute(base({ weights: w, scoreInputs: { c: inputs({ healthy: 10 }) } }));
    expect(s.scored.map((c) => c.score)).toEqual([0, 0, 0]);
    expect(s).toMatchObject({ provider: "a", basis: "configured_order" });
  });
});

describe("selection order (BR-4, LLD §17.3)", () => {
  it("with the default weights and no history picks the first configured provider (the M2 behaviour)", () => {
    expect(selectRoute(base())).toMatchObject({ provider: "a", basis: "configured_order" });
    expect(selectRoute(base({ eligible: ["c", "b"] }))).toMatchObject({ provider: "b", basis: "configured_order" });
    expect(selectRoute(base({ eligible: ["c"] }))).toMatchObject({ provider: "c", basis: "configured_order" });
  });

  it("is required provider, then affinity, then preference, then score, then configured order", () => {
    const better = { c: inputs({ healthy: 9 }) };
    expect(selectRoute(base({ scoreInputs: better }))).toMatchObject({ provider: "c", basis: "score" });
    expect(selectRoute(base({ scoreInputs: better, preference: "b" }))).toMatchObject({
      provider: "b",
      basis: "provider_preference",
    });
    expect(selectRoute(base({ scoreInputs: better, preference: "b", affinityProvider: "a" }))).toMatchObject({
      provider: "a",
      basis: "affinity",
    });
    expect(
      selectRoute(base({ scoreInputs: better, preference: "b", affinityProvider: "a", requiredProvider: "c" })),
    ).toMatchObject({ provider: "c", basis: "required_provider" });
  });

  it("never selects a provider stage 1 removed, whatever the hints or scores (BR-1)", () => {
    const s = (over: Partial<SelectionInput>) => selectRoute(base({ eligible: ["b"], ...over }));
    expect(s({ preference: "a" }).provider).toBe("b");
    expect(s({ affinityProvider: "a" }).provider).toBe("b");
    expect(s({ scoreInputs: { a: inputs({ healthy: 99 }) } }).provider).toBe("b");
    expect(s({ requiredProvider: "a" })).toMatchObject({ provider: null, basis: null });
    expect(selectRoute(base({ eligible: [] }))).toMatchObject({ provider: null, basis: null, scored: [] });
  });

  it("leaves the affine provider out of the score after capacity_exhausted or failed_after_retry, unless alone", () => {
    const strong = { a: inputs({ healthy: 50 }) };
    expect(selectRoute(base({ scoreInputs: strong, excludeFromScore: "a" })).provider).toBe("b");
    expect(selectRoute(base({ eligible: ["a"], scoreInputs: strong, excludeFromScore: "a" })).provider).toBe("a");
  });

  it("records every eligible candidate's score in configured order whatever decided", () => {
    const s = selectRoute(base({ eligible: ["c", "a"], affinityProvider: "c" }));
    expect(s.scored.map((c) => c.provider)).toEqual(["a", "c"]);
  });
});
