/**
 * Adapter conformance harness skeleton (FR-ADP-11, TDD §3.6). Reusable by M2's real adapters: each supplies cases
 * whose adapter points at recorded-fixture replay scripts instead of a live provider. The harness drives the
 * supervisor and the adapter and checks the normalized result against the case's expectation. Framework-neutral:
 * it returns a report rather than calling test APIs.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { auditInvocation, BYPASS_FLAGS, type BypassContext } from "./audit.js";
import { FAILURE_CODES, type FailureCode } from "./failure.js";
import { startAdapterRun } from "./run.js";
import {
  type CompileRequest,
  isIneligible,
  type NativeBinding,
  type NormalizedEvent,
  type ProviderAdapter,
  type ResolvedProfile,
  type RunResult,
} from "./types.js";

/** Cases FR-ADP-11 requires, plus the extras T1.7 exercises. */
export type ConformanceCaseKind =
  | "success"
  | "task_failure"
  | "auth_missing"
  | "malformed_output"
  | "cancellation"
  | "resume"
  | "rate_limit"
  | "partial_mutation"
  | "timeout";

export interface ConformanceExpectation {
  ok: boolean;
  failureCode?: FailureCode;
  /**
   * Exact `failureDetail` the result must carry. Set it when code, session id and mutation alone would also match a
   * run the replay refused (exit 64 or 65 with no output), so the case proves the fixture was replayed.
   */
  failureDetail?: string;
  /**
   * Native session id the result must carry (also the id a resume case must preserve). `null`: the run must bind no
   * session, so a fixture that binds one cannot stand in for one that does not.
   */
  nativeSessionId?: string | null;
  /** Exact result summary, or `null` for none. Tells apart cases whose code, detail and session id agree. */
  summary?: string | null;
  /** Exact count of provider events the parser did not recognize. */
  unknownEventCount?: number;
  /** Path relative to the request cwd that must exist after the run (workspace mutation evidence). */
  mutatedPath?: string;
}

export interface ConformanceCase {
  kind: ConformanceCaseKind;
  /** Adapter configured to replay this case (a scripted fake or a recorded-fixture replay). */
  adapter: ProviderAdapter;
  request: CompileRequest;
  profile: ResolvedProfile;
  expect: ConformanceExpectation;
  /** For `resume`: the binding to resume from. */
  binding?: NativeBinding;
}

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface ConformanceCaseReport {
  kind: ConformanceCaseKind;
  ok: boolean;
  checks: ConformanceCheck[];
  result?: RunResult;
}
export interface ConformanceReport {
  ok: boolean;
  cases: ConformanceCaseReport[];
}

/** The run context the argv audit sees for a case: its profile and the request's bypassApproved (T3.17). */
function bypassContext(c: ConformanceCase): BypassContext {
  return { profile: c.profile, bypassApproved: c.request.bypassApproved === true };
}

/** Static checks that need no process: purity, argv shape, bypass audit, never-success classification. */
export function checkAdapterStatics(c: ConformanceCase): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const a = c.adapter;
  const inv1 = c.binding ? a.resumeArgs(c.binding, c.request, c.profile) : a.compile(c.request, c.profile);
  const inv2 = c.binding ? a.resumeArgs(c.binding, c.request, c.profile) : a.compile(c.request, c.profile);
  if (isIneligible(inv1)) {
    check("compiles", false, `ineligible: ${inv1.reason}`);
    return checks;
  }
  check("compile is deterministic", JSON.stringify(inv1) === JSON.stringify(inv2));
  check("argv[0] is absolute", isAbsolute(inv1.argv[0] ?? ""), inv1.argv[0]);
  check("cwd is the request cwd", inv1.cwd === c.request.workspace.cwd);
  check("exit code 0 is expected", inv1.expectedExitCodes.includes(0));
  // T3.17: a bypass flag passes only for an approved privileged scope with bypass (the case's own run context).
  const bypass = auditInvocation(inv1, bypassContext(c));
  check("no refused bypass flags in argv/policyFlags", bypass.length === 0, bypass.join(",") || BYPASS_FLAGS.join(" "));
  const ev = a.classifyFailure({
    events: [],
    exit: { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: inv1.expectedExitCodes },
    stderrTail: "",
    timedOut: false,
    cancelled: false,
  });
  check("clean exit without a result event is not success", FAILURE_CODES.includes(ev.code), ev.code);
  // Without an approval no compile may carry a bypass flag, whatever the profile (FR-POL-03).
  const priv = a.compile(
    { ...c.request, bypassApproved: false },
    { ...c.profile, name: "privileged", bypassApproved: false },
  );
  check("privileged profile is never silently downgraded", isIneligible(priv) || !auditInvocation(priv).length);
  const unapproved = a.compile({ ...c.request, bypassApproved: false }, c.profile);
  check("no bypass flag without bypassApproved", isIneligible(unapproved) || !auditInvocation(unapproved).length);
  return checks;
}

