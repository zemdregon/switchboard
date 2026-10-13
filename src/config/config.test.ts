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

describe("timeouts.preflight_ttl_seconds (T3.21)", () => {
  it("defaults to 60 seconds, parses a value and 0 (disabled), and rejects bad values", () => {
    expect(loadConfig({ configPath: write(base()) }).preflightTtlMs).toBe(60_000);
    expect(
      loadConfig({ configPath: write({ ...base(), timeouts: { preflight_ttl_seconds: 5 } }) }).preflightTtlMs,
    ).toBe(5000);
    expect(
      loadConfig({ configPath: write({ ...base(), timeouts: { preflight_ttl_seconds: 0 } }) }).preflightTtlMs,
    ).toBe(0);
    for (const timeouts of [
      { preflight_ttl_seconds: -1 },
      { preflight_ttl_seconds: 1.5 },
      { preflight_ttl_seconds: 3601 },
      { preflight_ttl_seconds: "60" },
      { bogus: 1 },
    ]) {
      expect(() => loadConfig({ configPath: write({ ...base(), timeouts }) })).toThrow(ConfigError);
    }
  });
});

describe("retention and profiles config (T3.2)", () => {
  it("defaults retention to 30 days and a 24 hour interval, and no overrides", () => {
    const c = loadConfig({ configPath: write(base()) });
    expect(c.retention).toEqual({ days: 30, intervalMs: 86_400_000 });
    expect(c.retentionEnabled).toBe(false); // the default is a value, not a switch (T3.12)
    expect(c.profileOverrides).toEqual({});
  });

  it("parses retention.days and retention.interval and rejects bad values", () => {
    const c = loadConfig({
      configPath: write({ ...base(), retention: { days: 7, interval: "90m" } }),
    });
    expect(c.retention).toEqual({ days: 7, intervalMs: 5_400_000 });
    expect(c.retentionEnabled).toBe(true);
    expect(loadConfig({ configPath: write({ ...base(), retention: { interval: "1h" } }) }).retentionEnabled).toBe(
      false,
    );
    for (const retention of [{ days: 0 }, { days: 1.5 }, { interval: "soon" }, { interval: "0h" }, { bogus: 1 }]) {
      expect(() => loadConfig({ configPath: write({ ...base(), retention }) })).toThrow(ConfigError);
    }
  });

  it("maps profiles.<name> overrides to the policy form", () => {
    const profiles = {
      "test-sandboxed": {
        shell_allowlist: ["npm test"],
        repo_config: "approved-only",
      },
    };
    const c = loadConfig({ configPath: write({ ...base(), profiles }) });
    expect(c.profileOverrides).toEqual({
      "test-sandboxed": {
        shellAllowlist: ["npm test"],
        repoConfig: "approved-only",
      },
    });
  });

  it("rejects unknown profiles (privileged included), unknown fields, bad values and inconsistent overrides", () => {
    const load = (profiles: unknown) => () => loadConfig({ configPath: write({ ...base(), profiles }) });
    expect(load({ privileged: {} })).toThrow(/\$\.profiles\.privileged: unknown key/);
    expect(load({ "*": {} })).toThrow(/\$\.profiles\.\*: unknown key/);
    expect(load({ "edit-untrusted": { bypass_approved: true } })).toThrow(/unknown key/);
    expect(load({ "edit-untrusted": { network: "everything" } })).toThrow(/network: must be one of/);
    expect(load({ "edit-untrusted": { shell_allowlist: ["*"] } })).toThrow(
      /\$\.profiles\.edit-untrusted\.shell_allowlist: a wildcard/,
    );
    expect(load({ "inspect-untrusted": { shell_allowlist: ["ls"] } })).toThrow(/requires shell to be "allowlist"/);
  });
});

describe("mcp_clients[].privileged_approval (owner decision 22, ADR-0019)", () => {
  const clients = (...entries: Record<string, unknown>[]) => ({ ...base(), mcp_clients: entries });

  it("defaults to required (the restrictive value) and accepts both values on a privileged ceiling", () => {
    const c = loadConfig({
      configPath: write(
        clients(
          { id: "plain", max_trust_profile: "edit-untrusted" },
          { id: "ops", max_trust_profile: "privileged" },
          { id: "strict", max_trust_profile: "privileged", privileged_approval: "required" },
          { id: "loose", max_trust_profile: "privileged", privileged_approval: "not_required" },
        ),
      ),
    });
    expect(c.mcpClients.get("plain")).toEqual({
      id: "plain",
      maxTrustProfile: "edit-untrusted",
      privilegedApproval: "required",
    });
    expect(c.mcpClients.get("ops")?.privilegedApproval).toBe("required");
    expect(c.mcpClients.get("strict")?.privilegedApproval).toBe("required");
    expect(c.mcpClients.get("loose")?.privilegedApproval).toBe("not_required");
  });

  it("is a closed enum: other values and types fail with the JSON path and the allowed values", () => {
    for (const value of ["none", "NOT_REQUIRED", true, null, ""]) {
      const cfg = clients({ id: "ops", max_trust_profile: "privileged", privileged_approval: value });
      expect(() => loadConfig({ configPath: write(cfg) }), String(value)).toThrow(
        /\$\.mcp_clients\[0\]\.privileged_approval: must be one of required, not_required/,
      );
    }
  });

  it("refuses not_required below a privileged ceiling, naming the entry, the client and its ceiling", () => {
    const cfg = clients(
      { id: "ops", max_trust_profile: "privileged" },
      { id: "dev", max_trust_profile: "trusted-development", privileged_approval: "not_required" },
    );
    expect(() => loadConfig({ configPath: write(cfg) })).toThrow(
      /\$\.mcp_clients\[1\]\.privileged_approval: not_required applies only to a client whose max_trust_profile is privileged \(client "dev" has trusted-development\)/,
    );
    // required below the ceiling is harmless and accepted.
    const ok = clients({ id: "dev", max_trust_profile: "edit-untrusted", privileged_approval: "required" });
    expect(loadConfig({ configPath: write(ok) }).mcpClients.get("dev")?.privilegedApproval).toBe("required");
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

describe("projects[] (T9.1, FR-PRJ-01, 02, 04)", () => {
  const repoCtx = { id: "main", kind: "repository", path: "/x", base_ref: "main" };
  const withProjects = (...projects: unknown[]) => write({ ...base(), projects });

  it("loads without projects as before, and resolves defaults when present", () => {
    expect(loadConfig({ configPath: write(base()) }).projects).toEqual([]);
    const c = loadConfig({ configPath: withProjects({ id: "web-app", name: "Web", contexts: [repoCtx] }) });
    expect(c.projects[0]).toMatchObject({
      id: "web-app",
      environment: { kind: "host" },
      contexts: [{ primary: true, writable: true, push: { policy: "none" }, sign: false }],
    });
  });

  it("rejects an unknown context kind with the path and allowed values", () => {
    expect(() =>
      loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts: [{ ...repoCtx, kind: "db" }] }) }),
    ).toThrow(/\$\.projects\[0\]\.contexts\[0\]\.kind: must be one of repository/);
  });

  it("rejects unknown keys and bad ids", () => {
    expect(() => loadConfig({ configPath: withProjects({ id: "A", name: "W", contexts: [repoCtx], x: 1 }) })).toThrow(
      /\$\.projects\[0\]\.x: unknown key[\s\S]*\$\.projects\[0\]\.id/,
    );
  });
});
