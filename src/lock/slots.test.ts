/**
 * T3.22 verification slots (FR-EXE-09; LLD §8.1): a slot is a socket the kernel frees when its holder dies. Each test
 * uses its own scope (and, in `path` mode, its own directory), so nothing here touches the host-wide `default` slots.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSlot, type SlotLockOptions, slotAddress, tryAcquireSlot } from "./index.js";

let dir: string;
let scope: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  // Short: a socket path must fit in sun_path (104 bytes on macOS).
  dir = mkdtempSync(path.join(tmpdir(), "sbs-"));
  scope = `t${process.pid}${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

/** Another process holding a slot: it listens on the slot's address until it is killed. */
async function holdInChild(address: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    // JSON keeps the abstract name's leading NUL out of argv (spawn refuses NUL in arguments).
    ["-e", `require('net').createServer().listen(${JSON.stringify(address)}, () => process.stdout.write('ready'))`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`holder exited early (${code})`)));
  });
  return child;
}

const killed = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });

const modes: ("abstract" | "path")[] = process.platform === "linux" ? ["abstract", "path"] : ["path"];

describe.each(modes)("verification slots, %s mode (T3.22, FR-EXE-09)", (mode) => {
  const opts = (slots: number): SlotLockOptions => ({ slots, scope, mode, dir });

  it("hands out at most `slots` leases; a release frees one", async () => {
    const a = await tryAcquireSlot(opts(2));
    const b = await tryAcquireSlot(opts(2));
    expect([a?.index, b?.index]).toEqual([0, 1]);
    expect(await tryAcquireSlot(opts(2))).toBeUndefined();
    await a?.release();
    await a?.release(); // idempotent
    const c = await tryAcquireSlot(opts(2));
    expect(c?.index).toBe(0);
    await b?.release();
    await c?.release();
  });

  it("SIGKILL of a slot holder frees the slot", async () => {
    const holder = await holdInChild(slotAddress(opts(1), 0));
    expect(await tryAcquireSlot(opts(1))).toBeUndefined();
    await killed(holder);
    if (mode === "path") expect(existsSync(slotAddress(opts(1), 0))).toBe(true); // the dead holder's file is stale
    const lease = await tryAcquireSlot(opts(1));
    expect(lease?.index).toBe(0);
    await lease?.release();
  });

  it("acquireSlot waits, reports the wait once, and gets the slot when the holder dies", async () => {
    const holder = await holdInChild(slotAddress(opts(1), 0));
    let waits = 0;
    const pending = acquireSlot({ ...opts(1), deadline: Date.now() + 10_000, pollMs: 20, onWait: () => waits++ });
    await new Promise((r) => setTimeout(r, 200));
    await killed(holder);
    const got = await pending;
    expect(typeof got).toBe("object");
    expect(waits).toBe(1);
    if (typeof got === "object") await got.release();
  });

  it("acquireSlot stops at the deadline with `timeout`, and on a cancel with `cancelled`", async () => {
    const held = await tryAcquireSlot(opts(1));
    expect(await acquireSlot({ ...opts(1), deadline: Date.now() + 150, pollMs: 20 })).toBe("timeout");
    let stop = false;
    setTimeout(() => {
      stop = true;
    }, 100);
    expect(await acquireSlot({ ...opts(1), deadline: Date.now() + 10_000, pollMs: 20, cancelled: () => stop })).toBe(
      "cancelled",
    );
    await held?.release();
  });
});

describe("verification slot setup (T3.22)", () => {
  it("refuses an invalid scope or slot count", async () => {
    await expect(tryAcquireSlot({ slots: 1, scope: "../x", mode: "path", dir })).rejects.toThrow(/invalid slot scope/);
    await expect(tryAcquireSlot({ slots: 0, scope, mode: "path", dir })).rejects.toThrow(/positive integer/);
  });

  it("fails closed on a slot directory others can write", async () => {
    chmodSync(dir, 0o777);
    await expect(tryAcquireSlot({ slots: 1, scope, mode: "path", dir })).rejects.toThrow(/not a private directory/);
  });
});
