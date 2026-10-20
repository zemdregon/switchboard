/**
 * Provider registry table (T4.1; NFR-MAINT-01, FR-POL-03, FR-ADP-01; ADR-0035; LLD §2 "Provider ids").
 *
 * 1. Every derived constant equals what the code held before T4.1 (external behaviour unchanged).
 * 2. A scratch adapter from a fixture module, registered with no other source edit, appears in `doctor`,
 *    `list_capabilities` (the registry `serve` builds) and config validation, and disappears when removed.
 * 3. Every adapter-declared bypass-class flag is refused before spawn except in the approved bypass case (the T3.17
 *    matrix), and a declaration can only add to the shared `BYPASS_FLAGS`.
 * No provider CLI is run: the scratch adapter runs the bundled fake CLI and other probe commands are refused.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { defaultAdapters } from "../cli/doctor.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { buildRegistry } from "../cli/serve.js";
import { configSchema, configSchemaFor, PROVIDER_IDS, validateConfig } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { createSwitchboardServer } from "../mcp/index.js";
import { resolveTrustProfile } from "../policy/profiles.js";
import { CONFIG_TO_ADAPTER_ID, isProviderEnabled } from "../routing/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  assertBypassAudit,
  auditInvocation,
  BYPASS_FLAGS,
  type BypassContext,
  BypassFlagError,
  bypassClassFlags,
  findBypassFlags,
} from "./audit.js";
import { FakeAdapter } from "./fake/adapter.js";
import { FAKE_PROFILE } from "./fake/cases.js";
import { LOOSE_SCOPE, privilegedProfile } from "./fixtures/privileged.js";
import {
  SCRATCH_BYPASS_FLAG,
  SCRATCH_CONFIG_ID,
  SCRATCH_ID,
  SCRATCH_PROVIDER,
  ScratchAdapter,
} from "./fixtures/scratch-provider.js";
import {
  acceptedProviderNames,
  adapterIdForConfigId,
  BUILTIN_PROVIDERS,
  canonicalProviderId,
  configIdForAdapterId,
  configIdForProviderName,
  declaredBypassFlags,
  type ProviderEntry,
  ProviderRegistrationError,
  providerEntries,
  providerEntry,
  providerGeneration,
  registerProvider,
} from "./providers.js";
import { AdapterRegistry } from "./registry.js";
import { createProbeRunner, startAdapterRun } from "./run.js";
import {
  type Invocation,
  type ProbeRunner,
  type ProviderId,
  type ResolvedProfile,
  resumeMayChangeDirectory,
} from "./types.js";

/** Removes every registration a test made, so module state never leaks into other tests (or files). */
const cleanups: (() => void)[] = [];
const register = (entry: ProviderEntry) => {
  const off = registerProvider(entry);
  cleanups.push(off);
  return off;
};
afterEach(() => {
  for (const off of cleanups.splice(0).reverse()) off();
});

describe("provider name aliases (ADR-0076)", () => {
  it("every built-in provider is named by its adapter id (canonical) and its config id (alias)", () => {
    for (const e of BUILTIN_PROVIDERS) {
      expect(canonicalProviderId(e.id), e.id).toBe(e.id);
      if ("configId" in e) {
        expect(canonicalProviderId(e.configId), e.configId).toBe(e.id);
        expect(configIdForProviderName(e.id), e.id).toBe(e.configId);
        expect(configIdForProviderName(e.configId), e.configId).toBe(e.configId);
      }
    }
    expect(canonicalProviderId("claude-code")).toBe("claude");
    expect(canonicalProviderId("grok-build")).toBe("grok");
    expect(canonicalProviderId("kimi-code")).toBe("kimi");
    expect(canonicalProviderId("muse-code")).toBe("muse");
    expect(configIdForProviderName("fake")).toBeUndefined(); // test-only: no config spelling
  });

  it("unknown names, other cases and padded names name nothing (exact, lower-case match)", () => {
    for (const n of ["", "nope", "Claude", "CLAUDE-CODE", " claude", "claude-cod", "claude_code"]) {
      expect(canonicalProviderId(n), n).toBeUndefined();
      expect(configIdForProviderName(n), n).toBeUndefined();
    }
  });

  it("acceptedProviderNames lists both spellings, canonical first, and keeps unknown names", () => {
    expect(acceptedProviderNames(["claude", "grok-build", "fake", "other"])).toEqual([
      "claude",
      "claude-code",
      "grok",
      "grok-build",
      "fake",
      "other",
    ]);
    expect(acceptedProviderNames()).toContain("muse-code");
  });

  it("a runtime-registered provider gets the same alias, and loses it when removed", () => {
    const off = register(SCRATCH_PROVIDER);
    expect(canonicalProviderId(SCRATCH_CONFIG_ID)).toBe(SCRATCH_ID);
    expect(configIdForProviderName(SCRATCH_ID)).toBe(SCRATCH_CONFIG_ID);
    off();
    expect(canonicalProviderId(SCRATCH_CONFIG_ID)).toBeUndefined();
  });
});

