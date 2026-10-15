/**
 * Conformance cases for the Antigravity adapter over synthetic recorded fixtures (T4.35, FR-ADP-11).
 * Test-only (excluded from the build): the adapter runs the shared `node src/adapters/fixtures/replay.mjs --provider
 * antigravity` in place of the `agy` binary. The prompt is the `--prompt=<prompt>` argv word (stdin unused), which the
 * dialect reads.
 *
 * The `resume` case is listed so `missingRequiredKinds` names no gap, but it cannot pass while `resumeArgs` is
 * `Ineligible` (Q-86, T4.33): {@link ANTIGRAVITY_RUNNABLE_KINDS} excludes it, and the test asserts it fails closed.
 */
import { fileURLToPath } from "node:url";
import type { ConformanceCase, ConformanceCaseKind } from "../../conformance.js";
import { privilegedProfile } from "../../fixtures/privileged.js";
import { replayLauncher } from "../../fixtures/replay.js";
import type { CompileRequest, ResolvedProfile } from "../../types.js";
import { AntigravityAdapter } from "../adapter.js";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url));

export const DEFAULT_SESSION_ID = "0b6c2d1e-0000-4000-8000-000000000001";
export const RESUMED_SESSION_ID = "0b6c2d1e-0000-4000-8000-000000000042";

/** The `failureDetail` text of `model_unavailable.jsonl` (its invented C10 message). */
const MODEL_DETAIL =
  "model_unavailable: invalid model selection (--model synthetic-missing): SYNTHETIC. Available models: Synthetic Model";
/** The guard's `failureDetail` for the `git commit` step in both Git-write fixtures (ADR-0039). */
const GIT_DETAIL = "git write attempted: `git commit` can create commits, change refs or push";
/** The guard's `failureDetail` for the two shadowed Git-write fixtures (PR #387: every parameter key and container). */
const GIT_PUSH_DETAIL = "git write attempted: `git push` can create commits, change refs or push";
const GIT_TAG_DETAIL = "git write attempted: `git tag` can create commits, change refs or push";

/** The one scope Antigravity compiles (T4.32, owner decision 46, Q-84): an approved bypass with network on. */
export const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
} as const;

export const PRIVILEGED_BYPASS_PROFILE: ResolvedProfile = privilegedProfile(BYPASS_SCOPE);

/** Kinds whose case runs end to end today; `resume` waits for Q-86. */
export const ANTIGRAVITY_RUNNABLE_KINDS: readonly ConformanceCaseKind[] = [
  "success",
  "task_failure",
  "auth_missing",
  "malformed_output",
  "timeout",
  "cancellation",
  "partial_mutation",
];

const SHORT = { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 };

export interface ReplayOptions {
  exitCode?: number;
  write?: string;
  hang?: boolean;
  ignoreTerm?: boolean;
  timeouts?: Partial<typeof SHORT>;
}

/** An AntigravityAdapter whose argv[0] is node and whose launcher replays `fixture` instead of running `agy`. */
export function replayAdapter(fixture: string, o: ReplayOptions = {}): AntigravityAdapter {
  return new AntigravityAdapter({
    executable: process.execPath,
    launcherArgs: replayLauncher("antigravity", fixturePath(fixture), [
      ...(o.exitCode !== undefined ? ["--exit-code", String(o.exitCode)] : []),
      ...(o.write ? ["--write", o.write] : []),
      ...(o.hang ? ["--hang"] : []),
      ...(o.ignoreTerm ? ["--ignore-term"] : []),
    ]),
    timeouts: { ...SHORT, ...o.timeouts },
  });
}

