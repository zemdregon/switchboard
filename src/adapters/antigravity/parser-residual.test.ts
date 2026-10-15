/**
 * T4.33 (Delegated, not owner-approved): residual `parseEvent` and `extractResult` branches that survived a mutation
 * pass over `adapter.ts` on 2026-10-15 (each test below fails when its branch is mutated). SYNTHETIC lines in the
 * `stream-json` shapes of the 2026-10-14 live check (C4, C7, C10); no new capture, no `agy` run, parser unchanged.
 * Outside the T4.35 case list and the T4.36 malicious leg.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { usageObservationsFromEvents } from "../../usage/observations.js";
import { runConformanceCase } from "../conformance.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { guardEvent } from "../tool-guard.js";
import type { CompileRequest, ExitInfo, NormalizedEvent, ParseState, ResolvedProfile } from "../types.js";
import { isIneligible } from "../types.js";
import { AntigravityAdapter } from "./adapter.js";
import { DEFAULT_SESSION_ID, fixturePath, PRIVILEGED_BYPASS_PROFILE, replayAdapter } from "./fixtures/cases.js";

const CID = "0b6c2d1e-0000-4000-8000-0000000000ee";
const OTHER = "0b6c2d1e-0000-4000-8000-0000000000ef";
const USAGE = { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 };
const j = (o: Record<string, unknown>) => JSON.stringify(o);
const INIT = (outer: Record<string, unknown> = {}) =>
  j({ event: "init", conversation_id: CID, ...outer, init: { cwd: "/work/tree", permission_mode: "request-review" } });
const STEP = (o: Record<string, unknown>) => j({ event: "step_update", conversation_id: CID, state: "DONE", ...o });
const RESULT = (over: Record<string, unknown> = {}) =>
  j({ event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "ok", usage: USAGE, ...over } });
const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
const adapter = () => new AntigravityAdapter({ executable: "/opt/synthetic/agy" });
const run = (lines: string[]) => {
  const a = adapter();
  const state: ParseState = { lines: 0, unknownEvents: 0 };
  const events = lines.flatMap((l) => a.parseEvent(l, state));
  return { state, events, result: a.extractResult(events, EXIT0) };
};

describe("antigravity parser mutation residuals (T4.33, synthetic shapes)", () => {
  it("counts every stdout line in state.lines, malformed and unknown ones included, but not an ACP message", () => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    a.parseEvent(INIT(), state);
    a.parseEvent("{not json", state);
    a.parseEvent(j({ event: "telemetry" }), state);
    a.parseEvent(STEP({ step_index: 0, step_type: "agent_response", text_delta: "hi" }), state);
    a.parseEvent(RESULT(), state);
    expect(state).toMatchObject({ lines: 5, unknownEvents: 1 });
    expect(a.parseEvent({ jsonrpc: "2.0", method: "session/update" } as never, state)).toEqual([]);
    expect(state).toMatchObject({ lines: 5, unknownEvents: 1 });
  });

  it("a step whose conversation_id is empty is not a changed id: the run still succeeds", () => {
    const r = run([INIT(), STEP({ conversation_id: "", step_index: 1, step_type: "agent_response" }), RESULT()]);
    expect(r.events.some((e) => e.kind === "provider_error")).toBe(false);
    expect(r.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
  });

  it("an empty response emits no message event and the result carries no summary", () => {
    const r = run([INIT(), RESULT({ response: "" })]);
    expect(r.events.some((e) => e.kind === "message")).toBe(false);
    expect(r.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID });
  });

  it("an empty backing_provider is dropped from session_bound, as a missing one is", () => {
    const bound = run([INIT({ backing_provider: "" }), RESULT()]).events.filter((e) => e.kind === "session_bound");
    expect(bound).toEqual([{ kind: "session_bound", nativeSessionId: CID }]);
  });

  it("the responses of two result lines are joined by a newline in the failed run's summary", () => {
    const r = run([INIT(), RESULT({ response: "first" }), RESULT({ response: "second" })]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
      summary: "first\nsecond",
    });
  });

  it("a tool step between two result lines is judged against the last result, not reported as a trailing tool", () => {
    const tool = STEP({
      step_index: 2,
      step_type: "tool",
      tool_info: { name: "view_file", parameters: { path: "/work/tree/a.ts" } },
    });
    const r = run([INIT(), RESULT(), tool, RESULT()]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
      nativeSessionId: CID,
    });
  });

  it("an unknown event name is clipped to 64 characters in rawType and still counted", () => {
    const name = "x".repeat(80);
    const r = run([INIT(), j({ event: name }), RESULT()]);
    expect(r.events.filter((e) => e.kind === "unknown")).toEqual([{ kind: "unknown", rawType: `${"x".repeat(64)}…` }]);
    expect(r.result).toMatchObject({ ok: true, unknownEventCount: 1 });
  });

  it("extractResult keeps the first session_bound when given more than one (the parser emits only one)", () => {
    const events: NormalizedEvent[] = [
      { kind: "session_bound", nativeSessionId: CID },
      { kind: "session_bound", nativeSessionId: OTHER },
      { kind: "usage", source: "provider_reported", metrics: USAGE },
      { kind: "result", ok: true },
    ];
    expect(adapter().extractResult(events, EXIT0)).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID });
    const parsed = run([INIT(), j({ event: "init", conversation_id: OTHER, init: {} }), RESULT()]).events;
    expect(parsed.filter((e) => e.kind === "session_bound")).toHaveLength(1);
  });
});

/**
 * Second mutation pass (2026-10-15, Delegated, not owner-approved): stream order, usage accounting, exit and resume
 * parity. Each test fails when its branch is mutated; synthetic lines only, parser unchanged.
 */
