/**
 * T4.62 (TDD §4.7, ADR-0049): the Kimi Code module, probe, compile matrix and registry entry. SYNTHETIC: the executable
 * path is a placeholder and no `kimi` binary is run; probe output is the shape the 2026-10-15 live check recorded
 * (`2.1.1`; `--help` options and subcommands).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditAcpPlan, auditInvocation, bypassClassFlags, bypassClassShortFlags } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { acpDeclarations, providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import type { CompileRequest, Invocation, ProbeOutput, ProbeRunner, ResolvedProfile, TrustProfile } from "../types.js";
import { isIneligible } from "../types.js";
import { KimiAdapter } from "./adapter.js";

const EXE = "/opt/synthetic/kimi";
const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
  objective: "--yolo fix the failing test",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const adapter = () => new KimiAdapter({ executable: EXE });
const PROFILES: TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"];
const profileOf = (name: TrustProfile): ResolvedProfile => resolveTrustProfile(name);
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
} as const;
const compiled = (r: Invocation | ReturnType<KimiAdapter["compile"]>): Invocation => {
  if (isIneligible(r)) throw new Error(`expected an invocation, got ${r.reason}: ${r.detail}`);
  return r;
};

describe("kimi compile matrix (T4.62)", () => {
  it.each(PROFILES)("%s is Ineligible PROFILE_UNSUPPORTED, with and without a bypass approval", (name) => {
    for (const bypassApproved of [false, true]) {
      const r = adapter().compile(request({ bypassApproved }), { ...profileOf(name), bypassApproved });
      expect(r, name).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    }
  });

  it("privileged: the bypass cell compiles --prompt only for the widest approved scope; restricted cells use ACP", () => {
    let bypassCells = 0;
    let acpCells = 0;
    for (const scope of scopeShapes()) {
      const profile = privilegedProfile(scope);
      for (const approved of [false, true]) {
        const label = JSON.stringify({ scope, approved });
        const r = adapter().compile(request({ bypassApproved: approved }), { ...profile, bypassApproved: approved });
        const readOnly = scope.files.access === "read-only";
        const common = scope.network.mode === "on" && scope.repository_config.mode === "enabled";
        if (scope.bypass) {
          const expectOk = approved && common && !readOnly && scope.shell.mode === "broad";
          if (!expectOk) {
            expect(r, label).toMatchObject({ ineligible: true });
            if (!approved) expect(r, label).toMatchObject({ reason: "PROFILE_UNSUPPORTED" });
            continue;
          }
          bypassCells += 1;
          const inv = compiled(r);
          expect(inv.transport, label).toBe("subprocess-jsonl");
          expect(inv.acp, label).toBeUndefined();
          expect(inv.policyFlags, label).toEqual(["--prompt"]);
          // Nothing is added to restrict a bypass run (ADR-0049 item 1): no mode, agent, tool list or rule flag.
          expect(inv.argv.slice(1), label).toEqual([
            "--prompt=--yolo fix the failing test",
            "--output-format",
            "stream-json",
          ]);
          // The audit sees no declared bypass flag here (`--prompt` is not declared; see the registry entry).
          expect(auditInvocation(inv), label).toEqual([]);
          continue;
        }
        if (!common) {
          expect(r, label).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING" });
          continue;
        }
        acpCells += 1;
        const inv = compiled(r);
        expect(inv.transport, label).toBe("acp-stdio");
        expect(inv.outputFormat, label).toBe("acp");
        expect(inv.argv, label).toEqual([EXE, "acp"]);
        expect(inv.policyFlags, label).toEqual([]);
        expect(inv.stdin, label).toEqual({ kind: "none" });
        expect(inv.acp, label).toEqual({
          protocolVersion: 1,
          prompt: "--yolo fix the failing test",
          session: { kind: "new" },
          mcpServers: [],
          ...(readOnly ? { modeId: "plan" } : {}),
          loginCommand: "kimi login",
        });
        expect(auditInvocation(inv), label).toEqual([]);
        expect(auditAcpPlan(inv, "kimi"), label).toEqual([]);
      }
    }
    expect(bypassCells).toBe(1); // worktree + broad + on + enabled, approved
    expect(acpCells).toBe(12); // 2 file modes x 3 shell modes x approval on/off, with network on and repo enabled
  });

  it("an unapproved bypass, a missing scope, a Git-writing allowlist and a missing binary are Ineligible", () => {
    const profile = privilegedProfile(BYPASS_SCOPE);
    expect(adapter().compile(request(), profile)).toMatchObject({
      reason: "PROFILE_UNSUPPORTED",
      detail: expect.stringContaining("bypassApproved is false"),
    });
    const { privilegedScope: _drop, ...noScope } = profile;
    expect(adapter().compile(request({ bypassApproved: true }), { ...noScope, bypassApproved: true })).toMatchObject({
      reason: "PROFILE_UNSUPPORTED",
      detail: expect.stringContaining("scope binding"),
    });
    const gitAllow = { ...profileOf("edit-untrusted"), shellAllowlist: ["git commit -m x"] };
    expect(adapter().compile(request(), gitAllow)).toMatchObject({
      reason: "PROFILE_UNSUPPORTED",
      detail: expect.stringContaining("FR-GIT-01"),
    });
    const none = new KimiAdapter({ pathEnv: "/nonexistent" });
    expect(none.compile(request({ bypassApproved: true }), { ...profile, bypassApproved: true })).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("not found on PATH"),
    });
  });

  it("a requested model is one --model= word (bypass) or the ACP model option; an unsafe one is refused", () => {
    const approved = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const bypass = compiled(adapter().compile(request({ model: "kimi-code/k3", bypassApproved: true }), approved));
    expect(bypass.argv.slice(1, 3)).toEqual(["--model=kimi-code/k3", "--prompt=--yolo fix the failing test"]);
    const restricted = privilegedProfile({ ...BYPASS_SCOPE, bypass: false });
    const acp = compiled(adapter().compile(request({ model: "kimi-code/k3" }), restricted));
    expect(acp.acp?.configOptions).toEqual([{ configId: "model", value: "kimi-code/k3" }]);
    for (const model of ["--yolo", "-y", "a b", ""]) {
      expect(adapter().compile(request({ model, bypassApproved: true }), approved), model).toMatchObject({
        reason: "CAPABILITY_MISSING",
      });
    }
  });

  it("never emits an excluded flag, keeps KIMI_CODE_HOME out and never sets a bypass-class ACP mode", () => {
    const never = ["-p", "--yolo", "-y", "--auto", "--plan", "--continue", "-c", "--agent", "--agent-file"];
    const more = ["--skills-dir", "--add-dir", "--login", "--session", "-S"];
    const approved = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const restricted = privilegedProfile({ ...BYPASS_SCOPE, files: { access: "read-only" }, bypass: false });
    for (const inv of [
      compiled(adapter().compile(request({ bypassApproved: true }), approved)),
      compiled(adapter().compile(request(), restricted)),
    ]) {
      expect(inv.argv[0]).toBe(EXE);
      for (const a of inv.argv.slice(1)) expect([...never, ...more].includes(a), a).toBe(false);
      expect(inv.envAllowlist).toEqual(["PATH", "HOME"]);
      expect(inv.env).toEqual({});
      expect(["auto", "yolo"]).not.toContain(inv.acp?.modeId);
    }
  });

  it("the audits refuse what the registry declares outside the approved bypass case", () => {
    expect(bypassClassFlags()).toEqual(expect.arrayContaining(["--yolo", "--auto", "--plan"]));
    expect(bypassClassShortFlags()).toContain("-y");
    // Not declared: the shared audit would otherwise refuse Claude Code's `-p` and Antigravity's `--prompt`.
    expect(bypassClassFlags()).not.toContain("-p");
    expect(bypassClassFlags()).not.toContain("--prompt");
    const argv = (...words: string[]) => ({ argv: [EXE, ...words], policyFlags: [] });
    expect(auditInvocation(argv("--auto"))).toEqual(["--auto"]);
    expect(auditInvocation(argv("--plan"))).toEqual(["--plan"]);
    expect(auditInvocation(argv("-y"))).toEqual(["-y"]);
    expect(auditInvocation(argv("-yp"))).toEqual(["-y"]);
    const restricted = compiled(adapter().compile(request(), privilegedProfile({ ...BYPASS_SCOPE, bypass: false })));
    const plan = restricted.acp as NonNullable<Invocation["acp"]>;
    for (const mode of ["auto", "yolo", "YOLO"]) {
      expect(auditAcpPlan({ ...restricted, acp: { ...plan, modeId: mode } }, "kimi"), mode).toHaveLength(1);
      expect(
        auditAcpPlan({ ...restricted, acp: { ...plan, configOptions: [{ configId: "mode", value: mode }] } }, "kimi"),
        mode,
      ).toHaveLength(1);
    }
    expect(acpDeclarations("kimi")?.bypassModeIds).toEqual(["auto", "yolo"]);
  });
});

describe("kimi probe and auth placeholder (fail closed until T4.64; parser and resume: parser-residual.test.ts)", () => {
  const runner =
    (table: Record<string, { stdout: string; exitCode: number }>): ProbeRunner =>
    async (argv) => {
      const key = argv.slice(1).join(" ");
      const hit = table[key] ?? { stdout: "", exitCode: 2 };
      return { stdout: hit.stdout, stderr: "", exitCode: hit.exitCode, timedOut: false } as ProbeOutput;
    };
  const HELP =
    "Usage: kimi [options] [command]\n\nOptions:\n  -V, --version\n  -S, --session [id]\n  -c, --continue\n" +
    "  -y, --yolo\n  --auto\n  -m, --model <alias>\n  -p, --prompt <prompt>\n" +
    "  --output-format <format>  text|stream-json, for prompt mode\n  --plan\n  -h, --help\n\nCommands:\n" +
    "  session\n  acp [options]\n  login [options]\n  doctor\n";

  it("passes the five steps on the live-check shapes and reports the version line", async () => {
    const r = await adapter().probe(
      runner({ "--version": { stdout: "2.1.1\n", exitCode: 0 }, "--help": { stdout: HELP, exitCode: 0 } }),
    );
    expect(r.binaryVersion).toBe("2.1.1");
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
  });

  it("names a missing flag, a missing acp subcommand, an unparseable version and a missing binary", async () => {
    const noSession = await adapter().probe(
      runner({
        "--version": { stdout: "2.1.1\n", exitCode: 0 },
        "--help": { stdout: HELP.replace("--session", "--sessi0n"), exitCode: 0 },
      }),
    );
    expect(noSession.steps.find((s) => s.step === "flags")).toMatchObject({ ok: false, detail: "missing --session" });
    const noAcp = await adapter().probe(
      runner({
        "--version": { stdout: "2.1.1\n", exitCode: 0 },
        "--help": { stdout: HELP.replace("  acp [options]\n", ""), exitCode: 0 },
      }),
    );
    expect(noAcp.steps.find((s) => s.step === "command")).toMatchObject({
      ok: false,
      detail: "`acp` subcommand not listed",
    });
    const noVersion = await adapter().probe(runner({ "--version": { stdout: "kimi\n", exitCode: 0 } }));
    expect(noVersion.binaryVersion).toBeNull();
    expect(noVersion.steps.find((s) => s.step === "version")?.ok).toBe(false);
    const missing = await new KimiAdapter({ pathEnv: "/nonexistent" }).probe(runner({}));
    expect(missing.steps).toEqual([{ step: "binary", ok: false, detail: "kimi not found on PATH" }]);
  });

  it("auth is UNKNOWN; resume refuses a foreign binding and fails closed where compile does (T4.63)", async () => {
    const a = adapter();
    expect(await a.authPreflight(runner({}))).toMatchObject({ state: "UNKNOWN" });
    expect(
      a.resumeArgs({ provider: "codex", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
    expect(
      a.resumeArgs({ provider: "kimi", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    const r = a.extractResult([], { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] });
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("reads no credential or configuration file and names no credential variable it would pass", () => {
    for (const f of ["adapter.ts", "protocol.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
      expect(src, f).not.toMatch(/from "node:fs"|readFile|credentials\//);
    }
  });
});

describe("kimi registry entry and manifest gate (T4.62)", () => {
  it("is in the provider table with an adapter and declares resumeCwd like the adapter", () => {
    const entry = providerEntry("kimi");
    expect(entry?.create).toBeDefined();
    expect(entry?.configId).toBe("kimi-code");
    expect(entry?.resumeCwd).toBe(adapter().resumeCwd);
    expect(entry?.create?.({}).id).toBe("kimi");
  });

  it("fails the version gate for any version until `adapters validate` passes one (ADR-0009, T4.68)", () => {
    const registry = new AdapterRegistry();
    for (const v of ["2.1.1", "2.2.0", "0.0.0", null]) {
      expect(registry.gate("kimi", v).eligible, String(v)).toBe(false);
    }
  });
});
