/**
 * ACP JSON-RPC 2.0 envelope checks (ADR-0036 item 3, LLD §8.2 "Framing"; T4.8). Line splitting, the 1 MiB bound, strict
 * UTF-8 and JSON parsing are the JSONL reader's (`../jsonl.ts`), run by the supervisor with blank lines refused; this
 * module classifies each parsed line and encodes what the client writes. ACP v1 defines no batch, so an array is a
 * protocol error ([ACP-TR]: newline-delimited messages that "MUST NOT contain embedded newlines").
 */

export type AcpId = string | number;

export type AcpEnvelope =
  | { readonly kind: "request"; readonly id: AcpId; readonly method: string; readonly params: unknown }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "response"; readonly id: AcpId | null; readonly result?: unknown; readonly error?: unknown }
  | { readonly kind: "invalid"; readonly reason: AcpEnvelopeProblem };

export type AcpEnvelopeProblem = "batch" | "not_object" | "not_jsonrpc_2" | "bad_id" | "bad_method" | "bad_shape";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is AcpId => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** Classifies one parsed stdout line. Never throws. */
export function classifyEnvelope(value: unknown): AcpEnvelope {
  if (Array.isArray(value)) return { kind: "invalid", reason: "batch" };
  if (!isObj(value)) return { kind: "invalid", reason: "not_object" };
  if (value.jsonrpc !== "2.0") return { kind: "invalid", reason: "not_jsonrpc_2" };
  const hasId = Object.hasOwn(value, "id");
  if ("method" in value) {
    if (typeof value.method !== "string" || value.method === "") return { kind: "invalid", reason: "bad_method" };
    if ("result" in value || "error" in value) return { kind: "invalid", reason: "bad_shape" };
    if (!hasId) return { kind: "notification", method: value.method, params: value.params };
    if (!validId(value.id)) return { kind: "invalid", reason: "bad_id" };
    return { kind: "request", id: value.id, method: value.method, params: value.params };
  }
  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (!hasId || hasResult === hasError) return { kind: "invalid", reason: "bad_shape" };
  if (value.id !== null && !validId(value.id)) return { kind: "invalid", reason: "bad_id" };
  return hasResult
    ? { kind: "response", id: value.id as AcpId | null, result: value.result }
    : { kind: "response", id: value.id as AcpId | null, error: value.error };
}

/** One line the client writes: a message it built itself, JSON-encoded (never an embedded newline) plus `\n`. */
export function encodeMessage(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
}
