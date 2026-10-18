/**
 * T4.62 (TDD §4.7, ADR-0049): the Kimi Code module, probe, compile matrix and registry entry. SYNTHETIC: the executable
 * path is a placeholder and no `kimi` binary is run; probe output is the shape the 2026-10-15 live check recorded
 * (`2.1.1`; `--help` options and subcommands).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditAcpPlan, auditInvocation, bypassClassFlags, bypassClassShortFlags } from "../audit.js";
import { type ConformanceCase, missingRequiredKinds, runConformanceCase, runConformanceSuite } from "../conformance.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { acpDeclarations, providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner } from "../run.js";
import type { CompileRequest, Invocation, ProbeOutput, ProbeRunner, ResolvedProfile, TrustProfile } from "../types.js";
import { isIneligible } from "../types.js";
import { KimiAdapter, scrubStderrLine } from "./adapter.js";
import {
  DEFAULT_SESSION_ID,
  kimiConformanceCases,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";

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
    // Provider-scoped, not shared: Claude Code's `-p` and Antigravity's `--prompt` stay ordinary flags (Q-95).
    expect(bypassClassFlags()).not.toContain("-p");
    expect(bypassClassFlags()).not.toContain("--prompt");
    expect(providerEntry("kimi")?.providerScopedBypassFlags).toEqual(["-p", "--prompt"]);
    const argv = (...words: string[]) => ({ argv: [EXE, ...words], policyFlags: [] });
    expect(auditInvocation(argv("--auto"))).toEqual(["--auto"]);
    expect(auditInvocation(argv("--plan"))).toEqual(["--plan"]);
    expect(auditInvocation(argv("-y"))).toEqual(["-y"]);
    expect(auditInvocation(argv("-yp"))).toEqual(["-y"]);
    expect(auditInvocation(argv("-yp"), undefined, "kimi")).toEqual(["-y", "-p"]);
    expect(auditInvocation(argv("-p", "x"), undefined, "kimi")).toEqual(["-p"]);
    expect(auditInvocation(argv("--prompt", "x"), undefined, "kimi")).toEqual(["--prompt"]);
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

describe("kimi -p/--prompt in the argv audit (T4.62, ADR-0049 item 1, Q-95)", () => {
  const approved = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
  const bypassCell = () => compiled(adapter().compile(request({ bypassApproved: true }), approved));

  it("the approved bypass cell passes the audit, the Kimi-scoped flags included", () => {
    const inv = bypassCell();
    expect(inv.argv).toContain("--prompt=--yolo fix the failing test");
    expect(auditInvocation(inv, { profile: approved, bypassApproved: true }, "kimi")).toEqual([]);
  });

  it("the same argv outside the approved bypass cell is refused even with the compile gate bypassed", () => {
    const inv = bypassCell();
    const refusing = [
      undefined,
      { profile: { ...approved, bypassApproved: false }, bypassApproved: false },
      { profile: privilegedProfile({ ...BYPASS_SCOPE, bypass: false }), bypassApproved: true },
      ...PROFILES.map((name) => ({ profile: profileOf(name), bypassApproved: true })),
    ];
    for (const ctx of refusing) expect(auditInvocation(inv, ctx, "kimi"), ctx?.profile.name).toEqual(["--prompt"]);
    // Every short and two-word spelling the compile could be edited into is refused too.
    const edits: Array<[string, string[], string[]]> = [
      ["-p <prompt>", ["-p", "x"], ["-p"]],
      ["-p=<prompt>", ["-p=x"], ["-p"]],
      ["-p<prompt>", ["-px"], ["-p"]],
      ["--prompt <prompt>", ["--prompt", "x"], ["--prompt"]],
    ];
    for (const [label, words, hits] of edits) {
      const edited = { ...inv, argv: [EXE, ...words], policyFlags: [] };
      expect(auditInvocation(edited, undefined, "kimi"), label).toEqual(hits);
      expect(auditInvocation(edited, { profile: approved, bypassApproved: true }, "kimi"), label).toEqual([]);
    }
  });
});

describe("kimi probe (auth preflight: below; parser and resume: parser-residual.test.ts)", () => {
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

  it("resume refuses a foreign binding and fails closed where compile does (T4.63)", () => {
    const a = adapter();
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
      expect(src, f).not.toMatch(/from "node:fs|readFile|credentials\//);
    }
    // T4.64: the scratch directory module only creates and removes its own directory.
    const scratch = readFileSync(fileURLToPath(new URL("./scratch.ts", import.meta.url)), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(scratch).toMatch(/^import \{ mkdtemp, rm \} from "node:fs\/promises";$/m);
    expect(scratch).not.toMatch(/readFile|readdir|createReadStream|opendir|KIMI_CODE_HOME|kimi-code/);
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

/**
 * T4.64 (FR-AUTH-01/02, NFR-SEC-06, ADR-0049 item 4): the ACP auth probe. SYNTHETIC replies in the shapes of the
 * 2026-10-15 live check ([LIVE] 8 `initialize`, 9 logged-in `session/new`, 10 logged-out `-32000`); no `kimi` is run.
 */