describe("derived constants equal the pre-T4.1 values", () => {
  it("adapter ids, config ids and their mapping", () => {
    expect(BUILTIN_PROVIDERS.map((e) => e.id)).toEqual([
      "claude",
      "codex",
      "grok",
      "antigravity",
      "cursor",
      "opencode",
      "kimi",
      "muse",
      "fake",
    ]);
    expect([...PROVIDER_IDS]).toEqual([
      "claude-code",
      "codex",
      "grok-build",
      "antigravity",
      "cursor",
      "opencode",
      "kimi-code",
      "muse-code",
    ]);
    expect(CONFIG_TO_ADAPTER_ID).toEqual({
      "claude-code": "claude",
      codex: "codex",
      "grok-build": "grok",
      antigravity: "antigravity",
      cursor: "cursor",
      opencode: "opencode",
      "kimi-code": "kimi",
      "muse-code": "muse",
    });
    expect(configIdForAdapterId("fake")).toBeUndefined();
    expect(adapterIdForConfigId("kimi-code")).toBe("kimi");
    expect(adapterIdForConfigId("muse-code")).toBe("muse"); // added with its adapter task, T4.72 (LLD §2)
  });

  it("the config schema rebuilt from the built-in ids is byte-identical", () => {
    expect(JSON.stringify(configSchemaFor(PROVIDER_IDS))).toBe(JSON.stringify(configSchema));
  });

  it("serve and doctor register the same adapters in the same order", () => {
    const ids = (r: { list(): { id: string }[] }) => r.list().map((a) => a.id);
    expect(ids(buildRegistry({ enabled: false }))).toEqual([
      "claude",
      "codex",
      "grok",
      "antigravity",
      "cursor",
      "opencode",
      "kimi",
      "muse",
    ]);
    expect(ids(buildRegistry({ enabled: true, scenario: "success" }))).toEqual([
      "claude",
      "codex",
      "grok",
      "antigravity",
      "cursor",
      "opencode",
      "kimi",
      "muse",
      "fake",
    ]);
    expect(ids(defaultAdapters())).toEqual([
      "fake",
      "claude",
      "codex",
      "grok",
      "antigravity",
      "cursor",
      "opencode",
      "kimi",
      "muse",
    ]);
    // The Claude git_channel opt-in still reaches only the Claude adapter.
    const on = buildRegistry({ enabled: false }, { claudeGitChannel: true });
    expect(on.get("claude")?.gitCapabilities.commitChannel).toBe("injected");
    expect(on.get("codex")?.gitCapabilities.commitChannel).toBe("none");
    expect(buildRegistry({ enabled: false }).get("claude")?.gitCapabilities.commitChannel).toBe("none");
  });

  it("the audit list starts with the unchanged shared BYPASS_FLAGS and adds the declared flags", () => {
    expect(BYPASS_FLAGS).toEqual([
      "--dangerously-skip-permissions",
      "--yolo",
      "--force",
      "--always-approve",
      "--approve-mcps",
      "--full-auto",
    ]);
    const all = bypassClassFlags();
    expect(all.slice(0, BYPASS_FLAGS.length)).toEqual([...BYPASS_FLAGS]);
    expect(all).toContain("--allow-dangerously-skip-permissions");
    expect(new Set(all).size).toBe(all.length);
    for (const f of declaredBypassFlags()) expect(all).toContain(f);
  });
});

