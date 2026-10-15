/**
 * T4.33 (Delegated, not owner-approved): residual `parseEvent` and `extractResult` branches that survived a mutation
 * pass over `adapter.ts` on 2026-10-15 (each test below fails when its branch is mutated). SYNTHETIC lines in the
 * `stream-json` shapes of the 2026-10-14 live check (C4, C7, C10); no new capture, no `agy` run, parser unchanged.
 * Outside the T4.35 case list and the T4.36 malicious leg.
 */
import { describe, expect, it } from "vitest";
import type { ExitInfo, NormalizedEvent, ParseState } from "../types.js";
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
