/**
 * ADR-0071: `projects[].setup` in the configuration file. Defaults are filled in by the resolver, an unset key leaves
 * the project without a setup step, the schema refuses shapes outside the closed lists and bounds, and a `container`
 * project cannot carry it. (The dynamic-definition side, approval included, is in `src/mcp/project-tools.test.ts`.)
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalReasons } from "../projects/rules.js";
import { ConfigError, loadConfig, type ProjectConfig } from "./index.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-config-setup-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(obj: unknown): string {
  const p = path.join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
const config = (project: Record<string, unknown> = {}) => ({
  schema_version: 1,
  allowed_roots: [tmp],
  mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted", projects: ["web"] }],
  projects: [
    {
      id: "web",
      name: "Web",
      contexts: [{ id: "main", kind: "repository", path: path.join(tmp, "repo"), base_ref: "main" }],
      ...project,
    },
  ],
});
const errorOf = (cfg: unknown): string => {
  try {
    loadConfig({ configPath: write(cfg) });
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  return "";
};
const PNPM = [["corepack", "pnpm", "install", "--frozen-lockfile"]];

describe("projects[].setup (ADR-0071)", () => {
  it("resolves with the defaults: registry.npmjs.org, no cache, 600 seconds, no variables", () => {
    const c = loadConfig({ configPath: write(config({ setup: { commands: PNPM } })) });
    expect(c.projects[0]?.setup).toEqual({
      commands: PNPM,
      hosts: ["registry.npmjs.org"],
      cache: "none",
      timeoutSeconds: 600,
      env: {},
    });
    const full = loadConfig({
      configPath: write(
        config({
          setup: { commands: PNPM, network: { hosts: [] }, cache: "pnpm", timeout_seconds: 1800, env: { CI: "true" } },
        }),
      ),
    });
    expect(full.projects[0]?.setup).toEqual({
      commands: PNPM,
      hosts: [],
      cache: "pnpm",
      timeoutSeconds: 1800,
      env: { CI: "true" },
    });
    expect(loadConfig({ configPath: write(config()) }).projects[0]?.setup).toBeUndefined();
  });

  it("refuses shapes outside the closed lists and bounds", () => {
    for (const setup of [
      {},
      { commands: [] },
      { commands: [["pnpm"]], network: { hosts: ["evil.example:443"] } },
      { commands: [["pnpm"]], cache: "yarn" },
      { commands: [["pnpm"]], timeout_seconds: 0 },
      { commands: [["pnpm"]], env: { HOME: "/root" } },
      { commands: [["pnpm"]], shell: true },
    ]) {
      expect(errorOf(config({ setup })), JSON.stringify(setup)).toContain("setup");
    }
  });

  it("is refused on a container project (the sandbox and proxy are host mechanisms)", () => {
    expect(
      errorOf(
        config({
          environment: { kind: "container", image_digest: `sha256:${"a".repeat(64)}` },
          setup: { commands: PNPM },
        }),
      ),
    ).toContain("setup: only valid for a host environment");
  });

  it("a new or changed setup is a widening (project_setup); the same one or none is not", () => {
    const def = (setup?: ProjectConfig["setup"]): ProjectConfig => ({
      id: "web",
      name: "Web",
      contexts: [{ id: "main", kind: "repository", path: "/r", base_ref: "main" }],
      ...(setup !== undefined ? { setup } : {}),
    });
    const s = { commands: PNPM, cache: "pnpm" as const };
    expect(approvalReasons(def(s), undefined, "edit-untrusted")).toEqual(["project_setup"]);
    expect(approvalReasons(def(s), def(), "edit-untrusted")).toEqual(["project_setup"]);
    expect(approvalReasons(def({ ...s, timeout_seconds: 600 }), def(s), "edit-untrusted")).toEqual([]);
    expect(approvalReasons(def({ ...s, env: { CI: "1" } }), def(s), "edit-untrusted")).toEqual(["project_setup"]);
    expect(approvalReasons(def(), def(s), "edit-untrusted")).toEqual([]);
  });
});
