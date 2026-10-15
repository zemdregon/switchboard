/**
 * OpenCode CLI surface used by the OpenCode adapter (T4.52, TDD §4.6). Every spelling is cited to a TDD §4.6 source tag
 * ([D-cli], [D-perm]; OpenCode's documentation, retrieved 2026-10-13), to the T4.51 live checks ([LIVE]:
 * `docs/research/live-checks-2026-10-14-opencode.md`, `opencode v2.0.23`), or marked **Assumption**. Keep every native
 * spelling in this file so a later capture touches one place. The manifest range admits no version, so none of this
 * runs until `adapters validate` passes a version (ADR-0009, T4.4).
 */

/** Binary name ([D-cli], [LIVE] Environment: `opencode` under `~/.opencode/bin/`). */
export const OPENCODE_BINARY = "opencode";

/** Version command ([LIVE] 1: `opencode --version`, exit 0, `v2.0.23`). */
export const VERSION_ARGS: readonly string[] = ["--version"];

/** Help of the run command ([LIVE] 1: `opencode run --help`, exit 0; lists the flags below). */
export const RUN_HELP_ARGS: readonly string[] = ["run", "--help"];

/** The headless run command ([D-cli] `opencode run [message..]`; [R2] L78). */
export const RUN_COMMAND = "run";

/** Output format flag and value ([D-cli]; [LIVE] 1, 4c: `--format default|json`, one JSON object per line). */
export const FORMAT_FLAG = "--format";
export const FORMAT_JSON = "json";

/**
 * Private server for this run ([LIVE] 1, 2d, ESCAPED: `--standalone` "runs a private server instead" of the host's
 * shared background `opencode serve --service`). Without it the tools run inside that long-lived service, outside the
 * run's process group, environment allowlist, timeouts and cancel (FR-EXE-03), so it is always emitted.
 */
export const STANDALONE_FLAG = "--standalone";

/** Resume by explicit id ([D-cli] `--session`/`-s`; [LIVE] 13a, 15a). `--continue` is never used ([LIVE] 13b). */
export const SESSION_FLAG = "--session";

/**
 * End of options before the prompt. **Assumption** (not in [D-cli] or the [LIVE] help capture): the conventional `--`
 * makes a prompt that starts with `-` a positional message; a T4.58 check must confirm it.
 */
export const END_OF_OPTIONS = "--";

/** Flags the probe requires in `opencode run --help` ([LIVE] 1 lists each). */
export const REQUIRED_HELP_FLAGS: readonly string[] = [FORMAT_FLAG, STANDALONE_FLAG, SESSION_FLAG];

/**
 * Environment set by the adapter ([D-cli] names it; [LIVE] "Unverified": its effect was not exercised, so it is a
 * request, not a control the adapter relies on).
 */
export const DISABLE_AUTOUPDATE_ENV = "OPENCODE_DISABLE_AUTOUPDATE";

/** Native login command named on `AUTH_REQUIRED` ([D-cli] `opencode auth login`; never run by Switchboard). */
export const OPENCODE_LOGIN_COMMAND = "opencode auth login";

/**
 * Auth status (T4.54, Q-10, Q-64; [D-cli] `opencode auth list` "lists all the authenticated providers as stored in the
 * credentials file"; [LIVE] 2a to 2f). It exits 0 in every state, so the JSON decides: an array whose entries hold a
 * connection of a type other than an environment one is `OK` (**Assumption**: the type of a stored login was not
 * recorded, only that environment-only providers show `environment` or `env`); an empty array, or environment-only
 * connections (a run gets no provider key, so they would not apply), is `AUTH_REQUIRED`; anything else is `UNKNOWN`.
 * `--standalone` keeps the call off the host's shared service ([LIVE] 2c, 2d). Never `auth export` (prints secrets).
 */
export const AUTH_STATUS_ARGS: readonly string[] = ["auth", "list", "--format", "json", "--standalone"];
export const AUTH_ENV_CONNECTION_TYPES: readonly string[] = ["env", "environment"];
export const AUTH_STATUS_TIMEOUT_MS = 15_000;