/**
 * `makeCwd` returns a fresh empty directory per case. Covers every FR-ADP-11 kind plus timeout and partial_mutation,
 * and the other recorded fail-at-exit-0-or-1 shapes: a soft-denied tool (C7, PERMISSION_BLOCKED), an invalid model
 * envelope at exit 1 (C10, MODEL_UNAVAILABLE), a slash-command envelope with no turn (C6, TOOL_FAILURE) and a write
 * that ran before a soft-denied command (C18 run 2, PERMISSION_BLOCKED with the write visible). Also synthetic
 * negatives that need no capture: the `/credits` envelope (C6, TOOL_FAILURE), a stream with no `result`, a second
 * `result` after a C10 one and a `result` for another conversation (each OUTPUT_PROTOCOL_ERROR with the first id kept),
 * a `SUCCESS` envelope at exit 1 (TOOL_FAILURE with the write visible), an unrecorded event kind in a success (still
 * `ok`, counted as unknown), a structured backing vendor and model on `session_bound` (T4.6, FR-ADP-10), plus an empty
 * stream at exit 1 for unreached rate limit (TOOL_FAILURE, never RATE_LIMIT_TRANSIENT) and in-stream rate-limit text in
 * an `ERROR` envelope at exit 0 and exit 1 (TOOL_FAILURE: no rate-limit shape is recorded, so no `rate_limit` case),
 * multiple unreadable event lines at exit 0 without a result (OUTPUT_PROTOCOL_ERROR), a tool step after a clean
 * `result` (OUTPUT_PROTOCOL_ERROR), a guard-flagged Git write under a `SUCCESS` envelope with parameters and args
 * container aliases (PERMISSION_BLOCKED, ADR-0039), the same guard when an empty `command` key or a benign command in
 * an earlier container would have shadowed the Git write (PR #387; PERMISSION_BLOCKED), a `SUCCESS` envelope whose conversation id is not one safe token
 * (OUTPUT_PROTOCOL_ERROR, nothing bound) and the same unsafe id on the `result` only, after a normal `init` (the first
 * id stays bound), a `step_update` for another conversation (OUTPUT_PROTOCOL_ERROR, first id kept), a non-array
 * `denied_actions` value (PERMISSION_BLOCKED), a stream with no `result` at exit 3 (the TDD §4.4.1 `AGY_ERROR` case,
 * stderr only: TOOL_FAILURE), in-stream sandbox-violation text in an `ERROR` envelope at exit 0 (TOOL_FAILURE, never
 * SANDBOX_VIOLATION: the parser emits no sandbox category) and
 * a `SUCCESS` envelope whose usage keys were not recorded (TOOL_FAILURE, Q-86), an object `error` beside a `SUCCESS`
 * status with tokens and an invented status with tokens and no error (each TOOL_FAILURE), and a cancellation of a process that
 * honours SIGTERM as well as one that ignores it, and an idle timeout on both paths beside a wall-clock timeout (each
 * names its timeout kind). The whole-stream order shapes (an unknown line before the result,
 * a late auth envelope after a clean result and an unparseable line after it) are cases too. A case whose code,
 * session id and mutation would also match a replay refusal (exit 64 or 65, no output) names its `failureDetail`, so
 * every case fails when the replay refuses the compile. Every runnable case also pins its whole result (detail, session
 * id or `null` for none, summary or `null`, unknown event count), so it fails when another case's fixture is replayed
 * in its place, except for the listed pairs that normalize to the same result (conformance-residual.test.ts). No case
 * expects SANDBOX_VIOLATION: the one compiled cell is an approved bypass, where the provider-state guard does not apply;
 * the `sandbox_violation_unrecorded` fixture replays to a success (T4.33 gap), so it is not a conformance case.
 */
