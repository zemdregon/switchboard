/** Lazy, instance-local OTLP/HTTP transport (T8.1, LLD §7, ADR-0012). No global OTel registration. */
import type { ResolvedConfig } from "../config/index.js";
import { allowlistedAttributes, type SpanAttributes } from "./allowlist.js";

export interface CompletedSpan {
  readonly name: string;
  /** Unix milliseconds observed at the wrapper boundary. */
  readonly startTime: number;
  readonly endTime: number;
  /** Keys not on the LLD §7 allowlist are dropped before export (T8.4, `./allowlist.ts`). */
  readonly attributes?: SpanAttributes;
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
      const attributes = allowlistedAttributes(span.attributes);
      const exported: CompletedSpan = {
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        ...(attributes !== undefined ? { attributes } : {}),
      };
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
  const provider = new sdk.BasicTracerProvider({
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
      // ROOT_CONTEXT prevents an ambient caller context from introducing unrelated spans or baggage.
      tracer
        .startSpan(
          span.name,
          { startTime: span.startTime, ...(span.attributes !== undefined ? { attributes: span.attributes } : {}) },
          api.ROOT_CONTEXT,
        )
        .end(span.endTime);
    },
    close: () => provider.shutdown(),
  };
}
