/**
 * Opaque OAuth token store and bearer-token verifier (T13.3; FR-MCP-13, LLD §3.3, ADR-0041 items 4, 5 and 8, Q-73).
 *
 * Delegated (Q-73, orchestrator 2026-10-14): access and refresh tokens are opaque random values, never JWTs. Each is
 * 256 bits from the CSPRNG, base64url-encoded behind a fixed prefix (`sbat_` access, `sbrt_` refresh) so secret
 * scanners can recognise one. Only the SHA-256 hash of a token is stored (`oauth_token`, migration 0010); lookup is by
 * hash and the stored hash is compared to the presented one in constant time. The raw value exists only in the return
 * value of {@link OAuthTokenStore.issue}, for the token endpoint to hand to the client once.
 *
 * Verification needs no signature: a token this authorization server did not issue has no row, so a forged token, a
 * token from another issuer and a guessed token all read as unknown. Every refusal (malformed, unknown, wrong kind,
 * expired, revoked, wrong audience) yields the same outcome to the caller; only the reason code differs, and that code
 * is for the local log, never for the response.
 *
 * Migration 0036: each token carries the authorization grant it belongs to (`grant_id`, `sbg_...`), set when the code is
 * exchanged and carried across refresh rotation. {@link OAuthTokenStore.revokeForClient} (the RFC 7009 endpoint) revokes
 * a refresh token together with every token of its grant, and an access token alone; a token issued before the
 * migration has no grant and is revoked alone. The operator views ({@link OAuthTokenStore.list},
 * {@link OAuthTokenStore.counts}) return metadata only: never a token value or its hash.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export type OAuthTokenKind = "access" | "refresh";

const PREFIX: Record<OAuthTokenKind, string> = { access: "sbat_", refresh: "sbrt_" };
/** 32 random bytes = 256 bits, base64url without padding = 43 characters. */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^sb(at|rt)_[A-Za-z0-9_-]{43}$/;

/** Reason codes for a refused bearer token. Logged locally; never sent to the client. */
export type TokenRejectReason = "malformed" | "unknown" | "wrong_kind" | "expired" | "revoked" | "wrong_audience";

