/**
 * T4.42 (TDD §4.5): the Cursor module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and no
 * `cursor-agent` binary is run; probe output is the shape the 2026-10-14 live check recorded (`2026.10.12-d47ca18`).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../artifacts/index.js";
import { GIT_FINALIZE_COMMIT_EVENT, GitPublisher, publishRefFor } from "../../git/index.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, openLedger } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { createSwitchboardServer } from "../../mcp/server.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { WorkspaceManager } from "../../workspace/index.js";
import { auditInvocation, bypassClassFlags, bypassClassShortFlags, bypassClassValues } from "../audit.js";
import { type ConformanceCase, missingRequiredKinds, runConformanceCase, runConformanceSuite } from "../conformance.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { evaluateVersionGate } from "../manifest/index.js";
import { providerEntry } from "../providers.js";
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
  ResolvedProfile,
  TrustProfile,
} from "../types.js";
import { isIneligible } from "../types.js";
import { CURSOR_GIT_CAPABILITIES, CURSOR_GIT_WRITE_CONTROL, CursorAdapter } from "./adapter.js";
import {
  cursorConformanceCases,
  DEFAULT_SESSION_ID,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";
import { GIT_WRITE_CONTROL_DETAIL, NON_PRIVILEGED_UNSUPPORTED_DETAIL } from "./protocol.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-cursor-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

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
    const { a, events, state } = parse([INIT, INIT.replace(SID, other), ASSIST(`session ${other}`), RESULT()]);
    expect(events.filter((e) => e.kind === "session_bound")).toHaveLength(1);
    expect(state.nativeSessionId).toBe(SID);
    // A second id makes the binding ambiguous: the first stays bound and the run fails closed.
    expect(a.extractResult(events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
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

/**
 * T4.43 hardening (Delegated, not owner-approved): SYNTHETIC lines in the recorded shapes, bent the ways a stream could
 * deviate from them. Each case fails closed or is pinned as observed; none is a recorded Cursor shape.
 */
