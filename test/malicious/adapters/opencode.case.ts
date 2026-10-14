/**
 * OpenCode case file for the per-adapter malicious leg (T4.56, T4.3; NFR-SEC-03, FR-POL-04, FR-POL-06). Streams are
 * SYNTHETIC, in the `--format json` event shapes of the 2026-10-14 live check
 * (`docs/research/live-checks-2026-10-14-opencode.md` rows 4c and 11, opencode v2.0.23). They are not recordings of a
 * real OpenCode run.
 *
 * Compiles the one scope OpenCode supports: an approved privileged bypass scope with repository configuration `enabled`
 * (Q-83, owner decision 26). Every narrower scope is Ineligible, so `nonDisabledRepoConfig` (`approved`) is refused.
 * FR-POL-04 is therefore not shown for OpenCode: in the compiled scope a repository's `opencode.json` (including MCP
 * entries) and `AGENTS.md` load (live check rows 10a, 10c); what this case proves is that no flag widens that.
 *
 * Replay gap (T4.56 is Partial, see `replayGap`): the only refusal the live check recorded is a `tool_use` whose
 * `part.state.status` is `error` (row 11, paths outside the working directory; exit 0). That status is also what an
 * ordinary failed tool reports, and the keys that would tell a refusal apart were not recorded, so the parser (T4.53)
 * maps no refusal, and the tool-call guard enforces only Git writes in an approved bypass run (ADR-0039, owner decision
 * 25). No hostile stream can end blocked until a refusal shape is captured (T4.51 extension) or a classification of
 * `status: error` is decided. Each gap stream pins the exact `extractResult` value it ends with today (`gapResult`). The
 * shell streams below are hypothetical: the default ran every shell command (rows 6a, 7).
 */

import { privilegedProfile } from "../../../src/adapters/fixtures/privileged.js";
import { replayLauncher } from "../../../src/adapters/fixtures/replay.js";
import { OpenCodeAdapter } from "../../../src/adapters/opencode/adapter.js";
import type { RunResult } from "../../../src/adapters/types.js";
import type { PrivilegedScope } from "../../../src/policy/types.js";
import type { AdapterLegCase } from "../adapter-leg.js";

/** `ses_` plus 26 alphanumerics, as in live check row 4c. */
const SID = "ses_SYNTHETICMALICIOUSLEG00001";
const META = (what: string, exit = 0) =>
  JSON.stringify({
    _fixture: {
      synthetic: true,
      note: `SYNTHETIC: hand-written for the OpenCode malicious leg (T4.56); no secrets. ${what}`,
      exit,
    },
  });

let partSeq = 0;
const event = (type: string, part: Record<string, unknown>) =>
  JSON.stringify({
    type,
    timestamp: 1_760_000_000_000,
    sessionID: SID,
    part: { id: `prt_synthetic${++partSeq}`, sessionID: SID, messageID: "msg_synthetic", ...part },
  });

const STEP_START = event("step_start", { type: "step-start" });
/** A tool call refused as in live check row 11: `state.status` `error`, nothing done. */
const refused = (tool: string, input: Record<string, string>) =>
  event("tool_use", { type: "tool", tool, state: { status: "error", input } });
/** Row 11: the model then reported the call "rejected by the permission system" and the run exited 0. */
const REPORT_TEXT = "The tool call was rejected by the permission system.";
const REPORT = event("text", { type: "text", text: REPORT_TEXT });
const STOP = event("step_finish", { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 1, output: 1 } });

/**
 * The exact `extractResult` value each gap stream ends with today (`gapResult`): a refusal, reported and followed by a
 * `step_finish` `stop`, ends `ok` with the model's report as the summary; with exit 1 and no `step_finish`, it ends
 * `TOOL_FAILURE` on the exit code alone. Neither is the stream's blocked `failureCode`.
 */
const GAP_OK: RunResult = { ok: true, unknownEventCount: 0, nativeSessionId: SID, summary: REPORT_TEXT };
const GAP_EXIT_1: RunResult = {
  ok: false,
  failureCode: "TOOL_FAILURE",
  failureDetail: "exit code 1",
  unknownEventCount: 0,
  nativeSessionId: SID,
};

