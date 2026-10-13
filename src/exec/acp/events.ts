/**
 * Shared mapping from ACP messages to `NormalizedEvent`s (LLD §2 "Mapping to NormalizedEvent", ADR-0036 item 8.2 and
 * 8.3; T4.8). An `acp-stdio` adapter's `parseEvent` calls {@link mapAcpMessage} for the `session/update` notifications
 * and the final `session/prompt` response the client hands it, so every ACP adapter maps the same way. Variant and
 * field names are from the ACP specification v1 ([ACP-PT], [ACP-TC], retrieved 2026-10-13, cited in ADR-0036); real
 * providers' use of them is Unverified until each operator capture.
 */
import type { AcpMessage, AcpParseState, ExitInfo, NormalizedEvent, ParseState } from "../../adapters/types.js";

/** Proposed bounds (same as the Claude Code parser's text bound). */
export const ACP_MAX_MESSAGE_CHARS = 4000;
export const ACP_MAX_NAME_CHARS = 200;
export const ACP_MAX_TARGET_CHARS = 512;

/** JSON-RPC error code ACP uses for `auth_required` ([ACP-SCH] `ErrorCode`). */
export const ACP_AUTH_REQUIRED_CODE = -32000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bound = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function acpState(state: ParseState): AcpParseState {
  state.acp ??= { deniedToolCallIds: new Set<string>() };
  return state.acp;
}

/** Ends the message being joined, if any. */
export function flushAcpMessage(state: ParseState): NormalizedEvent[] {
  const s = acpState(state);
  const m = s.message;
  s.message = undefined;
  if (m === undefined || m.text === "") return [];
  return [{ kind: "message", role: "assistant", text: m.text }];
}

/** `tool_call` kinds to the four `NormalizedEvent` tools (ADR-0036 item 8.2). */
export function acpToolKind(kind: unknown): "read" | "edit" | "shell" | "other" {
  switch (kind) {
    case "read":
    case "search":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "execute":
      return "shell";
    default:
      return "other";
  }
}

/**
 * The event for a JSON-RPC error object: `-32000` (or an `auth_required` error) is `AUTH_REQUIRED` (category `auth`,
 * naming the native login command, FR-AUTH-02); any other code is `provider_error` with the code as category.
 */
export function acpErrorEvent(error: unknown, loginCommand: string): NormalizedEvent {
  const e = isObj(error) ? error : {};
  const code = typeof e.code === "number" ? e.code : undefined;
  const message = str(e.message) ?? "";
  const authRequired = code === ACP_AUTH_REQUIRED_CODE || message === "auth_required" || e.data === "auth_required";
  if (authRequired) {
    return { kind: "provider_error", category: "auth", message: `authentication required: run ${loginCommand}` };
  }
  return {
    kind: "provider_error",
    category: code === undefined ? "acp_error" : String(code),
    message: bound(message, ACP_MAX_MESSAGE_CHARS),
  };
}

function usageMetrics(u: Json): Record<string, number | string | null> {
  const metrics: Record<string, number | string | null> = {};
  if (typeof u.used === "number") metrics.used = u.used;
  if (typeof u.size === "number") metrics.size = u.size;
  if (typeof u.cost === "number") metrics.cost = u.cost;
  else if (isObj(u.cost)) {
    if (typeof u.cost.amount === "number") metrics.cost_amount = u.cost.amount;
    if (typeof u.cost.currency === "string") metrics.cost_currency = bound(u.cost.currency, 16);
  }
  return metrics;
}

