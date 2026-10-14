/**
 * T4.42 (TDD §4.5): the Cursor module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and no
 * `cursor-agent` binary is run; probe output is the shape the 2026-10-14 live check recorded (`2026.10.12-d47ca18`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditInvocation, bypassClassFlags, bypassClassShortFlags, bypassClassValues } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { evaluateVersionGate } from "../manifest/index.js";
import { providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import type {
  CompileRequest,
  ExitInfo,
  Invocation,
  NormalizedEvent,
  ParseState,
  ProbeOutput,
  ProbeRunner,
  ResolvedProfile,
  TrustProfile,
} from "../types.js";
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

describe("cursor probe and auth preflight (T4.42, T4.44)", () => {
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

  // T4.44: shapes of the 2026-10-14 live check rows 3b and 3c; account values are invented placeholders.
  const STATUS = "status --format json";
  const LOGGED_IN = JSON.stringify({
    status: "authenticated",
    isAuthenticated: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    userInfo: { email: "someone@example.test", userId: "u-123", firstName: "Some", lastName: "One" },
  });
  const LOGGED_OUT = JSON.stringify({
    status: "unauthenticated",
    isAuthenticated: false,
    hasAccessToken: false,
    hasRefreshToken: false,
    message: "Not logged in",
  });

  it("auth is OK only for isAuthenticated true and AUTH_REQUIRED naming the native login for false (exit 0 both)", async () => {
    expect(await adapter().authPreflight(runner({ [STATUS]: { stdout: LOGGED_IN, exitCode: 0 } }))).toEqual({
      state: "OK",
    });
    expect(await adapter().authPreflight(runner({ [STATUS]: { stdout: LOGGED_OUT, exitCode: 0 } }))).toEqual({
      state: "AUTH_REQUIRED",
      loginCommand: "cursor-agent login",
    });
  });

  it("auth is UNKNOWN for text output, a missing or non-boolean key, another exit code, a timeout and no binary", async () => {
    const cases: Record<string, { stdout: string; exitCode: number }>[] = [
      { [STATUS]: { stdout: "Logged in as someone@example.test\n", exitCode: 0 } },
      { [STATUS]: { stdout: JSON.stringify({ status: "authenticated" }), exitCode: 0 } },
      { [STATUS]: { stdout: JSON.stringify({ isAuthenticated: "true" }), exitCode: 0 } },
      { [STATUS]: { stdout: JSON.stringify([true]), exitCode: 0 } },
      { [STATUS]: { stdout: LOGGED_IN, exitCode: 1 } },
      { [STATUS]: { stdout: "", exitCode: 0 } },
    ];
    for (const table of cases) {
      const r = await adapter().authPreflight(runner(table));
      expect(r, JSON.stringify(table)).toMatchObject({ state: "UNKNOWN" });
      // No account value ever reaches the reason.
      expect(JSON.stringify(r)).not.toMatch(/someone|u-123|example\.test/);
    }
    const timedOut: ProbeRunner = async () => ({ stdout: LOGGED_IN, stderr: "", exitCode: null, timedOut: true });
    expect(await adapter().authPreflight(timedOut)).toMatchObject({
      state: "UNKNOWN",
      reason: expect.stringContaining("timed out"),
    });
    const noSpawn: ProbeRunner = async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      spawnError: "ENOENT",
    });
    expect(await adapter().authPreflight(noSpawn)).toMatchObject({ state: "UNKNOWN" });
    expect(await new CursorAdapter({ pathEnv: "/nonexistent" }).authPreflight(runner({}))).toMatchObject({
      state: "UNKNOWN",
      reason: "cursor-agent not found on PATH",
    });
  });

  it("runs only the status command, with a timeout", async () => {
    const seen: { argv: readonly string[]; timeoutMs?: number }[] = [];
    const rec: ProbeRunner = async (argv, opts) => {
      seen.push({ argv, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      return { stdout: LOGGED_OUT, stderr: "", exitCode: 0, timedOut: false };
    };
    await adapter().authPreflight(rec);
    expect(seen).toEqual([{ argv: [EXE, "status", "--format", "json"], timeoutMs: 10_000 }]);
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

  it("admits Cursor CalVer commit-hash version when manifest validated range covers it (T4.48)", () => {
    const manifest = {
      schema_version: 1 as const,
      provider: "cursor",
      validated_cli_version: "2026.10.12",
      validated_version_range: ">=2026.10.12 <2026.11.0",
      validated_on: "2026-10-14",
      auth_modes_allowed: ["native_cached_subscription" as const],
      automation_surface: ["documented_headless" as const],
      credential_export_allowed: false as const,
      dashboard_scraping_allowed: false as const,
      network_protocol_reverse_engineering: false as const,
      commercial_multi_user_status: "requires-review" as const,
      source_revision: "test",
    };
    const ok = evaluateVersionGate("cursor", manifest, "2026.10.12-d47ca18");
    expect(ok.eligible).toBe(true);
    expect(evaluateVersionGate("cursor", manifest, "2026.10.15-abcdef0").eligible).toBe(true);
    expect(evaluateVersionGate("cursor", manifest, "2026.10.11-d47ca18").eligible).toBe(false);
    expect(evaluateVersionGate("cursor", manifest, "2026.11.01-d47ca18").eligible).toBe(false);
    expect(evaluateVersionGate("cursor", manifest, "2026.10.12-rc.1").eligible).toBe(false);
  });
});

/**
 * T4.43: parser, result, failure classification and resume. SYNTHETIC lines in the shapes the 2026-10-14 live check
 * recorded (rows 5a, 5b, 7a, 7b, 11); ids, text and numbers are invented.
 */
