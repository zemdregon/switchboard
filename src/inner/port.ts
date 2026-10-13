/**
 * Inner backend port (T11.1; LLD §13.2, FR-INN-02). The port carries one request and one answer: there is no tool, file,
 * session, history or streaming parameter, so a backend cannot be asked for more than a single completion.
 * `response_schema` is a hint to the backend and is never trusted; the output is validated by the pipeline (T11.2).
 */
import type { InnerTask } from "./config.js";

export type { InnerTask };
export type Locality = "local" | "remote";

export interface InnerRequest {
  task: InnerTask;
  /** e.g. `commit_message.v1`; part of the task contract, bumped on any prompt change. */
  template_version: string;
  /** Fixed template text owned by the task contract, never built from input. */
  system: string;
  /** Redacted, budget-truncated input (LLD §13.4 steps 2 and 3). */
  user: string;
  max_output_tokens: number;
  /** JSON Schema of the expected output. */
  response_schema: object;
}

export interface InnerResult {
  /** Raw completion text; untrusted data (FR-INN-07). */
  text: string;
  /** As reported by the backend; null or absent means unknown, never estimated. */
  usage?: { in: number | null; out: number | null };
  /** As reported by the backend, else the configured model string. */
  model_id: string;
}

export interface InnerProbeResult {
  reachable: boolean;
  canary_ok: boolean;
  eligible: boolean;
  detail: string;
}

export interface InnerBackend {
  readonly kind: "http" | "cli";
  /** At connect time, every connection (LLD §13.2 locality rule). */
  resolveLocality(signal: AbortSignal): Promise<Locality>;
  /** Rejects on transport or exit failure. */
  complete(req: InnerRequest, signal: AbortSignal): Promise<InnerResult>;
  probe(signal: AbortSignal): Promise<InnerProbeResult>;
}
