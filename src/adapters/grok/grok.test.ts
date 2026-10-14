/**
 * T4.22 (TDD §4.3): the Grok Build module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `grok` binary is run; probe output is the shape the 2026-10-14 live check recorded (`grok 1.0.50 (...) [stable]`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { auditInvocation, bypassClassFlags } from "../audit.js";
import { privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import type { CompileRequest, ParseState, ProbeOutput, ProbeRunner, ResolvedProfile, TrustProfile } from "../types.js";
import { GrokAdapter } from "./adapter.js";

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
