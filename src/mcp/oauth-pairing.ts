/**
 * One-time pairing codes, the consent-page fallback to the operator passphrase (T13.8; ADR-0041 item 3, LLD §3.3,
 * Q-76).
 *
 * Delegated (Q-76, fail closed): `switchboard consent pair` creates a code of 12 characters from the Crockford base32
 * alphabet (60 bits from the CSPRNG), shown as `XXXX-XXXX-XXXX`. Only its SHA-256 hash is stored (`oauth_pairing_code`,
 * migration 0012). A code is valid for {@link PAIRING_CODE_TTL_MS} (10 minutes), is redeemed at most once, and creating
 * a new code ends every older unused one, so at most one code is live. Guessing is throttled by the consent page (at
 * most ten wrong codes a minute, so at most a hundred against one code's lifetime of a 2^60 space), separately from the
 * passphrase lockout, so a stranger who locks the passphrase cannot also block a fresh pairing code.
 *
 * Profile-bound codes (migration 0037): `switchboard mcp oauth issue-code --client-profile <id>` creates the same kind of
 * code with the `mcp_clients` id it was issued for and a lifetime of {@link MIN_PAIRING_CODE_TTL_MS} to
 * {@link MAX_PAIRING_CODE_TTL_MS}. It shares the single-live-code invariant with `consent pair` (either command ends
 * every older unused code). {@link PairingCodeStore.lookup} reads a live code without spending it (so the consent page
 * can refuse a profile conflict before the code is used); {@link PairingCodeStore.consume} spends it in one atomic
 * `UPDATE ... RETURNING` and yields the bound profile, or none for a legacy code. {@link PairingCodeStore.redeem} (the
 * approval-link page) spends only an unbound code: a code issued to bind a remote client never decides an approval.
 */
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const MIN_PAIRING_CODE_TTL_MS = 60 * 1000;
export const MAX_PAIRING_CODE_TTL_MS = 60 * 60 * 1000;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

/** Upper-case and drop separators and spaces; anything else outside the alphabet makes the input invalid. */
export function normalizePairingCode(input: string): string | undefined {
  if (input.length > 64) return undefined;
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== CODE_LENGTH) return undefined;
  for (const ch of s) if (!ALPHABET.includes(ch)) return undefined;
  return s;
}

function hash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export interface PairingCodeStoreDeps {
  now?: () => Date;
  randomBytes?: (n: number) => Buffer;
}

export interface CreatedPairingCode {
  /** The code for the operator's terminal. Never log or store it. */
  readonly code: string;
  readonly expiresAt: string;
  /** The `mcp_clients` id the code binds a client to; absent for a legacy unbound code. */
  readonly mcpClient?: string;
}

export interface CreatePairingCodeOptions {
  /** Bind the client this code approves to this `mcp_clients` id (the caller checks it is eligible). */
  readonly mcpClient?: string;
  /** Lifetime; default {@link PAIRING_CODE_TTL_MS}, allowed {@link MIN_PAIRING_CODE_TTL_MS} to {@link MAX_PAIRING_CODE_TTL_MS}. */
  readonly ttlMs?: number;
}

/** A live code: the profile it binds, or `mcpClient` undefined for a legacy unbound code. */
export interface PairingCodeGrant {
  readonly mcpClient: string | undefined;
}

export class PairingCodeStore {
  private readonly now: () => Date;
  private readonly random: (n: number) => Buffer;

  constructor(
    private readonly db: Database.Database,
    deps: PairingCodeStoreDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.randomBytes ?? randomBytes;
  }

  /** Create a code, ending every older unused one. The raw value is returned once and is not kept. */
  create(opts: CreatePairingCodeOptions = {}): CreatedPairingCode {
    const ttlMs = opts.ttlMs ?? PAIRING_CODE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_PAIRING_CODE_TTL_MS || ttlMs > MAX_PAIRING_CODE_TTL_MS) {
      throw new RangeError("a one-time code lives between 1 and 60 minutes");
    }
    const mcpClient = opts.mcpClient;
    if (mcpClient !== undefined && (mcpClient.length === 0 || mcpClient.length > 128)) {
      throw new RangeError("the client profile id must be 1 to 128 characters");
    }
    const bytes = this.random(CODE_LENGTH);
    if (bytes.length !== CODE_LENGTH) throw new Error("pairing-code entropy source returned the wrong length");
    // 32 symbols: the low 5 bits of each byte are uniform.
    const raw = [...bytes].map((b) => ALPHABET[b & 31]).join("");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE oauth_pairing_code SET used_at = ? WHERE used_at IS NULL").run(now.toISOString());
      this.db
        .prepare("INSERT INTO oauth_pairing_code (code_hash, created_at, expires_at, mcp_client) VALUES (?, ?, ?, ?)")
        .run(hash(raw), now.toISOString(), expiresAt, mcpClient ?? null);
    })();
    return {
      code: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`,
      expiresAt,
      ...(mcpClient !== undefined ? { mcpClient } : {}),
    };
  }

  /** A live (unused, unexpired) code without spending it; undefined for anything else. */
  lookup(input: string): PairingCodeGrant | undefined {
    const normalized = normalizePairingCode(input);
    if (normalized === undefined) return undefined;
    const row = this.db
      .prepare("SELECT mcp_client FROM oauth_pairing_code WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(hash(normalized), this.now().toISOString()) as { mcp_client: string | null } | undefined;
    return row === undefined ? undefined : { mcpClient: row.mcp_client ?? undefined };
  }

  /**
   * Spend a code: its grant only for an unused, unexpired code, which is marked used in the same statement, so two
   * concurrent redemptions cannot both succeed.
   */
  consume(input: string): PairingCodeGrant | undefined {
    const normalized = normalizePairingCode(input);
    if (normalized === undefined) return undefined;
    const now = this.now().toISOString();
    const row = this.db
      .prepare(
        `UPDATE oauth_pairing_code SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
         RETURNING mcp_client`,
      )
      .get(now, hash(normalized), now) as { mcp_client: string | null } | undefined;
    return row === undefined ? undefined : { mcpClient: row.mcp_client ?? undefined };
  }

  /**
   * Redeem a legacy (unbound) code, for the approval-link page: true only for an unused, unexpired code with no bound
   * profile, marked used in the same statement. A profile-bound code is refused and left live.
   */
  redeem(input: string): boolean {
    const normalized = normalizePairingCode(input);
    if (normalized === undefined) return false;
    const now = this.now().toISOString();
    const r = this.db
      .prepare(
        `UPDATE oauth_pairing_code SET used_at = ?
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND mcp_client IS NULL`,
      )
      .run(now, hash(normalized), now);
    return r.changes === 1;
  }
}
