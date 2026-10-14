/**
 * Dynamic Client Registration for the embedded authorization server (T13.7; FR-MCP-16, RFC 7591, LLD §3.3, ADR-0041
 * item 3, Q-74).
 *
 * Delegated (Q-74, fail closed): registration is open (RFC 7591 §3 without an initial access token, because a remote
 * client such as the Grok Bot embed registers itself), but a registered client gets nothing: it is stored `pending`
 * and can obtain no authorization code or token until the operator approves it on the consent page (a later M13 task).
 * Only public clients exist (`token_endpoint_auth_method` `none`), so no client secret is issued or stored. The accepted
 * metadata is narrow:
 *
 * - `redirect_uris` (required): 1 to 4 absolute `https:` URLs, each at most 2048 characters, with no userinfo or
 *   fragment. Plain `http:`, including loopback, is refused until a native client needs it.
 * - `token_endpoint_auth_method`: absent or `none`.
 * - `grant_types`: absent (RFC 7591 default `authorization_code`) or a subset of `authorization_code` and
 *   `refresh_token` that contains `authorization_code`.
 * - `response_types`: absent (default `code`) or exactly `["code"]`.
 * - `client_name`: optional, 1 to 128 characters, no control characters. It is shown to the operator later, so it is
 *   stored as text and must be escaped where rendered.
 * - Every other field (including `scope`, `jwks`, `software_statement`) is ignored, neither stored nor echoed; scopes
 *   are decided at consent and never include `privileged` (FR-MCP-14).
 *
 * At most {@link MAX_PENDING_CLIENTS} registrations may wait for a decision within {@link PENDING_WINDOW_MS}; past that
 * the endpoint refuses new ones, so an unauthenticated caller cannot flood the ledger or the operator's queue.
 */
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

/** Delegated (Q-74): the cap on recent pending registrations and the window it counts over. */
export const MAX_PENDING_CLIENTS = 16;
export const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_REDIRECT_URIS = 4;
const MAX_URI_LENGTH = 2048;
const MAX_CLIENT_NAME = 128;
const SUPPORTED_GRANTS = new Set(["authorization_code", "refresh_token"]);

export interface ClientMetadata {
  readonly redirectUris: readonly string[];
  readonly grantTypes: readonly string[];
  readonly clientName?: string;
}

export type MetadataCheck = { ok: true; metadata: ClientMetadata } | { ok: false; error: string; description: string };

const bad = (error: string, description: string): MetadataCheck => ({ ok: false, error, description });

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function redirectUriProblem(uri: string): string | undefined {
  if (uri.length === 0 || uri.length > MAX_URI_LENGTH) return "a redirect URI is empty or too long";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "a redirect URI is not an absolute URL";
  }
  if (url.protocol !== "https:") return "redirect URIs must use https";
  if (url.username !== "" || url.password !== "") return "a redirect URI must not contain userinfo";
  if (url.hash !== "" || uri.includes("#")) return "a redirect URI must not contain a fragment";
  return undefined;
}

