/**
 * T4.72 (TDD §4.8): the Muse Code module, manifest, probe, registry entry and compile matrix. SYNTHETIC: no `muse`
 * binary was installed or run. Executable paths are placeholders or the node stand-in `fixtures/fake-muse.mjs`, and
 * the version line is the format a third party reported ([Orca]), not a capture.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../artifacts/index.js";
import { main } from "../../cli/index.js";
import type { CliIo } from "../../cli/io.js";
import { buildRegistry } from "../../cli/serve.js";
import { validateConfig } from "../../config/index.js";
import { buildEnv, supervise } from "../../exec/supervisor.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, openLedger } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { createSwitchboardServer } from "../../mcp/server.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import type { PrivilegedScope } from "../../policy/types.js";
import { WorkspaceManager } from "../../workspace/index.js";
import { auditInvocation, type BypassContext } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { tryLoadManifest } from "../manifest/index.js";
import { adapterIdForConfigId, configIdForAdapterId, providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner } from "../run.js";
import type {
  CompileRequest,
  Invocation,
  ParseState,
  ProbeOutput,
  ProbeRunner,
  ResolvedProfile,
  TrustProfile,
} from "../types.js";
import { isIneligible } from "../types.js";
import {
  MUSE_BYPASS_NOT_APPROVED,
  MUSE_BYPASS_OUTSIDE_PRIVILEGED,
  MUSE_ENV_ALLOWLIST,
  MUSE_GIT_CAPABILITIES,
  MUSE_GIT_WRITE_CONTROL,
  MUSE_PRIVILEGED_NEEDS_BYPASS,
  MuseAdapter,
} from "./adapter.js";
import {
  BYPASS_SCOPE,
  PRIVILEGED_BYPASS_PROFILE,
  SYNTHETIC_EXEC_HELP_STDOUT,
  SYNTHETIC_VERSION_STDOUT,
} from "./fixtures/cases.js";
import { META_API_KEY_ENV, NO_AUTO_UPDATE_ENV } from "./protocol.js";

const FAKE_MUSE = fileURLToPath(new URL("./fixtures/fake-muse.mjs", import.meta.url));
const EXE = "/opt/synthetic/muse";
const dirs: string[] = [];
const makeDir = (prefix = "sb-muse-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
  objective: "fix the failing test",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const adapter = () => new MuseAdapter({ executable: EXE });
const fakeAdapter = () => new MuseAdapter({ executable: process.execPath, launcherArgs: [FAKE_MUSE] });
const NON_PRIVILEGED: TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"];
const approved = (scope: PrivilegedScope = BYPASS_SCOPE): ResolvedProfile => ({
  ...privilegedProfile(scope),
  bypassApproved: true,
});
const approvedCtx = (profile: ResolvedProfile): BypassContext => ({ profile, bypassApproved: true });
const compiled = (inv: Invocation | ReturnType<MuseAdapter["compile"]>): Invocation => {
  if (isIneligible(inv)) throw new Error(`unexpected Ineligible: ${inv.reason} ${inv.detail}`);
  return inv;
};
/** Every compiled cell of the matrix: the approved bypass scopes that compile, network off and on. */
const compiledCells = (): Invocation[] =>
  (["off", "on"] as const).map((mode) =>
    compiled(
      adapter().compile(
        request({ bypassApproved: true }),
        approved({ ...BYPASS_SCOPE, network: { mode } } as PrivilegedScope),
      ),
    ),
  );
/** The only flags and values the adapter may emit (TDD §4.8 sources; see protocol.ts). */
const SOURCED_WORDS = new Set([
  "exec",
  "--json",
  "-w",
  "off",
  "--approval-mode",
  "on-request",
  "--sandbox-network",
  "restricted",
  "unrestricted",
  "--trust-workspace",
]);

