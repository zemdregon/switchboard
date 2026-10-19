/**
 * T14.17 (FR-CTL-15, LLD §20.13): `projects[].critic` is off by default, resolves `min_diff_lines` to the Assumption
 * default of 400, and an invalid value aborts startup (fail closed) instead of being ignored or clamped.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";
import { projectSchema } from "./schema.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-critic-cfg-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const repoCtx = { id: "main", kind: "repository", path: "/x", base_ref: "main" };
const load = (critic?: unknown) => {
  const p = path.join(tmp, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: 1,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
      projects: [{ id: "web", name: "Web", contexts: [repoCtx], ...(critic !== undefined ? { critic } : {}) }],
    }),
  );
  return loadConfig({ configPath: p });
};

describe("advisory critic config (T14.17)", () => {
  it("is off by default", () => {
    expect(load().projects[0]?.critic).toBeUndefined();
    expect(load({}).projects[0]?.critic).toEqual({ enabled: false, minDiffLines: 400 });
  });

  it("resolves enabled and min_diff_lines", () => {
    expect(load({ enabled: true }).projects[0]?.critic).toEqual({ enabled: true, minDiffLines: 400 });
    expect(load({ enabled: true, min_diff_lines: 25 }).projects[0]?.critic).toEqual({
      enabled: true,
      minDiffLines: 25,
    });
  });

  it.each([0, -1, 1.5, 1_000_001, "400", null])("rejects min_diff_lines %j", (min_diff_lines) => {
    expect(() => load({ enabled: true, min_diff_lines })).toThrow(/min_diff_lines/);
  });

  it("rejects an unknown key and stays out of dynamic project definitions", () => {
    expect(() => load({ enabled: true, provider: "codex" })).toThrow(/critic/);
    expect("critic" in projectSchema.properties).toBe(false);
  });
});
