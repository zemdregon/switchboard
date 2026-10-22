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

  it("resume compiles the bound id after --conversation where compile accepts, else refuses for compile's reason", () => {
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
    const resumed = adapter().resumeArgs(binding, req, approved);
    if (isIneligible(resumed) || isIneligible(compiled)) throw new Error("the approved bypass cell must compile");
    expect(resumed.argv).toEqual([...compiled.argv, "--conversation", CID]);
    const cases: [AntigravityAdapter, CompileRequest, ResolvedProfile][] = [
      [adapter(), { ...req, model: "-synthetic-model" }, approved],
      [adapter(), { ...req, workspace: { cwd: "/work/tree", writable: false } }, approved],
      [adapter(), req, { ...approved, shellAllowlist: ["git commit -m x"] }],
      [new AntigravityAdapter({ pathEnv: "/nonexistent" }), req, approved],
    ];
    for (const [a, r, p] of cases) {
      const refusal = a.compile(r, p);
      expect(isIneligible(refusal)).toBe(true);
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
      tool_info: { name: "edit", parameters: { path: "a.ts", command: "git push origin HEAD" } },
    });
    const r = guarded([INIT(), bare("ACTIVE"), bare("DONE"), withPath, withPath, withCommand, RESULT()]);
    expect(r.raw.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "list_dir" },
      { kind: "tool_call", tool: "other", name: "edit", target: "a.ts" },
      { kind: "tool_call", tool: "shell", name: "edit", command: "git push origin HEAD" },
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

/**
 * Seventh pass (2026-10-15, Delegated, not owner-approved; mirrors Grok Build T4.23 sixth/seventh passes and
 * Cursor T4.43 / OpenCode T4.53 residuals): result-only streams with backing vendor and model parity (T4.6, FR-ADP-10),
 * init vs result precedence and shadowing, empty-string shadows on display_name and parameter containers,
 * non-object container skips, multi-command aggregation across containers, case-sensitive error prefixes, duplicate
 * event/conversation_id keys, and trailing-tool detail ranking against protocol errors vs guard violations.
 * Synthetic lines only, parser unchanged.
 */
describe("antigravity parser residuals, seventh pass: result-only backing parity, shadowing, framing and ranking (T4.33)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const rows = (events: readonly NormalizedEvent[]) =>
    usageObservationsFromEvents(events, { runId: "run_antigravity_t433_seventh_usage", provider: "antigravity" });
  const guarded = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const raw = lines.flatMap((l) => a.parseEvent(l, state));
    const events = raw.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    return { raw, events, result: a.extractResult(events, EXIT0) };
  };

  it("fixture backing_result_only replays a result-only stream with backing vendor and model through conformance and usage observation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sb-antigravity-t433-seventh-"));
    dirs.push(cwd);
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("backing_result_only"),
      request: {
        runId: "run_antigravity_t433_seventh_backing",
        objective: "synthetic antigravity objective",
        constraints: [],
        workspace: { cwd, writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: "0b6c2d1e-0000-4000-8000-000000000001" },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: "0b6c2d1e-0000-4000-8000-000000000001",
      summary: "Answered from a result-only stream.",
    });

    const lines = readFileSync(fixturePath("backing_result_only"), "utf8")
      .split("\n")
      .filter((l) => l !== "" && !l.includes('"_fixture"'));
    const parsed = run(lines);
    expect(parsed.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: "0b6c2d1e-0000-4000-8000-000000000001",
      model: "gemini-3.8-flash-high",
      backingProvider: "backing-g",
    });
    expect(rows(parsed.events)).toEqual([
      expect.objectContaining({
        harness: "antigravity",
        model: "gemini-3.8-flash-high",
        backingProvider: "backing-g",
        source: "provider_reported",
        metrics: expect.objectContaining({ total_tokens: 19 }),
      }),
    ]);
  });

  it("precedence and shadowing: root backing_provider shadows camelCase and inner init/result, while inner model shadows root model", () => {
    // 1. Root snake_case backing_provider takes highest precedence; inner init.model takes precedence over root model
    const r1 = run([
      j({
        event: "init",
        conversation_id: CID,
        backing_provider: "root-snake",
        backingProvider: "root-camel",
        model: "root-model",
        init: { backing_provider: "init-snake", backingProvider: "init-camel", model: "inner-model" },
      }),
      RESULT(),
    ]);
    expect(r1.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
      model: "inner-model",
      backingProvider: "root-snake",
    });

    // 2. Root camelCase backingProvider shadows inner init.backing_provider when root snake_case is omitted
    const r2 = run([
      j({
        event: "init",
        conversation_id: CID,
        backingProvider: "root-camel",
        init: { backing_provider: "init-snake" },
      }),
      RESULT(),
    ]);
    expect(r2.events.find((e) => e.kind === "session_bound")).toMatchObject({
      backingProvider: "root-camel",
    });

    // 3. Pinned gap: non-null non-string root backing_provider (e.g. 0 or false) shadows inner backing_provider and leaves it unset
    for (const falsyNonString of [0, false]) {
      const r = run([
        j({
          event: "init",
          conversation_id: CID,
          backing_provider: falsyNonString,
          init: { backing_provider: "inner-vendor" },
        }),
        RESULT(),
      ]);
      expect(r.events.find((e) => e.kind === "session_bound")).not.toHaveProperty("backingProvider");
    }

    // 4. Pinned gap: empty-string root backing_provider shadows inner backing_provider and is omitted from session_bound
    const rEmpty = run([
      j({
        event: "init",
        conversation_id: CID,
        backing_provider: "",
        init: { backing_provider: "inner-vendor" },
      }),
      RESULT(),
    ]);
    expect(rEmpty.events.find((e) => e.kind === "session_bound")).not.toHaveProperty("backingProvider");

    // 5. Pinned gap: empty-string init.model shadows root model and is omitted from session_bound
    const rEmptyModel = run([
      j({
        event: "init",
        conversation_id: CID,
        model: "root-model",
        init: { model: "" },
      }),
      RESULT(),
    ]);
    expect(rEmptyModel.events.find((e) => e.kind === "session_bound")).not.toHaveProperty("model");
  });

  it("pins the gap: model and backing vendor on result are ignored once init has bound the session", () => {
    // init binds with no model and no backing provider
    const r = run([
      INIT(),
      RESULT({
        model: "late-model",
        backing_provider: "late-vendor",
      }),
    ]);
    const bound = r.events.find((e) => e.kind === "session_bound");
    expect(bound).toEqual({ kind: "session_bound", nativeSessionId: CID });
    expect(bound).not.toHaveProperty("model");
    expect(bound).not.toHaveProperty("backingProvider");
    expect(rows(r.events)).toEqual([
      expect.objectContaining({ model: null, backingProvider: null, source: "provider_reported" }),
    ]);

    // Similarly, a later result with different values cannot override what init bound
    const r2 = run([
      j({
        event: "init",
        conversation_id: CID,
        backing_provider: "first-vendor",
        init: { model: "first-model" },
      }),
      RESULT({
        model: "second-model",
        backing_provider: "second-vendor",
      }),
    ]);
    expect(r2.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
      model: "first-model",
      backingProvider: "first-vendor",
    });
  });

  it("denied_actions: non-object entry yields unknown tool, empty display_name shadows action, and multiple denials order cleanly", () => {
    // Non-object entries (strings, numbers): action is not an object, so tool falls back to "unknown" (gap pinned)
    const rNonObj = run([INIT(), RESULT({ denied_actions: ["run_command", 42] })]);
    expect(rNonObj.events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "unknown" },
      { kind: "permission_denied", tool: "unknown" },
    ]);
    expect(rNonObj.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: unknown",
    });

    // Pinned gap: empty display_name shadows action, resulting in empty tool name
    const rShadow = run([INIT(), RESULT({ denied_actions: [{ display_name: "", action: "run_command" }] })]);
    expect(rShadow.events.find((e) => e.kind === "permission_denied")).toEqual({
      kind: "permission_denied",
      tool: "",
    });
    expect(rShadow.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: ",
    });

    // Non-string display_name falls through to action
    const rFallback = run([INIT(), RESULT({ denied_actions: [{ display_name: 7, action: "run_command" }] })]);
    expect(rFallback.events.find((e) => e.kind === "permission_denied")).toEqual({
      kind: "permission_denied",
      tool: "run_command",
    });

    // Multiple denials preserve order, and extractResult names the first denial
    const rMultiple = run([
      INIT(),
      RESULT({ denied_actions: [{ display_name: "edit_file" }, { action: "run_command" }] }),
    ]);
    expect(rMultiple.events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "edit_file" },
      { kind: "permission_denied", tool: "run_command" },
    ]);
    expect(rMultiple.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: edit_file",
    });
  });

  it("tool step parameter containers: command suppresses targets; a later command-less update reports target; multiple distinct commands report separately", () => {
    // 1. When command is present, targets in all containers are suppressed
    const rMixed = run([
      INIT(),
      STEP({
        step_index: 1,
        step_type: "tool",
        tool_name: "bash",
        tool_info: { parameters: { command: "ls", path: "/work/a.ts" } },
      }),
      RESULT(),
    ]);
    expect(rMixed.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "bash", command: "ls" },
    ]);

    // 2. An update repeating the command with a new target evaluates commands (found in seen), emitting nothing
    const rRepeatCmd = run([
      INIT(),
      STEP({
        step_index: 1,
        step_type: "tool",
        tool_name: "bash",
        tool_info: { parameters: { command: "ls" } },
      }),
      STEP({
        step_index: 1,
        step_type: "tool",
        tool_name: "bash",
        tool_info: { parameters: { command: "ls", path: "/work/b.ts" } },
      }),
      RESULT(),
    ]);
    expect(rRepeatCmd.events.filter((e) => e.kind === "tool_call")).toHaveLength(1);

    // 3. But a later update with ONLY the new target has commands.length === 0, so target IS reported
    const rTargetOnly = run([
      INIT(),
      STEP({
        step_index: 1,
        step_type: "tool",
        tool_name: "bash",
        tool_info: { parameters: { command: "ls" } },
      }),
      STEP({
        step_index: 1,
        step_type: "tool",
        tool_name: "bash",
        tool_info: { parameters: { path: "/work/b.ts" } },
      }),
      RESULT(),
    ]);
    expect(rTargetOnly.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "bash", command: "ls" },
      { kind: "tool_call", tool: "other", name: "bash", target: "/work/b.ts" },
    ]);

    // 4. Non-object parameter containers are ignored and do not shadow later containers
    const rNonObj = run([
      INIT(),
      STEP({
        step_index: 2,
        step_type: "tool",
        tool_name: "run_cmd",
        tool_info: { parameters: "string-param", args: { command: "pwd" } },
      }),
      RESULT(),
    ]);
    expect(rNonObj.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_cmd", command: "pwd" },
    ]);

    // 5. Multiple distinct commands in different containers report separate shell calls and trigger the guard
    const rDistinct = guarded([
      INIT(),
      STEP({
        step_index: 3,
        step_type: "tool",
        tool_name: "run_cmd",
        tool_info: { parameters: { command: "echo 1" }, args: { command: "echo 2" } },
        parameters: { CommandLine: "git push origin HEAD" },
      }),
      RESULT(),
    ]);
    expect(rDistinct.raw.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_cmd", command: "echo 1" },
      { kind: "tool_call", tool: "shell", name: "run_cmd", command: "echo 2" },
      { kind: "tool_call", tool: "shell", name: "run_cmd", command: "git push origin HEAD" },
    ]);
    expect(rDistinct.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "git write attempted: `git push` can create commits, change refs or push",
    });
  });

  it("error prefix matching is case-sensitive and un-trimmed; capitalised or whitespace-prefixed errors end TOOL_FAILURE", () => {
    // Model errors
    expect(run([INIT(), RESULT({ error: "invalid model selection: m1" })]).result).toMatchObject({
      ok: false,
      failureCode: "MODEL_UNAVAILABLE",
      failureDetail: "model_unavailable: invalid model selection: m1",
    });
    // Capitalized or whitespace-prefixed falls back to TOOL_FAILURE (category unknown)
    expect(run([INIT(), RESULT({ error: "Invalid model selection: m1" })]).result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "unknown: Invalid model selection: m1",
    });
    expect(run([INIT(), RESULT({ error: " invalid model selection: m1" })]).result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "unknown:  invalid model selection: m1",
    });

    // Auth errors
    expect(run([INIT(), RESULT({ error: "authentication failed: expired" })]).result).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      failureDetail: "auth: authentication failed: expired",
    });
    expect(run([INIT(), RESULT({ error: "Authentication failed: expired" })]).result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "unknown: Authentication failed: expired",
    });

    // Non-string error payload
    expect(run([INIT(), RESULT({ error: { code: 403 } })]).result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "unknown: non-string error field",
    });
  });

  it("duplicate JSON keys: a second event or conversation_id key resolves to the last one; a second step_type can hide a Git write", () => {
    // Duplicate event in init: last event "step_update" wins, so conversation_id never binds from that line;
    // a later result binds its own id instead
    const eventDup =
      '{"event":"init","conversation_id":"' +
      CID +
      '","init":{},"event":"step_update","step_index":0,"step_type":"agent_response"}';
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const stepEv = a.parseEvent(eventDup, state);
    expect(stepEv).toEqual([]);
    expect(state.nativeSessionId).toBeUndefined();
    // A later result for OTHER binds OTHER (proving eventDup never bound CID)
    const rOther = a.parseEvent(RESULT({ conversation_id: OTHER }), state);
    expect(state.nativeSessionId).toBe(OTHER);
    expect(rOther.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: OTHER,
    });

    // Duplicate conversation_id in init: last one wins
    const validWins = `{"event":"init","conversation_id":"-unsafe!","conversation_id":"${CID}","init":{}}`;
    expect(run([validWins, RESULT()]).result).toMatchObject({ ok: true, nativeSessionId: CID });
    const unsafeWins = `{"event":"init","conversation_id":"${CID}","conversation_id":"-unsafe!","init":{}}`;
    expect(run([unsafeWins, RESULT()]).result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: conversation id is not a safe token",
    });

    // Pinned gap: duplicate step_type where second value is "agent_response" hides Git write from guard
    const stepDup =
      '{"event":"step_update","conversation_id":"' +
      CID +
      '","step_index":1,"step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"command":"git push origin main"}},"step_type":"agent_response"}';
    const rHidden = guarded([INIT(), stepDup, RESULT()]);
    expect(rHidden.raw.filter((e) => e.kind === "tool_call")).toEqual([]);
    expect(rHidden.result).toMatchObject({ ok: true });

    // Control: without duplicate key, guard detects the Git write
    const rClean = guarded([
      INIT(),
      STEP({
        step_index: 1,
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { parameters: { command: "git push origin main" } },
      }),
      RESULT(),
    ]);
    expect(rClean.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("session id asymmetry: empty conversation_id parses cleanly without binding, but resumeArgs refuses an empty id", () => {
    const r = run([INIT({ conversation_id: "" }), RESULT({ conversation_id: "" })]);
    expect(r.events.filter((e) => e.kind === "session_bound")).toEqual([]);
    expect(r.events.filter((e) => e.kind === "provider_error")).toEqual([]);
    expect(r.result).toEqual({ ok: true, unknownEventCount: 0, summary: "ok" });

    const req: CompileRequest = {
      runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
      objective: "fix the failing test",
      constraints: [],
      workspace: { cwd: "/work/tree", writable: true },
      bypassApproved: true,
    };
    const a = adapter();
    // An empty session id is not one safe token, so resumeArgs refuses it (owner decision 67 compiles only safe ids)
    expect(a.resumeArgs({ provider: "antigravity", nativeSessionId: "" }, req, PRIVILEGED_BYPASS_PROFILE)).toEqual({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: "native session id is not a safe single argument",
    });

    // Foreign provider in resumeArgs is refused citing the foreign provider before the id check
    expect(a.resumeArgs({ provider: "grok" as never, nativeSessionId: CID }, req, PRIVILEGED_BYPASS_PROFILE)).toEqual({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: "binding is for grok",
    });
  });

  it("trailing tool detail ranking: trailing tool masks protocol errors but does not mask permission denials, guard violations, or error envelopes", () => {
    const trailingStep = STEP({
      step_index: 2,
      step_type: "tool",
      tool_info: { parameters: { command: "ls" } },
    });

    // 1. Trailing tool masks protocol error ("more than one result line" -> "tool call after the result line")
    const rProto = run([INIT(), RESULT(), RESULT(), trailingStep]);
    expect(rProto.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });

    // 2. Trailing tool does NOT mask permission denial
    const rDenial = run([INIT(), RESULT({ denied_actions: [{ display_name: "view_file" }] }), trailingStep]);
    expect(rDenial.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: view_file",
    });

    // 3. Trailing tool does NOT mask auth error
    const rAuth = run([
      INIT(),
      RESULT({ status: "ERROR", error: "authentication failed: missing token" }),
      trailingStep,
    ]);
    expect(rAuth.result).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      failureDetail: "auth: authentication failed: missing token",
    });

    // 4. Guard violation on trailing tool outranks the trailing tool protocol error
    const trailingPush = STEP({
      step_index: 2,
      step_type: "tool",
      tool_info: { parameters: { command: "git push origin main" } },
    });
    const rGuard = guarded([INIT(), RESULT(), trailingPush]);
    expect(rGuard.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "git write attempted: `git push` can create commits, change refs or push",
    });
  });

  it("tool name fallback chain: tool_info.name > e.tool_name > e.name > unknown; empty strings shadow lower fallbacks", () => {
    const namedCall = (stepObj: Record<string, unknown>) =>
      run([INIT(), STEP({ step_index: 1, step_type: "tool", ...stepObj })]).events.find((e) => e.kind === "tool_call");

    // tool_info.name non-string falls through to e.tool_name
    expect(namedCall({ tool_info: { name: 123 }, tool_name: "step_tool_name" })).toMatchObject({
      name: "step_tool_name",
    });

    // e.tool_name non-string falls through to e.name
    expect(namedCall({ tool_name: false, name: "outer_name" })).toMatchObject({
      name: "outer_name",
    });

    // e.tool_name empty string shadows e.name
    expect(namedCall({ tool_name: "", name: "outer_name" })).toMatchObject({
      name: "",
    });

    // No valid name falls through to "unknown"
    expect(namedCall({ tool_name: 99, name: null })).toMatchObject({
      name: "unknown",
    });

    // Tool name clipped to 64 chars
    const longName = "n".repeat(70);
    expect(namedCall({ name: longName })).toMatchObject({
      name: `${"n".repeat(64)}…`,
    });
  });
});

