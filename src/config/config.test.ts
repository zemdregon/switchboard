import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BUNDLE_BOUNDS, MIN_BUNDLE_BYTES } from "../continuity/bundle-schema.js";
import { cimdInternalClientId } from "../mcp/oauth-cimd.js";
import {
  ConfigError,
  effectiveMaxProfile,
  isUnderAllowedRoot,
  loadConfig,
  lowerProfile,
  MIN_CONTINUITY_MAX_BUNDLE_BYTES,
  projectsForClient,
  resolveConfigPath,
  submodulesEnabled,
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

  describe("telemetry (T8.1, FR-TEL-02, NFR-PRIV-01)", () => {
    it("is disabled when absent, empty or without an endpoint", () => {
      for (const telemetry of [undefined, {}, { otlp_endpoint: "" }]) {
        expect(loadConfig({ configPath: write({ ...base(), telemetry }) }).telemetry).toBeUndefined();
      }
    });

    it("accepts explicit HTTP and HTTPS collector endpoints", () => {
      for (const endpoint of ["http://127.0.0.1:4318/v1/traces", "https://collector.example.test/traces"]) {
        expect(
          loadConfig({ configPath: write({ ...base(), telemetry: { otlp_endpoint: endpoint } }) }).telemetry,
        ).toEqual({ otlpEndpoint: endpoint });
      }
    });

    it("rejects invalid endpoints at config load without echoing their values", () => {
      for (const endpoint of [
        "relative",
        "ftp://collector.test",
        "https://",
        " ",
        " http://collector.test",
        "http://secret-canary@[",
      ]) {
        const load = () => loadConfig({ configPath: write({ ...base(), telemetry: { otlp_endpoint: endpoint } }) });
        expect(load).toThrow("$.telemetry.otlp_endpoint: must be an absolute http or https URL");
        try {
          load();
        } catch (error) {
          expect(String(error)).toBe("ConfigError: $.telemetry.otlp_endpoint: must be an absolute http or https URL");
        }
      }
    });

    it("rejects wrong endpoint types and unknown telemetry keys", () => {
      expect(() => loadConfig({ configPath: write({ ...base(), telemetry: { otlp_endpoint: 42 } }) })).toThrow(
        /telemetry.otlp_endpoint/,
      );
      expect(() =>
        loadConfig({ configPath: write({ ...base(), telemetry: { endpoint: "http://collector.test" } }) }),
      ).toThrow(/telemetry.endpoint: unknown key/);
    });

    it("leaves the per-run provider OTLP receiver off unless explicitly enabled (T8.15, FR-TEL-06)", () => {
      for (const telemetry of [{ provider_otlp: false }, { otlp_endpoint: "http://127.0.0.1:4318/v1/traces" }]) {
        const loaded = loadConfig({ configPath: write({ ...base(), telemetry }) }).telemetry;
        expect(loaded?.providerOtlp).toBeUndefined();
      }
      expect(loadConfig({ configPath: write({ ...base(), telemetry: { provider_otlp: true } }) }).telemetry).toEqual({
        providerOtlp: true,
      });
      expect(
        loadConfig({
          configPath: write({
            ...base(),
            telemetry: { otlp_endpoint: "http://127.0.0.1:4318/v1/traces", provider_otlp: true },
          }),
        }).telemetry,
      ).toEqual({ otlpEndpoint: "http://127.0.0.1:4318/v1/traces", providerOtlp: true });
      expect(() => loadConfig({ configPath: write({ ...base(), telemetry: { provider_otlp: "yes" } }) })).toThrow(
        /telemetry.provider_otlp/,
      );
    });
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

  describe("transport.http (T13.1, FR-MCP-12, ADR-0041)", () => {
    const http = (h: Record<string, unknown>) =>
      loadConfig({ configPath: write({ ...base(), transport: { http: h } }) });
    const on = { enabled: true, public_url: "https://sb.example.test/mcp", port: 8443 };

    it("is off when absent or disabled", () => {
      expect(loadConfig({ configPath: write(base()) }).httpTransport).toBeUndefined();
      expect(http({ ...on, enabled: false }).httpTransport).toBeUndefined();
    });

    it("resolves an enabled section with a loopback default bind", () => {
      expect(http(on).httpTransport).toEqual({
        bind: "127.0.0.1",
        port: 8443,
        resource: "https://sb.example.test/mcp",
        issuer: "https://sb.example.test",
        mcpPath: "/mcp",
        allowedOrigins: [],
        clientMap: new Map(),
        cimd: true,
      });
    });

    it("maps a Client Identifier URL under its derived id and takes cimd: false (T13.11, FR-MCP-19)", () => {
      const url = "https://app.example/oauth/client";
      const mapped = http({ ...on, clients: [{ oauth_client_id: url, mcp_client: "main" }], cimd: false });
      expect(mapped.httpTransport?.cimd).toBe(false);
      expect(mapped.httpTransport?.clientMap.get(cimdInternalClientId(url))).toBe("main");
      expect(mapped.httpTransport?.clientMap.has(url)).toBe(false);
      expect(() =>
        http({
          ...on,
          clients: [
            { oauth_client_id: url, mcp_client: "main" },
            { oauth_client_id: url, mcp_client: "main" },
          ],
        }),
      ).toThrow(/mapped more than once/);
      for (const bad of [
        "https://app.example/",
        "https://app.example/c?x=1",
        "https://10.0.0.1/c",
        "https://App.example/c",
      ]) {
        expect(() => http({ ...on, clients: [{ oauth_client_id: bad, mcp_client: "main" }] })).toThrow(
          /Client Identifier URL must be https/,
        );
      }
      expect(() => http({ ...on, clients: [{ oauth_client_id: "http://app.example/c", mcp_client: "main" }] })).toThrow(
        ConfigError,
      );
    });

    it("maps OAuth clients to MCP clients and refuses unsafe or unknown targets (T13.4, FR-MCP-14)", () => {
      const A = `sbc_${"a".repeat(22)}`;
      const mapped = http({ ...on, clients: [{ oauth_client_id: A, mcp_client: "main" }], default_mcp_client: "main" });
      expect(mapped.httpTransport?.clientMap.get(A)).toBe("main");
      expect(mapped.httpTransport?.defaultMcpClient).toBe("main");
      expect(() => http({ ...on, clients: [{ oauth_client_id: A, mcp_client: "nobody" }] })).toThrow(
        /clients\[0\]\.mcp_client: unknown mcp_clients id/,
      );
      expect(() => http({ ...on, default_mcp_client: "nobody" })).toThrow(/default_mcp_client: unknown/);
      expect(() =>
        http({
          ...on,
          clients: [
            { oauth_client_id: A, mcp_client: "main" },
            { oauth_client_id: A, mcp_client: "main" },
          ],
        }),
      ).toThrow(/mapped more than once/);
      expect(() => http({ ...on, clients: [{ oauth_client_id: "grok", mcp_client: "main" }] })).toThrow(ConfigError);
      // A client whose privileged runs skip the operator's approval cannot be reached over HTTP.
      const root = {
        ...base(),
        mcp_clients: [{ id: "root", max_trust_profile: "privileged", privileged_approval: "not_required" }],
        transport: { http: { ...on, clients: [{ oauth_client_id: A, mcp_client: "root" }] } },
      };
      expect(() => loadConfig({ configPath: write(root) })).toThrow(/privileged_approval not_required/);
      // A privileged ceiling is never the default for every approved OAuth client; it needs an explicit mapping.
      const privDefault = {
        ...base(),
        mcp_clients: [{ id: "root", max_trust_profile: "privileged" }],
        transport: { http: { ...on, default_mcp_client: "root" } },
      };
      expect(() => loadConfig({ configPath: write(privDefault) })).toThrow(/privileged ceiling/);
      const privMapped = {
        ...privDefault,
        transport: { http: { ...on, clients: [{ oauth_client_id: A, mcp_client: "root" }] } },
      };
      expect(loadConfig({ configPath: write(privMapped) }).httpTransport?.clientMap.get(A)).toBe("root");
    });

    it.each([
      ["http://sb.example.test/mcp", /must use https/],
      ["http://127.0.0.1/mcp", /must use https/],
      ["https://user:pw@sb.example.test/mcp", /must not contain userinfo/],
      ["https://sb.example.test/mcp?x=1", /must not have a query or fragment/],
      ["https://sb.example.test/", /path must name the MCP endpoint/],
      ["https://sb.example.test/.well-known/oauth-protected-resource", /path must name the MCP endpoint/],
      ["https://sb.example.test/token", /path must name the MCP endpoint/],
      ["not a url", /not a valid URL/],
    ])("refuses public_url %s", (url, re) => {
      expect(() => http({ ...on, public_url: url })).toThrow(re);
    });

    it("never echoes userinfo from a refused URL", () => {
      expect(() => http({ ...on, public_url: "https://user:s3cr3t@sb.example.test/mcp" })).toThrow(
        /^(?![\s\S]*s3cr3t)/,
      );
    });

    it("refuses a non-loopback or host-name bind unless explicitly allowed", () => {
      expect(() => http({ ...on, bind: "0.0.0.0" })).toThrow(/not loopback; set allow_non_loopback/);
      expect(() => http({ ...on, bind: "localhost" })).toThrow(/must be an IP address literal/);
      expect(http({ ...on, bind: "0.0.0.0", allow_non_loopback: true }).httpTransport?.bind).toBe("0.0.0.0");
      expect(http({ ...on, bind: "::1" }).httpTransport?.bind).toBe("::1");
    });

    it("accepts serialised origins only (T13.2)", () => {
      const ok = ["https://app.example.test", "http://127.0.0.1:5173"];
      expect(http({ ...on, allowed_origins: ok }).httpTransport?.allowedOrigins).toEqual(ok);
      for (const bad of [
        "https://app.example.test/",
        "https://app.example.test/x",
        "https://App.example.test",
        "null",
        "*",
      ]) {
        expect(() => http({ ...on, allowed_origins: [bad] })).toThrow(
          /allowed_origins\[0\]: must be a serialised origin/,
        );
      }
      expect(() => http({ ...on, allowed_origins: ok.concat(ok[0] as string) })).toThrow(/allowed_origins/);
    });

    it("requires public_url and port when enabled, and refuses unknown keys", () => {
      expect(() => http({ enabled: true, port: 1 })).toThrow(/public_url: required when enabled/);
      expect(() => http({ enabled: true, public_url: on.public_url })).toThrow(/port: required when enabled/);
      expect(() => http({ ...on, token: "x" })).toThrow(/\$\.transport\.http\.token: unknown key/);
    });
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

describe("limits.min_free_disk_mb (T3.23, FR-WS-11)", () => {
  it("is off by default: an unset key leaves `limits` exactly as before (byte-identical to main)", () => {
    const c = loadConfig({ configPath: write(base()) });
    expect(c.limits).toStrictEqual({ globalConcurrency: 4, perProviderConcurrency: 1 });
    expect("minFreeDiskMb" in c.limits).toBe(false);
    const other = loadConfig({ configPath: write({ ...base(), limits: { global_concurrency: 2 } }) });
    expect(other.limits).toStrictEqual({ globalConcurrency: 2, perProviderConcurrency: 1 });
  });

  it("resolves a whole-megabyte floor and rejects zero, negative, fractional and non-integer values", () => {
    const c = loadConfig({ configPath: write({ ...base(), limits: { min_free_disk_mb: 2048 } }) });
    expect(c.limits).toStrictEqual({ globalConcurrency: 4, perProviderConcurrency: 1, minFreeDiskMb: 2048 });
    expect(() => loadConfig({ configPath: write({ ...base(), limits: { min_free_disk_mb: 0 } }) })).toThrow(
      /\$\.limits\.min_free_disk_mb: must be >= 1/,
    );
    for (const min_free_disk_mb of [-1, 1.5, "100", true, null]) {
      expect(() => loadConfig({ configPath: write({ ...base(), limits: { min_free_disk_mb } }) })).toThrow(ConfigError);
    }
  });
});

describe("host.max_load1 and host.resume_load1, mcp_clients[].allow_light (T3.24, FR-CAP-12)", () => {
  it("is off by default: no hostLoad and no allowLight are resolved", () => {
    const c = loadConfig({ configPath: write(base()) });
    expect("hostLoad" in c).toBe(false);
    for (const client of c.mcpClients.values()) expect("allowLight" in client).toBe(false);
  });

  it("resolves both values and allow_light: true", () => {
    const cfg = base();
    const c = loadConfig({
      configPath: write({
        ...cfg,
        mcp_clients: [{ ...cfg.mcp_clients[0], allow_light: true }],
        host: { max_load1: 10, resume_load1: 7.5 },
      }),
    });
    expect(c.hostLoad).toStrictEqual({ maxLoad1: 10, resumeLoad1: 7.5 });
    expect([...c.mcpClients.values()][0]?.allowLight).toBe(true);
    const off = loadConfig({
      configPath: write({ ...cfg, mcp_clients: [{ ...cfg.mcp_clients[0], allow_light: false }] }),
    });
    expect("allowLight" in ([...off.mcpClients.values()][0] ?? {})).toBe(false);
  });

  it("fails closed on a resume value not below the maximum, a missing key, an unknown key or a non-positive number", () => {
    const load = (host: unknown) => () => loadConfig({ configPath: write({ ...base(), host }) });
    expect(load({ max_load1: 8, resume_load1: 8 })).toThrow(
      /\$\.host\.resume_load1: must be lower than \$\.host\.max_load1/,
    );
    expect(load({ max_load1: 8, resume_load1: 9 })).toThrow(ConfigError);
    for (const host of [
      { max_load1: 10 },
      { resume_load1: 8 },
      { max_load1: 10, resume_load1: 8, extra: 1 },
      { max_load1: 0, resume_load1: -1 },
      { max_load1: 10, resume_load1: 0 },
      { max_load1: "10", resume_load1: 8 },
      { max_load1: 10, resume_load1: null },
      {},
      null,
    ]) {
      expect(load(host)).toThrow(ConfigError);
    }
    const cfg = base();
    expect(() =>
      loadConfig({ configPath: write({ ...cfg, mcp_clients: [{ ...cfg.mcp_clients[0], allow_light: "yes" }] }) }),
    ).toThrow(ConfigError);
  });
});

describe("providers.claude-code.git_channel (T9.4b, ADR-0029 item 7)", () => {
  it("defaults to off, is true only when set to true, and is refused on other providers or as a non-boolean", () => {
    expect(loadConfig({ configPath: write(base()) }).claudeCodeGitChannel).toBe(false);
    const withKey = (v: unknown) => ({ ...base(), providers: { "claude-code": { git_channel: v } } });
    expect(loadConfig({ configPath: write(withKey(false)) }).claudeCodeGitChannel).toBe(false);
    const on = loadConfig({ configPath: write(withKey(true)) });
    expect(on.claudeCodeGitChannel).toBe(true);
    expect(on.providers.get("claude-code")?.enabled).toBe(true); // the key does not change enablement
    for (const v of ["true", 1, null]) expect(() => loadConfig({ configPath: write(withKey(v)) })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath: write({ ...base(), providers: { codex: { git_channel: true } } }) })).toThrow(
      /\$\.providers\.codex\.git_channel: unknown key/,
    );
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
      // T9.9 defaults: no project-management tools, no push for dynamic projects.
      manageProjects: false,
      maxPushPolicy: "none",
      // T14.8 default: no approval proxy tools.
      approvalProxy: false,
      // T14.11 default: today's full tool set.
      toolProfile: "orchestrator",
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

describe("mcp_clients[].manage_projects and max_push_policy (T9.9, FR-PRJ-10)", () => {
  const clients = (...entries: Record<string, unknown>[]) => ({ ...base(), mcp_clients: entries });

  it("defaults to off and none, and accepts both keys together", () => {
    const c = loadConfig({
      configPath: write(
        clients(
          { id: "plain", max_trust_profile: "edit-untrusted" },
          { id: "mgr", max_trust_profile: "edit-untrusted", manage_projects: true },
          { id: "pusher", max_trust_profile: "edit-untrusted", manage_projects: true, max_push_policy: "branch" },
        ),
      ),
    });
    expect(c.mcpClients.get("plain")).toMatchObject({ manageProjects: false, maxPushPolicy: "none" });
    expect(c.mcpClients.get("mgr")).toMatchObject({ manageProjects: true, maxPushPolicy: "none" });
    expect(c.mcpClients.get("pusher")).toMatchObject({ manageProjects: true, maxPushPolicy: "branch" });
  });

  it("is strict: wrong types and values fail with the JSON path", () => {
    expect(() =>
      loadConfig({
        configPath: write(clients({ id: "a", max_trust_profile: "edit-untrusted", manage_projects: "yes" })),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.manage_projects: must be boolean/);
    expect(() =>
      loadConfig({
        configPath: write(
          clients({ id: "a", max_trust_profile: "edit-untrusted", manage_projects: true, max_push_policy: "all" }),
        ),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.max_push_policy: must be one of none, branch/);
  });

  it("refuses max_push_policy branch without manage_projects (fail closed)", () => {
    expect(() =>
      loadConfig({
        configPath: write(clients({ id: "a", max_trust_profile: "edit-untrusted", max_push_policy: "branch" })),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.max_push_policy: applies only to a client with manage_projects: true/);
  });
});

describe("mcp_clients[].approval_proxy and approval_proxy_targets (T14.8, FR-CTL-08, ADR-0047)", () => {
  const clients = (...entries: Record<string, unknown>[]) => ({ ...base(), mcp_clients: entries });

  it("defaults to off; a proxy targets itself unless the operator lists targets", () => {
    const c = loadConfig({
      configPath: write(
        clients(
          { id: "plain", max_trust_profile: "edit-untrusted" },
          { id: "bot", max_trust_profile: "inspect-untrusted", approval_proxy: true },
          {
            id: "relay",
            max_trust_profile: "inspect-untrusted",
            approval_proxy: true,
            approval_proxy_targets: ["plain"],
          },
        ),
      ),
    });
    expect(c.mcpClients.get("plain")?.approvalProxy).toBe(false);
    expect(c.mcpClients.get("plain")?.approvalProxyTargets).toBeUndefined();
    expect(c.mcpClients.get("bot")).toMatchObject({ approvalProxy: true, approvalProxyTargets: ["bot"] });
    expect(c.mcpClients.get("relay")).toMatchObject({ approvalProxy: true, approvalProxyTargets: ["plain"] });
  });

  it("is strict: an invalid approval_proxy value refuses the config", () => {
    for (const value of ["yes", 1, null]) {
      expect(
        () =>
          loadConfig({
            configPath: write(clients({ id: "a", max_trust_profile: "edit-untrusted", approval_proxy: value })),
          }),
        String(value),
      ).toThrow(/\$\.mcp_clients\[0\]\.approval_proxy: must be boolean/);
    }
    expect(() =>
      loadConfig({
        configPath: write(
          clients({ id: "a", max_trust_profile: "edit-untrusted", approval_proxy: true, approval_proxy_targets: [] }),
        ),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.approval_proxy_targets/);
  });

  it("refuses targets without approval_proxy, and a target that is not a configured client (fail closed)", () => {
    expect(() =>
      loadConfig({
        configPath: write(clients({ id: "a", max_trust_profile: "edit-untrusted", approval_proxy_targets: ["a"] })),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.approval_proxy_targets: applies only to a client with approval_proxy: true/);
    expect(() =>
      loadConfig({
        configPath: write(
          clients({
            id: "a",
            max_trust_profile: "edit-untrusted",
            approval_proxy: true,
            approval_proxy_targets: ["zz"],
          }),
        ),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.approval_proxy_targets\[0\]: unknown client id "zz"/);
  });
});

describe("mcp_clients[].tool_profile (T14.11, FR-CTL-11)", () => {
  const clients = (...entries: Record<string, unknown>[]) => ({ ...base(), mcp_clients: entries });

  it("defaults to orchestrator; console is accepted", () => {
    const c = loadConfig({
      configPath: write(
        clients(
          { id: "plain", max_trust_profile: "edit-untrusted" },
          { id: "orch", max_trust_profile: "edit-untrusted", tool_profile: "orchestrator" },
          { id: "bot", max_trust_profile: "inspect-untrusted", tool_profile: "console", approval_proxy: true },
        ),
      ),
    });
    expect(c.mcpClients.get("plain")?.toolProfile).toBe("orchestrator");
    expect(c.mcpClients.get("orch")?.toolProfile).toBe("orchestrator");
    expect(c.mcpClients.get("bot")).toMatchObject({ toolProfile: "console", approvalProxy: true });
  });

  it("refuses an unknown or mistyped value at load", () => {
    for (const value of ["Console", "chat", "", 1, null, true]) {
      expect(
        () =>
          loadConfig({
            configPath: write(clients({ id: "a", max_trust_profile: "edit-untrusted", tool_profile: value })),
          }),
        String(value),
      ).toThrow(/\$\.mcp_clients\[0\]\.tool_profile: must be one of orchestrator, console/);
    }
  });

  it("refuses console with manage_projects (fail closed: the console set has no project-admin tools)", () => {
    expect(() =>
      loadConfig({
        configPath: write(
          clients({ id: "a", max_trust_profile: "edit-untrusted", tool_profile: "console", manage_projects: true }),
        ),
      }),
    ).toThrow(/\$\.mcp_clients\[0\]\.tool_profile: console offers no project-admin tools/);
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

  it("base_remote (LLD §5.2, ADR-0067): absent by default, a remote name on the primary context only", () => {
    const off = loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts: [repoCtx] }) });
    expect(off.projects[0]?.contexts[0]?.baseRemote).toBeUndefined();
    const on = loadConfig({
      configPath: withProjects({ id: "web-app", name: "W", contexts: [{ ...repoCtx, base_remote: "origin" }] }),
    });
    expect(on.projects[0]?.contexts[0]?.baseRemote).toBe("origin");
    const load = (contexts: unknown[]) => () =>
      loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts }) });
    expect(load([{ ...repoCtx, base_remote: "https://example.test/r.git" }])).toThrow(
      /\$\.projects\[0\]\.contexts\[0\]\.base_remote: must be the name of a remote/,
    );
    expect(
      load([
        { ...repoCtx, primary: true },
        { ...repoCtx, id: "docs", base_remote: "origin" },
      ]),
    ).toThrow(/\$\.projects\[0\]\.contexts\[1\]\.base_remote: only the primary context/);
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

  it("contexts[].submodules (ADR-0087 item 1): resolved, primary-only recursive, safe paths, writable needs recursive", () => {
    const load = (contexts: unknown[]) => () =>
      loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts }) });
    const absent = loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts: [repoCtx] }) });
    expect(absent.projects[0]?.contexts[0]?.submodules).toBeUndefined();
    expect(submodulesEnabled(absent.projects[0]?.contexts[0])).toBe(false);
    const on = loadConfig({
      configPath: withProjects({
        id: "web-app",
        name: "W",
        contexts: [
          {
            ...repoCtx,
            submodules: { mode: "recursive", writable_paths: ["libs/a", "libs/b"], exclude: ["vendor/x"] },
          },
        ],
      }),
    });
    expect(on.projects[0]?.contexts[0]?.submodules).toEqual({
      mode: "recursive",
      writablePaths: ["libs/a", "libs/b"],
      exclude: ["vendor/x"],
    });
    expect(submodulesEnabled(on.projects[0]?.contexts[0])).toBe(true);
    const star = loadConfig({
      configPath: withProjects({
        id: "web-app",
        name: "W",
        contexts: [{ ...repoCtx, submodules: { mode: "recursive", writable_paths: ["*"] } }],
      }),
    });
    expect(star.projects[0]?.contexts[0]?.submodules?.writablePaths).toEqual(["*"]);
    const off = loadConfig({
      configPath: withProjects({ id: "web-app", name: "W", contexts: [{ ...repoCtx, submodules: { mode: "off" } }] }),
    });
    expect(off.projects[0]?.contexts[0]?.submodules).toEqual({ mode: "off", writablePaths: [], exclude: [] });
    expect(submodulesEnabled(off.projects[0]?.contexts[0])).toBe(false);

    expect(
      load([
        { ...repoCtx, primary: true },
        { ...repoCtx, id: "docs", submodules: { mode: "recursive" } },
      ]),
    ).toThrow(/contexts\[1\]\.submodules\.mode: SUBMODULES_PRIMARY_ONLY/);
    for (const bad of ["/abs", "a//b", "./a", "a/../b", "a/.git/b", ".GIT", "a\\b", ""]) {
      expect(load([{ ...repoCtx, submodules: { mode: "recursive", exclude: [bad] } }]), bad).toThrow();
    }
    expect(load([{ ...repoCtx, submodules: { mode: "recursive", exclude: ["a/../b"] } }])).toThrow(
      /submodules\.exclude\[0\]: SUBMODULE_PATH_UNSAFE/,
    );
    expect(load([{ ...repoCtx, submodules: { mode: "recursive", writable_paths: ["*", "a"] } }])).toThrow(
      /SUBMODULE_PATH_UNSAFE: "\*" is only valid as the sole entry/,
    );
    expect(load([{ ...repoCtx, submodules: { mode: "off", writable_paths: ["a"] } }])).toThrow(
      /submodules\.writable_paths: SUBMODULES_NOT_WRITABLE/,
    );
    expect(load([{ ...repoCtx, writable: false, submodules: { mode: "recursive", writable_paths: ["a"] } }])).toThrow(
      /SUBMODULES_NOT_WRITABLE/,
    );
    expect(load([{ ...repoCtx, submodules: { mode: "recursive", writable_paths: ["a"], exclude: ["a"] } }])).toThrow(
      /SUBMODULE_PATH_CONFLICT/,
    );
    // The JSON schema: unknown keys, bad mode, duplicates, too many and over-long paths.
    expect(load([{ ...repoCtx, submodules: { mode: "all" } }])).toThrow(/submodules/);
    expect(load([{ ...repoCtx, submodules: { mode: "recursive", extra: 1 } }])).toThrow(/submodules/);
    expect(load([{ ...repoCtx, submodules: { mode: "recursive", exclude: ["a", "a"] } }])).toThrow(/submodules/);
    expect(
      load([
        { ...repoCtx, submodules: { mode: "recursive", exclude: Array.from({ length: 513 }, (_, i) => `s/${i}`) } },
      ]),
    ).toThrow(/submodules/);
    expect(load([{ ...repoCtx, submodules: { mode: "recursive", exclude: ["a".repeat(257)] } }])).toThrow(/submodules/);
  });

  it("merge_policy.checks (ADR-0087 item 7): default required, all_reported accepted, anything else refused", () => {
    const cfg = (mp: unknown) =>
      loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts: [repoCtx], merge_policy: mp }) });
    expect(cfg({ enabled: true }).projects[0]?.mergePolicy?.checks).toBe("required");
    expect(cfg({ enabled: true, checks: "all_reported" }).projects[0]?.mergePolicy?.checks).toBe("all_reported");
    expect(() => cfg({ enabled: true, checks: "some" })).toThrow(/checks/);
  });

  it("projects[].queue.low_water (T15.4, FR-QUE-04): off by default, accepts integer >= 1, rejects invalid", () => {
    const off = loadConfig({ configPath: withProjects({ id: "web-app", name: "W", contexts: [repoCtx] }) });
    expect(off.projects[0]?.queue?.lowWater).toBeUndefined();

    const on = loadConfig({
      configPath: withProjects({
        id: "web-app",
        name: "W",
        contexts: [repoCtx],
        queue: { low_water: 5 },
      }),
    });
    expect(on.projects[0]?.queue?.lowWater).toBe(5);

    expect(() =>
      loadConfig({
        configPath: withProjects({
          id: "web-app",
          name: "W",
          contexts: [repoCtx],
          queue: { low_water: 0 },
        }),
      }),
    ).toThrow(/\$\.projects\[0\]\.queue\.low_water/);

    expect(() =>
      loadConfig({
        configPath: withProjects({
          id: "web-app",
          name: "W",
          contexts: [repoCtx],
          queue: { low_water: "three" },
        }),
      }),
    ).toThrow(/\$\.projects\[0\]\.queue\.low_water/);
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

describe("git.secret_scan.allow (FR-GIT-11, T9.14, LLD §20.9)", () => {
  it("defaults to none and resolves entries in order", () => {
    expect(loadConfig({ configPath: write(base()) }).secretScanAllow).toEqual([]);
    const allow = [
      { rule_id: "aws_access_key_id", path: "fixtures/**" },
      { rule_id: "jwt", path: "docs/*.md" },
    ];
    const cfg = { ...base(), git: { secret_scan: { allow } } };
    expect(loadConfig({ configPath: write(cfg) }).secretScanAllow).toEqual(allow);
  });

  it("refuses an unknown rule id, a missing field, an unknown key and more than 64 entries at load", () => {
    const at = (allow: unknown, extra: Record<string, unknown> = {}) =>
      loadConfig({ configPath: write({ ...base(), git: { secret_scan: { allow, ...extra } } }) });
    expect(() => at([{ rule_id: "not_a_rule", path: "**" }])).toThrow(
      /\$\.git\.secret_scan\.allow\[0\]\.rule_id: unknown rule "not_a_rule"/u,
    );
    expect(() => at([{ rule_id: "jwt" }])).toThrow(/secret_scan/u);
    expect(() => at([{ rule_id: "jwt", path: "x", extra: 1 }])).toThrow(/secret_scan/u);
    expect(() => at([], { bypass: true })).toThrow(/\$\.git\.secret_scan\.bypass: unknown key/u);
    const many = Array.from({ length: 65 }, () => ({ rule_id: "jwt", path: "x" }));
    expect(() => at(many)).toThrow(/secret_scan/u);
  });
});

describe("inner_agent (T11.1; FR-INN-01, FR-INN-03, LLD §13.1)", () => {
  const section = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    backend: { kind: "http", base_url: "http://127.0.0.1:8080", model: "local-model" },
    ...over,
  });
  const load = (inner: unknown) => loadConfig({ configPath: write({ ...base(), inner_agent: inner }) });

  it("with no section there is no inner agent and the resolved config has no such key", () => {
    const c = loadConfig({ configPath: write(base()) });
    expect(c.innerAgent).toBeUndefined();
    expect("innerAgent" in c).toBe(false);
  });

  it("resolves the LLD defaults: no task enabled, nothing but what the operator wrote", () => {
    const a = load(section()).innerAgent;
    expect(a?.enabled).toBe(true);
    expect(a?.backend).toMatchObject({
      kind: "http",
      baseUrl: "http://127.0.0.1:8080",
      model: "local-model",
      timeoutMs: 15000,
      maxConcurrency: 2,
      allowRemote: false,
      sharesSubscriptionWith: null,
    });
    expect(Object.values(a?.tasks ?? {}).some((t) => t.enabled)).toBe(false);
    expect(a?.tasks.commit_message).toMatchObject({ mode: "draft_if_missing", allowSourceContent: false });
    expect(a?.tasks.route_features.timeoutMs).toBe(5000);
    expect(a?.breaker).toEqual({ failureThreshold: 3, openMs: 60000 });
    expect(a?.suspension).toEqual({ windowCalls: 50, minCalls: 20, rejectionThreshold: 0.4 });
  });

  it("an empty or disabled section is accepted and has no backend or model default", () => {
    expect(load({}).innerAgent).toMatchObject({ enabled: false, backend: undefined });
    expect(load({ enabled: false }).innerAgent?.enabled).toBe(false);
    expect(() => load({ enabled: true })).toThrow(/\$\.inner_agent\.backend: required when enabled/);
    expect(() => load(section({ backend: { kind: "http", base_url: "http://127.0.0.1:1" } }))).toThrow(
      /backend\.model: required property is missing/,
    );
  });

  it("rejects unknown keys at every level, including credential-shaped field names", () => {
    expect(() => load(section({ surprise: 1 }))).toThrow(/\$\.inner_agent\.surprise: unknown key/);
    for (const key of ["api_key", "token", "headers", "password", "env"]) {
      const backend = { kind: "http", base_url: "http://127.0.0.1:1", model: "m", [key]: "x" };
      expect(() => load(section({ backend }))).toThrow(new RegExp(`backend\\.${key}: unknown key`));
    }
    expect(() => load(section({ tasks: { shell: { enabled: true } } }))).toThrow(/tasks\.shell: unknown key/);
    expect(() => load(section({ tasks: { run_title: { enabled: true, tools: [] } } }))).toThrow(
      /tasks\.run_title\.tools: unknown key/,
    );
    expect(() => load(section({ breaker: { nope: 1 } }))).toThrow(/breaker\.nope: unknown key/);
  });

  it("rejects a credential-looking value anywhere in the section, without echoing it", () => {
    const secret = `sk-${"a1B2c3D4e5".repeat(3)}`;
    for (const inner of [
      section({ backend: { kind: "http", base_url: "http://127.0.0.1:1", model: secret } }),
      section({ backend: { kind: "http", base_url: `http://127.0.0.1:1/${secret}`, model: "m" } }),
      section({ backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "api_key=abcdefgh12345" } }),
      section({ backend: { kind: "cli", provider: "opencode", model: `ghp_${"a".repeat(36)}` } }),
    ]) {
      let message = "";
      try {
        load(inner);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/looks like a credential/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("abcdefgh12345");
      expect(message).not.toContain("ghp_");
    }
  });

  it("rejects userinfo, a query string, a fragment, a non-http scheme and an unparseable base_url", () => {
    const withUrl = (base_url: string) => section({ backend: { kind: "http", base_url, model: "m" } });
    expect(() => load(withUrl("http://user:pw@127.0.0.1:1"))).toThrow(/userinfo/);
    expect(() => load(withUrl("http://user@127.0.0.1:1"))).toThrow(/userinfo/);
    expect(() => load(withUrl("http://127.0.0.1:1/v1?x=1"))).toThrow(/query string/);
    expect(() => load(withUrl("http://127.0.0.1:1/v1#frag"))).toThrow(/fragment/);
    expect(() => load(withUrl("ftp://127.0.0.1:1"))).toThrow(/scheme must be http or https/);
    expect(() => load(withUrl("not a url"))).toThrow(/not a valid URL/);
    expect(load(withUrl("https://gateway.example.test/v1")).innerAgent?.backend?.baseUrl).toBe(
      "https://gateway.example.test/v1",
    );
  });

  it("checks backend kind fields, the task rules and the cross-field rules", () => {
    expect(() => load(section({ backend: { kind: "http", model: "m" } }))).toThrow(
      /base_url: required for the http kind/,
    );
    expect(() => load(section({ backend: { kind: "cli", model: "m" } }))).toThrow(
      /provider: required for the cli kind/,
    );
    expect(() =>
      load(section({ backend: { kind: "cli", provider: "opencode", base_url: "http://127.0.0.1:1", model: "m" } })),
    ).toThrow(/base_url: valid only for the http kind/);
    expect(() =>
      load(section({ backend: { kind: "http", base_url: "http://127.0.0.1:1", provider: "opencode", model: "m" } })),
    ).toThrow(/provider: valid only for the cli kind/);
    expect(
      load(section({ backend: { kind: "cli", provider: "opencode", model: "m" } })).innerAgent?.backend?.kind,
    ).toBe("cli");
    // mode only on commit_message; allow_source_content only on tasks that send repository content
    expect(() => load(section({ tasks: { pr_draft: { mode: "always" } } }))).toThrow(/pr_draft\.mode: unknown key/);
    expect(() => load(section({ tasks: { run_title: { allow_source_content: true } } }))).toThrow(
      /run_title\.allow_source_content: unknown key/,
    );
    expect(() => load(section({ tasks: { route_features: { allow_source_content: true } } }))).toThrow(/unknown key/);
    expect(() => load(section({ tasks: { commit_message: { mode: "sometimes" } } }))).toThrow(/mode: must be one of/);
    // input budget floor 1024; task timeout may only be lower than the backend's
    expect(() => load(section({ tasks: { run_title: { input_budget_bytes: 1023 } } }))).toThrow(/>= 1024/);
    expect(() => load(section({ tasks: { run_title: { timeout_ms: 20000 } } }))).toThrow(
      /may only be lower than the backend/,
    );
    expect(() => load(section({ suspension: { window_calls: 10, min_calls: 11 } }))).toThrow(
      /min_calls: must not exceed/,
    );
    // shares_subscription_with must name a known provider or be null
    expect(() =>
      load(
        section({
          backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "m", shares_subscription_with: "nope" },
        }),
      ),
    ).toThrow(/shares_subscription_with: must name a configured provider id/);
    const shared = load(
      section({
        backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "m", shares_subscription_with: "claude-code" },
      }),
    );
    expect(shared.innerAgent?.backend?.sharesSubscriptionWith).toBe("claude-code");
  });
});

describe("project and context inner_agent (T11.3; LLD §13.1, FR-INN-16)", () => {
  const project = (over: Record<string, unknown> = {}, ctxOver: Record<string, unknown> = {}) => ({
    id: "web-app",
    name: "Web",
    ...over,
    contexts: [{ id: "main", kind: "repository", path: "/srv/web", base_ref: "main", ...ctxOver }],
  });
  const load = (p: unknown) => loadConfig({ configPath: write({ ...base(), projects: [p] }) });

  it("accepts off, local_only and inherit; resolves them only when written; no `on` value exists", () => {
    const c = load(project({ inner_agent: "local_only" }, { inner_agent: "off" }));
    expect(c.projects[0]?.innerAgent).toBe("local_only");
    expect(c.projects[0]?.contexts[0]?.innerAgent).toBe("off");
    const plain = load(project());
    expect(plain.projects[0]).not.toHaveProperty("innerAgent");
    expect(plain.projects[0]?.contexts[0]).not.toHaveProperty("innerAgent");
    expect(load(project({ inner_agent: "inherit" })).projects[0]?.innerAgent).toBe("inherit");
    expect(() => load(project({ inner_agent: "on" }))).toThrow(/\$\.projects\[0\]\.inner_agent/);
    expect(() => load(project({}, { inner_agent: "on" }))).toThrow(/\$\.projects\[0\]\.contexts\[0\]\.inner_agent/);
  });
});

describe("continuity (T5.6; ADR-0038 item 5.5, LLD §15.4)", () => {
  const load = (section: unknown) => loadConfig({ configPath: write({ ...base(), continuity: section }) });

  it("defaults every key to the LLD §15.4 value, which equals the bundle builder's defaults", () => {
    const c = loadConfig({ configPath: write(base()) });
    expect(c.continuity).toEqual({ max_bundle_bytes: 65536, max_diff_excerpt_bytes: 32768, max_text_chars: 2000 });
    expect(c.continuity).toEqual(DEFAULT_BUNDLE_BOUNDS);
    expect(MIN_CONTINUITY_MAX_BUNDLE_BYTES).toBe(MIN_BUNDLE_BYTES);
    expect(load({}).continuity).toEqual(DEFAULT_BUNDLE_BOUNDS);
    expect(load({ max_text_chars: 500 }).continuity).toEqual({ ...DEFAULT_BUNDLE_BOUNDS, max_text_chars: 500 });
  });

  it("takes all three keys", () => {
    const set = { max_bundle_bytes: 16384, max_diff_excerpt_bytes: 0, max_text_chars: 1 };
    expect(load(set).continuity).toEqual(set);
  });

  it("is strict: unknown keys, non-integers and out-of-range values fail", () => {
    expect(() => load({ max_bytes: 1 })).toThrow(/\$\.continuity\.max_bytes: unknown key/);
    expect(() => load({ max_bundle_bytes: 16383 })).toThrow(/\$\.continuity\.max_bundle_bytes/);
    expect(() => load({ max_bundle_bytes: 1_048_577 })).toThrow(/\$\.continuity\.max_bundle_bytes/);
    expect(() => load({ max_diff_excerpt_bytes: -1 })).toThrow(/\$\.continuity\.max_diff_excerpt_bytes/);
    expect(() => load({ max_text_chars: 0 })).toThrow(/\$\.continuity\.max_text_chars/);
    expect(() => load({ max_text_chars: 1.5 })).toThrow(/\$\.continuity\.max_text_chars/);
    expect(() => load({ max_text_chars: "2000" })).toThrow(/\$\.continuity\.max_text_chars/);
    expect(() => load([])).toThrow(/\$\.continuity/);
  });
});

describe("capacity (T6.2; LLD §16.1, ADR-0043)", () => {
  const load = (section: unknown) => loadConfig({ configPath: write({ ...base(), capacity: section }) });
  const DEFAULTS = {
    windowSeconds: 3600,
    confidenceRuns: 10,
    queueHorizonSeconds: 0,
    breaker: { failureThreshold: 3, openSeconds: 300 },
    retry: { maxAttempts: 3, baseMs: 2000, capMs: 120000 },
  };

  it("defaults every key to the LLD §16.1 value (Assumptions; queue horizon 0 means never wait)", () => {
    expect(loadConfig({ configPath: write(base()) }).capacity).toEqual(DEFAULTS);
    expect(load({}).capacity).toEqual(DEFAULTS);
    expect(load({ breaker: { open_seconds: 60 } }).capacity).toEqual({
      ...DEFAULTS,
      breaker: { failureThreshold: 3, openSeconds: 60 },
    });
  });

  it("takes every key", () => {
    const c = load({
      window_seconds: 60,
      confidence_runs: 1,
      queue_horizon_seconds: 86400,
      breaker: { failure_threshold: 100, open_seconds: 1 },
      retry: { max_attempts: 10, base_ms: 5, cap_ms: 5 },
    }).capacity;
    expect(c).toEqual({
      windowSeconds: 60,
      confidenceRuns: 1,
      queueHorizonSeconds: 86400,
      breaker: { failureThreshold: 100, openSeconds: 1 },
      retry: { maxAttempts: 10, baseMs: 5, capMs: 5 },
    });
  });

  it("is strict: unknown keys, non-integers, out-of-range values and base_ms above cap_ms fail", () => {
    expect(() => load({ horizon: 1 })).toThrow(/\$\.capacity\.horizon: unknown key/);
    expect(() => load({ breaker: { threshold: 1 } })).toThrow(/\$\.capacity\.breaker\.threshold: unknown key/);
    expect(() => load({ rate_gate: {} })).toThrow(/\$\.capacity\.rate_gate: unknown key/);
    expect(() => load({ window_seconds: 59 })).toThrow(/\$\.capacity\.window_seconds/);
    expect(() => load({ queue_horizon_seconds: -1 })).toThrow(/\$\.capacity\.queue_horizon_seconds/);
    expect(() => load({ confidence_runs: 1.5 })).toThrow(/\$\.capacity\.confidence_runs/);
    expect(() => load({ retry: { max_attempts: 0 } })).toThrow(/\$\.capacity\.retry\.max_attempts/);
    expect(() => load({ retry: { max_attempts: "3" } })).toThrow(/\$\.capacity\.retry\.max_attempts/);
    expect(() => load({ retry: { base_ms: 200000 } })).toThrow(/\$\.capacity\.retry\.base_ms: must not exceed/);
    expect(() => load([])).toThrow(/\$\.capacity/);
  });
});

describe("routing (T7.1; LLD §17.1, ADR-0044)", () => {
  const load = (section: unknown) => loadConfig({ configPath: write({ ...base(), routing: section }) });
  const ONES = { success: 1, latency: 1, capacity: 1, security: 1, handoff: 1, cost: 1 };

  const AFFINITY = { enabled: true, lowWaterMark: null, minConfidence: null };

  it("defaults every weight to 1 (Assumption, Q-80) and takes each key", () => {
    expect(loadConfig({ configPath: write(base()) }).routing).toEqual({ weights: ONES, affinity: AFFINITY });
    expect(load({}).routing).toEqual({ weights: ONES, affinity: AFFINITY });
    expect(load({ weights: { cost: 0, success: 100, latency: 2.5 } }).routing).toEqual({
      weights: { ...ONES, cost: 0, success: 100, latency: 2.5 },
      affinity: AFFINITY,
    });
  });

  it("affinity (T7.4): enabled by default, thresholds null so the estimate trigger is off (Q-81), set together", () => {
    expect(load({ affinity: {} }).routing.affinity).toEqual(AFFINITY);
    expect(load({ affinity: { enabled: false, idle_ttl: null } }).routing.affinity).toEqual({
      ...AFFINITY,
      enabled: false,
    });
    expect(load({ affinity: { low_water_mark: 0.1, min_confidence: 0.5 } }).routing.affinity).toEqual({
      enabled: true,
      lowWaterMark: 0.1,
      minConfidence: 0.5,
    });
    expect(() => load({ affinity: { low_water_mark: 0.1 } })).toThrow(
      /\$\.routing\.affinity: low_water_mark and min_confidence/,
    );
    expect(() => load({ affinity: { min_confidence: 0.1, low_water_mark: null } })).toThrow(/set together/);
    expect(() => load({ affinity: { idle_ttl: "7d" } })).toThrow(/\$\.routing\.affinity\.idle_ttl/);
    expect(() => load({ affinity: { low_water_mark: 2, min_confidence: 0.5 } })).toThrow(/low_water_mark/);
    expect(() => load({ affinity: { enabled: "yes" } })).toThrow(/\$\.routing\.affinity\.enabled/);
    expect(() => load({ affinity: { sticky: true } })).toThrow(/\$\.routing\.affinity/);
  });

  it("refuses unknown keys, out-of-range and non-numeric weights (NFR-SEC-06)", () => {
    expect(() => load({ weights: { quality: 1 } })).toThrow(/\$\.routing\.weights/);
    expect(() => load({ minimum_capability_defaults: {} })).toThrow(/\$\.routing/);
    expect(() => load({ weights: { cost: -1 } })).toThrow(/\$\.routing\.weights\.cost/);
    expect(() => load({ weights: { cost: 101 } })).toThrow(/\$\.routing\.weights\.cost/);
    expect(() => load({ weights: { cost: "1" } })).toThrow(/\$\.routing\.weights\.cost/);
    expect(() => load([])).toThrow(/\$\.routing/);
  });
});

describe("confined verification config (T3.11)", () => {
  it("defaults to false when unconfigured", () => {
    const cfg = loadConfig({ configPath: write(base()) });
    expect(cfg.confinedVerification).toBe(false);
  });

  it("can be enabled via programmatic option or SWITCHBOARD_CONFINED_VERIFICATION env", () => {
    const p = write(base());
    const cfgOpt = loadConfig({ configPath: p, confinedVerification: true });
    expect(cfgOpt.confinedVerification).toBe(true);

    const cfgEnv = loadConfig({ configPath: p, env: { SWITCHBOARD_CONFINED_VERIFICATION: "true" } });
    expect(cfgEnv.confinedVerification).toBe(true);

    const cfgEnv1 = loadConfig({ configPath: p, env: { SWITCHBOARD_CONFINED_VERIFICATION: "1" } });
    expect(cfgEnv1.confinedVerification).toBe(true);
  });
});
