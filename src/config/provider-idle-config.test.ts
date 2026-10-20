/**
 * FR-EXE-01 (LLD §8, ADR-0068; Delegated): `projects[].timeouts.provider_idle_seconds` is absent by default (the adapter's
 * 300-second window stands), resolves to milliseconds, and an out-of-bounds value aborts startup (fail closed).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_IDLE_MS } from "../exec/index.js";
import { loadConfig } from "./index.js";
import { projectSchema } from "./schema.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-idle-cfg-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const repoCtx = { id: "main", kind: "repository", path: "/x", base_ref: "main" };
const load = (timeouts?: unknown) => {
  const p = path.join(tmp, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: 1,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
      projects: [{ id: "web", name: "Web", contexts: [repoCtx], ...(timeouts !== undefined ? { timeouts } : {}) }],
    }),
  );
  return loadConfig({ configPath: p });
};

describe("projects[].timeouts.provider_idle_seconds (FR-EXE-01)", () => {
  it("is absent by default: the adapter default of 300 seconds applies", () => {
    expect(load().projects[0]?.providerIdleMs).toBeUndefined();
    expect(load({}).projects[0]?.providerIdleMs).toBeUndefined();
    expect(DEFAULT_IDLE_MS).toBe(300_000);
  });

  it("resolves seconds to milliseconds", () => {
    expect(load({ provider_idle_seconds: 900 }).projects[0]?.providerIdleMs).toBe(900_000);
  });

  it.each([0, 59, 3601, 1.5, "900", null])("rejects provider_idle_seconds %j", (provider_idle_seconds) => {
    expect(() => load({ provider_idle_seconds })).toThrow(/provider_idle_seconds/);
  });

  it("rejects an unknown key and stays out of dynamic project definitions", () => {
    expect(() => load({ wall_clock_seconds: 60 })).toThrow(/timeouts/);
    expect("timeouts" in projectSchema.properties).toBe(false);
  });
});
