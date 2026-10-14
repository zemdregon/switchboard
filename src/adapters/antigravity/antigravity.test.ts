/**
 * T4.32 (TDD §4.4): the Antigravity module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `agy` binary is run; probe output is the shape the 2026-10-14 live check recorded (`1.3.4`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditInvocation, bypassClassFlags } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import type { CompileRequest, Invocation, ProbeOutput, ProbeRunner, ResolvedProfile, TrustProfile } from "../types.js";
import { AntigravityAdapter } from "./adapter.js";

const EXE = "/opt/synthetic/agy";
const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
  objective: "--sandbox fix the failing test",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const adapter = () => new AntigravityAdapter({ executable: EXE });
const PROFILES: TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"];
const profileOf = (name: TrustProfile): ResolvedProfile => resolveTrustProfile(name);
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
} as const;
const compiled = (): Invocation => {
  const profile = privilegedProfile(BYPASS_SCOPE);
  const r = adapter().compile(request({ bypassApproved: true }), { ...profile, bypassApproved: true });
  if ("ineligible" in r) throw new Error(r.detail);
  return r;
};

describe("antigravity compile matrix (T4.32)", () => {
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
          // A privileged scope without bypass is refused for the settings-only toolPermission (TDD §4.4.2).
          if (!scope.bypass) expect(r, label).toMatchObject({ reason: "PROFILE_UNSUPPORTED" });
          continue;
        }
        count += 1;
        expect("ineligible" in r, label).toBe(false);
        if ("ineligible" in r) continue;
        expect(r.policyFlags, label).toEqual(["--dangerously-skip-permissions"]);
        expect(auditInvocation(r), label).toEqual(["--dangerously-skip-permissions"]);
        expect(auditInvocation(r, { profile, bypassApproved: false }), label).toEqual([
          "--dangerously-skip-permissions",
        ]);
        expect(auditInvocation(r, { profile, bypassApproved: true }), label).toEqual([]);
      }
    }
    expect(count).toBe(1);
  });

  it("a read-only workspace keeps the bypass cell Ineligible", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const r = adapter().compile(request({ bypassApproved: true, workspace: { cwd: "/w", writable: false } }), profile);
    expect(r).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING" });
  });

  it("keeps the prompt in one `--prompt=` word and never emits a flag the TDD §4.4 rules exclude", () => {
    const r = compiled();
    expect(r.argv).toEqual([
      EXE,
      "--prompt=--sandbox fix the failing test",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ]);
    const never = [
      "-p",
      "--sandbox",
      "--mode",
      "--model",
      "--effort",
      "--agent",
      "-c",
      "--continue",
      "--print-timeout",
      "--remote-control",
      "--gemini_dir",
      "--add-dir",
      "--project",
      "--new-project",
      "--input-format",
    ];
    for (const a of r.argv.slice(1)) expect(never.includes(a), a).toBe(false);
    expect(r.env).toEqual({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
    expect(r.envAllowlist).toEqual(["PATH", "HOME"]);
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"]) {
      expect(r.envAllowlist).not.toContain(name);
    }
    expect(r.stdin).toEqual({ kind: "none" });
    expect(r.transport).toBe("subprocess-jsonl");
    expect(r.outputFormat).toBe("jsonl");
  });

  it("a requested model, an unapproved bypass and a missing binary are Ineligible with a reason", () => {
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    expect(adapter().compile(request({ model: "x", bypassApproved: true }), approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
    });
    expect(adapter().compile(request(), profile)).toMatchObject({ reason: "PROFILE_UNSUPPORTED" });
    const none = new AntigravityAdapter({ pathEnv: "/nonexistent" });
    expect(none.compile(request({ bypassApproved: true }), approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("agy not found on PATH"),
    });
  });
});

describe("antigravity bypass-class declarations (ADR-0035, ADR-0045)", () => {
  const DECLARED = [
    "-dangerously-skip-permissions",
    "--remote-control",
    "-remote-control",
    "--gemini_dir",
    "-gemini_dir",
    "--add-dir",
    "-add-dir",
  ];

  it("are active now that the entry has an adapter", () => {
    for (const f of [...DECLARED, "--dangerously-skip-permissions"]) expect(bypassClassFlags()).toContain(f);
  });

  it("each spelling, bare or with a value, is refused outside the approved bypass case and admitted inside it", () => {
    const base = compiled();
    const scoped = privilegedProfile(BYPASS_SCOPE);
    for (const word of [...DECLARED, "-dangerously-skip-permissions=true", "-gemini_dir=/tmp/x"]) {
      const inv = { ...base, argv: [...base.argv, word] };
      const hits = auditInvocation(inv).filter((h) => h !== "--dangerously-skip-permissions");
      expect(hits, word).toHaveLength(1);
      expect(auditInvocation(inv, { profile: profileOf("trusted-development"), bypassApproved: true }), word).toContain(
        hits[0],
      );
      expect(auditInvocation(inv, { profile: scoped, bypassApproved: true }), word).toEqual([]);
    }
  });
});

describe("antigravity probe, auth, parser and resume placeholders (fail closed until T4.33, T4.34)", () => {
  const runner =
    (table: Record<string, { stdout: string; exitCode: number }>): ProbeRunner =>
    async (argv) => {
      const key = argv.slice(1).join(" ");
      const hit = table[key] ?? { stdout: "", exitCode: 2 };
      return { stdout: hit.stdout, stderr: "", exitCode: hit.exitCode, timedOut: false } as ProbeOutput;
    };
  const HELP =
    "Usage of agy:\n  -c, --continue\n  --conversation string\n  --dangerously-skip-permissions\n" +
    "  --output-format string\n  -p, --print, --prompt string\n  --sandbox\n";

  it("passes the five steps on the live-check shapes and reports the version line", async () => {
    const r = await adapter().probe(
      runner({ "--version": { stdout: "1.3.4\n", exitCode: 0 }, "--help": { stdout: HELP, exitCode: 0 } }),
    );
    expect(r.binaryVersion).toBe("1.3.4");
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
  });

  it("names a missing flag, an unparseable version and a missing binary", async () => {
    const noConversation = await adapter().probe(
      runner({
        "--version": { stdout: "1.3.4\n", exitCode: 0 },
        "--help": { stdout: HELP.replace("--conversation", "--talk"), exitCode: 0 },
      }),
    );
    expect(noConversation.steps.find((s) => s.step === "flags")).toMatchObject({
      ok: false,
      detail: "missing --conversation",
    });
    const noVersion = await adapter().probe(runner({ "--version": { stdout: "agy\n", exitCode: 0 } }));
    expect(noVersion.binaryVersion).toBeNull();
    const missing = await new AntigravityAdapter({ pathEnv: "/nonexistent" }).probe(runner({}));
    expect(missing.steps).toEqual([{ step: "binary", ok: false, detail: "agy not found on PATH" }]);
  });

  it("auth is UNKNOWN, resume is Ineligible, no event is recognised and a clean exit never succeeds", async () => {
    const a = adapter();
    expect(await a.authPreflight(runner({}))).toMatchObject({ state: "UNKNOWN" });
    expect(
      a.resumeArgs({ provider: "codex", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
    expect(
      a.resumeArgs({ provider: "antigravity", nativeSessionId: "c" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ ineligible: true });
    const state = { lines: 0, unknownEvents: 0 } as Parameters<AntigravityAdapter["parseEvent"]>[1];
    expect(a.parseEvent('{"event":"result","result":{"status":"SUCCESS"}}', state)).toEqual([
      { kind: "unknown", rawType: "unparsed" },
    ]);
    const r = a.extractResult([], { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] });
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("reads no Antigravity credential, settings or state file (source inspection)", () => {
    for (const f of ["adapter.ts", "protocol.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/from "node:fs"|readFile|antigravity-oauth-token|settings\.json"/);
    }
  });
});

describe("antigravity registry entry and manifest gate (T4.32)", () => {
  it("is in the provider table with an adapter and declares resumeCwd like the adapter", () => {
    const entry = providerEntry("antigravity");
    expect(entry?.create).toBeDefined();
    expect(entry?.resumeCwd).toBe(adapter().resumeCwd);
    expect(entry?.create?.({}).id).toBe("antigravity");
  });

  it("fails the version gate for any version until `adapters validate` passes one (ADR-0009)", () => {
    const registry = new AdapterRegistry();
    for (const v of ["1.3.4", "1.3.1", "0.0.0", null]) {
      expect(registry.gate("antigravity", v).eligible, String(v)).toBe(false);
    }
  });
});
