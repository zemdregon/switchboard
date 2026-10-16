/**
 * Span parent links (T8.3, FR-TEL-02, LLD §7, ADR-0012).
 *
 * The LLD §7 span tree is static: every span name has one parent name (or is a root). Spans reach the transport as
 * completed, fire-and-forget records (`CompletedSpan`), possibly before their parent completes, so the parent link
 * cannot be taken from a live parent span. Instead the trace id and the span ids of the spans that can be parents
 * (`controller.delegate`, `provider.spawn`) are derived from the run id by hashing: a child can name its parent's id
 * without the parent existing yet, and the ledger run id maps to exactly one trace. Spans that can occur more than once
 * per run get a random id. A span without a `run.id` attribute (or an explicit link) is exported as a root with random
 * ids (`inner.call` outside a run, LLD §7).
 *
 * Delegated design (2026-10-16, not owner-approved): ids are a one-way hash of the run id, so a trace id reveals nothing
 * about the run id, and nothing beyond the run id (no prompt, path or environment) enters the derivation.
 */
import { createHash, randomBytes } from "node:crypto";

/** LLD §7 span tree: the parent span name for each span name; `null` marks a root. */
export const SPAN_PARENTS: Readonly<Record<string, string | null>> = {
  "controller.delegate": null,
  "route.classify": "controller.delegate",
  "rag.retrieve": "controller.delegate",
  "provider.acquire_capacity": "controller.delegate",
  "workspace.create_checkpoint": "controller.delegate",
  "provider.spawn": "controller.delegate",
  "agent.tool.read": "provider.spawn",
  "agent.tool.edit": "provider.spawn",
  "agent.tool.shell": "provider.spawn",
  "provider.model_turn": "provider.spawn",
  "workspace.diff": "controller.delegate",
  "verification.tests": "controller.delegate",
  "run.finalize": "controller.delegate",
  "inner.call": "controller.delegate",
};

/** Span names that occur at most once per run and may be parents; their ids are derived, not random. */
const ANCHOR_SPANS: ReadonlySet<string> = new Set(
  Object.values(SPAN_PARENTS).filter((parent): parent is string => parent !== null),
);

/** W3C trace context identifiers as lowercase hex: 32 characters for a trace id, 16 for a span id. */
export interface SpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

function derivedId(label: string, bytes: number, ...parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(label);
  for (const part of parts) hash.update("\0").update(part);
  const id = hash.digest().subarray(0, bytes);
  // An all-zero id is invalid in W3C trace context; a SHA-256 prefix is never expected to be zero, but fail safe.
  if (id.every((byte) => byte === 0)) id[bytes - 1] = 1;
  return id.toString("hex");
}

/** The trace id of every span of one run: a one-way function of the run id. */
export function traceIdForRun(runId: string): string {
  return derivedId("switchboard.trace", TRACE_ID_BYTES, runId);
}

/** The span id of a once-per-run anchor span (`controller.delegate`, `provider.spawn`). */
export function anchorSpanId(runId: string, spanName: string): string {
  return derivedId("switchboard.span", SPAN_ID_BYTES, runId, spanName);
}

export function randomTraceId(): string {
  return nonZero(randomBytes(TRACE_ID_BYTES)).toString("hex");
}

export function randomSpanId(): string {
  return nonZero(randomBytes(SPAN_ID_BYTES)).toString("hex");
}

function nonZero(id: Buffer): Buffer {
  if (id.every((byte) => byte === 0)) id[id.length - 1] = 1;
  return id;
}

/** The parent span name LLD §7 assigns to `spanName`, `null` for a root, `undefined` for a name not in the table. */
export function parentSpanName(spanName: string): string | null | undefined {
  return Object.hasOwn(SPAN_PARENTS, spanName) ? SPAN_PARENTS[spanName] : undefined;
}

/**
 * The link for a span of run `runId`: the run's trace id, a derived id for an anchor span or a random one otherwise,
 * and the derived id of the LLD §7 parent when the span is not a root. A name outside the table is a root of the run's
 * trace (it is still correlated with the run, just unparented).
 */
export function linkForRun(runId: string, spanName: string): SpanLink {
  const parent = parentSpanName(spanName);
  const spanId = ANCHOR_SPANS.has(spanName) ? anchorSpanId(runId, spanName) : randomSpanId();
  return {
    traceId: traceIdForRun(runId),
    spanId,
    ...(typeof parent === "string" ? { parentSpanId: anchorSpanId(runId, parent) } : {}),
  };
}

/** A root span unrelated to any run: fresh random ids. */
export function rootLink(): SpanLink {
  return { traceId: randomTraceId(), spanId: randomSpanId() };
}

/**
 * Resolve the link for a completed span: explicit ids on the span win; otherwise the `run.id` attribute selects the
 * run's trace; otherwise the span is an unrelated root.
 */
export function resolveLink(span: {
  readonly name: string;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly parentSpanId?: string | undefined;
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined;
}): SpanLink {
  if (isHex(span.traceId, TRACE_ID_BYTES * 2) && isHex(span.spanId, SPAN_ID_BYTES * 2)) {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(isHex(span.parentSpanId, SPAN_ID_BYTES * 2) ? { parentSpanId: span.parentSpanId } : {}),
    };
  }
  const runId = span.attributes?.["run.id"];
  if (typeof runId === "string" && runId.length > 0) return linkForRun(runId, span.name);
  return rootLink();
}

function isHex(value: string | undefined, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value) && !/^0+$/.test(value);
}
