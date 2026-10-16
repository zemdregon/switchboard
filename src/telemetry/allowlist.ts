/**
 * Export-time span attribute allowlist (T8.4, FR-TEL-03, LLD §7, ADR-0012). Builders set only allowlisted keys by
 * construction; this filter is the defence-in-depth layer that drops every other key immediately before OTLP export.
 */

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

/** Inner-agent span attributes from LLD §13.8 (`run.id` and `session.id` are in the core list). */
const INNER_ATTRIBUTE_KEYS = [
  "inner.task",
  "inner.backend_kind",
  "inner.locality",
  "inner.template_version",
  "inner.model",
  "inner.outcome",
  "inner.reason",
  "inner.attempts",
  "inner.latency_ms",
  "inner.input_bytes",
  "inner.output_bytes",
  "inner.tokens_in",
  "inner.tokens_out",
  "inner.breaker_state",
] as const;

/**
 * The exact exported key set. Named keys come from LLD §7; the prose categories (durations, tool kind, counts,
 * token/usage numbers) are pinned to the concrete keys listed there (Delegated naming, 2026-10-16).
 */
export const ALLOWED_SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "run.id",
  "session.id",
  "provider",
  "adapter.version",
  "model",
  "trust_profile",
  "run.state",
  "failure.code",
  "retry.attempt",
  "transport",
  "duration_ms",
  "exit.code",
  "exit.signal",
  "tool.kind",
  "changed_files.count",
  "events.count",
  "usage.input_tokens",
  "usage.output_tokens",
  "usage.cache_read_tokens",
  "usage.cache_write_tokens",
  "route.eligible_count",
  "artifact.id",
  "artifact.sha256",
  "artifact.size_bytes",
  ...INNER_ATTRIBUTE_KEYS,
]);

/**
 * Returns a copy holding only allowlisted keys with scalar values; everything else is dropped silently (no log line,
 * since a dropped value may itself be forbidden text). Never throws. Returns `undefined` when nothing survives.
 */
export function allowlistedAttributes(attributes: unknown): SpanAttributes | undefined {
  if (attributes === null || typeof attributes !== "object") return undefined;
  const kept: Record<string, SpanAttributeValue> = {};
  let count = 0;
  try {
    for (const [key, value] of Object.entries(attributes)) {
      if (!ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key)) continue;
      if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        kept[key] = value;
        count++;
      }
    }
  } catch {
    // A throwing getter drops the whole attribute set: fail closed.
    return undefined;
  }
  return count > 0 ? kept : undefined;
}
