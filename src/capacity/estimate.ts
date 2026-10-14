/**
 * Capacity estimator (M6, T6.2; FR-CAP-02, FR-CAP-03, LLD §16.2, ADR-0043 items 1 and 2).
 *
 * A pure function of the inputs the collector read from the ledger, the configuration and a clock: no I/O, no
 * randomness, no stored state. Reported values (`reset_at`, `explicit_remaining`) and controller estimates
 * (`capacity_score`, `confidence`, `throttle_risk`) are separate fields with their own source label (FR-CAP-01).
 *
 * Fail closed on unknown capacity: with no evidence in the window the estimate is `unknown` / `null` / confidence 0 and
 * is never presented as headroom. `explicit_remaining` comes only from a key declared in `REMAINING_KEYS`, which is
 * empty because no provider's run output reports remaining quota (T6.0 inventory).
 */

import { type CacheObservation, cacheObservation } from "./cache.js";

/** Breaker states as stored in `provider_health` (LLD §1, §16.4). */
export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";
export type ThrottleRisk = "unknown" | "low" | "elevated" | "high";

/** Labels of the inputs that contributed (LLD §16.2 table). */
export type CapacitySource =
  | "controller:breaker"
  | "controller:concurrency"
  | "controller:run_outcomes"
  | "operator:weight"
  | "provider_reported:rate_limit"
  | "provider_reported:usage";

/**
 * Provider-reported remaining-capacity keys per provider id: `metrics_json` key and its unit. Empty on purpose: no
 * sourced run output reports remaining quota (docs/research/capacity-signals-2026-10-14.md). A key is added here only
 * with a source citation, by the task that wires it.
 */
export const REMAINING_KEYS: Readonly<Record<string, { key: string; unit: string }>> = Object.freeze({});

export interface CapacityRunInput {
  state: "SUCCEEDED" | "FAILED" | "CANCELLED";
  failureCode: string | null;
  /** The provider process was started (the run reached RUNNING). */
  started: boolean;
  /** A `PROCESS_CRASH` recorded by reconciliation after a controller restart (never counted, LLD §16.4). */
  controllerRestart: boolean;
}

export interface CapacityInputs {
  provider: string;
  enabled: boolean;
  /** `providers.<id>.weight` (ADR-0007 prior); null when unset. */
  weight: number | null;
  /** Terminal runs finished inside the window. */
  runs: readonly CapacityRunInput[];
  /** Provider-reported `rate_limit` signals inside the window. */
  rateLimitSignals: readonly { resetAt: string | null }[];
  /** `provider_reported` usage rows inside the window (metrics as stored). */
  usage: readonly { metrics: Readonly<Record<string, unknown>>; observedAt: string }[];
  breaker: { state: BreakerState; until: string | null; consecutiveFailures: number };
  slots: { inUse: number; limit: number };
}

export interface EstimatorSettings {
  windowSeconds: number;
  confidenceRuns: number;
}

export interface ExplicitRemaining {
  value: number;
  unit: string;
  source: "provider_reported";
  observed_at: string;
}

/** One provider entry of the projection (LLD §16.3). Keys are emitted in this order, then canonicalised. */
export interface ProviderCapacity {
  provider: string;
  enabled: boolean;
  capacity_score: number | null;
  confidence: number;
  throttle_risk: ThrottleRisk;
  estimate_source: "controller_estimated";
  sources: CapacitySource[];
  explicit_remaining: ExplicitRemaining | null;
  reset_at: { at: string; source: "provider_reported" } | null;
  concurrency_available: number;
  concurrency_limit: number;
  breaker: { state: BreakerState; until: string | null; consecutive_failures: number };
  window: {
    terminal_runs: number;
    counted_failures: number;
    quota_exhausted: number;
    rate_limit_signals: number;
    usage_observations: number;
  };
  /** T6.7 (FR-CAP-08): reported cache counts over the window; absent when no sourced key or no row holds one. */
  cache?: CacheObservation;
}

