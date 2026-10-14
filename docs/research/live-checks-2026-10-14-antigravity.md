# Live checks, Antigravity (`agy`), 2026-10-14

Status: research input (historical record once written). Run by an agent (Claude Code, Sonnet 5.5) on the operator's
Ampere host with the real, logged-in `agy`, against the checklist in
[TDD §4.4.3](../design/TDD.md#443-t431-operator-checklist-antigravity) and the candidate in
[§4.4.4](../design/TDD.md#444-separate-acp-adapter-owner-lead-2026-10-13). Everything here was **observed** in this
session; anything not run is listed under "Unverified / not run". The roadmap owns status. Verdicts are Delegated
findings, not owner decisions.

## Environment

| Item | Value |
| --- | --- |
| OS / arch | Ubuntu 26.04.1, Linux 7.0.0-1013-oracle, aarch64 |
| Node.js / Git | v24.21.0 / 2.53.0 |
| `agy` | `1.3.4` (`agy --version`, exit 0, one line, bare version) |
| Separate ACP server found | `agy_acp_server.par`, version `1.3.0` (from the T3 Code managed runtime, see C14) |
| Login | Logged in (operator's native login). Proven by `agy models` and `-p` calls succeeding; no login command was run |
| Method | Throwaway repos and directories under `$HOME/.cache/tmp` (removed afterwards), a local bare remote, `timeout 120`, stdin `</dev/null`, stdout and stderr captured separately. No credential file, `settings.json` or `~/.gemini` content was read; no bypass flag was used; no `GEMINI_API_KEY`, `GOOGLE_API_KEY` or `GOOGLE_GEMINI_BASE_URL` was set |

Verdicts: HELD (a control held), ESCAPED (a control did not hold), WORKS, FAILS, NOT_RUN.

## Results

Every command ran as `bash -lc` with the stated flags, from the throwaway repo (`repo`) unless noted. "exit" is the
observed process exit code.

| Row | Command (exact) | Observed | Verdict |
| --- | --- | --- | --- |
| C1 | `agy --version` | exit 0; prints `1.3.4` | WORKS |
| C2 | `agy --help`; `agy -p --help`; `agy models --help`; `agy agents --help`; `agy acp --help`; `agy serve --help` | All exit 0. Top-level flags: `--add-dir`, `--agent`, `-c/--continue`, `--conversation`, `--dangerously-skip-permissions`, `--disable-slash-commands`, `--effort`, `-i/--prompt-interactive`, `--input-format` (text, stream-json), `--json-schema`, `--log-file`, `--mode` (accept-edits, plan), `--model`, `--new-project`, `--output-format` (text, json, stream-json), `-p/--print/--prompt`, `--print-timeout`, `--project`, `--remote-control`, `--sandbox`. Subcommands: `agent`, `agents`, `changelog`, `help`, `install`, `mcp`, `mic-serve`, `models`, `plugin`, `plugins`, `remote-control`, `update`. `agy -p --help` prints the identical top-level text. `agy models --help` and `agy agents --help` list only `-h/--help`. **`agy acp --help` and `agy serve --help` exit 0 and print the top-level help**: no `acp` or `serve` subcommand exists, and unknown subcommands are not rejected. No `--settings`, `--config-dir`, `--mcp-config`, `--workspace`, permission flag other than `--dangerously-skip-permissions`, or auth/status subcommand appears in help | WORKS |
| C3 | `agy models --output-format json` | exit 1, stdout empty; stderr: usage text plus `Error: flags provided but not defined: -output-format`. `models` takes no `--output-format` | FAILS |
| C3b | `agy models` (logged in) | exit 0; stdout is 10 tab-separated lines `<slug>\t<display name>` (Gemini 3.8 Flash x3, Claude Opus 5.5 x3, Claude Sonnet 5.5 x3, GPT-OSS 120B x1); stderr `Fetching available models...` | WORKS |
| C3c | `HOME=<empty scratch> agy models` (logged out) | exit 1 in under 1 s; stderr `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.` | WORKS (cheap logged-out probe, exit 1) |
| C4 | `agy -p "Reply with the single word ok." --output-format text` / `json` / `stream-json` | All exit 0, stderr empty, 3 to 5 s wall. `text`: stdout `ok`. `json` keys: `conversation_id`, `status` (`SUCCESS`), `response`, `duration_seconds`, `num_turns`, `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`). `stream-json` is NDJSON, each line `{"event": ...}`: `init` (`conversation_id`, `init.cwd`, `init.tools`, `init.permission_mode`), `step_update` (`conversation_id`, `step_index`, `state` ACTIVE/DONE, `step_type` such as `user_input`, `agent_response`, `tool`; `text_delta`, `duration_seconds`, `usage`, `tool_name`, `tool_info.{name,parameters}`), then `result` (same fields as the `json` object, nested under `result`) | WORKS |
| C5 | `/logout` then `-p` | **Not run** (rule: no logout). Logged-out behaviour was taken from C13 with a scratch HOME instead | NOT_RUN |
| C5b | `env -u DBUS_SESSION_BUS_ADDRESS timeout 60 agy -p "Reply with the single word ok." --output-format json` | exit 0, `status` `SUCCESS`, `ok`. A keyring-locked variant was not run (see Contradictions: auth is file based, not a keyring) | WORKS (DBUS not needed) |
| C6 | `agy -p "/usage" --output-format json`; `agy -p "/credits" --output-format json`; `HOME=<scratch> agy -p "/usage" --output-format json` | Logged in: both exit 0 in 2 to 3 s, `status` `SUCCESS`, `conversation_id` empty, `num_turns` 0, all usage 0 (no model turn, no conversation created). Extra top-level key `command` = `{name, data}`. `/usage` `data` keys: `description`, `groups[]` (`name`, `description`, `buckets[]` with `id`, `name`, `description`, `window` weekly/5h, `remaining_fraction`, `reset_time`). `/credits` `data` keys: `remaining_credits`, `upgrade_uri`. Logged out (scratch HOME): exit 1 after about 61 s, stdout JSON `status` `ERROR`, `error` `authentication failed or timed out`; see C13 for stderr | WORKS (a zero-cost quota call) |
| C7 | `agy -p "Run the shell command: echo hello" --output-format json`, then `stream-json`; `agy -p "Create a file named a.txt containing the word hi" --output-format json` | Shell: exit 0 both times, `status` `SUCCESS`, empty `response`, `denied_actions` = `[{"action":"command","display_name":"RunCommand"}]`; stderr one line starting `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow ...`. `stream-json` showed a `run_command` tool step go ACTIVE then DONE (0.06 s) before the `result` carrying `denied_actions`. `init.permission_mode` = `request-review`. File write: exit 0, `a.txt` was created in the repo with no denial: auto-allowed | HELD (shell soft-denied, exit 0, must be read from `denied_actions`) |
| C7b | `agy -p "Say ok" --output-format stream-json --sandbox`; same with `--mode=plan` | Both exit 0. `init.permission_mode` is `request-review` in both: **neither flag changes it**. The `--mode=plan` run issued a shell command that was denied (`denied_actions` as above) and took 14.6 s for 963 output tokens. The `--dangerously-skip-permissions` variant was **not run** (rule) | WORKS (flags accepted; mode not surfaced) |
| C8 | Deny rules plus bypass | **Not run**: needs a bypass flag and a real `settings.json` edit (rules) | NOT_RUN |
| C9 | Run 1 = C4 `json`; run 2 `--conversation <id>` same dir; run 3 same id from the repo dir; run 4 `-c`; run 5 `--conversation 00000000-0000-0000-0000-000000000000` | All exit 0. Run 2: same `conversation_id`, `num_turns` 2, the model recalled the first prompt. Run 3 (other directory): same `conversation_id`, `num_turns` 3, the model recalled the prompt (cross-directory resume works). Run 4 `-c` in the original directory: resumed the most recent conversation there (the one run 5 had created), not run 1's; `-c` from the repo directory resumed run 1's id, which run 3 had last used there: most-recent is per working directory. Run 5 unknown id: **exit 0, a new conversation id, status `SUCCESS`, stderr only `warning: conversation "00000000-0000-0000-0000-000000000000" not found`**. `duration_seconds` on resumed runs was 74, 82 and 100 s while the wall time of run 3 was 6 s (the field looks cumulative over the conversation) | WORKS (with a silent-new-conversation hazard) |
| C10 | `agy -p "Say ok" --model does-not-exist --output-format json`; `agy -p "Say ok" --print-timeout 1s --output-format json` | Bad model: **exit 1** in 1 s, stdout `{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model ...): ... Available models: ..."}` (display names listed), stderr repeats `error: invalid model selection ...`. Timeout: **exit 0, `status` `SUCCESS`, `response` empty, zero usage, a fresh `conversation_id`**, stderr `[agy] print timeout after 1s with turn in progress; returning partial output` | WORKS (documented exit 1 confirmed; timeout reports SUCCESS) |
| C11 | Throwaway repo with `.agents/mcp_config.json` (stdio `command` `sh -c "echo started > <marker>; sleep 5"`), `.agents/hooks.json` (`SessionStart` and `PreToolUse` hooks writing a marker), `GEMINI.md` and `AGENTS.md` each asking for a canary phrase; `agy -p "Say ok" --output-format stream-json`, default settings | exit 0, `status` `SUCCESS`, no trust dialog, no denial. **`MCP_MARKER` and `HOOK_MARKER` were both created**, so the repo-supplied MCP server was started and the repo-supplied hook ran with no approval. Both canary phrases appeared in the reply, so `GEMINI.md` and `AGENTS.md` were both read. `init.tools` (60 entries) contained `call_mcp_tool`, no per-server tool name. The `--dangerously-skip-permissions` variant was **not run** (rule). The JSON field layout of `mcp_config.json` and `hooks.json` was my guess (`mcpServers`, `hooks.<Event>[].command`); it was enough to execute, but the real schemas were not read from documentation here | **ESCAPED** (repository-controlled commands execute under `-p` at default settings; see Findings) |
| C12 | `AGY_CLI_DISABLE_AUTO_UPDATE=true agy -p "Reply with the single word ok." --output-format json` | exit 0, `SUCCESS`, `ok`. `~/.gemini/antigravity-cli/updater/` listing (names only) was `update.lock`, `update_status.json` before and after | WORKS (no new updater files; whether a network update is suppressed was not measured) |
| C13 | `HOME=<empty scratch> agy -p "Say ok" --output-format json </dev/null` | **exit 1 after about 60 s** (it waited for a login). stdout `{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out",...}`; stderr: `Authentication required. Please visit the URL to log in:` followed by a Google OAuth authorization URL (public client parameters and a PKCE challenge; not pasted). The CLI created its own directory tree under the scratch HOME (`.gemini/antigravity-cli/...`, `.gemini/config/mcp_config.json`, `.gemini/config/projects/default-cli-project.json`): so settings and state follow `$HOME`, and a different HOME is logged out | WORKS (HOME is a hard profile boundary; logged-out run hangs about 60 s, exits 1, prints a sign-in URL on stderr) |
| C14 | `command -v agy_acp_server.par agy_acp_server.exe agy-acp agy-acp-bridge`; global `npm ls` filtered to `acp`/`antigravity`; `find ~/.t3 -maxdepth 6 -iname '*acp*'` | `command -v`: none on PATH (exit 1). `npm ls -g`: no `acp`/`antigravity` package. Zed: not installed on this host (not checked further). Under the T3 Code app: `~/.t3/tools/antigravity-acp/linux-arm64/versions/<64-hex id>/agy_acp_server.par` (ELF 64-bit aarch64 executable, about 931 MB, next to a `localharness_external` ELF about 123 MB and `.install-complete.json` with keys `releaseId`, `version`, `executable`, `harness`; `version` = `1.3.0`). Per-provider state at `~/.t3/userdata/providers/antigravity/<64-hex id>/antigravity-acp/` containing, by name, `acp_token.json` (mode 600, **not read**), `settings.json`, `brain/`, `conversations/`. The same provider directory also holds `antigravity-cli` and `config` | WORKS |
| C15 | `agy_acp_server.par --help`, `--helpfull`, `--version` (no model contact) | `--help`: "Entry point for the AGY ACP Server." with flags `--[no]debug` and `--[no]notices` only. `--helpfull` is a Google3 absl listing; relevant entries: `--[no]version`/`--show_build_data`, `--uid` ("If root, switch to this user id (or empty-string not to switch)"). Started with no `--uid=` it aborts with `Check failed: LookupGIDByGroupName ... Group nobody not found` (exit -6, SIGABRT); with `--uid=` (empty) it runs, matching the manifest. Build data names target `//cloud/developer_experience/antigravity_extensions/acp_server:_agy_acp_server_bin` (Google-built; a Python 3.14 embedded launcher). It is its own server, not a wrapper around `agy -p` as far as these outputs show (it reports `agentInfo.name` `antigravity-acp`, `title` `Google Antigravity`, `version` `1.3.0`). Environment variables, by the server's own error text: `GEMINI_API_KEY` (for `gemini-api-key`), `GOOGLE_API_KEY` and `GOOGLE_CLOUD_PROJECT` / project and location (for `agent-platform`), `gcp.project`/`location` settings (for `oauth-business`). None was set | WORKS |
| C16 | Scratch stdio JSON-RPC client (NDJSON), server started as `agy_acp_server.par --uid=`; `initialize` then `session/new` only; no `authenticate`, no prompt. Run once with a scratch HOME and once with the real HOME | See the C16 detail below. Login is **not** reused: `session/new` returns an authentication error in both runs | WORKS |
| C17 | `agy --gemini_dir=<scratch> -p "Say ok" --output-format json`; `agy --config-dir=<scratch> models` | `--gemini_dir` is **accepted although absent from help**: with an empty directory the run printed `Authentication required. Please visit the URL ...` (logged out), and the CLI wrote its `antigravity-cli/` tree directly inside the given directory. So `--gemini_dir` is a working per-run state and credential directory override. `--config-dir`: `flags provided but not defined: -config-dir` plus usage | WORKS |
| C18 | Run 1: `-p "Say ok" --output-format stream-json --sandbox --mode=plan`; run 2: `--conversation <id>` of run 1, neither flag, asking for a file write and a shell command | Both exit 0. Run 1: `init.permission_mode` `request-review`; the model tried a shell command and `denied_actions` = `[{"action":"command","display_name":"RunCommand"}]`. Run 2: `init.permission_mode` `request-review`, same `conversation_id`; `write_to_file` ran and `b.txt` exists (allowed), `run_command` was denied (same `denied_actions` shape). Run 3 (bypass after a bypass run) was **not run** (rule) | WORKS (mode flags not persisted on resume; permissions behaved as C7) |

### C16 detail (exactly what responded)

Transport: newline-delimited JSON-RPC 2.0 over the server's stdin and stdout. stderr was empty. The process had to be
terminated by the client (SIGTERM, exit -15), it does not exit on stdin close within the wait used.

- Request `initialize` with `params` `{protocolVersion: 1, clientCapabilities: {}, clientInfo}` responded with
  `result` keys `protocolVersion` (1), `agentCapabilities`, `authMethods`, `agentInfo`.
  - `agentCapabilities` keys: `loadSession` (true), `promptCapabilities` (`image`, `audio`, `embeddedContext`, all
    true), `mcpCapabilities` (`http` true, `sse` true; **no `stdio` key**), `sessionCapabilities` (`list`,
    `resume`), `auth` (`logout`).
  - `authMethods` ids, in order: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` (each entry
    has `id`, `name`, `description`).
  - `agentInfo`: `name` `antigravity-acp`, `title` `Google Antigravity`, `version` `1.3.0`.
- Request `session/new` with `params` `{cwd, mcpServers: []}` responded with a JSON-RPC **error**, code `-32000`,
  `message` `Authentication required`, `data.message` a prose string. With the real HOME it read: no authentication
  method selected; call the `authenticate` method (supports `oauth-personal`, `gemini-api-key`, `agent-platform`) or
  set `auth.type` in `~/.gemini/antigravity-acp/settings.json` to one of `oauth-personal`, `gemini-api-key`
  (requires `GEMINI_API_KEY`), `oauth-business` (requires gcp project/location), `agent-platform` (requires
  `GOOGLE_API_KEY` or a project and location). It contained no URL and no sign-in prompt was printed.
- A session was therefore **not** created with the operator's `agy` login present. Answer to "does it reuse agy's
  login": **no**. After the real-HOME run the listing of `~/.gemini` was unchanged (no `antigravity-acp` directory
  was created there).
- Not exercised: `authenticate`, `session/prompt`, `session/request_permission`, per-session `mcpServers` with a
  non-empty list, session modes, `session/list`, `session/resume`. The keys above are what the server advertised,
  not what was tested.

## Findings

1. **ESCAPED: repository-controlled code runs under `agy -p` with default settings (C11).** A workspace
   `.agents/mcp_config.json` stdio server and a workspace `.agents/hooks.json` hook both executed with no prompt,
   no trust gate and no denial, and exit 0. The committed design treats config-file injection as a design concern
   (T4.3). A repository that Switchboard hands to `agy` can run arbitrary commands before any permission check,
   outside the `permissions.deny` rules. The bypass variant was not run, so the bypass case is Unverified, but this
   did not need it.
2. **Soft denial confirmed (C7, C18):** shell commands are denied but exit 0 and `status` `SUCCESS`; only
   `denied_actions` (`action`, `display_name`) and a stderr notice carry the denial. File writes in the workspace
   are auto-allowed.
3. **`--print-timeout` returns exit 0 with `status` `SUCCESS` and empty output (C10);** an unknown `--conversation`
   id silently starts a new conversation with exit 0 (C9). Both would be read as success by an adapter that only
   checks the exit code and `status`.
4. **Auth is a token file under the CLI's state directory, selected by `$HOME` or `--gemini_dir` (C13, C17).** The
   logged-out call blocks about 60 s and exits 1 with a sign-in URL on stderr (never read on a real login).
5. **The separate ACP server exists on this machine (C14 to C16)** but only as a copy managed by the T3 Code app; it
   does not reuse `agy`'s login and advertises HTTP and SSE MCP only.

## Unverified / not run

| Item | Reason |
| --- | --- |
| C5 (`/logout`, log in again) | Rule: do not log out or log in. Logged-out behaviour was observed through a scratch HOME instead (C13) |
| C5b keyring-locked variant | No keyring involved; the token is a file (C14 listing of the CLI state directory shows a file named `antigravity-oauth-token`, mode 600, contents not read). Only the `DBUS_SESSION_BUS_ADDRESS` variant was run |
| C7b, C11, C18 bypass variants | Rule: no `--dangerously-skip-permissions` |
| C8 (all git-write denial checks, whether Deny survives bypass, `allowNonWorkspaceAccess` under bypass, `--sandbox` under bypass) | Needs a bypass flag and a real `settings.json` edit; not run. Git-write denial under `--sandbox` or default settings without bypass was not exercised separately either |
| Whether `--sandbox` actually restricts commands or filesystem | The flag was accepted and `init.permission_mode` did not change; no malicious-fixture leg (T4.38) was run |
| Whether `--mode=plan` blocks file writes | Only a shell-command prompt was tried under plan mode; no write was requested in plan mode |
| C11: MCP tool approvability, a documented schema for `.agents/mcp_config.json` and `.agents/hooks.json`, whether `-p` honours a worktree-local config in all cases | Schemas were guessed; no MCP tool call was made |
| C12: that the network update is suppressed | Only the updater file listing was compared |
| C16: `authenticate`, prompts, permission requests, per-session `mcpServers` content, session modes | Out of scope (initialize and `session/new` only; stop before any sign-in) |
| Zed's installed external agents | Zed is not present on this host (not otherwise inspected) |
| Server checksum or signature | Not checked |

## Contradictions with TDD §4.4

| TDD claim | Observed |
| --- | --- |
| C3: `agy models --output-format json` exists and gives JSON keys | Exit 1: `flags provided but not defined: -output-format`. `agy models` prints tab-separated `slug<TAB>display name` lines (exit 0) |
| C3: `agy models` is a harmless auth call, exit codes logged in and logged out | Logged out it exits 1 with `Please sign in to view available models` in under 1 s (usable as a preflight, no hang), whereas `-p` logged out hangs about 60 s |
| C5 "log in again afterwards", auth stored in the keyring (C5b "keyring locked", C13 "(keyring)") | Not run for C5; C13 and the directory listing show a token file in the CLI state directory and `$HOME`-dependent login. DBUS is not needed |
| "A tool that needs approval ... is soft-denied" (headless row) | Confirmed; additionally `status` is `SUCCESS` and `response` can be empty |
| C2 expectation of `--settings`, `--config-dir`, `--mcp-config`, `--workspace` flags | None in help. `--config-dir` is rejected. A hidden `--gemini_dir` is accepted and works (C17); the TDD says "Unverified" for it |
| C2 expects an ACP/server subcommand | `acp` and `serve` are not subcommands; `agy acp --help` and `agy serve --help` print top-level help with exit 0 |
| §4.4.1/§4.4.2: a per-run permission mode (`toolPermission`) is the thing to look for | No per-run flag exists; `init.permission_mode` was `request-review` in every run, including `--sandbox` and `--mode=plan` |
| §4.4.2/4.4.1: timeout "whether partial output and exit 0 occur" | Exit 0, `status` `SUCCESS`, empty `response`, stderr notice |
| §4.4.4 Authentication: "Unverified" whether it reuses `agy`'s login | Observed: it does not (C16); `session/new` returns `-32000 Authentication required` with `agy` logged in |
| §4.4.4 Install: the manifest `cmd` is `./agy_acp_server.par` with `--uid=` on Linux | Confirmed as needed: without `--uid=` the binary aborts (SIGABRT) because the group `nobody` is not found on this host |
| §4.4.4 probe: "mcp(http=true, sse=true) and no stdio"; modes `default`/`auto_edit`/`yolo` | MCP capabilities confirmed (`http`, `sse`; no `stdio`). Session modes were not requested so they remain Unverified. `initialize` does report `protocolVersion` 1 for build 1.3.0, consistent with one of the conflicting reports |
| C11 premise that a repo `.agents` config is a risk to be tested | Confirmed as an actual escape under default settings (Findings 1) |

## Credential-shaped output encountered

- `agy` (logged out, scratch HOME) printed a Google OAuth authorization URL on stderr: a public client id, a PKCE
  code challenge and callback parameters. Not a secret, not pasted, not followed.
- A file named `antigravity-oauth-token` (mode 600) exists in the CLI state directory and a file named
  `acp_token.json` (mode 600) in the T3 ACP state directory. Names and permissions only; contents were not read.
