/**
 * T7.6 affinity replay property test (FR-RTE-03, FR-RTE-06, FR-RTE-07, TDD §3.13.3, M7 acceptance criteria).
 *
 * Part 1, generated: thousands of simulated runs of projects through the real decision builder, with per-step random
 * eligibility, score inputs (success history, latency, capacity estimate), weights (cost-like and load-like terms
 * included), hints, resets and outcomes. The project's row is maintained as the lifecycle maintains it (written when a
 * run whose decision applied affinity succeeds). Properties: a project's provider changes only on a decision carrying a
 * reason from the closed list; a better score, lower cost or lower load never moves it; LLD §3.2's invariants hold;
 * every decision replays exactly.
 *
 * Part 2, persisted: a seeded scripted session through the MCP server on fake adapters, then a replay of the stored
 * route decisions in order, with the same properties, and with several eligible providers and equal capacity no project
 * is spread across providers.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AffinitySwitchReason } from "../ledger/index.js";
import type { AffinityFacts, AffinityRecord } from "./affinity.js";
import { buildRouteDecision, replayRouteDecision } from "./decision.js";
import type { EligibilityDecision, EligibilityInput } from "./eligibility.js";
import { down, type Harness, type Json, startHarness } from "./fixtures/harness.js";
import { SCORE_TERMS, type ScoreInputs, type Weights } from "./score.js";

const REASONS: readonly AffinitySwitchReason[] = [
  "user_request",
  "capacity_exhausted",
  "ineligible",
  "failed_after_retry",
];
const PROVIDERS = ["p1", "p2", "p3", "p4"] as const;

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
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

interface SimRow {
  provider: string;
  model: string | null;
  reset_requested_at: string | null;
}

function eligibilityFor(
  admissible: readonly string[],
  required: string | null,
): {
  input: EligibilityInput;
  decision: EligibilityDecision;
} {
  const candidates = required !== null ? [required] : [...PROVIDERS];
  const eligible = candidates.filter((p) => admissible.includes(p));
  const excluded = candidates
    .filter((p) => !admissible.includes(p))
    .map((p) => {
      const reason = { code: "CAPABILITY_MISSING" as const, detail: "simulated", evidence: {} };
      return { provider: p, primary: reason, reasons: [reason] };
    });
  return {
    input: {
      candidates: candidates as EligibilityInput["candidates"],
      ...(required !== null ? { requiredProvider: required as EligibilityInput["candidates"][number] } : {}),
      trustProfile: "edit-untrusted",
      clientMaxProfile: "edit-untrusted",
      requirements: { network: "off", writable: true },
      platform: "linux",
      facts: [],
    },
    decision: {
      eligible: eligible as EligibilityDecision["eligible"],
      excluded: excluded as EligibilityDecision["excluded"],
      outcome:
        eligible.length > 0
          ? ({ kind: "eligible", providers: eligible } as EligibilityDecision["outcome"])
          : ({
              kind: "none_eligible",
              failureCode: "ELIGIBILITY_NONE",
              message: "none",
            } as EligibilityDecision["outcome"]),
    },
  };
}

describe("affinity property over generated runs (T7.6, part 1)", () => {
  it("changes a project's provider only with a listed reason, never for score, cost or load", () => {
    const r = rng(20261014);
    let decisions = 0;
    let switches = 0;
    let heldAgainstBetterScore = 0;
    for (let project = 0; project < 120; project++) {
      let row: SimRow | undefined;
      let latest: AffinityFacts["latestOnAffine"] = null;
      for (let step = 0; step < 25; step++) {
        // Per-step world: eligibility, scores (cost-like and load-like terms vary through weights and capacity).
        const admissible = PROVIDERS.filter(() => r() < 0.8);
        const required = r() < 0.1 ? pick(r, PROVIDERS) : null;
        const preference = r() < 0.3 ? pick(r, PROVIDERS) : null;
        const inputs: Record<string, ScoreInputs> = Object.fromEntries(
          PROVIDERS.map((p) => [
            p,
            {
              healthy: Math.floor(r() * 30),
              counted: Math.floor(r() * 5),
              median_ms: r() < 0.2 ? null : 1000 + Math.floor(r() * 300_000),
              capacity_score: r() < 0.3 ? null : r(),
              capacity_confidence: r(),
              session_bound: true,
            },
          ]),
        );
        const weights = Object.fromEntries(SCORE_TERMS.map((t) => [t, Math.floor(r() * 101)])) as Weights;
        const thresholds =
          r() < 0.5 ? { lowWaterMark: null, minConfidence: null } : { lowWaterMark: 0.2, minConfidence: 0.5 };
        if (row !== undefined && r() < 0.05) row = { ...row, reset_requested_at: "now" };
        const { input, decision } = eligibilityFor(admissible, required);
        if (required !== null && !admissible.includes(required)) continue; // refused before any decision (BR-2)
        if (decision.eligible.length === 0) continue; // ELIGIBILITY_NONE: no decision, row unchanged (§3.2 step 6)
        const affinity: AffinityFacts = {
          enabled: true,
          applies: true,
          projectKey: `proj-${project}`,
          row,
          requiredProvider: required,
          admissible: decision.eligible,
          excluded: decision.excluded.map((e) => ({ provider: e.provider, codes: e.reasons.map((x) => x.code) })),
          latestOnAffine: latest,
          estimate:
            row !== undefined && inputs[row.provider] !== undefined
              ? {
                  capacityScore: (inputs[row.provider] as ScoreInputs).capacity_score,
                  confidence: (inputs[row.provider] as ScoreInputs).capacity_confidence,
                }
              : null,
          thresholds,
        };
        const result = buildRouteDecision({
          input,
          decision,
          admissible: decision.eligible,
          preference,
          features: null,
          scoreInputs: inputs,
          weights,
          affinity,
        });
        decisions++;
        const rec = result.affinity as AffinityRecord;
        const reasons = JSON.parse(result.record.reasons_json) as { affinity: AffinityRecord };
        expect(reasons.affinity).toEqual(rec);
        expect(replayRouteDecision({ ...result.record, weights_json: result.record.weights_json ?? null })).toEqual({
          schemaVersion: 2,
          ok: true,
          differences: [],
        });
        // LLD §3.2 invariants.
        if (rec.held) {
          expect(rec.affinity_switch_reason).toBeNull();
          expect(rec.scored).toBe(false);
        }
        if (rec.scored) expect(row === undefined || rec.affinity_switch_reason !== null).toBe(true);
        if (rec.affinity_switch_reason !== null) expect(REASONS).toContain(rec.affinity_switch_reason);
        if (row !== undefined && result.provider !== row.provider) {
          expect(rec.affinity_switch_reason, `step ${step}`).not.toBeNull();
          switches++;
        }
        // Score, cost and load are never reasons: with no reason the affine provider wins whatever the scores say.
        if (row !== undefined && rec.affinity_switch_reason === null) {
          expect(result.provider).toBe(row.provider);
          const scored = JSON.parse(result.record.candidates_json) as { provider: string; score: number | null }[];
          const mine = scored.find((c) => c.provider === row?.provider)?.score ?? 0;
          if (scored.some((c) => (c.score ?? -1) > mine)) heldAgainstBetterScore++;
        }
        // Outcome: success writes the row as the lifecycle does; failures shape the next step's facts.
        const outcome = pick(r, ["ok", "ok", "ok", "quota", "retry_exhausted", "other_failure"] as const);
        if (outcome === "ok") {
          if (rec.applies) row = { provider: result.provider as string, model: null, reset_requested_at: null };
          latest = null;
        } else if (result.provider === row?.provider) {
          latest = {
            failureCode: outcome === "quota" ? "QUOTA_EXHAUSTED" : "PROVIDER_OVERLOADED",
            retryExhausted: outcome === "retry_exhausted",
          };
        }
      }
    }
    // The generator exercised what it claims to.
    expect(decisions).toBeGreaterThan(2000);
    expect(switches).toBeGreaterThan(50);
    expect(heldAgainstBetterScore).toBeGreaterThan(100);
  });
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("affinity property over persisted decisions (T7.6, part 2)", () => {
  it("in a replay of stored decisions a project's provider changes only with a listed reason", async () => {
    const hh = await startHarness({ maxAttempts: 2 });
    h = hh;
    const r = rng(7);
    const repos = [hh.repo, hh.newRepo("second")];
    for (let step = 0; step < 14; step++) {
      down.clear();
      if (r() < 0.2) down.add(pick(r, ["fake", "fake-b"]));
      const mode = pick(r, ["ok", "ok", "ok", "overload", "quota"]);
      const routing: Json = {};
      if (r() < 0.3) routing.provider_preference = pick(r, ["fake", "fake-b", "grok"]);
      if (routing.provider_preference !== undefined && r() < 0.3) routing.require_provider = true;
      const res = await hh.call("delegate_task", {
        objective: mode,
        workspace_path: pick(r, repos),
        trust_profile: "edit-untrusted",
        routing,
      });
      if (res.isError) continue; // a required provider made ineligible: refused, no decision
      await followChain(hh, res.body.run_id as string);
    }
    down.clear();
    // The seeded session moved at least one project with a recorded reason.
    expect(checkPersisted(hh)).toBeGreaterThan(0);
  }, 300_000);

  it("with several eligible providers and equal capacity no project is spread across providers", async () => {
    const hh = await startHarness();
    h = hh;
    const second = hh.newRepo("second");
    const providers = new Map<string, Set<string>>();
    for (let i = 0; i < 8; i++) {
      const repo = i % 2 === 0 ? hh.repo : second;
      const run = await hh.delegate("ok", i % 3 === 0 ? { provider_preference: "grok" } : {}, { workspace_path: repo });
      providers.set(repo, (providers.get(repo) ?? new Set()).add(run.provider.adapter as string));
    }
    expect([...providers.values()].map((s) => s.size)).toEqual([1, 1]);
    checkPersisted(hh);
  }, 300_000);
});

/** Wait for a run and every retry or failover successor it gets. */
async function followChain(hh: Harness, runId: string): Promise<void> {
  let run = await hh.settle(runId);
  for (;;) {
    if (run.failure_code === "QUOTA_EXHAUSTED") {
      const id = run.run_id as string;
      await hh.waitFor(() => hh.ledger.listRunEvents(id).some((e) => e.type === "quota_ladder"));
      run = await hh.ok("get_run", { run_id: id });
    }
    if (run.superseded_by === undefined) return;
    run = await hh.settle(run.superseded_by as string);
  }
}

