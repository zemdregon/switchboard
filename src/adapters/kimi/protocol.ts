/**
 * Kimi Code CLI surface used by the Kimi Code adapter (T4.62, TDD §4.7, ADR-0049). Every spelling is cited to a TDD §4.7
 * source tag ([K1] command reference, [K4] configuration, [K5] MCP, [K10] environment variables and data locations;
 * Kimi Code documentation retrieved 2026-10-13, listed in `docs/research/kimi-code-spike-2026-10-13.md`), to the T4.61
 * live checks ([LIVE] row: `docs/research/live-checks-2026-10-15-kimi.md`, Kimi Code CLI 2.1.1), to the scrubbed
 * `stream-json` capture of that check's validation run ([CAP], below), or marked
 * **Assumption**. Keep every native spelling in this file so a later capture (T4.68) touches one place. The manifest
 * range admits no version, so none of this runs until `adapters validate` passes a version (ADR-0009, T4.4).
 */

/** Binary name ([K1]; [LIVE] Environment: `kimi` under `~/.kimi-code/bin/`). */
export const KIMI_BINARY = "kimi";

/** Version command ([K1] `-V, --version`; [LIVE] 1: prints `2.1.1`, exit 0). */
export const VERSION_ARGS: readonly string[] = ["--version"];

/** Help ([LIVE] 2: `--help` exit 0 and lists every flag below and the `acp` subcommand). */
export const HELP_FLAG = "--help";

/**
 * One-shot prompt ([K1], [LIVE] 2: `-p, --prompt <prompt>`). Always Never Ask, so bypass-class (ADR-0049 item 1):
 * compiled only for an approved `privileged` scope that sets `bypass`. The long spelling is used, as one word
 * `--prompt=<prompt>`, so a prompt that starts with `-` is never read as a flag. **Assumption** (T4.68): the `=` form
 * is accepted; [LIVE] 2 shows the two-word form only. If it is not, the run fails at argument parsing (fail closed).
 */
export const PROMPT_FLAG = "--prompt";

/** Output format flag and value ([K1]; [LIVE] 2: `--output-format text|stream-json`, "for prompt mode"). */
export const OUTPUT_FORMAT_FLAG = "--output-format";
export const OUTPUT_STREAM_JSON = "stream-json";

/**
 * Model alias ([K1], [LIVE] 2: `-m, --model <alias>`). Compiled as one word `--model=<alias>` (same **Assumption** as
 * {@link PROMPT_FLAG}); the ACP path sets the session's `model` config option instead ([LIVE] 9).
 */
export const MODEL_FLAG = "--model";

/**
 * Resume a named session ([K1], [LIVE] 2: `-S, --session [id]`). `-c`/`--continue` is never used: it names no session.
 * Compiled as two words `--session <id>` (the help's form); the id is checked to start with a letter or digit first, so
 * it is never read as a flag. The `kimi -r <id>` named in the [CAP] resume hint is not in the 2.1.1 help and is not used.
 */
export const SESSION_FLAG = "--session";

/** ACP server subcommand ([K1], [LIVE] 4: `kimi acp`; its `--login` flag is never passed, the client never logs in). */
export const ACP_SUBCOMMAND = "acp";

/** Flags the probe requires in `kimi --help` ([LIVE] 2 lists each). */
export const REQUIRED_HELP_FLAGS: readonly string[] = [PROMPT_FLAG, OUTPUT_FORMAT_FLAG, MODEL_FLAG, SESSION_FLAG];

/** Native login command named on `AUTH_REQUIRED` ([K1] `kimi login`; [LIVE] 4). */
export const KIMI_LOGIN_COMMAND = "kimi login";

/**
 * Auth preflight (T4.64, ADR-0049 item 4): no status command exists ([LIVE] 2, 6), so the probe is `kimi acp` sent
 * `initialize` (id {@link AUTH_PROBE_INITIALIZE_ID}) then `session/new` (id {@link AUTH_PROBE_SESSION_ID}) on stdin.
 * Logged in, `session/new` returns a `sessionId` ([LIVE] 9); logged out, `initialize` still succeeds and `session/new`
 * answers JSON-RPC `-32000` `Authentication required` ([LIVE] 10). Neither needs a model call. **Assumption**
 * (Unverified: T4.68): both requests may be written before the `initialize` reply. Stdin is held open until a reply
 * for each id has arrived (or the probe timeout), because the 2026-10-17 `adapters validate kimi` run on 2.1.1 ended
 * `session/new missing, exit 0` when stdin was closed straight after writing ([LIVE] 10 had held it until `timeout`).
 */
export const AUTH_PROBE_INITIALIZE_ID = 1;
export const AUTH_PROBE_SESSION_ID = 2;
export const ACP_METHOD_INITIALIZE = "initialize";
export const ACP_METHOD_SESSION_NEW = "session/new";

