import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/index.js";
import type { OverridableProfile, ProfileOverride } from "../../policy/types.js";
import { auditInvocation, BYPASS_FLAGS } from "../audit.js";
import { missingRequiredKinds, runConformanceCase, runConformanceSuite } from "../conformance.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner, startAdapterRun } from "../run.js";
import {
  type CompileRequest,
  createParseState,
  type ExitInfo,
  type Invocation,
  isIneligible,
  type NormalizedEvent,
  type ProbeOutput,
  type ProbeRunner,
  type ResolvedProfile,
} from "../types.js";
import { CodexAdapter, PRIVILEGED_DEFERRED, resolveOnPath } from "./adapter.js";
import {
  codexConformanceCases,
  EDIT_PROFILE,
  fixturePath,
  INSPECT_PROFILE,
  REPLAY_PATH,
  replayAdapter,
} from "./fixtures/cases.js";
import { CODEX_LOGIN_COMMAND } from "./protocol.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-codex-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const EXE = "/opt/test/bin/codex";
const adapter = () => new CodexAdapter({ executable: EXE });
const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_1",
  objective: "-- a prompt that looks like --yolo flags",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
  ...over,
});
const must = (x: Invocation | { ineligible: true }): Invocation => {
  if (isIneligible(x as Invocation)) throw new Error(`ineligible: ${JSON.stringify(x)}`);
  return x as Invocation;
};

