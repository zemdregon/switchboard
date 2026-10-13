import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  effectiveMaxProfile,
  isUnderAllowedRoot,
  loadConfig,
  lowerProfile,
  projectsForClient,
  resolveConfigPath,
  TRUST_PROFILES,
} from "./index.js";

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
      projects: [],
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

  it("finalize_commit (T9.7, FR-GIT-09): default off, opt-in resolved, needs an identity and the primary writable context", () => {
    const identity = { name: "Ada", email: "ada@example.test" };
    const off = loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts: [repoCtx] }) });
    expect(off.projects[0]?.contexts[0]?.finalizeCommit).toBe(false);
    const on = loadConfig({
      configPath: withProjects({
        id: "web-app",
        name: "W",
        contexts: [{ ...repoCtx, identity, finalize_commit: true }],
      }),
    });
    expect(on.projects[0]?.contexts[0]?.finalizeCommit).toBe(true);
    const load = (contexts: unknown[]) => () =>
      loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts }) });
    expect(load([{ ...repoCtx, finalize_commit: "yes" }])).toThrow(/\$\.projects\[0\]\.contexts\[0\]\.finalize_commit/);
    expect(load([{ ...repoCtx, finalize_commit: true }])).toThrow(
      /\$\.projects\[0\]\.contexts\[0\]\.identity: required when finalize_commit is true/,
    );
    expect(load([{ ...repoCtx, identity, writable: false, finalize_commit: true }])).toThrow(
      /\$\.projects\[0\]\.contexts\[0\]\.finalize_commit: only the primary, writable context/,
    );
    expect(
      load([
        { ...repoCtx, primary: true },
        { ...repoCtx, id: "docs", identity, finalize_commit: true },
      ]),
    ).toThrow(/\$\.projects\[0\]\.contexts\[1\]\.finalize_commit: only the primary, writable context/);
  });
});

describe("mcp_clients[].projects and the lower-of-two ceiling (T9.2, FR-PRJ-06)", () => {
  const repoCtx = { id: "main", kind: "repository", path: "/x", base_ref: "main" };
  const proj = (id: string) => ({ id, name: id, contexts: [repoCtx] });
  const withClients = (clients: unknown[], ...projects: unknown[]) =>
    write({ ...base(), mcp_clients: clients, projects });

  it("resolves a client's project list; an entry without one has none", () => {
    const c = loadConfig({
      configPath: withClients(
        [
          { id: "a", max_trust_profile: "edit-untrusted", projects: ["web-app"] },
          { id: "b", max_trust_profile: "edit-untrusted" },
        ],
        proj("web-app"),
      ),
    });
    expect(c.mcpClients.get("a")?.projects).toEqual(["web-app"]);
    expect(c.mcpClients.get("b")?.projects).toEqual([]);
    expect(projectsForClient(c.projects, c.mcpClients.get("a") ?? {}).map((p) => p.id)).toEqual(["web-app"]);
    expect(projectsForClient(c.projects, c.mcpClients.get("b") ?? {})).toEqual([]);
    expect(projectsForClient(c.projects, {})).toEqual([]); // a hand-built entry is read as no project
  });

  it("an id that names no configured project fails the load with its path", () => {
    expect(() =>
      loadConfig({
        configPath: withClients(
          [{ id: "a", max_trust_profile: "edit-untrusted", projects: ["web-app", "ghost"] }],
          proj("web-app"),
        ),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.projects\[1\]: unknown project id "ghost"/);
    expect(() =>
      loadConfig({ configPath: withClients([{ id: "a", max_trust_profile: "edit-untrusted", projects: ["ghost"] }]) }),
    ).toThrow(/unknown project id/);
  });

  it("rejects a malformed or repeated id and an unknown key shape", () => {
    expect(() =>
      loadConfig({
        configPath: withClients(
          [{ id: "a", max_trust_profile: "edit-untrusted", projects: ["Bad Id"] }],
          proj("web-app"),
        ),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.projects\[0\]/);
    expect(() =>
      loadConfig({
        configPath: withClients(
          [{ id: "a", max_trust_profile: "edit-untrusted", projects: ["web-app", "web-app"] }],
          proj("web-app"),
        ),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.projects/);
  });

  it("lowerProfile and effectiveMaxProfile take the lower of the two on the profile order", () => {
    for (const a of TRUST_PROFILES) {
      for (const b of TRUST_PROFILES) {
        expect(TRUST_PROFILES.indexOf(lowerProfile(a, b))).toBe(
          Math.min(TRUST_PROFILES.indexOf(a), TRUST_PROFILES.indexOf(b)),
        );
      }
    }
    const c = loadConfig({
      configPath: write({
        ...base(),
        projects: [{ ...proj("capped"), max_trust_profile: "inspect-untrusted" }, proj("open")],
      }),
    });
    const [capped, open] = c.projects;
    expect(effectiveMaxProfile("privileged", capped as never)).toBe("inspect-untrusted");
    expect(effectiveMaxProfile("edit-untrusted", open as never)).toBe("edit-untrusted");
    expect(
      effectiveMaxProfile("inspect-untrusted", { ...(open as object), maxTrustProfile: "privileged" } as never),
    ).toBe("inspect-untrusted");
  });
});

describe("git.sanitize_patterns (FR-GIT-04, T9.3)", () => {
  it("defaults to none and resolves a valid list in order", () => {
    expect(loadConfig({ configPath: write(base()) }).sanitizePatterns).toEqual([]);
    const cfg = { ...base(), git: { sanitize_patterns: ["^ticket-\\d+", "internal\\.corp"] } };
    expect(loadConfig({ configPath: write(cfg) }).sanitizePatterns).toEqual(["^ticket-\\d+", "internal\\.corp"]);
  });

  it("rejects an unsafe or malformed pattern at load, naming its index", () => {
    for (const bad of ["(a+)+$", "(a)\\1", ".*a.*b", "[abc", "a".repeat(201)]) {
      const cfg = { ...base(), git: { sanitize_patterns: ["ok", bad] } };
      expect(() => loadConfig({ configPath: write(cfg) }), bad.slice(0, 12)).toThrow(/\$\.git\.sanitize_patterns/u);
    }
    expect(() => loadConfig({ configPath: write({ ...base(), git: { sanitize_patterns: ["(a+)+$"] } }) })).toThrow(
      /\[0\]: quantified group/u,
    );
  });

  it("rejects more than 16 patterns, an unknown git key and a non-string pattern", () => {
    const many = { ...base(), git: { sanitize_patterns: Array.from({ length: 17 }, (_, i) => `p${i}`) } };
    expect(() => loadConfig({ configPath: write(many) })).toThrow(/sanitize_patterns/u);
    expect(() => loadConfig({ configPath: write({ ...base(), git: { bogus: 1 } }) })).toThrow(
      /\$\.git\.bogus: unknown key/u,
    );
    expect(() => loadConfig({ configPath: write({ ...base(), git: { sanitize_patterns: [1] } }) })).toThrow(
      /sanitize_patterns/u,
    );
  });
});
