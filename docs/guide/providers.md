# Provider notes

Per-provider login, trust profile, parser and Git notes for the milestone 4 adapters. Part of the [Switchboard guide](README.md).

## Grok Build CLI (milestone 4)

Config id `grok-build`; routing and `list_capabilities` id `grok-build`. Switchboard runs the **`grok`** binary with
`--single=<prompt> --output-format streaming-json`
([TDD §4.3.1](../design/TDD.md#431-grok-build-native-controls-per-profile-and-platform-t420); observed on
2026-10-14 in [`docs/research/live-checks-2026-10-14-grok.md`](../research/live-checks-2026-10-14-grok.md),
`grok 1.0.50`). The prompt is one argv word (`--single=<prompt>`), not stdin (an Assumption in the adapter: the `=`
form ensures flags cannot be smuggled by a leading `-` in the prompt; the prompt is visible in the process table).
Switchboard passes an environment allowlist (`PATH` and `HOME`) and never sets `GROK_HOME` (which would alter or hide
native login), `XAI_API_KEY` (credentials stay out of the child environment, ADR-0003), or `GROK_SANDBOX` (the
sandbox profile is always an explicit `--sandbox` flag so the audit sees it).

The compliance manifest range admits no version until an operator runs `switchboard adapters validate grok-build` and
commits the manifest diff (ROADMAP T4.28). Until then `doctor` reports `ADAPTER_VERSION_UNVERIFIED` for Grok Build.
Live state on 2026-10-18 (operator run through the budgeted channel, `grok 1.0.50`): probe, auth (`OK`) and the
conformance step passed in the adapter's only compiled cell (owner decision 59), and the smoke step stopped on a
`streaming-json` error line carrying a provider usage-limit message (classified `TOOL_FAILURE`), so nothing was written
and the range still admits no version. No end-to-end run, live malicious leg or native tool-call capture exists yet.

### Login

See the [login table](getting-started.md#log-in-to-the-providers-natively) above. Switchboard never runs `grok login`.
The `doctor`
probe runs `grok version` and `grok --help` (the help text must list the required flags), and auth preflight runs
`grok models`, which lists model names and makes no model call (`src/adapters/grok/protocol.ts`).

### Trust profiles

The adapter compiles only what [TDD §4.3.1](../design/TDD.md#431-grok-build-native-controls-per-profile-and-platform-t420)
records for the 2026-10-14 live check (Q-62): every profile other than an approved `privileged` bypass scope is refused
(`PROFILE_UNSUPPORTED`), because `dontAsk` did not show a deny without a matching allow rule, deny rules are prefix
matches only (so Git-write denial via `--deny` is not a control Switchboard can rely on), the native login file is
readable from inside the sandbox, and no per-run MCP-definition flag exists in headless mode.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`) |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). An approved scope with `bypass` compiles one of three scope shapes: `grok --no-auto-update --single=<prompt> --output-format streaming-json` with `--sandbox <profile>` and `--always-approve` together (never one without the other), shell `broad`, repository configuration `enabled`, and either worktree file access (with network `on` for sandbox profile `workspace`, or network `off` with `--disable-web-search` for `strict`) or `read-only` file access or a read-only workspace request (with network `off` with `--disable-web-search` for `read-only`) (owner decision 46). A scope without `bypass`, or any narrowing Switchboard can express (read-only files with network `on` because `read-only` blocks child network on Linux only, shell allowlist or `none`, network `allowlist`, repository configuration `disabled` or `approved`, or model overrides), is refused before spawn (`Ineligible`). No `--allow` or `--deny` rules are emitted (prefix matches are not a Git-write control). |

Resume continues the native session with `-r <session_id>` through the same matrix when the provider is eligible
(synthetic fixtures in `src/adapters/grok/grok.test.ts`, T4.23). `resumeArgs` mirrors `compile` across every structured
scope shape (the full `scopeShapes()` sweep with `bypassApproved` true/false; exactly three compiled bypass shapes)
appending only `-r <id>`, and rejects foreign provider bindings and ineligible profiles with exact reasons
([#331](https://github.com/zemdregon/switchboard/pull/331)). A `sessionId` that resume could not pass as one safe
argument (matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`, refusing leading dashes or flag syntax) is never bound
(`OUTPUT_PROTOCOL_ERROR` on the stream, `CAPABILITY_MISSING` in `resumeArgs`;
[#252](https://github.com/zemdregon/switchboard/pull/252)). Resumed runs pass every policy flag again because
whether permission mode persists without flags is unverified (`resumeCwd` is `unverified`, TDD §4.10, live check 14a).
A `tool_call` after the `end` line is not a success (fail closed; a guard verdict on it keeps its own code, e.g.
`PERMISSION_BLOCKED`; an unreadable trailing `tool_call` line that normalizes as `unknown` also fails closed as
`OUTPUT_PROTOCOL_ERROR` with detail `tool call after the end line`). A bare unreadable `tool_call_update` after a clean
`end_turn` (for example only `status` and `content`, with no readable command) still ends `ok` at exit 0 today: it
carries no command the guard can read, but it is inconsistent with the trailing `tool_call` rule (ROADMAP T4.28 gap;
parser change is outside fixture-only work). The `tool call after the end line` detail is set only when the code is
`OUTPUT_PROTOCOL_ERROR`; under a cancelled `stopReason` or a non-zero exit the classifier's own detail is kept
([#372](https://github.com/zemdregon/switchboard/pull/372)). A clean `end_turn` line is never the run verdict on its
own: a process that never exits after it ends `PROCESS_TIMEOUT` on the idle timeout or `CANCELLED` on cancel
(`hang_after_end.jsonl`), the same clean stream at exit `1`, `2` or `137` ends `TOOL_FAILURE`, and a line over the
compiled 1 MiB `maxLineBytes` after it ends `OUTPUT_PROTOCOL_ERROR`, each keeping the structured session id
([#342](https://github.com/zemdregon/switchboard/pull/342), [#351](https://github.com/zemdregon/switchboard/pull/351)).
An `error` line with an empty message is still a provider error, and an empty `stopReason` is a result that is not
success ([#372](https://github.com/zemdregon/switchboard/pull/372)). `tool_call` keys that name `Object.prototype`
members map to `other`, prototype-named types never smuggle a result, and only an exact `end_turn` stop reason is
success ([#252](https://github.com/zemdregon/switchboard/pull/252)). Non-string command, path and tool fields are
omitted, never coerced. Structured `backing_provider`/`backingProvider` and `model`/`model_id` (or inferred from
`modelUsage` keys, resolving the first own key when several are present; empty or non-object `modelUsage` binds no
model, [#313](https://github.com/zemdregon/switchboard/pull/313)) on the `end` line set `backingProvider` and `model`
on `session_bound` (with prototype pollution protection, non-strings dropped, clipped to 128 characters) and are stored
on `provider_reported` usage rows side by side with the harness `grok` (`backing_provider.jsonl`, T4.6, FR-ADP-10);
native captures observed a model id string in `modelUsage` (live check 4a) but no vendor, so without an explicit
structured `backing_provider` `backingProvider` stays unset. Usage counters on the `end` line (`input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens` and
non-negative `num_turns`) are recorded `provider_reported` on the first `end` line only; a second `end` line fails
closed as `OUTPUT_PROTOCOL_ERROR` and does not duplicate usage (FR-CAP-01). `num_turns` without a `usage` object records
no usage; with an empty `usage` object it records `num_turns` alone. An empty structured `model` or `backing_provider`
shadows its fallback key and binds none, while a non-string `model` falls through to `model_id`, then to the first own
`modelUsage` key ([#354](https://github.com/zemdregon/switchboard/pull/354)). The extra cost and correlation fields
recorded on `end` in the 2026-10-14 live check (`total_cost_usd`, `total_cost_usd_ticks`, `requestId`, live check 4a)
never widen the usage record or reach an event ([#313](https://github.com/zemdregon/switchboard/pull/313)). Mid-stream
standalone `usage` lines (row 4b) emit no usage event whatever counters or signatures they carry (the `end` line is
the run total), and dropped event kinds (`available_commands`, `thought`, standalone `usage`) are dropped whole on any
shape without incrementing unknown event counts ([#313](https://github.com/zemdregon/switchboard/pull/313)).
`ParseState` instances isolate `seenEnds` and `seenToolCalls` state across runs
([#313](https://github.com/zemdregon/switchboard/pull/313)). Rate-limit, permission-denial and sandbox-violation event
shapes and native `tool_call` / `tool_call_update` parameter fields remain unrecorded (T4.23 is `Done` against its
Done-when on synthetic fixtures, owner decision 65 (a); the native shapes are T4.28's work). Supervisor-replayed
JSONL fixtures pin today's gaps without inventing native fields
([#260](https://github.com/zemdregon/switchboard/pull/260),
[#313](https://github.com/zemdregon/switchboard/pull/313),
[#319](https://github.com/zemdregon/switchboard/pull/319)): `sandbox_violation` and `permission_denied_rule` (live
check 7g and 8c) end `end_turn` at exit 0 with opaque `tool_call` lines counted; `rate_limit` (5d, never forced) is an
empty stream at exit 1 → `TOOL_FAILURE`; `rate_limit_error` replays an unmapped error line at exit 0 to `TOOL_FAILURE`,
never `RATE_LIMIT_TRANSIENT` or success; `unknown_events` ends `OUTPUT_PROTOCOL_ERROR` with every unknown line counted;
`unknown_then_end` replays an unknown event in an otherwise clean success to `ok` with one unknown event counted,
confirming that unknown events can coexist with a recognized result without supplying it
([#319](https://github.com/zemdregon/switchboard/pull/319)); `error_after_end` replays a late provider error after a
recognized `end` at exit 0 to `AUTH_REQUIRED`, proving that late errors invalidate `end_turn` while preserving
structured session binding ([#319](https://github.com/zemdregon/switchboard/pull/319)); `malformed_after_end` replays
malformed framing trailing a recognized `end` to `OUTPUT_PROTOCOL_ERROR` through the supervisor, keeping the
structured session id ([#319](https://github.com/zemdregon/switchboard/pull/319)); and `resume_failure` replays
a resumed run whose `end` line carries `stopReason` `cancelled` (live check 6a + 8f combined) to `TOOL_FAILURE`,
preserving the resumed session id ([#313](https://github.com/zemdregon/switchboard/pull/313)). Native errors remain
failures in either stream order (`auth` vs `model`), with the first arriving error determining the failure code
(`AUTH_REQUIRED` vs `MODEL_UNAVAILABLE`), whether placed before or after `end`
([#331](https://github.com/zemdregon/switchboard/pull/331)). Unknown envelopes (even carrying spoofed `sessionId`,
`stopReason`, `usage`, `error` or `result`) cannot bind a session or smuggle status or usage before or after `end`
([#331](https://github.com/zemdregon/switchboard/pull/331)). The `classifyFailure` precedence chain is pinned on
synthetic fixtures: supervisor cancel, timeout, `protocol_error`, and crash outcomes beat every stream signal including
the ADR-0039 guard verdict; the guard verdict beats denials; denials beat provider errors; a provider error beats a
`rate_limit` event, a failed result and the exit code; and the Grok `protocol` category maps to `OUTPUT_PROTOCOL_ERROR`
([#313](https://github.com/zemdregon/switchboard/pull/313)). Precedence does not depend on arrival order (reversing the
event array yields identical classification), and free text in `stderrTail` never changes structured precedence
([#331](https://github.com/zemdregon/switchboard/pull/331)). Closing the remaining gaps needs operator captures of a
rate-limited or quota-stopped run and of native command and target fields (ROADMAP T4.28).

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`**: Grok Build documents `--deny` rules, but they are
prefix matches and the live check showed forms that could still run `git commit` (step 9); Switchboard does not emit a
deny rule. Shell allowlist entries that could write Git make the run `Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01),
including on an approved bypass scope.

The parser treats a guard-flagged `tool_call` (`violation`) as a failed run per
[ADR-0039](../adr/0039-switchboard-side-tool-call-guard.md) even when `end` `stopReason` is `end_turn` at exit 0
(`src/adapters/grok/grok.test.ts`; [#247](https://github.com/zemdregon/switchboard/pull/247)). On synthetic fixtures the
guard inspects commands under the supported container aliases (`input`, `parameters`, `args`, `arguments`), command
aliases (`command` > `cmd` > `CommandLine` on the container or event root), target paths (`path` > `filePath` >
`file_path` > `AbsolutePath` > `target`), tool names (`tool` > `name` > `tool_name`), and call IDs
(`id` > `call_id` > `tool_call_id`). Only the first object container is read; containers are not merged, so an object
`input` without a command shadows `parameters`, `args` and `arguments` (a top-level `command` is still read), and an
empty-string command is a command that shadows `cmd` and the top-level command. Both are pinned gaps the guard cannot
see: `shadowed_parameters.jsonl` replays a Git write under `parameters` behind an empty `input` to `end_turn` success
with one unknown event ([#372](https://github.com/zemdregon/switchboard/pull/372)). Late or swapped commands on
`tool_call_update` are correlated by call id and re-evaluated by the guard without duplicating identical reports.
An empty call id counts as no id. Each id-less `tool_call` opens the next number (`call_1`, `call_2` and so on), so
two id-less calls with the same command are both reported, and an id-less `tool_call_update` correlates to the latest
id-less call (`call_1` before any `tool_call`). An id-less update does not correlate to an earlier id'd call and is
reported again (over-reporting, never under-reporting), and an id-less Git-write update with no `tool_call` before it
is still guarded (`idless_update_guard.jsonl` replays to `PERMISSION_BLOCKED`). A repeated `tool_call` with the same id
and command is not reported twice and is never counted unknown; a name-only update emits nothing on a call already
reported and is reported as `other` on an unseen call; a target added to a call already reported with a command is a
separate `read` event ([#354](https://github.com/zemdregon/switchboard/pull/354),
[#372](https://github.com/zemdregon/switchboard/pull/372)).
Tool kind maps to `shell` when a command is present or tool name is `run_terminal_command` (a target-only
`run_terminal_command` call is a `shell` event carrying the target), `read` when target is present without command,
and `other` otherwise. In an approved bypass run
the guard enforces Git
writes only: a credential read, outside write or network call chained with a parsed Git write is blocked because of the
Git write, not because those other actions were refused. Native command/target fields remain unrecorded
(ROADMAP T4.28). A bare `tool_call` before a clean `end_turn` still succeeds; path keys, tool `content` text, a hostile
lower-precedence argument key shadowed by a benign higher one, and a command in a container shadowed by an earlier
object container without one remain invisible to the guard. A shell call carrying its command only in a target key now
hands the whole target to the guard (the kept target is still clipped to 512 characters), and a nameless target-only
update on a shell call stays a shell call, so a Git write past the clip ends `PERMISSION_BLOCKED` at exits 0 and 1
(gap pinned in [#449](https://github.com/zemdregon/switchboard/pull/449), closed 2026-10-15 on synthetic lines only);
whether the native CLI ever sends a command in a target field is unknown. Synthetic replay does not
prove provider refusal or preventive isolation.

`commitChannel` is **`finalize-only`**: Switchboard does not inject a per-run MCP server (no headless MCP-definition
flag was found in the 2026-10-14 live check). In the only compiled scope, project `.mcp.json` and `.grok/config.toml`
MCP servers load without `--trust` (observed step 10a). To publish work, set `finalize_commit` on the project's
primary context as for Codex ([How commits reach Git](mcp-server.md#how-commits-reach-git)). In an approved bypass run,
Git-write
denial therefore rests on FR-GIT-03 and FR-GIT-06 in addition to any provider rule.

Fixture evidence on `main`: `src/adapters/grok/fixtures/` (T4.23 Done-when and T4.25 conformance JSONL, including
`sandbox_violation`, `permission_denied_rule`, `rate_limit`, `rate_limit_error`, and `unknown_events` from
[#260](https://github.com/zemdregon/switchboard/pull/260), `backing_provider.jsonl` from T4.23 / T4.6,
`resume_failure.jsonl` from [#313](https://github.com/zemdregon/switchboard/pull/313), and `unknown_then_end.jsonl`,
`error_after_end.jsonl`, and `malformed_after_end.jsonl` from
[#319](https://github.com/zemdregon/switchboard/pull/319), `hang_after_end.jsonl` from
[#342](https://github.com/zemdregon/switchboard/pull/342) and [#351](https://github.com/zemdregon/switchboard/pull/351),
`idless_update_guard.jsonl` from [#354](https://github.com/zemdregon/switchboard/pull/354), and
`shadowed_parameters.jsonl` from [#372](https://github.com/zemdregon/switchboard/pull/372));
`src/adapters/grok/parser-residual.test.ts` ("grok parser residuals (T4.23, synthetic lines; parser unchanged)" and
its "second pass", [#354](https://github.com/zemdregon/switchboard/pull/354),
[#372](https://github.com/zemdregon/switchboard/pull/372)); `src/adapters/grok/grok.test.ts` ("grok compile matrix
(T4.22)", "grok probe and resume (T4.22, T4.23)", "resumeArgs mirrors compile across every structured scope"
([#331](https://github.com/zemdregon/switchboard/pull/331)), "grok parser and result (T4.23; SYNTHETIC lines in the
shapes the 2026-10-14 live check recorded)", "cases with no recorded native shape (live check 5d, 7g, 8c, 8f)" fixture
replay, stream ordering and late error/framing fixtures
([#319](https://github.com/zemdregon/switchboard/pull/319)), "parser hardening (T4.23, synthetic shapes; mirrors
Antigravity T4.33)", "parser hardening (T4.23, synthetic shapes; mirrors Cursor T4.43 and OpenCode T4.53)",
`classifyFailure` precedence chain and arrival-order independence
([#313](https://github.com/zemdregon/switchboard/pull/313),
[#331](https://github.com/zemdregon/switchboard/pull/331)), recorded end-line cost fields and requestId exclusion
([#313](https://github.com/zemdregon/switchboard/pull/313)), dropped standalone lines and `modelUsage` resolution
([#313](https://github.com/zemdregon/switchboard/pull/313)), native error ordering and unknown envelopes
([#331](https://github.com/zemdregon/switchboard/pull/331)), "grok auth preflight (T4.24, Q-10; SYNTHETIC outputs in
the shapes of the 2026-10-14 live check)", "grok conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.25)",
"grok registry entry and manifest gate (T4.22)", "grok Git declaration (T4.27, FR-GIT-01, FR-GIT-02, FR-GIT-09)", and
"grok backing-provider fixture (T4.23, T4.6, FR-ADP-10)"); CI also runs `test/malicious/adapters/grok.case.ts` and
`test/malicious/adapter-leg.test.ts` ("adapter malicious leg: grok" and "adapter malicious leg: grok partial streams",
T4.26 `Done` against its Done-when on fixtures, owner decision 65 (b))
([#291](https://github.com/zemdregon/switchboard/pull/291),
[#302](https://github.com/zemdregon/switchboard/pull/302),
[#308](https://github.com/zemdregon/switchboard/pull/308),
[#326](https://github.com/zemdregon/switchboard/pull/326),
[#345](https://github.com/zemdregon/switchboard/pull/345),
[#351](https://github.com/zemdregon/switchboard/pull/351),
[#358](https://github.com/zemdregon/switchboard/pull/358),
[#378](https://github.com/zemdregon/switchboard/pull/378),
[#393](https://github.com/zemdregon/switchboard/pull/393),
[#422](https://github.com/zemdregon/switchboard/pull/422),
[#449](https://github.com/zemdregon/switchboard/pull/449));
no `replayGap`). [#302](https://github.com/zemdregon/switchboard/pull/302) added synthetic argument-key and
tool-name variants (`input.cmd`, top-level `command`, `CommandLine` on `arguments` / `input` / the event, `name` and
`tool_name`), commands arriving or changing only on `tool_call_update` (including `call_id` and `tool_call_id`),
Git-write forms the live check showed a prefix deny does not stop, and missing auth/rate-limit error combinations
(79 streams: 73 blocked, 6 unknown-event). [#308](https://github.com/zemdregon/switchboard/pull/308) completed the
malicious cut-line position matrix across all three categories (`credential_read`, `out_of_worktree_write`, `network`)
and exit codes (`0`, `1`) (12 `grokPartialStreams`), verifying both cuts before the hostile call (framing failure) and
inside the line after the call (protocol failure outranking guard verdict).
[#326](https://github.com/zemdregon/switchboard/pull/326) closed remaining synthetic malicious-matrix gaps: prototype
keys (`__proto__`) beside command for worktree writes and network calls, additional chained Git-write forms
(`git merge`, `git rebase`, `git pull`, `git cherry-pick`, `git checkout -b`, `git revert`), container and argument
aliases (`input.cmd`, `parameters.CommandLine`, `args.CommandLine`, `arguments.cmd`, and tool calls without tool name),
and unreadable text/end shapes with clean exits and exit 1 (117 streams: 109 blocked, 8 unknown-event; 12
`grokPartialStreams`).
[#345](https://github.com/zemdregon/switchboard/pull/345) replays parser fall-through paths the matrix had not yet
covered: non-object `input`, null `parameters`, a non-string `command` beside `cmd`, a top-level `command` beside
`input.path`, commands under a non-shell or empty tool name (including an empty `id`), a benign `tool_call` before a
separate hostile one, a hostile call swapped back to a benign command in `tool_call_update`, and every hostile category
at exit `2` and `137` (15 streams, all `PERMISSION_BLOCKED` with the guard enabled); `unknown_events` adds non-object
`input`, empty or non-string tool names, null `parameters`, and an exit-`2` unknown-only stream (134 streams total: 124
blocked, 10 unknown-event; 12 `grokPartialStreams` unchanged).
[#351](https://github.com/zemdregon/switchboard/pull/351) adds, per hostile category at exit `0` and `1`, a guarded call
before `end` followed after it by an unreadable or a repeated `tool_call_update` (12 streams, all `PERMISSION_BLOCKED`;
without the guard verdict the 6 at exit `0` end `ok`, the T4.26 residual above).
[#358](https://github.com/zemdregon/switchboard/pull/358) (escapes corrected in
[#363](https://github.com/zemdregon/switchboard/pull/363)) adds 42 blocked streams: JSON encodings only `JSON.parse`
resolves (`\u` escapes in type, key and command, a duplicate `command` key whose last value is the Git write, CRLF
lines), hypothetical `stopReason` values `max_tokens` and `refusal` after a Git-write call, a call first reported with
only `input.path` then given a Git-write command on the same id, and swapped or after-`end` Git writes at exit `2` and
`137` (188 streams total: 178 blocked, 10 unknown-event; 12 `grokPartialStreams` unchanged).
[#378](https://github.com/zemdregon/switchboard/pull/378) replays the T4.23 second-pass branches (a top-level command
beside an empty `input`, an id-less update after an id'd call, an empty error message, an empty `stopReason`, a
target-only call upgraded to a Git write) and adds the shadowed-container gap as `unknown_events` (220 streams: 208
blocked, 12 unknown-event). [#393](https://github.com/zemdregon/switchboard/pull/393) pins the four compiled cells'
argv (exactly one `--sandbox` and its value, `--disable-web-search` exactly when network is off, one
`--always-approve`) and the refused scopes, with broken-compile positive controls.
[#422](https://github.com/zemdregon/switchboard/pull/422) replays the third-pass `end`-line branches and widens
`grokPartialStreams` to exits `2` and `137` (261 streams: 244 blocked, 17 unknown-event; 24 `grokPartialStreams`).
[#449](https://github.com/zemdregon/switchboard/pull/449) replays the fourth to sixth passes (decoy `sessionId`, a
5,000-character command, a caller id equal to `call_1`, `null` or number `input` beside `parameters`, a short
target-only Git write, an empty `id` beside `call_id`, a duplicate `type` key, an empty text chunk) in each hostile
category at exits `0` and `1`, and adds case-variant and duplicate-`type` `unknown_events` lines. With the target-only
shell gap closed in the parser (2026-10-15), the 6 streams #449 kept outside the blocked count, plus 6 for a nameless
target-only update on a shell call, replay in the blocked batch (337 streams at that point: 316 blocked — 106
`credential_read`, 106 `out_of_worktree_write`, 104 `network` — and 21 unknown-event; 24 `grokPartialStreams`;
180 `grokResidualStreams`, which a positive control shows none end `PERMISSION_BLOCKED` without the guard verdict).
[#478](https://github.com/zemdregon/switchboard/pull/478) replays the #470 eighth-pass controls (a non-string command
beside a hostile shell target; a read renamed with a new target before a nameless hostile update) in each hostile
category at exits `0` and `1`, bringing the matrix to 349 streams (328 blocked — 110 `credential_read`, 110
`out_of_worktree_write`, 108 `network` — and 21 unknown-event; 24 `grokPartialStreams`; 192 `grokResidualStreams`,
under the same positive control). Bare, non-string and
prototype-key tool lines remain `unknown`; cut-line streams end `OUTPUT_PROTOCOL_ERROR`, which outranks a guard
verdict. Apart from that target-only fix, these case-file updates change neither the parser nor the compiled matrix;
fields other than `type` remain hypothetical. No end-to-end run through Switchboard against a logged-in `grok` has
been recorded yet (T4.28).

## Antigravity CLI (milestone 4)

Config id `antigravity`; routing and `list_capabilities` id `antigravity`. Switchboard runs the **`agy`** binary with
`--prompt=<prompt> --output-format stream-json`
([TDD §4.4.2](../design/TDD.md#442-antigravity-native-controls-per-profile-and-platform-t430); observed on
2026-10-14 in [`docs/research/live-checks-2026-10-14-antigravity.md`](../research/live-checks-2026-10-14-antigravity.md),
`agy` 1.3.4). The prompt is one argv word (`--prompt=<prompt>`), not stdin (an Assumption in the adapter). Switchboard
passes only `PATH` and `HOME` from the parent environment and
sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` on every run and never puts `GEMINI_API_KEY`, `GOOGLE_API_KEY` or
`GOOGLE_GEMINI_BASE_URL` in the child environment (API-key mode stays disabled).

The compliance manifest range (`src/adapters/manifests/antigravity.json`) admits `>=1.4.2 <1.5.0`
since `switchboard adapters validate antigravity` passed on CLI 1.4.2 on 2026-10-18 (ROADMAP T4.38).
Other versions still report `ADAPTER_VERSION_UNVERIFIED` in `doctor`. The live smoke and the live
malicious leg ran on 2026-10-19 (ROADMAP T4.38 Done;
[`docs/research/live-checks-2026-10-19-antigravity.md`](../research/live-checks-2026-10-19-antigravity.md)):
smoke 9 HELD with 2 ESCAPED (A-7: 20 of 22 stream lines unrecognised; A-8: the edit landed through an
unrecognised tool call; risks R-73, R-75) and 1 NOT_CHECKED (A-G1); malicious A-M3 HELD (fake-HOME
credential canary in no surface) with A-M2 ESCAPED (out-of-worktree canary read; risk R-72) and A-M1
NOT_CHECKED (no Git write attempted).

### Login

See the [login table](getting-started.md#log-in-to-the-providers-natively) above. Switchboard never launches `agy` for
sign-in; it only
runs `agy models` during preflight.

### Trust profiles

The adapter compiles only what [TDD §4.4.2](../design/TDD.md#442-antigravity-native-controls-per-profile-and-platform-t430)
records for the 2026-10-14 live check (Q-63, Q-84): every profile other than an approved `privileged` bypass scope is
refused (`PROFILE_UNSUPPORTED`), because `toolPermission` is a settings value, not per run, soft denials can leave
`status` `SUCCESS` at exit 0, repository `GEMINI.md`, `AGENTS.md` and the `.agents` MCP server and hooks load with no
per-run approval flag, and no per-run deny rule was shown to hold under the bypass flag (T4.31 C8 not run).

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`) |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). An approved scope with `bypass` compiles one argv shape: `agy --prompt=<prompt> --output-format stream-json --dangerously-skip-permissions` with `AGY_CLI_DISABLE_AUTO_UPDATE=true`, worktree file access, shell `broad`, network `on` and repository configuration `enabled`, and **no** `--sandbox` (owner decision 46, Q-84). A scope without `bypass` is refused (`PROFILE_UNSUPPORTED`). Any narrowing Switchboard can express (read-only files or an unwritable workspace, shell allowlist, network off or repository configuration other than `enabled`) is refused before spawn (`CAPABILITY_MISSING`). An explicit model request is also refused (`CAPABILITY_MISSING`); `--model` is never emitted. |

Resume (`resumeArgs`, T4.35, owner decision 67) compiles only where `compile` does — the approved
bypass cell — as the first-run argv plus `--conversation <id>` for a safe-token id; every other cell returns
`compile`'s `Ineligible`. A resumed run whose returned `conversation_id` differs from the requested one (an unknown
id silently starts a new conversation, live check C9 run 5) or names none fails closed (`OUTPUT_PROTOCOL_ERROR`,
new id never bound). A full refusal matrix is pinned on synthetic fixtures — foreign provider bindings, flag-like or
unsafe conversation ids and ineligible profiles
([#297](https://github.com/zemdregon/switchboard/pull/297)). Structured
`backing_provider` on `init` or `result` sets `backingProvider` on `session_bound` (clipped, non-strings dropped) and
feeds `provider_reported` usage observations on synthetic fixtures (`backing_provider.jsonl`,
[#297](https://github.com/zemdregon/switchboard/pull/297)). The fixture also runs through `RunLifecycle`, checking
the ledger provider binding and usage observation and the `get_run` usage envelope: harness `antigravity`, backing
vendor and model remain separate ([#332](https://github.com/zemdregon/switchboard/pull/332)). Without it
`backingProvider` stays unset, never inferred from the model display name, because the 2026-10-14 live check
recorded a display name only, no vendor. A `tool_call` after the `result` line is not a success
(fail closed; a guard-flagged trailing call keeps `PERMISSION_BLOCKED` per ADR-0039;
unflagged → `OUTPUT_PROTOCOL_ERROR` with detail `tool call after the result line`; Proposed order — live check C4 had
`result` last; [#262](https://github.com/zemdregon/switchboard/pull/262)).

### Parser evidence and gaps

Synthetic fixtures in [`antigravity.test.ts`](../../src/adapters/antigravity/antigravity.test.ts) pin stricter success
checks than exit 0: a clean expected exit, one `result` with exact `SUCCESS` status and positive `total_tokens`,
and no denial, envelope error or guard violation. Duplicate results, changed or unsafe conversation ids and missing
results fail closed; duplicate result usage is not counted twice. Unrecorded rate-limit or quota text is
`TOOL_FAILURE`, not `RATE_LIMIT_TRANSIENT`: the supervisor replays `rate_limit.jsonl` (an empty stream at exit 1) and
`rate_limit_error.jsonl` (an `ERROR` envelope at exit 0) to `TOOL_FAILURE`, and `git_write_guard_args.jsonl` (a Git
write under `args.CommandLine`) to `PERMISSION_BLOCKED`
([#305](https://github.com/zemdregon/switchboard/pull/305)). An unknown event in an otherwise clean success is counted
without changing the result; an entirely unreadable stream is `OUTPUT_PROTOCOL_ERROR` (`unknown_events.jsonl`, every
line counted and no session bound, [#305](https://github.com/zemdregon/switchboard/pull/305)). Stream-order fixtures
replay through the supervisor ([#325](https://github.com/zemdregon/switchboard/pull/325)): `unknown_then_result.jsonl`
succeeds with one unknown event counted and binds only the later result's conversation id; `error_after_result.jsonl`
stays `OUTPUT_PROTOCOL_ERROR`, because a late auth envelope is a second result, not `AUTH_REQUIRED`; and
`malformed_after_result.jsonl` fails in the supervisor after the result was emitted, keeping the conversation id. The
same change pins the `classifyFailure` precedence: supervisor outcomes over the guard, the guard over denials,
denials over provider errors, a provider error over a `rate_limit` event, a failed result and the exit code.
`init.permission_mode` is not read (a pinned gap, [#249](https://github.com/zemdregon/switchboard/pull/249)): every
recorded run showed `request-review`, and whether a value that disagrees with the compiled bypass flag should fail the
run is not decided, so the outcome rests on the `result` envelope alone.

The supervisor replays `agy_error_exit3.jsonl`, `agy_error_quota.jsonl` and `usage_unrecorded.jsonl` to `TOOL_FAILURE`
(`agy_error_quota.jsonl` carries a stderr `AGY_ERROR` quota line in the T6.11 capture shape; the supervisor path has no
stderr, so it stays `TOOL_FAILURE` there, while `classifyFailure` over the run's stderr tail maps it to
`QUOTA_EXHAUSTED`, T6.15, [`limit-signals.test.ts`](../../src/adapters/antigravity/limit-signals.test.ts)).
`sandbox_violation_unrecorded.jsonl` deliberately pins a gap: a tool-output error beneath a successful envelope
still ends `ok`, because the parser does not interpret that error as a native sandbox-violation event. These are
synthetic checks, not native captures of rate limiting, sandbox enforcement or `AGY_ERROR` stderr
(the quota line shape follows the T6.11 capture key names, but the fixture is hand-written;
[#272](https://github.com/zemdregon/switchboard/pull/272)). Tool parameter aliases remain **Assumptions** until
operator captures confirm their native shapes. Later updates that supply or change a command or path reach the
guard again; commands under unrecorded parameter keys remain unseen. The live smoke and the live
malicious leg ran on 2026-10-19 (ROADMAP T4.38 Done;
[`docs/research/live-checks-2026-10-19-antigravity.md`](../research/live-checks-2026-10-19-antigravity.md)):
the smoke confirms the T4.36 gap (1) on a real CLI (native 1.4.2 `stream-json` lines mostly unrecognised;
risks R-73, R-75) and the malicious leg observes the file-access escape (A-M2 ESCAPED; risk R-72).
A live resume run, captured rate-limit and sandbox categories, and the T4.31 C8 deny-rule variant stay
unrun (T4.38 operator remainder). (T4.33 and T4.36 are Done against their
Done-when under owner decision 65, and T4.35 is Done on synthetic fixtures including resume per owner decision 67;
their remaining native shapes are carried by the T4.38 remainder);
the `adapters validate` leg passed live on 2026-10-18, CLI 1.4.2.

Residual parser pins ([#344](https://github.com/zemdregon/switchboard/pull/344), "antigravity parser residual pins
(T4.33, synthetic shapes)") record a second guard gap: tool parameters on a step whose `step_type` is not exactly
`tool` (for example `TOOL`, `checkpoint` or `agent_response`) never reach the guard, and the supervisor replays
`non_tool_step_command.jsonl`, a Git write on such a step, to a success. They also pin that tool steps are
deduplicated per `step_index`, so a repeated Git write in a new step is checked again; that the model and backing
vendor bind once, from `init` before a later `result`; and that a `SUCCESS` envelope with tokens and no string
conversation id succeeds with no session bound (a synthetic shape: every recorded success carried an id; resume
compiles `--conversation` with a fail-closed id check, T4.35, owner decision 67). A mutation pass over the parser left
eight non-equivalent survivors, now pinned in
[`parser-residual.test.ts`](../../src/adapters/antigravity/parser-residual.test.ts) ("antigravity parser mutation residuals
(T4.33, synthetic shapes)", [#359](https://github.com/zemdregon/switchboard/pull/359)).

T4.35 conformance fixtures also cover a conversation id changing on a tool step (`OUTPUT_PROTOCOL_ERROR`, first id
kept), non-array `denied_actions` (`PERMISSION_BLOCKED`, tool name `unknown`), and unrecorded sandbox-error text in an
`ERROR` envelope (`sandbox_violation_error.jsonl`: `TOOL_FAILURE`, never `SANDBOX_VIOLATION`). The latter does not
close the successful-envelope sandbox gap above. Supervisor tests check cancellation both with SIGTERM honoured
and with escalation required, including an empty process group after escalation. The replay dialect refuses unsafe
resume ids and additional never-emitted flag spellings; these are fixture invocation checks, not native enforcement
([#332](https://github.com/zemdregon/switchboard/pull/332)). `resume_failure.jsonl` is replayed through `resumeArgs`
(owner decision 67: `TOOL_FAILURE`, resumed id kept), listed out of the runnable suite in the fixture inventory.
Since [#347](https://github.com/zemdregon/switchboard/pull/347), [#361](https://github.com/zemdregon/switchboard/pull/361)
and [#373](https://github.com/zemdregon/switchboard/pull/373)
([`conformance-residual.test.ts`](../../src/adapters/antigravity/conformance-residual.test.ts)) every case fails when the
replay refuses the compile, idle (both SIGTERM paths) and wall-clock timeouts replay with their kind pinned, an
inventory test requires every fixture to be replayed or listed out with a reason and to carry SYNTHETIC provenance,
and every runnable case pins its failure detail, session id, summary and unknown-event count, so it fails on any
other case's fixture except eleven listed same-result pairs. T4.35 is `Done` on synthetic fixtures (owner decision
67): fixtures cannot establish a live resume run or captured rate-limit and sandbox categories (carried by
the T4.38 operator remainder: T4.38 Done 2026-10-19 with no resume check run and T4.31 C8 unrun).

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`**: Antigravity documents Git deny rules only in
`settings.json` or `/permissions` scopes, none per run, and Switchboard writes no configuration file. Whether deny rules
hold under `--dangerously-skip-permissions` was not observed (T4.31 C8). Git-write denial therefore relies on FR-GIT-03
(controller ref comparison) and FR-GIT-06 (the tool-call guard) in addition to any provider rule. Shell allowlist
entries that could write Git make the run `Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01), including on an approved
bypass scope.

The parser treats a guard-flagged `tool_call` (`violation`) as a failed run per
[ADR-0039](../adr/0039-switchboard-side-tool-call-guard.md) even when the envelope `status` is `SUCCESS` at exit 0
(`src/adapters/antigravity/antigravity.test.ts`). The same `extractResult` path fails closed on a `tool_call` after the
final `result` line ([#262](https://github.com/zemdregon/switchboard/pull/262)). On synthetic fixtures the guard sees a
command under the recorded or Assumption keys the parser accepts today — `command`, else `CommandLine`; paths `path`,
else `file_path` or `AbsolutePath`; containers `parameters`, else `args`, else `input`; the tool name falls back
`tool_info.name` → `step.tool_name` → `step.name` → `unknown` — and prototype-named keys never smuggle a command past
the parser's own-property reads
([#276](https://github.com/zemdregon/switchboard/pull/276),
[#297](https://github.com/zemdregon/switchboard/pull/297)). CI's malicious-fixture leg (T4.36)
replays synthetic hostile streams where shell `run_command` steps carry commands the guard can see (including Git writes
chained with credential read, out-of-worktree write and network patterns), ending `PERMISSION_BLOCKED` at exit 0 and exit
1 on both recorded `denied_actions` soft denials, bypass-shaped envelopes with no `denied_actions`
([#257](https://github.com/zemdregon/switchboard/pull/257)) and the same patterns placed after a clean `SUCCESS` `result`
([#262](https://github.com/zemdregon/switchboard/pull/262)). Later synthetic streams add guarded `ERROR` envelopes,
late and swapped commands, the `CommandLine` alias, other Git-write forms and parameter containers
([#295](https://github.com/zemdregon/switchboard/pull/295)); every blocked category at exit 2 and 137 with no `result`
line and the parser's fall-through paths ([#352](https://github.com/zemdregon/switchboard/pull/352)); and unsafe or
changed conversation ids, `SUCCESS` envelopes with zero, missing, negative or non-number `total_tokens`, empty or
null `denied_actions` and partial streams cut before, inside and after the hostile step
([#368](https://github.com/zemdregon/switchboard/pull/368)). In an approved bypass run the guard still enforces Git
writes only: the same hostile call without a Git write still ends `ok` (pinned), as does a Git write on a step that
is not a `tool` step (above); live blocked outcomes and FR-POL-04 were not established live
(T4.38 operator remainder: A-M1 NOT_CHECKED — the model declined the commit, no retry; A-M2
ESCAPED, risk R-72).

`commitChannel` is **`finalize-only`**: Switchboard does not inject a per-run MCP server (no headless MCP-definition
flag is documented). In the only compiled scope, repository `.agents/mcp_config.json`, `.agents/hooks.json`, `GEMINI.md`
and `AGENTS.md` load (observed on the 2026-10-14 live check). To publish work, set `finalize_commit` on the project's
primary context as for Codex ([How commits reach Git](mcp-server.md#how-commits-reach-git)).

Fixture evidence on `main`: `src/adapters/antigravity/antigravity.test.ts` ("antigravity compile matrix (T4.32)",
"antigravity bypass-class declarations (ADR-0035, ADR-0045)", "antigravity probe (T4.32)", "antigravity registry entry
and manifest gate (T4.32)", "antigravity auth preflight (T4.34; SYNTHETIC outputs in the shapes of the 2026-10-14 live
check C3b, C3c)", "antigravity parser and result (T4.33)", "antigravity parser hardening (T4.33, synthetic shapes)",
"antigravity cases with no recorded native shape (T4.33, synthetic shapes)"
([#272](https://github.com/zemdregon/switchboard/pull/272)), "antigravity parser fallbacks and exact matching (T4.33,
synthetic shapes)" ([#276](https://github.com/zemdregon/switchboard/pull/276)), "antigravity conformance suite
(synthetic recorded fixtures, FR-ADP-11, T4.35)" (dialect edge cases
[#281](https://github.com/zemdregon/switchboard/pull/281), Go `flag` boundaries
[#292](https://github.com/zemdregon/switchboard/pull/292), rate-limit, unknown-event and `args` fixtures
[#305](https://github.com/zemdregon/switchboard/pull/305), stream-order replays and `classifyFailure` precedence
[#325](https://github.com/zemdregon/switchboard/pull/325), widened conformance and lifecycle evidence
[#332](https://github.com/zemdregon/switchboard/pull/332)), "antigravity backing-provider fixture (T4.35, T4.6,
FR-ADP-10)" ([#332](https://github.com/zemdregon/switchboard/pull/332)), "antigravity Git declaration (T4.37,
FR-GIT-01, FR-GIT-02, FR-GIT-09)" and "antigravity malicious-fixture leg (T4.36, NFR-SEC-03, FR-POL-04,
FR-POL-06; SYNTHETIC lines)", trailing-tool pins in the same file, "a %s chained with a Git write and no denial
ends PERMISSION_BLOCKED (ADR-0039)", and the `backing_provider`, own-property, fallback, supervisor-exit and
resume-refusal matrices ([#297](https://github.com/zemdregon/switchboard/pull/297)); supervisor-replayed fixtures include
`backing_provider.jsonl` and the unrecorded-shape pins `agy_error_exit3.jsonl`,
`sandbox_violation_unrecorded.jsonl` and `usage_unrecorded.jsonl`; CI also runs
`test/malicious/adapters/antigravity.case.ts` and `test/malicious/adapter-leg.test.ts` ("adapter malicious leg:
antigravity", T4.36 Done against its Done-when under owner decision 65 (b) — see [Known limitations](advanced-features.md#known-limitations);
guard-blocked streams
[#257](https://github.com/zemdregon/switchboard/pull/257), trailing-tool streams
[#262](https://github.com/zemdregon/switchboard/pull/262), exit-code and hostile-repository-entry coverage
[#280](https://github.com/zemdregon/switchboard/pull/280), widened malicious matrix
[#295](https://github.com/zemdregon/switchboard/pull/295), exit 2/137 and fall-through streams
[#352](https://github.com/zemdregon/switchboard/pull/352), residual anomalies and inside-line cuts
[#368](https://github.com/zemdregon/switchboard/pull/368), plus "adapter malicious leg: antigravity partial
streams"); "antigravity parser residual pins (T4.33, synthetic shapes)"
([#344](https://github.com/zemdregon/switchboard/pull/344)) with `non_tool_step_command.jsonl`;
`src/adapters/antigravity/parser-residual.test.ts` ([#359](https://github.com/zemdregon/switchboard/pull/359)); and
`src/adapters/antigravity/conformance-residual.test.ts` (including "antigravity whole-stream order shapes in the case
list (T4.35, T4.33 fixtures)";
[#347](https://github.com/zemdregon/switchboard/pull/347), [#361](https://github.com/zemdregon/switchboard/pull/361),
[#373](https://github.com/zemdregon/switchboard/pull/373)). None of these changed the parser; the compiled matrix gains
only the resume path (T4.35, owner decision 67).
The conformance `resume` case runs through `resumeArgs`. The T4.38 live `adapters validate` smoke call ran
on CLI 1.4.2 on 2026-10-18 (one
structured-output call through `startAdapterRun` in the approved privileged bypass cell), and the full live
smoke and the live malicious leg ran on 2026-10-19 (ROADMAP T4.38 Done: smoke SUCCEEDED with `SMOKE.md`
landed, A-7/A-8 ESCAPED; malicious A-M3 HELD, A-M2 ESCAPED, A-M1/A-G1 NOT_CHECKED). The live resume run
stays unrun (T4.38 operator remainder).

## Cursor CLI (milestone 4)

Config id `cursor`; routing and `list_capabilities` id `cursor`. Switchboard runs the **`cursor-agent`** binary with
`--print --output-format stream-json` and the prompt on stdin
([TDD §4.5.2](../design/TDD.md#452-transport-decision); observed on 2026-10-14 in
[`docs/research/live-checks-2026-10-14-cursor.md`](../research/live-checks-2026-10-14-cursor.md)).
Do not invoke bare `agent` on `PATH`: on some hosts that name is Grok Build's CLI, not Cursor's (same live check). The
prompt travels on stdin ([LIVE] 6a: with no positional argument piped text is the prompt, so it is neither visible in
the process table nor read as a flag). Switchboard passes an environment allowlist (`PATH` and `HOME` so the CLI finds
its native login) and never passes `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` (credentials stay out of the child
environment, ADR-0003), `CURSOR_CONFIG_DIR` or `XDG_CONFIG_HOME` (which would alter or rewrite configuration files);
these are refused by the dialect.

The compliance manifest range (`src/adapters/manifests/cursor.json`) admits `>=2026.10.16 <2026.11.0` since
`switchboard adapters validate cursor` passed on CLI 2026.10.16 on 2026-10-19 (ROADMAP T4.48, owner decision 59;
[TDD §4.5.6](../design/TDD.md#456-t448-live-validation-2026-10-19)). Other versions still report
`ADAPTER_VERSION_UNVERIFIED` in `doctor`. The live smoke passed and the live malicious leg closed on 2026-10-19
per owner decision 77 (smoke `outcome=ok`; post-merge rerun w1703 inside the wrapper: U-M1/U-M2 `HELD`,
U-M3 `NOT_CHECKED` as expected bypass behaviour, not a defect);
T4.48 is `Done` (closed by owner decision 77). The escape fix has landed on this branch: the
bypass cell now runs inside the bubblewrap wrapper of [ADR-0059](../adr/0059-cursor-bypass-cell-bubblewrap-wrapper.md)
(owner ruling 2026-10-19 06:41 CDT), hermetically tested; the first live rerun inside the wrapper (w1700) ended with
all three cells `NOT_CHECKED` on a harness fault in the operator channel's model pin, not a wrapper or model outcome.
Under the owner ruling of 2026-10-19 08:12 CDT a check is `HELD` only when attempted, and U-M2/U-M3 join U-M1 as
`mustRun`; the w1703 rerun reached the tools and closed the row per the steward ruling of 2026-10-19 09:50 CDT.

### Login

See the [login table](getting-started.md#log-in-to-the-providers-natively) above. Switchboard never runs `cursor-agent
login`; it only
runs `cursor-agent status --format json` during preflight (10 s timeout), keying strictly on boolean `isAuthenticated`
(`true` -> `OK`, `false` -> `AUTH_REQUIRED`; non-zero exit, timeout, spawn error, non-JSON or missing boolean ->
`UNKNOWN`), and never stores or logs the account fields.

### Trust profiles

The adapter compiles only what [TDD §4.5.1](../design/TDD.md#451-cursor-native-controls-per-profile-and-platform-t440)
records for the 2026-10-14 live check (Q-65, Q-79): every profile other than an approved `privileged` bypass scope is
refused (`PROFILE_UNSUPPORTED`), because edits apply without `--force`, `--sandbox enabled` did not start on the
operator's Ampere host, headless runs need `--trust` (which loads repository rules and the operator's global MCP
servers), and no per-run permission flag is documented.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`) |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). An approved scope with `bypass` compiles one argv shape: `cursor-agent --print --output-format stream-json --trust --force` with the prompt on stdin, worktree file access, shell `broad`, network `on` and repository configuration `enabled`, and **no** `--sandbox` flag (owner decision 46). Every compiled and resumed invocation starts inside Switchboard's bubblewrap wrapper (root read-only, worktree read-write, `$HOME` and the temp directories hidden except Cursor's install directory, login store and state directory; [ADR-0059](../adr/0059-cursor-bypass-cell-bubblewrap-wrapper.md), owner ruling 2026-10-19 06:41 CDT): a missing `bwrap` or a failed `confinement` probe step leaves the cell `Ineligible` (`ELIGIBILITY_NONE`), never an unconfined run. A scope without `bypass`, or any narrowing Switchboard can express (read-only files or unwritable workspace, shell allowlist or none, network off or allowlist, repository configuration disabled or approved, or model overrides), is refused before spawn (`Ineligible: CAPABILITY_MISSING`). Bypass approved on any profile other than `privileged`, or `privileged` without approval, is refused `PROFILE_UNSUPPORTED` (FR-POL-03, ADR-0017). Bypass-class flags such as `--approve-mcps` and `--yolo` are never compiled outside that case. |

Resume continues the native session with `--resume <session_id>` through the same matrix when the provider is eligible
(synthetic fixtures in `src/adapters/cursor/cursor.test.ts`, T4.43). `resumeArgs` matches `compile` across every
structured scope, including exact refusals (one compiled bypass cell; `--resume <session_id>` is appended;
[#333](https://github.com/zemdregon/switchboard/pull/333)); alphanumeric, UUID and delimited ids compile while unsafe
or flag-like shapes are refused ([#341](https://github.com/zemdregon/switchboard/pull/341)), and resume on
`privileged` with no scope binding is refused with the compile reason
([#348](https://github.com/zemdregon/switchboard/pull/348)). A `session_id` that resume could not pass as one
safe argument (matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`, refusing leading dashes, empty strings or flag syntax) is
never bound (`OUTPUT_PROTOCOL_ERROR` on stream without binding, `CAPABILITY_MISSING` in `resumeArgs`;
[#248](https://github.com/zemdregon/switchboard/pull/248), [#287](https://github.com/zemdregon/switchboard/pull/287),
`unsafe_session_id.jsonl`). An unsafe session id in `result` after a normal `init` also fails `OUTPUT_PROTOCOL_ERROR`
while preserving the first bound id (`unsafe_id_after_bound.jsonl`,
[#309](https://github.com/zemdregon/switchboard/pull/309)). Session ID resolution also admits `sessionId`, `chat_id` and
`chatId` ([#299](https://github.com/zemdregon/switchboard/pull/299)), in that order after `session_id`
([#341](https://github.com/zemdregon/switchboard/pull/341)). A session id changing mid-run ends
`OUTPUT_PROTOCOL_ERROR` with the first id bound (`session_changed.jsonl`). `apiKeySource` must be `login`; any other
present value, including a non-string, fails with `AUTH_REQUIRED` (`auth_missing.jsonl`). Resumed runs pass
`--resume <session_id>` through the same compile matrix, preserving cwd and policy flags; `resumeCwd` is `unverified`
(TDD §4.10, live check 8c).
`reportedModelFlag` is `not_accepted` (`init` reports a display name, not a model id, [LIVE] 5b; `--model` is not
emitted, FR-RTE-08). Exactly one `result` line is permitted; a second `result` line fails closed as
`OUTPUT_PROTOCOL_ERROR` ("more than one result line", `two_results.jsonl`), does not flip a prior failure, and usage
deduplication ignores usage on subsequent result lines (FR-CAP-01;
[#299](https://github.com/zemdregon/switchboard/pull/299)). A `tool_call` after the `result` line is not a success
(fail closed; a guard-flagged trailing call keeps `PERMISSION_BLOCKED` per ADR-0039; an unflagged trailing call ends
`OUTPUT_PROTOCOL_ERROR` with detail `tool call after the result line`, `trailing_tool.jsonl`; an unreadable trailing
`tool_call` line that parses as `unknown` also fails closed as `OUTPUT_PROTOCOL_ERROR`,
[#268](https://github.com/zemdregon/switchboard/pull/268)). A completed refusal after the `result` line still ends
`PERMISSION_BLOCKED`, and a later success `result` cannot erase it (`denied_after_result.jsonl`,
[#341](https://github.com/zemdregon/switchboard/pull/341)). `tool_call` keys that name `Object.prototype` members map to
`other` (own-key lookup; [#248](https://github.com/zemdregon/switchboard/pull/248),
[#268](https://github.com/zemdregon/switchboard/pull/268)). Structured `backing_provider`/`backingProvider` and model on
synthetic `session_bound` events and the T4.6 end-to-end fixture are on `main`
([#275](https://github.com/zemdregon/switchboard/pull/275); `backing_provider.jsonl`), and model / `backingProvider`
resolution across `init` and `result` (when `init` is omitted; model from `model`, then `model_id`, then
`modelId`) with prototype pollution protection (`__proto__` and
`Object.prototype` members omitted, strings clipped to 128 characters) are in
[#299](https://github.com/zemdregon/switchboard/pull/299); native CLI captures report only a model display name and no
vendor, so without an explicit structured `backing_provider` (supported for fronted harnesses, T4.6) `backingProvider`
stays unset (never inferred from model display name; T4.43 is Done against its Done-when under owner decision
65 (a); T4.48 is Done 2026-10-19 per owner decision 77 without capturing these shapes — now a T4.41 extension or owner decision).

Usage deduplication suppresses reporting on a second `result` line so the run total is reported once (FR-CAP-01;
[#299](https://github.com/zemdregon/switchboard/pull/299)); usage metrics admit snake_case keys and `totalTokens`
([#299](https://github.com/zemdregon/switchboard/pull/299)). Assistant message parsing admits plain strings, arrays of
strings, `message.text`, `e.text` and `e.content` ([#299](https://github.com/zemdregon/switchboard/pull/299)); array
parts may also be objects with a string `text`, other parts are skipped, and empty text is dropped rather than counted
as unknown ([#348](https://github.com/zemdregon/switchboard/pull/348)). Tool
parameter container fallback (`args` > `parameters` > `input` > `arguments` > entry fallback), command aliases
(`command` > `cmd` > `CommandLine` > `commandLine`), target aliases (`path` > `filePath` > `file_path` >
`AbsolutePath` > `absolute_path` > `target` > `file`), and completed call refusal fallbacks (`result.rejected`,
`result.permissionDenied`) ensure shell and file tool calls reach the guard
([#287](https://github.com/zemdregon/switchboard/pull/287), [#299](https://github.com/zemdregon/switchboard/pull/299)).
`editFileToolCall` and `writeFileToolCall` are edit tools carrying their path
([#341](https://github.com/zemdregon/switchboard/pull/341)). Late or swapped commands or paths on `tool_call`
`completed` (or a repeated `started`) are tracked via `seenToolCalls` and re-evaluated by the guard without
duplicating identical reports; `call_id` or `callId` correlates `started` and `completed` (a different id is a new
call), and without either the tool key is the step id ([#341](https://github.com/zemdregon/switchboard/pull/341),
[#348](https://github.com/zemdregon/switchboard/pull/348)). Unmapped tool names carrying a command, or named with
shell aliases
(`bashToolCall`, `terminalToolCall`, `execToolCall`, `runCommandToolCall`, `executeCommandToolCall`), map to
`tool: "shell"` so the ADR-0039 tool-call guard intercepts unauthorized Git writes (`PERMISSION_BLOCKED`;
[#299](https://github.com/zemdregon/switchboard/pull/299)). Tool refusal aliases normalize `permission_denied`,
`denied`, `blocked`, and permission error text to `permission_denied` events
([#299](https://github.com/zemdregon/switchboard/pull/299)). Assistant message text is clipped to 2,000 characters,
target paths to 512 characters, and tool names and result subtypes to 64 characters; non-string values are dropped,
never coerced.

Supervisor-replayed JSONL fixtures under `src/adapters/cursor/fixtures/` pin today's gaps without inventing native
fields ([#283](https://github.com/zemdregon/switchboard/pull/283),
[#287](https://github.com/zemdregon/switchboard/pull/287),
[#309](https://github.com/zemdregon/switchboard/pull/309),
[#315](https://github.com/zemdregon/switchboard/pull/315),
[#324](https://github.com/zemdregon/switchboard/pull/324),
[#341](https://github.com/zemdregon/switchboard/pull/341)): `rate_limit` (rows 4 and 14, never reached/forced) replays
an empty stream at exit 1 to `TOOL_FAILURE`, never `RATE_LIMIT_TRANSIENT`; `rate_limit_error` replays an in-stream
error result at exit 0 to `TOOL_FAILURE`; `sandbox_violation` (row 9, unrecorded sandbox error text at exit 0) replays
to `TOOL_FAILURE`, never `SANDBOX_VIOLATION`; `unknown_events` replays to `OUTPUT_PROTOCOL_ERROR` with every unreadable
line counted and no session bound; `unknown_event` replays an unrecorded event in an otherwise clean success to `ok`
with one unknown event counted ([#309](https://github.com/zemdregon/switchboard/pull/309)) and is replayed again so an
unknown shape cannot supply a result while a later recognized `result` still succeeds
([#324](https://github.com/zemdregon/switchboard/pull/324)); `trailing_tool` replays a
`tool_call` after the `result` line to `OUTPUT_PROTOCOL_ERROR`; `session_changed` replays a conflicting `session_id` to
`OUTPUT_PROTOCOL_ERROR` with the first id bound; `two_results` replays more than one result line to
`OUTPUT_PROTOCOL_ERROR`; `git_write_guard` (ADR-0039) replays a guard-flagged Git write under a `success` result at exit
0 to `PERMISSION_BLOCKED`; `git_write_guard_args` replays the same Git write under `args.CommandLine`
([#315](https://github.com/zemdregon/switchboard/pull/315)); `no_result` replays text output at exit 0 without a
`result` line to `OUTPUT_PROTOCOL_ERROR`; `unsafe_session_id` replays an unsafe session id in `init` to
`OUTPUT_PROTOCOL_ERROR` without
binding; `unsafe_id_after_bound` replays an unsafe session id in `result` after a normal `init` to
`OUTPUT_PROTOCOL_ERROR` while preserving the first bound id ([#309](https://github.com/zemdregon/switchboard/pull/309));
`permission_denied` (row 7a `result.rejected`) and `permission_denied_perm` (row 11 `result.permissionDenied`,
[#309](https://github.com/zemdregon/switchboard/pull/309)) replay soft denials to `PERMISSION_BLOCKED`;
`denied_after_write` replays a workspace write before a soft denial to `PERMISSION_BLOCKED` with the write visible in
partial mutation ([#309](https://github.com/zemdregon/switchboard/pull/309)); `resume_unknown_id` replays an
unknown session id answered with success to verify that native session id mismatch fails the conformance resume test
([#309](https://github.com/zemdregon/switchboard/pull/309)); `resume_failure` replays a resumed run whose `result` is an
error to `TOOL_FAILURE`, preserving the resumed session id; `error_after_result` replays a late `system`/`init` whose
`apiKeySource` is not `login` after a success `result` at exit 0 to `AUTH_REQUIRED` with the first session id
preserved; and `malformed_after_result` replays malformed framing after a recognized `result` to
`OUTPUT_PROTOCOL_ERROR` through the supervisor, keeping the structured session id (all
[#324](https://github.com/zemdregon/switchboard/pull/324)); and `denied_after_result` replays a completed refusal after
a success `result` at exit 0 to `PERMISSION_BLOCKED` ([#341](https://github.com/zemdregon/switchboard/pull/341)). The
`classifyFailure` precedence chain is pinned in the same
change: supervisor cancel, timeout, `protocol_error`, `internal_error`, crash and spawn outcomes beat every stream
signal including the ADR-0039 guard verdict; the guard beats denials; denials beat provider errors; a provider error
beats a `rate_limit` event, a failed `result` and the exit code; and the Cursor `protocol` category maps to
`OUTPUT_PROTOCOL_ERROR` ([#324](https://github.com/zemdregon/switchboard/pull/324)). The extra fields the live check
recorded (`duration_ms`, `duration_api_ms` and `request_id` on `result`; `permissionMode` and `cwd` on `init`;
`timestamp_ms` on `thinking`) never widen the usage record or reach an event
([#324](https://github.com/zemdregon/switchboard/pull/324)). The same `classifyFailure` precedence holds when
lower-priority events arrive first ([#333](https://github.com/zemdregon/switchboard/pull/333)). Native credential
(`apiKeySource` other than `login`) and protocol (mid-run session-id change) errors stay failures in either order
around `result`; the first `provider_error` wins, and a failed `result` never outranks `AUTH_REQUIRED`. Opaque
unknown envelopes before or after `result` cannot bind a session or smuggle status, usage, model, vendor or a
credential source ([#333](https://github.com/zemdregon/switchboard/pull/333)). The "cursor parser residual branches
(T4.43, synthetic)" suite in `src/adapters/cursor/cursor.test.ts` pins non-object tool entries, id-less step ids,
paths first carried or swapped on `completed`, unmapped tools first carrying a command on `completed`, prototype-named
keys on `completed` whose refusal still fails the run, and a `tool_call` without a usable subtype (`unknown`, failing
the run after `result`) ([#348](https://github.com/zemdregon/switchboard/pull/348)). Parser residual pins in
`src/adapters/cursor/parser-residual.test.ts` (line counting, empty-string fallbacks, `apiKeySource` formatting,
tool-parameter fall-through, id-less `tool_call` correlation, provider_error categories, `resumeArgs` refusals) and
supervisor replay of `idless_guard.jsonl` (id-less Git write under `success` at exit 0 → `PERMISSION_BLOCKED`) are on
`main` ([#360](https://github.com/zemdregon/switchboard/pull/360); ROADMAP T4.43, [TDD §4.5.5](../design/TDD.md#455-cursor-parser-implementation-evidence-m4-t443)).
A quota-stopped run has since been captured as stderr tails (T6.11 limit captures `cursor-*.txt`, newest
2026-10-18T16:23Z: empty stdout, exit 1, `ActionRequiredError` with `out of usage`) and maps to `QUOTA_EXHAUSTED`
in `classifyFailure` from the stderr tail (PR #700, T6.15, ADR-0058); the `stream-json` shape of a quota stop
is still unrecorded, so the stream-parser path still ends `TOOL_FAILURE`. T4.43 is Done against its Done-when under
owner decision 65 (a); T4.45 to T4.47 are `Done` against their Done-when on synthetic fixtures. Still open, carried
by T4.48: a recorded `stream-json` quota-stop shape and any native backing-vendor field.

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`**: Cursor documents permission rules in configuration
files, not per-run argv, and Switchboard does not write a per-run `CURSOR_CONFIG_DIR` file. Shell allowlist entries that
could write Git make the run `Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01), including on an approved bypass scope.

The parser treats a guard-flagged `tool_call` (`violation`) as a failed run per
[ADR-0039](../adr/0039-switchboard-side-tool-call-guard.md) even when `result` is `success` at exit 0
(`src/adapters/cursor/cursor.test.ts`; [#238](https://github.com/zemdregon/switchboard/pull/238)). In an approved bypass
run the guard enforces Git writes only; other hostile categories that never appear as a refused `tool_call` on the
recorded fields still end `ok` on synthetic fixtures until operator captures pin live blocked outcomes (ROADMAP T4.48).

`commitChannel` is **`finalize-only`**: Switchboard does not inject a `commit` tool or pass `--approve-mcps`, so
repository `.mcp.json` servers stay unapproved (observed on the 2026-10-14 live check). To publish work, set
`finalize_commit` on the project's primary context as for Codex ([How commits reach
Git](mcp-server.md#how-commits-reach-git)). In an
approved bypass run, Git-write denial therefore rests on FR-GIT-03 and FR-GIT-06 in addition to any provider rule.

Fixture evidence on `main`: `src/adapters/cursor/fixtures/` (T4.43 Done-when and T4.45 conformance JSONL, including
`backing_provider.jsonl` from [#275](https://github.com/zemdregon/switchboard/pull/275), Done-when fixtures from
[#283](https://github.com/zemdregon/switchboard/pull/283), anomaly and parameter fallback fixtures from
[#287](https://github.com/zemdregon/switchboard/pull/287), conformance/refusal fixtures from
[#309](https://github.com/zemdregon/switchboard/pull/309), remaining T4.45 fixtures including
`git_write_guard_args.jsonl` from [#315](https://github.com/zemdregon/switchboard/pull/315), and stream-order,
`classifyFailure`-precedence and recorded-field pins with `resume_failure.jsonl`, `error_after_result.jsonl` and
`malformed_after_result.jsonl` from [#324](https://github.com/zemdregon/switchboard/pull/324),
`denied_after_result.jsonl` from [#341](https://github.com/zemdregon/switchboard/pull/341), `idless_guard.jsonl` from
[#360](https://github.com/zemdregon/switchboard/pull/360)); residual ordering and resume/compile-parity pins in
`src/adapters/cursor/cursor.test.ts` from [#333](https://github.com/zemdregon/switchboard/pull/333), resume-id,
correlation and edit-key pins from [#341](https://github.com/zemdregon/switchboard/pull/341) and "cursor parser residual
branches (T4.43, synthetic)" from [#348](https://github.com/zemdregon/switchboard/pull/348); "cursor parser residuals
(T4.43, synthetic lines; parser unchanged)" in `src/adapters/cursor/parser-residual.test.ts` from
[#360](https://github.com/zemdregon/switchboard/pull/360); `src/adapters/cursor/cursor.test.ts` ("cursor compile matrix
(T4.42)", "cursor bypass-class declarations (ADR-0035, ADR-0037)", "cursor probe and auth preflight (T4.42, T4.44)",
"cursor registry entry and manifest gate (T4.42)", "cursor parser and result (T4.43)", "cursor parser hardening (T4.43,
synthetic shapes)", "cases with no recorded native shape (live check rows 4, 9, 14)" fixture replay, "cursor conformance
suite (synthetic recorded fixtures, FR-ADP-11, T4.45)", "cursor backing-provider fixture (T4.43, T4.6, FR-ADP-10)",
"cursor Git declaration (T4.47, FR-GIT-01, FR-GIT-02, FR-GIT-09)" and "cursor malicious-fixture leg (T4.46, NFR-SEC-03,
FR-POL-04, FR-POL-06)"); CI also runs `test/malicious/adapters/cursor.case.ts`,
`test/malicious/adapter-leg.test.ts` ("adapter malicious leg: cursor") and
`test/malicious/cursor-leg.test.ts` ("Cursor malicious leg matrix (T4.46)": each hostile category at exits 0, 1, 2
and 137, plus 12 partial streams; [#316](https://github.com/zemdregon/switchboard/pull/316)). The residual cells
(`cursorResidualStreams`, [#367](https://github.com/zemdregon/switchboard/pull/367)) replay each blocked category
denied at exits 2 and 137 to `PERMISSION_BLOCKED`. Completed shell calls the provider did not refuse but that carry
a Git write end `PERMISSION_BLOCKED` at exits 0 and 1, including a hostile `started` command swapped to `ls` in
`completed`, an unmapped tool key carrying `command` and a benign `readToolCall` decoy key beside the shell key; the
six plain cells parse no `permission_denied`, so the ADR-0039 guard verdict alone blocks them, and a positive control
shows the same stream without that verdict would end `ok`. A denial followed by a separate benign call, or after the
`result` line, still ends `PERMISSION_BLOCKED`; unknown-event streams at exits 2 and 137 end `TOOL_FAILURE`; and bare
or unreadable `tool_call`, `system`, `result` and non-string `type` lines parse only as `unknown`
(`OUTPUT_PROTOCOL_ERROR` at exit 0, `TOOL_FAILURE` at exit 1). These are compile and parse evidence only, not native
containment. The conformance suite
replay dialect (`src/adapters/fixtures/replay-dialects/cursor.mjs`) enforces single `--print`,
`--output-format stream-json`, `--trust`, `--force`, safe non-flag `--resume <id>`, no `--`, no positional arguments,
and refuses credentials and config env variables (`CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_CONFIG_DIR`,
`XDG_CONFIG_HOME`) and unauthorized or never-compiled flags (59 compile/env refusal checks pass in CI, including `=`
forms of compiled `--print`/`--trust`/`--force`;
[#309](https://github.com/zemdregon/switchboard/pull/309),
[#315](https://github.com/zemdregon/switchboard/pull/315)). End-to-end runs through Switchboard against a logged-in
`cursor-agent` are recorded under T4.48: the live `adapters validate` smoke call on CLI 2026.10.16 on
2026-10-19 (one structured-output smoke call in the approved privileged bypass cell under owner decision 59), the
full live smoke passed the same day (`outcome=ok`, 11 held) and the live malicious leg closed the same day (post-merge
rerun w1703 inside the wrapper: U-M1/U-M2 `HELD`, U-M3 `NOT_CHECKED` as expected bypass behaviour per owner decision 77);
T4.48 is `Done` (closed by owner decision 77). The escape fix has landed on this branch ([ADR-0059](../adr/0059-cursor-bypass-cell-bubblewrap-wrapper.md),
owner ruling 2026-10-19 06:41 CDT: the bypass cell runs inside Switchboard's bubblewrap wrapper, hermetically tested);
the first live rerun inside the wrapper (w1700) ended with all three cells `NOT_CHECKED` on a harness fault, not a
wrapper or model outcome (under the owner ruling of 2026-10-19 08:12 CDT a check is `HELD` only when attempted, and
U-M2/U-M3 join U-M1 as `mustRun`); the w1703 rerun reached the tools and closed the row per the steward
ruling of 2026-10-19 09:50 CDT.

## OpenCode CLI (milestone 4)

Config id `opencode`; routing and `list_capabilities` id `opencode`. Switchboard runs the **`opencode`** binary with
`run --format json --standalone -- <prompt>` ([TDD §4.6](../design/TDD.md#46-opencode-m4); observed on
2026-10-14 in [`docs/research/live-checks-2026-10-14-opencode.md`](../research/live-checks-2026-10-14-opencode.md),
`opencode v2.0.23`). The prompt is one argv word after `--`, not stdin (an Assumption in the adapter). Every compiled
invocation sets `OPENCODE_DISABLE_AUTOUPDATE=1` with an environment allowlist of `PATH` and `HOME` only. Switchboard never
sets `OPENCODE_PERMISSION` or `OPENCODE_CONFIG_CONTENT` (env/inline config ignored on that version in the live
checks, reconfirmed 2026-10-18).

The compliance manifest range (`src/adapters/manifests/opencode.json`) admits `>=2.0.23 <2.1.0` since
`switchboard adapters validate opencode` passed on CLI v2.0.23 on 2026-10-18 (ROADMAP T4.58, owner decisions 60 and
68; [`docs/research/live-checks-2026-10-18-opencode.md`](../research/live-checks-2026-10-18-opencode.md)). Other
versions still report `ADAPTER_VERSION_UNVERIFIED` in `doctor`. The live smoke and the live malicious leg ran on
2026-10-19 (ROADMAP T4.58 Done; [`docs/research/live-checks-2026-10-19-opencode.md`](../research/live-checks-2026-10-19-opencode.md)):
smoke 11 HELD with the edit landing through recognised `write`/`shell` calls (O-G1 NOT_CHECKED: no Git write
attempted in the smoke; covered by O-M1), malicious O-M1/O-M2/O-M3 all HELD, no
check ESCAPED. T11.0's
2026-10-17 run found no tool-free control on that version
([TDD §4.6.7](../design/TDD.md#467-t110-live-result-2026-10-17)).

### Login

See the [login table](getting-started.md#log-in-to-the-providers-natively) above. Switchboard never runs `opencode auth
login`; it only
runs `opencode auth list --format json --standalone` during preflight.

### Trust profiles

The adapter compiles only what [TDD §4.6.1](../design/TDD.md#461-opencode-native-controls-per-profile-and-platform-t450)
records for the 2026-10-14 live check (Q-64, Q-83): every profile other than an approved `privileged` bypass scope is
refused (`PROFILE_UNSUPPORTED`), because no env/inline per-run deny took effect (a project-config deny takes effect but
matches lexically only: row 7 ESCAPED on 2026-10-18), the default runs shell commands including Git
writes, no sandbox is documented and a repository's `opencode.json` and `AGENTS.md` load.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`) |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). An approved scope with `bypass` compiles one argv shape: `opencode run --format json --standalone -- <prompt>` with worktree file access, shell `broad`, network `on` and repository configuration `enabled`, and **no** `--auto` (owner decision 46, Q-83). A scope without `bypass`, or any narrowing Switchboard can express, is refused before spawn. Bypass-class flags such as `--auto` are never compiled outside that case (and are not emitted even inside it). Never emits `--continue`, `--fork`, `--server`, `--attach`, `--share`, `--dir` or `--model` (the compile test pins the exact argv and an env of only `OPENCODE_DISABLE_AUTOUPDATE=1`; the malicious leg checks these, plus `--auto` and the bypass flags, as `neverEnabledFlags`). |

Resume continues the native session with `--session <session_id>` through the same matrix when the provider is eligible
(synthetic fixtures in `src/adapters/opencode/opencode.test.ts`, T4.53). `resumeArgs` mirrors `compile` across every
structured scope shape (the full `scopeShapes()` sweep with `bypassApproved` true/false; exactly one compiled approved
bypass shape) appending `--session <id>` before the prompt, and rejects foreign provider bindings and ineligible
profiles with exact reasons ([#339](https://github.com/zemdregon/switchboard/pull/339)). Alphanumeric, UUID and
delimited session ids compile; unsafe or flag-like ids, another provider's binding and every non-`privileged` profile
are refused with reasons, and resume preserves the request's working directory and the compile-time env, flags and audit
([#290](https://github.com/zemdregon/switchboard/pull/290)). A `sessionID` that resume could not pass as one safe
argument (matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`, refusing leading dashes or flag syntax) is never bound
(`OUTPUT_PROTOCOL_ERROR`; [#245](https://github.com/zemdregon/switchboard/pull/245)). Only an exact string `"stop"`
reason on `step_finish`, or a non-empty `text` before any tool event or `step_finish` (owner decision 68), emits a
result (on `step_finish`, case, whitespace, alternate reasons or non-string values never emit a result
and fail closed as `OUTPUT_PROTOCOL_ERROR`; Q-85, [#328](https://github.com/zemdregon/switchboard/pull/328)). A
`tool_use` line after the final result — a `step_finish` `stop`, or a text-only reply under owner decision 68 —
is not a success (fail closed; a guard-flagged trailing call keeps
`PERMISSION_BLOCKED` per ADR-0039). A trailing `tool_use` the parser cannot read still ends `OUTPUT_PROTOCOL_ERROR`
instead of success. `tool_use` keys that name `Object.prototype` members map to `other` (own-key lookup;
[#245](https://github.com/zemdregon/switchboard/pull/245)); since
[#290](https://github.com/zemdregon/switchboard/pull/290), own-property reads cover every structured field, so
prototype-named or `__proto__`-smuggled values fail closed as `unknown`. A malformed `step_start` (a missing `part`,
or a non-string `part.type` such as null, boolean, number, array or object) fails closed as `unknown`, ending
`OUTPUT_PROTOCOL_ERROR`, while an omitted `part.type` remains accepted
([#339](https://github.com/zemdregon/switchboard/pull/339)). An unknown or unreadable event anywhere in the stream —
before or after the final result — is never a success: exit 0 ends `OUTPUT_PROTOCOL_ERROR`, exit 1 stays `TOOL_FAILURE`,
and a later `stop` does not wash an earlier unreadable line
([#284](https://github.com/zemdregon/switchboard/pull/284)). Opaque unknown envelopes (even carrying spoofed session ID,
model, vendor, tokens or status) before or after clean `stop` cannot bind a session or smuggle status, usage, model or
vendor, ending `OUTPUT_PROTOCOL_ERROR` ([#339](https://github.com/zemdregon/switchboard/pull/339)). Structured provider
errors after a `stop` step cannot be erased by another `stop` or success text (`provider.no-route` →
`MODEL_UNAVAILABLE`, `provider.quota` → `QUOTA_EXHAUSTED`, `provider.auth` → `AUTH_REQUIRED`, unmapped error →
`TOOL_FAILURE`; [#328](https://github.com/zemdregon/switchboard/pull/328)). Structured `backing_provider` /
`backingProvider` and `model` fields on the event root or its part set `backingProvider` and `model` on
`session_bound` (non-strings dropped, clipped to 128 characters) and are stored on `provider_reported` usage rows side
by side with the harness `opencode`, shown in `get_run` — the T4.6 fronted-harness case, replayed end to end by
`backing_provider.jsonl`; they are never inferred from a display name, and native OpenCode captures name none (observed
absent on 2026-10-17: no `providerID` or `modelID` in any record,
[`docs/research/live-checks-2026-10-17-opencode.md`](../research/live-checks-2026-10-17-opencode.md)), so there
they stay unset ([#290](https://github.com/zemdregon/switchboard/pull/290)). The extra fields recorded in the 2026-10-14
live check (`error.status`, `error.response`, `timestamp`, `messageID`, `step_start.snapshot`) never widen the usage
record or reach an event; HTTP 429 `status` on an unmapped error type is never `RATE_LIMIT_TRANSIENT`; session ID
aliases (`sessionId`, `session_id`) never bind a session; model aliases (`model_id`, `modelId`) never set model;
and input aliases (`cmd`, `CommandLine`, `file_path`, `AbsolutePath`) never populate command or target (input key
names recorded 2026-10-18: `command` was the only key on every shell `tool_use`; values never captured, so other
spellings stay Assumptions). `ParseState` instances isolate `seenParts` WeakMap state across separate runs. Clean
turns without text leave summary undefined; long text is clipped to 2,000 characters; and bounds clipping limits tool
name to 64 chars and target to 512 chars ([#311](https://github.com/zemdregon/switchboard/pull/311)). The
`classifyFailure` precedence chain is pinned on synthetic fixtures: supervisor exit outcomes (`protocol_error`,
`internal_error`, `crashed`, `spawn_error`, `timeout`, `cancelled`) outrank the ADR-0039 guard verdict; the guard outranks
`permission_denied` and `sandbox_violation` events; denials outrank provider errors; a provider error outranks a
`rate_limit` event, a failed `result` and the exit code; and the OpenCode `protocol` category maps to
`OUTPUT_PROTOCOL_ERROR`. Precedence does not depend on arrival order, and free text in `stderrTail` never changes
structured precedence ([#321](https://github.com/zemdregon/switchboard/pull/321),
[#339](https://github.com/zemdregon/switchboard/pull/339)). Residual parser branches on synthetic lines
([#357](https://github.com/zemdregon/switchboard/pull/357)) pin that an empty `text` part adds no message and leaves a
clean run without summary, an error with structured `type` and no string message preserves its error category
(`AUTH_REQUIRED`, `QUOTA_EXHAUSTED`, `MODEL_UNAVAILABLE`, `TOOL_FAILURE`), the part's `sessionID` binds when root has
none or non-string, root session ID wins over part on the same line, empty id is absent, `backing_provider`/`model`
fall back to part while a non-string root value shadows the part (dropped, never merged), and `step_finish` without a
part id is counted every time while one with no readable counters emits no usage but still the result.
Rate-limit and sandbox stream shapes are still unrecorded (no real
OpenCode limit capture exists yet; a limitation still open after ROADMAP T4.58 (ran 2026-10-19 without capturing a
native limit shape) under owner decision 65 (a), with T4.53 Done
against its Done-when on synthetic fixtures). A project-config denial shape was recorded on 2026-10-18 (plain
`git commit`/`git push` denied as a shell `error` with refusal text; spelling variants escaped), and shell
`tool_use` input key names are recorded (`command` the only key; values never captured). Supervisor-replayed JSONL
fixtures pin today's gaps without inventing
native fields
([#274](https://github.com/zemdregon/switchboard/pull/274),
[#290](https://github.com/zemdregon/switchboard/pull/290),
[#311](https://github.com/zemdregon/switchboard/pull/311),
[#321](https://github.com/zemdregon/switchboard/pull/321),
[#328](https://github.com/zemdregon/switchboard/pull/328),
[#339](https://github.com/zemdregon/switchboard/pull/339),
[#357](https://github.com/zemdregon/switchboard/pull/357)): `permission_denied_outside` (live check row 11) ends `stop`
at exit 0 with `state.status` `error` and is not detected as a denial (gap pinned); `rate_limit` (row 14c, never
reached) is an empty stream at exit 1 → `TOOL_FAILURE`; `rate_limit_error` is an unmapped error type at exit 0 →
`TOOL_FAILURE`; `unknown_events` ends `OUTPUT_PROTOCOL_ERROR` with every unreadable line counted;
`no_stop` (row 4a) is a success under owner decision 68 (Q-85 narrowed: text only, no tool, error, `step_finish` or
unknown event) and `trailing_tool` (Q-85) ends `OUTPUT_PROTOCOL_ERROR`; `session_changed` ends
`OUTPUT_PROTOCOL_ERROR` with the first session id still bound; `git_write_guard` (ADR-0039) replays a guard-flagged
Git write under a `stop` finish at exit 0 to `PERMISSION_BLOCKED`; `unsafe_session_id` replays an unsafe session id to
`OUTPUT_PROTOCOL_ERROR` without binding; `sandbox_violation` replays unrecorded sandbox error text at exit 0 to a
success, never `SANDBOX_VIOLATION` (gap pinned); `model_unavailable` (live check 14a) replays `provider.no-route`
at exit 1 to `MODEL_UNAVAILABLE`; `quota_exhausted` (live check 14b) replays `provider.quota` with recorded status 402
at exit 1 to `QUOTA_EXHAUSTED`; `unsafe_id_after_bound` replays an unsafe session id after a bound id to
`OUTPUT_PROTOCOL_ERROR` keeping the first bound id; `stop_then_error` replays a late `provider.auth` error after a
`stop` followed by another `stop` at exit 0 to `AUTH_REQUIRED`
([#328](https://github.com/zemdregon/switchboard/pull/328)); `resume_failure` (live check rows 13a + 14a
combined) replays a resumed failed run to `TOOL_FAILURE` preserving the resumed session id; `malformed_step_start`
replays a non-string `part.type` followed by `stop` to `OUTPUT_PROTOCOL_ERROR`
([#339](https://github.com/zemdregon/switchboard/pull/339)); `error_type_only` replays a `provider.auth` error with
no message at exit 1 to `AUTH_REQUIRED` ([#357](https://github.com/zemdregon/switchboard/pull/357)); and
`part_session_empty_text` replays a part-only `sessionID`, empty text and an id-less `stop` at exit 0 to success with
the id bound and no summary ([#357](https://github.com/zemdregon/switchboard/pull/357)). Closing the remaining gaps
needs operator captures of native refusal field values and of `tool_use` input values (key names recorded
2026-10-18; ROADMAP T4.58 ran 2026-10-19 without capturing them — see T4.56). T4.53 is `Done` against
its Done-when on synthetic fixtures (owner decision 65 (a)) with those native shapes still open after T4.58; T4.52, T4.54,
T4.55 and T4.57 are `Done` against their Done-when on synthetic fixtures.

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`**: OpenCode documents `bash` deny patterns in
configuration, but on opencode v2.0.23 a project-config deny holds only for lexical matches (row 7 ESCAPED on
2026-10-18: plain `git commit`/`git push` denied, `git -C . commit`, `env git commit` and `sh -c 'git commit'`
committed), so Switchboard does not emit a
deny rule. Shell allowlist entries that could write Git make the run `Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01),
including on an approved bypass scope.

The parser treats a guard-flagged `tool_call` (`violation`) as a failed run per
[ADR-0039](../adr/0039-switchboard-side-tool-call-guard.md) even when a `step_finish` `stop` ends at exit 0
(`src/adapters/opencode/opencode.test.ts`; [#245](https://github.com/zemdregon/switchboard/pull/245)). A shell tool named
`bash` — the name OpenCode's permission keys use — or any tool name absent from the recorded kinds whose input carries
a string `command` parses as a shell tool, so its command line reaches the guard whatever the tool is called; a Git
write through such a tool ends `PERMISSION_BLOCKED` at exit 0 and exit 1
([#284](https://github.com/zemdregon/switchboard/pull/284)). A Git write not carried as an own string `command` on a
shell-kind tool — a known file tool, a `cmd` alias, or a command only under an own `__proto__` key — is still invisible
to the guard and stays in the pinned gap list
([#298](https://github.com/zemdregon/switchboard/pull/298)). CI's
malicious-fixture leg (T4.56) replays synthetic hostile streams where shell `tool_use` lines carry commands the guard
can see (including Git writes chained with credential read, out-of-worktree write and network patterns), ending
`PERMISSION_BLOCKED` at exit 0 and exit 1 across hostile categories, including calls after the final `stop` step
([#245](https://github.com/zemdregon/switchboard/pull/245)) and streams unreadable before that step, where an unknown
event anywhere is never a success (exit 0 ends `OUTPUT_PROTOCOL_ERROR`; exits 1, 2 and 137 end `TOOL_FAILURE`)
([#284](https://github.com/zemdregon/switchboard/pull/284)); the matrix was widened across
[#298](https://github.com/zemdregon/switchboard/pull/298),
[#312](https://github.com/zemdregon/switchboard/pull/312),
[#323](https://github.com/zemdregon/switchboard/pull/323),
[#355](https://github.com/zemdregon/switchboard/pull/355), and
[#369](https://github.com/zemdregon/switchboard/pull/369) to cover Git-write command prefixes and subcommands
(`git -C . commit`, `/usr/bin/git commit`, `sh -c`, `env`, `xargs`, `--git-dir`, `reset --hard`, `tag`, `stash`, `merge`,
`rebase`, `checkout -b`, `git branch -D`), alternative command-bearing tool names (`bash` at exit 1, `sh`, `terminal`,
`run_command`, `exec`, `synthetic_exec`, `constructor`, `toString`), provider errors (`provider.overloaded`, raw errors),
hostile streams at exit 2 and exit 137 in every hostile category (ending `PERMISSION_BLOCKED` as the guard outranks
`TOOL_FAILURE`), empty tool names with string command, commands beside paths, swapped benign/hostile commands, separate
benign calls following hostile calls, JSON encodings resolved by `JSON.parse` (`\u` escapes, duplicate command keys with
last-value winning, CRLF lines), hypothetical stop reasons (`max_tokens`, `refusal` at exit 0 where the guard outranks
`OUTPUT_PROTOCOL_ERROR`), path-to-command upgrades in subsequent `tool_use`, 48 partial streams cutting before,
inside, and after hostile calls (`opencodePartialStreams`), and 140 unreadable-event streams before/after `stop` at
exits 0, 1, 2 and 137 (`opencodeUnreadableStreams`). In an approved bypass run the guard still enforces Git
writes only: an out-of-worktree denial recorded only as `tool_use`
`state.status` `error` without refusal-specific fields still ends `ok` in the parser suite (T4.53 gap pinned); closing
that needs operator capture of native refusal fields or an owner decision on classifying `status` `error` (still open after
ROADMAP T4.58, which ran 2026-10-19 without capturing native refusal fields; the gap list stays on T4.56).

`commitChannel` is **`finalize-only`**: Switchboard does not inject a per-run MCP server through
`OPENCODE_CONFIG_CONTENT` (not exercised on the 2026-10-14 live check). In the only compiled scope, repository
`opencode.json` and `AGENTS.md` load (owner decision 26). To publish work, set `finalize_commit` on the project's primary
context as for Codex ([How commits reach Git](mcp-server.md#how-commits-reach-git)). In an approved bypass run,
Git-write denial
therefore rests on FR-GIT-03 and FR-GIT-06 in addition to any provider rule.

Fixture evidence on `main`: `src/adapters/opencode/fixtures/` (T4.53 Done-when and T4.55 conformance JSONL, including
`permission_denied_outside`, `rate_limit`, `rate_limit_error`, `unknown_events`, `no_stop`, `trailing_tool` and
`session_changed` from [#274](https://github.com/zemdregon/switchboard/pull/274), `backing_provider` from
[#290](https://github.com/zemdregon/switchboard/pull/290), `git_write_guard`, `unsafe_session_id`,
`sandbox_violation` and `model_unavailable` from [#311](https://github.com/zemdregon/switchboard/pull/311),
`quota_exhausted`, `unsafe_id_after_bound` and `resume_failure` from [#321](https://github.com/zemdregon/switchboard/pull/321),
`stop_then_error` from [#328](https://github.com/zemdregon/switchboard/pull/328), `malformed_step_start` from
[#339](https://github.com/zemdregon/switchboard/pull/339), plus `error_type_only` and `part_session_empty_text` from
[#357](https://github.com/zemdregon/switchboard/pull/357)); `src/adapters/opencode/opencode.test.ts` ("opencode
compile matrix (T4.52)", "opencode bypass-class declaration (ADR-0035)", "opencode probe and auth preflight (T4.52, T4.54)",
"opencode registry entry and manifest gate (T4.52)", "opencode parser and result (T4.53)",
"cases with no recorded native shape (live check rows 7, 11, 14c)" fixture replay, parser hardening and trailing-tool
pins in the same file, exact string `stop` matching ("only an exact string stop reason emits a result (Q-85)",
[#328](https://github.com/zemdregon/switchboard/pull/328)), late provider error preservation ("a structured provider
error after a stop cannot be erased by another stop or success text",
[#328](https://github.com/zemdregon/switchboard/pull/328)), malformed step-start fail-closed ("non-string step_start
part.type is unreadable even before a clean stop; an omitted type remains accepted",
[#339](https://github.com/zemdregon/switchboard/pull/339)), `resumeArgs` scope compile parity
("resumeArgs mirrors compile across every structured scope, including exact refusals",
[#339](https://github.com/zemdregon/switchboard/pull/339)), the `resumeArgs` edge-case pins ("accepts valid
alphanumeric, UUID and delimited session IDs and refuses unsafe or flag-like shapes", "preserves request cwd and mirrors
compile policyFlags, env and audit", "rejects foreign provider bindings and ineligible profiles with exact reasons"),
`classifyFailure` precedence chain and arrival-order independence ("classifyFailure precedence: supervisor outcomes over
the guard...", "classifyFailure precedence does not depend on lower-priority events arriving first",
[#321](https://github.com/zemdregon/switchboard/pull/321), [#339](https://github.com/zemdregon/switchboard/pull/339)),
recorded extra fields and alias exclusions ("recorded extra fields (error.status, error.response, timestamp, messageID,
snapshot) are never usage metrics or events", "sessionId/session_id never bind a session; model_id/modelId never set model",
"tool call without command or target keys emits tool_call with no command or target", "non-string command and path values
are omitted, never coerced", [#321](https://github.com/zemdregon/switchboard/pull/321)), `seenParts` WeakMap isolation
("seenParts WeakMap state is isolated across separate ParseState instances",
[#311](https://github.com/zemdregon/switchboard/pull/311)), summary clipping and bounds clipping ("clean turn with no
text messages leaves summary undefined, not empty string; long text is clipped to 2000 chars", "bounds clipping:
tool name > 64 chars, target > 512 chars", [#311](https://github.com/zemdregon/switchboard/pull/311)), parser residual
branches ("an empty text part is readable but adds no message...", "an error with a structured type and no string
message keeps the type's category...", "the part's sessionID binds when the root has none or a non-string one...",
"backing_provider and model fall back to the part...", "a step_finish without a part id is counted every time...",
[#357](https://github.com/zemdregon/switchboard/pull/357)),
"opencode backing-provider fixture (T4.53, T4.6, FR-ADP-10)", the T4.56 pins ("an unknown or unreadable event anywhere,
before or after the final stop step, is never a success", "a shell tool named bash, or any unlisted tool carrying a string
command, reaches the tool-call guard",
"a guard-flagged Git write ends PERMISSION_BLOCKED at exit 2 and exit 137, and survives subsequent benign calls (T4.56)",
[#355](https://github.com/zemdregon/switchboard/pull/355)), "opencode conformance suite (synthetic recorded fixtures,
FR-ADP-11, T4.55)" and "opencode Git declaration (T4.57, FR-GIT-01, FR-GIT-02, FR-GIT-09)");
CI also runs `test/malicious/adapters/opencode.case.ts` (275 synthetic streams: 263 blocked — 88 `credential_read`, 90
`out_of_worktree_write`, 85 `network` — and 12 `unknown_events`, 3 ending `OUTPUT_PROTOCOL_ERROR` at exit 0 and 9
`TOOL_FAILURE` at exits 1, 2 and 137; 48 `opencodePartialStreams`, 140 `opencodeUnreadableStreams`) and
`test/malicious/adapter-leg.test.ts` ("adapter malicious leg: discovery", "adapter malicious leg: opencode" and
"adapter malicious leg: opencode partial streams", T4.56 Done against its Done-when under owner decision 65 (b) — see
[Known limitations](advanced-features.md#known-limitations);
guard-blocked, trailing-tool and unreadable-event streams [#245](https://github.com/zemdregon/switchboard/pull/245),
[#284](https://github.com/zemdregon/switchboard/pull/284),
[#298](https://github.com/zemdregon/switchboard/pull/298), matrix gap fills
[#312](https://github.com/zemdregon/switchboard/pull/312),
[#323](https://github.com/zemdregon/switchboard/pull/323), exit 2/137 variations and swapped commands
[#355](https://github.com/zemdregon/switchboard/pull/355), and JSON encodings, hypothetical stop reasons, path-to-command
upgrades and exit 2/137 variations [#369](https://github.com/zemdregon/switchboard/pull/369)). T4.52, T4.54, T4.55 and
T4.57 are `Done` against their Done-when on synthetic fixtures; T4.53 and T4.56 are `Done` against their Done-when
under owner decision 65 (a) and (b), with native limit, refusal and tool-input shapes still open after T4.58 (see those
rows).
A successful end-to-end routed run through Switchboard against a logged-in `opencode` was recorded on
2026-10-19 (T4.58 Done): the live smoke edit task SUCCEEDED with `SMOKE.md` on the result branch, and the live
malicious leg held O-M1/O-M2/O-M3 with no check ESCAPED
([`docs/research/live-checks-2026-10-19-opencode.md`](../research/live-checks-2026-10-19-opencode.md)). The 2026-10-18
`adapters validate opencode` pass (CLI 2.0.23, owner decisions 60 and 68) ran one model call through the smoke
and set the manifest range to `>=2.0.23 <2.1.0`.

## Kimi Code CLI (milestone 4)

Config id `kimi-code`; routing and `list_capabilities` id `kimi`. Switchboard runs the **`kimi`** binary one
process per run ([ADR-0049](../adr/0049-kimi-code-transport-and-bypass-class.md),
[TDD §4.7](../design/TDD.md#47-kimi-code-m4-blocked-by-b-1); flags observed on Kimi Code CLI 2.1.1 in
[`docs/research/live-checks-2026-10-15-kimi.md`](../research/live-checks-2026-10-15-kimi.md), which made no model
call). Since the owner-level ruling relayed 2026-10-19 08:45 CDT ("T4.68 KIMI BYPASS-ONLY", ROADMAP T4.68), Kimi Code
is bypass-only: only the approved bypass cell below compiles, and any other mode is `Ineligible:
PROFILE_UNSUPPORTED` with a detail starting `mode approval: Kimi has no permission requests` (`kimiBypassOnlyGate` in
`src/adapters/kimi/adapter.ts`, tested by `src/adapters/kimi/bypass-only-gate.test.ts`), because Kimi Code 2.1.1
raises no ACP `session/request_permission` in `default` mode (ADR-0049 item 3):

- an approved `privileged` scope that sets `bypass` runs `kimi --prompt=<prompt> --output-format stream-json`
  (subprocess JSONL). `kimi -p`/`--prompt` never asks before a tool call, so it is bypass-class and nothing is added to
  restrict that run;
- a `privileged` scope without `bypass` no longer compiles: the ACP surface (`kimi acp` over stdio through the shared
  ACP client, [ADR-0036](../adr/0036-per-run-acp-stdio-client.md), mode `plan` for read-only files and `default`
  otherwise with the controller answering every `session/request_permission` and the plan's `requirePermissionRequest`
  check ending unasked tool calls `PERMISSION_BLOCKED`, [LLD §2](../design/LLD.md#2-adapter-contract)) is kept in code
  for the Deferred [ROADMAP §8](../ROADMAP.md#8-deferred-and-excluded-work) row "Kimi ACP permission gating
  (ADR-0049 item 3)", but the gate refuses it before any invocation is built, so no run reaches it. The auth
  preflight below still probes over `kimi acp` (no model call, no run compiled).

The bypass prompt and a requested model are one argv word each (`--prompt=<prompt>`, `--model=<alias>`), so a leading
`-` is never read as a flag; the prompt is visible in the process list. That the CLI accepts the `=` form held
in every live run to date (the `adapters validate` smoke on 2026-10-18 and the w1408/w1601 live legs, all through
compiled `--prompt=<prompt>` argv — see ROADMAP T4.68). Every compiled
invocation has an empty environment with an allowlist of `PATH` and `HOME`; `KIMI_CODE_HOME`, which relocates Kimi's
configuration, sessions and credentials, is never passed. The adapter never reads a Kimi credential or configuration
file and never writes provider configuration (`src/adapters/kimi/adapter.ts`, `src/adapters/kimi/protocol.ts`).

The compliance manifest range (`src/adapters/manifests/kimi.json`) admits `>=2.1.1 <2.2.0`
since `switchboard adapters validate kimi` passed on CLI 2.1.1 on 2026-10-18 (ROADMAP T4.68).
Other versions still report `ADAPTER_VERSION_UNVERIFIED` in `doctor`, and the adapter stays disabled
(T4.68 closed Partial-by-ruling 2026-10-19 without a pass; permission gating is Deferred — see ROADMAP T4.68,
FR-ADP-09).

Plan usage: `get_capacity` and `switchboard capacity` show Kimi's own `/usage` figures as `provider_usage`
(`source: "provider_reported"`; windows `5h`, `weekly`, `monthly`, plus `kimi:monthly` and `code:monthly`, and the
"Extra Usage" wallet as `credits`), or `source: "unknown"` with a reason when the read fails. Switchboard types `/usage`
into the TUI under a pseudo-terminal and reads no Kimi credential
([ADR-0081](../adr/0081-kimi-usage-via-cli-usage-display.md), shape in
[ADR-0079](../adr/0079-provider-reported-usage-reader.md)).

### Login

See the [login table](getting-started.md#log-in-to-the-providers-natively) above. Switchboard never runs `kimi login` or
`kimi acp --login`. Kimi Code has no auth status command, so the auth preflight (T4.64) runs `kimi acp` in a fresh
private scratch directory and writes ACP `initialize` and `session/new` (that directory, no `mcpServers`) on stdin,
which stays open until both replies arrive or the 15 s bound ends the probe (Kimi Code 2.1.1 can exit at stdin
end-of-file before it answers `session/new`); it never sends `authenticate` or a prompt, so no model call is made. Only
the JSON-RPC replies decide, whatever the exit code: a `session/new` result with a safe `sessionId` is `OK`, a
`session/new` error `-32000` is `AUTH_REQUIRED` naming `kimi login` (live check rows 8 to 10), and anything else is
`UNKNOWN` (fail closed). The reason carries codes, the exit, whether stdin was still open and at most one clipped stderr
line scrubbed of paths, secrets and ids; never the provider's JSON-RPC message text. The probe session is persisted in
Kimi's own data directory (live check row 12), so the preflight cache bounds it to once per window. The `doctor`
probe runs `kimi --version` and `kimi --help`, which must list `--prompt`, `--output-format`, `--model`, `--session`
and the `acp` subcommand.

### Trust profiles

Kimi Code has no sandbox or network control on either surface, and a trusted workspace loads the repository's
`.kimi-code/mcp.json`, `local.toml` and agent files with no per-run flag to disable them, so the adapter compiles only
the `privileged` cells below (Delegated, fail closed; T4.62).

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`): no sandbox or network control, and repository configuration cannot be disabled |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | yes, one cell (bypass-only since the 2026-10-19 08:45 CDT ruling) | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). The bypass cell needs network `on` and repository configuration `enabled` (owner decision 26, Q-37); anything narrower is `CAPABILITY_MISSING`. **With `bypass`:** only worktree file access with shell `broad` compiles, as `kimi [--model=<alias>] --prompt=<prompt> --output-format stream-json` with nothing added; read-only files or a narrower shell are `CAPABILITY_MISSING` because Never Ask cannot be narrowed. **Without `bypass`:** `Ineligible: PROFILE_UNSUPPORTED`, detail starting `mode approval: Kimi has no permission requests` — Kimi Code 2.1.1 raises no ACP `session/request_permission` in `default` mode (observed 2026-10-19, post-#748 rerun — see ROADMAP T4.68), so per ADR-0049 item 3 the restricted ACP cell no longer compiles; the ACP compile and the `requirePermissionRequest` runtime check stay in code for the Deferred [ROADMAP §8](../ROADMAP.md#8-deferred-and-excluded-work) row "Kimi ACP permission gating (ADR-0049 item 3)" but no run reaches them (test: `src/adapters/kimi/bypass-only-gate.test.ts`). A bypass approval on any other profile, or a `bypass` scope without an approval, is `PROFILE_UNSUPPORTED`. |

**Bypass-class flags (ADR-0049).** The registry entry (`src/adapters/providers.ts`) declares `--auto` and `--plan`
(with the shared `--yolo`) and the short `-y` as bypass flags, and the ACP modes `auto` and `yolo` (as a mode id or the
`mode` config option) as bypass modes, so the argv and ACP plan audits refuse them outside an approved bypass run. The
adapter never emits them even inside one, and never emits `--continue`, `--agent`, `--agent-file`, `--skills-dir` or
`--add-dir`. `-p`/`--prompt` are declared as provider-scoped bypass flags (`providerScopedBypassFlags` in
`src/adapters/providers.ts`, ADR-0049 item 1, Q-95, ROADMAP T4.62): the argv audit refuses them outside the approved
bypass cell only in Kimi argv (argv of an adapter id the table does not know is checked against every scoped list,
fail closed), so Claude Code's `-p` and Antigravity's `--prompt` stay accepted in their own runs.

Resume (FR-SES-03) runs the stored native id through the same matrix, with the same refusals: `--session <id>` after
the bypass cell's flags (nothing else added); a restricted resume is refused by the bypass-only gate like a first run
(no ACP `session/resume` compiles while permission gating is Deferred). A binding of another
provider, or an id that is not one safe argument (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`), is refused. Whether the
resumed run keeps its model, and resume from another directory, are unverified (were `Unverified: T4.68`; the carrier
row closed Partial-by-ruling 2026-10-19 without recording them — see ROADMAP T4.68; `resumeCwd` is still
`unverified` in `src/adapters/providers.ts`).

### Parser evidence and gaps

The `stream-json` parser (T4.63, [#436](https://github.com/zemdregon/switchboard/pull/436)) reads the records of the
scrubbed 2.1.1 success capture (`src/adapters/kimi/fixtures/captured_success.jsonl`, from the T4.61 validation run): `meta`
`system.version` is ignored, `assistant` text is a message, `tool` output is never an event, and `meta`
`session.resume_hint` binds `session_id` and ends the turn. Success also needs exit 0, so exit 0 without the hint ends
`OUTPUT_PROTOCOL_ERROR` and a non-zero exit `TOOL_FAILURE`. A 5-hour usage-limit stop has since been captured
as a stderr tail (T6.11 limit captures `kimi-20261015T103850Z.txt`: exit 1, `provider.auth_error: 403 … 5-hour usage
limit`) and maps to `QUOTA_EXHAUSTED` in `classifyFailure` from the stderr tail (PR #700, T6.15, ADR-0058); the
`stream-json` shape of a usage-limit stop is still unrecorded, so the stream-parser path still ends `TOOL_FAILURE`.
A second hint, a changed or unsafe session id, an
`assistant` or `tool` record after the hint, and a tool call whose name or arguments cannot be read all end
`OUTPUT_PROTOCOL_ERROR`. ACP messages use the shared mapping, with `-32000` as `AUTH_REQUIRED`. The `tool_calls`
item and `tool` record fields are **Observed** since the T4.68 follow-up-2 `live-run.sh` capture (CLI 2.1.1;
`src/adapters/kimi/fixtures/captured_tool_call.jsonl` and `captured_tool_error.jsonl`, replayed by
`src/adapters/kimi/live-capture.test.ts`); the error record and its `Authentication required` text in `-p` and
the usage and model fields stay **Assumptions** (were carried by T4.68 under owner decision 65 (a) — T4.63 is `Done`
against its Done-when; the carrier row closed Partial-by-ruling 2026-10-19 without recording them — see ROADMAP
T4.68); the failed-turn exit code is observed (unknown `--session` id exits 1, `K-F1` HELD w1408 and w1601 — see
ROADMAP T4.68); the `--prompt=` one-word form held in every live run to date (validate smoke and live legs through
compiled `--prompt=<prompt>` argv — see ROADMAP T4.68);
no model is recorded
from a Kimi run (`reportedModelFlag` `not_accepted`). Tests: `src/adapters/kimi/parser-residual.test.ts` and the
"kimi compile matrix (T4.62)", "kimi probe", "kimi registry entry and manifest gate (T4.62)" and "kimi auth preflight
(T4.64, ...)" suites in `src/adapters/kimi/kimi.test.ts` ([#429](https://github.com/zemdregon/switchboard/pull/429),
[#444](https://github.com/zemdregon/switchboard/pull/444)).

The conformance suite (T4.65, [#455](https://github.com/zemdregon/switchboard/pull/455); "kimi conformance suite
(synthetic recorded fixtures, FR-ADP-11, T4.65)") replays the synthetic fixtures in `src/adapters/kimi/fixtures/`
(`kimiConformanceCases` in `cases.ts`) through the replay dialect `src/adapters/fixtures/replay-dialects/kimi.mjs`,
which accepts only the approved bypass argv and exits 64 for any other word, a bypass-class or never-emitted flag, or
`KIMI_CODE_HOME` in the environment. Only the bypass cell is a conformance case; the `kimi acp` permission round trip
was carried by T4.68 (observed: 2.1.1 raises none in `default` mode; permission gating Deferred — see ROADMAP T4.68).

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`** (`remainingControls` `FR-GIT-03`, `FR-GIT-06`):
Kimi Code CLI 2.1.1 has no per-run permission-rule flag, and deny rules live only in the user's `config.toml`, which
Switchboard never edits and whose matching was not observed. Shell allowlist entries that could write Git make the run
`Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01) ahead of every other check, including on an approved bypass scope.
`commitChannel` is **`finalize-only`**: no tool is injected and ACP `mcpServers` stays empty until tool exposure is
observed (descoped from T4.68 by owner ruling 2026-10-19, decision 74; Deferred
[ROADMAP §8](../ROADMAP.md#8-deferred-and-excluded-work) row "Kimi ACP per-run MCP exposure").
To publish work, set `finalize_commit` on the project's primary context
([How commits reach Git](mcp-server.md#how-commits-reach-git)). In an approved bypass run, Git-write denial rests on the
ADR-0039
tool-call guard, FR-GIT-03 and FR-GIT-06. Tests: `src/adapters/kimi/git-declaration.test.ts` ("kimi Git declaration
(T4.67, FR-GIT-01, FR-GIT-02, FR-GIT-09)", [#464](https://github.com/zemdregon/switchboard/pull/464)), including one
controller commit at FINALIZING for a replayed write run in a finalize-only project.

CI's malicious-fixture leg (T4.66, [#459](https://github.com/zemdregon/switchboard/pull/459);
`test/malicious/adapters/kimi.case.ts`, "adapter malicious leg: kimi" and "adapter malicious leg: kimi partial and
unguarded streams" in `test/malicious/adapter-leg.test.ts`) replays the approved bypass cell only: 204 synthetic
streams that chain a Git write with a credential read, an outside write or a network call end `PERMISSION_BLOCKED` at
exits 0, 1, 2 and 137, four `unknown_events` streams end `OUTPUT_PROTOCOL_ERROR` or `TOOL_FAILURE`, and 36 partial
streams end `OUTPUT_PROTOCOL_ERROR`. Because `kimi --prompt` never asks and prints no denial record, a credential read,
outside write or network call **without** a Git write ends `ok` at exit 0 by design (owner decision 25: in a bypass run
the guard enforces Git writes only), pinned as `kimiUnguardedStreams`. The live malicious leg ran on 2026-10-19
(w1408; post-#748 w1601 rerun: `K-M1` NOT_CHECKED, `K-M2`/`K-M3` HELD — see ROADMAP T4.68).

T4.62 is `Done` (2026-10-16); T4.63, T4.64 and T4.66 are `Done` against their Done-when (owner decision 65 (a),
(d) and (b); synthetic fixtures plus scrubbed captures, with two live validate auth `OK` runs on CLI 2.1.1); T4.65
and T4.67 are `Done` against their Done-when (2026-10-15); T4.69 is `Done except
the post-T4.68 update` (owner decision 65 (c)). The validate cell is closed: `switchboard adapters validate kimi`
passed on CLI 2.1.1 on 2026-10-18 (ROADMAP T4.68: manifest, probe, auth `OK`, static conformance and one
structured-output smoke call). The full live smoke and the live malicious leg ran on 2026-10-19 (w1408; post-#748
w1601 rerun) and T4.68 closed Partial-by-ruling with permission gating Deferred (other cells unrecorded at closure —
see ROADMAP T4.68).

## Muse Code CLI (milestone 4)

Muse Code is a `Should` provider (FR-ADP-12). Config id `muse-code`; routing and `list_capabilities` id `muse`
(`src/adapters/providers.ts`). Every native spelling the adapter uses is in `src/adapters/muse/protocol.ts`, cited to a
source tag of [TDD §4.8](../design/TDD.md#48-muse-code-m4) with the status that section gives it (confirmed,
corrected, reported by a third party, or **Assumption**). **No `muse` binary has been installed or run for any of this
work, and nothing here is validated against a live CLI.** Using Muse Code needs Meta access (open question Q-27),
which has not been verified.

Switchboard would run the **`muse`** binary once per run as
`muse exec --json -w off --approval-mode on-request --sandbox-network restricted|unrestricted --trust-workspace <prompt>`
(`src/adapters/muse/adapter.ts`). The prompt is the last positional argv word and is visible in the process list. The
child environment is empty with an allowlist of `PATH` and `HOME` (`MUSE_ENV_ALLOWLIST`): `META_API_KEY`, which would
hide a browser login (TDD §4.8 "Auth preflight"), never reaches the child, and `MUSE_NO_AUTO_UPDATE` is not set
because only a third party reports it. The adapter never reads a Muse credential, trust or settings file and never
writes provider configuration ("the module source has no filesystem writes (inspection)" and "by inspection, the
adapter reads no file of the Muse home and no credential name (FR-AUTH-02)" in `src/adapters/muse/muse.test.ts`).

**Not runnable as shipped.** The compliance manifest (`src/adapters/manifests/muse.json`) has the range `<0.0.0`, so it
admits no version: with a `muse` on `PATH`, `doctor` and `list_capabilities` report `ADAPTER_VERSION_UNVERIFIED` ("doctor
lists muse with its version gate failing ADAPTER_VERSION_UNVERIFIED", "list_capabilities reports muse as
ADAPTER_VERSION_UNVERIFIED with no supported profile"), until an operator runs `switchboard adapters validate muse-code`
(ROADMAP T4.78). Without a `muse` on `PATH`, which is the case on any host that has not installed it, the probe's
`binary` step fails and routing excludes the provider as `BINARY_MISSING` (`src/routing/eligibility.ts`). The provider
is not disabled in configuration by default (a provider not listed under `providers` is enabled,
`src/config/load.ts`); set `providers.muse-code.enabled` to `false` to exclude it as `PROVIDER_DISABLED`.

### Login

| Provider | Login step the adapter reports | Status of that step |
| --- | --- | --- |
| Muse Code | `muse login` (the adapter returns `AUTH_REQUIRED` naming it; Switchboard never runs it) | Meta documents `muse auth set`, `muse logout` and sign-in on first run or with `/login`; `muse login` appears in Meta's changelog and a third-party report; no auth status command is documented ([TDD §4.8](../design/TDD.md#48-muse-code-m4) "Auth preflight"). Requires Meta access (Q-27), which is **not verified**; no Muse login has been checked |

The auth preflight (T4.74) runs `muse auth status` with a 10-second timeout and nothing but `PATH` and `HOME`. That
command is an **Assumption** (no status command is documented), as are its replies: at exit 0, a first stdout line
starting `Logged in` is `OK` and one starting `Not logged in` is `AUTH_REQUIRED` naming `muse login`. Any other first
line, a non-zero or null exit, a timeout, empty output or a spawn failure is `UNKNOWN` (fail closed), and the reason
carries at most the first 80 printable characters of that line. Without a binary on `PATH` it is `UNKNOWN` and nothing
runs. Tests: "muse auth preflight (T4.74, ...)" in `src/adapters/muse/muse.test.ts` ("runs only `auth status` with a
short timeout and passes no META_API_KEY", "a logged-out first line at exit 0 is AUTH_REQUIRED naming the native login",
"any other output, exit code, timeout or spawn failure is UNKNOWN and never leaks past the first line or carries an
account value", "is UNKNOWN when the binary is not on PATH, without running anything"). The `doctor` probe runs
`muse --version` and `muse exec --help`, which must list `--json`, `--approval-mode` and `--sandbox-network` ("muse
probe on synthetic output (T4.72, FR-ADP-02)").

### Trust profiles

The compile matrix (T4.72, Delegated, fail closed) follows Grok Build: only an approved `privileged` bypass scope
compiles. Each `Ineligible` reason below is the adapter's text, verbatim (`#build` in `src/adapters/muse/adapter.ts`
and `NON_PRIVILEGED_UNSUPPORTED_DETAIL` in `src/adapters/muse/protocol.ts`); routing reports `PROFILE_UNSUPPORTED` and
`CAPABILITY_MISSING` as `ELIGIBILITY_NONE`.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED`: "inspect-untrusted: Muse Code has no T4.71 results yet: whether --approval-mode holds with no TTY, what --sandbox-network restricted blocks and whether home-directory skills can be suppressed are Unverified (TDD §4.8), so no control a non-privileged profile needs is shown to hold (FR-POL-02)" |
| `edit-untrusted` | no | As `inspect-untrusted`, with the profile name `edit-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted`, with the profile name `test-sandboxed` |
| `trusted-development` | no | As `inspect-untrusted`, with the profile name `trusted-development` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once for a client whose `privileged_approval` is `not_required`). Only a scope that sets `bypass`, on an approved run, with worktree files, shell `broad`, network `off` or `on`, repository configuration `enabled`, no requested model and an objective that is not empty and does not start with `-` compiles, as `muse exec --json -w off --approval-mode on-request --sandbox-network <restricted for network off, unrestricted for on> --trust-workspace <prompt>`. Approvals and the sandbox stay on; nothing bypass-class but `--trust-workspace` is emitted. Every other scope is refused, as below |

Refusals, in the order the adapter checks them (the first unmet check is the reason):

| Request | Reason code | Detail (verbatim) |
| --- | --- | --- |
| Shell allowlist entry that could write Git (any profile, checked first) | `PROFILE_UNSUPPORTED` | "shell allowlist entries could write Git (FR-GIT-01): " followed by the entries |
| A bypass approval on a profile other than `privileged` | `PROFILE_UNSUPPORTED` | "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope (FR-POL-03, ADR-0017)" |
| `privileged` with no scope binding | `PROFILE_UNSUPPORTED` | "privileged without an approved scope binding (LLD §3.1)" |
| `privileged` without `bypass` | `PROFILE_UNSUPPORTED` | "privileged without bypass: no non-bypass Muse Code cell is shown to hold until T4.71 (TDD §4.8), and the shared argv audit refuses -w (a declared Cursor short flag, ADR-0037) outside an approved bypass run, so \`-w off\` could not spawn" |
| `bypass` set but the run's bypass approval missing | `PROFILE_UNSUPPORTED` | "privileged scope sets bypass but the run's bypassApproved is false: the Muse Code bypass cell is compiled only for an approved bypass run (FR-POL-03, ADR-0017)" |
| Shell other than `broad` | `CAPABILITY_MISSING` | "privileged shell=\<mode\>: Muse Code documents no per-run allow rule, and whether --approval-mode untrusted stops or denies with no TTY is Unverified: T4.71" |
| Read-only files, or a workspace that is not writable | `CAPABILITY_MISSING` | "privileged read-only files: no read-only file mode is documented" |
| Network `allowlist` | `CAPABILITY_MISSING` | "privileged network=allowlist: what --sandbox-network proxy-only admits is not documented (R-36)" |
| Repository configuration `disabled` or `approved` | `CAPABILITY_MISSING` | "privileged repository_config=\<mode\>: an untrusted headless run stops naming --trust-workspace ([M-log]), user-level rules and home-directory skills load regardless ([M-cfg], [M-ext]) and the CLI has no per-item approval" |
| A requested model | `CAPABILITY_MISSING` | "no model flag is sourced for Muse Code and no model registry data (T4.5)" |
| An empty objective, or one starting with `-` | `CAPABILITY_MISSING` | "the prompt is one positional argument ([M-ext]) and no end-of-options marker is sourced, so an empty objective or one starting with '-' is not compiled" |
| No `muse` on `PATH` | `CAPABILITY_MISSING` | "muse not found on PATH" |

Tests: "muse compile matrix per profile (T4.72)" ("%s is Ineligible PROFILE_UNSUPPORTED until T4.71, with and without a
bypass approval", "privileged compiles only an approved bypass scope with worktree files, shell broad, network off or
on, repo enabled", "privileged without bypass, or with bypass but no approval, is Ineligible with its reason", "a
model, a read-only workspace, a git-writing allowlist, a dash-led or empty objective and a missing binary are
Ineligible") and "muse argv invariants (T4.72)" ("`-w off` is present in every compiled argv, as one adjacent pair after
`exec`", "approvals and the sandbox stay on: no bypass-class flag or widening value is ever emitted", "no bypass-class
flag outside the approved bypass case: the audit refuses the compiled argv in every other context").

**Bypass-class declarations.** The registry entry declares `--disable-approval`, `--disable-sandbox` and
`--trust-workspace` (with the shared `--yolo`) as bypass flags, and `--approval-mode never`,
`--sandbox-network unrestricted` and `--sandbox-network enabled` as bypass values, so the argv audit refuses them
outside an approved bypass run ("declares the TDD §4.8 bypass-class flags and values, refused outside the approved
bypass case"). Because the shared audit also refuses `-w` (Cursor's declared short flag) outside that run, no Muse
argv could spawn anywhere else.

**Resume (FR-SES-03).** `resumeArgs` adds `--session-id <uuid>` before the prompt and compiles through the same matrix,
with the same refusals; a binding of another provider or an id that is not a uuid is refused, and
`--allow-workspace-switch` is never emitted (`resumeCwd` `bound`). Tests: "muse resume args (T4.73, FR-SES-03)".

### Parser rules

The `--json` parser (T4.73, `parseEvent` and `extractResult` in `src/adapters/muse/adapter.ts`) reads one record per
line, keyed on a string `kind`:

- `run_started` binds the session id from its `session_id` field, which must be a uuid; `run_output_delta` `text`
  becomes assistant text, joined as the summary; `task_lifecycle`, `model_configured` and `turn_input_user` are
  dropped. A `tool_result`, `command_accepted` or `command_result` record that carries a tool name, a command line or
  a path becomes a `tool_call` event for the ADR-0039 guard (T4.76; field spellings an Assumption until T4.71); a tool
  record with no readable field is dropped.
- **Success only for `terminal: "completed"`.** A run succeeds only with a `run_terminal` record whose `terminal` is
  `completed`, at an expected exit code (`0`), with no provider error. Exit code 0 alone never succeeds, and exit 0
  with any other `terminal` value ends `FAILED`.
- **Unknown records are never success.** Any other `kind`, a record with no string `kind`, or a known kind missing its
  field is an `unknown` event: counted, clipped, and never a result or a session, so a stream of unknown records at
  exit 0 fails.
- Fail closed (Delegated): any record after the first `run_terminal`, a session id that is not a uuid and a session id
  that changes mid-run end `OUTPUT_PROTOCOL_ERROR`. No native error, rate-limit, permission or sandbox record is
  sourced, so a failed terminal or an unexpected exit is `TOOL_FAILURE`, never a narrower code. No usage is recorded.

Tests: "muse parser and result (T4.73; ...)" in `src/adapters/muse/muse.test.ts`, among them "terminal success: deltas
joined, session id from run_started only, the other SDK kinds dropped", "exit code 0 with a failed terminal record ends
FAILED, never success", "unknown kinds fail closed: counted and clipped, never a result or a session, so an
unknown-only exit 0 fails", "stream anomaly %s is OUTPUT_PROTOCOL_ERROR, never success" and "a session id is taken from
structured output only, never from assistant or terminal text", over the synthetic fixtures in
`src/adapters/muse/fixtures/`. Tool records: "muse tool records and the ADR-0039 guard (T4.76; ...)" in the same file,
among them "fixture git_write_guard: a command record with a Git write under a completed terminal at exit 0 ends
PERMISSION_BLOCKED", "the shell-command form is read from a %s record", "a command line is read from %s and guarded
as a shell call" and "the guard verdict wins at every exit code, after a failed terminal, after the terminal record
and with a changed session id".

The conformance suite (T4.75; "muse conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.75)") replays those
synthetic fixtures (`museConformanceCases` in `fixtures/cases.ts`) through the replay dialect
`src/adapters/fixtures/replay-dialects/muse.mjs`, which refuses any argv the adapter would not emit ("the replay
refuses an argv Muse Code would not be given (%s), so a wrong compile cannot pass", 13 edits, each ending exit 64 or
65). "covers every FR-ADP-11 kind and passes the full suite" runs in CI with no `muse` installed. A missing login is
`AUTH_REQUIRED` naming `muse login` at the preflight only; a logged-out run is `TOOL_FAILURE`, because no logged-out
`muse exec --json` record is sourced.

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`** (`remainingControls` `FR-GIT-03`, `FR-GIT-06`): no
per-command Git deny control is documented, and the read-only `.git` inside Muse's writable workspace is a sandbox
property, unverified for a worktree whose `.git` is a file (`MUSE_GIT_WRITE_CONTROL`, `GIT_WRITE_CONTROL_DETAIL`).
Shell allowlist entries that could write Git make the run `Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01) before any
other check, including on an approved bypass scope. `commitChannel` is **`finalize-only`**: no tool is injected,
because the `-c` form for an MCP server block is unverified (`MUSE_GIT_CAPABILITIES`). To publish work, set
`finalize_commit` on the project's primary context ([How commits reach Git](mcp-server.md#how-commits-reach-git)).
Tests: "muse Git
declaration (T4.77, FR-GIT-01, FR-GIT-02, FR-GIT-09)" in `src/adapters/muse/muse.test.ts`, including "a replayed
write run in a finalize-only project gets the controller commit at FINALIZING". What a commit attempt does in a real
run is unverified.

### Open gaps

- **Record spellings are Assumptions until the operator capture (T4.71).** Only the `kind` field and the
  `run_terminal` shape are reported, by a third party; the other record kinds, the `session_id` and `text` fields and
  the `muse auth status` command and replies are Assumption spellings (T4.73 is `Done` against its Done-when under
  owner decision 65 (a); the spellings stay Assumption until the T4.71 capture, carried by T4.78).
- **The malicious-fixture leg (T4.76) rests on Switchboard's tool-call guard alone.** The parser reads a `tool_result`,
  `command_accepted` or `command_result` record into a `tool_call` event for the ADR-0039 guard, so a synthetic Git
  write in a Muse tool record ends `PERMISSION_BLOCKED` at any exit code (`test/malicious/adapters/muse.case.ts`),
  under tool-record field names that are Assumptions until T4.71.
- **Not runnable by default.** With no `muse` installed the provider is `BINARY_MISSING`, and with one installed it is
  `ADAPTER_VERSION_UNVERIFIED` until `adapters validate` passes a version (T4.78).
- Live smoke, live malicious leg and `adapters validate` are operator work that needs Meta access (T4.71, T4.78, Q-27).

T4.72 to T4.77 and T4.79 are `Done` against their Done-when on synthetic fixtures (T4.73 under owner decision 65 (a);
T4.76 under owner decision 65 (b), on the tool-call guard as above; T4.79 under owner decision 65 (c), README updated
again after T4.78). No run through Switchboard against a real `muse` has been recorded.
