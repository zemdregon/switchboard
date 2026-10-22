import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkHttpTransport,
  type HttpTransportConfig,
  type HttpTransportSettings,
  type RawMcpClientEntry,
  resolveHttpTransport,
} from "../config/index.js";
import { openLedger } from "../ledger/index.js";
import { type HttpTransportListener, startHttpTransport } from "./http.js";
import { OAuthAuditLog } from "./oauth-audit.js";
import { OAuthClientStore } from "./oauth-clients.js";
import { normalizePairingCode, PAIRING_CODE_TTL_MS, PairingCodeStore } from "./oauth-pairing.js";
import { hashPassphrase, isPassphraseHash, verifyPassphrase } from "./oauth-passphrase.js";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  type AuthEvent,
  type AuthEventFields,
  AuthorizationServer,
  CONSENT_COOKIE,
  LOCKOUT_MS,
  MAX_CONSENT_REQUESTS,
  MAX_FAILED_ATTEMPTS,
  MAX_PAIRING_FAILURES_PER_MINUTE,
} from "./oauth-server.js";
import { OAuthTokenStore } from "./oauth-tokens.js";

const RESOURCE = "https://sb.example.test/mcp";
const ISSUER = "https://sb.example.test";
const REDIRECT = "https://grok.example.test/oauth/callback";
const OTHER_REDIRECT = "https://evil.example.test/cb";
const PASSPHRASE = "correct horse battery staple";
const FAKE_HASH = `scrypt$17$8$1$${"A".repeat(22)}$${"B".repeat(43)}`;

/** Migration 0036 tests: `grok-bot` and `other` may be bound by a code; `root` (privileged ceiling, approval required) may too (ADR-0086); `auto` (approval not_required) may not. */
const MCP_CLIENTS: RawMcpClientEntry[] = [
  { id: "grok-bot", max_trust_profile: "edit-untrusted" },
  { id: "other", max_trust_profile: "inspect-untrusted" },
  { id: "root", max_trust_profile: "privileged" },
  { id: "auto", max_trust_profile: "privileged", privileged_approval: "not_required" },
];

const settings = (allowed_origins: string[] = [], over: Partial<HttpTransportConfig> = {}): HttpTransportSettings =>
  resolveHttpTransport(
    { enabled: true, public_url: RESOURCE, port: 0, allowed_origins, ...over },
    MCP_CLIENTS,
  ) as HttpTransportSettings;

let dir: string;
let db: Database.Database;
let clock: Date;
let clients: OAuthClientStore;
let tokens: OAuthTokenStore;
let pairing: PairingCodeStore;
let events: { event: AuthEvent; fields: AuthEventFields }[];
let listener: HttpTransportListener;
/** Every secret value a test handled; none may reach the ledger, the audit events or an error response. */
let secrets: string[];

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function call(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: listener.address.port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function register(grants: string[] = ["authorization_code", "refresh_token"]): string {
  const r = clients.register({ redirectUris: [REDIRECT], grantTypes: grants, clientName: "<b>Grok</b> Bot" });
  if (!r.ok) throw new Error("register failed");
  return r.client.clientId;
}

function authorizeQuery(clientId: string, challenge: string, over: Record<string, string | undefined> = {}): string {
  const base: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st-123",
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== undefined) q.append(k, v);
  return `/authorize?${q.toString()}`;
}

interface Consent {
  requestId: string;
  csrf: string;
  cookie: string;
  reply: Reply;
}

function consentFrom(reply: Reply): Consent {
  const requestId = /name="request_id" value="([^"]+)"/.exec(reply.text)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(reply.text)?.[1];
  const setCookie = (reply.headers["set-cookie"] ?? [])[0] ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  if (!requestId || !csrf || !cookie) throw new Error(`no consent form in ${reply.status} ${reply.text}`);
  return { requestId, csrf, cookie, reply };
}

async function openConsent(clientId: string, challenge: string): Promise<Consent> {
  const reply = await call("GET", authorizeQuery(clientId, challenge));
  expect(reply.status).toBe(200);
  return consentFrom(reply);
}

function submit(
  c: Consent,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
  cookie: string | null = c.cookie,
): Promise<Reply> {
  const body = new URLSearchParams({ request_id: c.requestId, csrf: c.csrf, ...fields }).toString();
  return call(
    "POST",
    "/authorize",
    {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      "sec-fetch-site": "same-origin",
      ...(cookie !== null ? { cookie } : {}),
      ...headers,
    },
    body,
  );
}

function token(fields: Record<string, string>): Promise<Reply> {
  return call(
    "POST",
    "/token",
    { "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams(fields).toString(),
  );
}

function redirectParams(reply: Reply): URLSearchParams {
  const loc = reply.headers.location;
  if (loc === undefined) throw new Error(`no redirect: ${reply.status} ${reply.text}`);
  const url = new URL(loc);
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
  return url.searchParams;
}

/** The whole happy path up to the authorization code. */
async function obtainCode(clientId: string): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const c = await openConsent(clientId, challenge);
  const r = await submit(c, { decision: "approve", passphrase: PASSPHRASE });
  expect(r.status).toBe(303);
  const code = redirectParams(r).get("code");
  if (!code) throw new Error("no code");
  secrets.push(code, verifier);
  return { code, verifier };
}