describe("muse compile matrix per profile (T4.72)", () => {
  it.each(NON_PRIVILEGED)(
    "%s is Ineligible PROFILE_UNSUPPORTED until T4.71, with and without a bypass approval",
    (name) => {
      const plain = adapter().compile(request(), resolveTrustProfile(name));
      expect(plain).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
      if (isIneligible(plain)) expect(plain.detail).toMatch(/T4\.71/);
      const withApproval = adapter().compile(request({ bypassApproved: true }), {
        ...resolveTrustProfile(name),
        bypassApproved: true,
      });
      expect(withApproval).toMatchObject({ reason: "PROFILE_UNSUPPORTED", detail: MUSE_BYPASS_OUTSIDE_PRIVILEGED });
    },
  );

  it("privileged compiles only an approved bypass scope with worktree files, shell broad, network off or on, repo enabled", () => {
    let count = 0;
    for (const scope of scopeShapes()) {
      for (const ok of [false, true]) {
        const label = JSON.stringify({ scope, ok });
        const r = adapter().compile(request({ bypassApproved: ok }), {
          ...privilegedProfile(scope),
          bypassApproved: ok,
        });
        const expectOk =
          ok &&
          scope.bypass &&
          scope.files.access === "worktree" &&
          scope.shell.mode === "broad" &&
          scope.network.mode !== "allowlist" &&
          scope.repository_config.mode === "enabled";
        if (!expectOk) {
          expect(r, label).toMatchObject({ ineligible: true, detail: expect.any(String) });
          if (isIneligible(r)) expect(r.detail.length, label).toBeGreaterThan(0);
          continue;
        }
        count += 1;
        const inv = compiled(r);
        const net = scope.network.mode === "off" ? "restricted" : "unrestricted";
        expect(inv.argv, label).toEqual([
          EXE,
          "exec",
          "--json",
          "-w",
          "off",
          "--approval-mode",
          "on-request",
          "--sandbox-network",
          net,
          "--trust-workspace",
          "fix the failing test",
        ]);
        expect(inv.policyFlags, label).toEqual([
          "-w",
          "off",
          "--approval-mode",
          "on-request",
          "--sandbox-network",
          net,
          "--trust-workspace",
        ]);
      }
    }
    expect(count).toBe(2);
  });

  it("privileged without bypass, or with bypass but no approval, is Ineligible with its reason", () => {
    const noBypass = privilegedProfile({ ...BYPASS_SCOPE, bypass: false });
    expect(adapter().compile(request(), noBypass)).toEqual({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: MUSE_PRIVILEGED_NEEDS_BYPASS,
    });
    expect(adapter().compile(request(), PRIVILEGED_BYPASS_PROFILE)).toEqual({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: MUSE_BYPASS_NOT_APPROVED,
    });
    const { privilegedScope: _unbound, ...unbound } = PRIVILEGED_BYPASS_PROFILE;
    expect(adapter().compile(request({ bypassApproved: true }), { ...unbound, bypassApproved: true })).toMatchObject({
      reason: "PROFILE_UNSUPPORTED",
      detail: expect.stringContaining("scope binding"),
    });
  });

  it("is the same on every platform: compile reads no host state, so linux and darwin hosts get the same cells", () => {
    // Platform rules are the lifecycle's (profilePlatformSupported); the adapter's matrix has no platform input. The
    // manifest notes say Linux only. Changing process.platform must not change any compiled argv or reason.
    const snapshot = () => [
      ...NON_PRIVILEGED.map((n) => adapter().compile(request(), resolveTrustProfile(n))),
      ...compiledCells(),
    ];
    const linux = snapshot();
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      expect(snapshot()).toEqual(linux);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it("a model, a read-only workspace, a git-writing allowlist, a dash-led or empty objective and a missing binary are Ineligible", () => {
    const p = approved();
    expect(adapter().compile(request({ model: "m", bypassApproved: true }), p)).toMatchObject({
      reason: "CAPABILITY_MISSING",
    });
    expect(
      adapter().compile(request({ bypassApproved: true, workspace: { cwd: "/work/tree", writable: false } }), p),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: expect.stringContaining("read-only") });
    for (const objective of ["--yolo fix it", "-w create", "", "   "]) {
      expect(adapter().compile(request({ objective, bypassApproved: true }), p), objective).toMatchObject({
        reason: "CAPABILITY_MISSING",
        detail: expect.stringContaining("positional"),
      });
    }
    expect(
      adapter().compile(request(), { ...resolveTrustProfile("edit-untrusted"), shellAllowlist: ["git commit -m x"] }),
    ).toMatchObject({ reason: "PROFILE_UNSUPPORTED", detail: expect.stringContaining("FR-GIT-01") });
    expect(new MuseAdapter({ pathEnv: "/nonexistent" }).compile(request({ bypassApproved: true }), p)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("not found on PATH"),
    });
  });
});

