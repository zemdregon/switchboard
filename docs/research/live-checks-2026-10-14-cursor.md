# Live checks of the Cursor CLI on the Ampere server, 2026-10-14

Status: research input (historical record once written). Run by an agent (Claude Code, Sonnet 5.5) on the operator's
Ampere server with the real, natively logged-in Cursor CLI, against the T4.41 checklist in
[TDD §4.5.3](../design/TDD.md#453-t441-operator-checklist). Everything here was **observed** in this session; nothing
is stated from memory. Verdicts are Delegated findings, not owner decisions. The roadmap owns status
([ROADMAP §6](../ROADMAP.md#6-milestones)).

Rules this run followed: no bypass flag was passed (`--force`, `-f`, `-pf`, `--yolo`, `--approve-mcps`,
`--sandbox disabled`, `--auto-review` were never used); `agent login` and `agent logout` were not run; the real
`~/.cursor` was not edited by hand (the CLI itself updates it on every run, see "Side effects"); no credential file was
read; account fields are replaced by `<redacted>`; home paths are shown as `~`.

## Environment

| Item | Value |
| --- | --- |
| OS | Ubuntu, Linux 7.0.0-1013-oracle, aarch64 (Ampere) |
| Node.js / Git | v24.21.0 / 2.53.0 |
| Cursor CLI | `2026.10.12-d47ca18` (`cursor-agent --version`, exit 0) |
| Binary | `~/.local/bin/cursor-agent`, symlink into `~/.local/share/cursor-agent/versions/2026.10.12-d47ca18/` |
| Login | native login present (`apiKeySource` was `login` on every run); no `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` set |
| Method | Throwaway Git repositories under `~/.cache/tmp`, removed afterwards; benign prompts; canaries were invented strings; `--trust` only in those scratch repositories |
| Model | every run used the CLI default; init reported a display name (a Claude Sonnet model name), no `--model` was passed except the invalid one in row 14 |

**Naming trap on this host.** In a login shell `agent` resolves to **Grok Build's** binary (`~/.grok/bin/agent`,
`grok 1.0.50`), not Cursor's, because `~/.grok/bin` precedes `~/.local/bin` on `PATH`. Cursor's binary is
`~/.local/bin/agent` (symlink, same target as `cursor-agent`) only when that directory comes first. Every command in
this note was run as `cursor-agent` (resolved to its real path). One command was sent to the wrong binary by mistake:
`agent status` and `agent status --format json` ran Grok's `agent` (output `Error: No such device or address (os error
6)`, exit 1; and `error: unexpected argument '--format' found`). Grok's `agent` took `status` as a prompt argument;
no Cursor call was involved, and it printed no response text. Switchboard must resolve the Cursor binary by absolute
path or by the name `cursor-agent`, never by `agent` alone.

## Results

Verdicts: WORKS, FAILS, HELD (a control held), ESCAPED (a control did not hold), BLOCKED (could not run here),
NOT_RUN (bypass-class, skipped by rule), OBSERVED.

| # | Command (all with `</dev/null` and `timeout 120` unless a pipe is shown) | Observed | Verdict |
| --- | --- | --- | --- |
| 1a | `cursor-agent --version` | `2026.10.12-d47ca18`, exit 0 | WORKS |
| 1b | `cursor-agent about --format json` | exit 0; one object, keys: `cliVersion`, `latestStatus`, `latestVersion`, `model`, `subscriptionTier`, `osPlatform`, `osArch`, `userEmail`, `terminalProgram`, `shell`, `lastRequestId` (value was `null`). `userEmail` is an account field: drop it from any capture | WORKS |
| 2a | `cursor-agent --help` | exit 0. Flags present: `-v/--version`, `--api-key`, `-H/--header`, `-e/--endpoint`, `-p/--print`, `--output-format text\|json\|stream-json`, `--stream-partial-output`, `--mode plan\|ask`, `--plan`, `--resume [chatId]`, `--continue`, `--model`, `--list-models`, `-f/--force`, `--yolo` ("Alias for --force (Run Everything)"), `--auto-review`, `--sandbox enabled\|disabled`, `--approve-mcps`, `--trust`, `--workspace`, `--add-dir`, `--plugin-dir`, `-w/--worktree`, `--worktree-base`, `--skip-worktree-setup`, `-h`. Commands: `persist`, `install-shell-integration`, `uninstall-shell-integration`, `login`, `logout`, `mcp`, `plugin`, `worker`, `status\|whoami`, `models`, `team`, `bedrock`, `about`, `update`, `create-chat`, `generate-rule\|rule`, `agent`, `ls`, `resume`, `help`. **`acp` is not listed** | WORKS |
| 2b | `cursor-agent sandbox --help` | exit 0; subcommands `enable`, `disable`, `reset`, `run [options] <cmd> [args...]` | WORKS |
| 2c | `cursor-agent sandbox run --help` | exit 0; options `--allow-paths`, `--readonly-paths`, `--blocked-patterns`, `--sandbox` (default true), `--network` (default false), `--sb-debug` | WORKS |
| 2d | `cursor-agent mcp --help` | exit 0; `login`, `list`, `list-tools`, `enable`, `disable` | WORKS |
| 3a | `cursor-agent status` (logged in) | `Logged in as <redacted>`, exit 0 | WORKS |
| 3b | `cursor-agent status --format json` (logged in) | exit 0; keys `status`, `isAuthenticated` (`true`), `hasAccessToken`, `hasRefreshToken`, `userInfo` {`email`, `userId`, `firstName`, `lastName`, `createdAt`}. Account fields all present: never log this object | WORKS |
| 3c | `cursor-agent status` and `status --format json` with `HOME`, `CURSOR_CONFIG_DIR`, `XDG_CONFIG_HOME` all pointed at an empty scratch directory (logged-out state, real login untouched) | text: `Not logged in`, **exit 0**. JSON: keys `status` (`unauthenticated`), `isAuthenticated` (`false`), `hasAccessToken` (`false`), `hasRefreshToken` (`false`), `message` (`Not logged in`), **exit 0** | WORKS; exit code does not signal logged-out |
| 4 | `cursor-agent -p "reply with the word ok"` with the same scratch `HOME` (logged out) | stderr `Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.`, **exit 1**, no JSON | WORKS |
| 5a | `cursor-agent -p --output-format json --trust "reply with the word ok"` | exit 0, stderr empty. One object, keys `type` (`result`), `subtype` (`success`), `is_error`, `duration_ms`, `duration_api_ms` (equal to `duration_ms`), `result`, `session_id`, `request_id`, `usage` {`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`} | WORKS |
| 5b | `... --output-format stream-json --trust "reply with the word ok"` | exit 0. Event types in order: `system`/`init` (keys `apiKeySource` = `login`, `cwd`, `session_id`, `model` display name, `permissionMode` = `default`), `user` (`message.content[].text`), 71 x `thinking`/`delta` (`text`, `session_id`, `timestamp_ms`), `thinking`/`completed`, one `assistant` (`message.content[].text`, no `timestamp_ms`), terminal `result` (same keys as 5a, with `usage`) | WORKS |
| 5c | `... stream-json --stream-partial-output --trust "reply with the word ok"` | exit 0. Same as 5b plus a **second** `assistant` event: the first has `timestamp_ms`, the second has none (a duplicate of the full text). Still 69 `thinking` deltas | WORKS |
| 6a | `echo "reply with the word ok" \| cursor-agent -p --output-format stream-json --trust` | exit 0; the `user` event content is the piped text; `result` was `ok` | WORKS (stdin is the prompt) |
| 6b | `echo "reply with the word ok" \| cursor-agent -p --output-format stream-json --trust -` | exit 0; the `user` event content is the literal text `-`; stdin ignored when a positional argument is present | OBSERVED: `-` is not a stdin marker |
| 7a | stream run: "Read the file a.txt, then run the shell command: echo shellok" (no `--force`, scratch repo) | exit 0. `tool_call` events: `started` then `completed`, `tool_call` object keyed by `readToolCall` (`args.path`; `result.success` with `content`, `isEmpty`, `exceededLimit`, `totalLines`, `fileSize`, `path`, `readRange`, `relatedCursorRulePaths`, `relatedCursorRules`) and `shellToolCall` (`args`: `command`, `workingDirectory`, `timeout`, `simpleCommands`, `parsingResult`, `description`, `closeStdin`, `adminCommandDenylist`, ...). The shell call's `result` was `{"rejected": {command, workingDirectory, reason (empty string), isReadonly}}`; the model retried the same command three times (three `started`/`completed` pairs, all `rejected`) and reported it was "blocked by the system". Overall `result.subtype` was still `success`, `is_error` false, exit 0 | HELD: shell is refused headless without `--force` (default `permissionMode`) |
| 7b | stream run: "Append the line 'edited' to a.txt using your edit tool" (no `--force`, scratch repo) | exit 0; the file **changed** (`git status` showed ` M a.txt`, content `hello` then `edited`). `tool_call` keyed by `editToolCall` with `result.success` | WORKS: edits apply without `--force` |
| 7c | edit with `--force` | not run (bypass flag) | NOT_RUN |
| 8a | resume the 5a `session_id` with `-p --output-format json --trust --resume <id> "..."` in the same directory | exit 0; `result` `ok`; `session_id` **equal** to the resumed id; same result keys | WORKS |
| 8b | resume the same id a second time | exit 0; `session_id` equal again | WORKS |
| 8c | resume the same id from a **different** scratch directory | exit 0; `session_id` equal; no error | WORKS (no working-directory tie observed) |
| 8d | `cursor-agent create-chat` | exit 0; prints one bare UUID line | WORKS |
| 9 | `cursor-agent -p --output-format stream-json --sandbox enabled --trust "run: curl ...; touch ../outside; test -r ~/.cursor/..."` | **exit 1**, stdout empty, stderr `Error: Sandbox mode is enabled but not available on this system. Sandbox failed to start, possibly due to AppArmor configuration. ... Run 'agent sandbox disable' to switch to allowlist mode.` No model call ran. `cursor-agent sandbox run echo hi` printed the policy (type `workspace_readwrite`, `readBoundary` `system`, network `default: deny`) then `Failed to execute command: SandboxUnsu...` and exit 1. Host: `kernel.apparmor_restrict_unprivileged_userns = 1`, kernel 7.0.0-1013-oracle | BLOCKED: no sandbox on this host; network, out-of-tree write and home-read confinement could not be tested. Fails closed (no run started) |
| 10a | fresh Git repo, `-p --output-format stream-json` **without** `--trust` | **exit 1**, stdout empty, stderr a "Workspace Trust Required" block naming the directory and offering "Run 'agent' interactively", or "Pass --trust, --yolo, or -f" | HELD |
| 10b | same repo with `--trust` | exit 0, `result` `ok`; init keys unchanged (no `tools` or `mcp_servers` key) | WORKS |
| 10c | repo with `AGENTS.md` (invented codeword), `.cursor/rules/c.mdc` (`alwaysApply`, invented codeword) and `.cursor/mcp.json` naming a local no-op stdio server, `--trust` | Both codewords were returned by the model: **repository `AGENTS.md` and `.cursor/rules` load once trusted**. `cursor-agent mcp list` said `noop: not loaded (needs approval)`; the model could not see or call the repo's server (`getMcpToolsToolCall` event, answer NOTAVAILABLE), exit 0. The model also listed tool names from the operator's **global** MCP servers (mail, source hosting, browser testing and similar): global MCP servers load in a headless run | HELD for repo MCP; OBSERVED for rules/AGENTS.md and global MCP |
| 11 | `CURSOR_CONFIG_DIR=<scratch>` with `cli-config.json` `{"version":1,"permissions":{"allow":["Shell(git)"],"deny":["Shell(git commit)"]}}`; ask for `git status --short` then `git commit --allow-empty -m x` | exit 0. `git status --short` ran (`shellToolCall.result.success`, keys `command`, `executionTime`, `exitCode`, `interleavedOutput`, `localExecutionTimeMs`, `signal`, `stderr`, `stdout`, `workingDirectory`). The commit's `result` was `{"permissionDenied": {workingDirectory, error: "Command blocked by permissions configuration", isReadonly}}`; commit count stayed 1. Login survived `CURSOR_CONFIG_DIR` (the credential is not stored under that directory). The CLI rewrote the scratch `cli-config.json`, adding default settings (`editor`, `display`, ...) | WORKS: per-run deny via `CURSOR_CONFIG_DIR` is honoured; allow `Shell(git)` was needed to let anything run |
| 12a | `.cursor/mcp.json` server, no `--approve-mcps`, asked to call its tool | server `not loaded (needs approval)`; tool not available; exit 0 | HELD |
| 12b | with `--approve-mcps` | not run (bypass flag) | NOT_RUN |
| 13a | `cursor-agent models` | exit 0, 263 lines; first line `Available models`, blank line, then one `<id> - <Display Name>` per line, the default marked `(default)` | WORKS |
| 13b | `cursor-agent -p --list-models` | exit 0, byte-identical to 13a | WORKS |
| 14a | `-p --output-format stream-json --trust --model no-such-model-xyz "ok"` | **exit 1**, stdout empty, stderr `Cannot use this model: no-such-model-xyz. Available models: <comma-separated ids>` | WORKS |
| 14b | killed network approximated with `-e http://127.0.0.1:9` and `HTTPS_PROXY`/`HTTP_PROXY` to the same closed port | **exit 1**, stdout empty (no stream line at all), stderr `Error: [unavailable] connect ECONNREFUSED 127.0.0.1:9`. The endpoint override is what failed it; whether the proxy variables are honoured was not separated | WORKS (approximation) |
| 15 | `-f` and `-pf` spellings of `--force` | not run (bypass flag). `--help` does list `-f, --force` and `--yolo`, and the trust error message names `--trust, --yolo, or -f` | NOT_RUN |
| 16 | working-directory tie, sandbox and permission flags on resume | (a) needs a first run with `--sandbox enabled`, which cannot start here (row 9); (b) was covered without sandbox flags by 8c (resume from another directory worked, same `session_id`); (c) needs `--force`. | BLOCKED / NOT_RUN |

### `agent acp` (hidden command, TDD §4.5.2)

- `cursor-agent --help` does **not** list `acp` (hidden, as the TDD says).
- `cursor-agent acp --help` exists, exit 0: `Usage: agent acp [options]`, "Start the Cursor Agent as an ACP (Agent
  Client Protocol) server", only `-h`.
