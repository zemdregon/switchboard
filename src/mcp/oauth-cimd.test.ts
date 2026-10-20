/**
 * T13.11 (FR-MCP-19, LLD §20.11, ADR-0065): Client ID Metadata Documents beside Dynamic Client Registration.
 *
 * The fixture is a local HTTPS server on loopback with a certificate for `cimd.test` and `other.test`, signed by a
 * throw-away CA generated with `openssl` in a temp directory. The CA is handed to the fetcher through its `ca` port
 * only (no global TLS switch), and DNS is an injected table, so no test touches the network or the real resolver. The
 * fixture sits on loopback, which the real address policy blocks, so the happy path injects a policy that allows
 * exactly the fixture's address on top of the real one; the refusal tests keep the real policy for every other
 * address.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type HttpTransportSettings, resolveHttpTransport } from "../config/index.js";
import { openLedger } from "../ledger/index.js";
import { type HttpTransportListener, startHttpTransport } from "./http.js";
import {
  CIMD_MAX_DOCUMENT_BYTES,
  CimdFetcher,
  checkCimdClientId,
  cimdInternalClientId,
  DEFAULT_ADDRESS_POLICY,
  embeddedIpv4,
  isBlockedAddress,
  MAX_CIMD_FETCHES_IN_FLIGHT,
} from "./oauth-cimd.js";
import { MAX_PENDING_CLIENTS, OAuthClientStore } from "./oauth-clients.js";
import { type AuthEvent, type AuthEventFields, AuthorizationServer } from "./oauth-server.js";
import { OAuthTokenStore } from "./oauth-tokens.js";

const RESOURCE = "https://sb.example.test/mcp";
const ISSUER = "https://sb.example.test";
const REDIRECT = "https://app.cimd.test/oauth/callback";
const PASSPHRASE = "correct horse battery staple";
const FAKE_HASH = `scrypt$17$8$1$${"A".repeat(22)}$${"B".repeat(43)}`;
const FIXTURE_ADDRESS = "127.0.0.1";

// ---------------------------------------------------------------------------------------------------------------------
// TLS fixture

let certDir: string;
let caPem: string;
let fixture: https.Server;
let fixturePort: number;
/** Requests the fixture received, as `host path`. */
let hits: string[];
/** What the fixture serves per path (the default is a valid document for `https://cimd.test<path>`). */
let routes: Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;

function openssl(args: string[]): void {
  execFileSync("openssl", args, { cwd: certDir, stdio: ["ignore", "ignore", "pipe"] });
}

