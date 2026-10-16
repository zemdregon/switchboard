import { describe, expect, it } from "vitest";
import {
  computeNextFireUtc,
  cronMatches,
  formatMinuteAnchor,
  InvalidCronError,
  isSameUtcMinute,
  validateCronExpr,
} from "./cron.js";

describe("UTC cron evaluation (LLD §18.5, FR-QUE-02)", () => {
  describe("validateCronExpr", () => {
    it("accepts valid 5-field UTC cron expressions", () => {
      expect(() => validateCronExpr("* * * * *")).not.toThrow();
      expect(() => validateCronExpr("0 0 * * *")).not.toThrow();
      expect(() => validateCronExpr("*/15 9-17 * * 1-5")).not.toThrow();
      expect(() => validateCronExpr("0,30 * * * 0,7")).not.toThrow();
      expect(() => validateCronExpr("59 23 31 12 7")).not.toThrow();
      expect(() => validateCronExpr("0 12 1 1 *")).not.toThrow();
    });

    it("rejects wrong field counts", () => {
      expect(() => validateCronExpr("")).toThrow(InvalidCronError);
      expect(() => validateCronExpr("* * * *")).toThrow(/exactly 5 fields/u);
      expect(() => validateCronExpr("* * * * * *")).toThrow(/exactly 5 fields/u);
    });

    it("rejects non-standard aliases and text", () => {
      expect(() => validateCronExpr("@yearly")).toThrow(InvalidCronError);
      expect(() => validateCronExpr("@daily")).toThrow(InvalidCronError);
      expect(() => validateCronExpr("0 0 * JAN *")).toThrow(InvalidCronError);
      expect(() => validateCronExpr("0 0 * * MON")).toThrow(InvalidCronError);
      expect(() => validateCronExpr("* * * * ?")).toThrow(InvalidCronError);
    });

    it("rejects out-of-range values", () => {
      expect(() => validateCronExpr("60 * * * *")).toThrow(/out of range/u);
      expect(() => validateCronExpr("* 24 * * *")).toThrow(/out of range/u);
      expect(() => validateCronExpr("* * 0 * *")).toThrow(/out of range/u);
      expect(() => validateCronExpr("* * 32 * *")).toThrow(/out of range/u);
      expect(() => validateCronExpr("* * * 0 *")).toThrow(/out of range/u);
      expect(() => validateCronExpr("* * * 13 *")).toThrow(/out of range/u);
      expect(() => validateCronExpr("* * * * 8")).toThrow(/out of range/u);
    });

    it("rejects invalid steps and ranges", () => {
      expect(() => validateCronExpr("*/0 * * * *")).toThrow(/positive/u);
      expect(() => validateCronExpr("*/-1 * * * *")).toThrow(InvalidCronError);
      expect(() => validateCronExpr("5-2 * * * *")).toThrow(/greater than end/u);
      expect(() => validateCronExpr("1, * * * *")).toThrow(InvalidCronError);
      expect(() => validateCronExpr("*/ * * * *")).toThrow(InvalidCronError);
      expect(() => validateCronExpr("*//2 * * * *")).toThrow(InvalidCronError);
    });
  });

  describe("cronMatches", () => {
    it("matches wildcards", () => {
      const d = new Date("2026-10-16T11:05:30.000Z");
      expect(cronMatches("* * * * *", d)).toBe(true);
    });

    it("matches exact minute and hour", () => {
      const d = new Date("2026-10-16T11:05:00.000Z");
      expect(cronMatches("5 11 * * *", d)).toBe(true);
      expect(cronMatches("6 11 * * *", d)).toBe(false);
      expect(cronMatches("5 12 * * *", d)).toBe(false);
    });

    it("treats 0 and 7 both as Sunday (S12, LLD §18.5)", () => {
      // 2026-10-18 is Sunday (UTC)
      const sunday = new Date("2026-10-18T12:00:00.000Z");
      expect(sunday.getUTCDay()).toBe(0);

      expect(cronMatches("* * * * 0", sunday)).toBe(true);
      expect(cronMatches("* * * * 7", sunday)).toBe(true);
      expect(cronMatches("* * * * 1", sunday)).toBe(false);

      // Friday 2026-10-16 (day 5)
      const friday = new Date("2026-10-16T12:00:00.000Z");
      expect(cronMatches("* * * * 5", friday)).toBe(true);
      expect(cronMatches("* * * * 0", friday)).toBe(false);
      expect(cronMatches("* * * * 7", friday)).toBe(false);
    });

    it("evaluates Vixie cron DOM/DOW OR-logic when both are restricted", () => {
      // 2026-10-16 is Friday (DOW 5), DOM 16
      const d = new Date("2026-10-16T12:00:00.000Z");

      // Matching DOM (16), non-matching DOW (1 = Mon): should match because DOM matches
      expect(cronMatches("0 12 16 * 1", d)).toBe(true);

      // Non-matching DOM (17), matching DOW (5 = Fri): should match because DOW matches
      expect(cronMatches("0 12 17 * 5", d)).toBe(true);

      // Neither matching: should not match
      expect(cronMatches("0 12 17 * 1", d)).toBe(false);
    });

    it("respects UTC boundary (S12)", () => {
      // Midnight UTC: 0 0 * * *
      const justBefore = new Date("2026-10-15T23:59:59.000Z");
      const midnight = new Date("2026-10-16T00:00:00.000Z");
      const justAfter = new Date("2026-10-16T00:01:00.000Z");

      expect(cronMatches("0 0 * * *", justBefore)).toBe(false);
      expect(cronMatches("0 0 * * *", midnight)).toBe(true);
      expect(cronMatches("0 0 * * *", justAfter)).toBe(false);
    });
  });

  describe("formatMinuteAnchor and isSameUtcMinute", () => {
    it("formats ISO string truncated to minute", () => {
      const d = new Date("2026-10-16T11:05:45.123Z");
      expect(formatMinuteAnchor(d)).toBe("2026-10-16T11:05:00.000Z");
    });

    it("detects same UTC minute", () => {
      expect(isSameUtcMinute("2026-10-16T11:05:10.000Z", "2026-10-16T11:05:59.999Z")).toBe(true);
      expect(isSameUtcMinute("2026-10-16T11:05:00.000Z", "2026-10-16T11:06:00.000Z")).toBe(false);
      expect(isSameUtcMinute("invalid", "2026-10-16T11:05:00.000Z")).toBe(false);
    });
  });

  describe("computeNextFireUtc", () => {
    it("computes the next matching minute", () => {
      const from = new Date("2026-10-16T11:05:00.000Z");
      const next = computeNextFireUtc("*/10 * * * *", from);
      expect(next?.toISOString()).toBe("2026-10-16T11:10:00.000Z");
    });

    it("returns undefined when no match within maxMinutes", () => {
      const from = new Date("2026-10-16T11:05:00.000Z");
      // Feb 30 does not exist
      const next = computeNextFireUtc("0 0 30 2 *", from, 2000);
      expect(next).toBeUndefined();
    });
  });
});
