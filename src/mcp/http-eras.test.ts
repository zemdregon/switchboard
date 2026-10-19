/**
 * T13.10 (FR-MCP-18, ADR-0062): the MCP endpoint serves both protocol eras with the SDK v2 packages. A client on the
 * 2025-era handshake (the v2 `Client` default) and a client pinned to 2026-07-28 both initialize and call a tool through
 * the real token checks of `src/mcp/http.ts`; neither era gets a session id, a presented session id is still refused
 * (ADR-0041 item 7 as built), and a non-JSON body is refused before either leg parses it. Fake adapter only; the
 * listener is on loopback.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { resolveHttpTransport } from "../config/http-transport.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { type HttpTransportListener, startHttpTransport } from "./http.js";
import { SubjectBindingStore } from "./http-subjects.js";
import { createSwitchboardServer } from "./index.js";
import { OAuthTokenStore } from "./oauth-tokens.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const now = () => NOW;
const MODERN = "2026-07-28";

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "read-only",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** One HTTP exchange as the client saw it: the request headers it sent and the response status and headers. */
interface Exchange {
  readonly method: string;
  readonly request: Record<string, string>;
  readonly status: number;
  readonly response: Record<string, string>;
}

let root: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle;
let listener: HttpTransportListener;
let url: URL;
let token: string;
let resource: string;
const clients: Client[] = [];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-http-eras-")));
  const dataDir = path.join(root, "data");
  mkdirSync(path.join(root, "repos"));
  mkdirSync(dataDir, { recursive: true });
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator(), now });
  const registry = new AdapterRegistry().register(new FakeAdapter({ script: "/nonexistent/fake-cli.mjs" }));
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const allowedRoots = [path.join(root, "repos")];
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots, ids: createIdGenerator() });
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots,
    globalConcurrency: 4,
    resolveProfile: profileFor,
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
  });
  const settings = resolveHttpTransport({
    enabled: true,
    public_url: "https://sb.example.test/mcp",
    port: 0,
    default_mcp_client: "c1",
  });
  if (!settings) throw new Error("HTTP settings missing");
  resource = settings.resource;
  const tokens = new OAuthTokenStore(db);
  const subjectBindings = new SubjectBindingStore(db);
  const started = await startHttpTransport(settings, {
    tokens,
    clients: {
      register: () => {
        throw new Error("not used");
      },
      get: (clientId) => ({ clientId, status: "approved", redirectUris: [], grantTypes: [], createdAt: "" }),
    },
    mcpServerFor: (mcpClientId, oauthClientId) =>
      createSwitchboardServer({
        lifecycle,
        ledger,
        artifacts,
        registry,
        config: {
          allowedRoots,
          mcpClients: new Map([["c1", { id: "c1", maxTrustProfile: "edit-untrusted" as TrustProfile }]]),
          capacity: { windowSeconds: 7200, confidenceRuns: 4 },
          limits: { perProviderConcurrency: 2 },
        },
        clientId: mcpClientId,
        subject: oauthClientId,
        subjectBindings,
        now,
      }),
  });
  if (!started) throw new Error("HTTP listener missing");
  listener = started;
  url = new URL(`http://127.0.0.1:${listener.address.port}/mcp`);
  token = tokens.issue({ kind: "access", clientId: "era-fixture", resource, scopes: ["mcp"], ttlMs: 60_000 }).token;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await listener.close();
  await lifecycle.shutdown();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A v2 client over the listener with the bearer token, recording every exchange. */
function connectRecording(options: ConstructorParameters<typeof Client>[1] = {}) {
  const exchanges: Exchange[] = [];
  const recordingFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init);
    const request: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      request[k] = v;
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k] = v;
    });
    exchanges.push({ method: init?.method ?? "GET", request, status: response.status, response: headers });
    return response;
  };
  const client = new Client({ name: "era-test", version: "0.0.0" }, options);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: recordingFetch,
  });
  clients.push(client);
  return { client, transport, exchanges };
}

async function listsAndCalls(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("get_capacity");
  const result = await client.callTool({ name: "get_capacity", arguments: {} });
  expect(result.isError).not.toBe(true);
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  expect(JSON.parse(text)).toHaveProperty("providers");
}

