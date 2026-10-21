/**
 * End to end: a real MCP client (`@modelcontextprotocol/client` 2.3.1, `StreamableHTTPClientTransport` with an
 * `OAuthClientProvider`) against the real HTTP transport, embedded authorization server and Switchboard MCP server on
 * an ephemeral loopback port. The resource is `https://sb.example.test/mcp`; the transport's custom `fetch` maps that
 * origin to the loopback listener, so every check that depends on the https issuer runs unchanged.
 *
 * Flow: an unauthenticated request gets 401 and the client discovers the protected-resource metadata, the
 * authorization-server metadata and registers dynamically; its `redirectToAuthorization` drives the consent form with a
 * one-time code from `switchboard mcp oauth issue-code --client-profile grok-bot`; `finishAuth` exchanges the code;
 * `tools/list` is served as `grok-bot`; an expired access token is refreshed (rotation) on the next call; the refresh
 * token is revoked at `/revoke` and the next call is refused. A client mapped statically in config still works as
 * before, and the stdio-only `list_oauth_clients` is neither listed nor callable over HTTP.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Client,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { type HttpTransportSettings, type RawMcpClientEntry, resolveHttpTransport } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { type HttpTransportListener, startHttpTransport } from "./http.js";
import { SubjectBindingStore } from "./http-subjects.js";
import { createSwitchboardServer } from "./index.js";
import { OAuthAdmin } from "./oauth-admin.js";
import { OAuthAuditLog } from "./oauth-audit.js";
import { OAuthClientStore } from "./oauth-clients.js";
import { PairingCodeStore } from "./oauth-pairing.js";
import { AuthorizationServer } from "./oauth-server.js";
import { OAuthTokenStore } from "./oauth-tokens.js";

const ISSUER = "https://sb.example.test";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = "https://client.example.test/oauth/callback";
const ENTRIES: RawMcpClientEntry[] = [
  { id: "grok-bot", max_trust_profile: "edit-untrusted" },
  { id: "static-bot", max_trust_profile: "inspect-untrusted" },
];
/** The deterministic id of the statically mapped client (16 bytes of 7). */
const STATIC_ID = `sbc_${Buffer.alloc(16, 7).toString("base64url")}`;

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "read-only",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

let root: string;
let configPath: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle;
let listener: HttpTransportListener;
let clock: Date;
let tokens: OAuthTokenStore;
let oauthClients: OAuthClientStore;
/** The configured MCP client of every request the endpoint admitted, in order. */
let served: string[];
/** Method and path (no query) of every request the MCP client made, in order. */
let seen: string[];
const open: Client[] = [];

/** The transport's fetch: the https issuer origin goes to the loopback listener. */
const mappedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
  if (url.origin !== ISSUER) throw new Error(`unexpected origin ${url.origin}`);
  return fetch(`http://127.0.0.1:${listener.address.port}${url.pathname}${url.search}`, init);
};

/** One raw request to the listener (the consent form needs Origin, Sec-Fetch-Site and Cookie headers). */
function raw(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
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

/** `switchboard mcp oauth issue-code --client-profile <profile>`, through the real CLI on the same data directory. */
async function issueCode(profile: string): Promise<string> {
  const out: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => {} },
    env: {},
    user: "operator",
    now: () => clock,
  };
  const code = await main(
    ["mcp", "oauth", "issue-code", "--client-profile", profile, "--ttl", "5m", "--json", "--config", configPath],
    io,
  );
  expect(code).toBe(0);
  return (JSON.parse(out.join("")) as { code: string }).code;
}