/**
 * Eighth pass (2026-10-15, Delegated, not owner-approved): as Grok T4.23 and Cursor T4.43 residuals,
 * pin observed parser behavior and label gaps rather than claiming native coverage. Synthetic lines only;
 * duplicate status/usage keys, post-result step identity and drifting totals; no new capture, parser unchanged.
 */
describe("antigravity parser residuals, eighth pass: divergent duplicate keys, trailing steps and usage drift (T4.33)", () => {
  const rows = (events: readonly NormalizedEvent[]) =>
    usageObservationsFromEvents(events, { runId: "run_antigravity_t433_eighth_usage", provider: "antigravity" });
  const tool = (index: number, command: string) =>
    STEP({ step_index: index, step_type: "tool", tool_info: { name: "run_command", parameters: { command } } });
  const duplicateStatus = (extra: Record<string, unknown>) =>
    RESULT(extra).replace('"status":"SUCCESS"', '"status":"ERROR","status":"SUCCESS"');

  it("a later duplicate SUCCESS status cannot erase an independent error or denied_actions payload", () => {
    const denied = run([INIT(), duplicateStatus({ denied_actions: [{ action: "edit_file" }] })]);
    expect(denied.events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: true }]);
    expect(denied.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: edit_file",
    });
    const errored = run([INIT(), duplicateStatus({ error: "invalid model selection: unavailable" })]);
    expect(errored.events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: true }]);
    expect(errored.result).toMatchObject({ ok: false, failureCode: "MODEL_UNAVAILABLE" });
    // Gap/control: absent those separate signals, JSON.parse has discarded the earlier ERROR.
    expect(run([INIT(), duplicateStatus({})]).result).toMatchObject({ ok: true });
  });

  it("pins the gap: a last non-string status makes the whole result unknown, dropping its denial and usage", () => {
    const line = RESULT({ denied_actions: [{ action: "edit_file" }] }).replace(
      '"status":"SUCCESS"',
      '"status":"SUCCESS","status":null',
    );
    const r = run([INIT(), line]);
    expect(r.events).toEqual([
      { kind: "session_bound", nativeSessionId: CID },
      { kind: "unknown", rawType: "result" },
    ]);
    expect(rows(r.events)).toEqual([]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 1 });
  });

  it("pins the gap: a duplicate usage object replaces its earlier counters rather than merging or validating them", () => {
    const line = RESULT().replace('"usage":', '"usage":{"total_tokens":0,"input_tokens":999},"usage":');
    const r = run([INIT(), line]);
    expect(rows(r.events)).toEqual([expect.objectContaining({ source: "provider_reported", metrics: USAGE })]);
    expect(r.result).toMatchObject({ ok: true });
    const reversed = RESULT()
      .replace('"usage":', '"usage":{"total_tokens":999},"usage":')
      .replace('"total_tokens":24', '"total_tokens":0');
    const failed = run([INIT(), reversed]);
    expect(rows(failed.events)).toEqual([expect.objectContaining({ metrics: { ...USAGE, total_tokens: 0 } })]);
    expect(failed.result).toMatchObject({ ok: false, failureDetail: "SUCCESS with no reported tokens" });
  });

  it("a repeated command on a fresh step index after result is a trailing tool, not a deduplicated repeat", () => {
    const r = run([INIT(), tool(1, "pwd"), RESULT(), tool(2, "pwd")]);
    expect(r.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_command", command: "pwd" },
      { kind: "tool_call", tool: "shell", name: "run_command", command: "pwd" },
    ]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    expect(run([INIT(), tool(1, "pwd"), RESULT(), tool(1, "pwd")]).result).toMatchObject({ ok: true });
  });

  it("a post-result changed command on the same step index still reaches the Git guard", () => {
    const r = run([INIT(), tool(1, "pwd"), RESULT(), tool(1, "git push origin HEAD")]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    const events = r.events.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    expect(events.filter((e) => e.kind === "tool_call")).toHaveLength(2);
    expect(adapter().extractResult(events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "git write attempted: `git push` can create commits, change refs or push",
    });
  });

  it("step counter drift before and after result does not add or replace the provider-reported run total", () => {
    const step = (index: number, total: number) =>
      STEP({
        step_index: index,
        step_type: "agent_response",
        usage: { total_tokens: total },
        total_tokens: total,
      });
    const r = run([INIT(), step(1, 100), step(1, 1), RESULT(), step(2, 999)]);
    expect(r.events.map((e) => e.kind)).toEqual(["session_bound", "usage", "message", "result"]);
    expect(rows(r.events)).toEqual([expect.objectContaining({ source: "provider_reported", metrics: USAGE })]);
    expect(r.result).toMatchObject({ ok: true });
  });

  it.each([1, 999])(
    "a second result drifting to %s tokens fails without revising the first usage observation",
    (total) => {
      const r = run([INIT(), RESULT(), RESULT({ usage: { total_tokens: total } })]);
      expect(rows(r.events)).toEqual([expect.objectContaining({ source: "provider_reported", metrics: USAGE })]);
      expect(r.events.filter((e) => e.kind === "result")).toEqual([
        { kind: "result", ok: true },
        { kind: "result", ok: false, summary: "SUCCESS with no reported tokens" },
      ]);
      // Gap: that summary does not distinguish duplicate results from missing tokens, even with a positive total.
      expect(r.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: more than one result line",
      });
    },
  );
});

