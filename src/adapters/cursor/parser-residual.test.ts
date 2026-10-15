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
 * Third pass (T4.6, FR-ADP-10): `backingProvider` and model on `session_bound` edge cases. Pinned gaps: a vendor or
 * model first reported on a `result` after `init` bound the same id is dropped (fixture `backing_on_result.jsonl`); an
 * `init` without a usable id loses its vendor; a non-null non-string `backing_provider` shadows `backingProvider`
 * (unlike `model`); values are bound verbatim (no trim or case folding, the harness name kept).
 * Fourth pass (as Grok T4.23 #416 and Antigravity T4.33 #424): session-id gaps (a first result that binds nothing leaves
 * the slot open, so a second, failing result binds the only id, replayed through fixture `unsafe_then_good_result.jsonl`;
 * fixture `resume_other_id.jsonl` replaying `--resume <id>` answered with another session id; session id on non-binding
 * lines; earlier binding finality; non-object and zero usage metrics; compile/resume bypass approval source parity).
 * Fifth pass (as Grok T4.23 #430): post-result tool lines, prototype values and exit codes (an unreadable non-tool line
 * after result is a counted unknown leaving the turn clean, replayed through fixture `trailing_bare_update.jsonl`;
 * a deduplicated tool update after result trips no order check; trailing-tool detail replacing two-results detail;
 * prototype-named model/backingProvider shadowing fallback keys; prototype-named tool keys; unclipped command reaching
 * the guard; call_id correlation; fractional usage counts; extractResult expectedExitCodes honouring).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../artifacts/index.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, openLedger } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { WorkspaceManager } from "../../workspace/index.js";
