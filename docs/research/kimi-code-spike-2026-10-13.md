# Kimi Code CLI automation contract: documentation spike (T4.60), 2026-10-13

- Date: 2026-10-13
- Status: Research input (historical record once written). Documentation only: no provider CLI was installed or run,
  no credential was handled. Verdicts are Delegated findings, not owner decisions.
- Used by: [ROADMAP](../ROADMAP.md) T4.60 and T4.61, [TDD §4.7](../design/TDD.md#47-kimi-code-m4-blocked-by-b-1),
  FR-ADP-09, B-1, R-1, R-7.

## Which sources, and why they are current

The legacy Python CLI (`MoonshotAI/kimi-cli`, `kimi run`, K2.x models, its permission model) was archived by Moonshot
on 2026-09-23 and is **not evidence** here ([R2] L77, L145 to L153). Every fact below comes from the replacement
product, which both Moonshot's docs and its repository name **Kimi Code CLI** (TypeScript, MIT licence, repository
`MoonshotAI/kimi-code`). All pages were retrieved on 2026-10-13 and text on them is treated as data.

| ID | Source (URL) | Why current |
| --- | --- | --- |
| K1 | [kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html) | Official docs of Kimi Code CLI; documents `kimi login`, `kimi web`, `kimi migrate` and the 2.x permission names |
| K2 | [Interaction and input](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/interaction.html) | Same site; three permission modes, goal exit codes |
| K3 | [Sessions](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html) | Same site; session storage and resume |
| K4 | [Configuration files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html) | Same site; `[[permission.rules]]`, `[tools]`, project-local config |
| K5 | [Model Context Protocol](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html) | Same site; `mcp.json`, tool naming |
| K6 | [kimi acp reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html) | Same site; ACP capability matrix |
| K7 | [Changelog](https://www.kimi.com/code/docs/en/kimi-code-cli/changelog.html) | Latest entry 2.1.1 (2026-09-24); dates the docs |
| K8 | [Config overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html) | Same site; precedence rules |
| K9 | [Agents and sub-agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html) | Same site; agent-file `tools` and `disallowedTools` |
| K10 | [Environment variables](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html) and [Data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html) | Same site; `KIMI_CODE_HOME`, credential directory |
| K11 | [MoonshotAI/kimi-code README](https://github.com/MoonshotAI/kimi-code) | Moonshot's repository for the new CLI |
| K12 | [npm registry metadata for `@moonshot-ai/kimi-code`](https://registry.npmjs.org/@moonshot-ai/kimi-code) | Registry `dist-tags.latest` is `2.1.1`, published 2026-09-24T07:27Z; matches K7 |
| K13 | [Migrating from kimi-cli](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/migration.html) | Same site; confirms the legacy CLI is being phased out and OAuth login is not migrated |

The docs describe themselves as the Kimi Code CLI docs; the changelog and the npm registry agree on version 2.1.1 as
the newest release at retrieval time. The documentation pages are not versioned, so any statement below applies to
"the docs as of 2026-10-13 (2.1.1)", not to a pinned binary.

## What is documented (sourced)

- **Headless command:** `kimi -p` / `--prompt <prompt>` runs one prompt non-interactively without the TUI (K1).
- **Structured output:** `--output-format text|stream-json`, valid only with `-p`; in `stream-json` each stdout line is
  a JSON object: Assistant messages, Assistant messages carrying `tool_calls`, then Tool messages; thinking is not
  emitted; progress and "resuming session" notices go to stderr (K1). A structured "session resume hint" meta message
  exists in `stream-json` (K7, changelog entry, version not stated). **No field-level schema is documented.**
- **Resume:** `--session [id]` / `-S` (hidden alias `-r`/`--resume`) and `--continue` / `-c`, mutually exclusive; the
  permission mode may be re-applied on resume (K1, K3). Whether the session id is printed in `stream-json` output other
  than via the resume-hint meta message: not documented.
- **Version command:** `kimi --version` / `-V` (K1, K11). Output format not documented.
- **Permission modes:** Always Ask (default, `manual`), Ask When Needed (`--yolo`/`-y`), Never Ask (`--auto`) (K1, K2,
  K4). `-p` uses the `auto` (Never Ask) policy by default, no human approval is requested, and **static deny rules stay
  in effect**; `--prompt` cannot be combined with `--yolo`, `--auto` or `--plan` (K1). K8 contradicts this by showing
  `kimi --yolo -p ...` (see Surprises).
- **Permission rules:** `[[permission.rules]]` in `config.toml`, first match wins, `decision` `allow`/`deny`/`ask`,
  `scope` `turn-override`/`session-runtime`/`project`/`user`, `pattern` `Tool` or `Tool(arg-pattern)` such as
  `Bash(rm -rf*)`; MCP tools match by name only (K4, K5).
- **Tool switches:** global `[tools] enabled`/`disabled` and agent-file `tools`/`disallowedTools`, enforced again
  before execution (K4, K9). `--agent-file <path>` loads a per-launch agent and `--agent <name>` selects one, both
  valid with `-p` (K1, K9).
- **Dangerous-command guard:** blocks `shutdown`, `reboot`, `rm -rf` outright in Never Ask mode; can be disabled
  (K2, K4, K7).
- **MCP:** servers come from `~/.kimi-code/mcp.json` (or `$KIMI_CODE_HOME/mcp.json`) and the project-level
  `.kimi-code/mcp.json`; project stdio entries execute commands when a session starts and need workspace trust;
  `enabledTools`/`disabledTools` per server (K5). **No per-run MCP flag** appears in the `kimi` option table (K1).
- **ACP:** `kimi acp` (JSON-RPC over stdio) with `session/new` accepting `mcpServers`, `session/resume`, `session/load`,
  `session/request_permission`, `session/set_mode`, `authenticate` returning `-32000` when no token (K6).
- **Auth:** `kimi login` (device-code flow, exit 0 success, 1 failure or cancel; no flags) (K1); credentials live under
  `$KIMI_CODE_HOME/credentials/` (0700/0600) (K10); API-key providers read `api_key`, or `api_key_env` (K4, K8).
  `KIMI_CODE_HOME` relocates config, sessions, logs and credentials (K10).
- **Other exit codes:** `kimi doctor` 0/1 (K1); `kimi -p "/goal ..."` 0 complete, 3 blocked, 6 paused (K2); a fixed bug
  made failed `-p` turns exit 0 (K7, so non-zero on failure now, code value not stated).
- **Workspace trust:** from 2.1.0, project-local config applies only after the workspace is trusted and file tools no
  longer follow symlinks out of the working directory (K7). How trust is granted in `-p` mode is not documented.

## What is not documented (missing for T4.62)

1. Field-level `stream-json` schema, terminal/result record, usage fields, and where the session id appears.
2. A non-bypass headless mode: `-p` is always Never Ask, so the controller's only brakes are deny rules, tool lists and
   its own worktree. Whether that counts as bypass-class under FR-POL-03 is an owner-visible design question.
3. How to supply `permission.rules` for one run without editing `~/.kimi-code/config.toml`. `KIMI_CODE_HOME` can point
   at a controller-owned directory, but OAuth credentials live inside it, so the controller would have to copy or
   symlink credentials (forbidden by AGENTS.md); an `api_key_env` provider avoids that but is a different auth route.
   Whether `scope = "turn-override"`/`"session-runtime"` rules can be injected from outside is not documented.
4. Matching semantics of `Bash(pattern)` for compound commands, subshells and wrappers; hence no sourced Git-write
   denial. Not stated whether any commit or attribution setting exists.
5. An OS-level sandbox: none is documented (the only "sandbox" in the docs is an example data directory, K8).
6. An auth status command or exit code for "logged out" in headless mode; `kimi -p` behaviour with no login.
7. Per-run MCP definition in `-p` (only file-based `mcp.json`, or ACP `session/new`).
8. Model listing for the registry (`kimi provider list`/`catalog list` list configured providers and a public
   catalogue; a command that lists the models the current login may use is not documented).
9. Capacity, usage and rate-limit reporting for FR-CAP-01.
10. How workspace trust is granted non-interactively; whether telemetry or auto-update can make a run non-reproducible
    (`KIMI_DISABLE_TELEMETRY` exists, K10; `kimi upgrade` is manual per K1).

## Surprises

- K1 says `--prompt` cannot be used with `--yolo`, `--auto` or `--plan`; K8 shows `kimi --yolo -p ...` and says
  `--prompt` cannot be combined with `--yolo` or `--plan` (omitting `--auto`). Two pages of the same docs disagree.
- K8 says the CLI "has no project-level config file mechanism" while K4, K5 and K7 document `.kimi-code/mcp.json`
  and `.kimi-code/local.toml`. The docs are not internally consistent, so every row should be observed (T4.61).
- The `--yolo` flag no longer means bypass-everything: it is "Ask When Needed" and still asks for sensitive files and
  dangerous commands (K1, K2); `--auto` is the unattended mode and `-p` forces it.
- Docs and the new product coexist with the legacy: `kimi migrate` does not copy OAuth credentials (K13).

## T4.61 operator checklist (installed Kimi Code CLI, operator's native login)

Run on a throwaway repository and a throwaway `KIMI_CODE_HOME` where the step says so. Record results in a dated note
under `docs/research/` (as `live-checks-2026-10-13.md`), with the version. Capture no credential, token, account id or
contents of `~/.kimi-code/credentials/`; scrub paths and the user name.

1. `kimi --version`: record the exact output and exit code.
2. `kimi --help` and `kimi -p`-related help text: record the full option table (confirm there is no `--mcp-config`,
   `--settings` or permission-rule flag, or record its spelling).
3. Logged in and logged out (use a second, empty `KIMI_CODE_HOME` for logged out): the exit code and first line of
   output of `kimi -p "say ok" --output-format stream-json`. Also check whether any `kimi` subcommand or flag reports
   login status; record "none" if not.
4. A benign scrubbed capture of one `stream-json` run (no tool call) and one with a tool call: keep the real record
   shapes, the terminal/result record, usage fields and where the session id appears, for fixtures.
5. Resume: `kimi -p "again" --session <id> --output-format stream-json`: confirm it works with `-p`, what changes in
   the output, and the exit code. Repeat with `--continue`.
6. Exit codes of `-p` for: success, a task the model reports as failed, a provider error (use a bad `api_key_env`
   provider), a deny-rule rejection, an interrupted run (SIGINT).
7. Permission posture in `-p`: with a deny rule `Bash(git commit*)` in the throwaway `config.toml`, ask the model to
   commit in a throwaway repo; record HELD or ESCAPED. Repeat for `git push` (use a local bare remote),
   `git -C . commit`, `sh -c 'git commit ...'` and `git config alias` variants. Record whether the deny rule is
   reported in `stream-json`.
8. Whether `[tools] disabled = ["Bash"]` or an `--agent-file` with `tools: [Read, Grep, Edit]` blocks shell access in
   `-p`; record the evidence (attempted `Bash` call, error shape).
9. Per-run rules without touching the real config: does `KIMI_CODE_HOME` pointing at a copy of an empty config work
   with `api_key_env` only (no credentials copied)? Do `turn-override` or `session-runtime` scopes load from a file?
10. Per-run MCP: does `kimi -p` accept an MCP definition other than `mcp.json` in the working directory or
    `KIMI_CODE_HOME`? Record how an untrusted-workspace `.kimi-code/mcp.json` behaves in `-p` (is it applied, skipped,
    or does it prompt?). Do not use a real remote MCP server; use a local stdio echo server.
11. Workspace trust in `-p`: in a fresh repository with `.kimi-code/mcp.json` and an `AGENTS.md`, record whether they
    are read and whether any prompt appears.
12. OS sandbox: record whether any filesystem or network confinement exists (attempt a write outside the working
    directory and a network call in a throwaway session; report both outcomes).
13. `kimi acp`: record the `initialize` response, then `session/new` with `mcpServers`, `session/prompt`, a
    `session/request_permission` round trip, `session/resume`, and `authenticate` with no login (exit and error code).
    State whether ACP is a better adapter surface (permission decisions made by the controller, per-session MCP).
14. Model listing: record any command that lists the models the logged-in account may use.
15. Capacity: record whether usage, limits or resets appear in `-p` output (compare `/usage` and `/status`).
16. Telemetry and updates: confirm `KIMI_DISABLE_TELEMETRY=1` is honoured in `-p` and that `kimi` never self-updates
    in a headless run.
17. Resume across directories and modes (T5.0): resume the item 5 session from a second throwaway directory and record
    whether the session is found; resume with `--auto`, `--yolo` and `--plan` each added and omitted, and record the
    permission mode that applies, the exit code, and how this squares with `-p` not combining with those flags (K1)
    and K8's disagreement. Settles the Kimi Code cells of
    [TDD §4.10](../design/TDD.md#410-native-resume-inventory-t50).
