/**
 * `switchboard mcp oauth ...`: the operator side of the embedded OAuth 2.1 authorization server of the HTTP MCP
 * transport (ADR-0041, LLD §3.3). Like `consent`, these commands manage only Switchboard's own authorization server,
 * never a provider sign-in, so they are not a login command (FR-OPS-03); they touch no provider credential.
 *
 * - `issue-code --client-profile <id> [--ttl <n>s|m|h]` creates a one-time code bound to an `mcp_clients` entry, valid
 *   1 to 60 minutes (default 10). The entry must exist and pass the ledger-binding rule (`httpProfileProblem`
 *   `bound`: no `privileged` ceiling, no `privileged_approval: not_required`), so a code can never give an HTTP client
 *   privileged runs. Like `consent pair` it ends every older unused code. The code is printed to this terminal only
 *   (it is the point of the command); the ledger keeps its hash and the audit records the issue without it.
 * - `clients`, `client <client_id>`: registered clients with status, the profile each acts as and its source (config
 *   map, ledger binding or default), token counts and the newest issue time.
 * - `tokens [--client <client_id>] [--all]`: token metadata (row id, kind, client, issued, expires, revoked); active
 *   tokens only unless `--all`. Never a token value or hash.
 * - `revoke <client_id> [--tokens-only]`: mark the client `revoked` and revoke all its tokens, or with `--tokens-only`
 *   revoke the tokens and keep the client approved. Audited.
 *
 * Each command opens the ledger beside a running `serve` (one short WAL transaction), as `consent pair` does.
 */
import os from "node:os";
import type Database from "better-sqlite3";
import { httpProfileProblem, loadConfig, type ResolvedConfig } from "../config/index.js";
import { openLedger } from "../ledger/index.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import {
  OAuthAdmin,
  type OAuthAdminSettings,
  type OAuthClientView,
  type OAuthRevokeResult,
  type OAuthTokenView,
} from "../mcp/oauth-admin.js";
import { OAuthAuditLog } from "../mcp/oauth-audit.js";
import { MAX_PAIRING_CODE_TTL_MS, MIN_PAIRING_CODE_TTL_MS, PairingCodeStore } from "../mcp/oauth-pairing.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";

/** `<n>s`, `<n>m` or `<n>h`, between 1 and 60 minutes. */
export function parseCodeTtl(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^([1-9][0-9]{0,4})([smh])$/.exec(text);
  if (m === null) throw new UsageError("--ttl must be <n>s, <n>m or <n>h (for example 10m)");
  const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
  if (ms < MIN_PAIRING_CODE_TTL_MS || ms > MAX_PAIRING_CODE_TTL_MS) {
    throw new UsageError("--ttl must be between 1 and 60 minutes");
  }
  return ms;
}

