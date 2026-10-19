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
 * Sixth pass (as Antigravity T4.33 #448 and Grok T4.26 #449): result-only streams (the result binds model and backing
 * vendor together, replayed through fixture `backing_result_only.jsonl` by conformance and `RunLifecycle`), framing
 * (whitespace, byte-order mark), refusal shapes (presence not value, multi-key lines, call_id fallback). Pinned gaps:
 * `apiKeySource` is checked on `system`/`init` only; a duplicated JSON key resolves to its last value, so it can flip a
 * result or hide a tool call from the guard; a repeated `started` line is reported again; a string `result.error`
 * shadows the entry's permission text; an empty session id is absent to the parser but refused by `resumeArgs`.
 * Seventh pass (as Grok, OpenCode and Antigravity seventh passes; T4.6, FR-ADP-10): the credential source is checked on
 * every `init`, so a late same-id `init` after a clean result fails `AUTH_REQUIRED`; `init` and a result-only stream
 * bind model and backing vendor through the same rules (aliases, empty, prototype names, whitespace, 128-character clip);
 * long unknown types and tool names clip to 64; a non-object `tool_call` is a counted unknown; usage keeps `-0` and very
 * large finite counters; resume from a result-only binding compiles as from an `init` binding. Pinned gaps: a refusal on a
 * `started` line is never reported (fixture `denied_on_started.jsonl` replays to success); clipping counts UTF-16 code
 * units, so a clipped model, vendor or target can end in half a surrogate pair.
 * Eighth pass (as the Grok and Antigravity eighth passes; T4.6, FR-ADP-10, FR-SES-03): a started-line refusal of a Git
 * write still reaches the tool-call guard (fixture `denied_on_started_git.jsonl` replays to `PERMISSION_BLOCKED`); after
 * the result a started refusal fails on order while a completed refusal fails as a denial; init-first and result-first
 * streams with the same fields bind the same event once; non-tool lines after the result stay clean, a subtype-less
 * second result does not; resume argv is compile argv plus `--resume <id>` and the id a failed run keeps resumes as a
 * clean one. Pinned gaps: a started refusal followed by a clean completed is never reported; an id-less result leaves the
 * slot open, so a late `init` binds id, model and vendor after the result (fixture `late_init_after_idless_result.jsonl`
 * replays to success); a case or spelling variant of the `tool_call` type after the result is an unknown the guard never
 * sees (fixture `trailing_tool_type_variant.jsonl` replays a Git write to success).
 * Ninth pass (T4.6, FR-ADP-10, FR-SES-03, FR-CAP-01): refusal-container fallback and refusal-text shapes (a
 * `result.rejected` object is the parameter container when no `args` family key exists, so a command smuggled inside a
 * refusal reaches the guard from both `started` and `completed` lines, fixture `denied_rejected_command.jsonl`; the
 * permission-text regex is case-insensitive, needs the literal space in `not permitted`, and matches `permission` as a
 * substring; multi-key completed lines emit each key's call then denial in key order); late-init persistence and alias
 * equivalence (fixture `late_init_after_idless_result.jsonl` through RunLifecycle stores the late model and backing
 * vendor on the provider binding, while the usage row, stamped by `usageObservationsFromEvents` before the late
 * binding, keeps null model and vendor; session-id aliases resolve before the id comparison, so one id under two keys
 * never conflicts, while a late unsafe id after an id-less result fails closed with no session); trailing unknowns (the
 * rawType clip boundary is exact at 64, an unrecorded trailing `tool_call` subtype `queued` is an unknown plus a reported
 * call whose Git write the guard sees, fixture `trailing_tool_queued.jsonl`, and the trailing-tool detail rewrite applies
 * only when classification is OUTPUT_PROTOCOL_ERROR); resume parity (flag-like ids refused, trailing-punctuation ids
 * safe, a returned resume invocation is mutable without leaking into the next compile); hostile usage token shapes
 * (per-key type gating keeps only finite non-negative numbers, prototype-named and `__proto__` keys and unrecorded
 * spellings such as `cost` never fabricate counters, an all-hostile first result also drops the second result's
 * counters). Parser unchanged.
 * Tenth pass (T4.6, FR-ADP-10, FR-SES-03): late session binding after an id-less result (a first id on a trailing
 * unknown or tool_call never binds, fixtures `late_id_on_trailing_unknown.jsonl` and `late_id_on_trailing_tool.jsonl`;
 * a trailing `system`/`init` after a trailing tool still binds; a whitespace id is unsafe while empty stays unbound);
 * trailing events after finish (the trailing-tool detail rewrites only OUTPUT_PROTOCOL_ERROR; two trailing tools keep
 * it once; a `type: permission_denied` line is unknown, never a denial); resume argv identity (prompt on stdin even
 * when it looks like `--resume`, never `--resume=` or `-r`, flag-value ids, empty objective); denied tool interactions
 * (case-variant refusal keys never deny, fixture `denied_key_case_variant.jsonl`; a Git write with those keys still
 * reaches the guard; a progress-line refusal after result is a denial that outranks the trailing unknown; a string
 * `result` is not a denial). Parser unchanged.
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

const adapter = (opts = {}) =>
  new CursorAdapter({ executable: "/opt/synthetic/cursor-agent", bwrap: "/opt/synthetic/bwrap", ...opts });
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
    expect(first.argv.slice(first.argv.indexOf("--") + 1).slice(0, 3)).toEqual([
      "/opt/synthetic/cursor-agent",
      "--launcher-a",
      "x",
    ]);
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

describe("cursor parser residuals, sixth pass: result-only streams, framing, tool repeats and refusal shapes (T4.43, T4.6, FR-ADP-10; synthetic lines; parser unchanged)", () => {
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");
  const LS = { shellToolCall: { args: { command: "ls" } } };
  const PUSH = { shellToolCall: { args: { command: "git push origin main" } } };

  it("pins the gap: apiKeySource is read on system/init only, so a result-only stream or a result naming another source succeeds", () => {
    const resultOnly = parse([RESULT({ apiKeySource: "api_key" })]);
    expect(resultOnly.events.filter((e) => e.kind === "provider_error")).toEqual([]);
    expect(resultOnly.a.extractResult(resultOnly.events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
    const afterLogin = parse([INIT(), RESULT({ apiKeySource: "env" })]);
    expect(afterLogin.a.extractResult(afterLogin.events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });

    // An init that binds no id is still checked: its credential error stands and the result binds the id.
    const idless = parse([INIT({ session_id: undefined, apiKeySource: "env" }), RESULT()]);
    expect(idless.events[0]).toEqual({
      kind: "provider_error",
      category: "auth",
      message: "credential source env is not the native login; run `cursor-agent login`",
    });
    expect(idless.a.extractResult(idless.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      nativeSessionId: SID,
    });
  });

  it("a result-only stream binds the result's model and backing vendor together (single-result shape, Assumption)", () => {
    const { events, a } = parse([
      RESULT({
        model: "Synthetic Model 3",
        backing_provider: "backing-y",
        backingProvider: "camel-ignored",
      }),
    ]);
    expect(events).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "Synthetic Model 3",
        backingProvider: "backing-y",
      },
      {
        kind: "usage",
        source: "provider_reported",
        metrics: { inputTokens: 10, outputTokens: 2 },
      },
      { kind: "result", ok: true },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
    // A backing vendor without a model binds alone; the harness name is never put in its place.
    expect(bound(parse([RESULT({ backingProvider: "backing-z" })]).events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        backingProvider: "backing-z",
      },
    ]);
  });

  it("fixture backing_result_only replays through conformance to success with the result's session id", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("backing_result_only"),
      request: {
        runId: "run_cursor_backing_result_only",
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
      summary: "Answered from a result-only stream.",
    });
  });

  it("fixture backing_result_only through RunLifecycle stores harness cursor beside backing vendor backing-y and the result model", async () => {
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
      adapters: new AdapterRegistry().register(replayAdapter("backing_result_only")),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
    });
    lifecycle.start();
    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "a vendor reported on a result-only stream",
        workspace: repo,
        trustProfile: "privileged",
        provider: "cursor",
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });
      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      expect(ledger.listProviderBindings(metaSessionId)).toEqual([
        expect.objectContaining({
          provider: "cursor",
          harness: "cursor",
          backing_provider: "backing-y",
          model: "Synthetic Model 3",
          native_session_id: DEFAULT_SESSION_ID,
        }),
      ]);
      const rows = ledger.listUsageObservationsForRun(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "cursor",
        harness: "cursor",
        backing_provider: "backing-y",
        model: "Synthetic Model 3",
        source: "provider_reported",
      });
      expect(JSON.stringify(rows)).not.toContain("api_key");
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  });

  it("framing: surrounding whitespace parses; a byte-order mark is a counted framing error with no events", () => {
    const padded = parse([`  ${RESULT()}\t `]);
    expect(padded.events.at(-1)).toEqual({ kind: "result", ok: true });
    const bom = parse([`﻿${RESULT()}`]);
    expect(bom.events).toEqual([]);
    expect(bom.state).toEqual({ lines: 1, unknownEvents: 0 });
  });

  it("pins the gap: a duplicated JSON key resolves to its last value, so a later key can flip a result or hide a tool call", () => {
    const flipped = `{"type":"result","subtype":"error","is_error":true,"session_id":"${SID}","subtype":"success","is_error":false}`;
    const r = parse([flipped]);
    expect(r.events.at(-1)).toEqual({ kind: "result", ok: true });
    expect(r.a.extractResult(r.events, EXIT_OK)).toMatchObject({
      ok: true,
      nativeSessionId: SID,
    });

    // A tool_call line whose second `type` is thinking is dropped whole: the guard never sees its Git write.
    const hidden =
      '{"type":"tool_call","subtype":"started","call_id":"c1",' +
      '"tool_call":{"shellToolCall":{"args":{"command":"git push origin main"}}},"type":"thinking"}';
    const h = parse([INIT(), hidden, RESULT()]);
    expect(h.events.filter((e) => e.kind === "tool_call")).toEqual([]);
    expect(adapter().extractResult(guarded([INIT(), hidden, RESULT()]), EXIT_OK)).toMatchObject({ ok: true });
    // The same line without the duplicate key is blocked.
    expect(adapter().extractResult(guarded([INIT(), TOOL("started", PUSH), RESULT()]), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("pins the asymmetry: a repeated started line is reported again, so a started repeat after result fails the run", () => {
    const started = TOOL("started", LS, "t1");
    const twice = parse([started, started]).events;
    expect(twice).toEqual([
      {
        kind: "tool_call",
        tool: "shell",
        name: "shellToolCall",
        command: "ls",
      },
      {
        kind: "tool_call",
        tool: "shell",
        name: "shellToolCall",
        command: "ls",
      },
    ]);
    expect(adapter().extractResult(parse([INIT(), started, RESULT(), started]).events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    // A progress repeat reports nothing new, but its unknown `tool_call:progress` still trips the order check.
    const progress = parse([INIT(), started, RESULT(), TOOL("progress", LS, "t1")]).events;
    expect(progress.at(-1)).toEqual({
      kind: "unknown",
      rawType: "tool_call:progress",
    });
    expect(adapter().extractResult(progress, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    // Only a completed repeat is silent (fifth pass).
    expect(
      adapter().extractResult(parse([INIT(), started, RESULT(), TOOL("completed", LS, "t1")]).events, EXIT_OK),
    ).toMatchObject({ ok: true });
  });

  it("a refusal key counts by presence, not value: null, false, 0 and an empty string are each a denial", () => {
    for (const result of [
      { rejected: null },
      { rejected: false },
      { permissionDenied: 0 },
      { permission_denied: "" },
      { denied: false },
      { blocked: null },
    ]) {
      const label = JSON.stringify(result);
      const call = TOOL("completed", {
        shellToolCall: { args: { command: "ls" }, result },
      });
      const { events, a } = parse([INIT(), call, RESULT()]);
      expect(
        events.filter((e) => e.kind === "permission_denied"),
        label,
      ).toEqual([{ kind: "permission_denied", tool: "shellToolCall" }]);
      expect(a.extractResult(events, EXIT_OK), label).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: "denied: shellToolCall",
      });
    }
    const success = parse([
      INIT(),
      TOOL("completed", {
        shellToolCall: { args: { command: "ls" }, result: { success: {} } },
      }),
      RESULT(),
    ]);
    expect(success.a.extractResult(success.events, EXIT_OK)).toMatchObject({
      ok: true,
    });
  });

  it("pins the gap: a string result.error shadows the entry's error, so permission text on the entry is missed", () => {
    const run = (entry: Record<string, unknown>) => {
      const { events, a } = parse([
        INIT(),
        TOOL("completed", {
          shellToolCall: { args: { command: "ls" }, ...entry },
        }),
        RESULT(),
      ]);
      return a.extractResult(events, EXIT_OK);
    };
    expect(run({ error: "Permission denied by policy" })).toMatchObject({
      failureCode: "PERMISSION_BLOCKED",
    });
    // A non-string result.error falls through to the entry's text.
    expect(run({ result: { error: 42 }, error: "Permission denied by policy" })).toMatchObject({
      failureCode: "PERMISSION_BLOCKED",
    });
    // A string result.error wins, even when it is unrelated text.
    expect(
      run({
        result: { error: "timed out" },
        error: "Permission denied by policy",
      }),
    ).toMatchObject({ ok: true });
  });

  it("a completed line with a clean key and a refused key reports both calls and one denial naming the refused key", () => {
    const { events, a } = parse([
      TOOL("completed", {
        readToolCall: { args: { path: "a.txt" }, result: { success: {} } },
        shellToolCall: { args: { command: "ls" }, result: { rejected: {} } },
      }),
      RESULT(),
    ]);
    expect(events.slice(0, 3)).toEqual([
      {
        kind: "tool_call",
        tool: "read",
        name: "readToolCall",
        target: "a.txt",
      },
      {
        kind: "tool_call",
        tool: "shell",
        name: "shellToolCall",
        command: "ls",
      },
      { kind: "permission_denied", tool: "shellToolCall" },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: shellToolCall",
    });
  });

  it("a non-string call_id falls through to callId, and with neither a string the tool key is the step id", () => {
    const raw = (subtype: string, ids: Record<string, unknown>, call: Record<string, unknown>) =>
      line({ type: "tool_call", subtype, ...ids, tool_call: call });
    const viaCamel = parse([
      raw("started", { call_id: 7, callId: "c2" }, LS),
      raw("completed", { callId: "c2" }, LS),
      raw("completed", { call_id: "c2" }, LS),
      raw("completed", { call_id: "c3" }, LS),
    ]).events;
    // c2 is one step (deduplicated); c3 is another call.
    expect(viaCamel).toEqual([
      {
        kind: "tool_call",
        tool: "shell",
        name: "shellToolCall",
        command: "ls",
      },
      {
        kind: "tool_call",
        tool: "shell",
        name: "shellToolCall",
        command: "ls",
      },
    ]);
    const neither = parse([
      raw("started", { call_id: 7, callId: { id: "x" } }, LS),
      raw("completed", {}, LS),
      raw("completed", { callId: null }, PUSH),
    ]).events;
    expect(neither).toEqual([
      {
        kind: "tool_call",
        tool: "shell",
        name: "shellToolCall",
        command: "ls",
      },
      {
        kind: "tool_call",
        tool: "shell",
        name: "shellToolCall",
        command: "git push origin main",
      },
    ]);
  });

  it("pins the asymmetry: an empty session id is absent to the parser (no error, nothing bound) but refused by resumeArgs", () => {
    const { events, state, a } = parse([INIT({ session_id: "" }), RESULT({ session_id: "" })]);
    expect(bound(events)).toEqual([]);
    expect(events.filter((e) => e.kind === "provider_error")).toEqual([]);
    expect(state.nativeSessionId).toBeUndefined();
    // A success with no native session id: nothing can be resumed from it.
    expect(a.extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
    });
    const req: CompileRequest = {
      runId: "run_cursor_t443_residual_p6",
      objective: "synthetic cursor objective",
      constraints: [],
      workspace: { cwd: "/w", writable: true },
      bypassApproved: true,
    };
    expect(a.resumeArgs({ provider: "cursor", nativeSessionId: "" }, req, PRIVILEGED_BYPASS_PROFILE)).toEqual({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: "native session id is not a safe single argument",
    });
  });
});

describe("cursor parser residuals, seventh pass: refusals on started lines, late credential checks, clip boundaries and backing parity (T4.43, T4.6, FR-ADP-10; synthetic lines; parser unchanged)", () => {
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");
  const REFUSED = (extra: Record<string, unknown>) => ({ shellToolCall: { args: { command: "ls" }, ...extra } });
  const req: CompileRequest = {
    runId: "run_cursor_t443_residual_p7",
    objective: "synthetic cursor objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };

  it("pins the gap: a refusal on a started line is never reported, while the same refusal on any other subtype is", () => {
    for (const extra of [
      { result: { rejected: {} } },
      { result: { permissionDenied: {} } },
      { result: { error: "Permission denied by policy" } },
      { error: "not permitted" },
    ]) {
      const label = JSON.stringify(extra);
      const started = parse([INIT(), TOOL("started", REFUSED(extra)), RESULT()]);
      expect(
        started.events.filter((e) => e.kind === "permission_denied"),
        label,
      ).toEqual([]);
      expect(started.a.extractResult(started.events, EXIT_OK), label).toMatchObject({ ok: true });
      for (const subtype of ["completed", "progress"]) {
        const other = parse([INIT(), TOOL(subtype, REFUSED(extra)), RESULT()]);
        expect(other.a.extractResult(other.events, EXIT_OK), `${subtype} ${label}`).toMatchObject({
          ok: false,
          failureCode: "PERMISSION_BLOCKED",
          failureDetail: "denied: shellToolCall",
        });
      }
    }
    // A completed line that only repeats the started parameters still carries the refusal.
    const pair = parse([
      INIT(),
      TOOL("started", REFUSED({})),
      TOOL("completed", REFUSED({ result: { rejected: {} } })),
      RESULT(),
    ]);
    expect(pair.events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "shellToolCall" },
    ]);
  });

  it("fixture denied_on_started replays a refusal carried only on a started line to success at exit 0 (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("denied_on_started"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
      summary: "The command was refused on start.",
    });
  });

  it("the credential source is checked on every init: a late same-id init after a clean result fails AUTH_REQUIRED", () => {
    const late = parse([INIT(), RESULT(), INIT({ apiKeySource: "env" })]);
    expect(late.events.slice(-1)).toEqual([
      {
        kind: "provider_error",
        category: "auth",
        message: "credential source env is not the native login; run `cursor-agent login`",
      },
    ]);
    expect(late.a.extractResult(late.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      nativeSessionId: SID,
    });
    // A late init naming another session and another source reports both, in the order protocol then auth.
    const both = parse([INIT(), RESULT(), INIT({ session_id: "other-session", apiKeySource: 7 })]);
    expect(both.events.slice(-2)).toEqual([
      { kind: "provider_error", category: "protocol", message: "session id changed mid-run" },
      {
        kind: "provider_error",
        category: "auth",
        message: "credential source (not a string) is not the native login; run `cursor-agent login`",
      },
    ]);
    expect(both.state.nativeSessionId).toBe(SID);
    // A late init with the native login, or with no apiKeySource key at all, adds nothing.
    for (const over of [{}, { apiKeySource: undefined }]) {
      const quiet = parse([INIT(), RESULT(), INIT(over)]);
      expect(quiet.a.extractResult(quiet.events, EXIT_OK), JSON.stringify(over)).toMatchObject({ ok: true });
    }
  });

  it("init and a result-only stream bind model and backing vendor through the same rules (parity)", () => {
    const long = "v".repeat(129);
    const cases: [Record<string, unknown>, { model?: string; backingProvider?: string }][] = [
      [
        { model: "M", backing_provider: "B" },
        { model: "M", backingProvider: "B" },
      ],
      [
        { modelId: "M2", backingProvider: "B2" },
        { model: "M2", backingProvider: "B2" },
      ],
      [
        { model_id: "M3", backing_provider: null, backingProvider: "B3" },
        { model: "M3", backingProvider: "B3" },
      ],
      [{ model: "", backing_provider: "" }, {}],
      [{ model: "__proto__", backing_provider: "constructor" }, {}],
      [
        { model: " ", backing_provider: "\t" },
        { model: " ", backingProvider: "\t" },
      ],
      [{ model: 5, model_id: "M4", backing_provider: 5, backingProvider: "ignored" }, { model: "M4" }],
      [
        { model: long, backing_provider: long },
        { model: `${long.slice(0, 128)}…`, backingProvider: `${long.slice(0, 128)}…` },
      ],
    ];
    for (const [fields, want] of cases) {
      const label = JSON.stringify(fields);
      const expected = [{ kind: "session_bound", nativeSessionId: SID, ...want }];
      expect(bound(parse([INIT({ model: undefined, ...fields }), RESULT()]).events), `init ${label}`).toEqual(expected);
      expect(bound(parse([RESULT(fields)]).events), `result ${label}`).toEqual(expected);
    }
    // The session-id aliases bind alike on both lines.
    for (const key of ["sessionId", "chat_id", "chatId"]) {
      const viaInit = parse([INIT({ session_id: undefined, [key]: "alias-id" })]);
      const viaResult = parse([RESULT({ session_id: undefined, [key]: "alias-id" })]);
      expect(viaInit.state.nativeSessionId, key).toBe("alias-id");
      expect(viaResult.state.nativeSessionId, key).toBe("alias-id");
    }
  });

  it("pins the gap: clipping counts UTF-16 code units, so a clipped model, backing vendor or target can end in half a surrogate pair", () => {
    const astral = "😀"; // two UTF-16 code units
    const value = `${"a".repeat(127)}${astral}`;
    const [b] = bound(parse([INIT({ model: value, backing_provider: value })]).events);
    const half = `${"a".repeat(127)}${astral[0]}…`;
    expect(b).toEqual({ kind: "session_bound", nativeSessionId: SID, model: half, backingProvider: half });
    // The clipped value ends in a lone high surrogate before the ellipsis.
    expect(half.charCodeAt(127).toString(16)).toBe("d83d");
    // Exactly 128 code units (126 + one astral character) is kept whole.
    const fits = `${"a".repeat(126)}${astral}`;
    expect(bound(parse([INIT({ model: fits })]).events)[0]).toMatchObject({ model: fits });

    const path = `${"p".repeat(511)}${astral}`;
    const [read] = parse([TOOL("started", { readToolCall: { args: { path } } })]).events;
    expect(read).toMatchObject({ kind: "tool_call", tool: "read", target: `${"p".repeat(511)}${astral[0]}…` });
  });

  it("unknown types and tool names are clipped to 64 characters; a non-object tool_call is an unknown that trips the order check", () => {
    const longType = `t${"y".repeat(80)}`;
    const t = parse([line({ type: longType })]);
    expect(t.events).toEqual([{ kind: "unknown", rawType: `${longType.slice(0, 64)}…` }]);
    const sys = parse([line({ type: "system", subtype: "s".repeat(80) })]);
    expect(sys.events).toEqual([{ kind: "unknown", rawType: `system:${"s".repeat(57)}…` }]);
    const longKey = `k${"x".repeat(80)}`;
    expect(parse([TOOL("started", { [longKey]: { args: { command: "ls" } } })]).events).toEqual([
      { kind: "tool_call", tool: "shell", name: `${longKey.slice(0, 64)}…`, command: "ls" },
    ]);

    for (const call of [["shellToolCall"], "shellToolCall", null, {}]) {
      const label = JSON.stringify(call);
      const before = parse([INIT(), TOOL("started", call as Record<string, unknown>), RESULT()]);
      expect(before.events[1], label).toEqual({ kind: "unknown", rawType: "tool_call:started" });
      expect(before.a.extractResult(before.events, EXIT_OK), label).toMatchObject({ ok: true, unknownEventCount: 1 });
      const after = parse([INIT(), RESULT(), TOOL("completed", call as Record<string, unknown>)]);
      expect(after.a.extractResult(after.events, EXIT_OK), label).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the result line",
      });
    }
  });

  it("usage counter edges: negative zero and very large finite counters are kept as given", () => {
    const { events } = parse([
      `{"type":"result","subtype":"success","is_error":false,"session_id":"${SID}","usage":{"inputTokens":-0,"outputTokens":1e308,"totalTokens":9007199254740993}}`,
    ]);
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { inputTokens: -0, outputTokens: 1e308, totalTokens: 9007199254740992 },
    });
    expect(usage?.kind === "usage" && Object.is(usage.metrics.inputTokens, -0)).toBe(true);
  });

  it("resume of a session bound from a result-only stream compiles exactly as resume of an init-bound one", () => {
    const fromResult = parse([RESULT({ chatId: "result-only-1", session_id: undefined })]);
    const fromInit = parse([INIT({ session_id: "result-only-1" }), RESULT({ session_id: "result-only-1" })]);
    const idOf = (r: ReturnType<typeof parse>) => r.a.extractResult(r.events, EXIT_OK).nativeSessionId;
    expect(idOf(fromResult)).toBe("result-only-1");
    expect(idOf(fromInit)).toBe("result-only-1");
    const a = adapter();
    const resumed = (id: string | undefined) =>
      a.resumeArgs({ provider: "cursor", nativeSessionId: id ?? "" }, req, PRIVILEGED_BYPASS_PROFILE);
    expect(resumed(idOf(fromResult))).toEqual(resumed(idOf(fromInit)));
    expect(resumed(idOf(fromResult))).toMatchObject({ argv: expect.arrayContaining(["--resume", "result-only-1"]) });
  });
});

