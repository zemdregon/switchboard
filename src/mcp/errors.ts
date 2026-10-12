/**
 * MCP error envelope (LLD §3, FR-MCP-07): exactly one taxonomy code (LLD §4) plus a redacted message.
 *
 * Proposed mappings (Delegated, not owner-approved):
 * - `LifecycleError` `QUEUE_FULL` (bounded ingress queue, FR-CAP-04; ROADMAP Q-5) maps to `ELIGIBILITY_NONE` with
 *   `details.reason = "QUEUE_FULL"`: FRD BR-3 already maps "at concurrency" to `ELIGIBILITY_NONE`, and no taxonomy code
 *   names a full queue. Retryable is false, matching the LLD §4 row ("state may change").
 * - Unexpected exceptions caught at the tool-handler boundary (TDD §3.2) map to `TOOL_FAILURE` with a generic message
 *   (no stack, no input echo), following the FRD WF-3 precedent for internal faults.
 */
import type { FailureCode } from "../adapters/failure.js";
import { LifecycleError } from "../lifecycle/index.js";

/** Codes that may succeed on a later identical attempt (LLD §4 "Retryable?" column, FR-CAP-05). */
const RETRYABLE: ReadonlySet<FailureCode> = new Set(["RATE_LIMIT_TRANSIENT", "PROVIDER_OVERLOADED", "PROCESS_CRASH"]);

export class ToolError extends Error {
  override readonly name = "ToolError";
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly runId?: string,
  ) {
    super(message);
  }
}

export interface ErrorEnvelope {
  error: {
    code: FailureCode;
    message: string;
    retryable: boolean;
    run_id?: string;
    details?: Record<string, unknown>;
  };
}

export const invalid = (message: string, details: Record<string, unknown> = {}): ToolError =>
  new ToolError("INVALID_REQUEST", message, details);

/** Normalise anything thrown by a handler into a ToolError. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof LifecycleError) {
    if (err.code === "QUEUE_FULL") return new ToolError("ELIGIBILITY_NONE", err.message, { reason: "QUEUE_FULL" });
    return new ToolError("INVALID_REQUEST", err.message);
  }
  return new ToolError("TOOL_FAILURE", "internal controller error; see the operator log");
}

export function errorEnvelope(err: ToolError, scrub: (s: string) => string): ErrorEnvelope {
  const details = Object.keys(err.details).length > 0 ? (scrubDeep(err.details, scrub) as Record<string, unknown>) : {};
  return {
    error: {
      code: err.code,
      message: scrub(err.message).slice(0, 2000),
      retryable: RETRYABLE.has(err.code),
      ...(err.runId !== undefined ? { run_id: err.runId } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    },
  };
}

/** Apply `scrub` to every string in a JSON-like value. */
export function scrubDeep(value: unknown, scrub: (s: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub)]));
  }
  return value;
}
