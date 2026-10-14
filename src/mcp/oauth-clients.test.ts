import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HttpTransportSettings, resolveHttpTransport } from "../config/index.js";
import { openLedger } from "../ledger/index.js";
import { MAX_REGISTRATION_BODY_BYTES, startHttpTransport } from "./http.js";
import {
  checkClientMetadata,
  MAX_PENDING_CLIENTS,
  OAuthClientStore,
  PENDING_WINDOW_MS,
  registrationResponse,
} from "./oauth-clients.js";

const settings = (allowed_origins: string[] = []): HttpTransportSettings =>
  resolveHttpTransport({
    enabled: true,
    public_url: "https://sb.example.test/mcp",
    port: 0,
    allowed_origins,
  }) as HttpTransportSettings;

const REDIRECT = "https://grok.example.test/oauth/callback";

let dir: string;
let db: Database.Database;
let clock: Date;
let store: OAuthClientStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-dcr-"));
  db = openLedger(dir);
  clock = new Date("2026-10-14T07:00:00.000Z");
  store = new OAuthClientStore(db, { now: () => clock });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("registration metadata (RFC 7591 §2, T13.7)", () => {
  it("accepts a minimal public client and applies the RFC defaults", () => {
    expect(checkClientMetadata({ redirect_uris: [REDIRECT] })).toEqual({
      ok: true,
      metadata: { redirectUris: [REDIRECT], grantTypes: ["authorization_code"] },
    });
    expect(
      checkClientMetadata({
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_name: "Grok Bot",
        scope: "privileged",
        software_statement: "x.y.z",
      }),
    ).toEqual({
      ok: true,
      metadata: {
        redirectUris: [REDIRECT],
        grantTypes: ["authorization_code", "refresh_token"],
        clientName: "Grok Bot",
      },
    });
  });

  it.each([
    ["not an object", [], "invalid_client_metadata"],
    ["null", null, "invalid_client_metadata"],
    ["no redirect_uris", {}, "invalid_redirect_uri"],
    ["empty redirect_uris", { redirect_uris: [] }, "invalid_redirect_uri"],
    [
      "too many redirect_uris",
      { redirect_uris: [1, 2, 3, 4, 5].map((i) => `${REDIRECT}${i}`) },
      "invalid_redirect_uri",
    ],
    ["plain http", { redirect_uris: ["http://grok.example.test/cb"] }, "invalid_redirect_uri"],
    ["http loopback", { redirect_uris: ["http://127.0.0.1:8080/cb"] }, "invalid_redirect_uri"],
    ["custom scheme", { redirect_uris: ["com.example.app:/cb"] }, "invalid_redirect_uri"],
    ["javascript", { redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
    ["relative", { redirect_uris: ["/cb"] }, "invalid_redirect_uri"],
    ["fragment", { redirect_uris: [`${REDIRECT}#x`] }, "invalid_redirect_uri"],
    ["empty fragment", { redirect_uris: [`${REDIRECT}#`] }, "invalid_redirect_uri"],
    ["userinfo", { redirect_uris: ["https://u:p@grok.example.test/cb"] }, "invalid_redirect_uri"],
    ["too long", { redirect_uris: [`${REDIRECT}?${"a".repeat(2048)}`] }, "invalid_redirect_uri"],
    ["duplicate", { redirect_uris: [REDIRECT, REDIRECT] }, "invalid_redirect_uri"],
    ["non-string uri", { redirect_uris: [42] }, "invalid_redirect_uri"],
    [
      "client secret",
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" },
      "invalid_client_metadata",
    ],
    ["implicit", { redirect_uris: [REDIRECT], grant_types: ["implicit"] }, "invalid_client_metadata"],
    [
      "password",
      { redirect_uris: [REDIRECT], grant_types: ["authorization_code", "password"] },
      "invalid_client_metadata",
    ],
    ["refresh only", { redirect_uris: [REDIRECT], grant_types: ["refresh_token"] }, "invalid_client_metadata"],
    [
      "client credentials",
      { redirect_uris: [REDIRECT], grant_types: ["client_credentials"] },
      "invalid_client_metadata",
    ],
    ["empty grants", { redirect_uris: [REDIRECT], grant_types: [] }, "invalid_client_metadata"],
    ["token response", { redirect_uris: [REDIRECT], response_types: ["token"] }, "invalid_client_metadata"],
    ["two responses", { redirect_uris: [REDIRECT], response_types: ["code", "token"] }, "invalid_client_metadata"],
    ["blank name", { redirect_uris: [REDIRECT], client_name: "  " }, "invalid_client_metadata"],
    ["long name", { redirect_uris: [REDIRECT], client_name: "x".repeat(129) }, "invalid_client_metadata"],
    ["control in name", { redirect_uris: [REDIRECT], client_name: "a\u001b[31mb" }, "invalid_client_metadata"],
    ["newline in name", { redirect_uris: [REDIRECT], client_name: "a\nb" }, "invalid_client_metadata"],
  ])("refuses %s", (_name, body, error) => {
    const r = checkClientMetadata(body);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(error);
      expect(r.description).not.toContain("grok.example.test"); // descriptions echo no input
    }
  });
});

describe("client store", () => {
  it("stores a registration as pending with an unguessable id and no secret", () => {
    const a = store.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"], clientName: "Grok" });
    const b = store.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"] });
    if (!a.ok || !b.ok) throw new Error("expected registrations");
    expect(a.client.clientId).toMatch(/^sbc_[A-Za-z0-9_-]{22}$/);
    expect(a.client.clientId).not.toBe(b.client.clientId);
    expect(store.get(a.client.clientId)).toEqual({
      clientId: a.client.clientId,
      redirectUris: [REDIRECT],
      grantTypes: ["authorization_code"],
      clientName: "Grok",
      status: "pending",
      createdAt: "2026-10-14T07:00:00.000Z",
    });
    expect(store.get("sbc_missing")).toBeUndefined();
    const response = registrationResponse(a.client);
    expect(response).toEqual({
      client_id: a.client.clientId,
      client_id_issued_at: Math.floor(clock.getTime() / 1000),
      client_name: "Grok",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(Object.keys(response).filter((k) => /secret|registration_access_token/.test(k))).toEqual([]);
    const cols = (db.prepare("PRAGMA table_info(oauth_client)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => /secret|token/.test(c))).toEqual([]);
  });

  it("caps pending registrations within the window, then frees the slot as they age out or are decided", () => {
    for (let i = 0; i < MAX_PENDING_CLIENTS; i++) {
      expect(store.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"] }).ok).toBe(true);
    }
    expect(store.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"] })).toEqual({
      ok: false,
      reason: "too_many_pending",
    });
    db.prepare("UPDATE oauth_client SET status = 'denied' WHERE rowid = (SELECT MIN(rowid) FROM oauth_client)").run();
    expect(store.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"] }).ok).toBe(true);
    expect(store.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"] }).ok).toBe(false);
    clock = new Date(clock.getTime() + PENDING_WINDOW_MS);
    expect(store.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"] }).ok).toBe(true);
  });
});

describe("POST /register over HTTP (T13.7)", () => {
  async function withListener(
    fn: (base: string, registered: string[]) => Promise<void>,
    opts: { clients?: boolean; origins?: string[] } = {},
  ): Promise<void> {
    const registered: string[] = [];
    const listener = await startHttpTransport(settings(opts.origins), {
      ...(opts.clients === false ? {} : { clients: store }),
      onClientRegistered: (id) => registered.push(id),
    });
    if (!listener) throw new Error("expected a listener");
    try {
      await fn(`http://127.0.0.1:${listener.address.port}`, registered);
    } finally {
      await listener.close();
    }
  }
  const register = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("registers a pending public client and returns RFC 7591 metadata only", async () => {
    await withListener(async (base, registered) => {
      const r = await register(base, { redirect_uris: [REDIRECT], client_name: "Grok Bot", scope: "privileged" });
      expect(r.status).toBe(201);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const body = (await r.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        client_name: "Grok Bot",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      expect(body).not.toHaveProperty("client_secret");
      expect(body).not.toHaveProperty("scope");
      expect(registered).toEqual([body.client_id]);
      expect(store.get(String(body.client_id))?.status).toBe("pending");
    });
  });

  it("refuses bad requests without storing anything", async () => {
    await withListener(async (base, registered) => {
      const bad = await register(base, { redirect_uris: ["http://grok.example.test/cb"] });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({
        error: "invalid_redirect_uri",
        error_description: "redirect URIs must use https",
      });
      expect((await register(base, "{not json")).status).toBe(400);
      expect((await register(base, { redirect_uris: [REDIRECT] }, { "content-type": "text/plain" })).status).toBe(415);
      const big = await register(base, { redirect_uris: [REDIRECT], pad: "x".repeat(MAX_REGISTRATION_BODY_BYTES) });
      expect(big.status).toBe(413);
      const get = await fetch(`${base}/register`);
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
      expect(registered).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_client").get()).toEqual({ n: 0 });
    });
  });

  it("answers 429 once the pending cap is reached", async () => {
    await withListener(async (base) => {
      for (let i = 0; i < MAX_PENDING_CLIENTS; i++) {
        expect((await register(base, { redirect_uris: [REDIRECT] })).status).toBe(201);
      }
      const r = await register(base, { redirect_uris: [REDIRECT] });
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("3600");
      expect(((await r.json()) as { error: string }).error).toBe("temporarily_unavailable");
    });
  });

  it("is subject to the Origin check and is 404 without a client store", async () => {
    await withListener(
      async (base) => {
        const r = await register(base, { redirect_uris: [REDIRECT] }, { origin: "https://evil.example.test" });
        expect(r.status).toBe(403);
      },
      { origins: ["https://app.example.test"] },
    );
    await withListener(
      async (base) => {
        expect((await register(base, { redirect_uris: [REDIRECT] })).status).toBe(404);
      },
      { clients: false },
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_client").get()).toEqual({ n: 0 });
  });
});
