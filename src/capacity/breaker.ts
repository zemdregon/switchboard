/**
 * Per-provider circuit breaker (M6, T6.4; FR-CAP-04, LLD §16.4, ADR-0043 item 3). Pure state machine over the
 * `provider_health` breaker columns; the lifecycle reads and writes the row and appends the events.
 *
 * - Counted: `RATE_LIMIT_TRANSIENT`, `PROVIDER_OVERLOADED`, `PROCESS_CRASH` (a crash after a controller restart never
 *   reaches the lifecycle and is also excluded by its marker). `failureThreshold` in a row open it until
 *   `now + openSeconds`; a counted failure while `HALF_OPEN` re-opens it.
 * - Healthy: `SUCCEEDED`, or `TEST_FAILURE`, `TOOL_FAILURE`, `PERMISSION_BLOCKED`, `SANDBOX_VIOLATION` after the
 *   provider ran. Resets the count and closes a `HALF_OPEN` breaker.
 * - Anything else (cancel, quota, timeout, pre-spawn refusals) leaves the row unchanged.
 * - Admission: `CLOSED` allows; `OPEN` before `until` denies; `OPEN` at or after `until`, and `HALF_OPEN`, admit one
 *   probe run at a time (the caller checks that none is in a slot state).
 */
import type { BreakerState } from "./estimate.js";

export interface BreakerSnapshot {
  state: BreakerState;
  until: string | null;
  consecutiveFailures: number;
  lastFailureCode: string | null;
}

export interface BreakerSettings {
  failureThreshold: number;
  openSeconds: number;
}

export type BreakerOutcome = "counted" | "healthy" | "neutral";
export type BreakerTransition = "breaker_opened" | "breaker_closed";
export type BreakerAdmission = "allow" | "deny" | "probe";

export const CLOSED_BREAKER: BreakerSnapshot = Object.freeze({
  state: "CLOSED",
  until: null,
  consecutiveFailures: 0,
  lastFailureCode: null,
});

export const BREAKER_COUNTED_CODES: ReadonlySet<string> = new Set([
  "RATE_LIMIT_TRANSIENT",
  "PROVIDER_OVERLOADED",
  "PROCESS_CRASH",
]);
const HEALTHY_FAILURE_CODES: ReadonlySet<string> = new Set([
  "TEST_FAILURE",
  "TOOL_FAILURE",
  "PERMISSION_BLOCKED",
  "SANDBOX_VIOLATION",
]);

/** Classify a terminal run for the breaker (LLD §16.4 table). */
export function breakerOutcome(run: {
  state: string;
  failure_code: string | null;
  failure_detail?: string | null;
  started_at: string | null;
}): BreakerOutcome {
  if (run.state === "SUCCEEDED") return "healthy";
  if (run.state !== "FAILED" || run.failure_code === null) return "neutral";
  if (BREAKER_COUNTED_CODES.has(run.failure_code)) {
    return (run.failure_detail ?? "").includes("cause controller_restart") ? "neutral" : "counted";
  }
  return HEALTHY_FAILURE_CODES.has(run.failure_code) && run.started_at !== null ? "healthy" : "neutral";
}

/** Apply one outcome. Returns the next snapshot and the transition to record, if any. Unchanged input: same object. */
export function applyBreakerOutcome(
  cur: BreakerSnapshot,
  outcome: BreakerOutcome,
  failureCode: string | null,
  settings: BreakerSettings,
  now: Date,
): { next: BreakerSnapshot; transition?: BreakerTransition } {
  if (outcome === "neutral") return { next: cur };
  if (outcome === "healthy") {
    // A probe's success closes the breaker; a straggler finishing while OPEN only resets the count.
    if (cur.state === "HALF_OPEN") {
      return { next: { ...CLOSED_BREAKER, lastFailureCode: cur.lastFailureCode }, transition: "breaker_closed" };
    }
    return cur.consecutiveFailures === 0 ? { next: cur } : { next: { ...cur, consecutiveFailures: 0 } };
  }
  const failures = cur.consecutiveFailures + 1;
  const until = new Date(now.getTime() + settings.openSeconds * 1000).toISOString();
  if (cur.state === "HALF_OPEN" || (cur.state === "CLOSED" && failures >= settings.failureThreshold)) {
    return {
      next: { state: "OPEN", until, consecutiveFailures: failures, lastFailureCode: failureCode },
      transition: "breaker_opened",
    };
  }
  return { next: { ...cur, consecutiveFailures: failures, lastFailureCode: failureCode } };
}

/** May a run of this provider be admitted or dispatched now? */
export function breakerAdmission(cur: BreakerSnapshot, now: Date): BreakerAdmission {
  if (cur.state === "CLOSED") return "allow";
  if (cur.state === "OPEN" && cur.until !== null && Date.parse(cur.until) > now.getTime()) return "deny";
  return "probe";
}