describe("kimi auth preflight (T4.64, ADR-0049 item 4; SYNTHETIC ACP replies)", () => {
  const INIT_OK = {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "2.1.1" }, authMethods: [] },
  };
  const NEW_OK = { jsonrpc: "2.0", id: 2, result: { sessionId: "session_0b8a4c1e-2f3d-4e5a-9b6c-7d8e9f0a1b2c" } };
  const NEW_AUTH = { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Authentication required" } };
  const UPDATE = { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "x" } } };
  const lines = (...msgs: unknown[]) => msgs.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("\n");
  const out =
    (stdout: string, extra: Partial<ProbeOutput> = {}): ProbeRunner =>
    async () => ({ stdout: `${stdout}\n`, stderr: "", exitCode: 0, timedOut: false, ...extra });

  it("runs only `kimi acp` in a fresh scratch directory, writes initialize then session/new, and removes the directory", async () => {
    const seen: Array<{
      argv: readonly string[];
      cwd?: string;
      timeoutMs?: number;
      stdinText?: string;
      existed: boolean;
    }> = [];
    const r = await adapter().authPreflight(async (argv, opts) => {
      seen.push({ argv, ...opts, existed: opts?.cwd !== undefined && existsSync(opts.cwd) });
      return { stdout: lines(INIT_OK, UPDATE, NEW_OK), stderr: "", exitCode: null, timedOut: true };
    });
    expect(r).toEqual({ state: "OK" });
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.argv).toEqual([EXE, "acp"]);
    expect(call?.existed).toBe(true);
    expect(call?.cwd).toMatch(/switchboard-kimi-auth-/);
    expect(existsSync(call?.cwd ?? "")).toBe(false);
    expect(call?.timeoutMs).toBeLessThanOrEqual(30_000);
    const sent = (call?.stdinText ?? "")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "switchboard", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: call?.cwd, mcpServers: [] } },
    ]);
    // Never a login, an `authenticate`, a mode change or a prompt (no model call, no bypass-class mode).
    expect(call?.stdinText).not.toMatch(/authenticate|--login|session\/prompt|set_mode|yolo|auto/);
  });

  it("a logged-out session/new (-32000) is AUTH_REQUIRED naming `kimi login`, at any exit or timeout", async () => {
    for (const extra of [{}, { exitCode: 1 }, { exitCode: null, timedOut: true }]) {
      expect(await adapter().authPreflight(out(lines(INIT_OK, NEW_AUTH), extra))).toEqual({
        state: "AUTH_REQUIRED",
        loginCommand: "kimi login",
      });
    }
  });

  it("anything unrecognised is UNKNOWN (fail closed) and the reason carries no provider text", async () => {
    const cases: Array<[string, ProbeRunner]> = [
      ["empty output", out("")],
      ["no session/new reply", out(lines(INIT_OK))],
      ["no initialize reply", out(lines(NEW_OK))],
      ["initialize error", out(lines({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "x" } }, NEW_OK))],
      ["initialize version 2", out(lines({ ...INIT_OK, result: { protocolVersion: 2 } }, NEW_OK))],
      ["initialize -32000", out(lines({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "a" } }, NEW_AUTH))],
      ["another session/new error", out(lines(INIT_OK, { jsonrpc: "2.0", id: 2, error: { code: -32603 } }))],
      ["-32000 with a result too", out(lines(INIT_OK, { ...NEW_AUTH, result: NEW_OK.result }))],
      ["a string error code", out(lines(INIT_OK, { jsonrpc: "2.0", id: 2, error: { code: "-32000" } }))],
      ["no sessionId", out(lines(INIT_OK, { jsonrpc: "2.0", id: 2, result: {} }))],
      ["a flag-like sessionId", out(lines(INIT_OK, { jsonrpc: "2.0", id: 2, result: { sessionId: "--yolo" } }))],
      ["a string id", out(lines(INIT_OK, { ...NEW_OK, id: "2" }))],
      ["two session/new replies", out(lines(INIT_OK, NEW_OK, NEW_AUTH))],
      ["two initialize replies", out(lines(INIT_OK, INIT_OK, NEW_OK))],
      ["a non-JSON line", out(lines("Welcome to Kimi", INIT_OK, NEW_OK))],
      ["a JSON array line", out(lines("[1]", INIT_OK, NEW_OK))],
      ["a truncated reply on timeout", out(`${lines(INIT_OK)}\n{"jsonrpc":"2.0","id":2,"res`, { timedOut: true })],
      ["spawn error", out("", { exitCode: null, spawnError: "ENOENT" })],
    ];
    for (const [name, runner] of cases) {
      const r = await adapter().authPreflight(runner);
      expect(r, name).toMatchObject({ state: "UNKNOWN" });
    }
    const leak = await adapter().authPreflight(
      out(lines(INIT_OK, { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "secret: hunter2" } })),
    );
    expect(leak).toEqual({
      state: "UNKNOWN",
      reason: "Kimi Code ACP auth probe was inconclusive (session/new error -32603, exit 0)",
    });
  });

  it("is UNKNOWN when the binary is not on PATH, without running anything", async () => {
    let ran = false;
    const r = await new KimiAdapter({ pathEnv: "/nonexistent" }).authPreflight(async () => {
      ran = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });
    expect(r).toEqual({ state: "UNKNOWN", reason: "kimi not found on PATH" });
    expect(ran).toBe(false);
  });

  it("removes the scratch directory when the runner throws", async () => {
    let dir: string | undefined;
    await expect(
      adapter().authPreflight(async (_argv, opts) => {
        dir = opts?.cwd;
        throw new Error("runner failed");
      }),
    ).resolves.toMatchObject({ state: "UNKNOWN" });
    expect(dir).toBeDefined();
    expect(existsSync(dir ?? "")).toBe(false);
  });

  it("holds stdin until a reply for both request ids has arrived (T4.64 fix); notifications do not count", async () => {
    let until: ((m: unknown) => boolean) | undefined;
    await adapter().authPreflight(async (_argv, opts) => {
      until = opts?.holdStdinUntil;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });
    expect(until).toBeDefined();
    const hold = until ?? (() => true);
    expect(hold(INIT_OK)).toBe(false);
    expect(hold(UPDATE)).toBe(false);
    expect(hold({ jsonrpc: "2.0", id: 2, method: "session/request_permission" })).toBe(false);
    expect(hold("not an object")).toBe(false);
    expect(hold(NEW_AUTH)).toBe(true);
  });

  it("names the exit and stdin state in an UNKNOWN reason when the runner reports it", async () => {
    expect(await adapter().authPreflight(out(lines(INIT_OK), { stdinOpenAtEnd: false }))).toEqual({
      state: "UNKNOWN",
      reason: "Kimi Code ACP auth probe was inconclusive (session/new missing, exit 0, stdin closed)",
    });
    expect(
      await adapter().authPreflight(out(lines(INIT_OK), { exitCode: null, timedOut: true, stdinOpenAtEnd: true })),
    ).toEqual({
      state: "UNKNOWN",
      reason: "Kimi Code ACP auth probe was inconclusive (session/new missing, timed out, stdin still open)",
    });
  });
});