export interface VerifiedToken {
  readonly clientId: string;
  /** The grant the token belongs to (migration 0037); absent for a token issued before it. */
  readonly grantId?: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

export type TokenVerification = { ok: true; token: VerifiedToken } | { ok: false; reason: TokenRejectReason };

export interface IssueTokenRequest {
  kind: OAuthTokenKind;
  clientId: string;
  /** Audience (RFC 8707): the resource identifier the token is bound to. */
  resource: string;
  scopes: readonly string[];
  /** Lifetime in milliseconds; a positive integer. */
  ttlMs: number;
  /** The authorization grant (`sbg_...`) the token belongs to; a rotation passes the old refresh token's. */
  grantId?: string;
}

/** Token metadata for the operator views: never the value or its hash. `id` is the row id. */
export interface TokenMetadata {
  readonly id: number;
  readonly kind: OAuthTokenKind;
  readonly clientId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly revokedAt?: string;
}

export interface TokenCounts {
  readonly active: number;
  readonly expired: number;
  readonly revoked: number;
  /** The newest `issued_at` of the client's tokens; undefined when it has none. */
  readonly lastIssuedAt?: string;
}

/** The outcome of {@link OAuthTokenStore.revokeForClient}; `matched` false for an unknown or another client's token. */
export interface ClientRevocation {
  readonly matched: boolean;
  readonly kind?: OAuthTokenKind;
  /** Rows revoked by this call (0 when the token was already revoked). */
  readonly revoked: number;
}

const GRANT_PATTERN = /^sbg_[A-Za-z0-9_-]{22}$/;

export interface IssuedToken {
  /** The raw token. Hand it to the client once; never log or store it. */
  readonly token: string;
  readonly expiresAt: string;
}

interface TokenRow {
  token_hash: string;
  kind: OAuthTokenKind;
  client_id: string;
  resource: string;
  scopes_json: string;
  expires_at: string;
  revoked: number;
  grant_id: string | null;
}

function sha256(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** True when the value has the shape of a Switchboard token. Used by tests and redaction to find leaked tokens. */
export function looksLikeOAuthToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export interface OAuthTokenStoreDeps {
  now?: () => Date;
  /** Injected by tests; defaults to the CSPRNG. */
  randomBytes?: (n: number) => Buffer;
}

export class OAuthTokenStore {
  private readonly now: () => Date;
  private readonly random: (n: number) => Buffer;

  constructor(
    private readonly db: Database.Database,
    deps: OAuthTokenStoreDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.randomBytes ?? randomBytes;
  }

  /** Mint a token and store its hash. The raw value is returned once and is not kept. */
  issue(req: IssueTokenRequest): IssuedToken {
    if (!Number.isSafeInteger(req.ttlMs) || req.ttlMs <= 0) throw new Error("token ttlMs must be a positive integer");
    if (req.clientId.length === 0 || req.resource.length === 0) throw new Error("token needs a client and a resource");
    if (req.grantId !== undefined && !GRANT_PATTERN.test(req.grantId)) throw new Error("malformed grant id");
    const bytes = this.random(TOKEN_BYTES);
    if (bytes.length !== TOKEN_BYTES) throw new Error("token entropy source returned the wrong length");
    const token = `${PREFIX[req.kind]}${bytes.toString("base64url")}`;
    const issued = this.now();
    const expiresAt = new Date(issued.getTime() + req.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO oauth_token (token_hash, kind, client_id, resource, scopes_json, issued_at, expires_at, grant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(token).toString("hex"),
        req.kind,
        req.clientId,
        req.resource,
        JSON.stringify([...req.scopes]),
        issued.toISOString(),
        expiresAt,
        req.grantId ?? null,
      );
    return { token, expiresAt };
  }

  /** A fresh grant id for a new authorization (`sbg_` and 128 random bits). */
  newGrantId(): string {
    const bytes = this.random(16);
    if (bytes.length !== 16) throw new Error("grant entropy source returned the wrong length");
    return `sbg_${bytes.toString("base64url")}`;
  }

  /**
   * RFC 7009 revocation by a client: only a token of `clientId` is revoked. A refresh token takes every token of its
   * grant with it; an access token is revoked alone. An unknown, malformed or another client's token changes nothing
   * (`matched` false), so the caller can answer 200 either way (RFC 7009 §2.2).
   */
  revokeForClient(token: string, clientId: string): ClientRevocation {
    if (!looksLikeOAuthToken(token)) return { matched: false, revoked: 0 };
    const presented = sha256(token);
    return this.db.transaction((): ClientRevocation => {
      const row = this.db
        .prepare("SELECT token_hash, kind, client_id, grant_id FROM oauth_token WHERE token_hash = ?")
        .get(presented.toString("hex")) as Pick<TokenRow, "token_hash" | "kind" | "client_id" | "grant_id"> | undefined;
      if (row === undefined) return { matched: false, revoked: 0 };
      const stored = Buffer.from(row.token_hash, "hex");
      if (stored.length !== presented.length || !timingSafeEqual(stored, presented) || row.client_id !== clientId) {
        return { matched: false, revoked: 0 };
      }
      const at = this.now().toISOString();
      const revoked =
        row.kind === "refresh" && row.grant_id !== null
          ? this.db
              .prepare(
                "UPDATE oauth_token SET revoked = 1, revoked_at = ? WHERE grant_id = ? AND client_id = ? AND revoked = 0",
              )
              .run(at, row.grant_id, clientId).changes
          : this.db
              .prepare("UPDATE oauth_token SET revoked = 1, revoked_at = ? WHERE token_hash = ? AND revoked = 0")
              .run(at, row.token_hash).changes;
      return { matched: true, kind: row.kind, revoked };
    })();
  }

  /**
   * Token metadata, newest first, at most `limit` rows. Active tokens only (not revoked, not expired) unless `all`.
   * Never selects the hash.
   */
  list(opts: { clientId?: string; all?: boolean; limit?: number } = {}): TokenMetadata[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.clientId !== undefined) {
      where.push("client_id = ?");
      args.push(opts.clientId);
    }
    if (opts.all !== true) {
      where.push("revoked = 0 AND expires_at > ?");
      args.push(this.now().toISOString());
    }
    const sql =
      "SELECT rowid AS id, kind, client_id, issued_at, expires_at, revoked, revoked_at FROM oauth_token" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY issued_at DESC, rowid DESC LIMIT ?";
    args.push(opts.limit ?? 500);
    const rows = this.db.prepare(sql).all(...args) as {
      id: number;
      kind: OAuthTokenKind;
      client_id: string;
      issued_at: string;
      expires_at: string;
      revoked: number;
      revoked_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      clientId: r.client_id,
      issuedAt: r.issued_at,
      expiresAt: r.expires_at,
      revoked: r.revoked !== 0,
      ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}),
    }));
  }

  /** Active, expired and revoked token counts of one client, and its newest issue time. */
  counts(clientId: string): TokenCounts {
    const now = this.now().toISOString();
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(revoked = 0 AND expires_at > ?), 0) AS active,
                COALESCE(SUM(revoked = 0 AND expires_at <= ?), 0) AS expired,
                COALESCE(SUM(revoked <> 0), 0) AS revoked,
                MAX(issued_at) AS last
           FROM oauth_token WHERE client_id = ?`,
      )
      .get(now, now, clientId) as {
      active: number;
      expired: number;
      revoked: number;
      last: string | null;
    };
    return {
      active: r.active,
      expired: r.expired,
      revoked: r.revoked,
      ...(r.last !== null ? { lastIssuedAt: r.last } : {}),
    };
  }

  /** Revoke one token by value (the token endpoint's rotation and revocation paths). Returns whether a row changed. */
  revokeToken(token: string): boolean {
    if (!looksLikeOAuthToken(token)) return false;
    const r = this.db
      .prepare("UPDATE oauth_token SET revoked = 1, revoked_at = ? WHERE token_hash = ? AND revoked = 0")
      .run(this.now().toISOString(), sha256(token).toString("hex"));
    return r.changes > 0;
  }

  /** Revoke every token of a client (operator revocation, ADR-0041 item 4). Returns the number of tokens revoked. */
  revokeClient(clientId: string): number {
    return this.db
      .prepare("UPDATE oauth_token SET revoked = 1, revoked_at = ? WHERE client_id = ? AND revoked = 0")
      .run(this.now().toISOString(), clientId).changes;
  }

  /**
   * Redeem a refresh token for rotation (T13.8, Q-76): verify it and revoke it in one transaction, so it works once.
   * A refresh token that was already revoked is treated as stolen (OAuth 2.1 §4.3.1): every token of its client is
   * revoked and `reusedBy` names the client for the audit log.
   */
  useRefreshToken(token: string, resource: string): TokenVerification & { reusedBy?: string } {
    return this.db.transaction((): TokenVerification & { reusedBy?: string } => {
      const v = this.verify(token, "refresh", resource);
      if (!v.ok) {
        if (v.reason !== "revoked") return v;
        const row = this.db
          .prepare("SELECT client_id FROM oauth_token WHERE token_hash = ?")
          .get(sha256(token).toString("hex")) as { client_id: string } | undefined;
        if (row) this.revokeClient(row.client_id);
        return row ? { ...v, reusedBy: row.client_id } : v;
      }
      if (!this.revokeToken(token)) return { ok: false, reason: "revoked" };
      return v;
    })();
  }

  /**
   * Verify a token of the given kind for the given audience. Fails closed: any doubt (bad shape, no row, a hash that
   * does not compare equal, wrong kind, unparseable or past expiry, revoked, another audience) is a refusal.
   */
  verify(token: string, kind: OAuthTokenKind, resource: string): TokenVerification {
    if (!looksLikeOAuthToken(token)) return { ok: false, reason: "malformed" };
    const presented = sha256(token);
    const row = this.db
      .prepare(
        "SELECT token_hash, kind, client_id, resource, scopes_json, expires_at, revoked, grant_id FROM oauth_token WHERE token_hash = ?",
      )
      .get(presented.toString("hex")) as TokenRow | undefined;
    if (row === undefined) return { ok: false, reason: "unknown" };
    const stored = Buffer.from(row.token_hash, "hex");
    if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
      return { ok: false, reason: "unknown" };
    }
    if (row.kind !== kind || !token.startsWith(PREFIX[kind])) return { ok: false, reason: "wrong_kind" };
    if (row.revoked !== 0) return { ok: false, reason: "revoked" };
    const expires = Date.parse(row.expires_at);
    if (!Number.isFinite(expires) || this.now().getTime() >= expires) return { ok: false, reason: "expired" };
    if (row.resource !== resource) return { ok: false, reason: "wrong_audience" };
    let scopes: unknown;
    try {
      scopes = JSON.parse(row.scopes_json);
    } catch {
      return { ok: false, reason: "unknown" };
    }
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) return { ok: false, reason: "unknown" };
    return {
      ok: true,
      token: {
        clientId: row.client_id,
        ...(row.grant_id !== null ? { grantId: row.grant_id } : {}),
        resource: row.resource,
        scopes,
        expiresAt: row.expires_at,
      },
    };
  }
}

/**
 * Extract the bearer token from an `Authorization` header value (RFC 6750 §2.1; the scheme is case-insensitive, RFC
 * 9110 §11.1). Returns undefined when there is no header (the caller sends the bare challenge) and `null` when a header
 * is present but is not a single well-formed bearer credential (the caller refuses it as an invalid token).
 */
export function bearerToken(header: string | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer +([^\s]+) *$/i.exec(header);
  return m?.[1] ?? null;
}