describe("muse argv invariants (T4.72)", () => {
  it("`-w off` is present in every compiled argv, as one adjacent pair after `exec`", () => {
    const cells = compiledCells();
    expect(cells).toHaveLength(2);
    for (const inv of cells) {
      const i = inv.argv.indexOf("-w");
      expect(i).toBeGreaterThan(inv.argv.indexOf("exec"));
      expect(inv.argv[i + 1]).toBe("off");
      expect(inv.argv.filter((a) => a === "-w")).toHaveLength(1);
    }
  });

  it("approvals and the sandbox stay on: no bypass-class flag or widening value is ever emitted", () => {
    const never = [
      "--yolo",
      "--disable-approval",
      "--disable-sandbox",
      "never",
      "-c",
      "--config",
      "--session-id",
      "--provider",
      "--prompt-file",
      "--worktree",
      "--worktree-existing",
      "--subagent-worktree-isolation",
      "--allow-workspace-switch",
      "--no-session-log",
      "--approval-judge",
      "--max-model-steps",
      "enabled",
      "create",
      "existing",
    ];
    for (const inv of compiledCells()) {
      const words = inv.argv.slice(1, -1);
      for (const w of words) {
        expect(never.includes(w), w).toBe(false);
        expect(SOURCED_WORDS.has(w), `unsourced word ${w}`).toBe(true);
      }
      expect(inv.argv.at(-1)).toBe("fix the failing test");
      expect(inv.stdin).toEqual({ kind: "none" });
      expect(inv.transport).toBe("subprocess-jsonl");
      expect(inv.outputFormat).toBe("jsonl");
    }
  });

  it("no bypass-class flag outside the approved bypass case: the audit refuses the compiled argv in every other context", () => {
    const [off, on] = compiledCells() as [Invocation, Invocation];
    // `-w` is Cursor's declared short flag and `--trust-workspace` Muse Code's own; `unrestricted` is a declared value.
    expect(auditInvocation(off).sort()).toEqual(["--trust-workspace", "-w"]);
    expect(auditInvocation(on).sort()).toEqual(["--sandbox-network unrestricted", "--trust-workspace", "-w"]);
    const profileOn = approved({ ...BYPASS_SCOPE, network: { mode: "on" } });
    expect(auditInvocation(off, approvedCtx(approved()))).toEqual([]);
    expect(auditInvocation(on, approvedCtx(profileOn))).toEqual([]);
    const notApproved: BypassContext = { profile: PRIVILEGED_BYPASS_PROFILE, bypassApproved: false };
    const noBypass: BypassContext = {
      profile: privilegedProfile({ ...BYPASS_SCOPE, bypass: false }),
      bypassApproved: true,
    };
    const edit: BypassContext = { profile: resolveTrustProfile("edit-untrusted"), bypassApproved: true };
    for (const ctx of [notApproved, noBypass, edit]) {
      expect(auditInvocation(off, ctx)).toContain("-w");
      expect(auditInvocation(on, ctx)).toContain("--sandbox-network unrestricted");
    }
  });
});