/** An in-memory OAuth client provider whose "browser" is the consent form driven with a one-time code. */
class ConsentDrivingProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  discovery: OAuthDiscoveryState | undefined;
  callback: URLSearchParams | undefined;
  /** False once the test expects no further interactive authorization. */
  allowAuthorization = true;
  authorizations = 0;

  constructor(private readonly profile: string) {}

  get redirectUrl(): string {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: "E2E test client",
    };
  }
  state(): string {
    return "e2e-state";
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.info = info;
  }
  tokens(): OAuthTokens | undefined {
    return this.saved;
  }
  saveTokens(t: OAuthTokens): void {
    this.saved = t;
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }
  codeVerifier(): string {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this.saved = undefined;
    if (scope === "all" || scope === "client") this.info = undefined;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.allowAuthorization) throw new Error("no interactive authorization expected now");
    this.authorizations++;
    expect(authorizationUrl.origin).toBe(ISSUER);
    expect(authorizationUrl.pathname).toBe("/authorize");
    expect(authorizationUrl.searchParams.get("resource")).toBe(RESOURCE);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const page = await raw("GET", `${authorizationUrl.pathname}${authorizationUrl.search}`);
    expect(page.status).toBe(200);
    const requestId = /name="request_id" value="([^"]+)"/.exec(page.text)?.[1] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? "";
    const cookie = String(page.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    const code = await issueCode(this.profile);
    const decided = await raw(
      "POST",
      "/authorize",
      {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        "sec-fetch-site": "same-origin",
        cookie,
      },
      new URLSearchParams({ request_id: requestId, csrf, decision: "approve", pairing_code: code }).toString(),
    );
    expect(decided.status).toBe(303);
    const location = new URL(String(decided.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("e2e-state");
    this.callback = location.searchParams;
  }
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-oauth-e2e-")));
  const dataDir = path.join(root, "data");
  const repos = path.join(root, "repos");
  mkdirSync(repos);
  mkdirSync(dataDir, { recursive: true });
  const http_ = {
    enabled: true,
    public_url: RESOURCE,
    port: 0,
    clients: [{ oauth_client_id: STATIC_ID, mcp_client: "static-bot" }],
  };
  configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [repos],
      mcp_clients: ENTRIES,
      transport: { http: http_ },
    }),
  );
  clock = new Date("2026-10-21T10:00:00.000Z");
  const now = () => clock;
  served = [];
  seen = [];
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator(), now });
  const registry = new AdapterRegistry().register(new FakeAdapter({ script: "/nonexistent/fake-cli.mjs" }));
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [repos], ids: createIdGenerator() });
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [repos],
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
  const settings = resolveHttpTransport(http_, ENTRIES) as HttpTransportSettings;
  tokens = new OAuthTokenStore(db, { now });
  oauthClients = new OAuthClientStore(db, { now });
  const subjectBindings = new SubjectBindingStore(db);
  const authorizationServer = new AuthorizationServer(settings, {
    clients: oauthClients,
    tokens,
    pairing: new PairingCodeStore(db, { now }),
    audit: new OAuthAuditLog(db, { now }),
    now,
  });
  const started = await startHttpTransport(settings, {
    tokens,
    clients: oauthClients,
    authorizationServer,
    mcpServerFor: (mcpClientId, oauthClientId) => {
      served.push(mcpClientId);
      return createSwitchboardServer({
        lifecycle,
        ledger,
        artifacts,
        registry,
        config: {
          allowedRoots: [repos],
          mcpClients: new Map(
            ENTRIES.map((e) => [e.id, { id: e.id, maxTrustProfile: e.max_trust_profile as TrustProfile }]),
          ),
          capacity: { windowSeconds: 7200, confidenceRuns: 4 },
          limits: { perProviderConcurrency: 2 },
        },
        clientId: mcpClientId,
        subject: oauthClientId,
        subjectBindings,
        // Passed on purpose: a server built for an HTTP subject must still neither list nor serve it.
        oauthAdmin: new OAuthAdmin(db, settings, { now }),
        now,
      });
    },
  });
  if (!started) throw new Error("HTTP listener missing");
  listener = started;
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => {});
  await listener.close();
  await lifecycle.shutdown();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function connect(transport: StreamableHTTPClientTransport): Promise<Client> {
  const client = new Client({ name: "oauth-e2e", version: "1.0.0" });
  await client.connect(transport);
  open.push(client);
  return client;
}

