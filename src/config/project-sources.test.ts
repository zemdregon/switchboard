/**
 * ADR-0068: `project_sources` and `mcp_clients[].approval_proxy_kinds` in the configuration file (strict schema plus
 * the `load.ts` rules the schema cannot express; fail closed, NFR-SEC-06).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

let tmp: string;
let root: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-srcs-")));
  root = path.join(tmp, "root");
  mkdirSync(path.join(root, "clones"), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function load(extra: Record<string, unknown>, clients?: Record<string, unknown>[]) {
  const p = path.join(tmp, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: 1,
      allowed_roots: [root],
      data_dir: path.join(tmp, "data"),
      mcp_clients: clients ?? [{ id: "main", max_trust_profile: "edit-untrusted" }],
      ...extra,
    }),
  );
  return loadConfig({ configPath: p });
}

describe("project_sources (ADR-0068)", () => {
  it("is absent unless configured (cloning refused)", () => {
    expect(load({}).projectSources).toBeUndefined();
  });

  it("resolves clone_root canonically, defaults allowed_hosts and lower-cases owners", () => {
    const c = load({
      project_sources: { clone_root: path.join(root, "clones"), allowed_owners: ["Digifender-LLC", "zemdregon"] },
    });
    expect(c.projectSources).toEqual({
      cloneRoot: path.join(root, "clones"),
      allowedHosts: ["github.com"],
      allowedOwners: ["digifender-llc", "zemdregon"],
    });
    const hosts = load({
      project_sources: {
        clone_root: path.join(root, "clones"),
        allowed_hosts: ["github.com", "git.example.test"],
        allowed_owners: ["a"],
      },
    });
    expect(hosts.projectSources?.allowedHosts).toEqual(["github.com", "git.example.test"]);
  });

  it("refuses a relative, missing, out-of-root or data-dir clone_root", () => {
    const owners = ["a"];
    expect(() => load({ project_sources: { clone_root: "root/clones", allowed_owners: owners } })).toThrow(
      /\$\.project_sources\.clone_root: must be an absolute path/,
    );
    expect(() => load({ project_sources: { clone_root: path.join(root, "missing"), allowed_owners: owners } })).toThrow(
      /\$\.project_sources\.clone_root: cannot resolve/,
    );
    mkdirSync(path.join(tmp, "outside"));
    expect(() => load({ project_sources: { clone_root: path.join(tmp, "outside"), allowed_owners: owners } })).toThrow(
      /\$\.project_sources\.clone_root: must lie under one of allowed_roots/,
    );
    // a symbolic link inside the root that leads outside it is outside
    symlinkSync(path.join(tmp, "outside"), path.join(root, "link"));
    expect(() => load({ project_sources: { clone_root: path.join(root, "link"), allowed_owners: owners } })).toThrow(
      /must lie under one of allowed_roots/,
    );
    const data = path.join(root, "data");
    mkdirSync(path.join(data, "clones"), { recursive: true });
    expect(() =>
      load({ data_dir: data, project_sources: { clone_root: path.join(data, "clones"), allowed_owners: owners } }),
    ).toThrow(/\$\.project_sources\.clone_root: may not lie inside data_dir/);
  });

  it("is strict: owners required and non-empty, well-formed hosts and owners, no unknown keys", () => {
    const clone_root = path.join(root, "clones");
    expect(() => load({ project_sources: { clone_root } })).toThrow(/allowed_owners/);
    expect(() => load({ project_sources: { clone_root, allowed_owners: [] } })).toThrow(/allowed_owners/);
    for (const owner of ["a/b", "a b", "", "x".repeat(101)]) {
      expect(() => load({ project_sources: { clone_root, allowed_owners: [owner] } }), owner).toThrow(
        /\$\.project_sources\.allowed_owners\[0\]/,
      );
    }
    for (const owner of [".", ".."]) {
      expect(() => load({ project_sources: { clone_root, allowed_owners: [owner] } }), owner).toThrow(
        /not a repository owner/,
      );
    }
    for (const host of ["GitHub.com", "github.com:443", "localhost", "https://github.com", "a..b"]) {
      expect(
        () => load({ project_sources: { clone_root, allowed_hosts: [host], allowed_owners: ["a"] } }),
        host,
      ).toThrow(/\$\.project_sources\.allowed_hosts\[0\]/);
    }
    expect(() => load({ project_sources: { clone_root, allowed_owners: ["a"], token: "x" } })).toThrow(
      /project_sources/,
    );
  });
});

describe("mcp_clients[].approval_proxy_kinds (ADR-0068)", () => {
  it("defaults to every kind for a proxy and is absent without one", () => {
    const c = load({}, [
      { id: "plain", max_trust_profile: "edit-untrusted" },
      { id: "bot", max_trust_profile: "edit-untrusted", approval_proxy: true },
      {
        id: "grok-bot",
        max_trust_profile: "edit-untrusted",
        approval_proxy: true,
        approval_proxy_targets: ["grok-bot"],
        approval_proxy_kinds: ["dynamic_project", "push_revision"],
      },
    ]);
    expect(c.mcpClients.get("plain")?.approvalProxyKinds).toBeUndefined();
    expect(c.mcpClients.get("bot")?.approvalProxyKinds).toEqual([
      "privileged_scope",
      "dynamic_project",
      "push_revision",
    ]);
    expect(c.mcpClients.get("grok-bot")).toMatchObject({
      approvalProxy: true,
      approvalProxyTargets: ["grok-bot"],
      approvalProxyKinds: ["dynamic_project", "push_revision"],
    });
  });

  it("refuses kinds without approval_proxy, unknown kinds and an empty list", () => {
    expect(() =>
      load({}, [{ id: "a", max_trust_profile: "edit-untrusted", approval_proxy_kinds: ["dynamic_project"] }]),
    ).toThrow(/\$\.mcp_clients\[0\]\.approval_proxy_kinds: applies only to a client with approval_proxy: true/);
    expect(() =>
      load({}, [{ id: "a", max_trust_profile: "edit-untrusted", approval_proxy: true, approval_proxy_kinds: ["all"] }]),
    ).toThrow(/\$\.mcp_clients\[0\]\.approval_proxy_kinds\[0\]/);
    expect(() =>
      load({}, [{ id: "a", max_trust_profile: "edit-untrusted", approval_proxy: true, approval_proxy_kinds: [] }]),
    ).toThrow(/\$\.mcp_clients\[0\]\.approval_proxy_kinds/);
  });
});