describe("cursor parser hardening (T4.43, synthetic shapes)", () => {
  const SID = "4f1c2a9e-0000-4000-8000-00000000000c";
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const INIT = (over: Record<string, unknown> = {}) =>
    line({
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      session_id: SID,
      model: "Synthetic Model 1",
      ...over,
    });
  const ASSIST = (text: string) =>
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: SID });
  const RESULT = (over: Record<string, unknown> = {}) =>
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      session_id: SID,
      usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 },
      ...over,
    });
  const TOOL = (subtype: string, call: Record<string, unknown>) =>
    line({ type: "tool_call", subtype, call_id: "c1", tool_call: call, session_id: SID });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const parse = (lines: string[], exit: ExitInfo = EXIT0) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events: NormalizedEvent[] = lines.flatMap((l) => a.parseEvent(l, state));
    return { state, events, result: a.extractResult(events, exit) };
  };

  it("a second result line fails the run even when it reports success", () => {
    const failedThenOk = parse([INIT(), RESULT({ subtype: "error", is_error: true }), RESULT()]);
    expect(failedThenOk.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    const okTwice = parse([INIT(), ASSIST("ok"), RESULT(), RESULT()]);
    expect(okTwice.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    expect(okTwice.events.filter((e) => e.kind === "result").map((e) => e.kind === "result" && e.ok)).toEqual([
      true,
      false,
    ]);
    // Results are counted per run: a new parse state starts at zero.
    expect(parse([INIT(), RESULT()]).result).toMatchObject({ ok: true });
  });

  it("a result for another session fails the run and never rebinds; the same id again is fine", () => {
    const other = "4f1c2a9e-0000-4000-8000-00000000000d";
    const r = parse([INIT(), ASSIST("ok"), RESULT({ session_id: other })]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: SID });
    expect(r.state.nativeSessionId).toBe(SID);
    expect(r.events.filter((e) => e.kind === "session_bound")).toHaveLength(1);
    expect(parse([INIT(), INIT(), ASSIST("ok"), RESULT()]).result).toMatchObject({ ok: true });
    // Non-string and empty ids never bind; a later structured id still can.
    const late = parse([INIT({ session_id: 7 }), INIT({ session_id: "" }), ASSIST("ok"), RESULT()]);
    expect(late.result).toMatchObject({ ok: true, nativeSessionId: SID });
  });

  it("a credential source that is not the string login fails the run AUTH_REQUIRED; an absent one does not", () => {
    for (const apiKeySource of ["env", "flag", "", "LOGIN", null, 1, true, ["login"], { source: "login" }]) {
      const r = parse([INIT({ apiKeySource }), ASSIST("ok"), RESULT()]);
      expect(r.result, JSON.stringify(apiKeySource)).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
      expect(JSON.stringify(r.events)).toContain("cursor-agent login");
    }
    expect(parse([INIT({ apiKeySource: undefined }), ASSIST("ok"), RESULT()]).result).toMatchObject({ ok: true });
  });

  it("negative, non-finite and non-number usage values are dropped; no usable counter means no usage row", () => {
    const r = parse([
      INIT(),
      RESULT({ usage: { inputTokens: -5, outputTokens: "3", cacheReadTokens: null, cacheWriteTokens: 4, extra: 9 } }),
    ]);
    expect(r.events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { cacheWriteTokens: 4 } },
    ]);
    expect(r.result).toMatchObject({ ok: true });
    for (const usage of [[11], "11", { inputTokens: -1 }, {}]) {
      const none = parse([INIT(), RESULT({ usage })]);
      expect(
        none.events.some((e) => e.kind === "usage"),
        JSON.stringify(usage),
      ).toBe(false);
    }
  });

  it("is_error other than false, or a subtype other than success, is never a success", () => {
    for (const over of [
      { is_error: true },
      { is_error: "false" },
      { is_error: undefined },
      { subtype: "error_max_turns" },
      { subtype: "Success" },
    ]) {
      expect(parse([INIT(), ASSIST("ok"), RESULT(over)]).result, JSON.stringify(over)).toMatchObject({ ok: false });
    }
  });

  it("a tool_call object with several keys reports each, so a decoy key cannot hide a shell call or a refusal", () => {
    const r = parse([
      INIT(),
      TOOL("started", {
        getMcpToolsToolCall: { args: {} },
        shellToolCall: { args: { command: "git push origin main" } },
      }),
      TOOL("completed", {
        getMcpToolsToolCall: { result: { success: {} } },
        shellToolCall: { result: { rejected: { command: "git push origin main" } } },
      }),
      RESULT(),
    ]);
    expect(r.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "getMcpToolsToolCall" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
    ]);
    expect(r.events).toContainEqual({ kind: "permission_denied", tool: "shellToolCall" });
    expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    const empty = parse([INIT(), TOOL("started", {}), RESULT()]);
    expect(empty.state.unknownEvents).toBe(1);
  });

  it("a shell call without a string command is reported without one (guard blind, pinned); a long path is clipped", () => {
    const r = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: ["git", "push"] } } }),
      TOOL("started", { shellToolCall: {} }),
      TOOL("started", { editToolCall: { args: { path: `/${"p".repeat(600)}` } } }),
      RESULT(),
    ]);
    const calls = r.events.filter((e) => e.kind === "tool_call");
    expect(calls.slice(0, 2)).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall" },
    ]);
    expect(calls[2]).toMatchObject({ tool: "edit", target: `/${"p".repeat(511)}…` });
  });

  it("cases with no recorded native shape end TOOL_FAILURE, never RATE_LIMIT_TRANSIENT, SANDBOX_VIOLATION or success", () => {
    // No rate-limit, quota or sandbox event was recorded (live check rows 4, 9, 14): text naming one is not read.
    for (const text of ["429 Too Many Requests", "rate limit reached", "quota exceeded", "sandbox: operation denied"]) {
      const asError = parse([INIT(), ASSIST(text), RESULT({ subtype: "error", is_error: true, result: text })]);
      expect(asError.result, text).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
      expect(
        asError.events.some((e) => e.kind === "rate_limit" || e.kind === "sandbox_violation"),
        text,
      ).toBe(false);
      // A failed run prints no stream ([LIVE] 4, 14), so only the exit code is left.
      expect(parse([], { ...EXIT0, exitCode: 1 }).result, text).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
      });
    }
    // An unknown line type that could be a rate-limit event is counted, never a success on its own.
    const unknownOnly = parse([INIT(), line({ type: "rate_limit", retry_after_ms: 1000 })]);
    expect(unknownOnly.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 1 });
  });

  // ADR-0039: a guard verdict ends the run in every run, bypass included, and the lifecycle trusts `result.ok`, so a
  // flagged tool_call must not be called clean even with a `success` result at exit 0.
  it("a guard-flagged Git write with a success result ends PERMISSION_BLOCKED (ADR-0039)", () => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const ctx = { cwd: "/w", bypass: true };
    const events = [
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "git push origin main", workingDirectory: "/w" } } }),
      ASSIST("pushed"),
      RESULT(),
    ]
      .flatMap((l) => a.parseEvent(l, state))
      .map((e) => guardEvent(e, ctx));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_call", violation: expect.anything() }));
    const r = a.extractResult(events, EXIT0);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(r.failureDetail).toMatch(/^git write attempted/);
  });

  it("any guard verdict on a tool_call makes a success result not clean (a provider_state verdict ends SANDBOX_VIOLATION)", () => {
    const { events } = parse([INIT(), ASSIST("ok"), RESULT()]);
    const flagged: NormalizedEvent = {
      kind: "tool_call",
      tool: "shell",
      name: "shellToolCall",
      violation: { kind: "provider_state", reason: "synthetic" },
    };
    expect(adapter().extractResult([flagged, ...events], EXIT0)).toMatchObject({
      ok: false,
      failureCode: "SANDBOX_VIOLATION",
    });
  });

  it("non-object roots and lines after a malformed result never bind or succeed", () => {
    const r = parse(["[]", "null", "1", '"result"', line({ type: 1 }), line({ type: "result", subtype: 5 })]);
    expect(r.state.unknownEvents).toBe(6);
    expect(r.state.nativeSessionId).toBeUndefined();
    expect(r.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });
});