describe("resumeCwd declarations (T5.7; ADR-0038 item 6.3, TDD §4.10)", () => {
  it("the table names TDD §4.10's value for every built-in provider", () => {
    expect(Object.fromEntries(BUILTIN_PROVIDERS.map((e) => [e.id, e.resumeCwd]))).toEqual({
      claude: "independent",
      codex: "independent",
      grok: "unverified",
      antigravity: "bound",
      cursor: "unverified",
      opencode: "unverified",
      kimi: "unverified",
      muse: "bound",
      fake: "bound",
    });
  });

  it("every adapter declares the value of its entry, and only `independent` lets a resume change directory", () => {
    for (const entry of providerEntries()) {
      if (entry.create === undefined) continue;
      const adapter = entry.create({});
      expect(adapter.resumeCwd, entry.id).toBe(entry.resumeCwd);
      expect(resumeMayChangeDirectory(adapter), entry.id).toBe(entry.id === "claude" || entry.id === "codex");
    }
    expect(resumeMayChangeDirectory({ resumeCwd: "independent" })).toBe(true);
    for (const v of ["bound", "unverified", undefined, "Independent", null]) {
      expect(resumeMayChangeDirectory({ resumeCwd: v })).toBe(false);
    }
  });

  it("Claude and Codex declare independent from their T5.12 cell 2 captures, so a resume may change directory", () => {
    const claude = providerEntry("claude");
    const codex = providerEntry("codex");
    expect(claude?.resumeCwd).toBe("independent");
    expect(codex?.resumeCwd).toBe("independent");
    expect(resumeMayChangeDirectory({ resumeCwd: claude?.resumeCwd })).toBe(true);
    expect(resumeMayChangeDirectory({ resumeCwd: codex?.resumeCwd })).toBe(true);
  });
});

describe("registerProvider refuses anything but a clean addition", () => {
  const base: ProviderEntry = { id: "zeta", configId: "zeta-cli", kind: "real", bypassFlags: [] };
  const cases: [string, ProviderEntry, RegExp][] = [
    ["a built-in id", { ...base, id: "claude" }, /id claude is already registered/],
    ["a built-in config id", { ...base, configId: "claude-code" }, /config id claude-code is already registered/],
    ["an adapter id used as config id", { ...base, configId: "grok" }, /config id grok is already registered/],
    ["a test-only entry", { id: "zeta", kind: "test", bypassFlags: [] }, /test-only/],
    ["a real provider without config id", { id: "zeta", kind: "real", bypassFlags: [] }, /needs a config id/],
    ["a malformed id", { ...base, id: "Zeta!" }, /does not match/],
    ["a flag with a value", { ...base, bypassFlags: ["--x=1"] }, /malformed bypass flag/],
    ["a flag without dashes", { ...base, bypassFlags: ["x"] }, /malformed bypass flag/],
    ["an empty flag", { ...base, bypassFlags: [""] }, /malformed bypass flag/],
    ["three dashes", { ...base, bypassFlags: ["---x"] }, /malformed bypass flag/],
    ["a lone dash", { ...base, bypassFlags: ["-"] }, /malformed bypass flag/],
    [
      "a malformed resumeCwd",
      { ...base, resumeCwd: "maybe" as NonNullable<ProviderEntry["resumeCwd"]> },
      /malformed resumeCwd/,
    ],
  ];
  for (const [label, entry, message] of cases) {
    it(label, () => {
      const before = { gen: providerGeneration(), entries: providerEntries().length, flags: bypassClassFlags() };
      expect(() => registerProvider(entry)).toThrow(ProviderRegistrationError);
      expect(() => registerProvider(entry)).toThrow(message);
      expect(providerGeneration()).toBe(before.gen);
      expect(providerEntries()).toHaveLength(before.entries);
      expect(bypassClassFlags()).toEqual(before.flags);
    });
  }

  it("a second registration of the same scratch entry is refused; removal is idempotent", () => {
    const off = register(SCRATCH_PROVIDER);
    expect(() => registerProvider(SCRATCH_PROVIDER)).toThrow(/already registered/);
    off();
    off();
    expect(providerEntries().some((e) => e.id === SCRATCH_ID)).toBe(false);
  });

  it("built-in entries and their flag lists are frozen", () => {
    expect(Object.isFrozen(BUILTIN_PROVIDERS)).toBe(true);
    for (const e of BUILTIN_PROVIDERS) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.bypassFlags)).toBe(true);
    }
    expect(() => (BUILTIN_PROVIDERS[0].bypassFlags as unknown as string[]).pop()).toThrow(TypeError);
  });

  it("an entry cannot remove a shared or built-in flag", () => {
    const before = bypassClassFlags();
    register({ ...base, bypassFlags: [] });
    expect(bypassClassFlags()).toEqual(before);
    register({ id: "eta", configId: "eta-cli", kind: "real", bypassFlags: ["--yolo", "--eta-unsafe"] });
    expect(bypassClassFlags()).toEqual([...before, "--eta-unsafe"]);
  });
});