import { runConformanceCase } from "../conformance.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { AdapterRegistry } from "../registry.js";
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
import { CURSOR_BYPASS_NOT_APPROVED, CURSOR_BYPASS_OUTSIDE_PRIVILEGED, CursorAdapter } from "./adapter.js";
import {
  BYPASS_SCOPE,
  DEFAULT_SESSION_ID,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";

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

describe("cursor parser residuals, third pass: backingProvider and model on session_bound (T4.43, T4.6, FR-ADP-10; synthetic lines; parser unchanged)", () => {
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");

  it("pins the gap: a backing vendor or model first reported on a result after init bound the same id is dropped", () => {
    const { a, events, state } = parse([
      INIT(),
      RESULT({
        model: "Result Model 2",
        backing_provider: "backing-late",
        backingProvider: "backing-late-camel",
      }),
    ]);
    // The first binding is final (#bind returns early on the same id), so session_bound is emitted once, from init.
    expect(bound(events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "Synthetic Model 1",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("backing-late");
    expect(JSON.stringify(events)).not.toContain("Result Model 2");
    expect(state.nativeSessionId).toBe(SID);
    expect(a.extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
  });

  it("an init without a usable id loses its model and backing vendor; the result binds with its own fields only", () => {
    for (const id of ["", undefined, 42]) {
      const { events } = parse([
        INIT({
          session_id: id,
          model: "Init Model",
          backing_provider: "init-vendor",
        }),
        RESULT({ model: undefined }),
      ]);
      expect(bound(events), String(id)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    }
    const withResultFields = parse([
      INIT({ session_id: "", backing_provider: "init-vendor" }),
      RESULT({ model: "Result Model", backingProvider: "result-vendor" }),
    ]);
    expect(bound(withResultFields.events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "Result Model",
        backingProvider: "result-vendor",
      },
    ]);
  });

  it("an init with an unsafe id binds nothing and its backing vendor is lost; the run fails even if the result binds", () => {
    const { a, events, state } = parse([
      INIT({ session_id: "-x", backing_provider: "init-vendor" }),
      RESULT({ model: undefined }),
    ]);
    expect(events.slice(0, 1)).toEqual([
      {
        kind: "provider_error",
        category: "protocol",
        message: "session id is not a safe argument",
      },
    ]);
    expect(bound(events)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    expect(state.nativeSessionId).toBe(SID);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
  });

  it("pins the asymmetry: a non-null non-string backing_provider shadows backingProvider, while a non-string model falls through", () => {
    for (const raw of [42, false, { vendor: "x" }, ["x"]]) {
      const { events } = parse([INIT({ backing_provider: raw, backingProvider: "camel-vendor" }), RESULT()]);
      expect(bound(events), JSON.stringify(raw)).toEqual([
        {
          kind: "session_bound",
          nativeSessionId: SID,
          model: "Synthetic Model 1",
        },
      ]);
    }
    // The same shapes on the result line (no init) behave alike.
    const onResult = parse([RESULT({ backing_provider: 0, backingProvider: "camel-vendor" })]);
    expect(bound(onResult.events)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    // `model` is read per key with str(), so a non-string falls through to model_id.
    const model = parse([
      INIT({
        model: 7,
        model_id: "via-model-id",
        backing_provider: 7,
        backingProvider: "camel",
      }),
    ]);
    expect(bound(model.events)).toEqual([{ kind: "session_bound", nativeSessionId: SID, model: "via-model-id" }]);
  });

  it("backingProvider and model are bound verbatim: no trim, no case folding, the harness name kept, 128 characters unclipped", () => {
    const exact = "v".repeat(128);
    for (const [vendor, model] of [
      ["cursor", "cursor"],
      ["  Anthropic  ", " Model With Spaces "],
      ["ANTHROPIC", "claude-SONNET"],
      [exact, exact],
      ["éditeur", "modèle"],
    ]) {
      const { events } = parse([INIT({ model, backing_provider: vendor })]);
      expect(bound(events), vendor).toEqual([
        {
          kind: "session_bound",
          nativeSessionId: SID,
          model,
          backingProvider: vendor,
        },
      ]);
    }
    const over = parse([INIT({ model: `${exact}m`, backing_provider: `${exact}b` })]);
    expect(bound(over.events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: `${exact}…`,
        backingProvider: `${exact}…`,
      },
    ]);
  });

  it("Object.prototype member names as backingProvider or model are omitted, never bound; the session still binds", () => {
    for (const name of ["constructor", "hasOwnProperty", "valueOf", "isPrototypeOf", "__proto__", "__defineGetter__"]) {
      const { events, a } = parse([INIT({ model: name, backing_provider: name }), RESULT()]);
      expect(bound(events), name).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
      expect(a.extractResult(events, EXIT_OK)).toMatchObject({
        ok: true,
        nativeSessionId: SID,
      });
    }
    // A name that only contains a prototype member name is kept.
    const near = parse([INIT({ model: "constructor-2", backing_provider: "valueOf-vendor" })]);
    expect(bound(near.events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "constructor-2",
        backingProvider: "valueOf-vendor",
      },
    ]);
  });

  it("an own __proto__ key in the JSON cannot supply a backing vendor, model or session id", () => {
    const raw =
      '{"type":"system","subtype":"init","apiKeySource":"login","__proto__":{"session_id":"' +
      SID +
      '","model":"proto-model","backing_provider":"proto-vendor"}}';
    const { events, state } = parse([raw]);
    expect(bound(events)).toEqual([]);
    expect(state.nativeSessionId).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("proto-vendor");
  });

  it("backing_provider on lines other than system/init and result never reaches session_bound", () => {
    const withVendor = {
      backing_provider: "smuggled-vendor",
      model: "smuggled-model",
      session_id: SID,
    };
    const { a, events, state } = parse([
      line({ type: "system", subtype: "status", ...withVendor }),
      line({ type: "assistant", message: { content: "hi" }, ...withVendor }),
      line({ type: "thinking", text: "t", ...withVendor }),
      line({ type: "user", message: { content: "p" }, ...withVendor }),
      TOOL("started", { readToolCall: { args: { path: "a.txt" } } }),
      INIT({ model: undefined }),
      RESULT(),
    ]);
    expect(bound(events)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    expect(JSON.stringify(events)).not.toContain("smuggled");
    expect(state.unknownEvents).toBe(1); // system:status
    // An unknown line before the result is counted, not fatal; the vendor it carried is simply never read.
    expect(a.extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 1,
      nativeSessionId: SID,
      summary: "hi",
    });
  });

  it("a backing vendor on a second result, or a late init with a changed id, is never bound", () => {
    const second = parse([INIT(), RESULT(), RESULT({ backing_provider: "second-vendor" })]);
    expect(bound(second.events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "Synthetic Model 1",
      },
    ]);
    const changed = parse([
      INIT(),
      INIT({
        session_id: "4f1c2a9e-0000-4000-8000-0000000000ff",
        backing_provider: "changed-vendor",
      }),
      RESULT(),
    ]);
    expect(bound(changed.events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "Synthetic Model 1",
      },
    ]);
    expect(JSON.stringify(changed.events)).not.toContain("changed-vendor");
  });

  it("fixture backing_on_result replays to success with the init model bound and no backing vendor", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("backing_on_result"),
      request: {
        runId: "run_cursor_backing_on_result",
        objective: "synthetic cursor objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
    });
  });

  it("fixture backing_on_result through RunLifecycle stores harness cursor with no backing vendor and the init model", async () => {
    const root = realpathSync(makeCwd());
    const repo = join(root, "repo");
    mkdirSync(repo);
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: {
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Cursor Dev",
          GIT_AUTHOR_EMAIL: "cursor@example.test",
          GIT_COMMITTER_NAME: "Cursor Dev",
          GIT_COMMITTER_EMAIL: "cursor@example.test",
        },
      });
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "initial\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const lifecycle = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({
        db,
        artifacts,
        dataDir,
        allowedRoots: [root],
        ids,
      }),
      artifacts,
      adapters: new AdapterRegistry().register(replayAdapter("backing_on_result")),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
    });
    lifecycle.start();
    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "a vendor reported only on the result line",
        workspace: repo,
        trustProfile: "privileged",
        provider: "cursor",
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });
      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      const bindings = ledger.listProviderBindings(metaSessionId);
      expect(bindings).toEqual([
        expect.objectContaining({
          provider: "cursor",
          harness: "cursor",
          model: "Synthetic Model 1",
          native_session_id: DEFAULT_SESSION_ID,
        }),
      ]);
      expect(bindings[0]?.backing_provider ?? null).toBeNull();
      const rows = ledger.listUsageObservationsForRun(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "cursor",
        harness: "cursor",
        source: "provider_reported",
      });
      expect(rows[0]?.backing_provider ?? null).toBeNull();
      expect(JSON.stringify([bindings, rows])).not.toContain("backing-late");
      expect(JSON.stringify([bindings, rows])).not.toContain("Result Model 2");
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  });
});

