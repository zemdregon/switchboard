/**
 * Which configured MCP client an OAuth client acts as at `/mcp` (migration 0036): the config `clients` map, then the
 * ledger binding a profile-bound code made, then `default_mcp_client`. A ledger binding is re-checked on every request
 * and refused (403 `insufficient_scope`) when it no longer names an entry eligible for a binding; it never falls
 * through to the default.
 */

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HttpTransportConfig,
  type HttpTransportSettings,
  type RawMcpClientEntry,
  resolveHttpTransport,
  resolveMcpClientFor,
} from "../config/index.js";
import { openLedger } from "../ledger/index.js";
import { type HttpTransportListener, startHttpTransport } from "./http.js";
import { OAuthClientStore } from "./oauth-clients.js";
import { OAuthTokenStore } from "./oauth-tokens.js";

const RESOURCE = "https://sb.example.test/mcp";
const ENTRIES: RawMcpClientEntry[] = [
  { id: "grok-bot", max_trust_profile: "edit-untrusted" },
  { id: "mapped", max_trust_profile: "privileged" },
  { id: "fallback", max_trust_profile: "inspect-untrusted" },
];

let dir: string;
let db: Database.Database;
let clients: OAuthClientStore;
let tokens: OAuthTokenStore;
let listener: HttpTransportListener | undefined;
let served: string[];
let refused: string[];

const settings = (over: Partial<HttpTransportConfig> = {}, entries = ENTRIES): HttpTransportSettings =>
  resolveHttpTransport({ enabled: true, public_url: RESOURCE, port: 0, ...over }, entries) as HttpTransportSettings;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-http-resolve-"));
  db = openLedger(dir);
  clients = new OAuthClientStore(db);
  tokens = new OAuthTokenStore(db);
  served = [];
  refused = [];
});

afterEach(async () => {
  await listener?.close();
  listener = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(s: HttpTransportSettings): Promise<void> {
  listener = await startHttpTransport(s, {
    tokens,
    clients,
    onClientRefused: (reason) => refused.push(reason),
    // Records who the request was served as; the stub server is never used (the request then answers 500).
    mcpServerFor: (mcpClientId) => {
      served.push(mcpClientId);
      throw new Error("stub");
    },
  });
}

function approvedClient(bindTo?: string): { clientId: string; token: string } {
  const r = clients.register({ redirectUris: ["https://app.example/cb"], grantTypes: ["authorization_code"] });
  if (!r.ok) throw new Error("register");
  expect(clients.approveAndBind(r.client.clientId, bindTo).ok).toBe(true);
  const token = tokens.issue({
    kind: "access",
    clientId: r.client.clientId,
    resource: RESOURCE,
    scopes: ["mcp"],
    ttlMs: 60_000,
  }).token;
  return { clientId: r.client.clientId, token };
}

function post(token: string): Promise<{ status: number; www: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: listener?.address.port,
        method: "POST",
        path: "/mcp",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, www: res.headers["www-authenticate"] }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
}

describe("resolveMcpClientFor", () => {
  it("prefers the config map, then the ledger binding, then the default", () => {
    const s = settings({
      clients: [{ oauth_client_id: `sbc_${"A".repeat(22)}`, mcp_client: "mapped" }],
      default_mcp_client: "fallback",
    });
    expect(resolveMcpClientFor(s, `sbc_${"A".repeat(22)}`, "grok-bot")).toEqual({
      mcpClient: "mapped",
      source: "config_map",
      eligible: true,
    });
    expect(resolveMcpClientFor(s, `sbc_${"B".repeat(22)}`, "grok-bot")).toEqual({
      mcpClient: "grok-bot",
      source: "ledger_binding",
      eligible: true,
    });
    expect(resolveMcpClientFor(s, `sbc_${"B".repeat(22)}`, undefined)).toEqual({
      mcpClient: "fallback",
      source: "default",
      eligible: true,
    });
    // A binding to a privileged ceiling or a removed entry is not eligible and never falls through to the default.
    expect(resolveMcpClientFor(s, `sbc_${"B".repeat(22)}`, "mapped")?.eligible).toBe(false);
    expect(resolveMcpClientFor(s, `sbc_${"B".repeat(22)}`, "gone")).toMatchObject({
      source: "ledger_binding",
      eligible: false,
    });
    expect(resolveMcpClientFor(settings(), `sbc_${"B".repeat(22)}`, undefined)).toBeUndefined();
  });
});

describe("profile resolution at the MCP endpoint", () => {
  it("serves a ledger-bound client as its bound profile, and a config mapping wins over the binding", async () => {
    const bound = approvedClient("grok-bot");
    const both = approvedClient("grok-bot");
    const plain = approvedClient();
    await start(
      settings({ clients: [{ oauth_client_id: both.clientId, mcp_client: "mapped" }], default_mcp_client: "fallback" }),
    );
    expect((await post(bound.token)).status).toBe(500); // reached the (stub) server
    expect((await post(both.token)).status).toBe(500);
    expect((await post(plain.token)).status).toBe(500);
    expect(served).toEqual(["grok-bot", "mapped", "fallback"]);
  });

  it("keeps static config behaviour: unmapped without a default is refused", async () => {
    const plain = approvedClient();
    await start(settings());
    const r = await post(plain.token);
    expect(r.status).toBe(403);
    expect(r.www).toContain('error="insufficient_scope"');
    expect(refused).toEqual(["unmapped_client"]);
  });

  it("refuses fail-closed when the bound profile is removed or becomes ineligible, even with a default", async () => {
    const bound = approvedClient("grok-bot");
    // The same entry id, now with a privileged ceiling: no longer bindable.
    const s = settings({ default_mcp_client: "fallback" }, [
      { id: "grok-bot", max_trust_profile: "privileged" },
      { id: "fallback", max_trust_profile: "inspect-untrusted" },
    ]);
    await start(s);
    const r = await post(bound.token);
    expect(r.status).toBe(403);
    expect(r.www).toContain('error="insufficient_scope"');
    expect(refused).toEqual(["ineligible_binding"]);
    expect(served).toEqual([]);
    await listener?.close();
    // Removed entirely.
    await start(
      settings({ default_mcp_client: "fallback" }, [{ id: "fallback", max_trust_profile: "edit-untrusted" }]),
    );
    expect((await post(bound.token)).status).toBe(403);
    expect(served).toEqual([]);
  });

  it("refuses a revoked client's unexpired token", async () => {
    const bound = approvedClient("grok-bot");
    await start(settings());
    clients.revoke(bound.clientId);
    expect((await post(bound.token)).status).toBe(401);
  });
});
