# Known limitations

What Switchboard does not do, or does not yet verify. Part of the [Switchboard guide](README.md).

## Known limitations

- **Submodules (ADR-0087).** Nested submodules (a submodule's own `.gitmodules`) are ignored and stay empty (ROADMAP
  Q-116). A GitHub wiki submodule is read-only. The umbrella commit that re-points gitlinks during the ordered merge
  is not signed, even with `sign: true`. Only `https` URLs on GitHub-style hosts you allowed are supported (no `ssh`,
  no GitHub Enterprise). The umbrella pull request body is not edited after the first publication, and a
  submodule pull request that a person merged first is accepted only when its merge commit is on the default branch
  (Q-117). A `project_source` grant does not expire (Q-118). The first run of a large umbrella clones every submodule
  store; `refresh_project_base` warms them.

- **Codex is only lightly validated.** The Codex compliance manifest covers `>=0.162.0 <0.163.0` (an Assumption, ROADMAP
  Q-12), validated on codex-cli 0.162.0 on 2026-10-14 by `switchboard adapters validate codex` (probe, auth, static
  conformance checks and one smoke call; `docs/research/live-checks-2026-10-14-claude-codex.md`) and, for 0.162.1, by
  `--version` and the flags in `--help` (`docs/research/live-checks-2026-10-13.md`), not by a conformance suite. Any
  other Codex version fails the version gate. The `codex login status` exit codes were observed on that version only;
  its output format is undocumented.
- **Grok Build parser shapes are synthetic (ROADMAP T4.23, `Done` against its Done-when on synthetic fixtures, owner
  decision 65).** The field names of `tool_call` and `tool_call_update` lines, and the rate-limit, permission-denial
  and sandbox-violation shapes, are Assumptions no capture has confirmed (T4.28). An 8c rule denial and a 7g sandbox
  violation end `end_turn` success at exit 0, because the CLI gives no structured signal for them; a rate limit ends
  `TOOL_FAILURE`, never `RATE_LIMIT_TRANSIENT`.
