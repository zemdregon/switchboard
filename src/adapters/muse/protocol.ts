/**
 * Muse Code CLI surface used by the Muse Code adapter (T4.72, TDD §4.8). Every spelling is cited to a TDD §4.8 source
 * tag ([M-ext], [M-perm], [M-auth], [M-cfg], [M-int], [M-log], [M-ov], [SDK], [Orca]; retrieved 2026-10-13) with the
 * status §4.8 gives it (confirmed, corrected, reported), or marked **Assumption**. Nothing here comes from running the
 * CLI: no `muse` binary was installed or run (T4.71 is the operator capture; T4.72 module, T4.73 record kinds and
 * resume). Keep every native spelling in this file so
 * the capture touches one place. The manifest range admits no version, so none of this runs until `adapters validate`
 * passes a version (ADR-0009, T4.78).
 */

/** Binary name ([M-ov], confirmed). */
export const MUSE_BINARY = "muse";

/** Version command ([M-ov], confirmed; output format not given: "Muse Code 1.2.1 (1.2.1-R2847.1)" is reported [Orca]). */
export const VERSION_ARGS: readonly string[] = ["--version"];

/** Headless subcommand: one prompt to completion, then exit ([M-ext], [M-ov], confirmed). `muse` alone is the TUI. */
export const EXEC_SUBCOMMAND = "exec";

/** Help for the headless subcommand (TDD §4.8.1 items 6 and 11 read `muse exec --help`; layout `Unverified: T4.71`). */
export const HELP_ARGS: readonly string[] = [EXEC_SUBCOMMAND, "--help"];

/** JSONL events on stdout ([M-ext], confirmed; record kinds corrected by [SDK], spelling `Unverified: T4.71`). */
export const JSON_FLAG = "--json";

/** Approval mode and its values ([M-perm], confirmed): `on-request` is the default; `never` is bypass-class (§4.8). */
export const APPROVAL_MODE_FLAG = "--approval-mode";
export const APPROVAL_ON_REQUEST = "on-request";
export const APPROVAL_NEVER = "never";

/**
 * Sandbox network and its values ([M-perm], [M-log], corrected): `proxy-only` (default), `restricted` (no network),
 * `unrestricted` (full; bypass-class, §4.8); `enabled` is a deprecated alias whose target Meta does not state.
 */
export const SANDBOX_NETWORK_FLAG = "--sandbox-network";
export const SANDBOX_NETWORK_RESTRICTED = "restricted";
export const SANDBOX_NETWORK_UNRESTRICTED = "unrestricted";
export const SANDBOX_NETWORK_ENABLED_ALIAS = "enabled";

/**
 * Worktree mode, always `off` because the controller owns the worktree ([Orca], reported: `-w, --worktree
 * off|create|existing`; Meta's pages name `--worktree` without values [M-log], [M-ext]). Value spelling, the
 * `.muse/worktrees/` side effect and `.git`-file handling are `Unverified: T4.71`.
 */
export const WORKTREE_SHORT_FLAG = "-w";
export const WORKTREE_OFF = "off";

/**
 * Workspace trust ([M-log]): a headless first run in an untrusted workspace stops naming this flag; it "now only decides
 * whether the workspace's skills and rules load". Bypass-class (§4.8): emitted only in an approved bypass run with
 * repository configuration `enabled`.
 */
export const TRUST_WORKSPACE_FLAG = "--trust-workspace";

/** Bypass-class flags ([M-perm], [M-ext], confirmed): never emitted. `--yolo` is a shared `BYPASS_FLAGS` entry. */
export const YOLO_FLAG = "--yolo";
export const DISABLE_APPROVAL_FLAG = "--disable-approval";
export const DISABLE_SANDBOX_FLAG = "--disable-sandbox";

/**
 * Headless resume ([M-ext], corrected): `muse exec --session-id <uuid> "<prompt>"`. `--allow-workspace-switch` is never
 * emitted: the adapter's `resumeCwd` is `bound`, so a resume runs in the session's own worktree (T4.73, Delegated).
 */
export const SESSION_ID_FLAG = "--session-id";

/**
 * `muse exec --json` record kinds (T4.73). The `kind` field and `run_terminal` spelling are **reported** ([Orca]:
 * `{"kind":"run_terminal","terminal":"completed","text":"...","reason":null}`). The other spellings are an
 * **Assumption**: the snake_case of the [SDK] payload names (`RunStarted`, `RunOutputDelta`, `TaskLifecycle`,
 * `CommandAccepted`, `CommandResult`, `ModelConfigured`, `ToolResult`, `TurnInputUser`). All are `Unverified: T4.71`;
 * any other kind is an `unknown` event, counted and never success (the [SDK] reads unseen payloads as `Unknown`).
 */
