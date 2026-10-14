/**
 * T4.22 (TDD §4.3): the Grok Build module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `grok` binary is run; probe output is the shape the 2026-10-14 live check recorded (`grok 1.0.50 (...) [stable]`).
 */
import { describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditInvocation, bypassClassFlags } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import type { CompileRequest, ProbeOutput, ProbeRunner, ResolvedProfile, TrustProfile } from "../types.js";
import { GrokAdapter } from "./adapter.js";

const EXE = "/opt/synthetic/grok";
const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
  objective: "--yolo fix the failing test",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const adapter = () => new GrokAdapter({ executable: EXE });
const PROFILES: TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"];
const profileOf = (name: TrustProfile): ResolvedProfile => resolveTrustProfile(name);

describe("grok compile matrix (T4.22)", () => {
  it.each(PROFILES)("%s is Ineligible PROFILE_UNSUPPORTED, with and without a bypass approval", (name) => {
    for (const bypassApproved of [false, true]) {
      const r = adapter().compile(request({ bypassApproved }), { ...profileOf(name), bypassApproved });
      expect(r, name).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    }
  });

  it("privileged compiles only an approved scope with bypass, shell broad, network not allowlist, repo enabled", () => {
    let compiled = 0;
    for (const scope of scopeShapes()) {
      const profile = privilegedProfile(scope);
      for (const approved of [false, true]) {
        const label = JSON.stringify({ scope, approved });
        const r = adapter().compile(request({ bypassApproved: approved }), { ...profile, bypassApproved: approved });
        const readOnly = scope.files.access === "read-only";
        const expectOk =
          approved &&
          scope.bypass &&
          scope.shell.mode === "broad" &&
          scope.network.mode !== "allowlist" &&
          !(readOnly && scope.network.mode !== "off") &&
          scope.repository_config.mode === "enabled";
        if (!expectOk) {
          expect(r, label).toMatchObject({ ineligible: true });
          continue;
        }
        compiled += 1;
        expect("ineligible" in r, label).toBe(false);
        if ("ineligible" in r) continue;
        // The sandbox profile and the permission mode are compiled together, never one without the other.
        expect(r.policyFlags, label).toContain("--always-approve");
        const i = r.policyFlags.indexOf("--sandbox");
        expect(i, label).toBeGreaterThanOrEqual(0);
        expect(["strict", "read-only", "workspace"], label).toContain(r.policyFlags[i + 1]);
        expect(r.policyFlags[i + 1], label).toBe(
          readOnly ? "read-only" : scope.network.mode === "off" ? "strict" : "workspace",
        );
        expect(r.policyFlags.includes("--disable-web-search"), label).toBe(scope.network.mode === "off");
        // The one bypass flag is audited as such: refused without the approved context, permitted with it.
        expect(auditInvocation(r), label).toEqual(["--always-approve"]);
        expect(auditInvocation(r, { profile, bypassApproved: true }), label).toEqual([]);
      }
    }
    expect(compiled).toBe(3); // worktree + broad + (off | on) + enabled, and read-only + broad + off + enabled
  });

  it("never emits a flag the TDD §4.3.1 rules exclude, and keeps the prompt in one `--single=` word", () => {
    const profile = privilegedProfile({
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "off" },
      repository_config: { mode: "enabled" },
      bypass: true,
    });
    const r = adapter().compile(request({ bypassApproved: true }), { ...profile, bypassApproved: true });
    expect("ineligible" in r).toBe(false);
    if ("ineligible" in r) return;
    expect(r.argv[0]).toBe(EXE);
    expect(r.argv).toContain("--single=--yolo fix the failing test");
    expect(r.argv).not.toContain("--yolo");
    expect(r.argv.slice(1).filter((a) => a.startsWith("--single"))).toHaveLength(1);
    expect(r.argv).toContain("--no-auto-update");
    const never = ["--trust", "-w", "--worktree", "--fork-session", "--permission-mode", "--yolo", "-m", "--model"];
    for (const a of r.argv.slice(1)) expect(never.includes(a), a).toBe(false);
    expect(r.stdin).toEqual({ kind: "none" });
    expect(r.envAllowlist).toEqual(["PATH", "HOME"]);
    expect(r.env).toEqual({});
    expect(r.transport).toBe("subprocess-jsonl");
    expect(r.outputFormat).toBe("jsonl");
  });

  it("a requested model, an unapproved bypass and a missing binary are Ineligible with a reason", () => {
    const profile = privilegedProfile({
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "on" },
      repository_config: { mode: "enabled" },
      bypass: true,
    });
    const approved = { ...profile, bypassApproved: true };
    expect(adapter().compile(request({ model: "x", bypassApproved: true }), approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
    });
    expect(adapter().compile(request(), profile)).toMatchObject({ reason: "PROFILE_UNSUPPORTED" });
    const none = new GrokAdapter({ pathEnv: "/nonexistent" });
    expect(none.compile(request({ bypassApproved: true }), approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("not found on PATH"),
    });
  });
});

