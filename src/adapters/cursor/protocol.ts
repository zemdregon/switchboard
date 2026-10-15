/**
 * Cursor CLI surface used by the Cursor adapter (T4.42, TDD §4.5). Every spelling is cited to a TDD §4.5 source tag
 * ([C1] CLI parameters, [C2] output format, [C10] run modes and sandboxing; Cursor's documentation, fetched
 * 2026-10-13), to the T4.41 live checks ([LIVE]: `docs/research/live-checks-2026-10-14-cursor.md`, Cursor CLI
 * 2026.10.12-d47ca18), or marked **Assumption**. Keep every native spelling in this file so a later capture touches one
 * place. The manifest range admits no version, so none of this runs until `adapters validate` passes a version
 * (ADR-0009, T4.4).
 */

/**
 * Binary name ([LIVE] "Naming trap": `cursor-agent`; on the operator's host `agent` in a login shell is Grok Build's
 * binary, so the adapter never resolves the bare name `agent`).
 */
export const CURSOR_BINARY = "cursor-agent";

/** Version command ([C1] `-v, --version`; [LIVE] 1a: prints `2026.10.12-d47ca18`, exit 0). */
export const VERSION_ARGS: readonly string[] = ["--version"];

/** Help ([LIVE] 2a: `--help` exit 0 and lists every flag below). */
export const HELP_FLAG = "--help";

/** Print (headless) mode ([C1] `-p, --print`; the long spelling, so no short flag reaches the argv). */
export const PRINT_FLAG = "--print";

/** Output format flag and value ([C1], [C2]; [LIVE] 5b: NDJSON `stream-json`, exit 0). */
export const OUTPUT_FORMAT_FLAG = "--output-format";
export const OUTPUT_STREAM_JSON = "stream-json";

/**
 * Workspace trust ([C1] "Trust the workspace without prompting (headless mode only)"; [LIVE] 10a: a headless run in an
 * untrusted workspace exits 1 without it; 10c: once trusted, the repository's `AGENTS.md` and `.cursor/rules` load).
 * Emitted only after the controller's own trust decision: an approved bypass scope whose `repository_config` is
 * `enabled` (owner decision 26).
 */
export const TRUST_FLAG = "--trust";

/** The bypass-class flag compiled only for an approved privileged scope with `bypass` ([C1] `-f, --force`; ADR-0017). */
export const FORCE_FLAG = "--force";

/**
 * Sandbox switch ([C1] `--sandbox enabled|disabled`). Not emitted by T4.42: `enabled` exits 1 on the operator's host
 * ([LIVE] 9, AppArmor user-namespace restriction) and what `--force` does to it was not observed (TDD §4.5.1).
 * `disabled` is a declared bypass-class value (registry entry, ADR-0037).
 */
export const SANDBOX_FLAG = "--sandbox";

/** Resume by explicit id ([C1] `--resume [chatId]`; [LIVE] 8a to 8c: same `session_id`). `--continue` is never used. */
export const RESUME_FLAG = "--resume";

/** Flags the probe requires in `cursor-agent --help` ([LIVE] 2a lists each). */
export const REQUIRED_HELP_FLAGS: readonly string[] = [
  PRINT_FLAG,
  OUTPUT_FORMAT_FLAG,
  TRUST_FLAG,
  FORCE_FLAG,
  RESUME_FLAG,
  SANDBOX_FLAG,
];

/** Native login command named on `AUTH_REQUIRED` ([C1] `login`; [LIVE] 4: the CLI's own message names `agent login`). */
export const CURSOR_LOGIN_COMMAND = "cursor-agent login";

/**
 * Auth status (T4.44, Q-10, Q-65; [C1], [C5] `status`/`whoami` with `--format text|json`; [LIVE] 3a to 3c). The exit code
 * is 0 logged in and logged out, so only the JSON key `isAuthenticated` decides: `true` is `OK`, `false` is
 * `AUTH_REQUIRED`, anything else (no JSON, no boolean, another exit code, a timeout) is `UNKNOWN` (fail closed). The
 * object also carries account fields (`userInfo`: email, user id, names): the adapter reads the one boolean and never
 * puts any of the output into a reason, log or event. The logged-out state was observed with an empty scratch `HOME`,
 * not after a real `logout` ([LIVE] "Unverified / not run").
 */
export const AUTH_STATUS_ARGS: readonly string[] = ["status", "--format", "json"];
export const AUTH_STATUS_KEY = "isAuthenticated";
export const AUTH_STATUS_TIMEOUT_MS = 10_000;

