/**
 * Antigravity CLI (`agy`) surface used by the Antigravity adapter (T4.32, TDD §4.4). Every spelling is cited to a TDD
 * §4.4 source tag ([H] headless, [I] install, [TS] troubleshooting; Google's documentation, retrieved 2026-10-13), to
 * the T4.31 live checks ([LIVE]: `docs/research/live-checks-2026-10-14-antigravity.md`, `agy` 1.3.4), or marked
 * **Assumption**. Keep every native spelling in this file so a later capture touches one place. The manifest range
 * admits no version, so none of this runs until `adapters validate` passes a version (ADR-0009, T4.4).
 */

/** Binary name ([H], [I]; [LIVE] C1). */
export const AGY_BINARY = "agy";

/** Version command ([I]; [LIVE] C1: prints the bare version `1.3.4`, exit 0). */
export const VERSION_ARGS: readonly string[] = ["--version"];

/** Help ([LIVE] C2: `agy --help` exit 0 and lists every flag below). */
export const HELP_FLAG = "--help";

/**
 * Headless prompt ([H] `-p`, aliases `--print`, `--prompt`; [LIVE] C2). Compiled as one word `--prompt=<prompt>`, so a
 * prompt that starts with `-` can never be read as a flag. **Assumption**: the `=` form is accepted (the parser's
 * errors, `flags provided but not defined: -output-format`, [LIVE] C3, read like Go's `flag` package, which accepts
 * it); if `-p` were a boolean the word fails to parse and the run fails closed.
 */
export const PROMPT_FLAG = "--prompt";

/** Output format flag and value ([H]; [LIVE] C4: NDJSON `stream-json`, exit 0). */
export const OUTPUT_FORMAT_FLAG = "--output-format";
export const OUTPUT_STREAM_JSON = "stream-json";

/**
 * The bypass-class flag compiled only for an approved privileged scope with `bypass` ([H] "Auto-approve all tool
 * permission requests"; `init.permission_mode` becomes `always-proceed`; ADR-0017). Not run in the live check (rule).
 */
export const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";

/** Resume by explicit id ([H] `--conversation <id>`; [LIVE] C9). `-c`/`--continue` is never used. */
export const CONVERSATION_FLAG = "--conversation";

/** Flags the probe requires in `agy --help` ([LIVE] C2 lists each). */
export const REQUIRED_HELP_FLAGS: readonly string[] = [
  PROMPT_FLAG,
  OUTPUT_FORMAT_FLAG,
  SKIP_PERMISSIONS_FLAG,
  CONVERSATION_FLAG,
];

/** Never self-update during a run ([TS]; [LIVE] C12: accepted, no new updater files). */
export const DISABLE_AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

/**
 * Native login: `agy` signs in when launched without arguments ([LIVE] C3c: "Launch the CLI without arguments to sign
 * in"). Switchboard never starts it.
 */
export const AGY_LOGIN_COMMAND = "agy";

/**
 * FR-GIT-01 declaration ([P]; [LIVE] C8 not run). Deny rules such as `command(git commit)` exist only in `settings.json`
 * or the `/permissions` scopes, none per run, and the adapter writes no configuration; whether deny rules survive
 * `--dangerously-skip-permissions` was not observed.
 */
export const GIT_WRITE_CONTROL_DETAIL =
  "Deny rules for Git writes are documented only as settings.json or /permissions entries ([P]), none per run; the " +
  "adapter writes no configuration, and whether they hold under --dangerously-skip-permissions was not observed " +
  "(T4.31 C8 not run). Remaining controls: Switchboard's own tool-call guard (ADR-0039), ref snapshots and violation " +
  "handling (FR-GIT-03, M9) and keeping push credentials out of the agent's environment (FR-GIT-06).";

/** Why every non-privileged profile is Ineligible (TDD §4.4.2, Q-63). */
export const NON_PRIVILEGED_UNSUPPORTED_DETAIL =
  "Antigravity profiles other than an approved privileged bypass scope are not compiled: toolPermission is a " +
  "settings.json value with no per-run flag (TDD §4.4.2), init.permission_mode was request-review in every run of the " +
  "2026-10-14 live check (agy 1.3.4) including --sandbox and --mode=plan, and a repository's .agents MCP server and " +
  "hook ran with no approval (Q-63, FR-POL-02, FR-POL-08)";

/**
 * `stream-json` lines ([H]; [LIVE] C4, C7, C9, C10): each is `{"event": ...}`. `init` carries `conversation_id` and
 * `init.{cwd,tools,permission_mode,model?}`; `step_update` carries `step_index`, `state`, `step_type`, `text_delta`,
 * `tool_name`, `tool_info.{name,parameters,output,error}`; `result` nests the `json` envelope under `result`.
 */
export const EVENT = { init: "init", stepUpdate: "step_update", result: "result" } as const;

/** `step_type` of a tool call ([H]; [LIVE] C4, C7); other step types are ignored steps, not unknown lines. */
export const STEP_TOOL = "tool";

/** The one success `status` ([H] §4.4.1); every other value is a failure. */
export const STATUS_SUCCESS = "SUCCESS";

/**
 * Prefixes of the envelope's `error` text observed in the live check ([LIVE] C10: invalid model; C6, C13: logged
 * out). An observation of 1.3.4, not a contract; anything else is `unknown` (TOOL_FAILURE).
 */
export const ERROR_MODEL_PREFIX = "invalid model selection";
export const ERROR_AUTH_PREFIX = "authentication failed";

/** `usage` keys of the envelope ([H]; [LIVE] C4). `total_tokens` > 0 is part of the success rule (Q-86). */
export const USAGE_KEYS: readonly string[] = [
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "cache_read_tokens",
  "total_tokens",
];
