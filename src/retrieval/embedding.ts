/**
 * Embedding backend port and privacy gates (T12.3; FR-RAG-04, FR-RAG-12, LLD §14.4, ADR-0031, ADR-0016, ADR-0003).
 *
 * One port, two kinds: `local` (in process; in this version only the deterministic fake of `fake-embedder.ts`, T12.0)
 * and `http` (`http-embedder.ts`, an operator-run endpoint). Every call goes through {@link embedGated}, which applies the
 * LLD §14.4 gate table BEFORE any text leaves the process:
 *
 * | Effective project mode | Locality | `allow_remote` | `allow_source_content` | Result |
 * | off                    | any      | any            | any                    | `PROJECT_OFF` |
 * | on                     | local    | any            | any                    | allowed |
 * | on                     | remote   | false          | any                    | `REMOTE_NOT_ALLOWED` |
 * | on                     | remote   | true           | false                  | `SOURCE_CONTENT_NOT_ALLOWED` |
 * | on                     | remote   | true           | true                   | allowed |
 *
 * Index text is always source content, and a query is treated the same way (LLD §14.4 Assumption), so a `remote`
 * backend needs both flags for both. Locality is resolved per call by the backend (unresolved is `remote`, LLD §13.2).
 *
 * Defence in depth: each text is redacted again (`redactForIndex`, idempotent on already-redacted chunks) immediately
 * before it is handed to the backend, so a caller that skipped the scanner still cannot send an unredacted secret shape.
 *
 * Accounting (FR-RAG-12): each call yields one {@link EmbeddingCallRecord} with counts, bytes, duration, backend kind,
 * locality and outcome, never text or vectors. Records go to an injected recorder only; this module imports neither the
 * ledger nor the capacity estimator, so no embedding call can become a `usage_observation` row or a capacity input (an
 * import test in `embedding.test.ts` checks it). A build sums them into the `embed_calls` count of its `index_built`
 * `rag_record` row (T12.4).
 */
import type { EffectiveProjectRag } from "../config/index.js";
import { redactForIndex } from "./scan.js";

export type Locality = "local" | "remote";

export interface EmbeddingResult {
  readonly vectors: Float32Array[];
  /** As reported by the backend, else the configured model. */
  readonly modelId: string;
  readonly dimension: number;
}

export interface EmbeddingProbeResult {
  readonly reachable: boolean;
  readonly dimension?: number;
  /** A fixed code, never endpoint text. */
  readonly detail: string;
}

export interface EmbeddingBackend {
  readonly kind: "local" | "http";
  /** Resolved for each call; pinned to the signal for the `http` kind (LLD §13.2). */
  resolveLocality(signal: AbortSignal): Promise<Locality>;
  /** Rejects on any transport or envelope failure. Called only by {@link embedGated}. */
  embed(texts: readonly string[], signal: AbortSignal): Promise<EmbeddingResult>;
  /** Built-in fixture text only; never repository content. */
  probe(signal: AbortSignal): Promise<EmbeddingProbeResult>;
}

export type EmbeddingGateReason = "PROJECT_OFF" | "REMOTE_NOT_ALLOWED" | "SOURCE_CONTENT_NOT_ALLOWED";

export interface EmbeddingGateInput {
  readonly projectEnabled: boolean;
  readonly locality: Locality;
  readonly allowRemote: boolean;
  readonly allowSourceContent: boolean;
}

/** LLD §14.4, rows 1 to 5. */
export function evaluateEmbeddingGate(
  g: EmbeddingGateInput,
): { allowed: true } | { allowed: false; reason: EmbeddingGateReason } {
  if (!g.projectEnabled) return { allowed: false, reason: "PROJECT_OFF" };
  if (g.locality === "local") return { allowed: true };
  if (!g.allowRemote) return { allowed: false, reason: "REMOTE_NOT_ALLOWED" };
  if (!g.allowSourceContent) return { allowed: false, reason: "SOURCE_CONTENT_NOT_ALLOWED" };
  return { allowed: true };
}

/** Upper bound on a vector's dimension (Assumption, Delegated: well above common embedding sizes; bounds memory). */
export const MAX_EMBEDDING_DIMENSION = 8192;

export type EmbeddingOutcome = "ok" | "denied" | "failed" | "invalid_response";

