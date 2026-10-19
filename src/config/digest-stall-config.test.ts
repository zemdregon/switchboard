/**
 * T14.16 (FR-CTL-14, LLD §20.5): `control_plane.digest_schedule` and `projects[].queue.stall_hours` are off by default,
 * resolve when set, and an invalid value aborts startup (fail closed) instead of being ignored or clamped.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cronMatches } from "../schedule/cron.js";
import { loadConfig } from "./index.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-digest-stall-cfg-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const repoCtx = { id: "main", kind: "repository", path: "/x", base_ref: "main" };
const load = (extra: { control_plane?: unknown; queue?: unknown }) => {
  const p = path.join(tmp, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: 1,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
      projects: [{ id: "web", name: "Web", contexts: [repoCtx], ...(extra.queue ? { queue: extra.queue } : {}) }],
      ...(extra.control_plane ? { control_plane: extra.control_plane } : {}),
    }),
  );
  return loadConfig({ configPath: p });
};

describe("digest schedule and stall window config (T14.16)", () => {
  it("is off by default", () => {
    const c = load({});
    expect(c.controlPlane.digestSchedule).toBeUndefined();
    expect(c.projects[0]?.queue?.stallHours).toBeUndefined();
  });

  it("resolves a digest schedule and a stall window", () => {
    const c = load({ control_plane: { digest_schedule: { cron: "*/30 * * * *" } }, queue: { stall_hours: 6 } });
    const cron = c.controlPlane.digestSchedule?.cron;
    expect(cron?.expr).toBe("*/30 * * * *");
    expect(cron && cronMatches(cron, new Date("2026-10-19T10:30:00Z"))).toBe(true);
    expect(c.projects[0]?.queue).toEqual({ stallHours: 6 });
    expect(load({ queue: { low_water: 2, stall_hours: 1 } }).projects[0]?.queue).toEqual({
      lowWater: 2,
      stallHours: 1,
    });
  });

  it.each([0, -1, 1.5, 721, "6", null])("rejects stall_hours %j", (stall_hours) => {
    expect(() => load({ queue: { stall_hours } })).toThrow(/stall_hours/);
  });

  it.each(["", "* * * *", "60 * * * *", "@hourly", "* * * * * *"])("rejects digest cron %j", (cron) => {
    expect(() => load({ control_plane: { digest_schedule: { cron } } })).toThrow(/digest_schedule/);
  });

  it("rejects an unknown digest_schedule key", () => {
    expect(() => load({ control_plane: { digest_schedule: { cron: "0 * * * *", sink: "ops" } } })).toThrow(
      /digest_schedule/,
    );
  });
});