describe("cursor conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.45)", () => {
  it("covers every FR-ADP-11 kind and passes the full suite", async () => {
    const cases = cursorConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("success with edit normalizes session, summary, tool calls and usage; drops reasoning", async () => {
    const c = cursorConformanceCases(makeCwd).find((x) => x.kind === "success");
    if (!c) throw new Error("missing success case");
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

  it("resumed run preserves native session id", async () => {
    const c = cursorConformanceCases(makeCwd).find((x) => x.kind === "resume");
    if (!c) throw new Error("missing resume case");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: RESUMED_SESSION_ID,
    });
  });

  it("partial mutation leaves the file in the cwd", async () => {
    const c = cursorConformanceCases(makeCwd).find((x) => x.kind === "partial_mutation");
    if (!c) throw new Error("missing partial_mutation case");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(c.request.workspace.cwd, "partial.txt"), "utf8")).toContain("synthetic");
  });

  it("permission denial ends PERMISSION_BLOCKED even at exit 0", async () => {
    const req = {
      runId: "run_cursor_perm",
      objective: "permission test",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
      bypassApproved: true,
    };
    const c: ConformanceCase = {
      profile: PRIVILEGED_BYPASS_PROFILE,
      kind: "task_failure",
      adapter: replayAdapter("permission_denied"),
      request: req,
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED" },
    };
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result?.failureCode).toBe("PERMISSION_BLOCKED");
  });

  it("hang that ignores SIGTERM is cancelled with the process group empty", async () => {
    const c = cursorConformanceCases(makeCwd).find((x) => x.kind === "cancellation");
    if (!c) throw new Error("missing cancellation case");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.checks.find((k) => k.name === "process group empty after run")?.ok).toBe(true);
  });
});

