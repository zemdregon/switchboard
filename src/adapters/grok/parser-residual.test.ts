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
 * Sixth pass: a non-object `input` that does not shadow `parameters` (replayed end to end), a shell command carried
 * only in a target (gap closed 2026-10-15: a shell target is never clipped and a nameless target-only update on a shell
 * call stays `shell`), empty `tool` and `id` values that shadow their fallback keys (pinned gaps), a
 * target dropped beside a command, duplicate JSON keys, exact-case line types, empty text and a byte-order mark.
 * Seventh pass (T4.6, FR-ADP-10): `backing_provider` over `backingProvider` (a non-string falls through), model and
 * vendor bound independently and verbatim (clipped past 128), lost with an `end` that binds nothing (pinned gap) and
 * never amended, a resumed run carrying both (replayed end to end); after #458, a call opened `shell` by its command
 * stays `shell`, a target-only call under another tool name is a `read` (pinned gap), a `read` renamed
 * `run_terminal_command` with the same target is deduplicated (pinned gap), and the transient command is stripped.
 * Eighth pass: target-field guard interactions (an earlier target key shadows a Git write in a later one, replayed end
 * to end, and an empty command hides a shell target from the guard: pinned gaps; a deduplicated rename never marks the
 * call `shell`: pinned gap), tool and unknown lines after `end` (a stopReason-less `end` after a good one is a plain
 * unknown: pinned gap, replayed end to end), and resume argv parity (a `-r` inside the prompt, a non-writable
 * workspace, and a failed run's bound id).
 * Ninth pass: fail-closed order after `end` (a repeated `tool_call` with the same id and command is deduplicated, replayed
 * end to end, and a parameter-less rename is silent: pinned gaps; a name-only call, an `error` line of any shape and a
 * third `end` still fail the run, and the guard outranks both anomalies), hostile token shapes (`__proto__` keys
 * never forge a field, `-0` and the largest double are recorded, clips split a surrogate pair: pinned), and the resume
 * round trip (the returned id compiles back, binding model and vendor ignored, a newline-split prompt stays one word).
 * Tenth pass: fail-closed order after `end` (the order check needs a counted `end`; its detail replaces an unsafe-id
 * anomaly, replayed end to end: pinned gap; it never replaces a supervisor outcome or an unexpected exit; a native-login
 * read after `end` is failed by the order check in a bypass run and by the guard otherwise; a Git write after a line
 * break in the command is blocked), hostile token shapes (prototype-named call ids, clipped stopReason and error
 * details, non-ASCII and control code points in a session id), and resume argv parity (flag-value ids, empty objective).
 * Eleventh pass: fail-closed order after `end` (the trailing-tool detail replaces a supervisor protocol_error or
 * internal_error detail, replayed end to end: pinned gap; a failed stopReason keeps TOOL_FAILURE; silent line types
 * carrying tool-shaped fields emit nothing; end counts and call keys are per ParseState), hostile token shapes (session
 * ids named after Object.prototype members), and resume argv parity (pure on frozen inputs, delimiter-ended ids).
 * Twelfth pass: the unsupported ACP input boundary (object messages ignored, serialized messages unknown, native
 * top-level types still dispatched), opaque text, raw target deduplication before clipping, exact call-id strings,
 * JSON object key ordering for modelUsage, and pre-seeded session state. Synthetic behaviour only, not a capture.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runConformanceCase } from "../conformance.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { guardEvent, type ToolGuardContext } from "../tool-guard.js";
