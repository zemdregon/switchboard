/**
 * T4.52 (TDD §4.6): the OpenCode module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `opencode` binary is run; probe output is the shape the 2026-10-14 live check recorded (`opencode v2.0.23`).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
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
  OPENCODE_BYPASS_NOT_APPROVED,
  OPENCODE_BYPASS_OUTSIDE_PRIVILEGED,
  OPENCODE_GIT_CAPABILITIES,
  OPENCODE_GIT_WRITE_CONTROL,
  OPENCODE_PRIVILEGED_NEEDS_BYPASS,
  OpenCodeAdapter,
  TEXT_ONLY_RESULT_SUMMARY,
} from "./adapter.js";
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
        expect(r.policyFlags, label).toEqual(["--standalone", "--auto"]);
        // `--auto` is the one bypass-class flag (ADR-0077): refused without the approved context, admitted with it.
        expect(auditInvocation(r), label).toEqual(["--auto"]);
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

  it("puts the prompt last after `--` and never emits a flag the TDD §4.6 rules exclude", () => {
    const r = compiled();
    expect(r.argv).toEqual([EXE, "run", "--format", "json", "--standalone", "--auto", "--", "fix the failing test"]);
    const never = ["--continue", "-c", "--fork", "--server", "--share", "--attach", "--model", "-m", "--agent"];
    for (const a of r.argv.slice(1)) expect(never.includes(a), a).toBe(false);
    // ADR-0077 (2026-10-21): the approved bypass cell carries `--auto` exactly once, so OpenCode's own permission
    // system does not refuse an out-of-tree path in a non-interactive run.
    expect(r.argv.filter((a) => a === "--auto")).toHaveLength(1);
    expect(r.policyFlags).toContain("--auto");
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
    const ctx = { profile: privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    expect(auditInvocation(r, ctx)).toEqual([]);
    // Without the approved context the audit refuses the cell's own `--auto` and a bypass-word prompt alike.
    expect(auditInvocation(compiled({ objective: "--yolo" }))).toEqual(["--auto", "--yolo"]);
  });

  it("an option-like model, an unapproved bypass and a missing binary are Ineligible with a reason", () => {
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    // ADR-0077: a plain model id compiles to `--model <id>` before `--`; an option-like one is refused.
    expect(adapter().compile(request({ model: "x/y", bypassApproved: true }), approved)).toMatchObject({
      policyFlags: ["--standalone", "--auto", "--model", "x/y"],
    });
    expect(adapter().compile(request({ model: "-x", bypassApproved: true }), approved)).toMatchObject({
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
    expect(auditInvocation({ ...base, argv: [...base.argv, "--auto-review"] })).toEqual(["--auto", "--auto-review"]);
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

  it("passes the version gate for the validated version now that `adapters validate` passed one (ADR-0009, T4.58)", () => {
    const registry = new AdapterRegistry();
    expect(registry.gate("opencode", "2.0.23").eligible).toBe(true);
    for (const v of ["2.1.0", "1.0.0", "0.0.0", null]) {
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

  it("harness and backing provider mismatch per T4.6 (FR-ADP-10): structured backing_provider is reported, never derived from display name", () => {
    // 1. Without backing_provider in step_start (the documented T4.51 shape): backingProvider is unset
    const standard = parse([START, TEXT("ok"), FINISH("stop")]);
    const standardBound = standard.events.find((e) => e.kind === "session_bound");
    expect(standardBound).toBeDefined();
    expect(standardBound).not.toHaveProperty("backingProvider");
    expect(standardBound).not.toHaveProperty("model");

    // 2. With backing_provider and model in step_start (T4.6: harness 'opencode' fronting another provider, e.g. 'backing-x'):
    const fronted = parse([
      line(
        "step_start",
        { id: "prt_s1", type: "step-start" },
        {
          model: "Synthetic Model 1",
          backing_provider: "backing-x",
        },
      ),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    const frontedBound = fronted.events.find((e) => e.kind === "session_bound");
    expect(frontedBound).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: "Synthetic Model 1",
      backingProvider: "backing-x",
    });

    // 3. Alternative camelCase spelling backingProvider is accepted
    const camel = parse([
      line(
        "step_start",
        { id: "prt_s1", type: "step-start" },
        {
          model: "Synthetic Model 1",
          backingProvider: "backing-y",
        },
      ),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    expect(camel.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: "Synthetic Model 1",
      backingProvider: "backing-y",
    });

    // 4. Non-string model and backing_provider are dropped, not coerced
    const nonStr = parse([
      line(
        "step_start",
        { id: "prt_s1", type: "step-start" },
        {
          model: 12345,
          backing_provider: { vendor: "invalid" },
        },
      ),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    const nonStrBound = nonStr.events.find((e) => e.kind === "session_bound");
    expect(nonStrBound).toEqual({ kind: "session_bound", nativeSessionId: SID });

    // 5. Long strings are clipped to 128 characters
    const longVal = "x".repeat(150);
    const clipped = parse([
      line(
        "step_start",
        { id: "prt_s1", type: "step-start" },
        {
          model: longVal,
          backing_provider: longVal,
        },
      ),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    expect(clipped.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: `${"x".repeat(128)}…`,
      backingProvider: `${"x".repeat(128)}…`,
    });

    // Verify end-to-end usage observation records harness 'opencode' alongside backingProvider 'backing-x' (T4.6, FR-ADP-10)
    const usageRows = usageObservationsFromEvents(fronted.events, { runId: "run_t46_opencode", provider: "opencode" });
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      runId: "run_t46_opencode",
      provider: "opencode",
      harness: "opencode",
      backingProvider: "backing-x",
      model: "Synthetic Model 1",
      metrics: { input: 10, output: 3, reasoning: 1, cache_read: 4, cache_write: 0, cost_usd: 0.001 },
    });
  });

  it("a run that exits 0 with text and a non-stop step_finish is not a success (Q-85); text only is (owner decision 68)", () => {
    const { a, events } = parse([START, TEXT("x"), FINISH("tool-calls")]);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    const textOnly = parse([START, TEXT("ok")]);
    expect(textOnly.a.extractResult(textOnly.events, EXIT0)).toMatchObject({ ok: true, summary: "ok" });
  });

  it("only an exact string stop reason emits a result (Q-85; mirrors Grok T4.23)", () => {
    // Synthetic variants of the recorded reason field, not claims of native refusal shapes.
    for (const reason of [
      "STOP",
      "stop ",
      " stop",
      "stop\n",
      "stopped",
      "end_turn",
      "",
      null,
      true,
      0,
      ["stop"],
      { reason: "stop" },
    ]) {
      const { a, events, state } = parse([
        START,
        TEXT("stop: completed successfully"),
        line("step_finish", { reason }),
      ]);
      // The text before it emits the owner-decision-68 text-only result; the step_finish adds none and cancels it.
      expect(
        events.filter((e) => e.kind === "result" && e.summary !== TEXT_ONLY_RESULT_SUMMARY),
        JSON.stringify(reason),
      ).toEqual([]);
      expect(state.unknownEvents).toBe(typeof reason === "string" ? 0 : 1);
      expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    }
    const { a, events } = parse([START, FINISH("stop")]);
    expect(events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: true }]);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: true });
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

  it("a structured provider error after a stop cannot be erased by another stop or success text", () => {
    for (const [type, code] of [
      ["provider.no-route", "MODEL_UNAVAILABLE"],
      ["provider.quota", "QUOTA_EXHAUSTED"],
      ["provider.auth", "AUTH_REQUIRED"],
      ["synthetic.failure", "TOOL_FAILURE"],
    ] as const) {
      for (const tail of [[], [TEXT("completed successfully"), FINISH("stop", "prt_f2")]]) {
        const { a, events } = parse([START, FINISH("stop"), ERROR(type, "synthetic late failure"), ...tail]);
        expect(a.extractResult(events, EXIT0), `${type}, tail=${tail.length}`).toMatchObject({
          ok: false,
          failureCode: code,
          nativeSessionId: SID,
          unknownEventCount: 0,
        });
      }
    }
  });

  it("native errors remain failures in either stream order, with the first error determining the code", () => {
    const auth = ERROR("provider.auth", "Not signed in");
    const model = ERROR("provider.no-route", "Couldn't find route to model");
    for (const [first, second, code] of [
      [auth, model, "AUTH_REQUIRED"],
      [model, auth, "MODEL_UNAVAILABLE"],
    ] as const) {
      for (const lines of [
        [START, first, second, FINISH("stop")],
        [START, FINISH("stop"), first, second],
        [START, first, FINISH("stop"), second],
      ]) {
        const { a, events } = parse(lines);
        expect(a.extractResult(events, EXIT0), JSON.stringify(lines)).toMatchObject({
          ok: false,
          failureCode: code,
          nativeSessionId: SID,
          unknownEventCount: 0,
        });
      }
    }
  });

  it("unknown envelopes cannot bind a session or smuggle status and usage before or after stop", () => {
    const envelope = JSON.stringify({
      type: "synthetic_future_event",
      sessionId: "spoofed_session",
      session_id: "spoofed_session",
      subtype: "success",
      is_error: false,
      reason: "stop",
      ok: true,
      model: "spoofed-model",
      backing_provider: "spoofed-vendor",
      tokens: { input: 999, output: 999 },
      error: { type: "provider.auth", message: "Not signed in" },
      part: {
        type: "synthetic",
        sessionId: "spoofed_part_session",
        session_id: "spoofed_part_session",
        reason: "stop",
        tokens: { input: 999 },
      },
    });
    for (const lines of [
      [envelope],
      [envelope, START, TEXT("ok"), FINISH("stop")],
      [START, TEXT("ok"), FINISH("stop"), envelope],
    ]) {
      const { a, state, events } = parse(lines);
      expect(state.unknownEvents).toBe(1);
      expect(events.filter((e) => e.kind === "unknown")).toEqual([
        { kind: "unknown", rawType: "synthetic_future_event" },
      ]);
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("spoofed_session");
      expect(serialized).not.toContain("spoofed_part_session");
      expect(serialized).not.toContain("spoofed-model");
      expect(serialized).not.toContain("spoofed-vendor");
      expect(serialized).not.toContain("999");
      const result = a.extractResult(events, EXIT0);
      if (lines.length === 1) {
        expect(result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 1 });
        expect(result).not.toHaveProperty("nativeSessionId");
        expect(events).toHaveLength(1);
      } else {
        expect(result).toMatchObject({
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: SID,
          unknownEventCount: 1,
        });
        expect(events.filter((e) => e.kind === "usage")).toEqual([
          {
            kind: "usage",
            source: "provider_reported",
            metrics: { input: 10, output: 3, reasoning: 1, cache_read: 4, cache_write: 0, cost_usd: 0.001 },
          },
        ]);
      }
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
      "--auto",
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

  it("resumeArgs accepts valid alphanumeric, UUID and delimited session IDs and refuses unsafe or flag-like shapes", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const req = request({ bypassApproved: true });

    // Valid IDs: UUID, alphanumeric with ., _, :, - and up to 256 chars
    for (const validId of ["0c1d5f2e-7c1a-4b66-9d0c-1f5b8a3a9e11", "session_123.456:789-abc", "A", "a".repeat(256)]) {
      const r = a.resumeArgs({ provider: "opencode", nativeSessionId: validId }, req, approved);
      expect("ineligible" in r, validId).toBe(false);
      if (!("ineligible" in r)) {
        expect(r.argv.slice(-4)).toEqual(["--session", validId, "--", "fix the failing test"]);
      }
    }

    // Unsafe IDs: empty, leading dash/flag, spaces, control chars, shell metachars, length > 256
    for (const unsafeId of [
      "",
      "-s",
      "--session",
      "--auto",
      "-dangerous",
      "session id",
      "session\nid",
      "session\tid",
      "../escape",
      "foo/bar",
      "/root",
      "; rm -rf /",
      "$SESSION",
      "`whoami`",
      "session\x00null",
      "a".repeat(257),
    ]) {
      const r = a.resumeArgs({ provider: "opencode", nativeSessionId: unsafeId }, req, approved);
      expect(r, JSON.stringify(unsafeId)).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: "native session id is not a safe single argument",
      });
    }
  });

  it("resumeArgs preserves request cwd and mirrors compile policyFlags, env and audit", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const req = request({ workspace: { cwd: "/custom/workspace/dir", writable: true }, bypassApproved: true });
    const id = "00000000-0000-4000-8000-000000000042";
    const resumed = a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, approved);
    expect("ineligible" in resumed).toBe(false);
    if ("ineligible" in resumed) return;
    expect(resumed.cwd).toBe("/custom/workspace/dir");
    expect(resumed.argv.slice(-4)).toEqual(["--session", id, "--", "fix the failing test"]);
    const first = a.compile(req, approved);
    expect("ineligible" in first).toBe(false);
    if ("ineligible" in first) return;
    expect(resumed.policyFlags).toEqual(first.policyFlags);
    expect(resumed.env).toEqual(first.env);
    expect(resumed.envAllowlist).toEqual(first.envAllowlist);
    expect(auditInvocation(resumed, { profile, bypassApproved: true })).toEqual([]);
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
        const resumed = a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, profile);
        const label = JSON.stringify({ scope, bypassApproved });
        if ("ineligible" in first) {
          expect(resumed, label).toEqual(first);
        } else {
          compiledCount += 1;
          // The entire invocation must stay identical, with the native resume pair inserted before the prompt.
          expect(resumed, label).toEqual({
            ...first,
            argv: [...first.argv.slice(0, -2), "--session", id, ...first.argv.slice(-2)],
          });
        }
      }
    }
    expect(compiledCount).toBe(1);
  });

  it("resumeArgs rejects foreign provider bindings and ineligible profiles with exact reasons", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const req = request({ bypassApproved: true });
    const id = "00000000-0000-4000-8000-000000000042";

    // Foreign providers
    for (const provider of ["claude", "codex", "grok", "antigravity", "cursor", "kimi", "muse", "fake", "other"]) {
      expect(a.resumeArgs({ provider: provider as ProviderId, nativeSessionId: id }, req, approved)).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: `binding is for ${provider}`,
      });
    }

    // Ineligible non-privileged profiles
    for (const name of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
      expect(a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, profileOf(name))).toMatchObject({
        ineligible: true,
        reason: "PROFILE_UNSUPPORTED",
      });
    }

    // Bypass approved outside privileged
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, {
        ...profileOf("edit-untrusted"),
        bypassApproved: true,
      }),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: OPENCODE_BYPASS_OUTSIDE_PRIVILEGED,
    });

    // Privileged without approved scope binding
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, {
        name: "privileged",
        fileAccess: "scoped",
        shell: "scoped",
        network: "scoped",
        repoConfig: "scoped",
        bypassApproved: true,
      }),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: "privileged without an approved scope binding (LLD §3.1)",
    });

    // Privileged without bypass
    const noBypass = privilegedProfile({ ...BYPASS_SCOPE, bypass: false });
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, { ...noBypass, bypassApproved: true }),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: OPENCODE_PRIVILEGED_NEEDS_BYPASS,
    });

    // Privileged with bypass but not approved
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, request({ bypassApproved: false }), profile),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: OPENCODE_BYPASS_NOT_APPROVED,
    });

    // Privileged read-only files
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, {
        ...privilegedProfile({ ...BYPASS_SCOPE, files: { access: "read-only" } }),
        bypassApproved: true,
      }),
    ).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });

    // Unwritable workspace
    expect(
      a.resumeArgs(
        { provider: "opencode", nativeSessionId: id },
        request({ workspace: { cwd: "/work", writable: false }, bypassApproved: true }),
        approved,
      ),
    ).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });

    // Narrow shell mode
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, {
        ...privilegedProfile({ ...BYPASS_SCOPE, shell: { mode: "none" } }),
        bypassApproved: true,
      }),
    ).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });

    // Narrow network mode
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, {
        ...privilegedProfile({ ...BYPASS_SCOPE, network: { mode: "off" } }),
        bypassApproved: true,
      }),
    ).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });

    // Narrow repository_config mode
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, {
        ...privilegedProfile({ ...BYPASS_SCOPE, repository_config: { mode: "disabled" } }),
        bypassApproved: true,
      }),
    ).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });

    // Requested model
    expect(
      a.resumeArgs(
        { provider: "opencode", nativeSessionId: id },
        request({ model: "-x", bypassApproved: true }),
        approved,
      ),
    ).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });

    // Git write risks in shell allowlist
    expect(
      a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, { ...approved, shellAllowlist: ["git commit"] }),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
    });

    // Missing executable
    const noExe = new OpenCodeAdapter({ pathEnv: "" });
    expect(noExe.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, approved)).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });
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

  it("__proto__ smuggling of type or sessionID fails closed as unknown and does not bind session", () => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const doc = JSON.stringify({
      __proto__: { type: "step_finish", sessionID: SID, part: { reason: "stop" } },
    });
    const ev = a.parseEvent(doc, state);
    expect(ev).toEqual([{ kind: "unknown", rawType: "none" }]);
    expect(state.nativeSessionId).toBeUndefined();
    expect(state.unknownEvents).toBe(1);
    expect(a.extractResult(ev, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      unknownEventCount: 1,
    });
  });

  it("malformed step_start missing part or with invalid part.type fails closed as unknown", () => {
    const a = adapter();
    const s1: ParseState = { lines: 0, unknownEvents: 0 };
    const ev1 = a.parseEvent(JSON.stringify({ type: "step_start", timestamp: 1, sessionID: SID }), s1);
    expect(ev1).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "unknown", rawType: "step_start" },
    ]);
    expect(s1.unknownEvents).toBe(1);

    const s2: ParseState = { lines: 0, unknownEvents: 0 };
    const ev2 = a.parseEvent(
      JSON.stringify({ type: "step_start", timestamp: 1, sessionID: SID, part: { type: "not-step-start" } }),
      s2,
    );
    expect(ev2).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "unknown", rawType: "step_start:not-step-start" },
    ]);
    expect(s2.unknownEvents).toBe(1);
  });

  it("non-string step_start part.type is unreadable even before a clean stop; an omitted type remains accepted", () => {
    for (const type of [null, false, 0, [], ["step-start"], { type: "step-start" }]) {
      const { a, state, events } = parse([
        START,
        JSON.stringify({ type: "step_start", sessionID: SID, part: { type } }),
        TEXT("ok"),
        FINISH("stop"),
      ]);
      expect(events.filter((e) => e.kind === "unknown")).toEqual([{ kind: "unknown", rawType: "step_start" }]);
      expect(state.unknownEvents).toBe(1);
      expect(a.extractResult(events, EXIT0)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        unknownEventCount: 1,
        nativeSessionId: SID,
      });
    }
    const omitted = parse([
      JSON.stringify({ type: "step_start", sessionID: SID, part: {} }),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    expect(omitted.a.extractResult(omitted.events, EXIT0)).toMatchObject({ ok: true, unknownEventCount: 0 });
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
    const EXIT2: ExitInfo = { ...EXIT0, exitCode: 2 };
    const EXIT137: ExitInfo = { ...EXIT0, exitCode: 137 };
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
      expect(a.extractResult(events, EXIT2), label).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
      expect(a.extractResult(events, EXIT137), label).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
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
    for (const name of ["bash", "synthetic_exec", "sh", ""]) {
      const { a, events } = parse([START, TOOL(name, { command: "git push origin main" }), TEXT("ok"), FINISH("stop")]);
      const call = events.find((e) => e.kind === "tool_call");
      expect(call, name).toEqual({ kind: "tool_call", tool: "shell", name, command: "git push origin main" });
      const guarded = events.map((e) => guardEvent(e, ctx));
      expect(a.extractResult(guarded, EXIT0), name).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    }
    // A command outranks filePath and path: the call is a shell tool and reaches the guard.
    const pathAndCmd = parse([
      START,
      TOOL("shell", { filePath: "src/safe.ts", path: "src/safe.ts", command: "git push origin main" }),
      FINISH("stop"),
    ]);
    expect(pathAndCmd.events.find((e) => e.kind === "tool_call")).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "shell",
      command: "git push origin main",
    });
    expect(
      pathAndCmd.a.extractResult(
        pathAndCmd.events.map((e) => guardEvent(e, ctx)),
        EXIT0,
      ),
    ).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });

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

  it("a guard-flagged Git write ends PERMISSION_BLOCKED at exit 2 and exit 137, and survives subsequent benign calls (T4.56)", () => {
    const ctx = { cwd: "/work/tree", home: "/home/synthetic", bypass: true };
    const guarded = (lines: string[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
    const PUSH = TOOL("shell", { command: "git push origin main" });
    const EXIT2: ExitInfo = { ...EXIT0, exitCode: 2 };
    const EXIT137: ExitInfo = { ...EXIT0, exitCode: 137 };

    // ADR-0039: guard verdict outranks non-zero exit codes 2 and 137.
    expect(adapter().extractResult(guarded([START, PUSH, TEXT("ok"), FINISH("stop")]), EXIT2)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
    expect(adapter().extractResult(guarded([START, PUSH]), EXIT137)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });

    // A benign call after the hostile call does not wash the guard verdict.
    const thenBenign = guarded([
      START,
      PUSH,
      FINISH("tool-calls", "prt_f1"),
      START,
      TOOL("shell", { command: "echo safe" }, "completed"),
      FINISH("stop", "prt_f2"),
    ]);
    expect(adapter().extractResult(thenBenign, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });
    expect(adapter().extractResult(thenBenign, { ...EXIT0, exitCode: 1 })).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });

    // A hostile call swapped back to a benign command in a later update still ends PERMISSION_BLOCKED.
    const swapped = guarded([
      START,
      line("tool_use", {
        id: "prt_u1",
        type: "tool",
        tool: "shell",
        state: { status: "pending", input: { command: "git push origin main" } },
      }),
      line("tool_use", {
        id: "prt_u1",
        type: "tool",
        tool: "shell",
        state: { status: "completed", input: { command: "ls" } },
      }),
      FINISH("stop"),
    ]);
    expect(adapter().extractResult(swapped, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
    });

    // Without the Git write, exit 2 and 137 end TOOL_FAILURE, never PERMISSION_BLOCKED.
    const plain = guarded([START, TOOL("shell", { command: "ls" }), TEXT("ok"), FINISH("stop")]);
    expect(adapter().extractResult(plain, EXIT2)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    expect(adapter().extractResult(plain, EXIT137)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
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

    const perm = adapter().extractResult([{ kind: "permission_denied", tool: "shell" }, endEvent], EXIT0);
    expect(perm).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: "denied: shell" });

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
      name: "shell",
      command: "git push origin main",
      violation: { kind: "git_write", reason: "git push origin main" },
    };
    const DENIED: NormalizedEvent = { kind: "permission_denied", tool: "shell" };
    const AUTH: NormalizedEvent = { kind: "provider_error", category: "auth", message: "provider.auth: 403" };
    const UNKNOWN_ERR: NormalizedEvent = { kind: "provider_error", category: "unknown", message: "boom" };
    const PROTOCOL_ERR: NormalizedEvent = {
      kind: "provider_error",
      category: "protocol",
      message: "session id changed mid-run",
    };
    const FAILED_RESULT: NormalizedEvent = { kind: "result", ok: false, summary: "task failed" };
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
      detail: "denied: shell",
    });
    expect(
      a.classifyFailure(evidence([{ kind: "sandbox_violation", detail: "out of worktree" }, UNKNOWN_ERR])),
    ).toEqual({ code: "SANDBOX_VIOLATION", detail: "out of worktree" });

    // A provider error beats a rate_limit event, a failed result and the exit code; the OpenCode `protocol`
    // category maps to OUTPUT_PROTOCOL_ERROR.
    expect(a.classifyFailure(evidence([UNKNOWN_ERR, { kind: "rate_limit" }]))).toEqual({
      code: "TOOL_FAILURE",
      detail: "unknown: boom",
    });
    expect(a.classifyFailure(evidence([AUTH, FAILED_RESULT]))).toEqual({
      code: "AUTH_REQUIRED",
      detail: "auth: provider.auth: 403",
    });
    expect(a.classifyFailure(evidence([PROTOCOL_ERR], EXIT_1))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "protocol: session id changed mid-run",
    });

    // A rate_limit event and a failed result beat the exit code; the exit code beats "no result".
    expect(a.classifyFailure(evidence([{ kind: "rate_limit" }], EXIT_1))).toEqual({
      code: "RATE_LIMIT_TRANSIENT",
      detail: "rate limit reported",
    });
    expect(a.classifyFailure(evidence([FAILED_RESULT], EXIT_1))).toEqual({
      code: "TOOL_FAILURE",
      detail: "task failed",
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
      message: "provider.auth: 403",
    };
    const denied: NormalizedEvent = { kind: "permission_denied", tool: "shell" };
    const guard: NormalizedEvent = {
      kind: "tool_call",
      tool: "shell",
      name: "shell",
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
          stderrTail: "provider.auth: 403; rate limit reported", // Free text never changes structured precedence.
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

  it("recorded extra fields (error.status, error.response, timestamp, messageID, snapshot) are never usage metrics or events", () => {
    // Live check row 14b/14d recorded status and response on provider errors; row 4c recorded timestamp, messageID
    // and step_start.snapshot. None of those are token keys ([LIVE] 4c: input, output, reasoning, cache.read/write)
    // or a usage event.
    const quota = parse([
      START,
      JSON.stringify({
        type: "error",
        timestamp: 1,
        sessionID: SID,
        error: {
          type: "provider.quota",
          message: "Insufficient account funds",
          status: 402,
          response: { error: { message: "Insufficient account funds", input: 99 } },
        },
      }),
    ]);
    expect(quota.events.filter((e) => e.kind === "usage")).toEqual([]);
    expect(quota.events.find((e) => e.kind === "provider_error")).toEqual({
      kind: "provider_error",
      category: "quota",
      message: "provider.quota: Insufficient account funds",
    });
    expect(JSON.stringify(quota.events)).not.toContain("402");
    expect(quota.a.extractResult(quota.events, { ...EXIT0, exitCode: 1 })).toMatchObject({
      ok: false,
      failureCode: "QUOTA_EXHAUSTED",
    });

    // An HTTP 429 status on an unmapped error type is not RATE_LIMIT_TRANSIENT (status is not read).
    const throttled = parse([
      START,
      JSON.stringify({
        type: "error",
        timestamp: 1,
        sessionID: SID,
        error: { type: "provider.rate_limit", message: "429 Too Many Requests", status: 429 },
      }),
    ]);
    expect(throttled.events.some((e) => e.kind === "rate_limit")).toBe(false);
    expect(throttled.a.extractResult(throttled.events, EXIT0)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
    });

    const finish = parse([START, TEXT("ok"), FINISH("stop")]);
    const usage = finish.events.find((e) => e.kind === "usage");
    expect(usage).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { input: 10, output: 3, reasoning: 1, cache_read: 4, cache_write: 0, cost_usd: 0.001 },
    });
    expect(JSON.stringify(finish.events)).not.toContain("messageID");
    expect(JSON.stringify(finish.events)).not.toContain("snapshot");
    expect(JSON.stringify(finish.events.filter((e) => e.kind === "usage"))).not.toContain("timestamp");
  });

  it("sessionId/session_id never bind a session; model_id/modelId never set model (recorded key is sessionID / model)", () => {
    // Live check row 4c names sessionID and does not name a model. Aliases used by other adapters are not OpenCode's.
    // Parsed alone so a later helper line cannot bind via the recorded `sessionID` key.
    const camel = parse([
      JSON.stringify({
        type: "step_start",
        timestamp: 1,
        sessionId: SID,
        part: { sessionId: SID, id: "prt_s1", type: "step-start" },
      }),
    ]);
    expect(camel.state.nativeSessionId).toBeUndefined();
    expect(camel.events.some((e) => e.kind === "session_bound")).toBe(false);

    const snake = parse([
      JSON.stringify({
        type: "step_start",
        timestamp: 1,
        session_id: SID,
        part: { session_id: SID, id: "prt_s1", type: "step-start" },
      }),
    ]);
    expect(snake.state.nativeSessionId).toBeUndefined();
    expect(snake.events.some((e) => e.kind === "session_bound")).toBe(false);

    const aliasedModel = parse([
      line("step_start", { id: "prt_s1", type: "step-start" }, { model_id: "opencode/gpt-5-nano", modelId: "other" }),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    const bound = aliasedModel.events.find((e) => e.kind === "session_bound");
    expect(bound).toEqual({ kind: "session_bound", nativeSessionId: SID });
    expect(bound).not.toHaveProperty("model");
  });

  it("seenParts WeakMap state is isolated across separate ParseState instances", () => {
    const a = adapter();
    const state1: ParseState = { lines: 0, unknownEvents: 0 };
    const state2: ParseState = { lines: 0, unknownEvents: 0 };
    const finish = FINISH("stop", "prt_f1");

    const ev1 = a.parseEvent(finish, state1);
    expect(ev1.filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(ev1.some((e) => e.kind === "result" && e.ok)).toBe(true);

    // The same part id on a fresh state is counted once, not skipped as already seen on state1.
    const ev2 = a.parseEvent(finish, state2);
    expect(ev2.filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(ev2.some((e) => e.kind === "result" && e.ok)).toBe(true);

    const ev1Repeat = a.parseEvent(finish, state1);
    expect(ev1Repeat.filter((e) => e.kind === "usage")).toHaveLength(0);
    expect(ev1Repeat.some((e) => e.kind === "result" && e.ok)).toBe(true);
  });

  it("clean turn with no text messages leaves summary undefined, not empty string; long text is clipped to 2000 chars", () => {
    const noText = parse([START, FINISH("stop")]);
    expect(noText.a.extractResult(noText.events, EXIT0)).toMatchObject({ ok: true, nativeSessionId: SID });
    expect(noText.a.extractResult(noText.events, EXIT0)).not.toHaveProperty("summary");

    const longText = "a".repeat(2500);
    const long = parse([START, TEXT(longText), FINISH("stop")]);
    const res = long.a.extractResult(long.events, EXIT0);
    expect(res).toMatchObject({ ok: true });
    expect(res.summary).toHaveLength(2000);
    expect(res.summary).toBe(`${"a".repeat(1999)}…`);
  });

  it("bounds clipping: tool name > 64 chars, target > 512 chars", () => {
    const longName = "custom_tool_name_".repeat(5);
    const longPath = `/work/tree/${"p".repeat(600)}`;
    const { events } = parse([
      START,
      TOOL(longName, { filePath: longPath }),
      TOOL("read", { filePath: longPath }),
      FINISH("stop"),
    ]);
    expect(events.find((e) => e.kind === "tool_call" && e.name.startsWith("custom_tool_name_"))).toMatchObject({
      kind: "tool_call",
      tool: "other",
      name: `${longName.slice(0, 64)}…`,
    });
    expect(events.find((e) => e.kind === "tool_call" && e.tool === "read")).toMatchObject({
      kind: "tool_call",
      tool: "read",
      name: "read",
      target: `${longPath.slice(0, 512)}…`,
    });
  });

  // Residual parser branches (synthetic lines, no new capture; as Cursor T4.43 PR #348 and Grok T4.26 PR #351).
  it("an empty text part is readable but adds no message: the run stays clean, nothing is unknown and summary is unset", () => {
    const { a, state, events } = parse([START, TEXT(""), FINISH("stop")]);
    expect(events.some((e) => e.kind === "message")).toBe(false);
    expect(state.unknownEvents).toBe(0);
    expect(a.extractResult(events, EXIT0)).toEqual({ ok: true, nativeSessionId: SID, unknownEventCount: 0 });

    // Empty text never masks real text: the summary is the non-empty part only.
    const mixed = parse([START, TEXT("", "prt_t1"), TEXT("done", "prt_t2"), TEXT("", "prt_t3"), FINISH("stop")]);
    expect(mixed.a.extractResult(mixed.events, EXIT0)).toMatchObject({ ok: true, summary: "done" });
  });

  it("an error with a structured type and no string message keeps the type's category and fails the run", () => {
    const errLine = (error: unknown) => JSON.stringify({ type: "error", timestamp: 1, sessionID: SID, error });
    const cases: [unknown, string, string][] = [
      [{ type: "provider.auth" }, "auth", "AUTH_REQUIRED"],
      [{ type: "provider.quota", message: 402 }, "quota", "QUOTA_EXHAUSTED"],
      [{ type: "provider.no-route", message: null }, "model_unavailable", "MODEL_UNAVAILABLE"],
      [{ type: "provider.rate_limit" }, "unknown", "TOOL_FAILURE"],
    ];
    for (const [error, category, code] of cases) {
      const { a, state, events } = parse([START, errLine(error), TEXT("ok"), FINISH("stop")]);
      const type = (error as { type: string }).type;
      expect(events).toContainEqual({ kind: "provider_error", category, message: `${type}: ` });
      expect(state.unknownEvents).toBe(0);
      expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: false, failureCode: code, nativeSessionId: SID });
    }
  });

  it("the part's sessionID binds when the root has none or a non-string one; an empty id binds nothing and is no error", () => {
    const partOnly = parse([
      JSON.stringify({ type: "step_start", timestamp: 1, part: { sessionID: SID, id: "prt_s1", type: "step-start" } }),
      TEXT("ok"),
      FINISH("stop"),
    ]);
    expect(partOnly.events[0]).toEqual({ kind: "session_bound", nativeSessionId: SID });
    expect(partOnly.a.extractResult(partOnly.events, EXIT0)).toMatchObject({ ok: true, nativeSessionId: SID });

    const nonStringRoot = parse([line("step_start", { id: "prt_s1", type: "step-start" }, { sessionID: 42 })]);
    expect(nonStringRoot.events).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);

    // The root id wins over a different part id on the same line (the root is read first); no mismatch is raised.
    const OTHER = "ses_0000000000000000000000000B";
    const both = parse([line("step_start", { id: "prt_s1", type: "step-start", sessionID: OTHER })]);
    expect(both.events).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);

    // An empty id is treated as absent: nothing bound, no protocol error, and a later real id still binds first.
    const blank = (type: string, part: Record<string, unknown>) =>
      JSON.stringify({ type, timestamp: 1, sessionID: "", part: { sessionID: "", ...part } });
    const empty = parse([blank("step_start", { type: "step-start" }), blank("text", { text: "ok" }), FINISH("stop")]);
    expect(empty.events.filter((e) => e.kind === "provider_error")).toEqual([]);
    expect(empty.events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
    ]);
    const emptyOnly = parse([blank("step_start", { type: "step-start" }), blank("step_finish", { reason: "stop" })]);
    expect(emptyOnly.state.nativeSessionId).toBeUndefined();
    expect(emptyOnly.a.extractResult(emptyOnly.events, EXIT0)).toEqual({ ok: true, unknownEventCount: 0 });
  });

  it("backing_provider and model fall back to the part; a non-string root value shadows the part; later events never report them (T4.6)", () => {
    const START_WITH = (part: Record<string, unknown>, root: Record<string, unknown> = {}) =>
      line("step_start", { id: "prt_s1", type: "step-start", ...part }, root);
    const bound = (lines: string[]) => parse(lines).events.find((e) => e.kind === "session_bound");

    expect(bound([START_WITH({ backing_provider: "backing-p", model: "Part Model" })])).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      model: "Part Model",
      backingProvider: "backing-p",
    });
    expect(bound([START_WITH({ backingProvider: "backing-q" })])).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      backingProvider: "backing-q",
    });
    // The root is read first; the part is only a fallback.
    expect(
      bound([START_WITH({ backing_provider: "part-x", model: "Part" }, { backing_provider: "root-x", model: "Root" })]),
    ).toEqual({ kind: "session_bound", nativeSessionId: SID, model: "Root", backingProvider: "root-x" });
    // A present but non-string root value is not skipped in favour of the part (fail closed: dropped, never merged).
    expect(
      bound([START_WITH({ backing_provider: "part-x", model: "Part" }, { backing_provider: 7, model: false })]),
    ).toEqual({ kind: "session_bound", nativeSessionId: SID });
    // A null root value counts as absent, so the part's value is read.
    expect(bound([START_WITH({ backing_provider: "part-x" }, { backing_provider: null })])).toEqual({
      kind: "session_bound",
      nativeSessionId: SID,
      backingProvider: "part-x",
    });

    // Only the binding event reports them: a later line naming a vendor or model changes nothing (gap pinned).
    const late = parse([
      START,
      line("text", { id: "prt_t1", text: "ok" }, { backing_provider: "late", model: "Late" }),
    ]);
    expect(late.events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
    ]);
  });

  it("a step_finish without a part id is counted every time; one with no readable counters emits no usage but still the result", () => {
    const noId = (reason: string, part: Record<string, unknown> = {}) =>
      line("step_finish", { type: "step-finish", reason, tokens: { input: 2 }, ...part });
    const repeated = parse([START, noId("tool-calls"), noId("stop"), noId("stop")]);
    expect(repeated.events.filter((e) => e.kind === "usage")).toHaveLength(3);

    const bare = parse([
      START,
      TEXT("ok"),
      line("step_finish", { id: "prt_f1", type: "step-finish", reason: "stop", tokens: { cache: "4" }, cost: "0.1" }),
    ]);
    expect(bare.events.some((e) => e.kind === "usage")).toBe(false);
    expect(bare.events.at(-1)).toEqual({ kind: "result", ok: true });
    expect(bare.a.extractResult(bare.events, EXIT0)).toMatchObject({ ok: true, unknownEventCount: 0 });

    // A tokens value that is not an object records only the cost.
    const arrTokens = parse([START, noId("stop", { tokens: [10, 3], cost: 0.002 })]);
    expect(arrTokens.events.find((e) => e.kind === "usage")).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { cost_usd: 0.002 },
    });
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
      // command and target are omitted from the tool_call event. Cursor/Grok aliases (cmd, CommandLine, file_path)
      // are not recorded for OpenCode, so they stay invisible to the ADR-0039 guard.
      const { events } = parse([
        START,
        TOOL("shell", { script: "git commit" }),
        TOOL("shell", { cmd: "git push origin main" }),
        TOOL("shell", { CommandLine: "git commit -am synthetic" }),
        TOOL("read", { file: "foo.txt" }),
        TOOL("read", { file_path: "/tmp/outside.txt" }),
        TOOL("write", { AbsolutePath: "hello.txt" }),
      ]);
      expect(events.filter((e) => e.kind === "tool_call")).toEqual([
        { kind: "tool_call", tool: "shell", name: "shell" },
        { kind: "tool_call", tool: "shell", name: "shell" },
        { kind: "tool_call", tool: "shell", name: "shell" },
        { kind: "tool_call", tool: "read", name: "read" },
        { kind: "tool_call", tool: "read", name: "read" },
        { kind: "tool_call", tool: "edit", name: "write" },
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
    // below, plus `git_write_guard`, `unsafe_session_id`, `sandbox_violation`, `model_unavailable`, `quota_exhausted`,
    // `unsafe_id_after_bound`, `resume_failure`, `error_type_only` and `part_session_empty_text` (as Grok T4.23 and Cursor T4.43). They pin the gaps; a capture
    // (T4.51 extension) must change them.
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

    it("fixture malformed_step_start replays a non-string part.type followed by stop to OUTPUT_PROTOCOL_ERROR", async () => {
      const report = await runConformanceCase(
        replayCase("malformed_step_start", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ unknownEventCount: 1, summary: "SYNTHETIC: apparent success." });
    });

    it("fixture no_stop (row 4a, Q-85 narrowed by owner decision 68) replays text at exit 0 without a stop step to success", async () => {
      const report = await runConformanceCase(
        replayCase("no_stop", "success", {
          ok: true,
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

    it("fixture git_write_guard (ADR-0039) replays a guard-flagged Git write under a stop finish at exit 0 to PERMISSION_BLOCKED", async () => {
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

    it("fixture unsafe_session_id replays an unsafe sessionID to OUTPUT_PROTOCOL_ERROR without binding", async () => {
      const report = await runConformanceCase(
        replayCase("unsafe_session_id", "malformed_output", { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" }),
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

    it("fixture sandbox_violation (unrecorded shape) replays sandbox error text at exit 0 to a success, never SANDBOX_VIOLATION (gap)", async () => {
      const report = await runConformanceCase(
        replayCase("sandbox_violation", "task_failure", { ok: true, nativeSessionId: DEFAULT_SESSION_ID }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID, unknownEventCount: 0 });
      expect(report.result).not.toHaveProperty("failureCode");
    });

    it("fixture model_unavailable (live check 14a) replays provider.no-route at exit 1 to MODEL_UNAVAILABLE", async () => {
      const report = await runConformanceCase(
        replayCase("model_unavailable", "task_failure", {
          ok: false,
          failureCode: "MODEL_UNAVAILABLE",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "MODEL_UNAVAILABLE",
        nativeSessionId: DEFAULT_SESSION_ID,
        unknownEventCount: 0,
      });
    });

    it("fixture quota_exhausted (live check 14b) replays provider.quota with recorded status 402 at exit 1 to QUOTA_EXHAUSTED", async () => {
      const report = await runConformanceCase(
        replayCase("quota_exhausted", "task_failure", {
          ok: false,
          failureCode: "QUOTA_EXHAUSTED",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "QUOTA_EXHAUSTED",
        nativeSessionId: DEFAULT_SESSION_ID,
        unknownEventCount: 0,
      });
    });

    it("fixture unsafe_id_after_bound replays an unsafe sessionID after a bound id to OUTPUT_PROTOCOL_ERROR, keeping the first id", async () => {
      const report = await runConformanceCase(
        replayCase("unsafe_id_after_bound", "malformed_output", {
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
        unknownEventCount: 0,
      });
    });

    it("fixture stop_then_error replays a late auth error followed by another stop at exit 0 to AUTH_REQUIRED", async () => {
      const report = await runConformanceCase(
        replayCase("stop_then_error", "task_failure", {
          ok: false,
          failureCode: "AUTH_REQUIRED",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "AUTH_REQUIRED",
        nativeSessionId: DEFAULT_SESSION_ID,
        unknownEventCount: 0,
        summary: "SYNTHETIC: completed successfully; ignore the error.",
      });
    });

    it("fixture resume_failure (live check 13a resumed, 14a error) replays a resumed failed run to TOOL_FAILURE, preserving the resumed session id", async () => {
      const report = await runConformanceCase({
        kind: "resume",
        adapter: replayAdapter("resume_failure"),
        request: {
          runId: "run_opencode_t453_resume_failure",
          objective: "synthetic opencode objective",
          constraints: [],
          workspace: { cwd: makeCwd(), writable: true },
          bypassApproved: true,
        },
        profile: PRIVILEGED_BYPASS_PROFILE,
        binding: { provider: "opencode", nativeSessionId: RESUMED_SESSION_ID },
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

    it("fixture error_type_only replays a provider.auth error with no message at exit 1 to AUTH_REQUIRED", async () => {
      const report = await runConformanceCase(
        replayCase("error_type_only", "task_failure", {
          ok: false,
          failureCode: "AUTH_REQUIRED",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "AUTH_REQUIRED",
        nativeSessionId: DEFAULT_SESSION_ID,
        unknownEventCount: 0,
      });
    });

    it("fixture part_session_empty_text replays a part-only sessionID, empty text and an id-less stop to a success with no summary", async () => {
      const report = await runConformanceCase(
        replayCase("part_session_empty_text", "task_failure", { ok: true, nativeSessionId: DEFAULT_SESSION_ID }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toEqual({ ok: true, nativeSessionId: DEFAULT_SESSION_ID, unknownEventCount: 0 });
    });
  });
});

describe("opencode parser to resume round trip and residual branches (T4.53 residual; SYNTHETIC lines, parser unchanged)", () => {
  const SID = "ses_0000000000000000000000000A";
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const line = (type: string, part: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type,
      timestamp: 1,
      sessionID: SID,
      part: { sessionID: SID, messageID: "msg_1", ...part },
      ...extra,
    });
  const START = line("step_start", { id: "prt_s1", type: "step-start" });
  const TEXT = (text: string, id = "prt_t1") => line("text", { id, type: "text", text });
  const FINISH = (reason: string, id = "prt_f1") => line("step_finish", { id, type: "step-finish", reason });
  const parse = (lines: string[], a = adapter()) => {
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events: NormalizedEvent[] = lines.flatMap((l) => a.parseEvent(l, state));
    return { a, state, events };
  };
  const approved = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
  const req = request({ bypassApproved: true });

  it("the parser and resumeArgs agree on the session id boundary: 256 characters bind and resume, 257 do neither", () => {
    // One SESSION_ID_RE guards both sides; mutating either side's length limit turns this red.
    const a = adapter();
    for (const [id, safe] of [
      ["a".repeat(256), true],
      ["a".repeat(257), false],
      ["0", true],
      ["-0", false],
      [".a", false],
      [":a", false],
      ["_a", false],
      ["session/1", false],
      ["session 1", false],
      ["session\n1", false],
    ] as const) {
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      const startLine = JSON.stringify({
        type: "step_start",
        timestamp: 1,
        sessionID: id,
        part: { id: "p1", type: "step-start" },
      });
      const finishLine = JSON.stringify({
        type: "step_finish",
        timestamp: 2,
        sessionID: id,
        part: { id: "f1", reason: "stop" },
      });
      const events = [startLine, finishLine].flatMap((l) => a.parseEvent(l, state));
      const r = a.extractResult(events, EXIT0);
      const resumed = a.resumeArgs({ provider: "opencode", nativeSessionId: id }, req, approved);
      const label = `${id.slice(0, 8)} (${id.length})`;
      if (safe) {
        expect(state.nativeSessionId, label).toBe(id);
        expect(r, label).toMatchObject({ ok: true, nativeSessionId: id });
        expect(isIneligible(resumed), label).toBe(false);
        if (!isIneligible(resumed)) {
          expect(resumed.argv.slice(-4), label).toEqual(["--session", id, "--", "fix the failing test"]);
        }
      } else {
        expect(state.nativeSessionId, label).toBeUndefined();
        expect(r, label).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
        expect(r.nativeSessionId, label).toBeUndefined();
        expect(resumed, label).toMatchObject({
          ineligible: true,
          reason: "CAPABILITY_MISSING",
          detail: "native session id is not a safe single argument",
        });
      }
    }
  });

  it("the id a run binds is the id the next resume passes, and a resumed run that rebinds it stays clean", () => {
    const a = adapter();
    const first: ParseState = { lines: 0, unknownEvents: 0 };
    const startLine = JSON.stringify({
      type: "step_start",
      timestamp: 1,
      sessionID: DEFAULT_SESSION_ID,
      part: { id: "p1", type: "step-start" },
    });
    const finishLine = JSON.stringify({
      type: "step_finish",
      timestamp: 2,
      sessionID: DEFAULT_SESSION_ID,
      part: { id: "f1", reason: "stop" },
    });
    const events1 = [startLine, finishLine].flatMap((l) => a.parseEvent(l, first));
    const r1 = a.extractResult(events1, EXIT0);
    expect(r1).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID });
    if (!r1.ok || r1.nativeSessionId === undefined) return;
    const resumed = a.resumeArgs({ provider: "opencode", nativeSessionId: r1.nativeSessionId }, req, approved);
    expect(isIneligible(resumed)).toBe(false);
    if (isIneligible(resumed)) return;
    expect(resumed.argv.slice(-4)).toEqual(["--session", DEFAULT_SESSION_ID, "--", "fix the failing test"]);

    const second: ParseState = { lines: 0, unknownEvents: 0 };
    const events2 = [startLine, finishLine].flatMap((l) => a.parseEvent(l, second));
    const r2 = a.extractResult(events2, EXIT0);
    expect(r2).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID });
  });

  it("privileged without a scope binding is refused by compile and resumeArgs with the same reason", () => {
    const { privilegedScope: _dropped, ...unscoped } = approved;
    const profile: ResolvedProfile = unscoped;
    const expected = {
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: "privileged without an approved scope binding (LLD §3.1)",
    };
    const a = adapter();
    expect(a.compile(req, profile)).toEqual(expected);
    expect(a.resumeArgs({ provider: "opencode", nativeSessionId: DEFAULT_SESSION_ID }, req, profile)).toEqual(expected);

    // Provider and id checks still take precedence: foreign or unsafe binding names its own reason.
    expect(a.resumeArgs({ provider: "codex", nativeSessionId: DEFAULT_SESSION_ID }, req, profile)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: "binding is for codex",
    });
    expect(a.resumeArgs({ provider: "opencode", nativeSessionId: "--auto" }, req, profile)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: "native session id is not a safe single argument",
    });
  });

  it("ParseState.lines counts every string line (valid, malformed, unknown, primitives) and ignores non-string inputs", () => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    a.parseEvent(JSON.stringify({ type: "step_start", sessionID: SID, part: { type: "step-start" } }), state);
    a.parseEvent("malformed { not json", state);
    a.parseEvent(JSON.stringify({ type: "future_telemetry_event" }), state);
    a.parseEvent('"string primitive"', state);
    a.parseEvent("12345", state);
    a.parseEvent("true", state);
    a.parseEvent(JSON.stringify({ type: "text", sessionID: SID, part: { text: "hello" } }), state);
    a.parseEvent(JSON.stringify({ type: "step_finish", sessionID: SID, part: { reason: "stop" } }), state);

    expect(state.lines).toBe(8);
    // Non-string input (e.g. ACP message) returns [] and does NOT increment lines
    const acp = a.parseEvent({ jsonrpc: "2.0", method: "init" } as never, state);
    expect(acp).toEqual([]);
    expect(state.lines).toBe(8);
  });

  it("empty string root model and backing_provider shadow part fallbacks; null values fall through", () => {
    const a = adapter();
    // 1. Root model="" shadows part.model, leaving model unset
    const s1: ParseState = { lines: 0, unknownEvents: 0 };
    const ev1 = a.parseEvent(
      JSON.stringify({
        type: "step_start",
        sessionID: SID,
        model: "",
        part: { id: "p1", type: "step-start", model: "part-model-1" },
      }),
      s1,
    );
    const bound1 = ev1.find((e) => e.kind === "session_bound");
    expect(bound1).toBeDefined();
    expect(bound1).not.toHaveProperty("model");

    // Root model=null falls through to part.model
    const s2: ParseState = { lines: 0, unknownEvents: 0 };
    const ev2 = a.parseEvent(
      JSON.stringify({
        type: "step_start",
        sessionID: SID,
        model: null,
        part: { id: "p1", type: "step-start", model: "part-model-2" },
      }),
      s2,
    );
    expect(ev2.find((e) => e.kind === "session_bound")?.model).toBe("part-model-2");

    // 2. Root backing_provider="" shadows part.backing_provider, leaving backingProvider unset
    const s3: ParseState = { lines: 0, unknownEvents: 0 };
    const ev3 = a.parseEvent(
      JSON.stringify({
        type: "step_start",
        sessionID: SID,
        backing_provider: "",
        part: { id: "p1", type: "step-start", backing_provider: "vendor-fallback" },
      }),
      s3,
    );
    const bound3 = ev3.find((e) => e.kind === "session_bound");
    expect(bound3).toBeDefined();
    expect(bound3).not.toHaveProperty("backingProvider");

    // Root backing_provider=null falls through to part.backing_provider
    const s4: ParseState = { lines: 0, unknownEvents: 0 };
    const ev4 = a.parseEvent(
      JSON.stringify({
        type: "step_start",
        sessionID: SID,
        backing_provider: null,
        part: { id: "p1", type: "step-start", backing_provider: "vendor-via-part" },
      }),
      s4,
    );
    expect(ev4.find((e) => e.kind === "session_bound")?.backingProvider).toBe("vendor-via-part");

    // Root backing_provider="" shadows root backingProvider="other"
    const s5: ParseState = { lines: 0, unknownEvents: 0 };
    const ev5 = a.parseEvent(
      JSON.stringify({
        type: "step_start",
        sessionID: SID,
        backing_provider: "",
        backingProvider: "other-vendor",
        part: { id: "p1", type: "step-start" },
      }),
      s5,
    );
    const bound5 = ev5.find((e) => e.kind === "session_bound");
    expect(bound5).toBeDefined();
    expect(bound5).not.toHaveProperty("backingProvider");
  });

  it("tool kind exclusivity and container key fallbacks: read/edit never extract command, shell never extracts target", () => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    // 1. read/edit carrying command ignore command
    const readWithCmd = a.parseEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: SID,
        part: { tool: "read", state: { input: { filePath: "a.ts", command: "git push" } } },
      }),
      state,
    );
    expect(readWithCmd.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "read", name: "read", target: "a.ts" },
    ]);

    const editWithCmd = a.parseEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: SID,
        part: { tool: "edit", state: { input: { path: "b.ts", command: "rm -rf /" } } },
      }),
      state,
    );
    expect(editWithCmd.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "edit", name: "edit", target: "b.ts" },
    ]);

    // 2. shell/bash carrying path ignore path
    const shellWithPath = a.parseEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: SID,
        part: { tool: "shell", state: { input: { command: "echo test", filePath: "c.ts", path: "d.ts" } } },
      }),
      state,
    );
    expect(shellWithPath.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "shell", command: "echo test" },
    ]);

    // 3. filePath="" shadows path in read/edit tool
    const shadowedPath = a.parseEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: SID,
        part: { tool: "read", state: { input: { filePath: "", path: "fallback.ts" } } },
      }),
      state,
    );
    expect(shadowedPath.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "read", name: "read", target: "" },
    ]);

    // 4. filePath=null falls through to path
    const nullFilePath = a.parseEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: SID,
        part: { tool: "read", state: { input: { filePath: null, path: "fallback.ts" } } },
      }),
      state,
    );
    expect(nullFilePath.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "read", name: "read", target: "fallback.ts" },
    ]);

    // 5. Unmapped tool with only target/path and no command remains tool: "other" with no target extracted
    const unmappedWithPath = a.parseEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: SID,
        part: { tool: "custom_analyzer", state: { input: { path: "file.ts", filePath: "file.ts" } } },
      }),
      state,
    );
    expect(unmappedWithPath.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "custom_analyzer" },
    ]);
  });

  it("token metrics parsing handles zero values, non-finite numbers, and invalid cache objects", () => {
    const a = adapter();
    const s1: ParseState = { lines: 0, unknownEvents: 0 };
    // Finite zeroes are valid non-negative metrics
    const zeroMetrics = a.parseEvent(
      JSON.stringify({
        type: "step_finish",
        sessionID: SID,
        part: {
          id: "f_zero",
          reason: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
      s1,
    );
    expect(zeroMetrics.find((e) => e.kind === "usage")).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
    });

    // Non-finite values (Infinity, NaN) and non-object cache are dropped
    const s2: ParseState = { lines: 0, unknownEvents: 0 };
    const invalidMetrics = a.parseEvent(
      JSON.stringify({
        type: "step_finish",
        sessionID: SID,
        part: {
          id: "f_inv",
          reason: "stop",
          cost: "0.01",
          tokens: { input: null, output: {}, reasoning: false, cache: "not an object" },
        },
      }),
      s2,
    );
    expect(invalidMetrics.some((e) => e.kind === "usage")).toBe(false);
  });

  it("error event variations: null error, primitive messages, non-string messages and unmapped categories", () => {
    const a = adapter();
    // 1. error: null or missing error field counts as unknown event
    const s1: ParseState = { lines: 0, unknownEvents: 0 };
    const evNull = a.parseEvent(JSON.stringify({ type: "error", sessionID: SID, error: null }), s1);
    expect(evNull).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "unknown", rawType: "error" },
    ]);
    expect(s1.unknownEvents).toBe(1);

    // 2. error with message only and no type
    const s2: ParseState = { lines: 0, unknownEvents: 0 };
    const evMsgOnly = a.parseEvent(
      JSON.stringify({ type: "error", sessionID: SID, error: { message: "connection reset by peer" } }),
      s2,
    );
    expect(evMsgOnly.find((e) => e.kind === "provider_error")).toEqual({
      kind: "provider_error",
      category: "unknown",
      message: "error: connection reset by peer",
    });

    // 3. error with array payload
    const s3: ParseState = { lines: 0, unknownEvents: 0 };
    const evArr = a.parseEvent(JSON.stringify({ type: "error", sessionID: SID, error: ["server", "maintenance"] }), s3);
    expect(evArr.find((e) => e.kind === "provider_error")).toEqual({
      kind: "provider_error",
      category: "unknown",
      message: '["server","maintenance"]',
    });
  });

  it("extractResult joins multiple text messages with newlines and summary takes the last 2000 characters", () => {
    const a = adapter();
    const head = "h".repeat(1200);
    const tail = "t".repeat(1200);
    const { events } = parse([
      START,
      line("text", { id: "t1", text: head }),
      line("text", { id: "t2", text: tail }),
      FINISH("stop"),
    ]);
    const r = a.extractResult(events, EXIT0);
    expect(r.ok).toBe(true);
    expect(r.summary).toHaveLength(2000);
    const full = `${head}\n${tail}`;
    expect(r.summary).toBe(full.slice(-2000));
  });

  it("trailing tool_use after stop vs non-tool unknown event after stop have distinct failure details", () => {
    const a = adapter();
    // 1. Trailing tool_use with no tool name parses as unknown with rawType "tool_use" -> detail "tool call after the final stop step"
    const trailingTool = parse([
      START,
      TEXT("ok"),
      FINISH("stop"),
      JSON.stringify({ type: "tool_use", sessionID: SID, part: {} }),
    ]);
    const rTool = a.extractResult(trailingTool.events, EXIT0);
    expect(rTool).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the final stop step",
    });

    // 2. Trailing step_start without part parses as unknown with rawType "step_start" -> detail "1 unreadable event(s) in the stream"
    const trailingStep = parse([
      START,
      TEXT("ok"),
      FINISH("stop"),
      JSON.stringify({ type: "step_start", sessionID: SID }),
    ]);
    const rStep = a.extractResult(trailingStep.events, EXIT0);
    expect(rStep).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "1 unreadable event(s) in the stream",
    });
  });

  it("supervisor exit outcomes: timeout kinds and empty-stream exit 0", () => {
    const a = adapter();
    const baseExit = { exitCode: null, signal: null, expectedExitCodes: [0] };
    // Idle timeout
    expect(a.extractResult([], { ...baseExit, outcome: "timeout", timeoutKind: "idle" })).toMatchObject({
      ok: false,
      failureCode: "PROCESS_TIMEOUT",
      failureDetail: "idle timeout",
    });
    // Wall-clock timeout
    expect(a.extractResult([], { ...baseExit, outcome: "timeout", timeoutKind: "wall_clock" })).toMatchObject({
      ok: false,
      failureCode: "PROCESS_TIMEOUT",
      failureDetail: "wall_clock timeout",
    });
    // Clean exit 0 with empty event stream ends OUTPUT_PROTOCOL_ERROR with detail "no result event"
    expect(a.extractResult([], { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] })).toMatchObject(
      {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "no result event",
      },
    );
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

/**
 * T4.53 with T4.6 (FR-ADP-10): a replayed fixture whose backing vendor differs from the harness. SYNTHETIC: native OpenCode
 * output reports no backing vendor ([LIVE] row 4c), so `backing_provider` is the structured key a fronted run would
 * carry, not a recorded field.
 */
