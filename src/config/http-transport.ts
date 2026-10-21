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
 * - `allowed_origins` (T13.2, LLD §3.3) lists serialised origins (`scheme://host[:port]`, exactly as a browser sends
 *   them: lower case, no default port, no path or trailing slash; at most 32). Default empty: any request that carries an
 *   `Origin` header is refused with 403. A request with no `Origin` is not a browser cross-origin request and passes
 *   this check; authentication still applies to it.
 * - `passphrase_hash` (T13.8, Q-75) is the operator passphrase for the consent page, as printed by `switchboard consent
 *   hash-passphrase` (scrypt, `scrypt$17$8$1$<salt>$<key>`); never the passphrase itself. A value in any other form, or
 *   with other parameters, aborts startup. Absent: the consent page accepts only one-time pairing codes.
 * - `clients` (T13.4, FR-MCP-14, Q-77) maps an approved OAuth client (`oauth_client_id`, `sbc_...`) to an `mcp_clients`
 *   entry (`mcp_client`), whose maximum trust profile then applies; at most 64 entries, each OAuth client once.
 *   `default_mcp_client` optionally names the entry for an approved OAuth client with no mapping. With neither, an
 *   authenticated client is refused (403). Cross-checks against `mcp_clients` are in `load.ts`.
 * - `cimd` (T13.11, FR-MCP-19; default true) lets a client identify itself with a Client ID Metadata Document: an
 *   `https` URL as `client_id`, fetched under the limits in `src/mcp/oauth-cimd.ts`. `false` turns the fetch off, so
 *   such a `client_id` is an unknown client. `oauth_client_id` in `clients` may then be that URL as well; it is mapped
 *   under the `sbc_` identifier derived from it (`cimdInternalClientId`). Stdio is unaffected either way.
 * - `client_ip_header` (optional, lower case, e.g. `cf-connecting-ip`) names the request header that carries the real
 *   client address when a trusted reverse proxy on the same host forwards to the listener. It is honoured only when
 *   the TCP peer is a loopback address (the proxy), and only when its value is one IP literal; otherwise the socket
 *   peer is used. It keys the per-address lockout for wrong pairing codes and passphrases on the consent pages.
 *
 * A profile-bound one-time code (`switchboard mcp oauth issue-code`) binds an OAuth client to an `mcp_clients` entry in
 * the ledger. Resolution at the MCP endpoint is: the config `clients` map, then that ledger binding, then
 * `default_mcp_client` ({@link resolveMcpClientFor}). Delegated: a ledger-bound profile must pass the stricter rule
 * load applies to `default_mcp_client` ({@link httpProfileProblem} with `bound`): no `privileged` ceiling and no
 * `privileged_approval: not_required`, checked when the code is issued and again on every request, so a code can never
 * give an HTTP client privileged runs; a privileged ceiling still needs an explicit `clients` mapping in config.
 */
import net from "node:net";
import { checkCimdClientId, cimdInternalClientId, looksLikeCimdClientId } from "../mcp/oauth-cimd.js";
import { isPassphraseHash } from "../mcp/oauth-passphrase.js";

export interface HttpTransportConfig {
  enabled?: boolean;
  public_url?: string;
  bind?: string;
  port?: number;
  allow_non_loopback?: boolean;
  allowed_origins?: string[];
  passphrase_hash?: string;
  clients?: { oauth_client_id: string; mcp_client: string }[];
  default_mcp_client?: string;
  cimd?: boolean;
  client_ip_header?: string;
}

/** The `oauth_client_id` of a mapping as the token store keys it: a URL's derived identifier, else as written. */
function mappedClientId(oauthClientId: string): string {
  return looksLikeCimdClientId(oauthClientId) ? cimdInternalClientId(oauthClientId) : oauthClientId;
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
    allowed_origins: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 2048 },
    },
    passphrase_hash: { type: "string", minLength: 1, maxLength: 256 },
    clients: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["oauth_client_id", "mcp_client"],
        properties: {
          oauth_client_id: { type: "string", maxLength: 2048, pattern: "^(sbc_[A-Za-z0-9_-]{22}|https://\\S+)$" },
          mcp_client: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
    default_mcp_client: { type: "string", minLength: 1, maxLength: 128 },
    cimd: { type: "boolean" },
    client_ip_header: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]*$" },
  },
} as const;

