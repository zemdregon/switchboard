/**
 * T4.72 and T4.73 (TDD §4.8): the Muse Code module, manifest, probe, registry entry, compile matrix, parser, result
 * and resume. SYNTHETIC: no `muse`
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
  ExitInfo,
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
  DEFAULT_SESSION_ID,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  readFixture,
  SYNTHETIC_EXEC_HELP_STDOUT,
  SYNTHETIC_VERSION_STDOUT,
} from "./fixtures/cases.js";
import {
  AUTH_LOGGED_IN_PREFIX,
  AUTH_LOGGED_OUT_PREFIX,
  AUTH_STATUS_ARGS,
  META_API_KEY_ENV,
  MUSE_LOGIN_COMMAND,
  NO_AUTO_UPDATE_ENV,
} from "./protocol.js";

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

describe("muse fail-closed placeholders (T4.75 to T4.77 are later tasks)", () => {
  it("declares the fail-closed Git values: none-documented and finalize-only", () => {
    const a = adapter();
    expect(a.gitWriteControl).toBe(MUSE_GIT_WRITE_CONTROL);
    expect(a.gitWriteControl).toMatchObject({ kind: "none-documented", remainingControls: ["FR-GIT-03", "FR-GIT-06"] });
    expect(a.gitCapabilities).toBe(MUSE_GIT_CAPABILITIES);
    expect(a.gitCapabilities.commitChannel).toBe("finalize-only");
    expect(a.transports).toEqual(["subprocess-jsonl"]);
  });
});

describe("muse auth preflight (T4.74, Q-10; SYNTHETIC outputs following Grok T4.24 precedent)", () => {
  const out =
    (stdout: string, exitCode: number | null = 0, extra: Partial<ProbeOutput> = {}): ProbeRunner =>
    async () => ({ stdout, stderr: "", exitCode, timedOut: false, ...extra });
  const STATUS_EXTRA = "\nAccount: test-user@example.com\nOrg: test-org\n";

  it("runs only `auth status` with a short timeout and passes no META_API_KEY", async () => {
    vi.stubEnv(META_API_KEY_ENV, "sb-canary-secret");
    const seen: Array<{ argv: readonly string[]; timeoutMs?: number; env?: unknown }> = [];
    const r = await adapter().authPreflight(async (argv, opts) => {
      seen.push({
        argv,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        env: (opts as { env?: unknown } | undefined)?.env,
      });
      return {
        stdout: `${AUTH_LOGGED_IN_PREFIX} as test-user@example.com.${STATUS_EXTRA}`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });
    expect(r).toEqual({ state: "OK" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv).toEqual([EXE, ...AUTH_STATUS_ARGS]);
    expect(seen[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(seen[0]?.env).toBeUndefined();
  });

  it("a logged-out first line at exit 0 is AUTH_REQUIRED naming the native login", async () => {
    expect(await adapter().authPreflight(out(`${AUTH_LOGGED_OUT_PREFIX}.${STATUS_EXTRA}`))).toEqual({
      state: "AUTH_REQUIRED",
      loginCommand: MUSE_LOGIN_COMMAND,
    });
  });

  it("any other output, exit code, timeout or spawn failure is UNKNOWN and never leaks past the first line or carries an account value", async () => {
    const cases: Array<[string, ProbeRunner]> = [
      ["unrecognised first line", out(`Welcome to Muse Code.${STATUS_EXTRA}`)],
      ["logged-in text at a non-zero exit", out(`${AUTH_LOGGED_IN_PREFIX}\n`, 1)],
      ["logged-out text at a non-zero exit", out(`${AUTH_LOGGED_OUT_PREFIX}\n`, 2)],
      ["empty output", out("")],
      ["a null exit code", out(`${AUTH_LOGGED_IN_PREFIX}\n`, null)],
      ["timeout", out("", null, { timedOut: true })],
      ["spawn error", out("", null, { spawnError: "ENOENT" })],
    ];
    for (const [name, runner] of cases) {
      const r = await adapter().authPreflight(runner);
      expect(r, name).toMatchObject({ state: "UNKNOWN" });
    }
    const r = await adapter().authPreflight(
      out(`Welcome back\u0007 ${"x".repeat(200)}\nsecret: hunter2\naccount: test-user@example.com\n`),
    );
    expect(r.state).toBe("UNKNOWN");
    if (r.state === "UNKNOWN") {
      expect(r.reason.length).toBeLessThan(200);
      expect(r.reason).not.toContain("hunter2");
      expect(r.reason).not.toContain("test-user@example.com");
      expect(r.reason).not.toContain("\u0007");
    }
  });

  it("is UNKNOWN when the binary is not on PATH, without running anything", async () => {
    let ran = false;
    const r = await new MuseAdapter({ pathEnv: "/nonexistent" }).authPreflight(async () => {
      ran = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });
    expect(r).toMatchObject({ state: "UNKNOWN" });
    expect(ran).toBe(false);
  });

  it("by inspection, the adapter reads no file of the Muse home and no credential name (FR-AUTH-02)", () => {
    const code = (f: string) =>
      readFileSync(new URL(f, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const f of ["./adapter.ts", "./protocol.ts"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/auth\.json|MUSE_HOME|readFile|readdir|createReadStream/);
    }
    expect(code("./adapter.ts")).not.toMatch(/\.muse|META_API_KEY/);
  });
});

describe("muse parser and result (T4.73; SYNTHETIC fixtures in reported or Assumption shapes, no muse was run)", () => {
  const exited = (exitCode: number): ExitInfo => ({
    outcome: "exited",
    exitCode,
    signal: null,
    expectedExitCodes: [0],
  });
  const parse = (lines: readonly string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    return { a, state, events: lines.flatMap((l) => a.parseEvent(l, state)) };
  };
  const runFixture = (name: string) => {
    const { exitCode, lines } = readFixture(name);
    const { a, state, events } = parse(lines);
    return { state, events, result: a.extractResult(events, exited(exitCode)) };
  };

  it("terminal success: deltas joined, session id from run_started only, the other SDK kinds dropped", () => {
    const { state, events, result } = runFixture("success_edit");
    expect(events.map((e) => e.kind)).toEqual(["session_bound", "message", "message", "result"]);
    expect(JSON.stringify(events)).not.toContain("prompt echo");
    expect(state).toMatchObject({ lines: 9, unknownEvents: 0, nativeSessionId: DEFAULT_SESSION_ID });
    expect(result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Added hello.txt.",
      unknownEventCount: 0,
    });
  });

  it.each([
    ["task_failure", "TOOL_FAILURE", "terminal failed: synthetic task failure"],
    ["exit0_failed_terminal", "TOOL_FAILURE", "terminal failed: synthetic failure at exit 0"],
    ["exit0_cancelled_terminal", "TOOL_FAILURE", "terminal cancelled: synthetic cancel"],
    ["completed_nonzero_exit", "TOOL_FAILURE", "exit code 1"],
    ["usage_error", "TOOL_FAILURE", "exit code 2"],
    ["no_terminal", "OUTPUT_PROTOCOL_ERROR", "no result event"],
  ] as const)(
    "terminal failure: fixture %s ends FAILED with %s (exit code alone never decides)",
    (name, code, detail) => {
      const { result } = runFixture(name);
      expect(result).toMatchObject({ ok: false, failureCode: code, failureDetail: detail });
    },
  );

  it("exit code 0 with a failed terminal record ends FAILED, never success", () => {
    const { exitCode, lines } = readFixture("exit0_failed_terminal");
    expect(exitCode).toBe(0);
    const { result } = runFixture("exit0_failed_terminal");
    expect(result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID });
    expect(lines.some((l) => l.includes('"terminal":"failed"'))).toBe(true);
  });

  it("unknown kinds fail closed: counted and clipped, never a result or a session, so an unknown-only exit 0 fails", () => {
    const { state, events, result } = runFixture("unknown_kinds");
    expect(events).toEqual([
      { kind: "unknown", rawType: "synthetic_future_record" },
      { kind: "unknown", rawType: "run_terminal_v2" },
      { kind: "unknown", rawType: "none" },
    ]);
    expect(state.unknownEvents).toBe(3);
    expect(result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 3 });
    const long = parse([JSON.stringify({ kind: "x".repeat(200) })]).events[0];
    expect(long).toEqual({ kind: "unknown", rawType: `${"x".repeat(64)}…` });
    for (const bad of ["[]", "null", "3", '"run_terminal"', '{"kind":7}']) {
      expect(
        parse([bad]).events.map((e) => e.kind),
        bad,
      ).toEqual(["unknown"]);
    }
  });

  it("an unknown kind supplies no result or session; a later recognised completed terminal still counts it", () => {
    const { result } = runFixture("unknown_then_terminal");
    expect(result).toEqual({ ok: true, nativeSessionId: DEFAULT_SESSION_ID, summary: "ok", unknownEventCount: 1 });
  });

  it("a known kind without its field is unknown: a non-string terminal gives no result", () => {
    const { result } = runFixture("terminal_not_string");
    expect(result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 1 });
    expect(parse(['{"kind":"run_output_delta","delta":"x"}']).events).toEqual([
      { kind: "unknown", rawType: "run_output_delta" },
    ]);
  });

  it.each(["record_after_terminal", "two_terminals", "session_changed", "unsafe_session_id"])(
    "stream anomaly %s is OUTPUT_PROTOCOL_ERROR, never success",
    (name) => {
      const { result } = runFixture(name);
      expect(result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    },
  );

  it("an id that is not a uuid is never bound; a changed id keeps the first binding", () => {
    expect(runFixture("unsafe_session_id").state.nativeSessionId).toBeUndefined();
    expect(runFixture("unsafe_session_id").result.nativeSessionId).toBeUndefined();
    expect(runFixture("session_changed").result.nativeSessionId).toBe(DEFAULT_SESSION_ID);
  });

  it.each(["rate_limit", "permission_denied", "sandbox_violation"])(
    "no native shape is sourced for %s: a failed terminal naming it is TOOL_FAILURE, never a narrower code or success",
    (name) => {
      const { result } = runFixture(name);
      expect(result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    },
  );

  it("supervisor outcomes win over a completed terminal: timeout, cancel, crash and unparseable framing", () => {
    const { a, events } = parse(readFixture("success_edit").lines);
    const base = { exitCode: null, signal: null, expectedExitCodes: [0] } as const;
    expect(a.extractResult(events, { ...base, outcome: "timeout", timeoutKind: "idle" })).toMatchObject({
      ok: false,
      failureCode: "PROCESS_TIMEOUT",
    });
    expect(a.extractResult(events, { ...base, outcome: "cancelled" })).toMatchObject({ failureCode: "CANCELLED" });
    expect(a.extractResult(events, { ...base, outcome: "crashed", signal: "SIGKILL" })).toMatchObject({
      failureCode: "PROCESS_CRASH",
    });
    expect(a.extractResult(events, { ...base, outcome: "protocol_error" })).toMatchObject({
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
    expect(parse(["{not json"]).events).toEqual([]);
  });

  it("a session id is taken from structured output only, never from assistant or terminal text", () => {
    const { state } = parse([
      JSON.stringify({ kind: "run_output_delta", text: `session ${RESUMED_SESSION_ID}` }),
      JSON.stringify({ kind: "run_terminal", terminal: "completed", text: RESUMED_SESSION_ID, reason: null }),
    ]);
    expect(state.nativeSessionId).toBeUndefined();
  });
});

describe("muse resume args (T4.73, FR-SES-03)", () => {
  it("resume args compile where compile compiles: `--session-id <uuid>` before the prompt, every policy flag again", () => {
    const req = request({ bypassApproved: true });
    for (const mode of ["off", "on"] as const) {
      const profile = approved({ ...BYPASS_SCOPE, network: { mode } } as PrivilegedScope);
      const first = compiled(adapter().compile(req, profile));
      const resumed = compiled(
        adapter().resumeArgs({ provider: "muse", nativeSessionId: RESUMED_SESSION_ID }, req, profile),
      );
      const at = first.argv.length - 1;
      expect(resumed.argv).toEqual([...first.argv.slice(0, at), "--session-id", RESUMED_SESSION_ID, req.objective]);
      expect(resumed.policyFlags).toEqual(first.policyFlags);
      expect(resumed.argv).not.toContain("--allow-workspace-switch");
      expect(auditInvocation(resumed, approvedCtx(profile))).toEqual([]);
      expect(auditInvocation(resumed).sort()).toEqual(auditInvocation(first).sort());
    }
  });

  it("resume is Ineligible wherever compile is, with the same reason", () => {
    const binding = { provider: "muse", nativeSessionId: RESUMED_SESSION_ID } as const;
    for (const name of NON_PRIVILEGED) {
      const profile = resolveTrustProfile(name);
      expect(adapter().resumeArgs(binding, request(), profile)).toEqual(adapter().compile(request(), profile));
    }
    const noApproval = privilegedProfile(BYPASS_SCOPE);
    expect(adapter().resumeArgs(binding, request(), noApproval)).toEqual(adapter().compile(request(), noApproval));
  });

  it("refuses another provider's binding and an id that is not a uuid", () => {
    const req = request({ bypassApproved: true });
    expect(adapter().resumeArgs({ provider: "grok", nativeSessionId: RESUMED_SESSION_ID }, req, approved())).toEqual({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
      detail: "binding is for grok",
    });
    for (const id of ["--yolo", "", "s", `${RESUMED_SESSION_ID} x`, `${RESUMED_SESSION_ID}\n`]) {
      expect(adapter().resumeArgs({ provider: "muse", nativeSessionId: id }, req, approved()), id).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
      });
    }
  });

  it("the resume fixture binds the resumed id, which compiles back into the same resume argv", () => {
    const { exitCode, lines } = readFixture("resume");
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events = lines.flatMap((l) => a.parseEvent(l, state));
    const r = a.extractResult(events, { outcome: "exited", exitCode, signal: null, expectedExitCodes: [0] });
    expect(r).toMatchObject({ ok: true, nativeSessionId: RESUMED_SESSION_ID });
    const inv = compiled(
      a.resumeArgs({ provider: "muse", nativeSessionId: r.nativeSessionId ?? "" }, request(), approved()),
    );
    expect(inv.argv.slice(-3)).toEqual(["--session-id", RESUMED_SESSION_ID, request().objective]);
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
