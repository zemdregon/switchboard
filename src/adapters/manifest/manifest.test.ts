import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../registry.js";
import { evaluateVersionGate, loadManifest, ManifestError, parseManifest, parseVersion, satisfies } from "./index.js";

const valid = () => ({
  schema_version: 1,
  provider: "claude",
  validated_cli_version: "2.1.296",
  validated_version_range: ">=2.1.296 <2.2.0",
  validated_on: "2026-10-12",
  auth_modes_allowed: ["native_cached_subscription"],
  automation_surface: ["documented_headless"],
  credential_export_allowed: false,
  dashboard_scraping_allowed: false,
  network_protocol_reverse_engineering: false,
  commercial_multi_user_status: "requires-review",
  source_revision: "test",
});
const parse = (o: unknown) => parseManifest(JSON.stringify(o));

describe("manifest validation", () => {
  it("accepts a valid manifest, with and without notes", () => {
    expect(parse(valid()).provider).toBe("claude");
    expect(parse({ ...valid(), notes: "n" }).notes).toBe("n");
  });
  it("rejects a missing required field", () => {
    const { source_revision: _omit, ...rest } = valid();
    expect(() => parse(rest)).toThrow(/source_revision/);
  });
  it("rejects unknown keys", () => {
    expect(() => parse({ ...valid(), extra: 1 })).toThrow(ManifestError);
  });
  it("rejects manifests claiming forbidden capabilities", () => {
    for (const k of [
      "credential_export_allowed",
      "dashboard_scraping_allowed",
      "network_protocol_reverse_engineering",
    ]) {
      expect(() => parse({ ...valid(), [k]: true })).toThrow(ManifestError);
    }
  });
  it("rejects bad enums, dates and non-JSON", () => {
    expect(() => parse({ ...valid(), auth_modes_allowed: ["api_key"] })).toThrow(ManifestError);
    expect(() => parse({ ...valid(), validated_on: "2026-13-40" })).toThrow(/calendar date/);
    expect(() => parse({ ...valid(), validated_on: "yesterday" })).toThrow(ManifestError);
    expect(() => parseManifest("{")).toThrow(/not valid JSON/);
  });
});

describe("shipped manifests", () => {
  it.each(["claude", "codex"] as const)("loads %s with a hash and no ToS-compliance claim", (id) => {
    const { manifest, hash } = loadManifest(id);
    expect(manifest.provider).toBe(id);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.commercial_multi_user_status).toBe("requires-review");
    expect(manifest.notes ?? "").toMatch(/no claim that any use complies/);
    expect(manifest.notes ?? "").not.toMatch(/\bis (ToS|terms)[- ]compliant\b/i);
  });
  it("claude and codex pin the observed version inside their own range; other versions fail closed", () => {
    const reg = new AdapterRegistry();
    expect(reg.gate("claude", "2.1.296 (Claude Code)").eligible).toBe(true);
    expect(reg.gate("codex", "codex-cli 0.162.1").eligible).toBe(true);
    expect(reg.gate("codex", "codex-cli 0.162.9").eligible).toBe(true);
    expect(reg.gate("codex", "codex-cli 0.163.0").eligible).toBe(false);
    expect(reg.gate("codex", "codex-cli 0.161.0").eligible).toBe(false);
    expect(reg.gate("codex", "codex-cli 0.1.0").eligible).toBe(false);
  });
});

