import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDataDirLock, heldLocks, LockError, tryAcquireSlot } from "./index.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-lock-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("data-dir lock", () => {
  it("writes the PID and releases the file", () => {
    const l = acquireDataDirLock(dir);
    expect(readFileSync(l.lockPath, "utf8").trim()).toBe(String(process.pid));
    l.release();
    expect(existsSync(l.lockPath)).toBe(false);
    l.release(); // idempotent
  });

  it("is listed by heldLocks() from acquisition until release (T8.10 instrumentation)", () => {
    expect(heldLocks()).toEqual([]);
    const l = acquireDataDirLock(dir);
    expect(heldLocks()).toEqual([{ kind: "data_dir", lockPath: l.lockPath }]);
    l.release();
    expect(heldLocks()).toEqual([]);
  });

  it("fails clearly on a second acquisition while the owner is alive", () => {
    const l = acquireDataDirLock(dir);
    expect(() => acquireDataDirLock(dir)).toThrow(LockError);
    expect(() => acquireDataDirLock(dir)).toThrow(new RegExp(`pid ${process.pid}.*already holds`));
    l.release();
    acquireDataDirLock(dir).release();
  });

  it("recovers a stale lock whose PID is dead", () => {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    writeFileSync(path.join(dir, "serve.lock"), `${dead.stdout.toString()}\n`);
    const l = acquireDataDirLock(dir);
    expect(readFileSync(l.lockPath, "utf8").trim()).toBe(String(process.pid));
    l.release();
  });

  it("treats a corrupt lock file as stale", () => {
    writeFileSync(path.join(dir, "serve.lock"), "garbage");
    acquireDataDirLock(dir).release();
  });

  it("does not delete a lock it no longer owns on release", () => {
    const l = acquireDataDirLock(dir);
    writeFileSync(l.lockPath, "999999999\n");
    l.release();
    expect(existsSync(l.lockPath)).toBe(true);
  });
});

describe("held-lock registry (T8.10, LLD §20.14)", () => {
  it("lists a verification slot from acquisition until release", async () => {
    const lease = await tryAcquireSlot({ slots: 1, scope: `h${process.pid}`, mode: "path", dir });
    expect(lease).toBeDefined();
    expect(heldLocks()).toEqual([{ kind: "verification_slot", index: 0 }]);
    await lease?.release();
    expect(heldLocks()).toEqual([]);
  });
});