function osUser(io: CliIo): string {
  if (io.user !== undefined) return io.user;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

/** Load the config and run `fn` on the ledger, beside a running daemon if one holds the data directory. */
function withLedger<T>(
  io: CliIo,
  argv: readonly string[],
  fn: (db: Database.Database, config: ResolvedConfig) => T,
): T {
  const config = loadConfig({
    argv,
    env: io.env,
    ...(io.homedir !== undefined ? { homedir: io.homedir } : {}),
  });
  let lock: ReturnType<typeof acquireDataDirLock> | undefined;
  try {
    lock = acquireDataDirLock(config.dataDir);
  } catch (err) {
    // A running daemon holds the lock; each command is one short WAL transaction, safe beside it.
    if (!(err instanceof LockError) || inspectDataDirLock(config.dataDir).state !== "held") throw err;
  }
  const db = openLedger(config.dataDir, io.now ? { now: io.now } : {});
  try {
    return fn(db, config);
  } finally {
    db.close();
    lock?.release();
  }
}

function adminSettings(config: ResolvedConfig): OAuthAdminSettings | undefined {
  return config.httpTransport;
}

export interface IssueCodeReport {
  schema_version: number;
  /** The one-time code, for this terminal only. */
  code: string;
  mcp_client: string;
  expires_at: string;
  /** False when `transport.http` is not enabled in this config: the code is stored but nothing serves it yet. */
  http_transport_enabled: boolean;
}

export function mcpOAuthIssueCode(
  io: CliIo,
  argv: readonly string[],
  opts: { clientProfile: string | undefined; ttl: string | undefined },
): IssueCodeReport {
  const profile = opts.clientProfile;
  if (profile === undefined || profile === "") {
    throw new UsageError("mcp oauth issue-code requires --client-profile <id> naming an mcp_clients entry");
  }
  const ttlMs = parseCodeTtl(opts.ttl);
  return withLedger(io, argv, (db, config) => {
    const entry = config.mcpClients.get(profile);
    const problem = httpProfileProblem(
      entry === undefined
        ? undefined
        : { maxTrustProfile: entry.maxTrustProfile, privilegedApproval: entry.privilegedApproval },
      "bound",
    );
    if (problem === "unknown") throw new UsageError(`unknown mcp_clients id ${JSON.stringify(profile.slice(0, 128))}`);
    if (problem === "privileged_ceiling") {
      throw new UsageError(
        `${JSON.stringify(profile)} has a privileged ceiling; a one-time code cannot bind an HTTP client to it ` +
          "(map the OAuth client explicitly in transport.http.clients instead)",
      );
    }
    if (problem === "approval_not_required") {
      throw new UsageError(
        `${JSON.stringify(profile)} has privileged_approval not_required; an HTTP client's privileged runs must wait ` +
          "for the operator (FR-MCP-14)",
      );
    }
    const now = io.now ? { now: io.now } : {};
    const created = db.transaction(() => {
      const c = new PairingCodeStore(db, now).create({
        mcpClient: profile,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      });
      new OAuthAuditLog(db, now).record("code_issued", {
        mcpClient: profile,
        actor: `cli:${osUser(io)}`,
        reason: `expires_${c.expiresAt}`,
      });
      return c;
    })();
    return {
      schema_version: JSON_SCHEMA_VERSION,
      code: created.code,
      mcp_client: profile,
      expires_at: created.expiresAt,
      http_transport_enabled: config.httpTransport !== undefined,
    };
  });
}

export function renderIssueCode(r: IssueCodeReport): string {
  return (
    `One-time code: ${r.code}\n` +
    `Client profile: ${r.mcp_client}\n` +
    `Valid once, until ${r.expires_at}. Enter it on the consent page; issuing another code ends this one.\n` +
    (r.http_transport_enabled ? "" : "Note: transport.http is not enabled in this config, so nothing serves it yet.\n")
  );
}

export interface ClientsReport {
  schema_version: number;
  clients: OAuthClientView[];
}

export function mcpOAuthClients(io: CliIo, argv: readonly string[]): ClientsReport {
  return withLedger(io, argv, (db, config) => ({
    schema_version: JSON_SCHEMA_VERSION,
    clients: new OAuthAdmin(db, adminSettings(config), io.now ? { now: io.now } : {}).listClients(),
  }));
}

function profileText(c: OAuthClientView): string {
  if (c.mcp_client === null) return "(none: refused)";
  const source = c.mcp_client_source === "ledger_binding" ? "binding" : (c.mcp_client_source ?? "");
  return `${c.mcp_client} (${source}${c.mcp_client_eligible ? "" : ", not eligible: refused"})`;
}

export function renderClients(r: ClientsReport): string {
  if (r.clients.length === 0) return "No OAuth clients.\n";
  return r.clients
    .map(
      (c) =>
        `${c.client_id}  ${c.status}  ${profileText(c)}  ${c.client_name ?? "(unnamed)"}  ` +
        `tokens ${c.tokens.active} active/${c.tokens.expired} expired/${c.tokens.revoked} revoked\n`,
    )
    .join("");
}

export interface ClientReport {
  schema_version: number;
  client: OAuthClientView;
}

export function mcpOAuthClient(io: CliIo, argv: readonly string[], clientId: string): ClientReport {
  return withLedger(io, argv, (db, config) => ({
    schema_version: JSON_SCHEMA_VERSION,
    client: new OAuthAdmin(db, adminSettings(config), io.now ? { now: io.now } : {}).getClient(clientId),
  }));
}

export function renderClient(r: ClientReport): string {
  const c = r.client;
  return [
    `Client:        ${c.client_id}`,
    `Name:          ${c.client_name ?? "(unnamed)"}`,
    ...(c.cimd_url !== null ? [`Metadata URL:  ${c.cimd_url}`] : []),
    `Status:        ${c.status}${c.decided_at !== null ? ` (since ${c.decided_at})` : ""}`,
    `Registered:    ${c.created_at}`,
    `Redirect URIs: ${c.redirect_uris.join(", ")}`,
    `Grant types:   ${c.grant_types.join(", ")}`,
    `Profile:       ${profileText(c)}`,
    `Bound:         ${c.bound_mcp_client !== null ? `${c.bound_mcp_client} at ${c.bound_at}` : "(no ledger binding)"}`,
    `Tokens:        ${c.tokens.active} active, ${c.tokens.expired} expired, ${c.tokens.revoked} revoked`,
    `Last issued:   ${c.last_token_issued_at ?? "(never)"}`,
    "",
  ].join("\n");
}

export interface TokensReport {
  schema_version: number;
  tokens: OAuthTokenView[];
}

export function mcpOAuthTokens(
  io: CliIo,
  argv: readonly string[],
  opts: { clientId?: string; all: boolean },
): TokensReport {
  return withLedger(io, argv, (db, config) => ({
    schema_version: JSON_SCHEMA_VERSION,
    tokens: new OAuthAdmin(db, adminSettings(config), io.now ? { now: io.now } : {}).listTokens({
      ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
      all: opts.all,
    }),
  }));
}

export function renderTokens(r: TokensReport): string {
  if (r.tokens.length === 0) return "No tokens.\n";
  return r.tokens
    .map(
      (t) =>
        `${t.id}  ${t.kind}  ${t.client_id}  issued ${t.issued_at}  expires ${t.expires_at}` +
        `${t.revoked ? `  revoked ${t.revoked_at ?? ""}` : ""}\n`,
    )
    .join("");
}

export interface RevokeReport extends OAuthRevokeResult {
  schema_version: number;
}

export function mcpOAuthRevoke(
  io: CliIo,
  argv: readonly string[],
  clientId: string,
  opts: { tokensOnly: boolean },
): RevokeReport {
  return withLedger(io, argv, (db, config) => ({
    schema_version: JSON_SCHEMA_VERSION,
    ...new OAuthAdmin(db, adminSettings(config), io.now ? { now: io.now } : {}).revoke(clientId, {
      tokensOnly: opts.tokensOnly,
      actor: `cli:${osUser(io)}`,
    }),
  }));
}

export function renderRevoke(r: RevokeReport): string {
  return (
    `${r.client_id}: ${r.client_revoked ? `client revoked (was ${r.status_before})` : `client status ${r.status} unchanged`}, ` +
    `${r.tokens_revoked} token(s) revoked.\n`
  );
}
