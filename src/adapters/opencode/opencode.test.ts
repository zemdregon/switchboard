/**
 * T4.52 (TDD §4.6): the OpenCode module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `opencode` binary is run; probe output is the shape the 2026-10-14 live check recorded (`opencode v2.0.23`).
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
import { OPENCODE_GIT_CAPABILITIES, OPENCODE_GIT_WRITE_CONTROL, OpenCodeAdapter } from "./adapter.js";
import {
  DEFAULT_SESSION_ID,
  opencodeConformanceCases,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";
import { GIT_WRITE_CONTROL_DETAIL, NON_PRIVILEGED_UNSUPPORTED_DETAIL } from "./protocol.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-opencode-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

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

describe("opencode probe and auth preflight (T4.52, T4.54)", () => {
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

  // T4.54: shapes of the 2026-10-14 live check rows 2b, 2d to 2f; names and ids are invented placeholders.
  const AUTH = "auth list --format json --standalone";
  const list = (v: unknown) => ({ [AUTH]: { stdout: JSON.stringify(v), exitCode: 0 } });

  it("auth is OK only when a provider holds a non-environment connection; empty or environment-only is AUTH_REQUIRED", async () => {
    expect(
      await adapter().authPreflight(
        runner(list([{ id: "opencode", name: "Someone", connections: [{ type: "oauth" }] }])),
      ),
    ).toEqual({ state: "OK" });
    for (const v of [
      [],
      [{ id: "cloudflare", name: "Env Provider", connections: [{ type: "environment" }] }],
      [{ id: "other", name: "Env Provider", connections: [{ type: "env" }, { type: "environment" }] }],
    ]) {
      expect(await adapter().authPreflight(runner(list(v))), JSON.stringify(v)).toEqual({
        state: "AUTH_REQUIRED",
        loginCommand: "opencode auth login",
      });
    }
  });

  it("auth is UNKNOWN for text output, other shapes, another exit code, a timeout and no binary; no name leaks", async () => {
    const cases: Record<string, { stdout: string; exitCode: number }>[] = [
      { [AUTH]: { stdout: "No authenticated integrations\n", exitCode: 0 } },
      list({ providers: [] }),
      list([{ id: "x", name: "Someone" }]),
      list([{ id: "x", name: "Someone", connections: [{}] }]),
      { [AUTH]: { stdout: "[]", exitCode: 1 } },
    ];
    for (const table of cases) {
      const r = await adapter().authPreflight(runner(table));
      expect(r, JSON.stringify(table)).toMatchObject({ state: "UNKNOWN" });
      expect(JSON.stringify(r)).not.toContain("Someone");
    }
    const timedOut: ProbeRunner = async () => ({ stdout: "[]", stderr: "", exitCode: null, timedOut: true });
    expect(await adapter().authPreflight(timedOut)).toMatchObject({ state: "UNKNOWN" });
    expect(await new OpenCodeAdapter({ pathEnv: "/nonexistent" }).authPreflight(runner({}))).toMatchObject({
      state: "UNKNOWN",
      reason: "opencode not found on PATH",
    });
  });

  it("runs only `auth list --format json --standalone`, never `auth export`, with a timeout", async () => {
    const seen: (readonly string[])[] = [];
    let timeout: number | undefined;
    const rec: ProbeRunner = async (argv, opts) => {
      seen.push(argv);
      timeout = opts?.timeoutMs;
      return { stdout: "[]", stderr: "", exitCode: 0, timedOut: false };
    };
    await adapter().authPreflight(rec);
    expect(seen).toEqual([[EXE, "auth", "list", "--format", "json", "--standalone"]]);
    expect(timeout).toBe(15_000);
    for (const f of ["adapter.ts", "protocol.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/"export"/);
    }
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

/**
 * T4.53: parser, result, failure classification and resume. SYNTHETIC lines in the shapes the 2026-10-14 live check
 * recorded (rows 4c, 5, 6a, 14a, 14b, 14d); ids, text and numbers are invented.
 */
