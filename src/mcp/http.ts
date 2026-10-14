/**
 * Network MCP transport skeleton (T13.1; FR-MCP-12, FR-MCP-13, LLD §3.3, ADR-0041, TDD §3.14).
 *
 * This slice serves only discovery: protected-resource metadata (RFC 9728) and the embedded authorization server's
 * metadata (RFC 8414). The MCP endpoint answers every request with 401 and a `WWW-Authenticate` challenge naming the
 * metadata URL, because no token verifier exists yet (T13.3): nothing is accepted, so nothing can be misused. The
 * authorization, token and registration endpoints are advertised as designed (ADR-0041 items 3 and 4) and answer 404
 * until their tasks land. The handler never reads the `Authorization` header, a body or a cookie, and logs nothing.
 *
 * Every request first passes the `Origin` check (T13.2, FR-MCP-12, LLD §3.3): a request whose `Origin` header is not in
 * `transport.http.allowed_origins` gets 403 before any routing, which blocks DNS rebinding and cross-site calls from a
 * browser. No CORS headers are sent yet, so a browser page cannot read any response even from an allowed origin.
 *
 * Delegated (T13.1): a plain `node:http` listener rather than the SDK's express `mcpAuthRouter`. The SDK's issuer check
 * accepts plain HTTP for localhost and can be relaxed by an environment variable, and its metadata advertises
 * `client_secret_post`; Switchboard needs neither. The SDK's `StreamableHTTPServerTransport.handleRequest(req, res)`
 * takes `node:http` objects, so later tasks can mount it here without express.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AS_ENDPOINT_PATHS,
  AUTHORIZATION_SERVER_WELL_KNOWN,
  type HttpTransportSettings,
  PROTECTED_RESOURCE_WELL_KNOWN,
} from "../config/http-transport.js";

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

/** The request handler, exported for tests. Paths are matched exactly; the query string is ignored. */
export function httpTransportHandler(s: HttpTransportSettings): (req: IncomingMessage, res: ServerResponse) => void {
  const prmUrl = protectedResourceMetadataUrl(s.resource);
  const documents = new Map<string, Record<string, unknown>>([
    [PROTECTED_RESOURCE_WELL_KNOWN, protectedResourceMetadata(s)],
    [new URL(prmUrl).pathname, protectedResourceMetadata(s)],
    [AUTHORIZATION_SERVER_WELL_KNOWN, authorizationServerMetadata(s)],
  ]);
  const allowedOrigins = new Set(s.allowedOrigins);
  return (req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      send(res, 403, { error: "forbidden_origin" });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://listener.invalid").pathname;
    } catch {
      send(res, 400, { error: "invalid_request" });
      return;
    }
    const doc = documents.get(pathname);
    if (doc !== undefined) {
      if (req.method === "GET" || req.method === "HEAD") send(res, 200, doc);
      else send(res, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      return;
    }
    if (pathname === s.mcpPath) {
      // RFC 6750 §3 and RFC 9728 §5.1: no token was verified (T13.3 adds the verifier), so challenge with no error code.
      send(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${prmUrl}"` });
      return;
    }
    send(res, 404, { error: "not_found" });
  };
}

export interface HttpTransportListener {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export interface HttpTransportDeps {
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
  const server = (deps.createServer ?? http.createServer)(httpTransportHandler(settings));
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