async function exchange(clientId: string, code: string, verifier: string): Promise<Reply> {
  return token({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
}

function norm(code: string): string {
  const n = normalizePairingCode(code);
  if (n === undefined) throw new Error("not a pairing code");
  return n;
}

function codeOf(reply: Reply): string {
  const code = redirectParams(reply).get("code");
  if (!code) throw new Error("no code");
  return code;
}

function ledgerBytes(): string {
  db.pragma("wal_checkpoint(TRUNCATE)");
  return readdirSync(dir)
    .map((f) => readFileSync(path.join(dir, f)).toString("latin1"))
    .join("\n");
}

let audit: OAuthAuditLog;

async function start(
  deps: { passphraseHash?: string | undefined; allowed?: string[]; http?: Partial<HttpTransportConfig> } = {},
): Promise<void> {
  const s = settings(deps.allowed ?? [], deps.http ?? {});
  const authorizationServer = new AuthorizationServer(s, {
    clients,
    tokens,
    pairing,
    ...("passphraseHash" in deps
      ? deps.passphraseHash !== undefined
        ? { passphraseHash: deps.passphraseHash }
        : {}
      : { passphraseHash: FAKE_HASH }),
    // scrypt's real cost is exercised in the passphrase tests below; here a constant-time stand-in keeps tests fast.
    verifyPassphrase: async (p, h) => p === PASSPHRASE && h === FAKE_HASH,
    now: () => clock,
    audit,
    onEvent: (event, fields) => events.push({ event, fields }),
  });
  const l = await startHttpTransport(s, { tokens, clients, authorizationServer });
  if (!l) throw new Error("expected a listener");
  listener = l;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-authz-"));
  db = openLedger(dir);
  clock = new Date("2026-10-14T08:00:00.000Z");
  clients = new OAuthClientStore(db, { now: () => clock });
  tokens = new OAuthTokenStore(db, { now: () => clock });
  pairing = new PairingCodeStore(db, { now: () => clock });
  audit = new OAuthAuditLog(db, { now: () => clock });
  events = [];
  secrets = [PASSPHRASE];
  await start();
});

afterEach(async () => {
  await listener.close();
  // No secret value may reach the audit events or the ledger, whatever the test did.
  const audit = JSON.stringify(events);
  const ledger = ledgerBytes();
  for (const s of secrets) {
    expect(audit).not.toContain(s);
    expect(ledger).not.toContain(s);
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("authorization code flow with PKCE S256 (T13.8)", () => {
  it("approves a pending client with the passphrase and issues audience-bound, rotating tokens", async () => {
    const clientId = register();
    const { verifier, challenge } = pkce();
    const c = await openConsent(clientId, challenge);
    // Anti-framing, no caching, form submission limited to this origin and the client's redirect origin.
    const csp = String(c.reply.headers["content-security-policy"]);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self' https://grok.example.test");
    expect(c.reply.headers["x-frame-options"]).toBe("DENY");
    expect(c.reply.headers["cache-control"]).toBe("no-store");
    expect(c.cookie.startsWith(`${CONSENT_COOKIE}=`)).toBe(true);
    expect(String(c.reply.headers["set-cookie"])).toMatch(/Secure; HttpOnly; SameSite=Strict/);
    // The client-chosen name is escaped, and the page says the client is new.
    expect(c.reply.text).toContain("&#60;b&#62;Grok&#60;/b&#62; Bot");
    expect(c.reply.text).not.toContain("<b>Grok</b>");
    expect(c.reply.text).toContain("A new client asks to be approved");

    const approved = await submit(c, { decision: "approve", passphrase: PASSPHRASE });
    expect(approved.status).toBe(303);
    expect(approved.headers["x-frame-options"]).toBe("DENY");
    const params = redirectParams(approved);
    expect(params.get("state")).toBe("st-123");
    expect(params.get("iss")).toBe(ISSUER);
    const code = params.get("code") ?? "";
    expect(code).toMatch(/^sbac_[A-Za-z0-9_-]{43}$/);
    secrets.push(code, verifier);
    expect(clients.get(clientId)?.status).toBe("approved");

    const r = await exchange(clientId, code, verifier);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(r.text) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_MS / 1000, scope: "mcp" });
    const access = String(body.access_token);
    const refresh = String(body.refresh_token);
    secrets.push(access, refresh);
    // Audience binding (RFC 8707): valid for this resource only.
    expect(tokens.verify(access, "access", RESOURCE).ok).toBe(true);
    expect(tokens.verify(access, "access", "https://other.example.test/mcp")).toEqual({
      ok: false,
      reason: "wrong_audience",
    });
    const mcp = await call("POST", "/mcp", { authorization: `Bearer ${access}` });
    expect(mcp.status).toBe(403); // valid token, but this test maps the client to no MCP client (T13.4)

    // Refresh rotation: the new pair works, the old refresh token is spent.
    const rotated = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh });
    expect(rotated.status).toBe(200);
    const next = JSON.parse(rotated.text) as Record<string, string>;
    secrets.push(String(next.access_token), String(next.refresh_token));
    expect(next.refresh_token).not.toBe(refresh);
    expect(tokens.verify(String(next.access_token), "access", RESOURCE).ok).toBe(true);

    // Reusing the rotated-out refresh token revokes every token of the client (theft signal).
    const replay = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh });
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.text)).toEqual({ error: "invalid_grant" });
    expect(tokens.verify(String(next.access_token), "access", RESOURCE)).toEqual({ ok: false, reason: "revoked" });
    expect(tokens.verify(String(next.refresh_token), "refresh", RESOURCE)).toEqual({ ok: false, reason: "revoked" });
    expect(events.some((e) => e.event === "refresh_reused" && e.fields.client_id === clientId)).toBe(true);
  });

  it("asks an approved client again (no login session) and denies without changing the client", async () => {
    const clientId = register();
    await obtainCode(clientId);
    const { challenge } = pkce();
    const c = await openConsent(clientId, challenge);
    expect(c.reply.text).toContain("An approved client asks for a new authorization");
    const denied = await submit(c, { decision: "deny" });
    expect(denied.status).toBe(303);
    expect(redirectParams(denied).get("error")).toBe("access_denied");
    expect(clients.get(clientId)?.status).toBe("approved");

    // A stranger's "deny" on a pending client changes nothing either.
    const pendingId = register();
    const p = await openConsent(pendingId, pkce().challenge);
    expect((await submit(p, { decision: "deny" })).status).toBe(303);
    expect(clients.get(pendingId)?.status).toBe("pending");
  });

  it("issues no refresh token to a client that did not register the refresh grant", async () => {
    const clientId = register(["authorization_code"]);
    const { code, verifier } = await obtainCode(clientId);
    const r = await exchange(clientId, code, verifier);
    const body = JSON.parse(r.text) as Record<string, unknown>;
    secrets.push(String(body.access_token));
    expect(body.refresh_token).toBeUndefined();
    const refresh = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: "sbrt_x" });
    expect(JSON.parse(refresh.text)).toEqual({ error: "unauthorized_client" });
  });
});

