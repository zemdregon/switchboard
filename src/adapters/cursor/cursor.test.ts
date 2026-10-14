/**
 * T4.42 (TDD §4.5): the Cursor module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and no
 * `cursor-agent` binary is run; probe output is the shape the 2026-10-14 live check recorded (`2026.10.12-d47ca18`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditInvocation, bypassClassFlags, bypassClassShortFlags, bypassClassValues } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import type { CompileRequest, Invocation, ProbeOutput, ProbeRunner, ResolvedProfile, TrustProfile } from "../types.js";
import { CursorAdapter } from "./adapter.js";

const EXE = "/opt/synthetic/cursor-agent";
const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
  objective: "--yolo fix the failing test",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const adapter = () => new CursorAdapter({ executable: EXE });
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

describe("cursor compile matrix (T4.42)", () => {
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
        expect(r.policyFlags, label).toEqual(["--trust", "--force"]);
        // The one bypass flag is audited as such: refused without the approved context, permitted with it.
        expect(auditInvocation(r), label).toEqual(["--force"]);
        expect(auditInvocation(r, { profile, bypassApproved: false }), label).toEqual(["--force"]);
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

  it("puts the prompt on stdin, never on the argv, and never emits a flag the TDD §4.5 rules exclude", () => {
    const r = compiled();
    expect(r.argv).toEqual([EXE, "--print", "--output-format", "stream-json", "--trust", "--force"]);
    expect(r.stdin).toEqual({ kind: "text", value: "--yolo fix the failing test" });
    expect(r.argv.join(" ")).not.toContain("fix the failing test");
    const never = [
      "agent",
      "-p",
      "-f",
      "--yolo",
      "--approve-mcps",
      "--auto-review",
      "--sandbox",
      "--continue",
      "-w",
      "--worktree",
      "--workspace",
      "--add-dir",
      "--plugin-dir",
      "--api-key",
      "--auth-token",
      "-H",
      "--header",
      "-e",
      "--endpoint",
      "--model",
      "--mode",
    ];
    for (const a of r.argv.slice(1)) expect(never.includes(a), a).toBe(false);
    expect(r.envAllowlist).toEqual(["PATH", "HOME"]);
    expect(r.env).toEqual({});
    expect(r.transport).toBe("subprocess-jsonl");
    expect(r.outputFormat).toBe("jsonl");
    expect(r.cwd).toBe("/work/tree");
  });

  it("a requested model, an unapproved bypass and a missing binary are Ineligible with a reason", () => {
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    expect(adapter().compile(request({ model: "x", bypassApproved: true }), approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
    });
    expect(adapter().compile(request(), profile)).toMatchObject({ reason: "PROFILE_UNSUPPORTED" });
    const none = new CursorAdapter({ pathEnv: "/nonexistent" });
    expect(none.compile(request({ bypassApproved: true }), approved)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: expect.stringContaining("cursor-agent not found on PATH"),
    });
  });
});

describe("cursor bypass-class declarations (ADR-0035, ADR-0037)", () => {
  const LONG = [
    "--auto-review",
    "--worktree",
    "--worktree-base",
    "--skip-worktree-setup",
    "--workspace",
    "--add-dir",
    "--plugin-dir",
    "--api-key",
    "--auth-token",
    "--header",
    "--endpoint",
  ];

  it("are active now that the entry has an adapter", () => {
    for (const f of [...LONG, "--force", "--yolo", "--approve-mcps"]) expect(bypassClassFlags()).toContain(f);
    expect(bypassClassShortFlags()).toEqual(expect.arrayContaining(["-f", "-w", "-H", "-e"]));
    expect(bypassClassValues()).toContainEqual({ flag: "--sandbox", value: "disabled" });
  });

  it("each spelling is refused outside the approved bypass case and admitted inside it", () => {
    const base = compiled();
    const scoped = privilegedProfile(BYPASS_SCOPE);
    const unapproved = privilegedProfile({ ...BYPASS_SCOPE, bypass: false });
    const forms: string[][] = [
      ...LONG.map((f) => [f]),
      ["--api-key=x"],
      ["-f"],
      ["-pf"],
      ["-w"],
      ["-H", "x"],
      ["-e", "http://127.0.0.1:9"],
      ["--sandbox", "disabled"],
      ["--sandbox=DISABLED"],
    ];
    for (const words of forms) {
      const inv = { ...base, argv: [...base.argv, ...words] };
      const label = words.join(" ");
      // Only the added words are hits once `--force` is accounted for.
      expect(
        auditInvocation(inv).filter((h) => h !== "--force"),
        label,
      ).toHaveLength(1);
      expect(auditInvocation(inv, { profile: unapproved, bypassApproved: true }).length, label).toBeGreaterThan(1);
      expect(
        auditInvocation(inv, { profile: profileOf("trusted-development"), bypassApproved: true }),
        label,
      ).not.toEqual([]);
      expect(auditInvocation(inv, { profile: scoped, bypassApproved: true }), label).toEqual([]);
    }
  });
});

describe("cursor probe, auth, parser and resume placeholders (fail closed until T4.43, T4.44)", () => {
  const runner =
    (table: Record<string, { stdout: string; exitCode: number }>): ProbeRunner =>
    async (argv) => {
      const key = argv.slice(1).join(" ");
      const hit = table[key] ?? { stdout: "", exitCode: 2 };
      return { stdout: hit.stdout, stderr: "", exitCode: hit.exitCode, timedOut: false } as ProbeOutput;
    };
  const HELP =
    "Usage: agent [options] [command] [prompt...]\n  -p, --print\n  --output-format <format>\n  --resume [chatId]\n" +
    "  -f, --force\n  --sandbox <mode>\n  --trust\n";

  it("passes the five steps on the live-check shapes and reports the version line", async () => {
    const r = await adapter().probe(
      runner({
        "--version": { stdout: "2026.10.12-d47ca18\n", exitCode: 0 },
        "--help": { stdout: HELP, exitCode: 0 },
      }),
    );
    expect(r.binaryVersion).toBe("2026.10.12-d47ca18");
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
  });

  it("names a missing flag, an unparseable version and a missing binary", async () => {
    const noTrust = await adapter().probe(
      runner({
        "--version": { stdout: "2026.10.12-d47ca18\n", exitCode: 0 },
        "--help": { stdout: HELP.replace("--trust", "--trusty-not"), exitCode: 0 },
      }),
    );
    expect(noTrust.steps.find((s) => s.step === "flags")).toMatchObject({ ok: false, detail: "missing --trust" });
    const noVersion = await adapter().probe(runner({ "--version": { stdout: "cursor\n", exitCode: 0 } }));
    expect(noVersion.binaryVersion).toBeNull();
    expect(noVersion.steps.find((s) => s.step === "version")?.ok).toBe(false);
    const missing = await new CursorAdapter({ pathEnv: "/nonexistent" }).probe(runner({}));
    expect(missing.steps).toEqual([{ step: "binary", ok: false, detail: "cursor-agent not found on PATH" }]);
  });

  it("auth is UNKNOWN, resume is Ineligible, no event is recognised and a clean exit never succeeds", async () => {
    const a = adapter();
    expect(await a.authPreflight(runner({}))).toMatchObject({ state: "UNKNOWN" });
    expect(
      a.resumeArgs({ provider: "codex", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
    expect(
      a.resumeArgs({ provider: "cursor", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ ineligible: true });
    const state = { lines: 0, unknownEvents: 0 } as Parameters<CursorAdapter["parseEvent"]>[1];
    expect(a.parseEvent('{"type":"result","subtype":"success","is_error":false}', state)).toEqual([
      { kind: "unknown", rawType: "unparsed" },
    ]);
    const r = a.extractResult([], { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] });
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("reads no Cursor credential or configuration file (source inspection)", () => {
    for (const f of ["adapter.ts", "protocol.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/from "node:fs"|readFile|cli-config\.json|auth\.json/);
    }
  });
});

describe("cursor registry entry and manifest gate (T4.42)", () => {
  it("is in the provider table with an adapter and declares resumeCwd like the adapter", () => {
    const entry = providerEntry("cursor");
    expect(entry?.create).toBeDefined();
    expect(entry?.resumeCwd).toBe(adapter().resumeCwd);
    expect(entry?.create?.({}).id).toBe("cursor");
  });

  it("fails the version gate for any version until `adapters validate` passes one (ADR-0009)", () => {
    const registry = new AdapterRegistry();
    for (const v of ["2026.10.12-d47ca18", "2026.10.12", "1.0.0", "0.0.0", null]) {
      expect(registry.gate("cursor", v).eligible, String(v)).toBe(false);
    }
  });
});
