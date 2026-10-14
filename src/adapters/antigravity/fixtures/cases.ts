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
 * `makeCwd` returns a fresh empty directory per case. Covers every FR-ADP-11 kind plus timeout, partial_mutation and a
 * soft-denied tool (a second `task_failure`, PERMISSION_BLOCKED).
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
  ];
}
