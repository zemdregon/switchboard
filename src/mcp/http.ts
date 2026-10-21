/**
 * Network MCP transport skeleton (T13.1; FR-MCP-12, FR-MCP-13, LLD §3.3, ADR-0041, TDD §3.14).
 *
 * The listener serves discovery: protected-resource metadata (RFC 9728) and the embedded authorization server's
 * metadata (RFC 8414). The authorization, token and registration endpoints are advertised as designed (ADR-0041 items 3
 * and 4). Dynamic Client Registration (T13.7, RFC 7591, `src/mcp/oauth-clients.ts`) answers `POST /register` when a
 * client store is configured: a valid request creates a `pending` client that can do nothing until the operator approves
 * it. The authorization and token endpoints (T13.8, `src/mcp/oauth-server.ts`) answer when an authorization server is
 * configured: `/authorize` shows the operator consent page and `/token` exchanges codes and rotates refresh tokens.
 * `/revoke` is the RFC 7009 revocation endpoint of the same server (`AuthorizationServer.handleRevoke`).
 *
 * The MCP endpoint verifies the bearer token (T13.3, Q-73; `src/mcp/oauth-tokens.ts`). A request without an
 * `Authorization` header gets 401 with a `WWW-Authenticate` challenge naming the metadata URL (RFC 6750 §3, RFC 9728
 * §5.1). A malformed, unknown, expired, revoked or wrong-audience token, or a refresh token used as a bearer token, gets
 * one identical 401 with `error="invalid_token"`; the reason code goes only to `onTokenRejected`. A valid token needs
 * the `mcp` scope and an OAuth-client-to-MCP-client mapping (T13.4, Q-77; resolved by `resolveMcpClientFor`: the config
 * map, then the ledger binding a profile-bound one-time code made, then `default_mcp_client`), otherwise 403
 * `insufficient_scope`. A ledger binding is re-checked on every request: one that no longer names an entry eligible for
 * a binding (removed or given `privileged_approval: not_required`) is refused the same way; then
 * the request is served by a stateless MCP server for that configured client, with its maximum trust profile. The
 * OAuth client must still be approved. Only POST is served; requests in flight are capped. The handler never echoes a
 * token, removes the `Authorization` and `Cookie` headers before the MCP server sees the request, and logs nothing
 * itself. T13.5 (FR-MCP-15, Q-78): a request carrying an `Mcp-Session-Id` header is refused (400), since no session is
 * ever issued; the MCP server is built for the token's subject, which binds every meta-session it opens to that OAuth
 * client (`src/mcp/http-subjects.ts`).
 *
 * Every request first passes the `Origin` check (T13.2, FR-MCP-12, LLD §3.3): a request whose `Origin` header is not in
 * `transport.http.allowed_origins` gets 403 before any routing, which blocks DNS rebinding and cross-site calls from a
 * browser. The one exception is the consent form, which posts to `/authorize` from the issuer's own origin (T13.8; the
 * authorization server then checks CSRF itself) and the consent page's approval-link form under `/approval/` (T14.10,
 * which checks CSRF the same way). No CORS headers are sent yet, so a browser page cannot read any response even from
 * an allowed origin.
 *
 * Delegated (T13.1): a plain `node:http` listener rather than the SDK's express `mcpAuthRouter`. The SDK's issuer check
 * accepts plain HTTP for localhost and can be relaxed by an environment variable, and its metadata advertises
 * `client_secret_post`; Switchboard needs neither.
 *
 * T13.10 (FR-MCP-18, ADR-0062): the MCP endpoint serves both protocol eras with the SDK v2 packages. After every check
 * above, the request is classified with the SDK's own `isLegacyRequest`: a 2025-era request (an `initialize`, or any
 * request without the per-request `_meta` envelope) is served by a fresh stateless `WebStandardStreamableHTTPServerTransport`
 * with JSON responses, and a 2026-07-28 request by one `createMcpHandler` per listener in strict modern mode. One
 * factory builds the same per-request `SwitchboardMcpServer` for both legs; it finds the request's configured MCP client
 * and OAuth client through a `WeakMap` keyed by the web `Request` the SDK hands back, never through the SDK's `AuthInfo`
 * (no token enters an SDK structure). Neither leg issues or accepts a session id. The SDK v2 HTTP entry is web-standard
 * (`fetch(Request): Promise<Response>`), so this module bridges `node:http` to it itself; `@modelcontextprotocol/node`
 * is not used (it lags the server package).
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import {
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  type McpHttpHandler,
  type McpRequestContext,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import {
  AS_ENDPOINT_PATHS,
  AUTHORIZATION_SERVER_WELL_KNOWN,
  type HttpTransportSettings,
  PROTECTED_RESOURCE_WELL_KNOWN,
  resolveMcpClientFor,
} from "../config/http-transport.js";
import { CONSENT_LINK_PATH } from "../control/consent-link.js";
import { mediaType, readBody } from "./http-body.js";
import { checkClientMetadata, type OAuthClientStore, registrationResponse } from "./oauth-clients.js";
import type { AuthorizationServer } from "./oauth-server.js";
import { bearerToken, type OAuthTokenStore, type TokenRejectReason } from "./oauth-tokens.js";
import type { SwitchboardMcpServer } from "./server.js";

/** RFC 9728 §3.1: the well-known segment goes between the host and the resource's path. */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const suffix = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}${PROTECTED_RESOURCE_WELL_KNOWN}${suffix}`;
}

/** RFC 9728 §2. `bearer_methods_supported` is header only (RFC 6750 §2.1); query and form tokens are not accepted. */
export function protectedResourceMetadata(s: HttpTransportSettings): Record<string, unknown> {
  return {
    resource: s.resource,
    authorization_servers: [s.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "Switchboard",
  };
}

/**
 * RFC 8414 §2. Authorization code with PKCE S256 only, public clients (`none`), rotating refresh tokens (ADR-0041 item
 * 4). A client revokes its own tokens at the RFC 7009 revocation endpoint (public clients: `none`, the `client_id`
 * alone); the operator revokes any client with `switchboard mcp oauth revoke`.
 */
export function authorizationServerMetadata(s: HttpTransportSettings): Record<string, unknown> {
  return {
    issuer: s.issuer,
    authorization_endpoint: `${s.issuer}${AS_ENDPOINT_PATHS.authorization}`,
    token_endpoint: `${s.issuer}${AS_ENDPOINT_PATHS.token}`,
    registration_endpoint: `${s.issuer}${AS_ENDPOINT_PATHS.registration}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint: `${s.issuer}${AS_ENDPOINT_PATHS.revocation}`,
    revocation_endpoint_auth_methods_supported: ["none"],
    // T13.11 (FR-MCP-19): Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document §6).
    client_id_metadata_document_supported: s.cimd,
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(res.req.method === "HEAD" ? undefined : text);
}

