/**
 * Authorization and token endpoints of the embedded OAuth 2.1 authorization server, with the operator consent page
 * (T13.8; ADR-0041 items 3, 4, 6 and 8, LLD §3.3, Q-75, Q-76).
 *
 * Flow: `GET /authorize` checks the request and shows the consent page; `POST /authorize` takes the operator's
 * decision; an approval with the operator passphrase or a one-time pairing code redirects back to the client with a
 * single-use authorization code; `POST /token` exchanges the code (PKCE S256) for an opaque access token and, if the
 * client registered the `refresh_token` grant, a refresh token that rotates on every use (`oauth-tokens.ts`).
 *
 * Delegated (Q-76, fail closed):
 * - PKCE is mandatory and `S256` only; a missing method (RFC 7636's default `plain`) is refused. `redirect_uri` is
 *   required and must equal a registered URI exactly. `resource` (RFC 8707) is required at `/authorize` and must equal
 *   this server's resource identifier; at `/token` it is optional but must equal it when sent. Every token is bound to
 *   that audience. A parameter sent twice is refused.
 * - The only grantable scope is `mcp` (the default when `scope` is absent). Any other scope, `privileged` included, is
 *   refused with `invalid_scope`; trust comes from the client's configured maximum profile (FR-MCP-14, T13.4).
 * - An unknown client or a redirect URI that does not match gets an error page and no redirect (RFC 6749 §4.1.2.1).
 *   Other errors redirect only for an approved client; a pending, denied or revoked client gets the error page, so a
 *   self-registered redirect URI cannot turn this server into an open redirector (RFC 9700 §4.11.2).
 * - There is no authorization-server login session: every authorization needs the passphrase or a pairing code. A
 *   pending client is approved by the first successful consent; a denied or revoked client is refused. "Deny" needs
 *   no credential and changes no client status, so a stranger cannot deny someone else's client.
 * - CSRF: each consent request has a random id and a CSRF token held server-side; the form carries both and the token
 *   is also set as a `__Host-` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`); the POST must match both, carry no
 *   foreign `Origin` and no cross-site `Sec-Fetch-Site`. A mismatch ends the consent request.
 * - Attempt limits: {@link MAX_FAILED_ATTEMPTS} wrong passphrases within {@link ATTEMPT_WINDOW_MS} lock passphrase
 *   approval for {@link LOCKOUT_MS}, during which even the right passphrase is refused. One passphrase check runs at a
 *   time; a concurrent one is refused, so scrypt's cost cannot be multiplied. Wrong pairing codes are throttled
 *   separately ({@link MAX_PAIRING_FAILURES_PER_MINUTE} a minute, then 429) and never lock or end a code, so a stranger
 *   who keeps the passphrase locked cannot also block the operator's fresh pairing code (60 bits, single use).
 * - Authorization codes live in memory only, hashed, for {@link AUTHORIZATION_CODE_TTL_MS}; a restart drops them. A
 *   reused code is refused and every token of its client is revoked (RFC 6749 §4.1.2).
 * - Lifetimes (Assumption): access token {@link ACCESS_TOKEN_TTL_MS}, refresh token {@link REFRESH_TOKEN_TTL_MS} from
 *   its issue (each rotation issues a new one), consent request {@link CONSENT_REQUEST_TTL_MS}.
 *
 * T13.11 (FR-MCP-19, LLD §20.11, ADR-0065): a `client_id` that is an `https` URL names a Client ID Metadata Document
 * (`oauth-cimd.ts`). With `transport.http.cimd` on (the default) and a fetcher wired, `GET /authorize` fetches the
 * document afresh under the fetcher's limits, stores the metadata under the URL's derived `sbc_` identifier (a new URL
 * as a `pending` client, under the registration cap), and shows the URL's host on the consent page; then consent and
 * `POST /token` run exactly as for a registered client. No fetch happens at `/token`, for a denied or revoked client,
 * for a URL whose origin is this issuer, or when the fetch cap is busy. A refused document is an error page with no
 * redirect, like an unknown client.
 *
 * Profile-bound one-time codes (migration 0036, `switchboard mcp oauth issue-code`): the consent form's `pairing_code`
 * field takes them as well as legacy `consent pair` codes. A bound code is looked up first without being spent; a client
 * bound (in config or in the ledger) to another profile, or a profile no longer eligible for a binding, gets an error
 * page and the code stays live. Otherwise the code is spent atomically and, in one transaction, a pending client is
 * approved and a client not mapped in config is bound to the code's profile (`approveAndBind`). A legacy code and the
 * passphrase approve exactly as before and bind nothing.
 *
 * Per-address lockout (`oauth-ip-limiter.ts`): wrong codes and wrong passphrases also count per client address; an
 * address over the limit gets 429 on any code or passphrase entry, before the credential is checked. The global limits
 * above stay in force.
 *
 * RFC 7009 revocation (`POST /revoke`, {@link AuthorizationServer.handleRevoke}): form-encoded `token`, optional
 * `token_type_hint` (accepted and ignored: the store finds the token by hash), and `client_id` (public clients
 * authenticate by identifier only). Only a token of that client is revoked; a refresh token takes its whole grant with
 * it. An unknown or another client's token gets the same 200 (RFC 7009 §2.2).
 *
 * Grants and revocations are written to the durable audit (`oauth_event`) when `audit` is wired: consent approval
 * (method, client, profile, address), token issue and refresh (client, profile), revocation (client, token kind).
 *
 * Nothing secret is logged or echoed: `onEvent` receives event names, client ids, methods and reason codes only.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type HttpTransportSettings, resolveMcpClientFor } from "../config/http-transport.js";
import { mediaType, readBody } from "./http-body.js";
import type { OAuthAuditLog } from "./oauth-audit.js";
import { type CimdFetcher, checkCimdClientId, cimdInternalClientId, looksLikeCimdClientId } from "./oauth-cimd.js";
import type { OAuthClientStore, RegisteredClient } from "./oauth-clients.js";
import { consentHeaders, consentPage, errorPage, sendHtml } from "./oauth-consent-page.js";
import { IP_LOCK_MS, IpAttemptLimiter } from "./oauth-ip-limiter.js";
import type { PairingCodeStore } from "./oauth-pairing.js";
import { verifyPassphrase as defaultVerifyPassphrase } from "./oauth-passphrase.js";
import type { OAuthTokenStore } from "./oauth-tokens.js";

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
export const CONSENT_REQUEST_TTL_MS = 10 * 60 * 1000;
export const MAX_CONSENT_REQUESTS = 32;
export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Wrong pairing codes allowed per minute; more are refused (429) without consuming or ending any code. */
export const MAX_PAIRING_FAILURES_PER_MINUTE = 10;
const PAIRING_WINDOW_MS = 60 * 1000;
export const GRANTABLE_SCOPES: readonly string[] = ["mcp"];
export const CONSENT_COOKIE = "__Host-sb_consent";
const MAX_FORM_BYTES = 8 * 1024;
const MAX_STATE_LENGTH = 512;
const CODE_PATTERN = /^sbac_[A-Za-z0-9_-]{43}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export type AuthEvent =
  | "consent_shown"
  | "consent_approved"
  | "consent_denied"
  | "consent_failed"
  | "consent_locked_out"
  | "consent_refused_locked"
  | "consent_csrf_refused"
  | "authorize_refused"
  | "code_reused"
  | "token_issued"
  | "token_refused"
  | "refresh_reused"
  | "cimd_fetched"
  | "cimd_refused"
  | "consent_refused_profile"
  | "token_revoked"
  | "revoke_refused";