/** Ninth pass: synthetic permutations only; no new capture, parser unchanged (Delegated, 2026-10-16). */
describe("antigravity parser residuals, ninth pass: soft-denial ordering, envelope keys and resume id parity (T4.33)", () => {
  const observations = (events: readonly NormalizedEvent[]) =>
    usageObservationsFromEvents(events, { runId: "run_antigravity_t433_ninth_usage", provider: "antigravity" });
  const tool = (index: number, state: string) =>
    STEP({
      step_index: index,
      state,
      step_type: "tool",
      tool_info: { name: "run_command", parameters: { command: "pwd" } },
    });

  it.each(["ACTIVE", "DONE", "ERROR"])(
    "a %s update after a soft-denied result keeps the denial for repeated and fresh steps",
    (state) => {
      for (const index of [1, 2]) {
        const r = run([
          INIT(),
          tool(1, "ACTIVE"),
          RESULT({ denied_actions: [{ display_name: "Run" }] }),
          tool(index, state),
        ]);
        // Step state is not a permission verdict. Repeats deduplicate; fresh steps still emit their calls.
        expect(r.events.filter((e) => e.kind === "tool_call")).toHaveLength(index);
        expect(r.events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: true }]);
        expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: "denied: Run" });
        expect(observations(r.events)).toEqual([expect.objectContaining({ metrics: USAGE })]);
      }
    },
  );

  it("pins the gap: duplicate result envelope keys discard the first envelope's denial and conflicting usage", () => {
    const bad = JSON.stringify({
      conversation_id: OTHER,
      status: "ERROR",
      denied_actions: [{ action: "edit_file" }],
      usage: { total_tokens: 0 },
    });
    const good = JSON.stringify({ conversation_id: CID, status: "SUCCESS", response: "ok", usage: USAGE });
    const r = run([INIT(), `{"event":"result","result":${bad},"result":${good}}`]);
    expect(r.events.filter((e) => e.kind === "permission_denied" || e.kind === "provider_error")).toEqual([]);
    expect(r.events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: true }]);
    expect(r.result).toMatchObject({ ok: true, nativeSessionId: CID });
    expect(observations(r.events)).toEqual([expect.objectContaining({ metrics: USAGE })]);
    const reversed = run([INIT(), `{"event":"result","result":${good},"result":${bad}}`]);
    expect(reversed.events.filter((e) => e.kind === "result")).toHaveLength(1);
    expect(reversed.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: CID });
    expect(observations(reversed.events)).toEqual([expect.objectContaining({ metrics: { total_tokens: 0 } })]);
  });

  it.each([
    ['0,"total_tokens":24', true, { total_tokens: 24 }],
    ['24,"total_tokens":0', false, { total_tokens: 0 }],
    ['24,"total_tokens":null', false, undefined],
  ] as const)("duplicate total_tokens %s uses the last scalar for verdict and ledger", (value, ok, metrics) => {
    const line = `{"event":"result","result":{"conversation_id":"${CID}","status":"SUCCESS","usage":{"total_tokens":${value}}}}`;
    const r = run([INIT(), line]);
    expect(r.result.ok).toBe(ok);
    expect(observations(r.events)).toEqual(metrics === undefined ? [] : [expect.objectContaining({ metrics })]);
    if (!ok)
      expect(r.result).toMatchObject({ failureCode: "TOOL_FAILURE", failureDetail: "SUCCESS with no reported tokens" });
  });

  it.each([CID, "a".repeat(256), "a".repeat(257), "_leading", "-option", "id with space", ""])(
    "init and result-only id %j have parser parity, and resumeArgs compiles exactly the ids the parser binds",
    (id) => {
      const fromInit = run([INIT({ conversation_id: id }), RESULT({ conversation_id: id })]);
      const fromResult = run([RESULT({ conversation_id: id })]);
      expect(fromInit.result).toEqual(fromResult.result);
      if (id === "") {
        expect(fromResult.result).toEqual({ ok: true, unknownEventCount: 0, summary: "ok" });
      } else if (id === CID || id.length === 256) {
        expect(fromResult.result).toMatchObject({ ok: true, nativeSessionId: id });
      } else {
        expect(fromResult.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
        expect(fromResult.result.nativeSessionId).toBeUndefined();
      }
      expect(fromInit.events.filter((e) => e.kind === "session_bound")).toEqual(
        fromResult.events.filter((e) => e.kind === "session_bound"),
      );
      const req: CompileRequest = {
        runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
        objective: "synthetic resume parity",
        constraints: [],
        workspace: { cwd: "/work/tree", writable: true },
        bypassApproved: true,
      };
      const a = adapter();
      const resumed = a.resumeArgs({ provider: "antigravity", nativeSessionId: id }, req, PRIVILEGED_BYPASS_PROFILE);
      const bound = fromResult.result.nativeSessionId;
      if (bound !== undefined) {
        if (isIneligible(resumed)) throw new Error(resumed.detail);
        expect(resumed.argv.slice(-2)).toEqual(["--conversation", bound]);
      } else {
        expect(resumed).toEqual({
          ineligible: true,
          reason: "CAPABILITY_MISSING",
          detail: "native session id is not a safe single argument",
        });
      }
    },
  );
});

