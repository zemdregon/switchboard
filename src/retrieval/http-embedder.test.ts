/**
 * `http` embedding backend against a scripted local HTTP server (T12.3; FR-RAG-04, LLD §14.4, TDD §3.13.3). The server
 * listens on a loopback ephemeral port and records every request body. Remote locality is simulated with an injected
 * resolver; a gated-off call must never connect at all. No real model, network or provider.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EffectiveProjectRag, RAG_DEFAULTS, type RagSettings } from "../config/index.js";
import { embedGated } from "./embedding.js";
import { fakeVector } from "./fake-embedder.js";
import { createHttpEmbedder, MAX_TEXTS_PER_REQUEST } from "./http-embedder.js";
import { scanContext } from "./scan.js";

type Scenario =
  | "ok"
  | "status500"
  | "wrong_dim"
  | "non_number"
  | "non_finite"
  | "non_json"
  | "drop"
  | "redirect"
  | "shuffled";

let server: http.Server;
let port: number;
let scenario: Scenario;
let bodies: string[];
let connections: number;

beforeEach(async () => {
  scenario = "ok";
  bodies = [];
  connections = 0;
  server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      bodies.push(body);
      if (req.url !== "/v1/embeddings" || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const input = (JSON.parse(body) as { input: string[] }).input;
      if (scenario === "drop") return req.socket.destroy();
      if (scenario === "status500") return void res.writeHead(500).end("boom");
      if (scenario === "redirect") return void res.writeHead(302, { location: "http://example.invalid/" }).end();
      if (scenario === "non_json")
        return void res.writeHead(200, { "content-type": "application/json" }).end("this is not json{");
      if (scenario === "non_finite") {
        // Raw `1e999`/`-1e999` literals in the body parse to `Infinity`/`-Infinity` (`NaN` is not valid JSON, so the
        // wire form for a non-finite value is an out-of-range literal); the backend must refuse them (TDD §3.13.3).
        const lit = ["1e999", "-1e999"];
        const raw = input
          .map(
            (_, index) =>
              `{"index":${index},"embedding":[${Array(16)
                .fill(lit[index % 2])
                .join(",")}]}`,
          )
          .join(",");
        return void res
          .writeHead(200, { "content-type": "application/json" })
          .end(`{"model":"served-model","data":[${raw}]}`);
      }
      const data = input.map((t, index) => ({
        index,
        embedding: Array.from(fakeVector(t, scenario === "wrong_dim" && index === 1 ? 8 : 16)),
      }));
      if (scenario === "non_number") (data[0] as { embedding: unknown[] }).embedding[0] = "x";
      if (scenario === "shuffled") data.reverse();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "served-model", data }));
    });
  });
  server.on("connection", () => {
    connections++;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const ON: EffectiveProjectRag = {
  enabled: true,
  caps: { ...RAG_DEFAULTS.caps },
  exclude: [],
  useGlobal: false,
  contributeToGlobal: false,
};
const settings = (
  over: Partial<NonNullable<RagSettings["embedding"]>> = {},
): NonNullable<RagSettings["embedding"]> => ({
  kind: "http",
  baseUrl: `http://127.0.0.1:${port}`,
  model: "operator-model",
  allowRemote: false,
  allowSourceContent: false,
  timeoutMs: 5000,
  maxConcurrency: 1,
  ...over,
});
/** A host name that "resolves" to a public documentation address: remote for the gates, never contacted when denied. */
const remoteResolve = async () => ["203.0.113.7"];
const embed = (s: NonNullable<RagSettings["embedding"]>, texts: string[], resolve?: typeof remoteResolve) =>
  embedGated(
    {
      backend: createHttpEmbedder(s, resolve ? { resolve } : {}),
      gates: { allowRemote: s.allowRemote, allowSourceContent: s.allowSourceContent },
      project: ON,
      homeDir: "/nonexistent-home",
    },
    texts,
    new AbortController().signal,
  );