import type { ParseState } from "../types.js";
import { GROK_BYPASS_NOT_APPROVED, GROK_ENV_ALLOWLIST, GrokAdapter } from "./adapter.js";
import {
  BYPASS_SCOPE,
  DEFAULT_SESSION_ID,
  fixturePath,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";

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

  it("a target added to a call already reported with a command is reported again, guarded as that shell call's command", () => {
    const { events } = parse([
      line({ type: "tool_call", id: "t1", tool: "edit_file", input: { command: "cat x" } }),
      line({ type: "tool_call_update", id: "t1", tool: "edit_file", input: { path: ".git/config" } }),
    ]);
    expect(events).toEqual([
      { kind: "tool_call", tool: "shell", name: "edit_file", command: "cat x" },
      // The call is a shell call, so a target-only update is its command line for the guard (2026-10-15).
      { kind: "tool_call", tool: "shell", name: "edit_file", command: ".git/config", target: ".git/config" },
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
    // The target is also the guard's transient command, which guardEvent strips before the event is kept.
    expect(events).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_terminal_command", command: "/w/a", target: "/w/a" },
    ]);
    expect(events.map((e) => guardEvent(e, { cwd: "/w", bypass: true }))).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_terminal_command", target: "/w/a" },
    ]);
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

describe("grok parser residuals, sixth pass: parameter shapes, shadowing keys and line framing (T4.23, synthetic lines; target-only shell gap closed in the parser)", () => {
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => parse(lines).events.map((e) => guardEvent(e, ctx));

  it("a non-object `input` does not shadow `parameters`: the Git write there is read and guarded", () => {
    // Contrast the second pass: only an object `input` without a command hides the later parameter keys.
    for (const input of [["ignored"], "git status", 7, null]) {
      const call = line({ type: "tool_call", input, parameters: { command: "git push origin main" } });
      expect(parse([call]).events, JSON.stringify(input)).toEqual([shell("git push origin main")]);
      expect(adapter().extractResult(guarded([call, line(END)]), EXIT_OK), JSON.stringify(input)).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });
    }
  });

  it("fixture array_input_parameters replays a Git write behind an array `input` to PERMISSION_BLOCKED", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("array_input_parameters"),
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

  it("a shell command carried only in a target reaches the guard whole, so a Git write past the 512-character clip is blocked at exit 0 and 1", () => {
    const asTarget = (path: string) => line({ type: "tool_call", name: "run_terminal_command", input: { path } });
    // The guard reads a shell call's `target` when it has no `command`, so a short Git write is blocked.
    expect(adapter().extractResult(guarded([asTarget("git push origin main"), line(END)]), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
    // Closed gap (#449, #451): the guard read the clipped target, so a Git write past the clip was lost.
    const long = `echo ${"x".repeat(600)} && git push origin main`;
    const [ev] = parse([asTarget(long)]).events;
    // The guard gets the whole line as the transient command; the kept target is still clipped.
    expect(ev).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "run_terminal_command",
      command: long,
      target: `${long.slice(0, 512)}…`,
    });
    for (const exitCode of [0, 1]) {
      expect(adapter().extractResult(guarded([asTarget(long), line(END)]), { ...EXIT_OK, exitCode })).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });
    }
    // A file tool's target is still clipped.
    const read = parse([line({ type: "tool_call", tool: "read_file", input: { path: long } })]).events[0];
    expect(read).toMatchObject({ tool: "read", target: `${long.slice(0, 512)}…` });
  });

  it("a target-only update without a name on a shell call stays `shell`, so its Git write is blocked at exit 0 and 1", () => {
    const lines = [
      line({ type: "tool_call", id: "c1", name: "run_terminal_command", input: { path: "." } }),
      line({ type: "tool_call_update", id: "c1", input: { path: `echo ${"x".repeat(600)} && git push origin main` } }),
      line(END),
    ];
    // Before the fix the update was a `read` event, so the guard checked the command line as a path only.
    expect(parse(lines).events[1]).toMatchObject({ kind: "tool_call", tool: "shell" });
    for (const exitCode of [0, 1]) {
      expect(adapter().extractResult(guarded(lines), { ...EXIT_OK, exitCode })).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });
    }
    // Outside bypass the provider-state check still sees a path in that update, read as a command word.
    const cred = parse([
      line({ type: "tool_call", id: "c1", name: "run_terminal_command", input: { path: "." } }),
      line({ type: "tool_call_update", id: "c1", input: { path: "~/.grok/auth.json" } }),
    ]).events.map((e) => guardEvent(e, { cwd: "/w", home: "/h", bypass: false }));
    expect(cred[1]).toMatchObject({ tool: "shell", violation: { kind: "provider_state" } });
    // Positive control: without the shell opener the same update is a file target, read but not a command.
    const fileOnly = parse([line({ type: "tool_call_update", id: "c2", input: { path: "/w/a" } })]).events;
    expect(fileOnly).toEqual([{ kind: "tool_call", tool: "read", name: "run_terminal_command", target: "/w/a" }]);
  });

  it("pins the gap: an empty `tool` shadows `name` and `tool_name`, so a named call is mislabelled or unknown", () => {
    const withTarget = parse([line({ type: "tool_call", tool: "", name: "edit_file", input: { path: "/w/a" } })]);
    expect(withTarget.events).toEqual([
      { kind: "tool_call", tool: "read", name: "run_terminal_command", target: "/w/a" },
    ]);
    const nameOnly = parse([line({ type: "tool_call", tool: "", name: "web_fetch", tool_name: "web_fetch" })]);
    expect(nameOnly.events).toEqual([{ kind: "unknown", rawType: "tool_call" }]);
    expect(nameOnly.state.unknownEvents).toBe(1);
    // A non-string `tool` is not a string, so it falls through to `name`.
    expect(parse([line({ type: "tool_call", tool: 7, name: "web_fetch" })]).events).toEqual([
      { kind: "tool_call", tool: "other", name: "web_fetch" },
    ]);
  });

  it("pins the gap: an empty `id` shadows `call_id`, so a later update on that call_id is a new call (over-reports)", () => {
    const { events } = parse([
      line({ type: "tool_call", id: "", call_id: "c1", input: { command: "git status" } }),
      line({ type: "tool_call_update", call_id: "c1", input: { command: "git status" } }),
    ]);
    expect(events).toEqual([shell("git status"), shell("git status")]);
    // A non-string `id` falls through to `call_id`, so the same update is deduplicated.
    const typed = parse([
      line({ type: "tool_call", id: 7, call_id: "c1", input: { command: "git status" } }),
      line({ type: "tool_call_update", call_id: "c1", input: { command: "git status" } }),
    ]);
    expect(typed.events).toEqual([shell("git status")]);
  });

  it("a target beside a command is never reported, and a later update with only a new target on that call is", () => {
    const { events } = parse([
      line({ type: "tool_call", id: "t1", input: { command: "cat a", path: "/w/a" } }),
      line({ type: "tool_call_update", id: "t1", input: { command: "cat a", path: "/w/b" } }),
      line({ type: "tool_call_update", id: "t1", input: { path: "/w/b" } }),
    ]);
    // The dedup key is the command when there is one, so the second line (same command, new path) emits nothing.
    expect(events).toEqual([
      shell("cat a"),
      { kind: "tool_call", tool: "shell", name: "run_terminal_command", command: "/w/b", target: "/w/b" },
    ]);
  });

  it("an empty-string target is a target: it shadows later target keys and the call is a `read` with an empty target", () => {
    const { events, state } = parse([
      line({ type: "tool_call", input: { path: "", filePath: "/w/a" }, target: "/w/b" }),
    ]);
    expect(events).toEqual([{ kind: "tool_call", tool: "read", name: "run_terminal_command", target: "" }]);
    expect(state.unknownEvents).toBe(0);
  });

  it("duplicate JSON keys resolve to the last one (JSON.parse), so a leading `type` cannot forge or hide an `end`", () => {
    const hidden = parse([`{"type":"end","stopReason":"end_turn","sessionId":"${SID}","type":"text","data":"x"}`]);
    expect(hidden.events).toEqual([{ kind: "message", role: "assistant", text: "x" }]);
    expect(hidden.state.nativeSessionId).toBeUndefined();
    const real = parse([`{"type":"text","data":"x","type":"end","stopReason":"end_turn","sessionId":"${SID}"}`]);
    expect(real.events).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "result", ok: true },
    ]);
    const forged = parse([`{"type":"end","stopReason":"end_turn","stopReason":"cancelled","sessionId":"${SID}"}`]);
    expect(adapter().extractResult(forged.events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  it("line types match exactly: a case or whitespace variant of `end` or `tool_call` is an unknown, never a result", () => {
    const variants = ["End", "END", " end", "end ", "Tool_call", "TOOL_CALL", "tool-call", "toolCall"];
    const { events, state } = parse(
      variants.map((type) => line({ ...END, type, input: { command: "git push origin main" } })),
    );
    expect(events).toEqual(variants.map((rawType) => ({ kind: "unknown", rawType })));
    expect(state).toEqual({ lines: variants.length, unknownEvents: variants.length });
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("an empty text chunk is a message, never unknown, and leaves the summary absent on a clean turn", () => {
    const { events, state } = parse([line({ type: "text", data: "" }), line(END)]);
    expect(events[0]).toEqual({ kind: "message", role: "assistant", text: "" });
    expect(state.unknownEvents).toBe(0);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: SID });
  });

  it("a byte-order mark before a line is unparseable framing: counted as a line, emitting nothing, never unknown", () => {
    const { events, state } = parse([`﻿${line(END)}`]);
    expect(events).toEqual([]);
    expect(state).toEqual({ lines: 1, unknownEvents: 0 });
    // With no result the parser alone can never report success; the supervisor ends such a run OUTPUT_PROTOCOL_ERROR.
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });
});

