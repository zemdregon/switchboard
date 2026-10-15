/**
 * T4.23 residual (2026-10-15, Delegated agent work, not owner-approved; synthetic lines only, no `grok` run, adapter
 * and parser unchanged). Pins parser branches grok.test.ts leaves implicit: id-less tool-call correlation, repeated
 * and parameter-less tool lines, a target added after a command, `num_turns` without a `usage` object, an empty
 * structured model or backing provider that shadows its fallback key, and the line counter. The tool-call field names
 * are Assumptions (the live check recorded no `tool_call` shape), so these pin behaviour, not a native contract.
 * Second pass: parameter-object and empty-command shadowing (pinned gaps), id-less updates after an id'd call, the
 * trailing-tool detail under another failure code, and empty `message` / `stopReason` values.
 * Third pass: stream order across `end` lines (an unrecognised `end`, a changed id, a failed first `end`, late text),
 * usage deduplication (including the gap that a counter-less first `end` drops a second `end`'s total), and resume
 * parity (more id shapes, refusal order with a missing binary, launcher and timeouts, no fork check: a pinned gap).
 * Fourth pass: a failing second `end` that binds the only id (pinned gap), a resumed run reporting another id replayed
 * end to end (pinned gap), `sessionId` on non-`end` lines, a late model, non-object and zero usage, bypass-approval parity.
 * Fifth pass: tool lines after `end` that the order check misses (an unreadable or deduplicated `tool_call_update`,
 * pinned gaps), the trailing-tool detail masking a two-`end` anomaly, prototype-named model values and `modelUsage` keys,
 * an unclipped command, a caller id that collides with a generated call key, usage key placement and fractional counts,
 * and `extractResult` honouring the compiled expected exit codes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runConformanceCase } from "../conformance.js";
import { guardEvent } from "../tool-guard.js";
import type { ParseState } from "../types.js";
import { GROK_BYPASS_NOT_APPROVED, GrokAdapter } from "./adapter.js";
import { DEFAULT_SESSION_ID, PRIVILEGED_BYPASS_PROFILE, RESUMED_SESSION_ID, replayAdapter } from "./fixtures/cases.js";

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

describe("grok parser residuals, second pass (T4.23, synthetic lines; parser unchanged)", () => {
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => parse(lines).events.map((e) => guardEvent(e, ctx));

  it("pins the gap: an object `input` without a command shadows `parameters`, `args` and `arguments` (no merge)", () => {
    for (const alt of ["parameters", "args", "arguments"]) {
      const call = { type: "tool_call", input: { description: "x" }, [alt]: { command: "git push origin main" } };
      const { events, state } = parse([line(call), line(END)]);
      expect(events[0], alt).toEqual({ kind: "unknown", rawType: "tool_call" });
      expect(state.unknownEvents, alt).toBe(1);
      // The guard never sees the Git write, so the turn succeeds with the line counted (field names are Assumptions).
      expect(adapter().extractResult(guarded([line(call), line(END)]), EXIT_OK), alt).toMatchObject({
        ok: true,
        unknownEventCount: 1,
      });
    }
  });

  it("a top-level command is still read when an object `input` carries none, and the guard sees it", () => {
    const call = { type: "tool_call", input: {}, command: "git push origin main" };
    expect(parse([line(call)]).events).toEqual([shell("git push origin main")]);
    expect(adapter().extractResult(guarded([line(call), line(END)]), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("pins the gap: an empty-string command is a command, so it shadows `cmd` and the top-level command", () => {
    const call = { type: "tool_call", input: { command: "", cmd: "git push origin main" }, command: "git push" };
    expect(parse([line(call)]).events).toEqual([shell("")]);
    expect(adapter().extractResult(guarded([line(call), line(END)]), EXIT_OK)).toMatchObject({ ok: true });
  });

  it("the run_terminal_command name makes a target-only call a `shell` event that carries the target", () => {
    const { events } = parse([line({ type: "tool_call", name: "run_terminal_command", input: { path: "/w/a" } })]);
    expect(events).toEqual([{ kind: "tool_call", tool: "shell", name: "run_terminal_command", target: "/w/a" }]);
  });

  it("an id-less tool_call_update after an id'd tool_call does not correlate to it: it opens call_1 and reports again", () => {
    const { events, state } = parse([
      line({ type: "tool_call", id: "t1", input: { command: "git status" } }),
      line({ type: "tool_call_update", input: { command: "git status" } }),
      line({ type: "tool_call_update", input: { command: "git status" } }),
      line({ type: "tool_call", input: { command: "git status" } }),
    ]);
    // Over-reporting, never under-reporting: the guard sees every distinct call at least once.
    expect(events).toEqual([shell("git status"), shell("git status"), shell("git status")]);
    expect(state.unknownEvents).toBe(0);
  });

  it("a tool call after the end line keeps the classifier's detail when the code is not OUTPUT_PROTOCOL_ERROR", () => {
    const tool = line({ type: "tool_call", input: { command: "ls" } });
    const cancelled = parse([line({ ...END, stopReason: "cancelled" }), tool]).events;
    expect(adapter().extractResult(cancelled, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "stopReason cancelled",
    });
    const exit1 = { ...EXIT_OK, exitCode: 1 };
    expect(adapter().extractResult(parse([line(END), tool]).events, exit1)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 1",
    });
    expect(adapter().extractResult(parse([line(END), tool]).events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the end line",
    });
  });

  it("an empty error message is still a provider error; an empty stopReason is a result that is not success", () => {
    const err = parse([line({ type: "error", message: "" }), line(END)]);
    expect(err.events[0]).toEqual({ kind: "provider_error", category: "unknown", message: "" });
    expect(adapter().extractResult(err.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "unknown: ",
      nativeSessionId: SID,
    });

    const stop = parse([line({ ...END, stopReason: "" })]);
    expect(stop.events.at(-1)).toEqual({ kind: "result", ok: false, summary: "stopReason " });
    expect(stop.state.unknownEvents).toBe(0);
    expect(adapter().extractResult(stop.events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  it("fixture shadowed_parameters replays a Git write hidden behind an object `input` to end_turn success (gap)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("shadowed_parameters"),
      request: {
        runId: "run_grok_t423_residual",
        objective: "synthetic grok objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, unknownEventCount: 1 });
  });
});

describe("grok parser residuals, third pass: stream order, usage dedup and resume parity (T4.23, synthetic lines; parser unchanged)", () => {
  const usages = (events: readonly { kind: string }[]) => events.filter((e) => e.kind === "usage");
  const approved = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true };
  const req = {
    runId: "run_grok_t423_residual",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };

  it("an unrecognised `end` does not take the first-end slot: its id and usage are dropped, the later `end` counts once", () => {
    const { events, state } = parse([
      line({ ...END, stopReason: 1, sessionId: "forged-id", usage: { input_tokens: 500 } }),
      line({ ...END, usage: { input_tokens: 7 } }),
    ]);
    expect(events).toEqual([
      { kind: "unknown", rawType: "end" },
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "usage", source: "provider_reported", metrics: { input_tokens: 7 } },
      { kind: "result", ok: true },
    ]);
    expect(state).toMatchObject({ unknownEvents: 1, nativeSessionId: SID });
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: true,
      nativeSessionId: SID,
      unknownEventCount: 1,
    });
  });

  it("pins the gap: a first `end` with no usable counter means a second `end`'s usage is never recorded", () => {
    const { events } = parse([
      line({ type: "end", stopReason: "end_turn", sessionId: SID }),
      line({ ...END, usage: { input_tokens: 99, output_tokens: 3 } }),
    ]);
    // The run total is recorded by the first `end` only (FR-CAP-01); the second fails the run, so nothing is counted.
    expect(usages(events)).toEqual([]);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("an `end` with an unsafe session id still records its usage and result, in the order error, usage, result", () => {
    const { events, state } = parse([line({ ...END, sessionId: "-r" })]);
    expect(events).toEqual([
      { kind: "provider_error", category: "protocol", message: "session id is not a safe argument" },
      { kind: "usage", source: "provider_reported", metrics: { input_tokens: 10 } },
      { kind: "result", ok: true },
    ]);
    expect(state.nativeSessionId).toBeUndefined();
  });

  it("a second `end` with a changed id emits both anomalies in order, no second usage, and keeps the first id", () => {
    const { events, state } = parse([
      line(END),
      line({ ...END, sessionId: "other-session", usage: { input_tokens: 5 } }),
    ]);
    expect(events).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "usage", source: "provider_reported", metrics: { input_tokens: 10 } },
      { kind: "result", ok: true },
      { kind: "provider_error", category: "protocol", message: "more than one end line" },
      { kind: "provider_error", category: "protocol", message: "session id changed mid-run" },
      { kind: "result", ok: false, summary: "stopReason end_turn" },
    ]);
    expect(state.nativeSessionId).toBe(SID);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
  });

  it("a failed first `end` records its usage; a later end_turn cannot flip it and the protocol error outranks it", () => {
    const { events } = parse([line({ ...END, stopReason: "cancelled" }), line(END)]);
    expect(usages(events)).toHaveLength(1);
    expect(events.filter((e) => e.kind === "result")).toEqual([
      { kind: "result", ok: false, summary: "stopReason cancelled" },
      { kind: "result", ok: false, summary: "stopReason end_turn" },
    ]);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("an error line before the `end` does not stop the run total being recorded, though the run fails", () => {
    const { events } = parse([line({ type: "error", message: "Not signed in" }), line(END)]);
    expect(usages(events)).toEqual([{ kind: "usage", source: "provider_reported", metrics: { input_tokens: 10 } }]);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
  });

  it("text after the `end` line joins the summary and leaves a clean turn clean (only a tool call trips the order check)", () => {
    const { events } = parse([line({ type: "text", data: "a" }), line(END), line({ type: "text", data: "b" })]);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
      summary: "ab",
    });
  });

  it("the parser and resumeArgs agree on more id shapes: both accept or both refuse", () => {
    const a = adapter();
    for (const [id, safe] of [
      ["A:b.c-d_9", true],
      ["9", true],
      ["a\n", false],
      ["\na", false],
      ["é", false],
      ["a b", false],
      ["a/b", false],
      ["a=b", false],
      ["_a", false],
      [":a", false],
    ] as const) {
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      a.parseEvent(line({ ...END, sessionId: id }), state);
      const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, approved);
      expect(state.nativeSessionId === id, JSON.stringify(id)).toBe(safe);
      expect("ineligible" in resumed, JSON.stringify(id)).toBe(!safe);
    }
  });

  it("resumeArgs refusal order: foreign binding, unsafe id, the compile matrix, then the missing binary (as compile)", () => {
    const missing = new GrokAdapter({ pathEnv: "/nonexistent" });
    const safe = { provider: "grok" as const, nativeSessionId: SID };
    const notFound = { ineligible: true, reason: "CAPABILITY_MISSING", detail: "grok not found on PATH" };
    expect(missing.compile(req, approved)).toEqual(notFound);
    expect(missing.resumeArgs(safe, req, approved)).toEqual(notFound);
    expect(missing.resumeArgs({ provider: "grok", nativeSessionId: "-r" }, req, approved)).toMatchObject({
      detail: "native session id is not a safe single argument",
    });
    expect(missing.resumeArgs({ provider: "codex", nativeSessionId: "-r" }, req, approved)).toMatchObject({
      detail: "binding is for codex",
    });
    // A matrix refusal comes before the missing binary on both paths.
    const gitWrite = { ...approved, shellAllowlist: ["git push origin main"] };
    const refused = missing.compile(req, gitWrite);
    expect(refused).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    expect(missing.resumeArgs(safe, req, gitWrite)).toEqual(refused);
    const withModel = { ...req, model: "grok-4.7-build" };
    expect(missing.resumeArgs(safe, withModel, approved)).toEqual(missing.compile(withModel, approved));
    expect(missing.compile(withModel, approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("T4.5"),
    });
  });

  it("resume keeps the launcher arguments and constructor timeouts exactly as compile, with only `-r <id>` appended", () => {
    const a = new GrokAdapter({
      executable: "/opt/synthetic/grok",
      launcherArgs: ["--launcher-a", "x"],
      timeouts: { idleMs: 1_234 },
    });
    const first = a.compile(req, approved);
    const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: SID }, req, approved);
    if ("ineligible" in first) throw new Error(first.detail);
    expect(first.argv.slice(0, 3)).toEqual(["/opt/synthetic/grok", "--launcher-a", "x"]);
    expect(first.timeouts.idleMs).toBe(1_234);
    expect(resumed).toEqual({ ...first, argv: [...first.argv, "-r", SID] });
    // Each call returns fresh arrays, so mutating one invocation never leaks into the next.
    first.argv.push("--mutated");
    first.timeouts.idleMs = 1;
    const again = a.compile(req, approved);
    if ("ineligible" in again) throw new Error(again.detail);
    expect(again.argv).not.toContain("--mutated");
    expect(again.timeouts.idleMs).toBe(1_234);
  });

  it("pins the gap: the parser has no resume context, so a resumed run whose `end` reports another id binds it", () => {
    // No adapter or lifecycle code compares the bound id with the requested one ([LIVE] 6a returned the same id).
    const a = adapter();
    const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: DEFAULT_SESSION_ID }, req, approved);
    expect("ineligible" in resumed).toBe(false);
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events = a.parseEvent(line(END), state);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });
  });
});

describe("grok parser residuals, fourth pass: session-id gaps, usage shapes and resume parity (T4.23, synthetic lines; parser unchanged)", () => {
  const req = {
    runId: "run_grok_t423_residual",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const bound = (events: readonly { kind: string }[]) => events.filter((e) => e.kind === "session_bound");

  it("pins the gap: a first `end` that binds nothing leaves the slot open, so a second, failing `end` binds the only id", () => {
    for (const first of ["--unsafe", "", 7, undefined]) {
      const label = JSON.stringify(first) ?? "undefined";
      const { events, state } = parse([
        line({ ...END, sessionId: first }),
        line({ ...END, usage: { input_tokens: 500 } }),
      ]);
      // The first `end` takes the first-end slot (its usage is the run total); the second is a protocol anomaly whose
      // id still binds, because #bind only refuses a change from an id already bound.
      expect(bound(events), label).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
      expect(
        events.filter((e) => e.kind === "usage"),
        label,
      ).toEqual([{ kind: "usage", source: "provider_reported", metrics: { input_tokens: 10 } }]);
      expect(state.nativeSessionId, label).toBe(SID);
      expect(adapter().extractResult(events, EXIT_OK), label).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: SID,
      });
    }
  });

  it("fixture unsafe_then_good_end replays to OUTPUT_PROTOCOL_ERROR with the second end's id bound (gap)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("unsafe_then_good_end"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ unknownEventCount: 0, summary: "Finished." });
  });

  it("pins the gap end to end: fixture resume_other_id passes `-r <requested>`, binds the reported id and succeeds", async () => {
    const a = replayAdapter("resume_other_id");
    const binding = { provider: "grok" as const, nativeSessionId: RESUMED_SESSION_ID };
    const request = { ...req, workspace: { cwd: makeCwd(), writable: true } };
    const inv = a.resumeArgs(binding, request, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in inv) throw new Error(inv.detail);
    expect(inv.argv.slice(-2)).toEqual(["-r", RESUMED_SESSION_ID]);
    const report = await runConformanceCase({
      kind: "resume",
      adapter: a,
      request,
      profile: PRIVILEGED_BYPASS_PROFILE,
      binding,
      expect: { ok: true, nativeSessionId: RESUMED_SESSION_ID },
    });
    // Only the conformance harness compares the ids; the adapter result is a success on the other session.
    expect(report.checks.filter((k) => !k.ok).map((k) => k.name)).toEqual(["native session id"]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: "00000000-0000-4000-8000-000000000099" });
  });

  it("a sessionId on any line other than `end` never binds or conflicts, before or after the `end` line", () => {
    const decoys = ["error", "text", "tool_call", "tool_call_update", "thought", "usage", "available_commands"].map(
      (type) => line({ type, sessionId: "decoy-session", data: "d", message: "m", input: { command: "ls" } }),
    );
    const none = parse([...decoys, line({ ...END, sessionId: undefined })]);
    expect(bound(none.events)).toEqual([]);
    expect(none.state.nativeSessionId).toBeUndefined();

    const { events, state } = parse([...decoys, line(END), ...decoys]);
    expect(bound(events)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    expect(state.nativeSessionId).toBe(SID);
    // The decoy ids never raise "session id changed mid-run"; only the error line is a provider error.
    expect(events.filter((e) => e.kind === "provider_error")).toEqual([
      { kind: "provider_error", category: "unknown", message: "m" },
      { kind: "provider_error", category: "unknown", message: "m" },
    ]);
  });

  it("the first binding is final: a model on a later `end` never amends it, unless the first `end` bound nothing", () => {
    const later = parse([line(END), line({ ...END, model: "grok-late", backing_provider: "late" })]).events;
    expect(bound(later)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);

    const lost = parse([
      line({ ...END, sessionId: "-x", model: "grok-first" }),
      line({ ...END, model: "grok-second", backingProvider: "backing-second" }),
    ]).events;
    expect(bound(lost)).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "grok-second", backingProvider: "backing-second" },
    ]);
  });

  it("a non-object usage records nothing even with num_turns; zero counters are counts and are recorded", () => {
    for (const usage of [[], null, "10", 10, [{ input_tokens: 5 }]]) {
      const { events } = parse([line({ ...END, usage, num_turns: 2 })]);
      expect(
        events.filter((e) => e.kind === "usage"),
        JSON.stringify(usage),
      ).toEqual([]);
      expect(adapter().extractResult(events, EXIT_OK), JSON.stringify(usage)).toMatchObject({ ok: true });
    }
    const zero = parse([line({ ...END, usage: { input_tokens: 0, output_tokens: 0 }, num_turns: 0 })]).events;
    expect(zero.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { input_tokens: 0, output_tokens: 0, num_turns: 0 } },
    ]);
  });

  it("resume and compile agree on where the bypass approval comes from: profile, request, both or neither", () => {
    const a = adapter();
    const binding = { provider: "grok" as const, nativeSessionId: SID };
    for (const [onProfile, onRequest] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const profile = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: onProfile };
      const request = { ...req, bypassApproved: onRequest };
      const first = a.compile(request, profile);
      const resumed = a.resumeArgs(binding, request, profile);
      const label = `profile=${onProfile} request=${onRequest}`;
      if ("ineligible" in first) {
        expect(onProfile || onRequest, label).toBe(false);
        expect(first, label).toEqual({
          ineligible: true,
          reason: "PROFILE_UNSUPPORTED",
          detail: GROK_BYPASS_NOT_APPROVED,
        });
        expect(resumed, label).toEqual(first);
      } else {
        expect(onProfile || onRequest, label).toBe(true);
        expect(resumed, label).toEqual({ ...first, argv: [...first.argv, "-r", SID] });
      }
    }
  });
});

describe("grok parser residuals, fifth pass: post-end tool lines, prototype values and exit codes (T4.23, synthetic lines; parser unchanged)", () => {
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
  const bound = (events: readonly { kind: string }[]) => events.filter((e) => e.kind === "session_bound");

  it("pins the gap: an unreadable tool_call_update after `end` is a counted unknown that leaves the turn clean", () => {
    // The order check keys on `tool_call` events and unknown `tool_call` lines; an unknown `tool_call_update` is neither.
    for (const update of [{ type: "tool_call_update" }, { type: "tool_call_update", input: { command: 7 } }]) {
      const { events } = parse([line(END), line(update)]);
      expect(events.at(-1), JSON.stringify(update)).toEqual({ kind: "unknown", rawType: "tool_call_update" });
      expect(adapter().extractResult(events, EXIT_OK), JSON.stringify(update)).toEqual({
        ok: true,
        unknownEventCount: 1,
        nativeSessionId: SID,
      });
    }
    // The same bare line typed `tool_call` fails the run, so the asymmetry is the rawType alone.
    const call = parse([line(END), line({ type: "tool_call" })]).events;
    expect(adapter().extractResult(call, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("fixture trailing_bare_update replays an unreadable update after end_turn at exit 0 to success (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("trailing_bare_update"),
      request: {
        runId: "run_grok_t423_residual",
        objective: "synthetic grok objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, unknownEventCount: 1, summary: "Done." });
  });

  it("pins the gap: an update after `end` that repeats a reported call is deduplicated, so the order check sees nothing", () => {
    const before = line({ type: "tool_call", id: "t1", input: { command: "ls" } });
    const repeat = line({ type: "tool_call_update", id: "t1", input: { command: "ls" } });
    const { events } = parse([before, line(END), repeat]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([shell("ls")]);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });
    // A swapped command on the same call after `end` is reported, so it trips the check (and reaches the guard).
    const swapped = line({ type: "tool_call_update", id: "t1", input: { command: "git push origin main" } });
    expect(adapter().extractResult(parse([before, line(END), swapped]).events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the end line",
    });
    expect(adapter().extractResult(guarded([before, line(END), swapped]), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("the trailing-tool detail replaces a two-`end` detail: the code is the same, the first cause is not named", () => {
    const tool = line({ type: "tool_call", input: { command: "ls" } });
    const twoEnds = parse([line(END), line(END)]).events;
    expect(adapter().extractResult(twoEnds, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one end line",
    });
    expect(adapter().extractResult(parse([line(END), line(END), tool]).events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the end line",
    });
    // A tool call between the two `end` lines is before the final result, so the two-`end` detail stands.
    expect(adapter().extractResult(parse([line(END), tool, line(END)]).events, EXIT_OK)).toMatchObject({
      failureDetail: "protocol: more than one end line",
    });
  });

  it("a prototype-named model or backing provider shadows its fallback key and binds none (as an empty one)", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const { events } = parse([
        line({ ...END, model: name, model_id: "grok-fallback", backing_provider: name, backingProvider: "backing-x" }),
      ]);
      expect(bound(events), name).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    }
  });

  it("modelUsage skips prototype-named keys and binds the first ordinary own key", () => {
    const { events } = parse([line({ ...END, modelUsage: { constructor: {}, toString: {}, "grok-4.7-build": {} } })]);
    expect(bound(events)).toEqual([{ kind: "session_bound", nativeSessionId: SID, model: "grok-4.7-build" }]);
    const only = parse([line({ ...END, modelUsage: { constructor: {}, valueOf: {} } })]).events;
    expect(bound(only)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
  });

  it("a command is never clipped (a target is), so a Git write at the end of a long command still reaches the guard", () => {
    const command = `echo ${"x".repeat(5_000)} && git push origin main`;
    const call = line({ type: "tool_call", input: { command } });
    expect(parse([call]).events).toEqual([shell(command)]);
    expect(adapter().extractResult(guarded([call, line(END)]), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("a caller id equal to a generated key shares that call: the same command is deduplicated, a new one reported", () => {
    const { events } = parse([
      line({ type: "tool_call", input: { command: "git status" } }),
      line({ type: "tool_call_update", id: "call_1", input: { command: "git status" } }),
      line({ type: "tool_call_update", id: "call_1", input: { command: "git push origin main" } }),
    ]);
    // Never under-reports: the guard saw the first command once and sees the new one.
    expect(events).toEqual([shell("git status"), shell("git push origin main")]);
  });

  it("usage is read from its recorded place only: num_turns inside usage and counters beside it are dropped", () => {
    const { events } = parse([
      line({ ...END, usage: { num_turns: 4, input_tokens: 1.5, requestId: 3 }, output_tokens: 9, total_tokens: 9 }),
    ]);
    // A fractional count is finite and non-negative, so it is recorded as reported (no integer check).
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { input_tokens: 1.5 } },
    ]);
  });

  it("extractResult honours the compiled expected exit codes rather than a hard-coded 0", () => {
    const { events } = parse([line(END)]);
    expect(adapter().extractResult(events, { ...EXIT_OK, exitCode: 2, expectedExitCodes: [0, 2] })).toMatchObject({
      ok: true,
    });
    expect(adapter().extractResult(events, { ...EXIT_OK, expectedExitCodes: [2] })).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 0",
    });
    expect(adapter().extractResult(events, { ...EXIT_OK, exitCode: null })).toMatchObject({ ok: false });
  });
});
