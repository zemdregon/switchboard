/**
 * Deterministic in-process embedding backend for tests (T12.3; TDD §3.13.3, LLD §14.4). Kind `local`. Each lower-cased
 * token (`[a-z0-9_]+`) adds ±1 at four positions chosen by its SHA-256, then the vector is L2-normalised: texts sharing
 * tokens are nearer, identical texts give identical vectors. The dimension and the scheme are test fixtures, not claims
 * about any real model. It records the exact texts it was given, so a test can assert what would have left the process.
 */
import { createHash } from "node:crypto";
import type { EmbeddingBackend, EmbeddingResult, Locality } from "./embedding.js";

export interface FakeEmbedderOptions {
  /** Default 64. */
  readonly dimension?: number;
  /** Reported locality; default `local`. A test can claim `remote` to exercise the gates. */
  readonly locality?: Locality;
  /** Makes every `embed` reject with this code. */
  readonly failWith?: string;
  /** Rewrites the result (wrong count, wrong dimension, non-finite values). */
  readonly tamper?: (r: EmbeddingResult) => EmbeddingResult;
}

export interface FakeEmbedder extends EmbeddingBackend {
  /** Every batch passed to `embed`, in order. */
  readonly requests: string[][];
}

export const FAKE_EMBEDDING_MODEL = "fake-embedder.v1";

export function fakeVector(text: string, dimension: number): Float32Array {
  const v = new Float32Array(dimension);
  for (const token of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    const h = createHash("sha256").update(token).digest();
    for (let k = 0; k < 4; k++) {
      const i = h.readUInt32LE(k * 4) % dimension;
      v[i] = (v[i] as number) + ((h[16 + k] as number) & 1 ? 1 : -1);
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  if (norm === 0) {
    v[0] = 1; // a text with no tokens still gets a valid unit vector
    return v;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dimension; i++) v[i] = (v[i] as number) * inv;
  return v;
}

export function createFakeEmbedder(options: FakeEmbedderOptions = {}): FakeEmbedder {
  const dimension = options.dimension ?? 64;
  const requests: string[][] = [];
  return {
    kind: "local",
    requests,
    async resolveLocality() {
      return options.locality ?? "local";
    },
    async embed(texts) {
      requests.push([...texts]);
      if (options.failWith !== undefined) throw Object.assign(new Error(options.failWith), { code: options.failWith });
      const r: EmbeddingResult = {
        vectors: texts.map((t) => fakeVector(t, dimension)),
        modelId: FAKE_EMBEDDING_MODEL,
        dimension,
      };
      return options.tamper ? options.tamper(r) : r;
    },
    async probe() {
      return { reachable: true, dimension, detail: "OK" };
    },
  };
}