describe("grok parser residuals, seventh pass: backingProvider and model parity, shell-kind edges after #458 (T4.23, T4.6, FR-ADP-10; synthetic lines; parser unchanged)", () => {
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
  const bound = (lines: (string | object)[]) => parse(lines).events.filter((e) => e.kind === "session_bound");

  it("backing_provider outranks backingProvider; a non-string one falls through (unlike Cursor's pinned asymmetry)", () => {
    expect(bound([line({ ...END, backing_provider: "snake", backingProvider: "camel" })])).toEqual([
      { kind: "session_bound", nativeSessionId: SID, backingProvider: "snake" },
    ]);
    // `str()` drops a non-string before `??`, so every non-string value falls through to the camel-case key.
    for (const raw of [null, 0, 7, false, true, {}, ["x"]]) {
      expect(bound([line({ ...END, backing_provider: raw, backingProvider: "camel" })]), JSON.stringify(raw)).toEqual([
        { kind: "session_bound", nativeSessionId: SID, backingProvider: "camel" },
      ]);
    }
    // Neither key a string: no vendor, and the binding itself still happens.
    expect(bound([line({ ...END, backing_provider: 1, backingProvider: 2 })])).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
    ]);
  });

  it("model and backingProvider are independent: either binds without the other, and neither is ever defaulted", () => {
    expect(bound([line({ ...END, model: "grok-4.7-build" })])).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "grok-4.7-build" },
    ]);
    expect(bound([line({ ...END, backingProvider: "backing-x" })])).toEqual([
      { kind: "session_bound", nativeSessionId: SID, backingProvider: "backing-x" },
    ]);
    // Neither is ever inferred from the harness: no "grok" vendor, no model from `requestId` or `usage`.
    expect(bound([line({ ...END, requestId: "req_1" })])).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
  });

  it("model and backingProvider are bound verbatim: no trim, no case folding, the harness name kept, 128 characters unclipped", () => {
    for (const value of [" grok-4.7-build ", "Grok-4.7-BUILD", "grok", "\t", "a".repeat(128)]) {
      expect(bound([line({ ...END, model: value, backing_provider: value })]), JSON.stringify(value)).toEqual([
        { kind: "session_bound", nativeSessionId: SID, model: value, backingProvider: value },
      ]);
    }
    const long = "b".repeat(129);
    expect(bound([line({ ...END, model: long, backing_provider: long })])).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: `${"b".repeat(128)}…`,
        backingProvider: `${"b".repeat(128)}…`,
      },
    ]);
  });

  it("pins the gap: an `end` that binds nothing loses its model and vendor, so only a later binding `end` supplies them", () => {
    for (const sessionId of ["", "-r", 7, undefined]) {
      const first = { ...END, sessionId, model: "first-model", backing_provider: "first-vendor" };
      expect(bound([line(first)]), JSON.stringify(sessionId)).toEqual([]);
      // The second `end` is a protocol error, but its vendor is the only one bound (as its id, fourth pass).
      const both = parse([line(first), line({ ...END, backing_provider: "second-vendor" })]);
      expect(both.events.filter((e) => e.kind === "session_bound")).toEqual([
        { kind: "session_bound", nativeSessionId: SID, backingProvider: "second-vendor" },
      ]);
      expect(adapter().extractResult(both.events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: SID,
      });
    }
  });

  it("the first binding is final for the vendor too: a later `end` with the same id never amends or adds one", () => {
    const { events } = parse([
      line({ ...END, backing_provider: "first-vendor" }),
      line({ ...END, backing_provider: "second-vendor", model: "late-model" }),
    ]);
    expect(events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: SID, backingProvider: "first-vendor" },
    ]);
    // A first binding without a vendor stays without one.
    const late = parse([line(END), line({ ...END, backing_provider: "late-vendor" })]).events;
    expect(late.filter((e) => e.kind === "session_bound")).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
  });

  it("a structured model outranks modelUsage even when the model is also a modelUsage key, and the vendor is unaffected", () => {
    const modelUsage = { "usage-model": { inputTokens: 1 }, "named-model": { inputTokens: 2 } };
    expect(bound([line({ ...END, model: "named-model", modelUsage, backingProvider: "v" })])).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "named-model", backingProvider: "v" },
    ]);
    expect(bound([line({ ...END, model_id: "id-model", modelUsage })])).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "id-model" },
    ]);
  });

  it("fixture resume_backing_provider: `-r <id>` resumes, the same id binds with model and vendor, and the run succeeds", async () => {
    const a = replayAdapter("resume_backing_provider");
    const binding = { provider: "grok" as const, nativeSessionId: RESUMED_SESSION_ID };
    const request = {
      runId: "run_grok_t423_residual",
      objective: "synthetic grok objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
      bypassApproved: true,
    };
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
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: RESUMED_SESSION_ID, unknownEventCount: 0 });
    // The same lines through the parser: the resumed binding carries the modelUsage model and the vendor.
    const lines = readFileSync(fixturePath("resume_backing_provider"), "utf8").split("\n").filter(Boolean).slice(1);
    expect(parse(lines).events.filter((e) => e.kind !== "message")).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: RESUMED_SESSION_ID,
        model: "grok-4.7-build",
        backingProvider: "backing-x",
      },
      {
        kind: "usage",
        source: "provider_reported",
        metrics: { input_tokens: 9, output_tokens: 3, total_tokens: 12, num_turns: 1 },
      },
      { kind: "result", ok: true },
    ]);
  });

  it("a call opened as `shell` by its command stays `shell`: a later target-only update is guarded as a command", () => {
    const open = line({ type: "tool_call", id: "s1", tool: "bash", input: { command: "ls" } });
    const lines = [
      open,
      line({ type: "tool_call_update", id: "s1", tool: "read_file", input: { path: "git push origin main" } }),
      line(END),
    ];
    // The update's own name says `read_file`, but the call is already `shell`: over-guard, never under.
    expect(parse(lines).events[1]).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "read_file",
      command: "git push origin main",
      target: "git push origin main",
    });
    expect(adapter().extractResult(guarded(lines), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
    // The `shell` mark is per call key: another call's target-only update stays a `read`.
    const other = parse([open, line({ type: "tool_call_update", id: "s2", input: { path: "/w/a" } })]).events;
    expect(other[1]).toMatchObject({ tool: "read", target: "/w/a" });
  });

  it("pins the gap: a target-only call named other than run_terminal_command is a `read`, so a Git write there is unguarded", () => {
    // Only `run_terminal_command` (or a command key) makes a call `shell`; the native shell tool name is an Assumption.
    const lines = [line({ type: "tool_call", tool: "bash", input: { path: "git push origin main" } }), line(END)];
    expect(parse(lines).events[0]).toEqual({
      kind: "tool_call",
      tool: "read",
      name: "bash",
      target: "git push origin main",
    });
    expect(adapter().extractResult(guarded(lines), EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
  });

  it("pins the gap: a `read` call later renamed run_terminal_command with the same target is deduplicated, so never guarded", () => {
    const read = line({ type: "tool_call", id: "r1", tool: "read_file", input: { path: "git push origin main" } });
    const rename = { type: "tool_call_update", id: "r1", name: "run_terminal_command" };
    const lines = [read, line({ ...rename, input: { path: "git push origin main" } }), line(END)];
    // The dedup key is `target:<value>` for both lines, whatever the kind, so the rename emits nothing.
    expect(parse(lines).events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "read", name: "read_file", target: "git push origin main" },
    ]);
    expect(adapter().extractResult(guarded(lines), EXIT_OK)).toMatchObject({ ok: true });
    // Positive control: a new target in the renamed update is reported as `shell` and blocked.
    const swapped = [read, line({ ...rename, input: { path: "git push origin dev" } }), line(END)];
    expect(adapter().extractResult(guarded(swapped), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("the transient guard command is stripped by guardEvent; only the clipped target is kept on the event", () => {
    const long = `echo ${"x".repeat(600)} && git push origin main`;
    const [kept] = guarded([line({ type: "tool_call", name: "run_terminal_command", input: { path: long } })]);
    expect(kept).not.toHaveProperty("command");
    expect(kept).toMatchObject({ tool: "shell", target: `${long.slice(0, 512)}…`, violation: { kind: "git_write" } });
    // An empty-string target on a shell call is an empty command: kept, never a violation.
    const [empty] = guarded([line({ type: "tool_call", name: "run_terminal_command", input: { path: "" } })]);
    expect(empty).toEqual({ kind: "tool_call", tool: "shell", name: "run_terminal_command", target: "" });
  });
});

describe("grok parser residuals, eighth pass: target-field guard interactions, trailing unknowns and resume argv parity (T4.23, synthetic lines; parser unchanged)", () => {
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
  const approved = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true };
  const req = {
    runId: "run_grok_t423_residual",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const GIT_WRITE = "git push origin main";

  it("pins the gap: an earlier target key shadows a Git write in a later one, so the guard sees only the first", () => {
    // Target precedence is input.path > filePath > file_path > AbsolutePath > input.target > the same keys top-level.
    for (const call of [
      { input: { path: "ls" }, target: GIT_WRITE },
      { input: { path: "ls", target: GIT_WRITE } },
      { input: { filePath: "ls" }, path: GIT_WRITE },
    ]) {
      const lines = [line({ type: "tool_call", name: "run_terminal_command", ...call }), line(END)];
      const label = JSON.stringify(call);
      expect(parse(lines).events[0], label).toEqual({
        kind: "tool_call",
        tool: "shell",
        name: "run_terminal_command",
        command: "ls",
        target: "ls",
      });
      expect(adapter().extractResult(guarded(lines), EXIT_OK), label).toEqual({
        ok: true,
        unknownEventCount: 0,
        nativeSessionId: SID,
      });
    }
    // Positive controls: a non-string earlier key falls through, and an object `input` with no target key does not
    // hide the top-level one, so the Git write reaches the guard.
    for (const call of [
      { input: { path: 7, filePath: GIT_WRITE } },
      { input: { description: "x" }, target: GIT_WRITE },
    ]) {
      const lines = [line({ type: "tool_call", name: "run_terminal_command", ...call }), line(END)];
      expect(adapter().extractResult(guarded(lines), EXIT_OK), JSON.stringify(call)).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });
    }
  });

  it("fixture shadowed_target replays a Git write behind input.path to end_turn success (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("shadowed_target"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, unknownEventCount: 0, summary: "Listed the files." });
  });

  it("pins the gap: an empty command is the command, so a shell target beside it never reaches the guard", () => {
    const lines = [
      line({ type: "tool_call", name: "run_terminal_command", input: { command: "", path: GIT_WRITE } }),
      line(END),
    ];
    // The target is dropped beside any command (sixth pass), and the empty command is what the guard reads.
    expect(parse(lines).events[0]).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "run_terminal_command",
      command: "",
    });
    expect(adapter().extractResult(guarded(lines), EXIT_OK)).toMatchObject({ ok: true });
    // Positive control: a non-string command is no command, so the target is the guard command and is blocked.
    const typed = [
      line({ type: "tool_call", name: "run_terminal_command", input: { command: 0, path: GIT_WRITE } }),
      line(END),
    ];
    expect(adapter().extractResult(guarded(typed), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("pins the gap: a deduplicated rename to run_terminal_command never marks the call `shell`, so a later target is a `read`", () => {
    const read = line({ type: "tool_call", id: "r1", tool: "read_file", input: { path: "notes.txt" } });
    const later = line({ type: "tool_call_update", id: "r1", input: { path: GIT_WRITE } });
    // The rename repeats the reported target, so it returns before the call is marked `shell` (seventh pass).
    const rename = line({
      type: "tool_call_update",
      id: "r1",
      name: "run_terminal_command",
      input: { path: "notes.txt" },
    });
    const lines = [read, rename, later, line(END)];
    expect(parse(lines).events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "read", name: "read_file", target: "notes.txt" },
      { kind: "tool_call", tool: "read", name: "run_terminal_command", target: GIT_WRITE },
    ]);
    expect(adapter().extractResult(guarded(lines), EXIT_OK)).toMatchObject({ ok: true });
    // Positive control: a rename with a new target is reported as `shell`, which marks the call, so the same nameless
    // update is then guarded as a command.
    const marking = line({ type: "tool_call_update", id: "r1", name: "run_terminal_command", input: { path: "ls" } });
    const marked = [read, marking, later, line(END)];
    expect(
      parse(marked)
        .events.filter((e) => e.kind === "tool_call")
        .at(-1),
    ).toMatchObject({ tool: "shell", command: GIT_WRITE });
    expect(adapter().extractResult(guarded(marked), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("a target-only call after `end` trips the order check as a `read`; as a guarded shell call the guard verdict outranks it", () => {
    const readAfter = parse([line(END), line({ type: "tool_call", tool: "read_file", input: { path: "/w/a" } })]);
    expect(adapter().extractResult(readAfter.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the end line",
    });
    const shellAfter = [
      line(END),
      line({ type: "tool_call", name: "run_terminal_command", input: { path: GIT_WRITE } }),
    ];
    const blocked = adapter().extractResult(guarded(shellAfter), EXIT_OK);
    expect(blocked).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID });
    // The order-check detail is used only under OUTPUT_PROTOCOL_ERROR, so the guard's own detail stands.
    expect(blocked.ok === false && blocked.failureDetail).not.toBe("tool call after the end line");
  });

  it("pins the gap: unreadable lines after `end`, a stopReason-less `end` included, are plain unknowns and the run succeeds", () => {
    const trailing = [
      line({ type: "synthetic_future_event", data: "x" }),
      line({ type: "text" }),
      "[]",
      line({ type: "end", stopReason: null, sessionId: "other-session", usage: { input_tokens: 500 } }),
    ];
    const silent = [
      line({ type: "thought", data: "t" }),
      line({ type: "usage", signature: "s" }),
      line({ type: "available_commands" }),
    ];
    const { events, state } = parse([line(END), ...trailing, ...silent]);
    expect(events.slice(3)).toEqual([
      { kind: "unknown", rawType: "synthetic_future_event" },
      { kind: "unknown", rawType: "text" },
      { kind: "unknown", rawType: "none" },
      { kind: "unknown", rawType: "end" },
    ]);
    // The stopReason-less `end` takes no end slot, so its id neither binds nor raises "session id changed mid-run".
    expect(state).toEqual({ lines: 1 + trailing.length + silent.length, unknownEvents: 4, nativeSessionId: SID });
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 4, nativeSessionId: SID });
    // Contrast: the same line with a string stopReason is a second `end`, so the run fails closed.
    const counted = parse([line(END), line({ type: "end", stopReason: "end_turn", sessionId: "other-session" })]);
    expect(adapter().extractResult(counted.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
  });

  it("fixture trailing_unknowns_after_end replays four unknowns after end_turn at exit 0 to success (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("trailing_unknowns_after_end"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, unknownEventCount: 4, summary: "Done." });
  });

  it("resume appends exactly one `-r <id>` pair: a `-r` inside the prompt stays in the one `--single=` word", () => {
    const a = adapter();
    for (const objective of ["-r other-session", "fix it -r other-session", "--single=x -r y"]) {
      const request = { ...req, objective };
      const first = a.compile(request, approved);
      const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: SID }, request, approved);
      if ("ineligible" in first || "ineligible" in resumed) throw new Error("expected both to compile");
      expect(
        first.argv.filter((w) => w.startsWith("--single")),
        objective,
      ).toEqual([`--single=${objective}`]);
      expect(resumed.argv, objective).toEqual([...first.argv, "-r", SID]);
      expect(
        resumed.argv.filter((w) => w === "-r"),
        objective,
      ).toEqual(["-r"]);
      expect(resumed.policyFlags, objective).toEqual(first.policyFlags);
    }
  });

  it("resume follows the request's writable flag exactly as compile: read-only sandbox, or the same refusal", () => {
    const a = adapter();
    const binding = { provider: "grok" as const, nativeSessionId: SID };
    const readOnlyReq = { ...req, workspace: { cwd: "/w", writable: false } };
    const first = a.compile(readOnlyReq, approved);
    if ("ineligible" in first) throw new Error(first.detail);
    expect(first.policyFlags).toEqual(["--sandbox", "read-only", "--disable-web-search", "--always-approve"]);
    expect(a.resumeArgs(binding, readOnlyReq, approved)).toEqual({ ...first, argv: [...first.argv, "-r", SID] });
    // With network on, a non-writable workspace is refused on both paths with the same detail.
    const networkOn = { ...privilegedProfile({ ...BYPASS_SCOPE, network: { mode: "on" } }), bypassApproved: true };
    const refused = a.compile(readOnlyReq, networkOn);
    expect(refused).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING" });
    expect(a.resumeArgs(binding, readOnlyReq, networkOn)).toEqual(refused);
    // The same scope on a writable workspace compiles, so the refusal is the request's flag alone.
    expect(a.compile(req, networkOn)).toMatchObject({ policyFlags: ["--sandbox", "workspace", "--always-approve"] });
  });

  it("a failed run still returns its first bound id, and resumeArgs compiles it (the adapter does not judge resumability)", () => {
    const { events, state } = parse([line(END), line({ ...END, sessionId: "other-session" })]);
    const result = adapter().extractResult(events, EXIT_OK);
    expect(result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: SID });
    expect(state.nativeSessionId).toBe(SID);
    const resumed = adapter().resumeArgs({ provider: "grok", nativeSessionId: SID }, req, approved);
    if ("ineligible" in resumed) throw new Error(resumed.detail);
    expect(resumed.argv.slice(-2)).toEqual(["-r", SID]);
    // A run whose only `end` id was unsafe returns no id, so there is nothing to resume from it.
    const unsafe = parse([line({ ...END, sessionId: "-r" })]).events;
    expect(adapter().extractResult(unsafe, EXIT_OK)).not.toHaveProperty("nativeSessionId");
  });
});

