/**
 * Network MCP transport skeleton (T13.1; FR-MCP-12, FR-MCP-13, LLD §3.3, ADR-0041, TDD §3.14).
 *
 * The listener serves discovery: protected-resource metadata (RFC 9728) and the embedded authorization server's
 * metadata (RFC 8414). The authorization, token and registration endpoints are advertised as designed (ADR-0041 items 3
 * and 4). Dynamic Client Registration (T13.7, RFC 7591, `src/mcp/oauth-clients.ts`) answers `POST /register` when a
 * client store is configured: a valid request creates a `pending` client that can do nothing until the operator approves
 * it. The authorization and token endpoints (T13.8, `src/mcp/oauth-server.ts`) answer when an authorization server is
 * configured: `/authorize` shows the operator consent page and `/token` exchanges codes and rotates refresh tokens.
 *
 * The MCP endpoint verifies the bearer token (T13.3, Q-73; `src/mcp/oauth-tokens.ts`). A request without an
 * `Authorization` header gets 401 with a `WWW-Authenticate` challenge naming the metadata URL (RFC 6750 §3, RFC 9728
 * §5.1). A malformed, unknown, expired, revoked or wrong-audience token, or a refresh token used as a bearer token, gets
 * one identical 401 with `error="invalid_token"`; the reason code goes only to `onTokenRejected`. A valid token needs
 * the `mcp` scope and an OAuth-client-to-MCP-client mapping (T13.4, Q-77), otherwise 403 `insufficient_scope`; then
 * the request is served by a stateless MCP server for that configured client, with its maximum trust profile. The
 * handler never echoes a token, never passes it to the MCP server, and logs nothing itself.
 *
 * Every request first passes the `Origin` check (T13.2, FR-MCP-12, LLD §3.3): a request whose `Origin` header is not in
 * `transport.http.allowed_origins` gets 403 before any routing, which blocks DNS rebinding and cross-site calls from a
 * browser. The one exception is the consent form, which posts to `/authorize` from the issuer's own origin (T13.8; the
 * authorization server then checks CSRF itself). No CORS headers are sent yet, so a browser page cannot read any response even from an allowed origin.
 *
 * Delegated (T13.1): a plain `node:http` listener rather than the SDK's express `mcpAuthRouter`. The SDK's issuer check
 * accepts plain HTTP for localhost and can be relaxed by an environment variable, and its metadata advertises
 * `client_secret_post`; Switchboard needs neither. The SDK's `StreamableHTTPServerTransport.handleRequest(req, res)`
 * takes `node:http` objects, so later tasks can mount it here without express.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  AS_ENDPOINT_PATHS,
  AUTHORIZATION_SERVER_WELL_KNOWN,
  type HttpTransportSettings,
  PROTECTED_RESOURCE_WELL_KNOWN,
} from "../config/http-transport.js";
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
 * 4). Revocation is the operator CLI (`switchboard auth revoke`), so no revocation endpoint is advertised.
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
  /** Told when a valid token is refused at the MCP endpoint (T13.4): no `mcp` scope, or no MCP client mapping. */
  onClientRefused?: (reason: "missing_scope" | "unmapped_client", oauthClientId: string) => void;
  /**
   * Builds the MCP server for one configured MCP client (T13.4; `serve` passes `createSwitchboardServer` with the same
   * dependencies as stdio). Without it a valid, mapped token gets 501.
   */
  mcpServerFor?: (mcpClientId: string) => SwitchboardMcpServer;
  /** Client registry for `POST /register` (T13.7). Without one the endpoint answers 404. */
  clients?: Pick<OAuthClientStore, "register">;
  /** Told the id of each newly registered (pending) client, for the local audit log. */
  onClientRegistered?: (clientId: string) => void;
  /** Authorization and token endpoints with the consent page (T13.8). Without one both answer 404. */
  authorizationServer?: Pick<AuthorizationServer, "handleAuthorize" | "handleToken">;
}

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

/**
 * One MCP request in stateless Streamable HTTP mode (T13.4, Q-77): a fresh server and transport per request, closed
 * when the response ends. There is no MCP session, so no session id is issued or ever accepted as authentication
 * (FR-MCP-15); every request is authenticated by its own token. Responses are plain JSON, not SSE streams.
 */
async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse,
  mcpServerFor: (mcpClientId: string) => SwitchboardMcpServer,
  mcpClientId: string,
): Promise<void> {
  const mcp = mcpServerFor(mcpClientId);
  // No `sessionIdGenerator`: the SDK's stateless mode.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    void transport.close().catch(() => {});
    void mcp.close().catch(() => {});
  });
  // The SDK's transport declares `onclose` as optional-or-undefined, which `exactOptionalPropertyTypes` rejects.
  await mcp.server.connect(transport as Transport);
  await transport.handleRequest(req, res);
}

/** The request handler, exported for tests. Paths are matched exactly; the query string is ignored. */
export function httpTransportHandler(
  s: HttpTransportSettings,
  auth: HttpAuthDeps = {},
): (req: IncomingMessage, res: ServerResponse) => void {
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
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://listener.invalid").pathname;
    } catch {
      send(res, 400, { error: "invalid_request" });
      return;
    }
    const origin = req.headers.origin;
    // T13.8: the consent form posts from the issuer's own origin, which is allowed on `/authorize` only.
    const sameOriginConsent = origin === s.issuer && pathname === AS_ENDPOINT_PATHS.authorization;
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
    if (pathname === AS_ENDPOINT_PATHS.authorization || pathname === AS_ENDPOINT_PATHS.token) {
      const as = auth.authorizationServer;
      if (!as) {
        send(res, 404, { error: "not_found" });
        return;
      }
      const handled = pathname === AS_ENDPOINT_PATHS.token ? as.handleToken(req, res) : as.handleAuthorize(req, res);
      handled.catch(() => {
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
      // T13.4 (FR-MCP-14, Q-77): the token's OAuth client maps to one configured MCP client, whose maximum profile
      // applies exactly as on stdio; the token carries no profile, so it cannot raise it.
      if (!verdict.token.scopes.includes("mcp")) {
        auth.onClientRefused?.("missing_scope", verdict.token.clientId);
        send(res, 403, { error: "insufficient_scope" }, { "www-authenticate": insufficient });
        return;
      }
      const mcpClientId = s.clientMap.get(verdict.token.clientId) ?? s.defaultMcpClient;
      if (mcpClientId === undefined) {
        auth.onClientRefused?.("unmapped_client", verdict.token.clientId);
        send(res, 403, { error: "insufficient_scope" }, { "www-authenticate": insufficient });
        return;
      }
      if (!auth.mcpServerFor) {
        send(res, 501, { error: "not_implemented" });
        return;
      }
      serveMcp(req, res, auth.mcpServerFor, mcpClientId).catch(() => {
        if (!res.headersSent) send(res, 500, { error: "server_error" });
        else res.destroy();
      });
      return;
    }
    send(res, 404, { error: "not_found" });
  };
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
  const server = (deps.createServer ?? http.createServer)(httpTransportHandler(settings, deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    address: server.address() as AddressInfo,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
