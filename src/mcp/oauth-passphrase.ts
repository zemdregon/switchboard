/**
 * Operator passphrase hash for the consent page (T13.8; ADR-0041 item 3, LLD §3.3, Q-75).
 *
 * Delegated (Q-75, orchestrator 2026-10-14): no new dependency. ADR-0041 names argon2id, but Node's built-in
 * `crypto.argon2` is not in Node 22, the bottom of the `engines` range and the version CI runs, so the hash is the
 * built-in scrypt with N = 2^17, r = 8, p = 1, a 16-byte random salt and a 32-byte key, compared with
 * `timingSafeEqual`. The encoded form is `scrypt$17$8$1$<salt base64url>$<key base64url>`; a hash with any other
 * parameters is refused at config load, so a weaker hash cannot be configured.
 *
 * The passphrase itself is never stored, logged or echoed; only this encoded hash lives in the config file.
 */
import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

const LOG_N = 17;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** scrypt needs 128 * N * r bytes (128 MiB here); Node's default `maxmem` is 32 MiB. */
const MAXMEM = 256 * 1024 * 1024;
/** Bounds on the passphrase itself; longer input is refused before any hashing. */
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;

const ENCODED = /^scrypt\$17\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  const opts: ScryptOptions = { N: 2 ** LOG_N, r: R, p: P, maxmem: MAXMEM };
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize("NFC"), salt, KEY_BYTES, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** True when the string is a well-formed hash with exactly the required parameters. */
export function isPassphraseHash(encoded: string): boolean {
  return ENCODED.test(encoded);
}

/** Hash a passphrase for `transport.http.passphrase_hash` (`switchboard consent hash-passphrase`). */
export async function hashPassphrase(passphrase: string): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH || passphrase.length > MAX_PASSPHRASE_LENGTH) {
    throw new Error(`the passphrase must be ${MIN_PASSPHRASE_LENGTH} to ${MAX_PASSPHRASE_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(passphrase, salt);
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Check a presented passphrase against an encoded hash. Fails closed: a malformed hash or input never matches. */
export async function verifyPassphrase(passphrase: string, encoded: string): Promise<boolean> {
  const m = ENCODED.exec(encoded);
  if (!m || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE_LENGTH) return false;
  const salt = Buffer.from(m[1] as string, "base64url");
  const expected = Buffer.from(m[2] as string, "base64url");
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
  const key = await derive(passphrase, salt);
  return timingSafeEqual(key, expected);
}
