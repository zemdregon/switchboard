/**
 * MCP error envelope (LLD §3, FR-MCP-07): exactly one taxonomy code (LLD §4) plus a redacted message.
 *
 * Proposed mappings (Delegated, not owner-approved):
 * - `LifecycleError` `QUEUE_FULL` (bounded ingress queue, FR-CAP-04; ROADMAP Q-5) maps to `ELIGIBILITY_NONE` with
 *   `details.reason = "QUEUE_FULL"`: FRD BR-3 already maps "at concurrency" to `ELIGIBILITY_NONE`, and no taxonomy code
 *   names a full queue. Retryable is false, matching the LLD §4 row ("state may change").
 * - `ProfileUnavailableError` from COMP-POL (`src/policy`, T2.6) carries its own code: PERMISSION_BLOCKED for
 *   `privileged`, ELIGIBILITY_NONE for a profile no M2 adapter can compile.
 * - `HandoffBundleError` (T5.6, ADR-0038 item 7) maps to its own `TOOL_FAILURE` with `details.reason`
 *   `HANDOFF_BUNDLE_UNAVAILABLE` and its fixed message.
 * - `SkillAdmissionError` (T16.4, LLD §19.5, FRD V15, C8) carries its own code (`INVALID_REQUEST` or
 *   `PERMISSION_BLOCKED`) and `details.reason` (and the requested `skill` reference when one failed).
 * - Unexpected exceptions caught at the tool-handler boundary (TDD §3.2) map to `TOOL_FAILURE` with a generic message
 *   (no stack, no input echo), following the FRD WF-3 precedent for internal faults.
 */
import type { FailureCode } from "../adapters/failure.js";
import { HandoffBundleError } from "../continuity/index.js";
import { LifecycleError } from "../lifecycle/index.js";
import { ProfileUnavailableError } from "../policy/index.js";
import { SkillAdmissionError } from "../skills/admission.js";

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
  // T5.6 (ADR-0038 item 7): a bundle that cannot be built is TOOL_FAILURE, not retryable, with the fixed message and
  // `details.reason = "HANDOFF_BUNDLE_UNAVAILABLE"`; the internal cause stays in the controller.
  if (err instanceof HandoffBundleError) return new ToolError(err.code, err.message, { reason: err.details.reason });
  if (err instanceof SkillAdmissionError) return new ToolError(err.code, err.message, { ...err.details });
  if (err instanceof LifecycleError) {
    if (err.code === "QUEUE_FULL") return new ToolError("ELIGIBILITY_NONE", err.message, { reason: "QUEUE_FULL" });
    // T14.4 (FR-CTL-06): an operator budget refusal, the same code as `QUEUE_FULL` (nothing is written, the state may
    // change); `details` names the cap as the digest does and the needs-attention reason `budget_exhausted`.
    if (err.code === "BUDGET_EXHAUSTED") return new ToolError("ELIGIBILITY_NONE", err.message, { ...err.details });
    // T14.6 (FR-CTL-05): a paused project or a global pause admits nothing; `details.reason` is PROJECT_PAUSED or
    // GLOBAL_PAUSED (with `project_id` when scoped), as QUEUE_FULL: no taxonomy code names a held admission.
    if (err.code === "PAUSED") return new ToolError("ELIGIBILITY_NONE", err.message, { ...err.details });
    return new ToolError("INVALID_REQUEST", err.message);
  }
  // COMP-POL refused to resolve the profile (fail closed, NFR-SEC-06); the error names its own taxonomy code.
  if (err instanceof ProfileUnavailableError)
    return new ToolError(err.code, err.message, { trust_profile: err.profile });
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
