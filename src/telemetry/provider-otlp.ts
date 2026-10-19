/**
 * Per-run loopback OTLP/HTTP metrics receiver (T8.15, FR-TEL-06, ADR-0062). No runtime dependency beyond
 * `node:http`: accepts `POST /v1/metrics` with `application/json` only (OTLP/HTTP JSON, never protobuf or gRPC).
 *
 * Trust boundary (ADR-0062 item 5): everything arriving at this listener comes from the provider process and is
 * untrusted. Only allowlisted metric names map to observation keys; every other metric is ignored. Data-point
 * attributes other than the token-type split key are dropped; resource attributes from the payload are ignored
 * entirely. The run and task identifiers are injected by the controller through the invocation environment, never
 * trusted from the payload. Stored values are finite non-negative numbers only (FR-TEL-03: numbers, never prompts,
 * credentials, environment or output text).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ProviderId } from "../adapters/types.js";
import type { NewUsageObservation } from "../ledger/index.js";

/** Body cap per request (ADR-0062 item 6, Assumption): 1 MiB. */
export const PROVIDER_OTLP_MAX_BODY_BYTES = 1_048_576;

/** OTLP/HTTP metrics path. Every other path is 404. */
export const PROVIDER_OTLP_METRICS_PATH = "/v1/metrics";

/**
 * Closed metric-name allowlist (ADR-0062 item 5). `gen_ai.client.token.usage` is the OpenTelemetry Semantic
 * Conventions for Generative AI Systems metric for per-operation token usage; the `gen_ai.usage.*` and `cost_usd`
 * names are this receiver's intake contract (no declared provider uses them yet; a manifest declaration cites the
 * provider's own documentation before any other name is accepted here).
 */
const TOKEN_USAGE_METRIC = "gen_ai.client.token.usage";
const INPUT_TOKENS_METRIC = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS_METRIC = "gen_ai.usage.output_tokens";
const COST_USD_METRIC = "cost_usd";

/** The only data-point attribute read, and only to split token usage into input/output. */
const TOKEN_TYPE_ATTRIBUTE = "gen_ai.token.type";

/** Observation keys this receiver produces. */
export type ProviderOtlpMetricKey = "input_tokens" | "output_tokens" | "cost_usd";

export type ProviderOtlpMetrics = Partial<Record<ProviderOtlpMetricKey, number>>;

export interface ProviderOtlpReceiver {
  /** `http://127.0.0.1:<port>/v1/metrics`: the URL the provider posts to. */
  readonly endpoint: string;
  /** Values accumulated so far (sums over every accepted data point). */
  snapshot(): ProviderOtlpMetrics;
  /** Stops accepting; accumulated values are kept for a final `snapshot()`. Never throws. */
  close(): Promise<void>;
}

const finiteNonNegative = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

function attributeValue(attrs: unknown, key: string): string | undefined {
  if (!Array.isArray(attrs)) return undefined;
  for (const attr of attrs) {
    if (typeof attr !== "object" || attr === null) continue;
    const { key: k, value } = attr as { key?: unknown; value?: unknown };
    if (k !== key || typeof value !== "object" || value === null) continue;
    const s = (value as { stringValue?: unknown }).stringValue;
    if (typeof s === "string") return s;
  }
  return undefined;
}

function numericValue(point: unknown): number | undefined {
  if (typeof point !== "object" || point === null) return undefined;
  const p = point as { asDouble?: unknown; asInt?: unknown };
  const raw =
    finiteNonNegative(p.asDouble) ?? (typeof p.asInt === "string" ? finiteNonNegative(Number(p.asInt)) : undefined);
  return raw;
}

/** Adds the accepted data points of one OTLP metric to `into`. Unknown metric names contribute nothing. */
function accumulateMetric(metric: unknown, into: ProviderOtlpMetrics): void {
  if (typeof metric !== "object" || metric === null) return;
  const { name, sum, gauge } = metric as { name?: unknown; sum?: unknown; gauge?: unknown };
  if (typeof name !== "string") return;
  const dataPoints =
    (typeof sum === "object" && sum !== null
      ? (sum as { dataPoints?: unknown }).dataPoints
      : typeof gauge === "object" && gauge !== null
        ? (gauge as { dataPoints?: unknown }).dataPoints
        : undefined) ?? [];
  if (!Array.isArray(dataPoints)) return;
  for (const point of dataPoints) {
    if (typeof point !== "object" || point === null) continue;
    const value = numericValue(point);
    if (value === undefined) continue;
    const attrs = (point as { attributes?: unknown }).attributes;
    if (name === TOKEN_USAGE_METRIC) {
      // Split by token type; any other type value is dropped (never stored under an unlisted key).
      const type = attributeValue(attrs, TOKEN_TYPE_ATTRIBUTE);
      if (type === "input") into.input_tokens = (into.input_tokens ?? 0) + value;
      else if (type === "output") into.output_tokens = (into.output_tokens ?? 0) + value;
    } else if (name === INPUT_TOKENS_METRIC) {
      into.input_tokens = (into.input_tokens ?? 0) + value;
    } else if (name === OUTPUT_TOKENS_METRIC) {
      into.output_tokens = (into.output_tokens ?? 0) + value;
    } else if (name === COST_USD_METRIC) {
      into.cost_usd = (into.cost_usd ?? 0) + value;
    }
    // Every other metric name is ignored (closed allowlist, ADR-0062 item 5).
  }
}

