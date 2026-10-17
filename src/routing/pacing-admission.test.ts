/**
 * The LLD §16.9 pacing admission rule (T6.8, FR-CAP-10, BR-51) as a pure function of the eligibility input: which
 * candidates selection may pick, which are recorded `PACING_DEFERRED`, and the hold time.
 */
import { describe, expect, it } from "vitest";
import { PACING_DEFERRED, type PacingDeferral } from "../capacity/pacing-gate.js";
import { type EligibilityInput, pacingAdmission } from "./eligibility.js";

const deferral = (subscription: string, until: string): PacingDeferral => ({
  subscription,
  window: "w",
  until,
  source: "controller_estimated",
});
const EARLY = "2026-10-17T01:00:00.000Z";
const LATE = "2026-10-17T02:00:00.000Z";

function input(deferred: Record<string, PacingDeferral>, requiredProvider?: string): EligibilityInput {
  const providers = ["a", "b", "c"];
  return {
    candidates: providers,
    ...(requiredProvider !== undefined ? { requiredProvider } : {}),
    trustProfile: "edit-untrusted",
    clientMaxProfile: "edit-untrusted",
    requirements: { network: "off", writable: true },
    platform: "linux",
    facts: providers.map((provider) => ({
      provider,
      registered: true,
      enabled: true,
      ...(deferred[provider] !== undefined ? { pacingDeferred: deferred[provider] } : {}),
    })),
  } as EligibilityInput;
}

describe("pacing admission rule (T6.8, LLD §16.9)", () => {
  it("is undefined when no admissible candidate is deferred, so the decision is built as before", () => {
    expect(pacingAdmission(input({}), ["a", "b", "c"], null)).toBeUndefined();
    expect(pacingAdmission(input({ c: deferral("s", LATE) }), ["a", "b"], null)).toBeUndefined();
  });

  it("leaves a deferred candidate out while an undeferred eligible one remains", () => {
    expect(pacingAdmission(input({ a: deferral("s", LATE) }), ["a", "b", "c"], "a")).toEqual({
      pool: ["b", "c"],
      deferred: [{ provider: "a", verdict: PACING_DEFERRED, ...deferral("s", LATE) }],
      holdUntil: null,
    });
  });

  it("with every candidate deferred keeps the ones whose gate opens first and holds until that time", () => {
    const all = { a: deferral("s1", LATE), b: deferral("s2", EARLY), c: deferral("s3", EARLY) };
    const r = pacingAdmission(input(all), ["a", "b", "c"], null);
    expect(r?.pool).toEqual(["b", "c"]);
    expect(r?.holdUntil).toBe(EARLY);
    expect(r?.deferred.map((d) => d.provider)).toEqual(["a", "b", "c"]);
  });

  it("with every candidate deferred a held affine provider stays the choice and waits for its own gate", () => {
    const all = { a: deferral("s1", LATE), b: deferral("s2", EARLY), c: deferral("s3", EARLY) };
    const r = pacingAdmission(input(all), ["a", "b", "c"], "a");
    expect(r?.pool).toEqual(["a", "b", "c"]);
    expect(r?.holdUntil).toBe(LATE);
  });

  it("require_provider narrows nothing and waits on its own gate", () => {
    const r = pacingAdmission(input({ a: deferral("s1", LATE) }, "a"), ["a"], null);
    expect(r).toEqual({
      pool: ["a"],
      deferred: [{ provider: "a", verdict: PACING_DEFERRED, ...deferral("s1", LATE) }],
      holdUntil: LATE,
    });
  });
});
