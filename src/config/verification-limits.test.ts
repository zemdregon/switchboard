/** T3.22 (FR-EXE-09, LLD §8.1): `limits.verification_*` keys; absent keys leave the controller as before. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-vlimits-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const load = (limits?: Record<string, unknown>) => {
  const p = path.join(tmp, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: 1,
      allowed_roots: [tmp],
      data_dir: path.join(tmp, "data"),
      mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
      ...(limits ? { limits } : {}),
    }),
  );
  return loadConfig({ configPath: p });
};

describe("limits.verification_* (T3.22)", () => {
  it("no key: no limiter at all (the T3.10 stage, unchanged)", () => {
    expect(load().verificationLimits).toBeUndefined();
    expect(load({ global_concurrency: 2 }).verificationLimits).toBeUndefined();
    expect("verificationLimits" in load()).toBe(false);
  });

  it("any key turns it on; unset keys take the Assumption defaults (2 slots, nice 10, no variable)", () => {
    expect(load({ verification_slots: 3 }).verificationLimits).toEqual({ slots: 3, nice: 10, env: {} });
    expect(load({ verification_nice: 0 }).verificationLimits).toEqual({ slots: 2, nice: 0, env: {} });
    expect(load({ verification_env: { VITEST_MAX_WORKERS: "2" } }).verificationLimits).toEqual({
      slots: 2,
      nice: 10,
      env: { VITEST_MAX_WORKERS: "2" },
    });
  });

  it("refuses out-of-range values and variables that are not plain parallelism names", () => {
    expect(() => load({ verification_slots: 0 })).toThrow(/verification_slots/);
    expect(() => load({ verification_nice: 20 })).toThrow(/verification_nice/);
    for (const name of ["PATH", "HOME", "GIT_DIR", "LD_PRELOAD", "SSH_AUTH_SOCK", "NODE_OPTIONS", "lower"]) {
      expect(() => load({ verification_env: { [name]: "1" } }), name).toThrow(/verification_env/);
    }
    expect(() => load({ verification_env: { JOBS: 2 } })).toThrow(/verification_env/);
  });
});