/** Audit fields: never a token, code, passphrase or pairing code. `host` is a Client Identifier URL's host (T13.11). */
export type AuthEventFields = {
  client_id?: string;
  method?: "passphrase" | "pairing_code";
  reason?: string;
  host?: string;
  /** The `mcp_clients` profile a grant is for, or a bound code's profile. */
  mcp_client?: string;
  /** The client address the per-address lockout keyed (consent events only). */
  ip?: string;
};

export interface AuthorizationServerDeps {
  /** `registerCimd` and `pendingCapReached` are needed for Client ID Metadata Documents; without them CIMD is off. */
  clients: Pick<OAuthClientStore, "get" | "approveAndBind"> &
    Partial<Pick<OAuthClientStore, "registerCimd" | "pendingCapReached">>;
  /** The metadata-document fetcher (T13.11); without one a URL `client_id` is an unknown client. */
  cimd?: Pick<CimdFetcher, "fetch">;
  tokens: Pick<
    OAuthTokenStore,
    "issue" | "verify" | "useRefreshToken" | "revokeClient" | "revokeForClient" | "newGrantId"
  >;
  /** One-time code lookup and redemption; without it the fallback is unavailable. */
  pairing?: Pick<PairingCodeStore, "lookup" | "consume">;
  /** Per-address lockout; `serve` shares one with the approval-link page. A fresh one when absent. */
  ipLimiter?: IpAttemptLimiter;
  /** Durable audit of grants and revocations (`oauth_event`); nothing is recorded without it. */
  audit?: Pick<OAuthAuditLog, "record">;
  /** `transport.http.passphrase_hash`; without it the passphrase path is unavailable. */
  passphraseHash?: string;
  /** Injected by tests to skip scrypt's cost. */
  verifyPassphrase?: (passphrase: string, encoded: string) => Promise<boolean>;
  /** Wrong-passphrase lockout; `serve` shares one with the approval-link page (T14.10) so both count together. */
  limiter?: AttemptLimiter;
  now?: () => Date;
  randomBytes?: (n: number) => Buffer;
  onEvent?: (event: AuthEvent, fields: AuthEventFields) => void;
}

interface ConsentRequest {
  readonly csrfHash: Buffer;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly state?: string;
  readonly approvedClient: boolean;
  readonly expiresAt: number;
}

interface CodeGrant {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  used: boolean;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function sameSecret(a: string | undefined, expectedHash: Buffer): boolean {
  if (a === undefined) return false;
  return timingSafeEqual(sha256(a), expectedHash);
}

/** Parse a form body; undefined when any parameter is repeated (RFC 6749 §3.1, §3.2). */
export function parseForm(text: string): Map<string, string> | undefined {
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(text)) {
    if (out.has(k)) return undefined;
    out.set(k, v);
  }
  return out;
}

