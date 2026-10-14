/**
 * Session binding for the network MCP transport (T13.5; FR-MCP-15, LLD §3.3, Q-78).
 *
 * The HTTP mount is stateless (Q-77): no MCP session id is issued, and a request that carries one is refused. What a
 * caller can come back to is a Switchboard meta-session and its runs, so those are what is bound: each meta-session
 * opened over HTTP records the OAuth client (the token subject) that opened it, in the same request that created it.
 * The MCP server then treats a meta-session, and every run in it, as unknown unless the caller's subject matches:
 *
 * - over HTTP, the binding must name the caller's OAuth client;
 * - over stdio (no subject), the meta-session must have no binding.
 *
 * Together with the configured MCP client check that already applies (`run.client_id`), a request from another subject
 * or another client cannot read, continue or cancel the work, and gets exactly the "unknown" answer an id that does not
 * exist gets. The table holds identifiers only.
 */
import type Database from "better-sqlite3";

export interface SubjectBindings {
  /** Record that `oauthClientId` opened `metaSessionId`. A second, different binding for the same id throws. */
  bind(metaSessionId: string, oauthClientId: string): void;
  /** The OAuth client that opened the meta-session over HTTP, or undefined for one opened over stdio. */
  subjectOf(metaSessionId: string): string | undefined;
}

export class SubjectBindingStore implements SubjectBindings {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database.Database,
    deps: { now?: () => Date } = {},
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  bind(metaSessionId: string, oauthClientId: string): void {
    this.db
      .prepare(
        "INSERT INTO http_subject (meta_session_id, oauth_client_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(metaSessionId, oauthClientId, this.now().toISOString());
    // Fail closed: never let a meta-session change hands.
    if (this.subjectOf(metaSessionId) !== oauthClientId) {
      throw new Error(`meta-session ${metaSessionId} is bound to another subject`);
    }
  }

  subjectOf(metaSessionId: string): string | undefined {
    const row = this.db
      .prepare("SELECT oauth_client_id FROM http_subject WHERE meta_session_id = ?")
      .get(metaSessionId) as { oauth_client_id: string } | undefined;
    return row?.oauth_client_id;
  }
}