describe("Codex conformance suite (synthetic recorded fixtures)", () => {
  it("covers every FR-ADP-11 kind and passes", async () => {
    const cases = codexConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) => c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name}`));
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("success with edit normalizes session, summary, tool calls and usage; drops reasoning", async () => {
    const c = codexConformanceCases(makeCwd)[0];
    if (!c) throw new Error("missing case");
    const inv = must(c.adapter.compile(c.request, c.profile));
    const out = await startAdapterRun(c.adapter, inv).done;
    expect(out.result).toMatchObject({
      ok: true,
      nativeSessionId: "synthetic-thread-0001",
      summary: "Added hello.txt.",
      unknownEventCount: 0,
    });
    expect(out.events).toContainEqual({ kind: "tool_call", tool: "edit", name: "file_change", target: "hello.txt" });
    expect(out.events).toContainEqual({
      kind: "tool_call",
      tool: "shell",
      name: "command_execution",
      target: "cat README.md",
    });
    expect(out.events).toContainEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30 },
    });
    expect(JSON.stringify(out.events)).not.toContain("reasoning text");
    expect(readFileSync(join(c.request.workspace.cwd, "hello.txt"), "utf8")).toContain("synthetic");
  });

  for (const [fixture, code] of [
    ["permission_denied", "PERMISSION_BLOCKED"],
    ["sandbox_denied", "SANDBOX_VIOLATION"],
    ["auth_missing", "AUTH_REQUIRED"],
    ["rate_limit", "RATE_LIMIT_TRANSIENT"],
    ["task_failure", "TOOL_FAILURE"],
    ["malformed_output", "OUTPUT_PROTOCOL_ERROR"],
  ] as const) {
    it(`${fixture} -> ${code}`, async () => {
      const a = replayAdapter(fixture);
      const out = await startAdapterRun(
        a,
        must(a.compile(request({ workspace: { cwd: makeCwd(), writable: true } }), EDIT_PROFILE)),
      ).done;
      expect(out.result.ok).toBe(false);
      expect(out.result.failureCode).toBe(code);
    });
  }

  it("resume passes the stored id to `exec resume` and the fixture echoes it", async () => {
    const report = await runConformanceCase(
      codexConformanceCases(makeCwd).find((c) => c.kind === "resume") ?? (undefined as never),
    );
    expect(report.result?.nativeSessionId).toBe("synthetic-thread-0042");
  });

  it("a declined command also records a denied tool call", async () => {
    const a = replayAdapter("permission_denied");
    const out = await startAdapterRun(
      a,
      must(a.compile(request({ workspace: { cwd: makeCwd(), writable: true } }), EDIT_PROFILE)),
    ).done;
    expect(out.events).toContainEqual(expect.objectContaining({ kind: "tool_call", tool: "shell", denied: true }));
    expect(out.events).toContainEqual({ kind: "permission_denied", tool: "command_execution" });
  });
});

describe("compile: argv and policy (FR-POL-02/03/04/08)", () => {
  const forbidden = /approv|bypass|yolo|dangerous|full-auto|--force|--last|^login$|^logout$|^config$|^-c$|^--config/i;

  const invocations = (): Array<[string, Invocation]> => [
    ["inspect", must(adapter().compile(request(), INSPECT_PROFILE))],
    ["edit", must(adapter().compile(request(), EDIT_PROFILE))],
    ["resume-edit", must(adapter().resumeArgs({ provider: "codex", nativeSessionId: "t-1" }, request(), EDIT_PROFILE))],
    [
      "resume-inspect",
      must(adapter().resumeArgs({ provider: "codex", nativeSessionId: "t-1" }, request(), INSPECT_PROFILE)),
    ],
  ];

  it("no bypass flag, approval override, config write or login appears in any argv", () => {
    for (const [name, inv] of invocations()) {
      expect(auditInvocation(inv), name).toEqual([]);
      for (const arg of [...inv.argv, ...inv.policyFlags]) {
        expect(
          BYPASS_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`)),
          `${name}: ${arg}`,
        ).toBe(false);
        expect(forbidden.test(arg), `${name}: ${arg}`).toBe(false);
      }
    }
  });

  it("uses `codex exec --json`, harness-control flags, and passes the prompt on stdin only", () => {
    for (const [name, inv] of invocations()) {
      expect(inv.argv.slice(0, 3), name).toEqual([EXE, "exec", "--json"]);
      expect(inv.argv, name).toContain("--ignore-user-config");
      expect(inv.argv, name).toContain("--ignore-rules");
      expect(inv.argv, name).not.toContain(request().objective);
      expect(inv.stdin, name).toEqual({ kind: "text", value: request().objective });
      expect(inv).toMatchObject({ transport: "subprocess-jsonl", outputFormat: "jsonl", cwd: "/work/tree" });
      expect(inv.env, name).toEqual({});
      expect(inv.envAllowlist, name).not.toContain("OPENAI_API_KEY");
      expect(inv.envAllowlist, name).not.toContain("CODEX_API_KEY");
      for (const f of inv.policyFlags) expect(inv.argv).toContain(f);
    }
  });

  const sandboxOf = (inv: Invocation) => inv.argv[inv.argv.indexOf("--sandbox") + 1];

  it("maps profiles to native sandbox modes: inspect -> read-only, edit -> workspace-write", () => {
    expect(sandboxOf(must(adapter().compile(request(), INSPECT_PROFILE)))).toBe("read-only");
    expect(sandboxOf(must(adapter().compile(request(), EDIT_PROFILE)))).toBe("workspace-write");
    const ro = request({ workspace: { cwd: "/work/tree", writable: false } });
    expect(sandboxOf(must(adapter().compile(ro, EDIT_PROFILE)))).toBe("read-only");
    expect(sandboxOf(must(adapter().compile(request(), { ...EDIT_PROFILE, fileAccess: "read-only" })))).toBe(
      "read-only",
    );
    expect(sandboxOf(must(adapter().compile(request(), { ...INSPECT_PROFILE, fileAccess: "worktree" })))).toBe(
      "read-only",
    );
  });

  it("resume appends `resume <id>` with the explicit id (never --last)", () => {
    const inv = must(adapter().resumeArgs({ provider: "codex", nativeSessionId: "abc-123" }, request(), EDIT_PROFILE));
    expect(inv.argv.slice(-2)).toEqual(["resume", "abc-123"]);
    expect(sandboxOf(inv)).toBe("workspace-write");
  });

  it("is pure and deterministic", () => {
    expect(JSON.stringify(adapter().compile(request(), EDIT_PROFILE))).toBe(
      JSON.stringify(adapter().compile(request(), EDIT_PROFILE)),
    );
  });

  const ineligibleCases: Array<[string, () => unknown, string]> = [
    ["privileged", () => adapter().compile(request(), { ...EDIT_PROFILE, name: "privileged" }), "PROFILE_UNSUPPORTED"],
    [
      "privileged with approval",
      () => adapter().compile(request(), { ...EDIT_PROFILE, name: "privileged", bypassApproved: true }),
      "PROFILE_UNSUPPORTED",
    ],
    [
      "bypass approved on edit",
      () => adapter().compile(request(), { ...EDIT_PROFILE, bypassApproved: true }),
      "PROFILE_UNSUPPORTED",
    ],
    [
      "test-sandboxed (Q-32)",
      () => adapter().compile(request(), { ...EDIT_PROFILE, name: "test-sandboxed" }),
      "PROFILE_UNSUPPORTED",
    ],
    [
      "trusted-development with an empty allowlist",
      () => adapter().compile(request(), { ...EDIT_PROFILE, name: "trusted-development" }),
      "CAPABILITY_MISSING",
    ],
    ["broad shell", () => adapter().compile(request(), { ...EDIT_PROFILE, shell: "broad" }), "PROFILE_UNSUPPORTED"],
    [
      "scoped files",
      () => adapter().compile(request(), { ...EDIT_PROFILE, fileAccess: "scoped" }),
      "PROFILE_UNSUPPORTED",
    ],
    [
      "network allowlist",
      () => adapter().compile(request(), { ...EDIT_PROFILE, network: "allowlist" }),
      "CAPABILITY_MISSING",
    ],
    ["model requested", () => adapter().compile(request({ model: "m" }), EDIT_PROFILE), "CAPABILITY_MISSING"],
    [
      "binary not on PATH",
      () => new CodexAdapter({ pathEnv: "/nonexistent-dir" }).compile(request(), EDIT_PROFILE),
      "CAPABILITY_MISSING",
    ],
    [
      "binding for another provider",
      () => adapter().resumeArgs({ provider: "claude", nativeSessionId: "x" }, request(), EDIT_PROFILE),
      "CAPABILITY_MISSING",
    ],
    [
      "flag-like session id",
      () => adapter().resumeArgs({ provider: "codex", nativeSessionId: "--yolo" }, request(), EDIT_PROFILE),
      "CAPABILITY_MISSING",
    ],
    [
      "privileged resume",
      () =>
        adapter().resumeArgs({ provider: "codex", nativeSessionId: "x" }, request(), {
          ...EDIT_PROFILE,
          name: "privileged",
        }),
      "PROFILE_UNSUPPORTED",
    ],
  ];
  for (const [name, fn, reason] of ineligibleCases) {
    it(`Ineligible, never downgraded: ${name}`, () => {
      expect(fn()).toMatchObject({ ineligible: true, reason });
    });
  }
});