export function antigravityConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (): CompileRequest => ({
    runId: "run_antigravity_conformance",
    objective: "synthetic antigravity objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
    bypassApproved: true,
  });
  const base = { profile: PRIVILEGED_BYPASS_PROFILE } as const;
  return [
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("success_edit"),
      request: request(),
      expect: {
        ok: true,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Added hello.txt.",
        unknownEventCount: 0,
        mutatedPath: "hello.txt",
      },
    },
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("unknown_event"),
      request: request(),
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID, summary: "ok", unknownEventCount: 1 },
    },
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("backing_provider"),
      request: request(),
      expect: {
        ok: true,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Answered through backing vendor.",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("unknown_then_result"),
      request: request(),
      expect: {
        ok: true,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "SYNTHETIC: recognized turn.",
        unknownEventCount: 1,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("task_failure"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "SUCCESS with no reported tokens",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("permission_denied"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: "denied: RunCommand",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("denied_not_array"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: "denied: unknown",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "blocked",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("model_unavailable"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "MODEL_UNAVAILABLE",
        failureDetail: MODEL_DETAIL,
        nativeSessionId: null,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("slash_command"),
      request: request(),
      // No session or write to show the fixture ran: without the detail a replay refusal would also pass (T4.35).
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "SUCCESS with no reported tokens",
        nativeSessionId: null,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("credits_command"),
      request: request(),
      // No session or write to show the fixture ran: without the detail a replay refusal would also pass (T4.35).
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "SUCCESS with no reported tokens",
        nativeSessionId: null,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("rate_limit_unrecorded"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "unknown: RESOURCE_EXHAUSTED: SYNTHETIC quota exceeded, 429 Too Many Requests",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("rate_limit"),
      request: request(),
      // No session or write to show the fixture ran: without the detail a replay refusal would also pass (T4.35).
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "exit code 1",
        nativeSessionId: null,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("rate_limit_error"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "unknown: RESOURCE_EXHAUSTED: rate limit exceeded, 429 Too Many Requests",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("sandbox_violation_error"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "unknown: sandbox: operation denied by seccomp profile",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("agy_error_exit3"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "exit code 3",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("usage_unrecorded"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "SUCCESS with no reported tokens",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "ok",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("error_not_string"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "unknown: non-string error field",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "ok",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("status_unrecorded"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "SYNTHETIC_CANCELLED",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("git_write_guard"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: GIT_DETAIL,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Done.",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("git_write_guard_args"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: GIT_DETAIL,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Done.",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("git_write_shadow_empty"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: GIT_PUSH_DETAIL,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Pushed.",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("git_write_shadow_container"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: GIT_TAG_DETAIL,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Listed.",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "auth_missing",
      adapter: replayAdapter("auth_missing"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "AUTH_REQUIRED",
        failureDetail: "auth: authentication failed or timed out",
        nativeSessionId: null,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("malformed_output"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "unparseable provider output",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("no_result"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "no result event",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("two_results"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: more than one result line",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "ok",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("conversation_changed"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: conversation id changed mid-run",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "ok",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("step_conversation_changed"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: conversation id changed mid-run",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "ok",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("trailing_tool"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the result line",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Done.",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("unsafe_conversation_id"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: conversation id is not a safe token",
        nativeSessionId: null,
        summary: "ok",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("unsafe_id_after_bound"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: conversation id is not a safe token",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "ok",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("error_after_result"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: more than one result line",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Done.",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("malformed_after_result"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "unparseable provider output",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Done.",
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("unknown_events"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "no result event",
        nativeSessionId: null,
        summary: null,
        unknownEventCount: 5,
      },
    },
    {
      ...base,
      kind: "timeout",
      adapter: replayAdapter("hang", { hang: true, timeouts: { idleMs: 400 } }),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PROCESS_TIMEOUT",
        failureDetail: "idle timeout",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "timeout",
      adapter: replayAdapter("hang", { hang: true, ignoreTerm: true, timeouts: { idleMs: 400 } }),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PROCESS_TIMEOUT",
        failureDetail: "idle timeout",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "timeout",
      adapter: replayAdapter("hang", { hang: true, timeouts: { wallClockMs: 400, idleMs: 10_000 } }),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PROCESS_TIMEOUT",
        failureDetail: "wall_clock timeout",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: replayAdapter("hang", { hang: true, ignoreTerm: true, timeouts: { idleMs: 10_000 } }),
      request: request(),
      expect: {
        ok: false,
        failureCode: "CANCELLED",
        failureDetail: "run cancelled",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: replayAdapter("hang", { hang: true, timeouts: { idleMs: 10_000 } }),
      request: request(),
      expect: {
        ok: false,
        failureCode: "CANCELLED",
        failureDetail: "run cancelled",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
      },
    },
    {
      ...base,
      kind: "resume",
      adapter: replayAdapter("resume"),
      request: request(),
      binding: { provider: "antigravity", nativeSessionId: RESUMED_SESSION_ID },
      expect: { ok: true, nativeSessionId: RESUMED_SESSION_ID },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: replayAdapter("task_failure", { exitCode: 1, write: "partial.txt" }),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "SUCCESS with no reported tokens",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: null,
        unknownEventCount: 0,
        mutatedPath: "partial.txt",
      },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: replayAdapter("denied_after_write"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: "denied: RunCommand",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Wrote b.txt; the shell command was not run.",
        unknownEventCount: 0,
        mutatedPath: "b.txt",
      },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: replayAdapter("success_edit", { exitCode: 1 }),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "exit code 1",
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Added hello.txt.",
        unknownEventCount: 0,
        mutatedPath: "hello.txt",
      },
    },
  ];
}