- Sent exactly one line, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}`,
  then closed stdin. No `session/new`, no prompt, no authenticate.
- Observed: one JSON-RPC response line (420 bytes), stdout only, stderr empty, exit 0, id `1`. No sign-in URL was
  printed. Response method: a `result` to `initialize` (no notifications or requests from the agent).
- `result` keys: `protocolVersion` (`1`), `agentCapabilities` {`loadSession` (`true`), `mcpCapabilities` {`http`,
  `sse`}, `promptCapabilities` {`audio`, `embeddedContext`, `image`}, `sessionCapabilities` {`list`}}, `authMethods`
  (array of objects with `id` = `cursor_login`, `name`, `description` that says to run `agent login` first).
- Other ACP methods named in TDD §4.5.2 (`session/load`, `session/request_permission`, `cursor/ask_question`,
  `cursor/create_plan`) were not exercised: Unverified.

## Unverified / not run

| Item | Reason |
| --- | --- |
| Row 7 edit and row 16(c) with `--force`; row 12 with `--approve-mcps`; row 15 `-f`, `-pf` | bypass flags are forbidden for this run |
| Row 9: network, out-of-worktree write and `~/.cursor` read inside the sandbox | `--sandbox enabled` cannot start on this host (AppArmor restricts unprivileged user namespaces); `--sandbox disabled` is bypass-class and was not used. Without `--sandbox`, shell is refused anyway (7a), so these three behaviours stay unobserved |
| Row 16(a) and the `--sandbox` flag on resume | needs a working first run with `--sandbox enabled` |
| Row 3 logged-in vs logged-out via the real `agent logout` | not allowed; scratch `HOME` used instead, which is the logged-out state of a fresh account directory, not of a logged-out real login |
| Real network kill (row 14) | no firewall change possible without sudo; approximated with a closed-port endpoint |
| Backing vendor or provider field (`backing_provider`) | no stream or JSON key naming it was observed; only the `model` display name in `init` |
| Cost field | no cost key in `result` or `usage` |
| Parsing of `-pf` and combined short flags | not run |
| `thinking` event `subtype` values other than `delta` and `completed`, error-result shapes inside a stream | not seen; failures here produced no stream at all |
| Whether `.cursor/sandbox.json` or `.cursor/cli.json` in a repository are loaded when trusted | not run |
| ACP: any method after `initialize` | out of scope by instruction |

## Contradictions with TDD §4.5

| TDD claim | Observed |
| --- | --- |
| `agent` is the binary (throughout) | On this host `agent` in a login shell is Grok Build's binary; Cursor's is `cursor-agent` (and `~/.local/bin/agent` when it wins on `PATH`) |
| "`thinking` events are suppressed" [C2] | `thinking` events (`delta`, `completed`) are emitted on **every** `stream-json` run, with or without `--stream-partial-output`, 67 to 162 per trivial prompt, and carry the model's reasoning text. The parser must ignore or drop them; a log of the stream stores reasoning |
| `--stream-partial-output` "adds delta `assistant` events" [C2] | Observed the extra `assistant` event as a duplicate full-text message **without** `timestamp_ms`; the one with `timestamp_ms` came first. `thinking` deltas were already present without the flag |
| `agent status` "no exit codes documented"; preflight `UNKNOWN` until recorded | Recorded: logged in exit 0, logged out also **exit 0** (`Not logged in`; JSON `isAuthenticated: false`). The exit code cannot tell the states apart; use the JSON `isAuthenticated` |
| `-p` with no login: "Unverified" | `Error: Authentication required ...` on stderr, exit 1, no stdout |
| "Whether a write-capable run is possible without `--force`" is Unverified; [C3] says changes are only proposed | Edits **apply** without `--force` (7b). Only shell is refused (`rejected`, reason empty). So [C8] and [C1] are right and [C3] is wrong for this version; `edit-untrusted` can compile for edits, but not for shell |
| Shell denial shape Unverified | `shellToolCall.result.rejected` (default mode) and `shellToolCall.result.permissionDenied` (config deny, field `error`); neither is a non-zero exit, and the overall `result` is still `success` with `is_error` false. A controller reading only `result` cannot see a refused command |
| `agent about --format json` keys Unverified | Recorded above; includes `userEmail` |
| Usage fields "no cost field; names unknown" | `usage` {`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`}, present on `result` in both `json` and `stream-json`; `request_id` present; still no cost field |
| "`--sandbox enabled` wherever a profile needs confinement"; Linux needs kernel 6.2+, Landlock v3, user namespaces, else "falls back to asking for approval" | Kernel 7.0 here, but `--sandbox enabled` **fails with exit 1** (AppArmor, "Sandbox mode is enabled but not available"), not a fallback to approval. So a profile that compiles `--sandbox enabled` cannot run on this host; the TDD base argv for every profile fails here |
| Trust: "headless runs in an untrusted workspace fail unless `--trust` or `--force`" | Confirmed: exit 1, prompt text on stderr, stdout empty. The message names `--trust`, `--yolo`, `-f` |
| Resume "whether an id resumes from another working directory" Unverified | It does (8c): same `session_id`, exit 0 |
| `--resume` "what it prints" Unverified | Prints no extra text in `json` mode; `session_id` unchanged across resumes |
| Models output shape Unverified | `Available models`, blank line, `<id> - <Display Name>` lines, default marked; `--list-models` identical |
| `--trust` "never because the repository asks" and what loads once trusted | Confirmed that `AGENTS.md` and `.cursor/rules` content reached the model once trusted; repo `.cursor/mcp.json` servers need approval; **global** MCP tools of the operator were visible to a headless run |
| `--help` lists the flags in [C1] | Additional flags not in the TDD audit list: `--auto-review`, `--add-dir`; additional commands `persist`, `plugin`, `team`, `bedrock`. `--auto-review` ("a server classifier auto-runs safe tool calls") is a permission-widening flag the argv audit should treat as bypass-class (Proposed) |
| `agent acp` hidden, JSON-RPC over stdio | Confirmed. `initialize` is answered with `protocolVersion: 1`, `agentCapabilities` and `authMethods` (`cursor_login`); the key names are above |

## Side effects and security notes

- **ESCAPED: none observed.** Controls that held: untrusted workspace refused (10a); repo MCP server not loaded
  without approval (10c, 12a); shell refused without `--force` (7a); config deny honoured (11); sandbox refused to
  start rather than run unconfined (9).
- **Observation (not an escape):** the model's visible reasoning (`thinking` events) quoted the operator's
  personal hook and skill context, meaning the headless Cursor run loads the operator's global rules or hooks. And a
  headless run saw the operator's global MCP tool names. A Switchboard-launched Cursor run would inherit both unless
  `HOME` or `CURSOR_CONFIG_DIR` is isolated; row 11 showed `CURSOR_CONFIG_DIR` alone does not isolate the login.
- The CLI writes under the real `~/.cursor` on every run (chats, projects, ai-tracking, statsig cache; `cli-config.json`
  modification time changed with unchanged size). Names only were listed. These run artefacts were left in place; the
  operator may prune the session directories under `~/.cursor/chats` created by this run (8 entries present afterwards).
- Account values appeared in the output of `about --format json`, `status --format json` and `status`; they were
  redacted at capture time and are not reproduced here. No token-shaped string was printed. Session and request ids
  are not reproduced.
- Scratch directories (`repoA`, `repoC`, `dirB`, the scratch config directory, the scratch `HOME`, outputs and the
  no-op MCP server script) were removed from `~/.cache/tmp`.