describe("opencode parser and result (T4.53)", () => {
  const SID = "ses_0000000000000000000000000A";
  const line = (type: string, part: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type,
      timestamp: 1,
      sessionID: SID,
      part: { sessionID: SID, messageID: "msg_1", ...part },
      ...extra,
    });
  const START = line("step_start", { id: "prt_s1", type: "step-start", snapshot: "abc" });
  const TEXT = (text: string, id = "prt_t1") => line("text", { id, type: "text", text });
  const TOOL = (tool: string, input: Record<string, unknown>, status = "completed") =>
    line("tool_use", { id: "prt_u1", type: "tool", tool, state: { status, input, output: "done" } });
  const FINISH = (reason: string, id = "prt_f1") =>
    line("step_finish", {
      id,
      type: "step-finish",
      reason,
      cost: 0.001,
      tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 4, write: 0 } },
    });
  const ERROR = (type: string, message: string) =>
    JSON.stringify({ type: "error", timestamp: 1, sessionID: SID, error: { type, message } });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const parse = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events: NormalizedEvent[] = lines.flatMap((l) => a.parseEvent(l, state));
    return { a, state, events };
  };

  it("success: session id from the first event, text joined, usage per step provider_reported, stop is the result", () => {
    const { a, state, events } = parse([
      START,
      TEXT("reading"),
      TOOL("read", { filePath: "hello.txt" }),
      FINISH("tool-calls", "prt_f1"),
      START,
      TEXT("ok", "prt_t2"),
      FINISH("stop", "prt_f2"),
    ]);
    expect(events[0]).toEqual({ kind: "session_bound", nativeSessionId: SID });
    expect(events.filter((e) => e.kind === "session_bound")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        source: "provider_reported",
        metrics: { input: 10, output: 3, reasoning: 1, cache_read: 4, cache_write: 0, cost_usd: 0.001 },
      },
      {
        kind: "usage",
        source: "provider_reported",
        metrics: { input: 10, output: 3, reasoning: 1, cache_read: 4, cache_write: 0, cost_usd: 0.001 },
      },
    ]);
    expect(events).toContainEqual({ kind: "tool_call", tool: "read", name: "read", target: "hello.txt" });
    expect(state).toMatchObject({ nativeSessionId: SID, unknownEvents: 0 });
    expect(a.extractResult(events, EXIT0)).toEqual({
      ok: true,
      nativeSessionId: SID,
      summary: "reading\nok",
      unknownEventCount: 0,
    });
  });

  it("a repeated step_finish part is counted once; no backing provider or model is invented (T4.6)", () => {
    const { events } = parse([START, TEXT("ok"), FINISH("stop", "prt_f9"), FINISH("stop", "prt_f9")]);
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(1);
    const bound = events.find((e) => e.kind === "session_bound");
    expect(bound).not.toHaveProperty("backingProvider");
    expect(bound).not.toHaveProperty("model");
  });

  it("a run that exits 0 with text but no step_finish stop is not a success (Q-85)", () => {
    for (const lines of [
      [START, TEXT("ok")],
      [START, TEXT("x"), FINISH("tool-calls")],
    ]) {
      const { a, events } = parse(lines);
      expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    }
  });

  it("shell calls carry their command for the tool-call guard (ADR-0039); other tools are `other`", () => {
    const { events } = parse([
      START,
      TOOL("shell", { command: "git -C . commit -m x" }),
      TOOL("write", { filePath: "/tmp/outside.txt" }, "error"),
      TOOL("webfetch", { url: "https://example.test" }),
      TOOL("shell", {}),
    ]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shell", command: "git -C . commit -m x" },
      { kind: "tool_call", tool: "edit", name: "write", target: "/tmp/outside.txt" },
      { kind: "tool_call", tool: "other", name: "webfetch" },
      { kind: "tool_call", tool: "shell", name: "shell" },
    ]);
  });

  it("error events map to the taxonomy and fail the run whatever the exit code", () => {
    const cases: [string, string][] = [
      ["provider.no-route", "MODEL_UNAVAILABLE"],
      ["provider.quota", "QUOTA_EXHAUSTED"],
      ["provider.auth", "AUTH_REQUIRED"],
      ["provider.something-new", "TOOL_FAILURE"],
    ];
    for (const [type, code] of cases) {
      const { a, events } = parse([START, ERROR(type, "synthetic message"), TEXT("ok"), FINISH("stop")]);
      expect(a.extractResult(events, EXIT0), type).toMatchObject({ ok: false, failureCode: code });
      expect(a.extractResult(events, { ...EXIT0, exitCode: 1 }), type).toMatchObject({ ok: false, failureCode: code });
    }
  });

  it("a non-zero exit, a timeout and a cancel never succeed", () => {
    const { a, events } = parse([START, TEXT("ok"), FINISH("stop")]);
    expect(a.extractResult(events, { ...EXIT0, exitCode: 1 })).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
    });
    expect(a.extractResult(events, { ...EXIT0, outcome: "timeout", timeoutKind: "wall_clock" })).toMatchObject({
      failureCode: "PROCESS_TIMEOUT",
    });
    expect(a.extractResult(events, { ...EXIT0, outcome: "cancelled" })).toMatchObject({ failureCode: "CANCELLED" });
  });

  it("malformed and unknown lines are unknown events, counted, never a result; JSON framing errors emit nothing", () => {
    const { a, state, events } = parse([
      START,
      line("brand_new"),
      JSON.stringify({ no_type: true }),
      line("text", { id: "p" }),
      line("tool_use", { id: "p" }),
      line("step_finish", { id: "p" }),
      JSON.stringify({ type: "error", sessionID: SID }),
      "not json",
    ]);
    expect(events.filter((e) => e.kind === "unknown")).toHaveLength(6);
    expect(state.unknownEvents).toBe(6);
    expect(events.some((e) => e.kind === "result")).toBe(false);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    expect(a.parseEvent({ jsonrpc: "2.0", method: "x" }, state)).toEqual([]);
  });

  it("the session id is never taken from text", () => {
    const { state } = parse([JSON.stringify({ type: "text", part: { text: `use ${SID}` } })]);
    expect(state.nativeSessionId).toBeUndefined();
  });

  // ADR-0039: a guard verdict ends the run in every run, bypass included, and the lifecycle trusts `result.ok`, so a
  // flagged tool_call must not be called clean even when the step finishes with `stop` at exit 0 (as T4.36, PR #237).
  it("a guard-flagged Git write with a stop finish at exit 0 ends PERMISSION_BLOCKED (ADR-0039)", () => {
    const { a, events } = parse([
      START,
      TOOL("shell", { command: "git push origin main" }),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    const ctx = { cwd: "/work/tree", home: "/home/synthetic", bypass: true };
    const guarded = events.map((e) => guardEvent(e, ctx));
    expect(guarded.find((e) => e.kind === "tool_call")).toHaveProperty("violation.kind", "git_write");
    const r = a.extractResult(guarded, EXIT0);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID, summary: "ok" });
    expect(r.failureDetail).toMatch(/^git write attempted/);
  });

  it("any guard verdict on a tool_call makes a clean run not clean (a provider_state verdict ends SANDBOX_VIOLATION)", () => {
    const { a, events } = parse([START, TEXT("ok"), FINISH("stop")]);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: true });
    const flagged: NormalizedEvent = {
      kind: "tool_call",
      tool: "shell",
      name: "shell",
      violation: { kind: "provider_state", reason: "synthetic" },
    };
    expect(a.extractResult([flagged, ...events], EXIT0)).toMatchObject({
      ok: false,
      failureCode: "SANDBOX_VIOLATION",
    });
  });

  it("resume is --session <id> through the same matrix; another provider's binding and a flag-like id are refused", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const r = adapter().resumeArgs(
      { provider: "opencode", nativeSessionId: SID },
      request({ bypassApproved: true }),
      profile,
    );
    if ("ineligible" in r) throw new Error(r.detail);
    expect(r.argv.slice(1)).toEqual([
      "run",
      "--format",
      "json",
      "--standalone",
      "--session",
      SID,
      "--",
      "fix the failing test",
    ]);
    expect(
      adapter().resumeArgs({ provider: "codex", nativeSessionId: SID }, request({ bypassApproved: true }), profile),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
    expect(
      adapter().resumeArgs({ provider: "opencode", nativeSessionId: "-c" }, request({ bypassApproved: true }), profile),
    ).toMatchObject({ reason: "CAPABILITY_MISSING" });
    expect(
      adapter().resumeArgs({ provider: "opencode", nativeSessionId: SID }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ reason: "PROFILE_UNSUPPORTED" });
  });

  it("records only observed usage counters, drops negative, non-number and unexpected values, and clips an unknown line's type", () => {
    const { events } = parse([
      START,
      line("step_finish", {
        id: "prt_f1",
        type: "step-finish",
        reason: "stop",
        cost: 0.005,
        tokens: {
          input: 10,
          output: "3",
          reasoning: 1,
          surprise: 9,
          cache: { read: 4, write: -1, extra: 2 },
        },
      }),
      line("x".repeat(10_000)),
    ]);
    expect(events.find((e) => e.kind === "usage")).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { input: 10, reasoning: 1, cache_read: 4, cost_usd: 0.005 },
    });
    const unknown = events.find((e) => e.kind === "unknown");
    expect(unknown?.kind === "unknown" && unknown.rawType.length).toBeLessThanOrEqual(65);

    const withBadCost = parse([
      START,
      line("step_finish", {
        id: "prt_f2",
        type: "step-finish",
        reason: "stop",
        cost: -0.1,
        tokens: { input: 5 },
      }),
    ]);
    expect(withBadCost.events.find((e) => e.kind === "usage")).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { input: 5 },
    });
  });

  it("a session id that changes mid-run fails OUTPUT_PROTOCOL_ERROR (the first id stays bound)", () => {
    const { a, state, events } = parse([
      START,
      TEXT("first"),
      JSON.stringify({
        type: "text",
        timestamp: 2,
        sessionID: "ses_OTHER00000000000000000002",
        part: { id: "prt_t2", type: "text", text: "second" },
      }),
      FINISH("stop", "prt_f2"),
    ]);
    expect(state.nativeSessionId).toBe(SID);
    expect(events).toContainEqual({
      kind: "provider_error",
      category: "protocol",
      message: "session id changed mid-run",
    });
    expect(a.extractResult(events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
  });

  it("non-string or unstructured error fields fail the run, never ignored", () => {
    const strErr = parse([
      START,
      JSON.stringify({ type: "error", timestamp: 1, sessionID: SID, error: "synthetic fatal error" }),
    ]);
    expect(strErr.events).toContainEqual({
      kind: "provider_error",
      category: "unknown",
      message: "error: synthetic fatal error",
    });
    expect(strErr.a.extractResult(strErr.events, EXIT0)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });

    const objErr = parse([
      START,
      JSON.stringify({ type: "error", timestamp: 1, sessionID: SID, error: { code: 500, detail: "bad" } }),
    ]);
    expect(objErr.events).toContainEqual({
      kind: "provider_error",
      category: "unknown",
      message: '{"code":500,"detail":"bad"}',
    });
    expect(objErr.a.extractResult(objErr.events, EXIT0)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });

    const numErr = parse([START, JSON.stringify({ type: "error", timestamp: 1, sessionID: SID, error: 500 })]);
    expect(numErr.events).toContainEqual({
      kind: "provider_error",
      category: "unknown",
      message: "500",
    });
    expect(numErr.a.extractResult(numErr.events, EXIT0)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  it("non-object roots, arrays, and __proto__ pollute nothing and are counted unknown", () => {
    const { state, events } = parse([
      '"str"',
      "123",
      "true",
      "null",
      "[]",
      '{"type":"text","__proto__":{"polluted":true},"part":{"id":"prt_p","type":"text","text":"hi"}}',
    ]);
    expect(state.unknownEvents).toBe(5);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(events.filter((e) => e.kind === "message")).toEqual([{ kind: "message", role: "assistant", text: "hi" }]);
  });

  it("resume refuses every non-privileged profile and dangerous session IDs", () => {
    const approved = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const badIds = ["", "-s", "--session", "--auto", "../escape", "id with spaces", "@flag"];
    for (const badId of badIds) {
      expect(
        adapter().resumeArgs(
          { provider: "opencode", nativeSessionId: badId },
          request({ bypassApproved: true }),
          approved,
        ),
        badId,
      ).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING" });
    }
    for (const name of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
      expect(
        adapter().resumeArgs({ provider: "opencode", nativeSessionId: SID }, request(), profileOf(name)),
        name,
      ).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    }
  });

  it("native values that name Object.prototype members map to `other`, `shell` and `unknown`, never an inherited member", () => {
    const { a, events } = parse([
      START,
      TOOL("constructor", { command: "git push" }),
      TOOL("__proto__", {}),
      TOOL("toString", {}),
      ERROR("toString", "synthetic"),
      ERROR("__proto__", "synthetic"),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      // An unlisted tool name whose input carries a string `command` is a shell tool (fail closed, T4.56).
      { kind: "tool_call", tool: "shell", name: "constructor", command: "git push" },
      { kind: "tool_call", tool: "other", name: "__proto__" },
      { kind: "tool_call", tool: "other", name: "toString" },
    ]);
    expect(events.filter((e) => e.kind === "provider_error")).toEqual([
      { kind: "provider_error", category: "unknown", message: "toString: synthetic" },
      { kind: "provider_error", category: "unknown", message: "__proto__: synthetic" },
    ]);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  it("a session id resume could not pass as one argument is never bound and fails OUTPUT_PROTOCOL_ERROR", () => {
    for (const bad of ["--auto", "-s", "ses x", "../ses", "a".repeat(257)]) {
      const withId = (type: string, part: Record<string, unknown>) =>
        JSON.stringify({ type, timestamp: 1, sessionID: bad, part });
      const { a, state, events } = parse([
        withId("step_start", { id: "prt_s1", type: "step-start" }),
        withId("text", { id: "prt_t1", type: "text", text: "ok" }),
        withId("step_finish", { id: "prt_f1", type: "step-finish", reason: "stop" }),
      ]);
      expect(state.nativeSessionId, bad).toBeUndefined();
      expect(
        events.some((e) => e.kind === "session_bound"),
        bad,
      ).toBe(false);
      const r = a.extractResult(events, EXIT0);
      expect(r, bad).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
      expect(r, bad).not.toHaveProperty("nativeSessionId");
    }
    // A bad id after a good one leaves the good one bound and still fails the run.
    const mixed = parse([
      START,
      JSON.stringify({ type: "text", sessionID: "--auto", part: { text: "x" } }),
      FINISH("stop"),
    ]);
    expect(mixed.state.nativeSessionId).toBe(SID);
    expect(mixed.a.extractResult(mixed.events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
  });

  it("a tool call after the last stop step is not a success (Q-85, fail closed); a later stop makes it clean again", () => {
    const trailing = parse([START, TEXT("ok"), FINISH("stop"), START, TOOL("read", { filePath: "a.txt" })]);
    expect(trailing.a.extractResult(trailing.events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the final stop step",
      nativeSessionId: SID,
    });
    const intermediate = parse([
      START,
      TOOL("read", { filePath: "a.txt" }),
      FINISH("tool-calls", "prt_f1"),
      START,
      TEXT("ok"),
      FINISH("stop", "prt_f2"),
      START,
      TOOL("read", { filePath: "b.txt" }),
      FINISH("tool-calls", "prt_f3"),
    ]);
    expect(intermediate.a.extractResult(intermediate.events, EXIT0)).toMatchObject({ ok: false });
    const restopped = parse([
      START,
      TEXT("ok"),
      FINISH("stop", "prt_f1"),
      START,
      TOOL("read", {}),
      FINISH("stop", "prt_f2"),
    ]);
    expect(restopped.a.extractResult(restopped.events, EXIT0)).toMatchObject({ ok: true });
    // A guard verdict on the trailing call keeps its own code (ADR-0039).
    const ctx = { cwd: "/work/tree", home: "/home/synthetic", bypass: true };
    const flagged = parse([START, TEXT("ok"), FINISH("stop"), TOOL("shell", { command: "git push origin main" })]);
    expect(
      flagged.a.extractResult(
        flagged.events.map((e) => guardEvent(e, ctx)),
        EXIT0,
      ),
    ).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
  });

  it("a trailing tool_use the parser cannot read is still a tool call after the final stop step", () => {
    // No string `part.tool`: the line parses as `unknown` and must not leave the run clean (as Grok, T4.26).
    for (const call of [
      JSON.stringify({ type: "tool_use", timestamp: 1, sessionID: SID }),
      line("tool_use", { type: "tool" }),
      line("tool_use", { type: "tool", tool: 7, state: { input: { command: "ls" } } }),
    ]) {
      const label = call;
      const { a, events } = parse([START, TEXT("ok"), FINISH("stop"), call]);
      expect(events.at(-1), label).toEqual({ kind: "unknown", rawType: "tool_use" });
      const r = a.extractResult(events, EXIT0);
      expect(r, label).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: SID });
      expect(r.ok === false && r.failureDetail, label).toBe("tool call after the final stop step");
    }
    // Late text and an intermediate step after `stop` do not trip it.
    const quiet = parse([START, TEXT("ok"), FINISH("stop"), TEXT("late", "prt_t2"), FINISH("tool-calls", "prt_f2")]);
    expect(quiet.a.extractResult(quiet.events, EXIT0)).toMatchObject({ ok: true });
    // The same unreadable line before `stop` is an unreadable event, not a trailing tool call; still not a success.
    const before = parse([START, line("tool_use", { type: "tool" }), TEXT("ok"), FINISH("stop")]);
    const r = before.a.extractResult(before.events, EXIT0);
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 1 });
    expect(r.ok === false && r.failureDetail).toBe("1 unreadable event(s) in the stream");
  });

  it("an unknown or unreadable event anywhere, before or after the final stop step, is never a success (T4.56)", () => {
    const EXIT1: ExitInfo = { ...EXIT0, exitCode: 1 };
    for (const [label, lines] of [
      ["unknown kind before stop", [START, line("synthetic_unknown_kind", {}), TEXT("ok"), FINISH("stop")]],
      ["unknown kind after stop", [START, TEXT("ok"), FINISH("stop"), line("synthetic_unknown_kind", {})]],
      ["step_finish without a reason", [START, line("step_finish", { type: "step-finish" }), FINISH("stop", "prt_f2")]],
      ["text without text", [START, line("text", { type: "text" }), FINISH("stop")]],
      ["no type", [START, JSON.stringify({ sessionID: SID }), TEXT("ok"), FINISH("stop")]],
    ] as const) {
      const { a, events } = parse([...lines]);
      expect(
        events.some((e) => e.kind === "unknown"),
        label,
      ).toBe(true);
      const r0 = a.extractResult(events, EXIT0);
      expect(r0, label).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
      expect(r0.ok === false && r0.failureDetail, label).toMatch(/unreadable event\(s\) in the stream$/);
      expect(a.extractResult(events, EXIT1), label).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    }
    // A later `stop` does not wash an earlier unreadable line back to success.
    const washed = parse([
      START,
      line("synthetic_unknown_kind", {}),
      TEXT("ok"),
      FINISH("stop"),
      START,
      TEXT("again", "prt_t2"),
      FINISH("stop", "prt_f2"),
    ]);
    expect(washed.a.extractResult(washed.events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      unknownEventCount: 1,
    });
  });

  it("a shell tool named bash, or any unlisted tool carrying a string command, reaches the tool-call guard (T4.56)", () => {
    const ctx = { cwd: "/work/tree", home: "/home/synthetic", bypass: true };
    for (const name of ["bash", "synthetic_exec", "sh"]) {
      const { a, events } = parse([START, TOOL(name, { command: "git push origin main" }), TEXT("ok"), FINISH("stop")]);
      const call = events.find((e) => e.kind === "tool_call");
      expect(call, name).toEqual({ kind: "tool_call", tool: "shell", name, command: "git push origin main" });
      const guarded = events.map((e) => guardEvent(e, ctx));
      expect(a.extractResult(guarded, EXIT0), name).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    }
    // No string `command`: an unlisted tool stays `other` and a read-only call leaves the run clean.
    for (const input of [{}, { command: 7 }, { pattern: "git push" }]) {
      const { a, events } = parse([START, TOOL("grep", input), TEXT("ok"), FINISH("stop")]);
      expect(
        events.find((e) => e.kind === "tool_call"),
        JSON.stringify(input),
      ).toEqual({
        kind: "tool_call",
        tool: "other",
        name: "grep",
      });
      expect(
        a.extractResult(
          events.map((e) => guardEvent(e, ctx)),
          EXIT0,
        ),
      ).toMatchObject({ ok: true });
    }
    // A known file tool keeps its kind even when `command` is also present. A benign shell command stays a success.
    const read = parse([START, TOOL("read", { filePath: "a.txt", command: "git push origin main" }), FINISH("stop")]);
    expect(read.events.find((e) => e.kind === "tool_call")).toEqual({
      kind: "tool_call",
      tool: "read",
      name: "read",
      target: "a.txt",
    });
    const benign = parse([START, TOOL("bash", { command: "echo ok" }), TEXT("ok"), FINISH("stop")]);
    expect(benign.events.find((e) => e.kind === "tool_call")).toMatchObject({ tool: "shell", command: "echo ok" });
    expect(
      benign.a.extractResult(
        benign.events.map((e) => guardEvent(e, ctx)),
        EXIT0,
      ),
    ).toMatchObject({ ok: true });
  });

  it("a guard-flagged trailing tool_use ends PERMISSION_BLOCKED at exit 1, after an intermediate step and a second stop", () => {
    const ctx = { cwd: "/work/tree", home: "/home/synthetic", bypass: true };
    const guarded = (lines: string[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
    const PUSH = TOOL("shell", { command: "git push origin main" });
    const EXIT1: ExitInfo = { ...EXIT0, exitCode: 1 };
    // ADR-0039: the guard verdict precedes the unexpected exit and the trailing-tool protocol anomaly.
    for (const [label, lines, exit] of [
      ["exit 1", [START, TEXT("ok"), FINISH("stop"), PUSH], EXIT1],
      ["intermediate step", [START, TEXT("ok"), FINISH("stop"), START, PUSH, FINISH("tool-calls", "prt_f2")], EXIT0],
      ["second stop", [START, FINISH("stop"), START, FINISH("stop", "prt_f2"), PUSH], EXIT0],
    ] as const) {
      expect(adapter().extractResult(guarded([...lines]), exit), label).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: SID,
      });
    }
    // Without the Git write the same exit-1 trailing call is an unexpected exit, never success.
    const plain = guarded([START, TEXT("ok"), FINISH("stop"), TOOL("shell", { command: "ls" })]);
    expect(adapter().extractResult(plain, EXIT1)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  // Done-when cases whose native shape the T4.51 live check did NOT record (ROADMAP T4.53 stays Partial).
  // These pin today's observed outcomes; an operator capture (T4.51 extension) must change them.
  describe("cases with no recorded native shape (live check rows 7, 11, 14c)", () => {
    it("permission denied by OpenCode (row 11: out-of-worktree path, status error, exit 0) is not detected as denial (gap)", () => {
      // Live check row 11: an out-of-repo read/write returned tool_use state.status "error", the model reported
      // "rejected by the permission system", and the run exited 0. FR-ADP-04 forbids reading status from free text,
      // and state.status "error" is also what an ordinary tool error reports, so neither permission_denied nor
      // sandbox_violation is emitted.
      const { a, events } = parse([
        START,
        TOOL("read", { filePath: "/tmp/outside.txt" }, "error"),
        TEXT("The tool call was rejected by the permission system."),
        FINISH("stop"),
      ]);
      expect(events.some((e) => e.kind === "permission_denied" || e.kind === "sandbox_violation")).toBe(false);
      expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: true });
    });

    it("a rate limit (row 14c, never forced) has no recognised form: an unrecognised error line or bare exit is TOOL_FAILURE, never RATE_LIMIT_TRANSIENT or success", () => {
      const exit1: ExitInfo = { outcome: "exited", exitCode: 1, signal: null, expectedExitCodes: [0] };
      const errorLine = parse([
        START,
        JSON.stringify({
          type: "error",
          timestamp: 1,
          sessionID: SID,
          error: { type: "provider.rate_limit", message: "429 Too Many Requests" },
        }),
      ]);
      expect(errorLine.events).toContainEqual({
        kind: "provider_error",
        category: "unknown",
        message: "provider.rate_limit: 429 Too Many Requests",
      });
      expect(errorLine.a.extractResult(errorLine.events, exit1)).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
      });
      expect(errorLine.events.some((e) => e.kind === "rate_limit")).toBe(false);
      expect(adapter().extractResult([], exit1)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    });

    it("tool call without command or target keys emits tool_call with no command or target (Assumption gap)", () => {
      // Live check row 4c recorded state.input but not its keys. If a tool call arrives with unexpected input keys,
      // command and target are omitted from the tool_call event.
      const { events } = parse([START, TOOL("shell", { script: "git commit" }), TOOL("read", { file: "foo.txt" })]);
      expect(events.filter((e) => e.kind === "tool_call")).toEqual([
        { kind: "tool_call", tool: "shell", name: "shell" },
        { kind: "tool_call", tool: "read", name: "read" },
      ]);
    });

    it("non-string command and path values are omitted, never coerced (Assumption gap: input keys unrecorded)", () => {
      // Live check row 4c did not record state.input's keys or value types, so an argv-array or object command is not
      // joined into a string the guard would read; it stays invisible to the guard until a capture names the shape.
      const { events } = parse([
        START,
        TOOL("shell", { command: ["git", "push"] }),
        TOOL("shell", { command: { argv: "git push" } }),
        TOOL("write", { filePath: 7, path: ["a"] }),
        TOOL("edit", { filePath: null, path: "b.txt" }),
      ]);
      expect(events.filter((e) => e.kind === "tool_call")).toEqual([
        { kind: "tool_call", tool: "shell", name: "shell" },
        { kind: "tool_call", tool: "shell", name: "shell" },
        { kind: "tool_call", tool: "edit", name: "write" },
        { kind: "tool_call", tool: "edit", name: "edit", target: "b.txt" },
      ]);
    });

    // The same outcomes replayed end to end from fixture files through the supervisor, so each Done-when case has a
    // fixture: success (`success_edit`), task failure (`task_failure`), malformed (`malformed_output`) and the ones
    // below. They pin the gaps; a capture (T4.51 extension) must change them.
    const replayCase = (
      fixture: string,
      kind: ConformanceCase["kind"],
      exp: ConformanceCase["expect"],
    ): ConformanceCase => ({
      kind,
      adapter: replayAdapter(fixture),
      request: {
        runId: "run_opencode_t453_fixture",
        objective: "synthetic opencode objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: exp,
    });

    it("fixture permission_denied_outside (row 11) replays to a stop success with nothing counted unknown (gap)", async () => {
      const report = await runConformanceCase(
        replayCase("permission_denied_outside", "task_failure", { ok: true, nativeSessionId: DEFAULT_SESSION_ID }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: true, unknownEventCount: 0 });
    });

    it("fixture rate_limit (row 14c, never reached) replays an empty stream at exit 1 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT", async () => {
      const report = await runConformanceCase(
        replayCase("rate_limit", "rate_limit", { ok: false, failureCode: "TOOL_FAILURE" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it("fixture rate_limit_error replays an unmapped error type at exit 0 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT or success", async () => {
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

    it("fixture unknown_events replays to OUTPUT_PROTOCOL_ERROR: every unreadable line is counted and none binds a session", async () => {
      const report = await runConformanceCase(
        replayCase("unknown_events", "malformed_output", { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 5 });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it("fixture no_stop (row 4a, Q-85) replays text at exit 0 without a stop step to OUTPUT_PROTOCOL_ERROR", async () => {
      const report = await runConformanceCase(
        replayCase("no_stop", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ summary: "SYNTHETIC: answer without a final step.", unknownEventCount: 0 });
    });

    it("fixture trailing_tool (Q-85) replays a tool_use after the stop step to OUTPUT_PROTOCOL_ERROR", async () => {
      const report = await runConformanceCase(
        replayCase("trailing_tool", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ failureDetail: "tool call after the final stop step" });
    });

    it("fixture session_changed replays to OUTPUT_PROTOCOL_ERROR with the first session id still bound", async () => {
      const report = await runConformanceCase(
        replayCase("session_changed", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    });
  });
});

/**
 * T4.55 (FR-ADP-11): the shared conformance suite over synthetic recorded fixtures (`./fixtures/*.jsonl`, in the
 * `--format json` shapes of the 2026-10-14 live check), replayed by `replay.mjs --provider opencode` in place of the
 * binary, so it passes with no `opencode` installed. The prompt reaches the replay as the argv word after `--`.
 */
describe("opencode conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.55)", () => {
  const caseOf = (kind: ConformanceCase["kind"]): ConformanceCase => {
    const c = opencodeConformanceCases(makeCwd).find((x) => x.kind === kind);
    if (!c) throw new Error(`missing ${kind} case`);
    return c;
  };

  it("covers every FR-ADP-11 kind and passes the full suite", async () => {
    const cases = opencodeConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("success with edit normalizes session, summary and the edit; usage is counted per step", async () => {
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

  it("resumed run passes --session and preserves the native session id", async () => {
    const c = caseOf("resume");
    const inv = c.adapter.resumeArgs(c.binding ?? { provider: "opencode", nativeSessionId: "" }, c.request, c.profile);
    if ("ineligible" in inv) throw new Error(inv.detail);
    expect(inv.argv.slice(-4)).toEqual(["--session", RESUMED_SESSION_ID, "--", "synthetic opencode objective"]);
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: RESUMED_SESSION_ID });
  });

  it("an auth error event ends AUTH_REQUIRED, not a success", async () => {
    const report = await runConformanceCase(caseOf("auth_missing"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("partial mutation leaves the file in the cwd", async () => {
    const c = caseOf("partial_mutation");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(c.request.workspace.cwd, "partial.txt"), "utf8")).toContain("synthetic");
  });

  it("the replay refuses an argv OpenCode would not be given (no --standalone), so a wrong compile cannot pass", async () => {
    const a = replayAdapter("success_edit");
    const req: CompileRequest = {
      runId: "run_opencode_shape",
      objective: "synthetic opencode objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
      bypassApproved: true,
    };
    const broken: OpenCodeAdapter = Object.create(a);
    broken.compile = (r, p) => {
      const inv = a.compile(r, p);
      if ("ineligible" in inv) return inv;
      return { ...inv, argv: inv.argv.filter((w) => w !== "--standalone"), policyFlags: [] };
    };
    const report = await runConformanceCase({
      kind: "success",
      adapter: broken,
      request: req,
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.ok).toBe(false);
    expect(report.result?.ok).toBe(false);
  });
});

describe("opencode Git declaration (T4.57, FR-GIT-01, FR-GIT-02, FR-GIT-09)", () => {
  it("declares that OpenCode documents no Git write control, leaving FR-GIT-03 and FR-GIT-06", () => {
    const c = adapter().gitWriteControl;
    expect(c.kind).toBe("none-documented");
    expect(c.remainingControls).toEqual(["FR-GIT-03", "FR-GIT-06"]);
    expect(c.detail).toBe(GIT_WRITE_CONTROL_DETAIL);
    expect(c.detail).toMatch(/opencode v2\.0\.23/);
    expect(c.detail).toMatch(/ADR-0039/);
    expect(c.detail).toMatch(/FR-GIT-03/);
    expect(c.detail).toMatch(/FR-GIT-06/);
    expect(adapter().gitWriteControl).toBe(OPENCODE_GIT_WRITE_CONTROL);
  });

  it("declares finalize-only commit channel (FR-GIT-09, owner decision 36)", () => {
    const caps = adapter().gitCapabilities;
    expect(caps.commitChannel).toBe("finalize-only");
    expect(caps.detail).toMatch(/FR-GIT-09/);
    expect(caps.detail).toMatch(/OPENCODE_CONFIG_CONTENT/);
    expect(adapter().gitCapabilities).toBe(OPENCODE_GIT_CAPABILITIES);
  });

  it("list_capabilities reports OpenCode's Git-write declaration through MCP", async () => {
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
      const opencode = body.providers.find((p: { provider: string }) => p.provider === "opencode");
      expect(opencode).toBeDefined();
      expect(opencode.git_write_control).toEqual({
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

  it("every compiled invocation carries no git command or credentials in argv/env and passes prompt after --", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const initial = adapter().compile(request({ bypassApproved: true }), profile);
    const resumed = adapter().resumeArgs(
      { provider: "opencode", nativeSessionId: "s-123" },
      request({ bypassApproved: true }),
      profile,
    );
    for (const [name, inv] of [
      ["initial", initial],
      ["resumed", resumed],
    ] as const) {
      if (isIneligible(inv)) throw new Error(`unexpected ineligible: ${inv.detail}`);
      expect(inv.argv.slice(-2)).toEqual(["--", "fix the failing test"]);
      expect(auditInvocation(inv, { profile, bypassApproved: true })).toEqual([]);
      for (const a of inv.argv.slice(1)) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} argv has git: ${a}`).toBe(false);
      }
      for (const a of inv.policyFlags) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} policyFlags has git: ${a}`).toBe(false);
      }
      expect(inv.envAllowlist).toEqual(["PATH", "HOME"]);
      for (const k of Object.keys(inv.env)) {
        expect(/GIT|GITHUB|GH|OPENCODE_AUTH|OPENCODE_CONFIG/.test(k), `${name} env: ${k}`).toBe(false);
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
          GIT_AUTHOR_NAME: "OpenCode Dev",
          GIT_AUTHOR_EMAIL: "opencode@example.test",
          GIT_COMMITTER_NAME: "OpenCode Dev",
          GIT_COMMITTER_EMAIL: "opencode@example.test",
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
    const real = createProbeRunner();
    const probeRunner: ProbeRunner = async (argv, opts) => {
      if (argv.includes("auth") && argv.includes("list")) {
        return {
          stdout: JSON.stringify([{ id: "opencode", name: "Synthetic", connections: [{ type: "oauth" }] }]),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      return real(argv, opts);
    };
    const lifecycle = new RunLifecycle({
      ledger,
      workspace,
      artifacts,
      adapters: new AdapterRegistry().register(replay),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
      finalizePublisher,
      probeRunner,
    });
    lifecycle.start();

    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "write a file with opencode",
        workspace: repo,
        trustProfile: "privileged",
        provider: "opencode",
        project: {
          id: "test-project",
          name: "Test Project",
          environment_kind: "host",
          context_id: "primary",
          base_ref: "main",
          effective_max_profile: "privileged",
          writable: true,
          identity: { name: "OpenCode Dev", email: "opencode@example.test" },
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
