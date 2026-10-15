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
import { buildEnvelope } from "../../mcp/envelope.js";
import { createSwitchboardServer } from "../../mcp/server.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { WorkspaceManager } from "../../workspace/index.js";
import { auditInvocation, bypassClassFlags } from "../audit.js";
import { type ConformanceCase, missingRequiredKinds, runConformanceCase, runConformanceSuite } from "../conformance.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { replayLauncher } from "../fixtures/replay.js";
import { providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner } from "../run.js";
import { guardEvent } from "../tool-guard.js";
import type {
  CompileRequest,
  FailureEvidence,
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
  GROK_BYPASS_NOT_APPROVED,
  GROK_GIT_CAPABILITIES,
  GROK_GIT_WRITE_CONTROL,
  GROK_PRIVILEGED_NEEDS_BYPASS,
  GrokAdapter,
} from "./adapter.js";
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

  it("resumeArgs accepts valid alphanumeric, UUID and delimited session IDs and refuses unsafe or flag-like shapes", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const req = request({ bypassApproved: true });

    // Valid IDs: UUID, alphanumeric with ., _, :, - and up to 256 chars
    for (const validId of ["0c1d5f2e-7c1a-4b66-9d0c-1f5b8a3a9e11", "session_123.456:789-abc", "A", "a".repeat(256)]) {
      const r = a.resumeArgs({ provider: "grok", nativeSessionId: validId }, req, approved);
      expect("ineligible" in r, validId).toBe(false);
      if (!("ineligible" in r)) {
        expect(r.argv.slice(-2)).toEqual(["-r", validId]);
      }
    }

    // Unsafe IDs: empty, leading dash/flag, spaces, control chars, shell metachars, length > 256
    for (const unsafeId of [
      "",
      "-r",
      "--resume",
      "-s",
      "--single",
      "-dangerous",
      "session id",
      "session\nid",
      "session\tid",
      "session;rm",
      "session&rm",
      "session|rm",
      "$SESSION",
      "`whoami`",
      "session\x00null",
      "a".repeat(257),
    ]) {
      const r = a.resumeArgs({ provider: "grok", nativeSessionId: unsafeId }, req, approved);
      expect(r, JSON.stringify(unsafeId)).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: "native session id is not a safe single argument",
      });
    }
  });

  it("resumeArgs preserves request cwd and mirrors compile policyFlags and audit", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const req = request({ workspace: { cwd: "/custom/workspace/dir", writable: true }, bypassApproved: true });
    const id = "00000000-0000-4000-8000-000000000042";
    const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, approved);
    expect("ineligible" in resumed).toBe(false);
    if ("ineligible" in resumed) return;
    expect(resumed.cwd).toBe("/custom/workspace/dir");
    expect(resumed.argv.slice(-2)).toEqual(["-r", id]);
    const first = a.compile(req, approved);
    expect("ineligible" in first).toBe(false);
    if ("ineligible" in first) return;
    expect(resumed.policyFlags).toEqual(first.policyFlags);
    expect(resumed.argv.slice(0, -2)).toEqual(first.argv);
    expect(auditInvocation(resumed, { profile, bypassApproved: true })).toEqual([]);
  });

  it("resumeArgs mirrors compile across every structured scope, including exact refusals", () => {
    const a = adapter();
    const id = "resume_scope_matrix";
    let compiled = 0;
    for (const scope of scopeShapes()) {
      for (const bypassApproved of [false, true]) {
        const profile = { ...privilegedProfile(scope), bypassApproved };
        const req = request({ bypassApproved, workspace: { cwd: "/resume scope/worktree", writable: true } });
        const first = a.compile(req, profile);
        const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, profile);
        const label = JSON.stringify({ scope, bypassApproved });
        if ("ineligible" in first) {
          expect(resumed, label).toEqual(first);
        } else {
          compiled += 1;
          // The entire invocation must stay identical, with only the native resume pair appended.
          expect(resumed, label).toEqual({ ...first, argv: [...first.argv, "-r", id] });
        }
      }
    }
    expect(compiled).toBe(3);
  });

  it("resumeArgs rejects foreign provider bindings and ineligible profiles with exact reasons", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const req = request({ bypassApproved: true });
    const id = "00000000-0000-4000-8000-000000000042";

    // Foreign providers
    for (const provider of ["claude", "codex", "antigravity", "cursor", "opencode", "other"]) {
      expect(a.resumeArgs({ provider: provider as ProviderId, nativeSessionId: id }, req, approved)).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: `binding is for ${provider}`,
      });
    }

    // Ineligible profiles
    for (const name of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
      expect(a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, profileOf(name))).toMatchObject({
        ineligible: true,
        reason: "PROFILE_UNSUPPORTED",
      });
    }

    // Privileged without bypass
    const noBypass = privilegedProfile({ ...BYPASS_SCOPE, bypass: false });
    expect(
      a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, { ...noBypass, bypassApproved: true }),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: GROK_PRIVILEGED_NEEDS_BYPASS,
    });

    // Privileged with bypass but not approved
    expect(
      a.resumeArgs({ provider: "grok", nativeSessionId: id }, request({ bypassApproved: false }), profile),
    ).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
      detail: GROK_BYPASS_NOT_APPROVED,
    });
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

  it("native errors remain failures in either stream order, with the first error determining the code", () => {
    const auth = { type: "error", message: "Not signed in" };
    const model = { type: "error", message: "Couldn't set model synthetic-model" };
    for (const [first, second, code] of [
      [auth, model, "AUTH_REQUIRED"],
      [model, auth, "MODEL_UNAVAILABLE"],
    ] as const) {
      for (const lines of [
        [first, second, END],
        [END, first, second],
        [first, END, second],
      ]) {
        const { events } = parse(lines.map(line));
        expect(adapter().extractResult(events, EXIT_OK), JSON.stringify(lines)).toMatchObject({
          ok: false,
          failureCode: code,
          nativeSessionId: SID,
          unknownEventCount: 0,
        });
      }
    }
  });

  it("unknown envelopes cannot bind a session or smuggle status and usage before or after end", () => {
    const envelope = {
      type: "synthetic_future_event",
      sessionId: "spoofed_session",
      stopReason: "end_turn",
      ok: true,
      usage: { input_tokens: 999 },
      error: { message: "Not signed in" },
      result: END,
    };
    for (const lines of [[envelope], [envelope, END], [END, envelope]]) {
      const { events, state } = parse(lines.map(line));
      expect(state.unknownEvents).toBe(1);
      expect(events.filter((e) => e.kind === "unknown")).toEqual([
        { kind: "unknown", rawType: "synthetic_future_event" },
      ]);
      const result = adapter().extractResult(events, EXIT_OK);
      if (lines.length === 1) {
        expect(result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", unknownEventCount: 1 });
        expect(result).not.toHaveProperty("nativeSessionId");
        expect(events).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ ok: true, nativeSessionId: SID, unknownEventCount: 1 });
        expect(events.filter((e) => e.kind === "usage")).toEqual([
          { kind: "usage", source: "provider_reported", metrics: { input_tokens: 10, output_tokens: 2, num_turns: 1 } },
        ]);
      }
    }
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

    it("fixture rate_limit_error replays an unmapped error line at exit 0 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT or success", async () => {
      const report = await runConformanceCase(
        replayCase("rate_limit_error", "rate_limit", { ok: false, failureCode: "TOOL_FAILURE" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it("fixture git_write_guard (ADR-0039) replays a guard-flagged Git write under end_turn at exit 0 to PERMISSION_BLOCKED", async () => {
      const report = await runConformanceCase(
        replayCase("git_write_guard", "task_failure", {
          ok: false,
          failureCode: "PERMISSION_BLOCKED",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    });

    it.each([
      ["unknown_then_end", true, undefined, 1],
      ["error_after_end", false, "AUTH_REQUIRED", 0],
      ["malformed_after_end", false, "OUTPUT_PROTOCOL_ERROR", 0],
    ] as const)(
      "fixture %s preserves structured session binding and checks the whole stream",
      async (fixture, ok, failureCode, unknownEventCount) => {
        // Unknown JSON can coexist with a recognized result, but cannot supply it. Late error events and malformed
        // framing must still invalidate that result; malformed JSON is rejected by the supervisor before parseEvent.
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

    it("fixture no_end replays text at exit 0 without an end line to OUTPUT_PROTOCOL_ERROR", async () => {
      const report = await runConformanceCase(
        replayCase("no_end", "malformed_output", { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        summary: "SYNTHETIC: finished work without an end line.",
      });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it("fixture two_ends replays a second end line at exit 0 to OUTPUT_PROTOCOL_ERROR", async () => {
      const report = await runConformanceCase(
        replayCase("two_ends", "malformed_output", {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          nativeSessionId: DEFAULT_SESSION_ID,
        }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    });

    it("fixture trailing_tool replays a tool_call after the end line to OUTPUT_PROTOCOL_ERROR", async () => {
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
        failureDetail: "tool call after the end line",
      });
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
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: DEFAULT_SESSION_ID,
      });
    });

    it("fixture unsafe_session_id replays an unsafe session id in the end line to OUTPUT_PROTOCOL_ERROR without binding", async () => {
      const report = await runConformanceCase(
        replayCase("unsafe_session_id", "malformed_output", { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it("fixture model_unavailable (live check 5b) replays an invalid model error at exit 1 to MODEL_UNAVAILABLE", async () => {
      const report = await runConformanceCase(
        replayCase("model_unavailable", "task_failure", { ok: false, failureCode: "MODEL_UNAVAILABLE" }),
      );
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "MODEL_UNAVAILABLE", unknownEventCount: 0 });
      expect(report.result).not.toHaveProperty("nativeSessionId");
    });

    it("fixture resume_failure (live check 6a resumed, 8f cancelled) replays a resumed failed run to TOOL_FAILURE, preserving the resumed session id", async () => {
      // The only replayed resume so far is the conformance success; the failure leg of `-r <id>` (a resumed run whose
      // tool call is cancelled, rows 6a + 8f combined) is replayed here end to end.
      const report = await runConformanceCase({
        kind: "resume",
        adapter: replayAdapter("resume_failure"),
        request: {
          runId: "run_grok_t423_resume_failure",
          objective: "synthetic grok objective",
          constraints: [],
          workspace: { cwd: makeCwd(), writable: true },
          bypassApproved: true,
        },
        profile: PRIVILEGED_BYPASS_PROFILE,
        binding: { provider: "grok", nativeSessionId: RESUMED_SESSION_ID },
        expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: RESUMED_SESSION_ID },
      });
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
        nativeSessionId: RESUMED_SESSION_ID,
      });
    });

    // Residual whole-run cases (T4.23, synthetic only, parser unchanged): a clean `end` line is never the run's verdict
    // on its own; the supervisor's exit outcome still decides, and the structured session id stays bound.
    const fixtureRequest = (runId: string): CompileRequest => ({
      runId,
      objective: "synthetic grok objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
      bypassApproved: true,
    });

    it.each([
      ["timeout", "PROCESS_TIMEOUT", { idleMs: 400 }, false],
      ["cancellation", "CANCELLED", { idleMs: 10_000 }, true],
    ] as const)(
      "fixture hang_after_end: an end_turn line followed by a process that never exits ends %s, never success",
      async (kind, failureCode, timeouts, ignoreTerm) => {
        const report = await runConformanceCase({
          kind,
          adapter: replayAdapter("hang_after_end", { hang: true, ignoreTerm, timeouts }),
          request: fixtureRequest("run_grok_t423_hang_after_end"),
          profile: PRIVILEGED_BYPASS_PROFILE,
          expect: { ok: false, failureCode, nativeSessionId: DEFAULT_SESSION_ID },
        });
        expect(report.checks.filter((k) => !k.ok)).toEqual([]);
        expect(report.result).toMatchObject({
          ok: false,
          failureCode,
          nativeSessionId: DEFAULT_SESSION_ID,
          unknownEventCount: 0,
        });
      },
    );

    it.each([1, 2, 137])(
      "fixture success_edit at unexpected exit code %i is TOOL_FAILURE with the session id kept, never success",
      async (exitCode) => {
        const report = await runConformanceCase({
          kind: "task_failure",
          adapter: replayAdapter("success_edit", { exitCode }),
          request: fixtureRequest("run_grok_t423_success_bad_exit"),
          profile: PRIVILEGED_BYPASS_PROFILE,
          expect: { ok: false, failureCode: "TOOL_FAILURE", nativeSessionId: DEFAULT_SESSION_ID },
        });
        expect(report.checks.filter((k) => !k.ok)).toEqual([]);
        expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", summary: "Added hello.txt." });
      },
    );

    it("a line over the compiled maxLineBytes after an end_turn line ends OUTPUT_PROTOCOL_ERROR, never success", async () => {
      // Generated at test time (a committed 1 MiB fixture would be noise): a clean `end`, then one `text` line longer
      // than the 1 MiB limit the Grok invocation compiles. The supervisor kills the group on the oversize line, so the
      // earlier result cannot stand.
      const inv = adapter().compile(fixtureRequest("run_grok_t423_oversize_probe"), PRIVILEGED_BYPASS_PROFILE);
      if (isIneligible(inv)) throw new Error(inv.reason);
      const limit = inv.maxLineBytes ?? 0;
      expect(limit).toBe(1024 * 1024);
      const file = join(makeCwd(), "oversize_after_end.jsonl");
      writeFileSync(
        file,
        [
          line({ _fixture: { synthetic: true, note: "SYNTHETIC: generated by grok.test.ts (T4.23)", exit: 0 } }),
          line({ type: "end", stopReason: "end_turn", sessionId: DEFAULT_SESSION_ID }),
          line({ type: "text", data: "x".repeat(limit + 1) }),
          "",
        ].join("\n"),
      );
      const report = await runConformanceCase({
        kind: "malformed_output",
        adapter: new GrokAdapter({
          executable: process.execPath,
          launcherArgs: replayLauncher("grok", file),
          timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
        }),
        request: fixtureRequest("run_grok_t423_oversize_after_end"),
        profile: PRIVILEGED_BYPASS_PROFILE,
        expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR", nativeSessionId: DEFAULT_SESSION_ID },
      });
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
      expect(report.result).not.toHaveProperty("summary");
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

    it("pinned residual: a tool_call_update after the `end` line that emits no tool_call leaves a clean turn clean", () => {
      // Residual (w411, parser unchanged): unlike an unreadable `tool_call`, an update with only status and content
      // (row 7a shape) or one repeating an already reported command emits no `tool_call`, so it is not counted as a
      // call after `end`. It carries no new command, so no Git write is missed; the malicious leg replays both shapes
      // after a guarded call (test/malicious/adapters/grok.case.ts). Turns red if the parser starts counting them.
      const CALL = { type: "tool_call", id: "c1", tool: "run_terminal_command", input: { command: "echo ok" } };
      for (const [label, lines] of [
        ["status and content only", [line(END), line({ type: "tool_call_update", status: "completed", content: "x" })]],
        ["repeated command", [line(CALL), line(END), line({ ...CALL, type: "tool_call_update", status: "completed" })]],
      ] as const) {
        const { events } = parse([...lines]);
        expect(events.filter((e) => e.kind === "tool_call").length, label).toBeLessThanOrEqual(1);
        expect(adapter().extractResult(events, EXIT_OK), label).toMatchObject({ ok: true, nativeSessionId: SID });
      }
      // The guard verdict on the call before `end` still decides when the repeated update follows it.
      const push = { ...CALL, input: { command: "git push origin main" } };
      const guarded = parse([line(push), line(END), line({ ...push, type: "tool_call_update" })]).events.map((e) =>
        guardEvent(e, { cwd: "/w", bypass: true }),
      );
      expect(adapter().extractResult(guarded, EXIT_OK)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
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

    it("a tool_call_update reporting a newly provided or swapped command is evaluated by the guard; identical reports are not duplicated", () => {
      const ctx = { cwd: "/w", bypass: true };
      const guarded = (lines: string[]) => parse(lines).events.map((e) => guardEvent(e, ctx));

      // 1. Started without command, completed with command in tool_call_update: reported and guarded
      const late = guarded([
        line({ type: "tool_call", tool: "run_terminal_command" }),
        line({ type: "tool_call_update", tool: "run_terminal_command", input: { command: "git push origin main" } }),
        line(END),
      ]);
      expect(adapter().extractResult(late, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });

      // 2. Swapped command: started with benign "ls", tool_call_update swaps to "git push origin main"
      const swapped = guarded([
        line({ type: "tool_call", tool: "run_terminal_command", input: { command: "ls" } }),
        line({ type: "tool_call_update", tool: "run_terminal_command", input: { command: "git push origin main" } }),
        line(END),
      ]);
      expect(adapter().extractResult(swapped, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });

      // 3. Identical reports in tool_call and tool_call_update are not duplicated
      const normal = parse([
        line({ type: "tool_call", tool: "run_terminal_command", input: { command: "echo ok" } }),
        line({ type: "tool_call_update", tool: "run_terminal_command", input: { command: "echo ok" } }),
        line({ type: "tool_call_update", status: "completed" }),
        line(END),
      ]);
      expect(normal.events.filter((e) => e.kind === "tool_call")).toEqual([
        { kind: "tool_call", tool: "shell", name: "run_terminal_command", command: "echo ok" },
      ]);
      expect(adapter().extractResult(normal.events, EXIT_OK)).toMatchObject({ ok: true });
    });

    it("a trailing tool_call_update with command is evaluated by the guard after the end line", () => {
      const ctx = { cwd: "/w", bypass: true };
      const guarded = (lines: string[]) => parse(lines).events.map((e) => guardEvent(e, ctx));

      // Guarded Git write in tool_call_update after end line ends PERMISSION_BLOCKED
      const push = guarded([
        line(END),
        line({ type: "tool_call_update", tool: "run_terminal_command", input: { command: "git push origin main" } }),
      ]);
      expect(adapter().extractResult(push, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
      });

      // Benign command in tool_call_update after end line ends OUTPUT_PROTOCOL_ERROR ("tool call after the end line")
      const plain = parse([
        line(END),
        line({ type: "tool_call_update", tool: "run_terminal_command", input: { command: "ls" } }),
      ]);
      const r = adapter().extractResult(plain.events, EXIT_OK);
      expect(r).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the end line",
      });
    });

    it("parses alternative argument keys (parameters, args, arguments, cmd, CommandLine, filePath, file_path, AbsolutePath, target)", () => {
      const ctx = { cwd: "/w", bypass: true };
      const guarded = (lines: string[]) => parse(lines).events.map((e) => guardEvent(e, ctx));

      for (const call of [
        { type: "tool_call", parameters: { command: "git push origin main" } },
        { type: "tool_call", args: { cmd: "git push origin main" } },
        { type: "tool_call", arguments: { CommandLine: "git push origin main" } },
        { type: "tool_call", cmd: "git push origin main" },
        { type: "tool_call", CommandLine: "git push origin main" },
      ]) {
        expect(adapter().extractResult(guarded([line(call), line(END)]), EXIT_OK), JSON.stringify(call)).toMatchObject({
          ok: false,
          failureCode: "PERMISSION_BLOCKED",
        });
      }

      for (const call of [
        { type: "tool_call", tool: "edit_file", parameters: { file_path: "/w/b.ts" } },
        { type: "tool_call", tool: "edit_file", args: { filePath: "/w/b.ts" } },
        { type: "tool_call", tool: "edit_file", arguments: { AbsolutePath: "/w/b.ts" } },
        { type: "tool_call", tool: "edit_file", input: { target: "/w/b.ts" } },
        { type: "tool_call", tool: "edit_file", file_path: "/w/b.ts" },
        { type: "tool_call", tool: "edit_file", AbsolutePath: "/w/b.ts" },
      ]) {
        const p = parse([line(call), line(END)]);
        expect(p.events[0], JSON.stringify(call)).toMatchObject({
          kind: "tool_call",
          tool: "read",
          name: "edit_file",
          target: "/w/b.ts",
        });
      }
    });

    it("prototype-named keys in tool_call and tool_call_update never smuggle commands or properties", () => {
      const parsed = parse([
        `{"type":"tool_call","__proto__":{"command":"git push origin main"}}`,
        `{"type":"tool_call_update","__proto__":{"command":"git push origin main"}}`,
        `{"type":"tool_call","parameters":{"__proto__":{"command":"git push origin main"}}}`,
        `{"type":"tool_call","args":{"__proto__":{"command":"git push origin main"}}}`,
        `{"type":"tool_call","arguments":{"__proto__":{"command":"git push origin main"}}}`,
        `{"type":"end","stopReason":"end_turn","__proto__":{"sessionId":"smuggled"}}`,
        `{"type":"end","stopReason":"end_turn","usage":{"__proto__":{"input_tokens":10}}}`,
      ]);
      expect(parsed.events.filter((e) => e.kind === "tool_call")).toEqual([]);
      expect(parsed.state.nativeSessionId).not.toBe("smuggled");
      const usage = parsed.events.find((e) => e.kind === "usage");
      expect(usage).toBeUndefined();
    });

    it("primitive JSON root values, null, arrays, and objects without string type parse as unknown event with rawType 'none'", () => {
      const r = parse([
        "123",
        "true",
        "false",
        "null",
        "[1, 2]",
        '"just a string"',
        "{}",
        line({ type: 123 }),
        line({ type: null }),
        line({ type: {} }),
      ]);
      expect(r.events).toHaveLength(10);
      expect(r.events.every((e) => e.kind === "unknown" && e.rawType === "none")).toBe(true);
      expect(r.state.unknownEvents).toBe(10);
      expect(adapter().extractResult(r.events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        unknownEventCount: 10,
      });
    });

    it("rawType is clipped to 64 characters with an ellipsis", () => {
      const longType = "custom_event_type_name_".repeat(5);
      const r = parse([line({ type: longType })]);
      expect(r.events).toEqual([{ kind: "unknown", rawType: `${longType.slice(0, 64)}…` }]);
      expect(r.state.unknownEvents).toBe(1);
    });

    it("assistant text event with non-string data is counted unknown, and long summary keeps its last 2,000 characters", () => {
      const r = parse([
        line({ type: "text", data: 42 }),
        line({ type: "text", data: null }),
        line({ type: "text", data: { text: "nested" } }),
      ]);
      expect(r.events).toEqual([
        { kind: "unknown", rawType: "text" },
        { kind: "unknown", rawType: "text" },
        { kind: "unknown", rawType: "text" },
      ]);
      expect(r.state.unknownEvents).toBe(3);

      const longText = `head-${"a".repeat(2_500)}-tail`;
      const withLong = parse([line({ type: "text", data: longText }), line(END)]);
      const res = adapter().extractResult(withLong.events, EXIT_OK);
      expect(res.ok).toBe(true);
      expect(res.summary).toHaveLength(2_000);
      expect(res.summary?.endsWith("-tail")).toBe(true);
      expect(res.summary?.startsWith("head-")).toBe(false);
    });

    it("error event with non-string message is provider_error, and long message is clipped to 2,000 characters", () => {
      const nonString = parse([
        line({ type: "error", message: 123 }),
        line({ type: "error", message: null }),
        line({ type: "error" }),
      ]);
      expect(nonString.events).toEqual([
        { kind: "provider_error", category: "unknown", message: "error line without a string message" },
        { kind: "provider_error", category: "unknown", message: "error line without a string message" },
        { kind: "provider_error", category: "unknown", message: "error line without a string message" },
      ]);

      const longMessage = `error-${"e".repeat(2_500)}`;
      const withLong = parse([line({ type: "error", message: longMessage })]);
      expect(withLong.events).toEqual([
        {
          kind: "provider_error",
          category: "unknown",
          message: `${longMessage.slice(0, 2_000)}…`,
        },
      ]);
    });

    it("unrecorded sandbox_violation and permission_denied events parse as unknown events, not detected natively", () => {
      const r = parse([line({ type: "sandbox_violation" }), line({ type: "permission_denied" }), line(END)]);
      expect(r.events.slice(0, 2)).toEqual([
        { kind: "unknown", rawType: "sandbox_violation" },
        { kind: "unknown", rawType: "permission_denied" },
      ]);
      expect(adapter().extractResult(r.events, EXIT_OK)).toMatchObject({
        ok: true,
        unknownEventCount: 2,
        nativeSessionId: SID,
      });
    });

    it("end line with non-string stopReason parses as unknown event, and non-string or empty sessionId binds nothing", () => {
      const badStop = parse([line({ ...END, stopReason: 123 }), line({ ...END, stopReason: null })]);
      expect(badStop.events).toEqual([
        { kind: "unknown", rawType: "end" },
        { kind: "unknown", rawType: "end" },
      ]);
      expect(badStop.state.unknownEvents).toBe(2);

      const nonStringId = parse([line({ ...END, sessionId: 42 })]);
      expect(nonStringId.events.some((e) => e.kind === "session_bound")).toBe(false);
      expect(adapter().extractResult(nonStringId.events, EXIT_OK)).toMatchObject({ ok: true });
      expect(adapter().extractResult(nonStringId.events, EXIT_OK)).not.toHaveProperty("nativeSessionId");

      const emptyId = parse([line({ ...END, sessionId: "" })]);
      expect(emptyId.events.some((e) => e.kind === "session_bound")).toBe(false);
      expect(adapter().extractResult(emptyId.events, EXIT_OK)).toMatchObject({ ok: true });
      expect(adapter().extractResult(emptyId.events, EXIT_OK)).not.toHaveProperty("nativeSessionId");
    });

    it("end line usage counters drop non-numeric, negative, Infinity and NaN values; num_turns is kept only when finite and non-negative", () => {
      const badUsage = parse([
        line({
          ...END,
          usage: {
            input_tokens: -1,
            output_tokens: "10",
            total_tokens: Number.NaN,
            cache_read_input_tokens: Number.POSITIVE_INFINITY,
            reasoning_tokens: 5,
            cache_creation_input_tokens: 0,
          },
          num_turns: -2,
        }),
      ]);
      const usageEv = badUsage.events.find((e) => e.kind === "usage");
      expect(usageEv).toEqual({
        kind: "usage",
        source: "provider_reported",
        metrics: {
          reasoning_tokens: 5,
          cache_creation_input_tokens: 0,
        },
      });

      const goodTurns = parse([
        line({
          ...END,
          usage: { total_tokens: 15 },
          num_turns: 3,
        }),
      ]);
      const turnsEv = goodTurns.events.find((e) => e.kind === "usage");
      expect(turnsEv).toEqual({
        kind: "usage",
        source: "provider_reported",
        metrics: {
          total_tokens: 15,
          num_turns: 3,
        },
      });
    });

    it("command precedence: input.command > input.cmd > input.CommandLine > e.command > e.cmd", () => {
      const p1 = parse([
        line({
          type: "tool_call",
          input: { command: "cmd1", cmd: "cmd2", CommandLine: "cmd3" },
          command: "cmd4",
          cmd: "cmd5",
        }),
      ]);
      expect(p1.events[0]).toMatchObject({ kind: "tool_call", tool: "shell", command: "cmd1" });

      const p2 = parse([
        line({
          type: "tool_call",
          input: { cmd: "cmd2", CommandLine: "cmd3" },
          command: "cmd4",
          cmd: "cmd5",
        }),
      ]);
      expect(p2.events[0]).toMatchObject({ kind: "tool_call", tool: "shell", command: "cmd2" });

      const p3 = parse([
        line({
          type: "tool_call",
          input: { CommandLine: "cmd3" },
          command: "cmd4",
          cmd: "cmd5",
        }),
      ]);
      expect(p3.events[0]).toMatchObject({ kind: "tool_call", tool: "shell", command: "cmd3" });

      const p4 = parse([
        line({
          type: "tool_call",
          command: "cmd4",
          cmd: "cmd5",
        }),
      ]);
      expect(p4.events[0]).toMatchObject({ kind: "tool_call", tool: "shell", command: "cmd4" });

      const p5 = parse([
        line({
          type: "tool_call",
          cmd: "cmd5",
        }),
      ]);
      expect(p5.events[0]).toMatchObject({ kind: "tool_call", tool: "shell", command: "cmd5" });
    });

    it("target path precedence: input.path > filePath > file_path > AbsolutePath > e.path > e.filePath > e.target", () => {
      const p1 = parse([
        line({
          type: "tool_call",
          tool: "read_file",
          input: { path: "/p1", filePath: "/p2", file_path: "/p3", AbsolutePath: "/p4" },
          path: "/p5",
          filePath: "/p6",
          target: "/p7",
        }),
      ]);
      expect(p1.events[0]).toMatchObject({ kind: "tool_call", tool: "read", target: "/p1" });

      const p2 = parse([
        line({
          type: "tool_call",
          tool: "read_file",
          input: { filePath: "/p2", file_path: "/p3", AbsolutePath: "/p4" },
          path: "/p5",
          filePath: "/p6",
          target: "/p7",
        }),
      ]);
      expect(p2.events[0]).toMatchObject({ kind: "tool_call", tool: "read", target: "/p2" });

      const p3 = parse([
        line({
          type: "tool_call",
          tool: "read_file",
          input: { file_path: "/p3", AbsolutePath: "/p4" },
          path: "/p5",
          filePath: "/p6",
          target: "/p7",
        }),
      ]);
      expect(p3.events[0]).toMatchObject({ kind: "tool_call", tool: "read", target: "/p3" });

      const p4 = parse([
        line({
          type: "tool_call",
          tool: "read_file",
          input: { AbsolutePath: "/p4" },
          path: "/p5",
          filePath: "/p6",
          target: "/p7",
        }),
      ]);
      expect(p4.events[0]).toMatchObject({ kind: "tool_call", tool: "read", target: "/p4" });

      const p5 = parse([
        line({
          type: "tool_call",
          tool: "read_file",
          path: "/p5",
          filePath: "/p6",
          target: "/p7",
        }),
      ]);
      expect(p5.events[0]).toMatchObject({ kind: "tool_call", tool: "read", target: "/p5" });

      const p6 = parse([
        line({
          type: "tool_call",
          tool: "read_file",
          filePath: "/p6",
          target: "/p7",
        }),
      ]);
      expect(p6.events[0]).toMatchObject({ kind: "tool_call", tool: "read", target: "/p6" });

      const p7 = parse([
        line({
          type: "tool_call",
          tool: "read_file",
          target: "/p7",
        }),
      ]);
      expect(p7.events[0]).toMatchObject({ kind: "tool_call", tool: "read", target: "/p7" });
    });

    it("when both command and target are present, command wins and target is omitted; long target is clipped to 512 characters", () => {
      const both = parse([
        line({
          type: "tool_call",
          input: { command: "ls", path: "/w/dir" },
        }),
      ]);
      expect(both.events[0]).toEqual({
        kind: "tool_call",
        tool: "shell",
        name: "run_terminal_command",
        command: "ls",
      });
      expect(both.events[0]).not.toHaveProperty("target");

      const longTarget = `/work/${"p".repeat(600)}`;
      const clipped = parse([
        line({
          type: "tool_call",
          tool: "read_file",
          input: { path: longTarget },
        }),
      ]);
      expect(clipped.events[0]).toEqual({
        kind: "tool_call",
        tool: "read",
        name: "read_file",
        target: `${longTarget.slice(0, 512)}…`,
      });
    });

    it("tool name precedence (tool > name > tool_name), fallback to run_terminal_command, and clipping to 64 characters", () => {
      const p1 = parse([
        line({
          type: "tool_call",
          tool: "t1",
          name: "t2",
          tool_name: "t3",
          input: { command: "echo 1" },
        }),
      ]);
      expect(p1.events[0]).toMatchObject({ kind: "tool_call", name: "t1" });

      const p2 = parse([
        line({
          type: "tool_call",
          name: "t2",
          tool_name: "t3",
          input: { command: "echo 2" },
        }),
      ]);
      expect(p2.events[0]).toMatchObject({ kind: "tool_call", name: "t2" });

      const p3 = parse([
        line({
          type: "tool_call",
          tool_name: "t3",
          input: { command: "echo 3" },
        }),
      ]);
      expect(p3.events[0]).toMatchObject({ kind: "tool_call", name: "t3" });

      // Fallback to run_terminal_command
      const p4 = parse([
        line({
          type: "tool_call",
          input: { command: "echo 4" },
        }),
      ]);
      expect(p4.events[0]).toMatchObject({ kind: "tool_call", name: "run_terminal_command", tool: "shell" });

      // Tool name clipping to 64 chars
      const longName = "custom_tool_name_".repeat(5);
      const p5 = parse([
        line({
          type: "tool_call",
          tool: longName,
          input: { command: "echo 5" },
        }),
      ]);
      expect(p5.events[0]).toMatchObject({
        kind: "tool_call",
        name: `${longName.slice(0, 64)}…`,
      });

      // Tool kind discrimination: other when not shell and no target
      const p6 = parse([
        line({
          type: "tool_call",
          tool: "calculate_hash",
        }),
      ]);
      expect(p6.events[0]).toEqual({
        kind: "tool_call",
        tool: "other",
        name: "calculate_hash",
      });
    });

    it("tool call ID precedence (id > call_id > tool_call_id) and multi-call correlation in tool_call_update", () => {
      // id precedence
      const p1 = parse([
        line({ type: "tool_call", id: "id1", call_id: "id2", tool_call_id: "id3", input: { command: "echo 1" } }),
        line({ type: "tool_call_update", id: "id1", input: { command: "echo 1 updated" } }),
      ]);
      expect(p1.events).toHaveLength(2);
      expect(p1.events[1]).toMatchObject({ kind: "tool_call", command: "echo 1 updated" });

      // call_id used
      const p2 = parse([
        line({ type: "tool_call", call_id: "call_abc", input: { command: "echo a" } }),
        line({ type: "tool_call_update", call_id: "call_abc", input: { command: "echo a updated" } }),
      ]);
      expect(p2.events).toHaveLength(2);
      expect(p2.events[1]).toMatchObject({ kind: "tool_call", command: "echo a updated" });

      // tool_call_id used
      const p3 = parse([
        line({ type: "tool_call", tool_call_id: "tcid_xyz", input: { command: "echo x" } }),
        line({ type: "tool_call_update", tool_call_id: "tcid_xyz", input: { command: "echo x updated" } }),
      ]);
      expect(p3.events).toHaveLength(2);
      expect(p3.events[1]).toMatchObject({ kind: "tool_call", command: "echo x updated" });
    });

    it("non-turn stopReason longer than 64 characters is clipped with an ellipsis in result summary", () => {
      const longStop = `custom_stop_reason_${"s".repeat(80)}`;
      const r = parse([line({ ...END, stopReason: longStop })]);
      const res = adapter().extractResult(r.events, EXIT_OK);
      expect(res.ok).toBe(false);
      expect(res.failureCode).toBe("TOOL_FAILURE");
      const resEvent = r.events.find((e) => e.kind === "result");
      expect(resEvent).toMatchObject({
        kind: "result",
        ok: false,
        summary: `stopReason ${longStop.slice(0, 64)}…`,
      });
    });

    it("error message prefixes match case-sensitively at the start; non-matching prefixes fall back to TOOL_FAILURE", () => {
      const exit1 = { outcome: "exited", exitCode: 1, signal: null, expectedExitCodes: [0] } as const;
      for (const msg of [
        "not signed in",
        "NOT SIGNED IN",
        " Not signed in",
        "error: Not signed in",
        "couldn't set model",
        "COULDN'T SET MODEL",
        " Couldn't set model",
        "error: Couldn't set model",
      ]) {
        const { events } = parse([line({ type: "error", message: msg })]);
        expect(events[0], msg).toMatchObject({ kind: "provider_error", category: "unknown", message: msg });
        expect(adapter().extractResult(events, exit1), msg).toMatchObject({
          ok: false,
          failureCode: "TOOL_FAILURE",
        });
      }
    });

    it("clean turn with no text messages leaves summary undefined, not empty string", () => {
      const r = parse([
        line({ type: "available_commands", tools: ["cmd1"] }),
        line({ type: "thought", data: "internal thinking" }),
        line({ type: "usage", signature: "sig" }),
        line(END),
      ]);
      const res = adapter().extractResult(r.events, EXIT_OK);
      expect(res.ok).toBe(true);
      expect(res).not.toHaveProperty("summary");
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

      const perm = adapter().extractResult([{ kind: "permission_denied", tool: "bash" }, endEvent], EXIT_OK);
      expect(perm).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: "denied: bash" });

      const sbx = adapter().extractResult(
        [{ kind: "sandbox_violation", detail: "out of worktree" }, endEvent],
        EXIT_OK,
      );
      expect(sbx).toMatchObject({ ok: false, failureCode: "SANDBOX_VIOLATION", failureDetail: "out of worktree" });

      const rl = adapter().extractResult([{ kind: "rate_limit" }, endEvent], EXIT_OK);
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
        name: "run_terminal_command",
        command: "git push origin main",
        violation: { kind: "git_write", reason: "git push origin main" },
      };
      const DENIED: NormalizedEvent = { kind: "permission_denied", tool: "bash" };
      const AUTH: NormalizedEvent = { kind: "provider_error", category: "auth", message: "Not signed in" };
      const UNKNOWN_ERR: NormalizedEvent = { kind: "provider_error", category: "unknown", message: "boom" };
      const PROTOCOL_ERR: NormalizedEvent = { kind: "provider_error", category: "protocol", message: "two ends" };
      const FAILED_RESULT: NormalizedEvent = { kind: "result", ok: false, summary: "stopReason cancelled" };
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
      expect(a.classifyFailure(evidence([GUARDED], { outcome: "protocol_error", exitCode: null }))).toEqual({
        code: "OUTPUT_PROTOCOL_ERROR",
        detail: "unparseable provider output",
      });
      expect(a.classifyFailure(evidence([GUARDED], { outcome: "crashed", exitCode: null, signal: "SIGKILL" }))).toEqual(
        { code: "PROCESS_CRASH", detail: "signal SIGKILL" },
      );

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
        detail: "denied: bash",
      });
      expect(
        a.classifyFailure(evidence([{ kind: "sandbox_violation", detail: "out of worktree" }, UNKNOWN_ERR])),
      ).toEqual({ code: "SANDBOX_VIOLATION", detail: "out of worktree" });

      // A provider error beats a rate_limit event, a failed result and the exit code; the grok `protocol`
      // category maps to OUTPUT_PROTOCOL_ERROR.
      expect(a.classifyFailure(evidence([UNKNOWN_ERR, { kind: "rate_limit" }]))).toEqual({
        code: "TOOL_FAILURE",
        detail: "unknown: boom",
      });
      expect(a.classifyFailure(evidence([AUTH, FAILED_RESULT]))).toEqual({
        code: "AUTH_REQUIRED",
        detail: "auth: Not signed in",
      });
      expect(a.classifyFailure(evidence([PROTOCOL_ERR], EXIT_1))).toEqual({
        code: "OUTPUT_PROTOCOL_ERROR",
        detail: "protocol: two ends",
      });

      // A rate_limit event and a failed result beat the exit code; the exit code beats "no result".
      expect(a.classifyFailure(evidence([{ kind: "rate_limit" }], EXIT_1))).toEqual({
        code: "RATE_LIMIT_TRANSIENT",
        detail: "rate limit reported",
      });
      expect(a.classifyFailure(evidence([FAILED_RESULT], EXIT_1))).toEqual({
        code: "TOOL_FAILURE",
        detail: "stopReason cancelled",
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
      const auth: NormalizedEvent = { kind: "provider_error", category: "auth", message: "Not signed in" };
      const denied: NormalizedEvent = { kind: "permission_denied", tool: "bash" };
      const guard: NormalizedEvent = {
        kind: "tool_call",
        tool: "shell",
        name: "run_terminal_command",
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
            exit: { ...EXIT_OK, exitCode: 1 },
            stderrTail: "Not signed in; too many requests", // Free text never changes structured precedence.
            timedOut: false,
            cancelled: false,
          });
        const result = classify(events);
        expect(result.code).toBe(code);
        expect(result).toEqual(classify([...events].reverse()));
        if (events.some((e) => e.kind === "tool_call")) {
          expect(result.detail).toBe("git write attempted: synthetic Git write");
        }
      }
    });

    it("seenEnds and seenToolCalls state is isolated across separate ParseState instances", () => {
      const a = adapter();
      const state1: ParseState = { lines: 0, unknownEvents: 0 };
      const state2: ParseState = { lines: 0, unknownEvents: 0 };

      // End line on state1
      const ev1 = a.parseEvent(line(END), state1);
      expect(ev1.some((e) => e.kind === "result" && e.ok)).toBe(true);

      // End line on fresh state2 is also a first end line, not a second one
      const ev2 = a.parseEvent(line(END), state2);
      expect(ev2.some((e) => e.kind === "result" && e.ok)).toBe(true);
      expect(ev2.some((e) => e.kind === "provider_error")).toBe(false);
    });

    it("session_bound carries model and backingProvider (from model, model_id, modelUsage, backing_provider, backingProvider)", () => {
      // From modelUsage (live check row 4a reported model id grok-4.7-build)
      const p1 = parse([
        line({
          ...END,
          modelUsage: { "grok-4.7-build": { inputTokens: 10, outputTokens: 2 } },
        }),
      ]);
      expect(p1.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
        model: "grok-4.7-build",
      });

      // From model_id
      const p2 = parse([line({ ...END, model_id: "grok-4.6" })]);
      expect(p2.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
        model: "grok-4.6",
      });

      // From model directly
      const p3 = parse([line({ ...END, model: "grok-4.7" })]);
      expect(p3.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
        model: "grok-4.7",
      });

      // Precedence: model > model_id > modelUsage
      const p4 = parse([
        line({
          ...END,
          model: "model-wins",
          model_id: "model-id-loses",
          modelUsage: { "usage-loses": {} },
        }),
      ]);
      expect(p4.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
        model: "model-wins",
      });

      // Backing provider (backing_provider and backingProvider)
      const p5 = parse([
        line({
          ...END,
          model: "grok-4.7",
          backing_provider: "backing-x",
        }),
      ]);
      expect(p5.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
        model: "grok-4.7",
        backingProvider: "backing-x",
      });

      const p6 = parse([
        line({
          ...END,
          model: "grok-4.7",
          backingProvider: "backing-y",
        }),
      ]);
      expect(p6.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
        model: "grok-4.7",
        backingProvider: "backing-y",
      });

      // Non-strings dropped, long values clipped to 128 chars
      const longModel = "m".repeat(150);
      const longBacking = "b".repeat(150);
      const p7 = parse([
        line({
          ...END,
          model: longModel,
          backing_provider: longBacking,
        }),
      ]);
      expect(p7.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
        model: `${longModel.slice(0, 128)}…`,
        backingProvider: `${longBacking.slice(0, 128)}…`,
      });

      const p8 = parse([
        line({
          ...END,
          model: 123,
          backing_provider: null,
        }),
      ]);
      expect(p8.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
      });

      // Prototype keys in modelUsage never smuggle a model
      const p9 = parse([
        `{"type":"end","stopReason":"end_turn","sessionId":"${SID}","modelUsage":{"__proto__":{"polluted":"true"}}}`,
      ]);
      expect(p9.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
      });
    });

    it("a second end line does not emit a second usage event (FR-CAP-01)", () => {
      const a = adapter();
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      const ev1 = a.parseEvent(line(END), state);
      expect(ev1.filter((e) => e.kind === "usage")).toHaveLength(1);
      const ev2 = a.parseEvent(line({ ...END, usage: { input_tokens: 99 } }), state);
      expect(ev2.filter((e) => e.kind === "usage")).toHaveLength(0);
      expect(ev2.some((e) => e.kind === "provider_error" && e.category === "protocol")).toBe(true);
    });

    it("the recorded end-line cost fields and requestId are never usage metrics or events (live check 4a/4b)", () => {
      // Row 4a recorded total_cost_usd, total_cost_usd_ticks and requestId on the result object; the parser reads
      // only the six token counters, num_turns and (elsewhere) model/modelUsage, so the costs and the request id
      // never widen the usage record or reach an event.
      const { events } = parse([
        line({
          type: "end",
          stopReason: "end_turn",
          sessionId: SID,
          requestId: "req_recorded_1",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 0,
            output_tokens: 2,
            reasoning_tokens: 0,
            total_tokens: 18,
          },
          num_turns: 1,
          total_cost_usd: 0.001,
          total_cost_usd_ticks: 1000,
        }),
      ]);
      expect(events.find((e) => e.kind === "usage")).toEqual({
        kind: "usage",
        source: "provider_reported",
        metrics: {
          input_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
          output_tokens: 2,
          reasoning_tokens: 0,
          total_tokens: 18,
          num_turns: 1,
        },
      });
      expect(JSON.stringify(events)).not.toContain("req_recorded_1");
      expect(JSON.stringify(events)).not.toContain("total_cost_usd");
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({ ok: true, nativeSessionId: SID });
    });

    it("a standalone usage line emits no usage event, whatever it carries (the end line is the run total)", () => {
      // Row 4b recorded the standalone usage line with a signature field and no recorded use; even with counters it
      // must not emit usage, so the run total is never counted away from the end line.
      const withEnd = parse([line({ type: "usage", signature: "s", input_tokens: 99, output_tokens: 99 }), line(END)]);
      expect(withEnd.events.filter((e) => e.kind === "usage")).toHaveLength(1);
      expect(withEnd.events.find((e) => e.kind === "usage")).toMatchObject({
        metrics: { input_tokens: 10, output_tokens: 2, num_turns: 1 },
      });
      const alone = parse([line({ type: "usage", signature: "s", input_tokens: 99 })]);
      expect(alone.events).toEqual([]);
      expect(alone.state.unknownEvents).toBe(0);
      expect(adapter().extractResult(alone.events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
      });
    });

    it("available_commands, thought and usage lines drop on any shape, never counted", () => {
      // These three recorded types are dropped whole ([LIVE] 4b: tools list, reasoning text, signature line); a
      // malformed shape of one of them is still one of them, so it is dropped too, not counted unknown.
      const { events, state } = parse([
        line({ type: "available_commands" }),
        line({ type: "available_commands", tools: "not-an-array" }),
        line({ type: "thought" }),
        line({ type: "thought", data: 42 }),
        line({ type: "usage" }),
        line({ type: "usage", signature: 7 }),
      ]);
      expect(events).toEqual([]);
      expect(state.unknownEvents).toBe(0);
      expect(state.lines).toBe(6);
    });

    it("modelUsage with several model keys resolves the first own key; a non-object or empty modelUsage binds no model", () => {
      const multi = parse([
        line({
          ...END,
          modelUsage: {
            "grok-4.7-build": { inputTokens: 10 },
            "grok-4.6": { inputTokens: 20 },
          },
        }),
      ]);
      expect(multi.events.find((e) => e.kind === "session_bound")).toEqual({
        kind: "session_bound",
        nativeSessionId: SID,
        model: "grok-4.7-build",
      });
      for (const modelUsage of ["grok-4.7-build", 42, ["grok-4.7-build"], {}]) {
        const { events } = parse([line({ ...END, modelUsage })]);
        expect(
          events.find((e) => e.kind === "session_bound"),
          JSON.stringify(modelUsage),
        ).toEqual({
          kind: "session_bound",
          nativeSessionId: SID,
        });
      }
    });

    it("empty string tool call ID falls back to generated counter, and empty tool name falls back when command is present", () => {
      // Empty string ID uses call_counter
      const p1 = parse([
        line({ type: "tool_call", id: "", input: { command: "echo 1" } }),
        line({ type: "tool_call_update", id: "", input: { command: "echo 1 update" } }),
      ]);
      expect(p1.events).toHaveLength(2);
      expect(p1.events[1]).toMatchObject({ kind: "tool_call", command: "echo 1 update" });

      // Empty string tool name with command falls back to run_terminal_command
      const p2 = parse([line({ type: "tool_call", tool: "", input: { command: "echo 2" } })]);
      expect(p2.events[0]).toMatchObject({ kind: "tool_call", name: "run_terminal_command", tool: "shell" });

      // Empty string tool name without command or target parses as unknown
      const p3 = parse([line({ type: "tool_call", tool: "" })]);
      expect(p3.events[0]).toEqual({ kind: "unknown", rawType: "tool_call" });
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

describe("grok parser to resume round trip (T4.23 residual; SYNTHETIC lines, parser unchanged)", () => {
  const EXIT_OK = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] } as const;
  const endLine = (sessionId: string) =>
    JSON.stringify({ type: "end", stopReason: "end_turn", sessionId, usage: { input_tokens: 1 } });
  const approved = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
  const req = request({ bypassApproved: true });

  it("the parser and resumeArgs agree on the session id boundary: 256 characters bind and resume, 257 do neither", () => {
    // One SESSION_ID_RE guards both sides; a drift would bind an id resume refuses (a dead binding) or resume one the
    // parser never binds. Mutating either side's length limit turns this red.
    for (const [id, safe] of [
      ["a".repeat(256), true],
      ["a".repeat(257), false],
      ["0", true],
      ["-0", false],
      [".a", false],
    ] as const) {
      const a = adapter();
      const state: ParseState = { lines: 0, unknownEvents: 0 };
      const events = a.parseEvent(endLine(id), state);
      const r = a.extractResult(events, EXIT_OK);
      const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: id }, req, approved);
      const label = `${id.slice(0, 8)} (${id.length})`;
      if (safe) {
        expect(state.nativeSessionId, label).toBe(id);
        expect(r, label).toMatchObject({ ok: true, nativeSessionId: id });
        expect(isIneligible(resumed), label).toBe(false);
        if (!isIneligible(resumed)) expect(resumed.argv.slice(-2), label).toEqual(["-r", id]);
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
    const r1 = a.extractResult(a.parseEvent(endLine(DEFAULT_SESSION_ID), first), EXIT_OK);
    expect(r1).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID });
    if (!r1.ok || r1.nativeSessionId === undefined) return;
    const resumed = a.resumeArgs({ provider: "grok", nativeSessionId: r1.nativeSessionId }, req, approved);
    expect(isIneligible(resumed)).toBe(false);
    if (isIneligible(resumed)) return;
    expect(resumed.argv.slice(-2)).toEqual(["-r", DEFAULT_SESSION_ID]);
    // [LIVE] 6a: the resumed run's `end` carries the same id, so it binds once on a fresh state and succeeds.
    const second: ParseState = { lines: 0, unknownEvents: 0 };
    const r2 = a.extractResult(a.parseEvent(endLine(DEFAULT_SESSION_ID), second), EXIT_OK);
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
    expect(a.resumeArgs({ provider: "grok", nativeSessionId: DEFAULT_SESSION_ID }, req, profile)).toEqual(expected);
    // The provider and id checks still come first: a foreign or unsafe binding names its own reason.
    expect(a.resumeArgs({ provider: "codex", nativeSessionId: DEFAULT_SESSION_ID }, req, profile)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: "binding is for codex",
    });
    expect(a.resumeArgs({ provider: "grok", nativeSessionId: "--yolo" }, req, profile)).toMatchObject({
      reason: "CAPABILITY_MISSING",
      detail: "native session id is not a safe single argument",
    });
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

/**
 * T4.23 with T4.6 (FR-ADP-10): a replayed fixture whose backing vendor differs from the harness. SYNTHETIC: live check
 * row 4a reported model id grok-4.7-build in modelUsage; backing_provider is the structured key a fronted run would
 * carry, not a recorded field.
 */
describe("grok backing-provider fixture (T4.23, T4.6, FR-ADP-10)", () => {
  it("a replayed run stores harness grok and backing vendor side by side and shows both in get_run", async () => {
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
          GIT_AUTHOR_NAME: "Grok Dev",
          GIT_AUTHOR_EMAIL: "grok@example.test",
          GIT_COMMITTER_NAME: "Grok Dev",
          GIT_COMMITTER_EMAIL: "grok@example.test",
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
      if (argv.includes("models")) {
        return {
          stdout: `${AUTH_LOGGED_IN_PREFIX} with grok.com.\nDefault model: grok-4.7\n`,
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
        provider: "grok",
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });
      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

      // The session_bound event's fields land on the provider binding (T5.3), never inferred from the display name.
      expect(ledger.listProviderBindings(metaSessionId)).toEqual([
        expect.objectContaining({
          provider: "grok",
          harness: "grok",
          backing_provider: "backing-x",
          model: "grok-4.7-build",
          native_session_id: DEFAULT_SESSION_ID,
        }),
      ]);

      const rows = ledger.listUsageObservationsForRun(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "grok",
        harness: "grok",
        backing_provider: "backing-x",
        model: "grok-4.7-build",
        source: "provider_reported",
      });
      expect(buildEnvelope(ledger, done, (s) => s).usage?.reported).toEqual([
        expect.objectContaining({
          harness: "grok",
          backing_provider: "backing-x",
          model: "grok-4.7-build",
        }),
      ]);
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  });
});