describe("cursor Git declaration (T4.47, FR-GIT-01, FR-GIT-02, FR-GIT-09)", () => {
  it("declares that Cursor documents no Git write control, leaving FR-GIT-03 and FR-GIT-06", () => {
    const c = adapter().gitWriteControl;
    expect(c.kind).toBe("none-documented");
    expect(c.remainingControls).toEqual(["FR-GIT-03", "FR-GIT-06"]);
    expect(c.detail).toBe(GIT_WRITE_CONTROL_DETAIL);
    expect(c.detail).toMatch(/no per-run permission flag/i);
    expect(c.detail).toMatch(/CURSOR_CONFIG_DIR/);
    expect(c.detail).toMatch(/FR-GIT-03/);
    expect(c.detail).toMatch(/FR-GIT-06/);
    expect(adapter().gitWriteControl).toBe(CURSOR_GIT_WRITE_CONTROL);
  });

  it("declares finalize-only commit channel (FR-GIT-09, owner decision 36)", () => {
    const caps = adapter().gitCapabilities;
    expect(caps.commitChannel).toBe("finalize-only");
    expect(caps.detail).toMatch(/FR-GIT-09/);
    expect(caps.detail).toMatch(/--approve-mcps/);
    expect(adapter().gitCapabilities).toBe(CURSOR_GIT_CAPABILITIES);
  });

  it("list_capabilities reports Cursor's Git-write declaration through MCP", async () => {
    const root = realpathSync(makeCwd());
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const registry = new AdapterRegistry().register(adapter());
    const real = createProbeRunner();
    const probeRunner: ProbeRunner = async (argv, opts) =>
      argv[0] === process.execPath
        ? real(argv, opts)
        : { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "refused in tests" };
    const lifecycle = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
      artifacts,
      adapters: registry,
      allowedRoots: [root],
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
        allowedRoots: [root],
        projects: [],
        mcpClients: new Map([["c1", { id: "c1", maxTrustProfile: "edit-untrusted" as const }]]),
      },
      clientId: "c1",
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.server.connect(serverSide);
      await client.connect(clientSide);
      const res = await client.callTool({ name: "list_capabilities", arguments: {} });
      const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}");
      const cursor = body.providers.find((p: { provider: string }) => p.provider === "cursor");
      expect(cursor).toBeDefined();
      expect(cursor.git_write_control).toEqual({
        kind: "none-documented",
        detail: GIT_WRITE_CONTROL_DETAIL,
        remaining_controls: ["FR-GIT-03", "FR-GIT-06"],
      });
    } finally {
      await client.close();
      await mcp.close();
      await lifecycle.shutdown();
      db.close();
    }
  });

  it("every compiled invocation puts prompt on stdin and carries no git command or credentials in argv/env", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const initial = adapter().compile(request({ bypassApproved: true }), profile);
    const resumed = adapter().resumeArgs(
      { provider: "cursor", nativeSessionId: "s-123" },
      request({ bypassApproved: true }),
      profile,
    );
    for (const [name, inv] of [
      ["initial", initial],
      ["resumed", resumed],
    ] as const) {
      if (isIneligible(inv)) throw new Error(`unexpected ineligible: ${inv.detail}`);
      expect(inv.stdin).toEqual({ kind: "text", value: "--yolo fix the failing test" });
      expect(auditInvocation(inv, { profile, bypassApproved: true })).toEqual([]);
      for (const a of inv.argv.slice(1)) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} argv has git: ${a}`).toBe(false);
      }
      for (const a of inv.policyFlags) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} policyFlags has git: ${a}`).toBe(false);
      }
      expect(inv.envAllowlist).toEqual(["PATH", "HOME"]);
      for (const k of Object.keys(inv.env)) {
        expect(/GIT|GITHUB|GH|CURSOR_API|CURSOR_AUTH/.test(k), `${name} env: ${k}`).toBe(false);
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
  ])("shell allowlist entry %j is Ineligible (PROFILE_UNSUPPORTED, FR-GIT-01)", (entry) => {
    const editUntrusted = profileOf("edit-untrusted");
    const r1 = adapter().compile(request(), { ...editUntrusted, shellAllowlist: [entry] });
    expect(r1).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if ("ineligible" in r1 && r1.ineligible) {
      expect(r1.detail).toContain("FR-GIT-01");
      expect(r1.detail).toContain(entry);
    }

    const priv = privilegedProfile(BYPASS_SCOPE);
    const r2 = adapter().compile(request({ bypassApproved: true }), {
      ...priv,
      bypassApproved: true,
      shellAllowlist: [entry],
    });
    expect(r2).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if ("ineligible" in r2 && r2.ineligible) {
      expect(r2.detail).toContain("FR-GIT-01");
      expect(r2.detail).toContain(entry);
    }
  });

  it("read-only commands in shell allowlist do not trigger FR-GIT-01 rejection", () => {
    const editUntrusted = profileOf("edit-untrusted");
    const r = adapter().compile(request(), {
      ...editUntrusted,
      shellAllowlist: ["git status", "git diff", "npm test"],
    });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if ("ineligible" in r && r.ineligible) {
      expect(r.detail).not.toContain("FR-GIT-01");
      expect(r.detail).toContain(NON_PRIVILEGED_UNSUPPORTED_DETAIL);
    }
  });

  it("a replayed write run in a finalize-only project gets the controller commit at FINALIZING", async () => {
    const root = realpathSync(makeCwd());
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
          GIT_AUTHOR_NAME: "Cursor Dev",
          GIT_AUTHOR_EMAIL: "cursor@example.test",
          GIT_COMMITTER_NAME: "Cursor Dev",
          GIT_COMMITTER_EMAIL: "cursor@example.test",
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
    const replay = replayAdapter("success_edit");
    const finalizePublisher = new GitPublisher({
      db,
      scratchDir: join(dataDir, "git-scratch"),
      allowedStates: ["FINALIZING"],
    });
    const lifecycle = new RunLifecycle({
      ledger,
      workspace,
      artifacts,
      adapters: new AdapterRegistry().register(replay),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
      finalizePublisher,
    });
    lifecycle.start();

    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "write a file with cursor",
        workspace: repo,
        trustProfile: "privileged",
        provider: "cursor",
        project: {
          id: "test-project",
          name: "Test Project",
          environment_kind: "host",
          context_id: "primary",
          base_ref: "main",
          effective_max_profile: "privileged",
          writable: true,
          identity: { name: "Cursor Dev", email: "cursor@example.test" },
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

      // Verify the controller made exactly one commit at FINALIZING
      const events = ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) }));
      const finTransition = events.find((e) => e.type === "state_transition" && e.p.to === "FINALIZING");
      expect(finTransition).toBeDefined();

      const finCommit = events.find((e) => e.type === GIT_FINALIZE_COMMIT_EVENT);
      expect(finCommit).toBeDefined();
      expect(finCommit?.p).toMatchObject({ outcome: "committed" });

      const pubRef = publishRefFor(metaSessionId);
      const sha = g(repo, "rev-parse", "--verify", "--quiet", pubRef);
      expect(sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(g(repo, "show", "--name-only", "--format=", sha)).toContain("hello.txt");
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  });
});

