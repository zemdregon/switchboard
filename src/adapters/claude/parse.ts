/**
 * Claude Code `--output-format stream-json` parser (T2.2, FR-ADP-04, LLD §2 parsing rules).
 *
 * Documented facts this relies on ([R2] = docs/research/headless-ai-coding-controller-verified-2026-10-12.md, adapter
 * matrix and "Claude Code" notes; TDD §4.1):
 * - `stream-json` is a realtime stream of JSON documents, one per line (installed `claude --help`: "stream-json
 *   (realtime streaming)").
 * - The final stream result carries session metadata including `session_id` ([R2]; TDD §4.1). The JSON result can
 *   report `total_cost_usd`, which is a client-side estimate ([R2] capacity section).
 * - The structured error stream distinguishes categories such as `rate_limit`, `overloaded`, authentication, billing
 *   and server failures ([R2] failure section).
 *
 * Assumption (not stated in [R2], TDD or `--help`; to be confirmed by the live conformance subset, FR-OPS-02): the
 * per-event shapes below — `type` of `system` (subtype `init`, carrying `session_id`, `model`), `assistant` and `user`
 * (with `message.content[]` blocks of `text` / `tool_use` / `tool_result`), `result` (with `subtype`, `is_error`,
 * `result`, `session_id`, `usage`, `total_cost_usd`, `num_turns`, `duration_ms`, `permission_denials[]`), an
 * `error` string on assistant/result events naming the category, and `rate_limit_event` (with `rate_limit_info`).
 * The exact category strings in CLAUDE_ERROR_CATEGORIES and the tool names in TOOL_KINDS are also Assumptions.
 * Anything unrecognized becomes an `unknown` event (counted, never trusted).
 *
 * T6.11 (docs/research/limit-captures-2026-10-17.md): the only real limit captured was in text mode ("You've hit your
 * weekly limit · resets 12pm (UTC)", exit 1; a reset hour with no date). The `rejected` `rate_limit_event` shape above
 * is still an Assumption from a synthetic fixture.
 *
 * ADR-0081 (captured 2026-10-21, `docs/research/claude-usage-capture-2026-10-21.md`): every run emits an `allowed`
 * `rate_limit_event` whose `unifiedWindows` carry the account's 5-hour and 7-day used share and reset; they become a
 * `provider_reported` `usage` event (`./usage.ts`).
 */
import { GIT_RULE_COMMAND_MAX_CHARS, gitDenyRuleSecurityReason } from "../git-write.js";
import type { DenialClass, NormalizedEvent, ParseState } from "../types.js";
import { claudeUsageMetrics } from "./usage.js";

type Json = Record<string, unknown>;

