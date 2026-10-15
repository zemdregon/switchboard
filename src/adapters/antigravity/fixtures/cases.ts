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
 * container aliases (PERMISSION_BLOCKED, ADR-0039), a `SUCCESS` envelope whose conversation id is not one safe token
 * (OUTPUT_PROTOCOL_ERROR, nothing bound) and the same unsafe id on the `result` only, after a normal `init` (the first
 * id stays bound), a stream with no `result` at exit 3 (the TDD §4.4.1 `AGY_ERROR` case, stderr only: TOOL_FAILURE) and
 * a `SUCCESS` envelope whose usage keys were not recorded (TOOL_FAILURE, Q-86), and a cancellation of a process that
 * honours SIGTERM as well as one that ignores it. No case expects SANDBOX_VIOLATION: the one compiled cell is an
 * approved bypass, where the provider-state guard does not apply; the `sandbox_violation_unrecorded` fixture replays to
 * a success (T4.33 gap), so it is not a conformance case.
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
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID, mutatedPath: "hello.txt" },
    },
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("unknown_event"),
      request: request(),
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("backing_provider"),
      request: request(),
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("task_failure"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("permission_denied"),
      request: request(),
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("model_unavailable"),
      request: request(),
      expect: { ok: false, failureCode: "MODEL_UNAVAILABLE" },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("slash_command"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE" },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("credits_command"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE" },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("rate_limit_unrecorded"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("rate_limit"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE" },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("rate_limit_error"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("agy_error_exit3"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("usage_unrecorded"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("git_write_guard"),
      request: request(),
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("git_write_guard_args"),
      request: request(),
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "auth_missing",
      adapter: replayAdapter("auth_missing"),
      request: request(),
      expect: { ok: false, failureCode: "AUTH_REQUIRED" },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("malformed_output"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("no_result"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("two_results"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("conversation_changed"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("trailing_tool"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("unsafe_conversation_id"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("unsafe_id_after_bound"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("unknown_events"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" },
    },
    {
      ...base,
      kind: "timeout",
      adapter: replayAdapter("hang", { hang: true, timeouts: { idleMs: 400 } }),
      request: request(),
      expect: { ok: false, failureCode: "PROCESS_TIMEOUT" },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: replayAdapter("hang", { hang: true, ignoreTerm: true, timeouts: { idleMs: 10_000 } }),
      request: request(),
      expect: { ok: false, failureCode: "CANCELLED" },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: replayAdapter("hang", { hang: true, timeouts: { idleMs: 10_000 } }),
      request: request(),
      expect: { ok: false, failureCode: "CANCELLED" },
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
      expect: { ok: false, failureCode: "TOOL_FAILURE", mutatedPath: "partial.txt" },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: replayAdapter("denied_after_write"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: DEFAULT_SESSION_ID,
        mutatedPath: "b.txt",
      },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: replayAdapter("success_edit", { exitCode: 1 }),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID, mutatedPath: "hello.txt" },
    },
  ];
}