describe("kimi auth preflight through the real probe runner (T4.64; SYNTHETIC `kimi acp` stand-in)", () => {
  const SCRIPT = fileURLToPath(new URL("./fixtures/fake-acp-auth.mjs", import.meta.url));
  const via = (scenario: string) =>
    new KimiAdapter({ executable: process.execPath, launcherArgs: [SCRIPT, `--scenario=${scenario}`] }).authPreflight(
      createProbeRunner(),
    );

  it("stdin reaches the process: logged in is OK, logged out is AUTH_REQUIRED, no reply is UNKNOWN", async () => {
    expect(await via("logged-in")).toEqual({ state: "OK" });
    expect(await via("logged-out")).toEqual({ state: "AUTH_REQUIRED", loginCommand: "kimi login" });
    expect(await via("silent")).toMatchObject({
      state: "UNKNOWN",
      reason: expect.stringContaining("initialize missing"),
    });
  });

  it("a `kimi acp` that exits 0 at stdin end-of-file before answering session/new is OK: stdin is held (T4.64 fix)", async () => {
    expect(await via("exit-on-eof")).toEqual({ state: "OK" });
    // The 2026-10-17 failure: closing stdin straight after writing loses the race (what origin/main did).
    const closeAtOnce: ProbeRunner = (argv, opts) => {
      const { holdStdinUntil: _held, ...rest } = opts ?? {};
      return createProbeRunner()(argv, rest);
    };
    expect(
      await new KimiAdapter({
        executable: process.execPath,
        launcherArgs: [SCRIPT, "--scenario=exit-on-eof"],
      }).authPreflight(closeAtOnce),
    ).toEqual({ state: "UNKNOWN", reason: "Kimi Code ACP auth probe was inconclusive (session/new missing, exit 0)" });
  });

  it("an UNKNOWN reason names the exit, whether stdin was still open and a scrubbed first stderr line", async () => {
    const r = await via("silent");
    expect(r).toEqual({
      state: "UNKNOWN",
      reason:
        'Kimi Code ACP auth probe was inconclusive (initialize missing, exit 0, stdin still open, stderr: "{\\"level\\":\\"error\\",\\"msg\\":\\"acp: auth readiness probe failed\\",\\"file\\":\\"<path>\\",\\"token\\":\\"[REDACTED]\\"}")',
    });
  });
});