describe("authPreflight (FR-AUTH-02)", () => {
  it("runs nothing, reads nothing, and returns UNKNOWN with the native login instruction", async () => {
    const calls: unknown[] = [];
    const runner: ProbeRunner = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const r = await adapter().authPreflight(runner);
    expect(r.state).toBe("UNKNOWN");
    if (r.state === "UNKNOWN") {
      expect(r.reason).toContain(CODEX_LOGIN_COMMAND);
      expect(r.reason).not.toMatch(/auth\.json/);
    }
    expect(calls).toEqual([]);
  });
});

describe("probe (FR-ADP-02 steps 1-5)", () => {
  const scripted =
    (map: Record<string, Partial<ProbeOutput>>): ProbeRunner =>
    async (argv) => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ...map[argv.slice(1).join(" ")] });

  it("reports version and required flags from help output", async () => {
    const r = await adapter().probe(
      scripted({
        "--version": { stdout: "codex-cli 1.2.3\n" },
        "exec --help": { stdout: "--json --sandbox --ignore-user-config --ignore-rules" },
      }),
    );
    expect(r).toMatchObject({ binaryPath: EXE, binaryVersion: "codex-cli 1.2.3" });
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["binary", true],
      ["version", true],
      ["command", true],
      ["output_format", true],
      ["flags", true],
    ]);
  });

  it("fails the flags step when a harness flag is missing, and output_format without --json", async () => {
    const r = await adapter().probe(
      scripted({ "--version": { stdout: "codex-cli 1.2.3" }, "exec --help": { stdout: "--sandbox" } }),
    );
    expect(r.steps.find((s) => s.step === "flags")).toMatchObject({ ok: false });
    expect(r.steps.find((s) => s.step === "output_format")).toMatchObject({ ok: false });
  });

  it("fails cleanly when the binary cannot run or is absent", async () => {
    const r = await adapter().probe(scripted({ "--version": { exitCode: null, spawnError: "ENOENT" } }));
    expect(r.binaryVersion).toBeNull();
    expect(r.steps[0]).toMatchObject({ step: "binary", ok: false });
    const none = await new CodexAdapter({ pathEnv: "" }).probe(scripted({}));
    expect(none.steps).toEqual([{ step: "binary", ok: false, detail: "codex not found on PATH" }]);
  });

  it("probes the replay binary through the real supervisor runner", async () => {
    const a = new CodexAdapter({ executable: process.execPath, launcherArgs: [REPLAY_PATH, fixturePath("resume")] });
    const r = await a.probe(createProbeRunner());
    expect(r.steps.every((s) => s.ok)).toBe(true);
    expect(r.binaryVersion).toMatch(/^codex-cli 0\.0\.1 /);
  });
});

