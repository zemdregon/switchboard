/** Lazy, instance-local OTLP/HTTP transport (T8.1, LLD §7, ADR-0012). No global OTel registration. */
import type { ResolvedConfig } from "../config/index.js";
import { allowlistedAttributes, type SpanAttributes } from "./allowlist.js";
import { resolveLink } from "./links.js";

export interface CompletedSpan {
  readonly name: string;
  /** Unix milliseconds observed at the wrapper boundary. */
  readonly startTime: number;
  readonly endTime: number;
  /**
   * Attribute values built by the wrapper-boundary builders (T8.2, `src/telemetry/spans.ts`) from controller-observed
   * facts only. Builders set allowlisted keys by construction (LLD §7); keys not on the allowlist are dropped before
   * export (T8.4, `./allowlist.ts`).
   */
  readonly attributes?: SpanAttributes;
  /**
   * T8.3 (LLD §7 span tree): explicit W3C ids (lowercase hex, 32/16/16 characters). When absent, the transport
   * derives the trace id and the parent link from the `run.id` attribute and the span name (`./links.ts`); a span
   * with neither is exported as an unrelated root.
   */
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
}

export interface Telemetry {
  /** Fire and forget: initialization and collector availability never block the caller. */
  recordSpan(span: CompletedSpan): void;
  /** Stops accepting spans and closes only a transport that was actually loaded. */
  close(): Promise<void>;
}

/** Delegated bounded defaults: at most 512 waiting spans, 1 second export timeout; telemetry is best effort. */
export function createTelemetry(config: Pick<ResolvedConfig, "telemetry">): Telemetry {
  const endpoint = config.telemetry?.otlpEndpoint;
  let closed = false;
  let pending = 0;
  let loading: ReturnType<typeof loadTransport> | undefined;
  return {
    recordSpan(span) {
      if (!endpoint || closed || pending >= 512) return;
      // Filter before queuing so a disallowed key never reaches the transport (T8.4, defence in depth).
      const { attributes: raw, ...rest } = span;
      const attributes = allowlistedAttributes(raw);
      const exported: CompletedSpan = attributes !== undefined ? { ...rest, attributes } : rest;
      pending++;
      loading ??= loadTransport(endpoint);
      void loading
        .then((transport) => {
          if (!closed) transport.recordSpan(exported);
        })
        .catch(() => {
          // No error body or endpoint is logged; transport failure must not fail a run.
        })
        .finally(() => {
          pending--;
        });
    },
    async close() {
      closed = true;
      if (!loading) return;
      try {
        const transport = await loading;
        await transport.close();
      } catch {
        // Import and export failures are best effort, including shutdown.
      }
    },
  };
}

async function loadTransport(endpoint: string) {
  // Keep every runtime OTel dependency behind the first configured span export.
  const [api, sdk, otlp] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/exporter-trace-otlp-http"),
  ]);
  const exporter = new otlp.OTLPTraceExporter({ url: endpoint, timeoutMillis: 1000 });
  // T8.3: the ids of the span being started are staged by `recordSpan` below (startSpan consumes them synchronously),
  // so a derived trace id and parent link (LLD §7 tree) survive the SDK's own id generation; otherwise random ids.
  const random = new sdk.RandomIdGenerator();
  const staged: { traceId?: string | undefined; spanId?: string | undefined } = {};
  const provider = new sdk.BasicTracerProvider({
    idGenerator: {
      generateTraceId: () => staged.traceId ?? random.generateTraceId(),
      generateSpanId: () => staged.spanId ?? random.generateSpanId(),
    },
    spanProcessors: [
      new sdk.BatchSpanProcessor(exporter, {
        maxQueueSize: 512,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 100,
        exportTimeoutMillis: 1000,
      }),
    ],
  });
  const tracer = provider.getTracer("switchboard");
  return {
    recordSpan(span: CompletedSpan) {
      const link = resolveLink(span);
      // ROOT_CONTEXT prevents an ambient caller context from introducing unrelated spans or baggage; the only parent a
      // span can have is the LLD §7 one, named by id (T8.3), never an ambient span.
      const parent =
        link.parentSpanId === undefined
          ? api.ROOT_CONTEXT
          : api.trace.setSpanContext(api.ROOT_CONTEXT, {
              traceId: link.traceId,
              spanId: link.parentSpanId,
              traceFlags: api.TraceFlags.SAMPLED,
            });
      staged.traceId = link.traceId;
      staged.spanId = link.spanId;
      try {
        tracer
          .startSpan(
            span.name,
            { startTime: span.startTime, ...(span.attributes !== undefined ? { attributes: span.attributes } : {}) },
            parent,
          )
          .end(span.endTime);
      } finally {
        staged.traceId = undefined;
        staged.spanId = undefined;
      }
    },
    close: () => provider.shutdown(),
  };
}