/** Validate an RFC 7591 registration request body. Error codes are RFC 7591 §3.2.2's; descriptions echo no input. */
export function checkClientMetadata(body: unknown): MetadataCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("invalid_client_metadata", "the request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!isStringArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return bad("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`);
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return bad("invalid_redirect_uri", problem);
  }
  if (new Set(uris).size !== uris.length) return bad("invalid_redirect_uri", "redirect_uris has duplicates");
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") {
    return bad("invalid_client_metadata", "only public clients are supported (token_endpoint_auth_method none)");
  }
  let grantTypes = ["authorization_code"];
  if (b.grant_types !== undefined) {
    if (!isStringArray(b.grant_types) || b.grant_types.length === 0) {
      return bad("invalid_client_metadata", "grant_types must be a non-empty array of strings");
    }
    const grants = [...new Set(b.grant_types)];
    if (!grants.every((g) => SUPPORTED_GRANTS.has(g)) || !grants.includes("authorization_code")) {
      return bad("invalid_client_metadata", "grant_types must be authorization_code, optionally with refresh_token");
    }
    grantTypes = grants;
  }
  if (b.response_types !== undefined) {
    if (!isStringArray(b.response_types) || b.response_types.length !== 1 || b.response_types[0] !== "code") {
      return bad("invalid_client_metadata", 'response_types must be ["code"]');
    }
  }
  let clientName: string | undefined;
  if (b.client_name !== undefined) {
    if (
      typeof b.client_name !== "string" ||
      b.client_name.trim().length === 0 ||
      b.client_name.length > MAX_CLIENT_NAME ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
      /[\u0000-\u001f\u007f-\u009f]/.test(b.client_name)
    ) {
      return bad("invalid_client_metadata", `client_name must be 1 to ${MAX_CLIENT_NAME} printable characters`);
    }
    clientName = b.client_name;
  }
  return { ok: true, metadata: { redirectUris: uris, grantTypes, ...(clientName ? { clientName } : {}) } };
}

export type ClientStatus = "pending" | "approved" | "denied" | "revoked";

export interface RegisteredClient extends ClientMetadata {
  readonly clientId: string;
  readonly status: ClientStatus;
  readonly createdAt: string;
}

export type RegisterResult = { ok: true; client: RegisteredClient } | { ok: false; reason: "too_many_pending" };

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris_json: string;
  grant_types_json: string;
  status: ClientStatus;
  created_at: string;
}

export interface OAuthClientStoreDeps {
  now?: () => Date;
  randomBytes?: (n: number) => Buffer;
}

export class OAuthClientStore {
  private readonly now: () => Date;
  private readonly random: (n: number) => Buffer;

  constructor(
    private readonly db: Database.Database,
    deps: OAuthClientStoreDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.randomBytes ?? randomBytes;
  }

  /** Store a validated registration as `pending`, unless the pending cap is reached. */
  register(metadata: ClientMetadata): RegisterResult {
    const now = this.now();
    const since = new Date(now.getTime() - PENDING_WINDOW_MS).toISOString();
    return this.db.transaction((): RegisterResult => {
      const { n } = this.db
        .prepare("SELECT COUNT(*) AS n FROM oauth_client WHERE status = 'pending' AND created_at > ?")
        .get(since) as { n: number };
      if (n >= MAX_PENDING_CLIENTS) return { ok: false, reason: "too_many_pending" };
      const clientId = `sbc_${this.random(16).toString("base64url")}`;
      const createdAt = now.toISOString();
      this.db
        .prepare(
          `INSERT INTO oauth_client (client_id, client_name, redirect_uris_json, grant_types_json, status, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          clientId,
          metadata.clientName ?? null,
          JSON.stringify(metadata.redirectUris),
          JSON.stringify(metadata.grantTypes),
          createdAt,
        );
      return { ok: true, client: { ...metadata, clientId, status: "pending", createdAt } };
    })();
  }

  get(clientId: string): RegisteredClient | undefined {
    const row = this.db
      .prepare(
        "SELECT client_id, client_name, redirect_uris_json, grant_types_json, status, created_at FROM oauth_client WHERE client_id = ?",
      )
      .get(clientId) as ClientRow | undefined;
    if (!row) return undefined;
    return {
      clientId: row.client_id,
      redirectUris: JSON.parse(row.redirect_uris_json) as string[],
      grantTypes: JSON.parse(row.grant_types_json) as string[],
      ...(row.client_name !== null ? { clientName: row.client_name } : {}),
      status: row.status,
      createdAt: row.created_at,
    };
  }
}

/** The RFC 7591 §3.2.1 response for a registered client. No secret, no registration access token (no RFC 7592). */
export function registrationResponse(c: RegisteredClient): Record<string, unknown> {
  return {
    client_id: c.clientId,
    client_id_issued_at: Math.floor(Date.parse(c.createdAt) / 1000),
    ...(c.clientName !== undefined ? { client_name: c.clientName } : {}),
    redirect_uris: [...c.redirectUris],
    grant_types: [...c.grantTypes],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