describe("muse registry entry and bypass-class declarations (T4.72, ADR-0035, ADR-0037)", () => {
  it("adds the `muse` and `muse-code` ids through the table, with `bound` resume and a factory", () => {
    const entry = providerEntry("muse");
    expect(entry).toMatchObject({ id: "muse", configId: "muse-code", kind: "real", resumeCwd: "bound" });
    expect(adapterIdForConfigId("muse-code")).toBe("muse");
    expect(configIdForAdapterId("muse")).toBe("muse-code");
    const a = entry?.create?.({});
    expect(a).toBeInstanceOf(MuseAdapter);
    expect(a?.resumeCwd).toBe("bound");
  });

  it("declares the TDD §4.8 bypass-class flags and values, refused outside the approved bypass case", () => {
    const entry = providerEntry("muse");
    expect(entry?.bypassFlags).toEqual(["--disable-approval", "--disable-sandbox", "--trust-workspace"]);
    expect(entry?.bypassValues).toEqual([
      { flag: "--approval-mode", value: "never" },
      { flag: "--sandbox-network", value: "unrestricted" },
      { flag: "--sandbox-network", value: "enabled" },
    ]);
    const forms: string[][] = [
      ["--yolo"],
      ["--disable-approval"],
      ["--disable-sandbox"],
      ["--trust-workspace"],
      ["--trust-workspace=true"],
      ["--approval-mode", "never"],
      ["--approval-mode=NEVER"],
      ["--sandbox-network", "unrestricted"],
      ["--sandbox-network=enabled"],
    ];
    const inv = (words: string[]) => ({ argv: [EXE, "exec", ...words], policyFlags: [] });
    for (const words of forms) {
      expect(auditInvocation(inv(words)), words.join(" ")).toHaveLength(1);
      expect(auditInvocation(inv(words), approvedCtx(approved())), words.join(" ")).toEqual([]);
    }
    // The values the adapter emits are not refused.
    for (const words of [
      ["--approval-mode", "on-request"],
      ["--sandbox-network", "restricted"],
    ]) {
      expect(auditInvocation(inv(words)), words.join(" ")).toEqual([]);
    }
  });
});