describe("kimi auth probe stderr scrubbing (T4.64 diagnostics)", () => {
  it("keeps only the first non-blank line, clipped, with no path under HOME, token, account id or e-mail", () => {
    expect(scrubStderrLine("")).toBeUndefined();
    expect(scrubStderrLine("\n  \nfirst line\nsecond line")).toBe("first line");
    const s =
      scrubStderrLine(
        "error at /home/op/.kimi/credentials/kimi-code.json for user 123456789 (op@example.com) " +
          "session 0b8a4c1e-2f3d-4e5a-9b6c-7d8e9f0a1b2c key sk-abcdefghijklmnopqrstuvwxyz012345 " +
          "tok AbCdEfGhIjKlMnOp1234567 hash deadbeefdeadbeefdeadbeef Bearer abcdefgh12345678 ~/x C:\\Users\\op\\y",
        "/home/op",
      ) ?? "";
    for (const leak of [
      "/home",
      "op@",
      ".kimi",
      "credentials",
      "123456789",
      "0b8a4c1e",
      "sk-",
      "AbCdEf",
      "deadbeef",
      "abcdefgh12345678",
      "Users",
    ]) {
      expect(s, leak).not.toContain(leak);
    }
    expect(s).toContain("<path>");
    expect(s).toContain("<email>");
    expect(s).toContain("<n>");
    expect(s).toContain("<id>");
    expect(s).toContain("[REDACTED]");
    expect(s).toContain("<token>");
    expect(scrubStderrLine(`${"word ".repeat(100)}`)?.length).toBeLessThanOrEqual(163);
    expect(scrubStderrLine("bell\u0007 and \u001b[31mcolour")).not.toMatch(/\p{Cc}/u);
  });
});