describe("opencode backing-provider fixture (T4.53, T4.6, FR-ADP-10)", () => {
  it("a replayed run stores harness opencode and backing vendor side by side and shows both in get_run", async () => {
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
          GIT_AUTHOR_NAME: "OpenCode Dev",
          GIT_AUTHOR_EMAIL: "opencode@example.test",
          GIT_COMMITTER_NAME: "OpenCode Dev",
          GIT_COMMITTER_EMAIL: "opencode@example.test",
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
      workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
      artifacts,
      adapters: new AdapterRegistry().register(replayAdapter("backing_provider")),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
      probeRunner,
    });
    lifecycle.start();
    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "answer through a backing vendor",
        workspace: repo,
        trustProfile: "privileged",
        provider: "opencode",
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });
      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

      // The session_bound event's fields land on the provider binding (T5.3), never inferred from the display name.
      expect(ledger.listProviderBindings(metaSessionId)).toEqual([
        expect.objectContaining({
          provider: "opencode",
          harness: "opencode",
          backing_provider: "backing-x",
          model: "Synthetic Model 1",
          native_session_id: DEFAULT_SESSION_ID,
        }),
      ]);

      const rows = ledger.listUsageObservationsForRun(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "opencode",
        harness: "opencode",
        backing_provider: "backing-x",
        model: "Synthetic Model 1",
        source: "provider_reported",
      });
      expect(buildEnvelope(ledger, done, (s) => s).usage?.reported).toEqual([
        expect.objectContaining({
          harness: "opencode",
          backing_provider: "backing-x",
          model: "Synthetic Model 1",
        }),
      ]);
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  });
});