/** Did this decision's run, or a retry successor that has no decision of its own, succeed? */
function chainSucceeded(hh: Harness, runId: string): boolean {
  let run = hh.ledger.getRunRecord(runId);
  for (let hops = 0; run !== undefined && hops < 32; hops++) {
    if (run.state === "SUCCEEDED") return true;
    const next = hh.ledger.findSuccessorRun(run.id);
    if (next === undefined || hh.ledger.getRouteDecision(next.id) !== undefined) return false;
    run = next;
  }
  return false;
}

/** Replay the stored decisions in order; per project, the selected provider changes only with a listed reason. */
function checkPersisted(hh: Harness): number {
  const lastByProject = new Map<string, string>();
  let switched = 0;
  for (const row of hh.decisions()) {
    expect(replayRouteDecision(row), row.id).toMatchObject({ ok: true, schemaVersion: 2 });
    const reasons = JSON.parse(row.reasons_json) as { affinity?: AffinityRecord };
    const a = reasons.affinity;
    if (a === undefined || !a.applies) continue;
    if (a.held) expect(a.affinity_switch_reason).toBeNull();
    // The decision's view of the affinity is the row as written by earlier successes.
    if (a.provider !== null && row.selected_provider !== a.provider) {
      expect(REASONS, row.id).toContain(a.affinity_switch_reason);
      switched++;
    }
    if (chainSucceeded(hh, row.run_id) && row.selected_provider !== null) {
      lastByProject.set(a.project_key, row.selected_provider);
    }
  }
  // The rows agree with the last succeeded applying decision of each project.
  for (const affinityRow of hh.ledger.listProjectAffinities()) {
    expect(lastByProject.get(affinityRow.project_key)).toBe(affinityRow.provider);
  }
  return switched;
}