describe("antigravity parser residuals, second pass (T4.33, synthetic shapes)", () => {
  const TOOL = STEP({
    step_index: 1,
    step_type: "tool",
    tool_info: { name: "view_file", parameters: { path: "a.ts" } },
  });

  it("tool steps with no result line end OUTPUT_PROTOCOL_ERROR `no result event`, not as a trailing tool", () => {
    const r = run([INIT(), TOOL]);
    expect(r.events.some((e) => e.kind === "tool_call")).toBe(true);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "no result event",
      nativeSessionId: CID,
    });
  });

  it("a clean SUCCESS envelope succeeds only when the exit code is one of the invocation's expected codes", () => {
    const events = run([INIT(), RESULT()]).events;
    const a = adapter();
    expect(a.extractResult(events, { ...EXIT0, expectedExitCodes: [1] })).toMatchObject({ ok: false });
    expect(a.extractResult(events, { ...EXIT0, expectedExitCodes: [] })).toMatchObject({ ok: false });
    expect(
      a.extractResult(events, {
        ...EXIT0,
        exitCode: 2,
        expectedExitCodes: [0, 2],
      }),
    ).toMatchObject({ ok: true });
  });

  it("the session id comes only from the outer `init.conversation_id` and the envelope's `result.conversation_id`", () => {
    // An id nested inside `init` leaves the line unrecognised; an id beside `result` binds nothing.
    const nested = j({
      event: "init",
      init: { conversation_id: CID, cwd: "/work/tree" },
    });
    const beside = j({
      event: "result",
      conversation_id: CID,
      result: { status: "SUCCESS", response: "ok", usage: USAGE },
    });
    const r = run([nested, beside]);
    expect(r.events.filter((e) => e.kind === "session_bound")).toEqual([]);
    // The run still succeeds, with no `nativeSessionId` to resume.
    expect(r.result).toEqual({ ok: true, unknownEventCount: 1, summary: "ok" });
  });

  it("usage on a second result is never recorded, even when the first result reported none (FR-CAP-01)", () => {
    const first = j({
      event: "result",
      result: { conversation_id: CID, status: "SUCCESS", response: "a" },
    });
    const r = run([INIT(), first, RESULT()]);
    expect(r.events.filter((e) => e.kind === "usage")).toEqual([]);
    expect(r.result).toMatchObject({
      ok: false,
      failureDetail: "protocol: more than one result line",
    });
  });

  it("a failed envelope still records its reported usage once, as provider_reported (FR-CAP-01)", () => {
    const r = run([INIT(), RESULT({ status: "ERROR", response: "" })]);
    expect(r.events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: USAGE },
    ]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "ERROR",
    });
  });

  it("resume refuses with the Q-86 detail even where compile accepts, or refuses for its own reason", () => {
    const scope = {
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "on" },
      repository_config: { mode: "enabled" },
      bypass: true,
    } as const;
    const approved = { ...privilegedProfile(scope), bypassApproved: true };
    const req: CompileRequest = {
      runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
      objective: "fix the failing test",
      constraints: [],
      workspace: { cwd: "/work/tree", writable: true },
      bypassApproved: true,
    };
    // The id a parsed run bound is the one a resume would be given.
    const binding = {
      provider: "antigravity" as const,
      nativeSessionId: run([INIT(), RESULT()]).result.nativeSessionId ?? "",
    };
    const compiled = adapter().compile(req, approved);
    expect(isIneligible(compiled)).toBe(false);
    if (!isIneligible(compiled)) expect(compiled.argv.join(" ")).not.toContain(CID);
    const refusal = adapter().resumeArgs(binding, req, approved);
    expect(refusal).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("(Q-86)"),
    });
    const cases: [AntigravityAdapter, CompileRequest, ResolvedProfile][] = [
      [adapter(), { ...req, model: "synthetic-model" }, approved],
      [adapter(), { ...req, workspace: { cwd: "/work/tree", writable: false } }, approved],
      [adapter(), req, { ...approved, shellAllowlist: ["git commit -m x"] }],
      [new AntigravityAdapter({ pathEnv: "/nonexistent" }), req, approved],
    ];
    for (const [a, r, p] of cases) {
      expect(isIneligible(a.compile(r, p))).toBe(true);
      expect(a.resumeArgs(binding, r, p)).toEqual(refusal);
    }
  });
});

