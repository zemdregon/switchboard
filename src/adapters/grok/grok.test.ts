/**
 * T4.22 (TDD §4.3): the Grok Build module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `grok` binary is run; probe output is the shape the 2026-10-14 live check recorded (`grok 1.0.50 (...) [stable]`).
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
  NormalizedEvent,
  ParseState,
  ProbeOutput,
  ProbeRunner,
  ResolvedProfile,
  TrustProfile,
} from "../types.js";
import { isIneligible } from "../types.js";
import { GROK_GIT_CAPABILITIES, GROK_GIT_WRITE_CONTROL, GrokAdapter } from "./adapter.js";
import {
  DEFAULT_SESSION_ID,
  grokConformanceCases,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";
import {
  AUTH_LOGGED_IN_PREFIX,
  AUTH_STATUS_ARGS,
  GIT_WRITE_CONTROL_DETAIL,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
} from "./protocol.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-grok-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const EXE = "/opt/synthetic/grok";
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "off" },
  repository_config: { mode: "enabled" },
  bypass: true,
} as const;
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

describe("grok probe and resume (T4.22, T4.23)", () => {
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

  it("resume compiles `-r <id>` through the same matrix and refuses another provider's or an unsafe id", () => {
    const a = adapter();
    expect(
      a.resumeArgs({ provider: "codex", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
    expect(
      a.resumeArgs({ provider: "grok", nativeSessionId: "s" }, request(), profileOf("edit-untrusted")),
    ).toMatchObject({
      reason: "PROFILE_UNSUPPORTED",
    });
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    expect(
      a.resumeArgs({ provider: "grok", nativeSessionId: "--yolo" }, request({ bypassApproved: true }), approved),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: expect.stringContaining("not a safe single argument") });
    const id = "0c1d5f2e-7c1a-4b66-9d0c-1f5b8a3a9e11";
    const r = a.resumeArgs({ provider: "grok", nativeSessionId: id }, request({ bypassApproved: true }), approved);
    expect("ineligible" in r).toBe(false);
    if ("ineligible" in r) return;
    expect(r.argv.slice(-2)).toEqual(["-r", id]);
    const first = a.compile(request({ bypassApproved: true }), approved);
    expect("ineligible" in first).toBe(false);
    if (!("ineligible" in first)) expect(r.policyFlags).toEqual(first.policyFlags);
    expect(auditInvocation(r, { profile, bypassApproved: true })).toEqual([]);
  });
});

describe("grok parser and result (T4.23; SYNTHETIC lines in the shapes the 2026-10-14 live check recorded)", () => {
  const parse = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    return { events: lines.flatMap((l) => a.parseEvent(l, state)), state };
  };
  const EXIT_OK = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] } as const;
  const line = (o: unknown) => JSON.stringify(o);
  const SID = "9f1c2b44-0d5e-4a77-8f3a-2b6c1d0e7a55";
  const END = {
    type: "end",
    stopReason: "end_turn",
    sessionId: SID,
    requestId: "r1",
    usage: { input_tokens: 10, output_tokens: 2 },
    num_turns: 1,
  };

  it("a successful turn: text chunks joined, session id from `end`, usage numbers, result ok", () => {
    const { events } = parse([
      line({ type: "available_commands", tools: ["a", "b"] }),
      line({ type: "thought", data: "private reasoning" }),
      line({ type: "text", data: "Hel" }),
      line({ type: "text", data: "lo" }),
      line({ type: "usage", signature: "s" }),
      line(END),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["message", "message", "session_bound", "usage", "result"]);
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    const r = adapter().extractResult(events, EXIT_OK);
    expect(r).toMatchObject({ ok: true, nativeSessionId: SID, summary: "Hello", unknownEventCount: 0 });
    expect(events.find((e) => e.kind === "usage")).toMatchObject({
      metrics: { input_tokens: 10, output_tokens: 2, num_turns: 1 },
    });
  });

  it("the session id comes only from the structured `end` line, never from text", () => {
    const { events } = parse([
      line({ type: "text", data: `sessionId: ${SID}` }),
      line({ ...END, sessionId: undefined }),
    ]);
    expect(events.some((e) => e.kind === "session_bound")).toBe(false);
    expect(adapter().extractResult(events, EXIT_OK)).not.toHaveProperty("nativeSessionId");
  });

  it("tool_call lines and any unrecognised shape are `unknown`, counted, and never a result", () => {
    const { events, state } = parse([
      line({ type: "tool_call", whatever: 1 }),
      line({ type: "tool_call_update" }),
      line({ type: "mystery" }),
      line({ nothing: true }),
      line({ type: "text" }),
      line({ type: "end" }),
      "[1,2]",
    ]);
    expect(events.every((e) => e.kind === "unknown")).toBe(true);
    expect(state.unknownEvents).toBe(events.length);
    const r = adapter().extractResult(events, EXIT_OK);
    expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 7 });
  });

  it("a stop reason other than end_turn is not success", () => {
    const { events } = parse([line({ ...END, stopReason: "cancelled" })]);
    const r = adapter().extractResult(events, EXIT_OK);
    expect(r).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    expect(r.ok === false && r.failureDetail).toContain("cancelled");
  });

  it("an error line maps its message to a category: not signed in is AUTH_REQUIRED, a bad model MODEL_UNAVAILABLE", () => {
    const signedOut = parse([
      line({
        type: "error",
        message: "Not signed in. To authenticate without a browser, run:\n  grok login --device-code",
      }),
    ]);
    expect(signedOut.events[0]).toMatchObject({ kind: "provider_error", category: "auth" });
    const exit1 = { outcome: "exited", exitCode: 1, signal: null, expectedExitCodes: [0] } as const;
    expect(adapter().extractResult(signedOut.events, exit1)).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
    const badModel = parse([line({ type: "error", message: "Couldn't set model 'x': Invalid params" })]);
    expect(adapter().extractResult(badModel.events, exit1)).toMatchObject({ failureCode: "MODEL_UNAVAILABLE" });
    const other = parse([line({ type: "error", message: "boom" })]);
    expect(adapter().extractResult(other.events, exit1)).toMatchObject({ failureCode: "TOOL_FAILURE" });
  });

  it("a clean `end` after an error line, a non-zero exit or a missing result is never success", () => {
    const afterError = parse([line({ type: "error", message: "boom" }), line(END)]);
    expect(adapter().extractResult(afterError.events, EXIT_OK)).toMatchObject({ ok: false });
    const badExit = { outcome: "exited", exitCode: 1, signal: null, expectedExitCodes: [0] } as const;
    expect(adapter().extractResult(parse([line(END)]).events, badExit)).toMatchObject({ ok: false });
    expect(adapter().extractResult([], EXIT_OK)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    expect(adapter().extractResult([], { ...EXIT_OK, outcome: "timeout", timeoutKind: "wall_clock" })).toMatchObject({
      failureCode: "PROCESS_TIMEOUT",
    });
    expect(adapter().extractResult([], { ...EXIT_OK, outcome: "cancelled" })).toMatchObject({
      failureCode: "CANCELLED",
    });
  });

  it("records only the observed usage counters and clips an unknown line's type", () => {
    const { events } = parse([
      line({
        ...END,
        usage: { input_tokens: 10, reasoning_tokens: 3, total_tokens: 13, surprise: 9, output_tokens: "2" },
      }),
      line({ type: "x".repeat(10_000) }),
    ]);
    expect(events.find((e) => e.kind === "usage")).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { input_tokens: 10, reasoning_tokens: 3, total_tokens: 13, num_turns: 1 },
    });
    const unknown = events.find((e) => e.kind === "unknown");
    expect(unknown?.kind === "unknown" && unknown.rawType.length).toBeLessThanOrEqual(65);
  });

  // Done-when cases whose native shape the T4.21 live check did NOT record (ROADMAP T4.23 stays Partial). Each fixture
  // replays only what the check saw: the `tool_call`/`tool_call_update` field names were not recorded, so those lines
  // carry `type` alone. These pin today's outcome; a capture (T4.21 extension) must change them.
  describe("cases with no recorded native shape (live check 5d, 7g, 8c, 8f)", () => {
    const TOOL_LINES = [line({ type: "tool_call" }), line({ type: "tool_call_update" })];

    it("permission denied without a deny rule (8f: tool cancelled, stopReason `cancelled`, exit 0) is not success", () => {
      const { events } = parse([...TOOL_LINES, line({ ...END, stopReason: "cancelled" })]);
      const r = adapter().extractResult(events, EXIT_OK);
      expect(r).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 2, nativeSessionId: SID });
    });

    it("permission denied by a rule (8c) and a sandbox violation (7g) end `end_turn` at exit 0: NOT detected (gap)", () => {
      // The only signal in both is the tool's own status and text inside an unrecorded `tool_call_update` shape, and
      // FR-ADP-04 forbids reading status from free text, so the parser emits neither `permission_denied` nor
      // `sandbox_violation`. The opaque tool lines are counted, so the run carries `unknownEventCount` > 0.
      const { events } = parse([...TOOL_LINES, line({ type: "text", data: "Permission denied" }), line(END)]);
      expect(events.some((e) => e.kind === "permission_denied" || e.kind === "sandbox_violation")).toBe(false);
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: true, unknownEventCount: 2 });
    });

    it("a rate limit (5d, never forced) has no recognised form: an unrecognised error line or a bare exit is not success", () => {
      const exit1 = { outcome: "exited", exitCode: 1, signal: null, expectedExitCodes: [0] } as const;
      const errorLine = parse([line({ type: "error", message: "SYNTHETIC: too many requests" })]);
      expect(errorLine.events).toEqual([
        { kind: "provider_error", category: "unknown", message: "SYNTHETIC: too many requests" },
      ]);
      expect(adapter().extractResult(errorLine.events, exit1)).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
      });
      expect(adapter().extractResult([], exit1)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
      expect(errorLine.events.some((e) => e.kind === "rate_limit")).toBe(false);
    });

    // The same outcomes replayed end to end from fixture files through the supervisor, so each Done-when case has a
    // fixture: success (`success_edit`), task failure and 8f denial (`task_failure`), malformed (`malformed_output`) and
    // the four below. They pin the gaps; a capture (T4.21 extension) must change them.
    const replayCase = (
      fixture: string,
      kind: ConformanceCase["kind"],
      exp: ConformanceCase["expect"],
    ): ConformanceCase => ({
      kind,
      adapter: replayAdapter(fixture),
      request: {
        runId: "run_grok_t423_fixture",
        objective: "synthetic grok objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: exp,
    });

    it.each([
      ["sandbox_violation", "7g"],
      ["permission_denied_rule", "8c"],
    ])("fixture %s (live check %s) replays to end_turn success with the opaque tool lines counted (gap)", async (f) => {
      const report = await runConformanceCase(
        replayCase(f, "task_failure", { ok: true, nativeSessionId: DEFAULT_SESSION_ID }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: true, unknownEventCount: 2 });
    });

    it("fixture rate_limit (5d, never forced) replays an empty stream at exit 1 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT", async () => {
      const report = await runConformanceCase(
        replayCase("rate_limit", "rate_limit", { ok: false, failureCode: "TOOL_FAILURE" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
    });

    it("fixture unknown_events replays to OUTPUT_PROTOCOL_ERROR: every unknown line is counted and none binds a session", async () => {
      const report = await runConformanceCase(
        replayCase("unknown_events", "malformed_output", { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 4 });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });
  });

  describe("parser hardening (T4.23, synthetic shapes; mirrors Antigravity T4.33)", () => {
    it("a second `end` line fails the run even when both report end_turn", () => {
      const cancelledThenOk = parse([line({ ...END, stopReason: "cancelled" }), line(END)]);
      expect(adapter().extractResult(cancelledThenOk.events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
      });
      const okTwice = parse([line(END), line(END)]);
      expect(adapter().extractResult(okTwice.events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: SID,
      });
      expect(okTwice.events.filter((e) => e.kind === "result").map((e) => e.kind === "result" && e.ok)).toEqual([
        true,
        false,
      ]);
    });

    it("a session id that changes mid-run fails the run and the first id stays bound; an empty id binds nothing", () => {
      const other = "0a0a0a0a-0000-4000-8000-000000000001";
      const { events, state } = parse([line({ ...END, stopReason: "cancelled" }), line({ ...END, sessionId: other })]);
      expect(state.nativeSessionId).toBe(SID);
      expect(events.filter((e) => e.kind === "session_bound")).toHaveLength(1);
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: SID,
      });
      const empty = parse([line({ ...END, sessionId: "" })]);
      expect(empty.events.some((e) => e.kind === "session_bound")).toBe(false);
      expect(adapter().extractResult(empty.events, EXIT_OK)).toMatchObject({ ok: true });
    });

    it("an error line without a string message is still an error, never ignored or unknown", () => {
      for (const message of [undefined, { code: 429 }, ["x"], 1, null]) {
        const { events, state } = parse([line({ type: "error", message }), line(END)]);
        expect(state.unknownEvents, JSON.stringify(message)).toBe(0);
        expect(adapter().extractResult(events, EXIT_OK), JSON.stringify(message)).toMatchObject({
          ok: false,
          failureCode: "TOOL_FAILURE",
        });
      }
    });

    it("unrecorded rate-limit or quota text in an error line is TOOL_FAILURE, never RATE_LIMIT_TRANSIENT or success", () => {
      for (const message of ["429 Too Many Requests", "rate limit reached", "quota exceeded"]) {
        const { events } = parse([line({ type: "error", message }), line(END)]);
        expect(adapter().extractResult(events, EXIT_OK), message).toMatchObject({
          ok: false,
          failureCode: "TOOL_FAILURE",
        });
        expect(
          events.some((e) => e.kind === "rate_limit"),
          message,
        ).toBe(false);
      }
    });

    it("negative, non-finite and non-number usage values are dropped; no usable counter emits no usage", () => {
      const { events } = parse([
        line({
          ...END,
          usage: { input_tokens: -5, output_tokens: "3", reasoning_tokens: null, total_tokens: 24 },
          num_turns: -1,
        }),
      ]);
      expect(events.find((e) => e.kind === "usage")).toEqual({
        kind: "usage",
        source: "provider_reported",
        metrics: { total_tokens: 24 },
      });
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: true });
      // JSON has no Infinity literal; an overflowing number parses to Infinity and is dropped.
      const huge = parse([`{"type":"end","stopReason":"end_turn","usage":{"input_tokens":1e400,"output_tokens":2}}`]);
      expect(huge.events.find((e) => e.kind === "usage")).toMatchObject({ metrics: { output_tokens: 2 } });
      expect(huge.events.find((e) => e.kind === "usage")).not.toHaveProperty("metrics.input_tokens");
      for (const usage of [{}, [24], "24", { input_tokens: -1 }]) {
        const r = parse([line({ ...END, usage, num_turns: undefined })]);
        expect(
          r.events.some((e) => e.kind === "usage"),
          JSON.stringify(usage),
        ).toBe(false);
      }
    });

    // ADR-0039: a guard verdict ends the run in every run, bypass included, and the lifecycle trusts `result.ok`, so a
    // flagged tool_call must not be called clean even with an `end_turn` result at exit 0. The parser emits no
    // `tool_call` yet (shape not recorded), so these feed the guarded event the runner would store.
    it("a guard-flagged Git write with an end_turn result ends PERMISSION_BLOCKED (ADR-0039)", () => {
      const { events } = parse([line({ type: "text", data: "pushed" }), line(END)]);
      const call: NormalizedEvent = { kind: "tool_call", tool: "shell", name: "run", command: "git push origin main" };
      const flagged = guardEvent(call, { cwd: "/w", bypass: true });
      expect(flagged).toMatchObject({ kind: "tool_call", violation: { kind: "git_write" } });
      expect(flagged).not.toHaveProperty("command");
      const r = adapter().extractResult([flagged, ...events], EXIT_OK);
      expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID });
      expect(r.failureDetail).toMatch(/^git write attempted/);
      // An unflagged tool_call leaves a clean turn clean.
      const plain = guardEvent({ ...call, command: "git status" }, { cwd: "/w", bypass: true });
      expect(adapter().extractResult([plain, ...events], EXIT_OK)).toMatchObject({ ok: true });
    });

    it("any guard verdict on a tool_call makes an end_turn result not clean (a provider_state verdict ends SANDBOX_VIOLATION)", () => {
      const { events } = parse([line({ type: "text", data: "ok" }), line(END)]);
      const flagged: NormalizedEvent = {
        kind: "tool_call",
        tool: "read",
        name: "read_file",
        violation: { kind: "provider_state", reason: "synthetic" },
      };
      expect(adapter().extractResult([flagged, ...events], EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "SANDBOX_VIOLATION",
      });
    });

    it("a synthetic tool_call line with command is parsed and guarded, so a Git write ends PERMISSION_BLOCKED (ADR-0039)", () => {
      const { events } = parse([
        line({ type: "tool_call", command: "git push origin main" }),
        line({ type: "text", data: "pushed" }),
        line(END),
      ]);
      const guarded = events.map((e) => guardEvent(e, { cwd: "/w", bypass: true }));
      expect(guarded.some((e) => e.kind === "tool_call")).toBe(true);
      expect(adapter().extractResult(guarded, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });
    });

    it("a tool_call line without tool or command fields remains unknown", () => {
      const { events } = parse([line({ type: "tool_call" }), line({ type: "text", data: "pushed" }), line(END)]);
      expect(events[0]).toMatchObject({ kind: "unknown", rawType: "tool_call" });
    });
  });

  // Synthetic-line hardening that needs no new capture (Delegated, not owner-approved; fail closed). The `tool_call`
  // field names below are the Assumptions the parser already reads, not recorded shapes (ROADMAP T4.23 stays Partial).
  describe("parser hardening (T4.23, synthetic shapes; mirrors Cursor T4.43 and OpenCode T4.53)", () => {
    it("a session id resume could not pass as one safe argument is never bound and fails the run", () => {
      for (const sessionId of ["--yolo", "-r", "a b", "x".repeat(300), "id\nnext", "../etc", "é"]) {
        const { events, state } = parse([line({ ...END, sessionId })]);
        expect(state.nativeSessionId, sessionId).toBeUndefined();
        expect(
          events.some((e) => e.kind === "session_bound"),
          sessionId,
        ).toBe(false);
        const r = adapter().extractResult(events, EXIT_OK);
        expect(r, sessionId).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
        expect(r, sessionId).not.toHaveProperty("nativeSessionId");
      }
    });

    it("an unsafe id after a good one leaves the good id bound and fails the run", () => {
      const { events, state } = parse([line({ ...END, stopReason: "cancelled" }), line({ ...END, sessionId: "-x" })]);
      expect(state.nativeSessionId).toBe(SID);
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: SID,
      });
    });

    it("a non-string sessionId binds nothing and is never coerced", () => {
      for (const sessionId of [42, { id: SID }, [SID], true]) {
        const { events, state } = parse([line({ ...END, sessionId })]);
        expect(state.nativeSessionId, JSON.stringify(sessionId)).toBeUndefined();
        expect(adapter().extractResult(events, EXIT_OK), JSON.stringify(sessionId)).not.toHaveProperty(
          "nativeSessionId",
        );
      }
    });

    it("a tool_call after the `end` line is not success; a guard verdict on it keeps its own code", () => {
      const { events } = parse([line(END), line({ type: "tool_call", command: "ls" })]);
      expect(events.map((e) => e.kind)).toEqual(["session_bound", "usage", "result", "tool_call"]);
      const r = adapter().extractResult(events, EXIT_OK);
      expect(r).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: SID });
      expect(r.ok === false && r.failureDetail).toBe("tool call after the end line");
      const push = parse([line(END), line({ type: "tool_call", command: "git push origin main" })]);
      const guarded = push.events.map((e) => guardEvent(e, { cwd: "/w", bypass: true }));
      expect(adapter().extractResult(guarded, EXIT_OK)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
      // A tool call before `end` leaves a clean turn clean.
      const before = parse([line({ type: "tool_call", command: "ls" }), line(END)]);
      expect(adapter().extractResult(before.events, EXIT_OK)).toMatchObject({ ok: true });
    });

    it("a trailing tool_call the parser cannot read is still a tool call after the `end` line", () => {
      // The bare line is the only `tool_call` shape the live check recorded (row 4b); a shape with no readable field is
      // the same line to the parser. Both parse as `unknown` and must not leave the turn clean.
      for (const call of [{ type: "tool_call" }, { type: "tool_call", input: { command: 7 } }]) {
        const { events } = parse([line(END), line(call)]);
        expect(events.at(-1), JSON.stringify(call)).toEqual({ kind: "unknown", rawType: "tool_call" });
        const r = adapter().extractResult(events, EXIT_OK);
        expect(r, JSON.stringify(call)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
        expect(r.ok === false && r.failureDetail, JSON.stringify(call)).toBe("tool call after the end line");
      }
      // A read-shaped call (target only) after `end` fails the same way.
      const read = parse([line(END), line({ type: "tool_call", tool: "read_file", input: { path: "a.txt" } })]);
      expect(adapter().extractResult(read.events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
      });
      // Other unknown lines, `tool_call_update` and late text after `end` do not trip it.
      const quiet = parse([
        line(END),
        line({ type: "tool_call_update" }),
        line({ type: "text", data: "late" }),
        line({ type: "synthetic_unknown_kind" }),
      ]);
      expect(adapter().extractResult(quiet.events, EXIT_OK)).toMatchObject({ ok: true });
      // The same unreadable line before `end` leaves a clean turn clean (fixtures sandbox_violation.jsonl, row 4b).
      const before = parse([line({ type: "tool_call" }), line(END)]);
      expect(adapter().extractResult(before.events, EXIT_OK)).toMatchObject({ ok: true });
    });

    it("a guard-flagged trailing tool_call ends PERMISSION_BLOCKED at exit 1, after a failed `end` and a second `end`", () => {
      const ctx = { cwd: "/w", bypass: true };
      const guarded = (lines: string[]) => parse(lines).events.map((e) => guardEvent(e, ctx));
      const PUSH = line({
        type: "tool_call",
        tool: "run_terminal_command",
        input: { command: "git push origin main" },
      });
      const EXIT_1 = { ...EXIT_OK, exitCode: 1 } as const;
      // ADR-0039: the guard verdict precedes the unexpected exit, the failed stop reason and the protocol anomaly.
      for (const [label, lines, exit] of [
        ["exit 1", [line(END), PUSH], EXIT_1],
        ["cancelled end", [line({ ...END, stopReason: "cancelled" }), PUSH], EXIT_OK],
        ["second end", [line(END), line(END), PUSH], EXIT_OK],
      ] as const) {
        expect(adapter().extractResult(guarded([...lines]), exit), label).toMatchObject({
          ok: false,
          failureCode: "PERMISSION_BLOCKED",
          nativeSessionId: SID,
        });
      }
      // Without the Git write the same exit-1 trailing call is an unexpected exit, never success.
      const plain = guarded([line(END), line({ type: "tool_call", command: "ls" })]);
      expect(adapter().extractResult(plain, EXIT_1)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    });

    it("only an exact `end_turn` stop reason is success", () => {
      for (const stopReason of ["END_TURN", "end_turn ", " end_turn", "end-turn", ""]) {
        const { events } = parse([line({ ...END, stopReason })]);
        expect(adapter().extractResult(events, EXIT_OK), JSON.stringify(stopReason)).toMatchObject({ ok: false });
      }
      for (const stopReason of [1, null, true, { reason: "end_turn" }]) {
        const { events, state } = parse([line({ ...END, stopReason })]);
        expect(events, JSON.stringify(stopReason)).toEqual([{ kind: "unknown", rawType: "end" }]);
        expect(state.unknownEvents).toBe(1);
        expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ failureCode: "OUTPUT_PROTOCOL_ERROR" });
      }
    });

    it("prototype-named types and a `__proto__` key never smuggle a result or a tool call", () => {
      const { events, state } = parse([
        line({ type: "constructor" }),
        line({ type: "toString" }),
        line({ type: "__proto__" }),
        `{"__proto__":{"type":"end","stopReason":"end_turn","sessionId":"${SID}"}}`,
        `{"type":"end","__proto__":{"stopReason":"end_turn"}}`,
        `{"type":"text","__proto__":{"data":"smuggled"}}`,
      ]);
      expect(events.every((e) => e.kind === "unknown")).toBe(true);
      expect(state.unknownEvents).toBe(6);
      expect(state.nativeSessionId).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain("smuggled");
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
      });
    });

    it("a tool name that matches an Object.prototype member is `other`, never an inherited value", () => {
      for (const tool of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const { events } = parse([line({ type: "tool_call", tool })]);
        expect(events, tool).toEqual([{ kind: "tool_call", tool: "other", name: tool }]);
      }
    });

    it("non-string command, path and tool values are omitted, never coerced (field names are Assumptions)", () => {
      // Pinned gap: a call whose fields are all non-strings stays `unknown`, so the guard cannot see it; it is counted.
      const opaque = [
        { type: "tool_call", command: ["git", "push"] },
        { type: "tool_call", input: { command: 7, path: { p: "/etc" } } },
        { type: "tool_call", tool: 1, path: null },
        { type: "tool_call", input: "git push" },
        `{"type":"tool_call","input":{"__proto__":{"command":"git push"}}}`,
      ];
      const { events, state } = parse(opaque.map((o) => (typeof o === "string" ? o : line(o))));
      expect(events.every((e) => e.kind === "unknown" && e.rawType === "tool_call")).toBe(true);
      expect(state.unknownEvents).toBe(opaque.length);
      // A string field beside non-string ones is kept alone; the non-string ones never reach the event.
      const mixed = parse([line({ type: "tool_call", tool: "edit_file", input: { command: 7, path: "/w/a.ts" } })]);
      expect(mixed.events).toEqual([{ kind: "tool_call", tool: "read", name: "edit_file", target: "/w/a.ts" }]);
    });

    it("a `run_terminal_command` call without a string command reaches the guard as a shell call without one", () => {
      const { events } = parse([line({ type: "tool_call", tool: "run_terminal_command", input: { command: 1 } })]);
      expect(events).toEqual([{ kind: "tool_call", tool: "shell", name: "run_terminal_command" }]);
    });
  });

  it("ignores ACP messages and unparseable framing", () => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    expect(a.parseEvent({ jsonrpc: "2.0", method: "x" } as never, state)).toEqual([]);
    expect(a.parseEvent("not json", state)).toEqual([]);
    expect(state.unknownEvents).toBe(0);
  });
});
describe("grok auth preflight (T4.24, Q-10; SYNTHETIC outputs in the shapes of the 2026-10-14 live check)", () => {
  const out =
    (stdout: string, exitCode: number | null = 0, extra: Partial<ProbeOutput> = {}): ProbeRunner =>
    async () => ({ stdout, stderr: "", exitCode, timedOut: false, ...extra });
  const MODELS = "\nDefault model: m-default\nAvailable models:\n* m-default\n- m-other\n";

  it("runs only `models` with a short timeout", async () => {
    const seen: Array<{ argv: readonly string[]; timeoutMs?: number }> = [];
    const r = await adapter().authPreflight(async (argv, opts) => {
      seen.push({ argv, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
      return { stdout: `You are logged in with grok.com.${MODELS}`, stderr: "", exitCode: 0, timedOut: false };
    });
    expect(r).toEqual({ state: "OK" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv).toEqual([EXE, "models"]);
    expect(seen[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("a logged-out first line at exit 0 is AUTH_REQUIRED naming the native login", async () => {
    expect(await adapter().authPreflight(out(`You are not authenticated.${MODELS}`))).toEqual({
      state: "AUTH_REQUIRED",
      loginCommand: "grok login",
    });
  });

  it("any other output, exit code, timeout or spawn failure is UNKNOWN and never leaks past the first line", async () => {
    const cases: Array<[string, ProbeRunner]> = [
      ["unrecognised first line", out(`Welcome back.${MODELS}`)],
      ["logged-in text at a non-zero exit", out("You are logged in with grok.com.\n", 1)],
      ["logged-out text at a non-zero exit", out("You are not authenticated.\n", 2)],
      ["empty output", out("")],
      ["a null exit code", out("You are logged in with grok.com.\n", null)],
      ["timeout", out("", null, { timedOut: true })],
      ["spawn error", out("", null, { spawnError: "ENOENT" })],
    ];
    for (const [name, runner] of cases) {
      const r = await adapter().authPreflight(runner);
      expect(r, name).toMatchObject({ state: "UNKNOWN" });
    }
    const r = await adapter().authPreflight(out(`Welcome back\u0007 ${"x".repeat(200)}\nsecret: hunter2\n`));
    expect(r.state).toBe("UNKNOWN");
    if (r.state === "UNKNOWN") {
      expect(r.reason.length).toBeLessThan(200);
      expect(r.reason).not.toContain("hunter2");
      expect(r.reason).not.toContain("\u0007");
    }
  });

  it("by inspection, the adapter reads no file of the Grok home and no credential name (FR-AUTH-02)", () => {
    const code = (f: string) =>
      readFileSync(new URL(f, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const f of ["./adapter.ts", "./protocol.ts"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/auth\.json|\.grok|XAI_API_KEY|GROK_HOME|readFile|readdir|createReadStream/);
    }
  });

  it("is UNKNOWN when the binary is not on PATH, without running anything", async () => {
    let ran = false;
    const r = await new GrokAdapter({ pathEnv: "/nonexistent" }).authPreflight(async () => {
      ran = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });
    expect(r).toMatchObject({ state: "UNKNOWN" });
    expect(ran).toBe(false);
  });
});

/**
 * T4.25 (FR-ADP-11): the shared conformance suite over synthetic recorded fixtures (`./fixtures/*.jsonl`, in the
 * `streaming-json` shapes of the 2026-10-14 live check), replayed by `replay.mjs --provider grok` in place of the
 * binary, so it passes with no `grok` installed. The prompt reaches the replay as the `--single=` argv word.
 */
