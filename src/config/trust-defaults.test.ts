/**
 * ADR-0091 (FR-POL-12, FR-MCP-27; owner ruling 2026-10-21): the configured request defaults and the HTTP opt-in for
 * unattended privileged runs. Every key is optional and absent means today's behaviour; a `privileged` default without
 * `default_privileged_scope` fails closed at load, a malformed scope is refused with its JSON path, and
 * `allow_unattended_privileged` relaxes only explicit mappings, never `default_mcp_client`.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, defaultedProfile, loadConfig } from "./index.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-config-trust-defaults-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(obj: unknown): string {
  const p = path.join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
const errorOf = (cfg: unknown): string => {
  try {
    loadConfig({ configPath: write(cfg) });
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  return "";
};
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
};
const project = (over: Record<string, unknown> = {}) => ({
  id: "web",
  name: "Web",
  contexts: [{ id: "main", kind: "repository", path: path.join(tmp, "repo"), base_ref: "main" }],
  ...over,
});
const base = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  allowed_roots: [tmp],
  mcp_clients: [{ id: "main", max_trust_profile: "privileged", projects: ["web"] }],
  projects: [project()],
  ...over,
});

describe("default_trust_profile and default_privileged_scope (ADR-0091, FR-POL-12)", () => {
  it("are absent by default, so trust_profile stays required", () => {
    const c = loadConfig({ configPath: write(base()) });
    expect(c.defaultTrustProfile).toBeUndefined();
    expect(c.defaultPrivilegedScope).toBeUndefined();
    expect(c.projects[0]?.defaultTrustProfile).toBeUndefined();
  });

  it("resolve a top-level and a project default, and parse the scope with defaults filled", () => {
    const { bypass: _omitted, ...noBypass } = BYPASS_SCOPE;
    const c = loadConfig({
      configPath: write(
        base({
          default_trust_profile: "privileged",
          default_privileged_scope: noBypass,
          projects: [project({ default_trust_profile: "edit-untrusted" })],
        }),
      ),
    });
    expect(c.defaultTrustProfile).toBe("privileged");
    expect(c.defaultPrivilegedScope).toEqual({ ...noBypass, bypass: false });
    expect(c.projects[0]?.defaultTrustProfile).toBe("edit-untrusted");
  });

  it("fails closed when a privileged default has no default_privileged_scope", () => {
    expect(errorOf(base({ default_trust_profile: "privileged" }))).toMatch(
      /\$\.default_trust_profile: privileged needs default_privileged_scope/,
    );
    expect(errorOf(base({ projects: [project({ default_trust_profile: "privileged" })] }))).toMatch(
      /\$\.projects\[0\]\.default_trust_profile: privileged needs default_privileged_scope/,
    );
    // A non-privileged default needs no scope, and a scope alone is accepted (explicit privileged requests use it).
    expect(errorOf(base({ default_trust_profile: "edit-untrusted" }))).toBe("");
    expect(errorOf(base({ default_privileged_scope: BYPASS_SCOPE }))).toBe("");
  });

  it("refuses a malformed default_privileged_scope with its JSON path", () => {
    const bad = (scope: unknown) =>
      errorOf(base({ default_trust_profile: "privileged", default_privileged_scope: scope }));
    expect(bad({ ...BYPASS_SCOPE, shell: { mode: "everything" } })).toMatch(
      /\$\.default_privileged_scope\.shell\.mode/,
    );
    expect(bad({ ...BYPASS_SCOPE, extra: 1 })).toMatch(/\$\.default_privileged_scope\.extra/);
    expect(bad({ ...BYPASS_SCOPE, shell: { mode: "allowlist" } })).toMatch(
      /\$\.default_privileged_scope\.shell\.allowlist: shell\.allowlist is required/,
    );
    expect(bad("broad")).toMatch(/\$\.default_privileged_scope: must be object/);
    expect(errorOf(base({ default_trust_profile: "root" }))).toMatch(/\$\.default_trust_profile/);
  });

  it("defaultedProfile prefers the project's default and lowers it to the ceiling", () => {
    expect(defaultedProfile(undefined, undefined, "privileged")).toBeUndefined();
    expect(defaultedProfile("privileged", undefined, "privileged")).toBe("privileged");
    expect(defaultedProfile("privileged", undefined, "edit-untrusted")).toBe("edit-untrusted");
    expect(defaultedProfile("privileged", { defaultTrustProfile: "test-sandboxed" }, "privileged")).toBe(
      "test-sandboxed",
    );
    expect(defaultedProfile(undefined, { defaultTrustProfile: "privileged" }, "inspect-untrusted")).toBe(
      "inspect-untrusted",
    );
  });
});

describe("transport.http.allow_unattended_privileged (ADR-0091, FR-MCP-27)", () => {
  const A = `sbc_${"a".repeat(22)}`;
  const on = { enabled: true, public_url: "https://sb.example.test/mcp", port: 8443 };
  const http = (h: Record<string, unknown>) =>
    base({
      mcp_clients: [
        { id: "main", max_trust_profile: "edit-untrusted" },
        { id: "grok-bot", max_trust_profile: "privileged", privileged_approval: "not_required" },
      ],
      projects: [],
      transport: { http: { ...on, ...h } },
    });

  it("off (absent or false) keeps refusing a mapped not_required client", () => {
    for (const flag of [{}, { allow_unattended_privileged: false }]) {
      expect(errorOf(http({ ...flag, clients: [{ oauth_client_id: A, mcp_client: "grok-bot" }] }))).toMatch(
        /clients\[0\]\.mcp_client: "grok-bot" has privileged_approval not_required/,
      );
      const c = loadConfig({ configPath: write(http(flag)) });
      expect(c.httpTransport?.allowUnattendedPrivileged).toBeUndefined();
      expect(c.httpTransport?.bindableMcpClients?.has("grok-bot")).toBe(false);
    }
  });

  it("true admits a mapped and a bindable not_required client, never the default", () => {
    const c = loadConfig({
      configPath: write(
        http({ allow_unattended_privileged: true, clients: [{ oauth_client_id: A, mcp_client: "grok-bot" }] }),
      ),
    });
    expect(c.httpTransport?.allowUnattendedPrivileged).toBe(true);
    expect(c.httpTransport?.clientMap.get(A)).toBe("grok-bot");
    expect(c.httpTransport?.bindableMcpClients?.has("grok-bot")).toBe(true);
    expect(errorOf(http({ allow_unattended_privileged: true, default_mcp_client: "grok-bot" }))).toMatch(
      /default_mcp_client: "grok-bot" has a privileged ceiling/,
    );
    expect(errorOf(http({ allow_unattended_privileged: "yes" }))).toMatch(/allow_unattended_privileged/);
  });
});

describe("mcp_clients[].promote_trust_profile (ADR-0093, FR-POL-13)", () => {
  const promoting = (over: Record<string, unknown> = {}) =>
    base({
      mcp_clients: [{ id: "main", max_trust_profile: "privileged", projects: ["web"], promote_trust_profile: true }],
      ...over,
    });

  it("is absent by default and set only when true", () => {
    expect(loadConfig({ configPath: write(base()) }).mcpClients.get("main")?.promoteTrustProfile).toBeUndefined();
    const c = loadConfig({ configPath: write(promoting({ default_trust_profile: "edit-untrusted" })) });
    expect(c.mcpClients.get("main")?.promoteTrustProfile).toBe(true);
  });

  it("fails closed without any default_trust_profile, and accepts a project default alone", () => {
    expect(errorOf(promoting())).toMatch(/\$\.mcp_clients\[0\]\.promote_trust_profile: needs a default_trust_profile/);
    expect(errorOf(promoting({ projects: [project({ default_trust_profile: "test-sandboxed" })] }))).toBe("");
    expect(errorOf(promoting({ default_trust_profile: "privileged", default_privileged_scope: BYPASS_SCOPE }))).toBe(
      "",
    );
    expect(
      errorOf(
        base({
          default_trust_profile: "edit-untrusted",
          mcp_clients: [{ id: "main", max_trust_profile: "privileged", promote_trust_profile: "yes" }],
        }),
      ),
    ).toMatch(/promote_trust_profile/);
  });
});
