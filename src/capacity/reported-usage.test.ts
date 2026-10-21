/**
 * Provider-reported usage windows in the capacity projection (ADR-0079; FR-CAP-13, BR-50). Rows carry the metrics the
 * Claude parser records from the 2026-10-21 capture.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderCapacity } from "../cli/capacity.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { CapacityProviderInfo } from "./collect.js";
import { capacityProjection } from "./projection.js";
import { reportedShareKeys, reportedUsage } from "./reported-usage.js";
import { USAGE_KEYS, type UsageKeyDeclaration, usageWindows } from "./usage-window.js";

const NOW = new Date("2026-10-21T03:00:00.000Z");
const CAPTURED = {
  five_hour_used_fraction: 0.03,
  five_hour_resets_at: "2026-10-21T07:30:00.000Z",
  seven_day_used_fraction: 0.06,
  seven_day_resets_at: "2026-10-22T12:00:00.000Z",
};

describe("reportedUsage (pure)", () => {
  it("returns both Claude windows from the newest row, with remaining = 1 - used", () => {
    const out = reportedUsage(
      "claude",
      [
        { metrics: { ...CAPTURED, five_hour_used_fraction: 0.01 }, observedAt: "2026-10-21T02:00:00.000Z" },
        { metrics: CAPTURED, observedAt: "2026-10-21T02:30:00.000Z" },
      ],
      NOW,
    );
    expect(out).toEqual({
      source: "provider_reported",
      windows: [
        {
          id: "five_hour",
          length_seconds: 18000,
          used_fraction: 0.03,
          remaining_fraction: 0.97,
          resets_at: "2026-10-21T07:30:00.000Z",
          observed_at: "2026-10-21T02:30:00.000Z",
          key: "five_hour_used_fraction",
        },
        {
          id: "seven_day",
          length_seconds: 604800,
          used_fraction: 0.06,
          remaining_fraction: 0.94,
          resets_at: "2026-10-22T12:00:00.000Z",
          observed_at: "2026-10-21T02:30:00.000Z",
          key: "seven_day_used_fraction",
        },
      ],
    });
  });

  it("concurrent runs: within one reset the largest share wins over a later-stored older reading; a later reset wins", () => {
    const five = (used: number, reset: string, at: string) => ({
      metrics: { five_hour_used_fraction: used, five_hour_resets_at: reset },
      observedAt: at,
    });
    const sameWindow = reportedUsage(
      "claude",
      [
        five(0.4, "2026-10-21T07:30:00.000Z", "2026-10-21T02:00:00.000Z"),
        five(0.3, "2026-10-21T07:30:00.000Z", "2026-10-21T02:50:00.000Z"), // a long run that read earlier, ended later
      ],
      NOW,
    );
    expect(sameWindow?.windows[0]).toMatchObject({ used_fraction: 0.4, observed_at: "2026-10-21T02:00:00.000Z" });
    const newWindow = reportedUsage(
      "claude",
      [
        five(0.9, "2026-10-21T02:30:00.000Z", "2026-10-21T02:20:00.000Z"),
        five(0.01, "2026-10-21T07:30:00.000Z", "2026-10-21T02:40:00.000Z"),
      ],
      NOW,
    );
    expect(newWindow?.windows[0]).toMatchObject({ used_fraction: 0.01, resets_at: "2026-10-21T07:30:00.000Z" });
  });

  it("leaves out a window whose reported reset has passed, or that was observed more than one length ago", () => {
    const out = reportedUsage(
      "claude",
      [
        {
          metrics: { ...CAPTURED, five_hour_resets_at: "2026-10-21T02:59:59.000Z" },
          observedAt: "2026-10-20T22:00:00Z",
        },
      ],
      NOW,
    );
    expect(out?.windows.map((w) => w.id)).toEqual(["seven_day"]);
    expect(reportedUsage("claude", [{ metrics: CAPTURED, observedAt: "2026-10-13T00:00:00Z" }], NOW)).toBeUndefined();
  });

  it("nothing for a provider without declared window keys, a future row, or a non-share value", () => {
    expect(reportedUsage("codex", [{ metrics: CAPTURED, observedAt: "2026-10-21T02:30:00Z" }], NOW)).toBeUndefined();
    expect(reportedUsage("claude", [{ metrics: CAPTURED, observedAt: "2026-10-21T04:00:00Z" }], NOW)).toBeUndefined();
    expect(
      reportedUsage("claude", [{ metrics: { five_hour_used_fraction: 3 }, observedAt: "2026-10-21T02:30:00Z" }], NOW),
    ).toBeUndefined();
  });

  it("a declared remaining share is converted, and the share keys the collector reads follow the declarations", () => {
    const keys: Record<string, readonly UsageKeyDeclaration[]> = {
      p: [
        {
          origin: "usage_observation",
          key: "rem",
          carries: "remaining_fraction",
          source: "t",
          window: { id: "d", lengthSeconds: 86400 },
        },
      ],
    };
    expect(
      reportedUsage("p", [{ metrics: { rem: 0.25 }, observedAt: "2026-10-21T02:00:00Z" }], NOW, keys)?.windows,
    ).toEqual([
      expect.objectContaining({ id: "d", used_fraction: 0.75, remaining_fraction: 0.25, resets_at: null, key: "rem" }),
    ]);
    expect(reportedShareKeys("p", keys)).toEqual([{ key: "rem", lengthSeconds: 86400 }]);
    expect(reportedShareKeys("claude")).toEqual([
      { key: "five_hour_used_fraction", lengthSeconds: 18000 },
      { key: "seven_day_used_fraction", lengthSeconds: 604800 },
    ]);
  });
});

describe("USAGE_KEYS for Claude Code feeds pacing only in a window of the same length", () => {
  it("a 5 h provider_reported subscription window reads five_hour, a 7 d one reads seven_day, another length reads neither", () => {
    expect(Object.isFrozen(USAGE_KEYS)).toBe(true);
    const out = usageWindows(
      [
        {
          name: "anthropic",
          providers: ["claude"],
          adapterIds: ["claude"],
          windows: [
            { id: "session", lengthSeconds: 18000, reset: { kind: "provider_reported" }, budget: null },
            { id: "week", lengthSeconds: 604800, reset: { kind: "provider_reported" }, budget: null },
            { id: "day", lengthSeconds: 86400, reset: { kind: "provider_reported" }, budget: null },
          ],
        },
      ],
      { mode: "gate", targetFraction: 0.95, burstFraction: 0.1, minConfidence: 0.5 },
      {
        startedRuns: [],
        usage: [
          { provider: "claude", source: "provider_reported", metrics: CAPTURED, observedAt: "2026-10-21T02:30:00Z" },
        ],
        rateLimitSignals: [],
      },
      NOW,
    );
    const [session, week, day] = out?.[0]?.windows ?? [];
    expect(session?.reset_at).toEqual({ at: "2026-10-21T07:30:00.000Z", source: "provider_reported" });
    expect(session?.used_fraction).toEqual({
      value: 0.03,
      source: "provider_reported",
      confidence: 1,
      key: "five_hour_used_fraction",
    });
    expect(week?.reset_at).toEqual({ at: "2026-10-22T12:00:00.000Z", source: "provider_reported" });
    expect(week?.used_fraction.value).toBe(0.06);
    expect(day?.reset_at).toBeNull();
    expect(day?.used_fraction.source).toBe("unknown");
  });
});

describe("capacity projection over the ledger shows reported_usage", () => {
  let dir: string;
  let db: Database.Database;
  let ledger: Ledger;
  let clock = NOW;
  const claude: CapacityProviderInfo = { id: "claude", enabled: true, weight: null, concurrencyLimit: 2 };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sb-reported-usage-"));
    db = openLedger(dir);
    ledger = createLedger(db, { now: () => clock });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const observe = (at: string, metrics: Record<string, number | string>) => {
    clock = new Date(at);
    const ms = ledger.createMetaSession({ objective: "o", constraints: [] });
    const r = ledger.createRun({
      metaSessionId: ms.id,
      trustProfile: "inspect-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c",
      provider: "claude",
    });
    ledger.insertUsageObservation({
      runId: r.id,
      provider: "claude",
      harness: "claude",
      source: "provider_reported",
      metrics,
    });
  };
  const project = () => capacityProjection(ledger, [claude], { windowSeconds: 3600, confidenceRuns: 5 }, NOW);

  it("absent with no row; present from the newest row even outside the estimator window; printed by the CLI", () => {
    expect(project().providers[0]?.reported_usage).toBeUndefined();
    observe("2026-10-20T20:00:00.000Z", { ...CAPTURED, five_hour_used_fraction: 0.5, seven_day_used_fraction: 0.05 });
    observe("2026-10-21T01:00:00.000Z", CAPTURED); // 2 h ago: outside the 1 h estimator window, inside 5 h
    observe("2026-10-21T01:30:00.000Z", { "usage.output_tokens": 4 }); // a token row: not a window
    const p = project();
    expect(p.providers[0]?.reported_usage?.windows.map((w) => [w.id, w.used_fraction, w.observed_at])).toEqual([
      ["five_hour", 0.03, "2026-10-21T01:00:00.000Z"],
      ["seven_day", 0.06, "2026-10-21T01:00:00.000Z"],
    ]);
    expect(p.providers[0]?.explicit_remaining).toBeNull();
    const text = renderCapacity(p);
    expect(text).toContain(
      "  provider-reported usage five_hour: used 0.03, remaining 0.97 of the window, resets 2026-10-21T07:30:00.000Z (at 2026-10-21T01:00:00.000Z)",
    );
    expect(text).toContain("  provider-reported usage seven_day: used 0.06, remaining 0.94 of the window");
  });
});