/**
 * ACP session modes ([LIVE] 9: `session/new` lists `default` "Manual approvals; tools execute normally.", `plan`
 * "Read-only planning; no tool execution.", `auto` "Auto-approve safe operations.", `yolo` "Auto-approve everything.";
 * `currentModeId` `default`). `auto` and `yolo` are bypass-class (ADR-0049 item 2; registry `acp` declaration).
 */
export const ACP_MODE_PLAN = "plan";
export const ACP_MODE_DEFAULT = "default";
export const ACP_BYPASS_MODES: readonly string[] = ["auto", "yolo"];

/** ACP config option ids ([LIVE] 9: `configOptions` for `model`, `thinking` and `mode`). */
export const ACP_CONFIG_MODE = "mode";
export const ACP_CONFIG_MODEL = "model";

/**
 * `stream-json` records (T4.63). [CAP] is the one scrubbed capture of a successful `-p` run (CLI 2.1.1, the T4.61
 * validation run of live-checks follow-up 1, exit 0; reproduced as `fixtures/captured_success.jsonl`):
 * `{"role":"meta","type":"system.version","version":"2.1.1"}`, then `{"role":"assistant","content":"ok"}`, then
 * `{"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>","command":…,"content":…}` as the last line.
 * No usage, model or terminal `result` record was printed. [K1] documents assistant messages, assistant messages carrying
 * `tool_calls`, and tool messages; their field names below are an **Assumption** (OpenAI-style chat records, the shape
 * the captured assistant record follows) until T4.68 captures a tool call.
 */
export const ROLE = { assistant: "assistant", tool: "tool", meta: "meta" } as const;
/** [CAP] line 1: the CLI version, carries no run state. */
export const META_VERSION = "system.version";
/**
 * [CAP] line 3: the resume hint, with the session id in `session_id`. It was the last line of the one recorded run, so
 * the parser treats it as the end of the turn (**Assumption**, T4.68: whether a failed turn prints it too is unobserved,
 * so success also needs exit 0).
 */
export const META_RESUME_HINT = "session.resume_hint";
/** Field of the resume hint that carries the session id ([CAP]). */
export const RESUME_HINT_SESSION_KEY = "session_id";
/** Assistant field carrying tool calls ([K1] "Assistant messages carrying `tool_calls`"); item shape **Assumption**. */
export const TOOL_CALLS_KEY = "tool_calls";
/**
 * Error records: none observed. **Assumption** (fail closed): a `meta` record whose `type` is `error` or ends in `.error`
 * is a provider error, its text in `message` or `content`.
 */
export const META_ERROR_RE = /(^|\.)error$/;
/**
 * Message prefix read as a login failure: the ACP `session/new` error text `Authentication required` ([LIVE] 10).
 * Whether `-p` prints the same text is **Unverified: T4.68**.
 */
export const ERROR_AUTH_PREFIX = "Authentication required";

/**
 * FR-GIT-01 declaration (ADR-0049 item 5; TDD §4.7 "Git writes and injected tools"). Deny rules exist only in
 * `config.toml` under `KIMI_CODE_HOME` ([K4], [K10]); editing the user's configuration is forbidden and their matching of
 * compound commands is unobserved (T4.68), so no deny rule is compiled.
 */
export const GIT_WRITE_CONTROL_DETAIL =
  "No per-run permission-rule flag exists (Kimi Code CLI 2.1.1 --help, 2026-10-15 live check); deny rules live in the " +
  "user's config.toml, which Switchboard never edits, and their matching was not observed (T4.68). `kimi -p` never " +
  "asks, so it is compiled only in an approved privileged bypass run (ADR-0049). On the ACP path the controller answers " +
  "every session/request_permission under its tool-call guard, which refuses Git writes; that round trip is " +
  "Unverified: T4.68. Remaining controls: the tool-call guard (ADR-0039), ref snapshots and violation handling " +
  "(FR-GIT-03, M9) and keeping push credentials out of the agent's environment (FR-GIT-06).";

/** Why every non-privileged profile is Ineligible today (Delegated, T4.62; TDD §4.7, ADR-0049 item 3). */
export const NON_PRIVILEGED_UNSUPPORTED_DETAIL =
  "Kimi Code has no OS sandbox or network control ([K1] to [K10]; observed absent in the 2026-10-15 live check, " +
  "CLI 2.1.1), so network `off` and sandboxed profiles cannot be held; and the project's .kimi-code/mcp.json stdio " +
  "servers start at session start once the workspace is trusted ([K5]), with no per-run flag to disable repository " +
  "configuration and workspace trust under ACP unobserved (T4.68), so repository configuration `disabled` cannot be " +
  "held either (FR-POL-02, FR-POL-04, ADR-0049 item 3)";