describe("grok parser residuals, ninth pass: fail-closed order after `end`, resume argv round trip and hostile token shapes (T4.23, synthetic lines; parser unchanged)", () => {
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
  const approved = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true };
  const req = {
    runId: "run_grok_t423_residual",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const call = (o: object) => line({ type: "tool_call", name: "run_terminal_command", ...o });

  it("pins the gap: a repeated `tool_call` (not only an update) with the same id and command after `end` is deduplicated", () => {
    const before = call({ id: "t1", input: { command: "ls" } });
    const { events } = parse([before, line(END), before]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([shell("ls")]);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: SID });
    // Positive controls: the same command under a new id, or id-less (a new generated key), is a new call after `end`.
    for (const late of [call({ id: "t2", input: { command: "ls" } }), call({ input: { command: "ls" } })]) {
      expect(adapter().extractResult(parse([before, line(END), late]).events, EXIT_OK), late).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the end line",
      });
    }
  });

  it("fixture repeat_call_after_end replays a repeated tool_call after end_turn at exit 0 to success (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("repeat_call_after_end"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, unknownEventCount: 0, summary: "Listed the files." });
  });

  it("a name-only tool call after `end` trips the order check as `other`; a name-only update on a reported call does not (gap)", () => {
    const named = parse([line(END), line({ type: "tool_call", tool: "web_fetch" })]).events;
    expect(named.at(-1)).toEqual({ kind: "tool_call", tool: "other", name: "web_fetch" });
    expect(adapter().extractResult(named, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the end line",
    });
    // An update naming an unseen call is reported, so it trips the check too.
    const unseen = parse([line(END), line({ type: "tool_call_update", id: "t9", tool: "web_fetch" })]).events;
    expect(adapter().extractResult(unseen, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    // Pinned gap: a parameter-less update on a call reported before `end` emits nothing, whatever name it carries.
    const before = call({ id: "t1", input: { command: "ls" } });
    const renamed = parse([before, line(END), line({ type: "tool_call_update", id: "t1", tool: "web_fetch" })]).events;
    expect(renamed.filter((e) => e.kind === "tool_call")).toEqual([shell("ls")]);
    expect(adapter().extractResult(renamed, EXIT_OK)).toMatchObject({ ok: true });
  });

  it("an `error` line after a clean `end` fails the run whatever its shape, with its own category's code", () => {
    for (const [error, code] of [
      [{ type: "error", message: "Not signed in. synthetic" }, "AUTH_REQUIRED"],
      [{ type: "error", message: "Couldn't set model synthetic-x" }, "MODEL_UNAVAILABLE"],
      // Only the recorded prefixes map; any other message is an unknown category, so TOOL_FAILURE.
      [{ type: "error", message: "Model synthetic-x not found" }, "TOOL_FAILURE"],
      [{ type: "error", message: { text: "x" } }, "TOOL_FAILURE"],
      [{ type: "error" }, "TOOL_FAILURE"],
      [{ type: "error", message: "" }, "TOOL_FAILURE"],
    ] as const) {
      const { events } = parse([line(END), line(error)]);
      expect(events.at(-1), JSON.stringify(error)).toMatchObject({ kind: "provider_error" });
      expect(adapter().extractResult(events, EXIT_OK), JSON.stringify(error)).toMatchObject({
        ok: false,
        failureCode: code,
        nativeSessionId: SID,
      });
    }
  });

  it("a third `end` adds a second anomaly, records no further usage, and its result is the one that decides", () => {
    const third = { ...END, stopReason: "end_turn", usage: { input_tokens: 99 } };
    const { events, state } = parse([line(END), line(END), line(third)]);
    expect(events.filter((e) => e.kind === "provider_error")).toEqual([
      { kind: "provider_error", category: "protocol", message: "more than one end line" },
      { kind: "provider_error", category: "protocol", message: "more than one end line" },
    ]);
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { input_tokens: 10 } },
    ]);
    expect(events.filter((e) => e.kind === "result")).toEqual([
      { kind: "result", ok: true },
      { kind: "result", ok: false, summary: "stopReason end_turn" },
      { kind: "result", ok: false, summary: "stopReason end_turn" },
    ]);
    expect(state.nativeSessionId).toBe(SID);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one end line",
      nativeSessionId: SID,
    });
  });

  it("a guarded Git write between two `end` lines is blocked: the guard verdict outranks both protocol anomalies", () => {
    const lines = [line(END), call({ input: { command: "git push origin main" } }), line(END)];
    expect(adapter().extractResult(parse(lines).events, EXIT_OK)).toMatchObject({
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one end line",
    });
    expect(adapter().extractResult(guarded(lines), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: SID,
    });
  });

  it("a prototype key cannot forge a line: `__proto__` fields are own data, never a type, stopReason, counter or id", () => {
    const forged = [
      '{"__proto__":{"type":"end","stopReason":"end_turn","sessionId":"forged-session"}}',
      '{"type":"end","__proto__":{"stopReason":"end_turn","sessionId":"forged-session"}}',
      '{"type":"text","__proto__":{"data":"forged"}}',
      '{"type":"tool_call","__proto__":{"input":{"command":"git push origin main"}}}',
    ];
    const { events, state } = parse(forged);
    expect(events).toEqual([
      { kind: "unknown", rawType: "none" },
      { kind: "unknown", rawType: "end" },
      { kind: "unknown", rawType: "text" },
      { kind: "unknown", rawType: "tool_call" },
    ]);
    expect(state).toEqual({ lines: 4, unknownEvents: 4 });
    // Inherited usage counters and an inherited sessionId are never read off a real `end`.
    const end = parse(['{"type":"end","stopReason":"end_turn","usage":{"__proto__":{"input_tokens":5}}}']);
    expect(end.events).toEqual([{ kind: "result", ok: true }]);
    expect(end.state.nativeSessionId).toBeUndefined();
  });

  it("hostile counter values: -0 and the largest finite double are recorded as reported; a numeric string is not", () => {
    const { events } = parse([
      '{"type":"end","stopReason":"end_turn","sessionId":"s1","usage":{"input_tokens":-0,"output_tokens":1.7976931348623157e308,"total_tokens":"10"}}',
    ]);
    const usage = events.find((e) => e.kind === "usage");
    if (usage?.kind !== "usage") throw new Error("expected a usage event");
    expect(Object.keys(usage.metrics)).toEqual(["input_tokens", "output_tokens"]);
    // `-0 >= 0`, so negative zero passes the counter check unchanged (no normalisation to 0).
    expect(Object.is(usage.metrics.input_tokens, -0)).toBe(true);
    expect(usage.metrics.output_tokens).toBe(Number.MAX_VALUE);
  });

  it("clips are by UTF-16 code unit, so a surrogate pair at the cut of a rawType or tool name is split (pinned)", () => {
    const astral = "\u{1F600}";
    const type = `${"t".repeat(63)}${astral}`;
    const name = `${"n".repeat(63)}${astral}`;
    const { events } = parse([line({ type }), line({ type: "tool_call", tool: name })]);
    expect(events).toEqual([
      { kind: "unknown", rawType: `${"t".repeat(63)}\uD83D…` },
      { kind: "tool_call", tool: "other", name: `${"n".repeat(63)}\uD83D…` },
    ]);
    // Control characters in a tool name are kept verbatim within the clip (no filtering in the parser).
    const ctl = parse([line({ type: "tool_call", tool: "a\u0000b\u001b[31m" })]).events;
    expect(ctl).toEqual([{ kind: "tool_call", tool: "other", name: "a\u0000b\u001b[31m" }]);
  });

  it("resume round trip: the id extractResult returns compiles to the same argv as compile plus one `-r <id>` pair", () => {
    const a = adapter();
    const first = a.compile(req, approved);
    if ("ineligible" in first) throw new Error(first.detail);
    for (const id of ["a".repeat(256), "0", "A:B.c_d-e", DEFAULT_SESSION_ID]) {
      const { events } = parse([line({ ...END, sessionId: id })]);
      const result = a.extractResult(events, EXIT_OK);
      expect(result.nativeSessionId, id).toBe(id);
      const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: result.nativeSessionId ?? "" }, req, approved);
      expect(resumed, id).toEqual({ ...first, argv: [...first.argv, "-r", id] });
    }
  });

  it("resume ignores the binding's model and vendor (no `-m`) and returns an env allowlist independent of the export", () => {
    const a = adapter();
    const plain = a.resumeArgs({ provider: "grok", nativeSessionId: SID }, req, approved);
    const rich = a.resumeArgs(
      { provider: "grok", nativeSessionId: SID, model: "grok-4.7-build", backingProvider: "xai" } as never,
      req,
      approved,
    );
    if ("ineligible" in plain || "ineligible" in rich) throw new Error("expected both to compile");
    expect(rich).toEqual(plain);
    expect(rich.argv).not.toContain("-m");
    expect(rich.argv.some((w) => w.includes("grok-4.7-build") || w === "xai")).toBe(false);
    rich.envAllowlist.push("XAI_API_KEY");
    rich.policyFlags.length = 0;
    expect(GROK_ENV_ALLOWLIST).toEqual(["PATH", "HOME"]);
    const again = a.resumeArgs({ provider: "grok", nativeSessionId: SID }, req, approved);
    expect(again).toEqual(plain);
  });

  it("a newline-split objective stays in the one `--single=` word on resume: a `-r` after the newline is not a flag", () => {
    const a = adapter();
    const objective = "fix it\n-r other-session\n--always-approve";
    const request = { ...req, objective };
    const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: SID }, request, approved);
    if ("ineligible" in resumed) throw new Error(resumed.detail);
    expect(resumed.argv.filter((w) => w.startsWith("--single"))).toEqual([`--single=${objective}`]);
    expect(resumed.argv.filter((w) => w === "-r" || w === "--always-approve")).toEqual(["--always-approve", "-r"]);
    expect(resumed.argv.slice(-2)).toEqual(["-r", SID]);
  });
});