describe("authorization request rejections (T13.8)", () => {
  it("never redirects for an unknown client or an unregistered redirect URI", async () => {
    const clientId = register();
    const { challenge } = pkce();
    for (const q of [
      authorizeQuery("sbc_unknown", challenge),
      authorizeQuery(clientId, challenge, { client_id: undefined }),
      authorizeQuery(clientId, challenge, { redirect_uri: OTHER_REDIRECT }),
      authorizeQuery(clientId, challenge, { redirect_uri: `${REDIRECT}/` }),
      authorizeQuery(clientId, challenge, { redirect_uri: undefined }),
      `${authorizeQuery(clientId, challenge)}&client_id=${clientId}`,
    ]) {
      const r = await call("GET", q);
      expect(r.status).toBe(400);
      expect(r.headers.location).toBeUndefined();
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.text).not.toContain("request_id");
    }
  });

  it.each([
    ["missing PKCE method (RFC 7636 default plain)", { code_challenge_method: undefined }, "invalid_request"],
    ["plain PKCE method", { code_challenge_method: "plain" }, "invalid_request"],
    ["missing code challenge", { code_challenge: undefined }, "invalid_request"],
    ["malformed code challenge", { code_challenge: "short" }, "invalid_request"],
    ["implicit response type", { response_type: "token" }, "unsupported_response_type"],
    ["missing resource", { resource: undefined }, "invalid_target"],
    ["another audience", { resource: "https://other.example.test/mcp" }, "invalid_target"],
    ["privileged scope", { scope: "privileged" }, "invalid_scope"],
    ["privileged beside mcp", { scope: "mcp privileged" }, "invalid_scope"],
    ["a trust-profile scope", { scope: "trusted-development" }, "invalid_scope"],
    ["empty scope", { scope: "" }, "invalid_scope"],
    ["an over-long state", { state: "s".repeat(513) }, "invalid_request"],
  ] as [string, Record<string, string | undefined>, string][])("refuses %s", async (_name, over, error) => {
    // A pending (self-registered) client's redirect URI is not trusted: error page, no redirect (no open redirector).
    const pendingId = register();
    const page = await call("GET", authorizeQuery(pendingId, pkce().challenge, over));
    expect(page.status).toBe(400);
    expect(page.headers.location).toBeUndefined();
    expect(page.text).not.toContain("request_id");
    // An approved client gets the RFC 6749 §4.1.2.1 error redirect.
    const clientId = register();
    db.prepare("UPDATE oauth_client SET status = 'approved' WHERE client_id = ?").run(clientId);
    const r = await call("GET", authorizeQuery(clientId, pkce().challenge, over));
    expect(r.status).toBe(302);
    const params = redirectParams(r);
    expect(params.get("error")).toBe(error);
    expect(params.get("state")).toBe(over.state === undefined ? "st-123" : null);
    expect(params.get("code")).toBeNull();
    expect(r.text).not.toContain("request_id");
  });

  it("refuses a denied or revoked client without redirecting", async () => {
    for (const status of ["denied", "revoked"]) {
      const clientId = register();
      db.prepare("UPDATE oauth_client SET status = ? WHERE client_id = ?").run(status, clientId);
      const r = await call("GET", authorizeQuery(clientId, pkce().challenge));
      expect(r.status).toBe(400);
      expect(r.headers.location).toBeUndefined();
      expect(r.text).toContain("this client is not approved");
    }
  });

  it("lets the issuer's own Origin through on /authorize only", async () => {
    for (const p of ["/token", "/register", "/mcp", "/.well-known/oauth-authorization-server"]) {
      expect((await call("POST", p, { origin: ISSUER })).status).toBe(403);
    }
    const clientId = register();
    expect((await call("GET", authorizeQuery(clientId, pkce().challenge), { origin: ISSUER })).status).toBe(200);
  });
});

describe("token endpoint rejections (T13.8)", () => {
  it("refuses a wrong or missing PKCE verifier, and the code is spent by the attempt", async () => {
    const clientId = register();
    const { code, verifier } = await obtainCode(clientId);
    const missing = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
    });
    expect(JSON.parse(missing.text)).toEqual({ error: "invalid_request" });
    const wrong = await exchange(clientId, code, pkce().verifier);
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.text)).toEqual({ error: "invalid_grant" });
    // The right verifier no longer helps: the code was used.
    expect(JSON.parse((await exchange(clientId, code, verifier)).text)).toEqual({ error: "invalid_grant" });
  });

  it("refuses a wrong redirect URI, another client's code and another audience", async () => {
    const clientId = register();
    const otherId = register();
    const a = await obtainCode(clientId);
    const wrongUri = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: a.code,
      redirect_uri: OTHER_REDIRECT,
      code_verifier: a.verifier,
    });
    expect(JSON.parse(wrongUri.text)).toEqual({ error: "invalid_grant" });
    const b = await obtainCode(clientId);
    expect(JSON.parse((await exchange(otherId, b.code, b.verifier)).text)).toEqual({ error: "invalid_grant" });
    const c = await obtainCode(clientId);
    const aud = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code: c.code,
      redirect_uri: REDIRECT,
      code_verifier: c.verifier,
      resource: "https://other.example.test/mcp",
    });
    expect(JSON.parse(aud.text)).toEqual({ error: "invalid_target" });
  });

  it("refuses a reused code and revokes the tokens it issued", async () => {
    const clientId = register();
    const { code, verifier } = await obtainCode(clientId);
    const first = JSON.parse((await exchange(clientId, code, verifier)).text) as Record<string, string>;
    secrets.push(String(first.access_token), String(first.refresh_token));
    const again = await exchange(clientId, code, verifier);
    expect(JSON.parse(again.text)).toEqual({ error: "invalid_grant" });
    expect(tokens.verify(String(first.access_token), "access", RESOURCE)).toEqual({ ok: false, reason: "revoked" });
    expect(events.some((e) => e.event === "code_reused")).toBe(true);
  });

  it("refuses an expired code", async () => {
    const clientId = register();
    const { code, verifier } = await obtainCode(clientId);
    clock = new Date(clock.getTime() + AUTHORIZATION_CODE_TTL_MS);
    expect(JSON.parse((await exchange(clientId, code, verifier)).text)).toEqual({ error: "invalid_grant" });
  });

  it("refuses other grant types, other encodings, repeated parameters and unknown clients", async () => {
    const clientId = register();
    for (const grant of [
      "password",
      "client_credentials",
      "implicit",
      "urn:ietf:params:oauth:grant-type:device_code",
    ]) {
      const r = await token({ grant_type: grant, client_id: clientId });
      expect(JSON.parse(r.text)).toEqual({ error: "unsupported_grant_type" });
    }
    const json = await call(
      "POST",
      "/token",
      { "content-type": "application/json" },
      JSON.stringify({ grant_type: "authorization_code" }),
    );
    expect(json.status).toBe(400);
    const dup = await call(
      "POST",
      "/token",
      { "content-type": "application/x-www-form-urlencoded" },
      `grant_type=refresh_token&client_id=${clientId}&client_id=${clientId}`,
    );
    expect(JSON.parse(dup.text)).toEqual({ error: "invalid_request" });
    const unknown = await token({ grant_type: "authorization_code", client_id: "sbc_nobody" });
    expect(unknown.status).toBe(401);
    expect(JSON.parse(unknown.text)).toEqual({ error: "invalid_client" });
    expect((await call("GET", "/token")).status).toBe(405);
  });

  it("refuses an access token as a refresh token and a privileged scope on refresh", async () => {
    const clientId = register();
    const { code, verifier } = await obtainCode(clientId);
    const pair = JSON.parse((await exchange(clientId, code, verifier)).text) as Record<string, string>;
    secrets.push(String(pair.access_token), String(pair.refresh_token));
    const asRefresh = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: String(pair.access_token),
    });
    expect(JSON.parse(asRefresh.text)).toEqual({ error: "invalid_grant" });
    const priv = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: String(pair.refresh_token),
      scope: "mcp privileged",
    });
    expect(JSON.parse(priv.text)).toEqual({ error: "invalid_scope" });
  });
});

