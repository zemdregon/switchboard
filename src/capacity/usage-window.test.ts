/**
 * T6.13 (FR-CAP-09, BR-50, BR-41, LLD §16.9, ADR-0055 items 5 to 7): the subscription and usage-window model, its
 * configuration keys, and the unchanged capacity output when no subscription is configured.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PacingSettings, SubscriptionSettings, UsageWindowSettings } from "../config/capacity.js";
import { checkCapacity, loadConfig } from "../config/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  ESTIMATE_NOTE,
  nextFixedReset,
  USAGE_KEYS,
  type UsageKeyDeclaration,
  type UsageWindowInputs,
  usageWindows,
} from "./index.js";
import { capacityJson, capacityProjection } from "./projection.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const PACING: PacingSettings = { mode: "gate", targetFraction: 0.95, burstFraction: 0.1, minConfidence: 0.5 };
const EMPTY: UsageWindowInputs = { startedRuns: [], usage: [], rateLimitSignals: [] };
const HOUR = 3600;

const sub = (windows: UsageWindowSettings[], adapterIds = ["fake"]): SubscriptionSettings => ({
  name: "team",
  providers: adapterIds.map((a) => `${a}-cfg`),
  adapterIds,
  windows,
});
const win = (reset: UsageWindowSettings["reset"], budget: UsageWindowSettings["budget"] = null, len = HOUR) => ({
  id: "w",
  lengthSeconds: len,
  reset,
  budget,
});
const one = (s: SubscriptionSettings, inputs: UsageWindowInputs = EMPTY, now = NOW, keys?: typeof USAGE_KEYS) => {
  const out = usageWindows([s], PACING, inputs, now, keys);
  if (out === undefined) throw new Error("expected output");
  return out[0]?.windows[0];
};

describe("usage windows (T6.13, LLD §16.9)", () => {
  it("no subscription gives no pacing output", () => {
    expect(usageWindows(undefined, undefined, EMPTY, NOW)).toBeUndefined();
    expect(usageWindows([], PACING, EMPTY, NOW)).toBeUndefined();
  });

  it("USAGE_KEYS declares only Claude Code's captured window keys (ADR-0081) and is frozen", () => {
    expect(Object.keys(USAGE_KEYS)).toEqual(["claude"]);
    expect(USAGE_KEYS.claude?.map((d) => [d.key, d.carries, d.window?.lengthSeconds])).toEqual([
      ["five_hour_used_fraction", "used_fraction", 18000],
      ["five_hour_resets_at", "reset_at", 18000],
      ["seven_day_used_fraction", "used_fraction", 604800],
      ["seven_day_resets_at", "reset_at", 604800],
    ]);
    expect(Object.isFrozen(USAGE_KEYS)).toBe(true);
    expect(() => {
      (USAGE_KEYS as Record<string, unknown>).fake = [];
    }).toThrow(TypeError);
  });

  it("a fixed window computes reset and elapsed exactly at boundaries", () => {
    const anchor = "2026-10-17T00:00:00.000Z";
    const s = sub([win({ kind: "fixed", anchor })]);
    // On a boundary: a new window starts now (elapsed 0), the reset is one length later.
    let w = one(s, EMPTY, new Date("2026-10-17T12:00:00.000Z"));
    expect(w?.reset_at).toEqual({ at: "2026-10-17T13:00:00.000Z", source: "operator_declared" });
    expect(w?.window_start).toEqual({ at: "2026-10-17T12:00:00.000Z", source: "operator_declared" });
    expect(w?.elapsed_fraction).toBe(0);
    // One millisecond before the boundary: the old window, elapsed just under 1.
    w = one(s, EMPTY, new Date("2026-10-17T11:59:59.999Z"));
    expect(w?.reset_at?.at).toBe("2026-10-17T12:00:00.000Z");
    expect(w?.elapsed_fraction).toBe(1);
    // A quarter in.
    w = one(s, EMPTY, new Date("2026-10-17T12:15:00.000Z"));
    expect(w?.reset_at?.at).toBe("2026-10-17T13:00:00.000Z");
    expect(w?.elapsed_fraction).toBe(0.25);
    // Before the anchor: the anchor itself is the next reset.
    w = one(s, EMPTY, new Date("2026-10-16T23:30:00.000Z"));
    expect(w?.reset_at?.at).toBe(anchor);
    expect(w?.elapsed_fraction).toBe(0.5);
    expect(nextFixedReset(0, 10, 0)).toBe(10);
    expect(nextFixedReset(0, 10, 9)).toBe(10);
    expect(nextFixedReset(0, 10, 10)).toBe(20);
    expect(nextFixedReset(100, 10, 85)).toBe(90);
    // No budget and no declared key: used is unknown, so no allowance and pace unknown.
    expect(w?.used_fraction).toEqual({ value: null, source: "unknown", confidence: 0 });
    expect(w?.allowance).toBeNull();
    expect(w?.pace).toBe("unknown");
  });

  it("a provider_reported window with no declared key has reset_at null", () => {
    const inputs: UsageWindowInputs = {
      startedRuns: [{ provider: "fake", startedAt: "2026-10-17T11:30:00.000Z" }],
      usage: [
        {
          provider: "fake",
          source: "provider_reported",
          metrics: { reset_at: "2026-10-17T13:00:00.000Z", used_fraction: 0.5, resetsAt: 1 },
          observedAt: "2026-10-17T11:30:00.000Z",
        },
      ],
      rateLimitSignals: [
        { provider: "fake", payload: { reset_at: "2026-10-17T13:00:00.000Z" }, observedAt: "2026-10-17T11:31:00.000Z" },
      ],
    };
    const w = one(sub([win({ kind: "provider_reported" }, { unit: "runs", value: 10 })]), inputs);
    expect(w).toMatchObject({
      reset_at: null,
      window_start: null,
      elapsed_fraction: null,
      used_fraction: { value: null, source: "unknown", confidence: 0 },
      allowance: null,
      pace: "unknown",
    });
  });

  it("a declared key gives a provider_reported reset and used share (the path T6.15 will wire)", () => {
    const keys: Record<string, readonly UsageKeyDeclaration[]> = {
      fake: [
        { origin: "rate_limit", key: "resets", carries: "reset_at", source: "synthetic test declaration" },
        { origin: "usage_observation", key: "left", carries: "remaining_fraction", source: "synthetic" },
      ],
    };
    const inputs: UsageWindowInputs = {
      startedRuns: [],
      usage: [
        { provider: "fake", source: "provider_reported", metrics: { left: 0.9 }, observedAt: "2026-10-17T10:00:00Z" },
        { provider: "fake", source: "provider_reported", metrics: { left: 0.6 }, observedAt: "2026-10-17T11:45:00Z" },
        { provider: "fake", source: "inner_agent", metrics: { left: 0.0 }, observedAt: "2026-10-17T11:50:00Z" },
      ],
      rateLimitSignals: [
        { provider: "fake", payload: { resets: "2026-10-17T12:30:00.000Z" }, observedAt: "2026-10-17T11:40:00Z" },
        { provider: "fake", payload: { resets: "2026-10-17T11:00:00.000Z" }, observedAt: "2026-10-17T10:40:00Z" },
      ],
    };
    const w = one(sub([win({ kind: "provider_reported" }, null, 2 * HOUR)]), inputs, NOW, keys);
    expect(w?.reset_at).toEqual({ at: "2026-10-17T12:30:00.000Z", source: "provider_reported" });
    expect(w?.window_start).toEqual({ at: "2026-10-17T10:30:00.000Z", source: "provider_reported" });
    expect(w?.elapsed_fraction).toBe(0.75);
    expect(w?.used_fraction).toEqual({ value: 0.4, source: "provider_reported", confidence: 1, key: "left" });
    expect(w?.allowance).toBe(2.2); // (0.95 - 0.4) / 0.25
    expect(w?.pace).toBe("behind"); // 0.4 < 0.95 × 0.75 - 0.1
  });

  describe("a budget gives controller_estimated with lower_bound true", () => {
    const anchor = "2026-10-17T11:00:00.000Z";
    const inputs: UsageWindowInputs = {
      startedRuns: [
        { provider: "fake", startedAt: "2026-10-17T11:10:00.000Z" },
        { provider: "fake", startedAt: "2026-10-17T11:20:00.000Z" },
        { provider: "fake", startedAt: "2026-10-17T10:59:59.999Z" }, // before window_start
        { provider: "other", startedAt: "2026-10-17T11:20:00.000Z" }, // not in the subscription
        { provider: "fake", startedAt: "2026-10-17T12:00:00.001Z" }, // after now
      ],
      usage: [
        {
          provider: "fake",
          source: "provider_reported",
          metrics: { input_tokens: 300, output_tokens: 100, total_cost_usd: 0.5 },
          observedAt: "2026-10-17T11:10:00.000Z",
        },
        {
          provider: "fake",
          source: "provider_reported",
          metrics: { total_tokens: 600, cost_usd: 0.25 },
          observedAt: "2026-10-17T11:20:00.000Z",
        },
        { provider: "other", source: "provider_reported", metrics: { total_tokens: 9999 }, observedAt: anchor },
      ],
      rateLimitSignals: [],
    };
    const fixed = { kind: "fixed", anchor } as const;
    const at = new Date("2026-10-17T11:30:00.000Z"); // elapsed 0.5

    it("runs", () => {
      const w = one(sub([win(fixed, { unit: "runs", value: 4 })]), inputs, at);
      expect(w?.used_fraction).toEqual({
        value: 0.5,
        source: "controller_estimated",
        confidence: 0.8,
        lower_bound: true,
        basis: "runs",
        note: ESTIMATE_NOTE,
      });
      expect(w?.elapsed_fraction).toBe(0.5);
      expect(w?.allowance).toBe(0.9); // (0.95 - 0.5) / 0.5
      expect(w?.pace).toBe("on_pace"); // |0.5 - 0.475| <= 0.1
    });

    it("reported_tokens", () => {
      const w = one(sub([win(fixed, { unit: "reported_tokens", value: 2000 })]), inputs, at);
      expect(w?.used_fraction).toMatchObject({
        value: 0.5, // (300 + 100 + 600) / 2000
        source: "controller_estimated",
        lower_bound: true,
        basis: "reported_tokens",
      });
    });

    it("reported_cost_usd, capped at 1, and ahead of pace", () => {
      let w = one(sub([win(fixed, { unit: "reported_cost_usd", value: 1 })]), inputs, at);
      expect(w?.used_fraction).toMatchObject({ value: 0.75, source: "controller_estimated", lower_bound: true });
      expect(w?.pace).toBe("ahead"); // 0.75 > 0.475 + 0.1
      w = one(sub([win(fixed, { unit: "reported_cost_usd", value: 0.5 })]), inputs, at);
      expect(w?.used_fraction.value).toBe(1);
      expect(w?.allowance).toBe(-0.1);
    });

    it("a rolling window: start is now - length, elapsed 1, confidence 0.5, allowance T - used", () => {
      const w = one(sub([win({ kind: "rolling" }, { unit: "runs", value: 4 }, 3600)]), inputs, at);
      expect(w?.reset_at).toBeNull();
      expect(w?.window_start).toEqual({ at: "2026-10-17T10:30:00.000Z", source: "controller" });
      expect(w?.elapsed_fraction).toBe(1);
      expect(w?.used_fraction).toMatchObject({ value: 0.75, confidence: 0.5, lower_bound: true });
      expect(w?.allowance).toBe(0.2);
      expect(w?.pace).toBe("behind"); // 0.75 < 0.95 - 0.1
    });

    it("inner_agent and controller_estimated rows change nothing (BR-41)", () => {
      const s = sub([
        win(fixed, { unit: "reported_tokens", value: 2000 }),
        { ...win(fixed, { unit: "reported_cost_usd", value: 1 }), id: "cost" },
      ]);
      const extra: UsageWindowInputs = {
        ...inputs,
        usage: [
          ...inputs.usage,
          { provider: "fake", source: "inner_agent", metrics: { total_tokens: 500, cost_usd: 1 }, observedAt: anchor },
          { provider: "fake", source: "controller_estimated", metrics: { total_tokens: 7 }, observedAt: anchor },
        ],
      };
      expect(usageWindows([s], PACING, extra, at)).toEqual(usageWindows([s], PACING, inputs, at));
    });
  });

  it("over generated inputs no figure is labelled provider_reported without a declared key (property)", () => {
    let seed = 0x5eed;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const KEYS = ["used_fraction", "remaining_fraction", "reset_at", "resetsAt", "total_tokens", "cost_usd", "x"];
    const time = () => new Date(NOW.getTime() + Math.floor((rnd() - 0.7) * 4 * HOUR * 1000)).toISOString();
    const value = () => pick<unknown>([rnd(), rnd() * 1000, time(), null, "0.5", -1]);
    const metrics = () => Object.fromEntries(KEYS.filter(() => rnd() < 0.5).map((k) => [k, value()]));
    let reportedSeen = 0;
    for (let i = 0; i < 300; i++) {
      const providers = ["a", "b", "c"].filter(() => rnd() < 0.6);
      const windows: UsageWindowSettings[] = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, j) => ({
        id: `w${j}`,
        lengthSeconds: 60 + Math.floor(rnd() * 200000),
        reset: pick<UsageWindowSettings["reset"]>([
          { kind: "provider_reported" },
          { kind: "rolling" },
          { kind: "fixed", anchor: time() },
        ]),
        budget:
          rnd() < 0.5
            ? null
            : { unit: pick(["runs", "reported_tokens", "reported_cost_usd"]), value: 0.1 + rnd() * 100 },
      }));
      const inputs: UsageWindowInputs = {
        startedRuns: Array.from({ length: Math.floor(rnd() * 6) }, () => ({
          provider: pick(["a", "b", "c"]),
          startedAt: time(),
        })),
        usage: Array.from({ length: Math.floor(rnd() * 6) }, () => ({
          provider: pick(["a", "b", "c"]),
          source: pick(["provider_reported", "inner_agent", "controller_estimated"]),
          metrics: metrics(),
          observedAt: time(),
        })),
        rateLimitSignals: Array.from({ length: Math.floor(rnd() * 4) }, () => ({
          provider: pick(["a", "b", "c"]),
          payload: metrics(),
          observedAt: time(),
        })),
      };
      const s: SubscriptionSettings = { name: "s", providers, adapterIds: providers, windows };
      for (const w of usageWindows([s], PACING, inputs, NOW)?.[0]?.windows ?? []) {
        expect(w.reset_at?.source).not.toBe("provider_reported");
        expect(w.window_start?.source).not.toBe("provider_reported");
        expect(w.used_fraction.source).not.toBe("provider_reported");
        if (w.used_fraction.source === "controller_estimated") expect(w.used_fraction.lower_bound).toBe(true);
        if (w.used_fraction.source === "unknown") expect([w.used_fraction.value, w.allowance]).toEqual([null, null]);
      }
      // Positive control: with every key declared for every provider, the reported path is reachable.
      const all = Object.fromEntries(
        providers.map((p) => [
          p,
          (["used_fraction", "remaining_fraction", "reset_at"] as const).flatMap((k) => [
            { origin: "usage_observation" as const, key: k, carries: k, source: "test" },
            { origin: "rate_limit" as const, key: k, carries: k, source: "test" },
          ]),
        ]),
      );
      for (const w of usageWindows([s], PACING, inputs, NOW, all)?.[0]?.windows ?? []) {
        if (w.used_fraction.source === "provider_reported" || w.reset_at?.source === "provider_reported")
          reportedSeen++;
      }
    }
    expect(reportedSeen).toBeGreaterThan(0);
  });
});

describe("capacity.subscriptions and capacity.pacing configuration (T6.13, LLD §16.9)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-usage-window-")));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const load = (capacity: unknown) => {
    const p = path.join(tmp, "config.json");
    const cfg = {
      schema_version: 1,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
      ...(capacity === undefined ? {} : { capacity }),
    };
    writeFileSync(p, JSON.stringify(cfg));
    return loadConfig({ configPath: p });
  };
  const window = { id: "five-hour", length_seconds: 18000, reset: { kind: "provider_reported" } };

  it("resolves subscriptions in name order with adapter ids, and pacing defaults", () => {
    const c = load({
      subscriptions: {
        zed: { providers: ["codex"], windows: [window] },
        max: {
          providers: ["claude-code"],
          windows: [
            { id: "week", length_seconds: 604800, reset: { kind: "fixed", anchor: "2026-10-13T08:00:00+02:00" } },
            { id: "roll", length_seconds: 3600, reset: { kind: "rolling" }, budget: { unit: "runs", value: 20 } },
          ],
        },
      },
    }).capacity;
    expect(c.subscriptions).toEqual([
      {
        name: "max",
        providers: ["claude-code"],
        adapterIds: ["claude"],
        windows: [
          {
            id: "week",
            lengthSeconds: 604800,
            reset: { kind: "fixed", anchor: "2026-10-13T06:00:00.000Z" },
            budget: null,
          },
          { id: "roll", lengthSeconds: 3600, reset: { kind: "rolling" }, budget: { unit: "runs", value: 20 } },
        ],
      },
      {
        name: "zed",
        providers: ["codex"],
        adapterIds: ["codex"],
        windows: [{ id: "five-hour", lengthSeconds: 18000, reset: { kind: "provider_reported" }, budget: null }],
      },
    ]);
    expect(c.pacing).toEqual({ mode: "gate", targetFraction: 0.95, burstFraction: 0.1, minConfidence: 0.5 });
    expect(
      load({ pacing: { mode: "score", target_fraction: 0.5, burst_fraction: 0, min_confidence: 1 } }).capacity,
    ).toMatchObject({
      subscriptions: [],
      pacing: { mode: "score", targetFraction: 0.5, burstFraction: 0, minConfidence: 1 },
    });
  });

  it("refuses a provider in two subscriptions", () => {
    expect(() =>
      load({
        subscriptions: {
          a: { providers: ["codex"], windows: [window] },
          b: { providers: ["codex"], windows: [window] },
        },
      }),
    ).toThrow(/\$\.capacity\.subscriptions\.b\.providers\[0\]: "codex" is already in subscription "a"/);
    expect(checkCapacity({ subscriptions: { a: { providers: ["x", "x"], windows: [] } } }, ["x"])).toEqual([
      '$.capacity.subscriptions.a.providers[1]: "x" is already in subscription "a"; a provider is in at most one subscription',
    ]);
  });

  it("refuses a bad window", () => {
    const bad = (w: unknown) => () => load({ subscriptions: { a: { providers: ["codex"], windows: [w] } } });
    expect(bad({ ...window, length_seconds: 59 })).toThrow(/length_seconds/);
    expect(bad({ ...window, length_seconds: 2678401 })).toThrow(/length_seconds/);
    expect(bad({ ...window, length_seconds: 60.5 })).toThrow(/length_seconds/);
    expect(bad({ ...window, id: "Bad Id" })).toThrow(/\.id/);
    expect(bad({ ...window, reset: { kind: "monthly" } })).toThrow(/reset\.kind/);
    expect(bad({ ...window, reset: { kind: "fixed" } })).toThrow(/reset\.anchor: required for a fixed reset/);
    expect(bad({ ...window, reset: { kind: "fixed", anchor: "2026-10-17T00:00:00" } })).toThrow(/ISO 8601 instant/);
    expect(bad({ ...window, reset: { kind: "fixed", anchor: "yesterday" } })).toThrow(/ISO 8601 instant/);
    expect(bad({ ...window, reset: { kind: "rolling", anchor: "2026-10-17T00:00:00Z" } })).toThrow(
      /only a fixed reset takes an anchor/,
    );
    expect(bad({ ...window, budget: { unit: "runs", value: 0 } })).toThrow(/budget\.value/);
    expect(bad({ ...window, budget: { unit: "percent", value: 1 } })).toThrow(/budget\.unit/);
    expect(() => load({ subscriptions: { a: { providers: ["codex"], windows: [window, window] } } })).toThrow(
      /windows\[1\]\.id: "five-hour" is not unique/,
    );
    expect(() => load({ subscriptions: { a: { providers: ["codex"], windows: [] } } })).toThrow(/windows/);
    expect(() =>
      load({ subscriptions: { a: { providers: ["codex"], windows: [window, window, window, window, window] } } }),
    ).toThrow(/windows/);
    expect(() => load({ subscriptions: { a: { providers: ["nope"], windows: [window] } } })).toThrow(
      /providers\[0\]: "nope" is not a configured provider id/,
    );
    expect(() => load({ subscriptions: { a: { providers: [], windows: [window] } } })).toThrow(/providers/);
    expect(() => load({ subscriptions: { "1bad": { providers: ["codex"], windows: [window] } } })).toThrow(
      /subscriptions/,
    );
  });

  it("refuses unknown keys", () => {
    expect(() => load({ subscriptions: { a: { providers: ["codex"], windows: [window], plan: "max" } } })).toThrow(
      /\$\.capacity\.subscriptions\.a\.plan: unknown key/,
    );
    expect(() =>
      load({ subscriptions: { a: { providers: ["codex"], windows: [{ ...window, reset_hint: 1 }] } } }),
    ).toThrow(/reset_hint: unknown key/);
    expect(() =>
      load({
        subscriptions: { a: { providers: ["codex"], windows: [{ ...window, reset: { kind: "rolling", tz: "UTC" } }] } },
      }),
    ).toThrow(/tz: unknown key/);
    expect(() =>
      load({
        subscriptions: {
          a: { providers: ["codex"], windows: [{ ...window, budget: { unit: "runs", value: 1, cap: 2 } }] },
        },
      }),
    ).toThrow(/cap: unknown key/);
    expect(() => load({ pacing: { mode: "gate", rate: 1 } })).toThrow(/\$\.capacity\.pacing\.rate: unknown key/);
    expect(() => load({ pacing: { mode: "always" } })).toThrow(/pacing\.mode/);
    expect(() => load({ pacing: { target_fraction: 0.4 } })).toThrow(/target_fraction/);
    expect(() => load({ pacing: { burst_fraction: 0.6 } })).toThrow(/burst_fraction/);
    expect(() => load({ pacing: { min_confidence: 1.1 } })).toThrow(/min_confidence/);
  });

  describe("no subscription: capacity output byte-identical to main", () => {
    let dir: string;
    let db: Database.Database;
    let ledger: Ledger;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "sb-usage-window-ledger-"));
      db = openLedger(dir);
      ledger = createLedger(db, { now: () => NOW });
      const ms = ledger.createMetaSession({ objective: "o", constraints: [] });
      const r = ledger.createRun({
        metaSessionId: ms.id,
        trustProfile: "inspect-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: "h",
        clientId: "c",
        provider: "fake",
      });
      db.prepare("UPDATE run SET state = 'SUCCEEDED', started_at = ?, finished_at = ? WHERE id = ?").run(
        "2026-10-17T11:50:00.000Z",
        "2026-10-17T11:55:00.000Z",
        r.id,
      );
    });
    afterEach(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("resolves exactly as before and the projection is unchanged", () => {
      const MAIN_SETTINGS = {
        windowSeconds: 3600,
        confidenceRuns: 10,
        queueHorizonSeconds: 0,
        breaker: { failureThreshold: 3, openSeconds: 300 },
        retry: { maxAttempts: 3, baseMs: 2000, capMs: 120000 },
      };
      const providers = [{ id: "fake", enabled: true, weight: null, concurrencyLimit: 1 }];
      const main = capacityJson(capacityProjection(ledger, providers, MAIN_SETTINGS, NOW));
      for (const capacity of [undefined, {}, { window_seconds: 3600 }]) {
        const settings = load(capacity).capacity;
        expect(settings).toStrictEqual(MAIN_SETTINGS);
        expect(Object.keys(settings)).not.toContain("subscriptions");
        expect(Object.keys(settings)).not.toContain("pacing");
        expect(usageWindows(settings.subscriptions, settings.pacing, EMPTY, NOW)).toBeUndefined();
        expect(capacityJson(capacityProjection(ledger, providers, settings, NOW))).toBe(main);
      }
      // Pacing alone (no subscription) still yields no pacing output and the same projection.
      const pacingOnly = load({ pacing: { mode: "score" } }).capacity;
      expect(usageWindows(pacingOnly.subscriptions, pacingOnly.pacing, EMPTY, NOW)).toBeUndefined();
      expect(capacityJson(capacityProjection(ledger, providers, pacingOnly, NOW))).toBe(main);
      expect(main).not.toContain("pacing");
    });
  });
});
