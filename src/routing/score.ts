/**
 * Stage-2 routing (FR-RTE-02, LLD §17.3, ADR-0044): a pure, deterministic score over the candidates stage 1 left, and the
 * selection order `require_provider`, affinity, `provider_preference`, score, configured order (BR-4). Every input is a
 * plain value the caller stores in the route decision (LLD §17.4), so a replay recomputes the same numbers from the row
 * alone. No I/O, no clock, no model.
 *
 * Unsourced terms (`security`, `cost`) are the same neutral value for every candidate, so they never decide a route
 * (Q-80). An unknown capacity estimate scores 0, the worst value, never headroom (Q-69).
 */

/** Fixed term order: sums are computed in this order so replays are bit-identical. */
export const SCORE_TERMS = ["success", "latency", "capacity", "security", "handoff", "cost"] as const;
export type ScoreTerm = (typeof SCORE_TERMS)[number];
export type Weights = Record<ScoreTerm, number>;
export type Terms = Record<ScoreTerm, number>;

/** LLD §17.1 default (Assumption, Q-80): every term weighs the same. */
export const DEFAULT_WEIGHTS: Readonly<Weights> = Object.freeze({
  success: 1,
  latency: 1,
  capacity: 1,
  security: 1,
  handoff: 1,
  cost: 1,
});

/** The value of a term that has no per-provider source (Q-80). */
export const NEUTRAL = 0.5;

/** Per-candidate inputs, as stored in `features_json.score_inputs` (LLD §17.4). */
export interface ScoreInputs {
  /** Runs in the window the breaker classification counts as healthy (LLD §16.4). */
  healthy: number;
  /** Runs in the window the breaker classification counts as provider failures. */
  counted: number;
  /** Median wall time of the provider's `SUCCEEDED` runs in the window; null with none. */
  median_ms: number | null;
  /** FR-CAP-02 `capacity_score`; null when unknown (Q-69). */
  capacity_score: number | null;
  capacity_confidence: number;
  /** The provider bound to the meta-session (`continue_task`); for `delegate_task` every candidate is true. */
  session_bound: boolean;
}

/** Inputs for a provider with no history and an unknown estimate. */
export const EMPTY_INPUTS: Readonly<ScoreInputs> = Object.freeze({
  healthy: 0,
  counted: 0,
  median_ms: null,
  capacity_score: null,
  capacity_confidence: 0,
  session_bound: true,
});

export interface ScoredCandidate {
  provider: string;
  score: number;
  terms: Terms;
}

/** Terms and score for each provider in `providers`, in that order. */
export function scoreCandidates(
  providers: readonly string[],
  inputs: Readonly<Record<string, ScoreInputs>>,
  weights: Readonly<Weights>,
): ScoredCandidate[] {
  const of = (p: string): ScoreInputs => inputs[p] ?? EMPTY_INPUTS;
  const medians = providers.map((p) => of(p).median_ms).filter((m): m is number => m !== null);
  const fastest = medians.length > 0 ? Math.min(...medians) : null;
  const totalWeight = SCORE_TERMS.reduce((sum, t) => sum + weights[t], 0);
  return providers.map((provider) => {
    const i = of(provider);
    const terms: Terms = {
      success: (i.healthy + 1) / (i.healthy + i.counted + 2),
      latency: i.median_ms === null || fastest === null ? NEUTRAL : i.median_ms === 0 ? 1 : fastest / i.median_ms,
      capacity: i.capacity_score === null ? 0 : clamp01(i.capacity_score),
      security: NEUTRAL,
      handoff: i.session_bound ? 1 : 0,
      cost: NEUTRAL,
    };
    const weighted = SCORE_TERMS.reduce((sum, t) => sum + weights[t] * terms[t], 0);
    return { provider, score: totalWeight === 0 ? 0 : weighted / totalWeight, terms };
  });
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export type SelectionBasis = "required_provider" | "affinity" | "provider_preference" | "score" | "configured_order";

export interface SelectionInput {
  /** Configured candidate order after project narrowing; the final tie-break. */
  candidateOrder: readonly string[];
  /** Providers stage 1 admitted (for `privileged`, the admissible set), any order. */
  eligible: readonly string[];
  requiredProvider: string | null;
  preference: string | null;
  /** The affine provider when the affinity step decided it holds (LLD §3.2 step 4); null otherwise. */
  affinityProvider: string | null;
  /** The affine provider left out of the score after `capacity_exhausted` or `failed_after_retry` (LLD §17.6). */
  excludeFromScore: string | null;
  scoreInputs: Readonly<Record<string, ScoreInputs>>;
  weights: Readonly<Weights>;
}

export interface Selection {
  /** Null when no candidate is eligible (the caller refuses with the BR-3 code). */
  provider: string | null;
  basis: SelectionBasis | null;
  /** Every eligible candidate, in configured order, with its terms and score. */
  scored: ScoredCandidate[];
}

/** LLD §17.3 selection; first match wins. */
export function selectRoute(input: SelectionInput): Selection {
  const eligibleSet = new Set(input.eligible);
  const ordered = [
    ...input.candidateOrder.filter((p) => eligibleSet.has(p)),
    // Admissible providers missing from the order (never expected) keep a stable place at the end.
    ...[...eligibleSet].filter((p) => !input.candidateOrder.includes(p)).sort(),
  ];
  const scored = scoreCandidates(ordered, input.scoreInputs, input.weights);
  const pick = (provider: string | null, basis: SelectionBasis | null): Selection => ({ provider, basis, scored });
  if (ordered.length === 0) return pick(null, null);
  if (input.requiredProvider !== null) {
    return eligibleSet.has(input.requiredProvider)
      ? pick(input.requiredProvider, "required_provider")
      : pick(null, null);
  }
  if (input.affinityProvider !== null && eligibleSet.has(input.affinityProvider)) {
    return pick(input.affinityProvider, "affinity");
  }
  if (input.preference !== null && eligibleSet.has(input.preference)) {
    return pick(input.preference, "provider_preference");
  }
  const pool = scored.filter((c) => c.provider !== input.excludeFromScore);
  const ranked = (pool.length > 0 ? pool : scored)
    .map((c, index) => ({ c, index }))
    .sort((a, b) => b.c.score - a.c.score || a.index - b.index);
  const best = ranked[0] as { c: ScoredCandidate };
  const second = ranked[1];
  const tied = second === undefined || second.c.score === best.c.score;
  return pick(best.c.provider, tied ? "configured_order" : "score");
}
