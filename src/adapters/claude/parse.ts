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
 */
import type { NormalizedEvent, ParseState } from "../types.js";

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
  // Record the file target for read/edit tools only; shell command text is not copied into events.
  const target = tool === "read" || tool === "edit" ? (str(input?.file_path) ?? str(input?.path)) : undefined;
  return { kind: "tool_call", tool, name, ...(target ? { target } : {}) };
}

function assistantEvents(e: Json): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const raw of arr(obj(e.message)?.content)) {
    const block = obj(raw);
    if (!block) continue;
    const t = str(block.type);
    if (t === "text") {
      const text = str(block.text);
      if (text) out.push({ kind: "message", role: "assistant", text: bound(text) });
    } else if (t === "tool_use") {
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

function resultEvents(e: Json): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  out.push(...usageEvent(e));
  for (const raw of arr(e.permission_denials)) {
    const d = obj(raw);
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
  const status = str(info?.status);
  if (status !== "rejected") return []; // allowed / warning states are informational
  const resetsAt = info?.resetsAt;
  const resetAt = typeof resetsAt === "number" ? new Date(resetsAt * 1000).toISOString() : str(resetsAt);
  const reportedCategory = str(info?.rateLimitType);
  return [{ kind: "rate_limit", ...(resetAt ? { resetAt } : {}), ...(reportedCategory ? { reportedCategory } : {}) }];
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
      break;
    case "assistant":
      return [...bindSession(e, state), ...assistantEvents(e)];
    case "user":
      // Tool results: observable outcome is already captured by tool_call + result/permission_denials.
      return bindSession(e, state);
    case "result":
      return [...bindSession(e, state), ...resultEvents(e)];
    case "rate_limit_event":
      return [...bindSession(e, state), ...rateLimitEvents(e)];
    default:
      break;
  }
  state.unknownEvents += 1;
  return [{ kind: "unknown", rawType: subtype ? `${type ?? "none"}:${subtype}` : (type ?? "none") }];
}
