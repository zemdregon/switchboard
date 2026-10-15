/**
 * Scratch directory for the Kimi Code auth probe (T4.64, ADR-0049 item 4: `session/new` "in a scratch directory").
 * A fresh private directory (`mkdtemp`, mode 0700) rather than the shared temporary directory, so no project
 * configuration another user planted there (`.kimi-code/mcp.json`, [K5]) can start with the probe session. It is
 * removed afterwards. Nothing is read: this module only creates and removes the directory (inspection test in
 * `kimi.test.ts`); the probe session itself persists in Kimi's own data directory ([LIVE] 12).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "switchboard-kimi-auth-";

/** Runs `fn` with a new empty directory and removes the directory whatever `fn` does. */
export async function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), PREFIX));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
