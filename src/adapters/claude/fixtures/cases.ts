/** Conformance cases for the Claude Code adapter replaying synthetic stream-json fixtures (T2.2, FR-ADP-11). */
import { fileURLToPath } from "node:url";
import type { ConformanceCase } from "../../conformance.js";
import type { CompileRequest, ResolvedProfile } from "../../types.js";
import { ClaudeAdapter } from "../adapter.js";

export const REPLAY_SCRIPT = fileURLToPath(new URL("./replay.mjs", import.meta.url));
export const fixturePath = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url));

export const DEFAULT_SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const RESUMED_SESSION_ID = "00000000-0000-4000-8000-000000000042";

export const EDIT_UNTRUSTED: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
export const INSPECT_UNTRUSTED: ResolvedProfile = {
  name: "inspect-untrusted",
  fileAccess: "read-only",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

const SHORT = { wallClockMs: 10_000, idleMs: 400, killGraceMs: 300 };

export interface ReplayOptions {
  exitCode?: number;
  write?: string;
  hang?: boolean;
  ignoreTerm?: boolean;
  timeouts?: Partial<typeof SHORT>;
}

/** A ClaudeAdapter whose argv[0] is node and whose launcher replays `fixture` instead of running `claude`. */
export function replayAdapter(fixture: string, o: ReplayOptions = {}): ClaudeAdapter {
  return new ClaudeAdapter({
    binaryPath: process.execPath,
    launcherArgs: [
      REPLAY_SCRIPT,
      "--fixture",
      fixturePath(fixture),
      ...(o.exitCode !== undefined ? ["--exit-code", String(o.exitCode)] : []),
      ...(o.write ? ["--write", o.write] : []),
      ...(o.hang ? ["--hang"] : []),
      ...(o.ignoreTerm ? ["--ignore-term"] : []),
      "--",
    ],
    timeouts: { ...SHORT, ...o.timeouts },
  });
}

/** `makeCwd` returns a fresh empty directory per case. Covers every FR-ADP-11 kind plus rate limit, timeout. */
export function claudeConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (): CompileRequest => ({
    runId: "run_claude_fixture",
    objective: "synthetic objective",
    constraints: ["synthetic constraint"],
    workspace: { cwd: makeCwd(), writable: true },
  });
  const base = { profile: EDIT_UNTRUSTED } as const;
  return [
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("success-edit.jsonl", { write: "hello.txt" }),
      request: request(),
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID, mutatedPath: "hello.txt" },
    },
    {
      kind: "success",
      profile: INSPECT_UNTRUSTED,
      adapter: replayAdapter("success-edit.jsonl"),
      request: request(),
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("task-failure.jsonl", { exitCode: 1 }),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE" },
    },
    {
      // Permission denial (FR-POL-05) has no dedicated harness kind; it is a task that ended blocked.
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("permission-denied.jsonl"),
      request: request(),
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED" },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: replayAdapter("task-failure.jsonl", { exitCode: 1, write: "partial.txt" }),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", mutatedPath: "partial.txt" },
    },
    {
      ...base,
      kind: "auth_missing",
      adapter: replayAdapter("auth-missing.jsonl", { exitCode: 1 }),
      request: request(),
      expect: { ok: false, failureCode: "AUTH_REQUIRED" },
    },
    {
      ...base,
      kind: "rate_limit",
      adapter: replayAdapter("rate-limit.jsonl", { exitCode: 1 }),
      request: request(),
      expect: { ok: false, failureCode: "RATE_LIMIT_TRANSIENT" },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: replayAdapter("malformed.jsonl"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" },
    },
    {
      ...base,
      kind: "timeout",
      adapter: replayAdapter("hang.jsonl", { hang: true }),
      request: request(),
      expect: { ok: false, failureCode: "PROCESS_TIMEOUT" },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: replayAdapter("hang.jsonl", { hang: true, ignoreTerm: true, timeouts: { idleMs: 10_000 } }),
      request: request(),
      expect: { ok: false, failureCode: "CANCELLED" },
    },
    {
      ...base,
      kind: "resume",
      adapter: replayAdapter("success-edit.jsonl"),
      request: request(),
      binding: { provider: "claude", nativeSessionId: RESUMED_SESSION_ID },
      expect: { ok: true, nativeSessionId: RESUMED_SESSION_ID },
    },
  ];
}
