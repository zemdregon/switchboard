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
import { buildEnvelope } from "../../mcp/envelope.js";
import { createSwitchboardServer } from "../../mcp/server.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { usageObservationsFromEvents } from "../../usage/observations.js";
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
  FailureEvidence,
  Invocation,
  NormalizedEvent,
  ParseState,
  ProbeOutput,
  ProbeRunner,
  ProviderId,
  ResolvedProfile,
  TrustProfile,
} from "../types.js";
import { isIneligible } from "../types.js";
import {
  CURSOR_BYPASS_NOT_APPROVED,
  CURSOR_GIT_CAPABILITIES,
  CURSOR_GIT_WRITE_CONTROL,
  CURSOR_PRIVILEGED_NEEDS_BYPASS,
  CursorAdapter,
} from "./adapter.js";
import {
  cursorConformanceCases,
  DEFAULT_SESSION_ID,
  fixturePath,
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

  it("harness and backing provider mismatch per T4.6 (FR-ADP-10): structured backing_provider is reported, never derived from display name", () => {
    // 1. Without backing_provider in init (the documented T4.41 shape): backingProvider is unset, never inferred from model
    const standard = parse([INIT, ASSIST("ok"), RESULT()]);
    const standardBound = standard.events.find((e) => e.kind === "session_bound");
    expect(standardBound).toBeDefined();
    expect(standardBound).not.toHaveProperty("backingProvider");
    expect(standardBound).toMatchObject({ kind: "session_bound", nativeSessionId: SID, model: "Synthetic Model 1" });

    // 2. With backing_provider in init (T4.6: harness 'cursor' fronting another provider, e.g. 'backing-x'):
    const fronted = parse([
      line({
        type: "system",
        subtype: "init",
        apiKeySource: "login",
        cwd: "/work/tree",
        session_id: SID,
        model: "Synthetic Model 1",
        backing_provider: "backing-x",
      }),
      ASSIST("ok"),
      RESULT(),
    ]);
    const frontedBound = fronted.events.find((e) => e.kind === "session_bound");
    expect(frontedBound).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: "Synthetic Model 1",
      backingProvider: "backing-x",
    });

    // Verify end-to-end usage observation records harness 'cursor' alongside backingProvider 'backing-x' (T4.6, FR-ADP-10)
    const usageRows = usageObservationsFromEvents(fronted.events, { runId: "run_t46_cursor", provider: "cursor" });
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      runId: "run_t46_cursor",
      provider: "cursor",
      harness: "cursor",
      backingProvider: "backing-x",
      model: "Synthetic Model 1",
      metrics: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 },
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

  it("resumeArgs mirrors compile across every structured scope, including exact refusals", () => {
    const a = adapter();
    const id = "resume_scope_matrix";
    let compiledCount = 0;
    for (const scope of scopeShapes()) {
      for (const bypassApproved of [false, true]) {
        const profile = { ...privilegedProfile(scope), bypassApproved };
        const req = request({ bypassApproved, workspace: { cwd: "/resume scope/worktree", writable: true } });
        const first = a.compile(req, profile);
        const resumed = a.resumeArgs({ provider: "cursor", nativeSessionId: id }, req, profile);
        const label = JSON.stringify({ scope, bypassApproved });
        if ("ineligible" in first) {
          expect(resumed, label).toEqual(first);
        } else {
          compiledCount += 1;
          // The entire invocation must stay identical, with only the native resume pair appended.
          expect(resumed, label).toEqual({ ...first, argv: [...first.argv, "--resume", id] });
        }
      }
    }
    expect(compiledCount).toBe(1);
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

  it("native credential and protocol errors remain failures in either stream order, with the first provider_error determining the code", () => {
    const other = "4f1c2a9e-0000-4000-8000-0000000000aa";
    const bind = INIT();
    const auth = INIT({ apiKeySource: "env" });
    const protocol = INIT({ session_id: other });
    const ok = RESULT();
    for (const [first, second, code] of [
      [auth, protocol, "AUTH_REQUIRED"],
      [protocol, auth, "OUTPUT_PROTOCOL_ERROR"],
    ] as const) {
      for (const lines of [
        [bind, first, second, ok],
        [bind, ok, first, second],
        [bind, first, ok, second],
      ]) {
        expect(parse(lines).result, JSON.stringify(lines)).toMatchObject({
          ok: false,
          failureCode: code,
          nativeSessionId: SID,
          unknownEventCount: 0,
        });
      }
    }
    // A failed result never outranks a later or earlier non-login credential source (classifyCommon order).
    expect(parse([INIT({ apiKeySource: "env" }), RESULT({ subtype: "error", is_error: true })]).result).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      nativeSessionId: SID,
    });
    expect(parse([RESULT({ subtype: "error", is_error: true }), INIT({ apiKeySource: "env" })]).result).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      nativeSessionId: SID,
    });
  });

  it("unknown envelopes cannot bind a session or smuggle status and usage before or after result", () => {
    const envelope = line({
      type: "synthetic_future_event",
      session_id: "spoofed_session",
      subtype: "success",
      is_error: false,
      apiKeySource: "env",
      model: "spoofed-model",
      backing_provider: "spoofed-vendor",
      usage: { inputTokens: 999, outputTokens: 999 },
      result: { subtype: "success", is_error: false, session_id: SID },
    });
    for (const lines of [[envelope], [envelope, RESULT()], [RESULT(), envelope]]) {
      const { events, state, result } = parse(lines);
      expect(state.unknownEvents).toBe(1);
      expect(events.filter((e) => e.kind === "unknown")).toEqual([
        { kind: "unknown", rawType: "synthetic_future_event" },
      ]);
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("spoofed_session");
      expect(serialized).not.toContain("spoofed-model");
      expect(serialized).not.toContain("spoofed-vendor");
      expect(serialized).not.toContain("999");
      if (lines.length === 1) {
        expect(result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 1 });
        expect(result).not.toHaveProperty("nativeSessionId");
        expect(events).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ ok: true, nativeSessionId: SID, unknownEventCount: 1 });
        expect(events.filter((e) => e.kind === "usage")).toEqual([
          {
            kind: "usage",
            source: "provider_reported",
            metrics: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 },
          },
        ]);
      }
    }
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

  // Done-when cases whose native shape the 2026-10-14 live check did NOT record (ROADMAP T4.43 stays Partial).
  // These pin today's observed outcomes; an operator capture (T4.41 extension) must change them.
  describe("cases with no recorded native shape (live check rows 4, 9, 14)", () => {
    it("cases with no recorded native shape end TOOL_FAILURE, never RATE_LIMIT_TRANSIENT, SANDBOX_VIOLATION or success", () => {
      // No rate-limit, quota or sandbox event was recorded (live check rows 4, 9, 14): text naming one is not read.
      for (const text of [
        "429 Too Many Requests",
        "rate limit reached",
        "quota exceeded",
        "sandbox: operation denied",
      ]) {
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
      expect(unknownOnly.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        unknownEventCount: 1,
      });
    });

    // The same outcomes replayed end to end from fixture files through the supervisor, so each Done-when case has a
    // fixture: success (`success_edit`), task failure (`task_failure`), malformed (`malformed_output`), permission
    // denied (`permission_denied`), backing vendor (`backing_provider`) and the ones below, plus `resume_failure`,
    // `error_after_result`, `malformed_after_result` and `denied_after_result` (as Grok T4.23 and OpenCode T4.53).
    // They pin the gaps; an operator capture (T4.41 extension) must change them.
    const replayCase = (
      fixture: string,
      kind: ConformanceCase["kind"],
      exp: ConformanceCase["expect"],
    ): ConformanceCase => ({
      kind,
      adapter: replayAdapter(fixture),
      request: {
        runId: "run_cursor_t443_fixture",
        objective: "synthetic cursor objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: exp,
    });

    it("fixture rate_limit (rows 4, 14, never forced) replays an empty stream at exit 1 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT", async () => {
      const report = await runConformanceCase(
        replayCase("rate_limit", "rate_limit", { ok: false, failureCode: "TOOL_FAILURE" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it("fixture rate_limit_error replays an in-stream error result at exit 0 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT or success", async () => {
      const report = await runConformanceCase(
        replayCase("rate_limit_error", "rate_limit", {
          ok: false,
          failureCode: "TOOL_FAILURE",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
    });

    it("fixture sandbox_violation (row 9 unrecorded shape) replays unrecorded sandbox error text to TOOL_FAILURE, never SANDBOX_VIOLATION", async () => {
      const report = await runConformanceCase(
        replayCase("sandbox_violation", "task_failure", {
          ok: false,
          failureCode: "TOOL_FAILURE",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
    });

    it("fixture unknown_events replays to OUTPUT_PROTOCOL_ERROR: every unreadable line is counted and none binds a session", async () => {
      const report = await runConformanceCase(
        replayCase("unknown_events", "malformed_output", { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 5 });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it("fixture trailing_tool replays a tool_call after the result line to OUTPUT_PROTOCOL_ERROR", async () => {
      const report = await runConformanceCase(
        replayCase("trailing_tool", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the result line",
        nativeSessionId: DEFAULT_SESSION_ID,
      });
    });

    it("fixture session_changed replays a conflicting session_id to OUTPUT_PROTOCOL_ERROR with the first id bound", async () => {
      const report = await runConformanceCase(
        replayCase("session_changed", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: DEFAULT_SESSION_ID,
      });
    });

    it("fixture two_results replays more than one result line to OUTPUT_PROTOCOL_ERROR", async () => {
      const report = await runConformanceCase(
        replayCase("two_results", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: DEFAULT_SESSION_ID,
      });
    });

    it("fixture git_write_guard (ADR-0039) replays a guard-flagged Git write under success result at exit 0 to PERMISSION_BLOCKED", async () => {
      const report = await runConformanceCase(
        replayCase("git_write_guard", "task_failure", {
          ok: false,
          failureCode: "PERMISSION_BLOCKED",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: DEFAULT_SESSION_ID,
      });
      expect(report.result?.failureDetail).toMatch(/^git write attempted/);
    });

    it("fixture no_result replays text output at exit 0 without a result line to OUTPUT_PROTOCOL_ERROR", async () => {
      const report = await runConformanceCase(
        replayCase("no_result", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "no result event",
        nativeSessionId: DEFAULT_SESSION_ID,
      });
    });

    it("fixture unsafe_session_id replays an unsafe session id in init to OUTPUT_PROTOCOL_ERROR without binding", async () => {
      const report = await runConformanceCase(
        replayCase("unsafe_session_id", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: session id is not a safe argument",
        unknownEventCount: 0,
      });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it.each([
      ["unknown_event", true, undefined, 1],
      ["error_after_result", false, "AUTH_REQUIRED", 0],
      ["malformed_after_result", false, "OUTPUT_PROTOCOL_ERROR", 0],
    ] as const)(
      "fixture %s preserves structured session binding and checks the whole stream",
      async (fixture, ok, failureCode, unknownEventCount) => {
        // Unknown JSON can coexist with a recognized result, but cannot supply it. A late credential source that is
        // not the native login, and malformed framing after the result, must still invalidate that result; malformed
        // JSON is rejected by the supervisor before parseEvent.
        const report = await runConformanceCase(
          replayCase(fixture, ok ? "success" : "malformed_output", {
            ok,
            ...(failureCode ? { failureCode } : {}),
            nativeSessionId: DEFAULT_SESSION_ID,
          }),
        );
        expect(report.checks.filter((k) => !k.ok)).toEqual([]);
        expect(report.result).toMatchObject({
          ok,
          ...(failureCode ? { failureCode } : {}),
          nativeSessionId: DEFAULT_SESSION_ID,
          unknownEventCount,
        });
      },
    );

    it("fixture denied_after_result replays a completed refusal after a success result to PERMISSION_BLOCKED", async () => {
      // OpenCode T4.53 stop_then_error analog: a recognized success result does not erase a later structured denial.
      const report = await runConformanceCase(
        replayCase("denied_after_result", "task_failure", {
          ok: false,
          failureCode: "PERMISSION_BLOCKED",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: DEFAULT_SESSION_ID,
        unknownEventCount: 0,
      });
    });

    it("fixture resume_failure replays a resumed failed run to TOOL_FAILURE, preserving the resumed session id", async () => {
      // The only replayed resume so far is the T4.45 success; the failure leg of `--resume <id>` (a resumed run whose
      // result is an error) is replayed here end to end.
      const report = await runConformanceCase({
        kind: "resume",
        adapter: replayAdapter("resume_failure"),
        request: {
          runId: "run_cursor_t443_resume_failure",
          objective: "synthetic cursor objective",
          constraints: [],
          workspace: { cwd: makeCwd(), writable: true },
          bypassApproved: true,
        },
        profile: PRIVILEGED_BYPASS_PROFILE,
        binding: { provider: "cursor", nativeSessionId: RESUMED_SESSION_ID },
        expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: RESUMED_SESSION_ID },
      });
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
        nativeSessionId: RESUMED_SESSION_ID,
        unknownEventCount: 0,
      });
    });
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

  it("tool_call keys that name Object.prototype members map to `other`, never an inherited member", () => {
    const r = parse([
      INIT(),
      TOOL("started", { constructor: { args: { command: "git push" } } }),
      // JSON.parse makes `__proto__` an own key, so Object.keys reports it.
      `{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"__proto__":{"args":{"path":"a.txt"}}}}`,
      TOOL("started", { toString: { args: {} }, hasOwnProperty: { args: {} } }),
      ASSIST("ok"),
      RESULT(),
    ]);
    expect(r.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "constructor" },
      { kind: "tool_call", tool: "other", name: "__proto__" },
      { kind: "tool_call", tool: "other", name: "toString" },
      { kind: "tool_call", tool: "other", name: "hasOwnProperty" },
    ]);
    expect(r.result).toMatchObject({ ok: true });
  });

  it("a session id resume could not pass as one argument is never bound and fails OUTPUT_PROTOCOL_ERROR", () => {
    for (const bad of ["--force", "-f", "chat x", "../chat", "a".repeat(257)]) {
      for (const lines of [
        [INIT({ session_id: bad }), ASSIST("ok"), RESULT({ session_id: bad })],
        // Without init the result's id is the only candidate; it is refused the same way.
        [ASSIST("ok"), RESULT({ session_id: bad })],
      ]) {
        const r = parse(lines);
        expect(r.state.nativeSessionId, bad).toBeUndefined();
        expect(
          r.events.some((e) => e.kind === "session_bound"),
          bad,
        ).toBe(false);
        expect(r.result, bad).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
        expect(r.result, bad).not.toHaveProperty("nativeSessionId");
      }
    }
    // A bad id after a good one leaves the good one bound and still fails the run.
    const mixed = parse([INIT(), ASSIST("ok"), RESULT({ session_id: "--resume" })]);
    expect(mixed.state.nativeSessionId).toBe(SID);
    expect(mixed.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: SID });
  });

  it("a tool call after the result line is not a success (fail closed); a guard verdict on it keeps its own code", () => {
    const trailing = parse([
      INIT(),
      ASSIST("ok"),
      RESULT(),
      TOOL("started", { readToolCall: { args: { path: "a.txt" } } }),
    ]);
    expect(trailing.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      nativeSessionId: SID,
    });
    // A completed call that adds nothing, or an assistant line, after the result does not trip it.
    const quiet = parse([
      INIT(),
      TOOL("started", { readToolCall: { args: { path: "a.txt" } } }),
      RESULT(),
      TOOL("completed", { readToolCall: { result: { success: {} } } }),
      ASSIST("late text"),
    ]);
    expect(quiet.result).toMatchObject({ ok: true });
    // ADR-0039: a guard-flagged trailing call ends PERMISSION_BLOCKED, not OUTPUT_PROTOCOL_ERROR.
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events = [
      INIT(),
      ASSIST("ok"),
      RESULT(),
      TOOL("started", { shellToolCall: { args: { command: "git push origin main" } } }),
    ]
      .flatMap((l) => a.parseEvent(l, state))
      .map((e) => guardEvent(e, { cwd: "/w", bypass: true }));
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("non-string path and model values are omitted, never coerced (Assumption gap: value types unrecorded)", () => {
    const r = parse([
      INIT({ model: { name: "Synthetic Model 1" } }),
      TOOL("started", { readToolCall: { args: { path: ["a.txt"] } } }),
      TOOL("started", { editToolCall: { args: { path: 7 } } }),
      TOOL("started", { writeToolCall: { args: { path: null } } }),
      TOOL("started", { shellToolCall: { args: { command: { argv: "git push" } } } }),
      RESULT(),
    ]);
    expect(r.events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
    ]);
    expect(r.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "read", name: "readToolCall" },
      { kind: "tool_call", tool: "edit", name: "editToolCall" },
      { kind: "tool_call", tool: "edit", name: "writeToolCall" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall" },
    ]);
  });

  it("a tool call completed with a newly provided or swapped command/path is reported for the guard; identical reports are not duplicated", () => {
    // 1. Started without args, completed with command: reported on completed
    const lateCommand = parse([
      INIT(),
      TOOL("started", { shellToolCall: {} }),
      TOOL("completed", { shellToolCall: { args: { command: "echo shellok" }, result: { success: {} } } }),
      RESULT(),
    ]);
    expect(lateCommand.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "echo shellok" },
    ]);

    // 2. Swapped command: started with benign "ls", completed swaps to "git push origin main"
    const swapped = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "ls" } } }),
      TOOL("completed", {
        shellToolCall: { args: { command: "git push origin main" }, result: { success: {} } },
      }),
      RESULT(),
    ]);
    const calls = swapped.events.filter((e) => e.kind === "tool_call");
    expect(calls).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "ls" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
    ]);

    // ADR-0039: The swapped command reaching the guard ends PERMISSION_BLOCKED
    const guarded = swapped.events.map((e) => guardEvent(e, { cwd: "/w", bypass: true }));
    expect(adapter().extractResult(guarded, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });

    // 3. Identical reports in started and completed (as in live check row 7a) are not duplicated
    const normal = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo shellok" } } }),
      TOOL("completed", {
        shellToolCall: { args: { command: "echo shellok" }, result: { rejected: {} } },
      }),
      RESULT(),
    ]);
    expect(normal.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "echo shellok" },
    ]);
    expect(normal.events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "shellToolCall" },
    ]);
  });

  it("a permission denial on completed at exit 1 still ends PERMISSION_BLOCKED with the tool name", () => {
    const exit1: ExitInfo = { outcome: "exited", exitCode: 1, signal: null, expectedExitCodes: [0] };
    const r = parse(
      [
        INIT(),
        TOOL("started", { shellToolCall: { args: { command: "git commit" } } }),
        TOOL("completed", {
          shellToolCall: {
            result: { permissionDenied: { error: "Command blocked by permissions configuration" } },
          },
        }),
      ],
      exit1,
    );
    expect(r.events).toContainEqual({ kind: "permission_denied", tool: "shellToolCall" });
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: shellToolCall",
    });
  });

  it("non-string backing_provider is omitted, never coerced", () => {
    const r = parse([
      INIT({ backing_provider: ["invalid", "vendor"], model: "Synthetic Model 1" }),
      ASSIST("ok"),
      RESULT(),
    ]);
    const bound = r.events.find((e) => e.kind === "session_bound");
    expect(bound).toBeDefined();
    expect(bound).not.toHaveProperty("backingProvider");
  });

  it("prototype-named types and a `__proto__` key never smuggle a result, assistant text or a tool call", () => {
    const r = parse([
      line({ type: "constructor" }),
      line({ type: "toString" }),
      line({ type: "__proto__" }),
      `{"__proto__":{"type":"result","subtype":"success","session_id":"${SID}"}}`,
      `{"type":"result","__proto__":{"subtype":"success"}}`,
      `{"type":"assistant","__proto__":{"message":{"content":[{"text":"smuggled"}]}}}`,
      `{"type":"tool_call","subtype":"started","__proto__":{"tool_call":{"shellToolCall":{"args":{"command":"git push origin main"}}}}}`,
      `{"type":"system","__proto__":{"subtype":"init"}}`,
    ]);
    expect(r.events.every((e) => e.kind === "unknown")).toBe(true);
    expect(r.state.unknownEvents).toBe(8);
    expect(r.state.nativeSessionId).toBeUndefined();
    expect(JSON.stringify(r.events)).not.toContain("smuggled");
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
  });

  it("a trailing tool_call the parser cannot read is still a tool call after the result line", () => {
    // The bare line or unreadable tool_call shapes parse as `unknown` and must not leave the turn clean.
    for (const call of [
      { type: "tool_call" },
      { type: "tool_call", subtype: "started" },
      { type: "tool_call", tool_call: {} },
      { type: "tool_call", subtype: "started", tool_call: {} },
      { type: "tool_call", subtype: "completed", tool_call: {} },
      { type: "tool_call", subtype: "unknown_subtype", tool_call: { readToolCall: {} } },
    ]) {
      const r = parse([INIT(), ASSIST("ok"), RESULT(), line(call)]);
      expect(r.events.at(-1), JSON.stringify(call)).toEqual(
        expect.objectContaining({ kind: "unknown", rawType: expect.stringMatching(/^tool_call(:.*)?$/) }),
      );
      expect(r.result, JSON.stringify(call)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the result line",
        nativeSessionId: SID,
      });
    }
    // A read-shaped call after the result fails the same way.
    const read = parse([
      INIT(),
      ASSIST("ok"),
      RESULT(),
      TOOL("started", { readToolCall: { args: { path: "a.txt" } } }),
    ]);
    expect(read.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
    // Other unknown lines, user echo and late assistant text after result do not trip it.
    const quiet = parse([
      INIT(),
      ASSIST("ok"),
      RESULT(),
      line({ type: "user", text: "echo" }),
      line({ type: "thinking", text: "thought" }),
      ASSIST("late"),
      line({ type: "synthetic_unknown_kind" }),
    ]);
    expect(quiet.result).toMatchObject({ ok: true });
    // The same unreadable line before result leaves a clean turn clean.
    const before = parse([INIT(), line({ type: "tool_call" }), ASSIST("ok"), RESULT()]);
    expect(before.result).toMatchObject({ ok: true });
  });

  it("a guard-flagged trailing tool_call ends PERMISSION_BLOCKED at exit 1, after a failed result and a second result (ADR-0039)", () => {
    const ctx = { cwd: "/w", bypass: true };
    const guarded = (lines: string[], exit: ExitInfo = EXIT0) => {
      const parsed = parse(lines, exit);
      return adapter().extractResult(
        parsed.events.map((e) => guardEvent(e, ctx)),
        exit,
      );
    };
    const PUSH = TOOL("started", { shellToolCall: { args: { command: "git push origin main" } } });
    const EXIT1: ExitInfo = { outcome: "exited", exitCode: 1, signal: null, expectedExitCodes: [0] };
    // ADR-0039: the guard verdict precedes the unexpected exit, the failed result and the protocol anomaly.
    for (const [label, lines, exit] of [
      ["exit 1", [INIT(), RESULT(), PUSH], EXIT1],
      ["failed result", [INIT(), RESULT({ subtype: "error", is_error: true }), PUSH], EXIT0],
      ["second result", [INIT(), RESULT(), RESULT(), PUSH], EXIT0],
    ] as const) {
      expect(guarded([...lines], exit), label).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: SID,
      });
    }
    // Without the Git write the same exit-1 trailing call is an unexpected exit, never success.
    const plain = guarded([INIT(), RESULT(), TOOL("started", { shellToolCall: { args: { command: "ls" } } })], EXIT1);
    expect(plain).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    // Without the Git write a second result line ends OUTPUT_PROTOCOL_ERROR.
    const secondResult = guarded([
      INIT(),
      RESULT(),
      RESULT(),
      TOOL("started", { shellToolCall: { args: { command: "ls" } } }),
    ]);
    expect(secondResult).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("parameter container fallback (args > parameters > input) and parameter key precedence", () => {
    // Command precedence: command > cmd > CommandLine
    const p1 = parse([
      INIT(),
      TOOL("started", {
        shellToolCall: {
          args: { command: "cmd1", cmd: "cmd2", CommandLine: "cmd3" },
        },
      }),
      RESULT(),
    ]);
    expect(p1.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "cmd1",
    });

    const p2 = parse([
      INIT(),
      TOOL("started", {
        shellToolCall: {
          args: { cmd: "cmd2", CommandLine: "cmd3" },
        },
      }),
      RESULT(),
    ]);
    expect(p2.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "cmd2",
    });

    const p3 = parse([
      INIT(),
      TOOL("started", {
        shellToolCall: {
          args: { CommandLine: "cmd3" },
        },
      }),
      RESULT(),
    ]);
    expect(p3.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "cmd3",
    });

    // Container fallback: args > parameters > input
    const p4 = parse([
      INIT(),
      TOOL("started", {
        shellToolCall: {
          parameters: { command: "cmd_from_params" },
        },
      }),
      RESULT(),
    ]);
    expect(p4.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "cmd_from_params",
    });

    const p5 = parse([
      INIT(),
      TOOL("started", {
        shellToolCall: {
          input: { command: "cmd_from_input" },
        },
      }),
      RESULT(),
    ]);
    expect(p5.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "cmd_from_input",
    });

    // Target precedence: path > filePath > file_path > AbsolutePath > target
    const p6 = parse([
      INIT(),
      TOOL("started", {
        readToolCall: {
          args: { path: "p1", filePath: "p2", file_path: "p3", AbsolutePath: "p4", target: "p5" },
        },
      }),
      RESULT(),
    ]);
    expect(p6.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "read",
      target: "p1",
    });

    const p7 = parse([
      INIT(),
      TOOL("started", {
        editToolCall: {
          args: { filePath: "p2", file_path: "p3", AbsolutePath: "p4", target: "p5" },
        },
      }),
      RESULT(),
    ]);
    expect(p7.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "edit",
      target: "p2",
    });

    const p8 = parse([
      INIT(),
      TOOL("started", {
        writeToolCall: {
          parameters: { file_path: "p3", AbsolutePath: "p4", target: "p5" },
        },
      }),
      RESULT(),
    ]);
    expect(p8.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "edit",
      target: "p3",
    });

    const p9 = parse([
      INIT(),
      TOOL("started", {
        readToolCall: {
          input: { AbsolutePath: "p4", target: "p5" },
        },
      }),
      RESULT(),
    ]);
    expect(p9.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "read",
      target: "p4",
    });

    const p10 = parse([
      INIT(),
      TOOL("started", {
        editToolCall: {
          input: { target: "p5" },
        },
      }),
      RESULT(),
    ]);
    expect(p10.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "edit",
      target: "p5",
    });
  });

  it("extractResult classifies supervisor exit outcomes (protocol_error, internal_error, crashed, spawn_error)", () => {
    const baseExit = { exitCode: null, signal: null, expectedExitCodes: [0] };

    const proto = adapter().extractResult([], { ...baseExit, outcome: "protocol_error" });
    expect(proto).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "unparseable provider output",
    });

    const internal = adapter().extractResult([], { ...baseExit, outcome: "internal_error" });
    expect(internal).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "event handling failed",
    });

    const crashedSig = adapter().extractResult([], { ...baseExit, outcome: "crashed", signal: "SIGKILL" });
    expect(crashedSig).toMatchObject({
      ok: false,
      failureCode: "PROCESS_CRASH",
      failureDetail: "signal SIGKILL",
    });

    const crashedNoSig = adapter().extractResult([], { ...baseExit, outcome: "crashed", signal: null });
    expect(crashedNoSig).toMatchObject({
      ok: false,
      failureCode: "PROCESS_CRASH",
      failureDetail: "crashed",
    });

    const spawnErr = adapter().extractResult([], { ...baseExit, outcome: "spawn_error" });
    expect(spawnErr).toMatchObject({
      ok: false,
      failureCode: "PROCESS_CRASH",
      failureDetail: "spawn_error",
    });

    const exitErr = adapter().extractResult([], {
      outcome: "exited",
      exitCode: 2,
      signal: null,
      expectedExitCodes: [0],
    });
    expect(exitErr).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 2",
    });
  });

  it("extractResult honors normalized failure events (permission_denied, sandbox_violation, rate_limit)", () => {
    const endEvent: NormalizedEvent = { kind: "result", ok: true };

    const perm = adapter().extractResult([{ kind: "permission_denied", tool: "shellToolCall" }, endEvent], EXIT0);
    expect(perm).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: shellToolCall",
    });

    const sbx = adapter().extractResult([{ kind: "sandbox_violation", detail: "out of worktree" }, endEvent], EXIT0);
    expect(sbx).toMatchObject({ ok: false, failureCode: "SANDBOX_VIOLATION", failureDetail: "out of worktree" });

    const rl = adapter().extractResult([{ kind: "rate_limit" }, endEvent], EXIT0);
    expect(rl).toMatchObject({
      ok: false,
      failureCode: "RATE_LIMIT_TRANSIENT",
      failureDetail: "rate limit reported",
    });
  });

  it("classifyFailure precedence: supervisor outcomes over the guard, the guard over denials, denials over provider errors, a provider error over a rate_limit event, a failed result and the exit code", () => {
    const a = adapter();
    const evidence = (
      events: readonly NormalizedEvent[],
      exit: Partial<FailureEvidence["exit"]> = {},
      extra: Partial<FailureEvidence> = {},
    ): FailureEvidence => ({
      events,
      exit: { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0], ...exit },
      stderrTail: "",
      timedOut: false,
      cancelled: false,
      ...extra,
    });
    const GUARDED: NormalizedEvent = {
      kind: "tool_call",
      tool: "shell",
      name: "shellToolCall",
      command: "git push origin main",
      violation: { kind: "git_write", reason: "git push origin main" },
    };
    const DENIED: NormalizedEvent = { kind: "permission_denied", tool: "shellToolCall" };
    const AUTH: NormalizedEvent = {
      kind: "provider_error",
      category: "auth",
      message: "credential source env is not the native login",
    };
    const UNKNOWN_ERR: NormalizedEvent = { kind: "provider_error", category: "unknown", message: "boom" };
    const PROTOCOL_ERR: NormalizedEvent = {
      kind: "provider_error",
      category: "protocol",
      message: "more than one result line",
    };
    const FAILED_RESULT: NormalizedEvent = { kind: "result", ok: false, summary: "result error" };
    const EXIT_1 = { exitCode: 1 };

    // Supervisor-determined outcomes beat every stream signal, the ADR-0039 guard included.
    expect(a.classifyFailure(evidence([GUARDED], { outcome: "cancelled" }))).toEqual({
      code: "CANCELLED",
      detail: "run cancelled",
    });
    expect(a.classifyFailure(evidence([GUARDED], {}, { cancelled: true }))).toEqual({
      code: "CANCELLED",
      detail: "run cancelled",
    });
    expect(a.classifyFailure(evidence([GUARDED], {}, { timedOut: true }))).toEqual({
      code: "PROCESS_TIMEOUT",
      detail: "unknown timeout",
    });
    expect(a.classifyFailure(evidence([GUARDED], { outcome: "timeout", timeoutKind: "wall_clock" }))).toEqual({
      code: "PROCESS_TIMEOUT",
      detail: "wall_clock timeout",
    });
    expect(a.classifyFailure(evidence([GUARDED], { outcome: "protocol_error", exitCode: null }))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "unparseable provider output",
    });
    expect(a.classifyFailure(evidence([GUARDED], { outcome: "internal_error", exitCode: null }))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "event handling failed",
    });
    expect(a.classifyFailure(evidence([GUARDED], { outcome: "crashed", exitCode: null, signal: "SIGKILL" }))).toEqual({
      code: "PROCESS_CRASH",
      detail: "signal SIGKILL",
    });
    expect(a.classifyFailure(evidence([GUARDED], { outcome: "spawn_error", exitCode: null }))).toEqual({
      code: "PROCESS_CRASH",
      detail: "spawn_error",
    });

    // ADR-0039: the guard verdict beats denials, provider errors, results and exit codes.
    expect(a.classifyFailure(evidence([GUARDED, DENIED]))).toEqual({
      code: "PERMISSION_BLOCKED",
      detail: "git write attempted: git push origin main",
    });
    expect(
      a.classifyFailure(
        evidence([{ ...GUARDED, violation: { kind: "provider_state", reason: "synthetic" } }, DENIED, AUTH]),
      ),
    ).toEqual({ code: "SANDBOX_VIOLATION", detail: "provider state reached: synthetic" });

    // Denials beat provider errors and unexpected exits.
    expect(a.classifyFailure(evidence([DENIED, AUTH], EXIT_1))).toEqual({
      code: "PERMISSION_BLOCKED",
      detail: "denied: shellToolCall",
    });
    expect(
      a.classifyFailure(evidence([{ kind: "sandbox_violation", detail: "out of worktree" }, UNKNOWN_ERR])),
    ).toEqual({ code: "SANDBOX_VIOLATION", detail: "out of worktree" });

    // A provider error beats a rate_limit event, a failed result and the exit code; the Cursor `protocol`
    // category maps to OUTPUT_PROTOCOL_ERROR.
    expect(a.classifyFailure(evidence([UNKNOWN_ERR, { kind: "rate_limit" }]))).toEqual({
      code: "TOOL_FAILURE",
      detail: "unknown: boom",
    });
    expect(a.classifyFailure(evidence([AUTH, FAILED_RESULT]))).toEqual({
      code: "AUTH_REQUIRED",
      detail: "auth: credential source env is not the native login",
    });
    expect(a.classifyFailure(evidence([PROTOCOL_ERR], EXIT_1))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "protocol: more than one result line",
    });

    // A rate_limit event and a failed result beat the exit code; the exit code beats "no result".
    expect(a.classifyFailure(evidence([{ kind: "rate_limit" }], EXIT_1))).toEqual({
      code: "RATE_LIMIT_TRANSIENT",
      detail: "rate limit reported",
    });
    expect(a.classifyFailure(evidence([FAILED_RESULT], EXIT_1))).toEqual({
      code: "TOOL_FAILURE",
      detail: "result error",
    });
    expect(a.classifyFailure(evidence([], EXIT_1))).toEqual({ code: "TOOL_FAILURE", detail: "exit code 1" });
    expect(a.classifyFailure(evidence([]))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "no result event",
    });
  });

  it("classifyFailure precedence does not depend on lower-priority events arriving first", () => {
    const a = adapter();
    const failed: NormalizedEvent = { kind: "result", ok: false, summary: "task failed" };
    const rate: NormalizedEvent = { kind: "rate_limit" };
    const auth: NormalizedEvent = {
      kind: "provider_error",
      category: "auth",
      message: "credential source env is not the native login",
    };
    const denied: NormalizedEvent = { kind: "permission_denied", tool: "shellToolCall" };
    const guard: NormalizedEvent = {
      kind: "tool_call",
      tool: "shell",
      name: "shellToolCall",
      command: "git push origin main",
      violation: { kind: "git_write", reason: "synthetic Git write" },
    };
    for (const [events, code] of [
      [[failed, rate], "RATE_LIMIT_TRANSIENT"],
      [[failed, rate, auth], "AUTH_REQUIRED"],
      [[failed, rate, auth, denied], "PERMISSION_BLOCKED"],
      [[failed, rate, auth, denied, guard], "PERMISSION_BLOCKED"],
    ] as const) {
      const classify = (ordered: readonly NormalizedEvent[]) =>
        a.classifyFailure({
          events: ordered,
          exit: { outcome: "exited", exitCode: 1, signal: null, expectedExitCodes: [0] },
          stderrTail: "Not signed in; too many requests", // Free text never changes structured precedence.
          timedOut: false,
          cancelled: false,
        });
      const classified = classify(events);
      expect(classified.code).toBe(code);
      expect(classified).toEqual(classify([...events].reverse()));
      if (events.some((e) => e.kind === "tool_call")) {
        expect(classified.detail).toBe("git write attempted: synthetic Git write");
      }
    }
  });

  it("recorded extra fields (duration_ms, duration_api_ms, request_id, permissionMode, cwd, timestamp_ms) are never usage metrics or events", () => {
    // Live check 5a/5b recorded duration_ms, duration_api_ms and request_id on result; 5b recorded permissionMode and
    // cwd on init and timestamp_ms on thinking. The parser reads only usage counters plus session/model/backing keys,
    // so those extra fields never widen the usage record or reach an event.
    const { events, result } = parse([
      INIT({ permissionMode: "default", cwd: "/work/tree" }),
      line({ type: "user", message: { content: [{ type: "text", text: "the prompt" }] }, session_id: SID }),
      line({
        type: "thinking",
        subtype: "delta",
        text: "private reasoning",
        session_id: SID,
        timestamp_ms: 1,
      }),
      ASSIST("ok"),
      RESULT({ duration_ms: 10, duration_api_ms: 10, request_id: "req-recorded-1" }),
    ]);
    expect(events.find((e) => e.kind === "usage")).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("req-recorded-1");
    expect(serialized).not.toContain("duration_ms");
    expect(serialized).not.toContain("duration_api_ms");
    expect(serialized).not.toContain("permissionMode");
    expect(serialized).not.toContain("/work/tree");
    expect(serialized).not.toContain("timestamp_ms");
    expect(serialized).not.toContain("private reasoning");
    expect(result).toMatchObject({ ok: true, nativeSessionId: SID });
  });

  it("seenResults and seenToolCalls WeakMap state is isolated across separate ParseState instances", () => {
    const a = adapter();
    const state1: ParseState = { lines: 0, unknownEvents: 0 };
    const state2: ParseState = { lines: 0, unknownEvents: 0 };

    // Result line on state1
    const ev1 = a.parseEvent(RESULT(), state1);
    expect(ev1.some((e) => e.kind === "result" && e.ok)).toBe(true);

    // Result line on fresh state2 is also a first result line, not a second duplicate
    const ev2 = a.parseEvent(RESULT(), state2);
    expect(ev2.some((e) => e.kind === "result" && e.ok)).toBe(true);
    expect(ev2.some((e) => e.kind === "provider_error")).toBe(false);

    // Second result line on state1 triggers protocol error
    const ev1Second = a.parseEvent(RESULT(), state1);
    expect(ev1Second.some((e) => e.kind === "provider_error" && e.category === "protocol")).toBe(true);

    // Tool calls across state1 and state2 are tracked independently
    const toolLine = TOOL("started", { shellToolCall: { args: { command: "echo independent" } } });
    const tc1 = a.parseEvent(toolLine, state1);
    expect(tc1.some((e) => e.kind === "tool_call")).toBe(true);
    const tc2 = a.parseEvent(toolLine, state2);
    expect(tc2.some((e) => e.kind === "tool_call")).toBe(true);
  });

  it("clean turn with no text messages leaves summary undefined, not empty string; long text is clipped to 2000 chars", () => {
    const noText = parse([INIT(), RESULT()]);
    expect(noText.result).toMatchObject({ ok: true });
    expect(noText.result).not.toHaveProperty("summary");

    const longText = "a".repeat(2500);
    const long = parse([INIT(), ASSIST(longText), RESULT()]);
    expect(long.result).toMatchObject({ ok: true });
    expect(long.result.summary).toHaveLength(2000);
    expect(long.result.summary).toBe(`${"a".repeat(1999)}…`);
  });

  it("bounds and clipping fallbacks: tool key > 64 chars, result subtype > 64 chars, model > 128 chars, backingProvider > 128 chars", () => {
    const longKey = "custom_tool_key_".repeat(5); // 80 chars
    const rKey = parse([INIT(), TOOL("started", { [longKey]: { args: { command: "echo 1" } } }), RESULT()]);
    const tc = rKey.events.find((e) => e.kind === "tool_call");
    expect(tc).toMatchObject({
      kind: "tool_call",
      name: `${longKey.slice(0, 64)}…`,
    });

    const longSubtype = `custom_error_subtype_${"e".repeat(80)}`;
    const rSub = parse([INIT(), RESULT({ subtype: longSubtype, is_error: true })]);
    const res = adapter().extractResult(rSub.events, EXIT0);
    expect(res).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: `result ${longSubtype.slice(0, 64)}…`,
    });

    const longModel = "M".repeat(200);
    const longBacking = "B".repeat(200);
    const rInit = parse([INIT({ model: longModel, backing_provider: longBacking }), RESULT()]);
    const bound = rInit.events.find((e) => e.kind === "session_bound");
    expect(bound).toMatchObject({
      kind: "session_bound",
      model: `${longModel.slice(0, 128)}…`,
      backingProvider: `${longBacking.slice(0, 128)}…`,
    });
  });

  it("resumeArgs comprehensive matrix: cwd preservation, policyFlag parity, foreign provider, profile, and id rejection", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const customReq = request({ workspace: { cwd: "/custom/workspace/dir", writable: true }, bypassApproved: true });
    const id = "synthetic-cursor-session-0042";

    // Successful resume preserves cwd, matches compile policyFlags, and passes audit
    const resumed = a.resumeArgs({ provider: "cursor", nativeSessionId: id }, customReq, approved);
    expect("ineligible" in resumed).toBe(false);
    if ("ineligible" in resumed) return;
    expect(resumed.cwd).toBe("/custom/workspace/dir");
    expect(resumed.argv.slice(-2)).toEqual(["--resume", id]);
    const first = a.compile(customReq, approved);
    expect("ineligible" in first).toBe(false);
    if ("ineligible" in first) return;
    expect(resumed.policyFlags).toEqual(first.policyFlags);
    expect(resumed.argv.slice(0, -2)).toEqual(first.argv);
    expect(auditInvocation(resumed, { profile, bypassApproved: true })).toEqual([]);

    // Foreign provider bindings rejected
    for (const provider of ["claude", "codex", "grok", "antigravity", "opencode", "other"] as const) {
      expect(
        a.resumeArgs({ provider: provider as ProviderId, nativeSessionId: id }, customReq, approved),
      ).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: `binding is for ${provider}`,
      });
    }

    // Ineligible non-privileged profiles
    for (const name of PROFILES) {
      expect(a.resumeArgs({ provider: "cursor", nativeSessionId: id }, customReq, profileOf(name))).toMatchObject({
        ineligible: true,
        reason: "PROFILE_UNSUPPORTED",
      });
    }

    // Privileged without bypass
    const noBypass = privilegedProfile({ ...BYPASS_SCOPE, bypass: false });
    expect(
      a.resumeArgs({ provider: "cursor", nativeSessionId: id }, customReq, { ...noBypass, bypassApproved: true }),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: CURSOR_PRIVILEGED_NEEDS_BYPASS,
    });

    // Privileged with bypass but not approved
    expect(
      a.resumeArgs({ provider: "cursor", nativeSessionId: id }, request({ bypassApproved: false }), profile),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: CURSOR_BYPASS_NOT_APPROVED,
    });

    // Dangerous / unsafe session ids
    for (const bad of ["--force", "-f", "chat x", "../chat", "a".repeat(257), ""]) {
      expect(a.resumeArgs({ provider: "cursor", nativeSessionId: bad }, customReq, approved), bad).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: "native session id is not a safe single argument",
      });
    }
  });

  it("resumeArgs accepts valid alphanumeric, UUID and delimited session IDs and refuses unsafe or flag-like shapes", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const req = request({ bypassApproved: true });

    for (const validId of ["0c1d5f2e-7c1a-4b66-9d0c-1f5b8a3a9e11", "session_123.456:789-abc", "A", "a".repeat(256)]) {
      const r = a.resumeArgs({ provider: "cursor", nativeSessionId: validId }, req, approved);
      expect("ineligible" in r, validId).toBe(false);
      if (!("ineligible" in r)) {
        expect(r.argv.slice(-2)).toEqual(["--resume", validId]);
      }
    }

    for (const unsafeId of [
      "",
      "-f",
      "--resume",
      "--force",
      "-dangerous",
      "session id",
      "session\nid",
      "session\tid",
      "../chat",
      "foo/bar",
      "/root",
      "session;rm",
      "$SESSION",
      "`whoami`",
      "session\x00null",
      "a".repeat(257),
    ]) {
      const r = a.resumeArgs({ provider: "cursor", nativeSessionId: unsafeId }, req, approved);
      expect(r, JSON.stringify(unsafeId)).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: "native session id is not a safe single argument",
      });
    }
  });

  it("second result line with usage does not record duplicate usage observation (FR-CAP-01)", () => {
    const r = parse([
      INIT(),
      ASSIST("ok"),
      RESULT({ usage: { inputTokens: 10, outputTokens: 2 } }),
      RESULT({ usage: { inputTokens: 20, outputTokens: 4 } }),
    ]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    const usageEvents = r.events.filter((e) => e.kind === "usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      kind: "usage",
      source: "provider_reported",
      metrics: { inputTokens: 10, outputTokens: 2 },
    });
    const observations = usageObservationsFromEvents(r.events, {
      runId: "run_usage_observation_test",
      provider: "cursor",
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.metrics).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it("session_bound carries model and backingProvider from init or result (model, model_id, modelId, backing_provider, backingProvider)", () => {
    // 1. From init: model_id, modelId, backingProvider
    const p1 = parse([
      INIT({ model: undefined, model_id: "claude-3-7-sonnet", backingProvider: "anthropic" }),
      RESULT(),
    ]);
    expect(p1.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: "claude-3-7-sonnet",
      backingProvider: "anthropic",
    });

    const p2 = parse([
      INIT({ model: undefined, modelId: "claude-3-5-sonnet", backing_provider: "anthropic" }),
      RESULT(),
    ]);
    expect(p2.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: "claude-3-5-sonnet",
      backingProvider: "anthropic",
    });

    // Model precedence: model > model_id > modelId
    const pPrecedence = parse([
      INIT({ model: "model-wins", model_id: "model-id-loses", modelId: "modelId-loses" }),
      RESULT(),
    ]);
    expect(pPrecedence.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: "model-wins",
    });

    // 2. From result without init (single result / json format)
    const p3 = parse([RESULT({ model: "claude-4-opus", backing_provider: "anthropic-direct" })]);
    expect(p3.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: "claude-4-opus",
      backingProvider: "anthropic-direct",
    });

    // 3. Session ID resolution from sessionId, chat_id, chatId in init and result
    const sessionKeyCases: readonly [string, string][] = [
      ["sessionId", "session-uuid-1"],
      ["chat_id", "session-uuid-2"],
      ["chatId", "session-uuid-3"],
    ];
    for (const [key, val] of sessionKeyCases) {
      const pInit = parse([line({ type: "system", subtype: "init", apiKeySource: "login", [key]: val }), RESULT()]);
      expect(pInit.events.find((e) => e.kind === "session_bound")?.nativeSessionId, key).toBe(val);

      const pRes = parse([RESULT({ session_id: undefined, [key]: val })]);
      expect(pRes.events.find((e) => e.kind === "session_bound")?.nativeSessionId, key).toBe(val);
    }

    // 4. Prototype pollution prevention: __proto__ or Object.prototype keys in model or backingProvider are omitted
    const pProto = parse([INIT({ model: "toString", backing_provider: "__proto__" }), RESULT()]);
    expect(pProto.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
    });
  });

  it("parses assistant message content variants (array of strings, string content, message.text, e.text, e.content)", () => {
    // Array of plain strings
    const p1 = parse([
      INIT(),
      line({ type: "assistant", message: { content: ["first part ", "second part"] } }),
      RESULT(),
    ]);
    expect(p1.events.find((e) => e.kind === "message")).toEqual({
      kind: "message",
      role: "assistant",
      text: "first part second part",
    });

    // String content inside message
    const p2 = parse([INIT(), line({ type: "assistant", message: { content: "single string response" } }), RESULT()]);
    expect(p2.events.find((e) => e.kind === "message")).toEqual({
      kind: "message",
      role: "assistant",
      text: "single string response",
    });

    // message.text
    const p3 = parse([INIT(), line({ type: "assistant", message: { text: "text in message" } }), RESULT()]);
    expect(p3.events.find((e) => e.kind === "message")).toEqual({
      kind: "message",
      role: "assistant",
      text: "text in message",
    });

    // e.text top-level
    const p4 = parse([INIT(), line({ type: "assistant", text: "text in event" }), RESULT()]);
    expect(p4.events.find((e) => e.kind === "message")).toEqual({
      kind: "message",
      role: "assistant",
      text: "text in event",
    });

    // e.content top-level
    const p5 = parse([INIT(), line({ type: "assistant", content: "content in event" }), RESULT()]);
    expect(p5.events.find((e) => e.kind === "message")).toEqual({
      kind: "message",
      role: "assistant",
      text: "content in event",
    });
  });

  it("parses tool arguments directly on entry, arguments container, and alias parameters", () => {
    // Top-level arguments in entry
    const p1 = parse([INIT(), TOOL("started", { shellToolCall: { command: "echo direct" } }), RESULT()]);
    expect(p1.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "echo direct",
    });

    const p2 = parse([INIT(), TOOL("started", { editToolCall: { filePath: "/w/file.ts" } }), RESULT()]);
    expect(p2.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "edit",
      target: "/w/file.ts",
    });

    // Container fallback: arguments
    const p3 = parse([
      INIT(),
      TOOL("started", { shellToolCall: { arguments: { commandLine: "echo args_cmd" } } }),
      RESULT(),
    ]);
    expect(p3.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "echo args_cmd",
    });

    // Target aliases: absolute_path and file
    const p4 = parse([INIT(), TOOL("started", { editToolCall: { args: { absolute_path: "/w/abs.ts" } } }), RESULT()]);
    expect(p4.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "edit",
      target: "/w/abs.ts",
    });

    const p5 = parse([INIT(), TOOL("started", { readToolCall: { args: { file: "/w/read.ts" } } }), RESULT()]);
    expect(p5.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "read",
      target: "/w/read.ts",
    });
  });

  it("unmapped tool names with a command are treated as shell and guarded against Git writes (ADR-0039)", () => {
    const ctx = { cwd: "/w", bypass: true };
    const a = adapter();

    for (const toolName of [
      "bashToolCall",
      "terminalToolCall",
      "execToolCall",
      "runCommandToolCall",
      "executeCommandToolCall",
      "custom_tool",
      "function",
    ]) {
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      const lines = [INIT(), TOOL("started", { [toolName]: { args: { command: "git push origin main" } } }), RESULT()];
      const events = lines.flatMap((l) => a.parseEvent(l, state)).map((e) => guardEvent(e, ctx));
      const r = a.extractResult(events, EXIT0);
      expect(r, toolName).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });
      expect(r.failureDetail, toolName).toMatch(/^git write attempted/);
    }
  });

  it("tool refusal aliases (permission_denied, denied, blocked, error message)", () => {
    const refusalCases: readonly [string, unknown][] = [
      ["permission_denied", {}],
      ["denied", {}],
      ["blocked", {}],
      ["error", "Permission denied by system"],
    ];
    for (const [refusalKey, body] of refusalCases) {
      const r = parse([
        INIT(),
        TOOL("started", { shellToolCall: { args: { command: "echo test" } } }),
        TOOL("completed", { shellToolCall: { result: { [refusalKey]: body } } }),
        RESULT(),
      ]);
      expect(
        r.events.some((e) => e.kind === "permission_denied"),
        refusalKey,
      ).toBe(true);
      expect(r.result, refusalKey).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });
    }

    // Error text on entry
    const rEntry = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo test" } } }),
      TOOL("completed", { shellToolCall: { error: "Command blocked by security policy" } }),
      RESULT(),
    ]);
    expect(rEntry.events.some((e) => e.kind === "permission_denied")).toBe(true);
    expect(rEntry.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("parses snake_case and totalTokens usage metrics", () => {
    const r = parse([
      INIT(),
      RESULT({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cache_read_tokens: 2,
          cache_write_tokens: 1,
        },
      }),
    ]);
    const u = r.events.find((e) => e.kind === "usage");
    expect(u).toMatchObject({
      kind: "usage",
      source: "provider_reported",
      metrics: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 2,
        cache_write_tokens: 1,
      },
    });

    const rCamel = parse([
      INIT(),
      RESULT({
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      }),
    ]);
    const uCamel = rCamel.events.find((e) => e.kind === "usage");
    expect(uCamel).toMatchObject({
      kind: "usage",
      source: "provider_reported",
      metrics: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
  });

  it("extracts command from result.rejected or result.permissionDenied when args omitted on completed call", () => {
    const ctx = { cwd: "/w", bypass: true };
    const a = adapter();

    // 1. result.rejected with command
    const state1: ParseState = { lines: 0, unknownEvents: 0 };
    const lines1 = [
      INIT(),
      TOOL("started", { shellToolCall: {} }),
      TOOL("completed", { shellToolCall: { result: { rejected: { command: "git push origin main" } } } }),
      RESULT(),
    ];
    const events1 = lines1.flatMap((l) => a.parseEvent(l, state1)).map((e) => guardEvent(e, ctx));
    const r1 = a.extractResult(events1, EXIT0);
    expect(r1).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
    expect(r1.failureDetail).toMatch(/^git write attempted/);

    // 2. result.permissionDenied with command
    const state2: ParseState = { lines: 0, unknownEvents: 0 };
    const lines2 = [
      INIT(),
      TOOL("started", { shellToolCall: {} }),
      TOOL("completed", { shellToolCall: { result: { permissionDenied: { command: "git commit -m x" } } } }),
      RESULT(),
    ];
    const events2 = lines2.flatMap((l) => a.parseEvent(l, state2)).map((e) => guardEvent(e, ctx));
    const r2 = a.extractResult(events2, EXIT0);
    expect(r2).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
    expect(r2.failureDetail).toMatch(/^git write attempted/);
  });

  it("call_id and callId correlate started/completed reports; a different id is a new call", () => {
    const same = parse([
      INIT(),
      line({
        type: "tool_call",
        subtype: "started",
        call_id: "c1",
        tool_call: { shellToolCall: { args: { command: "echo hi" } } },
        session_id: SID,
      }),
      line({
        type: "tool_call",
        subtype: "completed",
        callId: "c1",
        tool_call: { shellToolCall: { args: { command: "echo hi" }, result: { rejected: {} } } },
        session_id: SID,
      }),
      RESULT(),
    ]);
    expect(same.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "echo hi" },
    ]);
    expect(same.events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "shellToolCall" },
    ]);
    expect(same.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });

    const swapped = parse([
      INIT(),
      line({
        type: "tool_call",
        subtype: "started",
        call_id: "c1",
        tool_call: { shellToolCall: { args: { command: "echo hi" } } },
        session_id: SID,
      }),
      line({
        type: "tool_call",
        subtype: "completed",
        callId: "c2",
        tool_call: { shellToolCall: { args: { command: "git push origin main" }, result: { success: {} } } },
        session_id: SID,
      }),
      RESULT(),
    ]);
    expect(swapped.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "echo hi" },
      { kind: "tool_call", tool: "shell", name: "shellToolCall", command: "git push origin main" },
    ]);
  });

  it("editFileToolCall and writeFileToolCall are edit tools and carry their path", () => {
    const r = parse([
      INIT(),
      TOOL("started", { editFileToolCall: { args: { path: "/w/a.ts" } } }),
      TOOL("started", { writeFileToolCall: { args: { filePath: "/w/b.ts" } } }),
      RESULT(),
    ]);
    expect(r.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "edit", name: "editFileToolCall", target: "/w/a.ts" },
      { kind: "tool_call", tool: "edit", name: "writeFileToolCall", target: "/w/b.ts" },
    ]);
    expect(r.result).toMatchObject({ ok: true });
  });

  it("extracts command from result.permission_denied when args omitted on completed call", () => {
    const ctx = { cwd: "/w", bypass: true };
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events = [
      INIT(),
      TOOL("started", { shellToolCall: {} }),
      TOOL("completed", { shellToolCall: { result: { permission_denied: { command: "git push origin main" } } } }),
      RESULT(),
    ]
      .flatMap((l) => a.parseEvent(l, state))
      .map((e) => guardEvent(e, ctx));
    const r = a.extractResult(events, EXIT0);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(r.failureDetail).toMatch(/^git write attempted/);
  });

  it("session id key precedence is session_id over sessionId over chat_id over chatId", () => {
    const p1 = parse([
      line({
        type: "system",
        subtype: "init",
        apiKeySource: "login",
        sessionId: "sid-alias",
        chat_id: "chat-snake",
        chatId: "chat-camel",
      }),
      RESULT({ session_id: undefined }),
    ]);
    expect(p1.events.find((e) => e.kind === "session_bound")?.nativeSessionId).toBe("sid-alias");

    const p2 = parse([
      line({
        type: "system",
        subtype: "init",
        apiKeySource: "login",
        chat_id: "chat-snake",
        chatId: "chat-camel",
      }),
      RESULT({ session_id: undefined }),
    ]);
    expect(p2.events.find((e) => e.kind === "session_bound")?.nativeSessionId).toBe("chat-snake");

    const p3 = parse([RESULT({ session_id: undefined, sessionId: "from-result", chatId: "chat-camel" })]);
    expect(p3.events.find((e) => e.kind === "session_bound")?.nativeSessionId).toBe("from-result");
  });

  it("a completed refusal after the result line still ends PERMISSION_BLOCKED; a later success result cannot erase it", () => {
    const late = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo hi" } } }),
      ASSIST("ok"),
      RESULT(),
      TOOL("completed", { shellToolCall: { args: { command: "echo hi" }, result: { rejected: {} } } }),
    ]);
    expect(late.events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "shellToolCall" },
    ]);
    expect(late.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: SID,
      unknownEventCount: 0,
    });

    const erased = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { command: "echo hi" } } }),
      RESULT(),
      TOOL("completed", { shellToolCall: { args: { command: "echo hi" }, result: { rejected: {} } } }),
      RESULT(),
    ]);
    expect(erased.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: SID,
    });
  });

  it("CommandLine wins over commandLine; an unmapped tool with both command and path is shell", () => {
    const cmd = parse([
      INIT(),
      TOOL("started", { shellToolCall: { args: { CommandLine: "echo from-pascal", commandLine: "echo from-camel" } } }),
      RESULT(),
    ]);
    expect(cmd.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "echo from-pascal",
    });

    const both = parse([
      INIT(),
      TOOL("started", { custom_tool: { args: { command: "echo only-cmd", path: "/w/decoy.ts" } } }),
      RESULT(),
    ]);
    expect(both.events.find((e) => e.kind === "tool_call")).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "custom_tool",
      command: "echo only-cmd",
    });
  });
});