describe("MCP OAuth end to end with the real client library", () => {
  it("discovers, registers, approves with an issue-code code, serves the bound profile, refreshes and revokes", async () => {
    const provider = new ConsentDrivingProvider("grok-bot");
    const first = new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: provider, fetch: mappedFetch });
    const client0 = new Client({ name: "oauth-e2e", version: "1.0.0" });
    await expect(client0.connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    await client0.close().catch(() => {});

    // 401 discovery: protected-resource metadata, then the authorization server's metadata, then registration.
    const discovery = seen.slice(0, seen.indexOf("POST /register") + 1);
    expect(discovery[0]).toBe("POST /mcp");
    expect(discovery).toContain("GET /.well-known/oauth-protected-resource/mcp");
    expect(discovery).toContain("GET /.well-known/oauth-authorization-server");
    expect(discovery.indexOf("GET /.well-known/oauth-protected-resource/mcp")).toBeLessThan(
      discovery.indexOf("GET /.well-known/oauth-authorization-server"),
    );
    expect(provider.authorizations).toBe(1);
    const clientId = String(provider.info?.client_id);
    expect(clientId).toMatch(/^sbc_/);
    expect(provider.callback).toBeDefined();

    await first.finishAuth(provider.callback as URLSearchParams);
    expect(seen).toContain("POST /token");
    expect(provider.saved?.refresh_token).toBeDefined();
    // The consent bound the new client to the code's profile in the ledger.
    expect(oauthClients.get(clientId)).toMatchObject({ status: "approved", mcpClient: "grok-bot" });

    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      authProvider: provider,
      fetch: mappedFetch,
    });
    const client = await connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).not.toContain("list_oauth_clients");
    expect(served.at(-1)).toBe("grok-bot");
    expect(served.every((s) => s === "grok-bot")).toBe(true);
    // The stdio-only tool is answered as an unknown tool over HTTP.
    const hidden = await client.callTool({ name: "list_oauth_clients", arguments: {} });
    expect(hidden.isError).toBe(true);
    expect(JSON.stringify(hidden.content)).toContain("unknown tool");

    // Refresh rotation: the access token expires; the next call gets 401, the client refreshes and retries.
    provider.allowAuthorization = false;
    const before = { ...(provider.saved as OAuthTokens) };
    clock = new Date(clock.getTime() + 16 * 60_000);
    const servedBefore = served.length;
    await client.listTools();
    expect(served.length).toBeGreaterThan(servedBefore);
    const after = provider.saved as OAuthTokens;
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(tokens.verify(before.refresh_token as string, "refresh", RESOURCE)).toEqual({
      ok: false,
      reason: "revoked",
    });

    // RFC 7009 revocation of the refresh token takes the grant's access token with it.
    const revoked = await mappedFetch(`${ISSUER}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: after.refresh_token as string,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect(tokens.verify(after.access_token, "access", RESOURCE).ok).toBe(false);
    const servedAtRevocation = served.length;
    await expect(client.listTools()).rejects.toThrow();
    expect(served.length).toBe(servedAtRevocation);
  });

  it("still serves a client mapped statically in config, unchanged", async () => {
    const fixed = new OAuthClientStore(db, { now: () => clock, randomBytes: (n) => Buffer.alloc(n, 7) });
    const registered = fixed.register({ redirectUris: [REDIRECT], grantTypes: ["authorization_code"] });
    expect(registered.ok && registered.client.clientId).toBe(STATIC_ID);
    expect(fixed.approveAndBind(STATIC_ID).ok).toBe(true);
    const token = tokens.issue({
      kind: "access",
      clientId: STATIC_ID,
      resource: RESOURCE,
      scopes: ["mcp"],
      ttlMs: 60_000,
    }).token;
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      authProvider: { token: async () => token },
      fetch: mappedFetch,
    });
    const client = await connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((s) => s === "static-bot")).toBe(true);
  });
});
