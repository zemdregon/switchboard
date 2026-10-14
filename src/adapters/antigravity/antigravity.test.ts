/**
 * T4.32 (TDD §4.4): the Antigravity module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `agy` binary is run; probe output is the shape the 2026-10-14 live check recorded (`1.3.4`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditInvocation, bypassClassFlags } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
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
import { AntigravityAdapter } from "./adapter.js";

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

describe("antigravity probe and auth placeholder (fail closed until T4.34)", () => {
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

  it("auth is UNKNOWN until T4.34", async () => {
    expect(await adapter().authPreflight(runner({}))).toMatchObject({ state: "UNKNOWN" });
  });

  it("reads no Antigravity credential, settings or state file (source inspection)", () => {
    for (const f of ["adapter.ts", "protocol.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/from "node:fs"|readFile|antigravity-oauth-token|settings\.json"/);
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

  it("a tool step is reported once; a later update that first carries the command is reported for the guard", () => {
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
    expect(early.events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "write_to_file", target: "/work/tree/a.txt" },
    ]);
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