describe("scratch adapter registered from a fixture module (T4.1 Done when)", () => {
  let tmp: string;
  let repos: string;
  let configPath: string;
  const writeConfig = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: path.join(tmp, "data"),
        allowed_roots: [repos],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
        ...extra,
      }),
    );

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-providers-")));
    repos = path.join(tmp, "repos");
    mkdirSync(repos);
    configPath = path.join(tmp, "config.json");
    writeConfig();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const scratchConfig = {
    schema_version: 1,
    allowed_roots: ["/x"],
    mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
    providers: { [SCRATCH_CONFIG_ID]: { enabled: false, weight: 0.5 } },
    projects: [
      {
        id: "proj",
        name: "P",
        allowed_providers: [SCRATCH_CONFIG_ID],
        contexts: [{ id: "main", kind: "repository", path: "/x/r", base_ref: "main" }],
      },
    ],
  };

  it("config validation accepts its config id only while it is registered", () => {
    expect(() => validateConfig(scratchConfig)).toThrow(/providers/);
    const off = register(SCRATCH_PROVIDER);
    expect(validateConfig(scratchConfig)).toMatchObject({ providers: { [SCRATCH_CONFIG_ID]: { enabled: false } } });
    // `git_channel` stays Claude Code only.
    const withChannel = { ...scratchConfig, providers: { [SCRATCH_CONFIG_ID]: { git_channel: true } } };
    expect(() => validateConfig(withChannel)).toThrow(/git_channel|additional/);
    expect(isProviderEnabled(scratchConfig as never, SCRATCH_ID as ProviderId)).toBe(false);
    expect(adapterIdForConfigId(SCRATCH_CONFIG_ID)).toBe(SCRATCH_ID);
    off();
    expect(() => validateConfig(scratchConfig)).toThrow(/providers/);
    expect(adapterIdForConfigId(SCRATCH_CONFIG_ID)).toBeUndefined();
  });

  it("doctor probes it with its registry label and honours providers.<config id>.enabled", async () => {
    register(SCRATCH_PROVIDER);
    expect(
      defaultAdapters()
        .list()
        .map((a) => a.id),
    ).toEqual(["fake", "claude", "codex", "grok", "antigravity", "cursor", "opencode", "kimi", "muse", SCRATCH_ID]);
    const scratchOnly = () => {
      const r = buildRegistry({ enabled: false });
      const a = r.get(SCRATCH_ID as ProviderId);
      if (!a) throw new Error("scratch adapter not registered by serve");
      return new AdapterRegistry().register(a);
    };
    const doctor = async () => {
      const out: string[] = [];
      const io: CliIo = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => true }, env: {}, user: "t" };
      await main(["doctor", "--json", "--config", configPath], { ...io, adapters: scratchOnly() });
      return JSON.parse(out.join(""));
    };
    const j = await doctor();
    expect(j.adapters).toHaveLength(1);
    expect(j.adapters[0]).toMatchObject({
      id: SCRATCH_ID,
      label: "Scratch CLI (synthetic T4.1 test adapter)",
      kind: "real",
    });
    expect(j.adapters[0].probe.ok).toBe(true);
    writeConfig({ providers: { [SCRATCH_CONFIG_ID]: { enabled: false } } });
    expect((await doctor()).adapters[0]).toMatchObject({ id: SCRATCH_ID, status: "skip" });
  });

  it("list_capabilities on the registry serve builds reports it", async () => {
    register(SCRATCH_PROVIDER);
    const registry = buildRegistry({ enabled: false });
    expect(registry.list().map((a) => a.id)).toEqual([
      "claude",
      "codex",
      "grok",
      "antigravity",
      "cursor",
      "opencode",
      "kimi",
      "muse",
      SCRATCH_ID,
    ]);
    const dataDir = path.join(tmp, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
    // Only the bundled fake CLI (node) may run; any real provider binary found on PATH is refused, not run.
    const real = createProbeRunner();
    const probeRunner: ProbeRunner = async (argv, opts) =>
      argv[0] === process.execPath
        ? real(argv, opts)
        : { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "refused in tests" };
    const lifecycle = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [repos], ids }),
      artifacts,
      adapters: registry,
      allowedRoots: [repos],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
      probeRunner,
      eligibility: { platform: "linux", gate: (id, v, dir) => registry.gate(id, v, dir) },
    });
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config: {
        allowedRoots: [repos],
        projects: [],
        mcpClients: new Map([["c1", { id: "c1", maxTrustProfile: "edit-untrusted" as const }]]),
      },
      clientId: "c1",
    });
    const client = new Client({ name: "t", version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.server.connect(serverSide);
      await client.connect(clientSide);
      await client.listTools();
      const res = await client.callTool({ name: "list_capabilities", arguments: {} });
      const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}");
      const scratch = body.providers.find((p: { provider: string }) => p.provider === SCRATCH_ID);
      expect(body.providers.map((p: { provider: string }) => p.provider)).toEqual([
        "claude",
        "codex",
        "grok",
        "antigravity",
        "cursor",
        "opencode",
        "kimi",
        "muse",
        SCRATCH_ID,
      ]);
      // No compliance manifest: fail closed (ADR-0009), but listed with its declarations.
      expect(scratch).toMatchObject({ adapter_status: "NO_MANIFEST", transports: ["subprocess-jsonl"] });
      expect(scratch.git_write_control.kind).toBe("none-documented");
    } finally {
      await client.close();
      await mcp.close();
      await lifecycle.shutdown();
      db.close();
    }
  });
});