beforeAll(async () => {
  certDir = mkdtempSync(path.join(tmpdir(), "sb-cimd-ca-"));
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl([
    "req",
    "-x509",
    ...ec,
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=Switchboard CIMD test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  ]);
  openssl(["req", "-new", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=cimd.test"]);
  writeFileSync(path.join(certDir, "leaf.ext"), "subjectAltName=DNS:cimd.test,DNS:other.test\n");
  openssl([
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "leaf.pem",
    "-days",
    "2",
    "-extfile",
    "leaf.ext",
  ]);
  caPem = readFileSync(path.join(certDir, "ca.pem"), "utf8");
  fixture = https.createServer(
    { key: readFileSync(path.join(certDir, "leaf.key")), cert: readFileSync(path.join(certDir, "leaf.pem")) },
    (req, res) => {
      const host = req.headers.host ?? "";
      const p = req.url ?? "/";
      hits.push(`${host} ${p}`);
      const route = routes.get(p);
      if (typeof route === "function") return route(req, res);
      const body = JSON.stringify(document(`https://${host}${p}`));
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    },
  );
  await new Promise<void>((resolve) => fixture.listen(0, FIXTURE_ADDRESS, resolve));
  fixturePort = (fixture.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  fixture.closeAllConnections();
  rmSync(certDir, { recursive: true, force: true });
});

function document(clientId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: "<b>CIMD</b> client",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    ...over,
  };
}

const clientUrl = (p = "/client", host = "cimd.test"): string => `https://${host}:${fixturePort}${p}`;

/** DNS as the tests see it: fixture names resolve to the fixture; others to what the test says. */
function dnsTable(extra: Record<string, string[]> = {}): (hostname: string) => Promise<string[]> {
  const table: Record<string, string[]> = { "cimd.test": [FIXTURE_ADDRESS], "other.test": [FIXTURE_ADDRESS], ...extra };
  return async (hostname) => {
    const found = table[hostname];
    if (found === undefined) throw new Error(`no fixture DNS for ${hostname}`);
    return found;
  };
}

/** The real policy, plus exactly the fixture's loopback address. */
const fixturePolicy = { allows: (a: string) => a === FIXTURE_ADDRESS || DEFAULT_ADDRESS_POLICY.allows(a) };

function fetcher(over: ConstructorParameters<typeof CimdFetcher>[0] = {}): CimdFetcher {
  return new CimdFetcher({ lookup: dnsTable(), addressPolicy: fixturePolicy, ca: caPem, ...over });
}

// ---------------------------------------------------------------------------------------------------------------------
// Authorization server under test

let dir: string;
let db: Database.Database;
let clock: Date;
let clients: OAuthClientStore;
let tokens: OAuthTokenStore;
let events: { event: AuthEvent; fields: AuthEventFields }[];
let listener: HttpTransportListener;
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

function authorizeQuery(clientId: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st-1",
  });
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
  const cookie = ((reply.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0] ?? "";
  if (!requestId || !csrf || !cookie) throw new Error(`no consent form in ${reply.status} ${reply.text}`);
  return { requestId, csrf, cookie, reply };
}

function approve(c: Consent): Promise<Reply> {
  const body = new URLSearchParams({
    request_id: c.requestId,
    csrf: c.csrf,
    decision: "approve",
    passphrase: PASSPHRASE,
  }).toString();
  return call(
    "POST",
    "/authorize",
    {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      "sec-fetch-site": "same-origin",
      cookie: c.cookie,
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

async function start(over: { cimd?: CimdFetcher; settings?: Partial<HttpTransportSettings> } = {}): Promise<void> {
  const s = {
    ...(resolveHttpTransport({ enabled: true, public_url: RESOURCE, port: 0 }) as HttpTransportSettings),
    ...over.settings,
  };
  const authorizationServer = new AuthorizationServer(s, {
    clients,
    tokens,
    cimd: over.cimd ?? fetcher(),
    passphraseHash: FAKE_HASH,
    verifyPassphrase: async (p, h) => p === PASSPHRASE && h === FAKE_HASH,
    now: () => clock,
    onEvent: (event, fields) => events.push({ event, fields }),
  });
  const l = await startHttpTransport(s, { tokens, clients, authorizationServer });
  if (!l) throw new Error("expected a listener");
  listener = l;
}

function ledgerBytes(): string {
  db.pragma("wal_checkpoint(TRUNCATE)");
  return readdirSync(dir)
    .map((f) => readFileSync(path.join(dir, f)).toString("latin1"))
    .join("\n");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-cimd-"));
  db = openLedger(dir);
  clock = new Date("2026-10-19T08:00:00.000Z");
  clients = new OAuthClientStore(db, { now: () => clock });
  tokens = new OAuthTokenStore(db, { now: () => clock });
  events = [];
  secrets = [PASSPHRASE];
  hits = [];
  routes = new Map();
});

afterEach(async () => {
  await listener?.close();
  const audit = JSON.stringify(events);
  const ledger = ledgerBytes();
  for (const s of secrets) {
    expect(audit).not.toContain(s);
    expect(ledger).not.toContain(s);
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The refusal reason of the one `authorize_refused` event, with its host. */
function refusal(): { reason?: string; host?: string } {
  const e = events.find((x) => x.event === "authorize_refused");
  return {
    ...(e?.fields.reason !== undefined ? { reason: e.fields.reason } : {}),
    ...(e?.fields.host !== undefined ? { host: e.fields.host } : {}),
  };
}

describe("a Client ID Metadata Document client (T13.11, FR-MCP-19)", () => {
  it("passes consent with the URL's host shown and gets an audience-bound token under the normal PKCE flow", async () => {
    await start();
    const id = clientUrl();
    const { verifier, challenge } = pkce();
    const reply = await call("GET", authorizeQuery(id, challenge));
    expect(reply.status).toBe(200);
    const c = consentFrom(reply);
    // The consent page names the host of the metadata document, the URL as the client id, and escapes the name the
    // document chose; the TLS fixture saw exactly one fetch, with the host name (not the pinned address) in `Host`.
    expect(c.reply.text).toContain("Client metadata document host");
    expect(c.reply.text).toContain(`<code>cimd.test:${fixturePort}</code>`);
    expect(c.reply.text).toContain("Client name (from the client's metadata document)");
    expect(c.reply.text).toContain("&#60;b&#62;CIMD&#60;/b&#62; client");
    expect(c.reply.text).toContain("A new client asks to be approved");
    expect(hits).toEqual([`cimd.test:${fixturePort} /client`]);
    const internal = cimdInternalClientId(id);
    expect(internal).toMatch(/^sbc_[A-Za-z0-9_-]{22}$/);
    expect(clients.get(internal)).toMatchObject({ status: "pending", cimdUrl: id, clientName: "<b>CIMD</b> client" });
    expect(events.some((e) => e.event === "cimd_fetched" && e.fields.client_id === internal)).toBe(true);

    const approved = await approve(c);
    expect(approved.status).toBe(303);
    const location = new URL(approved.headers.location ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    const code = location.searchParams.get("code") ?? "";
    expect(code).toMatch(/^sbac_/);
    secrets.push(code, verifier);
    expect(clients.get(internal)?.status).toBe("approved");

    // The client presents its URL at the token endpoint too; no fetch happens there.
    const r = await token({
      grant_type: "authorization_code",
      client_id: id,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as Record<string, string>;
    secrets.push(body.access_token ?? "", body.refresh_token ?? "");
    expect(tokens.verify(body.access_token ?? "", "access", RESOURCE)).toMatchObject({
      ok: true,
      token: { clientId: internal },
    });
    expect(tokens.verify(body.access_token ?? "", "access", "https://other.example.test/mcp").ok).toBe(false);
    expect(hits).toHaveLength(1);

    // A second authorization fetches the document again (nothing is cached across consents) and keeps the status.
    routes.set("/client", (_req, res) => {
      const text = JSON.stringify(document(id, { client_name: "renamed" }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(text);
    });
    const again = await call("GET", authorizeQuery(id, pkce().challenge));
    expect(again.status).toBe(200);
    expect(again.text).toContain("An approved client asks for a new authorization");
    expect(again.text).toContain("<dd>renamed</dd>");
    expect(hits).toHaveLength(2);
    expect(clients.get(internal)).toMatchObject({ status: "approved", clientName: "renamed" });
  });

  it("advertises support in the authorization server metadata, and not when turned off", async () => {
    await start();
    const on = JSON.parse((await call("GET", "/.well-known/oauth-authorization-server")).text) as Record<
      string,
      unknown
    >;
    expect(on.client_id_metadata_document_supported).toBe(true);
    await listener.close();
    await start({ settings: { cimd: false } });
    const off = JSON.parse((await call("GET", "/.well-known/oauth-authorization-server")).text) as Record<
      string,
      unknown
    >;
    expect(off.client_id_metadata_document_supported).toBe(false);
  });

  it("treats a URL client_id as an unknown client when transport.http.cimd is false, without fetching", async () => {
    await start({ settings: { cimd: false } });
    const reply = await call("GET", authorizeQuery(clientUrl(), pkce().challenge));
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("unknown client");
    expect(hits).toEqual([]);
    expect(refusal()).toEqual({ reason: "unknown_client" });
  });
});

describe("metadata fetch refusals (T13.11, SSRF limits)", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["private", "10.0.0.1"],
    ["link-local", "169.254.169.254"],
    ["IPv4-mapped private", "::ffff:10.1.2.3"],
    ["NAT64 of loopback", "64:ff9b::7f00:1"],
    ["unique-local", "fd12::1"],
    ["IPv6 loopback", "::1"],
  ])("refuses a URL resolving to a %s address before any connection", async (_name, address) => {
    await start({
      cimd: fetcher({ lookup: dnsTable({ "client.test": [address] }), addressPolicy: DEFAULT_ADDRESS_POLICY }),
    });
    const reply = await call("GET", authorizeQuery(`https://client.test:${fixturePort}/client`, pkce().challenge));
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("metadata document could not be fetched");
    expect(reply.headers.location).toBeUndefined();
    expect(hits).toEqual([]);
    expect(refusal()).toEqual({ reason: "cimd_address_blocked", host: `client.test:${fixturePort}` });
    expect(events.some((e) => e.event === "cimd_refused" && e.fields.reason === "address_blocked")).toBe(true);
  });

  it("refuses a host with one public and one private address", async () => {
    await start({ cimd: fetcher({ lookup: dnsTable({ "mixed.test": ["203.0.113.9", "10.0.0.1"] }) }) });
    // 203.0.113.0/24 is documentation space and blocked too; the point is that one blocked address refuses the host.
    const reply = await call("GET", authorizeQuery(`https://mixed.test:${fixturePort}/client`, pkce().challenge));
    expect(reply.status).toBe(400);
    expect(hits).toEqual([]);
    expect(refusal().reason).toBe("cimd_address_blocked");
  });

  it("refuses a redirect, whether it points to a private address or anywhere else", async () => {
    await start({ cimd: fetcher({ lookup: dnsTable({ "internal.test": ["10.0.0.5"] }) }) });
    routes.set("/to-private", (_req, res) => {
      res.writeHead(302, { location: "https://internal.test/client" });
      res.end();
    });
    routes.set("/to-public", (_req, res) => {
      res.writeHead(301, { location: clientUrl("/client", "other.test") });
      res.end();
    });
    for (const p of ["/to-private", "/to-public"]) {
      events = [];
      const reply = await call("GET", authorizeQuery(clientUrl(p), pkce().challenge));
      expect(reply.status).toBe(400);
      expect(refusal()).toEqual({ reason: "cimd_redirect", host: `cimd.test:${fixturePort}` });
    }
    // Exactly one request per attempt reached the fixture; the redirect targets were never fetched.
    expect(hits).toEqual([`cimd.test:${fixturePort} /to-private`, `cimd.test:${fixturePort} /to-public`]);
  });

  it("refuses an oversize document, declared or streamed, without parsing it", async () => {
    await start();
    const big = JSON.stringify(document(clientUrl("/big"), { padding: "x".repeat(CIMD_MAX_DOCUMENT_BYTES) }));
    routes.set("/big", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(big) });
      res.end(big);
    });
    routes.set("/big-chunked", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(big.slice(0, 40000));
      res.end(big.slice(40000));
    });
    for (const p of ["/big", "/big-chunked"]) {
      events = [];
      expect((await call("GET", authorizeQuery(clientUrl(p), pkce().challenge))).status).toBe(400);
      expect(refusal().reason).toBe("cimd_too_large");
    }
    expect(clients.get(cimdInternalClientId(clientUrl("/big")))).toBeUndefined();
  });

  it("refuses a slow document at the fetch deadline", async () => {
    await start({ cimd: fetcher({ timeoutMs: 300 }) });
    let pending: http.ServerResponse | undefined;
    routes.set("/slow", (_req, res) => {
      pending = res; // never answered within the deadline
    });
    const reply = await call("GET", authorizeQuery(clientUrl("/slow"), pkce().challenge));
    expect(reply.status).toBe(400);
    expect(refusal().reason).toBe("cimd_timeout");
    pending?.destroy();
  });

  it("refuses a document whose client_id is not its URL, and one that is not a public-client document", async () => {
    await start();
    routes.set("/mismatch", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(document(clientUrl("/other"))));
    });
    routes.set("/confidential", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(document(clientUrl("/confidential"), { token_endpoint_auth_method: "private_key_jwt" })));
    });
    routes.set("/http-redirect-uri", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(document(clientUrl("/http-redirect-uri"), { redirect_uris: ["http://app.cimd.test/cb"] })),
      );
    });
    routes.set("/html", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    });
    routes.set("/missing", (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    for (const [p, reason] of [
      ["/mismatch", "cimd_client_id_mismatch"],
      ["/confidential", "cimd_metadata"],
      ["/http-redirect-uri", "cimd_metadata"],
      ["/html", "cimd_content_type"],
      ["/missing", "cimd_status"],
    ]) {
      events = [];
      expect((await call("GET", authorizeQuery(clientUrl(p ?? ""), pkce().challenge))).status).toBe(400);
      expect(refusal().reason).toBe(reason);
      expect(clients.get(cimdInternalClientId(clientUrl(p ?? "")))).toBeUndefined();
    }
  });

  it("refuses a malformed identifier, this issuer's own origin and the token endpoint without a consent", async () => {
    await start();
    for (const id of [
      "https://cimd.test/", // no path
      "https://user:pw@cimd.test/client",
      "https://cimd.test/client?x=1",
      "https://cimd.test/client#frag",
      `https://${FIXTURE_ADDRESS}:${fixturePort}/client`, // IP literal host
      "https://CIMD.test/client", // not its own serialisation
    ]) {
      events = [];
      expect((await call("GET", authorizeQuery(id, pkce().challenge))).status).toBe(400);
      expect(refusal().reason).toBe("cimd_client_id");
    }
    events = [];
    expect((await call("GET", authorizeQuery(`${ISSUER}/client`, pkce().challenge))).status).toBe(400);
    expect(refusal().reason).toBe("cimd_self");
    expect(hits).toEqual([]);
    // The token endpoint never fetches: an unseen URL is an unknown client there.
    const r = await token({
      grant_type: "authorization_code",
      client_id: clientUrl("/never-seen"),
      code: "sbac_x",
      redirect_uri: REDIRECT,
      code_verifier: "v".repeat(43),
    });
    expect(r.status).toBe(401);
    expect(hits).toEqual([]);
  });

  it("applies the pending-registration cap before fetching, and refuses a denied client without fetching", async () => {
    await start();
    for (let i = 0; i < MAX_PENDING_CLIENTS; i++) {
      expect(clients.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"] }).ok).toBe(true);
    }
    expect((await call("GET", authorizeQuery(clientUrl("/capped"), pkce().challenge))).status).toBe(400);
    expect(refusal().reason).toBe("cimd_too_many_pending");
    expect(hits).toEqual([]);
    // A known client is not subject to the cap: it fetches and keeps its status.
    db.prepare("DELETE FROM oauth_client").run();
    const id = clientUrl("/client");
    expect((await call("GET", authorizeQuery(id, pkce().challenge))).status).toBe(200);
    expect(hits).toHaveLength(1);
    const internal = cimdInternalClientId(id);
    db.prepare("UPDATE oauth_client SET status = 'revoked' WHERE client_id = ?").run(internal);
    events = [];
    expect((await call("GET", authorizeQuery(id, pkce().challenge))).status).toBe(400);
    expect(refusal().reason).toBe("client_revoked");
    expect(hits).toHaveLength(1);
  });
});