/**
 * FR-GIT-01 declaration ([C6], [LIVE] 11). A `permissions.deny` rule in a controller-written `CURSOR_CONFIG_DIR` file
 * denied `git commit` in the live check, but it needs a config file, the CLI rewrites that file, the operator's global
 * rules and MCP servers still load, and the match form (command prefix) was not tested against `git -C . commit` or an
 * absolute path. T4.42 writes no configuration, so no deny rule is compiled.
 */
export const GIT_WRITE_CONTROL_DETAIL =
  "No per-run permission flag is documented ([C6]); deny rules live in a config file. A `Shell(git commit)` deny in a " +
  "scratch CURSOR_CONFIG_DIR held in the 2026-10-14 live check (Cursor CLI 2026.10.12-d47ca18), but whether the rule " +
  "is a command-prefix match (Q-62) was not tested and the adapter writes no configuration, so no deny rule is " +
  "declared. Remaining controls: Switchboard's own tool-call guard (ADR-0039), ref snapshots and violation handling " +
  "(FR-GIT-03, M9) and keeping push credentials out of the agent's environment (FR-GIT-06).";

/** Why every non-privileged profile is Ineligible today (Q-65; TDD §4.5.4). */
export const NON_PRIVILEGED_UNSUPPORTED_DETAIL =
  "Cursor profiles other than an approved privileged bypass scope are not compiled: in the 2026-10-14 live check " +
  "(Cursor CLI 2026.10.12-d47ca18) edits applied without --force, so there is no read-only control; --sandbox enabled " +
  "exited 1 on the operator's host and its confinement was never observed; a headless run needs --trust to start, " +
  "after which the repository's AGENTS.md and rules load; and the operator's global rules and MCP servers load in " +
  "every run (Q-65, TDD §4.5.4, FR-POL-02, FR-POL-06)";

/**
 * `stream-json` event types and fields observed in the 2026-10-14 live check ([LIVE] 5b, 7a, 7b, 11; [C2]). Only these
 * fields are read. `thinking` lines carry the model's reasoning and are dropped (NFR-PRIV-02; [LIVE] contradicts [C2],
 * they are emitted on every run); `user` echoes the prompt and is dropped.
 */
export const EVENT = {
  system: "system",
  user: "user",
  thinking: "thinking",
  assistant: "assistant",
  toolCall: "tool_call",
  result: "result",
} as const;

/** `system` subtype carrying the session id, the model display name and the credential source ([LIVE] 5b). */
export const SUBTYPE_INIT = "init";
/** `tool_call` subtypes ([C2]; [LIVE] 7a: `started` then `completed` per call). */
export const SUBTYPE_STARTED = "started";
export const SUBTYPE_COMPLETED = "completed";
/** `result.subtype` of a finished run ([LIVE] 5a, 5b). Not proof of success alone: a refused shell call keeps it (7a). */
export const SUBTYPE_SUCCESS = "success";

/** `init.apiKeySource` of the native login ([C2] `env|flag|login`; [LIVE] 5b: `login` on every run). */
export const API_KEY_SOURCE_LOGIN = "login";

/**
 * Keys of the `tool_call` object ([LIVE] 7a, 7b, 10c, 11) and the tool kind each maps to. Any other key is an `other`
 * tool named by its key (Assumption: [C2] names `writeToolCall` and a generic `function` shape, not observed).
 */
export const TOOL_KEYS: Readonly<Record<string, "read" | "edit" | "shell">> = {
  readToolCall: "read",
  editToolCall: "edit",
  writeToolCall: "edit",
  shellToolCall: "shell",
  bashToolCall: "shell",
  terminalToolCall: "shell",
  execToolCall: "shell",
  runCommandToolCall: "shell",
  executeCommandToolCall: "shell",
  editFileToolCall: "edit",
  writeFileToolCall: "edit",
};

/**
 * Refusal shapes of a completed tool call ([LIVE] 7a: `result.rejected` in the default mode; 11: `result.permissionDenied`
 * under a config deny). Neither changes the exit code or the final `result`, so they are the only evidence of a denial.
 */
export const TOOL_RESULT_REJECTED = "rejected";
export const TOOL_RESULT_PERMISSION_DENIED = "permissionDenied";
export const TOOL_RESULT_PERMISSION_DENIED_SNAKE = "permission_denied";
export const TOOL_RESULT_DENIED = "denied";
export const TOOL_RESULT_BLOCKED = "blocked";

/** `result.usage` keys ([LIVE] 5a: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`). */
export const USAGE_KEYS: readonly string[] = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
];

/**
 * Optional backing provider key ([LIVE] row 102 checked for `backing_provider`; none observed in native CLI).
 * Supported if structured output reports it, so a harness fronting another provider can satisfy T4.6 without
 * deriving a vendor from the model display name.
 */
export const BACKING_PROVIDER_KEY = "backing_provider";
