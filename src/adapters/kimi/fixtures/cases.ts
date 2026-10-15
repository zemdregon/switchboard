/**
 * Replay helpers and conformance cases for the Kimi Code adapter over synthetic recorded fixtures (T4.63; the
 * conformance suite is T4.65, FR-ADP-11). Test-only (excluded from the build): the adapter runs the shared `node
 * src/adapters/fixtures/replay.mjs --provider kimi` in place of the `kimi` binary. Only the approved bypass cell
 * (`--prompt=<prompt> --output-format stream-json`) is replayed this way; the prompt is the `--prompt=` argv word (stdin
 * unused), which the dialect reads.
 */
import { fileURLToPath } from "node:url";
import type { ConformanceCase } from "../../conformance.js";
import { privilegedProfile } from "../../fixtures/privileged.js";
import { replayLauncher } from "../../fixtures/replay.js";
import type { CompileRequest, ResolvedProfile } from "../../types.js";
import { KimiAdapter } from "../adapter.js";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url));

export const DEFAULT_SESSION_ID = "session_00000000-0000-4000-8000-000000000001";
export const RESUMED_SESSION_ID = "session_00000000-0000-4000-8000-000000000042";
/** The placeholder id of the scrubbed capture (`captured_success.jsonl`). */
export const CAPTURED_SESSION_ID = "session_00000000-0000-0000-0000-000000000000";

/** The one bypass scope Kimi Code compiles (T4.62): worktree files, shell `broad`, network `on`, repo config `enabled`. */
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

/** A KimiAdapter whose argv[0] is node and whose launcher replays `fixture` instead of running `kimi`. */
export function replayAdapter(fixture: string, o: ReplayOptions = {}): KimiAdapter {
  return new KimiAdapter({
    executable: process.execPath,
    launcherArgs: replayLauncher("kimi", fixturePath(fixture), [
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
 * with the ADR-0039 guard and the fail-closed stream anomalies as extra failures. Each failure pins its detail, session
 * id or summary, so a run the replay refused (exit 64 with no output) cannot stand in. The scrubbed 2.1.1 capture is not
 * a case: the dialect replays synthetic fixtures only (`requireSynthetic`); parser-residual.test.ts parses it.
 */
export function kimiConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (): CompileRequest => ({
    runId: "run_kimi_conformance",
    objective: "synthetic kimi objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
    bypassApproved: true,
  });
  const base = { profile: PRIVILEGED_BYPASS_PROFILE } as const;
  const malformed = (fixture: string, failureDetail: string): ConformanceCase => ({
    ...base,
    kind: "malformed_output",
    adapter: replayAdapter(fixture),
    request: request(),
    expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", failureDetail },
  });
  return [
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("success_edit"),
      request: request(),
      expect: {
        ok: true,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Reading the file first.\nAdded hello.txt.",
        unknownEventCount: 0,
        mutatedPath: "hello.txt",
      },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("task_failure"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 1", nativeSessionId: null },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: replayAdapter("git_write_guard"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: "git write attempted: `git commit` can create commits, change refs or push",
        nativeSessionId: DEFAULT_SESSION_ID,
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
        failureDetail: "auth: Authentication required. SYNTHETIC: run kimi login.",
        nativeSessionId: null,
      },
    },
    malformed("malformed_output", "unparseable provider output"),
    malformed("no_hint", "no result event"),
    malformed("two_hints", "protocol: more than one resume hint"),
    malformed("record_after_hint", "protocol: assistant record after the resume hint"),
    malformed("unreadable_tool_call", "protocol: tool call without a readable name and arguments"),
    {
      ...base,
      kind: "timeout",
      adapter: replayAdapter("hang", { hang: true, timeouts: { idleMs: 400 } }),
      request: request(),
      expect: { ok: false, failureCode: "PROCESS_TIMEOUT", summary: "Hanging indefinitely..." },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: replayAdapter("hang", { hang: true, ignoreTerm: true, timeouts: { idleMs: 10_000 } }),
      request: request(),
      expect: { ok: false, failureCode: "CANCELLED", summary: "Hanging indefinitely..." },
    },
    {
      ...base,
      kind: "resume",
      adapter: replayAdapter("resume"),
      request: request(),
      binding: { provider: "kimi", nativeSessionId: RESUMED_SESSION_ID },
      expect: { ok: true, nativeSessionId: RESUMED_SESSION_ID, summary: "Resumed earlier session." },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: replayAdapter("task_failure", { exitCode: 1, write: "partial.txt" }),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 1", mutatedPath: "partial.txt" },
    },
  ];
}