describe("grok parser residuals, tenth pass: fail-closed order after `end`, resume argv parity and hostile token shapes (T4.23, synthetic lines; parser unchanged)", () => {
  const bypassCtx: ToolGuardContext = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[], ctx = bypassCtx) => parse(lines).events.map((e) => guardEvent(e, ctx));
  const approved = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true };
  const req = {
    runId: "run_grok_t423_residual",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const call = (o: object) => line({ type: "tool_call", name: "run_terminal_command", ...o });
  const LS = call({ id: "t1", input: { command: "ls" } });

  it("the order check needs a counted `end`: a tool call after an `end` with a non-string stopReason is `no result event`", () => {
    for (const stopReason of [7, null, { reason: "end_turn" }, ["end_turn"]]) {
      const { events, state } = parse([line({ ...END, stopReason }), LS]);
      const label = JSON.stringify(stopReason);
      // The uncounted `end` is an unknown, so it binds no id and the tool call has no result before it.
      expect(state, label).toEqual({ lines: 2, unknownEvents: 1 });
      expect(adapter().extractResult(events, EXIT_OK), label).toEqual({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "no result event",
        unknownEventCount: 1,
      });
    }
    // Contrast: an uncounted `end` after a counted one leaves the counted result in place, so the order check fires.
    const after = parse([line(END), line({ ...END, stopReason: 7 }), LS]).events;
    expect(adapter().extractResult(after, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the end line",
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
  });

  it("pins the gap: the trailing-tool detail replaces an unsafe session-id anomaly, and no id is returned either way", () => {
    const unsafe = line({ ...END, sessionId: "-r" });
    expect(adapter().extractResult(parse([unsafe]).events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id is not a safe argument",
      unknownEventCount: 0,
    });
    expect(adapter().extractResult(parse([unsafe, LS]).events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the end line",
      unknownEventCount: 0,
    });
  });

  it("fixture unsafe_id_then_tool replays an unsafe-id end_turn and a later tool call to OUTPUT_PROTOCOL_ERROR (gap)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("unsafe_id_then_tool"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the end line",
        nativeSessionId: null,
      },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, unknownEventCount: 0, summary: "Listed the files." });
    expect(report.result).not.toHaveProperty("nativeSessionId");
  });

  it("the trailing-tool detail is used only under OUTPUT_PROTOCOL_ERROR: supervisor outcomes and unexpected exits keep theirs", () => {
    const events = parse([line(END), LS]).events;
    for (const [exit, code, detail] of [
      [{ ...EXIT_OK, outcome: "cancelled" }, "CANCELLED", "run cancelled"],
      [{ ...EXIT_OK, outcome: "timeout", timeoutKind: "idle" }, "PROCESS_TIMEOUT", "idle timeout"],
      [{ ...EXIT_OK, outcome: "crashed", exitCode: null, signal: "SIGKILL" }, "PROCESS_CRASH", "signal SIGKILL"],
      [{ ...EXIT_OK, exitCode: 1 }, "TOOL_FAILURE", "exit code 1"],
      // An exit code the invocation expects is clean, so the order check decides.
      [{ ...EXIT_OK, exitCode: 3, expectedExitCodes: [0, 3] }, "OUTPUT_PROTOCOL_ERROR", "tool call after the end line"],
    ] as const) {
      expect(adapter().extractResult(events, exit as never), JSON.stringify(exit)).toEqual({
        ok: false,
        failureCode: code,
        failureDetail: detail,
        unknownEventCount: 0,
        nativeSessionId: SID,
      });
    }
  });

  it("a read of the native login path after `end` is failed by the order check in a bypass run, by the guard otherwise", () => {
    const cred = line({ type: "tool_call", tool: "read_file", input: { path: "~/.grok/auth.json" } });
    const lines = [line(END), cred];
    // Owner decision 25: the provider-state check is not enforced in an approved bypass run (tool-guard.ts), and
    // Grok Build compiles only bypass runs, so the order check is what fails this one.
    const bypass = guarded(lines);
    expect(bypass.at(-1)).toEqual({ kind: "tool_call", tool: "read", name: "read_file", target: "~/.grok/auth.json" });
    expect(adapter().extractResult(bypass, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the end line",
    });
    // Before `end` the same read leaves a bypass turn clean (pinned: nothing else in the parser looks at the path).
    expect(adapter().extractResult(guarded([cred, line(END)]), EXIT_OK)).toMatchObject({ ok: true });
    // Outside bypass the guard verdict outranks the order check.
    const strict = guarded(lines, { cwd: "/w", home: "/home/u", bypass: false });
    expect(adapter().extractResult(strict, EXIT_OK)).toMatchObject({ ok: false, failureCode: "SANDBOX_VIOLATION" });
  });

  it("hostile call ids (`__proto__`, `constructor`, `toString`, `hasOwnProperty`) are plain correlation keys", () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const opened = call({ id, input: { command: "ls" } });
      const update = (command: string) => line({ type: "tool_call_update", id, input: { command } });
      // The same command on an update or a repeated tool_call is deduplicated (ninth-pass gap), with no throw.
      const { events } = parse([opened, update("ls"), line(END), opened]);
      expect(
        events.filter((e) => e.kind === "tool_call"),
        id,
      ).toEqual([shell("ls")]);
      expect(adapter().extractResult(events, EXIT_OK), id).toMatchObject({ ok: true });
      // A new command on the same id after `end` is reported, so the order check fires.
      const late = parse([opened, line(END), update("pwd")]).events;
      expect(late.at(-1), id).toEqual(shell("pwd"));
      expect(adapter().extractResult(late, EXIT_OK), id).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the end line",
      });
    }
  });

  it("a Git write after a line break in the command reaches the guard whole, after `end` too, and outranks the order check", () => {
    for (const command of ["ls\ngit push origin main", "ls\r\ngit push origin main", "ls;\n\tgit commit -m x"]) {
      const before = guarded([call({ input: { command } }), line(END)]);
      expect(before[0], JSON.stringify(command)).toMatchObject({ tool: "shell", violation: { kind: "git_write" } });
      expect(before[0], JSON.stringify(command)).not.toHaveProperty("command");
      const after = guarded([line(END), call({ input: { command } })]);
      expect(adapter().extractResult(after, EXIT_OK), JSON.stringify(command)).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: SID,
      });
    }
  });

  it("long native strings are clipped in failure details: stopReason at 64 code units, an error message at 2,000", () => {
    const stop = `${"x".repeat(100)}\u001b[31m`;
    expect(adapter().extractResult(parse([line({ ...END, stopReason: stop })]).events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: `stopReason ${"x".repeat(64)}…`,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
    const message = `Not signed in. ${"y".repeat(2_100)}`;
    const r = adapter().extractResult(parse([line({ type: "error", message }), line(END)]).events, EXIT_OK);
    expect(r).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
    // The category prefix is read off the unclipped message; the detail carries `<category>: ` plus the clip.
    expect(r.ok === false && r.failureDetail).toBe(`auth: ${message.slice(0, 2_000)}…`);
  });

  it("hostile session-id code points are refused by the parser and by resumeArgs alike, without binding", () => {
    const a = adapter();
    for (const id of ["a b", "a\u0000", "\uD83D", "\u{1F600}", "１", "a​b", "a\tb", "a\r", "A".repeat(257)]) {
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      const events = a.parseEvent(line({ ...END, sessionId: id }), state);
      const label = JSON.stringify(id);
      expect(events[0], label).toEqual({
        kind: "provider_error",
        category: "protocol",
        message: "session id is not a safe argument",
      });
      expect(state.nativeSessionId, label).toBeUndefined();
      expect(a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, approved), label).toEqual({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: "native session id is not a safe single argument",
      });
    }
    // An empty id is neither bound nor an anomaly on the parser side, but resume still refuses it.
    const empty = parse([line({ ...END, sessionId: "" })]);
    expect(empty.events).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { input_tokens: 10 } },
      { kind: "result", ok: true },
    ]);
    expect(a.resumeArgs({ provider: "grok", nativeSessionId: "" }, req, approved)).toMatchObject({ ineligible: true });
  });

  it("resume argv parity: an id spelled like a flag value and an empty objective append one trailing `-r <id>` pair", () => {
    const a = adapter();
    for (const objective of ["", req.objective]) {
      const request = { ...req, objective };
      const first = a.compile(request, approved);
      if ("ineligible" in first) throw new Error(first.detail);
      expect(first.argv.filter((w) => w.startsWith("--single"))).toEqual([`--single=${objective}`]);
      for (const id of ["strict", "read-only", "streaming-json", "end_turn", "always-approve"]) {
        const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: id }, request, approved);
        expect(resumed, `${objective}/${id}`).toEqual({ ...first, argv: [...first.argv, "-r", id] });
      }
    }
  });
});