describe("version gate (ADR-0009) with an injected test manifest", () => {
  it("the shipped manifest fails closed; a test manifest covering the version passes", () => {
    const reg = new AdapterRegistry().register(adapter());
    expect(reg.gate("codex", "codex-cli 0.0.1").eligible).toBe(false);
    const dir = makeCwd();
    writeFileSync(
      join(dir, "codex.json"),
      JSON.stringify({
        schema_version: 1,
        provider: "codex",
        validated_cli_version: "0.0.1",
        validated_version_range: ">=0.0.1 <0.1.0",
        validated_on: "2026-10-12",
        auth_modes_allowed: ["native_cached_subscription"],
        automation_surface: ["documented_headless"],
        credential_export_allowed: false,
        dashboard_scraping_allowed: false,
        network_protocol_reverse_engineering: false,
        commercial_multi_user_status: "requires-review",
        source_revision: "test-only manifest",
      }),
    );
    expect(reg.gate("codex", "codex-cli 0.0.1", dir).eligible).toBe(true);
    expect(reg.gate("codex", "codex-cli 0.2.0", dir).eligible).toBe(false);
  });
});

describe("parseEvent and classification", () => {
  const parse = (lines: unknown[]) => {
    const state = createParseState();
    const events = lines.flatMap((l) => adapter().parseEvent(typeof l === "string" ? l : JSON.stringify(l), state));
    return { state, events };
  };
  const exit = (code = 0): ExitInfo => ({ outcome: "exited", exitCode: code, signal: null, expectedExitCodes: [0] });

  it("captures the thread id in parse state and counts unknown events without trusting them", () => {
    const { state, events } = parse([
      { type: "thread.started", thread_id: "th-9" },
      { type: "future.event" },
      { type: "item.completed", item: { type: "future_item" } },
      [1, 2],
      { type: "item.started", item: { type: "command_execution" } },
    ]);
    expect(state.nativeSessionId).toBe("th-9");
    expect(state.unknownEvents).toBe(3);
    expect(events.filter((e) => e.kind === "unknown").map((e) => (e.kind === "unknown" ? e.rawType : ""))).toEqual([
      "future.event",
      "item:future_item",
      "none",
    ]);
  });

  it("thread.started without an id is not a session binding", () => {
    expect(parse([{ type: "thread.started" }]).events).toEqual([{ kind: "unknown", rawType: "thread.started" }]);
  });

  it.each([
    ["usage_limit_exceeded", "QUOTA_EXHAUSTED"],
    ["server_overloaded", "PROVIDER_OVERLOADED"],
    ["model_not_found", "MODEL_UNAVAILABLE"],
    ["unauthorized", "AUTH_REQUIRED"],
    [undefined, "TOOL_FAILURE"],
    ["something_new", "TOOL_FAILURE"],
  ])("error code %s -> %s (structured field only)", (code, expected) => {
    const { events } = parse([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.failed", error: { message: "rate limit exceeded; not logged in", ...(code ? { code } : {}) } },
    ]);
    expect(adapter().extractResult(events, exit(1)).failureCode).toBe(expected);
  });

  it("never reports success without turn.completed, on a non-zero exit, or after an error", () => {
    const a = adapter();
    expect(a.extractResult([], exit(0))).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    const done = parse([{ type: "turn.completed" }]).events;
    expect(a.extractResult(done, exit(0)).ok).toBe(true);
    expect(a.extractResult(done, exit(3))).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
    const errThenDone = parse([{ type: "error", message: "x" }, { type: "turn.completed" }]).events;
    expect(a.extractResult(errThenDone, exit(0)).ok).toBe(false);
  });

  it("ignores ACP input and unparseable lines (the supervisor fails the run)", () => {
    const state = createParseState();
    expect(adapter().parseEvent({ jsonrpc: "2.0", method: "x" }, state)).toEqual([]);
    expect(adapter().parseEvent("not json", state)).toEqual([]);
  });

  it("bounds message text and targets", () => {
    const long = "x".repeat(5000);
    const { events } = parse([
      { type: "item.completed", item: { type: "agent_message", text: long } },
      { type: "item.completed", item: { type: "command_execution", command: long, status: "completed" } },
    ]);
    const [m, t] = events as [NormalizedEvent, NormalizedEvent];
    expect(m.kind === "message" && m.text.length).toBeLessThan(2100);
    expect(t.kind === "tool_call" && (t.target ?? "").length).toBeLessThan(600);
  });
});

