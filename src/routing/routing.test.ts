import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../adapters/claude/adapter.js";
import { CodexAdapter } from "../adapters/codex/adapter.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { ProbeOutput, ProbeRunner, ProviderId, ResolvedProfile, TrustProfile } from "../adapters/types.js";
import {
  type CollectDeps,
  type EligibilityRequest,
  evaluateEligibility,
  failureCodeForReason,
  filterEligible,
  isProviderEnabled,
  toRouteDecisionJson,
} from "./index.js";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const CLAUDE = "/opt/synthetic/bin/claude"; // never executed
const CODEX = "/opt/synthetic/bin/codex"; // never executed
const CLAUDE_HELP =
  "-p, --print\n--output-format stream-json\n--permission-mode dontAsk\n--permission-prompts\n--tools\n--allowedTools\n--disallowedTools\n--safe-mode\n--restricted\n--strict-mcp-config\n--resume\n";
const CODEX_HELP = "--json --sandbox --ignore-user-config --ignore-rules";

type Table = Record<string, Partial<ProbeOutput>>;
function runnerFor(table: Table): ProbeRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...table[`${argv[0]} ${argv.slice(1).join(" ")}`] };
  }) as ProbeRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}
const claudeTable = (over: Table = {}, version = "2.1.296 (Claude Code)\n"): Table => ({
  [`${CLAUDE} --version`]: { stdout: version },
  [`${CLAUDE} --help`]: { stdout: CLAUDE_HELP },
  [`${CLAUDE} auth status --json`]: { stdout: '{"loggedIn":true}' },
  ...over,
});
const codexTable: Table = {
  [`${CODEX} --version`]: { stdout: "codex-cli 1.2.3\n" },
  [`${CODEX} exec --help`]: { stdout: CODEX_HELP },
};

const profile = (name: TrustProfile, over: Partial<ResolvedProfile> = {}): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
  ...over,
});

function registry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(new ClaudeAdapter({ binaryPath: CLAUDE }))
    .register(new CodexAdapter({ executable: CODEX }));
}

function request(over: Partial<EligibilityRequest> = {}): EligibilityRequest {
  const trustProfile = over.trustProfile ?? "edit-untrusted";
  return {
    candidates: ["claude", "codex"],
    trustProfile,
    clientMaxProfile: "edit-untrusted",
    profile: profile(trustProfile),
    requirements: { network: "off", writable: true },
    cwd: "/tmp/synthetic-worktree",
    ...over,
  };
}

const deps = (runner: ProbeRunner, over: Partial<CollectDeps> = {}): CollectDeps => ({
  registry: registry(),
  runner,
  platform: "linux",
  ...over,
});

/** Lets Codex past the shipped (deliberately empty) version range so later constraints can be tested. */
const passGate: CollectDeps["gate"] = (id) => ({
  eligible: true,
  evidence: { provider: id, observedVersion: "x", validatedRange: "x", validatedCliVersion: "x" },
});

const excludedFor = (d: Awaited<ReturnType<typeof evaluateEligibility>>, p: ProviderId) =>
  d.excluded.find((e) => e.provider === p);