describe("locality gates against a fake server (FR-RAG-04)", () => {
  it("a loopback endpoint is local and allowed with no flags", async () => {
    const r = await embed(settings(), ["alpha", "beta"]);
    expect(r).toMatchObject({ ok: true, modelId: "served-model", dimension: 16 });
    expect(JSON.parse(bodies[0] as string)).toEqual({ model: "operator-model", input: ["alpha", "beta"] });
  });

  it("a remote endpoint is refused without both flags, and no connection is made", async () => {
    for (const [flags, reason] of [
      [{}, "REMOTE_NOT_ALLOWED"],
      [{ allowSourceContent: true }, "REMOTE_NOT_ALLOWED"],
      [{ allowRemote: true }, "SOURCE_CONTENT_NOT_ALLOWED"],
    ] as const) {
      const s = settings({ baseUrl: `http://embed.example.test:${port}`, ...flags });
      expect(await embed(s, ["alpha"], remoteResolve)).toEqual({ ok: false, outcome: "denied", reason });
    }
    expect(connections).toBe(0);
    expect(bodies).toEqual([]);
  });

  it("an unresolvable host is remote (fail closed)", async () => {
    const s = settings({ baseUrl: `http://embed.example.test:${port}` });
    const r = await embed(s, ["alpha"], async () => {
      throw new Error("ENOTFOUND");
    });
    expect(r).toMatchObject({ ok: false, reason: "REMOTE_NOT_ALLOWED" });
    expect(connections).toBe(0);
  });

  it("probe does not contact a remote endpoint that is not allowed", async () => {
    const backend = createHttpEmbedder(settings({ baseUrl: `http://embed.example.test:${port}` }), {
      resolve: remoteResolve,
    });
    expect(await backend.probe(new AbortController().signal)).toEqual({
      reachable: false,
      detail: "REMOTE_NOT_ALLOWED",
    });
    expect(connections).toBe(0);
    const local = await createHttpEmbedder(settings()).probe(new AbortController().signal);
    expect(local).toEqual({ reachable: true, dimension: 16, detail: "OK" });
    expect(bodies[0]).toContain("switchboard embedding probe");
  });
});

describe("planted secret never reaches the request (FR-RAG-02, FR-RAG-04)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-embed-")));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("scan -> chunk -> http embed: the captured bodies hold no canary", async () => {
    // Synthetic canaries only, assembled at run time.
    const token = `ghp_${"W".repeat(36)}`;
    const awsKey = `AKIA${"Q".repeat(16)}`;
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIB".padEnd(64, "A"), "-----END RSA PRIVATE KEY-----"].join("\n");
    mkdirSync(path.join(tmp, "src"));
    writeFileSync(
      path.join(tmp, "src", "config.ts"),
      `export const t = "${token}";\nconst aws = "${awsKey}";\n${pem}\nexport const ok = 1;\n`,
    );
    writeFileSync(path.join(tmp, ".env"), `TOKEN=${token}\n`);
    const scan = await scanContext(tmp, {
      maxFileBytes: 10_000,
      maxFiles: 100,
      maxChunks: 100,
      maxTotalBytes: 1_000_000,
      exclude: [],
      homeDir: "/nonexistent-home",
    });
    expect(scan.chunks.length).toBeGreaterThan(0);
    const r = await embed(
      settings(),
      scan.chunks.map((c) => c.text),
    );
    expect(r.ok).toBe(true);
    const all = bodies.join("\n");
    for (const secret of [token, awsKey, "MIIB".padEnd(64, "A")]) expect(all).not.toContain(secret);
    expect(all).toContain("[REDACTED]");
  });

  it("texts given directly (no scanner) are redacted too", async () => {
    const token = `ghp_${"V".repeat(36)}`;
    expect((await embed(settings(), [`key ${token}`])).ok).toBe(true);
    expect(bodies.join("")).not.toContain(token);
  });
});

describe("envelope and transport failures fall back, never throw", () => {
  it.each([
    ["status500", "HTTP_STATUS"],
    ["wrong_dim", "BAD_ENVELOPE"],
    ["non_number", "BAD_ENVELOPE"],
    ["non_finite", "BAD_ENVELOPE"],
    ["non_json", "NOT_JSON"],
    ["drop", "CONNECT_FAILED"],
    ["redirect", "REDIRECT"],
  ] as const)("%s -> %s", async (s, reason) => {
    scenario = s;
    expect(await embed(settings(), ["alpha", "beta"])).toEqual({ ok: false, outcome: "failed", reason });
  });

  it("orders by index and splits large inputs into bounded requests", async () => {
    scenario = "shuffled";
    const texts = Array.from({ length: MAX_TEXTS_PER_REQUEST + 3 }, (_, i) => `text number ${i}`);
    const r = await embed(settings(), texts);
    expect(r.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    if (r.ok) expect(Array.from(r.vectors[5] as Float32Array)).toEqual(Array.from(fakeVector(texts[5] as string, 16)));
  });

  it("a timeout aborts the call", async () => {
    scenario = "ok";
    server.removeAllListeners("request");
    server.on("request", () => {
      /* never answers */
    });
    expect(await embed(settings({ timeoutMs: 200 }), ["alpha"])).toMatchObject({ ok: false, outcome: "failed" });
  });

  it("a delayed response within the timeout succeeds (TDD §3.13.3)", async () => {
    scenario = "ok";
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        bodies.push(body);
        const input = (JSON.parse(body) as { input: string[] }).input;
        setTimeout(() => {
          const data = input.map((t, index) => ({
            index,
            embedding: Array.from(fakeVector(t, 16)),
          }));
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ model: "served-model", data }));
        }, 150);
      });
    });
    const r = await embed(settings({ timeoutMs: 5000 }), ["alpha", "beta"]);
    expect(r).toMatchObject({ ok: true, modelId: "served-model", dimension: 16 });
  });
});