describe("resolveOnPath", () => {
  it("finds an executable file and skips non-executables and relative dirs", () => {
    const root = makeCwd();
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "codex"), "");
    writeFileSync(join(b, "codex"), "#!/bin/sh\n");
    chmodSync(join(b, "codex"), 0o755);
    expect(resolveOnPath("codex", `relative:${a}:${b}`)).toBe(join(b, "codex"));
    expect(resolveOnPath("codex", a)).toBeUndefined();
  });
});

// Keep the SRS profile shapes honest: both M2 profiles keep network off and repo config disabled.
it("test profiles match SRS §3.3 defaults", () => {
  for (const p of [INSPECT_PROFILE, EDIT_PROFILE] as ResolvedProfile[]) {
    expect(p).toMatchObject({ network: "off", repoConfig: "disabled", bypassApproved: false });
  }
});

describe("Git write operations (FR-GIT-01)", () => {
  const all = (): Array<[string, Invocation]> => [
    ["inspect", must(adapter().compile(request(), INSPECT_PROFILE))],
    ["edit", must(adapter().compile(request(), EDIT_PROFILE))],
    [
      "edit, read-only workspace",
      must(adapter().compile(request({ workspace: { cwd: "/w", writable: false } }), EDIT_PROFILE)),
    ],
    [
      "resume-inspect",
      must(adapter().resumeArgs({ provider: "codex", nativeSessionId: "t-1" }, request(), INSPECT_PROFILE)),
    ],
    ["resume-edit", must(adapter().resumeArgs({ provider: "codex", nativeSessionId: "t-1" }, request(), EDIT_PROFILE))],
  ];

  it("declares that Codex documents no Git write control, leaving FR-GIT-03 and FR-GIT-06", () => {
    const c = adapter().gitWriteControl;
    expect(c.kind).toBe("none-documented");
    expect(c.remainingControls).toEqual(["FR-GIT-03", "FR-GIT-06"]);
    expect(c.detail).toMatch(/no Codex per-command deny or allow rule/);
    expect(c.detail).toMatch(/Assumption/);
  });

  it("every compiled invocation uses only the read-only or workspace-write sandbox and grants nothing else", () => {
    for (const [name, inv] of all()) {
      const i = inv.argv.indexOf("--sandbox");
      expect(i, name).toBeGreaterThan(0);
      expect(["read-only", "workspace-write"], name).toContain(inv.argv[i + 1]);
      expect(
        inv.argv.filter((a) => a === "--sandbox"),
        name,
      ).toHaveLength(1);
      expect(auditInvocation(inv), name).toEqual([]);
      // Nothing in argv names git or a command to run; the prompt is on stdin (FR-ADP-04 / FR-POL-02).
      for (const a of inv.argv.slice(1)) expect(/\bgit\b|\bgh\b/.test(a), `${name}: ${a}`).toBe(false);
      // No credential-bearing variable reaches the agent (FR-GIT-06).
      expect(inv.envAllowlist, name).toEqual(["PATH", "HOME"]);
    }
  });

  it.each([
    "git commit",
    "git push",
    "git branch -f main",
    "git update-ref refs/heads/x HEAD",
    "git tag v1",
    "gh pr create",
  ])("allowlist entry %j is Ineligible (PROFILE_UNSUPPORTED)", (entry) => {
    const r = adapter().compile(request(), { ...EDIT_PROFILE, shellAllowlist: [entry] });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
  });

  it("any other non-empty allowlist is Ineligible: Codex documents no command allowlist (Q-11)", () => {
    expect(adapter().compile(request(), { ...EDIT_PROFILE, shellAllowlist: ["npm test"] })).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });
  });
});

