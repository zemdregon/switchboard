/**
 * `cli` inner backend (T11.13; FR-INN-04, FR-ADP-03, FR-ADP-08). Synthetic only: no test executes `opencode`.
 * An in-range manifest and a verification record are injected copies. They are not a claim that T11.0 verified a
 * tool-free argv, and they are not a live backend run. The shipped manifest range stays `<0.0.0` and
 * `CLI_TOOL_FREE_VERIFICATION` stays null, so production does not attach this backend.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execPath } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditInvocation } from "../adapters/audit.js";
import { privilegedProfile } from "../adapters/fixtures/privileged.js";
import { type ComplianceManifest, tryLoadManifest } from "../adapters/manifest/index.js";
import { OpenCodeAdapter } from "../adapters/opencode/adapter.js";
import { type Invocation, isIneligible } from "../adapters/types.js";
import { resolveInnerAgent } from "../config/inner-agent.js";
import {
  assessCliBackend,
  CLI_TOOL_FREE_VERIFICATION,
  type CliSpawn,
  type CliSpawnResult,
  createCliBackend,
} from "./cli-backend.js";
import { createConfiguredInnerAgent } from "./index.js";
import type { InnerBackend, InnerRequest } from "./port.js";

const MODEL = "openai/gpt-4.1";
const PROMPT = "sys\n\nuser";
const DENY_ALL = '{"*":"deny"}';
const REQ: InnerRequest = {
  task: "run_title",
  template_version: "canary.v1",
  system: "sys",
  user: "user",
  max_output_tokens: 32,
  response_schema: { type: "object" },
};
const settings = { provider: "opencode" as const, model: MODEL, timeoutMs: 5_000 };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-inner-cli-test-"));
  dirs.push(dir);
  return dir;
}

function manifestWithRange(range: string): ComplianceManifest {
  const loaded = tryLoadManifest("opencode");
  if (loaded.loaded === undefined) throw new Error("shipped opencode manifest missing");
  return { ...loaded.loaded.manifest, validated_version_range: range };
}

/** The TDD §4.6 tool-free argv, written out here so a shared helper cannot hide a wrong shape. */
function toolFree(exe: string, model: string, prompt: string, cwd: string): Invocation {
  return {
    transport: "subprocess-jsonl",
    argv: [exe, "run", "--format", "json", "--pure", "--model", model, "--dir", cwd, "--", prompt],
    env: {
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_PERMISSION: DENY_ALL,
    },
    envAllowlist: ["OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_PERMISSION"],
    cwd,
    stdin: { kind: "none" },
    outputFormat: "jsonl",
    timeouts: { wallClockMs: 5_000, idleMs: 5_000, killGraceMs: 500 },
    policyFlags: [],
    expectedExitCodes: [0],
    maxLineBytes: 1024 * 1024,
  };
}

function refusedSpawn(): { calls: Invocation[]; spawn: CliSpawn } {
  const calls: Invocation[] = [];
  const spawn: CliSpawn = async (invocation) => {
    calls.push(invocation);
    throw new Error("spawn must not run");
  };
  return { calls, spawn };
}

async function expectRefusal(backend: InnerBackend, code: string, calls: Invocation[]): Promise<void> {
  await expect(backend.complete(REQ, new AbortController().signal)).rejects.toMatchObject({
    name: "CliBackendError",
    code,
    message: code,
  });
  expect(calls).toEqual([]);
  expect(await backend.probe(new AbortController().signal)).toEqual({
    reachable: false,
    canary_ok: false,
    eligible: false,
    detail: code,
  });
  expect(calls).toEqual([]);
}

const SID = "ses_SYNTHETIC0000000000000001";

function line(type: string, part: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    timestamp: 1,
    sessionID: SID,
    model: MODEL,
    part: { sessionID: SID, messageID: "msg_1", ...part },
  });
}

