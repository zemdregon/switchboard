/**
 * `capacity` configuration (M6, T6.2; LLD §16.1, ADR-0043). The JSON schema in `schema.ts` checks types and ranges;
 * this module adds the one cross-field rule (`retry.base_ms <= retry.cap_ms`) and resolves defaults. Every default is an
 * Assumption with no measurement behind it (Q-69 to Q-72).
 */
import {
  type CapacityConfigInput,
  DEFAULT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_BREAKER_OPEN_SECONDS,
  DEFAULT_CAPACITY_CONFIDENCE_RUNS,
  DEFAULT_CAPACITY_QUEUE_HORIZON_SECONDS,
  DEFAULT_CAPACITY_WINDOW_SECONDS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_CAP_MS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
} from "./schema.js";

/** Resolved `capacity` section; every key set. */
export interface CapacitySettings {
  windowSeconds: number;
  confidenceRuns: number;
  queueHorizonSeconds: number;
  breaker: { failureThreshold: number; openSeconds: number };
  retry: { maxAttempts: number; baseMs: number; capMs: number };
}

export function resolveCapacity(input: CapacityConfigInput | undefined): CapacitySettings {
  return {
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
}

/** Cross-field checks the JSON schema cannot express; one message per problem, JSON-path prefixed. */
export function checkCapacity(input: CapacityConfigInput | undefined): string[] {
  const resolved = resolveCapacity(input);
  return resolved.retry.baseMs > resolved.retry.capMs
    ? [`$.capacity.retry.base_ms: must not exceed capacity.retry.cap_ms (${resolved.retry.capMs})`]
    : [];
}