function sessionUpdate(update: Json, state: ParseState): NormalizedEvent[] {
  const s = acpState(state);
  const variant = str(update.sessionUpdate);
  switch (variant) {
    case "agent_message_chunk": {
      const content = isObj(update.content) ? update.content : {};
      const text = content.type === "text" ? (str(content.text) ?? "") : "";
      const id = str(update.messageId);
      const out = s.message !== undefined && s.message.id !== id ? flushAcpMessage(state) : [];
      if (s.message === undefined) s.message = { id, text: "", truncated: false };
      const m = s.message;
      if (!m.truncated) {
        const joined = m.text + text;
        m.truncated = joined.length > ACP_MAX_MESSAGE_CHARS;
        m.text = bound(joined, ACP_MAX_MESSAGE_CHARS);
      }
      return out;
    }
    // NFR-PRIV-02: reasoning text is never an event; it stays in the raw artifact only.
    case "agent_thought_chunk":
    case "user_message_chunk":
      return [];
    case "tool_call":
    case "tool_call_update": {
      const out = flushAcpMessage(state);
      const id = str(update.toolCallId);
      const name = str(update.name) ?? str(update.title) ?? variant;
      const loc =
        Array.isArray(update.locations) && isObj(update.locations[0]) ? str(update.locations[0].path) : undefined;
      // A `tool_call_update` without a kind keeps `other`: the update may change only the status.
      out.push({
        kind: "tool_call",
        tool: acpToolKind(update.kind),
        name: bound(name, ACP_MAX_NAME_CHARS),
        ...(loc ? { target: bound(loc, ACP_MAX_TARGET_CHARS) } : {}),
        ...(id !== undefined && s.deniedToolCallIds.has(id) ? { denied: true } : {}),
      });
      return out;
    }
    case "usage_update":
      return [...flushAcpMessage(state), { kind: "usage", source: "provider_reported", metrics: usageMetrics(update) }];
    default:
      // `plan`, `available_commands_update`, `config_option_update`, `session_info_update`, `current_mode_update`
      // (checked by the client, ADR-0036 item 10) and any variant v1 does not name: recorded, never trusted.
      state.unknownEvents += 1;
      return [...flushAcpMessage(state), { kind: "unknown", rawType: bound(variant ?? "none", 64) }];
  }
}

/**
 * Maps one ACP message the client passes on: a `session/update` notification, or the `session/prompt` response
 * (`result.stopReason`, or an error). Anything else gives an `unknown` event.
 */
export function mapAcpMessage(msg: AcpMessage, state: ParseState, loginCommand = "the provider's login command") {
  state.lines += 1;
  if (msg.method === "session/update") {
    const params = isObj(msg.params) ? msg.params : {};
    return sessionUpdate(isObj(params.update) ? params.update : {}, state);
  }
  if (msg.method === undefined && msg.error !== undefined) {
    return [...flushAcpMessage(state), acpErrorEvent(msg.error, loginCommand)];
  }
  if (msg.method === undefined && isObj(msg.result) && typeof msg.result.stopReason === "string") {
    const stopReason = msg.result.stopReason;
    const out = flushAcpMessage(state);
    // ADR-0036 item 8.3: only `end_turn` succeeds; `cancelled` the controller asked for ends CANCELLED by the run outcome.
    out.push(
      stopReason === "end_turn"
        ? { kind: "result", ok: true }
        : { kind: "result", ok: false, summary: `stop reason: ${bound(stopReason, 64)}` },
    );
    return out;
  }
  state.unknownEvents += 1;
  return [...flushAcpMessage(state), { kind: "unknown" as const, rawType: bound(msg.method ?? "response", 64) }];
}

/**
 * Whether an `acp-stdio` run succeeded (ADR-0036 item 8.3 and 8.4): the client ended the turn (`exited`, whatever the
 * exit status or signal of the kill that followed the result), the last `result` is `ok`, and no event denied,
 * failed or broke the sandbox. Anything else goes to the adapter's `classifyFailure`.
 */
export function acpRunSucceeded(events: readonly NormalizedEvent[], exit: ExitInfo): boolean {
  const final = events.findLast((e) => e.kind === "result");
  return (
    exit.outcome === "exited" &&
    final?.kind === "result" &&
    final.ok &&
    !events.some((e) => e.kind === "provider_error" || e.kind === "permission_denied" || e.kind === "sandbox_violation")
  );
}