/**
 * The checks a finished run's `result` (in workspace `cwd`) must pass for `exp`. Exported so a suite can hold one
 * case's expectation against another case's run and show the expectation tells the two fixtures apart.
 */
export function checkExpectation(exp: ConformanceExpectation, result: RunResult, cwd: string): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  check("result.ok matches", result.ok === exp.ok, `ok=${result.ok}`);
  check("failure code matches", result.failureCode === exp.failureCode, `code=${result.failureCode ?? "none"}`);
  if (exp.failureDetail !== undefined) {
    check("failure detail matches", result.failureDetail === exp.failureDetail, result.failureDetail ?? "none");
  }
  if (exp.nativeSessionId !== undefined) {
    check("native session id", result.nativeSessionId === (exp.nativeSessionId ?? undefined), result.nativeSessionId);
  }
  if (exp.summary !== undefined) {
    check("summary matches", result.summary === (exp.summary ?? undefined), result.summary ?? "none");
  }
  if (exp.unknownEventCount !== undefined) {
    check(
      "unknown event count matches",
      result.unknownEventCount === exp.unknownEventCount,
      String(result.unknownEventCount),
    );
  }
  if (exp.mutatedPath !== undefined) {
    check("workspace mutation visible", existsSync(join(cwd, exp.mutatedPath)), exp.mutatedPath);
  }
  return checks;
}

/** Run one case end to end through the supervisor and the adapter. */
export async function runConformanceCase(c: ConformanceCase): Promise<ConformanceCaseReport> {
  const checks = checkAdapterStatics(c);
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const inv = c.binding
    ? c.adapter.resumeArgs(c.binding, c.request, c.profile)
    : c.adapter.compile(c.request, c.profile);
  if (isIneligible(inv)) return { kind: c.kind, ok: false, checks };

  let firstEvent: (() => void) | undefined;
  const sawEvent = new Promise<void>((resolve) => {
    firstEvent = resolve;
  });
  const events: NormalizedEvent[] = [];
  const run = startAdapterRun(c.adapter, inv, {
    ...bypassContext(c),
    onEvent: (e) => {
      events.push(e);
      firstEvent?.();
    },
  });
  if (c.kind === "cancellation") {
    await Promise.race([sawEvent, run.done]);
    await run.cancel();
  }
  const outcome = await run.done;
  const { result } = outcome;
  checks.push(...checkExpectation(c.expect, result, c.request.workspace.cwd));
  check("process group empty after run", outcome.groupEmpty);
  return { kind: c.kind, ok: checks.every((k) => k.ok), checks, result };
}

export async function runConformanceSuite(cases: readonly ConformanceCase[]): Promise<ConformanceReport> {
  const reports: ConformanceCaseReport[] = [];
  for (const c of cases) reports.push(await runConformanceCase(c));
  return { ok: reports.every((r) => r.ok), cases: reports };
}

/** Kinds FR-ADP-11 requires every adapter suite to cover. */
export const REQUIRED_CASE_KINDS: readonly ConformanceCaseKind[] = [
  "success",
  "task_failure",
  "resume",
  "auth_missing",
  "malformed_output",
  "cancellation",
];

export function missingRequiredKinds(cases: readonly ConformanceCase[]): ConformanceCaseKind[] {
  const have = new Set(cases.map((c) => c.kind));
  return REQUIRED_CASE_KINDS.filter((k) => !have.has(k));
}