describe("semver", () => {
  it("parses version output", () => {
    expect(parseVersion("2.1.296 (Claude Code)")).toMatchObject({ major: 2, minor: 1, patch: 296, prerelease: false });
    expect(parseVersion("codex-cli 0.5.1")).toMatchObject({ major: 0, minor: 5, patch: 1, prerelease: false });
    expect(parseVersion("2026.10.12-d47ca18")).toEqual({
      major: 2026,
      minor: 10,
      patch: 12,
      prerelease: false,
      build: "d47ca18",
    });
    expect(parseVersion("2026.10.12+d47ca18")).toEqual({
      major: 2026,
      minor: 10,
      patch: 12,
      prerelease: false,
      build: "d47ca18",
    });
    expect(parseVersion("2026.10.12-gd47ca18")).toEqual({
      major: 2026,
      minor: 10,
      patch: 12,
      prerelease: false,
      build: "gd47ca18",
    });
    expect(parseVersion("2026.10.12-alpha.1")).toMatchObject({
      major: 2026,
      minor: 10,
      patch: 12,
      prerelease: true,
    });
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });
  it("evaluates ranges and fails closed on junk", () => {
    const v = parseVersion("2.1.300");
    if (!v) throw new Error("unparseable");
    expect(satisfies(v, ">=2.1.296 <2.2.0")).toBe(true);
    expect(satisfies(v, ">=2.2.0")).toBe(false);
    expect(satisfies(v, "2.1.300")).toBe(true);
    expect(satisfies(v, "^2.1.0")).toBe(false);
    expect(satisfies(v, "")).toBe(false);
    const pre = parseVersion("2.1.300-beta.1");
    if (!pre) throw new Error("unparseable");
    expect(satisfies(pre, ">=2.1.296 <2.2.0")).toBe(false);
  });
  it("evaluates ranges against CalVer versions with commit hash (T4.48)", () => {
    const cur = parseVersion("2026.10.12-d47ca18");
    if (!cur) throw new Error("unparseable");
    expect(satisfies(cur, ">=2026.10.12 <2026.11.0")).toBe(true);
    expect(satisfies(cur, ">=2026.10.12-d47ca18 <2026.11.0")).toBe(true);
    expect(satisfies(cur, "=2026.10.12")).toBe(true);
    expect(satisfies(cur, "2026.10.12")).toBe(true);
    expect(satisfies(cur, ">=2026.10.13")).toBe(false);
    expect(satisfies(cur, "<2026.10.12")).toBe(false);
    expect(satisfies(cur, ">=2026.10.12-beta.1")).toBe(false);
    const curPre = parseVersion("2026.10.12-preview.1");
    if (!curPre) throw new Error("unparseable");
    expect(satisfies(curPre, ">=2026.10.12 <2026.11.0")).toBe(false);
  });
});

describe("version gate", () => {
  const m = parse(valid());
  it("accepts in-range versions", () => {
    const r = evaluateVersionGate("claude", m, "2.1.296");
    expect(r.eligible).toBe(true);
    expect(evaluateVersionGate("claude", m, "2.1.999 (Claude Code)").eligible).toBe(true);
  });
  it.each([["2.2.0"], ["2.1.295"], ["3.0.0"]])("rejects out-of-range %s with evidence", (ver) => {
    const r = evaluateVersionGate("claude", m, ver);
    expect(r).toMatchObject({
      eligible: false,
      code: "ADAPTER_VERSION_UNVERIFIED",
      evidence: { observedVersion: ver, validatedRange: ">=2.1.296 <2.2.0", provider: "claude" },
    });
  });
  it.each([[null], [""], ["not a version"]])("rejects unknown/unparseable version %j", (ver) => {
    const r = evaluateVersionGate("claude", m, ver);
    expect(r).toMatchObject({ eligible: false, code: "ADAPTER_VERSION_UNVERIFIED" });
  });
  it("rejects when there is no manifest", () => {
    expect(evaluateVersionGate("claude", undefined, "2.1.296")).toMatchObject({
      eligible: false,
      code: "ADAPTER_VERSION_UNVERIFIED",
    });
  });
});

describe("AdapterRegistry.gate", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "sb-manifest-"));
    dirs.push(d);
    for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
    return d;
  };
  const reg = new AdapterRegistry();
  it("uses the supplied manifest directory", () => {
    const d = dir({ "claude.json": JSON.stringify(valid()) });
    expect(reg.gate("claude", "2.1.296", d).eligible).toBe(true);
    expect(reg.gate("claude", "2.3.0", d)).toMatchObject({ eligible: false, code: "ADAPTER_VERSION_UNVERIFIED" });
  });
  it("fails closed on missing or invalid manifests", () => {
    const missing = reg.gate("codex", "1.0.0", dir({}));
    expect(missing).toMatchObject({ eligible: false, code: "ADAPTER_VERSION_UNVERIFIED" });
    const bad = reg.gate("claude", "2.1.296", dir({ "claude.json": JSON.stringify({ ...valid(), extra: 1 }) }));
    expect(bad).toMatchObject({ eligible: false, code: "ADAPTER_VERSION_UNVERIFIED" });
  });
  it("rejects a manifest whose provider does not match its file", () => {
    const d = dir({ "codex.json": JSON.stringify(valid()) });
    expect(reg.gate("codex", "2.1.296", d).eligible).toBe(false);
  });
});