/** The POST exchanges; a 2025-era client also tries one GET for a server-initiated stream, which stays 405 (POST only). */
function posts(exchanges: Exchange[]): Exchange[] {
  for (const e of exchanges.filter((e) => e.method !== "POST")) {
    expect(e.method).toBe("GET");
    expect(e.status).toBe(405);
    expect(e.response["mcp-session-id"]).toBeUndefined();
  }
  return exchanges.filter((e) => e.method === "POST");
}

function noSessionAnywhere(exchanges: Exchange[], transport: StreamableHTTPClientTransport): void {
  expect(exchanges.length).toBeGreaterThan(0);
  for (const e of posts(exchanges)) {
    expect(e.status, JSON.stringify(e)).toBeLessThan(300);
    expect(e.response["mcp-session-id"]).toBeUndefined();
    expect(e.request["mcp-session-id"]).toBeUndefined();
    // Every response is one JSON body (no SSE stream) in either era; a 202 is the acknowledged notification.
    if (e.status === 200) expect(e.response["content-type"]).toMatch(/^application\/json/);
    // The credential stays in the Authorization header and nowhere else.
    expect(JSON.stringify(e.response)).not.toContain(token);
  }
  expect(transport.sessionId).toBeUndefined();
}

describe("MCP over HTTP serves both protocol eras (T13.10; FR-MCP-18, ADR-0062)", () => {
  it("a 2025-era client initializes and calls a tool with no session id", async () => {
    const { client, transport, exchanges } = connectRecording();
    await client.connect(transport);
    await listsAndCalls(client);
    noSessionAnywhere(exchanges, transport);
    // The legacy handshake: an `initialize` POST without the modern protocol-version header, then the notification.
    const sent = posts(exchanges);
    expect(sent[0]?.request["mcp-protocol-version"]).toBeUndefined();
    expect(sent.map((e) => e.status)).toEqual([200, 202, 200, 200]);
    expect(sent.every((e) => e.request["mcp-protocol-version"] !== MODERN)).toBe(true);
  });

  it("a 2026-07-28 client discovers, lists and calls a tool with no session id", async () => {
    const { client, transport, exchanges } = connectRecording({ versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(transport);
    await listsAndCalls(client);
    noSessionAnywhere(exchanges, transport);
    // No `initialize`: every request carries the 2026-07-28 header (and the per-request envelope the SDK adds).
    expect(exchanges.every((e) => e.method === "POST" && e.request["mcp-protocol-version"] === MODERN)).toBe(true);
    expect(exchanges.map((e) => e.status)).toEqual([200, 200, 200]);

    // A negotiating client lands on the modern era too (the probe is answered, not treated as legacy).
    const auto = connectRecording({ versionNegotiation: { mode: "auto" } });
    await auto.client.connect(auto.transport);
    await listsAndCalls(auto.client);
    noSessionAnywhere(auto.exchanges, auto.transport);
    expect(auto.exchanges.every((e) => e.request["mcp-protocol-version"] === MODERN)).toBe(true);
  });

  it("a presented session id and a non-JSON body are still refused", async () => {
    const post = (headers: Record<string, string>, body: string) =>
      fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", ...headers },
        body,
      });
    const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    const withSession = await post({ "content-type": "application/json", "mcp-session-id": "anything" }, list);
    expect(withSession.status).toBe(400);
    expect(await withSession.json()).toMatchObject({ error: "invalid_request" });

    const notJson = await post({ "content-type": "text/plain" }, list);
    expect(notJson.status).toBe(415);
    expect(await notJson.json()).toMatchObject({ error: "invalid_request" });

    // A 2026-07-28 header without the per-request envelope is the modern leg's own error, not served as legacy.
    const bare = await post({ "content-type": "application/json", "mcp-protocol-version": MODERN }, list);
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32602 } });

    // Positive control: the same body without that header is a 2025-era request and is served.
    const served = await post({ "content-type": "application/json" }, list);
    expect(served.status).toBe(200);
    expect(served.headers.get("mcp-session-id")).toBeNull();
    expect(await served.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } });
  });
});
