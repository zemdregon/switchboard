import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export class LockError extends Error {
  override readonly name = "LockError";
}

export interface DataDirLock {
  readonly lockPath: string;
  release(): void;
}

export const LOCK_FILE_NAME = "serve.lock";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(lockPath: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(lockPath, "utf8").trim().split("\n")[0] ?? "", 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the exclusive `serve` lock for a data directory (ADR-0005, TDD §3.5). The lock is a file created with O_EXCL
 * containing the owner PID. A lock whose PID is dead (or unreadable/corrupt) is stale and is replaced once; a live
 * owner makes acquisition fail. Fails closed (NFR-SEC-06). Proposed: PID liveness only; PID reuse by an unrelated
 * process is treated as a live owner, so the operator must remove the file manually.
 */
export function acquireDataDirLock(dataDir: string, pid: number = process.pid): DataDirLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, LOCK_FILE_NAME);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${pid}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        process.off("exit", release);
        if (readPid(lockPath) === pid) {
          try {
            unlinkSync(lockPath);
          } catch {
            // already gone
          }
        }
      };
      process.on("exit", release);
      return { lockPath, release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new LockError(`Cannot create lock file ${lockPath}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
      }
    }
    const owner = readPid(lockPath);
    if (owner !== undefined && pidAlive(owner)) {
      throw new LockError(
        `Another switchboard serve (pid ${owner}) already holds the data directory ${dataDir}. ` +
          `Stop it, or use a different data_dir.`,
      );
    }
    // Stale: owner dead or file unreadable. Remove and retry once.
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new LockError(
          `Cannot remove stale lock file ${lockPath}: ${(err as NodeJS.ErrnoException).code ?? "error"}`,
        );
      }
    }
  }
  throw new LockError(`Could not acquire lock ${lockPath}: lost a race with another process`);
}

export type LockStatus =
  | { state: "free" }
  | { state: "held"; pid: number; lockPath: string }
  | { state: "stale"; pid: number | undefined; lockPath: string };

/**
 * Read-only lock inspection for the operator CLI (T1.10): never creates, replaces or removes the lock file. `held`
 * means the recorded PID is alive (Proposed: same liveness rule as {@link acquireDataDirLock}).
 */
export function inspectDataDirLock(dataDir: string): LockStatus {
  const lockPath = path.join(dataDir, LOCK_FILE_NAME);
  if (!existsSync(lockPath)) return { state: "free" };
  const pid = readPid(lockPath);
  if (pid !== undefined && pidAlive(pid)) return { state: "held", pid, lockPath };
  return { state: "stale", pid, lockPath };
}

export {
  type AcquireSlotOptions,
  acquireSlot,
  SLOT_POLL_MS,
  type SlotLease,
  SlotLockError,
  type SlotLockOptions,
  slotAddress,
  tryAcquireSlot,
} from "./slots.js";