describe("adapter-declared bypass-class flags in the argv audit (T3.17 matrix; FR-POL-03, ADR-0035)", () => {
  const request = { runId: "r", objective: "x", constraints: [], workspace: { cwd: "/tmp", writable: true } };
  const fakeInv = () => new FakeAdapter().compile(request, FAKE_PROFILE) as Invocation;
  const PRIV_BYPASS = privilegedProfile({ ...LOOSE_SCOPE, bypass: true });
  const PRIV_NO_BYPASS = privilegedProfile(LOOSE_SCOPE);
  const profiles: Array<[string, Pick<ResolvedProfile, "name" | "privilegedScope">]> = [
    ["inspect-untrusted", resolveTrustProfile("inspect-untrusted")],
    ["edit-untrusted", resolveTrustProfile("edit-untrusted")],
    ["test-sandboxed", resolveTrustProfile("test-sandboxed")],
    ["trusted-development", resolveTrustProfile("trusted-development")],
    ["privileged, scope bypass false", PRIV_NO_BYPASS],
    ["privileged, scope bypass true", PRIV_BYPASS],
    ["privileged, no scope binding", { name: "privileged" }],
    ["edit-untrusted carrying a bypass scope", { ...PRIV_BYPASS, name: "edit-untrusted" }],
  ];

  for (const [label, profile] of profiles) {
    for (const bypassApproved of [false, true]) {
      const allowed = label === "privileged, scope bypass true" && bypassApproved;
      it(`${label}, bypassApproved=${bypassApproved}: declared flags ${allowed ? "admitted" : "refused"}`, () => {
        register(SCRATCH_PROVIDER);
        const ctx: BypassContext = { profile, bypassApproved };
        const declared = declaredBypassFlags();
        expect(declared).toEqual(
          expect.arrayContaining([
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--yolo",
            "--full-auto",
            SCRATCH_BYPASS_FLAG,
          ]),
        );
        for (const f of declared) {
          for (const arg of [f, `${f}=1`]) {
            const inv = { ...fakeInv(), argv: [...fakeInv().argv, arg] };
            expect(findBypassFlags(inv)).toEqual([f]);
            expect(auditInvocation(inv, ctx)).toEqual(allowed ? [] : [f]);
            if (allowed) expect(() => assertBypassAudit(inv, ctx)).not.toThrow();
            else {
              expect(() => startAdapterRun(new FakeAdapter(), inv, { profile, bypassApproved })).toThrow(
                BypassFlagError,
              );
            }
          }
          const viaPolicy = { ...fakeInv(), policyFlags: [f] };
          expect(auditInvocation(viaPolicy, ctx)).toEqual(allowed ? [] : [f]);
        }
        // Without a context every declared flag is refused.
        for (const f of declared) expect(auditInvocation({ ...fakeInv(), argv: [f] })).toEqual([f]);
      });
    }
  }

  it("the scratch adapter emits its flag only for an approved bypass scope; the audit gates the spawn", async () => {
    register(SCRATCH_PROVIDER);
    const a = new ScratchAdapter();
    const cwd = mkdtempSync(path.join(tmpdir(), "sb-scratch-"));
    try {
      const req = { ...request, workspace: { cwd, writable: true } };
      const approved = { ...PRIV_BYPASS, bypassApproved: true };
      const inv = a.compile(req, approved) as Invocation;
      expect(inv.argv).toContain(SCRATCH_BYPASS_FLAG);
      expect(a.compile(req, PRIV_BYPASS)).toMatchObject({ ineligible: true });
      expect(a.compile(req, { ...PRIV_NO_BYPASS, bypassApproved: true })).toMatchObject({ ineligible: true });
      expect(() => startAdapterRun(a, inv)).toThrow(BypassFlagError);
      expect(() => startAdapterRun(a, inv, { profile: PRIV_BYPASS, bypassApproved: false })).toThrow(BypassFlagError);
      expect(() => startAdapterRun(a, inv, { profile: PRIV_NO_BYPASS, bypassApproved: true })).toThrow(BypassFlagError);
      const run = startAdapterRun(a, inv, { profile: PRIV_BYPASS, bypassApproved: true });
      expect((await run.done).groupEmpty).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("the audit reads the table at call time: removing the scratch entry drops only its own flag", () => {
    const off = register(SCRATCH_PROVIDER);
    const inv = { ...fakeInv(), argv: [...fakeInv().argv, SCRATCH_BYPASS_FLAG, "--yolo"] };
    expect(auditInvocation(inv)).toEqual([SCRATCH_BYPASS_FLAG, "--yolo"]);
    off();
    expect(auditInvocation(inv)).toEqual(["--yolo"]);
    for (const f of BYPASS_FLAGS) expect(auditInvocation({ ...fakeInv(), argv: [f] })).toEqual([f]);
    expect(auditInvocation({ ...fakeInv(), argv: ["--allow-dangerously-skip-permissions"] })).toEqual([
      "--allow-dangerously-skip-permissions",
    ]);
  });
});

describe("module evaluation order (the audit and the table import each other)", () => {
  const orders = [
    ["./claude/adapter.js", "./audit.js", "./providers.js"],
    ["./audit.js", "./claude/adapter.js", "./providers.js"],
    ["./providers.js", "./audit.js", "./claude/adapter.js"],
    ["../config/schema.js", "./audit.js", "./providers.js"],
  ];
  for (const order of orders) {
    it(`loads in the order ${order.join(", ")}`, async () => {
      vi.resetModules();
      for (const m of order) await import(m);
      const audit = (await import("./audit.js")) as typeof import("./audit.js");
      expect(audit.bypassClassFlags()).toContain("--allow-dangerously-skip-permissions");
    });
  }
});
