# Live checks: Grok Build on the Ampere operator host, 2026-10-14

Status: research input (historical record once written). Run by an agent (Claude Code, Sonnet 5.5) against the
operator's own, logged-in Grok Build CLI, following the
[TDD §4.3.2 T4.21 checklist](../design/TDD.md#432-t421-operator-checklist-grok-build) with the restrictions below.
Everything here was **observed** in this session; anything not run is listed under "Unverified / not run". The roadmap
owns status. Verdicts are Delegated findings, not owner decisions.

## Environment

| Item | Value |
| --- | --- |
| OS | Ubuntu 26.04.1 LTS, Linux 7.0.0-1013-oracle, aarch64 (Ampere) |
| Node.js / Git | v24.21.0 / 2.53.0 |
| Grok Build | `grok 1.0.50 (c58f321264ba) [stable]` (`grok version` and `grok --version` print the same line, exit 0) |
| Login | Logged in with grok.com (native login, from `grok models`); default model `grok-4.7` |
| Method | Throwaway repos under a scratch directory only; every provider call under `timeout 120` with stdin from `/dev/null`; scratch directories removed afterwards |

Restrictions applied (operator hard rules): no `--always-approve`/`--yolo`/`--force`/`--trust`, no login, logout or
config change of the real Grok home, no credential file read. Consequences: the `--always-approve` part of step 9 and the
`--trust` part of step 10 were not run. No credential file was opened; the only access to the login directory was a
directory listing and one `test -r` (step 11).

One method note that matters for results: a scratch directory under `$TMPDIR` is inside the sandbox's temp allowance.
The first step 7 run (scratch parent inside `$TMPDIR`) therefore saw the "outside" write succeed under `--sandbox strict`.
All sandbox results below come from runs with `TMPDIR` unset for the Grok process (so temp is `/tmp`) and the scratch
repository elsewhere.

## Results

Verdicts: HELD (a control held), ESCAPED (a control did not hold), WORKS, FAILS, NOT_RUN, NOT_OBSERVED.

| Step | Command run (abridged) | Observed result | Verdict |
| --- | --- | --- | --- |
| 1 | `grok version`; `grok --version`; `grok --help`; `grok -p --help`; `grok agent --help`; `grok agent stdio --help` | Exit 0 for all except `-p --help`. `-p --help` exits **2** with `error: a value is required for '--single <PROMPT>' but none was supplied` (`-p` is the short form of `--single` and needs a value). `grok --help` lists `--allow`, `--deny`, `--always-approve`, `--sandbox <PROFILE>` (env `GROK_SANDBOX`), `--permission-mode` (possible values `default, acceptEdits, auto, dontAsk, bypassPermissions, plan`), `--json-schema`, `--tools`, `--disallowed-tools`, `--disable-web-search`, `-r/--resume`, `-s/--session-id`, `-c/--continue`, `--output-format` (`plain`, `json`, `streaming-json`, `streaming-messages-json`), `--max-turns`, `-w/--worktree`, `--fork-session`. **Not listed** in top-level help: `--trust`, `--no-auto-update`, any MCP-definition flag. `grok agent stdio --help` lists only `--debug`, `--debug-file`, `--leader-socket`: no permission or sandbox flags. `grok agent --help` lists `--always-approve`, `-m`, `--plugin-dir`, `--agent-profile`, subcommands `stdio`, `headless`, `serve`, `leader` | WORKS |
| 2a | `grok inspect --json` | Exit 0, one JSON object, ~120 KB. Top-level keys: `grokVersion, channel, cwd, projectRoot, projectTrusted, projectInstructions, permissions, loginPolicy, hooks, skills, agents, plugins, marketplaces, mcpServers, lspServers, configSources, externalCompat`. **No authentication status key** (`loginPolicy` holds only `disableApiKeyAuth`, `forceLoginTeamUuid`, `apiKeyAuthDisabled`) | WORKS (not an auth probe) |
| 2b | `grok models` | Exit 0. Plain text: a first line `You are logged in with grok.com.`, `Default model: grok-4.7`, then `Available models:` with a `*` marker on the default and `-` on others: `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5` | WORKS |
| 2c | `grok models --json` | Exit **2**: `unexpected argument '--json' found` | FAILS |
| 3a | `GROK_HOME=<scratch> grok inspect --json` | Exit 0 (works logged out, creates a config tree in the scratch home) | WORKS |
| 3b | `GROK_HOME=<scratch> grok models` | Exit **0** even when logged out; first line `You are not authenticated.`, default model `grok-4.6`, models `grok-4.6`, `grok-4.5` | WORKS (usable auth probe by text, not by exit code) |
| 3c | `GROK_HOME=<scratch> grok -p "hi" --output-format json` | Exit **1**. Stdout: `{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run grok login on a machine with a browser."}`. Stderr: the same text prefixed with `Error:` | WORKS |
| 4a | `grok --no-auto-update -p "Reply with the word ok" --output-format json` | Exit 0, stderr empty. `--no-auto-update` is accepted although absent from `--help`. One JSON object: `text`, `stopReason` (`end_turn`), `sessionId`, `requestId`, `usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens`), `num_turns`, `total_cost_usd`, `total_cost_usd_ticks`, `modelUsage` (per model: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `modelCalls`, `costUSD`). Reported model id: `grok-4.7-build` | WORKS |
| 4b | same, `--output-format streaming-json` | Exit 0, stderr empty, NDJSON. Line `type` values seen: `available_commands` (a `tools` array of built-in tool names, repeated), `thought` and `text` (each with `data`), `tool_call`, `tool_call_update`, `usage` (with a `signature` field), and a final `end` line carrying `stopReason`, `sessionId`, `requestId`, `usage`, `num_turns`, `total_cost_usd`, `modelUsage` | WORKS |
| 4c | same, `--output-format plain` | Exit 0, stdout is the bare text (`ok`), stderr empty | WORKS |
| 5a | invalid flag `--bogus-flag` | Exit **2**, stderr `error: unexpected argument '--bogus-flag' found` plus usage; nothing on stdout | WORKS |
| 5b | `-m no-such-model --output-format json` | Exit **1**. Stdout `{"type":"error","message":"Couldn't set model 'no-such-model': Invalid params: \"unknown model id\". Run 'grok models' to see available models."}`; stderr the same text prefixed with `Error:` | WORKS |
| 5c | SIGINT after 4 s (`timeout -s INT 4`) during a long answer | Exit code reported by `timeout` was 124 (it cannot show the child's own code); stdout and stderr empty; the process was gone afterwards. The child's own exit code and any partial output: not observed | NOT_OBSERVED |
| 5d | rate limit | Not forced; not observed | NOT_OBSERVED |
| 5e | `--permission-mode bogus` | Exit 2, `invalid value 'bogus' ... [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]` | WORKS |
| 5f | `--sandbox bogus` | Exit 1, `sandbox profile resolve failed: Custom sandbox profile 'bogus' not found. Define it in ~/.grok/sandbox.toml or .grok/sandbox.toml`, followed by an example `[profiles.<name>] extends = "workspace"` snippet | WORKS (shows custom profiles can come from a project `.grok/sandbox.toml`) |
| 6a | `-r <id>` of the 4a session, `--output-format json` | Exit 0; same `sessionId` returned; `num_turns` 1 | WORKS |
| 6b | `-s <fresh-uuid>` first use | Exit 0, `sessionId` equals the supplied uuid | WORKS |
| 6c | `-s <same-uuid>` second use | Exit **1**, stderr `Error: Error: Session ID <uuid> is already in use.`, stdout empty. So `-s` creates a new session only; the [SESS] reading (`-s` is a session id, not a resume) holds on this version | WORKS |
| 6d | `-c` in the scratch directory | Exit 0; resumed the most recent session of that directory (the `-s` one), not the 4a session | WORKS |
| 7a | `--sandbox strict --permission-mode dontAsk --allow 'Bash(*)'`, ask `touch ../outside-marker && cat /etc/hostname`, `TMPDIR` unset | Exit 0; the shell tool result was `exit: 1`, `touch: cannot touch '../outside-marker': Permission denied`; marker absent | HELD |
| 7b | same with `--sandbox read-only` | identical to 7a; marker absent | HELD |
| 7c | same with `--sandbox workspace` | identical to 7a; marker absent | HELD |
| 7d | same with `GROK_SANDBOX=strict` and no flag | identical to 7a; marker absent | HELD |
| 7e | same with **no** sandbox flag or variable | tool exit 0, marker **created** in the parent directory, hostname printed. The default is no sandbox | WORKS (documents the default) |
| 7f | `--sandbox strict` with the scratch parent inside `$TMPDIR` (first attempt) | the marker **was** created: the profile's temp allowance covers `$TMPDIR` | NOT_A_FAILURE (method note above) |
| 7g | sandbox-violation shape | No distinct event: the run exits 0 with `stopReason: end_turn`; the only signal is the shell tool's own `exit: 1` and the OS text `Permission denied` in the tool output | WORKS |
| 8a | `--permission-mode dontAsk`, no rules, ask `echo hi` | Command **ran** (`exit: 0`, `hi`), run exit 0 | ESCAPED (see below) |
| 8b | `--permission-mode dontAsk --allow 'Bash(echo *)'` | ran | WORKS |
| 8c | `--permission-mode dontAsk --deny 'Bash(echo *)' --allow 'Bash(echo *)'` | Not executed. Tool status `failed`, content "Tool run_terminal_command was not executed: Denied by permission policy: deny rule on bash matching echo *"; run exit 0, stopReason `end_turn` | HELD (deny wins) |
| 8d | `--permission-mode dontAsk`, no rules, ask `touch inrepo-marker` | Command **ran**, file created in the repo | ESCAPED (see below) |
| 8e | `--permission-mode default`, no rules, headless, `touch` | ran | WORKS |
| 8f | `dontAsk`, `--allow 'Bash(test *)'`, command a test-r compound (`test -r FILE`, then echo A or B) | Tool call cancelled: status `failed`, content "User cancelled the execution for tool run_terminal_command", stopReason `cancelled`, run exit 0. This is the only `dontAsk` denial seen without a deny rule: the compound command did not match the allow rule | WORKS (denial shape) |
| 9 | `dontAsk`, `--allow 'Bash(*)' --deny 'Bash(git commit*)' --deny 'Bash(git push*)'`; five forms, scratch repo with one commit and a local bare remote | (1) `git commit --allow-empty -m x1`: **denied** by the rule. (2) `git -C . commit --allow-empty -m x2`: **ran, commit created**. (3) `/usr/bin/git commit --allow-empty -m x3`: **ran, commit created**. (4) `sh -c 'git commit ...'`: **denied** (the rule matched inside the `sh -c` string). (5) `git push origin main`: **denied**; bare remote still at 1 commit. Final `git log`: `x3 x2 init` | ESCAPED for forms 2 and 3; HELD for 1, 4, 5 |
| 9b | the same with `--always-approve` | Not run (hard rule) | NOT_RUN |
| 10a | project hooks, `.mcp.json`, `.grok/config.toml` (MCP server and `[permission]`), headless, no `--trust`, `grok inspect --json` first | `inspect` showed `projectTrusted: false`; project hooks (`.grok/hooks/probe.json`, `.claude/settings.json`) were **not** listed under `hooks`; the `.mcp.json` and `.grok/config.toml` MCP servers **were** listed under `mcpServers`; `permissions.loaded` stayed 0. After the run: no hook marker and no MCP marker | HELD (no marker) |
| 10b | same with `GROK_CLAUDE_HOOKS_ENABLED=0 GROK_CURSOR_HOOKS_ENABLED=0 GROK_CLAUDE_MCPS_ENABLED=0 GROK_CURSOR_MCPS_ENABLED=0` | no marker | HELD (no marker; the switches were not shown to be necessary) |
| 10c | with `--trust` | Not run (hard rule: it writes global state) | NOT_RUN |
| 11a | in `strict` and in `workspace`, list names under the Grok home | Listing succeeded in both. The listing includes a file named `auth.json` and `auth.json.lock`, `sandbox.toml`, `trusted_folders.toml`, `config.toml`, `sessions` and others | ESCAPED (credential-boundary) |
| 11b | in `strict` and in `workspace`, `test -r` on the login file | Exit 0 in both: the file is **readable** from inside the sandboxed process. Contents were not read | ESCAPED (credential-boundary) |
| 12 | look for an MCP-definition flag | Top-level and `agent` help have none. `grok mcp` exposes only `list`, `add`, `remove`, `enable`, `disable`, `doctor` (config management; not run). `agent` has `--plugin-dir` ("always trusted: hooks and MCP servers activate without a prompt") | WORKS (negative) |
| 13 | ACP transcript | Not needed: steps 1 and 4 succeeded | NOT_RUN |
| 14a | session from dir A (`strict`, `dontAsk`, `--allow 'Bash(*)'`), resumed with `-r` from a second directory B | Exit 0; same `sessionId`; stderr note `Session <id> found locally (originally in <path of A>)`. Resume is **not** tied to the working directory | WORKS |
| 14b | resume in A with no sandbox or permission flags, ask `touch ../outside-marker` | tool `exit: 1`, `Permission denied`, marker absent: the sandbox profile is preserved on resume | HELD |
| 14c | resume in A with `--permission-mode dontAsk` and no `--allow`, ask `echo hi` | ran (`exit: 0`) | see 8a |

### ESCAPED findings (security)

1. **Git-write deny rules are prefix matches on the command string.** `--deny 'Bash(git commit*)'` did not stop
   `git -C . commit` or `/usr/bin/git commit` (step 9 forms 2 and 3): both created commits. `sh -c '...'` and the plain
   form were denied. Rule matching is therefore not a Git-write control by itself; only the plain and `sh -c` forms were
   shown to hold. `git -C . push` and `/usr/bin/git push` were not tried.
2. **The native login file is reachable from inside `--sandbox strict` and `--sandbox workspace`.** Its name is listed
   and `test -r` succeeds (step 11). This is the credential-boundary question [ADR-0003] raised; the answer is that
   the sandbox does not protect it.
3. **`--permission-mode dontAsk` with no allow rule did not deny** a plain `echo hi` or `touch inrepo-marker`
   (8a, 8d). A compound command (8f) was cancelled. The cause was not isolated: the operator's user-level
   `config.toml` was not read (hard rule), so a user-level allow or an automatic-allow of simple commands cannot be
   excluded. Treat `dontAsk` as "not shown to deny" until reproduced with a clean login.

## Unverified / not run

| Item | Reason |
| --- | --- |
| `--always-approve` in step 9 (deny under always-approve) | Bypass flag; hard rule |
| `--trust` in step 10, and whether trust enables project hooks, MCP, LSP and `[permission]` rules | `--trust` writes the global trusted-folders file; hard rule |
| Whether project hooks fire at all in this CLI version | No positive control possible without `--trust`; the hook JSON shape was a guess (Claude-style); `inspect` did not list the project hooks either, so inertness and a wrong shape are indistinguishable |
| Project `[permission]` rules applying without trust | `permissions.loaded` stayed 0 in `inspect`; a rule effect was not exercised |
| `git -C . push`, `/usr/bin/git push`, `git push` under `sh -c` | Not asked |
| Rate-limit shape | Cannot be forced |
| SIGINT child exit code and partial output | `timeout` replaced the child's code with 124; no interactive Ctrl+C |
| Cause of the `dontAsk` no-rule execution | User config not read; no clean authenticated home available without logging in |
| Per-run MCP definition and ACP `mcpServers` | No flag exists in headless help; ACP not run (step 13 condition not met) |
| `--tools` / `--disallowed-tools` tool names | Names seen only in the `available_commands` list (`run_terminal_command`, `read_file`, `search_replace`, `list_dir`, `grep`, ...); the flags were not exercised |
| Sandbox behaviour of `read-only` for reads outside the workspace | Only the write case was tried |
| Network blocking under `strict` | Not tested |
| Whether runs wrote entries to the real Grok home (session records, logs) | Expected (sessions are stored there); not inspected beyond file names |
| `GROK_HOME` as the home of config, auth and sessions | Assumption only; the logged-out checks behaved as if it is (not authenticated, fresh config tree created in the scratch home) |

## Contradictions with TDD §4.3

| TDD §4.3 / §4.3.1 claim | Observed |
| --- | --- |
| `--no-auto-update` is always emitted (ADR-0009), implying it is a documented flag | Accepted (exit 0, run works) but absent from `grok --help`; it is not in the flag list |
| `--trust` is a flag that Switchboard never emits ([HOOK]) | `--trust` is absent from `grok --help` in 1.0.50 (the matrix already notes it is missing from [CLI]); its existence was not exercised |
| `dontAsk` "silently deny[ies] anything without an explicit allow rule" [ENT]; `inspect-untrusted` relies on it | Plain `echo hi` and `touch` ran under `dontAsk` with no allow rule (cause not isolated, see ESCAPED 3) |
| `--deny 'Bash(git commit*)'` / `'Bash(git push*)'` as the Git-write denial (syntax "by analogy"), `Unverified: T4.21` | Rule syntax is accepted and the deny fires with the message `Denied by permission policy: deny rule on bash matching "<pattern>"`, but `git -C . commit` and `/usr/bin/git commit` bypass it |
| `--sandbox strict` writes limited to the working directory, `~/.grok/` and temp | Holds for a path outside the working directory when temp is not an ancestor. The temp allowance follows `$TMPDIR`, so a `TMPDIR` that is a parent of the repository widens write access |
| `read-only` "reads everywhere" and writes only `~/.grok/` and temp | Writes outside the working directory were denied (as expected); reads not tried |
| Whether the sandboxed process can read the native login under `~/.grok/` is `Unverified` | It can: `auth.json` is listed and `test -r` succeeds in `strict` and `workspace` |
| `--output-format` values `json` and `streaming-json` ([CLI]) | Help also lists `plain` (default) and `streaming-messages-json` (Anthropic Messages wire format, with `--include-partial-messages`); not exercised |
| `grok models` parse format `Unverified`; `--json` assumed by the checklist | No `--json` (exit 2); text format as in step 2b; the same command works logged out (exit 0) with `You are not authenticated.` |
| `grok inspect --json` as an auth status candidate | It carries no auth status, and it works logged out; use the `grok models` first line or a headless run's exit 1 and `Not signed in.` text |
| `AUTH_REQUIRED` names `grok login` (`--device-auth` on a headless host) | The observed message names `grok login --device-code`, and also `XAI_API_KEY` as an alternative |
| `-s` contradiction between [HL] and [SESS] | `-s` names a **new** session; reusing the id exits 1 with `Session ID ... is already in use`. [SESS] is right |
| `-c` selects "the most recent session for the current directory" | Confirmed |
| Resume tied to the original working directory (checklist 14) | Not tied: `-r <id>` from another directory worked, with a stderr note giving the original directory |
| Sandbox profile preserved on resume ([CL] 0.2.56) | Confirmed (14b) |
| Project sources (`.mcp.json`, `.grok/config.toml` MCP) are inert without trust (assumed) | `inspect` **lists** those MCP servers without trust (source type shown); no server was spawned in the headless run. Project and `.claude` hooks were not listed and did not fire |
| `grok agent stdio` as a transport fallback with permission and sandbox flags | `agent stdio --help` has only `--debug`, `--debug-file`, `--leader-socket`; the parent `agent` has `--always-approve` but no `--sandbox` or `--permission-mode` |
| `projectTrusted` | Reported `true` in a non-repository scratch directory and `false` in a `git init` directory; not explained |
