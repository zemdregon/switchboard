/** Failure taxonomy (LLD §4) and shared classification helpers for adapters. */
import type { FailureClassification, FailureEvidence } from "./types.js";

export const FAILURE_CODES = [
  "AUTH_REQUIRED",
  "PERMISSION_BLOCKED",
  "SANDBOX_VIOLATION",
  "MODEL_UNAVAILABLE",
  "QUOTA_EXHAUSTED",
  "RATE_LIMIT_TRANSIENT",
  "PROVIDER_OVERLOADED",
  "TOOL_FAILURE",
  "TEST_FAILURE",
  "PROCESS_TIMEOUT",
  "PROCESS_CRASH",
  "OUTPUT_PROTOCOL_ERROR",
  "ADAPTER_VERSION_UNVERIFIED",
  "CANCELLED",
  "ELIGIBILITY_NONE",
  "INVALID_REQUEST",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * Proposed: normalized `provider_error.category` vocabulary -> taxonomy code. Adapters map native categories onto
 * these strings in parseEvent; unknown categories fall through to TOOL_FAILURE.
 */
export const PROVIDER_ERROR_CATEGORY_CODES: Readonly<Record<string, FailureCode>> = {
  auth: "AUTH_REQUIRED",
  permission: "PERMISSION_BLOCKED",
  sandbox: "SANDBOX_VIOLATION",
  model_unavailable: "MODEL_UNAVAILABLE",
  quota: "QUOTA_EXHAUSTED",
  rate_limit: "RATE_LIMIT_TRANSIENT",
  overloaded: "PROVIDER_OVERLOADED",
  tool: "TOOL_FAILURE",
};

/**
 * Shared precedence for classifyFailure (Proposed): supervisor-determined outcomes first, then structured events,
 * then exit status. Evidence that is not clearly a success never yields success; a clean exit with no `result`
 * event is OUTPUT_PROTOCOL_ERROR.
 */
export function classifyCommon(
  evidence: FailureEvidence,
  categoryCodes: Readonly<Record<string, FailureCode>> = PROVIDER_ERROR_CATEGORY_CODES,
): FailureClassification {
  const { exit, events } = evidence;
  if (evidence.cancelled || exit.outcome === "cancelled") return { code: "CANCELLED", detail: "run cancelled" };
  if (exit.outcome === "protocol_error")
    return { code: "OUTPUT_PROTOCOL_ERROR", detail: "unparseable provider output" };
  if (evidence.timedOut || exit.outcome === "timeout") {
    return { code: "PROCESS_TIMEOUT", detail: `${exit.timeoutKind ?? "unknown"} timeout` };
  }
  if (exit.outcome === "internal_error") return { code: "OUTPUT_PROTOCOL_ERROR", detail: "event handling failed" };
  if (exit.outcome === "crashed" || exit.outcome === "spawn_error") {
    return { code: "PROCESS_CRASH", detail: exit.signal ? `signal ${exit.signal}` : exit.outcome };
  }
  // ADR-0039: Switchboard's own tool-call guard fired, whatever the provider's policy did.
  for (const e of events) {
    if (e.kind !== "tool_call" || e.violation === undefined) continue;
    if (e.violation.kind === "git_write") {
      return { code: "PERMISSION_BLOCKED", detail: `git write attempted: ${e.violation.reason}` };
    }
    return { code: "SANDBOX_VIOLATION", detail: `provider state reached: ${e.violation.reason}` };
  }
  for (const e of events) {
    if (e.kind === "permission_denied") return { code: "PERMISSION_BLOCKED", detail: `denied: ${e.tool}` };
    if (e.kind === "sandbox_violation") return { code: "SANDBOX_VIOLATION", detail: e.detail };
  }
  for (const e of events) {
    if (e.kind === "provider_error") {
      return { code: categoryCodes[e.category] ?? "TOOL_FAILURE", detail: `${e.category}: ${e.message}` };
    }
  }
  if (events.some((e) => e.kind === "rate_limit")) {
    return { code: "RATE_LIMIT_TRANSIENT", detail: "rate limit reported" };
  }
  const result = events.findLast((e) => e.kind === "result");
  if (result?.kind === "result" && !result.ok) return { code: "TOOL_FAILURE", detail: result.summary ?? "task failed" };
  if (exit.exitCode !== null && !exit.expectedExitCodes.includes(exit.exitCode)) {
    return { code: "TOOL_FAILURE", detail: `exit code ${exit.exitCode}` };
  }
  return { code: "OUTPUT_PROTOCOL_ERROR", detail: "no result event" };
}