describe("cursor parser residuals, fourth pass: session-id gaps, usage shapes and resume parity (T4.43, synthetic lines; parser unchanged)", () => {
  const req: CompileRequest = {
    runId: "run_cursor_t443_residual_p4",
    objective: "synthetic cursor objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");

  it("pins the gap: a first result that binds nothing leaves the slot open, so a second, failing result binds the only id", () => {
    for (const first of ["--unsafe", "-unsafe", "", 7, undefined]) {
      const label = JSON.stringify(first) ?? "undefined";
      const { events, state, a } = parse([
        RESULT({ session_id: first, usage: { inputTokens: 10 } }),
        RESULT({ session_id: SID, usage: { inputTokens: 500 } }),
      ]);
      // The first result takes the usage slot (its usage is the run total); the second is a protocol anomaly whose
      // id still binds, because #bind only refuses a change from an id already bound.
      expect(bound(events), label).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
      expect(
        events.filter((e) => e.kind === "usage"),
        label,
      ).toEqual([{ kind: "usage", source: "provider_reported", metrics: { inputTokens: 10 } }]);
      expect(state.nativeSessionId, label).toBe(SID);
      expect(a.extractResult(events, EXIT_OK), label).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: SID,
      });
    }
  });

  it("fixture unsafe_then_good_result replays to OUTPUT_PROTOCOL_ERROR with the second result's id bound (gap, pinned)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("unsafe_then_good_result"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
      summary: "Done.",
    });
  });

  it("pins the gap end to end: fixture resume_other_id passes --resume <requested>, binds the reported id and succeeds", async () => {
    const a = replayAdapter("resume_other_id");
    const binding = { provider: "cursor" as const, nativeSessionId: RESUMED_SESSION_ID };
    const request = { ...req, workspace: { cwd: makeCwd(), writable: true } };
    const inv = a.resumeArgs(binding, request, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in inv) throw new Error(inv.detail);
    expect(inv.argv.slice(-2)).toEqual(["--resume", RESUMED_SESSION_ID]);
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

  it("a session_id on any line other than system/init and result never binds or conflicts, before or after binding", () => {
    const decoys = [
      line({ type: "assistant", message: { content: "hi" }, session_id: "decoy-session" }),
      line({ type: "thinking", text: "t", session_id: "decoy-session" }),
      line({ type: "user", message: { content: "p" }, session_id: "decoy-session" }),
      TOOL("started", { shellToolCall: { args: { command: "ls" } } }, "c1"),
    ];
    const none = parse([...decoys, RESULT({ session_id: undefined })]);
    expect(bound(none.events)).toEqual([]);
    expect(none.state.nativeSessionId).toBeUndefined();

    const { events, state } = parse([...decoys, INIT(), ...decoys]);
    expect(bound(events)).toEqual([{ kind: "session_bound", nativeSessionId: SID, model: "Synthetic Model 1" }]);
    expect(state.nativeSessionId).toBe(SID);
    // The decoy ids never raise "session id changed mid-run".
    expect(events.filter((e) => e.kind === "provider_error")).toEqual([]);
  });

  it("the first binding is final: a model on a later result never amends it, unless the init bound nothing", () => {
    const later = parse([INIT(), RESULT({ model: "Late Model", backingProvider: "Late Vendor" })]).events;
    expect(bound(later)).toEqual([{ kind: "session_bound", nativeSessionId: SID, model: "Synthetic Model 1" }]);

    const lost = parse([
      INIT({ session_id: "-unsafe", model: "First Model" }),
      RESULT({ model: "Second Model", backingProvider: "Second Vendor" }),
    ]).events;
    expect(bound(lost)).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "Second Model", backingProvider: "Second Vendor" },
    ]);
  });

  it("a non-object usage records nothing; zero counters are recorded; non-finite and negative counters are dropped", () => {
    for (const usage of [[], null, "10", 10, [{ inputTokens: 5 }]]) {
      const { events, a } = parse([RESULT({ usage })]);
      expect(
        events.filter((e) => e.kind === "usage"),
        JSON.stringify(usage),
      ).toEqual([]);
      expect(a.extractResult(events, EXIT_OK), JSON.stringify(usage)).toMatchObject({ ok: true });
    }
    const zero = parse([RESULT({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })]).events;
    expect(zero.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ]);
    const negative = parse([RESULT({ usage: { inputTokens: -1, outputTokens: NaN, totalTokens: Infinity } })]).events;
    expect(negative.filter((e) => e.kind === "usage")).toEqual([]);
    const mixed = parse([RESULT({ usage: { inputTokens: 10, outputTokens: -5 } })]).events;
    expect(mixed.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { inputTokens: 10 } },
    ]);
  });

  it("resume and compile agree on where the bypass approval comes from: profile, request, both or neither", () => {
    const a = adapter();
    const binding = { provider: "cursor" as const, nativeSessionId: SID };
    for (const [onProfile, onRequest] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const profile: ResolvedProfile = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: onProfile };
      const request: CompileRequest = { ...req, bypassApproved: onRequest };
      const first = a.compile(request, profile);
      const resumed = a.resumeArgs(binding, request, profile);
      const label = `profile=${onProfile} request=${onRequest}`;
      if ("ineligible" in first) {
        expect(onProfile || onRequest, label).toBe(false);
        expect(first, label).toEqual({
          ineligible: true,
          reason: "PROFILE_UNSUPPORTED",
          detail: CURSOR_BYPASS_NOT_APPROVED,
        });
        expect(resumed, label).toEqual(first);
      } else {
        expect(onProfile || onRequest, label).toBe(true);
        expect(resumed, label).toEqual({ ...first, argv: [...first.argv, "--resume", SID] });
      }
    }
  });
});