/**
 * Tenth pass (2026-10-16, Delegated, not owner-approved): Q-86 numeric edges, non-array `denied_actions` beside a
 * `SUCCESS` envelope, which result owns the `provider_reported` row, a flag-shaped objective beside the resume refusal
 * and lines after the result that the parser cannot read. Synthetic lines only; no new capture, parser unchanged.
 */
describe("antigravity parser residuals, tenth pass: Q-86 numeric edges, denial shapes, usage ownership and trailing unknowns (T4.33)", () => {
  const observations = (events: readonly NormalizedEvent[]) =>
    usageObservationsFromEvents(events, { runId: "run_antigravity_t433_tenth_usage", provider: "antigravity" });
  const raw = (usage: string) =>
    `{"event":"result","result":{"conversation_id":"${CID}","status":"SUCCESS","response":"ok","usage":${usage}}}`;

  it.each([
    ["1e309", false, { input_tokens: 20 }],
    ["-0", false, { input_tokens: 20, total_tokens: -0 }],
    ["5e-324", true, { input_tokens: 20, total_tokens: 5e-324 }],
  ] as const)("total_tokens %s: Q-86 verdict and ledger row", (total, ok, metrics) => {
    const r = run([INIT(), raw(`{"input_tokens":20,"total_tokens":${total}}`)]);
    // An overflowing total parses to Infinity and is dropped; -0 passes `v >= 0`, so the row keeps -0, not 0.
    expect(observations(r.events)).toEqual([expect.objectContaining({ source: "provider_reported", metrics })]);
    expect(r.result.ok).toBe(ok);
    if (!ok)
      expect(r.result).toMatchObject({ failureCode: "TOOL_FAILURE", failureDetail: "SUCCESS with no reported tokens" });
    // Gap: any positive total passes Q-86, even one far below a single token.
  });

  it.each([[{}], [false], [0], [""], ["edit_file"], [[null]], [[42]]])(
    "denied_actions %j beside SUCCESS with tokens is one unnamed denial, never ignored",
    (denied) => {
      const r = run([INIT(), RESULT({ denied_actions: denied })]);
      expect(r.events.filter((e) => e.kind === "permission_denied")).toEqual([
        { kind: "permission_denied", tool: "unknown" },
      ]);
      expect(r.events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: true }]);
      // Gap: a bare string is not read as the action name.
      expect(r.result).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: "denied: unknown",
      });
      expect(observations(r.events)).toEqual([expect.objectContaining({ metrics: USAGE })]);
    },
  );

  it("an empty denied_actions array or null is no denial, so the SUCCESS envelope with tokens is a success", () => {
    for (const denied of [[], null]) {
      expect(run([INIT(), RESULT({ denied_actions: denied })]).result).toEqual({
        ok: true,
        unknownEventCount: 0,
        nativeSessionId: CID,
        summary: "ok",
      });
    }
  });

  it("a denial outranks an auth error, a zero total and a non-SUCCESS status in the failure code", () => {
    const r = run([
      INIT(),
      RESULT({
        status: "ERROR",
        error: "authentication failed: synthetic",
        usage: { total_tokens: 0 },
        denied_actions: [{ action: "run_command" }],
      }),
    ]);
    expect(r.events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: false, summary: "ERROR" }]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: run_command",
    });
    const noDenial = run([INIT(), RESULT({ status: "ERROR", error: "authentication failed: synthetic" })]);
    expect(noDenial.result).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
  });

  it("pins the gap: only the first result may record usage, so a second result's usage after a usage-less first is lost", () => {
    const first = j({ event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "a" } });
    const r = run([INIT(), first, RESULT()]);
    expect(observations(r.events)).toEqual([]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
    });
  });

  it("a usage object with only unrecorded or negative counters records no row and fails Q-86", () => {
    const r = run([INIT(), raw('{"cost_usd":0.01,"total_tokens":-24,"output_tokens":-1,"cache_read_tokens":2}')]);
    expect(observations(r.events)).toEqual([expect.objectContaining({ metrics: { cache_read_tokens: 2 } })]);
    expect(r.result).toMatchObject({ ok: false, failureDetail: "SUCCESS with no reported tokens" });
    const none = run([INIT(), raw('{"cost_usd":0.01,"total_tokens":"24"}')]);
    expect(none.events.some((e) => e.kind === "usage")).toBe(false);
    expect(none.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  it("a flag-shaped objective stays inside the one --prompt= word, on a first run and on a resume", () => {
    const req: CompileRequest = {
      runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
      objective: `--conversation ${CID} --continue`,
      constraints: [],
      workspace: { cwd: "/work/tree", writable: true },
      bypassApproved: true,
    };
    const a = adapter();
    const compiled = a.compile(req, PRIVILEGED_BYPASS_PROFILE);
    expect(isIneligible(compiled)).toBe(false);
    if (isIneligible(compiled)) return;
    expect(compiled.argv.filter((w) => w.startsWith("--prompt"))).toEqual([`--prompt=${req.objective}`]);
    expect(compiled.argv.filter((w) => ["--conversation", "--continue", "-c", CID].includes(w))).toEqual([]);
    const resumed = a.resumeArgs({ provider: "antigravity", nativeSessionId: CID }, req, PRIVILEGED_BYPASS_PROFILE);
    if (isIneligible(resumed)) throw new Error(resumed.detail);
    // The objective's flag words stay in the prompt word; the resume adds exactly one `--conversation <id>` pair.
    expect(resumed.argv).toEqual([...compiled.argv, "--conversation", CID]);
    expect(resumed.argv.filter((w) => ["--continue", "-c"].includes(w))).toEqual([]);
  });

  it("trailing unreadable lines after a good result are counted as unknown and do not flip the verdict", () => {
    const trailing = [
      j({ event: "telemetry", conversation_id: OTHER }),
      j({ event: "step_update", conversation_id: CID, step_type: "tool" }),
      j({ event: "init", conversation_id: OTHER }),
      j({ conversation_id: OTHER }),
    ];
    const r = run([INIT(), RESULT(), ...trailing]);
    expect(r.state).toMatchObject({ lines: 6, unknownEvents: 4 });
    expect(r.events.slice(-4)).toEqual([
      { kind: "unknown", rawType: "telemetry" },
      { kind: "unknown", rawType: "step_update" },
      { kind: "unknown", rawType: "init" },
      { kind: "unknown", rawType: "none" },
    ]);
    // An unknown line's forged id binds nothing and is not a changed id.
    expect(r.result).toEqual({ ok: true, unknownEventCount: 4, nativeSessionId: CID, summary: "ok" });
  });

  it("pins the gap: a trailing status-less result carrying an error or a denial is unknown, not a second result", () => {
    const line = j({
      event: "result",
      result: { conversation_id: OTHER, error: "authentication failed", denied_actions: [{ action: "edit_file" }] },
    });
    const r = run([INIT(), RESULT(), line]);
    expect(r.events.at(-1)).toEqual({ kind: "unknown", rawType: "result" });
    expect(r.events.some((e) => e.kind === "provider_error" || e.kind === "permission_denied")).toBe(false);
    expect(r.result).toMatchObject({ ok: true, unknownEventCount: 1 });
    // Control: with a status the same line is a second result and the run fails closed.
    const withStatus = j({ event: "result", result: { conversation_id: CID, status: "SUCCESS", usage: USAGE } });
    expect(run([INIT(), RESULT(), withStatus]).result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
  });

  it("pins the gap: a trailing unknown event that names a Git write is never a tool_call, so the guard does not see it", () => {
    const r = run([INIT(), RESULT(), j({ event: "tool_call", conversation_id: CID, command: "git push origin main" })]);
    const guarded = r.events.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    expect(guarded.filter((e) => e.kind === "tool_call")).toEqual([]);
    expect(adapter().extractResult(guarded, EXIT0)).toMatchObject({ ok: true, unknownEventCount: 1 });
  });
});

/**
 * Eleventh pass (2026-10-16, Delegated, not owner-approved): envelope shapes that are not objects, non-string ids and
 * presentation fields, an empty or near-miss status, overflowing step indexes and the failure tail when the supervisor
 * ends a run that printed a clean result. Synthetic lines only (no new fixture: the fixture inventory is owned by the
 * T4.35 conformance file); no new capture, no `agy` run, parser unchanged.
 */
describe("antigravity parser residuals, eleventh pass: envelope shapes, non-string fields, status edges and the failure tail (T4.33)", () => {
  const observations = (events: readonly NormalizedEvent[]) =>
    usageObservationsFromEvents(events, { runId: "run_antigravity_t433_eleventh_usage", provider: "antigravity" });

  it.each([
    ["null", "none"],
    ["42", "none"],
    ['"result"', "none"],
    ["[]", "none"],
    [j({ event: 7, conversation_id: CID }), "none"],
    [j({ event: null, result: { status: "SUCCESS", usage: USAGE } }), "none"],
    [j({ event: ["result"], result: { status: "SUCCESS", usage: USAGE } }), "none"],
    [j({ event: "init", conversation_id: CID, init: [] }), "init"],
    [j({ event: "init", conversation_id: CID, init: "cwd" }), "init"],
    [j({ event: "init", conversation_id: 42, init: { cwd: "/work/tree" } }), "init"],
    [j({ event: "result", result: [{ status: "SUCCESS", usage: USAGE }] }), "result"],
    [j({ event: "result", result: "SUCCESS" }), "result"],
    [j({ event: "result", result: null }), "result"],
  ] as const)("line %s is one counted unknown (rawType %s) that binds and reports nothing", (line, rawType) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    expect(a.parseEvent(line, state)).toEqual([{ kind: "unknown", rawType }]);
    expect(state).toEqual({ lines: 1, unknownEvents: 1 });
    // Beside a good stream it never flips the verdict or the bound id; alone it is no result.
    expect(run([INIT(), line, RESULT()]).result).toEqual({
      ok: true,
      unknownEventCount: 1,
      nativeSessionId: CID,
      summary: "ok",
    });
    expect(run([line]).result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "no result event",
    });
  });

  it.each([[42], [true], [{ id: CID }], [[CID]], [null]])(
    "pins the gap: a result-only stream whose conversation_id is %j succeeds with no session bound",
    (id) => {
      const r = run([RESULT({ conversation_id: id })]);
      expect(r.events.some((e) => e.kind === "session_bound" || e.kind === "provider_error")).toBe(false);
      // A non-string id is not read as an id at all, so it is neither bound nor refused as unsafe.
      expect(r.result).toEqual({ ok: true, unknownEventCount: 0, summary: "ok" });
      expect(observations(r.events)).toEqual([expect.objectContaining({ metrics: USAGE })]);
      // With init first, the non-string result id is not compared, so it is never a changed id either.
      expect(run([INIT(), RESULT({ conversation_id: id })]).result).toMatchObject({ ok: true, nativeSessionId: CID });
    },
  );

  it.each([[42], [{ text: "ok" }], [["ok"]], [true], [null]])(
    "a non-string response %j emits no message, leaves no summary and does not fail the run",
    (response) => {
      const r = run([INIT(), RESULT({ response })]);
      expect(r.events.some((e) => e.kind === "message")).toBe(false);
      expect(r.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID });
    },
  );

  it("a non-string or empty model is dropped from session_bound; the outer model is read only when init has none", () => {
    const bound = (lines: string[]) => run(lines).events.filter((e) => e.kind === "session_bound");
    const init = (inner: Record<string, unknown>, outer: Record<string, unknown> = {}) =>
      j({ event: "init", conversation_id: CID, ...outer, init: { cwd: "/work/tree", ...inner } });
    expect(bound([init({ model: 42 }), RESULT()])).toEqual([{ kind: "session_bound", nativeSessionId: CID }]);
    expect(bound([init({ model: "" }), RESULT()])).toEqual([{ kind: "session_bound", nativeSessionId: CID }]);
    // `??` falls through only on null or a missing key: a non-string inner model shadows a good outer one.
    expect(bound([init({ model: 42 }, { model: "outer" }), RESULT()])).toEqual([
      { kind: "session_bound", nativeSessionId: CID },
    ]);
    expect(bound([init({ model: null }, { model: "outer" }), RESULT()])).toEqual([
      { kind: "session_bound", nativeSessionId: CID, model: "outer" },
    ]);
  });

  it("pins the gap: a non-string root backing_provider shadows a good nested one; a null root falls through", () => {
    const bound = (outer: Record<string, unknown>) =>
      run([
        j({
          event: "init",
          conversation_id: CID,
          ...outer,
          init: { cwd: "/work/tree", backing_provider: "google" },
        }),
        RESULT(),
      ]).events.filter((e) => e.kind === "session_bound");
    expect(bound({ backing_provider: 42 })).toEqual([{ kind: "session_bound", nativeSessionId: CID }]);
    expect(bound({ backing_provider: "" })).toEqual([{ kind: "session_bound", nativeSessionId: CID }]);
    expect(bound({ backing_provider: null })).toEqual([
      { kind: "session_bound", nativeSessionId: CID, backingProvider: "google" },
    ]);
    expect(bound({ backing_provider: null, backingProvider: "camel" })).toEqual([
      { kind: "session_bound", nativeSessionId: CID, backingProvider: "camel" },
    ]);
  });

  it.each([
    ["success", "success"],
    [" SUCCESS", " SUCCESS"],
    ["SUCCESS\n", "SUCCESS\n"],
    ["SUCCESS​", "SUCCESS​"],
    ["Success", "Success"],
  ])("a near-miss status %j is not SUCCESS: TOOL_FAILURE with the raw status as the detail", (status, detail) => {
    const r = run([INIT(), RESULT({ status })]);
    expect(r.events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: false, summary: detail }]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: detail, summary: "ok" });
    // The tokens are still the run's reported usage (FR-CAP-01).
    expect(observations(r.events)).toEqual([expect.objectContaining({ metrics: USAGE })]);
  });

  it("pins the gap: an empty status takes the result slot and fails with an empty failure detail", () => {
    const r = run([INIT(), RESULT({ status: "" })]);
    expect(r.events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: false, summary: "" }]);
    // classifyCommon reads `summary ?? "task failed"`, so the empty summary survives as the detail.
    expect(r.result).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "",
      unknownEventCount: 0,
      nativeSessionId: CID,
      summary: "ok",
    });
    // It is a result, so a later SUCCESS is a second result, not the first.
    expect(run([INIT(), RESULT({ status: "" }), RESULT()]).result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
    });
  });

  it("pins the gap: every overflowing step_index parses to Infinity, so 1e309 and 2e309 are one step", () => {
    const step = (index: string, command: string) =>
      `{"event":"step_update","conversation_id":"${CID}","state":"DONE","step_type":"tool","step_index":${index},` +
      `"tool_info":{"name":"run_command","parameters":{"command":"${command}"}}}`;
    const r = run([INIT(), step("1e309", "pwd"), step("2e309", "pwd"), step("-1e309", "pwd"), RESULT()]);
    // Infinity and -Infinity are two keys; the repeat on +Infinity is deduplicated.
    expect(r.events.filter((e) => e.kind === "tool_call")).toHaveLength(2);
    // A different command on the collapsed index is still reported, so the guard still sees a Git write.
    const g = run([INIT(), step("1e309", "pwd"), step("2e309", "git push origin main"), RESULT()]);
    expect(g.events.filter((e) => e.kind === "tool_call").map((e) => e.kind === "tool_call" && e.command)).toEqual([
      "pwd",
      "git push origin main",
    ]);
    const guarded = g.events.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    expect(guarded.filter((e) => e.kind === "tool_call" && e.violation !== undefined)).toHaveLength(1);
    expect(adapter().extractResult(guarded, EXIT0)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("a supervisor outcome outranks every parsed failure, and the trailing-tool detail never replaces it", () => {
    const trailing = STEP({
      step_index: 9,
      step_type: "tool",
      tool_info: { name: "run_command", parameters: { command: "ls" } },
    });
    const events = run([
      INIT(),
      RESULT({ denied_actions: [{ action: "edit_file" }], error: "authentication failed" }),
      trailing,
    ]).events;
    const a = adapter();
    const base = { nativeSessionId: CID, summary: "ok", unknownEventCount: 0 };
    expect(a.extractResult(events, { ...EXIT0, outcome: "timeout", exitCode: null, timeoutKind: "idle" })).toEqual({
      ok: false,
      failureCode: "PROCESS_TIMEOUT",
      failureDetail: "idle timeout",
      ...base,
    });
    expect(a.extractResult(events, { ...EXIT0, outcome: "cancelled", exitCode: null })).toEqual({
      ok: false,
      failureCode: "CANCELLED",
      failureDetail: "run cancelled",
      ...base,
    });
    // A clean result is no defence either: the timeout ends the run whatever the stream said.
    const clean = run([INIT(), RESULT()]).events;
    expect(a.extractResult(clean, { ...EXIT0, outcome: "timeout", exitCode: null })).toMatchObject({
      ok: false,
      failureCode: "PROCESS_TIMEOUT",
      failureDetail: "unknown timeout",
      nativeSessionId: CID,
    });
  });

  it("classifyFailure reads the stderr tail only for a structured AGY_ERROR line at exit 3 (T6.15); free text changes nothing", () => {
    const events = run([INIT(), RESULT({ status: "ERROR" })]).events;
    const classify = (stderrTail: string, exit = EXIT0) =>
      adapter().classifyFailure({ events, exit, stderrTail, timedOut: false, cancelled: false });
    const plain = classify("");
    expect(plain).toEqual({ code: "TOOL_FAILURE", detail: "ERROR" });
    const EXIT3 = { ...EXIT0, exitCode: 3 };
    for (const tail of [
      "Error: Please sign in to view available models.",
      "authentication failed",
      "429 Too Many Requests: rate limit exceeded",
      "AGY_ERROR exit 3",
      "error: Individual quota reached. Resets in 2h0m56s.",
    ]) {
      expect(classify(tail), tail).toEqual(plain);
      expect(classify(tail, EXIT3), tail).toEqual(plain);
    }
    // The one structured shape (the 2026-10-17 T6.11 capture) maps at exit 3 and only there; limit-signals.test.ts has
    // the full rules.
    const structured = 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true}';
    expect(classify(structured)).toEqual(plain);
    expect(classify(structured, EXIT3)).toEqual({
      code: "QUOTA_EXHAUSTED",
      detail: "quota: AGY_ERROR status RESOURCE_EXHAUSTED, error_code 429, retryable true",
    });
  });
});

