/**
 * T4.23 residual (2026-10-15, Delegated agent work, not owner-approved; synthetic lines only, no `grok` run, adapter
 * and parser unchanged). Pins parser branches grok.test.ts leaves implicit: id-less tool-call correlation, repeated
 * and parameter-less tool lines, a target added after a command, `num_turns` without a `usage` object, an empty
 * structured model or backing provider that shadows its fallback key, and the line counter. The tool-call field names
 * are Assumptions (the live check recorded no `tool_call` shape), so these pin behaviour, not a native contract.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runConformanceCase } from "../conformance.js";
import { guardEvent } from "../tool-guard.js";
import type { ParseState } from "../types.js";
import { GrokAdapter } from "./adapter.js";
import { DEFAULT_SESSION_ID, PRIVILEGED_BYPASS_PROFILE, replayAdapter } from "./fixtures/cases.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-grok-residual-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const adapter = () => new GrokAdapter({ executable: "/opt/synthetic/grok" });
const line = (o: unknown) => JSON.stringify(o);
const parse = (lines: (string | object)[]) => {
  const a = adapter();
  const state: ParseState = { lines: 0, unknownEvents: 0 };
  return { events: lines.flatMap((l) => a.parseEvent(l as string, state)), state };
};
const EXIT_OK = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] } as const;
const SID = "9f1c2b44-0d5e-4a77-8f3a-2b6c1d0e7a55";
const END = { type: "end", stopReason: "end_turn", sessionId: SID, usage: { input_tokens: 10 } };
const shell = (command: string) => ({ kind: "tool_call", tool: "shell", name: "run_terminal_command", command });

describe("grok parser residuals (T4.23, synthetic lines; parser unchanged)", () => {
  it("an id-less tool_call_update before any tool_call is call_1; a later id-less tool_call opens call_2", () => {
    const { events, state } = parse([
      line({ type: "tool_call_update", input: { command: "echo a" } }),
      line({ type: "tool_call_update", input: { command: "echo a" } }),
      line({ type: "tool_call", input: { command: "echo a" } }),
      line({ type: "tool_call_update", input: { command: "echo a" } }),
      line({ type: "tool_call_update", input: { command: "echo b" } }),
    ]);
    // The second update repeats call_1; the tool_call is a new call, so the same command is reported again; the next
    // update correlates to call_2 (deduplicated), and a swapped command on it is reported.
    expect(events).toEqual([shell("echo a"), shell("echo a"), shell("echo b")]);
    expect(state.unknownEvents).toBe(0);
  });

  it("two id-less tool_call lines with the same command are two calls, each reported to the guard", () => {
    const { events } = parse([
      line({ type: "tool_call", input: { command: "git status" } }),
      line({ type: "tool_call", input: { command: "git status" } }),
    ]);
    expect(events).toEqual([shell("git status"), shell("git status")]);
  });

  it("a repeated tool_call with the same id and command is not duplicated, and is never counted unknown", () => {
    const { events, state } = parse([
      line({ type: "tool_call", id: "t1", input: { command: "ls" } }),
      line({ type: "tool_call", id: "t1", input: { command: "ls" } }),
      line({ type: "tool_call", id: "t1", input: { command: "git push" } }),
    ]);
    expect(events).toEqual([shell("ls"), shell("git push")]);
    expect(state.unknownEvents).toBe(0);
  });

  it("a name-only update on a reported call emits nothing; on an unseen call it is reported as `other`", () => {
    const { events, state } = parse([
      line({ type: "tool_call", id: "t1", input: { command: "ls" } }),
      line({ type: "tool_call_update", id: "t1", tool: "run_terminal_command" }),
      line({ type: "tool_call_update", id: "t2", tool: "web_fetch" }),
      line({ type: "tool_call_update", id: "t2", tool: "web_fetch" }),
    ]);
    expect(events).toEqual([shell("ls"), { kind: "tool_call", tool: "other", name: "web_fetch" }]);
    expect(state.unknownEvents).toBe(0);
  });

  it("a target added to a call already reported with a command is reported as a separate `read` event", () => {
    const { events } = parse([
      line({ type: "tool_call", id: "t1", tool: "edit_file", input: { command: "cat x" } }),
      line({ type: "tool_call_update", id: "t1", tool: "edit_file", input: { path: ".git/config" } }),
    ]);
    expect(events).toEqual([
      { kind: "tool_call", tool: "shell", name: "edit_file", command: "cat x" },
      { kind: "tool_call", tool: "read", name: "edit_file", target: ".git/config" },
    ]);
  });

  it("an id-less update carrying a Git write is still guarded when no tool_call line preceded it (ADR-0039)", () => {
    const ctx = { cwd: "/w", bypass: true };
    const events = parse([
      line({ type: "tool_call_update", input: { command: "git push origin main" } }),
      line(END),
    ]).events.map((e) => guardEvent(e, ctx));
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("fixture idless_update_guard replays an id-less Git-write update under end_turn at exit 0 to PERMISSION_BLOCKED", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("idless_update_guard"),
      request: {
        runId: "run_grok_t423_residual",
        objective: "synthetic grok objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", unknownEventCount: 0 });
  });

  it("num_turns without a usage object records no usage; with an empty usage object it records num_turns alone", () => {
    const bare = parse([line({ type: "end", stopReason: "end_turn", sessionId: SID, num_turns: 3 })]);
    expect(bare.events.some((e) => e.kind === "usage")).toBe(false);
    expect(adapter().extractResult(bare.events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });

    const empty = parse([line({ type: "end", stopReason: "end_turn", sessionId: SID, usage: {}, num_turns: 3 })]);
    expect(empty.events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { num_turns: 3 } },
    ]);
  });

  it("an empty structured model or backing provider shadows its fallback key and binds none (no coercion)", () => {
    const { events } = parse([
      line({
        ...END,
        model: "",
        model_id: "grok-fallback",
        modelUsage: { "grok-usage": {} },
        backing_provider: "",
        backingProvider: "backing-fallback",
      }),
    ]);
    expect(events.filter((e) => e.kind === "session_bound")).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
  });

  it("a non-string model falls through to model_id, then to the first own modelUsage key", () => {
    const viaId = parse([line({ ...END, model: 7, model_id: "grok-4.7-build" })]).events;
    expect(viaId.find((e) => e.kind === "session_bound")).toMatchObject({ model: "grok-4.7-build" });
    const viaUsage = parse([line({ ...END, model: null, model_id: {}, modelUsage: { "grok-x": {} } })]).events;
    expect(viaUsage.find((e) => e.kind === "session_bound")).toMatchObject({ model: "grok-x" });
  });

  it("the line counter counts every string line (dropped, malformed and unknown) and no ACP message", () => {
    const { state } = parse([
      line({ type: "thought", data: "x" }),
      "not json",
      line({ type: "invented" }),
      line({ type: "text", data: "hi" }),
      { jsonrpc: "2.0", method: "session/update" },
      line(END),
    ]);
    expect(state).toEqual({ lines: 5, unknownEvents: 1, nativeSessionId: SID });
  });
});
