/**
 * The Q-61 rule (T5.6; ADR-0038 item 8, LLD §15.7 step 3): one constant, fail closed while ROADMAP Q-61 is open.
 */
import { describe, expect, it } from "vitest";
import {
  PRIVILEGED_CROSS_PROVIDER,
  PRIVILEGED_CROSS_PROVIDER_REASON,
  refusesPrivilegedCrossProvider,
} from "./policy.js";

describe("PRIVILEGED_CROSS_PROVIDER (Q-61)", () => {
  it("is the fail-closed default until zemdregon answers Q-61", () => {
    expect(PRIVILEGED_CROSS_PROVIDER).toBe("refuse");
    expect(PRIVILEGED_CROSS_PROVIDER_REASON).toBe("PRIVILEGED_CROSS_PROVIDER");
  });

  it("refuses only a privileged continuation to another provider", () => {
    expect(refusesPrivilegedCrossProvider("privileged", "fake", "fake-b")).toBe(true);
    expect(refusesPrivilegedCrossProvider("privileged", "fake", "fake")).toBe(false);
    for (const p of ["inspect-untrusted", "edit-untrusted", "trusted-development"]) {
      expect(refusesPrivilegedCrossProvider(p, "fake", "fake-b")).toBe(false);
    }
  });

  it("an answer of 'allowed' is the one-line change of the constant", () => {
    expect(refusesPrivilegedCrossProvider("privileged", "fake", "fake-b", "allow_under_approval")).toBe(false);
  });
});
