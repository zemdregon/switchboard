/**
 * Conformance cases for the Grok Build adapter over synthetic recorded fixtures (T4.25, FR-ADP-11).
 * Test-only (excluded from the build): the adapter runs the shared `node src/adapters/fixtures/replay.mjs --provider
 * grok` in place of the `grok` binary. The prompt is the `--single=<prompt>` argv word (stdin unused), which the dialect
 * reads.
 */
import { fileURLToPath } from "node:url";
import type { ConformanceCase } from "../../conformance.js";
import { privilegedProfile } from "../../fixtures/privileged.js";
import { replayLauncher } from "../../fixtures/replay.js";
import type { CompileRequest, ResolvedProfile } from "../../types.js";
import { GrokAdapter } from "../adapter.js";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url));

export const DEFAULT_SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const RESUMED_SESSION_ID = "00000000-0000-4000-8000-000000000042";

/**
 * An approved bypass scope Grok Build compiles (T4.22, owner decision 46): network on, `--sandbox off` (ADR-0077: the
 * worktree-files bypass cell is not confined to its worktree).
 */
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

/** A GrokAdapter whose argv[0] is node and whose launcher replays `fixture` instead of running `grok`. */
export function replayAdapter(fixture: string, o: ReplayOptions = {}): GrokAdapter {
  return new GrokAdapter({
    executable: process.execPath,
    launcherArgs: replayLauncher("grok", fixturePath(fixture), [
      ...(o.exitCode !== undefined ? ["--exit-code", String(o.exitCode)] : []),
      ...(o.write ? ["--write", o.write] : []),
      ...(o.hang ? ["--hang"] : []),
      ...(o.ignoreTerm ? ["--ignore-term"] : []),
    ]),
    timeouts: { ...SHORT, ...o.timeouts },
  });
}

/** `makeCwd` returns a fresh empty directory per case. Covers every FR-ADP-11 kind plus timeout, partial_mutation. */
export function grokConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (writable = true): CompileRequest => ({
    runId: "run_grok_conformance",
    objective: "synthetic grok objective",
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
      kind: "task_failure",
      adapter: replayAdapter("task_failure"),
      request: request(),
      // Session id and detail: a compile the replay refuses (exit 64 or 65, no output) is TOOL_FAILURE too (T4.22).
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "stopReason cancelled",
        nativeSessionId: DEFAULT_SESSION_ID,
      },
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
      binding: { provider: "grok", nativeSessionId: RESUMED_SESSION_ID },
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