export const DEFAULT_HTTP_BIND = "127.0.0.1";

/** Well-known paths (RFC 9728 §3, RFC 8414 §3) and the embedded authorization server's endpoints (ADR-0041 items 3, 4). */
export const PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_WELL_KNOWN = "/.well-known/oauth-authorization-server";
export const AS_ENDPOINT_PATHS = {
  authorization: "/authorize",
  token: "/token",
  registration: "/register",
  revocation: "/revoke",
} as const;

export interface HttpTransportSettings {
  bind: string;
  port: number;
  /** Resource identifier: the normalised `public_url` (RFC 8707 audience, RFC 9728 `resource`). */
  resource: string;
  /** Embedded authorization server issuer (RFC 8414): the origin of `resource`, no trailing slash. */
  issuer: string;
  /** Path of the MCP endpoint on the listener: the pathname of `resource`. */
  mcpPath: string;
  /** Origins allowed to send an `Origin` header (T13.2); empty refuses every request that has one. */
  allowedOrigins: readonly string[];
  /** The consent-page passphrase hash (T13.8, Q-75); undefined when only pairing codes are accepted. */
  passphraseHash?: string;
  /** OAuth client id to `mcp_clients` id (T13.4, Q-77). */
  clientMap: ReadonlyMap<string, string>;
  /** The `mcp_clients` id for an approved OAuth client with no mapping; undefined refuses such a client. */
  defaultMcpClient?: string;
  /** Client ID Metadata Documents accepted as `client_id` (T13.11, FR-MCP-19); default true. */
  cimd: boolean;
  /** `client_ip_header`: honoured only from a loopback TCP peer; undefined uses the socket peer. */
  clientIpHeader?: string;
  /**
   * The `mcp_clients` ids a ledger binding may name (exist, no privileged ceiling, approval required). Undefined or
   * empty: every ledger binding is refused at the MCP endpoint (fail closed).
   */
  bindableMcpClients?: ReadonlySet<string>;
}

/** The part of an `mcp_clients` entry the HTTP eligibility rules read. */
export interface HttpProfileEntry {
  readonly maxTrustProfile: string;
  /** Absent reads as `required` (the default). */
  readonly privilegedApproval?: string | undefined;
}

/** Why an `mcp_clients` entry may not serve HTTP requests from the given source, or undefined when it may. */
export type HttpProfileProblem = "unknown" | "privileged_ceiling" | "approval_not_required";

/**
 * The HTTP eligibility rule for an `mcp_clients` entry (T13.4, FR-MCP-14). `mapped` is an explicit config mapping (a
 * privileged ceiling is allowed, its runs still need the operator); `default` and `bound` (a ledger binding made by a
 * profile-bound one-time code) refuse a privileged ceiling. Every source refuses `privileged_approval: not_required`.
 */
export function httpProfileProblem(
  entry: HttpProfileEntry | undefined,
  source: "mapped" | "default" | "bound",
): HttpProfileProblem | undefined {
  if (entry === undefined) return "unknown";
  if (source !== "mapped" && entry.maxTrustProfile === "privileged") return "privileged_ceiling";
  if (entry.privilegedApproval === "not_required") return "approval_not_required";
  return undefined;
}

/** Where an OAuth client's MCP client came from: the config map, the ledger binding, or `default_mcp_client`. */
export type McpClientSource = "config_map" | "ledger_binding" | "default";

export interface ResolvedMcpClientFor {
  readonly mcpClient: string;
  readonly source: McpClientSource;
  /** False for a ledger binding that no longer names a bindable entry: the MCP endpoint refuses the request. */
  readonly eligible: boolean;
}

/**
 * The configured MCP client an OAuth client acts as: the config `clients` map, then the ledger binding, then
 * `default_mcp_client`. A ledger binding is eligible only while it names an entry in `bindableMcpClients`; it never
 * falls through to the default when it is not (fail closed). Undefined: no mapping at all.
 */
