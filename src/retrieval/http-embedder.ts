/**
 * `http` embedding backend (T12.3; FR-RAG-04, LLD §14.4, TDD §3.13.4, ADR-0003).
 *
 * Reuses the inner agent's pinned-address transport (`createPinnedHttpTransport`, LLD §13.2): the host is resolved and
 * every address classified once per call, the connection goes only to the pinned address, a call gated `local` is
 * dropped before a byte is written if the peer is not loopback, redirects and content encodings are refused, the
 * response is capped, and errors are fixed codes. No credential is held or sent: the only headers are fixed, and the
 * schema has no field for one (a keyed hosted service is reached through an operator-run local gateway).
 *
 * Request mapping (Assumption, T12.0; fixed against a fake server only): `POST <base_url>/v1/embeddings` (no second
 * `/v1` when the base path ends in it) with `{ model, input: [texts] }`; the answer's `data[i].embedding` arrays are
 * the vectors, ordered by `data[i].index` when every item carries a distinct valid one, else in array order; `model` is
 * used when it is a non-empty string. Anything else is `BAD_ENVELOPE`.
 *
 * Bounds (Assumptions, Delegated): at most 32 texts per request (larger inputs are sent as several requests, in order),
 * and a response of at most 8 MiB per request.
 */

import type { RagSettings } from "../config/index.js";
import { createPinnedHttpTransport, HttpBackendError, type Pinned } from "../inner/http-backend.js";
import { type EmbeddingBackend, type EmbeddingResult, MAX_EMBEDDING_DIMENSION } from "./embedding.js";

export const MAX_TEXTS_PER_REQUEST = 32;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** The built-in probe text (`doctor`); never repository content. */
export const PROBE_TEXT = "switchboard embedding probe";

export interface HttpEmbedderOptions {
  /** Name resolution, injectable for tests (LLD §13.2). */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}

type Settings = NonNullable<RagSettings["embedding"]>;

export function createHttpEmbedder(settings: Settings, options: HttpEmbedderOptions = {}): EmbeddingBackend {
  const transport = createPinnedHttpTransport(settings.baseUrl, "embeddings", options.resolve);
  const pins = new WeakMap<AbortSignal, Pinned>();

  const withTimeout = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]);

  async function exchange(texts: readonly string[], pin: Pinned, signal: AbortSignal): Promise<EmbeddingResult> {
    const vectors: Float32Array[] = [];
    let modelId = settings.model;
    let dimension = 0;
    for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_REQUEST) {
      const batch = texts.slice(i, i + MAX_TEXTS_PER_REQUEST);
      const raw = await transport.post(
        JSON.stringify({ model: settings.model, input: batch }),
        pin,
        MAX_RESPONSE_BYTES,
        withTimeout(signal),
      );
      const decoded = decode(raw, batch.length);
      if (dimension !== 0 && decoded.dimension !== dimension) throw new HttpBackendError("BAD_ENVELOPE");
      dimension = decoded.dimension;
      if (decoded.model !== undefined) modelId = decoded.model;
      vectors.push(...decoded.vectors);
    }
    return { vectors, modelId, dimension };
  }

  return {
    kind: "http",
    async resolveLocality(signal) {
      if (signal.aborted) throw new HttpBackendError("ABORTED");
      const pin = await transport.resolvePinned();
      pins.set(signal, pin);
      return pin.locality;
    },
    async embed(texts, signal) {
      // `embedGated` resolves locality with this same signal first; without that, resolve now (and the caller has no
      // gate decision, so this path is for tests only).
      const pin = pins.get(signal) ?? (await transport.resolvePinned());
      return exchange(texts, pin, signal);
    },
    async probe(signal) {
      const pin = await transport.resolvePinned();
      // Defence in depth: the probe never contacts a remote endpoint the operator has not allowed.
      if (pin.locality === "remote" && !settings.allowRemote) return { reachable: false, detail: "REMOTE_NOT_ALLOWED" };
      try {
        const r = await exchange([PROBE_TEXT], pin, signal);
        return { reachable: true, dimension: r.dimension, detail: "OK" };
      } catch (e) {
        const code = e instanceof HttpBackendError ? e.code : "CONNECT_FAILED";
        return { reachable: code !== "CONNECT_FAILED" && code !== "ABORTED", detail: code };
      }
    },
  };
}

function decode(raw: string, expected: number): { vectors: Float32Array[]; dimension: number; model?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HttpBackendError("NOT_JSON");
  }
  const obj = json as { data?: unknown; model?: unknown } | null;
  if (obj === null || typeof obj !== "object" || !Array.isArray(obj.data) || obj.data.length !== expected) {
    throw new HttpBackendError("BAD_ENVELOPE");
  }
  const items = obj.data as { embedding?: unknown; index?: unknown }[];
  const indexes = items.map((it) => (it !== null && typeof it === "object" ? it.index : undefined));
  const indexed =
    indexes.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < expected) &&
    new Set(indexes).size === expected;
  const ordered = indexed ? [...items].sort((a, b) => (a.index as number) - (b.index as number)) : items;
  const vectors = ordered.map((it) => {
    const e = it !== null && typeof it === "object" ? it.embedding : undefined;
    if (!Array.isArray(e) || e.length === 0 || e.length > MAX_EMBEDDING_DIMENSION) {
      throw new HttpBackendError("BAD_ENVELOPE");
    }
    if (!e.every((x) => typeof x === "number" && Number.isFinite(x))) throw new HttpBackendError("BAD_ENVELOPE");
    return Float32Array.from(e as number[]);
  });
  const dimension = vectors[0]?.length ?? 0;
  if (vectors.some((v) => v.length !== dimension)) throw new HttpBackendError("BAD_ENVELOPE");
  return {
    vectors,
    dimension,
    ...(typeof obj.model === "string" && obj.model !== "" ? { model: obj.model.slice(0, 256) } : {}),
  };
}
