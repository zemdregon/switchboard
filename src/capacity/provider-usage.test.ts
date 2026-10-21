/**
 * Provider-reported usage service (FR-CAP-13, ADR-0079, BR-50): per-provider cache with separate success and failure
 * TTLs, one shared in-flight read, a throwing reader reported as `unavailable` with a generic reason, and
 * `attachProviderUsage` leaving entries without a reader untouched.
 */
import { describe, expect, it } from "vitest";
import {
  attachProviderUsage,
  PROVIDER_USAGE_READER_FAILED,
  type ProviderUsageReader,
  type ProviderUsageReport,
  ProviderUsageService,
} from "./provider-usage.js";

function clock(start = Date.parse("2026-10-21T10:00:00.000Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function reader(status: "ok" | "unavailable" | "throw", provider = "kimi") {
  const calls: Date[] = [];
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const r: ProviderUsageReader & { calls: Date[]; hold(): void; release(): void } = {
    provider,
    via: "test via",
    calls,
    hold() {
      gate = new Promise((res) => {
        release = res;
      });
    },
    release() {
      release?.();
    },
    async read(now) {
      calls.push(now);
      if (gate) await gate;
      if (status === "throw") throw new Error("secret /home/op/.kimi-code token");
      const base = { provider, source: "provider_reported" as const, observed_at: now.toISOString(), via: "test via" };
      return status === "ok"
        ? { status, ...base, windows: [], balances: [] }
        : { status, ...base, reason: "not logged in" };
    },
  };
  return r;
}

describe("ProviderUsageService (FR-CAP-13)", () => {
  it("lists providers and returns undefined without a reader", async () => {
    const s = new ProviderUsageService([reader("ok")]);
    expect(s.providers()).toEqual(["kimi"]);
    expect(await s.get("claude")).toBeUndefined();
  });

  it("reuses an ok report for the TTL, then reads again", async () => {
    const c = clock();
    const r = reader("ok");
    const s = new ProviderUsageService([r], { ttlMs: 1_000, now: c.now });
    const first = await s.get("kimi");
    c.advance(999);
    expect(await s.get("kimi")).toBe(first);
    expect(r.calls).toHaveLength(1);
    c.advance(1);
    await s.get("kimi");
    expect(r.calls).toHaveLength(2);
  });

  it("reuses an unavailable report for the shorter failure TTL", async () => {
    const c = clock();
    const r = reader("unavailable");
    const s = new ProviderUsageService([r], { ttlMs: 10_000, failureTtlMs: 500, now: c.now });
    await s.get("kimi");
    c.advance(499);
    await s.get("kimi");
    expect(r.calls).toHaveLength(1);
    c.advance(1);
    await s.get("kimi");
    expect(r.calls).toHaveLength(2);
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const r = reader("ok");
    r.hold();
    const s = new ProviderUsageService([r]);
    const all = Promise.all([s.get("kimi"), s.get("kimi"), s.get("kimi")]);
    await new Promise((res) => setTimeout(res, 5));
    r.release();
    const [a, b, c] = await all;
    expect(r.calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("turns a throwing reader into unavailable with a generic reason", async () => {
    const c = clock();
    const s = new ProviderUsageService([reader("throw")], { now: c.now });
    const r = await s.get("kimi");
    expect(r).toEqual({
      status: "unavailable",
      provider: "kimi",
      source: "provider_reported",
      observed_at: c.now().toISOString(),
      via: "test via",
      reason: PROVIDER_USAGE_READER_FAILED,
    });
    expect(JSON.stringify(r)).not.toContain("kimi-code");
  });
});

describe("attachProviderUsage", () => {
  const projection = () => ({
    as_of: "x",
    providers: [
      { provider: "fake", enabled: true },
      { provider: "kimi", enabled: true },
      { provider: "other", enabled: false },
    ],
  });

  it("is the same object without a service", async () => {
    const p = projection();
    expect(await attachProviderUsage(p, undefined)).toBe(p);
  });

  it("adds provider_usage only where a reader exists and the provider is enabled", async () => {
    const off = reader("ok", "other");
    const s = new ProviderUsageService([reader("ok"), off]);
    const p = projection();
    const out = await attachProviderUsage(p, s);
    expect(out.providers[0]).toBe(p.providers[0]);
    expect((out.providers[1] as { provider_usage?: ProviderUsageReport }).provider_usage?.status).toBe("ok");
    expect(out.providers[2]).toBe(p.providers[2]);
    expect(off.calls).toHaveLength(0);
  });
});
