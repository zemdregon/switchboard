/**
 * T4.68 (2026-10-16, Delegated agent work, not owner-approved): replays the two scrubbed `stream-json` captures of
 * Kimi Code CLI 2.1.1 taken through the operator's budgeted `live-run.sh` channel (`kimi -m <model> --agent-file
 * <read-only agent: Read, Grep> --output-format stream-json -p "<prompt>"`, scratch cwd, both exit 0; see
 * `docs/research/live-checks-2026-10-15-kimi.md`, "Follow-up 2"). No `kimi` binary is run here: the lines are fed to
 * `parseEvent` and `extractResult` as the supervisor would. The captures confirm the T4.63 Assumption on tool records
 * (`tool_calls[].function.{name,arguments}` with `arguments` a JSON string; a `tool` record with `tool_call_id` and
 * `content`) and show that a failed `Read` is reported only inside the `tool` record's text: the turn still ends with
 * the resume hint and exit 0, so the parser (by design: tool output is untrusted and never an event) sees a successful
 * run whose summary is the model's echo of the error text.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExitInfo, NormalizedEvent, ParseState } from "../types.js";
import { KimiAdapter } from "./adapter.js";
import { fixturePath } from "./fixtures/cases.js";

const EXIT_OK: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };

function replay(fixture: string): { events: NormalizedEvent[]; state: ParseState } {
  const adapter = new KimiAdapter({ executable: "/opt/synthetic/kimi" });
  const state: ParseState = { lines: 0, unknownEvents: 0 };
  const lines = readFileSync(fixturePath(fixture), "utf8").split("\n").filter(Boolean);
  return { events: lines.flatMap((l) => adapter.parseEvent(l, state)), state };
}

describe("kimi live captures (T4.68, live-run.sh 2026-10-16, CLI 2.1.1; scrubbed, replayed offline)", () => {
  it("parses the captured Read tool call and the captured failed Read the same way: tool_call, message, bound, ok", () => {
    const adapter = new KimiAdapter({ executable: "/opt/synthetic/kimi" });

    // Run 1: `Read w690/probe.txt` succeeded; the model echoed the first line.
    const call = replay("captured_tool_call");
    expect(call.state).toMatchObject({
      lines: 5,
      unknownEvents: 0,
      nativeSessionId: "session_00000000-0000-0000-0000-000000000468",
    });
    expect(call.events).toEqual([
      { kind: "tool_call", tool: "read", name: "Read", target: "w690/probe.txt" },
      { kind: "message", role: "assistant", text: "probe-ok-690" },
      { kind: "session_bound", nativeSessionId: "session_00000000-0000-0000-0000-000000000468" },
      { kind: "result", ok: true },
    ]);
    expect(adapter.extractResult(call.events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: "session_00000000-0000-0000-0000-000000000468",
      summary: "probe-ok-690",
    });

    // Run 2: `Read w690/does-not-exist.txt` failed inside the tool. The CLI printed no error record and exited 0; the
    // failure text is only in the `tool` record (dropped, untrusted) and the assistant's echo of it (a message).
    const failed = replay("captured_tool_error");
    expect(failed.state).toMatchObject({ lines: 5, unknownEvents: 0 });
    expect(failed.events).toEqual([
      { kind: "tool_call", tool: "read", name: "Read", target: "w690/does-not-exist.txt" },
      { kind: "message", role: "assistant", text: '"w690/does-not-exist.txt" does not exist.' },
      { kind: "session_bound", nativeSessionId: "session_00000000-0000-0000-0000-000000000469" },
      { kind: "result", ok: true },
    ]);
    expect(failed.events.some((e) => e.kind === "provider_error" || e.kind === "unknown")).toBe(false);
    expect(adapter.extractResult(failed.events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: "session_00000000-0000-0000-0000-000000000469",
      summary: '"w690/does-not-exist.txt" does not exist.',
    });
  });
});