describe("grok parser residuals, eleventh pass: fail-closed order after `end`, resume argv parity and hostile token shapes (T4.23, synthetic lines; parser unchanged)", () => {
  const approved = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true };
  const req = {
    runId: "run_grok_t423_residual",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const call = (o: object) => line({ type: "tool_call", name: "run_terminal_command", ...o });
  const LS = call({ id: "t1", input: { command: "ls" } });

  it("pins the gap: the trailing-tool detail replaces a supervisor protocol_error or internal_error detail", () => {
    const exits = [
      [{ outcome: "protocol_error", exitCode: null }, "unparseable provider output"],
      [{ outcome: "internal_error", exitCode: null }, "event handling failed"],
    ] as const;
    for (const [outcome, own] of exits) {
      const exit = { ...EXIT_OK, ...outcome };
      // Without a trailing tool call the supervisor's own detail is kept.
      expect(adapter().extractResult(parse([line(END)]).events, exit), outcome.outcome).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: own,
      });
      expect(adapter().extractResult(parse([line(END), LS]).events, exit), outcome.outcome).toEqual({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the end line",
        unknownEventCount: 0,
        nativeSessionId: SID,
      });
    }
  });

  it("fixture tool_then_malformed_after_end replays a tool call and then malformed framing after end_turn (gap)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("tool_then_malformed_after_end"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the end line",
        nativeSessionId: DEFAULT_SESSION_ID,
      },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, unknownEventCount: 0, summary: "Listed the files." });
    // Contrast: the existing fixture without the tool line keeps the supervisor's detail.
    const plain = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("malformed_after_end"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "unparseable provider output",
        nativeSessionId: DEFAULT_SESSION_ID,
      },
    });
    expect(plain.checks.filter((k) => !k.ok)).toEqual([]);
  });

  it("silent line types after `end` carrying tool-shaped or session fields emit nothing and leave the run clean (pinned)", () => {
    const git = { input: { command: "git push origin main" }, id: "t9", name: "run_terminal_command" };
    const silent = ["thought", "usage", "available_commands"].map((type) =>
      line({ type, ...git, sessionId: "other-session", usage: { input_tokens: 99 }, stopReason: "cancelled" }),
    );
    const { events, state } = parse([line(END), ...silent]);
    // Only the `end` line's own events: the silent types never reach the guard, the binding or the usage record.
    expect(events).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "usage", source: "provider_reported", metrics: { input_tokens: 10 } },
      { kind: "result", ok: true },
    ]);
    expect(state).toEqual({ lines: 4, unknownEvents: 0, nativeSessionId: SID });
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: SID });
  });

  it("end counts and tool-call keys are per ParseState: interleaved runs on one adapter never trip each other", () => {
    const a = adapter();
    const s1: ParseState = { lines: 0, unknownEvents: 0 };
    const s2: ParseState = { lines: 0, unknownEvents: 0 };
    const other = "00000000-0000-4000-8000-0000000000aa";
    const e1 = [...a.parseEvent(LS, s1), ...a.parseEvent(line(END), s1)];
    // The same call id and command on the other state is a new report, and its first `end` is not a second one.
    const e2 = [...a.parseEvent(LS, s2), ...a.parseEvent(line({ ...END, sessionId: other }), s2)];
    expect(e2.filter((e) => e.kind === "tool_call")).toEqual([shell("ls")]);
    expect(e2.some((e) => e.kind === "provider_error")).toBe(false);
    expect(a.extractResult(e1, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: SID });
    expect(a.extractResult(e2, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: other });
    // A repeat on the first state after its `end` is still deduplicated there (ninth-pass gap), not on the second.
    expect(a.parseEvent(LS, s1)).toEqual([]);
    // Pinned: a ParseState reused for a second run keeps its counts, so that run's `end` is an anomaly.
    const reused = a.parseEvent(line(END), s1);
    expect(reused[0]).toEqual({ kind: "provider_error", category: "protocol", message: "more than one end line" });
  });

  it("an `end` with a failed stopReason, then a tool call, keeps TOOL_FAILURE and its own detail, not the order detail", () => {
    for (const stopReason of ["cancelled", "max_tokens", "", "END_TURN"]) {
      const { events } = parse([line({ ...END, stopReason }), LS]);
      expect(adapter().extractResult(events, EXIT_OK), stopReason).toEqual({
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: `stopReason ${stopReason}`,
        unknownEventCount: 0,
        nativeSessionId: SID,
      });
    }
  });

  it("session ids named after Object.prototype members bind verbatim and resume to the same argv as any other id", () => {
    const a = adapter();
    const first = a.compile(req, approved);
    if ("ineligible" in first) throw new Error(first.detail);
    for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
      const { events, state } = parse([line({ ...END, sessionId: id })]);
      expect(state.nativeSessionId, id).toBe(id);
      const result = a.extractResult(events, EXIT_OK);
      expect(result, id).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: id });
      expect(a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, approved), id).toEqual({
        ...first,
        argv: [...first.argv, "-r", id],
      });
    }
    // `__proto__` starts with `_`, so it is refused on both sides without binding.
    const proto = parse([line({ ...END, sessionId: "__proto__" })]);
    expect(proto.state.nativeSessionId).toBeUndefined();
    expect(a.resumeArgs({ provider: "grok", nativeSessionId: "__proto__" }, req, approved)).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });
  });

  it("resume is pure: frozen inputs compile, and mutating one invocation's argv or timeouts never leaks into the next", () => {
    const a = adapter();
    const binding = Object.freeze({ provider: "grok" as const, nativeSessionId: SID });
    const frozenReq = Object.freeze({ ...req, workspace: Object.freeze({ ...req.workspace }) });
    const frozenProfile = Object.freeze({ ...approved });
    const resumed = a.resumeArgs(binding, frozenReq, frozenProfile);
    if ("ineligible" in resumed) throw new Error(resumed.detail);
    const snapshot = structuredClone(resumed);
    resumed.argv.splice(-2, 2);
    resumed.timeouts.wallClockMs = 1;
    resumed.policyFlags.push("--yolo");
    const again = a.resumeArgs(binding, frozenReq, frozenProfile);
    if ("ineligible" in again) throw new Error(again.detail);
    expect(again).toEqual(snapshot);
    expect(again.argv.slice(-2)).toEqual(["-r", SID]);
    // compile after a mutated resume is untouched too, and differs only by the trailing pair.
    const compiled = a.compile(frozenReq, frozenProfile);
    if ("ineligible" in compiled) throw new Error(compiled.detail);
    expect({ ...compiled, argv: [...compiled.argv, "-r", SID] }).toEqual(snapshot);
  });

  it("resume ids ending in a delimiter or repeating one round-trip from `end` to one trailing `-r <id>` pair", () => {
    const a = adapter();
    const first = a.compile(req, approved);
    if ("ineligible" in first) throw new Error(first.detail);
    for (const id of ["a-", "a:", "a.", "a_", "a--r", "a::b", "1..2", "Z-_-:.0"]) {
      const result = a.extractResult(parse([line({ ...END, sessionId: id })]).events, EXIT_OK);
      expect(result.nativeSessionId, id).toBe(id);
      const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, approved);
      expect(resumed, id).toEqual({ ...first, argv: [...first.argv, "-r", id] });
      if ("ineligible" in resumed) continue;
      expect(
        resumed.argv.filter((w) => w === "-r"),
        id,
      ).toHaveLength(1);
    }
  });
});