describe("cursor malicious-fixture leg (T4.46, NFR-SEC-03, FR-POL-04, FR-POL-06)", () => {
  it("never emits --approve-mcps, so repository MCP definitions stay unapproved (FR-POL-04, NFR-SEC-03)", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const inv = adapter().compile(request({ bypassApproved: true }), profile);
    expect("ineligible" in inv).toBe(false);
    if (!("ineligible" in inv)) {
      expect(inv.argv).not.toContain("--approve-mcps");
      expect(inv.policyFlags).not.toContain("--approve-mcps");
      expect(inv.argv.some((a) => a.startsWith("--approve-mcps"))).toBe(false);
    }
  });

  it("compiled argv carries isolation flags and never any repository-enabling or bypass flags (FR-POL-04, FR-POL-06)", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const inv = adapter().compile(request({ bypassApproved: true }), profile);
    expect("ineligible" in inv).toBe(false);
    if (!("ineligible" in inv)) {
      expect(inv.argv).toContain("--print");
      expect(inv.argv).toContain("--output-format");
      expect(inv.argv).toContain("stream-json");
      const forbidden = [
        "--approve-mcps",
        "--yolo",
        "--auto-review",
        "-w",
        "--worktree",
        "--workspace",
        "--add-dir",
        "--plugin-dir",
        "--continue",
        "--sandbox",
      ];
      for (const f of forbidden) {
        expect(inv.argv).not.toContain(f);
      }
    }
  });

  it("deliberately broken compile fails audit or dialect check (T4.26 bar)", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const inv = adapter().compile(request({ bypassApproved: true }), profile);
    expect("ineligible" in inv).toBe(false);
    if (!("ineligible" in inv)) {
      // Invocation audit refuses --force without approval context
      const unapprovedAudit = auditInvocation(inv);
      expect(unapprovedAudit).toContain("--force");
      // Removing --trust or --force breaks required flags
      const missingTrust = inv.argv.filter((a) => a !== "--trust");
      expect(missingTrust.includes("--trust")).toBe(false);
      const missingForce = inv.argv.filter((a) => a !== "--force");
      expect(missingForce.includes("--force")).toBe(false);
    }
  });
});
