# Kimi Code live checks on the Ampere operator host, 2026-10-15 (T4.61, B-1)

Status: research input (historical record once written). Run by an agent (Grok Bot, for Linus) on the operator's
Ampere host against the installed Kimi Code CLI, working through the
[T4.61 checklist](kimi-code-spike-2026-10-13.md#t461-operator-checklist-installed-kimi-code-cli-operators-native-login)
as far as the live-run policy allows. Everything here was **observed** in this session unless a row says otherwise.
The roadmap owns status (see [ROADMAP §6](../ROADMAP.md#6-milestones)). Verdicts are Delegated findings (Linus, under
the owner's 2026-10-15 instruction to pick the bypass-flag handling and the best restricted path), not owner
decisions. Results are valid for the version below only (ADR-0009).

## Environment

| Item | Value |
| --- | --- |
| OS | Ubuntu 26.04.1, Linux aarch64 (Ampere host) |
| Kimi Code CLI | `2.1.1` (`kimi --version`, exit 0); binary under `~/.kimi-code/bin/` |
| Login | The operator's native login, global region (kimi.ai). No auth file, token or credential directory was read |
| Model | `kimi-code/kimi-for-coding` (the cheapest-model alias in `live-models.conf`) |
| Method | Non-model commands run directly (`--help`, `--version`, `doctor`, `session list`, `provider list`, an ACP stdio client sent `initialize`, `session/new`, `session/list`, `session/set_mode`; **no `session/prompt`**), in the scratch directory `~/operator-runs/live-scratch/kimi-b1`; the logged-out cases used an empty throwaway `KIMI_CODE_HOME` (removed afterwards). One run through `live-run.sh` (below). No bypass flag, `kimi login`, `kimi upgrade` or `kimi web` was run |
| Live runs used | 1 of 2 (`pre-check`, task `kimi-b1-validate`), failed at argument parsing, no model call (row 3) |
| Redaction | `kimi provider list --json` prints provider tables whose key-named fields (API key, OAuth key) were replaced by `REDACTED` on the host before capture; nothing else was secret-bearing. Paths are scrubbed to `~` |

## Results

Verdicts: WORKS, FAILS, HELD, ESCAPED, NOT_RUN (needs a model call the live-run channel could not make).

| # | Command or call | Observed | Verdict |
| --- | --- | --- | --- |
| 1 | `kimi --version` | `2.1.1`, exit 0 | WORKS |
| 2 | `kimi --help` | exit 0. Options: `-V/--version`, `-S/--session [id]`, `-c/--continue`, `-y/--yolo` ("Ask When Needed"), `--auto` ("Never Ask"), `-m/--model <alias>`, `-p/--prompt <prompt>`, `--output-format text\|stream-json` ("for prompt mode"), `--skills-dir`, `--agent`, `--agent-file` (both "cannot be combined with --session/--continue"), `--add-dir`, `--plan`, `-h`. **Absent: any MCP flag, settings or permission-rule flag, turn limit, sandbox flag, usage flag.** Subcommands: `export`, `fork`, `provider`, `session`, `acp`, `web`, `server` (deprecated), `rc/remote`, `login [--region]`, `doctor`, `vis`, `install-desktop`, `migrate`, `upgrade/update`. **No `info`, `status` or `whoami`** | WORKS (confirms K1) |
| 3 | `live-run.sh kimi` (its compiled command is `kimi -m kimi-code/kimi-for-coding --plan -p "<prompt>"`) | `error: Cannot combine --prompt with --plan.`, exit 1, 2 s. **`-p` is rejected with `--plan` at startup**, as K1 says (K8's wording was the incomplete one). The wrapper's `kimi` line can therefore never reach the model; it needs `-p` without `--plan` (see Follow-ups) | FAILS (wrapper), confirms K1 |
| 4 | `kimi acp --help`, `kimi login --help` | `acp` takes `--login` and `--region <mainland-cn\|global>`; `login` takes `--region` (K1 says "no flags": the 2.1.1 help shows one) | WORKS |
| 5 | `kimi doctor config` | `OK config.toml ... All checked config files are valid.`, exit 0 | WORKS |
| 6 | `kimi session list`, logged in and with an empty `KIMI_CODE_HOME` | Both print `No sessions found.`, exit 0. **Not an auth probe**: it does not distinguish the two states | WORKS (not usable for auth) |
| 7 | `kimi provider list --json` | Object with `providers` (the managed provider: `baseUrl` `https://api.kimi.ai/coding/v1`, `type` `kimi`, OAuth `storage` `file`, `oauthHost`) and `models` (`kimi-code/kimi-for-coding`: `maxContextSize` 1048576, `capabilities` thinking, always_thinking, image_in, video_in, tool_use ...). Key-named fields exist in this output and must stay redacted | WORKS (usable for the registry, never stored raw) |
| 8 | ACP `initialize` (`protocolVersion` 1, empty `clientCapabilities`), logged in | `agentInfo` `Kimi Code CLI` `2.1.1`; `agentCapabilities`: `loadSession` true, `promptCapabilities` image and embeddedContext, `sessionCapabilities` list, resume, close, delete, fork, additionalDirectories, `mcpCapabilities` http and sse, `auth.logout`; `authMethods` one entry `login` of `type` `terminal` with `args` `["--login"]`. Replied within the 2 s wait | WORKS |
| 9 | ACP `session/new` with `cwd` and `mcpServers: []`, logged in | Result `sessionId` (`session_<uuid>`), `configOptions` for `model`, `thinking` (`low`, `high`, `max`; default `max`) and `mode`, and `modes` with **`default` ("Manual approvals; tools execute normally."), `plan` ("Read-only planning; no tool execution."), `auto` ("Auto-approve safe operations."), `yolo` ("Auto-approve everything.")**, `currentModeId` `default`. The `model` option lists the models this login may use: `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`, `kimi-code/k3`, `kimi-code/k3-256k`. A `session/update` `available_commands_update` follows (`compact`, `status`, `usage`, `mcp`, `tasks`, `help`, skills) | WORKS |
| 10 | ACP with an empty `KIMI_CODE_HOME` (logged out): `initialize`, then `session/new` | `initialize` succeeds (its `authMethods` entry carries the `KIMI_CODE_HOME`); **`session/new` answers JSON-RPC error `-32000` `Authentication required`**; stderr carries one JSON log line (`acp: auth readiness probe failed ... no provider configured`). This is a **free, non-model auth probe**: the process was ended by `timeout` after the replies | WORKS |
| 11 | ACP `session/new` with `mcpServers: [{"name":"echo","command":"/bin/cat","args":[],"env":[]}]` | Accepted (same result keys). Whether the server started and its tools were exposed was not observed (needs `/mcp` or a prompt) | WORKS (accepted); exposure NOT_RUN |
| 12 | ACP `session/list` with `cwd` | `sessions[]` with `sessionId`, `cwd`, `title` (null), `updatedAt`; both probe sessions are listed, so an empty `session/new` **is persisted** (a probe leaves session records in the data directory) | WORKS |
| 13 | ACP `session/set_mode` with an unknown `sessionId` | `-32602` `Invalid params: Unknown sessionId` | WORKS |

## Not observed (each needs a model call; the only channel cannot make one until its `kimi` line is fixed)

| Cell | Why it matters | Where it is settled |
| --- | --- | --- |
| `stream-json` record shapes, terminal record, usage, where the session id appears | T4.63 parser fixtures | T4.63 parses tolerantly from the documented message kinds; T4.68 captures real lines |
| `kimi -p` exit codes (success, failure, deny-rule, SIGINT) | Failure classification | T4.63 (documented: non-zero on failure), T4.68 |
| `session/request_permission` round trip in `default` mode; what `toolCall` carries (tool name, arguments) | The restricted path ([ADR-0049](../adr/0049-kimi-code-transport-and-bypass-class.md)) | T4.68; if it fails, restricted profiles become `Ineligible` and Kimi is privileged-only |
| Git-write denial by `Bash(git commit*)` deny rules; matching of wrappers | FR-GIT-01 | Declared `none-documented` (T4.67); T4.68 |
| OS sandbox | Confinement profiles | None in `--help`, ACP `modes` or the docs: profiles needing one are `Ineligible` |
| Per-run MCP tool exposure and workspace trust in `-p`/ACP | FR-GIT-02, FR-POL-04 | T4.68 |
| Capacity in output, telemetry, self-update in a headless run | FR-CAP-01 | T4.68 / T6.x |

## Follow-ups for the operator

1. **Fixed (2026-10-15, 16:51 UTC).** `~/operator-runs/live-run.sh` first compiled `kimi -m <model> --plan -p`, which
   Kimi rejects (run 1, above). It now compiles `kimi -m <model> --agent-file <read-only agent with tools Read, Grep>
   --output-format stream-json -p "<prompt>"` (`-p` is never-ask, so the agent's tool list is the only brake and this
   form must not be used with a writable tool set). A validation run with the fixed form succeeded (exit 0, 5 s) and
   its `stream-json` output is the capture for the T4.63 fixtures.
2. The per-task budget for `kimi-b1-validate` is exhausted (2 of 2 runs used: the rejected `--plan` run and the
   successful fixed-form run). Further Kimi live runs need a new task id and a fresh check of `live-usage.sh`; do not
   retry under this id.

## Follow-up 2 (2026-10-16, live-run.sh)

Two more runs through the budgeted channel (task id `w690-kimi-t468`, purpose `pre-check`, 2 of 2 used; Delegated agent
work, not owner-approved), to capture the `stream-json` records T4.63 had only assumed: an assistant record carrying
`tool_calls`, the tool record that answers it, and what the CLI prints and exits with when the tool call fails. Same
binary (`2.1.1`), same model alias, same compiled form as follow-up 1 (`kimi -m <model> --agent-file <read-only agent:
tools Read, Grep> --output-format stream-json -p "<prompt>"`, stdin from `/dev/null`, 120 s timeout, scratch cwd). The
scratch directory held one file, `w690/probe.txt`, with the single line `probe-ok-690`. No bypass flag was passed.

| # | Prompt (scoped question) | Observed | Exit, duration | Verdict |
| --- | --- | --- | --- | --- |
| 14 | Read `w690/probe.txt` with the Read tool, reply with its first line | 5 records: `meta` `system.version`; `assistant` with **`tool_calls`** (one item: `type` `function`, `id` `tool_<24 chars>`, `function.name` `Read`, `function.arguments` a **JSON string** `{"path":"w690/probe.txt","n_lines":1}`) and no `content`; **`tool`** with `tool_call_id` (the same id) and `content` `1\tprobe-ok-690` (line-numbered, tab-separated); `assistant` `content` `probe-ok-690`; `meta` `session.resume_hint` (`session_id`, `command`, `content`) as the last line | 0, 8 s | WORKS; T4.63's tool-record Assumption HELD |
| 15 | Read `w690/does-not-exist.txt` with the Read tool; if it fails, reply with the exact error text | Same five record kinds in the same order. The failure is visible **only as the `tool` record's text**: `content` `"w690/does-not-exist.txt" does not exist.`; the `assistant` echoed it. **No error record of any kind, no `meta` other than version and hint, no stderr line in the log, and the turn still ended with the resume hint** | **0**, 17 s | WORKS; a failed tool call is not a failed turn (exit 0) |

Findings for the adapter (`src/adapters/kimi/adapter.ts`, `protocol.ts`), replayed offline in
`src/adapters/kimi/live-capture.test.ts` from the scrubbed captures `src/adapters/kimi/fixtures/captured_tool_call.jsonl`
and `captured_tool_error.jsonl`:

- The parser reads both captures as intended today: `tool_call` (`tool` `read`, `name` `Read`, `target` from `path`),
  `message`, `session_bound`, `result ok`; `extractResult` with exit 0 returns `ok: true` with the assistant text as
  the summary. No `it.fails` was needed; no parser change is made in this follow-up.
- A tool-level failure under `-p` is indistinguishable from tool output at the stream level (the `tool` record is
  untrusted and never an event, by design); the run's outcome is whatever the model says next. The process-level exit
  code of a **failed turn** (provider error, auth failure, SIGINT) is still unobserved: both runs exited 0.
- Neither run printed a usage, model or terminal `result` record (as in follow-up 1), so FR-CAP-01 for `-p` output
  stays unobserved.
- `function.arguments` is a JSON **string** (the OpenAI-style form the parser already accepts first); the `id` prefix
  is `tool_`; `Read` takes `path` and an optional `n_lines`.

Scrubbing: the two session ids were replaced by `session_00000000-0000-0000-0000-000000000468` and `...469`, and the
two tool-call ids by `tool_000000000000000000000001` and `...002` (same lengths). The logs' two header lines (the
channel's own timestamp, model, purpose, task id and reason) are not part of the stream and are omitted. Nothing in
either stream named a path under the home directory, an account or a credential.

What this channel cannot reach, so these stay **Operator** cells of T4.68: its `kimi` line is `-p` (Never Ask) with a
read-only agent file, so the `default`-mode ACP `session/request_permission` round trip, Git-write denial (a deliberate
`git commit` attempt through a Shell tool), per-run MCP tool exposure, the live malicious leg (NFR-SEC-03) and
`switchboard adapters validate kimi` (FR-OPS-02) were not and cannot be run here. No further run was made under this
task id (no retry, no `final-verify`).
