/**
 * T4.72 to T4.75 and T4.77 (TDD §4.8): the Muse Code module, manifest, probe, registry entry, compile matrix, parser,
 * result, resume, auth preflight, conformance suite and Git declaration. SYNTHETIC: no `muse`
 * binary was installed or run. Executable paths are placeholders or the node stand-in `fixtures/fake-muse.mjs`, and
 * the version line is the format a third party reported ([Orca]), not a capture.
 */
import { execFileSync } from "node:child_process";
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
import { GIT_FINALIZE_COMMIT_EVENT, GitPublisher, publishRefFor } from "../../git/index.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, openLedger } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { createSwitchboardServer } from "../../mcp/server.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import type { PrivilegedScope } from "../../policy/types.js";
import { WorkspaceManager } from "../../workspace/index.js";
import { auditInvocation, type BypassContext } from "../audit.js";
import { type ConformanceCase, missingRequiredKinds, runConformanceCase, runConformanceSuite } from "../conformance.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { replayLauncher } from "../fixtures/replay.js";
import { tryLoadManifest } from "../manifest/index.js";
import { adapterIdForConfigId, configIdForAdapterId, providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner } from "../run.js";
import { guardEvent } from "../tool-guard.js";
import type {
  CompileRequest,
  ExitInfo,
  Invocation,
  NormalizedEvent,
  ParseState,
  ProbeOutput,
  ProbeRunner,
  ProviderAdapter,
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
  AUTH_MISSING_DETAIL,
  BYPASS_SCOPE,
  DEFAULT_SESSION_ID,
  museConformanceCases,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  readFixture,
  replayAdapter,
  SYNTHETIC_EXEC_HELP_STDOUT,
  SYNTHETIC_VERSION_STDOUT,
  TASK_FAILURE_DETAIL,
} from "./fixtures/cases.js";
import {
  AUTH_LOGGED_IN_PREFIX,
  AUTH_LOGGED_OUT_PREFIX,
  AUTH_STATUS_ARGS,
  GIT_WRITE_CONTROL_DETAIL,
  META_API_KEY_ENV,
  MUSE_LOGIN_COMMAND,
  NO_AUTO_UPDATE_ENV,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  RECORD,
  SESSION_ID_FLAG,
  TOOL_COMMAND_FIELDS,
  TOOL_ID_FIELDS,
  TOOL_INPUT_FIELDS,
  TOOL_NAME_FIELDS,
  TOOL_PATH_FIELDS,
  TOOL_RECORDS,
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

/**
 * T4.77 on the Grok T4.27 pattern (TDD §4.8 "Git writes": no per-command deny control is documented). SYNTHETIC: the
 * replayed run uses the shared replay helper with the Muse dialect and the T4.73 `success_edit` fixture; no `muse` was
 * run.
 */
describe("muse Git declaration (T4.77, FR-GIT-01, FR-GIT-02, FR-GIT-09)", () => {
  it("declares no Git write control (a sandbox property is not a deny control), leaving FR-GIT-03 and FR-GIT-06", () => {
    const c = adapter().gitWriteControl;
    expect(c).toBe(MUSE_GIT_WRITE_CONTROL);
    expect(c.kind).toBe("none-documented");
    expect(c.remainingControls).toEqual(["FR-GIT-03", "FR-GIT-06"]);
    expect(c.detail).toBe(GIT_WRITE_CONTROL_DETAIL);
    expect(c.detail).toMatch(/not a FR-GIT-01 control/);
    expect(c.detail).toMatch(/Unverified: T4\.71/);
    expect(adapter().transports).toEqual(["subprocess-jsonl"]);
  });

  it("declares finalize-only commit channel with no injected channel (FR-GIT-09, owner decision 36)", () => {
    const caps = adapter().gitCapabilities;
    expect(caps).toBe(MUSE_GIT_CAPABILITIES);
    expect(caps.commitChannel).toBe("finalize-only");
    expect(caps.detail).toMatch(/FR-GIT-09/);
    expect(caps.detail).toMatch(/no tool is injected/);
  });

  it("FR-GIT-01 argv test: no compiled argv, policy flag or env carries git, gh or a Git-write enabling flag", () => {
    const profile = approved();
    const initial = adapter().compile(request({ bypassApproved: true }), profile);
    const resumed = adapter().resumeArgs(
      { provider: "muse", nativeSessionId: RESUMED_SESSION_ID },
      request({ bypassApproved: true }),
      profile,
    );
    // `--disable-sandbox` and `--yolo` lift the read-only `.git` ([M-perm]); `-c` could load a commit-capable MCP server.
    const gitEnabling = ["--disable-sandbox", "--yolo", "--disable-approval", "-c", "--config"];
    const invocations: [string, Invocation][] = [
      ["initial", compiled(initial)],
      ["resumed", compiled(resumed)],
      ...compiledCells().map((c, i): [string, Invocation] => [`cell ${i}`, c]),
    ];
    for (const [name, inv] of invocations) {
      expect(inv.argv.at(-1), name).toBe("fix the failing test");
      expect(inv.stdin).toEqual({ kind: "none" });
      for (const a of inv.argv.slice(1)) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} argv has git: ${a}`).toBe(false);
        expect(gitEnabling.includes(a), `${name} argv has ${a}`).toBe(false);
      }
      for (const a of inv.policyFlags) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} policyFlags has git: ${a}`).toBe(false);
      }
      expect(inv.envAllowlist).toEqual(["PATH", "HOME"]);
      for (const k of Object.keys(inv.env)) {
        expect(/GIT|GITHUB|GH|MUSE|META/.test(k), `${name} env: ${k}`).toBe(false);
      }
    }
  });

  it.each([
    "git commit",
    "git commit -m x",
    "git push",
    "git push origin main",
    "git branch -f main",
    "git update-ref refs/heads/x HEAD",
    "git tag v1",
    "gh pr create",
    "git reset --hard",
    "git merge x",
    "git rebase main",
    "git cherry-pick abc",
    "git stash",
    "git -C . commit",
    "git --git-dir=/repo/.git commit",
    "/usr/bin/git push",
    "env git commit",
    "xargs git push",
  ])("shell allowlist entry %j is Ineligible (PROFILE_UNSUPPORTED, FR-GIT-01) before any other check", (entry) => {
    const r1 = adapter().compile(request(), { ...resolveTrustProfile("edit-untrusted"), shellAllowlist: [entry] });
    expect(r1).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (isIneligible(r1)) {
      expect(r1.detail).toBe(`shell allowlist entries could write Git (FR-GIT-01): ${entry}`);
    }
    // On the one cell that otherwise compiles (an approved bypass scope), and ahead of a bypass outside privileged.
    const r2 = adapter().compile(request({ bypassApproved: true }), { ...approved(), shellAllowlist: [entry] });
    expect(r2).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (isIneligible(r2)) expect(r2.detail).toContain("FR-GIT-01");
    const r3 = adapter().compile(request({ bypassApproved: true }), {
      ...resolveTrustProfile("edit-untrusted"),
      shellAllowlist: [entry],
    });
    expect(r3).toMatchObject({ ineligible: true, detail: expect.stringContaining("FR-GIT-01") });
  });

  it("read-only commands in a shell allowlist do not trigger the FR-GIT-01 rejection", () => {
    const r = adapter().compile(request(), {
      ...resolveTrustProfile("edit-untrusted"),
      shellAllowlist: ["git status", "git diff", "npm test"],
    });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (isIneligible(r)) {
      expect(r.detail).not.toContain("FR-GIT-01");
      expect(r.detail).toContain(NON_PRIVILEGED_UNSUPPORTED_DETAIL);
    }
  });

  it("a replayed write run in a finalize-only project gets the controller commit at FINALIZING", async () => {
    const root = makeDir();
    const repo = join(root, "repo");
    const bare = join(root, "remote.git");
    mkdirSync(repo);
    const g = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Muse Dev",
          GIT_AUTHOR_EMAIL: "muse@example.test",
          GIT_COMMITTER_NAME: "Muse Dev",
          GIT_COMMITTER_EMAIL: "muse@example.test",
        },
        encoding: "utf8",
      }).trim();

    g(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "initial\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "init");
    g(root, "init", "-q", "--bare", "-b", "main", bare);
    g(repo, "remote", "add", "origin", bare);
    g(repo, "push", "-q", "origin", "main");

    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
    const finalizePublisher = new GitPublisher({
      db,
      scratchDir: join(dataDir, "git-scratch"),
      allowedStates: ["FINALIZING"],
    });
    // The replay dialect answers `--version` and `exec --help` only; `muse auth status` gets the Assumption logged-in
    // line (T4.74). The replay writes hello.txt into the run worktree (`--write`), standing in for the agent's edit.
    const real = createProbeRunner();
    const probeRunner: ProbeRunner = async (argv, opts) =>
      argv.slice(-AUTH_STATUS_ARGS.length).join(" ") === AUTH_STATUS_ARGS.join(" ")
        ? { exitCode: 0, stdout: `${AUTH_LOGGED_IN_PREFIX} (synthetic)\n`, stderr: "", timedOut: false }
        : real(argv, opts);
    const fixture = fileURLToPath(new URL("./fixtures/success_edit.jsonl", import.meta.url));
    const replay = new MuseAdapter({
      executable: process.execPath,
      launcherArgs: replayLauncher("muse", fixture, ["--write", "hello.txt"]),
    });
    const lifecycle = new RunLifecycle({
      ledger,
      workspace,
      artifacts,
      adapters: new AdapterRegistry().register(replay),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
      probeRunner,
      finalizePublisher,
    });
    lifecycle.start();

    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "write a file with muse",
        workspace: repo,
        trustProfile: "privileged",
        provider: "muse",
        project: {
          id: "test-project",
          name: "Test Project",
          environment_kind: "host",
          context_id: "primary",
          base_ref: "main",
          effective_max_profile: "privileged",
          writable: true,
          identity: { name: "Muse Dev", email: "muse@example.test" },
          push: { policy: "branch" },
          finalize_commit: true,
        },
        privileged: {
          scope: BYPASS_SCOPE,
          approvedByClientPolicy: true,
        },
      });

      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

      const events = ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) }));
      expect(events.find((e) => e.type === "state_transition" && e.p.to === "FINALIZING")).toBeDefined();
      const finCommit = events.find((e) => e.type === GIT_FINALIZE_COMMIT_EVENT);
      expect(finCommit?.p).toMatchObject({ outcome: "committed" });

      const sha = g(repo, "rev-parse", "--verify", "--quiet", publishRefFor(metaSessionId));
      expect(sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(g(repo, "show", "--name-only", "--format=", sha)).toContain("hello.txt");
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
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

describe("muse tool records and the ADR-0039 guard (T4.76; Assumption field spellings, Unverified: T4.71, no muse was run)", () => {
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
  /** The run's events as `startAdapterRun` stores them: through the guard as an approved bypass run sees it. */
  const guarded = (lines: readonly string[], bypass = true) => {
    const { a, state, events } = parse(lines);
    return { a, state, events: events.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/x", bypass })) };
  };
  const STARTED = JSON.stringify({ kind: "run_started", session_id: DEFAULT_SESSION_ID });
  const DONE = JSON.stringify({ kind: "run_terminal", terminal: "completed", text: "done", reason: null });
  const record = (kind: string, fields: Record<string, unknown>) => JSON.stringify({ kind, ...fields });
  const GIT = "git commit -am synthetic";

  it("fixture git_write_guard: a command record with a Git write under a completed terminal at exit 0 ends PERMISSION_BLOCKED", () => {
    const { exitCode, lines } = readFixture("git_write_guard");
    expect(exitCode).toBe(0);
    const { a, state, events } = guarded(lines);
    expect(events.map((e) => e.kind)).toEqual(["session_bound", "tool_call", "message", "result"]);
    expect(events[1]).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "shell",
      violation: { kind: "git_write", reason: expect.stringContaining("commit") },
    });
    expect(JSON.stringify(events)).not.toContain(GIT); // the transient command is dropped by the guard
    expect(state.unknownEvents).toBe(0);
    expect(a.extractResult(events, exited(0))).toEqual({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: expect.stringMatching(/^git write attempted: /),
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Committed.",
      unknownEventCount: 0,
    });
  });

  it("positive control: the same fixture without the guard verdict would end ok, so the guard is the control", () => {
    const { a, events } = parse(readFixture("git_write_guard").lines);
    expect(events.find((e) => e.kind === "tool_call")).toMatchObject({ tool: "shell", command: GIT });
    expect(a.extractResult(events, exited(0))).toMatchObject({ ok: true });
  });

  it("fixture git_write_guard replayed through the supervisor and the guard ends PERMISSION_BLOCKED (never success)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("git_write_guard"),
      request: { ...request({ bypassApproved: true }), workspace: { cwd: makeDir(), writable: true } },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", summary: "Committed." });
  });

  it.each(TOOL_RECORDS.map((kind) => [kind]))("the shell-command form is read from a %s record", (kind) => {
    const { a, events } = guarded([STARTED, record(kind, { tool: "shell", input: { command: GIT } }), DONE]);
    expect(events.map((e) => e.kind)).toEqual(["session_bound", "tool_call", "result"]);
    expect(a.extractResult(events, exited(0))).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(a.extractResult(events, exited(1))).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("the sourced tool record kinds are exactly tool_result, command_accepted and command_result", () => {
    expect([...TOOL_RECORDS].sort()).toEqual([RECORD.commandAccepted, RECORD.commandResult, RECORD.toolResult].sort());
  });

  it.each([
    ...TOOL_INPUT_FIELDS.flatMap((field) =>
      TOOL_COMMAND_FIELDS.map((key) => [`${field}.${key} object`, { [field]: { [key]: GIT } }] as const),
    ),
    ...TOOL_INPUT_FIELDS.map(
      (field) => [`${field} as a JSON string`, { [field]: JSON.stringify({ command: GIT }) }] as const,
    ),
    ...TOOL_COMMAND_FIELDS.map((key) => [`top-level ${key}`, { [key]: GIT }] as const),
    ["a non-shell tool name beside the command", { tool: "ReadFile", input: { command: GIT } }],
    ["a path beside the command", { input: { path: "README.md", command: GIT } }],
    ["a parameters object beside a top-level command", { input: { verbose: true }, command: GIT }],
    ["a non-JSON string input beside a top-level command", { input: "not json", command: GIT }],
  ] as const)("a command line is read from %s and guarded as a shell call", (_label, fields) => {
    const { events } = parse([record("tool_result", fields)]);
    expect(events).toEqual([{ kind: "tool_call", tool: "shell", name: expect.any(String), command: GIT }]);
    expect(guardEvent(events[0] as NormalizedEvent, { cwd: "/work/tree", bypass: true })).toMatchObject({
      violation: { kind: "git_write" },
    });
  });

  it("a path-only record is a read, or an edit when the tool name says so; a name-only record is other; nothing readable is dropped", () => {
    const long = "p".repeat(600);
    expect(parse([record("tool_result", { tool: "read_file", input: { path: "src/a.ts" } })]).events).toEqual([
      { kind: "tool_call", tool: "read", name: "read_file", target: "src/a.ts" },
    ]);
    for (const key of TOOL_PATH_FIELDS) {
      expect(parse([record("tool_result", { name: "WriteFile", [key]: long })]).events, key).toEqual([
        { kind: "tool_call", tool: "edit", name: "WriteFile", target: `${"p".repeat(512)}…` },
      ]);
    }
    for (const key of TOOL_NAME_FIELDS) {
      expect(parse([record("command_result", { [key]: "x".repeat(100) })]).events, key).toEqual([
        { kind: "tool_call", tool: "other", name: `${"x".repeat(64)}…` },
      ]);
    }
    // Nothing readable: dropped, as T4.73 decided (the success_edit fixture's `tool_result` and `command_accepted`).
    for (const fields of [{}, { ok: true }, { tool: "", command: "", path: "" }, { input: {} }, { input: 7 }]) {
      const { state, events } = parse([record("tool_result", fields), record("command_accepted", fields)]);
      expect(events, JSON.stringify(fields)).toEqual([]);
      expect(state.unknownEvents).toBe(0);
    }
  });

  it("a call id reports each command line once: a repeat is dropped, a swapped or late command is reported, no id never dedups", () => {
    for (const key of TOOL_ID_FIELDS) {
      const { events } = parse([
        record("command_accepted", { [key]: "c1", tool: "shell", input: { command: "echo safe" } }),
        record("command_result", { [key]: "c1", tool: "shell", input: { command: "echo safe" }, exit_code: 0 }),
        record("tool_result", { [key]: "c1", tool: "shell" }), // no parameter: nothing new
        record("command_result", { [key]: "c1", tool: "shell", input: { command: GIT } }), // swapped: reported
        record("tool_result", { [key]: "c1", tool: "shell", input: { command: "echo safe" } }), // seen before
      ]);
      expect(
        events.map((e) => (e.kind === "tool_call" ? e.command : e.kind)),
        key,
      ).toEqual(["echo safe", GIT]);
    }
    const late = parse([
      record("command_accepted", { id: "c2", tool: "shell" }),
      record("command_result", { id: "c2", command: GIT }),
    ]);
    expect(late.events.map((e) => (e.kind === "tool_call" ? (e.command ?? e.tool) : e.kind))).toEqual(["other", GIT]);
    const noId = parse([record("tool_result", { command: GIT }), record("tool_result", { command: GIT })]);
    expect(noId.events).toHaveLength(2);
    // Ids are per run: a new parse state starts afresh.
    expect(parse([record("tool_result", { id: "c1", command: GIT })]).events).toHaveLength(1);
  });

  it("the guard verdict wins at every exit code, after a failed terminal, after the terminal record and with a changed session id", () => {
    const hostile = record("command_accepted", { tool: "shell", input: { command: GIT } });
    const FAILED = JSON.stringify({ kind: "run_terminal", terminal: "failed", text: "", reason: "synthetic" });
    const OTHER = JSON.stringify({ kind: "run_started", session_id: RESUMED_SESSION_ID });
    for (const lines of [
      [STARTED, hostile, DONE],
      [STARTED, hostile, FAILED],
      [STARTED, DONE, hostile],
      [STARTED, hostile, OTHER, DONE],
      [hostile],
    ]) {
      const { a, events } = guarded(lines);
      for (const exitCode of [0, 1, 2, 137]) {
        expect(a.extractResult(events, exited(exitCode)), `${lines.join(" ")} exit ${exitCode}`).toMatchObject({
          ok: false,
          failureCode: "PERMISSION_BLOCKED",
        });
      }
    }
  });

  it("in an approved bypass run a hostile command with no Git write is not blocked (owner decision 25); outside bypass the provider-state check applies", () => {
    const lines = [
      STARTED,
      record("tool_result", { tool: "shell", input: { command: "cat /home/x/.codex/auth.json" } }),
      DONE,
    ];
    const bypass = guarded(lines, true);
    expect(bypass.a.extractResult(bypass.events, exited(0))).toMatchObject({ ok: true });
    const plain = guarded(lines, false);
    expect(plain.a.extractResult(plain.events, exited(0))).toMatchObject({
      ok: false,
      failureCode: "SANDBOX_VIOLATION",
    });
  });

  it("an unsourced tool_call kind stays unknown: counted, no result, and a Git write in it is not a tool call (fail closed, never success at exit 0)", () => {
    const { a, state, events } = guarded([record("tool_call", { tool: "shell", input: { command: GIT } })]);
    expect(events).toEqual([{ kind: "unknown", rawType: "tool_call" }]);
    expect(state.unknownEvents).toBe(1);
    expect(a.extractResult(events, exited(0))).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("the success_edit fixture still parses the same: its field-less tool and command records are dropped", () => {
    const { lines } = readFixture("success_edit");
    expect(lines.filter((l) => TOOL_RECORDS.some((k) => l.includes(`"kind":"${k}"`)))).toHaveLength(2);
    const { state, events } = guarded(lines);
    expect(events.map((e) => e.kind)).toEqual(["session_bound", "message", "message", "result"]);
    expect(state.unknownEvents).toBe(0);
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

/**
 * T4.75 (FR-ADP-11): the shared conformance suite over SYNTHETIC recorded fixtures (`./fixtures/*.jsonl`, in the
 * reported or Assumption shapes of protocol.ts), replayed by `replay.mjs --provider muse` in place of the binary, so it
 * passes with no `muse` installed. The prompt reaches the replay as the last argv word; stdin is unused.
 */
describe("muse conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.75)", () => {
  const caseOf = (kind: ConformanceCase["kind"]): ConformanceCase => {
    const c = museConformanceCases(makeDir).find((x) => x.kind === kind);
    if (!c) throw new Error(`missing ${kind} case`);
    return c;
  };
  /** `a` with its compiled argv rewritten by `edit`, to show the replay refuses a wrong compile. */
  const brokenBy = (a: ProviderAdapter, edit: (argv: string[]) => string[]): ProviderAdapter =>
    new Proxy(a, {
      get(target, key) {
        if (key === "compile") {
          return (r: CompileRequest, p: ResolvedProfile) => {
            const inv = target.compile(r, p);
            return isIneligible(inv) ? inv : { ...inv, argv: edit(inv.argv), policyFlags: [] };
          };
        }
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  /** Inserts `words` before the prompt (the last argv word). */
  const beforePrompt =
    (...words: string[]) =>
    (argv: string[]) => [...argv.slice(0, -1), ...words, ...argv.slice(-1)];
  const withoutPair = (flag: string) => (argv: string[]) => argv.filter((w, i) => w !== flag && argv[i - 1] !== flag);
  const replace = (flag: string, value: string) => (argv: string[]) =>
    argv.map((w, i) => (argv[i - 1] === flag ? value : w));

  it("covers every FR-ADP-11 kind and passes the full suite", async () => {
    const cases = museConformanceCases(makeDir);
    expect(missingRequiredKinds(cases)).toEqual([]);
    expect(cases.map((c) => c.kind)).toEqual(expect.arrayContaining(["timeout", "partial_mutation"]));
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("success with edit: session from run_started, deltas joined as the summary, no unknown records", async () => {
    const c = caseOf("success");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Added hello.txt.",
      unknownEventCount: 0,
    });
    expect(readFileSync(join(c.request.workspace.cwd, "hello.txt"), "utf8")).toContain("synthetic");
  });

  it("resumed run passes `--session-id <uuid>` before the prompt and preserves the native session id", async () => {
    const c = caseOf("resume");
    const inv = compiled(
      c.adapter.resumeArgs(c.binding ?? { provider: "muse", nativeSessionId: "" }, c.request, c.profile),
    );
    expect(inv.argv.slice(-3)).toEqual([SESSION_ID_FLAG, RESUMED_SESSION_ID, c.request.objective]);
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: RESUMED_SESSION_ID });
    // The resume fixture requires the resume flag: replayed from a fresh compile, the replay refuses it.
    const { binding, ...unbound } = c;
    expect(binding).toBeDefined();
    const fresh = await runConformanceCase(unbound);
    expect(fresh.ok).toBe(false);
    expect(fresh.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 64" });
  });

  it("a failed terminal at exit 1 is TOOL_FAILURE with the terminal reason and keeps the session id", async () => {
    const report = await runConformanceCase(caseOf("task_failure"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: TASK_FAILURE_DETAIL,
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("a missing login is AUTH_REQUIRED naming `muse login` at the preflight; a logged-out run fails closed, never success", async () => {
    const c = caseOf("auth_missing");
    // T4.74 Assumption reply; the probe runner stands in for the replay, which answers only --version and exec --help.
    const seen: string[][] = [];
    const auth = await c.adapter.authPreflight(async (argv) => {
      seen.push([...argv]);
      return { exitCode: 0, stdout: `${AUTH_LOGGED_OUT_PREFIX}. (synthetic)\n`, stderr: "", timedOut: false };
    });
    expect(auth).toEqual({ state: "AUTH_REQUIRED", loginCommand: MUSE_LOGIN_COMMAND });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(-AUTH_STATUS_ARGS.length)).toEqual([...AUTH_STATUS_ARGS]);
    // In-run: no logged-out record is sourced (TDD §4.8.1 item 3), so exit 1 with no records is TOOL_FAILURE, no session.
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: AUTH_MISSING_DETAIL });
    expect(report.result?.nativeSessionId).toBeUndefined();
    // The expectation tells this run apart from a compile the replay refused (exit 64, also no output).
    const refused = await runConformanceCase({ ...c, adapter: brokenBy(c.adapter, withoutPair("-w")) });
    expect(refused.ok).toBe(false);
    expect(refused.result?.failureDetail).toBe("exit code 64");
  });

  it("a line that is not JSON between valid records is OUTPUT_PROTOCOL_ERROR, even with a completed terminal", async () => {
    const report = await runConformanceCase(caseOf("malformed_output"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("partial mutation leaves the file in the cwd", async () => {
    const c = caseOf("partial_mutation");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(c.request.workspace.cwd, "partial.txt"), "utf8")).toContain("synthetic");
  });

  it.each([
    ["-w off removed", withoutPair("-w")],
    ["--json removed", (argv: string[]) => argv.filter((w) => w !== "--json")],
    ["--approval-mode never", replace("--approval-mode", "never")],
    ["--sandbox-network enabled", replace("--sandbox-network", "enabled")],
    ["--sandbox-network removed", withoutPair("--sandbox-network")],
    ["--yolo added", beforePrompt("--yolo")],
    ["--disable-approval added", beforePrompt("--disable-approval")],
    ["--disable-sandbox added", beforePrompt("--disable-sandbox")],
    ["--prompt-file added", beforePrompt("--prompt-file", "/tmp/p")],
    ["--allow-workspace-switch added", beforePrompt("--allow-workspace-switch")],
    ["-c added", beforePrompt("-c", "approval_mode=never")],
    ["--yolo appended after the prompt", (argv: string[]) => [...argv, "--yolo"]],
    ["the prompt removed", (argv: string[]) => argv.slice(0, -1)],
  ])(
    "the replay refuses an argv Muse Code would not be given (%s), so a wrong compile cannot pass",
    async (_n, edit) => {
      const c = caseOf("success");
      const report = await runConformanceCase({ ...c, adapter: brokenBy(c.adapter, edit) });
      expect(report.ok).toBe(false);
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
      expect(report.result?.failureDetail).toMatch(/^exit code 6[45]$/);
    },
  );
});
