/**
 * Codex conformance cases over synthetic recorded fixtures (T2.2, FR-ADP-11). Test-only (excluded from the build):
 * the adapter runs `node replay.mjs <fixture>` in place of the codex binary.
 */
import { fileURLToPath } from "node:url";
import type { ConformanceCase } from "../../conformance.js";
import type { CompileRequest, ResolvedProfile } from "../../types.js";
import { CodexAdapter } from "../adapter.js";

export const REPLAY_PATH = fileURLToPath(new URL("./replay.mjs", import.meta.url));
export const fixturePath = (name: string) => fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url));

/** SRS §3.3 defaults for the two M2 profiles. */
export const INSPECT_PROFILE: ResolvedProfile = {
  name: "inspect-untrusted",
  fileAccess: "read-only",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
export const EDIT_PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "allowlist",
  shellAllowlist: [],
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

const SHORT = { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 };

export function replayAdapter(fixture: string, timeouts?: Partial<typeof SHORT>): CodexAdapter {
  return new CodexAdapter({
    executable: process.execPath,
    launcherArgs: [REPLAY_PATH, fixturePath(fixture)],
    timeouts: { ...SHORT, ...timeouts },
  });
}

export function codexConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (writable = true): CompileRequest => ({
    runId: "run_codex",
    objective: "synthetic objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable },
  });
  const edit = { profile: EDIT_PROFILE } as const;
  return [
    {
      ...edit,
      kind: "success",
      adapter: replayAdapter("success_edit"),
      request: request(),
      expect: { ok: true, nativeSessionId: "synthetic-thread-0001", mutatedPath: "hello.txt" },
    },
    {
      profile: INSPECT_PROFILE,
      kind: "success",
      adapter: replayAdapter("success_inspect"),
      request: request(false),
      expect: { ok: true, nativeSessionId: "synthetic-thread-0002" },
    },
    {
      ...edit,
      kind: "task_failure",
      adapter: replayAdapter("task_failure"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE" },
    },
    {
      ...edit,
      kind: "auth_missing",
      adapter: replayAdapter("auth_missing"),
      request: request(),
      expect: { ok: false, failureCode: "AUTH_REQUIRED" },
    },
    {
      ...edit,
      kind: "rate_limit",
      adapter: replayAdapter("rate_limit"),
      request: request(),
      expect: { ok: false, failureCode: "RATE_LIMIT_TRANSIENT" },
    },
    {
      ...edit,
      kind: "malformed_output",
      adapter: replayAdapter("malformed_output"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" },
    },
    {
      ...edit,
      kind: "timeout",
      adapter: replayAdapter("hang", { idleMs: 400 }),
      request: request(),
      expect: { ok: false, failureCode: "PROCESS_TIMEOUT" },
    },
    {
      ...edit,
      kind: "cancellation",
      adapter: replayAdapter("hang", { idleMs: 10_000 }),
      request: request(),
      expect: { ok: false, failureCode: "CANCELLED" },
    },
    {
      ...edit,
      kind: "resume",
      adapter: replayAdapter("resume"),
      request: request(),
      binding: { provider: "codex", nativeSessionId: "synthetic-thread-0042" },
      expect: { ok: true, nativeSessionId: "synthetic-thread-0042" },
    },
  ];
}
