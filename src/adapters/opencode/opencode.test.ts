/**
 * T4.52 (TDD §4.6): the OpenCode module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `opencode` binary is run; probe output is the shape the 2026-10-14 live check recorded (`opencode v2.0.23`).
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
import { OpenCodeAdapter } from "./adapter.js";

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
});
