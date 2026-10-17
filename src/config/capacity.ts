/**
 * `capacity` configuration (M6, T6.2; LLD §16.1, ADR-0043). The JSON schema in `schema.ts` checks types and ranges;
 * this module adds the cross-field rules (`retry.base_ms <= retry.cap_ms`; T6.13's subscription rules) and resolves
 * defaults. Every default is an Assumption with no measurement behind it (Q-69 to Q-72, Q-98).
 *
 * T6.13 (FR-CAP-09, LLD §16.9, ADR-0055 item 5): `subscriptions` and `pacing` are resolved only when the file sets one
 * of them, so a configuration without them resolves exactly as before.
 */
import { adapterIdForConfigId, configProviderIds } from "../adapters/providers.js";
import {
  type CapacityConfigInput,
  DEFAULT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_BREAKER_OPEN_SECONDS,
  DEFAULT_CAPACITY_CONFIDENCE_RUNS,
  DEFAULT_CAPACITY_QUEUE_HORIZON_SECONDS,
  DEFAULT_CAPACITY_WINDOW_SECONDS,
  DEFAULT_PACING_BURST_FRACTION,
  DEFAULT_PACING_MIN_CONFIDENCE,
  DEFAULT_PACING_MODE,
  DEFAULT_PACING_TARGET_FRACTION,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_CAP_MS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  type PacingMode,
  type UsageBudgetUnit,
} from "./schema.js";

/** A resolved usage window (LLD §16.9). A `fixed` anchor is held as a canonical ISO instant. */
export interface UsageWindowSettings {
  id: string;
  lengthSeconds: number;
  reset: { kind: "provider_reported" } | { kind: "fixed"; anchor: string } | { kind: "rolling" };
  budget: { unit: UsageBudgetUnit; value: number } | null;
}

/** A resolved subscription: its config provider ids, the adapter ids the ledger records them under, its windows. */
export interface SubscriptionSettings {
  name: string;
  providers: string[];
  adapterIds: string[];
  windows: UsageWindowSettings[];
}

export interface PacingSettings {
  mode: PacingMode;
  targetFraction: number;
  burstFraction: number;
  minConfidence: number;
}

/** Resolved `capacity` section; every key set. `subscriptions` and `pacing` only when the file sets either. */
export interface CapacitySettings {
  windowSeconds: number;
  confidenceRuns: number;
  queueHorizonSeconds: number;
  breaker: { failureThreshold: number; openSeconds: number };
  retry: { maxAttempts: number; baseMs: number; capMs: number };
  /** Sorted by name; empty when only `pacing` is set. */
  subscriptions?: SubscriptionSettings[];
  pacing?: PacingSettings;
}

export function resolveCapacity(input: CapacityConfigInput | undefined): CapacitySettings {
  const settings: CapacitySettings = {
    windowSeconds: input?.window_seconds ?? DEFAULT_CAPACITY_WINDOW_SECONDS,
    confidenceRuns: input?.confidence_runs ?? DEFAULT_CAPACITY_CONFIDENCE_RUNS,
    queueHorizonSeconds: input?.queue_horizon_seconds ?? DEFAULT_CAPACITY_QUEUE_HORIZON_SECONDS,
    breaker: {
      failureThreshold: input?.breaker?.failure_threshold ?? DEFAULT_BREAKER_FAILURE_THRESHOLD,
      openSeconds: input?.breaker?.open_seconds ?? DEFAULT_BREAKER_OPEN_SECONDS,
    },
    retry: {
      maxAttempts: input?.retry?.max_attempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
      baseMs: input?.retry?.base_ms ?? DEFAULT_RETRY_BASE_MS,
      capMs: input?.retry?.cap_ms ?? DEFAULT_RETRY_CAP_MS,
    },
  };
  if (input?.subscriptions === undefined && input?.pacing === undefined) return settings;
  settings.subscriptions = Object.entries(input.subscriptions ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, sub]) => ({
      name,
      providers: [...sub.providers],
      adapterIds: sub.providers.map((p) => adapterIdForConfigId(p) ?? p),
      windows: sub.windows.map((w) => ({
        id: w.id,
        lengthSeconds: w.length_seconds,
        reset:
          w.reset.kind === "fixed"
            ? { kind: "fixed", anchor: new Date(Date.parse(w.reset.anchor ?? "")).toISOString() }
            : { kind: w.reset.kind },
        budget: w.budget === undefined ? null : { unit: w.budget.unit, value: w.budget.value },
      })),
    }));
  settings.pacing = {
    mode: input.pacing?.mode ?? DEFAULT_PACING_MODE,
    targetFraction: input.pacing?.target_fraction ?? DEFAULT_PACING_TARGET_FRACTION,
    burstFraction: input.pacing?.burst_fraction ?? DEFAULT_PACING_BURST_FRACTION,
    minConfidence: input.pacing?.min_confidence ?? DEFAULT_PACING_MIN_CONFIDENCE,
  };
  return settings;
}

/** An ISO 8601 instant with an explicit offset (a `fixed` window anchor); local times are refused as ambiguous. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Cross-field checks the JSON schema cannot express; one message per problem, JSON-path prefixed. Run after schema
 * validation. `providerIds` defaults to the registered config provider ids.
 */
export function checkCapacity(
  input: CapacityConfigInput | undefined,
  providerIds: readonly string[] = configProviderIds(),
): string[] {
  const errors: string[] = [];
  // Resolve without `subscriptions`: an anchor is only parsed once the checks below have passed.
  const { subscriptions: _subscriptions, ...rest } = input ?? {};
  const resolved = resolveCapacity(rest);
  if (resolved.retry.baseMs > resolved.retry.capMs) {
    errors.push(`$.capacity.retry.base_ms: must not exceed capacity.retry.cap_ms (${resolved.retry.capMs})`);
  }
  const known = new Set(providerIds);
  const owner = new Map<string, string>();
  for (const [name, sub] of Object.entries(input?.subscriptions ?? {})) {
    const at = `$.capacity.subscriptions.${name}`;
    sub.providers.forEach((p, i) => {
      if (!known.has(p)) errors.push(`${at}.providers[${i}]: ${JSON.stringify(p)} is not a configured provider id`);
      const first = owner.get(p);
      if (first !== undefined) {
        errors.push(
          `${at}.providers[${i}]: ${JSON.stringify(p)} is already in subscription ${JSON.stringify(first)}; ` +
            "a provider is in at most one subscription",
        );
      } else owner.set(p, name);
    });
    const ids = new Set<string>();
    sub.windows.forEach((w, i) => {
      const wat = `${at}.windows[${i}]`;
      if (ids.has(w.id)) errors.push(`${wat}.id: ${JSON.stringify(w.id)} is not unique in the subscription`);
      ids.add(w.id);
      if (w.reset.kind === "fixed") {
        const a = w.reset.anchor;
        if (a === undefined) errors.push(`${wat}.reset.anchor: required for a fixed reset`);
        else if (!ISO_INSTANT.test(a) || !Number.isFinite(Date.parse(a))) {
          errors.push(`${wat}.reset.anchor: must be an ISO 8601 instant with an offset, e.g. 2026-10-17T00:00:00Z`);
        }
      } else if (w.reset.anchor !== undefined) {
        errors.push(`${wat}.reset.anchor: only a fixed reset takes an anchor`);
      }
    });
  }
  return errors;
}