export interface HttpAuthDeps {
  /** Token verifier (`serve` passes the ledger-backed store). Without one every presented token is refused. */
  tokens?: Pick<OAuthTokenStore, "verify">;
  /** Told the reason code of each refused token, for the local log. Never receives the token. */
  onTokenRejected?: (reason: TokenRejectReason) => void;
  /**
   * Told when a valid token is refused at the MCP endpoint (T13.4): no `mcp` scope, no MCP client mapping, or a ledger
   * binding to an entry that is no longer eligible.
   */
  onClientRefused?: (reason: "missing_scope" | "unmapped_client" | "ineligible_binding", oauthClientId: string) => void;
  /**
   * Builds the MCP server for one configured MCP client and one token subject, the OAuth client id (T13.4, T13.5;
   * `serve` passes `createSwitchboardServer` with the same dependencies as stdio plus the subject and its bindings).
   * Without it a valid, mapped token gets 501.
   */
  mcpServerFor?: (mcpClientId: string, oauthClientId: string) => SwitchboardMcpServer;
  /** Client registry for `POST /register` (T13.7). Without one the endpoint answers 404. */
  clients?: Pick<OAuthClientStore, "register" | "get">;
  /** Told the id of each newly registered (pending) client, for the local audit log. */
  onClientRegistered?: (clientId: string) => void;
  /**
   * Authorization and token endpoints with the consent page (T13.8), and the revocation endpoint. Without one all
   * answer 404; without `handleRevoke` only `/revoke` does.
   */
  authorizationServer?: Pick<AuthorizationServer, "handleAuthorize" | "handleToken"> &
    Partial<Pick<AuthorizationServer, "handleRevoke">>;
  /** Consent-page approval links under `/approval/` (T14.10, FR-CTL-09). Without one the prefix answers 404. */
  approvalLinks?: { handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> };
}