describe("eligibility filter (T2.3, FR-RTE-01, FR-MCP-05)", () => {
  it("keeps eligible providers in candidate order and excludes the rest with reasons", async () => {
    const d = await evaluateEligibility(request(), deps(runnerFor({ ...claudeTable(), ...codexTable })));
    expect(d.eligible).toEqual(["claude"]);
    expect(d.outcome).toEqual({ kind: "eligible", providers: ["claude"] });
    expect(excludedFor(d, "codex")?.primary.code).toBe("ADAPTER_VERSION_UNVERIFIED");
  });

  it("provider disabled in config: excluded and never executed", async () => {
    const runner = runnerFor({ ...claudeTable(), ...codexTable });
    const config = { providers: { "claude-code": { enabled: false } } };
    const d = await evaluateEligibility(request({ candidates: ["claude"] }), deps(runner, { config }));
    expect(excludedFor(d, "claude")?.primary.code).toBe("PROVIDER_DISABLED");
    expect(excludedFor(d, "claude")?.failureCode).toBe("ELIGIBILITY_NONE");
    expect(d.outcome.kind).toBe("none_eligible");
    expect(runner.calls).toEqual([]);
    expect(isProviderEnabled(config, "claude")).toBe(false);
    expect(isProviderEnabled(config, "codex")).toBe(true);
  });

  it("client trust ceiling exceeded: nothing is eligible and the code is PERMISSION_BLOCKED", async () => {
    const runner = runnerFor(claudeTable());
    const d = await evaluateEligibility(
      request({ candidates: ["claude"], trustProfile: "edit-untrusted", clientMaxProfile: "inspect-untrusted" }),
      deps(runner),
    );
    expect(d.eligible).toEqual([]);
    expect(d.requestReason?.code).toBe("CLIENT_TRUST_CEILING_EXCEEDED");
    expect(d.outcome).toMatchObject({ kind: "client_ceiling_exceeded", failureCode: "PERMISSION_BLOCKED" });
    expect(failureCodeForReason("CLIENT_TRUST_CEILING_EXCEEDED")).toBe("PERMISSION_BLOCKED");
  });

  it("binary missing", async () => {
    const reg = new AdapterRegistry().register(new ClaudeAdapter({ binaryPath: "definitely-not-a-binary-xyz" }));
    const d = await evaluateEligibility(request({ candidates: ["claude"] }), deps(runnerFor({}), { registry: reg }));
    expect(excludedFor(d, "claude")?.primary.code).toBe("BINARY_MISSING");
  });

  it("failed probe step (flags missing) is PROBE_FAILED", async () => {
    const t = claudeTable({ [`${CLAUDE} --help`]: { stdout: "-p, --print\n" } });
    const d = await evaluateEligibility(request({ candidates: ["claude"] }), deps(runnerFor(t)));
    expect(excludedFor(d, "claude")?.primary).toMatchObject({ code: "PROBE_FAILED" });
  });

  it("version unverified with the shipped Codex manifest; auth is not run on an unvalidated binary", async () => {
    const runner = runnerFor(codexTable);
    const d = await evaluateEligibility(request({ candidates: ["codex"] }), deps(runner));
    const ex = excludedFor(d, "codex");
    expect(ex?.primary.code).toBe("ADAPTER_VERSION_UNVERIFIED");
    expect(ex?.failureCode).toBe("ADAPTER_VERSION_UNVERIFIED");
    expect(ex?.primary.evidence).toMatchObject({ observedVersion: "codex-cli 1.2.3", validatedRange: "<0.0.0" });
  });

  it("claude outside its validated range is ADAPTER_VERSION_UNVERIFIED", async () => {
    const t = claudeTable({}, "9.9.9 (Claude Code)\n");
    const d = await evaluateEligibility(request({ candidates: ["claude"] }), deps(runnerFor(t)));
    expect(excludedFor(d, "claude")?.primary.code).toBe("ADAPTER_VERSION_UNVERIFIED");
  });

  it("no manifest is NO_MANIFEST (FRD BR-3: ELIGIBILITY_NONE, not ADAPTER_VERSION_UNVERIFIED)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-nomanifest-"));
    tmp.push(dir);
    const d = await evaluateEligibility(
      request({ candidates: ["claude"] }),
      deps(runnerFor(claudeTable()), { manifestDir: dir }),
    );
    const ex = excludedFor(d, "claude");
    expect(ex?.primary.code).toBe("NO_MANIFEST");
    expect(ex?.failureCode).toBe("ELIGIBILITY_NONE");
  });

  it("auth required carries the native login command", async () => {
    const t = claudeTable({ [`${CLAUDE} auth status --json`]: { stdout: '{"loggedIn":false}', exitCode: 1 } });
    const d = await evaluateEligibility(request({ candidates: ["claude"] }), deps(runnerFor(t)));
    const ex = excludedFor(d, "claude");
    expect(ex?.primary.code).toBe("AUTH_REQUIRED");
    expect(ex?.failureCode).toBe("AUTH_REQUIRED");
    expect(ex?.primary.evidence).toMatchObject({ loginCommand: expect.stringContaining("claude") });
  });

  it("auth unknown fails closed (Claude unparseable status, and Codex which has no status command)", async () => {
    const t = claudeTable({ [`${CLAUDE} auth status --json`]: { stdout: "garbage", exitCode: 1 } });
    const d = await evaluateEligibility(request(), deps(runnerFor({ ...t, ...codexTable }), { gate: passGate }));
    expect(d.eligible).toEqual([]);
    expect(excludedFor(d, "claude")?.primary.code).toBe("AUTH_UNKNOWN");
    expect(excludedFor(d, "codex")?.primary.code).toBe("AUTH_UNKNOWN");
    expect(excludedFor(d, "claude")?.failureCode).toBe("ELIGIBILITY_NONE");
  });

  it("capability missing: model not expressible (Claude) and no model flag (Codex)", async () => {
    const d = await evaluateEligibility(
      request({ requirements: { network: "off", writable: true, model: "not a model!" } }),
      deps(runnerFor({ ...claudeTable(), ...codexTable }), { gate: passGate }),
    );
    expect(excludedFor(d, "claude")?.reasons.map((r) => r.code)).toEqual(["CAPABILITY_MISSING"]);
    const codex = excludedFor(d, "codex");
    expect(codex?.reasons.map((r) => r.code)).toContain("CAPABILITY_MISSING");
    expect(codex?.reasons[0]?.code).toBe("AUTH_UNKNOWN"); // check order: auth before capability
  });

  it("shell allowlist not supported: unexpressible Claude entries and broad shell on both", async () => {
    const p = profile("edit-untrusted", { shell: "allowlist", shellAllowlist: ["git status; rm -rf /"] });
    const d = await evaluateEligibility(
      request({
        profile: p,
        requirements: { network: "off", writable: true, shellAllowlist: p.shellAllowlist ?? [] },
      }),
      deps(runnerFor({ ...claudeTable(), ...codexTable }), { gate: passGate }),
    );
    expect(excludedFor(d, "claude")?.reasons.map((r) => r.code)).toEqual(["PROFILE_UNSUPPORTED"]);
    expect(excludedFor(d, "claude")?.primary.evidence).toMatchObject({
      requirements: { shellAllowlist: ["git status; rm -rf /"] },
    });
    const broad = await evaluateEligibility(
      request({ profile: profile("edit-untrusted", { shell: "broad" }) }),
      deps(runnerFor({ ...claudeTable(), ...codexTable }), { gate: passGate }),
    );
    expect(excludedFor(broad, "codex")?.reasons.map((r) => r.code)).toContain("PROFILE_UNSUPPORTED");
    expect(excludedFor(broad, "claude")?.reasons.map((r) => r.code)).toEqual(["PROFILE_UNSUPPORTED"]);
  });

  it("profile unsupported by the adapter is never downgraded", async () => {
    const d = await evaluateEligibility(
      request({ trustProfile: "test-sandboxed", clientMaxProfile: "privileged", candidates: ["claude"] }),
      deps(runnerFor(claudeTable())),
    );
    const ex = excludedFor(d, "claude");
    expect(ex?.primary.code).toBe("PROFILE_UNSUPPORTED");
    expect(ex?.failureCode).toBe("ELIGIBILITY_NONE");
    expect(d.outcome).toMatchObject({ kind: "none_eligible", failureCode: "ELIGIBILITY_NONE" });
  });

  it("unsupported platform: excluded without executing the provider", async () => {
    const runner = runnerFor(claudeTable());
    const d = await evaluateEligibility(
      request({ candidates: ["claude"] }),
      deps(runner, { platform: "linux", supportedPlatforms: () => ["darwin"] }),
    );
    expect(excludedFor(d, "claude")?.primary).toMatchObject({
      code: "PLATFORM_UNSUPPORTED",
      evidence: { platform: "linux", supportedPlatforms: ["darwin"] },
    });
    expect(runner.calls).toEqual([]);
  });

  it("unregistered adapter is excluded", async () => {
    const d = await evaluateEligibility(request({ candidates: ["grok"] }), deps(runnerFor({})));
    expect(excludedFor(d, "grok")?.primary.code).toBe("ADAPTER_NOT_REGISTERED");
  });

  describe("require_provider (BR-2): explicit provider ineligible -> error, no silent substitution", () => {
    it("fails with the BR-3 code even though another candidate is eligible", async () => {
      const runner = runnerFor({ ...claudeTable(), ...codexTable });
      const d = await evaluateEligibility(
        request({ candidates: ["claude", "codex"], requiredProvider: "codex" }),
        deps(runner),
      );
      expect(d.eligible).toEqual([]);
      expect(d.outcome).toMatchObject({
        kind: "required_provider_ineligible",
        provider: "codex",
        failureCode: "ADAPTER_VERSION_UNVERIFIED",
      });
      expect(runner.calls.every((c) => c[0] === CODEX)).toBe(true); // claude was never even consulted
    });

    it("maps AUTH_REQUIRED and generic reasons per BR-3", async () => {
      const t = claudeTable({ [`${CLAUDE} auth status --json`]: { stdout: '{"loggedIn":false}', exitCode: 1 } });
      const d = await evaluateEligibility(request({ requiredProvider: "claude" }), deps(runnerFor(t)));
      expect(d.outcome).toMatchObject({ kind: "required_provider_ineligible", failureCode: "AUTH_REQUIRED" });
      const off = await evaluateEligibility(
        request({ requiredProvider: "claude" }),
        deps(runnerFor(t), { config: { providers: { "claude-code": { enabled: false } } } }),
      );
      expect(off.outcome).toMatchObject({ kind: "required_provider_ineligible", failureCode: "ELIGIBILITY_NONE" });
    });

    it("an eligible required provider is the only candidate", async () => {
      const d = await evaluateEligibility(
        request({ requiredProvider: "claude" }),
        deps(runnerFor({ ...claudeTable(), ...codexTable })),
      );
      expect(d.outcome).toEqual({ kind: "eligible", providers: ["claude"] });
      expect(d.excluded).toEqual([]);
    });
  });

  it("is deterministic and pure over facts (no I/O in filterEligible)", () => {
    const input = {
      candidates: ["codex", "claude"] as ProviderId[],
      trustProfile: "inspect-untrusted" as const,
      clientMaxProfile: "edit-untrusted" as const,
      requirements: { network: "off" as const, writable: false },
      platform: "linux",
      facts: [
        { provider: "claude" as const, registered: true, enabled: true },
        { provider: "codex" as const, registered: true, enabled: false },
      ],
    };
    const a = filterEligible(input);
    expect(filterEligible(input)).toEqual(a);
    expect(a.excluded.map((e) => [e.provider, e.primary.code])).toEqual([
      ["codex", "PROVIDER_DISABLED"],
      ["claude", "PROBE_FAILED"], // not probed: fail closed
    ]);
  });

  it("serialises to route_decision columns as valid JSON (Proposed: caller inserts after creating the run)", async () => {
    const input = await (async () => {
      const { collectFacts } = await import("./collect.js");
      return collectFacts(request(), deps(runnerFor({ ...claudeTable(), ...codexTable })));
    })();
    const row = toRouteDecisionJson(input, filterEligible(input));
    const cands = JSON.parse(row.candidates_json) as Array<{ provider: string; eligible: boolean }>;
    expect(cands).toEqual([
      expect.objectContaining({ provider: "claude", eligible: true }),
      expect.objectContaining({ provider: "codex", eligible: false }),
    ]);
    expect(() => JSON.parse(row.features_json)).not.toThrow();
    expect(() => JSON.parse(row.reasons_json)).not.toThrow();
  });
});