/**
 * T4.65 (FR-ADP-11): the shared conformance suite over synthetic recorded fixtures (`./fixtures/*.jsonl`, in the
 * `stream-json` record shapes of the scrubbed 2026-10-15 capture), replayed by `replay.mjs --provider kimi` in place of
 * the binary, so it passes with no `kimi` installed. Only the approved bypass cell is replayed (ADR-0049 item 1); the
 * prompt reaches the replay as the one `--prompt=` argv word. The restricted `kimi acp` cell is not a conformance case
 * here: its ACP client runs against the shared fake ACP agent (T4.8) and its permission round trip is T4.68.
 */
describe("kimi conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.65)", () => {
  const dirs: string[] = [];
  const makeCwd = () => {
    const d = mkdtempSync(join(tmpdir(), "sb-kimi-t465-"));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const caseOf = (kind: ConformanceCase["kind"]): ConformanceCase => {
    const c = kimiConformanceCases(makeCwd).find((x) => x.kind === kind);
    if (!c) throw new Error(`missing ${kind} case`);
    return c;
  };
  const shapeRequest = (over: Partial<CompileRequest> = {}): CompileRequest => ({
    runId: "run_kimi_shape",
    objective: "synthetic kimi objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
    bypassApproved: true,
    ...over,
  });
  /**
   * `a` with its compiled invocation rewritten by `edit`, to show the replay refuses a wrong compile. A proxy, not
   * `Object.create`: the adapter's private fields are only readable with `a` itself as `this`.
   */
  const brokenBy = (a: KimiAdapter, edit: (inv: Invocation) => Invocation): KimiAdapter => {
    const compile: KimiAdapter["compile"] = (r, p) => {
      const inv = a.compile(r, p);
      return isIneligible(inv) ? inv : { ...edit(inv), policyFlags: [] };
    };
    return new Proxy(a, {
      get(target, key) {
        if (key === "compile") return compile;
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  /** Rewrites only the provider words after the launcher's `--`. */
  const argvEdit =
    (edit: (words: string[]) => string[]) =>
    (inv: Invocation): Invocation => {
      const sep = inv.argv.indexOf("--");
      return { ...inv, argv: [...inv.argv.slice(0, sep + 1), ...edit(inv.argv.slice(sep + 1))] };
    };
  const SUCCESS = {
    ok: true,
    nativeSessionId: DEFAULT_SESSION_ID,
    summary: "Reading the file first.\nAdded hello.txt.",
  };

  it("covers every FR-ADP-11 kind and passes the full suite", async () => {
    const cases = kimiConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    expect(new Set(cases.map((c) => c.kind))).toEqual(
      new Set([
        "success",
        "task_failure",
        "resume",
        "auth_missing",
        "malformed_output",
        "cancellation",
        "timeout",
        "partial_mutation",
      ]),
    );
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("success with edit normalizes session, summary and the edit; tool output is never an event", async () => {
    const c = caseOf("success");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ...SUCCESS, unknownEventCount: 0 });
    expect(readFileSync(join(c.request.workspace.cwd, "hello.txt"), "utf8")).toContain("synthetic");
  });

  it("resumed run appends --session <id> and nothing else, and preserves the native session id", async () => {
    const c = caseOf("resume");
    const inv = compiled(
      c.adapter.resumeArgs(c.binding ?? { provider: "kimi", nativeSessionId: "" }, c.request, c.profile),
    );
    expect(inv.argv.slice(inv.argv.indexOf("--") + 1)).toEqual([
      "--prompt=synthetic kimi objective",
      "--output-format",
      "stream-json",
      "--session",
      RESUMED_SESSION_ID,
    ]);
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: RESUMED_SESSION_ID });
  });

  it("the login error record ends AUTH_REQUIRED with no session, never a success", async () => {
    const report = await runConformanceCase(caseOf("auth_missing"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it("partial mutation leaves the file in the cwd and still fails", async () => {
    const c = caseOf("partial_mutation");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(c.request.workspace.cwd, "partial.txt"), "utf8")).toContain("synthetic");
  });

  it("positive controls: the unedited bypass compile, with and without a model, replays to success", async () => {
    for (const over of [{}, { model: "synthetic-model" }]) {
      const report = await runConformanceCase({
        kind: "success",
        adapter: brokenBy(replayAdapter("success_edit"), (inv) => inv),
        request: shapeRequest(over),
        profile: PRIVILEGED_BYPASS_PROFILE,
        expect: SUCCESS,
      });
      expect(
        report.checks.filter((k) => !k.ok),
        JSON.stringify(over),
      ).toEqual([]);
    }
  });

  it.each([
    ["--prompt= removed", (w: string[]) => w.filter((x) => !x.startsWith("--prompt="))],
    ["--prompt= repeated", (w: string[]) => [w[0] ?? "", ...w]],
    [
      "two-word --prompt",
      (w: string[]) => w.flatMap((x) => (x.startsWith("--prompt=") ? ["--prompt", x.slice(9)] : [x])),
    ],
    [
      "-p instead of --prompt=",
      (w: string[]) => w.flatMap((x) => (x.startsWith("--prompt=") ? ["-p", x.slice(9)] : [x])),
    ],
    ["--output-format text", (w: string[]) => w.map((x) => (x === "stream-json" ? "text" : x))],
    ["--output-format removed", (w: string[]) => w.filter((x) => x !== "--output-format" && x !== "stream-json")],
    ["--output-format=stream-json", (w: string[]) => [w[0] ?? "", "--output-format=stream-json"]],
    ["flags reordered", (w: string[]) => [...w.slice(1), w[0] ?? ""]],
    ["--yolo added", (w: string[]) => [...w, "--yolo"]],
    ["-y added", (w: string[]) => [...w, "-y"]],
    ["--auto added", (w: string[]) => [...w, "--auto"]],
    ["--plan added", (w: string[]) => [...w, "--plan"]],
    ["--continue added", (w: string[]) => [...w, "--continue"]],
    ["--agent-file added", (w: string[]) => [...w, "--agent-file", "agent.yaml"]],
    ["--add-dir added", (w: string[]) => [...w, "--add-dir", "/"]],
    ["--skills-dir added", (w: string[]) => [...w, "--skills-dir", "skills"]],
    ["-r <id> added", (w: string[]) => [...w, "-r", DEFAULT_SESSION_ID]],
    ["-S <id> added", (w: string[]) => [...w, "-S", DEFAULT_SESSION_ID]],
    ["--session=<id> form", (w: string[]) => [...w, `--session=${DEFAULT_SESSION_ID}`]],
    ["--session with a flag-like id", (w: string[]) => [...w, "--session", "--yolo"]],
    ["--session without an id", (w: string[]) => [...w, "--session"]],
    ["two-word --model", (w: string[]) => ["--model", "synthetic-model", ...w]],
    ["--model= after the prompt", (w: string[]) => [w[0] ?? "", "--model=synthetic-model", ...w.slice(1)]],
    ["acp subcommand prepended", (w: string[]) => ["acp", ...w]],
    ["a positional word appended", (w: string[]) => [...w, "extra"]],
  ])(
    "the replay refuses an argv Kimi Code would not be given (%s), so a wrong compile cannot pass",
    async (_n, edit) => {
      const report = await runConformanceCase({
        kind: "success",
        adapter: brokenBy(replayAdapter("success_edit"), argvEdit(edit)),
        request: shapeRequest(),
        profile: PRIVILEGED_BYPASS_PROFILE,
        expect: SUCCESS,
      });
      expect(report.ok).toBe(false);
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 64" });
    },
  );

  it("the replay refuses a run whose environment carries KIMI_CODE_HOME (configuration and credential relocation)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: brokenBy(replayAdapter("success_edit"), (inv) => ({
        ...inv,
        env: { ...inv.env, KIMI_CODE_HOME: "/nonexistent/synthetic-kimi-home" },
      })),
      request: shapeRequest(),
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: SUCCESS,
    });
    expect(report.ok).toBe(false);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 64" });
  });
});
