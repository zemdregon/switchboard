/**
 * `transport.http` configuration (T13.1; FR-MCP-12, FR-MCP-13, LLD §3.3, ADR-0041 items 1, 2 and 9).
 *
 * Off unless `enabled: true`: with the section absent or disabled nothing is resolved and `serve` opens no listener.
 * The schema is strict (an unknown key aborts startup, NFR-SEC-06) and has no credential field.
 *
 * Delegated (T13.1, fail closed; key names follow LLD §3.3 where it names one):
 * - `public_url` is the MCP endpoint URL clients use, behind the operator's TLS terminator or relay. It is the resource
 *   identifier (RFC 8707 audience, RFC 9728 `resource`) and must be `https://` with no userinfo, query or fragment, and a
 *   path other than `/` that is not a well-known or authorization-server path. Plain HTTP is refused at load even for
 *   localhost; the listener itself speaks plain HTTP on loopback behind that terminator (ADR-0041 item 1).
 * - The embedded authorization server's issuer is the origin of `public_url` (AS and resource server on one host).
 * - `bind` is an IP literal (a host name could resolve anywhere). Only `127.0.0.0/8` and `::1` count as loopback; any
 *   other address needs `allow_non_loopback: true`.
 * - `port` is required when enabled; 0 (an ephemeral port) is accepted for tests.
 */
import net from "node:net";

export interface HttpTransportConfig {
  enabled?: boolean;
  public_url?: string;
  bind?: string;
  port?: number;
  allow_non_loopback?: boolean;
}

export const httpTransportSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    public_url: { type: "string", minLength: 1, maxLength: 2048 },
    bind: { type: "string", minLength: 1, maxLength: 64 },
    port: { type: "integer", minimum: 0, maximum: 65535 },
    allow_non_loopback: { type: "boolean" },
  },
} as const;

export const DEFAULT_HTTP_BIND = "127.0.0.1";

/** Well-known paths (RFC 9728 §3, RFC 8414 §3) and the embedded authorization server's endpoints (ADR-0041 items 3, 4). */
export const PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_WELL_KNOWN = "/.well-known/oauth-authorization-server";
export const AS_ENDPOINT_PATHS = { authorization: "/authorize", token: "/token", registration: "/register" } as const;

export interface HttpTransportSettings {
  bind: string;
  port: number;
  /** Resource identifier: the normalised `public_url` (RFC 8707 audience, RFC 9728 `resource`). */
  resource: string;
  /** Embedded authorization server issuer (RFC 8414): the origin of `resource`, no trailing slash. */
  issuer: string;
  /** Path of the MCP endpoint on the listener: the pathname of `resource`. */
  mcpPath: string;
}

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** True only for an IPv4 address in `127.0.0.0/8` or the IPv6 address `::1`; a host name is never loopback here. */
export function isLoopbackAddress(host: string): boolean {
  const family = net.isIP(host);
  if (family === 4) return loopback.check(host, "ipv4");
  if (family === 6) return loopback.check(host, "ipv6");
  return false;
}

function reservedPath(p: string): boolean {
  const bare = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  return (
    bare === "/" ||
    bare === "/.well-known" ||
    bare.startsWith("/.well-known/") ||
    (Object.values(AS_ENDPOINT_PATHS) as string[]).includes(bare)
  );
}

/** Semantic checks beyond the schema; messages name the key and never echo a rejected URL's userinfo. */
export function checkHttpTransport(cfg: HttpTransportConfig | undefined): string[] {
  if (cfg === undefined) return [];
  const at = "$.transport.http";
  const errs: string[] = [];
  if (cfg.public_url !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(cfg.public_url);
    } catch {
      errs.push(`${at}.public_url: not a valid URL`);
    }
    if (url) {
      if (url.protocol !== "https:")
        errs.push(`${at}.public_url: must use https (ADR-0041); terminate TLS in front of the listener`);
      if (url.username !== "" || url.password !== "") errs.push(`${at}.public_url: must not contain userinfo`);
      if (url.search !== "" || url.hash !== "") errs.push(`${at}.public_url: must not have a query or fragment`);
      if (reservedPath(url.pathname))
        errs.push(`${at}.public_url: the path must name the MCP endpoint (e.g. /mcp), not / or a reserved OAuth path`);
    }
  }
  if (cfg.bind !== undefined && net.isIP(cfg.bind) === 0) errs.push(`${at}.bind: must be an IP address literal`);
  const bind = cfg.bind ?? DEFAULT_HTTP_BIND;
  if (net.isIP(bind) !== 0 && !isLoopbackAddress(bind) && cfg.allow_non_loopback !== true) {
    errs.push(`${at}.bind: ${bind} is not loopback; set allow_non_loopback: true only with a TLS terminator in front`);
  }
  if (cfg.enabled === true) {
    if (cfg.public_url === undefined) errs.push(`${at}.public_url: required when enabled`);
    if (cfg.port === undefined) errs.push(`${at}.port: required when enabled`);
  }
  return errs;
}

/** Resolve a checked section (call {@link checkHttpTransport} first). Undefined means off: no listener. */
export function resolveHttpTransport(cfg: HttpTransportConfig | undefined): HttpTransportSettings | undefined {
  if (cfg?.enabled !== true || cfg.public_url === undefined || cfg.port === undefined) return undefined;
  const url = new URL(cfg.public_url);
  return {
    bind: cfg.bind ?? DEFAULT_HTTP_BIND,
    port: cfg.port,
    resource: url.href,
    issuer: url.origin,
    mcpPath: url.pathname,
  };
}
