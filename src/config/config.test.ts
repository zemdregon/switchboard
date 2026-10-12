import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, isUnderAllowedRoot, loadConfig, resolveConfigPath } from "./index.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-config-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(obj: unknown): string {
  const p = path.join(tmp, "config.json");
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
}
const base = () => ({
  schema_version: 1,
  allowed_roots: [tmp],
  mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
});

describe("loadConfig", () => {
  it("loads a valid config and applies concurrency defaults", () => {
    const c = loadConfig({ configPath: write({ ...base(), data_dir: path.join(tmp, "data") }) });
    expect(c.limits).toEqual({ globalConcurrency: 4, perProviderConcurrency: 1 });
    expect(c.mcpClients.get("main")?.maxTrustProfile).toBe("edit-untrusted");
    expect(c.dataDir).toBe(path.join(tmp, "data"));
  });

  it("rejects an unknown top-level key with its path", () => {
    expect(() => loadConfig({ configPath: write({ ...base(), surprise: 1 }) })).toThrow(/\$\.surprise: unknown key/);
  });

  it("rejects an unknown nested key", () => {
    const cfg = { ...base(), limits: { global_concurrency: 2, bogus: true } };
    expect(() => loadConfig({ configPath: write(cfg) })).toThrow(/\$\.limits\.bogus: unknown key/);
  });

  it("rejects a missing schema_version", () => {
    const { schema_version: _omit, ...rest } = base();
    expect(() => loadConfig({ configPath: write(rest) })).toThrow(/\$\.schema_version: required property is missing/);
  });

  it("rejects a wrong schema_version", () => {
    expect(() => loadConfig({ configPath: write({ ...base(), schema_version: 2 }) })).toThrow(
      /\$\.schema_version: must equal 1/,
    );
  });

  it("rejects a bad trust profile with the JSON path and allowed values", () => {
    const cfg = { ...base(), mcp_clients: [{ id: "main", max_trust_profile: "yolo" }] };
    expect(() => loadConfig({ configPath: write(cfg) })).toThrow(
      /\$\.mcp_clients\[0\]\.max_trust_profile: must be one of inspect-untrusted/,
    );
  });

  it("rejects wrong types and out-of-range values", () => {
    const cfg = { ...base(), limits: { global_concurrency: 0 }, providers: { codex: { weight: 2 } } };
    expect(() => loadConfig({ configPath: write(cfg) })).toThrow(/\$\.limits\.global_concurrency: must be >= 1/);
    expect(() => loadConfig({ configPath: write(cfg) })).toThrow(/\$\.providers\.codex\.weight: must be <= 1/);
  });

  it("rejects unknown providers, duplicate client ids, unparseable JSON, missing file", () => {
    expect(() => loadConfig({ configPath: write({ ...base(), providers: { nope: {} } }) })).toThrow(
      /\$\.providers\.nope/,
    );
    const dup = { ...base(), mcp_clients: [base().mcp_clients[0], base().mcp_clients[0]] };
    expect(() => loadConfig({ configPath: write(dup) })).toThrow(/duplicate client id/);
    expect(() => loadConfig({ configPath: write("{not json") })).toThrow(/not valid JSON/);
    expect(() => loadConfig({ configPath: path.join(tmp, "missing.json") })).toThrow(ConfigError);
  });

  it("rejects an allowed root that does not exist", () => {
    const cfg = { ...base(), allowed_roots: [path.join(tmp, "nope")] };
    expect(() => loadConfig({ configPath: write(cfg) })).toThrow(/\$\.allowed_roots\[0\]: cannot resolve/);
  });

  it("canonicalizes a symlinked allowed root and enforces the prefix check", () => {
    const real = path.join(tmp, "real");
    mkdirSync(real);
    const link = path.join(tmp, "link");
    symlinkSync(real, link);
    const c = loadConfig({ configPath: write({ ...base(), allowed_roots: [link] }) });
    expect(c.allowedRoots).toEqual([real]);
    expect(isUnderAllowedRoot(path.join(real, "proj"), c.allowedRoots)).toBe(true);
    expect(isUnderAllowedRoot(`${real}-evil`, c.allowedRoots)).toBe(false);
  });

  it("canonicalizes a data_dir that does not exist yet through a symlinked parent", () => {
    const real = path.join(tmp, "realdata");
    mkdirSync(real);
    symlinkSync(real, path.join(tmp, "datalink"));
    const c = loadConfig({ configPath: write({ ...base(), data_dir: path.join(tmp, "datalink", "sb") }) });
    expect(c.dataDir).toBe(path.join(real, "sb"));
  });
});

describe("resolveConfigPath", () => {
  it("prefers --config, then SWITCHBOARD_CONFIG, then XDG, then ~/.config", () => {
    const env = { SWITCHBOARD_CONFIG: "/e/c.json", XDG_CONFIG_HOME: "/x" };
    expect(resolveConfigPath({ argv: ["serve", "--config", "/f/c.json"], env })).toBe("/f/c.json");
    expect(resolveConfigPath({ argv: ["--config=/g/c.json"], env })).toBe("/g/c.json");
    expect(resolveConfigPath({ argv: [], env })).toBe("/e/c.json");
    expect(resolveConfigPath({ argv: [], env: { XDG_CONFIG_HOME: "/x" } })).toBe("/x/switchboard/config.json");
    expect(resolveConfigPath({ argv: [], env: {}, homedir: "/h" })).toBe("/h/.config/switchboard/config.json");
    expect(() => resolveConfigPath({ argv: ["--config"], env: {} })).toThrow(/requires a path/);
  });
});