describe("cursor parser and result (T4.43)", () => {
  const SID = "4f1c2a9e-0000-4000-8000-000000000001";
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const INIT = line({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    cwd: "/work/tree",
    session_id: SID,
    model: "Synthetic Model 1",
    permissionMode: "default",
  });
  const USER = line({ type: "user", message: { content: [{ type: "text", text: "the prompt" }] }, session_id: SID });
  const THINK = line({
    type: "thinking",
    subtype: "delta",
    text: "private reasoning",
    session_id: SID,
    timestamp_ms: 1,
  });
  const ASSIST = (text: string) =>
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: SID });
  const tool = (subtype: string, key: string, body: Record<string, unknown>) =>
    line({ type: "tool_call", subtype, call_id: "c1", tool_call: { [key]: body }, session_id: SID });
  const RESULT = (over: Record<string, unknown> = {}) =>
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 10,
      duration_api_ms: 10,
      result: "ok",
      session_id: SID,
      request_id: "req-1",
      usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 },
      ...over,
    });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const parse = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events: NormalizedEvent[] = lines.flatMap((l) => a.parseEvent(l, state));
    return { a, state, events };
  };

  it("success: session id and model from init, reasoning and the prompt echo dropped, usage provider_reported", () => {
    const { a, state, events } = parse([INIT, USER, THINK, ASSIST("ok"), RESULT()]);
    expect(events).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "Synthetic Model 1" },
      { kind: "message", role: "assistant", text: "ok" },
      {
        kind: "usage",
        source: "provider_reported",
        metrics: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 },
      },
      { kind: "result", ok: true },
    ]);
    // No backing vendor is reported, so none is invented from the display name (TDD §4.5, T4.6).
    expect(events.find((e) => e.kind === "session_bound")).not.toHaveProperty("backingProvider");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(state).toMatchObject({ nativeSessionId: SID, unknownEvents: 0, lines: 5 });
    expect(a.extractResult(events, EXIT0)).toEqual({
      ok: true,
      nativeSessionId: SID,
      summary: "ok",
      unknownEventCount: 0,
    });
  });

  it("a refused shell call is PERMISSION_BLOCKED although result says success and the exit is 0 (Q-65)", () => {
    for (const refusal of [
      { rejected: { command: "git push", workingDirectory: "/w", reason: "", isReadonly: false } },
      { permissionDenied: { workingDirectory: "/w", error: "Command blocked by permissions configuration" } },
    ]) {
      const { a, events } = parse([
        INIT,
        tool("started", "shellToolCall", { args: { command: "echo shellok", workingDirectory: "/w" } }),
        tool("completed", "shellToolCall", { args: { command: "echo shellok" }, result: refusal }),
        ASSIST("blocked by the system"),
        RESULT(),
      ]);
      expect(events).toContainEqual({
        kind: "tool_call",
        tool: "shell",
        name: "shellToolCall",
        command: "echo shellok",
      });
      expect(events).toContainEqual({ kind: "permission_denied", tool: "shellToolCall" });
      expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    }
  });

  it("read and edit calls carry their path for the guard; a completed call that succeeded adds nothing", () => {
    const { a, events } = parse([
      INIT,
      tool("started", "readToolCall", { args: { path: "a.txt" } }),
      tool("completed", "readToolCall", { args: { path: "a.txt" }, result: { success: { content: "hello" } } }),
      tool("started", "editToolCall", { args: { path: "a.txt" } }),
      tool("completed", "editToolCall", { result: { success: {} } }),
      tool("started", "getMcpToolsToolCall", { args: {} }),
      ASSIST("done"),
      RESULT(),
    ]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "read", name: "readToolCall", target: "a.txt" },
      { kind: "tool_call", tool: "edit", name: "editToolCall", target: "a.txt" },
      { kind: "tool_call", tool: "other", name: "getMcpToolsToolCall" },
    ]);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: true });
  });

  it("task failure, a non-zero exit, a missing result and a credential source other than the login fail", () => {
    const err = parse([INIT, RESULT({ subtype: "error", is_error: true })]);
    expect(err.a.extractResult(err.events, EXIT0)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    // A failed run prints no stream at all (live check rows 4, 14): exit 1 is TOOL_FAILURE, never success.
    const none = parse([]);
    expect(none.a.extractResult(none.events, { ...EXIT0, exitCode: 1 })).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
    });
    const cut = parse([INIT, ASSIST("partial")]);
    expect(cut.a.extractResult(cut.events, EXIT0)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    const envKey = parse([INIT.replace('"login"', '"env"'), ASSIST("ok"), RESULT()]);
    expect(envKey.a.extractResult(envKey.events, EXIT0)).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
    const clean = parse([INIT, ASSIST("ok"), RESULT()]);
    expect(clean.a.extractResult(clean.events, { ...EXIT0, exitCode: 1 })).toMatchObject({ ok: false });
    expect(clean.a.extractResult(clean.events, { ...EXIT0, outcome: "timeout", timeoutKind: "idle" })).toMatchObject({
      failureCode: "PROCESS_TIMEOUT",
    });
    expect(clean.a.extractResult(clean.events, { ...EXIT0, outcome: "cancelled" })).toMatchObject({
      failureCode: "CANCELLED",
    });
  });

  it("malformed and unknown lines are unknown events, counted, never a result; JSON framing errors emit nothing", () => {
    const { a, state, events } = parse([
      INIT,
      line({ type: "system", subtype: "compact" }),
      line({ type: "brand_new" }),
      line({ no_type: true }),
      line({ type: "tool_call", subtype: "started" }),
      line({ type: "tool_call", subtype: "progress", tool_call: { shellToolCall: {} } }),
      line({ type: "assistant", message: {} }),
      line({ type: "result" }),
      "not json",
    ]);
    expect(events.filter((e) => e.kind === "unknown")).toHaveLength(7);
    expect(state.unknownEvents).toBe(7);
    expect(events.some((e) => e.kind === "result")).toBe(false);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    expect(a.parseEvent({ jsonrpc: "2.0", method: "x" }, state)).toEqual([]);
  });

  it("the session id comes only from structured fields: the first init wins, result binds only when init is absent", () => {
    const other = "4f1c2a9e-0000-4000-8000-000000000002";
    const { events, state } = parse([INIT, INIT.replace(SID, other), ASSIST(`session ${other}`), RESULT()]);
    expect(events.filter((e) => e.kind === "session_bound")).toHaveLength(1);
    expect(state.nativeSessionId).toBe(SID);
    const late = parse([ASSIST("ok"), RESULT()]);
    expect(late.events).toContainEqual({ kind: "session_bound", nativeSessionId: SID });
  });

  it("resume is --resume <id> through the same matrix; another provider's binding and a flag-like id are refused", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const r = adapter().resumeArgs(
      { provider: "cursor", nativeSessionId: SID },
      request({ bypassApproved: true }),
      profile,
    );
    if ("ineligible" in r) throw new Error(r.detail);
    expect(r.argv.slice(1)).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--force",
      "--resume",
      SID,
    ]);
    expect(r.stdin).toEqual({ kind: "text", value: "--yolo fix the failing test" });
    expect(
      adapter().resumeArgs({ provider: "codex", nativeSessionId: SID }, request({ bypassApproved: true }), profile),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
    expect(
      adapter().resumeArgs(
        { provider: "cursor", nativeSessionId: "--force" },
        request({ bypassApproved: true }),
        profile,
      ),
    ).toMatchObject({ reason: "CAPABILITY_MISSING" });
    // The matrix still applies: a resume under a non-privileged profile is Ineligible.
    expect(
      adapter().resumeArgs({ provider: "cursor", nativeSessionId: SID }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ reason: "PROFILE_UNSUPPORTED" });
  });
});
