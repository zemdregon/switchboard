/**
 * Controller decision kinds and their fixed templates (T5.3; LLD §15.3, ADR-0038 item 3; FR-SES-02, NFR-PRIV-02).
 * PURE: no I/O. A `decision` row's `reason_summary` is one of five templates filled with controller values only: ids,
 * provider ids, route reason codes, hashes, counts and booleans. Every value is checked against a strict token shape, so
 * free text (provider reasoning, a summary, a failure detail, stdout) cannot enter a decision even by mistake: a value
 * that is not a controller token throws {@link DecisionTemplateError}, and nothing is written.
 */

export const DECISION_KINDS = [
  "route_selected",
  "handoff_built",
  "approval_decided",
  "verification_outcome",
  "rollback",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Route reason codes (LLD §15.3, Proposed). T5.3 writes the first two; the rest belong to the T5.6 handoff routing. */
export const ROUTE_REASON_CODES = [
  "new_session",
  "same_provider_resume",
  "provider_named",
  "bound_provider_ineligible",
  "no_binding",
  "resume_directory_unavailable",
  // T6.6 (LLD §16.6, BR-8): a handoff after QUOTA_EXHAUSTED on the previous provider.
  "quota_failover",
] as const;
export type RouteReasonCode = (typeof ROUTE_REASON_CODES)[number];

/** LLD §15.3: at most 500 characters. */
export const DECISION_SUMMARY_MAX = 500;

export type DecisionInput =
  | {
      readonly kind: "route_selected";
      readonly runId: string;
      readonly provider: string;
      readonly mode: "new" | "resume" | "handoff";
      readonly reasons: readonly RouteReasonCode[];
    }
  | {
      readonly kind: "handoff_built";
      readonly runId: string;
      readonly bundleArtifactId: string;
      readonly bundleSha256: string;
      readonly asOfSha256: string;
      readonly sourceRuns: number;
    }
  | {
      readonly kind: "approval_decided";
      readonly runId: string;
      readonly approvalId: string;
      readonly status: "APPROVED" | "DENIED";
      readonly by: "operator" | "client_policy";
    }
  | {
      readonly kind: "verification_outcome";
      readonly runId: string;
      readonly outcome: "passed" | "failed" | "cancelled";
      readonly passed: number;
      readonly failed: number;
      readonly notRun: number;
    }
  | {
      readonly kind: "rollback";
      readonly runId: string;
      readonly head: string;
      readonly evidenceCommit: string;
      readonly mutated: boolean;
    };

export class DecisionTemplateError extends Error {
  override readonly name = "DecisionTemplateError";
}

const ID_RE = /^[a-z]{2,8}_[0-9A-Za-z]{1,40}$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function token(value: unknown, re: RegExp, what: string): string {
  if (typeof value !== "string" || !re.test(value))
    throw new DecisionTemplateError(`${what} is not a controller value`);
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new DecisionTemplateError(`${what} is not one of ${allowed.join(", ")}`);
  }
  return value as T;
}
function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DecisionTemplateError(`${what} is not a non-negative integer`);
  }
  return value;
}

/** The `approval=<id> ` prefix that identifies one `approval_decided` cause inside its summary. */
export function approvalCausePrefix(approvalId: string): string {
  return `approval=${token(approvalId, ID_RE, "approval id")} `;
}

/** Render the fixed template of `input.kind` (LLD §15.3). Throws {@link DecisionTemplateError} on any non-controller value. */
export function renderDecisionSummary(input: DecisionInput): string {
  token(input.runId, ID_RE, "run id");
  let text: string;
  switch (input.kind) {
    case "route_selected": {
      if (input.reasons.length === 0) throw new DecisionTemplateError("route_selected needs at least one reason code");
      const reasons = input.reasons.map((r) => oneOf(r, ROUTE_REASON_CODES, "route reason"));
      text = `provider=${token(input.provider, PROVIDER_RE, "provider id")} mode=${oneOf(input.mode, ["new", "resume", "handoff"], "mode")} reasons=${reasons.join(",")}`;
      break;
    }
    case "handoff_built":
      text = `bundle=${token(input.bundleArtifactId, ID_RE, "bundle artifact id")} sha256=${token(input.bundleSha256, SHA256_RE, "bundle hash")} as_of=${token(input.asOfSha256, SHA256_RE, "as_of hash")} source_runs=${count(input.sourceRuns, "source runs")}`;
      break;
    case "approval_decided":
      text = `${approvalCausePrefix(input.approvalId)}status=${oneOf(input.status, ["APPROVED", "DENIED"], "approval status")} by=${oneOf(input.by, ["operator", "client_policy"], "decider")}`;
      break;
    case "verification_outcome":
      text = `outcome=${oneOf(input.outcome, ["passed", "failed", "cancelled"], "verification outcome")} passed=${count(input.passed, "passed")} failed=${count(input.failed, "failed")} not_run=${count(input.notRun, "not_run")}`;
      break;
    case "rollback":
      text = `head=${token(input.head, GIT_SHA_RE, "head commit")} evidence_commit=${token(input.evidenceCommit, GIT_SHA_RE, "evidence commit")} mutated=${input.mutated === true ? "true" : "false"}`;
      break;
    default:
      throw new DecisionTemplateError("unknown decision kind");
  }
  if (text.length > DECISION_SUMMARY_MAX) throw new DecisionTemplateError("decision summary exceeds its bound");
  return text;
}