describe("grok conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.25)", () => {
  const caseOf = (kind: ConformanceCase["kind"]): ConformanceCase => {
    const c = grokConformanceCases(makeCwd).find((x) => x.kind === kind);
    if (!c) throw new Error(`missing ${kind} case`);
    return c;
  };
  const shapeRequest = (): CompileRequest => ({
    runId: "run_grok_shape",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
    bypassApproved: true,
  });
  /** A copy of `a` whose compiled argv is rewritten by `edit`, to show the replay refuses a wrong compile. */
  const brokenBy = (a: GrokAdapter, edit: (argv: string[]) => string[]): GrokAdapter => {
    const broken: GrokAdapter = Object.create(a);
    broken.compile = (r, p) => {
      const inv = a.compile(r, p);
      if ("ineligible" in inv) return inv;
      return { ...inv, argv: edit(inv.argv), policyFlags: [] };
    };
    return broken;
  };

  it("covers every FR-ADP-11 kind and passes the full suite", async () => {
    const cases = grokConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("success with edit normalizes session, summary and the edit; thought is dropped and usage recorded", async () => {
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

  it("resumed run passes -r <id> after the policy flags and preserves the native session id", async () => {
    const c = caseOf("resume");
    const inv = c.adapter.resumeArgs(c.binding ?? { provider: "grok", nativeSessionId: "" }, c.request, c.profile);
    if ("ineligible" in inv) throw new Error(inv.detail);
    expect(inv.argv.slice(-3)).toEqual(["--always-approve", "-r", RESUMED_SESSION_ID]);
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: RESUMED_SESSION_ID });
  });

  it("a not-signed-in error line at exit 1 ends AUTH_REQUIRED, not a success", async () => {
    const report = await runConformanceCase(caseOf("auth_missing"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: false, failureCode: "AUTH_REQUIRED" });
  });

  it("a cancelled stopReason at exit 0 (live check 8f) is TOOL_FAILURE and keeps the session id", async () => {
    const report = await runConformanceCase(caseOf("task_failure"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("partial mutation leaves the file in the cwd", async () => {
    const c = caseOf("partial_mutation");
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(c.request.workspace.cwd, "partial.txt"), "utf8")).toContain("synthetic");
  });

  it.each([
    ["--sandbox removed", (argv: string[]) => argv.filter((w, i) => w !== "--sandbox" && argv[i - 1] !== "--sandbox")],
    ["--always-approve removed", (argv: string[]) => argv.filter((w) => w !== "--always-approve")],
    ["--yolo added", (argv: string[]) => [...argv, "--yolo"]],
    ["--permission-mode added", (argv: string[]) => [...argv, "--permission-mode", "bypassPermissions"]],
    ["--trust added", (argv: string[]) => [...argv, "--trust"]],
    ["--single= removed", (argv: string[]) => argv.filter((w) => !w.startsWith("--single="))],
  ])(
    "the replay refuses an argv Grok Build would not be given (%s), so a wrong compile cannot pass",
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

describe("grok Git declaration (T4.27, FR-GIT-01, FR-GIT-02, FR-GIT-09)", () => {
  it("declares no Git write control (deny rules are prefix matches), leaving FR-GIT-03 and FR-GIT-06", () => {
    const c = adapter().gitWriteControl;
    expect(c.kind).toBe("none-documented");
    expect(c.remainingControls).toEqual(["FR-GIT-03", "FR-GIT-06"]);
    expect(c.detail).toBe(GIT_WRITE_CONTROL_DETAIL);
    expect(c.detail).toMatch(/prefix/i);
    expect(c.detail).toMatch(/git -C \. commit/);
    expect(c.detail).toMatch(/FR-GIT-03/);
    expect(c.detail).toMatch(/FR-GIT-06/);
    expect(adapter().gitWriteControl).toBe(GROK_GIT_WRITE_CONTROL);
  });

  it("declares finalize-only commit channel (FR-GIT-09, owner decision 36)", () => {
    const caps = adapter().gitCapabilities;
    expect(caps.commitChannel).toBe("finalize-only");
    expect(caps.detail).toMatch(/FR-GIT-09/);
    expect(caps.detail).toMatch(/per-run MCP/);
    expect(adapter().gitCapabilities).toBe(GROK_GIT_CAPABILITIES);
  });

  it("list_capabilities reports Grok Build's Git-write declaration through MCP", async () => {
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
      const grok = body.providers.find((p: { provider: string }) => p.provider === "grok");
      expect(grok).toBeDefined();
      expect(grok.git_write_control).toEqual({
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

  it("every compiled invocation passes the prompt as one --single= word and carries no git command or credentials", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    const initial = adapter().compile(request({ bypassApproved: true }), profile);
    const resumed = adapter().resumeArgs(
      { provider: "grok", nativeSessionId: "s-123" },
      request({ bypassApproved: true }),
      profile,
    );
    for (const [name, inv] of [
      ["initial", initial],
      ["resumed", resumed],
    ] as const) {
      if (isIneligible(inv)) throw new Error(`unexpected ineligible: ${inv.detail}`);
      expect(inv.argv).toContain("--single=--yolo fix the failing test");
      expect(inv.stdin).toEqual({ kind: "none" });
      expect(auditInvocation(inv, { profile, bypassApproved: true })).toEqual([]);
      for (const a of inv.argv.slice(1)) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} argv has git: ${a}`).toBe(false);
      }
      for (const a of inv.policyFlags) {
        expect(/\bgit\b|\bgh\b/.test(a), `${name} policyFlags has git: ${a}`).toBe(false);
      }
      expect(inv.envAllowlist).toEqual(["PATH", "HOME"]);
      for (const k of Object.keys(inv.env)) {
        expect(/GIT|GITHUB|GH|GROK|XAI/.test(k), `${name} env: ${k}`).toBe(false);
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
          GIT_AUTHOR_NAME: "Grok Dev",
          GIT_AUTHOR_EMAIL: "grok@example.test",
          GIT_COMMITTER_NAME: "Grok Dev",
          GIT_COMMITTER_EMAIL: "grok@example.test",
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
    // The replay dialect answers `version` and `--help` only; `grok models` gets the observed logged-in line (T4.24).
    const real = createProbeRunner();
    const probeRunner: ProbeRunner = async (argv, opts) =>
      argv.at(-1) === AUTH_STATUS_ARGS.at(-1)
        ? { exitCode: 0, stdout: `${AUTH_LOGGED_IN_PREFIX} (synthetic)\n`, stderr: "", timedOut: false }
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
        objective: "write a file with grok",
        workspace: repo,
        trustProfile: "privileged",
        provider: "grok",
        project: {
          id: "test-project",
          name: "Test Project",
          environment_kind: "host",
          context_id: "primary",
          base_ref: "main",
          effective_max_profile: "privileged",
          writable: true,
          identity: { name: "Grok Dev", email: "grok@example.test" },
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