/**
 * FR-GIT-01 declaration ([D-perm], [LIVE] 7, 14d, ESCAPED). `bash` deny patterns are documented, but on v2.0.23 no
 * per-run deny took effect: `OPENCODE_PERMISSION` and `OPENCODE_CONFIG_CONTENT` denials did not deny a `read`, a
 * recognised deny in config failed tool runs with a 403 instead of refusing the tool, and with default permissions
 * `git commit`, `git -C . commit`, `env git commit`, `sh -c 'git commit'` and `git push` all ran (Q-64).
 */
export const GIT_WRITE_CONTROL_DETAIL =
  "`bash` deny patterns are documented ([D-perm]), but on opencode v2.0.23 (2026-10-14 live check) no per-run deny " +
  "took effect and every Git-write spelling ran with default permissions, so no deny rule is declared or emitted " +
  "(Q-64, ADR-0039). Remaining controls: Switchboard's own tool-call guard (ADR-0039), ref snapshots and violation " +
  "handling (FR-GIT-03, M9) and keeping push credentials out of the agent's environment (FR-GIT-06).";

/** Why every non-privileged profile is Ineligible today (Q-64; TDD §4.6.4). */
export const NON_PRIVILEGED_UNSUPPORTED_DETAIL =
  "OpenCode profiles other than an approved privileged bypass scope are not compiled: in the 2026-10-14 live check " +
  "(opencode v2.0.23) no per-run deny took effect (OPENCODE_PERMISSION and OPENCODE_CONFIG_CONTENT were ignored, a " +
  "recognised deny failed the run with a 403), the default ran shell commands including git commit and git push, no " +
  "sandbox is documented, and a repository's opencode.json and AGENTS.md load (Q-64, TDD §4.6.4, FR-POL-02, FR-POL-06)";

/**
 * `--format json` event types observed in the 2026-10-14 live check ([LIVE] 4c; opencode v2.0.23). Every event carries
 * `type`, `timestamp`, `sessionID` and `part`. Only the fields named below are read.
 */
export const EVENT = {
  stepStart: "step_start",
  text: "text",
  toolUse: "tool_use",
  stepFinish: "step_finish",
  error: "error",
} as const;

/** `step_finish.part.reason` of the final step ([LIVE] 4c, 5: `stop`; `tool-calls` ends an intermediate step). */
export const REASON_STOP = "stop";

/**
 * `tool_use.part.tool` of the shell tool ([LIVE] 6a: `shell`, not `bash`) and the file tools ([LIVE] 4c). `bash` is
 * **Assumption** (fail closed): it is the name OpenCode's permission keys use ([D-perm]; [LIVE] note 7), so a stream
 * that names the shell tool `bash` still reaches the tool-call guard. The adapter also treats any other tool name whose
 * input carries a string `command` as a shell tool (see `parseEvent`).
 */
export const TOOL_KINDS: Readonly<Record<string, "read" | "edit" | "shell">> = {
  read: "read",
  write: "edit",
  edit: "edit",
  shell: "shell",
  bash: "shell",
};

/**
 * `error.type` values observed ([LIVE] 14a `provider.no-route`, 14b `provider.quota`, 14d `provider.auth`) and the
 * shared category each maps to. 14d's `provider.auth` was a 403 on a free tier, not a missing login, but an auth error
 * is the safe reading (the run fails either way). Others are `unknown` (TOOL_FAILURE).
 */
export const ERROR_TYPE_CATEGORIES: Readonly<Record<string, string>> = {
  "provider.no-route": "model_unavailable",
  "provider.quota": "quota",
  "provider.auth": "auth",
};

/** `step_finish.part.tokens` keys ([LIVE] 4c) and the metric names they are recorded under. */
export const TOKEN_KEYS: readonly (readonly [path: readonly string[], metric: string])[] = [
  [["input"], "input"],
  [["output"], "output"],
  [["reasoning"], "reasoning"],
  [["cache", "read"], "cache_read"],
  [["cache", "write"], "cache_write"],
];