/** Delegated (Q-77, Assumptions): bounds on the stateless MCP endpoint, which builds a server per request. */
export const MAX_MCP_REQUESTS_IN_FLIGHT = 16;
export const MAX_MCP_REQUESTS_PER_CLIENT = 4;
export const MAX_MCP_BODY_BYTES = 256 * 1024;

/** Delegated (Q-74): the largest registration body read; a larger one is refused with 413 without being parsed. */
export const MAX_REGISTRATION_BODY_BYTES = 16 * 1024;

type JsonBodyResult = { ok: true; body: unknown } | { ok: false; status: 400 | 413 };

async function readJsonBody(req: IncomingMessage, limit: number): Promise<JsonBodyResult> {
  const read = await readBody(req, limit);
  if (!read.ok) return read;
  try {
    return { ok: true, body: JSON.parse(read.body.toString("utf8")) };
  } catch {
    return { ok: false, status: 400 };
  }
}

async function handleRegistration(req: IncomingMessage, res: ServerResponse, auth: HttpAuthDeps): Promise<void> {
  const clients = auth.clients;
  if (!clients) {
    send(res, 404, { error: "not_found" });
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return;
  }
  if (mediaType(req) !== "application/json") {
    send(res, 415, { error: "invalid_client_metadata", error_description: "the body must be application/json" });
    return;
  }
  const read = await readJsonBody(req, MAX_REGISTRATION_BODY_BYTES);
  if (!read.ok) {
    if (read.status === 413) send(res, 413, { error: "invalid_client_metadata", error_description: "body too large" });
    else send(res, 400, { error: "invalid_client_metadata", error_description: "the body is not valid JSON" });
    return;
  }
  const checked = checkClientMetadata(read.body);
  if (!checked.ok) {
    send(res, 400, { error: checked.error, error_description: checked.description });
    return;
  }
  const result = clients.register(checked.metadata);
  if (!result.ok) {
    send(
      res,
      429,
      { error: "temporarily_unavailable", error_description: "too many clients are waiting for operator approval" },
      { "retry-after": "3600" },
    );
    return;
  }
  auth.onClientRegistered?.(result.client.clientId);
  send(res, 201, registrationResponse(result.client));
}

/** The `node:http` request as a web `Request` for the SDK v2 entry. Only POST reaches here, so the body is streamed. */
function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return new Request(new URL(req.url ?? "/", "http://listener.invalid"), {
    method: req.method ?? "POST",
    headers,
    body: Readable.toWeb(req) as unknown as ReadableStream,
    duplex: "half",
  });
}

/** Write the SDK's web `Response` to the `node:http` response. */
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body !== null) {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
}

/** Who one MCP request is for (T13.4): the configured MCP client and the OAuth client of the token that authenticated it. */
interface McpRequestIdentity {
  readonly mcpClientId: string;
  readonly oauthClientId: string;
}

