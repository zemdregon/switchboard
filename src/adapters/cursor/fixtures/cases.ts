/**
 * Conformance cases for the Cursor adapter over synthetic recorded fixtures (T4.45, FR-ADP-11).
 * Test-only (excluded from the build): the adapter runs the shared `node src/adapters/fixtures/replay.mjs --provider cursor`
 * in place of the `cursor-agent` binary. Prompt travels on stdin as compiled by CursorAdapter.
 */
import { fileURLToPath } from "node:url";
import type { ConformanceCase } from "../../conformance.js";
import { privilegedProfile } from "../../fixtures/privileged.js";
import { replayLauncher } from "../../fixtures/replay.js";
import type { CompileRequest, ResolvedProfile } from "../../types.js";
import { CursorAdapter } from "../adapter.js";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url));

export const DEFAULT_SESSION_ID = "synthetic-cursor-session-0001";
export const RESUMED_SESSION_ID = "synthetic-cursor-session-0042";

/** The approved bypass scope Cursor compiles (T4.42, Q-79). */
export const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
} as const;

export const PRIVILEGED_BYPASS_PROFILE: ResolvedProfile = privilegedProfile(BYPASS_SCOPE);

const SHORT = { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 };

export interface ReplayOptions {
  exitCode?: number;
  write?: string;
  hang?: boolean;
  ignoreTerm?: boolean;
  timeouts?: Partial<typeof SHORT>;
}

/** A CursorAdapter whose argv[0] is node and whose launcher replays `fixture` instead of running `cursor-agent`. */
export function replayAdapter(fixture: string, o: ReplayOptions = {}): CursorAdapter {
  return new CursorAdapter({
    executable: process.execPath,
    launcherArgs: replayLauncher("cursor", fixturePath(fixture), [
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
 * and the recorded fail-at-exit-0-or-1 shapes: soft-denied shell commands (live check row 7a `rejected` and row 11
 * `permissionDenied`, each PERMISSION_BLOCKED at exit 0), an ADR-0039 guard-flagged Git write (PERMISSION_BLOCKED at exit 0),
 * unrecorded rate-limit and sandbox error text at exit 0 (TOOL_FAILURE), stream anomalies (no result line, two result lines,
 * conflicting session id, trailing tool call, and unsafe session id in init or after a bound id, each OUTPUT_PROTOCOL_ERROR),
 * unknown event counting in a success, both cancellation paths (SIGTERM and SIGKILL escalation on ignore-term), and
 * workspace mutations preserved on failure (denied after write with PERMISSION_BLOCKED, partial mutation at exit 1, and
 * success edit at exit 1 with TOOL_FAILURE).
 */
export function cursorConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (writable = true): CompileRequest => ({
    runId: "run_cursor_conformance",
    objective: "synthetic cursor objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable },
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
      kind: "task_failure",
      adapter: replayAdapter("task_failure"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE" },
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
      adapter: replayAdapter("permission_denied_perm"),
      request: request(),
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
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
      adapter: replayAdapter("rate_limit_error"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("sandbox_violation"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID },
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
      adapter: replayAdapter("session_changed"),
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
      adapter: replayAdapter("unsafe_session_id"),
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
      binding: { provider: "cursor", nativeSessionId: RESUMED_SESSION_ID },
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