describe("compile matrix (M3, T3.6; TDD §4.2.1)", () => {
  type Expected = { argv: string[] } | { reason: "PROFILE_UNSUPPORTED" | "CAPABILITY_MISSING"; detail?: RegExp };
  type Row = [
    label: string,
    profile: OverridableProfile,
    override: ProfileOverride | undefined,
    req: Partial<CompileRequest>,
    expected: Expected,
  ];
  const argv = (mode: "read-only" | "workspace-write") => [
    EXE,
    "exec",
    "--json",
    "--sandbox",
    mode,
    "--ignore-user-config",
    "--ignore-rules",
  ];
  const RO = { workspace: { cwd: "/work/tree", writable: false } };
  const CAP = (detail?: RegExp): Expected => ({ reason: "CAPABILITY_MISSING", ...(detail ? { detail } : {}) });
  const UNSUP = (detail?: RegExp): Expected => ({ reason: "PROFILE_UNSUPPORTED", ...(detail ? { detail } : {}) });
  const BROAD = { shell: "broad" } as const;
  const rows: Row[] = [
    // inspect-untrusted: decision 10, commands inside --sandbox read-only (confinement unverified, R-23)
    ["default", "inspect-untrusted", undefined, {}, { argv: argv("read-only") }],
    ["shell allowlist, empty", "inspect-untrusted", { shell: "allowlist" }, {}, { argv: argv("read-only") }],
    [
      "shell allowlist [npm test]",
      "inspect-untrusted",
      { shell: "allowlist", shellAllowlist: ["npm test"] },
      {},
      CAP(/Q-11/),
    ],
    ["shell broad", "inspect-untrusted", BROAD, {}, UNSUP(/shell=broad/)],
    [
      "network allowlist",
      "inspect-untrusted",
      { network: "allowlist", networkAllowlist: ["example.com"] },
      {},
      CAP(/network/),
    ],
    ["network policy", "inspect-untrusted", { network: "policy" }, {}, CAP(/network/)],
    ["repoConfig approved-only", "inspect-untrusted", { repoConfig: "approved-only" }, {}, CAP(/repoConfig/)],
    ["model requested", "inspect-untrusted", undefined, { model: "m" }, CAP(/model/)],
    // edit-untrusted: decision 10, commands inside --sandbox workspace-write
    ["default", "edit-untrusted", undefined, {}, { argv: argv("workspace-write") }],
    ["read-only workspace", "edit-untrusted", undefined, RO, { argv: argv("read-only") }],
    ["fileAccess read-only", "edit-untrusted", { fileAccess: "read-only" }, {}, { argv: argv("read-only") }],
    ["shell none", "edit-untrusted", { shell: "none" }, {}, { argv: argv("workspace-write") }],
    ["shell allowlist [npm test]", "edit-untrusted", { shellAllowlist: ["npm test"] }, {}, CAP(/Q-11/)],
    ["shell allowlist [git commit]", "edit-untrusted", { shellAllowlist: ["git commit"] }, {}, UNSUP(/FR-GIT-01/)],
    ["shell broad", "edit-untrusted", BROAD, {}, UNSUP(/shell=broad/)],
    ["network allowlist", "edit-untrusted", { network: "allowlist", networkAllowlist: ["a.example"] }, {}, CAP()],
    ["repoConfig allowlisted", "edit-untrusted", { repoConfig: "allowlisted" }, {}, CAP(/repoConfig/)],
    ["model requested", "edit-untrusted", undefined, { model: "m" }, CAP(/model/)],
    // test-sandboxed: Q-32 Proposed fail closed; capability gaps name their own reason first
    ["default", "test-sandboxed", undefined, {}, UNSUP(/Q-32/)],
    ["shell none", "test-sandboxed", { shell: "none" }, {}, UNSUP(/Q-32/)],
    ["shell broad", "test-sandboxed", BROAD, {}, UNSUP(/Q-32/)],
    ["read-only workspace", "test-sandboxed", undefined, RO, UNSUP(/Q-32/)],
    ["shell allowlist [npm test]", "test-sandboxed", { shellAllowlist: ["npm test"] }, {}, CAP(/Q-11/)],
    ["shell allowlist [git push]", "test-sandboxed", { shellAllowlist: ["git push"] }, {}, UNSUP(/FR-GIT-01/)],
    ["network allowlist", "test-sandboxed", { network: "allowlist", networkAllowlist: ["a.example"] }, {}, CAP()],
    ["repoConfig approved-only", "test-sandboxed", { repoConfig: "approved-only" }, {}, CAP(/repoConfig/)],
    ["model requested", "test-sandboxed", undefined, { model: "m" }, CAP(/model/)],
    // trusted-development: only documented controls compile; shell must be broad (commands inside the sandbox)
    ["default (empty allowlist)", "trusted-development", undefined, {}, CAP(/shell=allowlist/)],
    ["shell none", "trusted-development", { shell: "none" }, {}, CAP(/shell=none/)],
    ["shell allowlist [npm test]", "trusted-development", { shellAllowlist: ["npm test"] }, {}, CAP(/shell=allowlist/)],
    ["shell allowlist [git commit]", "trusted-development", { shellAllowlist: ["git commit"] }, {}, UNSUP(/FR-GIT-01/)],
    ["shell broad", "trusted-development", BROAD, {}, { argv: argv("workspace-write") }],
    ["shell broad, read-only workspace", "trusted-development", BROAD, RO, { argv: argv("read-only") }],
    [
      "shell broad, fileAccess read-only",
      "trusted-development",
      { ...BROAD, fileAccess: "read-only" },
      {},
      { argv: argv("read-only") },
    ],
    [
      "shell broad, network allowlist",
      "trusted-development",
      { ...BROAD, network: "allowlist", networkAllowlist: ["a.example"] },
      {},
      CAP(/network=allowlist/),
    ],
    ["shell broad, network policy", "trusted-development", { ...BROAD, network: "policy" }, {}, CAP(/network=policy/)],
    [
      "shell broad, repoConfig approved-only",
      "trusted-development",
      { ...BROAD, repoConfig: "approved-only" },
      {},
      CAP(/repoConfig/),
    ],
    [
      "shell broad, repoConfig allowlisted",
      "trusted-development",
      { ...BROAD, repoConfig: "allowlisted" },
      {},
      CAP(/repoConfig/),
    ],
    ["shell broad, model requested", "trusted-development", BROAD, { model: "m" }, CAP(/model/)],
  ];

  const compileRow = (
    profile: OverridableProfile,
    override: ProfileOverride | undefined,
    req: Partial<CompileRequest>,
  ) =>
    adapter().compile(
      request(req),
      resolveTrustProfile(profile, override ? { overrides: { [profile]: override } } : {}),
    );

  for (const [label, profile, override, req, expected] of rows) {
    it(`${profile} / ${label} -> ${"argv" in expected ? expected.argv.slice(4, 5).join("") : expected.reason}`, () => {
      const r = compileRow(profile, override, req);
      if ("argv" in expected) {
        const inv = must(r);
        expect(inv.argv).toEqual(expected.argv);
        expect(inv.policyFlags).toEqual(expected.argv.slice(3));
        expect(auditInvocation(inv)).toEqual([]);
      } else {
        expect(r).toMatchObject({ ineligible: true, reason: expected.reason });
        if (expected.detail) expect((r as { detail: string }).detail).toMatch(expected.detail);
      }
    });
  }

  it("a network allowlist is CAPABILITY_MISSING under every non-privileged profile, never downgraded", () => {
    for (const p of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
      const override: ProfileOverride = {
        ...(p === "trusted-development" ? BROAD : {}),
        network: "allowlist",
        networkAllowlist: ["registry.example"],
      };
      expect(compileRow(p, override, {}), p).toMatchObject({ ineligible: true, reason: "CAPABILITY_MISSING" });
    }
  });

  it("privileged stays Ineligible awaiting T3.17 and emits no bypass option, scope or approval notwithstanding", () => {
    const priv: ResolvedProfile = {
      name: "privileged",
      fileAccess: "scoped",
      shell: "scoped",
      network: "scoped",
      repoConfig: "scoped",
      bypassApproved: false,
    };
    for (const p of [priv, { ...priv, bypassApproved: true }, { ...EDIT_PROFILE, bypassApproved: true }]) {
      for (const r of [
        adapter().compile(request(), p),
        adapter().resumeArgs({ provider: "codex", nativeSessionId: "t-1" }, request(), p),
      ]) {
        expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
        expect((r as { detail: string }).detail).toContain(PRIVILEGED_DEFERRED);
        expect(JSON.stringify(r)).not.toMatch(/--yolo|--full-auto|--dangerously/);
      }
    }
  });

  it("no compiled argv in the matrix (or its resume form) carries a bypass flag or a second sandbox", () => {
    let compiled = 0;
    for (const [, profile, override, req] of rows) {
      const p = resolveTrustProfile(profile, override ? { overrides: { [profile]: override } } : {});
      for (const r of [
        adapter().compile(request(req), p),
        adapter().resumeArgs({ provider: "codex", nativeSessionId: "t-1" }, request(req), p),
      ]) {
        if (isIneligible(r as Invocation)) continue;
        const inv = r as Invocation;
        compiled += 1;
        expect(auditInvocation(inv)).toEqual([]);
        for (const a of inv.argv) expect(BYPASS_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))).toBe(false);
        expect(inv.argv.filter((a) => a === "--sandbox")).toHaveLength(1);
      }
    }
    expect(compiled).toBe(2 * rows.filter(([, , , , e]) => "argv" in e).length);
  });

  it("the Git-write declaration is unchanged: none-documented", () => {
    expect(adapter().gitWriteControl.kind).toBe("none-documented");
  });
});