/**
 * Third pass (2026-10-15, Delegated, not owner-approved; mirrors Grok Build T4.23 fourth pass): binding order, the
 * result slot, zero counters, unclipped commands and step re-reports. Synthetic lines only, parser unchanged; each
 * test fails under a one-line mutation of the branch it names.
 */
describe("antigravity parser residuals, third pass (T4.33, synthetic shapes)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const makeCwd = () => {
    const d = mkdtempSync(join(tmpdir(), "sb-antigravity-t433-residual-"));
    dirs.push(d);
    return d;
  };
  /** As `run`, with the tool-call guard applied the way an approved bypass run applies it. */
  const guarded = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const raw = lines.flatMap((l) => a.parseEvent(l, state));
    const events = raw.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    return { raw, events, result: a.extractResult(events, EXIT0) };
  };

  it("pins the gap: an init id that binds nothing leaves the binding open, so the result's id binds", () => {
    const r = run([INIT({ conversation_id: "-c" }), RESULT()]);
    expect(r.events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: CID },
    ]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: conversation id is not a safe token",
      nativeSessionId: CID,
    });
    // With no init, an unsafe first result leaves the slot to a second result: both anomalies, its id bound, and only
    // the first result's usage counted (FR-CAP-01).
    const twice = run([RESULT({ conversation_id: "-c" }), RESULT({ usage: { ...USAGE, total_tokens: 99 } })]);
    expect(
      twice.events.filter((e) => e.kind === "provider_error").map((e) => e.kind === "provider_error" && e.message),
    ).toEqual(["conversation id is not a safe token", "more than one result line"]);
    expect(twice.events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: USAGE },
    ]);
    expect(twice.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: CID });
  });

  it("fixture unsafe_then_good_result replays to OUTPUT_PROTOCOL_ERROR with the result's id bound (gap, pinned)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("unsafe_then_good_result"),
      request: {
        runId: "run_antigravity_t433_residual",
        objective: "synthetic antigravity objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      failureDetail: "protocol: conversation id is not a safe token",
      unknownEventCount: 0,
      summary: "Done.",
    });
  });

  it("pins the gap: a step for another conversation before anything binds, or with a non-string id, is not compared", () => {
    const early = run([STEP({ conversation_id: OTHER, step_index: 0, step_type: "agent_response" }), INIT(), RESULT()]);
    expect(early.events.some((e) => e.kind === "provider_error")).toBe(false);
    expect(early.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
    const numeric = run([INIT(), STEP({ conversation_id: 7, step_index: 1, step_type: "agent_response" }), RESULT()]);
    expect(numeric.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
    // The same step after the binding is an anomaly (control for the gap above).
    const late = run([INIT(), STEP({ conversation_id: OTHER, step_index: 0, step_type: "agent_response" }), RESULT()]);
    expect(late.result).toMatchObject({ ok: false, failureDetail: "protocol: conversation id changed mid-run" });
  });

  it("a result line with no string status does not take the result slot: the later result is first and counts", () => {
    const bad = j({ event: "result", result: { conversation_id: CID, response: "x", usage: USAGE } });
    const r = run([INIT(), bad, RESULT()]);
    expect(r.events.filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(r.events.some((e) => e.kind === "provider_error")).toBe(false);
    expect(r.result).toEqual({ ok: true, unknownEventCount: 1, nativeSessionId: CID, summary: "ok" });
  });

  it("zero counters are recorded as provider_reported, and a zero total is not a success (Q-86, FR-CAP-01)", () => {
    const zero = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
    const r = run([INIT(), RESULT({ usage: zero })]);
    expect(r.events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: zero },
    ]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "SUCCESS with no reported tokens",
      nativeSessionId: CID,
    });
  });

  it("a command is never clipped: a Git write past the 512-character target limit still reaches the guard whole", () => {
    const command = `echo ${"a".repeat(600)} && git push origin main`;
    const r = guarded([
      INIT(),
      STEP({ step_index: 1, step_type: "tool", tool_info: { name: "run_command", parameters: { command } } }),
      RESULT(),
    ]);
    expect(r.raw.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_command", command },
    ]);
    expect(r.events.some((e) => e.kind === "tool_call" && e.violation !== undefined)).toBe(true);
    expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: CID });
  });

  it("a step is reported bare once; an update naming nothing new emits nothing; a later command adds to a path", () => {
    const bare = (state: string) => STEP({ step_index: 1, step_type: "tool", state, tool_name: "list_dir" });
    const withPath = STEP({
      step_index: 2,
      step_type: "tool",
      tool_info: { name: "edit", parameters: { path: "a.ts" } },
    });
    const withCommand = STEP({
      step_index: 2,
      step_type: "tool",
      tool_info: { name: "edit", parameters: { path: "a.ts", command: "git commit -am x" } },
    });
    const r = guarded([INIT(), bare("ACTIVE"), bare("DONE"), withPath, withPath, withCommand, RESULT()]);
    expect(r.raw.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "list_dir" },
      { kind: "tool_call", tool: "other", name: "edit", target: "a.ts" },
      { kind: "tool_call", tool: "shell", name: "edit", command: "git commit -am x" },
    ]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("a repeated init with the bound id emits nothing and the run still succeeds", () => {
    const r = run([INIT(), INIT(), RESULT(), INIT()]);
    expect(r.events.filter((e) => e.kind !== "usage" && e.kind !== "message")).toEqual([
      { kind: "session_bound", nativeSessionId: CID },
      { kind: "result", ok: true },
    ]);
    expect(r.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
  });
});

