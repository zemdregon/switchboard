/**
 * Test-only (excluded from the build), SYNTHETIC: Muse Code fixtures for T4.72, T4.73 and the T4.75 conformance cases
 * (FR-ADP-11, replayed by the shared `replay.mjs --provider muse`). No `muse` binary was installed or run;
 * the version line is the format reported by a third party ([Orca] in TDD §4.8), not a capture. T4.71 replaces these
 * with scrubbed captures.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrivilegedScope } from "../../../policy/types.js";
import type { ConformanceCase } from "../../conformance.js";
import { privilegedProfile } from "../../fixtures/privileged.js";
import { replayLauncher } from "../../fixtures/replay.js";
import type { CompileRequest, ResolvedProfile } from "../../types.js";
import { MuseAdapter } from "../adapter.js";

/** The one scope shape whose approved bypass run compiles with network off (see the adapter header). */
export const BYPASS_SCOPE: PrivilegedScope = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "off" },
  repository_config: { mode: "enabled" },
  bypass: true,
};

/** `privileged` with {@link BYPASS_SCOPE}; callers set `bypassApproved` on the request or the profile. */
export const PRIVILEGED_BYPASS_PROFILE: ResolvedProfile = privilegedProfile(BYPASS_SCOPE);

/** SYNTHETIC `muse --version` stdout in the reported format ([Orca]: "Muse Code 1.2.1 (1.2.1-R2847.1)"). */
export const SYNTHETIC_VERSION_STDOUT = "Muse Code 1.2.1 (1.2.1-R2847.1)\n";

/** SYNTHETIC `muse exec --help` stdout listing the flags TDD §4.8 sources (layout invented; Unverified: T4.71). */
export const SYNTHETIC_EXEC_HELP_STDOUT =
  "Usage: muse exec [OPTIONS] [PROMPT]\n" +
  "      --json\n" +
  "      --prompt-file <PATH>\n" +
  "      --approval-mode <MODE>\n" +
  "      --sandbox-network <MODE>\n" +
  "  -w, --worktree <MODE>\n" +
  "      --session-id <UUID>\n";

/** Session ids of the T4.73 JSONL fixtures (SYNTHETIC uuids). */
export const DEFAULT_SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const RESUMED_SESSION_ID = "00000000-0000-4000-8000-000000000042";

/**
 * Reads a SYNTHETIC T4.73 fixture `./<name>.jsonl`: the first line is the `_fixture` header (its `exit` is the exit code
 * the case pins), every other line is one `muse exec --json` record in the reported or **Assumption** shapes of
 * protocol.ts. No line was captured from a real `muse`; T4.71 replaces these.
 */
export function readFixture(name: string): { exitCode: number; lines: string[] } {
  const [head = "", ...lines] = readFileSync(fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => l !== "");
  const header = (JSON.parse(head) as { _fixture?: { synthetic?: boolean; exit?: number } })._fixture;
  if (header?.synthetic !== true || typeof header.exit !== "number") throw new Error(`${name}: bad fixture header`);
  return { exitCode: header.exit, lines };
}

/** `failureDetail` of the `task_failure` fixture: the failed terminal's value and reason (T4.73). */
export const TASK_FAILURE_DETAIL = "terminal failed: synthetic task failure";
/** `failureDetail` of the logged-out run: its exit code (a refused compile exits 64 or 65 instead). */
export const AUTH_MISSING_DETAIL = "exit code 1";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url));

const SHORT = { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 };

export interface ReplayOptions {
  exitCode?: number;
  write?: string;
  hang?: boolean;
  ignoreTerm?: boolean;
  timeouts?: Partial<typeof SHORT>;
}

/**
 * A MuseAdapter whose argv[0] is node and whose launcher replays `fixture` instead of running `muse` (T4.75): the shared
 * `replay.mjs --provider muse`, which reads the prompt from the last argv word (stdin unused) and refuses an argv
 * without `exec --json -w off --approval-mode on-request --sandbox-network restricted|unrestricted`.
 */
export function replayAdapter(fixture: string, o: ReplayOptions = {}): MuseAdapter {
  return new MuseAdapter({
    executable: process.execPath,
    launcherArgs: replayLauncher("muse", fixturePath(fixture), [
      ...(o.exitCode !== undefined ? ["--exit-code", String(o.exitCode)] : []),
      ...(o.write ? ["--write", o.write] : []),
      ...(o.hang ? ["--hang"] : []),
      ...(o.ignoreTerm ? ["--ignore-term"] : []),
    ]),
    timeouts: { ...SHORT, ...o.timeouts },
  });
}

/**
 * Conformance cases over the SYNTHETIC fixtures above (T4.75, FR-ADP-11; `makeCwd` returns a fresh empty directory per
 * case). Covers every FR-ADP-11 kind plus timeout and partial_mutation. `auth_missing` is a logged-out run: no
 * logged-out record is sourced (TDD §4.8.1 item 3, T4.71) and the adapter never narrows a failure from text, so the run
 * fails closed as TOOL_FAILURE; `AUTH_REQUIRED` naming `muse login` is the T4.74 preflight's, before any spawn.
 */
export function museConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (writable = true): CompileRequest => ({
    runId: "run_muse_conformance",
    objective: "synthetic muse objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable },
    bypassApproved: true,
  });
  const base = { profile: PRIVILEGED_BYPASS_PROFILE } as const;
  return [
    {
      ...base,
      kind: "success",
      adapter: replayAdapter("success_edit", { write: "hello.txt" }),
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
      kind: "task_failure",
      adapter: replayAdapter("task_failure"),
      request: request(),
      // Detail and session id: a compile the replay refuses (exit 64 or 65, no output) is TOOL_FAILURE too.
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: TASK_FAILURE_DETAIL,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Tests still fail.",
      },
    },
    {
      ...base,
      kind: "auth_missing",
      adapter: replayAdapter("auth_missing"),
      request: request(),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: AUTH_MISSING_DETAIL,
        nativeSessionId: null,
        summary: null,
      },
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
      binding: { provider: "muse", nativeSessionId: RESUMED_SESSION_ID },
      expect: { ok: true, nativeSessionId: RESUMED_SESSION_ID, summary: "Resumed earlier session." },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: replayAdapter("task_failure", { write: "partial.txt" }),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", mutatedPath: "partial.txt" },
    },
  ];
}