describe("cursor parser residuals, eighth pass: denied-on-started interactions, late init binding, trailing lines after result and resume argv parity (T4.43, T4.6, FR-ADP-10, FR-SES-03; synthetic lines; parser unchanged)", () => {
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");
  const denials = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "permission_denied");
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => {
    const r = parse(lines);
    return { ...r, events: r.events.map((e) => guardEvent(e, ctx)) };
  };
  const REJECTED = { result: { rejected: {} } };
  const SHELL = (command: string, extra: Record<string, unknown> = {}) => ({
    shellToolCall: { args: { command }, ...extra },
  });
  const req: CompileRequest = {
    runId: "run_cursor_t443_residual_p8",
    objective: "synthetic cursor objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const resumed = (id: string, a = adapter()) =>
    a.resumeArgs({ provider: "cursor", nativeSessionId: id }, req, PRIVILEGED_BYPASS_PROFILE);

  it("pins the gap across a pair: a refusal on started followed by a clean completed for the same call is never reported", () => {
    const pair = parse([
      INIT(),
      TOOL("started", SHELL("rm -rf build", REJECTED)),
      TOOL("completed", SHELL("rm -rf build")),
      RESULT(),
    ]);
    expect(denials(pair.events)).toEqual([]);
    // The completed line repeats the started command, so it adds no second tool_call either.
    expect(pair.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "rm -rf build" },
    ]);
    expect(pair.a.extractResult(pair.events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
    // A completed refusal for another call_id is reported once, naming its key; the started refusal still is not.
    const other = parse([
      INIT(),
      TOOL("started", SHELL("rm -rf build", REJECTED), "c1"),
      TOOL("completed", SHELL("ls", REJECTED), "c2"),
      RESULT(),
    ]);
    expect(denials(other.events)).toEqual([{ kind: "permission_denied", tool: "shellToolCall" }]);
    expect(other.events.filter((e) => e.kind === "tool_call").map((e) => e.kind === "tool_call" && e.command)).toEqual([
      "rm -rf build",
      "ls",
    ]);
  });

  it("a refusal on started never hides the command from the guard: a Git write there is PERMISSION_BLOCKED", () => {
    const r = guarded([INIT(), TOOL("started", SHELL("git push origin main", REJECTED)), RESULT()]);
    expect(denials(r.events)).toEqual([]);
    const res = r.a.extractResult(r.events, EXIT_OK);
    expect(res).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID });
    expect(res.failureDetail).toMatch(/^git write attempted/);
  });

  it("fixture denied_on_started_git replays a started-line refusal of a Git write to PERMISSION_BLOCKED through the guard", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("denied_on_started_git"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
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

  it("pins the asymmetry: after the result a started refusal fails on order, while a completed refusal fails as a denial", () => {
    const r = parse([INIT(), RESULT(), TOOL("started", SHELL("ls", REJECTED))]);
    expect(denials(r.events)).toEqual([]);
    expect(r.a.extractResult(r.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    // The same refusal on a completed line after the result is reported, and the denial outranks the order check.
    const done = parse([INIT(), RESULT(), TOOL("completed", SHELL("ls", REJECTED))]);
    expect(denials(done.events)).toEqual([{ kind: "permission_denied", tool: "shellToolCall" }]);
    expect(done.a.extractResult(done.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: shellToolCall",
    });
  });

  it("pins the gap: an id-less result leaves the slot open, so a late init binds its id, model and vendor after the result", () => {
    const r = parse([
      RESULT({ session_id: undefined }),
      INIT({ model: "Late Model", backing_provider: "backing-late" }),
    ]);
    expect(r.events.map((e) => e.kind)).toEqual(["usage", "result", "session_bound"]);
    expect(bound(r.events)).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "Late Model", backingProvider: "backing-late" },
    ]);
    expect(r.a.extractResult(r.events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: SID });
    // The late init's credential source is still checked after the result.
    const auth = parse([RESULT({ session_id: undefined }), INIT({ apiKeySource: "env" })]);
    expect(bound(auth.events)).toHaveLength(1);
    expect(auth.a.extractResult(auth.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      nativeSessionId: SID,
    });
    // A late init with no usable id binds nothing and loses its vendor; the run is clean but has no session.
    const idless = parse([RESULT({ session_id: undefined }), INIT({ session_id: undefined, backing_provider: "b" })]);
    expect(bound(idless.events)).toEqual([]);
    expect(idless.a.extractResult(idless.events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0 });
  });

  it("fixture late_init_after_idless_result replays a binding after the result to success with the late id (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("late_init_after_idless_result"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
      summary: "ok",
    });
  });

  it("init-first and result-first streams carrying the same fields bind the same session_bound event, once", () => {
    const fields = { model: "Same Model", backing_provider: "backing-same" };
    const initFirst = parse([INIT(fields), RESULT(fields)]);
    const resultFirst = parse([RESULT(fields), INIT(fields)]);
    expect(bound(initFirst.events)).toEqual(bound(resultFirst.events));
    expect(bound(initFirst.events)).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "Same Model", backingProvider: "backing-same" },
    ]);
    expect(initFirst.a.extractResult(initFirst.events, EXIT_OK)).toEqual(
      resultFirst.a.extractResult(resultFirst.events, EXIT_OK),
    );
    // After a failed result, a late same-id init adds nothing: the failure stands as reported by the result.
    const failed = parse([RESULT({ subtype: "error", is_error: true }), INIT(fields)]);
    expect(bound(failed.events)).toHaveLength(1);
    expect(failed.a.extractResult(failed.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "result error",
      nativeSessionId: SID,
    });
  });

  it("non-tool lines after the result are counted unknowns (or nothing) and leave a clean turn clean", () => {
    const trailing: [string, number][] = [
      [line({ type: "brand_new" }), 1],
      [line({ type: "system", subtype: "compact" }), 1],
      [line({ no_type: true }), 1],
      [line([1, 2]), 1],
      [line(7), 1],
      [line("text"), 1],
      [line(null), 1],
      [line({ type: "assistant", message: { content: { text: "x" } } }), 1],
      [line({ type: "assistant", message: { content: "" } }), 0],
      [line({ type: "thinking" }), 0],
      [line({ type: "user" }), 0],
      ["{not json", 0],
      ["", 0],
    ];
    for (const [l, unknown] of trailing) {
      const r = parse([INIT(), RESULT(), l]);
      expect(r.state.lines, l).toBe(3);
      expect(r.a.extractResult(r.events, EXIT_OK), l).toEqual({
        ok: true,
        unknownEventCount: unknown,
        nativeSessionId: SID,
      });
    }
    // A subtype-less result after a clean result is a second result, not a harmless unknown.
    const again = parse([INIT(), RESULT(), line({ type: "result" })]);
    expect(again.a.extractResult(again.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
      unknownEventCount: 1,
    });
  });

  it("pins the gap: a case or spelling variant of the tool_call type after the result is an unknown the guard never sees", () => {
    for (const type of ["Tool_Call", "TOOL_CALL", "tool_call ", " tool_call", "toolCall", "tool-call"]) {
      const r = guarded([
        INIT(),
        RESULT(),
        line({ type, subtype: "started", call_id: "c9", tool_call: SHELL("git push origin main"), session_id: SID }),
      ]);
      expect(r.events.at(-1), JSON.stringify(type)).toEqual({ kind: "unknown", rawType: type });
      expect(r.a.extractResult(r.events, EXIT_OK), JSON.stringify(type)).toEqual({
        ok: true,
        unknownEventCount: 1,
        nativeSessionId: SID,
      });
    }
    // A case variant of the subtype keeps the exact type, so the order check and the guard both fire.
    const sub = guarded([INIT(), RESULT(), TOOL("Started", SHELL("git push origin main"))]);
    expect(sub.events.slice(-2).map((e) => e.kind)).toEqual(["unknown", "tool_call"]);
    const res = sub.a.extractResult(sub.events, EXIT_OK);
    expect(res).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(res.failureDetail).toMatch(/^git write attempted/);
  });

  it("fixture trailing_tool_type_variant replays a Tool_Call Git write after the result to success at exit 0 (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("trailing_tool_type_variant"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 1,
      summary: "Done.",
    });
  });

  it("resume argv is compile argv plus `--resume <id>` for every safe id shape, and two resumes differ only in the id", () => {
    const a = adapter();
    const first = a.compile(req, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in first) throw new Error(first.detail);
    for (const id of [SID, "A", "a:b.c-d_9", `a${"b".repeat(255)}`]) {
      expect(resumed(id, a), id).toEqual({ ...first, argv: [...first.argv, "--resume", id] });
    }
    const x = resumed("session-x", a);
    const y = resumed("session-y", a);
    if ("ineligible" in x || "ineligible" in y) throw new Error("resume refused");
    expect(x.argv.slice(0, -1)).toEqual(y.argv.slice(0, -1));
    expect({ ...x, argv: [] }).toEqual({ ...y, argv: [] });
    // Resuming twice never accumulates a second `--resume`, and `--continue` is never emitted.
    const twice = resumed("session-x", a);
    if ("ineligible" in twice) throw new Error(twice.detail);
    expect(twice.argv.filter((v) => v === "--resume")).toHaveLength(1);
    expect(twice.argv).not.toContain("--continue");
  });

  it("the id a failed run keeps is resumed exactly as the id of a clean run", () => {
    const failing: [string, (string | object)[]][] = [
      ["denied", [INIT(), TOOL("completed", SHELL("ls", REJECTED)), RESULT()]],
      ["auth", [INIT({ apiKeySource: "env" }), RESULT()]],
      ["changed id", [INIT(), RESULT({ session_id: "other-session" })]],
      ["late init changed id", [RESULT(), INIT({ session_id: "other-session" })]],
      ["failed result", [INIT(), RESULT({ subtype: "error", is_error: true })]],
      ["late id after id-less result", [RESULT({ session_id: undefined }), INIT()]],
    ];
    const clean = parse([INIT(), RESULT()]);
    const cleanId = clean.a.extractResult(clean.events, EXIT_OK).nativeSessionId;
    expect(cleanId).toBe(SID);
    for (const [label, lines] of failing) {
      const r = parse(lines);
      const id = r.a.extractResult(r.events, EXIT_OK).nativeSessionId;
      expect(id, label).toBe(SID);
      expect(resumed(id ?? ""), label).toEqual(resumed(SID));
    }
  });
});