/** FR-RAG-12: no content, no vectors. */
export interface EmbeddingCallRecord {
  readonly backendKind: "local" | "http";
  readonly locality: Locality | null;
  readonly outcome: EmbeddingOutcome;
  /** Gate reason, a backend error code, or an envelope check name. */
  readonly reason: string | null;
  readonly texts: number;
  readonly bytes: number;
  readonly dimension: number | null;
  readonly durationMs: number;
}

export type EmbeddingCallRecorder = (record: EmbeddingCallRecord) => void;

export interface EmbedGatedDeps {
  readonly backend: EmbeddingBackend;
  /** The installation's gates (`rag.embedding`). */
  readonly gates: { readonly allowRemote: boolean; readonly allowSourceContent: boolean };
  /** The project's effective setting (`effectiveProjectRag`). */
  readonly project: EffectiveProjectRag;
  readonly recorder?: EmbeddingCallRecorder;
  readonly homeDir?: string;
  readonly now?: () => number;
}

export type EmbedGatedResult =
  | { readonly ok: true; readonly vectors: Float32Array[]; readonly modelId: string; readonly dimension: number }
  | { readonly ok: false; readonly outcome: Exclude<EmbeddingOutcome, "ok">; readonly reason: string };

/**
 * Gate, redact, embed and validate one batch. Never throws for a backend, gate or envelope problem: the caller gets
 * `ok: false` and falls back to no retrieval (FR-RAG-08). An empty batch is `ok` with no vectors and no backend call.
 */
export async function embedGated(
  deps: EmbedGatedDeps,
  texts: readonly string[],
  signal: AbortSignal,
): Promise<EmbedGatedResult> {
  const now = deps.now ?? (() => performance.now());
  const t0 = now();
  const bytes = texts.reduce((n, t) => n + Buffer.byteLength(t, "utf8"), 0);
  const record = (r: Omit<EmbeddingCallRecord, "backendKind" | "texts" | "bytes" | "durationMs">) =>
    deps.recorder?.({
      backendKind: deps.backend.kind,
      texts: texts.length,
      bytes,
      durationMs: Math.max(0, Math.round(now() - t0)),
      ...r,
    });

  if (!deps.project.enabled) {
    record({ locality: null, outcome: "denied", reason: "PROJECT_OFF", dimension: null });
    return { ok: false, outcome: "denied", reason: "PROJECT_OFF" };
  }
  if (texts.length === 0) return { ok: true, vectors: [], modelId: "", dimension: 0 };

  let locality: Locality;
  try {
    locality = await deps.backend.resolveLocality(signal);
  } catch {
    locality = "remote"; // unresolved is remote (LLD §13.2)
  }
  const gate = evaluateEmbeddingGate({ projectEnabled: true, locality, ...deps.gates });
  if (!gate.allowed) {
    record({ locality, outcome: "denied", reason: gate.reason, dimension: null });
    return { ok: false, outcome: "denied", reason: gate.reason };
  }

  const safe = texts.map((t) => redactForIndex(t, deps.homeDir));
  let res: EmbeddingResult;
  try {
    res = await deps.backend.embed(safe, signal);
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "FAILED";
    record({ locality, outcome: "failed", reason: code, dimension: null });
    return { ok: false, outcome: "failed", reason: code };
  }
  const problem = checkResult(res, texts.length);
  if (problem !== undefined) {
    record({ locality, outcome: "invalid_response", reason: problem, dimension: null });
    return { ok: false, outcome: "invalid_response", reason: problem };
  }
  record({ locality, outcome: "ok", reason: null, dimension: res.dimension });
  return { ok: true, vectors: res.vectors, modelId: res.modelId, dimension: res.dimension };
}

/** Envelope checks on a backend's answer; returns a fixed code or undefined when valid. */
function checkResult(res: EmbeddingResult, expected: number): string | undefined {
  if (res.vectors.length !== expected) return "VECTOR_COUNT";
  if (!Number.isInteger(res.dimension) || res.dimension < 1 || res.dimension > MAX_EMBEDDING_DIMENSION) {
    return "DIMENSION";
  }
  for (const v of res.vectors) {
    if (v.length !== res.dimension) return "DIMENSION";
    let norm = 0;
    for (const x of v) {
      if (!Number.isFinite(x)) return "NON_FINITE";
      norm += x * x;
    }
    if (norm === 0) return "ZERO_VECTOR";
  }
  return undefined;
}