function accumulateBody(body: unknown, into: ProviderOtlpMetrics): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { resourceMetrics } = body as { resourceMetrics?: unknown };
  if (!Array.isArray(resourceMetrics)) return false;
  for (const rm of resourceMetrics) {
    if (typeof rm !== "object" || rm === null) continue;
    const { scopeMetrics } = rm as { scopeMetrics?: unknown };
    if (!Array.isArray(scopeMetrics)) continue;
    for (const sm of scopeMetrics) {
      if (typeof sm !== "object" || sm === null) continue;
      const { metrics } = sm as { metrics?: unknown };
      if (!Array.isArray(metrics)) continue;
      for (const metric of metrics) accumulateMetric(metric, into);
    }
  }
  return true;
}

function readBody(req: IncomingMessage, res: ServerResponse, onBody: (raw: string) => void): void {
  let bytes = 0;
  const chunks: Buffer[] = [];
  let refused = false;
  req.on("data", (chunk: Buffer) => {
    if (refused) return;
    bytes += chunk.length;
    if (bytes > PROVIDER_OTLP_MAX_BODY_BYTES) {
      refused = true;
      res.writeHead(413, { "content-type": "application/json" }).end("{}\n");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (refused) return;
    onBody(Buffer.concat(chunks).toString("utf8"));
  });
}

/**
 * Starts the per-run receiver bound to loopback with an ephemeral port. Resolves once listening; the bound address
 * is asserted to be loopback (fail closed: a non-loopback bind refuses to serve). Close with `close()`.
 */

export function startProviderOtlpReceiver(): Promise<ProviderOtlpReceiver> {
  const totals: ProviderOtlpMetrics = {};
  const server: Server = createServer((req, res) => {
    if (req.url !== PROVIDER_OTLP_METRICS_PATH) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}\n");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" }).end("{}\n");
      return;
    }
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.split(";")[0]?.trim().toLowerCase().endsWith("/json")) {
      // OTLP/HTTP JSON only (ADR-0062 item 3, v10-D6): protobuf bodies are refused, never parsed.
      res.writeHead(415, { "content-type": "application/json" }).end("{}\n");
      return;
    }
    readBody(req, res, (raw) => {
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end("{}\n");
        return;
      }
      if (!accumulateBody(body, totals)) {
        res.writeHead(400, { "content-type": "application/json" }).end("{}\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Explicit 127.0.0.1 (ADR-0062 item 2): never a wildcard, never a hostname that could resolve elsewhere.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null || address.address !== "127.0.0.1") {
        server.close();
        reject(new Error(`provider OTLP receiver bound a non-loopback address: ${JSON.stringify(address)}`));
        return;
      }
      resolve({
        endpoint: `http://127.0.0.1:${address.port}${PROVIDER_OTLP_METRICS_PATH}`,
        snapshot: () => ({ ...totals }),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** An active per-run receiver plus the environment the provider process gets (FR-EXE-07, ADR-0062 item 4). */
export interface ProviderOtlpRunSession {
  /** Adapter-declared variables merged into the invocation env verbatim; empty when there is no session. */
  readonly env: Readonly<Record<string, string>>;
  /** Reads the accumulated totals as `provider_reported` observations for the run. Pure; safe after `close()`. */
  drain(ctx: { runId: string; provider: string; model?: string | null }): NewUsageObservation[];
  /** Closes the listener. Total: never throws; safe on every run exit path. */
  close(): Promise<void>;
}

export interface ProviderOtlpRunOptions {
  /** The operator switch (`telemetry.provider_otlp`). Anything but `true` means no listener. */
  enabled: boolean;
  /** Adapter id; the manifest must declare `otlp_metrics` or there is no session. */
  provider: string;
  runId: string;
  /** Task identifier (the meta-session id), injected as `session.id`, never trusted from the payload. */
  sessionId: string;
  /** Manifest directory override (tests only); defaults to the shipped manifests. */
  manifestDir?: string;
}

/**
 * Starts the per-run session: no session (undefined, no socket) unless the switch is on *and* the provider's
 * manifest declares `otlp_metrics` with a provider-documentation citation. The manifest loader is imported lazily so
 * this module's import graph stays dependency-light.
 */
export async function startProviderOtlpForRun(
  opts: ProviderOtlpRunOptions,
): Promise<ProviderOtlpRunSession | undefined> {
  if (!opts.enabled) return undefined;
  const { tryLoadManifest } = await import("../adapters/manifest/index.js");
  const { loaded } = tryLoadManifest(opts.provider as ProviderId, opts.manifestDir);
  const declared = loaded?.manifest.otlp_metrics;
  if (declared === undefined) return undefined;
  const receiver = await startProviderOtlpReceiver();
  const env: Record<string, string> = { [declared.endpoint_env]: receiver.endpoint };
  if (declared.protocol_env !== undefined) env[declared.protocol_env] = "http/json";
  if (declared.resource_attributes_env !== undefined) {
    env[declared.resource_attributes_env] = `run.id=${opts.runId},session.id=${opts.sessionId}`;
  }
  return {
    env,
    drain: (ctx) => {
      const metrics = receiver.snapshot();
      const values = Object.entries(metrics).filter(([, v]) => Number.isFinite(v));
      if (values.length === 0) return [];
      return [
        {
          runId: ctx.runId,
          provider: ctx.provider,
          harness: ctx.provider,
          backingProvider: null,
          model: ctx.model ?? null,
          source: "provider_reported" as const,
          metrics: Object.fromEntries(values),
        },
      ];
    },
    close: () => receiver.close().catch(() => undefined),
  };
}

/** Merges a session's environment into an invocation-shaped `{ env }`. No-op without a session. */
export function withProviderOtlpEnv<T extends { env: Record<string, string> }>(
  inv: T,
  session: ProviderOtlpRunSession | undefined,
): T {
  if (session === undefined) return inv;
  return { ...inv, env: { ...inv.env, ...session.env } };
}