/** The one cookie `name`; undefined when it is absent or sent twice. */
export function cookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    if (found !== undefined) return undefined; // two cookies of the same name: refuse rather than pick one
    found = part.slice(i + 1).trim();
  }
  return found;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    pragma: "no-cache",
    ...headers,
  });
  res.end(text);
}

/** Lock approval after repeated failures (Q-76). In memory: one `serve` process owns the listener. */
export class AttemptLimiter {
  private failures: number[] = [];
  private lockedUntil = 0;

  locked(now: number): boolean {
    return now < this.lockedUntil;
  }

  /** Record a failure; returns true when this failure starts a lockout. */
  fail(now: number): boolean {
    this.failures = this.failures.filter((t) => now - t < ATTEMPT_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length < MAX_FAILED_ATTEMPTS) return false;
    this.failures = [];
    this.lockedUntil = now + LOCKOUT_MS;
    return true;
  }

  succeed(): void {
    this.failures = [];
  }
}

export class AuthorizationServer {
  private readonly consents = new Map<string, ConsentRequest>();
  private readonly codes = new Map<string, CodeGrant>();
  /** Wrong passphrases: a global lockout. */
  private readonly limiter: AttemptLimiter;
  /** Wrong codes and passphrases per client address. */
  private readonly ipLimiter: IpAttemptLimiter;
  /** Times of recent wrong pairing codes (a separate, short throttle; never a lockout). */
  private pairingFailures: number[] = [];
  private verifying = false;
  private readonly now: () => Date;
  private readonly random: (n: number) => Buffer;
  private readonly checkPassphrase: (passphrase: string, encoded: string) => Promise<boolean>;

  constructor(
    private readonly s: HttpTransportSettings,
    private readonly deps: AuthorizationServerDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.randomBytes ?? randomBytes;
    this.checkPassphrase = deps.verifyPassphrase ?? defaultVerifyPassphrase;
    this.limiter = deps.limiter ?? new AttemptLimiter();
    this.ipLimiter = deps.ipLimiter ?? new IpAttemptLimiter(s.clientIpHeader);
  }

  /** The profile a client acts as at the MCP endpoint, for the audit; undefined when it has none. */
  private profileOf(clientId: string, ledgerBinding: string | undefined): string | undefined {
    return resolveMcpClientFor(this.s, clientId, ledgerBinding)?.mcpClient;
  }

  /**
   * Why a profile-bound code may not approve this client, or undefined: the profile is no longer eligible for a
   * ledger binding, or the client is already mapped (config) or bound (ledger) to another profile.
   */
  private bindingProblem(client: RegisteredClient, profile: string): string | undefined {
    if (this.s.bindableMcpClients?.has(profile) !== true) return "profile_ineligible";
    const mapped = this.s.clientMap.get(client.clientId);
    if (mapped !== undefined && mapped !== profile) return "bound_elsewhere";
    if (client.mcpClient !== undefined && client.mcpClient !== profile) return "bound_elsewhere";
    return undefined;
  }

  /** True while {@link MAX_PAIRING_FAILURES_PER_MINUTE} wrong pairing codes fall within the last minute. */
  private pairingThrottled(now: number): boolean {
    this.pairingFailures = this.pairingFailures.filter((t) => now - t < PAIRING_WINDOW_MS);
    return this.pairingFailures.length >= MAX_PAIRING_FAILURES_PER_MINUTE;
  }

  private event(event: AuthEvent, fields: AuthEventFields = {}): void {
    this.deps.onEvent?.(event, fields);
  }

  private secret(prefix = ""): string {
    const bytes = this.random(32);
    if (bytes.length !== 32) throw new Error("entropy source returned the wrong length");
    return `${prefix}${bytes.toString("base64url")}`;
  }

  private prune(now: number): void {
    for (const [k, v] of this.consents) if (v.expiresAt <= now) this.consents.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
  }

  /** The authorization response (RFC 6749 §4.1.2, RFC 9207 `iss`). */
  private redirectTo(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.append(k, v);
    url.searchParams.append("iss", this.s.issuer);
    return url.href;
  }