describe("refresh-token rotation edge cases (T13.8)", () => {
  async function pair(clientId: string): Promise<{ access: string; refresh: string }> {
    const { code, verifier } = await obtainCode(clientId);
    const body = JSON.parse((await exchange(clientId, code, verifier)).text) as Record<string, string>;
    const out = { access: String(body.access_token), refresh: String(body.refresh_token) };
    secrets.push(out.access, out.refresh);
    return out;
  }
  const refreshWith = (clientId: string, refresh: string, extra: Record<string, string> = {}) =>
    token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh, ...extra });

  it("keeps the refresh token after a refusal that is the request's fault", async () => {
    const clientId = register();
    const otherId = register();
    db.prepare("UPDATE oauth_client SET status = 'approved' WHERE client_id = ?").run(otherId);
    const t = await pair(clientId);
    expect(JSON.parse((await refreshWith(clientId, t.refresh, { scope: "privileged" })).text)).toEqual({
      error: "invalid_scope",
    });
    // Presented under another client's id: refused, and not spent.
    expect(JSON.parse((await refreshWith(otherId, t.refresh)).text)).toEqual({ error: "invalid_grant" });
    const ok = await refreshWith(clientId, t.refresh);
    expect(ok.status).toBe(200);
    const next = JSON.parse(ok.text) as Record<string, string>;
    secrets.push(String(next.access_token), String(next.refresh_token));
    expect(tokens.verify(String(next.access_token), "access", RESOURCE).ok).toBe(true);
  });

  it("refuses an expired refresh token and a client revoked after consent", async () => {
    const clientId = register();
    const t = await pair(clientId);
    const revokedLater = register();
    const { code, verifier } = await obtainCode(revokedLater);
    db.prepare("UPDATE oauth_client SET status = 'revoked' WHERE client_id = ?").run(revokedLater);
    expect(JSON.parse((await exchange(revokedLater, code, verifier)).text)).toEqual({ error: "invalid_grant" });
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(JSON.parse((await refreshWith(clientId, t.refresh)).text)).toEqual({ error: "invalid_grant" });
  });

  it("lets only one of two concurrent rotations of the same token succeed", async () => {
    const clientId = register();
    const t = await pair(clientId);
    const replies = await Promise.all([refreshWith(clientId, t.refresh), refreshWith(clientId, t.refresh)]);
    const statuses = replies.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    const winner = JSON.parse((replies.find((r) => r.status === 200) as Reply).text) as Record<string, string>;
    secrets.push(String(winner.access_token), String(winner.refresh_token));
  });
});

