import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateVersionGate } from "./manifest/gate.js";
import type { ComplianceManifest } from "./manifest/schema.js";
import {
  emptyVersionCanaryStore,
  evaluateVersionCanary,
  readVersionCanaryStore,
  recordAdapterVersion,
  sameVersion,
  versionCanaryBaseline,
  versionCanaryCore,
  versionCanaryPath,
} from "./version-canary.js";

const manifest = (validated_cli_version: string, range = ">=2.1.0 <2.2.0"): ComplianceManifest => ({
  schema_version: 1,
  provider: "claude",
  validated_cli_version,
  validated_on: "2026-10-01",
  validated_version_range: range,
  auth_modes_allowed: ["native_cached_subscription"],
  automation_surface: ["documented_headless"],
  credential_export_allowed: false,
  dashboard_scraping_allowed: false,
  network_protocol_reverse_engineering: false,
  commercial_multi_user_status: "requires-review",
  source_revision: "test",
});

const cursorManifest = (validated_cli_version: string): ComplianceManifest => ({
  ...manifest(validated_cli_version, ">=2026.10.16 <2026.11.0"),
  provider: "cursor",
});

const gateFor = (observed: string, validatedCli: string) =>
  evaluateVersionGate("claude", manifest(validatedCli), observed);

describe("version canary (T8.5)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.length = 0;
  });
  const dataDir = () => {
    const d = mkdtempSync(join(tmpdir(), "sb-vcanary-"));
    dirs.push(d);
    return d;
  };

  it("unchanged version is silent and eligible", () => {
    const dir = dataDir();
    recordAdapterVersion(dir, "claude", "2.1.294", () => new Date("2026-10-01T00:00:00Z"));
    const store = readVersionCanaryStore(dir);
    const gate = gateFor("2.1.294", "2.1.294");
    const ev = evaluateVersionCanary(gate, "claude", store);
    expect(ev.bump).toBe(false);
    expect(ev.gate.eligible).toBe(true);
    expect(ev.recordVersion).toBeNull();
  });

  it("a version bump marks the adapter ADAPTER_VERSION_UNVERIFIED", () => {
    const store = {
      schema_version: 1 as const,
      adapters: { claude: { binary_version: "2.1.294", recorded_at: "2026-10-01T00:00:00Z" } },
    };
    const gate = gateFor("2.1.296", "2.1.294");
    const ev = evaluateVersionCanary(gate, "claude", store);
    expect(ev.bump).toBe(true);
    expect(ev.gate.eligible).toBe(false);
    if (!ev.gate.eligible) {
      expect(ev.gate.code).toBe("ADAPTER_VERSION_UNVERIFIED");
      expect(ev.gate.detail).toContain("2.1.296");
      expect(ev.gate.detail).toContain("2.1.294");
    }
    expect(ev.recordVersion).toBeNull();
  });

  it("uses manifest validated_cli_version as baseline when the store has no row", () => {
    const store = emptyVersionCanaryStore();
    const gate = gateFor("2.1.296", "2.1.294");
    const ev = evaluateVersionCanary(gate, "claude", store);
    expect(ev.bump).toBe(true);
    expect(ev.gate.eligible).toBe(false);
  });

  it("a raw version line matches the manifest's bare validated_cli_version (codex-cli prefix, T2.8)", () => {
    // Codex's probe reports `codex-cli 0.162.0`; codex.json records `0.162.0`. With no store row (a fresh data
    // directory) this must not count as a bump (live doctor on Ampere, 2026-10-17).
    const store = emptyVersionCanaryStore();
    const gate = evaluateVersionGate("claude", manifest("0.162.0", ">=0.162.0 <0.163.0"), "codex-cli 0.162.0");
    expect(gate.eligible).toBe(true);
    const ev = evaluateVersionCanary(gate, "claude", store);
    expect(ev.bump).toBe(false);
    expect(ev.gate.eligible).toBe(true);
    expect(ev.recordVersion).toBe("codex-cli 0.162.0");
    const bumped = evaluateVersionCanary(
      evaluateVersionGate("claude", manifest("0.162.0", ">=0.162.0 <0.163.0"), "codex-cli 0.162.1"),
      "claude",
      store,
    );
    expect(bumped.bump).toBe(true);
    expect(bumped.gate.eligible).toBe(false);
  });

  it("sameVersion compares parsed versions and falls back to exact strings", () => {
    expect(sameVersion("codex-cli 0.162.0", "0.162.0")).toBe(true);
    expect(sameVersion("2.1.294 (Claude Code)", "2.1.294")).toBe(true);
    expect(sameVersion("codex-cli 0.162.1", "0.162.0")).toBe(false);
    expect(sameVersion("2026.10.12-d47ca18", "2026.10.12-e3cb207")).toBe(true);
    expect(sameVersion("2026.10.13-d47ca18", "2026.10.12-d47ca18")).toBe(false);
    expect(sameVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(sameVersion("no version here", "no version here")).toBe(true);
    expect(sameVersion("no version", "0.1.0")).toBe(false);
  });

  it("establishes a baseline when manifest gate passes and no baseline exists", () => {
    const store = emptyVersionCanaryStore();
    const gate = gateFor("2.1.294", "unverified-on-this-host");
    expect(versionCanaryBaseline(store, "claude", "unverified-on-this-host")).toBeNull();
    const ev = evaluateVersionCanary(gate, "claude", store);
    expect(ev.bump).toBe(false);
    expect(ev.recordVersion).toBe("2.1.294");
  });

  it("persists recorded versions under the data directory", () => {
    const dir = dataDir();
    recordAdapterVersion(dir, "codex", "0.162.1", () => new Date("2026-10-16T12:00:00Z"));
    const reread = readVersionCanaryStore(dir);
    expect(reread.adapters.codex).toEqual({
      binary_version: "0.162.1",
      recorded_at: "2026-10-16T12:00:00.000Z",
    });
    expect(readFileSync(versionCanaryPath(dir), "utf8")).toContain("0.162.1");
  });

  describe("build-metadata normalisation (T4.80, decision 75)", () => {
    const cursorGate = (observed: string | null, validated = "2026.10.16") =>
      evaluateVersionGate("cursor", cursorManifest(validated), observed);

    it("equal core with a trailing hex commit suffix passes and records the full observed string", () => {
      const ev = evaluateVersionCanary(cursorGate("2026.10.16-e3cb207"), "cursor", emptyVersionCanaryStore());
      expect(ev.bump).toBe(false);
      expect(ev.gate.eligible).toBe(true);
      expect(ev.recordVersion).toBe("2026.10.16-e3cb207");
      expect(ev.evidence).toEqual({
        observed_raw: "2026.10.16-e3cb207",
        observed_core: "2026.10.16",
        baseline_raw: "2026.10.16",
        baseline_core: "2026.10.16",
      });
    });

    it("a 40-hex suffix passes; 6 or 41 hex digits do not", () => {
      expect(versionCanaryCore(`2026.10.16-${"a".repeat(40)}`)).toBe("2026.10.16");
      expect(versionCanaryCore("2026.10.16-abcdef")).toBeNull();
      expect(versionCanaryCore(`2026.10.16-${"a".repeat(41)}`)).toBeNull();
    });

    it("equal core with +meta passes", () => {
      const store = {
        schema_version: 1 as const,
        adapters: { claude: { binary_version: "2.1.294", recorded_at: "2026-10-01T00:00:00Z" } },
      };
      const ev = evaluateVersionCanary(gateFor("2.1.294+build.7", "2.1.294"), "claude", store);
      expect(ev.bump).toBe(false);
      expect(ev.gate.eligible).toBe(true);
      expect(ev.evidence.observed_raw).toBe("2.1.294+build.7");
      expect(ev.evidence.observed_core).toBe("2.1.294");
    });

    it("a core mismatch fails closed with ADAPTER_VERSION_UNVERIFIED and keeps the raw string", () => {
      const ev = evaluateVersionCanary(cursorGate("2026.10.17-e3cb207"), "cursor", emptyVersionCanaryStore());
      expect(ev.bump).toBe(true);
      expect(ev.gate.eligible).toBe(false);
      if (!ev.gate.eligible) {
        expect(ev.gate.code).toBe("ADAPTER_VERSION_UNVERIFIED");
        expect(ev.gate.detail).toContain("2026.10.17-e3cb207");
      }
      expect(ev.evidence.observed_raw).toBe("2026.10.17-e3cb207");
      expect(ev.evidence.observed_core).toBe("2026.10.17");
    });

    it.each(["2026.10.16-beta", "2026.10.16-rc1", "2026.10.16-e3cb20z", "2026.10.16.4", "2026.10.16-e3cb207-dirty"])(
      "a non-hex or prerelease suffix (%s) fails closed",
      (observed) => {
        expect(versionCanaryCore(observed)).toBeNull();
        expect(sameVersion(observed, "2026.10.16")).toBe(false);
        // Bypass the manifest gate (which already rejects prereleases) to prove the canary fails closed on its own.
        const eligible = {
          eligible: true as const,
          evidence: { ...cursorGate("2026.10.16").evidence, observedVersion: observed },
        };
        const ev = evaluateVersionCanary(eligible, "cursor", emptyVersionCanaryStore());
        expect(ev.bump).toBe(true);
        expect(ev.gate.eligible).toBe(false);
        if (!ev.gate.eligible) expect(ev.gate.code).toBe("ADAPTER_VERSION_UNVERIFIED");
        expect(ev.evidence.observed_raw).toBe(observed);
        expect(ev.evidence.observed_core).toBeNull();
      },
    );

    it("a missing version fails closed", () => {
      const gate = cursorGate(null);
      expect(gate.eligible).toBe(false);
      const ev = evaluateVersionCanary(gate, "cursor", emptyVersionCanaryStore());
      expect(ev.gate.eligible).toBe(false);
      expect(ev.recordVersion).toBeNull();
      expect(ev.evidence.observed_raw).toBeNull();
      expect(versionCanaryCore("")).toBeNull();
      expect(sameVersion("", "2026.10.16")).toBe(false);
    });
  });
});