describe("muse child environment (T4.72, FR-EXE-07)", () => {
  it("passes PATH and HOME only; META_API_KEY and MUSE_NO_AUTO_UPDATE are never declared", () => {
    for (const inv of compiledCells()) {
      expect(inv.envAllowlist).toEqual(["PATH", "HOME"]);
      expect(inv.env).toEqual({});
      expect(inv.envAllowlist).not.toContain(META_API_KEY_ENV);
      expect(inv.envAllowlist).not.toContain(NO_AUTO_UPDATE_ENV);
    }
    expect(MUSE_ENV_ALLOWLIST).toEqual(["PATH", "HOME"]);
  });

  it("META_API_KEY is absent from the child environment even when set in the controller's", async () => {
    vi.stubEnv(META_API_KEY_ENV, "sb-canary-not-a-key");
    vi.stubEnv(NO_AUTO_UPDATE_ENV, "1");
    expect(process.env[META_API_KEY_ENV]).toBe("sb-canary-not-a-key");
    const inv = compiled(fakeAdapter().compile(request({ bypassApproved: true }), approved()));
    // What the supervisor would build from the controller's own environment.
    const env = buildEnv({ envAllowlist: inv.envAllowlist, extraEnv: inv.env });
    expect(Object.keys(env)).not.toContain(META_API_KEY_ENV);
    expect(Object.keys(env)).not.toContain(NO_AUTO_UPDATE_ENV);
    // And what a spawned child actually sees (the fake prints variable names, never values).
    const lines: unknown[] = [];
    const run = supervise({
      argv: inv.argv,
      cwd: makeDir(),
      envAllowlist: inv.envAllowlist,
      extraEnv: inv.env,
      onEvent: (v) => lines.push(v),
      wallClockMs: 20_000,
      idleMs: 10_000,
      killGraceMs: 500,
    });
    const result = await run.result;
    expect(result.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    const seen = lines[0] as { synthetic: boolean; envNames: string[]; argv: string[] };
    expect(seen.synthetic).toBe(true);
    expect(seen.envNames).not.toContain(META_API_KEY_ENV);
    expect(seen.envNames).not.toContain(NO_AUTO_UPDATE_ENV);
    expect(seen.envNames).toContain("PATH");
    expect(seen.argv.slice(0, 5)).toEqual(["exec", "--json", "-w", "off", "--approval-mode"]);
    expect(result.stdout.toString()).not.toContain("sb-canary-not-a-key");
  });
});

describe("muse writes no global configuration (T4.72, FR-POL-04, FR-POL-08)", () => {
  it("probe, auth preflight, compile and a spawned run leave an empty temporary HOME empty", async () => {
    const home = makeDir("sb-muse-home-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    const a = fakeAdapter();
    const runner = createProbeRunner(["PATH", "HOME"]);
    const probe = await a.probe(runner);
    expect(probe.steps.every((s) => s.ok)).toBe(true);
    await a.authPreflight(runner);
    const inv = compiled(a.compile(request({ bypassApproved: true }), approved()));
    const run = supervise({ argv: inv.argv, cwd: makeDir(), envAllowlist: inv.envAllowlist, extraEnv: inv.env });
    expect((await run.result).exitCode).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  });

  it("the module source has no filesystem writes (inspection)", () => {
    for (const f of ["adapter.ts", "protocol.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
      expect(src, f).not.toMatch(/node:fs|writeFile|appendFile|mkdir|rmSync|from "fs"/);
    }
  });
});

describe("muse probe on synthetic output (T4.72, FR-ADP-02)", () => {
  const runner =
    (table: Record<string, { stdout: string; exitCode: number }>): ProbeRunner =>
    async (argv) => {
      const hit = table[argv.slice(1).join(" ")] ?? { stdout: "", exitCode: 2 };
      return { stdout: hit.stdout, stderr: "", exitCode: hit.exitCode, timedOut: false } as ProbeOutput;
    };
  const OK = {
    "--version": { stdout: SYNTHETIC_VERSION_STDOUT, exitCode: 0 },
    "exec --help": { stdout: SYNTHETIC_EXEC_HELP_STDOUT, exitCode: 0 },
  };

  it("parses the reported `--version` line and finds the required flags in `muse exec --help`", async () => {
    const r = await adapter().probe(runner(OK));
    expect(r.binaryPath).toBe(EXE);
    expect(r.binaryVersion).toBe("Muse Code 1.2.1 (1.2.1-R2847.1)");
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
  });

  it("fails the steps it cannot confirm, and never reports a version it could not parse", async () => {
    const noVersion = await adapter().probe(runner({ ...OK, "--version": { stdout: "Muse Code\n", exitCode: 0 } }));
    expect(noVersion.binaryVersion).toBeNull();
    expect(noVersion.steps.find((s) => s.step === "version")?.ok).toBe(false);
    const thinHelp = await adapter().probe(
      runner({ ...OK, "exec --help": { stdout: "Usage: muse exec\n  --json\n", exitCode: 0 } }),
    );
    expect(thinHelp.steps.find((s) => s.step === "flags")).toMatchObject({
      ok: false,
      detail: "missing --approval-mode --sandbox-network",
    });
    const broken = await adapter().probe(runner({}));
    expect(broken.binaryVersion).toBeNull();
    expect(broken.steps.map((s) => s.step)).toEqual(["binary", "version"]);
    const missing = await new MuseAdapter({ pathEnv: "/nonexistent" }).probe(runner(OK));
    expect(missing.steps).toEqual([{ step: "binary", ok: false, detail: "muse not found on PATH" }]);
  });
});

describe("muse fail-closed placeholders (T4.73 to T4.77 are later tasks)", () => {
  const state = (): ParseState => ({ lines: 0, unknownEvents: 0 }) as ParseState;

  it("auth is UNKNOWN, resume Ineligible, parser unknown and a clean exit is OUTPUT_PROTOCOL_ERROR", async () => {
    const a = adapter();
    const never: ProbeRunner = async () => {
      throw new Error("the auth placeholder must not run anything");
    };
    expect(await a.authPreflight(never)).toMatchObject({ state: "UNKNOWN", reason: expect.stringContaining("T4.74") });
    expect(a.resumeArgs({ provider: "muse", nativeSessionId: "s" }, request(), approved())).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("T4.73"),
    });
    expect(a.resumeArgs({ provider: "grok", nativeSessionId: "s" }, request(), approved())).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: "binding is for grok",
    });
    const s = state();
    const events = a.parseEvent('{"kind":"run_terminal","terminal":"completed"}', s);
    expect(events).toEqual([{ kind: "unknown", rawType: "unparsed" }]);
    expect(s).toMatchObject({ lines: 1, unknownEvents: 1 });
    const r = a.extractResult(events, {
      outcome: "exited",
      exitCode: 0,
      signal: null,
      expectedExitCodes: [0],
    } as never);
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 1 });
  });

  it("declares the fail-closed Git values: none-documented and finalize-only", () => {
    const a = adapter();
    expect(a.gitWriteControl).toBe(MUSE_GIT_WRITE_CONTROL);
    expect(a.gitWriteControl).toMatchObject({ kind: "none-documented", remainingControls: ["FR-GIT-03", "FR-GIT-06"] });
    expect(a.gitCapabilities).toBe(MUSE_GIT_CAPABILITIES);
    expect(a.gitCapabilities.commitChannel).toBe("finalize-only");
    expect(a.transports).toEqual(["subprocess-jsonl"]);
  });
});