describe("consent page authentication, lockout and CSRF (T13.8)", () => {
  it("refuses a wrong passphrase, re-renders with a fresh CSRF token, and issues no code", async () => {
    const clientId = register();
    const c = await openConsent(clientId, pkce().challenge);
    const wrong = await submit(c, { decision: "approve", passphrase: "not the passphrase" });
    secrets.push("not the passphrase");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.location).toBeUndefined();
    expect(wrong.text).toContain("Wrong passphrase or pairing code.");
    expect(wrong.text).not.toContain("not the passphrase");
    const again = consentFrom(wrong);
    expect(again.csrf).not.toBe(c.csrf);
    expect(clients.get(clientId)?.status).toBe("pending");
    // The old CSRF token is dead; the new one works.
    expect((await submit(c, { decision: "approve", passphrase: PASSPHRASE })).status).toBe(403);
    const c2 = await openConsent(clientId, pkce().challenge);
    expect((await submit(c2, { decision: "approve", passphrase: PASSPHRASE })).status).toBe(303);
    expect(events.some((e) => e.event === "consent_failed" && e.fields.method === "passphrase")).toBe(true);
  });

  it("asks for a credential when none is given, without counting a failure", async () => {
    const c = await openConsent(register(), pkce().challenge);
    const r = await submit(c, { decision: "approve" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("Enter the operator passphrase or a pairing code.");
  });

  it("locks passphrase approval after repeated failures, refusing even the right passphrase until it ends", async () => {
    const clientId = register();
    let c = await openConsent(clientId, pkce().challenge);
    // Wrong pairing codes do not count towards the passphrase lockout.
    const wrongCode = await submit(c, { decision: "approve", pairing_code: "AAAA-BBBB-CCCC" });
    expect(wrongCode.status).toBe(401);
    c = consentFrom(wrongCode);
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      const r = await submit(c, { decision: "approve", passphrase: `wrong-${i}-passphrase` });
      secrets.push(`wrong-${i}-passphrase`);
      expect(r.status).toBe(401);
      c = consentFrom(r);
    }
    const last = await submit(c, { decision: "approve", passphrase: "wrong-last-passphrase" });
    secrets.push("wrong-last-passphrase");
    expect(last.status).toBe(429);
    expect(last.headers["retry-after"]).toBe(String(LOCKOUT_MS / 1000));
    expect(events.some((e) => e.event === "consent_locked_out")).toBe(true);

    const locked = await openConsent(clientId, pkce().challenge);
    const refused = await submit(locked, { decision: "approve", passphrase: PASSPHRASE });
    expect(refused.status).toBe(429);
    expect(refused.headers.location).toBeUndefined();
    expect(clients.get(clientId)?.status).toBe("pending");

    // The lockout does not block the operator's local recovery path: a fresh pairing code still works.
    const live = pairing.create();
    secrets.push(live.code, norm(live.code));
    const viaPairing = await openConsent(clientId, pkce().challenge);
    const paired = await submit(viaPairing, { decision: "approve", pairing_code: live.code });
    expect(paired.status).toBe(303);
    secrets.push(codeOf(paired));

    // The passphrase works again once the lockout ends.
    clock = new Date(clock.getTime() + LOCKOUT_MS);
    const after = await openConsent(clientId, pkce().challenge);
    const ok = await submit(after, { decision: "approve", passphrase: PASSPHRASE });
    expect(ok.status).toBe(303);
    secrets.push(codeOf(ok));
  });

  it("throttles wrong pairing codes without consuming or ending the live code", async () => {
    // The stranger's wrong codes come from another address than the operator's (behind the loopback proxy), so the
    // per-address lockout locks only the stranger; the global throttle still applies to everyone.
    await listener.close();
    await start({ http: { client_ip_header: "x-client-ip" } });
    const stranger = { "x-client-ip": "198.51.100.7" };
    const clientId = register();
    const live = pairing.create();
    secrets.push(live.code, norm(live.code));
    let c = await openConsent(clientId, pkce().challenge);
    for (let i = 0; i < MAX_PAIRING_FAILURES_PER_MINUTE - 1; i++) {
      const r = await submit(c, { decision: "approve", pairing_code: "AAAA-BBBB-CCCC" }, stranger);
      expect(r.status).toBe(401);
      c = consentFrom(r);
    }
    // The tenth wrong code from one address within the window locks that address.
    const lockedStranger = await submit(c, { decision: "approve", pairing_code: "AAAA-BBBB-CCCC" }, stranger);
    expect(lockedStranger.status).toBe(429);
    c = await openConsent(clientId, pkce().challenge);
    const throttled = await submit(c, { decision: "approve", pairing_code: live.code });
    expect(throttled.status).toBe(429);
    expect(db.prepare("SELECT used_at FROM oauth_pairing_code").get()).toEqual({ used_at: null });
    clock = new Date(clock.getTime() + 60_000);
    const ok = await submit(consentFrom(throttled), { decision: "approve", pairing_code: live.code });
    expect(ok.status).toBe(303);
    secrets.push(codeOf(ok));
  });

  it("accepts a pairing code once, and refuses a reused, expired or superseded one", async () => {
    await listener.close();
    await start({ passphraseHash: undefined }); // pairing codes only
    const clientId = register();
    const first = pairing.create();
    secrets.push(first.code, norm(first.code));
    expect(first.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(Date.parse(first.expiresAt) - clock.getTime()).toBe(PAIRING_CODE_TTL_MS);

    const c = await openConsent(clientId, pkce().challenge);
    const ok = await submit(c, { decision: "approve", pairing_code: first.code.toLowerCase() });
    expect(ok.status).toBe(303);
    secrets.push(codeOf(ok));
    expect(events.some((e) => e.event === "consent_approved" && e.fields.method === "pairing_code")).toBe(true);

    // Reused.
    const reuse = await openConsent(clientId, pkce().challenge);
    expect((await submit(reuse, { decision: "approve", pairing_code: first.code })).status).toBe(401);

    // Expired.
    const late = pairing.create();
    secrets.push(late.code, norm(late.code));
    clock = new Date(clock.getTime() + PAIRING_CODE_TTL_MS);
    const expired = await openConsent(clientId, pkce().challenge);
    expect((await submit(expired, { decision: "approve", pairing_code: late.code })).status).toBe(401);

    // Superseded by a newer code.
    const older = pairing.create();
    const newer = pairing.create();
    secrets.push(older.code, newer.code, norm(older.code), norm(newer.code));
    const sup = await openConsent(clientId, pkce().challenge);
    expect((await submit(sup, { decision: "approve", pairing_code: older.code })).status).toBe(401);

    // With no passphrase configured, a passphrase never matches.
    const pass = await openConsent(clientId, pkce().challenge);
    expect((await submit(pass, { decision: "approve", passphrase: PASSPHRASE })).status).toBe(401);
  });

  it("refuses a POST without the CSRF cookie, with a wrong token, cross-site, or from another origin", async () => {
    const clientId = register();
    const noCookie = await openConsent(clientId, pkce().challenge);
    expect((await submit(noCookie, { decision: "approve", passphrase: PASSPHRASE }, {}, null)).status).toBe(403);
    // The failed CSRF check ended that request.
    expect((await submit(noCookie, { decision: "approve", passphrase: PASSPHRASE })).status).toBe(400);

    const wrongToken = await openConsent(clientId, pkce().challenge);
    const forged = { ...wrongToken, csrf: randomBytes(32).toString("base64url") };
    expect((await submit(forged, { decision: "approve", passphrase: PASSPHRASE })).status).toBe(403);

    const otherCookie = await openConsent(clientId, pkce().challenge);
    const mixed = await submit(
      otherCookie,
      { decision: "approve", passphrase: PASSPHRASE },
      {},
      `${CONSENT_COOKIE}=${randomBytes(32).toString("base64url")}`,
    );
    expect(mixed.status).toBe(403);

    const crossSite = await openConsent(clientId, pkce().challenge);
    const cs = await submit(
      crossSite,
      { decision: "approve", passphrase: PASSPHRASE },
      { "sec-fetch-site": "cross-site" },
    );
    expect(cs.status).toBe(403);

    // An origin outside allowed_origins is refused before routing; an allowed one may not post consent either.
    const foreign = await openConsent(clientId, pkce().challenge);
    const f = await submit(
      foreign,
      { decision: "approve", passphrase: PASSPHRASE },
      { origin: "https://evil.example.test" },
    );
    expect(f.status).toBe(403);
    await listener.close();
    await start({ allowed: ["https://app.example.test"] });
    const allowed = await openConsent(clientId, pkce().challenge);
    const a = await submit(
      allowed,
      { decision: "approve", passphrase: PASSPHRASE },
      { origin: "https://app.example.test" },
    );
    expect(a.status).toBe(403);
    expect(clients.get(clientId)?.status).toBe("pending");
  });

  it("drops pending clients' consent requests first when too many are open", async () => {
    const approvedId = register();
    db.prepare("UPDATE oauth_client SET status = 'approved' WHERE client_id = ?").run(approvedId);
    const operator = await openConsent(approvedId, pkce().challenge);
    const flooder = register();
    const firstFlood = await openConsent(flooder, pkce().challenge);
    for (let i = 0; i < MAX_CONSENT_REQUESTS; i++) await openConsent(flooder, pkce().challenge);
    // The flood pushed out its own oldest request, not the approved client's.
    expect((await submit(firstFlood, { decision: "approve", passphrase: PASSPHRASE })).status).toBe(400);
    const ok = await submit(operator, { decision: "approve", passphrase: PASSPHRASE });
    expect(ok.status).toBe(303);
    secrets.push(codeOf(ok));
  });

  it("puts no secret in any response other than the one it is for", async () => {
    const clientId = register();
    const { code, verifier } = await obtainCode(clientId);
    const pair = JSON.parse((await exchange(clientId, code, verifier)).text) as Record<string, string>;
    secrets.push(String(pair.access_token), String(pair.refresh_token));
    const replies = [
      await exchange(clientId, code, verifier),
      await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: String(pair.access_token) }),
      await call("POST", "/mcp", { authorization: `Bearer ${String(pair.refresh_token)}` }),
      await submit(await openConsent(clientId, pkce().challenge), {
        decision: "approve",
        passphrase: "wrong passphrase!",
      }),
    ];
    secrets.push("wrong passphrase!");
    for (const r of replies) {
      const all = `${JSON.stringify(r.headers)}${r.text}`;
      for (const s of secrets) expect(all).not.toContain(s);
    }
  });
});