/**
 * Fourth pass (2026-10-15, Delegated, not owner-approved; mirrors the Grok Build, Cursor and OpenCode event-order and
 * usage residuals): the order of the events one `result` line emits, and `provider_reported` usage edge cases, each
 * through `usageObservationsFromEvents` as the lifecycle records it (FR-CAP-01, ADR-0007). Synthetic lines only. One
 * gap is closed: the Q-86 total is read as an own property, so an inherited `total_tokens` no longer passes for a
 * reported one (the old parser fails that test). The other gaps below are pinned, not fixed.
 */
describe("antigravity parser residuals, fourth pass: event order and provider_reported usage (T4.33)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const rows = (events: readonly NormalizedEvent[]) =>
    usageObservationsFromEvents(events, { runId: "run_antigravity_t433_usage", provider: "antigravity" });
  const usageOf = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "usage");

  it("a result with no init emits session_bound (with the result's model) before its usage, message and result", () => {
    const r = run([RESULT({ model: "synthetic-model" })]);
    expect(r.events.map((e) => e.kind)).toEqual(["session_bound", "usage", "message", "result"]);
    // The usage row carries the model the same line bound, because session_bound comes first.
    expect(rows(r.events)).toEqual([
      expect.objectContaining({ harness: "antigravity", model: "synthetic-model", source: "provider_reported" }),
    ]);
    expect(r.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
  });

  it("pins the gap: a result whose id is not a safe token records its usage, in the order error, usage, result, with no model", () => {
    const r = run([RESULT({ conversation_id: "-c", model: "synthetic-model" })]);
    expect(r.events.map((e) => e.kind)).toEqual(["provider_error", "usage", "message", "result"]);
    // Nothing bound, so the model on that line reaches no usage row (it is dropped with the unsafe id).
    expect(rows(r.events)).toEqual([expect.objectContaining({ model: null, backingProvider: null, metrics: USAGE })]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: conversation id is not a safe token",
    });
    expect(r.result).not.toHaveProperty("nativeSessionId");
  });

  it("a failed envelope emits usage, denials, its error, message and result in that order; usage is recorded once", () => {
    const r = run([
      INIT(),
      RESULT({ status: "ERROR", denied_actions: [{ action: "run_command", display_name: "Run" }], error: "boom" }),
    ]);
    expect(r.events.map((e) => e.kind)).toEqual([
      "session_bound",
      "usage",
      "permission_denied",
      "provider_error",
      "message",
      "result",
    ]);
    expect(rows(r.events)).toHaveLength(1);
    // A denial outranks the envelope's error (FR-POL-04).
    expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: CID });
  });

  it("a failed first result records its usage; a later success cannot flip it and the protocol error outranks it", () => {
    const r = run([INIT(), RESULT({ status: "ERROR" }), RESULT({ usage: { ...USAGE, total_tokens: 99 } })]);
    expect(usageOf(r.events)).toEqual([{ kind: "usage", source: "provider_reported", metrics: USAGE }]);
    // The second line is never ok; its event summary reuses the Q-86 wording although it reported tokens (the run's
    // failure detail below is the protocol error, so that summary is not surfaced).
    expect(r.events.filter((e) => e.kind === "result")).toEqual([
      { kind: "result", ok: false, summary: "ERROR" },
      { kind: "result", ok: false, summary: "SUCCESS with no reported tokens" },
    ]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
      nativeSessionId: CID,
    });
  });

  it("a total with no other counter is recorded alone and is a success; nothing is computed from components", () => {
    const totalOnly = run([INIT(), RESULT({ usage: { total_tokens: 24 } })]);
    expect(usageOf(totalOnly.events)).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { total_tokens: 24 } },
    ]);
    expect(totalOnly.result).toMatchObject({ ok: true });
    // Components with no total: still recorded, no total is summed in, and the run fails (Q-86).
    const parts = { input_tokens: 20, output_tokens: 3 };
    const noTotal = run([INIT(), RESULT({ usage: parts })]);
    expect(rows(noTotal.events)).toEqual([expect.objectContaining({ metrics: parts })]);
    expect(noTotal.result).toMatchObject({ ok: false, failureDetail: "SUCCESS with no reported tokens" });
  });

  it("pins the gap: fractional counters are recorded as reported and a fractional total above zero is a success", () => {
    const usage = { ...USAGE, thinking_tokens: 0.5, total_tokens: 0.25 };
    const r = run([INIT(), RESULT({ usage })]);
    expect(usageOf(r.events)).toEqual([{ kind: "usage", source: "provider_reported", metrics: usage }]);
    expect(r.result).toMatchObject({ ok: true, nativeSessionId: CID });
  });

  it("pins the gap: a total below the sum of its components is recorded unreconciled and the run succeeds", () => {
    const usage = { ...USAGE, total_tokens: 1 };
    const r = run([INIT(), RESULT({ usage })]);
    expect(rows(r.events)).toEqual([expect.objectContaining({ metrics: usage })]);
    expect(r.result).toMatchObject({ ok: true });
  });

  it("usage counters are own properties only: an inherited total_tokens is never recorded and fails the run", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.total_tokens = 24;
    try {
      const r = run([INIT(), RESULT({ usage: { input_tokens: 20 } })]);
      expect(usageOf(r.events)).toEqual([
        { kind: "usage", source: "provider_reported", metrics: { input_tokens: 20 } },
      ]);
      expect(r.result).toMatchObject({ ok: false, failureDetail: "SUCCESS with no reported tokens" });
    } finally {
      delete proto.total_tokens;
    }
    // A JSON `__proto__` key inside usage is an own key named `__proto__`, never a counter.
    const smuggled = run([INIT(), RESULT().replace('"usage":{', '"usage":{"__proto__":{"total_tokens":99},')]);
    expect(usageOf(smuggled.events)).toEqual([{ kind: "usage", source: "provider_reported", metrics: USAGE }]);
  });

  it("a null usage records no row and no total, so a SUCCESS envelope fails (Q-86)", () => {
    const r = run([INIT(), RESULT({ usage: null })]);
    expect(rows(r.events)).toEqual([]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  it("fixture usage_unreconciled replays to a success with the reported numbers recorded as is (gap, pinned)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sb-antigravity-t433-usage-"));
    dirs.push(cwd);
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("usage_unreconciled"),
      request: {
        runId: "run_antigravity_t433_usage",
        objective: "synthetic antigravity objective",
        constraints: [],
        workspace: { cwd, writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Done.",
    });
    const lines = readFileSync(fixturePath("usage_unreconciled"), "utf8")
      .split("\n")
      .filter((l) => l !== "" && !l.includes('"_fixture"'));
    expect(rows(run(lines).events)).toEqual([
      expect.objectContaining({
        model: "synthetic-model",
        source: "provider_reported",
        metrics: { input_tokens: 20, output_tokens: 3, thinking_tokens: 0.5, cache_read_tokens: 0, total_tokens: 7 },
      }),
    ]);
  });
});

