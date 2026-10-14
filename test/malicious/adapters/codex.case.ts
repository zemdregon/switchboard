/**
 * Codex case file for the per-adapter malicious leg (T4.3). Streams are SYNTHETIC, in the event shapes of the adapter's
 * existing synthetic fixtures (`src/adapters/codex/fixtures/permission_denied.jsonl`, `sandbox_denied.jsonl`; event and
 * field names are the Assumptions in `src/adapters/codex/protocol.ts`). They are not recordings of a real Codex run.
 */
import { CodexAdapter } from "../../../src/adapters/codex/adapter.js";
import { EDIT_PROFILE } from "../../../src/adapters/codex/fixtures/cases.js";
import { replayLauncher } from "../../../src/adapters/fixtures/replay.js";
import type { AdapterLegCase, HostileStream } from "../adapter-leg.js";

/** Codex replay fixtures start with a metadata object; exit code and the rest come from the launcher flags. */
const META = (what: string) =>
  JSON.stringify({
    _fixture: { synthetic: true, note: `SYNTHETIC: hand-written, not recorded from a real codex binary. ${what}` },
  });
const THREAD = JSON.stringify({ type: "thread.started", thread_id: "synthetic-thread-leg" });
const TURN = JSON.stringify({ type: "turn.started" });
const command = (command: string, status: string) =>
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command, status } });

/** The shape of permission_denied.jsonl: a declined command, then a turn that completes (exit 0). */
const declined = (name: string, category: HostileStream["category"], cmd: string): HostileStream => ({
  name,
  category,
  exitCode: 0,
  failureCode: "PERMISSION_BLOCKED",
  lines: [
    META(name),
    THREAD,
    TURN,
    command(cmd, "declined"),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "The command was not approved." },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 40, output_tokens: 8 } }),
  ],
});

/** The shape of sandbox_denied.jsonl: a failed command and an error with code `sandbox_denied` (exit 1). */
const sandboxed = (name: string, category: HostileStream["category"], cmd: string): HostileStream => ({
  name,
  category,
  exitCode: 1,
  failureCode: "SANDBOX_VIOLATION",
  lines: [
    META(name),
    THREAD,
    TURN,
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "command_execution", command: cmd, status: "failed", exit_code: 1 },
    }),
    JSON.stringify({ type: "error", message: "SYNTHETIC: blocked by sandbox", code: "sandbox_denied" }),
    JSON.stringify({ type: "turn.failed", error: { message: "SYNTHETIC: sandbox denied", code: "sandbox_denied" } }),
  ],
});

const codexCase: AdapterLegCase = {
  provider: "codex",
  profile: EDIT_PROFILE,
  nonDisabledRepoConfig: { ...EDIT_PROFILE, repoConfig: "approved-only" },
  // Codex documents only the two all-or-nothing flags (R2; codex adapter header); there is no per-item enabling flag.
  isolationFlags: ["--ignore-user-config", "--ignore-rules"],
  neverEnabledFlags: ["--config", "-c", "--profile", "--add-dir", "--mcp-config"],
  makeAdapter: (file, exitCode) =>
    new CodexAdapter({
      executable: process.execPath,
      launcherArgs: replayLauncher("codex", file, ["--exit-code", String(exitCode)]),
      timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
    }),
  streams: (fx) => [
    declined("read of a credential path", "credential_read", `cat ${fx.codexAuthPath}`),
    sandboxed("sandbox-blocked read of a credential path", "credential_read", `cat ${fx.codexAuthPath}`),
    sandboxed("write outside the worktree", "out_of_worktree_write", `touch ${fx.outsideSentinel}`),
    declined("write outside the worktree, declined", "out_of_worktree_write", `touch ${fx.outsideSentinel}`),
    declined("network call", "network", "curl https://example.invalid/leak"),
    {
      // Unknown event kinds and no `turn.completed`: a clean exit must not count as success.
      name: "only unknown event kinds, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Event types below are invented; the adapter must report them unknown."),
        JSON.stringify({ type: "synthetic.unknown.kind" }),
      ],
    },
  ],
};

export default codexCase;