  private redirect(res: ServerResponse, status: 302 | 303, location: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { location, "content-length": "0", ...consentHeaders(new URL(location).origin), ...extra });
    res.end();
  }

  /** `GET`/`POST /authorize`. */
  async handleAuthorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" || req.method === "HEAD") return this.showConsent(req, res);
    if (req.method === "POST") return this.decide(req, res);
    sendHtml(res, 405, errorPage("Method not allowed."), { allow: "GET, HEAD, POST" });
  }

  private cimdEnabled(): boolean {
    return (
      this.s.cimd &&
      this.deps.cimd !== undefined &&
      this.deps.clients.registerCimd !== undefined &&
      this.deps.clients.pendingCapReached !== undefined
    );
  }

  /** The stored client for a presented `client_id`, a Client Identifier URL included; never fetches (T13.11). */
  private findClient(presented: string): RegisteredClient | undefined {
    if (!looksLikeCimdClientId(presented)) return this.deps.clients.get(presented);
    if (!this.cimdEnabled() || checkCimdClientId(presented) === undefined) return undefined;
    const client = this.deps.clients.get(cimdInternalClientId(presented));
    return client?.cimdUrl === presented ? client : undefined;
  }

  /**
   * T13.11 (FR-MCP-19): the client of an authorization request. A Client Identifier URL is fetched afresh and stored
   * under its derived identifier; `reason` is the audit reason code when no client results.
   */
  private async clientForAuthorize(
    presented: string,
  ): Promise<{ client: RegisteredClient } | { client?: undefined; reason: string; host?: string }> {
    const cimd = this.deps.cimd;
    const clients = this.deps.clients;
    if (!looksLikeCimdClientId(presented)) {
      const client = clients.get(presented);
      return client !== undefined ? { client } : { reason: "unknown_client" };
    }
    if (
      !this.cimdEnabled() ||
      cimd === undefined ||
      clients.registerCimd === undefined ||
      clients.pendingCapReached === undefined
    ) {
      return { reason: "unknown_client" };
    }
    const url = checkCimdClientId(presented);
    if (url === undefined) return { reason: "cimd_client_id" };
    const host = url.host;
    // This server's own origin is never fetched: the document would be served by Switchboard itself.
    if (url.origin === this.s.issuer) return { reason: "cimd_self", host };
    const internalId = cimdInternalClientId(presented);
    const known = clients.get(internalId);
    if (known !== undefined && known.cimdUrl !== presented) return { reason: "cimd_id_conflict", host };
    // No fetch on behalf of a denied or revoked client: the usual refusal follows without an outbound request.
    if (known !== undefined && known.status !== "pending" && known.status !== "approved") return { client: known };
    // A new URL would create a pending client, so the registration cap applies before any outbound request.
    if (known === undefined && clients.pendingCapReached()) return { reason: "cimd_too_many_pending", host };
    const fetched = await cimd.fetch(presented);
    if (!fetched.ok) {
      this.event("cimd_refused", { reason: fetched.reason, host });
      return { reason: `cimd_${fetched.reason}`, host };
    }
    // The store's methods are called on the store (not as detached functions), so `this` stays bound.
    const stored = clients.registerCimd(internalId, presented, fetched.metadata);
    if (!stored.ok) return { reason: `cimd_${stored.reason}`, host };
    this.event("cimd_fetched", { client_id: internalId, host });
    return { client: stored.client };
  }

  private async showConsent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseForm(new URL(req.url ?? "/", "http://listener.invalid").search.slice(1));
    if (q === undefined) {
      this.event("authorize_refused", { reason: "duplicate_parameter" });
      sendHtml(res, 400, errorPage("Invalid authorization request: a parameter is repeated."));
      return;
    }
    const clientId = q.get("client_id");
    const found = clientId !== undefined ? await this.clientForAuthorize(clientId) : { reason: "unknown_client" };
    if (found.client === undefined) {
      const { reason, host } = found;
      this.event("authorize_refused", { reason, ...(host !== undefined ? { host } : {}) });
      sendHtml(
        res,
        400,
        errorPage(
          reason === "unknown_client"
            ? "Invalid authorization request: unknown client."
            : "Invalid authorization request: the client's metadata document could not be fetched or is not valid.",
        ),
      );
      return;
    }
    const client = found.client;
    const redirectUri = q.get("redirect_uri");
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
      this.event("authorize_refused", { client_id: client.clientId, reason: "redirect_uri" });
      sendHtml(res, 400, errorPage("Invalid authorization request: the redirect URI is not registered."));
      return;
    }
    const rawState = q.get("state");
    const state = rawState !== undefined && rawState.length <= MAX_STATE_LENGTH ? rawState : undefined;
    const refuse = (error: string, reason: string, description: string) => {
      this.event("authorize_refused", { client_id: client.clientId, reason });
      // Only an approved client's redirect URI is trusted for error redirects: a self-registered client's URI would
      // make this server an open redirector (RFC 9700 §4.11.2).
      if (client.status === "approved") {
        this.redirect(res, 302, this.redirectTo(redirectUri, { error, error_description: description, state }));
      } else {
        sendHtml(res, 400, errorPage(`Invalid authorization request: ${description}.`));
      }
    };
    if (rawState !== undefined && state === undefined) {
      refuse("invalid_request", "state", "state is too long");
      return;
    }
    if (q.get("response_type") !== "code") {
      refuse("unsupported_response_type", "response_type", "only response_type=code is supported");
      return;
    }
    if (q.get("code_challenge_method") !== "S256") {
      refuse("invalid_request", "pkce_method", "PKCE with code_challenge_method=S256 is required");
      return;
    }
    const challenge = q.get("code_challenge");
    if (challenge === undefined || !CHALLENGE_PATTERN.test(challenge)) {
      refuse("invalid_request", "pkce_challenge", "a valid S256 code_challenge is required");
      return;
    }
    if (q.get("resource") !== this.s.resource) {
      refuse("invalid_target", "resource", "resource must be this server's MCP endpoint");
      return;
    }
    const scope = q.get("scope");
    const scopes = scope === undefined ? [...GRANTABLE_SCOPES] : [...new Set(scope.split(" "))];
    if (scopes.length === 0 || !scopes.every((sc) => GRANTABLE_SCOPES.includes(sc))) {
      refuse("invalid_scope", "scope", "the only grantable scope is mcp");
      return;
    }
    if (client.status !== "pending" && client.status !== "approved") {
      refuse("access_denied", `client_${client.status}`, "this client is not approved");
      return;
    }
    const now = this.now().getTime();
    this.prune(now);
    // At most MAX_CONSENT_REQUESTS open. A new request drops the oldest one for a client that is not yet approved
    // (anyone can register those), and only if there is none the oldest overall, so a flood against self-registered
    // clients cannot push out an approved client's request.
    while (this.consents.size >= MAX_CONSENT_REQUESTS) {
      let victim: string | undefined;
      for (const [k, v] of this.consents) {
        if (!v.approvedClient) {
          victim = k;
          break;
        }
      }
      victim ??= this.consents.keys().next().value;
      if (victim === undefined) break;
      this.consents.delete(victim);
    }
    const requestId = this.secret();
    const csrf = this.secret();
    this.consents.set(requestId, {
      csrfHash: sha256(csrf),
      clientId: client.clientId,
      redirectUri,
      codeChallenge: challenge,
      scopes,
      ...(state !== undefined ? { state } : {}),
      approvedClient: client.status === "approved",
      expiresAt: now + CONSENT_REQUEST_TTL_MS,
    });
    this.event("consent_shown", { client_id: client.clientId });
    this.renderConsent(res, 200, requestId, csrf, client, redirectUri, scopes);
  }

  private renderConsent(
    res: ServerResponse,
    status: number,
    requestId: string,
    csrf: string,
    client: RegisteredClient,
    redirectUri: string,
    scopes: readonly string[],
    notice?: string,
  ): void {
    const html = consentPage({
      requestId,
      csrf,
      // A CIMD client is shown by its URL (the identifier the operator can recognise), with the host on its own line.
      clientId: client.cimdUrl ?? client.clientId,
      ...(client.cimdUrl !== undefined ? { metadataHost: new URL(client.cimdUrl).host } : {}),
      ...(client.clientName !== undefined ? { clientName: client.clientName } : {}),
      redirectUri,
      scopes,
      newClient: client.status === "pending",
      ...(notice !== undefined ? { notice } : {}),
    });
    sendHtml(res, status, html, {
      "set-cookie": `${CONSENT_COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${CONSENT_REQUEST_TTL_MS / 1000}`,
      "content-security-policy": consentHeaders(new URL(redirectUri).origin)["content-security-policy"] as string,
    });
  }

  private async decide(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if ((origin !== undefined && origin !== this.s.issuer) || (site !== undefined && site !== "same-origin")) {
      this.event("consent_csrf_refused", { reason: "cross_site" });
      sendHtml(res, 403, errorPage("This form can only be submitted from the consent page."));
      return;
    }
    if (mediaType(req) !== "application/x-www-form-urlencoded") {
      sendHtml(res, 415, errorPage("Unsupported form encoding."));
      return;
    }
    const read = await readBody(req, MAX_FORM_BYTES);
    const form = read.ok ? parseForm(read.body.toString("utf8")) : undefined;
    if (form === undefined) {
      sendHtml(res, 400, errorPage("Invalid form."));
      return;
    }
    const now = this.now().getTime();
    this.prune(now);
    const requestId = form.get("request_id");
    const consent = requestId !== undefined ? this.consents.get(requestId) : undefined;
    if (requestId === undefined || consent === undefined) {
      sendHtml(res, 400, errorPage("This authorization request has expired. Start again from the client."));
      return;
    }
    const clearCookie = { "set-cookie": `${CONSENT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` };
    if (!sameSecret(form.get("csrf"), consent.csrfHash) || !sameSecret(cookie(req, CONSENT_COOKIE), consent.csrfHash)) {
      this.consents.delete(requestId);
      this.event("consent_csrf_refused", { client_id: consent.clientId, reason: "csrf_token" });
      sendHtml(res, 403, errorPage("The form could not be verified. Start again from the client."), clearCookie);
      return;
    }
    const decision = form.get("decision");
    if (decision === "deny") {
      this.consents.delete(requestId);
      this.event("consent_denied", { client_id: consent.clientId });
      const location = this.redirectTo(consent.redirectUri, {
        error: "access_denied",
        error_description: "the operator denied the request",
        state: consent.state,
      });
      this.redirect(res, 303, location, clearCookie);
      return;
    }
    if (decision !== "approve") {
      sendHtml(res, 400, errorPage("Invalid form."));
      return;
    }
    const client = this.deps.clients.get(consent.clientId);
    if (client === undefined || (client.status !== "pending" && client.status !== "approved")) {
      this.consents.delete(requestId);
      sendHtml(res, 403, errorPage("This client is not approved."), clearCookie);
      return;
    }
    const passphrase = form.get("passphrase") ?? "";
    const pairingCode = form.get("pairing_code") ?? "";
    const { ip, key: ipKey } = this.ipLimiter.identify(req);
    const at = ip !== undefined ? { ip } : {};
    const retry = (status: number, notice: string) => {
      const csrf = this.secret();
      this.consents.set(requestId, { ...consent, csrfHash: sha256(csrf) });
      this.renderConsent(res, status, requestId, csrf, client, consent.redirectUri, consent.scopes, notice);
    };
    const lockedOut = () => {
      this.consents.delete(requestId);
      sendHtml(res, 429, errorPage("Too many wrong passphrases. Passphrase approval is locked; try again later."), {
        ...clearCookie,
        "retry-after": String(LOCKOUT_MS / 1000),
      });
    };
    const ipLockedOut = () => {
      this.consents.delete(requestId);
      sendHtml(res, 429, errorPage("Too many wrong attempts from this address. Try again later."), {
        ...clearCookie,
        "retry-after": String(IP_LOCK_MS / 1000),
      });
    };
    // Per address first: an address over its limit is refused before any credential is checked.
    if ((passphrase !== "" || pairingCode !== "") && this.ipLimiter.locked(ipKey, now)) {
      this.event("consent_refused_locked", { client_id: client.clientId, reason: "address_locked", ...at });
      ipLockedOut();
      return;
    }
    // The passphrase lockout does not block pairing codes, so a stranger who keeps the passphrase locked cannot also
    // lock out the operator's local recovery path (`switchboard consent pair`).
    if (passphrase !== "" && this.limiter.locked(now)) {
      this.event("consent_refused_locked", { client_id: client.clientId });
      lockedOut();
      return;
    }
    if (passphrase === "" && pairingCode !== "" && this.pairingThrottled(now)) {
      this.event("consent_refused_locked", { client_id: client.clientId, method: "pairing_code" });
      retry(429, "Too many wrong pairing codes. Wait a minute and try again.");
      return;
    }
    if (passphrase === "" && pairingCode === "") {
      retry(400, "Enter the operator passphrase or a pairing code.");
      return;
    }
    const method = passphrase !== "" ? "passphrase" : "pairing_code";
    let ok: boolean;
    /** The profile a bound code binds the client to; undefined for the passphrase and a legacy code. */
    let codeProfile: string | undefined;
    if (method === "passphrase") {
      if (this.verifying) {
        retry(429, "Another approval is being checked. Try again.");
        return;
      }
      this.verifying = true;
      try {
        const hash = this.deps.passphraseHash;
        ok = hash !== undefined && (await this.checkPassphrase(passphrase, hash));
      } finally {
        this.verifying = false;
      }
    } else {
      const pairing = this.deps.pairing;
      // Looked up first without spending it, so a profile conflict leaves the operator's code live.
      const live = pairing?.lookup(pairingCode);
      if (pairing !== undefined && live?.mcpClient !== undefined) {
        const problem = this.bindingProblem(client, live.mcpClient);
        if (problem !== undefined) {
          this.consents.delete(requestId);
          this.event("consent_refused_profile", {
            client_id: client.clientId,
            mcp_client: live.mcpClient,
            reason: problem,
            ...at,
          });
          sendHtml(
            res,
            403,
            errorPage(
              problem === "bound_elsewhere"
                ? "This client is already bound to a different client profile. Nothing changed; the code is still valid."
                : "The client profile this code was issued for can no longer be used over HTTP. Nothing changed.",
            ),
            clearCookie,
          );
          return;
        }
      }
      const spent = live !== undefined ? pairing?.consume(pairingCode) : undefined;
      ok = spent !== undefined && spent.mcpClient === live?.mcpClient;
      codeProfile = spent?.mcpClient;
    }
    const after = this.now().getTime();
    if (!ok) {
      this.event("consent_failed", { client_id: client.clientId, method, ...at });
      const ipLock = this.ipLimiter.fail(ipKey, after);
      if (method === "passphrase" && this.limiter.fail(after)) {
        this.event("consent_locked_out", { client_id: client.clientId });
        lockedOut();
        return;
      }
      if (method === "pairing_code") this.pairingFailures.push(after);
      if (ipLock) {
        this.event("consent_locked_out", { client_id: client.clientId, reason: "address", ...at });
        ipLockedOut();
        return;
      }
      retry(401, "Wrong passphrase or pairing code.");
      return;
    }
    if (method === "passphrase") this.limiter.succeed();
    this.consents.delete(requestId);
    // A client mapped in config keeps that mapping; the ledger binding is only for one that is not.
    const bindTo = codeProfile !== undefined && !this.s.clientMap.has(client.clientId) ? codeProfile : undefined;
    const decided = this.deps.clients.approveAndBind(client.clientId, bindTo);
    if (!decided.ok) {
      if (decided.reason === "bound_elsewhere") {
        this.event("consent_refused_profile", {
          client_id: client.clientId,
          ...(codeProfile !== undefined ? { mcp_client: codeProfile } : {}),
          reason: "bound_elsewhere",
          ...at,
        });
        sendHtml(res, 403, errorPage("This client is already bound to a different client profile."), clearCookie);
        return;
      }
      sendHtml(res, 403, errorPage("This client is not approved."), clearCookie);
      return;
    }
    const profile = this.profileOf(client.clientId, decided.client.mcpClient);
    const code = this.secret("sbac_");
    this.codes.set(sha256(code).toString("hex"), {
      clientId: client.clientId,
      redirectUri: consent.redirectUri,
      codeChallenge: consent.codeChallenge,
      scopes: consent.scopes,
      expiresAt: after + AUTHORIZATION_CODE_TTL_MS,
      used: false,
    });
    this.event("consent_approved", {
      client_id: client.clientId,
      method,
      ...(profile !== undefined ? { mcp_client: profile } : {}),
      ...(decided.bound ? { reason: "bound" } : {}),
      ...at,
    });
    this.deps.audit?.record("consent_approved", {
      clientId: client.clientId,
      mcpClient: profile,
      method: codeProfile !== undefined ? "bound_code" : method,
      actor: "endpoint",
      ip,
      ...(decided.bound ? { reason: "bound" } : decided.approved ? { reason: "approved" } : {}),
    });
    this.redirect(res, 303, this.redirectTo(consent.redirectUri, { code, state: consent.state }), clearCookie);
  }

  /** `POST /token` (OAuth 2.1 §3.2). */
  async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (status: number, error: string, reason: string, clientId?: string, headers = {}) => {
      this.event("token_refused", { reason, ...(clientId !== undefined ? { client_id: clientId } : {}) });
      sendJson(res, status, { error }, headers);
    };
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "invalid_request" }, { allow: "POST" });
      return;
    }
    if (mediaType(req) !== "application/x-www-form-urlencoded") {
      fail(400, "invalid_request", "content_type");
      return;
    }
    const read = await readBody(req, MAX_FORM_BYTES);
    if (!read.ok) {
      fail(read.status, "invalid_request", "body");
      return;
    }
    const form = parseForm(read.body.toString("utf8"));
    if (form === undefined) {
      fail(400, "invalid_request", "duplicate_parameter");
      return;
    }
    const grantType = form.get("grant_type");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      fail(400, "unsupported_grant_type", "grant_type");
      return;
    }
    const clientId = form.get("client_id");
    const client = clientId !== undefined ? this.findClient(clientId) : undefined;
    if (client === undefined) {
      fail(401, "invalid_client", "unknown_client");
      return;
    }
    const resource = form.get("resource");
    if (resource !== undefined && resource !== this.s.resource) {
      fail(400, "invalid_target", "resource", client.clientId);
      return;
    }
    const now = this.now().getTime();
    if (grantType === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      const verifier = form.get("code_verifier");
      if (code === undefined || redirectUri === undefined || verifier === undefined) {
        fail(400, "invalid_request", "missing_parameter", client.clientId);
        return;
      }
      const key = CODE_PATTERN.test(code) ? sha256(code).toString("hex") : undefined;
      const grant = key !== undefined ? this.codes.get(key) : undefined;
      if (grant === undefined) {
        fail(400, "invalid_grant", "unknown_code", client.clientId);
        return;
      }
      if (grant.used) {
        const revoked = this.deps.tokens.revokeClient(grant.clientId);
        this.event("code_reused", { client_id: grant.clientId, reason: `revoked_${revoked}` });
        fail(400, "invalid_grant", "code_reused", client.clientId);
        return;
      }
      grant.used = true; // single use, whatever the outcome below
      if (now >= grant.expiresAt) {
        fail(400, "invalid_grant", "code_expired", client.clientId);
        return;
      }
      if (grant.clientId !== client.clientId) {
        fail(400, "invalid_grant", "code_client", client.clientId);
        return;
      }
      if (grant.redirectUri !== redirectUri) {
        fail(400, "invalid_grant", "redirect_uri", client.clientId);
        return;
      }
      if (!VERIFIER_PATTERN.test(verifier)) {
        fail(400, "invalid_grant", "pkce_verifier", client.clientId);
        return;
      }
      const computed = createHash("sha256").update(verifier, "ascii").digest();
      const expected = Buffer.from(grant.codeChallenge, "base64url");
      if (expected.length !== computed.length || !timingSafeEqual(computed, expected)) {
        fail(400, "invalid_grant", "pkce_mismatch", client.clientId);
        return;
      }
      if (client.status !== "approved") {
        fail(400, "invalid_grant", "client_not_approved", client.clientId);
        return;
      }
      this.issue(res, client, grant.scopes, "authorization_code", this.deps.tokens.newGrantId());
      return;
    }
    if (!client.grantTypes.includes("refresh_token")) {
      fail(400, "unauthorized_client", "refresh_not_registered", client.clientId);
      return;
    }
    const refresh = form.get("refresh_token");
    if (refresh === undefined) {
      fail(400, "invalid_request", "missing_parameter", client.clientId);
      return;
    }
    // Every check that can refuse a well-formed request runs before the token is spent, so a client's bad request
    // does not cost it its refresh token (and a retry is not mistaken for reuse).
    const pre = this.deps.tokens.verify(refresh, "refresh", this.s.resource);
    if (!pre.ok) {
      // A rotated-out (revoked) token: let the store apply reuse detection, which revokes the client's tokens.
      if (pre.reason === "revoked") {
        const reused = this.deps.tokens.useRefreshToken(refresh, this.s.resource);
        if (reused.reusedBy !== undefined) this.event("refresh_reused", { client_id: reused.reusedBy });
      }
      fail(400, "invalid_grant", `refresh_${pre.reason}`, client.clientId);
      return;
    }
    if (pre.token.clientId !== client.clientId) {
      fail(400, "invalid_grant", "refresh_client", client.clientId);
      return;
    }
    if (client.status !== "approved") {
      fail(400, "invalid_grant", "client_not_approved", client.clientId);
      return;
    }
    let scopes = pre.token.scopes;
    const scope = form.get("scope");
    if (scope !== undefined) {
      const asked = [...new Set(scope.split(" "))];
      if (asked.length === 0 || !asked.every((sc) => scopes.includes(sc) && GRANTABLE_SCOPES.includes(sc))) {
        fail(400, "invalid_scope", "scope", client.clientId);
        return;
      }
      scopes = asked;
    }
    // Spend it atomically; a concurrent rotation of the same token makes this one fail (and counts as reuse).
    const used = this.deps.tokens.useRefreshToken(refresh, this.s.resource);
    if (!used.ok) {
      if (used.reusedBy !== undefined) this.event("refresh_reused", { client_id: used.reusedBy });
      fail(400, "invalid_grant", `refresh_${used.reason}`, client.clientId);
      return;
    }
    this.issue(res, client, scopes, "refresh_token", pre.token.grantId ?? this.deps.tokens.newGrantId());
    return;
  }

  private issue(
    res: ServerResponse,
    client: RegisteredClient,
    scopes: readonly string[],
    grant: "authorization_code" | "refresh_token",
    grantId: string,
  ): void {
    const base = { clientId: client.clientId, resource: this.s.resource, scopes, grantId };
    const access = this.deps.tokens.issue({ ...base, kind: "access", ttlMs: ACCESS_TOKEN_TTL_MS });
    const refresh = client.grantTypes.includes("refresh_token")
      ? this.deps.tokens.issue({ ...base, kind: "refresh", ttlMs: REFRESH_TOKEN_TTL_MS })
      : undefined;
    const profile = this.profileOf(client.clientId, client.mcpClient);
    this.event("token_issued", {
      client_id: client.clientId,
      reason: grant,
      ...(profile !== undefined ? { mcp_client: profile } : {}),
    });
    this.deps.audit?.record(grant === "refresh_token" ? "token_refreshed" : "token_issued", {
      clientId: client.clientId,
      mcpClient: profile,
      method: grant,
      actor: "endpoint",
    });
    sendJson(res, 200, {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: scopes.join(" "),
      ...(refresh !== undefined ? { refresh_token: refresh.token } : {}),
    });
  }

  /**
   * `POST /revoke` (RFC 7009). Public clients authenticate by `client_id` alone; a missing or unknown one is 401
   * `invalid_client`. A missing `token` is 400 `invalid_request`. Otherwise 200 with an empty body whether or not the
   * token was this client's (RFC 7009 §2.2), so the endpoint is no oracle for other clients' tokens.
   */
  async handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (status: number, error: string, reason: string, clientId?: string) => {
      this.event("revoke_refused", { reason, ...(clientId !== undefined ? { client_id: clientId } : {}) });
      sendJson(res, status, { error });
    };
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "invalid_request" }, { allow: "POST" });
      return;
    }
    if (mediaType(req) !== "application/x-www-form-urlencoded") {
      fail(400, "invalid_request", "content_type");
      return;
    }
    const read = await readBody(req, MAX_FORM_BYTES);
    if (!read.ok) {
      fail(read.status, "invalid_request", "body");
      return;
    }
    const form = parseForm(read.body.toString("utf8"));
    if (form === undefined) {
      fail(400, "invalid_request", "duplicate_parameter");
      return;
    }
    const clientId = form.get("client_id");
    const client = clientId !== undefined ? this.findClient(clientId) : undefined;
    if (client === undefined) {
      fail(401, "invalid_client", "unknown_client");
      return;
    }
    const token = form.get("token");
    if (token === undefined || token === "") {
      fail(400, "invalid_request", "missing_token", client.clientId);
      return;
    }
    const r = this.deps.tokens.revokeForClient(token, client.clientId);
    const reason = r.matched ? `${r.kind ?? "token"}_${r.revoked}` : "no_match";
    this.event("token_revoked", { client_id: client.clientId, reason });
    if (r.matched) {
      this.deps.audit?.record("token_revoked", {
        clientId: client.clientId,
        method: r.kind,
        actor: "endpoint",
        reason: `revoked_${r.revoked}`,
      });
    }
    res.writeHead(200, {
      "content-length": "0",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end();
  }
}
