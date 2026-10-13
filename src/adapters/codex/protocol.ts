/**
 * Codex CLI surface used by the Codex adapter (T2.2, TDD §4.2). Every string here is either cited to R2
 * (docs/research/headless-ai-coding-controller-verified-2026-10-12.md) / TDD §4.2, or marked **Assumption**.
 * The codex binary was not installed on the development host, so no Assumption has been checked against a real CLI;
 * the shipped manifest's empty version range keeps the adapter ineligible until an operator validates a version
 * (ADR-0009). Keep every native spelling in this file so verification against an installed CLI touches one place.
 */

/** Binary name. R2 "Verified provider adapter design" (adapter matrix: `codex exec`). */
export const CODEX_BINARY = "codex";

/** Automation subcommand. R2 adapter matrix and Codex paragraph: "OpenAI's documented scripting command is `codex exec`". */
export const EXEC_SUBCOMMAND = "exec";

/** Native JSONL output. R2 adapter matrix: "`--json` emits JSONL events"; TDD §4.2 "Structured output". */
export const JSON_FLAG = "--json";

/** Resume subcommand under `exec`. R2 adapter matrix: "`codex exec resume <SESSION_ID>` or `--last`"; TDD §4.2. */
export const RESUME_SUBCOMMAND = "resume";

/** Sandbox flag. R2 adapter matrix / Codex paragraph: "Explicit `--sandbox workspace-write` or stricter policy". */
export const SANDBOX_FLAG = "--sandbox";

/** Writable-worktree sandbox value. R2 adapter matrix: `--sandbox workspace-write`. */
export const SANDBOX_WORKSPACE_WRITE = "workspace-write";

/**
 * Read-only sandbox value. **Assumption**: R2 says only "`workspace-write` or stricter"; the spelling `read-only` is
 * not in R2 and TDD §4.2 says "Read-only sandbox value spelling: to be verified". Verify against `codex exec --help`.
 */
export const SANDBOX_READ_ONLY = "read-only";

/**
 * Harness-control flags. R2 adapter matrix ("use `--ignore-user-config`/`--ignore-rules` for controlled harnesses") and
 * the trust-profile section ("explicit sandboxing with `--ignore-user-config` and `--ignore-rules`"); TDD §4.2.
 * **Assumption**: that `--ignore-rules` also suppresses repository `AGENTS.md`-style instructions (FR-POL-04); R2 does
 * not say what "rules" covers.
 */
export const IGNORE_USER_CONFIG_FLAG = "--ignore-user-config";
export const IGNORE_RULES_FLAG = "--ignore-rules";

/**
 * FR-GIT-01 declaration. R2 documents no Codex per-command deny or allow rule: the adapter matrix ("Explicit `--sandbox
 * workspace-write` or stricter policy; use `--ignore-user-config`/`--ignore-rules` for controlled harnesses") and the
 * Codex paragraph name only the sandbox and the two harness-control flags, and R2 names no Codex commit or attribution
 * setting. **Assumption** (unverified, live smoke check X-G1): `workspace-write` also blocks writes to a worktree's Git
 * directory, which lives outside the cwd under the main repository's `.git/worktrees/`; R2 does not say so.
 */
export const GIT_WRITE_CONTROL_DETAIL =
  "R2 documents no Codex per-command deny or allow rule and no commit or attribution setting; the documented controls " +
  "are `--sandbox` (read-only for inspect-untrusted or a read-only workspace, workspace-write for edit-untrusted and " +
  "trusted-development with shell broad), `--ignore-user-config` and " +
  "`--ignore-rules`. Whether workspace-write keeps the agent from writing the worktree's Git directory (outside the " +
  "cwd) is an Assumption, unverified on this host (codex not installed; live smoke test). R2 documents no way to " +
  "stop Codex running commands inside its sandbox, so a `git commit` or `git push` attempt is limited only by the " +
  "sandbox; a non-empty shell allowlist is not compiled. Whether the sandbox keeps those commands away from Codex " +
  "credentials (~/.codex) and other same-user files is unverified (owner decision 10, R-23, FR-POL-06 open; live " +
  "check T3.9). Remaining controls: ref snapshots and " +
  "violation handling (FR-GIT-03, M9) and keeping push credentials out of the agent's environment (FR-GIT-06).";

/** **Assumption**: `codex --version` prints a version line (not in R2). Used by probe only. */
export const VERSION_FLAG = "--version";

