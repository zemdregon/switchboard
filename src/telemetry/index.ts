/** Lazy, instance-local OTLP/HTTP transport (T8.1, LLD §7, ADR-0012). No global OTel registration. */
import type { ResolvedConfig } from "../config/index.js";

export interface CompletedSpan {
  readonly name: string;
  /** Unix milliseconds observed at the wrapper boundary. */
  readonly startTime: number;
  readonly endTime: number;
  /**
   * Attribute values built by the wrapper-boundary builders (T8.2, `src/telemetry/spans.ts`) from controller-observed
   * facts only. Builders set allowlisted keys by construction (LLD §7); the export-time drop filter for any other key
   * remains T8.4.
   */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
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
      pending++;
      loading ??= loadTransport(endpoint);
      void loading
        .then((transport) => {
          if (!closed) transport.recordSpan(span);
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