export const RECORD = {
  runStarted: "run_started",
  runOutputDelta: "run_output_delta",
  runTerminal: "run_terminal",
  taskLifecycle: "task_lifecycle",
  commandAccepted: "command_accepted",
  commandResult: "command_result",
  modelConfigured: "model_configured",
  toolResult: "tool_result",
  turnInputUser: "turn_input_user",
} as const;

/** `run_terminal.terminal` of a completed run ([Orca], reported). Every other value, or none, is not success. */
export const TERMINAL_COMPLETED = "completed";

/**
 * **Assumption** field names, `Unverified: T4.71` (TDD §4.8 "Resume": how the controller learns the session id is not
 * sourced): `run_started.session_id` carries the session's uuid (the name follows `MUSE_SESSION_ID`, which Muse passes
 * to stdio MCP servers [M-ext]); `run_output_delta.text` carries assistant text.
 */
export const SESSION_ID_FIELD = "session_id";
export const DELTA_TEXT_FIELD = "text";

/** API key variable ([M-auth], confirmed): it hides a browser session, so it is never in the child environment. */
export const META_API_KEY_ENV = "META_API_KEY";

/**
 * Self-update switch, **reported** only ([Orca]); Meta's overview, interactive, configuration and changelog pages do not
 * mention it ([M-ov], [M-int], [M-cfg], [M-log]). Neither T4.70 (documentation) nor T4.71 (not run) confirmed that it
 * pins the version, so the adapter does NOT set it (TDD §4.8 "Version gate"); the name is kept so a test can say so.
 */
export const NO_AUTO_UPDATE_ENV = "MUSE_NO_AUTO_UPDATE";

/** Native login command named on `AUTH_REQUIRED` ([M-log]; reported [Orca]). */
export const MUSE_LOGIN_COMMAND = "muse login";

/**
 * Auth status (T4.74, Q-10; FR-AUTH-02; Grok T4.24 precedent).
 * Meta documents `muse auth set` and `muse logout` ([M-auth]; TDD §4.8), but no auth status command is documented
 * (TDD §4.8 "Auth preflight", Unverified: T4.71). `muse auth status` is an **Assumption** (pending T4.71; try
 * `muse auth --help` per TDD §4.8.1 item 3). Its exit code is assumed to be 0 for both states as Grok Build, keyed on
 * the first line of stdout: `Logged in` is OK, `Not logged in` is AUTH_REQUIRED naming the native login (both replies
 * are **Assumptions** pending T4.71). Any other first line, a non-zero exit, a timeout, empty output, null exit or a
 * spawn error is UNKNOWN (fail closed).
 */
export const AUTH_STATUS_ARGS: readonly string[] = ["auth", "status"];
export const AUTH_LOGGED_IN_PREFIX = "Logged in";
export const AUTH_LOGGED_OUT_PREFIX = "Not logged in";
export const AUTH_STATUS_TIMEOUT_MS = 10_000;
export const AUTH_STATUS_LINE_MAX = 80;

/** Flags the probe requires in `muse exec --help` (each confirmed or corrected by Meta's pages in TDD §4.8). */
export const REQUIRED_HELP_FLAGS: readonly string[] = [JSON_FLAG, APPROVAL_MODE_FLAG, SANDBOX_NETWORK_FLAG];

/** FR-GIT-01 detail (TDD §4.8 "Git writes", corrected): a sandbox property, not a per-command deny control. */
export const GIT_WRITE_CONTROL_DETAIL =
  "No per-command Git deny control is documented ([M-perm]); `.git`, `.muse` and `.agents` stay read-only inside the " +
  "writable workspace, a sandbox property that is not a FR-GIT-01 control and is unverified for a worktree whose " +
  "`.git` is a file (Unverified: T4.71). The controller's ref check (FR-GIT-03) and isolated worktree (FR-GIT-06) remain.";

/** Why the four non-`privileged` profiles do not compile (Grok T4.22 precedent; TDD §4.8). */
export const NON_PRIVILEGED_UNSUPPORTED_DETAIL =
  "Muse Code has no T4.71 results yet: whether --approval-mode holds with no TTY, what --sandbox-network restricted " +
  "blocks and whether home-directory skills can be suppressed are Unverified (TDD §4.8), so no control a " +
  "non-privileged profile needs is shown to hold (FR-POL-02)";
