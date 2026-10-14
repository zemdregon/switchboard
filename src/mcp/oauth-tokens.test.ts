import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HttpTransportSettings, resolveHttpTransport } from "../config/index.js";
import { openLedger } from "../ledger/index.js";
import { startHttpTransport } from "./http.js";
import { bearerToken, looksLikeOAuthToken, OAuthTokenStore, type TokenRejectReason } from "./oauth-tokens.js";

const RESOURCE = "https://sb.example.test/mcp";
const PRM = "https://sb.example.test/.well-known/oauth-protected-resource/mcp";

const settings = (): HttpTransportSettings =>
  resolveHttpTransport({ enabled: true, public_url: RESOURCE, port: 0 }) as HttpTransportSettings;

let dir: string;
let db: Database.Database;
let clock: Date;
let store: OAuthTokenStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-oauth-"));
  db = openLedger(dir);
  clock = new Date("2026-10-14T06:00:00.000Z");
  store = new OAuthTokenStore(db, { now: () => clock });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const access = (over: Partial<Parameters<OAuthTokenStore["issue"]>[0]> = {}) =>
  store.issue({ kind: "access", clientId: "grok-bot", resource: RESOURCE, scopes: ["mcp"], ttlMs: 600_000, ...over });

/** Every byte the ledger wrote (main file, WAL, shared memory), as latin1 text for a substring scan. */
function ledgerBytes(): string {
  return readdirSync(dir)
    .map((f) => readFileSync(path.join(dir, f)).toString("latin1"))
    .join("\n");
}

