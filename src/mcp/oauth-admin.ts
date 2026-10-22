/**
 * Operator views and revocation for the embedded authorization server's clients and tokens, shared by `switchboard mcp
 * oauth clients|client|tokens|revoke` and the stdio-only MCP tool `list_oauth_clients`.
 *
 * Every view is metadata only: a client's registration, status, the profile it acts as and where that comes from, and
 * token counts; a token's row id, kind, client, times and revocation. Never a token value, a token hash, a code or a
 * code hash. Revocation marks the client `revoked` and revokes all its tokens, or with `tokensOnly` revokes the tokens
 * and leaves the client approved; both are written to the durable audit (`oauth_event`).
 */
import type Database from "better-sqlite3";
import { type HttpTransportSettings, type McpClientSource, resolveMcpClientFor } from "../config/http-transport.js";
import { OAuthAuditLog } from "./oauth-audit.js";
import { type ClientStatus, OAuthClientStore, type RegisteredClient } from "./oauth-clients.js";
import { OAuthTokenStore, type TokenMetadata } from "./oauth-tokens.js";

/** The settings the views read; undefined (transport off) resolves no profile. */
export type OAuthAdminSettings = Pick<HttpTransportSettings, "clientMap" | "defaultMcpClient" | "bindableMcpClients">;

export interface OAuthClientView {
  client_id: string;
  client_name: string | null;
  /** The Client Identifier URL of a Client ID Metadata Document client; null for a registered one. */
  cimd_url: string | null;
  status: ClientStatus;
  created_at: string;
  decided_at: string | null;
  redirect_uris: string[];
  grant_types: string[];
  /** The `mcp_clients` profile the client acts as at the MCP endpoint; null when it has none. */
  mcp_client: string | null;
  mcp_client_source: McpClientSource | null;
  /** False when a ledger binding names an entry no longer eligible (the endpoint refuses), or the transport is off. */
  mcp_client_eligible: boolean;
  /** The ledger binding a profile-bound code made, and when; null when there is none. */
  bound_mcp_client: string | null;
  bound_at: string | null;
  tokens: { active: number; expired: number; revoked: number };
  last_token_issued_at: string | null;
}

export interface OAuthTokenView {
  id: number;
  kind: "access" | "refresh";
  client_id: string;
  issued_at: string;
  expires_at: string;
  revoked: boolean;
  revoked_at: string | null;
}

export interface OAuthRevokeResult {
  client_id: string;
  status_before: ClientStatus;
  status: ClientStatus;
  client_revoked: boolean;
  tokens_revoked: number;
}

export class UnknownOAuthClientError extends Error {
  constructor(clientId: string) {
    super(`unknown OAuth client ${JSON.stringify(clientId.slice(0, 128))}`);
    this.name = "UnknownOAuthClientError";
  }
}

export function tokenView(t: TokenMetadata): OAuthTokenView {
  return {
    id: t.id,
    kind: t.kind,
    client_id: t.clientId,
    issued_at: t.issuedAt,
    expires_at: t.expiresAt,
    revoked: t.revoked,
    revoked_at: t.revokedAt ?? null,
  };
}

export class OAuthAdmin {
  private readonly clients: OAuthClientStore;
  private readonly tokens: OAuthTokenStore;
  private readonly audit: OAuthAuditLog;

  constructor(
    private readonly db: Database.Database,
    private readonly settings: OAuthAdminSettings | undefined,
    deps: { now?: () => Date } = {},
  ) {
    const opts = deps.now ? { now: deps.now } : {};
    this.clients = new OAuthClientStore(db, opts);
    this.tokens = new OAuthTokenStore(db, opts);
    this.audit = new OAuthAuditLog(db, opts);
  }

  private view(c: RegisteredClient): OAuthClientView {
    const resolved =
      this.settings === undefined ? undefined : resolveMcpClientFor(this.settings, c.clientId, c.mcpClient);
    const counts = this.tokens.counts(c.clientId);
    return {
      client_id: c.clientId,
      client_name: c.clientName ?? null,
      cimd_url: c.cimdUrl ?? null,
      status: c.status,
      created_at: c.createdAt,
      decided_at: c.decidedAt ?? null,
      redirect_uris: [...c.redirectUris],
      grant_types: [...c.grantTypes],
      mcp_client: resolved?.mcpClient ?? null,
      mcp_client_source: resolved?.source ?? null,
      mcp_client_eligible: resolved?.eligible === true,
      bound_mcp_client: c.mcpClient ?? null,
      bound_at: c.boundAt ?? null,
      tokens: { active: counts.active, expired: counts.expired, revoked: counts.revoked },
      last_token_issued_at: counts.lastIssuedAt ?? null,
    };
  }

  listClients(): OAuthClientView[] {
    return this.clients.list().map((c) => this.view(c));
  }

  getClient(clientId: string): OAuthClientView {
    const c = this.clients.get(clientId);
    if (c === undefined) throw new UnknownOAuthClientError(clientId);
    return this.view(c);
  }

  /** Token metadata, newest first; active tokens only unless `all`. An unknown `clientId` is refused. */
  listTokens(opts: { clientId?: string; all?: boolean } = {}): OAuthTokenView[] {
    if (opts.clientId !== undefined && this.clients.get(opts.clientId) === undefined) {
      throw new UnknownOAuthClientError(opts.clientId);
    }
    return this.tokens
      .list({
        ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
        ...(opts.all === true ? { all: true } : {}),
      })
      .map(tokenView);
  }

  /**
   * Revoke a client and all its tokens, or with `tokensOnly` its tokens only (the client keeps its status), in one
   * transaction with its audit row. `actor` names the operator (`cli:<user>`).
   */
  revoke(clientId: string, opts: { tokensOnly?: boolean; actor: string }): OAuthRevokeResult {
    return this.db.transaction((): OAuthRevokeResult => {
      const before = this.clients.get(clientId);
      if (before === undefined) throw new UnknownOAuthClientError(clientId);
      const clientRevoked = opts.tokensOnly === true ? false : this.clients.revoke(clientId);
      const tokensRevoked = this.tokens.revokeClient(clientId);
      const after = this.clients.get(clientId);
      this.audit.record(opts.tokensOnly === true ? "tokens_revoked" : "client_revoked", {
        clientId,
        mcpClient: before.mcpClient,
        actor: opts.actor,
        reason: `tokens_${tokensRevoked}`,
      });
      return {
        client_id: clientId,
        status_before: before.status,
        status: after?.status ?? before.status,
        client_revoked: clientRevoked,
        tokens_revoked: tokensRevoked,
      };
    })();
  }
}
