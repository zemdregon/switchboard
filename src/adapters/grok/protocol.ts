/**
 * Grok Build CLI surface used by the Grok Build adapter (T4.22, TDD §4.3). Every spelling is cited to a TDD §4.3 source
 * tag ([CLI], [HL], [PERM], [SBX], [SET], [SESS]; xAI's documentation, retrieved 2026-10-13), to the T4.21 live checks
 * ([LIVE]: `docs/research/live-checks-2026-10-14-grok.md`, CLI version 1.0.50), or marked **Assumption**. Keep every native
 * spelling in this file so a later capture touches one place. The manifest range admits no version, so none of this
 * runs until `adapters validate` passes a version (ADR-0009, T4.4).
 */

/** Binary name ([CLI]: `grok`). */
export const GROK_BINARY = "grok";

/** Version command ([CLI] `grok version`; [LIVE] step 1: prints `grok <x.y.z> (<build>) [<channel>]`, exit 0). */
export const VERSION_ARGS: readonly string[] = ["version"];

/** Help ([LIVE] step 1: `grok --help` exit 0; lists the flags below except `--no-auto-update`). */
export const HELP_FLAG = "--help";

/** Headless prompt ([HL], [LIVE] step 1: `-p` is the short form of `--single` and takes a value). */
export const SINGLE_FLAG = "--single";

/** Output format flag and value ([CLI], [HL]; [LIVE] 4b: NDJSON `streaming-json` runs exit 0). */
export const OUTPUT_FORMAT_FLAG = "--output-format";
export const OUTPUT_STREAMING_JSON = "streaming-json";

/** Sandbox profile selection ([SBX], [LIVE] 7a to 7d: `strict`, `read-only` and `workspace` held for writes). */
export const SANDBOX_FLAG = "--sandbox";
export const SANDBOX_STRICT = "strict";
export const SANDBOX_READ_ONLY = "read-only";
export const SANDBOX_WORKSPACE = "workspace";

/** Permission rule flags ([PERM], [LIVE] 8c, 9: syntax accepted, deny wins, prefix match only). */
export const ALLOW_FLAG = "--allow";
export const DENY_FLAG = "--deny";

/** The bypass-class flag compiled only for an approved privileged scope with `bypass` ([CLI], [PERM]; ADR-0017). */
export const ALWAYS_APPROVE_FLAG = "--always-approve";

/**
 * Never self-update during a run (ADR-0009). Accepted by 1.0.50 although absent from `--help` ([LIVE] 4a), so it is
 * emitted but never required by the probe.
 */
export const NO_AUTO_UPDATE_FLAG = "--no-auto-update";

/** Resume ([CLI], [SESS], [LIVE] 6a: `-r <id>` returns the same `sessionId`; not tied to the directory, 14a). */
export const RESUME_FLAG = "--resume";

/** Flags the probe requires in `grok --help` ([LIVE] step 1 lists each). */
export const REQUIRED_HELP_FLAGS: readonly string[] = [
  SINGLE_FLAG,
  OUTPUT_FORMAT_FLAG,
  SANDBOX_FLAG,
  ALLOW_FLAG,
  DENY_FLAG,
  RESUME_FLAG,
];

/** Native login command named on `AUTH_REQUIRED` ([LIVE] 3c: the CLI's own message names `grok login --device-code`). */
export const GROK_LOGIN_COMMAND = "grok login";

/**
 * Auth status (T4.24, Q-10; [LIVE] steps 2b and 3b). `grok models` is the only observed status surface and its exit
 * code does not discriminate: it exits 0 logged in and logged out. Only the first stdout line does: `You are logged in
 * with grok.com.` or `You are not authenticated.` (CLI version 1.0.50). `grok inspect --json` carries no auth status ([LIVE]
 * 2a). The text is an observation of one version, not a documented contract, so only a first line that starts with one
 * of the two observed phrases decides; any other output, exit code or a timeout is `UNKNOWN` (fail closed).
 */
export const AUTH_STATUS_ARGS: readonly string[] = ["models"];
export const AUTH_LOGGED_IN_PREFIX = "You are logged in";
export const AUTH_LOGGED_OUT_PREFIX = "You are not authenticated";
export const AUTH_STATUS_TIMEOUT_MS = 10_000;
export const AUTH_STATUS_LINE_MAX = 80;

/**
 * FR-GIT-01 declaration. [LIVE] step 9: a `--deny 'Bash(git commit*)'` rule is a prefix match on the command string;
 * `git -C . commit` and `/usr/bin/git commit` created commits, so it is not a declared control (Q-62, ADR-0039).
 * `--always-approve` under a deny rule was not run ([LIVE] 9b).
 */
export const GIT_WRITE_CONTROL_DETAIL =
  "--deny 'Bash(<git subcommand>*)' rules are documented ([PERM]) and fire for the plain and `sh -c` forms, but they " +
  "match the command string by prefix: `git -C . commit` and `/usr/bin/git commit` created commits in the 2026-10-14 " +
  "live check (CLI version 1.0.50), so they are not a declared control (Q-62, ADR-0039). Whether a deny rule holds under " +
  "--always-approve was not observed. Remaining controls: Switchboard's own tool-call guard (ADR-0039), ref " +
  "snapshots and violation handling (FR-GIT-03, M9) and keeping push credentials out of the agent's environment " +
  "(FR-GIT-06).";

/** Why every non-privileged profile is Ineligible today (TDD §4.3.1 "Cells that change profile eligibility today"). */
export const NON_PRIVILEGED_UNSUPPORTED_DETAIL =
  "Grok Build profiles other than an approved privileged bypass scope are not compiled: the 2026-10-14 live check " +
  "(CLI version 1.0.50) found `--permission-mode dontAsk` did not deny a plain command without an allow rule, deny rules " +
  "are prefix matches, and the native login file is readable from inside `--sandbox strict` and `workspace` " +
  "(TDD §4.3.3, Q-62, FR-POL-02, FR-POL-06)";