describe("operator passphrase hash (Q-75)", () => {
  it("hashes with scrypt N=2^17, r=8, p=1 and verifies only the right passphrase", async () => {
    const encoded = await hashPassphrase(PASSPHRASE);
    expect(encoded).toMatch(/^scrypt\$17\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(encoded).not.toContain(PASSPHRASE);
    expect(isPassphraseHash(encoded)).toBe(true);
    expect(await verifyPassphrase(PASSPHRASE, encoded)).toBe(true);
    expect(await verifyPassphrase(`${PASSPHRASE} `, encoded)).toBe(false);
    expect(await verifyPassphrase(PASSPHRASE, encoded.replace("$17$", "$14$"))).toBe(false);
    expect(await verifyPassphrase("", encoded)).toBe(false);
    // Salted: the same passphrase hashes differently.
    expect(await hashPassphrase(PASSPHRASE)).not.toBe(encoded);
    await expect(hashPassphrase("short")).rejects.toThrow(/12 to 1024/);
  }, 30_000);

  it("refuses a malformed or weaker hash at config load", () => {
    const at = (h: string) =>
      checkHttpTransport({ enabled: true, public_url: RESOURCE, port: 0, passphrase_hash: h }).join("\n");
    expect(at(FAKE_HASH)).toBe("");
    expect(at(PASSPHRASE)).toMatch(/passphrase_hash/);
    expect(at(FAKE_HASH.replace("$17$", "$10$"))).toMatch(/passphrase_hash/);
    expect(at(`$argon2id$v=19$m=65536,t=3,p=4$${"A".repeat(22)}$${"B".repeat(43)}`)).toMatch(/passphrase_hash/);
    expect(
      resolveHttpTransport({ enabled: true, public_url: RESOURCE, port: 0, passphrase_hash: FAKE_HASH })
        ?.passphraseHash,
    ).toBe(FAKE_HASH);
  });
});

describe("profile-bound one-time codes on the consent page (migration 0037)", () => {
  async function approveWithCode(clientId: string, code: string, headers: Record<string, string> = {}) {
    const c = await openConsent(clientId, pkce().challenge);
    return submit(c, { decision: "approve", pairing_code: code }, headers);
  }

  function liveCode(mcpClient?: string) {
    const c = pairing.create(mcpClient !== undefined ? { mcpClient } : {});
    secrets.push(c.code, norm(c.code));
    return c;
  }

  it("labels the field as a one-time code from issue-code and keeps the pairing_code field name", async () => {
    const c = await openConsent(register(), pkce().challenge);
    expect(c.reply.text).toContain('name="pairing_code"');
    expect(c.reply.text).toContain("switchboard mcp oauth issue-code");
  });

  it("approves a pending client and binds it to the code's profile, audited without the code", async () => {
    const clientId = register();
    const code = liveCode("grok-bot");
    const r = await approveWithCode(clientId, code.code);
    expect(r.status).toBe(303);
    secrets.push(codeOf(r));
    const stored = clients.get(clientId);
    expect(stored?.status).toBe("approved");
    expect(stored?.mcpClient).toBe("grok-bot");
    expect(stored?.boundAt).toBe(clock.toISOString());
    const approved = events.find((e) => e.event === "consent_approved");
    expect(approved?.fields).toMatchObject({ client_id: clientId, method: "pairing_code", mcp_client: "grok-bot" });
    expect(approved?.fields.ip).toBe("127.0.0.1");
    expect(audit.list(clientId)).toEqual([
      expect.objectContaining({
        kind: "consent_approved",
        client_id: clientId,
        mcp_client: "grok-bot",
        method: "bound_code",
        actor: "endpoint",
        ip: "127.0.0.1",
        reason: "bound",
      }),
    ]);
  });

  it("binds an approved unbound client, and a legacy code or the passphrase binds nothing", async () => {
    const clientId = register();
    const legacy = liveCode();
    const first = await approveWithCode(clientId, legacy.code);
    expect(first.status).toBe(303);
    secrets.push(codeOf(first));
    expect(clients.get(clientId)?.mcpClient).toBeUndefined();
    const viaPassphrase = await obtainCode(clientId);
    expect(viaPassphrase.code).toBeDefined();
    expect(clients.get(clientId)?.mcpClient).toBeUndefined();

    const bound = liveCode("grok-bot");
    const second = await approveWithCode(clientId, bound.code);
    expect(second.status).toBe(303);
    secrets.push(codeOf(second));
    expect(clients.get(clientId)?.mcpClient).toBe("grok-bot");
    // The same profile again is fine; nothing changes.
    const again = await approveWithCode(clientId, liveCode("grok-bot").code);
    expect(again.status).toBe(303);
    secrets.push(codeOf(again));
  });

  it("refuses a client bound to another profile before spending the code", async () => {
    const clientId = register();
    const first = await approveWithCode(clientId, liveCode("grok-bot").code);
    secrets.push(codeOf(first));
    const other = liveCode("other");
    const r = await approveWithCode(clientId, other.code);
    expect(r.status).toBe(403);
    expect(r.text).toContain("already bound to a different client profile");
    expect(r.headers.location).toBeUndefined();
    expect(pairing.lookup(other.code)).toEqual({ mcpClient: "other" }); // still live
    expect(clients.get(clientId)?.mcpClient).toBe("grok-bot");
    expect(events.some((e) => e.event === "consent_refused_profile" && e.fields.reason === "bound_elsewhere")).toBe(
      true,
    );
  });

  it("refuses a client the config maps to another profile, and does not ledger-bind a config-mapped client", async () => {
    const mappedOther = register();
    const mappedSame = register();
    await listener.close();
    await start({
      http: {
        clients: [
          { oauth_client_id: mappedOther, mcp_client: "other" },
          { oauth_client_id: mappedSame, mcp_client: "grok-bot" },
        ],
      },
    });
    const code = liveCode("grok-bot");
    const refused = await approveWithCode(mappedOther, code.code);
    expect(refused.status).toBe(403);
    expect(pairing.lookup(code.code)).toBeDefined();
    expect(clients.get(mappedOther)?.status).toBe("pending");

    const ok = await approveWithCode(mappedSame, code.code);
    expect(ok.status).toBe(303);
    secrets.push(codeOf(ok));
    expect(clients.get(mappedSame)?.status).toBe("approved");
    expect(clients.get(mappedSame)?.mcpClient).toBeUndefined(); // the config mapping is the source
  });

  it("refuses a code whose profile is not eligible for a binding (approval not_required) and keeps it live", async () => {
    const clientId = register();
    const root = liveCode("auto"); // issue-code refuses this; the page checks again
    const r = await approveWithCode(clientId, root.code);
    expect(r.status).toBe(403);
    expect(r.text).toContain("can no longer be used over HTTP");
    expect(pairing.lookup(root.code)).toBeDefined();
    expect(clients.get(clientId)?.status).toBe("pending");
  });

  it("refuses denied and revoked clients exactly as before", async () => {
    const clientId = register();
    const first = await approveWithCode(clientId, liveCode("grok-bot").code);
    secrets.push(codeOf(first));
    const c = await openConsent(clientId, pkce().challenge);
    clients.revoke(clientId);
    const code = liveCode("grok-bot");
    const r = await submit(c, { decision: "approve", pairing_code: code.code });
    expect(r.status).toBe(403);
    expect(r.text).toContain("not approved");
  });
});

describe("per-address lockout for wrong codes and passphrases", () => {
  const from = (ip: string) => ({ "x-client-ip": ip });

  beforeEach(async () => {
    await listener.close();
    await start({ http: { client_ip_header: "x-client-ip" } });
  });

  it("locks one address after ten wrong codes in five minutes, for fifteen minutes, without ending the live code", async () => {
    const clientId = register();
    const live = pairing.create({ mcpClient: "grok-bot" });
    secrets.push(live.code, norm(live.code));
    let last: Reply | undefined;
    for (let i = 0; i < 10; i++) {
      // 25 s apart: the global throttle (ten a minute) never trips, the per-address window (five minutes) does.
      clock = new Date(clock.getTime() + 25_000);
      const c = await openConsent(clientId, pkce().challenge);
      last = await submit(c, { decision: "approve", pairing_code: "AAAA-BBBB-CCCC" }, from("198.51.100.7"));
      if (i < 9) expect(last.status).toBe(401);
    }
    expect(last?.status).toBe(429);
    expect(last?.headers["retry-after"]).toBe("900");
    // The locked address is refused even with the right code, which stays live.
    const c1 = await openConsent(clientId, pkce().challenge);
    const blocked = await submit(c1, { decision: "approve", pairing_code: live.code }, from("198.51.100.7"));
    expect(blocked.status).toBe(429);
    expect(pairing.lookup(live.code)).toBeDefined();
    // Another address is not affected.
    const c2 = await openConsent(clientId, pkce().challenge);
    const ok = await submit(c2, { decision: "approve", pairing_code: live.code }, from("203.0.113.20"));
    expect(ok.status).toBe(303);
    secrets.push(codeOf(ok));
    // After the lock the address may try again.
    clock = new Date(clock.getTime() + 15 * 60_000);
    const c3 = await openConsent(clientId, pkce().challenge);
    expect((await submit(c3, { decision: "approve", passphrase: PASSPHRASE }, from("198.51.100.7"))).status).toBe(303);
  });

  it("counts wrong passphrases too, and refuses the right passphrase from a locked address", async () => {
    const clientId = register();
    for (let i = 0; i < 4; i++) {
      const c = await openConsent(clientId, pkce().challenge);
      expect((await submit(c, { decision: "approve", passphrase: "wrong" }, from("198.51.100.8"))).status).toBe(401);
    }
    for (let i = 0; i < 6; i++) {
      clock = new Date(clock.getTime() + 20_000);
      const c = await openConsent(clientId, pkce().challenge);
      await submit(c, { decision: "approve", pairing_code: "AAAA-BBBB-CCCC" }, from("198.51.100.8"));
    }
    const c = await openConsent(clientId, pkce().challenge);
    const r = await submit(c, { decision: "approve", passphrase: PASSPHRASE }, from("198.51.100.8"));
    expect(r.status).toBe(429);
    expect(events.some((e) => e.event === "consent_refused_locked" && e.fields.reason === "address_locked")).toBe(true);
    const other = await openConsent(clientId, pkce().challenge);
    expect((await submit(other, { decision: "approve", passphrase: PASSPHRASE }, from("198.51.100.9"))).status).toBe(
      303,
    );
  });
});

describe("RFC 7009 revocation endpoint", () => {
  function revoke(fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Reply> {
    return call(
      "POST",
      "/revoke",
      { "content-type": "application/x-www-form-urlencoded", ...headers },
      new URLSearchParams(fields).toString(),
    );
  }

  async function grant(clientId: string): Promise<{ access: string; refresh: string }> {
    const { code, verifier } = await obtainCode(clientId);
    const r = await exchange(clientId, code, verifier);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as { access_token: string; refresh_token: string };
    secrets.push(body.access_token, body.refresh_token);
    return { access: body.access_token, refresh: body.refresh_token };
  }

  it("advertises the endpoint with public-client authentication", async () => {
    const meta = JSON.parse((await call("GET", "/.well-known/oauth-authorization-server")).text) as Record<
      string,
      unknown
    >;
    expect(meta.revocation_endpoint).toBe(`${ISSUER}/revoke`);
    expect(meta.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("revokes an access token alone, and a refresh token with its whole grant only", async () => {
    const clientId = register();
    const a = await grant(clientId);
    const b = await grant(clientId);
    const r1 = await revoke({ token: a.access, token_type_hint: "access_token", client_id: clientId });
    expect(r1.status).toBe(200);
    expect(r1.text).toBe("");
    expect(r1.headers["cache-control"]).toBe("no-store");
    expect(tokens.verify(a.access, "access", RESOURCE).ok).toBe(false);
    expect(tokens.verify(a.refresh, "refresh", RESOURCE).ok).toBe(true);

    // Rotate grant b once, then revoke the new refresh token: the rotated access token of the same grant goes too.
    const rotated = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: b.refresh });
    expect(rotated.status).toBe(200);
    const nb = JSON.parse(rotated.text) as { access_token: string; refresh_token: string };
    secrets.push(nb.access_token, nb.refresh_token);
    expect((await revoke({ token: nb.refresh_token, client_id: clientId })).status).toBe(200);
    expect(tokens.verify(nb.refresh_token, "refresh", RESOURCE).ok).toBe(false);
    expect(tokens.verify(nb.access_token, "access", RESOURCE).ok).toBe(false);
    // Grant a's refresh token is another grant: untouched.
    expect(tokens.verify(a.refresh, "refresh", RESOURCE).ok).toBe(true);
    expect(audit.list(clientId).filter((e) => e.kind === "token_revoked")).toHaveLength(2);
  });

  it("answers 200 and changes nothing for another client's token or an unknown one", async () => {
    const mine = register();
    const theirs = register();
    const t = await grant(theirs);
    expect((await revoke({ token: t.access, client_id: mine })).status).toBe(200);
    expect(tokens.verify(t.access, "access", RESOURCE).ok).toBe(true);
    expect((await revoke({ token: `sbat_${"A".repeat(43)}`, client_id: mine })).status).toBe(200);
    expect((await revoke({ token: "garbage", client_id: mine })).status).toBe(200);
    expect(audit.list(mine)).toEqual([]);
    expect(events.filter((e) => e.event === "token_revoked").every((e) => e.fields.reason === "no_match")).toBe(true);
  });

  it("refuses a missing token, a missing or unknown client and malformed requests", async () => {
    const clientId = register();
    const missing = await revoke({ client_id: clientId });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.text)).toEqual({ error: "invalid_request" });
    const unknown = await revoke({ token: "x", client_id: `sbc_${"A".repeat(22)}` });
    expect(unknown.status).toBe(401);
    expect(JSON.parse(unknown.text)).toEqual({ error: "invalid_client" });
    expect((await revoke({ token: "x" })).status).toBe(401);
    expect(
      (await call("POST", "/revoke", { "content-type": "application/json" }, JSON.stringify({ token: "x" }))).status,
    ).toBe(400);
    expect(
      (
        await call(
          "POST",
          "/revoke",
          { "content-type": "application/x-www-form-urlencoded" },
          `token=a&token=b&client_id=${clientId}`,
        )
      ).status,
    ).toBe(400);
    expect((await call("GET", "/revoke")).status).toBe(405);
    expect(
      (
        await call(
          "POST",
          "/revoke",
          { "content-type": "application/x-www-form-urlencoded" },
          `client_id=${clientId}&token=${"a".repeat(9000)}`,
        )
      ).status,
    ).toBe(413);
    // The Origin rule of /token applies: a browser origin that is not allowed is refused before routing.
    expect((await revoke({ token: "x", client_id: clientId }, { origin: "https://evil.example.test" })).status).toBe(
      403,
    );
  });

  it("audits token issue and refresh with the profile, never a token", async () => {
    await listener.close();
    await start({ http: { default_mcp_client: "grok-bot" } });
    const clientId = register();
    const g = await grant(clientId);
    const r = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: g.refresh });
    const body = JSON.parse(r.text) as { access_token: string; refresh_token: string };
    secrets.push(body.access_token, body.refresh_token);
    const kinds = audit.list(clientId).map((e) => [e.kind, e.mcp_client]);
    expect(kinds).toEqual([
      ["consent_approved", "grok-bot"],
      ["token_issued", "grok-bot"],
      ["token_refreshed", "grok-bot"],
    ]);
  });
});
