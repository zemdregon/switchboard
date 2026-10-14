/**
 * Embedding port, gates and accounting (T12.3; FR-RAG-04, FR-RAG-12, LLD §14.4). The deterministic fake backend only; the
 * `http` kind against a scripted local server is in `http-embedder.test.ts`. No model, network or provider.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type EffectiveProjectRag, RAG_DEFAULTS } from "../config/index.js";
import {
  type EmbeddingCallRecord,
  type EmbeddingGateInput,
  embedGated,
  evaluateEmbeddingGate,
  type Locality,
} from "./embedding.js";
import { createFakeEmbedder, fakeVector } from "./fake-embedder.js";

const ON: EffectiveProjectRag = {
  enabled: true,
  caps: { ...RAG_DEFAULTS.caps },
  exclude: [],
  useGlobal: false,
  contributeToGlobal: false,
};
const OFF: EffectiveProjectRag = { enabled: false, reason: "PROJECT_OFF" };
const signal = () => new AbortController().signal;
// Synthetic canary, assembled at run time.
const CANARY = `ghp_${"K".repeat(36)}`;

describe("evaluateEmbeddingGate (LLD §14.4 table)", () => {
  const rows: [EmbeddingGateInput, string][] = [
    [{ projectEnabled: false, locality: "local", allowRemote: true, allowSourceContent: true }, "PROJECT_OFF"],
    [{ projectEnabled: true, locality: "local", allowRemote: false, allowSourceContent: false }, "allowed"],
    [{ projectEnabled: true, locality: "remote", allowRemote: false, allowSourceContent: true }, "REMOTE_NOT_ALLOWED"],
    [
      { projectEnabled: true, locality: "remote", allowRemote: true, allowSourceContent: false },
      "SOURCE_CONTENT_NOT_ALLOWED",
    ],
    [{ projectEnabled: true, locality: "remote", allowRemote: true, allowSourceContent: true }, "allowed"],
  ];
  it.each(rows)("%j -> %s", (input, want) => {
    const r = evaluateEmbeddingGate(input);
    expect(r.allowed ? "allowed" : r.reason).toBe(want);
  });
});

describe("embedGated", () => {
  const run = async (
    opts: { locality?: Locality; allowRemote?: boolean; allowSourceContent?: boolean; project?: EffectiveProjectRag },
    texts: string[] = ["alpha beta"],
  ) => {
    const backend = createFakeEmbedder(opts.locality ? { locality: opts.locality } : {});
    const records: EmbeddingCallRecord[] = [];
    const res = await embedGated(
      {
        backend,
        gates: { allowRemote: opts.allowRemote ?? false, allowSourceContent: opts.allowSourceContent ?? false },
        project: opts.project ?? ON,
        recorder: (r) => records.push(r),
        homeDir: "/nonexistent-home",
      },
      texts,
      signal(),
    );
    return { res, backend, records };
  };

  it("a remote backend sees nothing unless both flags are set", async () => {
    for (const [flags, reason] of [
      [{}, "REMOTE_NOT_ALLOWED"],
      [{ allowSourceContent: true }, "REMOTE_NOT_ALLOWED"],
      [{ allowRemote: true }, "SOURCE_CONTENT_NOT_ALLOWED"],
    ] as const) {
      const { res, backend, records } = await run({ locality: "remote", ...flags });
      expect(res).toEqual({ ok: false, outcome: "denied", reason });
      expect(backend.requests).toEqual([]);
      expect(records).toMatchObject([{ outcome: "denied", reason, locality: "remote" }]);
    }
    const both = await run({ locality: "remote", allowRemote: true, allowSourceContent: true });
    expect(both.res.ok).toBe(true);
    expect(both.backend.requests).toHaveLength(1);
  });

  it("a project that is off never reaches the backend, even a local one", async () => {
    const { res, backend } = await run({ project: OFF });
    expect(res).toMatchObject({ ok: false, reason: "PROJECT_OFF" });
    expect(backend.requests).toEqual([]);
  });

  it("redacts again before the backend sees a text (defence in depth)", async () => {
    const { res, backend } = await run({}, [`const token = "${CANARY}";`]);
    expect(res.ok).toBe(true);
    expect(JSON.stringify(backend.requests)).not.toContain(CANARY);
    expect(JSON.stringify(backend.requests)).toContain("[REDACTED]");
  });

  it("records counts, bytes, duration and outcome, never text or vectors (FR-RAG-12)", async () => {
    const { records } = await run({}, ["alpha", "beta gamma"]);
    expect(records).toHaveLength(1);
    const r = records[0] as EmbeddingCallRecord;
    expect(r).toMatchObject({
      backendKind: "local",
      locality: "local",
      outcome: "ok",
      texts: 2,
      bytes: 15,
      dimension: 64,
    });
    expect(Object.keys(r).sort()).toEqual(
      ["backendKind", "bytes", "dimension", "durationMs", "locality", "outcome", "reason", "texts"].sort(),
    );
    expect(JSON.stringify(r)).not.toMatch(/alpha|gamma/);
  });

  it("a failing or malformed backend is a result, never a throw", async () => {
    const cases: [Parameters<typeof createFakeEmbedder>[0], string, string][] = [
      [{ failWith: "CONNECT_FAILED" }, "failed", "CONNECT_FAILED"],
      [{ tamper: (r) => ({ ...r, vectors: r.vectors.slice(1) }) }, "invalid_response", "VECTOR_COUNT"],
      [{ tamper: (r) => ({ ...r, vectors: [new Float32Array(3)] }) }, "invalid_response", "DIMENSION"],
      [
        { tamper: (r) => ({ ...r, vectors: [Float32Array.from({ length: 64 }, () => Number.NaN)] }) },
        "invalid_response",
        "NON_FINITE",
      ],
      [{ tamper: (r) => ({ ...r, vectors: [new Float32Array(64)] }) }, "invalid_response", "ZERO_VECTOR"],
    ];
    for (const [opts, outcome, reason] of cases) {
      const records: EmbeddingCallRecord[] = [];
      const res = await embedGated(
        {
          backend: createFakeEmbedder(opts),
          gates: { allowRemote: false, allowSourceContent: false },
          project: ON,
          recorder: (r) => records.push(r),
        },
        ["one"],
        signal(),
      );
      expect(res).toEqual({ ok: false, outcome, reason });
      expect(records[0]).toMatchObject({ outcome, reason });
    }
  });

  it("an empty batch makes no backend call", async () => {
    const { res, backend } = await run({}, []);
    expect(res).toEqual({ ok: true, vectors: [], modelId: "", dimension: 0 });
    expect(backend.requests).toEqual([]);
  });
});

describe("fake embedder (TDD §3.13.3)", () => {
  const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * (b[i] as number), 0);
  it("is deterministic, unit length, and nearer for shared tokens", () => {
    const a = fakeVector("parse the config file", 64);
    expect(fakeVector("parse the config file", 64)).toEqual(a);
    expect(cos(a, a)).toBeCloseTo(1, 5);
    expect(cos(a, fakeVector("parse config", 64))).toBeGreaterThan(cos(a, fakeVector("render widget colour", 64)));
  });
});

describe("accounting boundary (FR-RAG-12)", () => {
  it("no retrieval module imports the ledger, usage accounting or the capacity estimator", () => {
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        if (/^\.\.\/(ledger|usage|capacity)(\/|$)/.test(spec)) offenders.push(`${f} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