const MAX_TEXT_CHARS = 4000; // Proposed bound for message/summary text (NormalizedEvent `message` is bounded).

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bound = (s: string): string => (s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS)}…` : s);

/**
 * Native error category -> normalized `provider_error.category` (keys of PROVIDER_ERROR_CATEGORY_CODES in
 * ../failure.ts). Category families per [R2]; the literal strings are an Assumption. Unlisted values pass through
 * verbatim and therefore classify as TOOL_FAILURE, never success.
 */
export const CLAUDE_ERROR_CATEGORIES: Readonly<Record<string, string>> = {
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  overloaded_error: "overloaded",
  server_error: "overloaded", // [R2] lists server failures beside overload; both are provider-side, retryable (LLD §4)
  authentication_failed: "auth",
  authentication_error: "auth",
  billing_error: "quota", // Proposed: a billing failure means the account cannot spend, not a transient throttle
};

/** Assumption: Claude Code built-in tool names. Only `Read`, `Edit` and `Bash` appear in the installed `--help`. */
const TOOL_KINDS: Readonly<Record<string, "read" | "edit" | "shell">> = {
  Read: "read",
  Grep: "read",
  Glob: "read",
  LS: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "shell",
};

function bindSession(e: Json, state: ParseState): NormalizedEvent[] {
  const id = str(e.session_id);
  if (id === undefined || state.nativeSessionId !== undefined) return [];
  state.nativeSessionId = id;
  const model = str(e.model);
  return [{ kind: "session_bound", nativeSessionId: id, ...(model ? { model } : {}) }];
}

function errorEvent(e: Json): NormalizedEvent[] {
  const native = str(e.error);
  if (native === undefined) return [];
  return [{ kind: "provider_error", category: CLAUDE_ERROR_CATEGORIES[native] ?? native, message: native }];
}

function toolCall(block: Json): NormalizedEvent {
  const name = str(block.name) ?? "unknown";
  const tool = TOOL_KINDS[name] ?? "other";
  const input = obj(block.input);
  // Record the file target for read/edit tools only. A shell command line travels as the transient `command`, which
  // `startAdapterRun` evaluates (ADR-0039) and drops before the event is stored.
  const target = tool === "read" || tool === "edit" ? (str(input?.file_path) ?? str(input?.path)) : undefined;
  const command = tool === "shell" ? str(input?.command) : undefined;
  return { kind: "tool_call", tool, name, ...(target ? { target } : {}), ...(command ? { command } : {}) };
}

/** Proposed bound on remembered `Bash` commands per parse; past it a `rule` denial finds no command (fail closed). */
const MAX_REMEMBERED_COMMANDS = 4096;

/** ADR-0072 follow-up: remember a `Bash` tool_use's command by id so a later `rule` denial of it can be classified. */
function rememberBashCommand(block: Json, state: ParseState): void {
  const id = str(block.id);
  const command = str(obj(block.input)?.command);
  if (str(block.name) !== "Bash" || id === undefined || command === undefined) return;
  if (command.length > GIT_RULE_COMMAND_MAX_CHARS) return;
  state.claudeBashCommands ??= new Map();
  if (state.claudeBashCommands.size >= MAX_REMEMBERED_COMMANDS) state.claudeBashCommands.clear();
  state.claudeBashCommands.set(id, command);
}

function assistantEvents(e: Json, state: ParseState): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const raw of arr(obj(e.message)?.content)) {
    const block = obj(raw);
    if (!block) continue;
    const t = str(block.type);
    if (t === "text") {
      const text = str(block.text);
      if (text) out.push({ kind: "message", role: "assistant", text: bound(text) });
    } else if (t === "tool_use") {
      rememberBashCommand(block, state);
      out.push(toolCall(block));
    }
    // Other block types (e.g. thinking) are dropped: observable facts only, no reasoning text (NFR-PRIV-02).
  }
  return [...out, ...errorEvent(e)];
}

function usageEvent(e: Json): NormalizedEvent[] {
  const metrics: Record<string, number | string | null> = {};
  // total_cost_usd is a client-side estimate ([R2]); it is recorded as reported, never as remaining quota.
  for (const k of ["total_cost_usd", "num_turns", "duration_ms", "duration_api_ms"]) {
    const v = e[k];
    if (typeof v === "number") metrics[k] = v;
  }
  for (const [k, v] of Object.entries(obj(e.usage) ?? {})) {
    if (typeof v === "number" || typeof v === "string") metrics[`usage.${k}`] = v;
  }
  return Object.keys(metrics).length > 0 ? [{ kind: "usage", source: "provider_reported", metrics }] : [];
}

/**
 * `system` / `permission_denied` (C-10; Claude Code 2.1.294, 2026-10-14, [live-checks-2026-10-14-claude-codex.md]): emitted
 * when a tool call is denied, with top-level `tool_name`, `tool_use_id`, `decision_reason_type`, `message`. The final
 * `result` event repeats the denial in `permission_denials`; the `tool_use_id` is remembered so it is reported once.
 */
function systemDenialEvents(e: Json, state: ParseState): NormalizedEvent[] {
  const id = str(e.tool_use_id);
  if (id !== undefined) {
    state.claudeDeniedToolUseIds ??= new Set();
    state.claudeDeniedToolUseIds.add(id);
  }
  const tool = str(e.tool_name) ?? "unknown";
  const command = id !== undefined ? state.claudeBashCommands?.get(id) : undefined;
  if (id !== undefined) state.claudeBashCommands?.delete(id);
  const denial = claudeDenialClass(tool, str(e.decision_reason_type), command);
  return [...bindSession(e, state), { kind: "permission_denied", tool, ...(denial ? { denial } : {}) }];
}

/**
 * ADR-0072: the class of a `system/permission_denied` event from its `decision_reason_type` (values seen on claude
 * 2.1.294 in the operator's run streams, 2026-10-20; the `message` text is never read):
 * - `mode` on `Bash`: a command no allow rule admits, denied by `--permission-mode dontAsk` -> `profile` (recoverable).
 *   `mode` on any other tool is left unclassified: a file-tool write to Git or settings files that `--restricted`
 *   reserves for a person would be denied the same way.
 * - `rule`: a `--disallowedTools` rule matched; Switchboard passes only the FR-GIT-01 Git deny rules. ADR-0072
 *   follow-up (Linus, 2026-10-20): on `Bash`, the denied `tool_use`'s command is checked by
 *   {@link gitDenyRuleSecurityReason}; when every Git invocation in it is a read or a local ref verb (`git branch -a`,
 *   `git log`) -> `git_rule_local` (recoverable). Otherwise (push, remote, config, `gh`, `-C`/`--git-dir`, ..., or no
 *   command found or parsed) -> `git_write`.
 * - `subcommandResults`: a compound or single shell command one of whose parts a deny rule matched (the part's own
 *   reason is not reported; seen for Git and `gh` deny rules, for example `git branch -a --contains <sha>` in
 *   run_01M5D74KSXB5VVC4FZD0D3Q92C). Treated exactly like `rule`: on `Bash` the whole denied command is checked by
 *   {@link gitDenyRuleSecurityReason}, so every part must be a Git read or local ref verb for `git_rule_local`;
 *   anything else, including no Git invocation, no command found, or another tool -> `git_write` (fails the run).
 * - `other`: seen only for a file tool outside the working directory (`--restricted` confinement) -> `outside_worktree`.
 * - anything else -> unclassified, which fails the run (fail closed).
 * A `result.permission_denials` entry with no `system` event before it carries no reason and stays unclassified.
 */
export function claudeDenialClass(tool: string, reason: string | undefined, command?: string): DenialClass | undefined {
  if (reason === "mode") return tool === "Bash" ? "profile" : undefined;
  if (reason === "rule" || reason === "subcommandResults") {
    return tool === "Bash" && gitDenyRuleSecurityReason(command) === undefined ? "git_rule_local" : "git_write";
  }
  if (reason === "other") return "outside_worktree";
  return undefined;
}

function resultEvents(e: Json, state: ParseState): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  out.push(...usageEvent(e));
  for (const raw of arr(e.permission_denials)) {
    const d = obj(raw);
    const id = str(d?.tool_use_id);
    if (id !== undefined && state.claudeDeniedToolUseIds?.has(id)) continue; // already reported from system/permission_denied
    out.push({ kind: "permission_denied", tool: str(d?.tool_name) ?? "unknown" });
  }
  out.push(...errorEvent(e));
  const subtype = str(e.subtype);
  const ok = subtype === "success" && e.is_error === false;
  const text = str(e.result);
  const summary = ok ? text : (subtype ?? text);
  out.push({ kind: "result", ok, ...(summary ? { summary: bound(summary) } : {}) });
  return out;
}

function rateLimitEvents(e: Json): NormalizedEvent[] {
  const info = obj(e.rate_limit_info);
  // ADR-0081: the window figures are recorded whatever the status; only `rejected` is a limit signal.
  const metrics = claudeUsageMetrics(info);
  const usage: NormalizedEvent[] = metrics ? [{ kind: "usage", source: "provider_reported", metrics }] : [];
  const status = str(info?.status);
  if (status !== "rejected") return usage; // allowed / warning states are informational
  const resetsAt = info?.resetsAt;
  const resetAt = typeof resetsAt === "number" ? new Date(resetsAt * 1000).toISOString() : str(resetsAt);
  const reportedCategory = str(info?.rateLimitType);
  return [
    ...usage,
    { kind: "rate_limit", ...(resetAt ? { resetAt } : {}), ...(reportedCategory ? { reportedCategory } : {}) },
  ];
}

/** One stdout line -> zero or more normalized events. Unparseable lines yield nothing (the supervisor fails the run). */
export function parseClaudeLine(line: string, state: ParseState): NormalizedEvent[] {
  state.lines += 1;
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return [];
  }
  const e = obj(doc);
  if (!e) return [];
  const type = str(e.type);
  const subtype = str(e.subtype);
  switch (type) {
    case "system":
      if (subtype === "init") return bindSession(e, state);
      if (subtype === "permission_denied") return systemDenialEvents(e, state);
      break;
    case "assistant":
      return [...bindSession(e, state), ...assistantEvents(e, state)];
    case "user":
      // Tool results: observable outcome is already captured by tool_call + result/permission_denials.
      return bindSession(e, state);
    case "result":
      return [...bindSession(e, state), ...resultEvents(e, state)];
    case "rate_limit_event":
      return [...bindSession(e, state), ...rateLimitEvents(e)];
    default:
      break;
  }
  state.unknownEvents += 1;
  return [{ kind: "unknown", rawType: subtype ? `${type ?? "none"}:${subtype}` : (type ?? "none") }];
}
