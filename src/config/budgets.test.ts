/**
 * T14.4 (FR-CTL-06, LLD §3.4.6): `control_plane.budgets` loads with every cap unset by default (unlimited, not zero and
 * no invented default), resolves global and per-project caps, and refuses malformed sections naming the key only.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasAnyCap, loadConfig, NO_BUDGETS } from "./index.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-budgetcfg-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const load = (controlPlane?: unknown) => {
  const p = path.join(tmp, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: 1,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
      ...(controlPlane !== undefined ? { control_plane: controlPlane } : {}),
    }),
  );
  return loadConfig({ configPath: p });
};
const errorOf = (controlPlane: unknown): string => {
  try {
    load(controlPlane);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the config to be refused");
};

describe("control_plane.budgets config (T14.4)", () => {
  it("every cap is unset when the section is absent or empty: unlimited, never a number", () => {
    for (const cfg of [undefined, {}, { budgets: {} }, { budgets: { global: {}, projects: {} } }]) {
      const { budgets } = load(cfg).controlPlane;
      expect(budgets.global).toEqual({});
      expect(budgets.projects.size).toBe(0);
      expect(hasAnyCap(budgets.global)).toBe(false);
    }
    expect(hasAnyCap(NO_BUDGETS.global)).toBe(false);
  });

  it("resolves global caps and a per-project override with the LLD §3.4.6 keys; a cap of 0 is kept as written", () => {
    const { budgets } = load({
      budgets: {
        global: { runs_per_day: 200, concurrent_runs: 8 },
        projects: {
          "acme-api": {
            runs_per_day: 0,
            concurrent_runs: 2,
            wall_clock_per_run_seconds: 7200,
            usage_per_window: { window_seconds: 86400, max_reported_tokens: 100000 },
          },
        },
      },
    }).controlPlane;
    expect(budgets.global).toEqual({ runsPerDay: 200, concurrentRuns: 8 });
    expect(budgets.projects.get("acme-api")).toEqual({
      runsPerDay: 0,
      concurrentRuns: 2,
      wallClockPerRunSeconds: 7200,
      usagePerWindow: { windowSeconds: 86400, maxReportedTokens: 100000 },
    });
    expect(hasAnyCap(budgets.projects.get("acme-api") ?? {})).toBe(true);
  });

  it("refuses an unknown key, a negative or fractional cap, a short window and an incomplete window object", () => {
    expect(errorOf({ budgets: { global: { runs_per_hour: 1 } } })).toMatch(
      /\$\.control_plane\.budgets\.global\.runs_per_hour/,
    );
    expect(errorOf({ budgets: { global: { runs_per_day: -1 } } })).toMatch(
      /\$\.control_plane\.budgets\.global\.runs_per_day/,
    );
    expect(errorOf({ budgets: { global: { concurrent_runs: 1.5 } } })).toMatch(
      /\$\.control_plane\.budgets\.global\.concurrent_runs/,
    );
    expect(
      errorOf({ budgets: { global: { usage_per_window: { window_seconds: 10, max_reported_tokens: 1 } } } }),
    ).toMatch(/usage_per_window\.window_seconds/);
    expect(errorOf({ budgets: { global: { usage_per_window: { window_seconds: 3600 } } } })).toMatch(
      /usage_per_window.*max_reported_tokens/,
    );
    expect(errorOf({ budgets: { projects: { "Bad Id": { runs_per_day: 1 } } } })).toMatch(
      /\$\.control_plane\.budgets\.projects/,
    );
    expect(errorOf({ loop: {} })).toMatch(/\$\.control_plane\.loop: unknown key/);
  });
});
