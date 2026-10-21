/**
 * Claude Code usage windows from `rate_limit_event` (ADR-0088; FR-CAP-15). The recorded fixture is the redacted
 * 2026-10-21 capture (`docs/research/claude-usage-capture-2026-10-21.md`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { usageObservationsFromEvents } from "../../usage/index.js";
import { createParseState, type NormalizedEvent } from "../types.js";
import { fixturePath } from "./fixtures/cases.js";
import { parseClaudeLine } from "./parse.js";
import { CLAUDE_USAGE_WINDOWS, claudeUsageMetrics, MAX_USAGE_WINDOWS } from "./usage.js";

const parseFixture = (name: string): NormalizedEvent[] => {
  const state = createParseState();
  return readFileSync(fixturePath(name), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith(`{"_fixture"`))
    .flatMap((l) => parseClaudeLine(l.replaceAll("{{SESSION_ID}}", "00000000-0000-4000-8000-000000000001"), state));
};

const WINDOWS = {
  five_hour_used_fraction: 0.03,
  five_hour_resets_at: "2026-10-21T07:30:00.000Z",
  seven_day_used_fraction: 0.06,
  seven_day_resets_at: "2026-10-22T12:00:00.000Z",
};

describe("Claude Code rate_limit_event usage windows (ADR-0088)", () => {
  it("the recorded allowed event yields one provider_reported usage event with both windows and no rate_limit", () => {
    const events = parseFixture("usage-windows-recorded.jsonl");
    const usage = events.filter((e) => e.kind === "usage");
    expect(usage[0]).toEqual({ kind: "usage", source: "provider_reported", metrics: WINDOWS });
    expect(events.some((e) => e.kind === "rate_limit")).toBe(false);
    expect(events.some((e) => e.kind === "unknown")).toBe(false);
    expect(events.find((e) => e.kind === "result")).toEqual({ kind: "result", ok: true, summary: "ok" });
  });

  it("the window metrics become a usage_observation row beside the result's token row", () => {
    const rows = usageObservationsFromEvents(parseFixture("usage-windows-recorded.jsonl"), {
      runId: "run_1",
      provider: "claude",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: "claude", source: "provider_reported", metrics: WINDOWS });
    expect(rows[0]?.model).toBe("claude-haiku-5-5");
  });

  it("a rejected event keeps its rate_limit signal and also records the windows it carries", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1792567800,
        rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792567800 } },
      },
    });
    expect(parseClaudeLine(line, createParseState())).toEqual([
      {
        kind: "usage",
        source: "provider_reported",
        metrics: { five_hour_used_fraction: 1, five_hour_resets_at: "2026-10-21T07:30:00.000Z" },
      },
      { kind: "rate_limit", resetAt: "2026-10-21T07:30:00.000Z", reportedCategory: "five_hour" },
    ]);
  });

  it("the synthetic rejected fixture (no window figures) is unchanged: a rate_limit signal and no usage event", () => {
    const events = parseFixture("rate-limit.jsonl");
    expect(events.filter((e) => e.kind === "rate_limit")).toEqual([
      { kind: "rate_limit", resetAt: "2027-01-01T00:00:00.000Z", reportedCategory: "five_hour" },
    ]);
    expect(events.filter((e) => e.kind === "usage" && "five_hour_used_fraction" in e.metrics)).toEqual([]);
  });

  it("a top-level utilization with a rateLimitType is read as that one window", () => {
    expect(claudeUsageMetrics({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81 })).toEqual({
      seven_day_used_fraction: 0.81,
    });
  });

  it("drops values that are not a share, bad window names, bad resets, and caps the window count", () => {
    expect(claudeUsageMetrics(undefined)).toBeUndefined();
    expect(claudeUsageMetrics({ status: "allowed" })).toBeUndefined();
    expect(
      claudeUsageMetrics({
        unifiedWindows: {
          five_hour: { utilization: 1.5, resetsAt: 1792567800 },
          "Bad-Name": { utilization: 0.1 },
          seven_day: { utilization: "0.2" },
          seven_day_opus: { utilization: 0.2, resetsAt: -1 },
        },
      }),
    ).toEqual({ seven_day_opus_used_fraction: 0.2 });
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`w${i}`, { utilization: 0.1 }]));
    expect(Object.keys(claudeUsageMetrics({ unifiedWindows: many }) ?? {})).toHaveLength(MAX_USAGE_WINDOWS);
  });

  it("declares exactly the captured windows with their lengths", () => {
    expect(CLAUDE_USAGE_WINDOWS).toEqual([
      { id: "five_hour", lengthSeconds: 18000 },
      { id: "seven_day", lengthSeconds: 604800 },
    ]);
  });
});