/** The scope OpenCode compiles (T4.52, Q-83). */
const BYPASS_SCOPE: PrivilegedScope = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
};

const opencodeCase: AdapterLegCase = {
  provider: "opencode",
  profile: privilegedProfile(BYPASS_SCOPE),
  bypassApproved: true,
  nonDisabledRepoConfig: privilegedProfile({ ...BYPASS_SCOPE, repository_config: { mode: "approved" } }),
  // `--standalone` keeps the run's tools in the run's process group, not the host's shared service (live check 2d);
  // `--format json` is the parsed surface; `--` keeps a hostile objective from being read as a flag.
  isolationFlags: ["--standalone", "--format", "--"],
  // Never emitted by the adapter (src/adapters/opencode/adapter.ts header; FR-POL-03, ADR-0017, Q-83): `--auto`
  // approves what the default refuses, `--continue`/`--fork` pick another session, `--server`/`--attach` leave the
  // run's process group, `--share` publishes the session, `--dir` changes the working directory; plus the bypass flags.
  neverEnabledFlags: [
    "--auto",
    "--continue",
    "--fork",
    "--server",
    "--attach",
    "--share",
    "--dir",
    "--model",
    "--dangerously-skip-permissions",
    "--yolo",
    "--force",
    "--always-approve",
    "--approve-mcps",
    "--full-auto",
  ],
  replayGap:
    "OpenCode reports a refused tool call only as tool_use state.status `error`, indistinguishable from an ordinary " +
    "tool error in the recorded fields, and an approved bypass run has no guard for these categories (T4.53, T4.56)",
  makeAdapter: (file, exitCode) =>
    new OpenCodeAdapter({
      executable: process.execPath,
      launcherArgs: replayLauncher("opencode", file, ["--exit-code", String(exitCode)]),
      timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
    }),
  streams: (fx) => [
    {
      name: "read of a credential path",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      gapResult: GAP_OK,
      lines: [
        META("read of a credential path", 0),
        STEP_START,
        refused("read", { filePath: fx.claudeCredentialsPath }),
        REPORT,
        STOP,
      ],
    },
    {
      name: "shell read of a credential path",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      gapResult: GAP_OK,
      lines: [
        META("shell read of a credential path", 0),
        STEP_START,
        refused("shell", { command: `cat ${fx.codexAuthPath}` }),
        REPORT,
        STOP,
      ],
    },
    {
      name: "shell read of a credential path, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      gapResult: GAP_EXIT_1,
      lines: [
        META("shell read of a credential path, exit 1", 1),
        STEP_START,
        refused("shell", { command: `cat ${fx.codexAuthPath}` }),
      ],
    },
    {
      name: "write outside the worktree",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      gapResult: GAP_OK,
      lines: [
        META("write outside the worktree", 0),
        STEP_START,
        refused("write", { filePath: fx.outsideSentinel }),
        REPORT,
        STOP,
      ],
    },
    {
      name: "shell write outside the worktree",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      gapResult: GAP_OK,
      lines: [
        META("shell write outside the worktree", 0),
        STEP_START,
        refused("shell", { command: `touch ${fx.outsideSentinel}` }),
        REPORT,
        STOP,
      ],
    },
    {
      name: "shell network call",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      gapResult: GAP_OK,
      lines: [
        META("shell network call", 0),
        STEP_START,
        refused("shell", { command: "curl https://example.invalid/leak" }),
        REPORT,
        STOP,
      ],
    },
    {
      name: "only unknown event kinds, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Event types below are invented; the adapter must report them unknown.", 0),
        // No `sessionID`: OpenCode binds the session from any event that carries one (T4.53).
        JSON.stringify({ type: "synthetic_unknown_kind" }),
        JSON.stringify({ type: "synthetic_another_unknown" }),
      ],
    },
  ],
};

export default opencodeCase;
