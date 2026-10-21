/**
 * One-time codes (T13.8; migration 0036 profile binding): bound and legacy codes share the single-live-code invariant,
 * `lookup` never spends a code, `consume` spends it atomically and yields its profile, `redeem` (the approval-link page)
 * spends only a legacy code, and the lifetime is bounded to 1 to 60 minutes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger/index.js";
import {
  MAX_PAIRING_CODE_TTL_MS,
  MIN_PAIRING_CODE_TTL_MS,
  normalizePairingCode,
  PAIRING_CODE_TTL_MS,
  PairingCodeStore,
} from "./oauth-pairing.js";

let dir: string;
let db: Database.Database;
let clock: Date;
let store: PairingCodeStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-pairing-"));
  db = openLedger(dir);
  clock = new Date("2026-10-21T08:00:00.000Z");
  store = new PairingCodeStore(db, { now: () => clock });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("profile-bound one-time codes (migration 0036)", () => {
  it("stores the profile with the hash only, looks it up without spending it and consumes it once", () => {
    const c = store.create({ mcpClient: "grok-bot" });
    expect(c.mcpClient).toBe("grok-bot");
    expect(Date.parse(c.expiresAt) - clock.getTime()).toBe(PAIRING_CODE_TTL_MS);
    const row = db.prepare("SELECT code_hash, mcp_client, used_at FROM oauth_pairing_code").get() as Record<
      string,
      unknown
    >;
    expect(row.mcp_client).toBe("grok-bot");
    expect(row.used_at).toBeNull();
    expect(JSON.stringify(row)).not.toContain(normalizePairingCode(c.code));

    expect(store.lookup(c.code)).toEqual({ mcpClient: "grok-bot" });
    expect(store.lookup(c.code)).toEqual({ mcpClient: "grok-bot" }); // still live
    expect(store.consume(c.code.toLowerCase())).toEqual({ mcpClient: "grok-bot" });
    expect(store.consume(c.code)).toBeUndefined();
    expect(store.lookup(c.code)).toBeUndefined();
  });

  it("returns no profile for a legacy code, and redeem spends only a legacy code", () => {
    const legacy = store.create();
    expect(legacy.mcpClient).toBeUndefined();
    expect(store.lookup(legacy.code)).toEqual({ mcpClient: undefined });
    expect(store.redeem(legacy.code)).toBe(true);
    expect(store.redeem(legacy.code)).toBe(false);

    const bound = store.create({ mcpClient: "grok-bot" });
    // The approval-link page never accepts a code issued to bind a remote client; the code stays live.
    expect(store.redeem(bound.code)).toBe(false);
    expect(store.lookup(bound.code)).toEqual({ mcpClient: "grok-bot" });
    expect(store.consume(bound.code)).toEqual({ mcpClient: "grok-bot" });
  });

  it("keeps at most one live code across legacy and bound codes", () => {
    const legacy = store.create();
    const bound = store.create({ mcpClient: "grok-bot" });
    expect(store.lookup(legacy.code)).toBeUndefined();
    expect(store.lookup(bound.code)).toBeDefined();
    const again = store.create();
    expect(store.lookup(bound.code)).toBeUndefined();
    expect(store.consume(bound.code)).toBeUndefined();
    expect(store.lookup(again.code)).toEqual({ mcpClient: undefined });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM oauth_pairing_code WHERE used_at IS NULL").get() as { n: number }).n,
    ).toBe(1);
  });

  it("bounds the lifetime to 1 to 60 minutes and expires a code", () => {
    expect(() => store.create({ ttlMs: MIN_PAIRING_CODE_TTL_MS - 1 })).toThrow(RangeError);
    expect(() => store.create({ ttlMs: MAX_PAIRING_CODE_TTL_MS + 1 })).toThrow(RangeError);
    expect(() => store.create({ ttlMs: 1.5 * 60_000 + 0.5 })).toThrow(RangeError);
    expect(() => store.create({ mcpClient: "" })).toThrow(RangeError);
    const shortest = store.create({ mcpClient: "grok-bot", ttlMs: MIN_PAIRING_CODE_TTL_MS });
    expect(Date.parse(shortest.expiresAt) - clock.getTime()).toBe(MIN_PAIRING_CODE_TTL_MS);
    const longest = store.create({ mcpClient: "grok-bot", ttlMs: MAX_PAIRING_CODE_TTL_MS });
    expect(Date.parse(longest.expiresAt) - clock.getTime()).toBe(MAX_PAIRING_CODE_TTL_MS);
    clock = new Date(clock.getTime() + MAX_PAIRING_CODE_TTL_MS);
    expect(store.lookup(longest.code)).toBeUndefined();
    expect(store.consume(longest.code)).toBeUndefined();
  });

  it("refuses malformed input without touching the table", () => {
    store.create({ mcpClient: "grok-bot" });
    for (const bad of ["", "nope", "AAAA-BBBB-CCC", "!".repeat(12), "A".repeat(65)]) {
      expect(store.lookup(bad)).toBeUndefined();
      expect(store.consume(bad)).toBeUndefined();
      expect(store.redeem(bad)).toBe(false);
    }
  });
});