describe("grok probe, auth, parser and resume placeholders (fail closed until T4.23, T4.24)", () => {
  const runner =
    (table: Record<string, { stdout: string; exitCode: number }>): ProbeRunner =>
    async (argv) => {
      const key = argv.slice(1).join(" ");
      const hit = table[key] ?? { stdout: "", exitCode: 2 };
      return { stdout: hit.stdout, stderr: "", exitCode: hit.exitCode, timedOut: false } as ProbeOutput;
    };
  const HELP =
    "Usage: grok [OPTIONS]\n  -p, --single <PROMPT>\n  --output-format <FORMAT>\n  --sandbox <PROFILE>\n" +
    "  --allow <RULE>\n  --deny <RULE>\n  -r, --resume [<ID>]\n";

  it("passes the five steps on the live-check shapes and reports the version line", async () => {
    const r = await adapter().probe(
      runner({
        version: { stdout: "grok 1.0.50 (c58f321264ba) [stable]\n", exitCode: 0 },
        "--help": { stdout: HELP, exitCode: 0 },
      }),
    );
    expect(r.binaryVersion).toBe("grok 1.0.50 (c58f321264ba) [stable]");
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
  });

  it("names a missing flag, an unparseable version and a missing binary", async () => {
    const noSandbox = await adapter().probe(
      runner({
        version: { stdout: "grok 1.0.50 (x) [stable]\n", exitCode: 0 },
        "--help": { stdout: HELP.replace("--sandbox", "--sandb0x"), exitCode: 0 },
      }),
    );
    expect(noSandbox.steps.find((s) => s.step === "flags")).toMatchObject({ ok: false, detail: "missing --sandbox" });
    const noVersion = await adapter().probe(runner({ version: { stdout: "grok\n", exitCode: 0 } }));
    expect(noVersion.binaryVersion).toBeNull();
    expect(noVersion.steps.find((s) => s.step === "version")?.ok).toBe(false);
    const missing = await new GrokAdapter({ pathEnv: "/nonexistent" }).probe(runner({}));
    expect(missing.steps).toEqual([{ step: "binary", ok: false, detail: "grok not found on PATH" }]);
  });

  it("auth is UNKNOWN, resume is Ineligible, no event is recognised and a clean exit never succeeds", () => {
    const a = adapter();
    expect(
      a.resumeArgs({ provider: "codex", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: "binding is for codex",
    });
    expect(
      a.resumeArgs({ provider: "grok", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({
      ineligible: true,
    });
    const state = { lines: 0, unknownEvents: 0 } as Parameters<GrokAdapter["parseEvent"]>[1];
    expect(a.parseEvent('{"type":"end","stopReason":"end_turn"}', state)).toEqual([
      { kind: "unknown", rawType: "unparsed" },
    ]);
    const r = a.extractResult([], {
      outcome: "exited",
      exitCode: 0,
      signal: null,
      expectedExitCodes: [0],
    });
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("authPreflight is UNKNOWN (fail closed)", async () => {
    expect(await adapter().authPreflight(runner({}))).toMatchObject({ state: "UNKNOWN" });
  });
});

describe("grok registry entry and manifest gate (T4.22)", () => {
  it("is in the provider table with an adapter, declares resumeCwd like the adapter and its bypass values are active", () => {
    const entry = providerEntry("grok");
    expect(entry?.create).toBeDefined();
    expect(entry?.resumeCwd).toBe(adapter().resumeCwd);
    expect(bypassClassFlags()).toContain("--always-approve");
  });

  it("fails the version gate for any version until `adapters validate` passes one (ADR-0009)", () => {
    const registry = new AdapterRegistry();
    for (const v of ["1.0.50", "1.0.52", "0.0.0", null]) {
      expect(registry.gate("grok", v).eligible, String(v)).toBe(false);
    }
  });
});