describe("CimdFetcher and the address policy (unit)", () => {
  it("caps concurrent fetches", async () => {
    const held: http.ServerResponse[] = [];
    routes.set("/hold", (_req, res) => {
      held.push(res);
    });
    const f = fetcher({ timeoutMs: 2000 });
    const first = Array.from({ length: MAX_CIMD_FETCHES_IN_FLIGHT }, () => f.fetch(clientUrl("/hold")));
    await new Promise((r) => setTimeout(r, 100));
    expect(await f.fetch(clientUrl("/client"))).toMatchObject({ ok: false, reason: "busy" });
    for (const res of held) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(document(clientUrl("/hold"))));
    }
    for (const r of await Promise.all(first)) expect(r.ok).toBe(true);
    expect(await f.fetch(clientUrl("/client"))).toMatchObject({ ok: true, host: `cimd.test:${fixturePort}` });
  });

  it("refuses a certificate not signed by a trusted authority, and never trusts one through the environment", async () => {
    const r = await new CimdFetcher({ lookup: dnsTable(), addressPolicy: fixturePolicy }).fetch(clientUrl("/client"));
    expect(r).toMatchObject({ ok: false, reason: "connect" });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it("checks identifiers as the draft requires", () => {
    expect(checkCimdClientId("https://app.example/client")?.host).toBe("app.example");
    expect(checkCimdClientId("https://app.example:8443/a/b")?.port).toBe("8443");
    for (const bad of [
      "http://app.example/client",
      "https://app.example",
      "https://app.example/",
      "https://app.example:443/client", // the default port is not its own serialisation
      "https://app.example/a/../b",
      "https://[::1]/client",
      "https://10.0.0.1/client",
      "https://app.example/client?x",
      "https://app.example/client#x",
      "https://u@app.example/client",
      `https://app.example/${"a".repeat(2048)}`,
      "",
      "not a url",
    ]) {
      expect(checkCimdClientId(bad), bad).toBeUndefined();
    }
  });

  it("derives a stable sbc_ identifier from the URL", () => {
    const a = cimdInternalClientId("https://app.example/client");
    expect(a).toMatch(/^sbc_[A-Za-z0-9_-]{22}$/);
    expect(cimdInternalClientId("https://app.example/client")).toBe(a);
    expect(cimdInternalClientId("https://app.example/client2")).not.toBe(a);
  });

  it("blocks special-use addresses in every transition form and allows public ones", () => {
    for (const blocked of [
      "0.0.0.0",
      "10.1.1.1",
      "100.64.0.1",
      "127.0.0.1",
      "127.255.255.255",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:192.168.0.1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::1",
      "2002:7f00:1::1", // 6to4 of 127.0.0.1
      "2002:a00:1::1", // 6to4 of 10.0.0.1
      "2001:0:0:0:0:0:f5ff:fffe", // Teredo client 10.0.0.1 (inverted)
      "fc00::1",
      "fd00::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "2001:db8::1",
      "100::1",
      "not-an-ip",
    ]) {
      expect(isBlockedAddress(blocked), blocked).toBe(true);
    }
    for (const allowed of ["93.184.216.34", "1.1.1.1", "2606:4700::1111", "::ffff:1.1.1.1", "64:ff9b::1.1.1.1"]) {
      expect(isBlockedAddress(allowed), allowed).toBe(false);
    }
    expect(embeddedIpv4("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(embeddedIpv4("64:ff9b::7f00:1")).toBe("127.0.0.1");
    expect(embeddedIpv4("2002:c0a8:101::")).toBe("192.168.1.1");
    expect(embeddedIpv4("2606:4700::1111")).toBeUndefined();
  });
});