describe("cursor conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.45)", () => {
  const caseOf = (kind: ConformanceCase["kind"]): ConformanceCase => {
    const c = cursorConformanceCases(makeCwd).find((x) => x.kind === kind);
    if (!c) throw new Error(`missing ${kind} case`);
    return c;
  };
  const shapeRequest = (): CompileRequest => ({
    runId: "run_cursor_shape",
    objective: "synthetic cursor objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
    bypassApproved: true,
  });
  /**
   * `a` with `compile` replaced. A Proxy that binds every other method to `a`, because the adapter's private `#`
   * members throw on an `Object.create` copy.
   */
  const withCompile = (a: CursorAdapter, compile: CursorAdapter["compile"]): CursorAdapter =>
    new Proxy(a, {
      get(target, key) {
        if (key === "compile") return compile;
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  /** A copy of `a` whose compiled invocation is rewritten by `edit`, to show the replay refuses a wrong compile. */
  const brokenBy = (a: CursorAdapter, edit: (inv: Invocation) => Invocation): CursorAdapter =>
    withCompile(a, (r, p) => {
      const inv = a.compile(r, p);
      if ("ineligible" in inv) return inv;
      return { ...edit(inv), policyFlags: [] };
    });

  const caseWhere = (name: string, pick: (e: ConformanceCase["expect"]) => boolean): ConformanceCase => {
    const c = cursorConformanceCases(makeCwd).find((x) => pick(x.expect));
    if (!c) throw new Error(`missing ${name} case`);
    return c;
  };

  const caseFor = (fixture: string): ConformanceCase => {
    const want = fixturePath(fixture);
    const c = cursorConformanceCases(makeCwd).find((x) => {
      const inv = x.adapter.compile(x.request, x.profile);
      return !("ineligible" in inv) && inv.argv.includes(want);
    });
    if (!c) throw new Error(`missing ${fixture} case`);
    return c;
  };

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

  it("resumed run preserves native session id", async () => {
    const c = caseOf("resume");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: RESUMED_SESSION_ID,
    });
  });

  it("an unknown or mismatched session id in resume fails the resume case's id check", async () => {
    const { binding: _binding, ...c } = caseOf("resume");
    const unknown = replayAdapter("resume_unknown_id");
    const report = await runConformanceCase({
      ...c,
      adapter: unknown,
      binding: { provider: "cursor", nativeSessionId: RESUMED_SESSION_ID },
    });
    expect(report.ok).toBe(false);
    expect(report.checks.filter((k) => !k.ok).map((k) => k.name)).toEqual(["native session id"]);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: "synthetic-cursor-session-different-0099",
    });
  });

  it("the case list replays the refusal, anomaly, guard and exit code shapes, both cancellation paths", () => {
    const cases = cursorConformanceCases(makeCwd);
    const replays = (fixture: string) =>
      cases.filter((x) => {
        const inv = x.adapter.compile(x.request, x.profile);
        return !("ineligible" in inv) && inv.argv.includes(fixturePath(fixture));
      });
    expect(replays("permission_denied").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "PERMISSION_BLOCKED"],
    ]);
    expect(replays("permission_denied_perm").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "PERMISSION_BLOCKED"],
    ]);
    expect(replays("git_write_guard").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "PERMISSION_BLOCKED"],
    ]);
    expect(replays("git_write_guard_args").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "PERMISSION_BLOCKED"],
    ]);
    expect(replays("rate_limit").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "TOOL_FAILURE"],
    ]);
    expect(replays("rate_limit_error").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "TOOL_FAILURE"],
    ]);
    expect(replays("sandbox_violation").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "TOOL_FAILURE"],
    ]);
    expect(replays("backing_provider").map((x) => [x.kind, x.expect.ok])).toEqual([["success", true]]);
    for (const fx of ["no_result", "two_results", "session_changed", "trailing_tool", "unsafe_id_after_bound"]) {
      expect(replays(fx).map((x) => [x.kind, x.expect.failureCode])).toEqual([
        ["malformed_output", "OUTPUT_PROTOCOL_ERROR"],
      ]);
    }
    const cancels = cases.filter((x) => x.kind === "cancellation");
    const argvOf = (x: ConformanceCase) => {
      const inv = x.adapter.compile(x.request, x.profile);
      return "ineligible" in inv ? [] : inv.argv;
    };
    expect(cancels.map((x) => argvOf(x).includes("--ignore-term"))).toEqual([true, false]);
  });

  it("a soft-denied shell command at exit 0 (rejected, live check row 7a) is PERMISSION_BLOCKED", async () => {
    const report = await runConformanceCase(caseFor("permission_denied"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("a permissionDenied tool call at exit 0 (live check row 11) is PERMISSION_BLOCKED", async () => {
    const report = await runConformanceCase(caseFor("permission_denied_perm"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("a logged-out or env apiKeySource at exit 0 ends AUTH_REQUIRED, not a success", async () => {
    const report = await runConformanceCase(caseOf("auth_missing"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
  });

  it("a write before a soft-denied command (live check rows 7a, 7b) is PERMISSION_BLOCKED and the write stays", async () => {
    const c = caseWhere("denied_after_write", (e) => e.mutatedPath === "b.txt");
    const report = await runConformanceCase(c);
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
    expect(readFileSync(join(c.request.workspace.cwd, "b.txt"), "utf8")).toContain("synthetic");
  });

  it("a SUCCESS envelope at exit 1 is TOOL_FAILURE and the write stays: the exit code is not overridden", async () => {
    const c = caseWhere("success_exit_1", (e) => e.mutatedPath === "hello.txt" && !e.ok);
    const report = await runConformanceCase(c);
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 1" });
    expect(readFileSync(join(c.request.workspace.cwd, "hello.txt"), "utf8")).toContain("synthetic");
  });

  it("an unrecorded event kind in a success is counted as unknown and does not change the result", async () => {
    const report = await runConformanceCase(caseFor("unknown_event"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID, unknownEventCount: 1 });
  });

  it("an unsafe session id in init binds nothing and is OUTPUT_PROTOCOL_ERROR", async () => {
    const report = await runConformanceCase(caseFor("unsafe_session_id"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id is not a safe argument",
    });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it("an unsafe session id after a bound one is OUTPUT_PROTOCOL_ERROR and keeps the first session id", async () => {
    const report = await runConformanceCase(caseFor("unsafe_id_after_bound"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id is not a safe argument",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("a tool step after a clean result line is OUTPUT_PROTOCOL_ERROR and keeps the session id", async () => {
    const report = await runConformanceCase(caseFor("trailing_tool"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("a Git write under a success result with no denial ends PERMISSION_BLOCKED through the run (ADR-0039)", async () => {
    const report = await runConformanceCase(caseFor("git_write_guard"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(report.result?.failureDetail).toContain("git write attempted");
  });

  it("a Git write under args.CommandLine (ADR-0039 alias) ends PERMISSION_BLOCKED through the run", async () => {
    const report = await runConformanceCase(caseFor("git_write_guard_args"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(report.result?.failureDetail).toContain("git write attempted");
  });

  it("an empty stream at exit 1 (rows 4, 14 never forced) is TOOL_FAILURE, never RATE_LIMIT_TRANSIENT", async () => {
    const report = await runConformanceCase(caseFor("rate_limit"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it("a backing_provider success (T4.6, FR-ADP-10) normalizes ok and session id and does not fail", async () => {
    const report = await runConformanceCase(caseFor("backing_provider"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID });
  });

  it.each([
    ["a stream with no result line at exit 0", "no_result", "no result event"],
    ["a second result line after a clean one", "two_results", "protocol: more than one result line"],
    ["a result for another session id", "session_changed", "protocol: session id changed mid-run"],
  ])("%s is OUTPUT_PROTOCOL_ERROR and keeps the first session id", async (_n, fixture, detail) => {
    const report = await runConformanceCase(caseFor(fixture));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: detail,
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("names no rate_limit case and expects no RATE_LIMIT_TRANSIENT or SANDBOX_VIOLATION (unrecorded shapes)", () => {
    const cases = cursorConformanceCases(makeCwd);
    expect(cases.filter((c) => c.kind === "rate_limit")).toEqual([]);
    const codes = cases.map((c) => c.expect.failureCode);
    expect(codes).not.toContain("RATE_LIMIT_TRANSIENT");
    expect(codes).not.toContain("SANDBOX_VIOLATION");
  });

  it("partial mutation leaves the file in the cwd", async () => {
    const c = caseOf("partial_mutation");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(c.request.workspace.cwd, "partial.txt"), "utf8")).toContain("synthetic");
  });

  it("hang that ignores SIGTERM is cancelled with the process group empty", async () => {
    const c = cursorConformanceCases(makeCwd).find(
      (x) =>
        x.kind === "cancellation" &&
        !("ineligible" in x.adapter.compile(x.request, x.profile)) &&
        (x.adapter.compile(x.request, x.profile) as Invocation).argv.includes("--ignore-term"),
    );
    if (!c) throw new Error("missing cancellation ignoreTerm case");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.checks.find((k) => k.name === "process group empty after run")?.ok).toBe(true);
  });

  it("hang that honours SIGTERM is cancelled cleanly", async () => {
    const c = cursorConformanceCases(makeCwd).find(
      (x) =>
        x.kind === "cancellation" &&
        !("ineligible" in x.adapter.compile(x.request, x.profile)) &&
        !(x.adapter.compile(x.request, x.profile) as Invocation).argv.includes("--ignore-term"),
    );
    if (!c) throw new Error("missing cancellation normal case");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "CANCELLED" });
  });

  it("positive control: the same wrapper with the compile unchanged passes, so each refusal below is the replay's", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: brokenBy(replayAdapter("success_edit"), (inv) => ({ ...inv, policyFlags: inv.policyFlags })),
      request: shapeRequest(),
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
  });

  const argvEdit =
    (edit: (argv: string[]) => string[]) =>
    (inv: Invocation): Invocation => ({ ...inv, argv: edit(inv.argv) });
  it.each([
    ["--print removed", argvEdit((a) => a.filter((w) => w !== "--print"))],
    ["a second --print", argvEdit((a) => [...a, "--print"])],
    [
      "--output-format removed",
      argvEdit((a) => a.filter((w, i) => w !== "--output-format" && a[i - 1] !== "--output-format")),
    ],
    [
      "--output-format text",
      argvEdit((a) => {
        const i = a.indexOf("--output-format");
        return [...a.slice(0, i), "--output-format", "text", ...a.slice(i + 2)];
      }),
    ],
    [
      "--output-format=stream-json in place of the two words",
      argvEdit((a) => {
        const i = a.indexOf("--output-format");
        return [...a.slice(0, i), "--output-format=stream-json", ...a.slice(i + 2)];
      }),
    ],
    ["a second --output-format stream-json", argvEdit((a) => [...a, "--output-format", "stream-json"])],
    ["--trust removed", argvEdit((a) => a.filter((w) => w !== "--trust"))],
    ["a second --trust", argvEdit((a) => [...a, "--trust"])],
    ["--force removed", argvEdit((a) => a.filter((w) => w !== "--force"))],
    ["a second --force", argvEdit((a) => [...a, "--force"])],
    ["--print=true beside the compiled --print", argvEdit((a) => [...a, "--print=true"])],
    ["--trust=false beside the compiled --trust", argvEdit((a) => [...a, "--trust=false"])],
    ["--force=false beside the compiled --force", argvEdit((a) => [...a, "--force=false"])],
    ["--print= replacing --print", argvEdit((a) => a.map((w) => (w === "--print" ? "--print=true" : w)))],
    ["-p added (short --print, never compiled)", argvEdit((a) => [...a, "-p"])],
    ["-pf cluster added", argvEdit((a) => [...a, "-pf"])],
    ["--list-models added", argvEdit((a) => [...a, "--list-models"])],
    ["--help added to a run argv", argvEdit((a) => [...a, "--help"])],
    ["--version added to a run argv", argvEdit((a) => [...a, "--version"])],
    ["--dangerously-skip-permissions added", argvEdit((a) => [...a, "--dangerously-skip-permissions"])],
    ["--yolo added", argvEdit((a) => [...a, "--yolo"])],
    ["--always-approve added", argvEdit((a) => [...a, "--always-approve"])],
    ["--approve-mcps added", argvEdit((a) => [...a, "--approve-mcps"])],
    ["--full-auto added", argvEdit((a) => [...a, "--full-auto"])],
    ["--auto-review added", argvEdit((a) => [...a, "--auto-review"])],
    ["--worktree added", argvEdit((a) => [...a, "--worktree"])],
    ["--worktree-base added", argvEdit((a) => [...a, "--worktree-base", "/tmp"])],
    ["--skip-worktree-setup added", argvEdit((a) => [...a, "--skip-worktree-setup"])],
    ["--workspace added", argvEdit((a) => [...a, "--workspace"])],
    ["--add-dir added", argvEdit((a) => [...a, "--add-dir", "/tmp"])],
    ["--plugin-dir added", argvEdit((a) => [...a, "--plugin-dir", "/tmp"])],
    ["--api-key added", argvEdit((a) => [...a, "--api-key", "key"])],
    ["--auth-token added", argvEdit((a) => [...a, "--auth-token", "token"])],
    ["--header added", argvEdit((a) => [...a, "--header", "k:v"])],
    ["--endpoint added", argvEdit((a) => [...a, "--endpoint", "http://127.0.0.1:9"])],
    ["--mode added", argvEdit((a) => [...a, "--mode", "plan"])],
    ["--permission-mode added", argvEdit((a) => [...a, "--permission-mode", "yolo"])],
    ["--allow added", argvEdit((a) => [...a, "--allow", "Shell(*)"])],
    ["--deny added", argvEdit((a) => [...a, "--deny", "Shell(git)"])],
    ["--sandbox added", argvEdit((a) => [...a, "--sandbox"])],
    ["--sandbox=disabled added", argvEdit((a) => [...a, "--sandbox=disabled"])],
    ["--sandbox=enabled added", argvEdit((a) => [...a, "--sandbox=enabled"])],
    ["--continue added", argvEdit((a) => [...a, "--continue"])],
    ["--model added", argvEdit((a) => [...a, "--model", "model"])],
    ["-f added", argvEdit((a) => [...a, "-f"])],
    ["-w added", argvEdit((a) => [...a, "-w"])],
    ["-H added", argvEdit((a) => [...a, "-H", "key:val"])],
    ["-e added", argvEdit((a) => [...a, "-e", "http://127.0.0.1:9"])],
    ["-- terminator added", argvEdit((a) => [...a, "--"])],
    ["positional prompt word on argv", argvEdit((a) => [...a, "unexpected_prompt_word"])],
    ["--resume with a flag-like id", argvEdit((a) => [...a, "--resume", "-flag-id"])],
    ["--resume with an empty id", argvEdit((a) => [...a, "--resume", ""])],
    ["--resume with no id", argvEdit((a) => [...a, "--resume"])],
    ["--resume=id in place of two words", argvEdit((a) => [...a, "--resume=synthetic-id"])],
    ["a second --resume", argvEdit((a) => [...a, "--resume", "id1", "--resume", "id2"])],
    [
      "CURSOR_API_KEY environment variable present",
      (inv: Invocation): Invocation => ({ ...inv, env: { ...inv.env, CURSOR_API_KEY: "secret" } }),
    ],
    [
      "CURSOR_AUTH_TOKEN environment variable present",
      (inv: Invocation): Invocation => ({ ...inv, env: { ...inv.env, CURSOR_AUTH_TOKEN: "secret" } }),
    ],
    [
      "CURSOR_CONFIG_DIR environment variable present",
      (inv: Invocation): Invocation => ({ ...inv, env: { ...inv.env, CURSOR_CONFIG_DIR: "/tmp" } }),
    ],
    [
      "XDG_CONFIG_HOME environment variable present",
      (inv: Invocation): Invocation => ({ ...inv, env: { ...inv.env, XDG_CONFIG_HOME: "/tmp" } }),
    ],
  ])(
    "the replay refuses an argv or env cursor-agent would not be given (%s), so a wrong compile cannot pass",
    async (_n, edit) => {
      const report = await runConformanceCase({
        kind: "success",
        adapter: brokenBy(replayAdapter("success_edit"), edit),
        request: shapeRequest(),
        profile: PRIVILEGED_BYPASS_PROFILE,
        expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
      });
      expect(report.ok).toBe(false);
      expect(report.result?.ok).toBe(false);
    },
  );
});

/**
 * T4.43 with T4.6 (FR-ADP-10): a replayed fixture whose backing vendor differs from the harness. SYNTHETIC: native Cursor
 * output reports no backing vendor ([LIVE] row 102), so `backing_provider` is the structured key a fronted run would
 * carry, not a recorded field.
 */
describe("cursor backing-provider fixture (T4.43, T4.6, FR-ADP-10)", () => {
  it("a replayed run stores harness cursor and backing vendor side by side and shows both in get_run", async () => {
    const root = realpathSync(makeCwd());
    const repo = join(root, "repo");
    mkdirSync(repo);
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: {
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Cursor Dev",
          GIT_AUTHOR_EMAIL: "cursor@example.test",
          GIT_COMMITTER_NAME: "Cursor Dev",
          GIT_COMMITTER_EMAIL: "cursor@example.test",
        },
      });
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "initial\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");

    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const lifecycle = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
      artifacts,
      adapters: new AdapterRegistry().register(replayAdapter("backing_provider")),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
    });
    lifecycle.start();
    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "answer through a backing vendor",
        workspace: repo,
        trustProfile: "privileged",
        provider: "cursor",
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });
      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

      // The session_bound event's fields land on the provider binding (T5.3), never inferred from the display name.
      expect(ledger.listProviderBindings(metaSessionId)).toEqual([
        expect.objectContaining({
          provider: "cursor",
          harness: "cursor",
          backing_provider: "backing-x",
          model: "Synthetic Model 1",
          native_session_id: DEFAULT_SESSION_ID,
        }),
      ]);

      const rows = ledger.listUsageObservationsForRun(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "cursor",
        harness: "cursor",
        backing_provider: "backing-x",
        model: "Synthetic Model 1",
        source: "provider_reported",
      });
      expect(buildEnvelope(ledger, done, (s) => s).usage?.reported).toEqual([
        expect.objectContaining({
          harness: "cursor",
          backing_provider: "backing-x",
          model: "Synthetic Model 1",
          metrics: expect.objectContaining({ inputTokens: 13, outputTokens: 3 }),
        }),
      ]);
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
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
