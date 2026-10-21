/**
 * Durable audit of the embedded authorization server's grants and revocations (`oauth_event`, migration 0036).
 *
 * `serve` records the consent approvals, token issues and refreshes and `/revoke` revocations its authorization server
 * reports; the operator CLI records the one-time codes it issues and the revocations it makes. A row holds the event
 * kind, client id, `mcp_clients` profile, method, actor, client address and a reason code: never a token, code,
 * passphrase or hash. The table is append-only (triggers in the migration).
 */
import type Database from "better-sqlite3";

export type OAuthAuditKind =
  | "code_issued"
  | "consent_approved"
  | "token_issued"
  | "token_refreshed"
  | "token_revoked"
  | "client_revoked"
  | "tokens_revoked";

export interface OAuthAuditFields {
  readonly clientId?: string | undefined;
  readonly mcpClient?: string | undefined;
  readonly method?: string | undefined;
  /** Who acted: `endpoint` for the HTTP endpoints, `cli:<user>` for the operator CLI. */
  readonly actor: string;
  readonly ip?: string | undefined;
  readonly reason?: string | undefined;
}

export interface OAuthAuditRow {
  readonly id: number;
  readonly at: string;
  readonly kind: OAuthAuditKind;
  readonly client_id: string | null;
  readonly mcp_client: string | null;
  readonly method: string | null;
  readonly actor: string;
  readonly ip: string | null;
  readonly reason: string | null;
}

export class OAuthAuditLog {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database.Database,
    deps: { now?: () => Date } = {},
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  record(kind: OAuthAuditKind, f: OAuthAuditFields): void {
    this.db
      .prepare(
        "INSERT INTO oauth_event (at, kind, client_id, mcp_client, method, actor, ip, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.now().toISOString(),
        kind,
        f.clientId ?? null,
        f.mcpClient ?? null,
        f.method ?? null,
        f.actor,
        f.ip ?? null,
        f.reason ?? null,
      );
  }

  /** Events, oldest first; optionally of one client. */
  list(clientId?: string): OAuthAuditRow[] {
    return (
      clientId === undefined
        ? this.db.prepare("SELECT * FROM oauth_event ORDER BY id").all()
        : this.db.prepare("SELECT * FROM oauth_event WHERE client_id = ? ORDER BY id").all(clientId)
    ) as OAuthAuditRow[];
  }
}
