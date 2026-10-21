/** Provider usage reads for the capacity surfaces (ADR-0079, FR-CAP-13, LLD §16.10): cache, failure and overlay. */
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import type { ProviderUsageResult } from "../adapters/provider-usage.js";
import type { ProbeRunner } from "../adapters/types.js";
import { PROVIDER_USAGE_TTL_MS, ProviderUsageCache, providerUsageLines, readProviderUsage } from "./provider-usage.js";

const T0 = new Date("2026-10-21T00:00:00.000Z");
const runner: ProbeRunner = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
const unknown = (at: Date): ProviderUsageResult => ({
  provider: "fake",
  source: "unknown",
  observed_at: at.toISOString(),
  method: "m",
  error: "e",
});

class Counting extends FakeAdapter {
  reads = 0;
  async readProviderUsage(_r: ProbeRunner, now?: Date): Promise<ProviderUsageResult> {
    this.reads++;
    return unknown(now ?? T0);
  }
}

describe("readProviderUsage", () => {
  it("skips adapters without a reader and caches a read for the TTL", async () => {
    const a = new Counting({ script: "/x" });
    const plain = new FakeAdapter({ script: "/x" });
    const cache = new ProviderUsageCache();
    const first = await readProviderUsage([a, plain], { runner, cache }, T0);
    expect([...first.keys()]).toEqual(["fake"]);
    await readProviderUsage([a], { runner, cache }, new Date(T0.getTime() + PROVIDER_USAGE_TTL_MS - 1));
    expect(a.reads).toBe(1);
    const later = await readProviderUsage([a], { runner, cache }, new Date(T0.getTime() + PROVIDER_USAGE_TTL_MS));
    expect(a.reads).toBe(2);
    expect(later.get("fake")?.observed_at).toBe(new Date(T0.getTime() + PROVIDER_USAGE_TTL_MS).toISOString());
    // A clock that went backwards reads again rather than trusting a future entry.
    await readProviderUsage([a], { runner, cache }, new Date(T0.getTime() - 1));
    expect(a.reads).toBe(3);
  });

  it("a reader that throws yields unknown with the error's name only", async () => {
    class Throwing extends FakeAdapter {
      async readProviderUsage(): Promise<ProviderUsageResult> {
        throw new TypeError("secret-looking detail");
      }
    }
    const r = await readProviderUsage([new Throwing({ script: "/x" })], { runner }, T0);
    expect(r.get("fake")).toEqual({
      provider: "fake",
      source: "unknown",
      observed_at: T0.toISOString(),
      method: "readProviderUsage",
      error: "usage read failed: TypeError",
    });
  });

  it("text lines say unknown with the reason, and never print a percentage", () => {
    expect(providerUsageLines(unknown(T0), "  ")).toEqual(["  provider-reported usage: unknown (e; m)"]);
    const lines = providerUsageLines(
      {
        provider: "codex",
        source: "provider_reported",
        observed_at: T0.toISOString(),
        method: "m",
        plan: null,
        limit_reached: true,
        limit_reached_type: "rate_limit_reached",
        windows: [
          {
            id: "primary",
            limit_id: null,
            window_seconds: null,
            used_fraction: 1,
            remaining_fraction: 0,
            resets_at: null,
          },
        ],
        credits: { has_credits: false, unlimited: false, balance: null },
      },
      "",
    );
    expect(lines).toEqual([
      "provider-reported usage (m, at 2026-10-21T00:00:00.000Z): plan unknown, limit reached yes (rate_limit_reached)",
      "  primary (length unknown, provider_reported): used 1, remaining 0, resets unknown",
      "  credits: unknown (none)",
    ]);
    expect(lines.join("\n")).not.toContain("%");
  });

  it("spend lines say spent, never remaining, and print scope and note (ADR-0089)", () => {
    const lines = providerUsageLines(
      {
        provider: "opencode",
        source: "provider_reported",
        observed_at: T0.toISOString(),
        method: "m",
        plan: null,
        limit_reached: null,
        limit_reached_type: null,
        windows: [],
        credits: null,
        spend_windows: [
          {
            id: "five_hour",
            window_seconds: 18_000,
            from: "2026-10-20T19:00:00.000Z",
            to: T0.toISOString(),
            amount: 1.234,
            unit: "usd",
          },
        ],
        scope: "s",
        note: "n",
      },
      "",
    );
    expect(lines).toEqual([
      "provider-reported usage (m, at 2026-10-21T00:00:00.000Z): plan unknown, limit reached unknown",
      "  five_hour (18000 s, provider_reported): spent 1.23 usd; limit not reported, remaining not reported, " +
        "reset not reported",
      "  scope: s",
      "  note: n",
    ]);
  });
});