/**
 * Twelfth pass (2026-10-16, Delegated, not owner-approved): unreadable `step_update` lines that name a Git write, the
 * never-read `state` field, a non-object `tool_info` and the root parameter containers, failure ranking by event order
 * inside one envelope, `init` lines after the result, status against exit code, and a whitespace-only response.
 * Synthetic lines only, no new fixture (the T4.35 fixture inventory in `conformance-residual.test.ts` lists every file),
 * parser unchanged. None of these shapes was recorded ([LIVE] C4, C7), so the gaps pin behaviour, not a native contract.
 */
describe("antigravity parser residuals, twelfth pass: unreadable steps, root containers, in-envelope ranking and post-result init (T4.33)", () => {
  const rows = (events: readonly NormalizedEvent[]) =>
    usageObservationsFromEvents(events, { runId: "run_antigravity_t433_twelfth_usage", provider: "antigravity" });
  const guarded = (lines: string[], exit: ExitInfo = EXIT0) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const raw = lines.flatMap((l) => a.parseEvent(l, state));
    const events = raw.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    return { raw, events, result: a.extractResult(events, exit) };
  };
  const PUSH = { name: "run_command", parameters: { command: "git push origin main" } };
  const PUSH_DETAIL = "git write attempted: `git push` can create commits, change refs or push";
  const calls = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "tool_call");

  it.each([
    ["a string step_index", { step_index: "2", step_type: "tool" }],
    ["a null step_index", { step_index: null, step_type: "tool" }],
    ["a boolean step_index", { step_index: true, step_type: "tool" }],
    ["an array step_index", { step_index: [2], step_type: "tool" }],
    ["no step_index", { step_type: "tool" }],
    ["a numeric step_type", { step_index: 2, step_type: 7 }],
    ["a null step_type", { step_index: 2, step_type: null }],
    ["an array step_type", { step_index: 2, step_type: ["tool"] }],
    ["no step_type", { step_index: 2 }],
  ] as const)("pins the gap: a step with %s naming a Git write is one counted unknown the guard never sees", (_, o) => {
    const line = STEP({ ...o, tool_info: PUSH });
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    expect(a.parseEvent(line, state)).toEqual([{ kind: "unknown", rawType: "step_update" }]);
    expect(state).toEqual({ lines: 1, unknownEvents: 1 });
    // No tool_call reaches the guard, so the run that pushed still succeeds.
    const r = guarded([INIT(), line, RESULT()]);
    expect(calls(r.events)).toEqual([]);
    expect(r.result).toEqual({ ok: true, unknownEventCount: 1, nativeSessionId: CID, summary: "ok" });
    // The same step with a numeric index and a string type is read and blocked.
    const read = guarded([INIT(), STEP({ step_index: 2, step_type: "tool", tool_info: PUSH }), RESULT()]);
    expect(read.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: PUSH_DETAIL });
  });

  it.each([[42], [null], ["PENDING"], [""], [{ value: "DONE" }], [undefined]])(
    "pins the gap: state %j is never read, so a tool step in it is still a tool_call the guard blocks",
    (s) => {
      const line = j({
        event: "step_update",
        conversation_id: CID,
        state: s,
        step_index: 4,
        step_type: "tool",
        tool_info: PUSH,
      });
      const r = guarded([INIT(), line, RESULT()]);
      expect(calls(r.raw)).toEqual([
        { kind: "tool_call", tool: "shell", name: "run_command", command: "git push origin main" },
      ]);
      expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: PUSH_DETAIL });
    },
  );

  it.each([[["run_command"]], ["git push origin main"], [42], [null], [true]])(
    "a non-object tool_info %j is skipped: the name falls back to tool_name and a root container still reaches the guard",
    (info) => {
      const withRoot = guarded([
        INIT(),
        STEP({
          step_index: 5,
          step_type: "tool",
          tool_info: info,
          tool_name: "run_command",
          parameters: { command: "git push origin main" },
        }),
        RESULT(),
      ]);
      expect(calls(withRoot.raw)).toEqual([
        { kind: "tool_call", tool: "shell", name: "run_command", command: "git push origin main" },
      ]);
      expect(withRoot.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
      // Gap: a bare string tool_info is never read as a name or a command, so alone it is an unnamed bare call.
      const alone = guarded([INIT(), STEP({ step_index: 5, step_type: "tool", tool_info: info }), RESULT()]);
      expect(calls(alone.raw)).toEqual([{ kind: "tool_call", tool: "other", name: "unknown" }]);
      expect(alone.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
    },
  );

  it.each(["parameters", "args", "input"])(
    "the root %s container alone carries a CommandLine command or an AbsolutePath / file_path target",
    (key) => {
      const cmd = guarded([
        INIT(),
        STEP({ step_index: 6, step_type: "tool", tool_name: "run_command", [key]: { CommandLine: "git tag v1" } }),
        RESULT(),
      ]);
      expect(calls(cmd.raw)).toEqual([
        { kind: "tool_call", tool: "shell", name: "run_command", command: "git tag v1" },
      ]);
      expect(cmd.result).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: "git write attempted: `git tag` can create commits, change refs or push",
      });
      const paths = guarded([
        INIT(),
        STEP({
          step_index: 7,
          step_type: "tool",
          tool_name: "write_to_file",
          [key]: { AbsolutePath: "/work/tree/a.ts", file_path: "b.ts" },
        }),
        RESULT(),
      ]);
      // Keys are read in TARGET_KEYS order (path, file_path, AbsolutePath), not in the line's key order.
      expect(calls(paths.raw)).toEqual([
        { kind: "tool_call", tool: "other", name: "write_to_file", target: "b.ts" },
        { kind: "tool_call", tool: "other", name: "write_to_file", target: "/work/tree/a.ts" },
      ]);
      expect(paths.result).toMatchObject({ ok: true });
    },
  );

  it("containers are read in order tool_info.{parameters,args,input} then root {parameters,args,input}, deduplicated", () => {
    const r = guarded([
      INIT(),
      STEP({
        step_index: 8,
        step_type: "tool",
        tool_info: { name: "run_command", input: { command: "ls" }, parameters: { command: "pwd" } },
        input: { command: "git push origin HEAD" },
        args: { command: "pwd" },
        parameters: { command: "ls" },
      }),
      RESULT(),
    ]);
    expect(calls(r.raw).map((e) => e.kind === "tool_call" && e.command)).toEqual(["pwd", "ls", "git push origin HEAD"]);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "git write attempted: `git push` can create commits, change refs or push",
    });
  });

  it("pins the gap: inside one envelope the id's protocol error comes first, so it outranks an auth or model error", () => {
    const unsafe = run([RESULT({ conversation_id: "-c", error: "authentication failed" })]);
    expect(unsafe.events.map((e) => e.kind)).toEqual([
      "provider_error",
      "usage",
      "provider_error",
      "message",
      "result",
    ]);
    expect(unsafe.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: conversation id is not a safe token",
    });
    const changed = run([INIT(), RESULT({ conversation_id: OTHER, error: "invalid model selection (synthetic)" })]);
    expect(changed.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: conversation id changed mid-run",
      nativeSessionId: CID,
    });
    // A denial in the same envelope outranks both provider errors, whatever their order.
    const denied = run([
      RESULT({ conversation_id: "-c", error: "authentication failed", denied_actions: [{ action: "run_command" }] }),
    ]);
    expect(denied.events.map((e) => e.kind)).toEqual([
      "provider_error",
      "usage",
      "permission_denied",
      "provider_error",
      "message",
      "result",
    ]);
    expect(denied.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: run_command",
    });
    // The usage is still the run's one provider_reported row.
    expect(rows(denied.events)).toEqual([expect.objectContaining({ source: "provider_reported", metrics: USAGE })]);
  });

  it("an init after the result is still compared: another or an unsafe id fails the run, the bound or an empty one does not", () => {
    const postResult = (init: string) => run([INIT(), RESULT(), init]);
    const initWith = (id: string) => j({ event: "init", conversation_id: id, init: { cwd: "/work/tree" } });
    expect(postResult(initWith(OTHER)).result).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: conversation id changed mid-run",
      unknownEventCount: 0,
      nativeSessionId: CID,
      summary: "ok",
    });
    expect(postResult(initWith("id with space")).result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: conversation id is not a safe token",
      nativeSessionId: CID,
    });
    for (const id of [CID, ""]) {
      const r = postResult(initWith(id));
      expect(
        r.events.filter((e) => e.kind === "session_bound"),
        id,
      ).toHaveLength(1);
      expect(r.result, id).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: "ok" });
    }
    // Gap: a post-result init is not a trailing tool and is not a second result, so only the id comparison catches it.
    expect(rows(postResult(initWith(OTHER)).events)).toHaveLength(1);
  });

  it("a failed status outranks an unexpected exit code; only a clean envelope leaves the exit code as the detail", () => {
    const at = (lines: string[], exitCode: number) =>
      adapter().extractResult(run(lines).events, { ...EXIT0, exitCode });
    expect(at([INIT(), RESULT({ status: "ERROR" })], 3)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "ERROR",
    });
    expect(at([INIT(), RESULT({ usage: { input_tokens: 20 } })], 1)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "SUCCESS with no reported tokens",
    });
    expect(at([INIT(), RESULT()], 1)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 1",
    });
    // A recognised error outranks both the status and the exit code.
    expect(at([INIT(), RESULT({ status: "ERROR", error: "authentication failed" })], 1)).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      failureDetail: "auth: authentication failed",
    });
    // No result at a failing exit is the exit code, not `no result event`.
    expect(at([INIT()], 2)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 2" });
  });

  it.each([" ", "\n", "\t "])(
    "pins the gap: a whitespace-only response %j is kept untrimmed as the message and summary",
    (response) => {
      const r = run([INIT(), RESULT({ response })]);
      expect(r.events.filter((e) => e.kind === "message")).toEqual([
        { kind: "message", role: "assistant", text: response },
      ]);
      expect(r.result).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: CID, summary: response });
    },
  );
});
