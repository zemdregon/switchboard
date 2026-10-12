import { describe, expect, it } from "vitest";
import { createIdGenerator, isPrefixedId } from "./index.js";

describe("ids", () => {
  it("produces prefixed 26-char ULIDs", () => {
    const g = createIdGenerator();
    const id = g.id("sess");
    expect(id).toMatch(/^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isPrefixedId(id, "sess")).toBe(true);
    expect(isPrefixedId(id, "run")).toBe(false);
  });

  it("is strictly increasing within one millisecond", () => {
    const g = createIdGenerator({ now: () => 1_700_000_000_000 });
    const ids = Array.from({ length: 2000 }, () => g.ulid());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("carries the increment across digits and stays monotonic if the clock goes backwards", () => {
    let t = 1000;
    const g = createIdGenerator({ now: () => t, randomDigits: (n) => Array.from({ length: n }, () => 31) });
    const a = g.ulid();
    expect(() => g.ulid()).toThrow(RangeError); // all-ones random part overflows
    const g2 = createIdGenerator({ now: () => t, randomDigits: (n) => [...Array(n - 1).fill(0), 31] });
    const b = g2.ulid();
    t = 500; // regression
    const c = g2.ulid();
    expect(c > b).toBe(true);
    expect(c.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a).toHaveLength(26);
  });

  it("sorts by time across milliseconds", () => {
    let t = 1;
    const g = createIdGenerator({ now: () => t });
    const first = g.ulid();
    t = 2;
    expect(g.ulid() > first).toBe(true);
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => createIdGenerator({ now: () => -1 }).ulid()).toThrow(RangeError);
  });
});