describe("cursor parser residuals, fifth pass: post-result tool lines, prototype values and exit codes (T4.43, synthetic lines; parser unchanged)", () => {
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");

  it("pins the gap: an unreadable non-tool line after result is a counted unknown that leaves the turn clean", () => {
    for (const lineObj of [
      { type: "tool_call_update" },
      { type: "telemetry", data: "ping" },
      { type: "progress", pct: 50 },
    ]) {
      const { events, a } = parse([INIT(), RESULT(), line(lineObj)]);
      expect(events.at(-1), JSON.stringify(lineObj)).toEqual({ kind: "unknown", rawType: lineObj.type });
      expect(a.extractResult(events, EXIT_OK), JSON.stringify(lineObj)).toEqual({
        ok: true,
        unknownEventCount: 1,
        nativeSessionId: SID,
      });
    }
    // An unreadable line typed tool_call matches startsWith("tool_call:") and fails the run.
    const call = parse([INIT(), RESULT(), line({ type: "tool_call" })]).events;
    expect(adapter().extractResult(call, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
  });

  it("fixture trailing_bare_update replays an unreadable update after result at exit 0 to success (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("trailing_bare_update"),
      request: {
        runId: "run_cursor_t443_trailing_bare",
        objective: "synthetic cursor objective",
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

  it("pins the gap: an update after result that repeats a reported call is deduplicated, so the order check sees nothing", () => {
    const before = TOOL("started", { shellToolCall: { args: { command: "ls" } } }, "t1");
    const repeat = TOOL("completed", { shellToolCall: { args: { command: "ls" } } }, "t1");
    const { events, a } = parse([INIT(), before, RESULT(), repeat]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "ls" },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });

    // A swapped command on the same call after result is reported, tripping the order check and the guard.
    const swapped = TOOL("completed", { shellToolCall: { args: { command: "git push origin main" } } }, "t1");
    expect(a.extractResult(parse([INIT(), before, RESULT(), swapped]).events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    expect(a.extractResult(guarded([INIT(), before, RESULT(), swapped]), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("the trailing-tool detail replaces a two-result detail: the code is OUTPUT_PROTOCOL_ERROR, the first cause is replaced", () => {
    const tool = TOOL("started", { shellToolCall: { args: { command: "ls" } } });
    const twoResults = parse([RESULT(), RESULT()]).events;
    expect(adapter().extractResult(twoResults, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
    });
    expect(adapter().extractResult(parse([RESULT(), RESULT(), tool]).events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    // A tool call between the two result lines is before the final result, so the two-result detail stands.
    expect(adapter().extractResult(parse([RESULT(), tool, RESULT()]).events, EXIT_OK)).toMatchObject({
      failureDetail: "protocol: more than one result line",
    });
  });

  it("a prototype-named model or backing provider shadows its fallback key and binds none (as an empty one)", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      const { events } = parse([
        INIT({
          model: name,
          model_id: "cursor-fallback-model",
          backing_provider: name,
          backingProvider: "backing-fallback",
        }),
      ]);
      expect(bound(events), name).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    }
  });

  it("tool calls with prototype-named keys emit kind other and no command or target", () => {
    for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
      const { events } = parse([TOOL("started", { [name]: { args: { command: "git status" } } })]);
      expect(
        events.filter((e) => e.kind === "tool_call"),
        name,
      ).toEqual([{ kind: "tool_call", tool: "other", name }]);
    }
  });

  it("a command is never clipped (a target is), so a Git write at the end of a long command still reaches the guard", () => {
    const command = `echo ${"x".repeat(5_000)} && git push origin main`;
    const call = TOOL("started", { shellToolCall: { args: { command } } });
    expect(parse([call]).events).toEqual([{ kind: "tool_call", tool: "shell", name: "shellToolCall", command }]);
    expect(adapter().extractResult(guarded([call, RESULT()]), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("call_id correlation: empty string falls back to key, while numeric string is preserved as prefix", () => {
    const { events } = parse([
      TOOL("started", { shellToolCall: { args: { command: "git status" } } }, ""),
      TOOL("completed", { shellToolCall: { args: { command: "git status" } } }, ""),
      TOOL("completed", { shellToolCall: { args: { command: "git push origin main" } } }, ""),
    ]);
    // The repeat is deduplicated because stepId is key ("shellToolCall"); the swapped command is reported.
    expect(events).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git status" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
    ]);
    // With call_id: "0", stepId is "0:shellToolCall", so it is treated as its own step.
    const withZero = parse([TOOL("started", { shellToolCall: { args: { command: "git status" } } }, "0")]);
    expect(withZero.events).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git status" },
    ]);
  });

  it("usage is read from result.usage only: counters at root or non-numeric counters are dropped", () => {
    const rootOnly = parse([
      line({ type: "result", subtype: "success", session_id: SID, inputTokens: 10, totalTokens: 10 }),
    ]).events;
    expect(rootOnly.filter((e) => e.kind === "usage")).toEqual([]);

    const fractional = parse([RESULT({ usage: { inputTokens: 1.5, outputTokens: 0 } })]).events;
    expect(fractional.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { inputTokens: 1.5, outputTokens: 0 } },
    ]);
  });

  it("extractResult honours the compiled expected exit codes rather than a hard-coded 0", () => {
    const { events } = parse([RESULT()]);
    expect(adapter().extractResult(events, { ...EXIT_OK, exitCode: 2, expectedExitCodes: [0, 2] })).toMatchObject({
      ok: true,
    });
    expect(adapter().extractResult(events, { ...EXIT_OK, exitCode: 0, expectedExitCodes: [2] })).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 0",
    });
    expect(adapter().extractResult(events, { ...EXIT_OK, exitCode: null })).toMatchObject({
      ok: false,
    });
  });
});