describe("token issue and storage (T13.3, Q-69)", () => {
  it("mints opaque 256-bit tokens and stores only their SHA-256 hash", () => {
    const a = access();
    const r = store.issue({ kind: "refresh", clientId: "grok-bot", resource: RESOURCE, scopes: [], ttlMs: 1000 });
    expect(a.token).toMatch(/^sbat_[A-Za-z0-9_-]{43}$/);
    expect(r.token).toMatch(/^sbrt_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.token.slice(5), "base64url")).toHaveLength(32);
    expect(a.token.split(".")).toHaveLength(1); // not a JWT
    expect(a.expiresAt).toBe("2026-10-14T06:10:00.000Z");
    expect(new Set(Array.from({ length: 50 }, () => access().token)).size).toBe(50);

    const rows = db.prepare("SELECT * FROM oauth_token").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(52);
    for (const row of rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toMatch(/sb(at|rt)_/);
    }
    db.pragma("wal_checkpoint(TRUNCATE)");
    for (const t of [a.token, r.token]) expect(ledgerBytes()).not.toContain(t);
    expect(ledgerBytes()).not.toMatch(/sb(at|rt)_[A-Za-z0-9_-]{43}/);
  });

  it("refuses a raw token value in the hash column (schema check)", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO oauth_token (token_hash, kind, client_id, resource, scopes_json, issued_at, expires_at)
           VALUES (?, 'access', 'c', ?, '[]', 'x', 'y')`,
        )
        .run(access().token, RESOURCE),
    ).toThrow(/CHECK constraint/);
  });

  it("refuses a non-positive or fractional lifetime and an empty client or resource", () => {
    for (const ttlMs of [0, -1, 1.5, Number.NaN]) expect(() => access({ ttlMs })).toThrow(/ttlMs/);
    expect(() => access({ clientId: "" })).toThrow();
    expect(() => access({ resource: "" })).toThrow();
  });
});

describe("token verification (FR-MCP-13)", () => {
  it("accepts a live access token for this audience", () => {
    const { token } = access({ scopes: ["mcp", "read"] });
    expect(store.verify(token, "access", RESOURCE)).toEqual({
      ok: true,
      token: {
        clientId: "grok-bot",
        resource: RESOURCE,
        scopes: ["mcp", "read"],
        expiresAt: "2026-10-14T06:10:00.000Z",
      },
    });
  });

  it.each([
    ["empty", ""],
    ["JWT", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."],
    ["short", "sbat_abc"],
    ["bad alphabet", `sbat_${"+".repeat(43)}`],
    ["unknown prefix", `sbxx_${"A".repeat(43)}`],
    ["trailing data", `sbat_${"A".repeat(43)}x`],
  ])("refuses a malformed token (%s)", (_name, token) => {
    expect(store.verify(token, "access", RESOURCE)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a well-formed token it did not issue, including one from another issuer's store", () => {
    expect(store.verify(`sbat_${"A".repeat(43)}`, "access", RESOURCE)).toEqual({ ok: false, reason: "unknown" });
    const otherDir = mkdtempSync(path.join(tmpdir(), "sb-oauth-other-"));
    const otherDb = openLedger(otherDir);
    try {
      const foreign = new OAuthTokenStore(otherDb).issue({
        kind: "access",
        clientId: "grok-bot",
        resource: RESOURCE,
        scopes: ["mcp"],
        ttlMs: 600_000,
      });
      expect(store.verify(foreign.token, "access", RESOURCE)).toEqual({ ok: false, reason: "unknown" });
    } finally {
      otherDb.close();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("refuses a refresh token used as an access token and the reverse", () => {
    const r = store.issue({ kind: "refresh", clientId: "grok-bot", resource: RESOURCE, scopes: [], ttlMs: 1000 });
    expect(store.verify(r.token, "access", RESOURCE)).toEqual({ ok: false, reason: "wrong_kind" });
    expect(store.verify(access().token, "refresh", RESOURCE)).toEqual({ ok: false, reason: "wrong_kind" });
  });

  it("refuses an expired token from the expiry instant on", () => {
    const { token } = access({ ttlMs: 1000 });
    clock = new Date("2026-10-14T06:00:00.999Z");
    expect(store.verify(token, "access", RESOURCE).ok).toBe(true);
    clock = new Date("2026-10-14T06:00:01.000Z");
    expect(store.verify(token, "access", RESOURCE)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a revoked token, by value and by client", () => {
    const one = access();
    const two = access();
    const other = access({ clientId: "other" });
    expect(store.revokeToken(one.token)).toBe(true);
    expect(store.revokeToken(one.token)).toBe(false);
    expect(store.revokeToken("not-a-token")).toBe(false);
    expect(store.verify(one.token, "access", RESOURCE)).toEqual({ ok: false, reason: "revoked" });
    expect(store.verify(two.token, "access", RESOURCE).ok).toBe(true);
    expect(store.revokeClient("grok-bot")).toBe(1);
    expect(store.verify(two.token, "access", RESOURCE)).toEqual({ ok: false, reason: "revoked" });
    expect(store.verify(other.token, "access", RESOURCE).ok).toBe(true);
    const row = db.prepare("SELECT revoked, revoked_at FROM oauth_token WHERE client_id = 'grok-bot' LIMIT 1").get();
    expect(row).toEqual({ revoked: 1, revoked_at: "2026-10-14T06:00:00.000Z" });
  });

  it("refuses a token bound to another audience (RFC 8707)", () => {
    for (const resource of [
      "https://other.example.test/mcp",
      "https://sb.example.test/mcp/",
      "https://sb.example.test",
    ]) {
      const { token } = access({ resource });
      expect(store.verify(token, "access", RESOURCE)).toEqual({ ok: false, reason: "wrong_audience" });
    }
  });
});

describe("bearer header parsing (RFC 6750 §2.1)", () => {
  it.each([
    [undefined, undefined],
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["Bearer  abc ", "abc"],
    ["Basic abc", null],
    ["Bearer", null],
    ["Bearer a b", null],
    ["Bearerabc", null],
    ["", null],
  ])("%j -> %j", (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });
});

describe("MCP endpoint token check over HTTP (T13.3)", () => {
  it("gives every refused token the same 401 and logs only a reason code", async () => {
    const reasons: TokenRejectReason[] = [];
    const listener = await startHttpTransport(settings(), {
      tokens: store,
      onTokenRejected: (r) => reasons.push(r),
    });
    if (!listener) throw new Error("expected a listener");
    const base = `http://127.0.0.1:${listener.address.port}`;
    const post = (authorization?: string, query = "") =>
      fetch(`${base}/mcp${query}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    try {
      const expired = access({ ttlMs: 1 });
      const revoked = access();
      store.revokeToken(revoked.token);
      const refresh = store.issue({
        kind: "refresh",
        clientId: "grok-bot",
        resource: RESOURCE,
        scopes: [],
        ttlMs: 1e6,
      });
      const wrongAudience = access({ resource: "https://other.example.test/mcp" });
      const unknown = `sbat_${"Q".repeat(43)}`;
      clock = new Date("2026-10-14T06:00:00.001Z");
      const cases: [string, string, TokenRejectReason][] = [
        ["malformed", "Bearer eyJhbGciOiJub25lIn0.e30.", "malformed"],
        ["not bearer", `Basic ${unknown}`, "malformed"],
        ["unknown", `Bearer ${unknown}`, "unknown"],
        ["expired", `Bearer ${expired.token}`, "expired"],
        ["revoked", `Bearer ${revoked.token}`, "revoked"],
        ["refresh as bearer", `Bearer ${refresh.token}`, "wrong_kind"],
        ["wrong audience", `Bearer ${wrongAudience.token}`, "wrong_audience"],
      ];
      const secrets = [expired.token, revoked.token, refresh.token, wrongAudience.token, unknown];
      const seen = new Set<string>();
      for (const [name, authorization, reason] of cases) {
        const r = await post(authorization);
        expect(r.status, name).toBe(401);
        const headers = JSON.stringify([...r.headers.entries()].filter(([k]) => k !== "date"));
        const body = await r.text();
        seen.add(`${headers}\n${body}`);
        for (const s of secrets) expect(`${headers}${body}`).not.toContain(s);
        expect(reasons.at(-1), name).toBe(reason);
      }
      expect(seen.size).toBe(1); // identical response whatever the reason
      const [only] = [...seen];
      expect(only).toContain(`Bearer error=\\"invalid_token\\", resource_metadata=\\"${PRM}\\"`);
      expect(only).toContain('{"error":"invalid_token"}');
      // The log hook only ever sees reason codes.
      expect(new Set(reasons)).toEqual(new Set(cases.map((c) => c[2])));
      for (const s of secrets) expect(JSON.stringify(reasons)).not.toContain(s);

      // No Authorization header: the bare challenge (RFC 6750 §3.1), and a query-string token is not accepted.
      const valid = access();
      for (const r of [await post(), await post(undefined, `?access_token=${valid.token}`)]) {
        expect(r.status).toBe(401);
        expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM}"`);
        expect(await r.text()).not.toContain(valid.token);
      }

      // A valid token passes the verifier; no tool is served until T13.4 mounts the MCP server.
      const ok = await post(`Bearer ${valid.token}`);
      expect(ok.status).toBe(501);
      expect(await ok.text()).not.toContain(valid.token);
      secrets.push(valid.token);
      db.pragma("wal_checkpoint(TRUNCATE)");
      for (const s of secrets) expect(ledgerBytes()).not.toContain(s);
    } finally {
      await listener.close();
    }
  });

  it("refuses every token when no verifier is configured", async () => {
    const reasons: TokenRejectReason[] = [];
    const listener = await startHttpTransport(settings(), { onTokenRejected: (r) => reasons.push(r) });
    if (!listener) throw new Error("expected a listener");
    try {
      const r = await fetch(`http://127.0.0.1:${listener.address.port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${access().token}` },
      });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "invalid_token" });
      expect(reasons).toEqual(["unknown"]);
    } finally {
      await listener.close();
    }
  });
});

describe("token shape detector", () => {
  it("recognises issued tokens only", () => {
    expect(looksLikeOAuthToken(access().token)).toBe(true);
    expect(looksLikeOAuthToken("sbat_short")).toBe(false);
  });
});
