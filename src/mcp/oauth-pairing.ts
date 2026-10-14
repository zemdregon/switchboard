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
 */
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
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
  create(): CreatedPairingCode {
    const bytes = this.random(CODE_LENGTH);
    if (bytes.length !== CODE_LENGTH) throw new Error("pairing-code entropy source returned the wrong length");
    // 32 symbols: the low 5 bits of each byte are uniform.
    const raw = [...bytes].map((b) => ALPHABET[b & 31]).join("");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE oauth_pairing_code SET used_at = ? WHERE used_at IS NULL").run(now.toISOString());
      this.db
        .prepare("INSERT INTO oauth_pairing_code (code_hash, created_at, expires_at) VALUES (?, ?, ?)")
        .run(hash(raw), now.toISOString(), expiresAt);
    })();
    return { code: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`, expiresAt };
  }

  /**
   * Redeem a code: true only for an unused, unexpired code, which is marked used in the same statement, so two
   * concurrent redemptions cannot both succeed.
   */
  redeem(input: string): boolean {
    const normalized = normalizePairingCode(input);
    if (normalized === undefined) return false;
    const now = this.now().toISOString();
    const r = this.db
      .prepare("UPDATE oauth_pairing_code SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, hash(normalized), now);
    return r.changes === 1;
  }
}