export function resolveMcpClientFor(
  s: Pick<HttpTransportSettings, "clientMap" | "defaultMcpClient" | "bindableMcpClients">,
  oauthClientId: string,
  ledgerBinding: string | undefined,
): ResolvedMcpClientFor | undefined {
  const mapped = s.clientMap.get(oauthClientId);
  if (mapped !== undefined) return { mcpClient: mapped, source: "config_map", eligible: true };
  if (ledgerBinding !== undefined) {
    return {
      mcpClient: ledgerBinding,
      source: "ledger_binding",
      eligible: s.bindableMcpClients?.has(ledgerBinding) === true,
    };
  }
  if (s.defaultMcpClient !== undefined) return { mcpClient: s.defaultMcpClient, source: "default", eligible: true };
  return undefined;
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
  for (const [i, o] of (cfg.allowed_origins ?? []).entries()) {
    let origin: string | undefined;
    try {
      origin = new URL(o).origin;
    } catch {
      // reported below
    }
    if (origin === undefined || origin === "null" || origin !== o) {
      errs.push(
        `${at}.allowed_origins[${i}]: must be a serialised origin such as https://app.example (no path or slash)`,
      );
    }
  }
  if (cfg.passphrase_hash !== undefined && !isPassphraseHash(cfg.passphrase_hash)) {
    errs.push(`${at}.passphrase_hash: must be the output of switchboard consent hash-passphrase (scrypt$17$8$1$...)`);
  }
  const seen = new Set<string>();
  for (const [i, c] of (cfg.clients ?? []).entries()) {
    if (looksLikeCimdClientId(c.oauth_client_id) && checkCimdClientId(c.oauth_client_id) === undefined) {
      errs.push(
        `${at}.clients[${i}].oauth_client_id: a Client Identifier URL must be https with a DNS host and a path, ` +
          "no userinfo, query or fragment, in its canonical form",
      );
    }
    const key = mappedClientId(c.oauth_client_id);
    if (seen.has(key)) errs.push(`${at}.clients[${i}].oauth_client_id: mapped more than once`);
    seen.add(key);
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

/** One raw `mcp_clients` entry as {@link resolveHttpTransport} reads it. */
export interface RawMcpClientEntry {
  readonly id: string;
  readonly max_trust_profile: string;
  readonly privileged_approval?: string | undefined;
}

/**
 * Resolve a checked section (call {@link checkHttpTransport} first). Undefined means off: no listener. `mcpClients`
 * (the config's `mcp_clients`) decides which entries a ledger binding may name; without it none may.
 */
export function resolveHttpTransport(
  cfg: HttpTransportConfig | undefined,
  mcpClients: readonly RawMcpClientEntry[] = [],
): HttpTransportSettings | undefined {
  if (cfg?.enabled !== true || cfg.public_url === undefined || cfg.port === undefined) return undefined;
  const url = new URL(cfg.public_url);
  return {
    bind: cfg.bind ?? DEFAULT_HTTP_BIND,
    port: cfg.port,
    resource: url.href,
    issuer: url.origin,
    mcpPath: url.pathname,
    allowedOrigins: [...(cfg.allowed_origins ?? [])],
    ...(cfg.passphrase_hash !== undefined ? { passphraseHash: cfg.passphrase_hash } : {}),
    clientMap: new Map((cfg.clients ?? []).map((c) => [mappedClientId(c.oauth_client_id), c.mcp_client])),
    ...(cfg.default_mcp_client !== undefined ? { defaultMcpClient: cfg.default_mcp_client } : {}),
    cimd: cfg.cimd ?? true,
    ...(cfg.client_ip_header !== undefined ? { clientIpHeader: cfg.client_ip_header } : {}),
    bindableMcpClients: new Set(
      mcpClients
        .filter(
          (c) =>
            httpProfileProblem(
              { maxTrustProfile: c.max_trust_profile, privilegedApproval: c.privileged_approval },
              "bound",
            ) === undefined,
        )
        .map((c) => c.id),
    ),
  };
}