describe("grok parser residuals, twelfth pass: ACP boundaries and raw structured values (T4.23, synthetic lines; parser unchanged)", () => {
  it("ACP result, error and tool updates never supply native status, bindings, usage or guard calls", () => {
    const messages = [
      { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn", sessionId: SID, usage: END.usage } },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Not signed in" } },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: SID, update: { sessionUpdate: "tool_call", command: "git push origin main" } },
      },
    ];
    expect(adapter().transports).toEqual(["subprocess-jsonl"]);
    const objects = parse(messages);
    expect(objects).toEqual({ events: [], state: { lines: 0, unknownEvents: 0 } });
    expect(adapter().extractResult(objects.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
    const serialized = parse(messages.map(line));
    expect(serialized.events).toEqual(messages.map(() => ({ kind: "unknown", rawType: "none" })));
    expect(serialized.state).toEqual({ lines: 3, unknownEvents: 3 });
    expect(adapter().extractResult(serialized.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      unknownEventCount: 3,
    });
  });

  it("pins the gap: an ACP error after a native end is ignored as an object and only counted as serialized JSON", () => {
    const error = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Not signed in" } };
    for (const [input, count] of [
      [error, 0],
      [line(error), 1],
    ] as const) {
      const { events } = parse([line(END), input]);
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
        ok: true,
        nativeSessionId: SID,
        unknownEventCount: count,
      });
      expect(events.some((e) => e.kind === "provider_error")).toBe(false);
    }
  });

  it("a JSON-RPC-looking string still dispatches its top-level native type; the same object is ignored", () => {
    const hybrid = { jsonrpc: "2.0", id: 1, type: "error", message: "Not signed in", result: END };
    expect(parse([hybrid]).events).toEqual([]);
    const { events, state } = parse([line(END), line(hybrid)]);
    expect(events.at(-1)).toEqual({ kind: "provider_error", category: "auth", message: "Not signed in" });
    expect(state).toEqual({ lines: 2, unknownEvents: 0, nativeSessionId: SID });
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
  });

  it("text containing a serialized end or error stays text and supplies neither a result nor a session", () => {
    const text = `${line(END)}\n${line({ type: "error", message: "Not signed in" })}`;
    const { events, state } = parse([line({ type: "text", data: text })]);
    expect(events).toEqual([{ kind: "message", role: "assistant", text }]);
    expect(state).toEqual({ lines: 1, unknownEvents: 0 });
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "no result event",
      unknownEventCount: 0,
      summary: text,
    });
  });

  it("target deduplication compares the full raw target, so different suffixes beyond the clip emit twice", () => {
    const prefix = "x".repeat(512);
    const { events } = parse([
      line({ type: "tool_call", id: "clip", input: { path: `${prefix}a` } }),
      line({ type: "tool_call_update", id: "clip", input: { path: `${prefix}b` } }),
      line({ type: "tool_call_update", id: "clip", input: { path: `${prefix}a` } }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: "tool_call", tool: "read", name: "run_terminal_command", target: `${prefix}…` });
    expect(events[1]).toEqual(events[0]);
  });

  it("call ids are exact opaque strings: case and surrounding whitespace create independent dedupe keys", () => {
    const ids = ["Call", "call", " call", "call "];
    const { events, state } = parse([
      ...ids.map((id) => line({ type: "tool_call", id, command: "pwd" })),
      ...ids.map((id) => line({ type: "tool_call_update", id, command: "pwd" })),
    ]);
    expect(events).toEqual(ids.map(() => shell("pwd")));
    expect(state).toEqual({ lines: 8, unknownEvents: 0 });
  });

  it("modelUsage selects the first Object.keys key: integer-like names sort before the source's first model", () => {
    const { events } = parse([
      '{"type":"end","stopReason":"end_turn","sessionId":"model-order","modelUsage":{"grok-first":{},"12":{},"2":{}}}',
    ]);
    expect(events[0]).toEqual({ kind: "session_bound", nativeSessionId: "model-order", model: "2" });
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: "model-order" });
  });

  it("a pre-seeded nativeSessionId suppresses a matching binding event; only emitted bindings reach the result", () => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0, nativeSessionId: SID };
    const events = a.parseEvent(
      line({ ...END, model: "synthetic-model", backing_provider: "synthetic-vendor" }),
      state,
    );
    expect(events.map((e) => e.kind)).toEqual(["usage", "result"]);
    expect(a.extractResult(events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0 });
    const changed = a.parseEvent(line({ ...END, sessionId: "another-id" }), {
      lines: 0,
      unknownEvents: 0,
      nativeSessionId: SID,
    });
    expect(changed[0]).toEqual({ kind: "provider_error", category: "protocol", message: "session id changed mid-run" });
    expect(a.extractResult(changed, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });
});
