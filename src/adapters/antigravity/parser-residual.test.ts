/**
 * T4.33 (Delegated, not owner-approved): residual `parseEvent` and `extractResult` branches that survived a mutation
 * pass over `adapter.ts` on 2026-10-15 (each test below fails when its branch is mutated). SYNTHETIC lines in the
 * `stream-json` shapes of the 2026-10-14 live check (C4, C7, C10); no new capture, no `agy` run, parser unchanged.
 * Outside the T4.35 case list and the T4.36 malicious leg.
 */
import { describe, expect, it } from "vitest";
import { privilegedProfile } from "../fixtures/privileged.js";
import type { CompileRequest, ExitInfo, NormalizedEvent, ParseState, ResolvedProfile } from "../types.js";
import { isIneligible } from "../types.js";
import { AntigravityAdapter } from "./adapter.js";

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
