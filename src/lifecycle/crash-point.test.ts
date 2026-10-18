import { describe, expect, it } from "vitest";
import { armedCrashPoint, CRASH_POINTS, TEST_CRASH_AT_ENV } from "./crash-point.js";

const SOURCE = "file:///repo/src/lifecycle/crash-point.ts";
const BUILT = "file:///repo/dist/lifecycle/crash-point.js";

describe("named crash points are test-only (T1.9, TDD §3.6)", () => {
  it("arms a named point only with NODE_ENV=test, the explicit variable and the TypeScript source", () => {
    for (const point of CRASH_POINTS) {
      expect(armedCrashPoint({ NODE_ENV: "test", [TEST_CRASH_AT_ENV]: point }, SOURCE)).toBe(point);
    }
  });

  it("is inert in production: without NODE_ENV=test, from the built dist, or with the variable unset or empty", () => {
    expect(armedCrashPoint({ [TEST_CRASH_AT_ENV]: "leased" }, SOURCE)).toBeUndefined();
    expect(armedCrashPoint({ NODE_ENV: "production", [TEST_CRASH_AT_ENV]: "leased" }, SOURCE)).toBeUndefined();
    expect(armedCrashPoint({ NODE_ENV: "test", [TEST_CRASH_AT_ENV]: "leased" }, BUILT)).toBeUndefined();
    expect(armedCrashPoint({ NODE_ENV: "test" }, SOURCE)).toBeUndefined();
    expect(armedCrashPoint({ NODE_ENV: "test", [TEST_CRASH_AT_ENV]: "" }, SOURCE)).toBeUndefined();
  });

  it("refuses an unknown point name under test instead of silently never crashing", () => {
    expect(() => armedCrashPoint({ NODE_ENV: "test", [TEST_CRASH_AT_ENV]: "RUNNING" }, SOURCE)).toThrow(
      /not a crash point/,
    );
  });
});