/** Failure codes that signal throttling (`elevated`, LLD §16.2 step 3) and that the breaker counts (§16.4). */
export const THROTTLE_CODES: ReadonlySet<string> = new Set(["RATE_LIMIT_TRANSIENT", "PROVIDER_OVERLOADED"]);

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function estimateCapacity(inputs: CapacityInputs, settings: EstimatorSettings, now: Date): ProviderCapacity {
  const sources = new Set<CapacitySource>(["controller:concurrency"]);
  const startedRuns = inputs.runs.filter((r) => r.started);
  const quotaExhausted = inputs.runs.filter((r) => r.failureCode === "QUOTA_EXHAUSTED").length;
  const throttled = inputs.runs.filter((r) => r.failureCode !== null && THROTTLE_CODES.has(r.failureCode)).length;
  const crashed = inputs.runs.filter((r) => r.failureCode === "PROCESS_CRASH" && !r.controllerRestart).length;
  const breakerNotClosed = inputs.breaker.state !== "CLOSED";

  // Step 1: evidence.
  const evidence = startedRuns.length > 0 || inputs.rateLimitSignals.length > 0 || breakerNotClosed;
  if (inputs.runs.length > 0) sources.add("controller:run_outcomes");
  if (breakerNotClosed) sources.add("controller:breaker");
  if (inputs.rateLimitSignals.length > 0) sources.add("provider_reported:rate_limit");
  if (inputs.usage.length > 0) sources.add("provider_reported:usage");

  // Step 2: the latest provider-reported reset still in the future.
  let resetAt: string | null = null;
  for (const s of inputs.rateLimitSignals) {
    const t = s.resetAt === null ? Number.NaN : Date.parse(s.resetAt);
    if (Number.isFinite(t) && t > now.getTime()) {
      const iso = new Date(t).toISOString();
      if (resetAt === null || iso > resetAt) resetAt = iso;
    }
  }

  // Step 3: throttle risk, first match wins.
  let throttleRisk: ThrottleRisk;
  if (breakerNotClosed || resetAt !== null || quotaExhausted > 0) throttleRisk = "high";
  else if (throttled > 0 || inputs.rateLimitSignals.length > 0) throttleRisk = "elevated";
  else if (evidence) throttleRisk = "low";
  else throttleRisk = "unknown";

  // Step 4: score (a relative estimate, never a quota percentage).
  const prior = inputs.weight ?? 1;
  if (inputs.weight !== null && throttleRisk !== "unknown" && throttleRisk !== "high") sources.add("operator:weight");
  let capacityScore: number | null;
  if (throttleRisk === "unknown") capacityScore = null;
  else if (throttleRisk === "high") capacityScore = 0;
  else capacityScore = round2(prior * (throttleRisk === "low" ? 1 : 0.5));

  // Step 5: confidence.
  let confidence: number;
  if (throttleRisk === "unknown") confidence = 0;
  else if (throttleRisk === "high" && (breakerNotClosed || resetAt !== null)) confidence = 1;
  else confidence = round2(Math.min(1, inputs.runs.length / settings.confidenceRuns));

  // Step 6: provider-reported remaining capacity, only from a declared key.
  let explicitRemaining: ExplicitRemaining | null = null;
  const declared = REMAINING_KEYS[inputs.provider];
  if (declared !== undefined) {
    for (const row of inputs.usage) {
      const v = row.metrics[declared.key];
      if (typeof v === "number" && Number.isFinite(v)) {
        explicitRemaining = { value: v, unit: declared.unit, source: "provider_reported", observed_at: row.observedAt };
      }
    }
  }

  // Step 7: slots (controller facts).
  const available = Math.max(0, inputs.slots.limit - inputs.slots.inUse);
  // T6.7 (FR-CAP-08): reported cache counts, labelled; never estimated, never an input to the estimate.
  const cache = cacheObservation(inputs.provider, inputs.usage);

  return {
    provider: inputs.provider,
    enabled: inputs.enabled,
    capacity_score: capacityScore,
    confidence,
    throttle_risk: throttleRisk,
    estimate_source: "controller_estimated",
    sources: [...sources].sort(),
    explicit_remaining: explicitRemaining,
    reset_at: resetAt === null ? null : { at: resetAt, source: "provider_reported" },
    concurrency_available: available,
    concurrency_limit: inputs.slots.limit,
    breaker: {
      state: inputs.breaker.state,
      until: inputs.breaker.until,
      consecutive_failures: inputs.breaker.consecutiveFailures,
    },
    window: {
      terminal_runs: inputs.runs.length,
      counted_failures: throttled + crashed,
      quota_exhausted: quotaExhausted,
      rate_limit_signals: inputs.rateLimitSignals.length,
      usage_observations: inputs.usage.length,
    },
    ...(cache !== undefined ? { cache } : {}),
  };
}