/**
 * Fifth pass (2026-10-15, Delegated, not owner-approved; mirrors Grok Build T4.23 fifth pass): step lines after the
 * `result` line that the trailing-tool check misses (a deduplicated or unreadable step, pinned gaps), the trailing-tool
 * detail masking an earlier protocol anomaly, prototype-named values, `step_index` shapes, and `extractResult` against
 * the compiled expected exit codes. Synthetic lines only, parser unchanged. The `tool_info.parameters` keys are still
 * the parser's Assumptions (gap (3) in the roadmap row), so these pin behaviour, not a native contract.
 */
describe("antigravity parser residuals, fifth pass: post-result steps, prototype values and exit codes (T4.33)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const tool = (index: number, parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    STEP({ step_index: index, step_type: "tool", tool_info: { name: "run_command", parameters }, ...extra });
  const guarded = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events = lines
      .flatMap((l) => a.parseEvent(l, state))
      .map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    return a.extractResult(events, EXIT0);
  };

  it("pins the gap: a tool step repeated unchanged after the result is deduplicated, so the run still succeeds", () => {
    const before = tool(1, { command: "ls" });
    const r = run([INIT(), before, RESULT(), before]);
    expect(r.events.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(r.events.at(-1)?.kind).toBe("result");
    expect(r.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
    // A new command on the same step after the result is reported, so it trips the order check and reaches the guard.
    const swapped = tool(1, { command: "git push origin main" });
    expect(run([INIT(), before, RESULT(), swapped]).result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    expect(guarded([INIT(), before, RESULT(), swapped])).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("fixture trailing_repeat_step replays a repeated step after a clean result to success at exit 0 (gap, pinned)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sb-antigravity-t433-fifth-"));
    dirs.push(cwd);
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("trailing_repeat_step"),
      request: {
        runId: "run_antigravity_t433_fifth",
        objective: "synthetic antigravity objective",
        constraints: [],
        workspace: { cwd, writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Done.",
    });
  });

  it("pins the gap: an unreadable or non-tool step after the result is no tool call, so the run still succeeds", () => {
    // No numeric step_index: a counted unknown line, not a tool call, so the order check skips it.
    const unreadable = STEP({ step_index: "1", step_type: "tool", tool_info: { parameters: { command: "ls" } } });
    const r = run([INIT(), RESULT(), unreadable]);
    expect(r.events.at(-1)).toEqual({ kind: "unknown", rawType: "step_update" });
    expect(r.result).toEqual({ ok: true, unknownEventCount: 1, nativeSessionId: CID, summary: "ok" });
    // A command on a step that is not exactly `tool` emits nothing at all.
    const response = STEP({ step_index: 2, step_type: "agent_response", tool_info: { parameters: { command: "ls" } } });
    expect(run([INIT(), RESULT(), response]).result).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: CID,
      summary: "ok",
    });
    // A bare `tool` step after the result is a tool call, so it fails the run (the control for both gaps above).
    expect(run([INIT(), RESULT(), STEP({ step_index: 3, step_type: "tool" })]).result).toMatchObject({
      ok: false,
      failureDetail: "tool call after the result line",
    });
  });

  it("the trailing-tool detail replaces an earlier protocol detail: the code stands, the first cause is not named", () => {
    const step = tool(4, { path: "a.ts" });
    expect(run([INIT(), RESULT(), RESULT(), step]).result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    // A step for another conversation after the result: the changed id is emitted but the trailing tool is named.
    const other = run([INIT(), RESULT(), tool(4, { path: "a.ts" }, { conversation_id: OTHER })]);
    expect(other.events.slice(-2).map((e) => e.kind)).toEqual(["provider_error", "tool_call"]);
    expect(other.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    // A failure that is not a protocol error keeps its own detail, the trailing tool notwithstanding.
    expect(run([INIT(), RESULT({ status: "ERROR" }), step]).result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "ERROR",
    });
  });

  it("prototype-named event, step and status values are plain strings: a counted unknown, an ignored step or a failed status", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const r = run([INIT(), j({ event: name }), STEP({ step_index: 1, step_type: name }), RESULT()]);
      expect(
        r.events.filter((e) => e.kind === "unknown"),
        name,
      ).toEqual([{ kind: "unknown", rawType: name }]);
      expect(r.result, name).toEqual({ ok: true, unknownEventCount: 1, nativeSessionId: CID, summary: "ok" });
      expect(run([INIT(), RESULT({ status: name })]).result, name).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: name,
      });
    }
  });

  it("pins the gap: a prototype-named model, tool name or denied action is kept as an ordinary string", () => {
    const r = run([
      j({ event: "init", conversation_id: CID, init: { model: "constructor" }, backing_provider: "toString" }),
      STEP({ step_index: 1, step_type: "tool", tool_info: { name: "__proto__", parameters: { path: "a.ts" } } }),
      RESULT({ denied_actions: [{ display_name: "hasOwnProperty" }] }),
    ]);
    expect(r.events.filter((e) => e.kind !== "usage" && e.kind !== "message")).toEqual([
      { kind: "session_bound", nativeSessionId: CID, model: "constructor", backingProvider: "toString" },
      { kind: "tool_call", tool: "other", name: "__proto__", target: "a.ts" },
      { kind: "permission_denied", tool: "hasOwnProperty" },
      { kind: "result", ok: true },
    ]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: CID });
  });

  it("pins the gap: any number is a step index, so fractional and negative indexes are distinct steps", () => {
    const steps = [1, 1.5, -1, 0].map((i) => tool(i, { command: "ls" }));
    const r = run([INIT(), ...steps, tool(1.5, { command: "ls" }), RESULT()]);
    expect(r.events.filter((e) => e.kind === "tool_call")).toHaveLength(4);
    expect(r.result).toMatchObject({ ok: true, unknownEventCount: 0 });
    // The same command under two keys or containers of one step is reported once.
    const twice = run([INIT(), tool(5, { command: "ls", CommandLine: "ls" }, { args: { command: "ls" } }), RESULT()]);
    expect(twice.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_command", command: "ls" },
    ]);
  });

  it("extractResult honours the compiled expected exit codes: exit 0 only, and every other outcome fails", () => {
    const req: CompileRequest = {
      runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
      objective: "fix the failing test",
      constraints: [],
      workspace: { cwd: "/work/tree", writable: true },
      bypassApproved: true,
    };
    const compiled = adapter().compile(req, PRIVILEGED_BYPASS_PROFILE);
    if (isIneligible(compiled)) throw new Error(`unexpected refusal: ${compiled.detail}`);
    expect(compiled.expectedExitCodes).toEqual([0]);
    const events = run([INIT(), RESULT()]).events;
    const exit = (o: Partial<ExitInfo>): ExitInfo => ({
      ...EXIT0,
      expectedExitCodes: compiled.expectedExitCodes,
      ...o,
    });
    expect(adapter().extractResult(events, exit({}))).toMatchObject({ ok: true, nativeSessionId: CID });
    expect(adapter().extractResult(events, exit({ exitCode: 3 }))).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 3",
      nativeSessionId: CID,
      summary: "ok",
    });
    expect(adapter().extractResult(events, exit({ exitCode: null, signal: "SIGKILL" }))).toMatchObject({ ok: false });
    for (const outcome of ["crashed", "protocol_error", "internal_error"] as const) {
      expect(adapter().extractResult(events, exit({ outcome })), outcome).toMatchObject({ ok: false });
    }
  });
});