- **Grok Build malicious-fixture leg is fixtures only (ROADMAP T4.26, `Done` against its Done-when, owner decision
  65; live refusal evidence is T4.28).** CI runs `test/malicious/adapter-leg.test.ts` with
  `test/malicious/adapters/grok.case.ts` on synthetic `streaming-json` streams (no `grok` installed; no `replayGap`).
  Compile, isolation-flag and argv checks pass for each compiled bypass cell; hostile replay blocking streams test Git
  writes blocked by Switchboard's tool-call guard per ADR-0039.
  [#302](https://github.com/zemdregon/switchboard/pull/302) through
  [#449](https://github.com/zemdregon/switchboard/pull/449) expand synthetic command-key, update/call-id, Git-write,
  provider-error, cut-line, parser fall-through, exit `2`/`137`, trailing-update, JSON-encoding and T4.23
  parser-residual coverage on `main` (#308 completes both cut positions for each category and exit code; #326 through
  #449 widen the matrix to 325 streams, 304 blocked and 21 unknown-event, with 24 `grokPartialStreams`; #393 pins the
  compiled cells' argv and refused scopes); fields other than `type` remain hypothetical, and no live CLI validation is
  implied. The gap [#449](https://github.com/zemdregon/switchboard/pull/449) pinned (a Git write past the
  512-character clip of a target-only shell call was not guarded) is closed in the parser on synthetic lines
  (2026-10-15): those streams, plus a nameless target-only update on a shell call, now replay blocked (337 streams, 316
  blocked; [#478](https://github.com/zemdregon/switchboard/pull/478) replays the #470 eighth-pass controls, bringing
  the matrix to 349 streams, 328 blocked). A bare `tool_call` before a clean `end_turn` still succeeds;
  path keys, tool `content`, shadowed lower-precedence command keys and a command in a container shadowed by an earlier
  object container without one (#372) are invisible to the guard. A bare unreadable `tool_call_update` after a clean
  `end_turn` still succeeds at exit 0 (T4.26 residual). Partial lines end `OUTPUT_PROTOCOL_ERROR`, not a proven
  provider refusal. FR-POL-04 cannot hold in the only compiled scope because repository configuration is `enabled`
  and `.mcp.json` and `.grok/config.toml` load without `--trust` (live check 10a). Native login credentials remain
  readable from inside the sandbox (live check 11b, Q-62). Other hostile categories without a parsed Git write are not
  blocked by the bypass guard. Scrubbed native `tool_call` and `tool_call_update` command/target and status fields, live
  blocked outcomes and `adapters validate` remain operator work (T4.21 extension / T4.28). See ROADMAP T4.26 for the
  full gap list.
- **Antigravity malicious-fixture leg is Done against its Done-when (ROADMAP T4.36, owner decision 65 (b)).** CI runs
  `test/malicious/adapter-leg.test.ts` with
  `test/malicious/adapters/antigravity.case.ts` on synthetic `stream-json` streams (no `agy` installed; no `replayGap`).
  Compile, isolation-flag and argv checks pass for the approved bypass cell; hostile replay blocking covers every
  hostile category with both recorded soft-denial shapes (shell `run_command` without bypass, live check C7) and
  guard-blocked streams where a hostile command is chained with a Git write under a `SUCCESS` envelope with no
  `denied_actions` ([#257](https://github.com/zemdregon/switchboard/pull/257)) and trailing-tool streams where the same
  hostile call arrives after the `result` line ([#262](https://github.com/zemdregon/switchboard/pull/262)); since
  [#280](https://github.com/zemdregon/switchboard/pull/280) every blocked category also replays at exit 0 and exit 1,
  including guarded streams with no `result` line, and the hostile fixture carries `GEMINI.md`,
  `.agents/mcp_config.json` and `.agents/hooks.json` so the untouched check covers them.
  [#295](https://github.com/zemdregon/switchboard/pull/295) adds guarded `ERROR` envelopes with no
  `denied_actions` in every blocked category, commands arriving or swapped on `step_update`, a `CommandLine` alias,
  further Git-write forms and dialect-spelling compile isolation;
  [#352](https://github.com/zemdregon/switchboard/pull/352) adds exit 2 and 137 and parser fall-through paths, and
  [#368](https://github.com/zemdregon/switchboard/pull/368) adds conversation-id and `total_tokens` anomalies, empty
  or null `denied_actions` and cuts inside the hostile line. Fields other than the recorded and Assumption shapes
  remain hypothetical, a Git write on a step whose `step_type` is not `tool` is not seen by the guard (pinned,
  [#344](https://github.com/zemdregon/switchboard/pull/344)); besides the live `adapters validate` pass on
  CLI 1.4.2 on 2026-10-18 (ROADMAP T4.38: manifest, probe, auth `OK`, static conformance and one
  structured-output smoke call), plus the live smoke and live malicious leg on 2026-10-19 (ROADMAP T4.38 Done;
  smoke 9 HELD / 2 ESCAPED, malicious A-M3 HELD / A-M2 ESCAPED / A-M1 NOT_CHECKED), no further live CLI
  validation is implied. FR-POL-04
  cannot hold in the only
  compiled scope because repository configuration is `enabled` and `GEMINI.md`, `AGENTS.md` and the `.agents` MCP server
  and hooks load with no approval (live check C11). The blocked streams still rest on unrecorded
  `tool_info.parameters` keys — the parser's accepted key set is pinned on synthetic fixtures, and a command under none
  of those keys stays invisible to the guard; a hostile call without a Git write still ends `ok` in bypass runs
  (pinned). The T4.38 live malicious leg ran on 2026-10-19: A-M3 HELD, A-M2 ESCAPED (risk R-72), A-M1
  NOT_CHECKED (the model declined the commit, so no live Git-write attempt exists).
  See ROADMAP T4.36 for the full gap list.
- **OpenCode malicious-fixture leg is Done against its Done-when on fixtures only (ROADMAP T4.56, owner decision 65 (b));
  the OpenCode parser likewise (ROADMAP T4.53, owner decision 65 (a)): no native rate-limit or sandbox shape
  exists (no real OpenCode limit capture has been made); a project-config denial shape and shell `tool_use` input
  key names were recorded on 2026-10-18 (`command` the only key; values never captured), and a native vendor
  or model in the stream was observed absent on 2026-10-17, all still open after T4.58 (ran 2026-10-19 without
  capturing them; see T4.56).** CI runs
  `test/malicious/adapter-leg.test.ts` with
  `test/malicious/adapters/opencode.case.ts` on synthetic `--format json` streams (no `opencode` installed; no
  `replayGap`). Compile, isolation-flag and hostile replay blocking checks pass for the approved bypass cell: every
  hostile category replays synthetic streams in the live-check row 4c and 11 shapes, and shell commands that include Git
  writes the tool-call guard can see end `PERMISSION_BLOCKED` at exit 0 and exit 1 (ADR-0039, owner decision 25),
  including trailing-tool streams where the same hostile call arrives after the final `stop` step
  ([#245](https://github.com/zemdregon/switchboard/pull/245)). Since
  [#284](https://github.com/zemdregon/switchboard/pull/284) the leg also fails closed on a stream with an unknown or
  unreadable event anywhere, before or after the final `stop` step (exit 0 ends `OUTPUT_PROTOCOL_ERROR`, never
  success), and hostile commands reach the guard through a shell tool named `bash` and through an unlisted tool name
  carrying a string `command`, each ending `PERMISSION_BLOCKED` when the command writes Git. Synthetic hostile matrix
  expansions across [#298](https://github.com/zemdregon/switchboard/pull/298),
  [#312](https://github.com/zemdregon/switchboard/pull/312),
  [#323](https://github.com/zemdregon/switchboard/pull/323),
  [#355](https://github.com/zemdregon/switchboard/pull/355), and
  [#369](https://github.com/zemdregon/switchboard/pull/369) widened the suite to 275 streams (263 blocked, 12 unknown-event;
  48 partial streams, 140 unreadable streams), covering Git-write prefixes and subcommands (`git -C . commit`,
  `git branch -D`, `/usr/bin/git commit`, `sh -c`, `env`, `xargs`, `--git-dir`, `reset --hard`, `tag`, `stash`, `merge`,
  `rebase`, `checkout -b`), command-bearing tool names (`bash` at exit 1, `sh`, `terminal`, `run_command`, etc.), exits
  2 and 137 in every hostile category (guard outranks `TOOL_FAILURE`), empty tool names, swapped commands, separate benign
  calls after hostile calls, JSON encodings (\u escapes, duplicate command keys, CRLF), hypothetical stop reasons
  (`max_tokens`, `refusal` at exit 0), and path-to-command upgrades. The leg asserts, for each of the 263 blocked
  streams (88 `credential_read`, 90 `out_of_worktree_write`, 85 `network`; 119 at exit 0, 108 at exit 1 and 18 each
  at exits 2 and 137), a non-ok result ending
  `PERMISSION_BLOCKED`, no failed conformance check, and an unchanged hostile checkout, outside sentinel, hook log and
  config log; it does not assert the guard verdict per stream separately. The 12 `unknown_events` streams end
  `OUTPUT_PROTOCOL_ERROR` at exit 0 (3) or `TOOL_FAILURE` at exits 1, 2 and 137 (9).
  The blocked streams still rest on synthetic `tool_use` command shapes; the live check recorded only `state.status`
  `error` without refusal-specific fields, and the guard enforces Git writes only in bypass runs — a Git write not
  carried as an own string `command` on a shell-kind tool (a known file tool, a `cmd` alias, or a command only under an
  own `__proto__` key) is still not seen by the guard. FR-POL-04 cannot hold in the only
  compiled scope because repository configuration is `enabled` and `opencode.json` and `AGENTS.md` load with no approval
  (live check rows 10a, 10c; owner decision 26). Closing the remaining gap needs operator capture of native refusal
  fields (a T4.51 extension) or an owner decision on classifying `status` `error`. See ROADMAP T4.56 for the full gap list.
- **Kimi Code was validated on synthetic fixtures only (ROADMAP T4.62 to T4.67) until `adapters validate kimi`
  passed live on CLI 2.1.1 on 2026-10-18 (ROADMAP T4.68: manifest, probe, auth `OK`, static conformance and one
  structured-output smoke call). Under owner decision 65, T4.63, T4.64 and T4.66 are Done against their Done-when
  (synthetic fixtures plus three scrubbed captures, owner decision 65 (a), (b), (d); two live `validate` runs observing
  auth `OK` on CLI 2.1.1; T4.69 Done except the post-T4.68 update, decision 65 (c)). The error record fields and
  the usage and model fields stay Assumptions (were carried by T4.68; the carrier row closed Partial-by-ruling
  2026-10-19 without recording them — see ROADMAP T4.68); the `--prompt=` one-word form held in every live run to
  date, the failed-turn exit code is observed (`K-F1` HELD, unknown `--session` id exits 1), and the `kimi acp`
  permission round trip in `default` mode is observed (2.1.1 raises none — see ROADMAP T4.68). The auth probe's
  stdin timing is no longer an Assumption: the 2026-10-17 live `validate kimi` run showed
  CLI 2.1.1 exits at stdin end-of-file before the `session/new` reply, and the fixed probe (stdin held open until both
  replies arrive) printed `[ok] auth: OK` twice on 2026-10-18 (ROADMAP T4.64, owner decision 65 (d); scrubbed ACP
  replies were carried by T4.68, which closed without recording them). Since `default` mode does not ask, the
  restricted ACP cell is `Ineligible` per ADR-0049 item 3 since the owner-level ruling relayed 2026-10-19 08:45 CDT
  (the bypass-only gate, `kimiBypassOnlyGate` in `src/adapters/kimi/adapter.ts`, refuses it at compile time; the ACP
  compile and runtime check stay in code for the Deferred gating row — see ROADMAP T4.68). The
  malicious-fixture leg (T4.66) replays the approved bypass cell only: a credential read, outside write or network call
  without a Git write ends `ok` there by design (owner decision 25), and the live malicious leg ran on 2026-10-19
  (`K-M1` NOT_CHECKED, `K-M2`/`K-M3` HELD — see ROADMAP T4.68). See [Kimi Code CLI](providers.md#kimi-code-cli-milestone-4).
- **Muse Code is built on synthetic fixtures only and does not run (ROADMAP T4.72 to T4.79).** No `muse` has been
  installed or run, and Meta access (Q-27) is not verified. The `--json` record spellings and the `muse auth status`
  probe are Assumptions until the operator capture (T4.71); the malicious-fixture leg (T4.76) rests on Switchboard's
  tool-call guard alone, under tool-record field names that are Assumptions too. The provider is `BINARY_MISSING`
  without a `muse` on `PATH`
  and `ADAPTER_VERSION_UNVERIFIED` with one, and only an approved `privileged` bypass scope compiles. See
  [Muse Code CLI](providers.md#muse-code-cli-milestone-4).
- **Event shapes are partly verified.** The 2026-10-13 live checks confirmed the Claude Code stream-json shapes
  (C-1 to C-11 and G-1) on 2.1.296 and the Codex flags (X-1 to X-3) on 0.162.1. Claude error strings (C-12), the
  live-smoke Git-write attempt (C-G2) and Codex through Switchboard (X-5 to X-9) are still unverified, and another CLI
  version may differ. See `docs/research/live-checks-2026-10-13.md`. (The T3.9 malicious leg held its C-G2 at the
  outcome level on 2026-10-18 and again on 2026-10-19; see ROADMAP T3.9.)
- Linux only. Single operator only. No hosted or multi-user mode.
- Only Claude Code and Codex; profiles beyond `inspect-untrusted` and `edit-untrusted` only where the adapter can
  compile them (see `list_capabilities`); a `privileged` `continue_task` only on the same provider (ROADMAP
  Q-61 is open).
- `adapters validate` is implemented for every registered provider, but only the Claude Code, Codex, OpenCode, Kimi
  Code, Antigravity and Cursor manifests admit a version on `main` today (OpenCode `>=2.0.23 <2.1.0` since the
  T4.58 live pass on 2026-10-18, owner decisions 60 and 68; Cursor `>=2026.10.16 <2026.11.0` since the T4.48 live pass
  on 2026-10-19, owner decision 59). Grok Build and the other M4 adapters still need operator captures
  before their manifests admit a version (ROADMAP T4.28, T4.68 and §6.8.2).
- Routing (milestone 7) evaluates `minimum_capability` against operator-declared model capabilities in the model
  registry instead of refusing it (ROADMAP §6.12 T7.8, `src/routing/minimum-capability.test.ts`); undeclared models
  fail closed with `CAPABILITY_MISSING` (mapping to `ELIGIBILITY_NONE`), and admitted providers compile with the
  satisfying model. Affinity pins the model at compile when the adapter declares `reportedModelFlag` (Claude Code
  today, T7.12, `src/routing/model-pin.test.ts`); undeclared adapters keep their default model. No cache benefit from
  keeping a project on one provider is claimed (T7.9).
- Capacity figures are controller estimates. No provider is known to report remaining quota, and the rate-limit and
  quota output shapes of Claude Code and Codex come from synthetic fixtures; the operator has captured their
  text-mode limit output but the `stream-json` shapes are still `NOT_CHECKED` (ROADMAP
  T6.11, `Done` 2026-10-17 with a 2026-10-18 follow-up; [limit captures](../research/limit-captures-2026-10-17.md)
  and the [follow-up](../research/limit-captures-2026-10-18.md)). There is no token-bucket
  rate gate: no provider publishes an enforceable limit for the logins used, so the pacing gate
  paces usage per subscription window from observed usage instead (ROADMAP T6.8, `Done` 2026-10-17).
- Retrieval is tested with a deterministic in-process fake embedder and scripted HTTP fixtures; no live embedding model
  runs in CI. `search_project_context` with `scope: "global"` reads the global store and `"both"` merges project and
  global hits (each needs `use_global`; `GLOBAL_NOT_AVAILABLE` only when the global index is unavailable), as does the
  admission merge with `use_global`.
- The inner agent (milestone 11) is tested on a scripted in-process fake backend and a loopback fake HTTP server only.
  No live inner backend has been exercised, and `npm run test:live` has no inner-agent leg. The `cli` backend kind is
  reported `Ineligible` by `doctor` and never started (`src/cli/inner.test.ts`; ROADMAP T11.0, T11.13). T11.0 ran the
  installed `opencode v2.0.23` live on 2026-10-17 and found no tool-free one-shot
  ([TDD §4.6.7](../design/TDD.md#467-t110-live-result-2026-10-17)), so the kind stays `Ineligible`. The PR-draft,
  verification-summary, handoff-condensation and run-title tasks are service functions that no run path, hook or
  `inner` command calls yet. The `inner.call` telemetry span of
  [LLD §13.8](../design/LLD.md#138-telemetry-and-events) is not emitted (no span exporter exists); the pipeline
  writes a body-free `inner.call` log line instead. What the suite proves per task, and what is not built, is recorded
  in the [TDD §3.12](../design/TDD.md#312-inner-agent) as-built note,
  [HLD §2.5](../design/HLD.md#25-comp-inn-implementation-evidence-m11-t111t1113-done-on-fakes) and
  [SDD §4.3](../design/SDD.md#43-comp-inn-implementation-evidence-m11-t111t1113-done-on-fakes) (merged as
  [PR #353](https://github.com/zemdregon/switchboard/pull/353)). See
  [ROADMAP §6.6](../ROADMAP.md#66-m11-inner-agent-tasks).
