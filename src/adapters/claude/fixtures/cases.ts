/** Conformance cases for the Claude Code adapter replaying synthetic stream-json fixtures (T2.2, FR-ADP-11). */
import { fileURLToPath } from "node:url";
import type { ConformanceCase } from "../../conformance.js";
import { LOOSE_SCOPE, privilegedProfile } from "../../fixtures/privileged.js";
import { REPLAY_SCRIPT, replayLauncher } from "../../fixtures/replay.js";
import type { CompileRequest, ResolvedProfile } from "../../types.js";
import { ClaudeAdapter } from "../adapter.js";

export { REPLAY_SCRIPT };
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

/** The Proposed `trusted-development` default (src/policy/profiles.ts, Q-17): empty shell allowlist, network off. */
export const TRUSTED_DEVELOPMENT: ResolvedProfile = {
  name: "trusted-development",
  fileAccess: "worktree",
  shell: "allowlist",
  shellAllowlist: [],
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
    launcherArgs: replayLauncher("claude", fixturePath(fixture), [
      ...(o.exitCode !== undefined ? ["--exit-code", String(o.exitCode)] : []),
      ...(o.write ? ["--write", o.write] : []),
      ...(o.hang ? ["--hang"] : []),
      ...(o.ignoreTerm ? ["--ignore-term"] : []),
    ]),
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

/**
 * T3.5: synthetic denial fixtures under the M3-compiled `trusted-development` profile (with an operator allowlist), run
 * through the same harness. Each must end with its failure code, never success, and must not hang.
 */
export function claudeDenialCases(makeCwd: () => string): ConformanceCase[] {
  const request = (): CompileRequest => ({
    runId: "run_claude_denial_fixture",
    objective: "synthetic objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
  });
  const profile: ResolvedProfile = { ...TRUSTED_DEVELOPMENT, shellAllowlist: ["npm test"] };
  return [
    {
      kind: "success",
      profile,
      adapter: replayAdapter("success-edit.jsonl", { write: "hello.txt" }),
      request: request(),
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID, mutatedPath: "hello.txt" },
    },
    {
      // FR-POL-05: a denied Git write (FR-GIT-01 deny rule) ends PERMISSION_BLOCKED even when the CLI exits 0.
      kind: "task_failure",
      profile,
      adapter: replayAdapter("permission-denied-git.jsonl"),
      request: request(),
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED" },
    },
    {
      kind: "task_failure",
      profile,
      adapter: replayAdapter("permission-denied-git.jsonl", { exitCode: 1 }),
      request: request(),
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED" },
    },
    {
      kind: "task_failure",
      profile,
      adapter: replayAdapter("sandbox-violation.jsonl", { exitCode: 1 }),
      request: request(),
      expect: { ok: false, failureCode: "SANDBOX_VIOLATION" },
    },
    {
      // A denial with partial edits keeps the mutation visible and still fails closed.
      kind: "partial_mutation",
      profile,
      adapter: replayAdapter("sandbox-violation.jsonl", { write: "partial.txt" }),
      request: request(),
      expect: { ok: false, failureCode: "SANDBOX_VIOLATION", mutatedPath: "partial.txt" },
    },
  ];
}

/**
 * T3.5/T3.17: the same synthetic denials under `privileged` (the loose scope of decision 18), once with `bypass: false`
 * and once with an approved `bypass: true` (the harness hands the run context to the argv audit). A denial still ends
 * with its failure code, never success, and never hangs.
 */
export function claudePrivilegedDenialCases(makeCwd: () => string): ConformanceCase[] {
  const out: ConformanceCase[] = [];
  for (const bypass of [false, true]) {
    const profile = privilegedProfile({ ...LOOSE_SCOPE, bypass });
    const request = (): CompileRequest => ({
      runId: "run_claude_privileged_fixture",
      objective: "synthetic objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
      bypassApproved: bypass,
    });
    out.push(
      {
        kind: "success",
        profile,
        adapter: replayAdapter("success-edit.jsonl", { write: "hello.txt" }),
        request: request(),
        expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID, mutatedPath: "hello.txt" },
      },
      {
        kind: "task_failure",
        profile,
        adapter: replayAdapter("permission-denied-git.jsonl"),
        request: request(),
        expect: { ok: false, failureCode: "PERMISSION_BLOCKED" },
      },
      {
        kind: "task_failure",
        profile,
        adapter: replayAdapter("sandbox-violation.jsonl", { exitCode: 1 }),
        request: request(),
        expect: { ok: false, failureCode: "SANDBOX_VIOLATION" },
      },
    );
  }
  return out;
}