/**
 * The MCP endpoint's dual-era serving (T13.10, ADR-0062 item 4): a fresh `SwitchboardMcpServer` per request for either
 * era, closed when the response ends. There is no MCP session, so no session id is issued or ever accepted as
 * authentication (FR-MCP-15); every request is authenticated by its own token. Responses are plain JSON in both eras:
 * the legacy transport is built with `enableJsonResponse`, and the modern handler's `auto` mode answers with one JSON
 * body unless a handler emits a related notification first, which no Switchboard tool does (`"json"` would behave the
 * same but prints an SDK warning at construction).
 */
class McpEndpoint {
  /** The identity of each request in flight, keyed by the web `Request` the SDK hands back to the factory. */
  private readonly identities = new WeakMap<Request, McpRequestIdentity>();
  /** The server built for each request, so the `node:http` close event can end it (as before T13.10). */
  private readonly servers = new WeakMap<Request, SwitchboardMcpServer>();
  private readonly modern: McpHttpHandler;

  constructor(private readonly mcpServerFor: (mcpClientId: string, oauthClientId: string) => SwitchboardMcpServer) {
    this.modern = createMcpHandler((ctx) => this.build(ctx), {
      legacy: "reject",
      responseMode: "auto",
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
      // Reporting only; the handler logs nothing itself (the response is unaffected).
      onerror: () => {},
    });
  }

  /** The one factory behind both eras. A request the endpoint did not admit has no identity and is refused. */
  private build(ctx: McpRequestContext): SwitchboardMcpServer["server"] {
    const request = ctx.requestInfo;
    const identity = request === undefined ? undefined : this.identities.get(request);
    if (request === undefined || identity === undefined) throw new Error("MCP request without an admitted identity");
    const mcp = this.mcpServerFor(identity.mcpClientId, identity.oauthClientId);
    this.servers.set(request, mcp);
    return mcp.server;
  }

  async serve(req: IncomingMessage, res: ServerResponse, identity: McpRequestIdentity): Promise<void> {
    const request = toWebRequest(req);
    this.identities.set(request, identity);
    res.on("close", () => {
      void this.servers
        .get(request)
        ?.close()
        .catch(() => {});
    });
    // Hand-wired compositions must refuse a non-JSON media type themselves before either leg parses the body.
    if (!isJsonContentType(request.headers.get("content-type"))) {
      send(res, 415, { error: "invalid_request", error_description: "the body must be application/json" });
      return;
    }
    // The SDK's own classification, so this routing can never disagree with its entry: a body over the cap or a
    // malformed modern envelope classifies modern, and the modern leg answers 413 or the JSON-RPC error.
    const legacy = await isLegacyRequest(request, undefined, { maxRequestBodySize: MAX_MCP_BODY_BYTES });
    let response: Response;
    if (legacy) {
      const server = this.build({ era: "legacy", requestInfo: request });
      // `sessionIdGenerator: undefined` is the SDK's stateless mode: no session id is issued or validated.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: MAX_MCP_BODY_BYTES,
      });
      res.on("close", () => {
        void transport.close().catch(() => {});
      });
      await server.connect(transport);
      response = await transport.handleRequest(request);
    } else {
      response = await this.modern.fetch(request);
    }
    await writeWebResponse(res, response);
  }

  close(): Promise<void> {
    return this.modern.close();
  }
}

/** The request handler with the resources it holds, exported for tests. */
export interface HttpRequestHandler {
  (req: IncomingMessage, res: ServerResponse): void;
  /** Ends the modern-era MCP handler (in-flight modern exchanges are aborted). */
  close(): Promise<void>;
}

