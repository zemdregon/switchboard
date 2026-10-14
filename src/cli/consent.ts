/**
 * `switchboard consent` (T13.8; ADR-0041 item 3, LLD §3.3, Q-75, Q-76): operator commands for the embedded
 * authorization server's consent page. They touch no provider credential. Delegated (Q-76): ADR-0041 calls the pairing
 * command `switchboard auth pair`; it is `consent pair` because FR-OPS-03 keeps the CLI free of any `auth` or `login`
 * command, which could read as a provider sign-in.
 *
 * - `consent hash-passphrase` reads the passphrase from stdin (never from an argument, which would reach the shell history
 *   and the process list) and prints the scrypt hash for `transport.http.passphrase_hash`.
 * - `consent pair` creates a one-time pairing code, valid for 10 minutes, and prints it to the operator's terminal only.
 *   The ledger keeps its hash; a new code ends every older unused one.
 */
import { loadConfig } from "../config/index.js";
import { openLedger } from "../ledger/index.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import { PairingCodeStore } from "../mcp/oauth-pairing.js";
import { hashPassphrase } from "../mcp/oauth-passphrase.js";
import { type CliIo, JSON_SCHEMA_VERSION } from "./io.js";

async function readAll(io: CliIo): Promise<string> {
  if (io.readStdin) return io.readStdin();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export interface PassphraseHashReport {
  schema_version: number;
  passphrase_hash: string;
}

export async function consentHashPassphrase(io: CliIo): Promise<PassphraseHashReport> {
  const input = (await readAll(io)).replace(/\r?\n$/, "");
  return { schema_version: JSON_SCHEMA_VERSION, passphrase_hash: await hashPassphrase(input) };
}

export function renderPassphraseHash(r: PassphraseHashReport): string {
  return `${r.passphrase_hash}\nSet it as transport.http.passphrase_hash in the config file.\n`;
}

export interface PairReport {
  schema_version: number;
  pairing_code: string;
  expires_at: string;
}

export function consentPair(io: CliIo, argv: readonly string[]): PairReport {
  const dataDir = loadConfig({
    argv,
    env: io.env,
    ...(io.homedir !== undefined ? { homedir: io.homedir } : {}),
  }).dataDir;
  let lock: ReturnType<typeof acquireDataDirLock> | undefined;
  try {
    lock = acquireDataDirLock(dataDir);
  } catch (err) {
    // A running daemon holds the lock; the insert is a single WAL transaction, safe beside it.
    if (!(err instanceof LockError) || inspectDataDirLock(dataDir).state !== "held") throw err;
  }
  const db = openLedger(dataDir, io.now ? { now: io.now } : {});
  try {
    const created = new PairingCodeStore(db, io.now ? { now: io.now } : {}).create();
    return { schema_version: JSON_SCHEMA_VERSION, pairing_code: created.code, expires_at: created.expiresAt };
  } finally {
    db.close();
    lock?.release();
  }
}

export function renderPair(r: PairReport): string {
  return (
    `Pairing code: ${r.pairing_code}\n` +
    `Valid once, until ${r.expires_at}. Enter it on the consent page; creating another code ends this one.\n`
  );
}
