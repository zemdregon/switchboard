/**
 * T4.52 (TDD §4.6): the OpenCode module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `opencode` binary is run; probe output is the shape the 2026-10-14 live check recorded (`opencode v2.0.23`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditInvocation, bypassClassFlags } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import type { CompileRequest, Invocation, ProbeOutput, ProbeRunner, ResolvedProfile, TrustProfile } from "../types.js";
import { OpenCodeAdapter } from "./adapter.js";

const EXE = "/opt/synthetic/opencode";
const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
  objective: "fix the failing test",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const adapter = () => new OpenCodeAdapter({ executable: EXE });
const PROFILES: TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"];
const profileOf = (name: TrustProfile): ResolvedProfile => resolveTrustProfile(name);
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
} as const;
const compiled = (over: Partial<CompileRequest> = {}): Invocation => {
  const profile = privilegedProfile(BYPASS_SCOPE);
  const r = adapter().compile(request({ bypassApproved: true, ...over }), { ...profile, bypassApproved: true });
  if ("ineligible" in r) throw new Error(r.detail);
  return r;
};

describe("opencode compile matrix (T4.52)", () => {
  it.each(PROFILES)("%s is Ineligible PROFILE_UNSUPPORTED, with and without a bypass approval", (name) => {
    for (const bypassApproved of [false, true]) {
      const r = adapter().compile(request({ bypassApproved }), { ...profileOf(name), bypassApproved });
      expect(r, name).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    }
  });

  it("privileged compiles only an approved bypass scope with worktree files, shell broad, network on, repo enabled", () => {
    let count = 0;
    for (const scope of scopeShapes()) {
      const profile = privilegedProfile(scope);
      for (const approved of [false, true]) {
        const label = JSON.stringify({ scope, approved });
        const r = adapter().compile(request({ bypassApproved: approved }), { ...profile, bypassApproved: approved });
        const expectOk =
          approved &&
          scope.bypass &&
          scope.files.access === "worktree" &&
          scope.shell.mode === "broad" &&
          scope.network.mode === "on" &&
          scope.repository_config.mode === "enabled";
        if (!expectOk) {
          expect(r, label).toMatchObject({ ineligible: true });
          continue;
        }
        count += 1;
        expect("ineligible" in r, label).toBe(false);
        if ("ineligible" in r) continue;
        expect(r.policyFlags, label).toEqual(["--standalone"]);
        // No bypass-class flag is emitted, so the audit finds nothing in any context (Q-83).
        expect(auditInvocation(r), label).toEqual([]);
      }
    }
    expect(count).toBe(1);
  });

  it("a read-only workspace keeps the bypass cell Ineligible", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const r = adapter().compile(request({ bypassApproved: true, workspace: { cwd: "/w", writable: false } }), profile);
    expect(r).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING" });
  });

  it("puts the prompt last after `--` and never emits a flag the TDD §4.6 rules exclude", () => {
    const r = compiled();
    expect(r.argv).toEqual([EXE, "run", "--format", "json", "--standalone", "--", "fix the failing test"]);
    const never = [
      "--auto",
      "--continue",
      "-c",
      "--fork",
      "--server",
      "--share",
      "--attach",
      "--model",
      "-m",
      "--agent",
    ];
    for (const a of r.argv.slice(1)) expect(never.includes(a), a).toBe(false);
    expect(r.env).toEqual({ OPENCODE_DISABLE_AUTOUPDATE: "1" });
    expect(r.envAllowlist).toEqual(["PATH", "HOME"]);
    for (const name of ["OPENCODE_PERMISSION", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG"]) {
      expect(Object.keys(r.env)).not.toContain(name);
      expect(r.envAllowlist).not.toContain(name);
    }
    expect(r.stdin).toEqual({ kind: "none" });
    expect(r.transport).toBe("subprocess-jsonl");
    expect(r.outputFormat).toBe("jsonl");
    expect(r.cwd).toBe("/work/tree");
  });

  it("a prompt that looks like a flag stays one word after `--`; a bypass-flag prompt is refused by the audit", () => {
    const r = compiled({ objective: "-c continue the last session" });
    expect(r.argv.slice(-2)).toEqual(["--", "-c continue the last session"]);
    expect(auditInvocation(r)).toEqual([]);
    expect(auditInvocation(compiled({ objective: "--auto" }))).toEqual(["--auto"]);
  });

  it("a requested model, an unapproved bypass and a missing binary are Ineligible with a reason", () => {
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    expect(adapter().compile(request({ model: "x/y", bypassApproved: true }), approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
    });
    expect(adapter().compile(request(), profile)).toMatchObject({ reason: "PROFILE_UNSUPPORTED" });
    const none = new OpenCodeAdapter({ pathEnv: "/nonexistent" });
    expect(none.compile(request({ bypassApproved: true }), approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("opencode not found on PATH"),
    });
  });
});

describe("opencode bypass-class declaration (ADR-0035)", () => {
  it("--auto is refused outside the approved bypass case and admitted inside it", () => {
    expect(bypassClassFlags()).toContain("--auto");
    const base = compiled();
    const scoped = privilegedProfile(BYPASS_SCOPE);
    for (const words of [["--auto"], ["--auto=true"]]) {
      const inv = { ...base, argv: [...base.argv.slice(0, -2), ...words, ...base.argv.slice(-2)] };
      const label = words.join(" ");
      expect(auditInvocation(inv), label).toEqual(["--auto"]);
      expect(auditInvocation(inv, { profile: profileOf("trusted-development"), bypassApproved: true }), label).toEqual([
        "--auto",
      ]);
      expect(
        auditInvocation(inv, { profile: privilegedProfile({ ...BYPASS_SCOPE, bypass: false }), bypassApproved: true }),
        label,
      ).toEqual(["--auto"]);
      expect(auditInvocation(inv, { profile: scoped, bypassApproved: true }), label).toEqual([]);
    }
    // Cursor's `--auto-review` is its own declaration; `--auto` does not match it by prefix.
    expect(auditInvocation({ ...base, argv: [...base.argv, "--auto-review"] })).toEqual(["--auto-review"]);
  });
});

describe("opencode probe, auth, parser and resume placeholders (fail closed until T4.53, T4.54)", () => {
  const runner =
    (table: Record<string, { stdout: string; exitCode: number }>): ProbeRunner =>
    async (argv) => {
      const key = argv.slice(1).join(" ");
      const hit = table[key] ?? { stdout: "", exitCode: 2 };
      return { stdout: hit.stdout, stderr: "", exitCode: hit.exitCode, timedOut: false } as ProbeOutput;
    };
  const HELP =
    "opencode run [message..]\n  --standalone\n  --server\n  -c, --continue\n  -s, --session\n  --fork\n" +
    "  -m, --model\n  --format\n  --auto\n";

  it("passes the five steps on the live-check shapes and reports the version line", async () => {
    const r = await adapter().probe(
      runner({ "--version": { stdout: "2.0.23\n", exitCode: 0 }, "run --help": { stdout: HELP, exitCode: 0 } }),
    );
    expect(r.binaryVersion).toBe("2.0.23");
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
  });

  it("names a missing flag, an unparseable version and a missing binary", async () => {
    const noStandalone = await adapter().probe(
      runner({
        "--version": { stdout: "2.0.23\n", exitCode: 0 },
        "run --help": { stdout: HELP.replace("--standalone", "--alone"), exitCode: 0 },
      }),
    );
    expect(noStandalone.steps.find((s) => s.step === "flags")).toMatchObject({
      ok: false,
      detail: "missing --standalone",
    });
    const noVersion = await adapter().probe(runner({ "--version": { stdout: "opencode\n", exitCode: 0 } }));
    expect(noVersion.binaryVersion).toBeNull();
    expect(noVersion.steps.find((s) => s.step === "version")?.ok).toBe(false);
    const missing = await new OpenCodeAdapter({ pathEnv: "/nonexistent" }).probe(runner({}));
    expect(missing.steps).toEqual([{ step: "binary", ok: false, detail: "opencode not found on PATH" }]);
  });

  it("auth is UNKNOWN, resume is Ineligible, no event is recognised and a clean exit never succeeds", async () => {
    const a = adapter();
    expect(await a.authPreflight(runner({}))).toMatchObject({ state: "UNKNOWN" });
    expect(
      a.resumeArgs({ provider: "codex", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: "ses_x" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ ineligible: true });
    const state = { lines: 0, unknownEvents: 0 } as Parameters<OpenCodeAdapter["parseEvent"]>[1];
    expect(a.parseEvent('{"type":"text","sessionID":"ses_x","part":{"text":"ok"}}', state)).toEqual([
      { kind: "unknown", rawType: "unparsed" },
    ]);
    const r = a.extractResult([], { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] });
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("reads no OpenCode credential or configuration file (source inspection)", () => {
    for (const f of ["adapter.ts", "protocol.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/from "node:fs"|readFile|"auth", "export"|share\/opencode/);
    }
  });
});

describe("opencode registry entry and manifest gate (T4.52)", () => {
  it("is in the provider table with an adapter and declares resumeCwd like the adapter", () => {
    const entry = providerEntry("opencode");
    expect(entry?.create).toBeDefined();
    expect(entry?.resumeCwd).toBe(adapter().resumeCwd);
    expect(entry?.create?.({}).id).toBe("opencode");
  });

  it("fails the version gate for any version until `adapters validate` passes one (ADR-0009)", () => {
    const registry = new AdapterRegistry();
    for (const v of ["2.0.23", "1.0.0", "0.0.0", null]) {
      expect(registry.gate("opencode", v).eligible, String(v)).toBe(false);
    }
  });
});
