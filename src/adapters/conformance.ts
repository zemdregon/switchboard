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
import { type PromptSkill, renderSkillBlock } from "./prompt.js";
import { startAdapterRun } from "./run.js";
import {
  type CompileRequest,
  isIneligible,
  type NativeBinding,
  type NormalizedEvent,
  type ProviderAdapter,
  type ResolvedProfile,
  type RunResult,
  type SkillDelivery,
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
  // T16.7: the delivery declaration is checked whether or not this cell compiles.
  checks.push(...checkSkillDelivery(c));
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

/** T16.7 probe entries: two, so an adapter that put them anywhere but the prompt carrier would show it in the argv. */
const PROBE_SKILLS: readonly PromptSkill[] = [
  { name: "conformance-probe", version: 1, sha256: "a".repeat(64), body: "Probe skill one.\n" },
  { name: "conformance-probe-two", version: 2, sha256: "b".repeat(64), body: "Probe skill two.\n" },
];

/** A declaration as comparable text: the location and evidence of a `native` one, `absent` for none. */
function describeDelivery(d: SkillDelivery | undefined): string {
  if (d === undefined || d === "prompt_prefix") return d ?? "absent";
  const n = typeof d === "object" && d !== null ? d.native : undefined;
  return JSON.stringify({ dir: n?.dir, layout: n?.layout, evidence: n?.evidence ?? null });
}

/**
 * T16.7 (LLD §19.6, ADR-0056 items 5, 6 and 8, TDD §3.16.1): the case's skill delivery declaration, read raw (not
 * through `skillDeliveryOf`, which reads a bad one as `prompt_prefix`). A `native` declaration must carry the evidence
 * id of a T16.8 live check; the declaration must be pure and must not depend on the skills; and it never changes the
 * compiled argv: the cell compiled with skills and with none differs only in the prompt text (the T16.5 reading of
 * "argv identical": the one word that carries the prompt may gain the block, nothing else may change).
 */
export function checkSkillDelivery(c: ConformanceCase): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const a = c.adapter;
  const { skills: _skills, ...bare } = c.request;
  const withSkills: CompileRequest = { ...bare, skills: PROBE_SKILLS };
  const declared = a.skillDelivery?.(bare, c.profile);
  const shown = describeDelivery(declared);
  check(
    "skill delivery declaration is pure and ignores the skills",
    shown === describeDelivery(a.skillDelivery?.(bare, c.profile)) &&
      shown === describeDelivery(a.skillDelivery?.(withSkills, c.profile)),
    shown,
  );
  const native = typeof declared === "object" && declared !== null ? declared.native : undefined;
  const evidence = native?.evidence;
  check(
    "native skill delivery carries a T16.8 evidence id",
    declared === undefined || declared === "prompt_prefix" || (typeof evidence === "string" && evidence.trim() !== ""),
    native === undefined ? shown : `evidence=${typeof evidence === "string" ? JSON.stringify(evidence) : "missing"}`,
  );
  const compileWith = (req: CompileRequest) =>
    c.binding ? a.resumeArgs(c.binding, req, c.profile) : a.compile(req, c.profile);
  const plain = compileWith(bare);
  const skilled = compileWith(withSkills);
  if (isIneligible(plain) || isIneligible(skilled)) {
    check(
      "skills never change the compiled argv",
      isIneligible(plain) && isIneligible(skilled) && plain.reason === skilled.reason,
      `eligible without skills: ${!isIneligible(plain)}, with skills: ${!isIneligible(skilled)}`,
    );
    return checks;
  }
  const block = `${renderSkillBlock(PROBE_SKILLS)}\n\n`;
  const at = skilled.argv.findIndex((w, i) => w.replace(block, "") !== plain.argv[i]);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  check(
    "skills never change the compiled argv",
    skilled.argv.length === plain.argv.length &&
      at === -1 &&
      skilled.cwd === plain.cwd &&
      same(skilled.env, plain.env) &&
      same(skilled.envAllowlist, plain.envAllowlist) &&
      same(skilled.policyFlags, plain.policyFlags),
    at === -1 ? `argv ${plain.argv.length} words` : `argv[${at}] differs`,
  );
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