/** The request handler, exported for tests. Paths are matched exactly; the query string is ignored. */
export function httpTransportHandler(s: HttpTransportSettings, auth: HttpAuthDeps = {}): HttpRequestHandler {
  const prmUrl = protectedResourceMetadataUrl(s.resource);
  const challenge = `Bearer resource_metadata="${prmUrl}"`;
  const invalid = `Bearer error="invalid_token", resource_metadata="${prmUrl}"`;
  const insufficient = `Bearer error="insufficient_scope", scope="mcp", resource_metadata="${prmUrl}"`;
  const refuse = (res: ServerResponse, reason: TokenRejectReason): void => {
    auth.onTokenRejected?.(reason);
    send(res, 401, { error: "invalid_token" }, { "www-authenticate": invalid });
  };
  const documents = new Map<string, Record<string, unknown>>([
    [PROTECTED_RESOURCE_WELL_KNOWN, protectedResourceMetadata(s)],
    [new URL(prmUrl).pathname, protectedResourceMetadata(s)],
    [AUTHORIZATION_SERVER_WELL_KNOWN, authorizationServerMetadata(s)],
  ]);
  const allowedOrigins = new Set(s.allowedOrigins);
  /** MCP requests being served, in total and per OAuth client (T13.4): each one holds a whole MCP server. */
  let inFlightTotal = 0;
  const inFlight = new Map<string, number>();
  const endpoint = auth.mcpServerFor === undefined ? undefined : new McpEndpoint(auth.mcpServerFor);
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://listener.invalid").pathname;
    } catch {
      send(res, 400, { error: "invalid_request" });
      return;
    }
    const origin = req.headers.origin;
    // T13.8: the consent form posts from the issuer's own origin, which is allowed on `/authorize`; T14.10 adds the
    // approval-link form under `/approval/` when that page is configured.
    const approvalLink = pathname.startsWith(CONSENT_LINK_PATH);
    const sameOriginConsent =
      origin === s.issuer && (pathname === AS_ENDPOINT_PATHS.authorization || (approvalLink && !!auth.approvalLinks));
    if (origin !== undefined && !allowedOrigins.has(origin) && !sameOriginConsent) {
      send(res, 403, { error: "forbidden_origin" });
      return;
    }
    const doc = documents.get(pathname);
    if (doc !== undefined) {
      if (req.method === "GET" || req.method === "HEAD") send(res, 200, doc);
      else send(res, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      return;
    }
    if (pathname === AS_ENDPOINT_PATHS.registration) {
      handleRegistration(req, res, auth).catch(() => {
        if (!res.headersSent) send(res, 500, { error: "server_error" });
        else res.destroy();
      });
      return;
    }
    if (
      pathname === AS_ENDPOINT_PATHS.authorization ||
      pathname === AS_ENDPOINT_PATHS.token ||
      pathname === AS_ENDPOINT_PATHS.revocation
    ) {
      const as = auth.authorizationServer;
      const revoke = as?.handleRevoke;
      if (!as || (pathname === AS_ENDPOINT_PATHS.revocation && revoke === undefined)) {
        send(res, 404, { error: "not_found" });
        return;
      }
      const handled =
        pathname === AS_ENDPOINT_PATHS.token
          ? as.handleToken(req, res)
          : pathname === AS_ENDPOINT_PATHS.revocation && revoke !== undefined
            ? revoke.call(as, req, res)
            : as.handleAuthorize(req, res);
      handled.catch(() => {
        if (!res.headersSent) send(res, 500, { error: "server_error" });
        else res.destroy();
      });
      return;
    }
    if (approvalLink && pathname !== s.mcpPath) {
      const links = auth.approvalLinks;
      if (!links) {
        send(res, 404, { error: "not_found" });
        return;
      }
      links.handle(req, res, pathname).catch(() => {
        if (!res.headersSent) send(res, 500, { error: "server_error" });
        else res.destroy();
      });
      return;
    }
    if (pathname === s.mcpPath) {
      const token = bearerToken(req.headers.authorization);
      if (token === undefined) {
        // RFC 6750 §3.1: no authentication information, so challenge with no error code.
        send(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge });
        return;
      }
      if (token === null) {
        refuse(res, "malformed");
        return;
      }
      const verdict = auth.tokens ? auth.tokens.verify(token, "access", s.resource) : undefined;
      if (verdict === undefined || !verdict.ok) {
        refuse(res, verdict?.reason ?? "unknown");
        return;
      }
      // T13.4 (FR-MCP-14, Q-77): the token's OAuth client must still be approved (fail closed without a client store:
      // a revoked client's unexpired token is refused even if its tokens were not revoked with it).
      const oauthClient = auth.clients?.get(verdict.token.clientId);
      if (oauthClient?.status !== "approved") {
        refuse(res, "revoked");
        return;
      }
      // The token's OAuth client maps to one configured MCP client, whose maximum profile applies exactly as on
      // stdio; the token carries no profile, so it cannot raise it.
      if (!verdict.token.scopes.includes("mcp")) {
        auth.onClientRefused?.("missing_scope", verdict.token.clientId);
        send(res, 403, { error: "insufficient_scope" }, { "www-authenticate": insufficient });
        return;
      }
      const resolved = resolveMcpClientFor(s, verdict.token.clientId, oauthClient.mcpClient);
      if (resolved === undefined || !resolved.eligible) {
        auth.onClientRefused?.(
          resolved === undefined ? "unmapped_client" : "ineligible_binding",
          verdict.token.clientId,
        );
        send(res, 403, { error: "insufficient_scope" }, { "www-authenticate": insufficient });
        return;
      }
      const mcpClientId = resolved.mcpClient;
      if (endpoint === undefined) {
        send(res, 501, { error: "not_implemented" });
        return;
      }
      // Stateless mode serves POST only: a GET would open a server-sent-events stream that never ends, and DELETE has
      // no session to end (the MCP transport spec allows 405 for both).
      if (req.method !== "POST") {
        send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
        return;
      }
      // T13.5 (FR-MCP-15, Q-78): no session id is ever issued, so one presented is refused rather than ignored.
      if (req.headers["mcp-session-id"] !== undefined) {
        send(res, 400, { error: "invalid_request", error_description: "MCP sessions are not supported" });
        return;
      }
      const perClient = inFlight.get(verdict.token.clientId) ?? 0;
      if (inFlightTotal >= MAX_MCP_REQUESTS_IN_FLIGHT || perClient >= MAX_MCP_REQUESTS_PER_CLIENT) {
        send(res, 503, { error: "temporarily_unavailable" }, { "retry-after": "1" });
        return;
      }
      // The credential stays here: the SDK copies request headers into every handler's `extra.requestInfo`.
      delete req.headers.authorization;
      delete req.headers.cookie;
      const oauthClientId = verdict.token.clientId;
      inFlightTotal++;
      inFlight.set(oauthClientId, perClient + 1);
      res.once("close", () => {
        inFlightTotal--;
        const n = (inFlight.get(oauthClientId) ?? 1) - 1;
        if (n <= 0) inFlight.delete(oauthClientId);
        else inFlight.set(oauthClientId, n);
      });
      endpoint.serve(req, res, { mcpClientId, oauthClientId }).catch(() => {
        if (!res.headersSent) send(res, 500, { error: "server_error" });
        else res.destroy();
      });
      return;
    }
    send(res, 404, { error: "not_found" });
  };
  return Object.assign(handle, { close: (): Promise<void> => endpoint?.close() ?? Promise.resolve() });
}

export interface HttpTransportListener {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export interface HttpTransportDeps extends HttpAuthDeps {
  /** Injected by tests to prove that no server is created when the transport is off. */
  createServer?: (handler: (req: IncomingMessage, res: ServerResponse) => void) => http.Server;
}

/**
 * Start the listener (FR-MCP-12). With `settings` undefined (the option off) it creates no server, opens no socket and
 * returns undefined. A bind failure rejects; `serve` treats that as a startup failure.
 */
export async function startHttpTransport(
  settings: HttpTransportSettings | undefined,
  deps: HttpTransportDeps = {},
): Promise<HttpTransportListener | undefined> {
  if (settings === undefined) return undefined;
  const handler = httpTransportHandler(settings, deps);
  const server = (deps.createServer ?? http.createServer)(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    address: server.address() as AddressInfo,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await handler.close();
    },
  };
}
