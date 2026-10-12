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

/** **Assumption**: `codex --version` prints a version line (not in R2). Used by probe only. */
export const VERSION_FLAG = "--version";

/** **Assumption**: `--help` exists on `codex exec` and lists its flags (not in R2). Used by probe only. */
export const HELP_FLAG = "--help";

/**
 * Native login instruction surfaced with AUTH_REQUIRED (FR-AUTH-02). Never executed by Switchboard.
 * **Assumption**: R2 says Codex supports ChatGPT-subscription login with cached credentials but does not spell the
 * command; `codex login` must be verified against the installed CLI.
 */
export const CODEX_LOGIN_COMMAND = "codex login";

/**
 * Auth preflight: R2 ("Compliance and authentication boundary") and TDD §4.2 state that saved auth is reused by
 * `codex exec` and that a dedicated status command is **not** documented. Per FR-AUTH-02 the adapter therefore
 * reports UNKNOWN (treated as ineligible, NFR-SEC-06) with this instruction rather than guessing or reading
 * `~/.codex/auth.json` (which R2 says must be treated like a password).
 */
export const AUTH_UNKNOWN_REASON =
  "Codex documents no auth status command (R2, TDD §4.2), and Switchboard never reads Codex credential files. " +
  `Log in natively with the Codex CLI (believed to be \`${CODEX_LOGIN_COMMAND}\`; unverified), then validate the ` +
  "adapter against the installed CLI (`switchboard adapters validate codex`, FR-OPS-02) before routing to Codex.";

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
