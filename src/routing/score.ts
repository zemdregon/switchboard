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
/**
 * The six weights, plus the seventh `pacing` weight (T7.15, LLD §17.7) when the decision carries the term. The `pacing`
 * term is summed after the six, in that fixed order.
 */
export type Weights = Record<ScoreTerm, number> & { pacing?: number };
export type Terms = Record<ScoreTerm, number> & { pacing?: number };

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

/**
 * Terms and score for each candidate in `candidates`, in that order. A candidate is a provider, or with a model group a
 * member keyed `<provider>/<model>` (T7.15): `providerOf` maps it to the provider whose ledger facts and `pacing` term
 * it takes (absent: the candidate is the provider). `pacing` holds the `pacing` term per provider (LLD §17.7); absent,
 * the term is left out of both sums, so the six-term score is computed exactly as before.
 */
export function scoreCandidates(
  candidates: readonly string[],
  inputs: Readonly<Record<string, ScoreInputs>>,
  weights: Readonly<Weights>,
  providerOf?: Readonly<Record<string, string>>,
  pacing?: Readonly<Record<string, number>>,
): ScoredCandidate[] {
  const prov = (c: string): string => providerOf?.[c] ?? c;
  const of = (c: string): ScoreInputs => inputs[prov(c)] ?? EMPTY_INPUTS;
  const medians = candidates.map((c) => of(c).median_ms).filter((m): m is number => m !== null);
  const fastest = medians.length > 0 ? Math.min(...medians) : null;
  const pacingWeight = pacing !== undefined ? (weights.pacing ?? 0) : 0;
  const sixWeight = SCORE_TERMS.reduce((sum, t) => sum + weights[t], 0);
  const totalWeight = pacing !== undefined ? sixWeight + pacingWeight : sixWeight;
  return candidates.map((provider) => {
    const i = of(provider);
    const terms: Terms = {
      success: (i.healthy + 1) / (i.healthy + i.counted + 2),
      latency: i.median_ms === null || fastest === null ? NEUTRAL : i.median_ms === 0 ? 1 : fastest / i.median_ms,
      capacity: i.capacity_score === null ? 0 : clamp01(i.capacity_score),
      security: NEUTRAL,
      handoff: i.session_bound ? 1 : 0,
      cost: NEUTRAL,
    };
    let weighted = SCORE_TERMS.reduce((sum, t) => sum + weights[t] * terms[t], 0);
    if (pacing !== undefined) {
      terms.pacing = pacing[prov(provider)] ?? 0;
      weighted += pacingWeight * terms.pacing;
    }
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
  /**
   * T7.15: candidate id to provider for group members (`<provider>/<model>`). `requiredProvider` and `preference` name
   * providers and select among their members (highest score, then member order). Absent: candidates are providers.
   */
  providerOf?: Readonly<Record<string, string>>;
  /** T7.15: the `pacing` term per provider (LLD §17.7); absent, the six-term score. */
  pacing?: Readonly<Record<string, number>>;
}

export interface Selection {
  /** Null when no candidate is eligible (the caller refuses with the BR-3 code). */
  provider: string | null;
  basis: SelectionBasis | null;
  /** Every eligible candidate, in configured order, with its terms and score. */
  scored: ScoredCandidate[];
}

/** LLD §17.3 selection (and §17.7 with members); first match wins. */
export function selectRoute(input: SelectionInput): Selection {
  const eligibleSet = new Set(input.eligible);
  const ordered = [
    ...input.candidateOrder.filter((p) => eligibleSet.has(p)),
    // Admissible providers missing from the order (never expected) keep a stable place at the end.
    ...[...eligibleSet].filter((p) => !input.candidateOrder.includes(p)).sort(),
  ];
  const scored = scoreCandidates(ordered, input.scoreInputs, input.weights, input.providerOf, input.pacing);
  const pick = (provider: string | null, basis: SelectionBasis | null): Selection => ({ provider, basis, scored });
  if (ordered.length === 0) return pick(null, null);
  const best = (pool: readonly ScoredCandidate[]) =>
    pool
      .map((c, index) => ({ c, index }))
      .sort((a, b) => b.c.score - a.c.score || a.index - b.index)
      .map((x) => x.c);
  const providerOf = input.providerOf;
  if (providerOf !== undefined) {
    // LLD §17.7: `require_provider` and `provider_preference` name a provider; selection is among its members. A held
    // affine member among them stays the choice, so the model does not move without a reason.
    const membersOf = (p: string) => scored.filter((c) => providerOf[c.provider] === p);
    const within = (p: string, basis: SelectionBasis): Selection | undefined => {
      const pool = membersOf(p);
      if (pool.length === 0) return undefined;
      const affine = pool.find((c) => c.provider === input.affinityProvider);
      return pick((affine ?? (best(pool)[0] as ScoredCandidate)).provider, basis);
    };
    if (input.requiredProvider !== null) return within(input.requiredProvider, "required_provider") ?? pick(null, null);
    if (input.affinityProvider !== null && eligibleSet.has(input.affinityProvider)) {
      return pick(input.affinityProvider, "affinity");
    }
    if (input.preference !== null) {
      const chosen = within(input.preference, "provider_preference");
      if (chosen !== undefined) return chosen;
    }
  } else {
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
  }
  const pool = scored.filter((c) => c.provider !== input.excludeFromScore);
  const ranked = best(pool.length > 0 ? pool : scored);
  const top = ranked[0] as ScoredCandidate;
  const second = ranked[1];
  const tied = second === undefined || second.score === top.score;
  return pick(top.provider, tied ? "configured_order" : "score");
}

/**
 * LLD §16.9 and §17.7: the `pacing` term of one candidate from its subscription's stored inputs. Mode `off`: 0.5 for
 * every candidate (neutral). No subscription, or no known allowance: 0. Otherwise `clamp(allowance / (2T), 0, 1)` for
 * the binding window.
 */
export function pacingTerm(mode: string, sub: { T: number; allowance: number | null } | null | undefined): number {
  if (mode === "off") return NEUTRAL;
  if (sub === null || sub === undefined || sub.allowance === null || !(sub.T > 0)) return 0;
  return clamp01(sub.allowance / (2 * sub.T));
}
