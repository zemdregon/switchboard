/** NFR-SEC-04: classification of the effective uid that `serve` and `doctor` check (`./unprivileged.ts`). */
import { describe, expect, it } from "vitest";
import { checkUnprivileged, defaultEffectiveUid } from "./unprivileged.js";

describe("checkUnprivileged (NFR-SEC-04)", () => {
  it("accepts any non-zero uid", () => {
    expect(checkUnprivileged(() => 1000)).toEqual({ ok: true, uid: 1000 });
    expect(checkUnprivileged(() => 1)).toEqual({ ok: true, uid: 1 });
  });

  it("refuses uid 0", () => {
    expect(checkUnprivileged(() => 0)).toMatchObject({ ok: false, code: "RUNNING_AS_ROOT" });
  });

  it("fails closed when the uid is missing, malformed or the getter throws", () => {
    for (const getter of [
      () => undefined,
      () => Number.NaN,
      () => -1,
      () => 1.5,
      () => {
        throw new Error("no uid here");
      },
    ]) {
      expect(checkUnprivileged(getter)).toMatchObject({ ok: false, code: "UID_UNKNOWN" });
    }
  });

  it("defaults to the process effective uid", () => {
    expect(defaultEffectiveUid()).toBe(typeof process.geteuid === "function" ? process.geteuid() : undefined);
  });
});
