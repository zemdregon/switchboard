/**
 * Claude Code case file for the per-adapter malicious leg (T4.3). Streams are SYNTHETIC, in the event shapes of the
 * adapter's existing synthetic fixtures (`src/adapters/claude/fixtures/permission-denied.jsonl`,
 * `sandbox-violation.jsonl`; shapes are the Assumption documented in `src/adapters/claude/parse.ts`). They are not
 * recordings of a real Claude Code run. Isolation flags come from the adapter's own documented constants.
 */
import { CLAUDE_ISOLATION_FLAGS, ClaudeAdapter } from "../../../src/adapters/claude/adapter.js";
import { EDIT_UNTRUSTED } from "../../../src/adapters/claude/fixtures/cases.js";
import { replayLauncher } from "../../../src/adapters/fixtures/replay.js";
import type { AdapterLegCase, HostileStream } from "../adapter-leg.js";

const SID = "{{SESSION_ID}}";
const NOTE = (what: string) =>
  JSON.stringify({
    _fixture: `SYNTHETIC: hand-written for Switchboard tests (T4.3), not a recorded transcript; no secrets. ${what}`,
  });
const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: SID,
  model: "synthetic-model",
  cwd: ".",
  tools: ["Read", "Grep", "Glob", "Edit", "Write"],
  permissionMode: "dontAsk",
});
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    session_id: SID,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
const toolError = (id: string, text: string) =>
  JSON.stringify({
    type: "user",
    session_id: SID,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] },
  });
/** A run that ends `success` at the CLI level but carries the provider's own denial record (FR-POL-05). */
const deniedResult = (id: string, tool: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "I could not do that.",
    session_id: SID,
    num_turns: 2,
    duration_ms: 300,
    permission_denials: [{ tool_name: tool, tool_use_id: id, tool_input: input }],
  });

const denied = (
  name: string,
  category: HostileStream["category"],
  tool: string,
  input: Record<string, unknown>,
): HostileStream => ({
  name,
  category,
  exitCode: 0,
  failureCode: "PERMISSION_BLOCKED",
  lines: [
    NOTE(name),
    INIT,
    toolUse("toolu_leg_1", tool, input),
    toolError("toolu_leg_1", "permission denied (synthetic)"),
    deniedResult("toolu_leg_1", tool, input),
  ],
});

const claudeCase: AdapterLegCase = {
  provider: "claude",
  profile: EDIT_UNTRUSTED,
  nonDisabledRepoConfig: { ...EDIT_UNTRUSTED, repoConfig: "approved-only" },
  isolationFlags: CLAUDE_ISOLATION_FLAGS,
  // Never emitted by the adapter (its header comment, FR-POL-03/FR-POL-08): these would load repository or user
  // settings, MCP definitions or plugins.
  neverEnabledFlags: ["--mcp-config", "--setting-sources", "--settings", "--plugin-dir", "--add-dir", "--worktree"],
  makeAdapter: (file, exitCode) =>
    new ClaudeAdapter({
      binaryPath: process.execPath,
      launcherArgs: replayLauncher("claude", file, ["--exit-code", String(exitCode)]),
      timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
    }),
  streams: (fx) => [
    denied("read of a credential path", "credential_read", "Read", { file_path: fx.claudeCredentialsPath }),
    denied("shell read of a credential path", "credential_read", "Bash", {
      command: `cat ${fx.claudeCredentialsPath}`,
    }),
    {
      ...denied("write outside the worktree", "out_of_worktree_write", "Write", {
        file_path: fx.outsideSentinel,
        content: "x",
      }),
    },
    {
      // The shape of sandbox-violation.jsonl: the CLI ends in error with the category "sandbox".
      name: "write outside the worktree, sandbox category",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "SANDBOX_VIOLATION",
      lines: [
        NOTE("Error category 'sandbox' is an Assumption (see sandbox-violation.jsonl)."),
        INIT,
        toolUse("toolu_leg_2", "Write", { file_path: fx.outsideSentinel, content: "x" }),
        toolError("toolu_leg_2", "blocked by sandbox (synthetic)"),
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          error: "sandbox",
          session_id: SID,
          num_turns: 1,
          duration_ms: 150,
        }),
      ],
    },
    denied("network fetch", "network", "WebFetch", { url: "https://example.invalid/leak" }),
    denied("shell network call", "network", "Bash", { command: "curl https://example.invalid/leak" }),
    {
      // Unknown event kinds and no `result` event: a clean exit must not count as success.
      name: "only unknown event kinds, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        NOTE("Event types below are invented; the adapter must report them unknown."),
        JSON.stringify({ type: "synthetic_unknown_kind", session_id: SID }),
        JSON.stringify({ type: "system", subtype: "synthetic_unknown_subtype", session_id: SID }),
      ],
    },
  ],
};

export default claudeCase;
