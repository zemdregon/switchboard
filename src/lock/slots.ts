/**
 * Verification slots (T3.22; FR-EXE-09, NFR-PERF-03, R-8; LLD §8.1). A slot is a Unix-domain socket that its holder
 * listens on: binding is atomic, and the kernel closes the socket when the holder process dies, however it dies
 * (`SIGKILL` included), so a dead holder never keeps a slot. Not a ledger row: every controller on the host sees the
 * same slots. Delegated choices (not owner-approved), recorded in LLD §8.1:
 *
 * - **Linux:** an abstract-namespace socket (`\0switchboard-<uid>-verification-<scope>-<i>`). There is no file to go
 *   stale; the name disappears with the last descriptor.
 * - **Elsewhere:** a socket file in a `0700` directory owned by the controller's user. A file left by a dead holder is
 *   detected by a refused connection and removed before the bind is retried. Two waiters removing the same stale file
 *   at the same moment can, rarely, both bind (one unlinks the other's fresh socket); the cost is one extra concurrent
 *   command, never a lost run.
 * - **Per user.** Slots are shared by every controller of the same operator account on the host, not across accounts:
 *   another account cannot occupy them (abstract sockets have no permissions, so the uid is in the name).
 * - **No queue.** A waiter polls every {@link SLOT_POLL_MS}; there is no FIFO order between waiters.
 */
import { lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/** Proposed (Delegated): how often a waiting run retries the slots. */
export const SLOT_POLL_MS = 100;

export interface SlotLockOptions {
  /** Number of slots (at least 1). */
  readonly slots: number;
  /** Separates independent slot sets (tests); `[A-Za-z0-9_-]{1,32}`. Default `default`. */
  readonly scope?: string | undefined;
  /** `abstract` (Linux only) or `path`. Default: `abstract` on Linux, `path` elsewhere. */
  readonly mode?: "abstract" | "path" | undefined;
  /** Directory for `path` mode. Default `<tmpdir>/switchboard-<uid>/verification-slots`. */
  readonly dir?: string | undefined;
}

export interface SlotLease {
  readonly index: number;
  /** Idempotent: closes the socket, freeing the slot. */
  release(): Promise<void>;
}

export class SlotLockError extends Error {
  override readonly name = "SlotLockError";
}

const uid = (): number => process.getuid?.() ?? 0;

function resolveMode(opts: SlotLockOptions): "abstract" | "path" {
  const mode = opts.mode ?? (process.platform === "linux" ? "abstract" : "path");
  if (mode === "abstract" && process.platform !== "linux") throw new SlotLockError("abstract sockets need Linux");
  return mode;
}

function checkScope(scope: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(scope)) throw new SlotLockError(`invalid slot scope: ${JSON.stringify(scope)}`);
  return scope;
}

/** The slot directory for `path` mode, created `0700`; refused if another user owns it or others can write it. */
function slotDir(opts: SlotLockOptions): string {
  const dir = opts.dir ?? path.join(tmpdir(), `switchboard-${uid()}`, "verification-slots");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (!st.isDirectory() || (process.getuid !== undefined && st.uid !== uid()) || (st.mode & 0o022) !== 0) {
    throw new SlotLockError(`verification slot directory ${dir} is not a private directory of this user`);
  }
  return dir;
}

/** The listen address of slot `index` (exported for tests that hold a slot from another process). */
export function slotAddress(opts: SlotLockOptions, index: number): string {
  const scope = checkScope(opts.scope ?? "default");
  if (resolveMode(opts) === "abstract") return `\0switchboard-${uid()}-verification-${scope}-${index}`;
  return path.join(slotDir(opts), `${scope}-${index}.sock`);
}

function listen(address: string): Promise<Server | "busy"> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (err: NodeJS.ErrnoException) => {
      server.close();
      if (err.code === "EADDRINUSE") resolve("busy");
      else reject(new SlotLockError(`cannot bind verification slot: ${err.code ?? err.message}`));
    };
    server.once("error", onError);
    server.listen(address, () => {
      server.off("error", onError);
      server.on("error", () => {}); // a listening server has nothing left to report
      server.unref(); // a held slot never keeps the controller alive
      resolve(server);
    });
  });
}

/** True when nobody accepts on the socket file (its holder died). */
function refused(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(address);
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "ECONNREFUSED" || err.code === "ENOENT"));
  });
}

async function bindSlot(address: string, abstract: boolean): Promise<Server | "busy"> {
  const first = await listen(address);
  if (first !== "busy" || abstract) return first;
  // `path` mode: a socket file whose holder died stays behind. Remove it only if it is still the same file.
  let ino: number;
  try {
    ino = lstatSync(address).ino;
  } catch {
    return listen(address);
  }
  if (!(await refused(address))) return "busy";
  try {
    if (lstatSync(address).ino === ino) unlinkSync(address);
  } catch {
    // already removed by another waiter
  }
  return listen(address);
}

function lease(index: number, server: Server, address: string, abstract: boolean): SlotLease {
  let released: Promise<void> | undefined;
  return {
    index,
    release: () => {
      released ??= new Promise<void>((resolve) => {
        // Unlink before close so a waiter never sees a refused, about-to-vanish file it would remove.
        if (!abstract) {
          try {
            unlinkSync(address);
          } catch {
            // already gone
          }
        }
        server.close(() => resolve());
      });
      return released;
    },
  };
}

/** Take the first free slot, or `undefined` when all are held. Throws {@link SlotLockError} on a setup problem. */
export async function tryAcquireSlot(opts: SlotLockOptions): Promise<SlotLease | undefined> {
  if (!Number.isInteger(opts.slots) || opts.slots < 1) throw new SlotLockError("slots must be a positive integer");
  const abstract = resolveMode(opts) === "abstract";
  for (let index = 0; index < opts.slots; index++) {
    const address = slotAddress(opts, index);
    const server = await bindSlot(address, abstract);
    if (server !== "busy") return lease(index, server, address, abstract);
  }
  return undefined;
}

export interface AcquireSlotOptions extends SlotLockOptions {
  /** Epoch milliseconds; waiting stops here with `timeout`. */
  readonly deadline: number;
  /** Polled between attempts; true stops waiting with `cancelled`. */
  readonly cancelled?: () => boolean;
  /** Called once, when the first attempt finds every slot held. */
  readonly onWait?: () => void;
  readonly pollMs?: number;
}

/** Wait for a slot until the deadline or a cancel. */
export async function acquireSlot(opts: AcquireSlotOptions): Promise<SlotLease | "timeout" | "cancelled"> {
  let waiting = false;
  for (;;) {
    if (opts.cancelled?.()) return "cancelled";
    const got = await tryAcquireSlot(opts);
    if (got) {
      if (opts.cancelled?.()) {
        await got.release();
        return "cancelled";
      }
      return got;
    }
    if (!waiting) {
      waiting = true;
      opts.onWait?.();
    }
    const left = opts.deadline - Date.now();
    if (left <= 0) return "timeout";
    await new Promise((r) => setTimeout(r, Math.min(opts.pollMs ?? SLOT_POLL_MS, left)));
  }
}