/**
 * Sixth pass (2026-10-15, Delegated, not owner-approved; mirrors Grok Build T4.23 sixth pass and the OpenCode framing
 * residuals): exact clip and session-id boundaries, falsy present values that must still fail, line framing, duplicate
 * JSON keys and an empty name that shadows its fallback. Synthetic lines only, parser unchanged; the boundary and
 * falsy-value tests each fail under a one-line mutation (`>` to `>=` in `clip`, `{0,255}` to `{0,256}`, a truthiness
 * test for `denied_actions` or `error`). Duplicate keys and the empty-name shadow are pinned gaps: no recorded `agy`
 * line repeats a key or carries an empty tool name ([LIVE] C4, C7), so these pin behaviour, not a native contract.
 */
describe("antigravity parser residuals, sixth pass: boundaries, falsy values, framing and duplicate keys (T4.33)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const kept = (n: number, c = "x") => c.repeat(n);
  const cut = (n: number, c = "x") => `${c.repeat(n)}…`;

  it("every clip keeps a value of exactly its limit whole and clips one character more", () => {
    const toolName = (name: string) =>
      run([INIT(), STEP({ step_index: 1, step_type: "tool", tool_info: { name } }), RESULT()]).events.find(
        (e) => e.kind === "tool_call",
      );
    expect(toolName(kept(64))).toMatchObject({ name: kept(64) });
    expect(toolName(kept(65))).toMatchObject({ name: cut(64) });
    const target = (path: string) =>
      run([
        INIT(),
        STEP({ step_index: 1, step_type: "tool", tool_info: { name: "view_file", parameters: { path } } }),
      ]).events.find((e) => e.kind === "tool_call");
    expect(target(kept(512))).toMatchObject({ target: kept(512) });
    expect(target(kept(513))).toMatchObject({ target: cut(512) });
    const bound = (v: string) =>
      run([j({ event: "init", conversation_id: CID, backing_provider: v, init: { model: v } })]).events[0];
    expect(bound(kept(128))).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
      model: kept(128),
      backingProvider: kept(128),
    });
    expect(bound(kept(129))).toMatchObject({ model: cut(128), backingProvider: cut(128) });
    const denied = (display_name: string) =>
      run([INIT(), RESULT({ denied_actions: [{ display_name }] })]).events.find((e) => e.kind === "permission_denied");
    expect(denied(kept(64))).toEqual({ kind: "permission_denied", tool: kept(64) });
    expect(denied(kept(65))).toEqual({ kind: "permission_denied", tool: cut(64) });
    const unknown = (name: string) => run([j({ event: name })]).events;
    expect(unknown(kept(64))).toEqual([{ kind: "unknown", rawType: kept(64) }]);
    expect(unknown(kept(65))).toEqual([{ kind: "unknown", rawType: cut(64) }]);
    const status = (s: string) => run([INIT(), RESULT({ status: s })]).result;
    expect(status(kept(64, "E"))).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: kept(64, "E"),
    });
    expect(status(kept(65, "E"))).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: cut(64, "E"),
    });
    const message = (response: string) => run([INIT(), RESULT({ response })]).events.find((e) => e.kind === "message");
    expect(message(kept(2_000))).toMatchObject({ text: kept(2_000) });
    expect(message(kept(2_001))).toMatchObject({ text: cut(2_000) });
  });

  it("a conversation id of 256 characters binds and one of 257 does not; it must start with a letter or digit", () => {
    const binds = (id: string) =>
      run([j({ event: "init", conversation_id: id, init: {} })]).events.some((e) => e.kind === "session_bound");
    expect(binds(`a${"b".repeat(255)}`)).toBe(true);
    expect(binds(`a${"b".repeat(256)}`)).toBe(false);
    for (const id of ["0", "Z", "a.b:c_d-e", "9:"]) expect(binds(id), id).toBe(true);
    for (const id of [".a", "_a", ":a", "a/b", "a b", "aé"]) expect(binds(id), id).toBe(false);
  });

  it("pins the gap: a step's conversation_id is compared, never checked as a safe token, so an unsafe one is a changed id", () => {
    const r = run([INIT(), STEP({ conversation_id: "-c", step_index: 1, step_type: "agent_response" }), RESULT()]);
    expect(r.events.filter((e) => e.kind === "provider_error")).toEqual([
      { kind: "provider_error", category: "protocol", message: "conversation id changed mid-run" },
    ]);
    expect(r.result).toMatchObject({ ok: false, failureDetail: "protocol: conversation id changed mid-run" });
    // The comparison is exact: the bound id in upper case is another conversation.
    const upper = run([INIT(), STEP({ conversation_id: CID.toUpperCase(), step_index: 1, step_type: "x" }), RESULT()]);
    expect(upper.result).toMatchObject({ ok: false, failureDetail: "protocol: conversation id changed mid-run" });
  });

  it("a falsy denied_actions other than null is still one unknown denial; null and an empty array deny nothing", () => {
    for (const value of [false, 0, "", {}]) {
      const r = run([INIT(), RESULT({ denied_actions: value })]);
      expect(
        r.events.filter((e) => e.kind === "permission_denied"),
        String(value),
      ).toEqual([{ kind: "permission_denied", tool: "unknown" }]);
      expect(r.result, String(value)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    }
    for (const value of [null, []]) {
      expect(run([INIT(), RESULT({ denied_actions: value })]).result).toMatchObject({ ok: true });
    }
  });

  it("a falsy error other than null or an empty string is a non-string error field and fails the run", () => {
    for (const value of [false, 0, [], {}]) {
      const r = run([INIT(), RESULT({ error: value })]);
      expect(
        r.events.filter((e) => e.kind === "provider_error"),
        JSON.stringify(value),
      ).toEqual([{ kind: "provider_error", category: "unknown", message: "non-string error field" }]);
      expect(r.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    }
    expect(run([INIT(), RESULT({ error: "" })]).result).toMatchObject({ ok: true });
  });

  it("line framing: surrounding whitespace and a trailing CR parse; a BOM is unparseable and not counted unknown", () => {
    const r = run([` ${INIT()}\t`, `${RESULT()}\r`]);
    expect(r.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    expect(a.parseEvent(`﻿${INIT()}`, state)).toEqual([]);
    expect(state).toMatchObject({ lines: 1, unknownEvents: 0 });
    // Top-level JSON that is not an object is a counted unknown line with no event name.
    for (const line of ["[]", "7", '"init"', "null", "true"]) {
      expect(a.parseEvent(line, state), line).toEqual([{ kind: "unknown", rawType: "none" }]);
    }
    expect(state).toMatchObject({ lines: 6, unknownEvents: 5 });
  });

  it("pins the gap: a duplicated JSON key keeps its last value, so a later SUCCESS status hides an earlier ERROR", () => {
    const twice = RESULT({ status: "ERROR" }).replace(/\}\}$/, ',"status":"SUCCESS"}}');
    expect(run([INIT(), twice]).result).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: CID,
      summary: "ok",
    });
    // The reverse order fails, and a duplicated event name is read by its last value too.
    const reverse = RESULT().replace(/\}\}$/, ',"status":"ERROR"}}');
    expect(run([INIT(), reverse]).result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "ERROR",
    });
    const renamed = RESULT().replace(/\}$/, ',"event":"telemetry"}');
    expect(run([INIT(), renamed]).events.at(-1)).toEqual({ kind: "unknown", rawType: "telemetry" });
  });

  it("fixture duplicate_status_key replays an ERROR status overwritten by SUCCESS to a success at exit 0 (gap, pinned)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sb-antigravity-t433-sixth-"));
    dirs.push(cwd);
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("duplicate_status_key"),
      request: {
        runId: "run_antigravity_t433_sixth",
        objective: "synthetic antigravity objective",
        constraints: [],
        workspace: { cwd, writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Done.",
    });
  });

  it("pins the gap: an empty tool_info.name shadows tool_name, so the call is named by the empty string", () => {
    const named = (info: Record<string, unknown>) =>
      run([INIT(), STEP({ step_index: 1, step_type: "tool", tool_name: "list_dir", tool_info: info })]).events.find(
        (e) => e.kind === "tool_call",
      );
    expect(named({ name: "" })).toEqual({ kind: "tool_call", tool: "other", name: "" });
    // A non-string name is skipped, so the fallback names the call (the control for the gap above).
    expect(named({ name: 7 })).toEqual({ kind: "tool_call", tool: "other", name: "list_dir" });
    // An empty step_type is not `tool`: an ignored step, not an unknown line.
    const empty = run([INIT(), STEP({ step_index: 2, step_type: "" }), RESULT()]);
    expect(empty.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
  });

  it("the summary is the last 2,000 characters of every message joined by newlines, so an earlier response can be cut", () => {
    const r = run([INIT(), RESULT({ response: kept(1_500, "a") }), RESULT({ response: kept(1_500, "b") })]);
    expect(r.result).toMatchObject({
      ok: false,
      failureDetail: "protocol: more than one result line",
      summary: `${kept(499, "a")}\n${kept(1_500, "b")}`,
    });
  });
});