describe("cursor parser residuals, ninth pass: refusal-container fallback, late-init persistence and aliases, trailing clip boundary and unrecorded subtypes, resume id edges and usage key gating (T4.43, T4.6, FR-ADP-10, FR-SES-03, FR-CAP-01; synthetic lines; parser unchanged)", () => {
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");
  const denials = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "permission_denied");
  const usages = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "usage");
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => {
    const r = parse(lines);
    return { ...r, events: r.events.map((e) => guardEvent(e, ctx)) };
  };
  const PUSH = { shellToolCall: { args: { command: "git push origin main" } } };
  const REFUSED_PUSH = {
    shellToolCall: { result: { rejected: { command: "git push origin main", reason: "not allowed" } } },
  };
  const req: CompileRequest = {
    runId: "run_cursor_t443_residual_p9",
    objective: "synthetic cursor objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };

  it("pins the gap: a started line whose refusal object carries the command reports the command (never a denial), so the guard still sees the Git write", () => {
    const { events, a } = parse([INIT(), TOOL("started", REFUSED_PUSH), RESULT()]);
    // The parameter-container fallback treats result.rejected as the container, so the smuggled command is reported.
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
    ]);
    // A started line never reports a refusal, and without the guard the run would end clean.
    expect(denials(events)).toEqual([]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });
    const g = guarded([INIT(), TOOL("started", REFUSED_PUSH), RESULT()]);
    const res = g.a.extractResult(g.events, EXIT_OK);
    expect(res).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID });
    expect(res.failureDetail).toMatch(/^git write attempted/);
  });

  it("fixture denied_rejected_command replays a command smuggled in a started-line refusal object to PERMISSION_BLOCKED", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("denied_rejected_command"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
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

  it("the same refusal-container fallback on a completed line reports the call and the denial; a seen command deduplicates", () => {
    const { events, a } = parse([INIT(), TOOL("completed", REFUSED_PUSH), RESULT()]);
    expect(events.slice(1, 3)).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
      { kind: "permission_denied", tool: "shellToolCall" },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: shellToolCall",
    });
    // A started line that already reported the command leaves only the denial new on the completed fallback.
    const pair = parse([INIT(), TOOL("started", PUSH), TOOL("completed", REFUSED_PUSH), RESULT()]);
    expect(pair.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
    ]);
    expect(denials(pair.events)).toEqual([{ kind: "permission_denied", tool: "shellToolCall" }]);
  });

  it("refusal-text edges: case-insensitive and substring matches block, hyphenated or doubled-space `not permitted` and non-string errors do not", () => {
    const run = (error: unknown) => {
      const { events, a } = parse([
        INIT(),
        TOOL("completed", { shellToolCall: { args: { command: "ls" }, error } }),
        RESULT(),
      ]);
      return a.extractResult(events, EXIT_OK);
    };
    expect(run("PERMISSION DENIED BY POLICY")).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(run("route blocked by firewall")).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    // The alternation matches `permission` anywhere, so benign text containing it is still blocked (fail closed).
    expect(run("Permission granted for the write")).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    // The space in `not permitted` is literal: hyphenated or doubled-space variants do not match.
    expect(run("Access not-permitted here")).toMatchObject({ ok: true });
    expect(run("Access not  permitted here")).toMatchObject({ ok: true });
    // A non-string error (text nested in an object) is not read.
    expect(run({ message: "Permission denied" })).toMatchObject({ ok: true });
  });

  it("a multi-key completed line reports each key's call then its denial in key order, and the first denial names the detail", () => {
    const multi = {
      readToolCall: { args: { path: "a.txt" }, result: { rejected: {} } },
      shellToolCall: { args: { command: "git push origin main" }, result: { denied: {} } },
    };
    const { events, a } = parse([INIT(), TOOL("completed", multi), RESULT()]);
    expect(events.slice(1, 5)).toEqual([
      { kind: "tool_call", tool: "read", name: "readToolCall", target: "a.txt" },
      { kind: "permission_denied", tool: "readToolCall" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
      { kind: "permission_denied", tool: "shellToolCall" },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: readToolCall",
    });
    // The guard violation on the second key's Git write outranks the first key's denial.
    const g = guarded([INIT(), TOOL("completed", multi), RESULT()]);
    const res = g.a.extractResult(g.events, EXIT_OK);
    expect(res).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(res.failureDetail).toMatch(/^git write attempted/);
  });

  it("fixture late_init_after_idless_result through RunLifecycle pins the gap: the binding row keeps the late init's model and vendor, the usage row stays null", async () => {
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
      adapters: new AdapterRegistry().register(replayAdapter("late_init_after_idless_result")),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
    });
    lifecycle.start();
    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "a session bound by a late init after an id-less result",
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
          backing_provider: "backing-late",
          native_session_id: DEFAULT_SESSION_ID,
        }),
      ]);
      const rows = ledger.listUsageObservationsForRun(runId);
      expect(rows).toHaveLength(1);
      // Pinned gap: usageObservationsFromEvents stamps a usage row with the session_bound that preceded it; the usage
      // event here arrives on the result line before the late init binds, so the row keeps null model and vendor even
      // though the provider binding written after the run carries both.
      expect(rows[0]).toMatchObject({
        provider: "cursor",
        harness: "cursor",
        backing_provider: null,
        model: null,
        source: "provider_reported",
      });
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  });

  it("session-id aliases resolve before the id comparison, so one id under two keys never conflicts", () => {
    const combos: (string | object)[][] = [
      [
        RESULT({ session_id: undefined, chatId: "alias-target" }),
        INIT({ session_id: "alias-target", model: "Late Model" }),
      ],
      [
        RESULT({ session_id: undefined, sessionId: "alias-target" }),
        INIT({ session_id: undefined, chat_id: "alias-target" }),
      ],
      [
        INIT({ session_id: undefined, chatId: "alias-target", model: undefined }),
        RESULT({ session_id: "alias-target" }),
      ],
    ];
    for (const lines of combos) {
      const { events, state, a } = parse(lines);
      expect(
        events.filter((e) => e.kind === "provider_error"),
        JSON.stringify(lines),
      ).toEqual([]);
      expect(state.nativeSessionId, JSON.stringify(lines)).toBe("alias-target");
      expect(a.extractResult(events, EXIT_OK), JSON.stringify(lines)).toMatchObject({
        ok: true,
        nativeSessionId: "alias-target",
      });
      // The first binding is still final: the late line's model and vendor never amend it.
      expect(bound(events), JSON.stringify(lines)).toEqual([
        { kind: "session_bound", nativeSessionId: "alias-target" },
      ]);
    }
    // A different value under another alias still conflicts and keeps the first id.
    const conflict = parse([
      RESULT({ session_id: undefined, chatId: "alias-target" }),
      INIT({ session_id: "other-value" }),
    ]);
    expect(conflict.events.filter((e) => e.kind === "provider_error")).toEqual([
      { kind: "provider_error", category: "protocol", message: "session id changed mid-run" },
    ]);
    expect(conflict.state.nativeSessionId).toBe("alias-target");
  });

  it("a late init with an unsafe id after an id-less result binds nothing and fails closed with no session", () => {
    const { events, state, a } = parse([RESULT({ session_id: undefined }), INIT({ session_id: "-x" })]);
    expect(events.filter((e) => e.kind === "provider_error")).toEqual([
      { kind: "provider_error", category: "protocol", message: "session id is not a safe argument" },
    ]);
    expect(bound(events)).toEqual([]);
    expect(state.nativeSessionId).toBeUndefined();
    const r = a.extractResult(events, EXIT_OK);
    expect(r).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id is not a safe argument",
    });
    expect(r).not.toHaveProperty("nativeSessionId");
  });

  it("pins the boundary: a trailing unknown type of exactly 64 characters is kept whole; 65 clips to 64 plus the ellipsis", () => {
    const exact = `t${"y".repeat(63)}`;
    expect(exact).toHaveLength(64);
    const at = parse([INIT(), RESULT(), line({ type: exact })]);
    expect(at.events.at(-1)).toEqual({ kind: "unknown", rawType: exact });
    expect(at.a.extractResult(at.events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
    const over = `t${"y".repeat(64)}`;
    const r = parse([INIT(), RESULT(), line({ type: over })]);
    expect(r.events.at(-1)).toEqual({ kind: "unknown", rawType: `${over.slice(0, 64)}…` });
    expect(r.a.extractResult(r.events, EXIT_OK)).toMatchObject({
      ok: true,
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
    // Neither clipped rawType starts with tool_call, so the trailing-tool order check stays untripped.
  });

  it("pins the gap: a trailing tool_call line with an unrecorded subtype is an unknown plus a reported call, so the guard sees its Git write", () => {
    const lines = [INIT(), RESULT(), TOOL("queued", PUSH)];
    const { events, a } = parse(lines);
    expect(events.slice(-2)).toEqual([
      { kind: "unknown", rawType: "tool_call:queued" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
    const g = guarded(lines);
    const res = g.a.extractResult(g.events, EXIT_OK);
    expect(res).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", unknownEventCount: 1 });
    expect(res.failureDetail).toMatch(/^git write attempted/);
  });

  it("fixture trailing_tool_queued replays an unrecorded trailing tool_call subtype carrying a Git write to PERMISSION_BLOCKED", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("trailing_tool_queued"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 1,
    });
    expect(report.result?.failureDetail).toMatch(/^git write attempted/);
  });

  it("pins the asymmetry: a trailing unreadable tool_call after a failed result keeps the result's failure detail", () => {
    const { events, a } = parse([INIT(), RESULT({ subtype: "error", is_error: true }), line({ type: "tool_call" })]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "result error",
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
    // After a clean first result the same line rewrites an OUTPUT_PROTOCOL_ERROR detail (fifth pass).
    const clean = parse([INIT(), RESULT(), line({ type: "tool_call" })]);
    expect(clean.a.extractResult(clean.events, EXIT_OK)).toMatchObject({
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
  });

  it("the parser and resumeArgs agree on flag-like and trailing-punctuation id shapes", () => {
    const a = adapter();
    for (const [id, safe] of [
      ["a:", true],
      ["a-", true],
      ["a.", true],
      ["a_", true],
      ["Z_9:x-y.z", true],
      ["a", true],
      ["--", false],
      ["--resume", false],
      ["-1", false],
      ["-", false],
    ] as const) {
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      a.parseEvent(INIT({ session_id: id }), state);
      const resumed = a.resumeArgs({ provider: "cursor", nativeSessionId: id }, req, PRIVILEGED_BYPASS_PROFILE);
      expect(state.nativeSessionId === id, JSON.stringify(id)).toBe(safe);
      expect("ineligible" in resumed, JSON.stringify(id)).toBe(!safe);
      if (safe) {
        if ("ineligible" in resumed) throw new Error(resumed.detail);
        expect(resumed.argv.slice(-2), JSON.stringify(id)).toEqual(["--resume", id]);
        expect(
          resumed.argv.filter((v) => v === id),
          JSON.stringify(id),
        ).toHaveLength(1);
      }
    }
  });

  it("mutating a returned resume invocation never leaks into a later compile or resume", () => {
    const a = adapter({ launcherArgs: ["--launch", "x"] });
    const first = a.compile(req, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in first) throw new Error(first.detail);
    const resumedOnce = a.resumeArgs({ provider: "cursor", nativeSessionId: SID }, req, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in resumedOnce) throw new Error(resumedOnce.detail);
    resumedOnce.argv.push("--mutated");
    resumedOnce.policyFlags.push("--mutated");
    resumedOnce.envAllowlist.push("CURSOR_API_KEY");
    resumedOnce.timeouts.idleMs = 1;
    const again = a.compile(req, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in again) throw new Error(again.detail);
    expect(again.argv).not.toContain("--mutated");
    expect(again.policyFlags).toEqual(["--trust", "--force"]);
    expect(again.envAllowlist).toEqual(["PATH", "HOME"]);
    expect(again.timeouts.idleMs).not.toBe(1);
    const againResumed = a.resumeArgs({ provider: "cursor", nativeSessionId: SID }, req, PRIVILEGED_BYPASS_PROFILE);
    expect(againResumed).toEqual({ ...again, argv: [...again.argv, "--resume", SID] });
  });

  it("pins the gap: usage counters gate per key, so string, boolean, null, object and array counters are dropped while numeric siblings are kept", () => {
    const { events, a } = parse([
      RESULT({
        usage: {
          inputTokens: "10",
          outputTokens: true,
          cacheReadTokens: { value: 1 },
          cacheWriteTokens: [1],
          totalTokens: null,
          input_tokens: 7,
        },
      }),
    ]);
    expect(usages(events)).toEqual([{ kind: "usage", source: "provider_reported", metrics: { input_tokens: 7 } }]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });
    // Every counter hostile: no usage event at all, and the run is still clean.
    const allHostile = parse([RESULT({ usage: { inputTokens: "10", outputTokens: false } })]);
    expect(usages(allHostile.events)).toEqual([]);
    expect(allHostile.a.extractResult(allHostile.events, EXIT_OK)).toMatchObject({ ok: true });
  });

  it("prototype-named usage keys and a __proto__ payload can never fabricate counters", () => {
    const protoNamed = parse([RESULT({ usage: { toString: 10, constructor: 5, hasOwnProperty: 1 } })]);
    expect(usages(protoNamed.events)).toEqual([]);
    // An own __proto__ key in the JSON is just another unread spelling.
    const raw = (usage: string) =>
      `{"type":"result","subtype":"success","is_error":false,"session_id":"${SID}","usage":${usage}}`;
    const protoOnly = parse([raw('{"__proto__":{"inputTokens":50}}')]);
    expect(usages(protoOnly.events)).toEqual([]);
    // A legitimate key beside a __proto__ payload is still recorded.
    const mixed = parse([raw('{"__proto__":{"inputTokens":50},"inputTokens":7}')]);
    expect(usages(mixed.events)).toEqual([{ kind: "usage", source: "provider_reported", metrics: { inputTokens: 7 } }]);
  });

  it("usage keys outside the ten recorded spellings are never read, so a cost-style counter never reaches the run total", () => {
    const { events, a } = parse([RESULT({ usage: { input: 3, tokens: 4, cost: 0.25, characters: 9 } })]);
    expect(usages(events)).toEqual([]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });
  });

  it("pins the mirror gap: an all-hostile first result drops the second result's counters too, so no usage is recorded at all", () => {
    const { events, a } = parse([RESULT({ usage: { inputTokens: "bad" } }), RESULT({ usage: { inputTokens: 10 } })]);
    expect(usages(events)).toEqual([]);
    expect(a.extractResult(events, EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });
});

describe("cursor parser residuals, tenth pass: late session binding after result, trailing events after finish, resume argv identity and denied tool interactions (T4.43, T4.6, FR-ADP-10, FR-SES-03; synthetic lines; parser unchanged)", () => {
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");
  const denials = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "permission_denied");
  const ctx = { cwd: "/w", bypass: true };
  const guarded = (lines: (string | object)[]) => {
    const r = parse(lines);
    return { ...r, events: r.events.map((e) => guardEvent(e, ctx)) };
  };
  const req: CompileRequest = {
    runId: "run_cursor_t443_residual_p10",
    objective: "synthetic cursor objective",
    constraints: [],
    workspace: { cwd: "/w", writable: true },
    bypassApproved: true,
  };
  const READ = { readToolCall: { args: { path: "a.txt" } } };
  const LS = { shellToolCall: { args: { command: "ls" } } };

  it("pins the gap: a first id on a trailing non-binding line after an id-less result never binds; the run succeeds with no session", () => {
    const decoys = [
      line({ type: "session.idle", session_id: SID, backing_provider: "late-idle", model: "Idle" }),
      line({ type: "assistant", message: { content: "late" }, session_id: SID }),
      line({ type: "thinking", text: "t", session_id: SID }),
      line({ type: "user", message: { content: "p" }, session_id: SID }),
      line({ type: "tool_call_update", session_id: SID, tool_call: LS }),
    ];
    for (const trailing of decoys) {
      const { events, state, a } = parse([RESULT({ session_id: undefined }), trailing]);
      expect(bound(events), trailing).toEqual([]);
      expect(state.nativeSessionId, trailing).toBeUndefined();
      const r = a.extractResult(events, EXIT_OK);
      expect(r, trailing).toMatchObject({ ok: true });
      expect(r, trailing).not.toHaveProperty("nativeSessionId");
    }
    // A late init after that unknown still binds: the slot stayed open.
    const late = parse([
      RESULT({ session_id: undefined }),
      line({ type: "session.idle", session_id: "ignored-id" }),
      INIT({ model: "Late Model", backing_provider: "backing-late-unknown" }),
    ]);
    expect(bound(late.events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "Late Model",
        backingProvider: "backing-late-unknown",
      },
    ]);
    expect(late.a.extractResult(late.events, EXIT_OK)).toMatchObject({
      ok: true,
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
  });

  it("fixture late_id_on_trailing_unknown replays an id-less result then a session.idle id to success with no session (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("late_id_on_trailing_unknown"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: null, unknownEventCount: 1, summary: "SYNTHETIC: done" },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      unknownEventCount: 1,
      summary: "SYNTHETIC: done",
    });
    expect(report.result).not.toHaveProperty("nativeSessionId");
  });

  it("pins the gap: a first id on a trailing tool_call after an id-less result fails as trailing-tool with no session", () => {
    const { events, state, a } = parse([RESULT({ session_id: undefined }), TOOL("started", READ)]);
    expect(bound(events)).toEqual([]);
    expect(state.nativeSessionId).toBeUndefined();
    const r = a.extractResult(events, EXIT_OK);
    expect(r).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      unknownEventCount: 0,
    });
    expect(r).not.toHaveProperty("nativeSessionId");
  });

  it("fixture late_id_on_trailing_tool replays an id-less result then a tool_call id to the trailing-tool detail with no session (gap)", async () => {
    const report = await runConformanceCase({
      kind: "malformed_output",
      adapter: replayAdapter("late_id_on_trailing_tool"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the result line",
        nativeSessionId: null,
        summary: "SYNTHETIC: done",
        unknownEventCount: 0,
      },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).not.toHaveProperty("nativeSessionId");
  });

  it("a trailing system/init after a trailing tool still binds; the failure is trailing-tool with the late id", () => {
    const { events, a } = parse([
      RESULT({ session_id: undefined }),
      TOOL("started", READ),
      INIT({ model: "Late Model", backing_provider: "backing-late-tool" }),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["usage", "result", "tool_call", "session_bound"]);
    expect(bound(events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "Late Model",
        backingProvider: "backing-late-tool",
      },
    ]);
    expect(a.extractResult(events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
  });

  it("a late whitespace session id is an unsafe argument; an empty one stays unbound; parser and resumeArgs agree on hostile code points", () => {
    const a = adapter();
    const space = parse([RESULT({ session_id: undefined }), INIT({ session_id: " " })]);
    expect(space.events.filter((e) => e.kind === "provider_error")).toEqual([
      { kind: "provider_error", category: "protocol", message: "session id is not a safe argument" },
    ]);
    expect(bound(space.events)).toEqual([]);
    expect(space.a.extractResult(space.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id is not a safe argument",
    });
    expect(space.a.extractResult(space.events, EXIT_OK)).not.toHaveProperty("nativeSessionId");
    // Contrast: empty string is absent, so the same order is a clean run with no session (sixth pass).
    const empty = parse([RESULT({ session_id: undefined }), INIT({ session_id: "" })]);
    expect(empty.a.extractResult(empty.events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0 });

    for (const id of ["a\u0000", "a\tb", "a\r", "\uD83D", "😀", "１", "a b"]) {
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      const events = a.parseEvent(INIT({ session_id: id }), state);
      const label = JSON.stringify(id);
      expect(events[0], label).toEqual({
        kind: "provider_error",
        category: "protocol",
        message: "session id is not a safe argument",
      });
      expect(state.nativeSessionId, label).toBeUndefined();
      expect(a.resumeArgs({ provider: "cursor", nativeSessionId: id }, req, PRIVILEGED_BYPASS_PROFILE), label).toEqual({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: "native session id is not a safe single argument",
      });
    }
  });

  it("the trailing-tool detail is used only under OUTPUT_PROTOCOL_ERROR: supervisor outcomes and unexpected exits keep theirs", () => {
    const events = parse([INIT(), RESULT(), TOOL("started", READ)]).events;
    for (const [exit, code, detail] of [
      [{ ...EXIT_OK, outcome: "cancelled" }, "CANCELLED", "run cancelled"],
      [{ ...EXIT_OK, outcome: "timeout", timeoutKind: "idle" }, "PROCESS_TIMEOUT", "idle timeout"],
      [{ ...EXIT_OK, outcome: "crashed", exitCode: null, signal: "SIGKILL" }, "PROCESS_CRASH", "signal SIGKILL"],
      [{ ...EXIT_OK, exitCode: 1 }, "TOOL_FAILURE", "exit code 1"],
      [
        { ...EXIT_OK, exitCode: 3, expectedExitCodes: [0, 3] },
        "OUTPUT_PROTOCOL_ERROR",
        "tool call after the result line",
      ],
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

  it("two trailing tools keep the trailing-tool detail once; a type:permission_denied line is unknown, never a denial", () => {
    const two = parse([INIT(), RESULT(), TOOL("started", READ, "c1"), TOOL("started", READ, "c2")]).events;
    expect(two.filter((e) => e.kind === "tool_call")).toHaveLength(2);
    expect(adapter().extractResult(two, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
    const named = parse([
      INIT(),
      RESULT(),
      line({ type: "permission_denied", tool: "shellToolCall", session_id: SID }),
    ]).events;
    expect(denials(named)).toEqual([]);
    expect(named.at(-1)).toEqual({ kind: "unknown", rawType: "permission_denied" });
    expect(adapter().extractResult(named, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
  });

  it("resume argv is compile argv plus one `--resume <id>` pair: prompt stays on stdin, never `--resume=` or `-r`", () => {
    const a = adapter();
    for (const objective of ["", req.objective, `--resume ${SID} --force --print`]) {
      const request = { ...req, objective };
      const first = a.compile(request, PRIVILEGED_BYPASS_PROFILE);
      if ("ineligible" in first) throw new Error(first.detail);
      expect(first.stdin).toEqual({ kind: "text", value: objective });
      expect(first.argv).not.toContain(objective);
      for (const id of ["print", "force", "trust", "stream-json", "yolo"]) {
        const resumed = a.resumeArgs({ provider: "cursor", nativeSessionId: id }, request, PRIVILEGED_BYPASS_PROFILE);
        expect(resumed, `${JSON.stringify(objective)}/${id}`).toEqual({
          ...first,
          argv: [...first.argv, "--resume", id],
        });
        if ("ineligible" in resumed) throw new Error(resumed.detail);
        expect(resumed.argv.filter((w) => w === "--resume")).toEqual(["--resume"]);
        expect(resumed.argv.some((w) => w.startsWith("--resume="))).toBe(false);
        expect(resumed.argv).not.toContain("-r");
        expect(resumed.argv).not.toContain("--continue");
        expect(resumed.stdin).toEqual(first.stdin);
      }
    }
    // The format value `stream-json` and a resume id spelled the same are two occurrences of one word.
    const stream = a.resumeArgs({ provider: "cursor", nativeSessionId: "stream-json" }, req, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in stream) throw new Error(stream.detail);
    expect(stream.argv.filter((w) => w === "stream-json")).toEqual(["stream-json", "stream-json"]);
  });

  it("pins the gap: case-variant refusal keys never emit permission_denied; a Git write with those keys still reaches the guard", () => {
    for (const key of ["Rejected", "PermissionDenied", "PERMISSION_DENIED", "DENIED", "Blocked", "permission-denied"]) {
      const { events, a } = parse([
        INIT(),
        TOOL("completed", { shellToolCall: { args: { command: "ls" }, result: { [key]: {} } } }),
        RESULT(),
      ]);
      expect(denials(events), key).toEqual([]);
      expect(a.extractResult(events, EXIT_OK), key).toMatchObject({ ok: true, nativeSessionId: SID });
    }
    // The same capitalised key on a Git write is not a denial; the guard still sees the command.
    const g = guarded([
      INIT(),
      TOOL("completed", { shellToolCall: { args: { command: "git push origin main" }, result: { Rejected: {} } } }),
      RESULT(),
    ]);
    expect(denials(g.events)).toEqual([]);
    const res = g.a.extractResult(g.events, EXIT_OK);
    expect(res).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID });
    expect(res.failureDetail).toMatch(/^git write attempted/);
  });

  it("fixture denied_key_case_variant replays a completed result.Rejected shell call to success at exit 0 (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("denied_key_case_variant"),
      request: { ...req, workspace: { cwd: makeCwd(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID, unknownEventCount: 0, summary: "The listing ran." },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
      summary: "The listing ran.",
    });
  });

  it("a progress-line refusal after result is a denial that outranks the trailing unknown; a string result is not a denial", () => {
    const progress = parse([
      INIT(),
      RESULT(),
      TOOL("progress", { shellToolCall: { args: { command: "ls" }, result: { rejected: {} } } }),
    ]);
    expect(progress.events.slice(-3)).toEqual([
      { kind: "unknown", rawType: "tool_call:progress" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "ls" },
      { kind: "permission_denied", tool: "shellToolCall" },
    ]);
    expect(progress.a.extractResult(progress.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: shellToolCall",
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
    // A string `result` is not an object, so neither denial keys nor a nested command are read.
    const asString = parse([
      INIT(),
      TOOL("completed", { shellToolCall: { args: { command: "ls" }, result: "rejected" } }),
      RESULT(),
    ]);
    expect(denials(asString.events)).toEqual([]);
    expect(asString.a.extractResult(asString.events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });
  });
});