/** **Assumption**: `--help` exists on `codex exec` and lists its flags (not in R2). Used by probe only. */
export const HELP_FLAG = "--help";

/**
 * Native login instruction surfaced with AUTH_REQUIRED (FR-AUTH-02). Never executed by Switchboard.
 * **Assumption**: R2 says Codex supports ChatGPT-subscription login with cached credentials but does not spell the
 * command; `codex login` exists in codex-cli 0.162.1 (`codex login --help` and `login status`, live-checks-2026-10-13)
 * but running it was not observed.
 */
export const CODEX_LOGIN_COMMAND = "codex login";

/**
 * Arguments of the status command run by the auth preflight. Observed (docs/research/live-checks-2026-10-13.md,
 * codex-cli 0.162.1): `codex login --help` lists `status` ("Show login status").
 */
export const CODEX_LOGIN_STATUS_ARGS = ["login", "status"] as const;

/** **Proposed**: short wall-clock bound for the status command, so a hung CLI fails closed to UNKNOWN. */
export const AUTH_STATUS_TIMEOUT_MS = 5_000;

/** **Proposed**: the only part of the status output that is logged, truncated (the format is undocumented). */
export const AUTH_STATUS_LINE_MAX = 80;

/**
 * Auth preflight. Observed (docs/research/live-checks-2026-10-13.md, codex-cli 0.162.1): `codex login status` exits 0
 * when logged in and 1 when not; only the exit code and the first output line were observed and the output format is
 * undocumented, so the adapter keys on the exit code alone. Any other exit code, timeout or spawn failure is UNKNOWN
 * (ineligible, NFR-SEC-06) and carries this instruction. Switchboard never reads `~/.codex/auth.json`.
 */
export const AUTH_UNKNOWN_REASON =
  "`codex login status` gave no usable answer (not exit 0 or 1, timed out, or could not start), and Switchboard " +
  "never reads Codex credential files. Check that `codex login status` runs on its own, log in natively with " +
  `\`${CODEX_LOGIN_COMMAND}\` if needed, and validate the adapter (\`switchboard adapters validate codex\`, FR-OPS-02).`;

/**
 * JSONL event and item vocabulary. R2 says only that `--json` emits "thread, turn, item, error, and token-usage
 * events". **Assumption**: every exact type string and field name below (`thread.started`/`thread_id`,
 * `turn.started`, `turn.completed`/`usage`, `turn.failed`/`error.message`, `item.started`/`item.updated`/
 * `item.completed` with `item.type`, `error`/`message`), and every item type and field.
 */
export const EVENT = {
  threadStarted: "thread.started",
  turnStarted: "turn.started",
  turnCompleted: "turn.completed",
  turnFailed: "turn.failed",
  itemStarted: "item.started",
  itemUpdated: "item.updated",
  itemCompleted: "item.completed",
  error: "error",
} as const;

/** **Assumption**: item types (`item.type`) and their fields; none is named in R2. */
export const ITEM = {
  agentMessage: "agent_message", // { text }
  reasoning: "reasoning", // dropped: provider reasoning is never persisted (NFR-PRIV-02)
  commandExecution: "command_execution", // { command, status }
  fileChange: "file_change", // { changes: [{ path, kind }], status }
  mcpToolCall: "mcp_tool_call", // { server, tool, status }
  webSearch: "web_search", // { query }
  todoList: "todo_list", // planning bookkeeping, not an observable action
  error: "error", // { message, code? }
} as const;

/** **Assumption**: item `status` value meaning the action was refused by approval policy. */
export const STATUS_DECLINED = "declined";

/**
 * **Assumption**: errors carry a structured `code` string (on `error` events and on `turn.failed.error`). R2 documents
 * no Codex error categories. Classification reads only this structured field, never the free-text message
 * (FR-ADP-04); an error without a recognised code maps to category `unknown` -> TOOL_FAILURE, never success.
 * Values map onto the shared `provider_error.category` vocabulary in failure.ts.
 */
export const ERROR_CODE_CATEGORIES: Readonly<Record<string, string>> = {
  unauthorized: "auth",
  rate_limit_exceeded: "rate_limit",
  usage_limit_exceeded: "quota",
  server_overloaded: "overloaded",
  model_not_found: "model_unavailable",
  sandbox_denied: "sandbox",
  permission_denied: "permission",
};
