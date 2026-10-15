/**
 * T4.43 parser residual coverage (2026-10-15, Delegated agent work, not owner-approved).
 * SYNTHETIC lines only, parser unchanged, no cursor-agent run.
 * Pins line counting, empty string shadowing, container fallbacks, tool kind exclusivity,
 * id-less deduplication, refusal text patterns, exit 2/137 guard precedence, provider error
 * categories, trailing event distinctions, and exact resume refusals.
 * Second pass (as Grok T4.23 #400 and OpenCode T4.53 #402): stream order across `result` and `init` lines (exact event
 * order for an unsafe id, a changed id on a second result, a failed first result and a late `init`), usage deduplication
 * (including the gap that a counter-less first result drops a second result's total), and resume parity (more id
 * shapes, refusal order with a missing binary, launcher and timeouts, either approval source, no resume context: a
 * pinned gap).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runConformanceCase } from "../conformance.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { guardEvent } from "../tool-guard.js";
import type {
  AcpMessage,
  CompileRequest,
  ExitInfo,
  FailureEvidence,
  NormalizedEvent,
  ParseState,
  ResolvedProfile,
} from "../types.js";
import { CURSOR_BYPASS_OUTSIDE_PRIVILEGED, CursorAdapter } from "./adapter.js";
import { BYPASS_SCOPE, DEFAULT_SESSION_ID, PRIVILEGED_BYPASS_PROFILE, replayAdapter } from "./fixtures/cases.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-cursor-residual-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const adapter = (opts = {}) => new CursorAdapter({ executable: "/opt/synthetic/cursor-agent", ...opts });
const line = (o: unknown) => JSON.stringify(o);
const parse = (lines: (string | object)[], a = adapter()) => {
  const state: ParseState = { lines: 0, unknownEvents: 0 };
  const events = lines.flatMap((l) => a.parseEvent(typeof l === "string" ? l : (l as AcpMessage), state));
  return { a, state, events };
};
const EXIT_OK: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
const SID = "4f1c2a9e-0000-4000-8000-000000000042";
const INIT = (over: Record<string, unknown> = {}) =>
  line({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    session_id: SID,
    model: "Synthetic Model 1",
    ...over,
  });
const RESULT = (over: Record<string, unknown> = {}) =>
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    session_id: SID,
    usage: { inputTokens: 10, outputTokens: 2 },
    ...over,
  });
const TOOL = (subtype: string, call: Record<string, unknown>, callId: string | null = "c1") =>
  line({
    type: "tool_call",
    subtype,
    ...(callId === null ? {} : { call_id: callId }),
    tool_call: call,
    session_id: SID,
  });

describe("cursor parser residuals (T4.43, synthetic lines; parser unchanged)", () => {
  it("ParseState.lines counts every string line (dropped, malformed, unknown, valid) and ignores non-string inputs", () => {
    const { state, events } = parse([
      line({ type: "user", text: "prompt echo" }),
      line({ type: "thinking", text: "internal reasoning" }),
      "malformed not json",
      { jsonrpc: "2.0", method: "init" }, // non-string (ACP message)
      line({ type: "unrecognized_event" }),
      line({ type: "assistant", message: { text: "hello" } }),
      RESULT(),
    ]);
    // 6 string lines parsed (user, thinking, malformed, unrecognized, assistant, result)
    // ACP message is not a string so it does not increment lines
    expect(state.lines).toBe(6);
    expect(state.unknownEvents).toBe(1); // unrecognized_event is unknown
    expect(state.nativeSessionId).toBe(SID);
    expect(events.filter((e) => e.kind === "message")).toEqual([{ kind: "message", role: "assistant", text: "hello" }]);
  });

  it("empty strings shadow fallbacks in init and result (model, backingProvider, session_id); non-strings fall through", () => {
    // 1. Empty string model shadows model_id and modelId, leaving model unset
    const emptyModel = parse([
      INIT({ model: "", model_id: "claude-fallback-1", modelId: "claude-fallback-2" }),
      RESULT(),
    ]);
    const boundEmptyModel = emptyModel.events.find((e) => e.kind === "session_bound");
    expect(boundEmptyModel).toBeDefined();
    expect(boundEmptyModel).not.toHaveProperty("model");

    // Non-string model falls through to model_id
    const nonStrModel = parse([INIT({ model: 123, model_id: "claude-via-id" }), RESULT()]);
    expect(nonStrModel.events.find((e) => e.kind === "session_bound")?.model).toBe("claude-via-id");

    // Non-string model and model_id fall through to modelId
    const nullModel = parse([INIT({ model: null, model_id: null, modelId: "claude-via-modelId" }), RESULT()]);
    expect(nullModel.events.find((e) => e.kind === "session_bound")?.model).toBe("claude-via-modelId");

    // 2. Empty string backing_provider shadows backingProvider
    const emptyBacking = parse([INIT({ backing_provider: "", backingProvider: "anthropic" }), RESULT()]);
    const boundEmptyBacking = emptyBacking.events.find((e) => e.kind === "session_bound");
    expect(boundEmptyBacking).not.toHaveProperty("backingProvider");

    // Null backing_provider falls through to backingProvider
    const nullBacking = parse([INIT({ backing_provider: null, backingProvider: "anthropic-direct" }), RESULT()]);
    expect(nullBacking.events.find((e) => e.kind === "session_bound")?.backingProvider).toBe("anthropic-direct");

    // 3. Empty string session_id shadows sessionId, chat_id and chatId
    const emptySid = parse([
      line({
        type: "system",
        subtype: "init",
        apiKeySource: "login",
        session_id: "",
        sessionId: "valid-fallback-sid",
      }),
      RESULT({ session_id: "" }),
    ]);
    expect(emptySid.state.nativeSessionId).toBeUndefined();
    expect(emptySid.events.some((e) => e.kind === "session_bound")).toBe(false);

    // Non-string session_id falls through to sessionId
    const nonStrSid = parse([
      line({
        type: "system",
        subtype: "init",
        apiKeySource: "login",
        session_id: 42,
        sessionId: "valid-uuid-from-alias",
      }),
      RESULT({ session_id: undefined }),
    ]);
    expect(nonStrSid.events.find((e) => e.kind === "session_bound")?.nativeSessionId).toBe("valid-uuid-from-alias");
  });

  it("apiKeySource formatting clips long source strings and formats non-string sources", () => {
    // 1. Long source string clipped to 32 chars with ellipsis
    const longSource = "custom_enterprise_auth_token_source_key";
    const rLong = parse([INIT({ apiKeySource: longSource }), RESULT()]);
    const errLong = rLong.events.find((e) => e.kind === "provider_error");
    expect(errLong).toEqual({
      kind: "provider_error",
      category: "auth",
      message: `credential source ${longSource.slice(0, 32)}… is not the native login; run \`cursor-agent login\``,
    });

    // 2. Non-string source formats as '(not a string)'
    const rNonStr = parse([INIT({ apiKeySource: 42 }), RESULT()]);
    const errNonStr = rNonStr.events.find((e) => e.kind === "provider_error");
    expect(errNonStr).toEqual({
      kind: "provider_error",
      category: "auth",
      message: "credential source (not a string) is not the native login; run `cursor-agent login`",
    });

    // 3. Empty string source formats as 'credential source  is not the native login'
    const rEmpty = parse([INIT({ apiKeySource: "" }), RESULT()]);
    const errEmpty = rEmpty.events.find((e) => e.kind === "provider_error");
    expect(errEmpty).toEqual({
      kind: "provider_error",
      category: "auth",
      message: "credential source  is not the native login; run `cursor-agent login`",
    });
  });

  it("assistant content handles mixed arrays, top-level arrays, and falls back to unknown on invalid object content", () => {
    // 1. Mixed array with string, text object, non-text object, numbers, and null
    const rMixed = parse([
      INIT(),
      line({
        type: "assistant",
        message: {
          content: ["first ", { text: "second " }, { other: "dropped" }, 99, null, { text: null }, "third"],
        },
      }),
      RESULT(),
    ]);
    expect(rMixed.events.find((e) => e.kind === "message")).toEqual({
      kind: "message",
      role: "assistant",
      text: "first second third",
    });

    // 2. Content array where every item evaluates to empty string emits no message
    const rEmptyArray = parse([
      INIT(),
      line({ type: "assistant", message: { content: [{ other: "ignored" }, null, 12] } }),
      RESULT(),
    ]);
    expect(rEmptyArray.events.some((e) => e.kind === "message")).toBe(false);
    expect(rEmptyArray.state.unknownEvents).toBe(0);

    // 3. Top-level content array directly on event (without message wrapper)
    const rTopContent = parse([INIT(), line({ type: "assistant", content: ["top-level ", "message text"] }), RESULT()]);
    expect(rTopContent.events.find((e) => e.kind === "message")).toEqual({
      kind: "message",
      role: "assistant",
      text: "top-level message text",
    });

    // 4. Object content that is not an array and has no text falls through to unknown assistant event
    const rObjContent = parse([
      INIT(),
      line({ type: "assistant", message: { content: { type: "image", url: "https://example.invalid" } } }),
      RESULT(),
    ]);
    expect(rObjContent.events.find((e) => e.kind === "unknown")).toEqual({
      kind: "unknown",
      rawType: "assistant",
    });
    expect(rObjContent.state.unknownEvents).toBe(1);
  });

  it("tool parameter containers and command/target aliases fall through when preceding entries are null or invalid", () => {
    // 1. Non-object args falls through to parameters, then input, then arguments
    const rParams = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: null, parameters: { command: "echo from_params" } } }),
      RESULT(),
    ]);
    expect(rParams.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "echo from_params",
    });

    const rInput = parse([
      INIT(),
      TOOL("started", {
        shellToolCall: { args: "not-an-object", parameters: [1, 2], input: { command: "echo from_input" } },
      }),
      RESULT(),
    ]);
    expect(rInput.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "echo from_input",
    });

    const rArgs = parse([
      INIT(),
      TOOL("started", {
        shellToolCall: { args: null, parameters: null, input: null, arguments: { command: "echo from_arguments" } },
      }),
      RESULT(),
    ]);
    expect(rArgs.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "echo from_arguments",
    });

    // 2. Non-string command alias fall-through: command (null) -> cmd (123) -> CommandLine (string)
    const rCmd = parse([
      INIT(),
      TOOL("started", {
        shellToolCall: { args: { command: null, cmd: 123, CommandLine: "echo from_pascal_cmdline" } },
      }),
      RESULT(),
    ]);
    expect(rCmd.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "echo from_pascal_cmdline",
    });

    // 3. Non-string target alias fall-through: path (null) -> filePath (123) -> file_path (string)
    const rTarget = parse([
      INIT(),
      TOOL("started", { readToolCall: { args: { path: null, filePath: 123, file_path: "/w/path_from_snake.ts" } } }),
      RESULT(),
    ]);
    expect(rTarget.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "read",
      target: "/w/path_from_snake.ts",
    });
  });

  it("tool kind exclusivity: read/edit tools never extract command, shell tools never extract target", () => {
    // 1. readToolCall and editToolCall carrying command ignore command
    const rRead = parse([
      INIT(),
      TOOL("started", { readToolCall: { args: { command: "ls", path: "/w/read.ts" } } }),
      TOOL("started", { editToolCall: { args: { command: "git status", path: "/w/edit.ts" } } }, "c2"),
      RESULT(),
    ]);
    const readCalls = rRead.events.filter((e) => e.kind === "tool_call");
    expect(readCalls).toEqual([
      { kind: "tool_call", tool: "read", name: "readToolCall", target: "/w/read.ts" },
      { kind: "tool_call", tool: "edit", name: "editToolCall", target: "/w/edit.ts" },
    ]);

    // 2. shellToolCall carrying path ignores path
    const rShell = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo shell", path: "/w/decoy.ts" } } }),
      RESULT(),
    ]);
    const shellCall = rShell.events.find((e) => e.kind === "tool_call");
    expect(shellCall).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "shellToolCall",
      command: "echo shell",
    });

    // 3. Unmapped tool with only path remains other tool
    const rOther = parse([INIT(), TOOL("started", { inspectFile: { args: { path: "/w/inspect.ts" } } }), RESULT()]);
    const otherCall = rOther.events.find((e) => e.kind === "tool_call");
    expect(otherCall).toEqual({
      kind: "tool_call",
      tool: "other",
      name: "inspectFile",
      target: "/w/inspect.ts",
    });
  });

  it("id-less tool calls deduplicate identical reports on completed and emit swaps and additions", () => {
    // 1. Id-less started and completed with identical command emits only 1 tool_call
    const rSame = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo idless" } } }, null),
      TOOL("completed", { shellToolCall: { args: { command: "echo idless" }, result: { success: {} } } }, null),
      RESULT(),
    ]);
    expect(rSame.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "echo idless" },
    ]);
    expect(rSame.a.extractResult(rSame.events, EXIT_OK)).toMatchObject({ ok: true });

    // 2. Two id-less started lines with the same command are both emitted
    const rDoubleStarted = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "git status" } } }, null),
      TOOL("started", { shellToolCall: { args: { command: "git status" } } }, null),
      RESULT(),
    ]);
    expect(rDoubleStarted.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git status" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git status" },
    ]);

    // 3. Id-less completed line with no parameters and no refusal emits nothing and is not unknown
    const rEmptyCompleted = parse([
      INIT(),
      TOOL("started", { getMcpTools: {} }, null),
      TOOL("completed", { getMcpTools: { result: { success: {} } } }, null),
      RESULT(),
    ]);
    expect(rEmptyCompleted.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "getMcpTools" },
    ]);
    expect(rEmptyCompleted.state.unknownEvents).toBe(0);
    expect(rEmptyCompleted.a.extractResult(rEmptyCompleted.events, EXIT_OK)).toMatchObject({ ok: true });
  });

  it("tool refusal regex matches unauthorized and not permitted patterns; unrelated errors do not trigger denial", () => {
    // 1. 'unauthorized' pattern triggers permission_denied
    const rUnauth = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo test" } } }),
      TOOL("completed", { shellToolCall: { error: "Operation was unauthorized by administrator policy" } }),
      RESULT(),
    ]);
    expect(rUnauth.events.some((e) => e.kind === "permission_denied")).toBe(true);
    expect(rUnauth.a.extractResult(rUnauth.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });

    // 2. 'not permitted' pattern triggers permission_denied
    const rNotPermitted = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo test" } } }),
      TOOL("completed", { shellToolCall: { result: { error: "Execution is not permitted in current mode" } } }),
      RESULT(),
    ]);
    expect(rNotPermitted.events.some((e) => e.kind === "permission_denied")).toBe(true);
    expect(rNotPermitted.a.extractResult(rNotPermitted.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });

    // 3. Unrelated error message (e.g. compilation/syntax error) does not trigger permission_denied
    const rSyntax = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo test" } } }),
      TOOL("completed", { shellToolCall: { result: { error: "SyntaxError: Unexpected identifier" } } }),
      RESULT(),
    ]);
    expect(rSyntax.events.some((e) => e.kind === "permission_denied")).toBe(false);
    expect(rSyntax.a.extractResult(rSyntax.events, EXIT_OK)).toMatchObject({ ok: true });
  });

  it("exit codes 2 and 137 under ADR-0039 guard violations end PERMISSION_BLOCKED; without violation they end TOOL_FAILURE", () => {
    const a = adapter();
    const ctx = { cwd: "/w", bypass: true };

    for (const exitCode of [2, 137]) {
      const exit: ExitInfo = { outcome: "exited", exitCode, signal: null, expectedExitCodes: [0] };

      // Hostile Git-write command guarded: outranks exit 2 and exit 137
      const hostileLines = [INIT(), TOOL("started", { shellToolCall: { args: { command: "git push origin main" } } })];
      const guardedEvents = hostileLines
        .flatMap((l) => a.parseEvent(l, { lines: 0, unknownEvents: 0 }))
        .map((e) => guardEvent(e, ctx));
      const resHostile = a.extractResult(guardedEvents, exit);
      expect(resHostile, `exit ${exitCode}`).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });
      expect(resHostile.failureDetail, `exit ${exitCode}`).toMatch(/^git write attempted/);

      // Benign command without violation: ends in TOOL_FAILURE with exit code detail
      const benignLines = [INIT(), TOOL("started", { shellToolCall: { args: { command: "ls -la" } } })];
      const benignEvents = benignLines
        .flatMap((l) => a.parseEvent(l, { lines: 0, unknownEvents: 0 }))
        .map((e) => guardEvent(e, ctx));
      const resBenign = a.extractResult(benignEvents, exit);
      expect(resBenign, `exit ${exitCode}`).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: `exit code ${exitCode}`,
      });
    }
  });

  it("classifyFailure maps provider_error categories overloaded, quota, model_unavailable, and unknown fall-through", () => {
    const a = adapter();
    const baseEvidence = (events: readonly NormalizedEvent[]): FailureEvidence => ({
      events,
      exit: EXIT_OK,
      stderrTail: "",
      timedOut: false,
      cancelled: false,
    });

    const overloaded: NormalizedEvent = { kind: "provider_error", category: "overloaded", message: "server busy" };
    expect(a.classifyFailure(baseEvidence([overloaded]))).toEqual({
      code: "PROVIDER_OVERLOADED",
      detail: "overloaded: server busy",
    });

    const quota: NormalizedEvent = { kind: "provider_error", category: "quota", message: "monthly tokens exhausted" };
    expect(a.classifyFailure(baseEvidence([quota]))).toEqual({
      code: "QUOTA_EXHAUSTED",
      detail: "quota: monthly tokens exhausted",
    });

    const modelUnavailable: NormalizedEvent = {
      kind: "provider_error",
      category: "model_unavailable",
      message: "model sunset",
    };
    expect(a.classifyFailure(baseEvidence([modelUnavailable]))).toEqual({
      code: "MODEL_UNAVAILABLE",
      detail: "model_unavailable: model sunset",
    });

    const unknownCategory: NormalizedEvent = {
      kind: "provider_error",
      category: "unmapped_category",
      message: "weird error",
    };
    expect(a.classifyFailure(baseEvidence([unknownCategory]))).toEqual({
      code: "TOOL_FAILURE",
      detail: "unmapped_category: weird error",
    });
  });

  it("trailing assistant messages and unknown non-tool events after result leave a clean turn clean", () => {
    // 1. Assistant message after result is added to summary and does not fail the run
    const rAssist = parse([INIT(), RESULT(), line({ type: "assistant", message: { text: "trailing summary notes" } })]);
    expect(rAssist.a.extractResult(rAssist.events, EXIT_OK)).toMatchObject({
      ok: true,
      summary: "trailing summary notes",
      nativeSessionId: SID,
      unknownEventCount: 0,
    });

    // 2. Unknown non-tool event after result increments unknown count and does not fail the run
    const rUnknown = parse([INIT(), RESULT(), line({ type: "vendor_telemetry_event", ping: true })]);
    expect(rUnknown.a.extractResult(rUnknown.events, EXIT_OK)).toMatchObject({
      ok: true,
      nativeSessionId: SID,
      unknownEventCount: 1,
    });

    // 3. Unreadable tool_call line after result trips trailingTool and fails OUTPUT_PROTOCOL_ERROR
    const rUnreadableTool = parse([
      INIT(),
      RESULT(),
      line({ type: "tool_call" }), // bare unreadable tool_call
    ]);
    expect(rUnreadableTool.a.extractResult(rUnreadableTool.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      nativeSessionId: SID,
      unknownEventCount: 1,
    });
  });

  it("resumeArgs exact refusals for requested models, read-only workspaces, shell allowlists with git write, and missing executable", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const binding = { provider: "cursor" as const, nativeSessionId: SID };

    // 1. Requested model is CAPABILITY_MISSING
    const reqModel: CompileRequest = {
      runId: "run_model_check",
      objective: "synthetic objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
      bypassApproved: true,
      model: "cursor-fast",
    };
    expect(a.resumeArgs(binding, reqModel, approved)).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: "no model registry data for Cursor yet (T4.5; --model is not emitted)",
    });

    // 2. Read-only workspace is CAPABILITY_MISSING
    const reqReadOnly: CompileRequest = {
      runId: "run_readonly_check",
      objective: "synthetic objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: false },
      bypassApproved: true,
    };
    expect(a.resumeArgs(binding, reqReadOnly, approved)).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: expect.stringMatching(/^privileged read-only files:/),
    });

    // 3. Shell allowlist containing Git write is PROFILE_UNSUPPORTED (FR-GIT-01)
    const profileWithGitWrite = {
      ...approved,
      shellAllowlist: ["git push origin main"],
    };
    const reqPlain: CompileRequest = {
      runId: "run_gitwrite_check",
      objective: "synthetic objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
      bypassApproved: true,
    };
    expect(a.resumeArgs(binding, reqPlain, profileWithGitWrite)).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: expect.stringMatching(/^shell allowlist entries could write Git \(FR-GIT-01\): git push origin main/),
    });

    // 4. Missing executable on PATH returns CAPABILITY_MISSING
    const unresolvable = new CursorAdapter({ pathEnv: "/empty_path_dir" });
    expect(unresolvable.resumeArgs(binding, reqPlain, approved)).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: "cursor-agent not found on PATH",
    });
  });

  it("fixture idless_guard replays an id-less Git write under success result at exit 0 to PERMISSION_BLOCKED (T4.43)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("idless_guard"),
      request: {
        runId: "run_cursor_t443_idless_guard",
        objective: "synthetic cursor objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: DEFAULT_SESSION_ID,
      },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
    });
    expect(report.result?.failureDetail).toMatch(/^git write attempted/);
  });
});

describe("cursor parser residuals, second pass: stream order, usage dedup and resume parity (T4.43, synthetic lines; parser unchanged)", () => {
  const usages = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "usage");
  const approved = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true };
  const req: CompileRequest = {
    runId: "run_cursor_t443_residual",
    objective: "synthetic cursor objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const OTHER = "4f1c2a9e-0000-4000-8000-0000000000ff";

  it("pins the gap: a first result with no usable counter means a second result's usage is never recorded", () => {
    const { a, events } = parse([INIT(), RESULT({ usage: undefined }), RESULT({ usage: { inputTokens: 99 } })]);
    // The run total is recorded by the first result only (FR-CAP-01); the second fails the run, so nothing is counted.
    expect(usages(events)).toEqual([]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("a result with an unsafe session id still records its usage and result, in the order error, usage, result", () => {
    const { a, events, state } = parse([RESULT({ session_id: "-r" })]);
    expect(events).toEqual([
      { kind: "provider_error", category: "protocol", message: "session id is not a safe argument" },
      { kind: "usage", source: "provider_reported", metrics: { inputTokens: 10, outputTokens: 2 } },
      { kind: "result", ok: true },
    ]);
    expect(state.nativeSessionId).toBeUndefined();
    const r = a.extractResult(events, EXIT_OK);
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    expect(r).not.toHaveProperty("nativeSessionId");
  });

  it("a second result with a changed id emits both anomalies in order, no second usage, and keeps the first id", () => {
    const { a, events, state } = parse([INIT(), RESULT(), RESULT({ session_id: OTHER, usage: { inputTokens: 5 } })]);
    expect(events).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "Synthetic Model 1" },
      { kind: "usage", source: "provider_reported", metrics: { inputTokens: 10, outputTokens: 2 } },
      { kind: "result", ok: true },
      { kind: "provider_error", category: "protocol", message: "more than one result line" },
      { kind: "provider_error", category: "protocol", message: "session id changed mid-run" },
      { kind: "result", ok: false, summary: "result success" },
    ]);
    expect(state.nativeSessionId).toBe(SID);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
      nativeSessionId: SID,
    });
  });

  it("a failed first result records its usage; a later success cannot flip it and the protocol error outranks it", () => {
    const { a, events } = parse([INIT(), RESULT({ subtype: "error", is_error: true }), RESULT()]);
    expect(usages(events)).toHaveLength(1);
    expect(events.filter((e) => e.kind === "result")).toEqual([
      { kind: "result", ok: false, summary: "result error" },
      { kind: "result", ok: false, summary: "result success" },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("a credential-source error on init does not stop the run total being recorded, though the run fails", () => {
    const { a, events } = parse([INIT({ apiKeySource: "env" }), RESULT()]);
    expect(usages(events)).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { inputTokens: 10, outputTokens: 2 } },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      nativeSessionId: SID,
    });
  });

  it("a result before any init binds from the result; a late init with the same id adds nothing and the turn stays clean", () => {
    const { a, events, state } = parse([
      RESULT({ model: "From Result" }),
      INIT({ model: "From Late Init", backing_provider: "late-vendor" }),
    ]);
    // The late init neither rebinds nor re-reports the model or a backing vendor: session_bound is emitted once.
    expect(events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "From Result" },
    ]);
    expect(state).toMatchObject({ lines: 2, unknownEvents: 0, nativeSessionId: SID });
    expect(a.extractResult(events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: SID });
  });

  it("a late init after the result that names another session or an unsafe id fails closed with the first id bound", () => {
    for (const [late, message] of [
      [OTHER, "session id changed mid-run"],
      ["--force", "session id is not a safe argument"],
    ] as const) {
      const { a, events, state } = parse([INIT(), RESULT(), INIT({ session_id: late })]);
      expect(events.at(-1), late).toEqual({ kind: "provider_error", category: "protocol", message });
      expect(state.nativeSessionId, late).toBe(SID);
      expect(a.extractResult(events, EXIT_OK), late).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: `protocol: ${message}`,
        nativeSessionId: SID,
      });
    }
  });

  it("thinking, user echo and a non-init system line after the result never trip the order check", () => {
    const { a, events, state } = parse([
      INIT(),
      RESULT(),
      line({ type: "thinking", text: "late" }),
      line({ type: "user", message: { content: "late echo" } }),
      line({ type: "system", subtype: "status" }),
    ]);
    expect(state.unknownEvents).toBe(1);
    expect(events.at(-1)).toEqual({ kind: "unknown", rawType: "system:status" });
    expect(a.extractResult(events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 1, nativeSessionId: SID });
  });

  it("assistant text after a failed result joins the summary but cannot make the run succeed", () => {
    const { a, events } = parse([
      INIT(),
      line({ type: "assistant", message: { text: "a" } }),
      RESULT({ subtype: "error", is_error: true }),
      line({ type: "assistant", message: { text: "b" } }),
    ]);
    expect(a.extractResult(events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "result error",
      unknownEventCount: 0,
      nativeSessionId: SID,
      summary: "a\nb",
    });
  });

  it("pins the gap: camelCase and snake_case counters on one result are both kept side by side, never merged", () => {
    const { events } = parse([INIT(), RESULT({ usage: { inputTokens: 10, input_tokens: 10, total_tokens: 12 } })]);
    expect(usages(events)).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { inputTokens: 10, input_tokens: 10, total_tokens: 12 } },
    ]);
  });

  it("fixture late_init_changed replays a late init naming another session after a result-first stream to OUTPUT_PROTOCOL_ERROR", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("late_init_changed"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id changed mid-run",
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
    });
  });

  it("the parser and resumeArgs agree on id shapes: both accept or both refuse", () => {
    const a = adapter();
    for (const [id, safe] of [
      ["A:b.c-d_9", true],
      ["9", true],
      [`a${"b".repeat(255)}`, true],
      [`a${"b".repeat(256)}`, false],
      ["a\n", false],
      ["\na", false],
      ["é", false],
      ["a b", false],
      ["a/b", false],
      ["a=b", false],
      ["_a", false],
      [".a", false],
      [":a", false],
    ] as const) {
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      a.parseEvent(INIT({ session_id: id }), state);
      const resumed = a.resumeArgs({ provider: "cursor", nativeSessionId: id }, req, approved);
      expect(state.nativeSessionId === id, JSON.stringify(id)).toBe(safe);
      expect("ineligible" in resumed, JSON.stringify(id)).toBe(!safe);
    }
  });

  it("resumeArgs refusal order: foreign binding, unsafe id, the compile matrix, then the missing binary (as compile)", () => {
    const missing = new CursorAdapter({ pathEnv: "/nonexistent" });
    const safe = { provider: "cursor" as const, nativeSessionId: SID };
    const notFound = { ineligible: true, reason: "CAPABILITY_MISSING", detail: "cursor-agent not found on PATH" };
    expect(missing.compile(req, approved)).toEqual(notFound);
    expect(missing.resumeArgs(safe, req, approved)).toEqual(notFound);
    expect(missing.resumeArgs({ provider: "cursor", nativeSessionId: "-r" }, req, approved)).toMatchObject({
      detail: "native session id is not a safe single argument",
    });
    expect(missing.resumeArgs({ provider: "codex", nativeSessionId: "-r" }, req, approved)).toMatchObject({
      detail: "binding is for codex",
    });
    // A matrix refusal comes before the missing binary on both paths.
    const refusals: [CompileRequest, ResolvedProfile][] = [
      [req, { ...approved, shellAllowlist: ["git push origin main"] }],
      [{ ...req, model: "cursor-fast" }, approved],
      [{ ...req, workspace: { cwd: "/w", writable: false } }, approved],
    ];
    for (const [request, profile] of refusals) {
      const refused = missing.compile(request, profile);
      expect("ineligible" in refused).toBe(true);
      expect(refused).not.toEqual(notFound);
      expect(missing.resumeArgs(safe, request, profile)).toEqual(refused);
    }
  });

  it("either approval source compiles and resumes identically; a bypass approval outside privileged is refused alike", () => {
    const a = adapter();
    const binding = { provider: "cursor" as const, nativeSessionId: SID };
    const viaProfile = a.compile({ ...req, bypassApproved: false }, approved);
    const viaRequest = a.compile(req, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in viaProfile) throw new Error(viaProfile.detail);
    expect(viaRequest).toEqual(viaProfile);
    expect(a.resumeArgs(binding, { ...req, bypassApproved: false }, approved)).toEqual(
      a.resumeArgs(binding, req, PRIVILEGED_BYPASS_PROFILE),
    );
    const editProfile = { ...privilegedProfile(BYPASS_SCOPE), name: "edit-untrusted" as const };
    const outside = a.compile(req, editProfile);
    expect(outside).toMatchObject({ reason: "PROFILE_UNSUPPORTED", detail: CURSOR_BYPASS_OUTSIDE_PRIVILEGED });
    expect(a.resumeArgs(binding, req, editProfile)).toEqual(outside);
  });

  it("resume keeps the launcher arguments and constructor timeouts exactly as compile, with only `--resume <id>` appended", () => {
    const a = adapter({ launcherArgs: ["--launcher-a", "x"], timeouts: { idleMs: 1_234 } });
    const first = a.compile(req, approved);
    const resumed = a.resumeArgs({ provider: "cursor", nativeSessionId: SID }, req, approved);
    if ("ineligible" in first) throw new Error(first.detail);
    expect(first.argv.slice(0, 3)).toEqual(["/opt/synthetic/cursor-agent", "--launcher-a", "x"]);
    expect(first.timeouts.idleMs).toBe(1_234);
    expect(resumed).toEqual({ ...first, argv: [...first.argv, "--resume", SID] });
    // Each call returns fresh arrays, so mutating one invocation never leaks into the next.
    first.argv.push("--mutated");
    first.policyFlags.push("--mutated");
    first.envAllowlist.push("CURSOR_API_KEY");
    first.timeouts.idleMs = 1;
    const again = a.compile(req, approved);
    if ("ineligible" in again) throw new Error(again.detail);
    expect(again.argv).not.toContain("--mutated");
    expect(again.policyFlags).toEqual(["--trust", "--force"]);
    expect(again.envAllowlist).toEqual(["PATH", "HOME"]);
    expect(again.timeouts.idleMs).toBe(1_234);
  });

  it("pins the gap: the parser has no resume context, so a resumed run whose init reports another id binds it", () => {
    // No adapter or lifecycle code in this path compares the bound id with the requested one ([LIVE] 8a to 8c returned
    // the same id); the conformance resume case checks the id separately.
    const a = adapter();
    const resumed = a.resumeArgs({ provider: "cursor", nativeSessionId: DEFAULT_SESSION_ID }, req, approved);
    expect("ineligible" in resumed).toBe(false);
    const { events } = parse([INIT(), RESULT()], a);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });
  });
});