describe("sandbox and permission denials per compilable profile (synthetic fixtures, conformance harness)", () => {
  const profiles: Array<[string, ResolvedProfile]> = [
    ["inspect-untrusted", resolveTrustProfile("inspect-untrusted")],
    ["edit-untrusted", resolveTrustProfile("edit-untrusted")],
    [
      "trusted-development (shell broad)",
      resolveTrustProfile("trusted-development", { overrides: { "trusted-development": { shell: "broad" } } }),
    ],
  ];
  for (const [name, profile] of profiles) {
    for (const [fixture, code] of [
      ["sandbox_denied", "SANDBOX_VIOLATION"],
      ["permission_denied", "PERMISSION_BLOCKED"],
    ] as const) {
      it(`${name}: ${fixture} ends ${code} without hanging; process group empty`, { timeout: 15_000 }, async () => {
        const report = await runConformanceCase({
          kind: "task_failure",
          adapter: replayAdapter(fixture),
          request: request({ workspace: { cwd: makeCwd(), writable: profile.fileAccess !== "read-only" } }),
          profile,
          expect: { ok: false, failureCode: code },
        });
        expect(report.checks.filter((k) => !k.ok)).toEqual([]);
        expect(report.result?.failureCode).toBe(code);
      });
    }
  }
});