function successStdout(text = "SYNTHETIC_OK"): string {
  return [
    line("step_start", { id: "prt_s1", type: "step-start" }),
    line("text", { id: "prt_t1", type: "text", text }),
    line("step_finish", {
      id: "prt_f1",
      type: "step-finish",
      reason: "stop",
      tokens: { input: 11, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ].join("\n");
}

function passingOptions(compile: CliBackendOptionsCompile, spawn?: CliSpawn) {
  return {
    observedVersion: "v1.2.3",
    manifest: manifestWithRange("=1.2.3"),
    verification: { version: "1.2.3" },
    compile,
    ...(spawn !== undefined ? { spawn } : {}),
  };
}

type CliBackendOptionsCompile = (input: { model: string; prompt: string; cwd: string }) => Invocation;

describe("cli inner backend (T11.13; FR-INN-04, FR-ADP-03, FR-ADP-08)", () => {
  it("missing OpenCode is Ineligible and spawns nothing", async () => {
    const compile = vi.fn();
    const missing = refusedSpawn();
    const backend = createCliBackend(settings, {
      manifest: manifestWithRange("=1.2.3"),
      verification: { version: "1.2.3" },
      compile,
      spawn: missing.spawn,
    });
    expect(await backend.resolveLocality(new AbortController().signal)).toBe("remote");
    await expectRefusal(backend, "MISSING", missing.calls);
    expect(compile).not.toHaveBeenCalled();

    const blank = refusedSpawn();
    const blankCompile = vi.fn();
    await expectRefusal(
      createCliBackend(settings, {
        observedVersion: "  ",
        manifest: manifestWithRange("=1.2.3"),
        verification: { version: "1.2.3" },
        compile: blankCompile,
        spawn: blank.spawn,
      }),
      "MISSING",
      blank.calls,
    );
    expect(blankCompile).not.toHaveBeenCalled();

    const absent = refusedSpawn();
    const absentCompile = vi.fn();
    await expectRefusal(
      createCliBackend(settings, {
        observedVersion: "1.2.3",
        manifest: null,
        verification: { version: "1.2.3" },
        compile: absentCompile,
        spawn: absent.spawn,
      }),
      "NO_MANIFEST",
      absent.calls,
    );
    expect(absentCompile).not.toHaveBeenCalled();
  });

  it("a version outside the shipped manifest range is Ineligible and spawns nothing", async () => {
    const shipped = tryLoadManifest("opencode");
    expect(shipped.loaded?.manifest.validated_version_range).toBe("<0.0.0");
    const cases: Array<{ observedVersion: string; manifest?: ComplianceManifest }> = [
      { observedVersion: "2.0.23" },
      { observedVersion: "1.2.3", manifest: manifestWithRange(">=9.0.0") },
      { observedVersion: "not-a-version", manifest: manifestWithRange(">=1.0.0") },
      { observedVersion: "1.2.3-rc.1", manifest: manifestWithRange(">=1.0.0") },
    ];
    for (const c of cases) {
      const compile = vi.fn();
      const { calls, spawn } = refusedSpawn();
      const backend = createCliBackend(settings, {
        observedVersion: c.observedVersion,
        ...(c.manifest !== undefined ? { manifest: c.manifest } : {}),
        verification: { version: c.observedVersion },
        compile,
        spawn,
      });
      await expectRefusal(backend, "VERSION_OUT_OF_RANGE", calls);
      expect(compile, c.observedVersion).not.toHaveBeenCalled();
    }
  });

  it("flags cannot be verified from config alone, so an in-range version stays Ineligible", async () => {
    expect(CLI_TOOL_FREE_VERIFICATION).toBeNull();
    const compile = vi.fn(() => toolFree("/opt/synthetic/opencode", MODEL, PROMPT, "/tmp/unused"));
    const unverified = refusedSpawn();
    await expectRefusal(
      createCliBackend(settings, {
        observedVersion: "1.2.3",
        manifest: manifestWithRange("=1.2.3"),
        compile,
        spawn: unverified.spawn,
      }),
      "FLAGS_UNVERIFIED",
      unverified.calls,
    );
    expect(compile).not.toHaveBeenCalled();

    const mismatch = vi.fn();
    const mismatched = refusedSpawn();
    await expectRefusal(
      createCliBackend(settings, {
        observedVersion: "v1.2.3",
        manifest: manifestWithRange("=1.2.3"),
        verification: { version: "9.9.9" },
        compile: mismatch,
        spawn: mismatched.spawn,
      }),
      "FLAGS_UNVERIFIED",
      mismatched.calls,
    );
    expect(mismatch).not.toHaveBeenCalled();
  });

  it("the OpenCode adapter compile path does not yield a tool-free invocation", async () => {
    const direct = new OpenCodeAdapter({ pathEnv: "" }).compile(
      {
        runId: "inner_cli",
        objective: PROMPT,
        constraints: [],
        workspace: { cwd: "/tmp/sb-inner-cli-unused", writable: false },
        model: MODEL,
      },
      {
        name: "inspect-untrusted",
        fileAccess: "read-only",
        shell: "none",
        network: "off",
        repoConfig: "disabled",
        bypassApproved: false,
      },
    );
    expect(direct).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    const { calls, spawn } = refusedSpawn();
    await expectRefusal(
      createCliBackend(settings, {
        observedVersion: "1.2.3",
        manifest: manifestWithRange("=1.2.3"),
        verification: { version: "1.2.3" },
        spawn,
      }),
      "FLAGS_UNVERIFIED",
      calls,
    );
  });

  it("a bypass flag fails the argv audit and spawns nothing", async () => {
    const dir = scratchDir();
    const echoed = assessCliBackend({
      model: MODEL,
      prompt: "--auto",
      cwd: dir,
      provider: "opencode",
      options: {
        observedVersion: "1.2.3",
        manifest: manifestWithRange("=1.2.3"),
        verification: { version: "1.2.3" },
        compile: ({ model, prompt, cwd }) => toolFree("/opt/synthetic/opencode", model, prompt, cwd),
      },
    });
    expect(echoed).toEqual({ ok: false, reason: "ARGV_AUDIT" });

    const cases: Array<{ label: string; model?: string; build: (cwd: string) => Invocation }> = [
      {
        label: "--auto in argv",
        build: (cwd) => {
          const inv = toolFree("/opt/synthetic/opencode", MODEL, PROMPT, cwd);
          const exe = inv.argv[0] ?? "/opt/synthetic/opencode";
          return { ...inv, argv: [exe, "--auto", ...inv.argv.slice(1)] };
        },
      },
      {
        label: "--auto only in policyFlags",
        build: (cwd) => ({ ...toolFree("/opt/synthetic/opencode", MODEL, PROMPT, cwd), policyFlags: ["--auto"] }),
      },
      {
        label: "prompt word --auto",
        build: (cwd) => toolFree("/opt/synthetic/opencode", MODEL, "--auto", cwd),
      },
      {
        label: "model --auto",
        model: "--auto",
        build: (cwd) => toolFree("/opt/synthetic/opencode", "--auto", PROMPT, cwd),
      },
    ];
    for (const c of cases) {
      const { calls, spawn } = refusedSpawn();
      const backend = createCliBackend(
        { ...settings, model: c.model ?? MODEL },
        {
          observedVersion: "1.2.3",
          manifest: manifestWithRange("=1.2.3"),
          verification: { version: "1.2.3" },
          compile: ({ cwd }) => c.build(cwd),
          spawn,
        },
      );
      await expectRefusal(backend, "ARGV_AUDIT", calls);
    }
  });

  it("the privileged compile argv is not the tool-free argv and spawns nothing", async () => {
    const profile = privilegedProfile({
      files: { access: "worktree" },
      shell: { mode: "broad" },
      network: { mode: "on" },
      repository_config: { mode: "enabled" },
      bypass: true,
    });
    const compiled = new OpenCodeAdapter({ executable: "/opt/synthetic/opencode" }).compile(
      {
        runId: "run_01M4WBZSXSCWYKTKJN77A7MFJQ",
        objective: PROMPT,
        constraints: [],
        workspace: { cwd: "/work/tree", writable: true },
        bypassApproved: true,
      },
      { ...profile, bypassApproved: true },
    );
    expect(isIneligible(compiled)).toBe(false);
    if (isIneligible(compiled)) return;
    expect(auditInvocation(compiled)).toEqual([]);
    expect(compiled.argv).toContain("--standalone");
    expect(compiled.argv).not.toContain("--pure");
    expect(compiled.argv).not.toContain("--model");
    const { calls, spawn } = refusedSpawn();
    await expectRefusal(
      createCliBackend(settings, {
        observedVersion: "1.2.3",
        manifest: manifestWithRange("=1.2.3"),
        verification: { version: "1.2.3" },
        compile: () => compiled,
        spawn,
      }),
      "FLAGS_UNVERIFIED",
      calls,
    );
  });

  it("an eligible gate spawns only the verified tool-free argv", async () => {
    const edits: Array<{ label: string; edit: (inv: Invocation) => Invocation }> = [
      {
        label: "drop --pure",
        edit: (inv) => ({ ...inv, argv: inv.argv.filter((word) => word !== "--pure") }),
      },
      {
        label: "relative exe",
        edit: (inv) => ({ ...inv, argv: ["opencode", ...inv.argv.slice(1)] }),
      },
      {
        label: "permission allow",
        edit: (inv) => ({ ...inv, env: { ...inv.env, OPENCODE_PERMISSION: '{"*":"allow"}' } }),
      },
      {
        label: "permission ask",
        edit: (inv) => ({ ...inv, env: { ...inv.env, OPENCODE_PERMISSION: '{"*":"ask"}' } }),
      },
      {
        label: "extra env key",
        edit: (inv) => ({ ...inv, env: { ...inv.env, HOME: "/tmp/not-passed" } }),
      },
      {
        label: "missing OPENCODE_DISABLE_CLAUDE_CODE",
        edit: (inv) => {
          const env = { ...inv.env };
          delete env.OPENCODE_DISABLE_CLAUDE_CODE;
          return { ...inv, env };
        },
      },
      {
        label: "prompt mismatch",
        edit: (inv) => ({ ...inv, argv: [...inv.argv.slice(0, -1), "other prompt"] }),
      },
      {
        label: "model mismatch",
        edit: (inv) => {
          const argv = [...inv.argv];
          const at = argv.indexOf("--model");
          argv[at + 1] = "other/model";
          return { ...inv, argv };
        },
      },
    ];
    for (const item of edits) {
      const { calls, spawn } = refusedSpawn();
      const backend = createCliBackend(settings, {
        ...passingOptions(({ model, prompt, cwd }) =>
          item.edit(toolFree("/opt/synthetic/opencode", model, prompt, cwd)),
        ),
        spawn,
      });
      if (item.label === "permission allow") {
        const sample = item.edit(toolFree("/opt/synthetic/opencode", MODEL, PROMPT, scratchDir()));
        expect(auditInvocation(sample), item.label).toEqual([]);
      }
      await expectRefusal(backend, "FLAGS_UNVERIFIED", calls);
    }

    const scriptDir = scratchDir();
    const script = join(scriptDir, "fake-opencode.mjs");
    writeFileSync(script, recorderScript(), { mode: 0o755 });
    const backend = createCliBackend(
      settings,
      passingOptions(({ model, prompt, cwd }) => toolFree(script, model, prompt, cwd)),
    );
    const result = await backend.complete(REQ, new AbortController().signal);
    const record = JSON.parse(readFileSync(join(scriptDir, "record.json"), "utf8")) as {
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      dirEntries: string[];
    };
    expect(result).toEqual({ text: "SYNTHETIC_OK", model_id: MODEL, usage: { in: 11, out: 4 } });
    expect(record.argv[0]).toBe(execPath);
    expect(record.argv[1]).toBe(script);
    // The child's cwd is the realpath (macOS tmpdir is a /var -> /private/var symlink); argv keeps the unresolved path.
    const dirArg = record.argv[record.argv.indexOf("--dir") + 1] ?? "";
    expect(dirArg.startsWith(join(tmpdir(), "sb-inner-cli-"))).toBe(true);
    expect(record.cwd).toBe(join(realpathSync(tmpdir()), basename(dirArg)));
    expect(record.argv.slice(2)).toEqual([
      "run",
      "--format",
      "json",
      "--pure",
      "--model",
      MODEL,
      "--dir",
      dirArg,
      "--",
      PROMPT,
    ]);
    expect(record.argv).not.toContain("--auto");
    expect(record.argv).not.toContain("--standalone");
    expect(record.dirEntries).toEqual([]);
    // macOS adds `__CF_USER_TEXT_ENCODING` to every process it starts (T4.10); it is not the controller's.
    expect(
      Object.keys(record.env)
        .filter((k) => k !== "__CF_USER_TEXT_ENCODING")
        .sort(),
    ).toEqual(["OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_PERMISSION"]);
    expect(record.env.OPENCODE_PERMISSION).toBe(DENY_ALL);
    expect(record.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(record.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(record.env.PATH).toBeUndefined();
    expect(existsSync(record.cwd)).toBe(false);
  });

  it("a tool call in the stream is refused and not accepted", async () => {
    let calls = 0;
    const tool = line("tool_use", {
      id: "prt_u1",
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "a.txt" }, output: "x" },
    });
    const parts = successStdout().split("\n");
    const stdout = [parts[0] ?? "", tool, ...parts.slice(1)].join("\n");
    const backend = createCliBackend(
      settings,
      passingOptions(
        ({ model, prompt, cwd }) => toolFree("/opt/synthetic/opencode", model, prompt, cwd),
        async () => {
          calls += 1;
          const result: CliSpawnResult = { stdout, exitCode: 0, signal: null };
          return result;
        },
      ),
    );
    await expect(backend.complete(REQ, new AbortController().signal)).rejects.toMatchObject({
      name: "CliBackendError",
      code: "TOOL_CALL",
      message: "TOOL_CALL",
    });
    expect(calls).toBe(1);

    let bad = 0;
    const rejected = createCliBackend(
      settings,
      passingOptions(
        ({ model, prompt, cwd }) => toolFree("/opt/synthetic/opencode", model, prompt, cwd),
        async () => {
          bad += 1;
          return { stdout: "not-json\n", exitCode: 0, signal: null };
        },
      ),
    );
    await expect(rejected.complete(REQ, new AbortController().signal)).rejects.toMatchObject({
      code: "OUTPUT_REJECTED",
      message: "OUTPUT_REJECTED",
    });
    expect(bad).toBe(1);
  });

  it("createConfiguredInnerAgent stays no_backend until every gate passes", async () => {
    const resolved = resolveInnerAgent({
      enabled: true,
      backend: { kind: "cli", provider: "opencode", model: MODEL },
      tasks: { run_title: { enabled: true } },
    });
    const spawn = vi.fn<CliSpawn>(async () => {
      throw new Error("spawn must not run");
    });
    const blocked = createConfiguredInnerAgent(resolved, { cli: { spawn } });
    expect(blocked.state).toBe("no_backend");
    expect(blocked.backend).toBeUndefined();
    expect(blocked.taskEnabled("run_title")).toBe(false);
    expect(spawn).not.toHaveBeenCalled();

    let calls = 0;
    const ready = createConfiguredInnerAgent(resolved, {
      cli: passingOptions(
        ({ model, prompt, cwd }) => toolFree("/opt/synthetic/opencode", model, prompt, cwd),
        async () => {
          calls += 1;
          return { stdout: successStdout(), exitCode: 0, signal: null };
        },
      ),
    });
    expect(ready.state).toBe("ready");
    expect(ready.backend?.kind).toBe("cli");
    expect(ready.taskEnabled("run_title")).toBe(true);
    expect(await ready.backend?.probe(new AbortController().signal)).toEqual({
      reachable: true,
      canary_ok: false,
      eligible: true,
      detail: "NO_CANARY",
    });
    expect(calls).toBe(0);
    await expect(ready.backend?.complete(REQ, new AbortController().signal)).resolves.toMatchObject({
      text: "SYNTHETIC_OK",
      model_id: MODEL,
      usage: { in: 11, out: 4 },
    });
    expect(calls).toBe(1);
  });

  it("probe reports Ineligible and does not spawn", async () => {
    const { calls, spawn } = refusedSpawn();
    const ineligible = createCliBackend(settings, { spawn });
    expect(await ineligible.probe(new AbortController().signal)).toEqual({
      reachable: false,
      canary_ok: false,
      eligible: false,
      detail: "MISSING",
    });
    expect(calls).toEqual([]);

    let compilePrompt = "";
    let cwd = "";
    let spawns = 0;
    const eligible = createCliBackend(settings, {
      observedVersion: "1.2.3",
      manifest: manifestWithRange("=1.2.3"),
      verification: { version: "1.2.3" },
      compile: (input) => {
        compilePrompt = input.prompt;
        cwd = input.cwd;
        return toolFree("/opt/synthetic/opencode", input.model, input.prompt, input.cwd);
      },
      spawn: async () => {
        spawns += 1;
        throw new Error("probe must not spawn");
      },
    });
    expect(await eligible.probe(new AbortController().signal)).toEqual({
      reachable: true,
      canary_ok: false,
      eligible: true,
      detail: "NO_CANARY",
    });
    expect(compilePrompt).toBe("Reply with the single word ok");
    expect(spawns).toBe(0);
    expect(existsSync(cwd)).toBe(false);
    expect(await eligible.resolveLocality(new AbortController().signal)).toBe("remote");
  });
});

function recorderScript(): string {
  return `#!${execPath}
import { writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  join(here, "record.json"),
  JSON.stringify({
    argv: process.argv,
    env: process.env,
    cwd: process.cwd(),
    dirEntries: readdirSync(process.cwd()),
  }),
);
const sid = ${JSON.stringify(SID)};
const model = ${JSON.stringify(MODEL)};
const line = (type, part) =>
  JSON.stringify({
    type,
    timestamp: 1,
    sessionID: sid,
    model,
    part: { sessionID: sid, messageID: "msg_1", ...part },
  });
process.stdout.write(
  [
    line("step_start", { id: "prt_s1", type: "step-start" }),
    line("text", { id: "prt_t1", type: "text", text: "SYNTHETIC_OK" }),
    line("step_finish", {
      id: "prt_f1",
      type: "step-finish",
      reason: "stop",
      tokens: { input: 11, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ].join("\\n") + "\\n",
);
`;
}