describe("muse manifest and version gate (T4.72, ADR-0009)", () => {
  it("the manifest admits no version, so every version is ADAPTER_VERSION_UNVERIFIED", () => {
    const { loaded, error } = tryLoadManifest("muse");
    expect(error).toBeUndefined();
    expect(loaded?.manifest).toMatchObject({ provider: "muse", validated_version_range: "<0.0.0" });
    const notes = String(loaded?.manifest.notes);
    expect(notes).toMatch(/MUSE_NO_AUTO_UPDATE=1 is NOT set/);
    expect(notes).toMatch(/META_API_KEY/);
    const registry = new AdapterRegistry().register(adapter());
    for (const v of ["Muse Code 1.2.1 (1.2.1-R2847.1)", "0.0.0", null]) {
      expect(registry.gate("muse", v)).toMatchObject({ eligible: false, code: "ADAPTER_VERSION_UNVERIFIED" });
    }
  });
});

describe("muse through the registry: config validation, doctor and list_capabilities (T4.1 pattern)", () => {
  const writeConfig = (root: string) => {
    const repos = join(root, "repos");
    mkdirSync(repos, { recursive: true });
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: join(root, "data"),
        allowed_roots: [repos],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      }),
    );
    return { repos, configPath };
  };

  it("config validation accepts providers.muse-code and allowed_providers muse-code", () => {
    const cfg = validateConfig({
      schema_version: 1,
      allowed_roots: ["/x"],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      providers: { "muse-code": { enabled: false } },
      projects: [
        {
          id: "proj",
          name: "P",
          allowed_providers: ["muse-code"],
          contexts: [{ id: "main", kind: "repository", path: "/x/r", base_ref: "main" }],
        },
      ],
    });
    expect(cfg).toMatchObject({ providers: { "muse-code": { enabled: false } } });
    expect(() =>
      validateConfig({
        schema_version: 1,
        allowed_roots: ["/x"],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
        providers: { "muse-code": { git_channel: true } },
      }),
    ).toThrow(/git_channel|additional/);
  });

  it("doctor lists muse with its version gate failing ADAPTER_VERSION_UNVERIFIED", async () => {
    const root = makeDir();
    const { configPath } = writeConfig(root);
    expect(
      buildRegistry({ enabled: false })
        .list()
        .map((a) => a.id),
    ).toContain("muse");
    const out: string[] = [];
    const io: CliIo = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => true }, env: {}, user: "t" };
    await main(["doctor", "--json", "--config", configPath], {
      ...io,
      adapters: new AdapterRegistry().register(fakeAdapter()),
    });
    const j = JSON.parse(out.join(""));
    expect(j.adapters).toHaveLength(1);
    expect(j.adapters[0]).toMatchObject({
      id: "muse",
      kind: "real",
      probe: { ok: true, binary_version: "Muse Code 1.2.1 (1.2.1-R2847.1)" },
      auth: { state: "UNKNOWN" },
      version_gate: { eligible: false, code: "ADAPTER_VERSION_UNVERIFIED" },
      status: "fail",
    });
  });

  it("list_capabilities reports muse as ADAPTER_VERSION_UNVERIFIED with no supported profile", async () => {
    const root = makeDir();
    const { repos } = writeConfig(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const registry = new AdapterRegistry().register(fakeAdapter());
    // Only the node stand-in may run; anything else is refused, not run.
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
      const res = await client.callTool({ name: "list_capabilities", arguments: {} });
      const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}");
      const muse = body.providers.find((p: { provider: string }) => p.provider === "muse");
      expect(muse).toMatchObject({
        adapter_status: "ADAPTER_VERSION_UNVERIFIED",
        binary_version: "Muse Code 1.2.1 (1.2.1-R2847.1)",
        transports: ["subprocess-jsonl"],
      });
      expect(muse.supported_profiles).not.toContain("edit-untrusted");
      expect(muse.git_write_control.kind).toBe("none-documented");
    } finally {
      await client.close();
      await mcp.close();
      await lifecycle.shutdown();
      db.close();
    }
  });
});
