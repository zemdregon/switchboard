/**
 * T8.6 (FR-ADP-03, NFR-PERF-02): synthetic version bump through preflight cache invalidation and routing exclusion
 * until validation is recorded. Fakes only; no provider CLI.
 */
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CollectDeps, type EligibilityRequest, evaluateEligibility } from "../routing/index.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { PreflightCache } from "./preflight-cache.js";
import { AdapterRegistry } from "./registry.js";
import type { ProbeOutput, ProbeRunner } from "./types.js";
import { evaluateVersionCanary, readVersionCanaryStore, recordAdapterVersion } from "./version-canary.js";

const CLAUDE_HELP =
  "-p, --print\n--output-format stream-json\n--permission-mode dontAsk\n--permission-prompts\n--tools\n--allowedTools\n--disallowedTools\n--safe-mode\n--restricted\n--strict-mcp-config\n--resume\n";

type Table = Record<string, Partial<ProbeOutput>>;

function runnerFor(table: Table): ProbeRunner {
  return async (argv) => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...table[`${argv[0]} ${argv.slice(1).join(" ")}`],
  });
}

function claudeTable(binaryPath: string, versionStdout: string, over: Table = {}): Table {
  return {
    [`${binaryPath} --version`]: { stdout: versionStdout },
    [`${binaryPath} --help`]: { stdout: CLAUDE_HELP },
    [`${binaryPath} auth status --json`]: { stdout: '{"loggedIn":true}' },
    ...over,
  };
}

function gateWithCanary(registry: AdapterRegistry, dataDir: string) {
  const store = readVersionCanaryStore(dataDir);
  return (id: string, version: string | null, dir?: string) =>
    evaluateVersionCanary(registry.gate(id as never, version, dir), id, store).gate;
}

const request = (): EligibilityRequest => ({
  candidates: ["claude"],
  trustProfile: "edit-untrusted",
  clientMaxProfile: "edit-untrusted",
  profile: {
    name: "edit-untrusted",
    fileAccess: "worktree",
    shell: "none",
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
  },
  requirements: { network: "off", writable: true },
  cwd: "/tmp/synthetic-worktree",
});

describe("version bump through preflight cache invalidation (T8.6)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.length = 0;
  });

  it("re-probes after a binary identity change, excludes routing on version canary bump until validate records the version", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sb-vbump-"));
    dirs.push(dataDir);
    recordAdapterVersion(dataDir, "claude", "2.1.296");

    const binDir = mkdtempSync(join(tmpdir(), "sb-vbump-bin-"));
    dirs.push(binDir);
    const bin = join(binDir, "claude");
    writeFileSync(bin, "#!/bin/sh\n");

    const registry = new AdapterRegistry().register(new ClaudeAdapter({ binaryPath: bin }));
    const gate = gateWithCanary(registry, dataDir);

    let versionLine = "2.1.296 (Claude Code)\n";
    const runner: ProbeRunner = (argv, opts) => runnerFor(claudeTable(bin, versionLine))(argv, opts);

    const t = 1000;
    const preflight = new PreflightCache({ ttlMs: 60_000, now: () => t });
    const deps = (): CollectDeps => ({
      registry,
      runner,
      platform: "linux",
      gate,
      preflight,
    });

    const first = await evaluateEligibility(request(), deps());
    expect(first.eligible).toEqual(["claude"]);

    utimesSync(bin, new Date(2_000_000), new Date(2_000_000));
    versionLine = "2.1.297 (Claude Code)\n";

    const bumped = await evaluateEligibility(request(), deps());
    expect(bumped.eligible).toEqual([]);
    const excluded = bumped.excluded.find((e) => e.provider === "claude");
    expect(excluded?.primary.code).toBe("ADAPTER_VERSION_UNVERIFIED");
    expect(excluded?.failureCode).toBe("ADAPTER_VERSION_UNVERIFIED");
    expect(excluded?.primary.detail).toMatch(/version canary/i);
    expect(excluded?.primary.detail).toContain("2.1.297");
    expect(excluded?.primary.detail).toContain("2.1.296");

    recordAdapterVersion(dataDir, "claude", "2.1.297");
    const afterValidate = await evaluateEligibility(request(), {
      ...deps(),
      gate: gateWithCanary(registry, dataDir),
    });
    expect(afterValidate.eligible).toEqual(["claude"]);
  });
});
