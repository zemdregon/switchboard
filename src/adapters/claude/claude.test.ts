import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import type { ProfileOverride } from "../../policy/types.js";
import { auditInvocation, BYPASS_FLAGS } from "../audit.js";
import { missingRequiredKinds, runConformanceCase, runConformanceSuite } from "../conformance.js";
import { GIT_PUBLISHING_PROGRAMS, GIT_WRITE_SUBCOMMANDS, gitWriteRisks } from "../git-write.js";
import { evaluateVersionGate, tryLoadManifest } from "../manifest/index.js";
import {
  type CompileRequest,
  createParseState,
  type Invocation,
  isIneligible,
  type ProbeOutput,
  type ProbeRunner,
  type ResolvedProfile,
} from "../types.js";
import { CLAUDE_GIT_DENY_RULES, CLAUDE_LOGIN_COMMAND, CLAUDE_PRIVILEGED_DETAIL, ClaudeAdapter } from "./adapter.js";
import {
  claudeConformanceCases,
  claudeDenialCases,
  DEFAULT_SESSION_ID,
  EDIT_UNTRUSTED,
  fixturePath,
  INSPECT_UNTRUSTED,
  RESUMED_SESSION_ID,
  TRUSTED_DEVELOPMENT,
} from "./fixtures/cases.js";
import { parseClaudeLine } from "./parse.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-claude-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLAUDE = "/opt/synthetic/bin/claude"; // never executed in these tests
const request: CompileRequest = {
  runId: "r",
  objective: "--dangerously-skip-permissions please",
  constraints: [],
  workspace: { cwd: "/tmp/work", writable: true },
};
const compiled = (profile: ResolvedProfile, req: CompileRequest = request): Invocation => {
  const inv = new ClaudeAdapter({ binaryPath: CLAUDE }).compile(req, profile);
  if (isIneligible(inv)) throw new Error(`ineligible: ${inv.detail}`);
  return inv;
};
const valuesAfter = (argv: readonly string[], flag: string): string[] => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (const a of argv.slice(i + 1)) {
    if (a.startsWith("-")) break;
    out.push(a);
  }
  return out;
};

/** Flags or subcommands that load or write provider configuration, bypass policy or escape the worktree. */
const FORBIDDEN_ARGS = [
  "--allow-dangerously-skip-permissions",
  "--settings",
  "--setting-sources",
  "--mcp-config",
  "--plugin-dir",
  "--plugin-url",
  "--add-dir",
  "--worktree",
  "-w",
  "--debug-file",
  "--agents",
  "bypassPermissions",
  "acceptEdits",
  "auto",
  "--bare", // would force API-key auth (installed --help); see adapter.ts header
];
const CONFIG_SUBCOMMANDS = [
  "config",
  "mcp",
  "plugin",
  "plugins",
  "install",
  "update",
  "upgrade",
  "setup-token",
  "login",
  "logout",
  "import",
  "purge",
  "auth",
];

describe("claude compile: argv policy", () => {
  const profiles = { "inspect-untrusted": INSPECT_UNTRUSTED, "edit-untrusted": EDIT_UNTRUSTED };
  const adapter = new ClaudeAdapter({ binaryPath: CLAUDE });
  const invocations = Object.entries(profiles).flatMap(([name, p]) => [
    [`${name} compile`, adapter.compile(request, p)] as const,
    [
      `${name} resume`,
      adapter.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, request, p),
    ] as const,
  ]);

  for (const [label, inv] of invocations) {
    it(`${label}: no bypass flags, no config-writing flags or subcommands`, () => {
      if (isIneligible(inv)) throw new Error(inv.detail);
      expect(auditInvocation(inv)).toEqual([]);
      for (const arg of [...inv.argv, ...inv.policyFlags]) {
        expect(BYPASS_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`))).toBe(false);
        expect(FORBIDDEN_ARGS).not.toContain(arg);
      }
      for (const sub of CONFIG_SUBCOMMANDS) expect(inv.argv.slice(1)).not.toContain(sub);
      expect(Object.keys(inv.env)).toEqual([]);
      expect(inv.envAllowlist).not.toContain("CLAUDE_CONFIG_DIR");
      expect(inv.envAllowlist.some((n) => /KEY|TOKEN|SECRET/i.test(n))).toBe(false);
    });

    it(`${label}: headless stream-json, fail-closed permissions, repo config disabled`, () => {
      if (isIneligible(inv)) throw new Error(inv.detail);
      expect(inv.argv[0]).toBe(CLAUDE);
      expect(inv.argv).toContain("-p");
      expect(valuesAfter(inv.argv, "--output-format")).toEqual(["stream-json"]);
      expect(valuesAfter(inv.argv, "--permission-mode")).toEqual(["dontAsk"]);
      expect(valuesAfter(inv.argv, "--permission-prompts")).toEqual(["none"]);
      for (const f of ["--safe-mode", "--restricted", "--strict-mcp-config"]) {
        expect(inv.argv).toContain(f);
        expect(inv.policyFlags).toContain(f);
      }
      expect(inv.outputFormat).toBe("jsonl");
      expect(inv.transport).toBe("subprocess-jsonl");
    });

    it(`${label}: objective goes on stdin, never into argv`, () => {
      if (isIneligible(inv)) throw new Error(inv.detail);
      expect(inv.stdin).toEqual({ kind: "text", value: request.objective });
      expect(inv.argv.some((a) => a.includes("please"))).toBe(false);
    });

    it(`${label}: tools and allow rules are explicit, never wildcards`, () => {
      if (isIneligible(inv)) throw new Error(inv.detail);
      const tools = valuesAfter(inv.argv, "--tools");
      const allow = valuesAfter(inv.argv, "--allowedTools");
      expect(tools).toHaveLength(1);
      expect(allow.length).toBeGreaterThan(0);
      for (const t of [...(tools[0] ?? "").split(","), ...allow]) {
        expect(t).not.toBe("");
        expect(t).not.toContain("*");
        expect(t).not.toBe("default");
      }
    });
  }

  it("inspect-untrusted exposes read tools only; edit-untrusted adds edit tools; neither has Bash", () => {
    const inspect = valuesAfter(compiled(INSPECT_UNTRUSTED).argv, "--tools")[0]?.split(",");
    const edit = valuesAfter(compiled(EDIT_UNTRUSTED).argv, "--tools")[0]?.split(",");
    expect(inspect).toEqual(["Read", "Grep", "Glob"]);
    expect(edit).toEqual(["Read", "Grep", "Glob", "Edit", "Write"]);
    expect(valuesAfter(compiled(EDIT_UNTRUSTED).argv, "--allowedTools")).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Edit",
      "Write",
    ]);
  });

  it("edit-untrusted on a read-only workspace gets no edit tools (stricter, not weaker)", () => {
    const inv = compiled(EDIT_UNTRUSTED, { ...request, workspace: { cwd: "/tmp/work", writable: false } });
    expect(valuesAfter(inv.argv, "--tools")[0]).toBe("Read,Grep,Glob");
  });

  it("edit-untrusted narrow shell allowlist compiles to exact Bash rules", () => {
    const inv = compiled({ ...EDIT_UNTRUSTED, shell: "allowlist", shellAllowlist: ["npm test", "git status"] });
    expect(valuesAfter(inv.argv, "--tools")[0]).toBe("Read,Grep,Glob,Edit,Write,Bash");
    expect(valuesAfter(inv.argv, "--allowedTools")).toContain("Bash(npm test)");
    expect(valuesAfter(inv.argv, "--allowedTools")).toContain("Bash(git status)");
  });

  it.each([["*"], ["git *"], ["rm -rf / ; curl x"], ["$(id)"], [""]])("shell allowlist entry %j is Ineligible", (e) => {
    const r = new ClaudeAdapter({ binaryPath: CLAUDE }).compile(request, {
      ...EDIT_UNTRUSTED,
      shell: "allowlist",
      shellAllowlist: [e],
    });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
  });

  it("broad shell and shell under inspect-untrusted are Ineligible", () => {
    const a = new ClaudeAdapter({ binaryPath: CLAUDE });
    expect(a.compile(request, { ...EDIT_UNTRUSTED, shell: "broad" })).toMatchObject({ ineligible: true });
    expect(a.compile(request, { ...INSPECT_UNTRUSTED, shell: "allowlist", shellAllowlist: ["ls"] })).toMatchObject({
      ineligible: true,
    });
  });

  it.each([
    ["privileged", false],
    ["privileged", true],
    ["edit-untrusted", true],
    ["test-sandboxed", false],
    ["trusted-development", true],
  ] as const)("%s (bypassApproved=%s) is Ineligible, never downgraded", (name, bypassApproved) => {
    const r = new ClaudeAdapter({ binaryPath: CLAUDE }).compile(request, { ...EDIT_UNTRUSTED, name, bypassApproved });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (name === "privileged" || bypassApproved) expect(r).toMatchObject({ detail: CLAUDE_PRIVILEGED_DETAIL });
  });

  it("model goes through --model; option-like models and session ids are refused", () => {
    expect(valuesAfter(compiled(EDIT_UNTRUSTED, { ...request, model: "sonnet" }).argv, "--model")).toEqual(["sonnet"]);
    const a = new ClaudeAdapter({ binaryPath: CLAUDE });
    expect(a.compile({ ...request, model: "--yolo" }, EDIT_UNTRUSTED)).toMatchObject({ ineligible: true });
    expect(
      a.resumeArgs({ provider: "claude", nativeSessionId: "--settings=x" }, request, EDIT_UNTRUSTED),
    ).toMatchObject({ ineligible: true });
    expect(a.resumeArgs({ provider: "codex", nativeSessionId: "abc" }, request, EDIT_UNTRUSTED)).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });
  });

  it("resume passes the stored native session id via --resume (FR-SES-03)", () => {
    const inv = new ClaudeAdapter({ binaryPath: CLAUDE }).resumeArgs(
      { provider: "claude", nativeSessionId: RESUMED_SESSION_ID },
      request,
      EDIT_UNTRUSTED,
    );
    if (isIneligible(inv)) throw new Error(inv.detail);
    expect(valuesAfter(inv.argv, "--resume")).toEqual([RESUMED_SESSION_ID]);
  });

  it("an unresolved (relative, unprobed) binary is Ineligible", () => {
    expect(new ClaudeAdapter({ binaryPath: "claude-not-probed" }).compile(request, EDIT_UNTRUSTED)).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });
  });
});

describe("claude compile: no permitted Git write operation (FR-GIT-01)", () => {
  const adapter = new ClaudeAdapter({ binaryPath: CLAUDE });
  const READ_ONLY_ALLOWLIST: ResolvedProfile = {
    ...EDIT_UNTRUSTED,
    shell: "allowlist",
    shellAllowlist: ["git status", "git diff --stat", "npm test"],
  };
  const profiles: Array<[string, ResolvedProfile]> = [
    ["inspect-untrusted", INSPECT_UNTRUSTED],
    ["edit-untrusted", EDIT_UNTRUSTED],
    ["edit-untrusted, empty allowlist", { ...EDIT_UNTRUSTED, shell: "allowlist", shellAllowlist: [] }],
    ["edit-untrusted, read-only allowlist", READ_ONLY_ALLOWLIST],
  ];
  const invocations = profiles.flatMap(([name, p]) => [
    [`${name} compile`, adapter.compile(request, p)] as const,
    [
      `${name} compile, read-only workspace`,
      adapter.compile({ ...request, workspace: { cwd: "/w", writable: false } }, p),
    ] as const,
    [
      `${name} resume`,
      adapter.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, request, p),
    ] as const,
  ]);
  /** Values of a variadic option: everything after it up to the next `--` option. */
  const rulesAfter = (argv: readonly string[], flag: string): string[] => {
    const i = argv.indexOf(flag);
    if (i < 0) return [];
    const end = argv.findIndex((a, j) => j > i && a.startsWith("--"));
    return argv.slice(i + 1, end < 0 ? undefined : end);
  };
  const bashCommand = (rule: string) => /^Bash\((.*)\)$/.exec(rule)?.[1];

  for (const [label, inv] of invocations) {
    it(`${label}: every Git write deny rule is passed with --disallowedTools`, () => {
      if (isIneligible(inv)) throw new Error(inv.detail);
      const deny = rulesAfter(inv.argv, "--disallowedTools");
      expect(deny).toEqual([...CLAUDE_GIT_DENY_RULES]);
      expect(rulesAfter(inv.policyFlags, "--disallowedTools")).toEqual([...CLAUDE_GIT_DENY_RULES]);
      for (const v of GIT_WRITE_SUBCOMMANDS) {
        expect(deny).toContain(`Bash(git ${v})`);
        expect(deny).toContain(`Bash(git ${v} *)`);
      }
      for (const o of ["-C", "-c", "--git-dir", "--work-tree"]) expect(deny).toContain(`Bash(git ${o} *)`);
      for (const p of GIT_PUBLISHING_PROGRAMS) expect(deny).toContain(`Bash(${p} *)`);
    });

    it(`${label}: no tool or allow rule grants a Git write`, () => {
      if (isIneligible(inv)) throw new Error(inv.detail);
      const tools = (valuesAfter(inv.argv, "--tools")[0] ?? "").split(",");
      const allow = rulesAfter(inv.argv, "--allowedTools");
      // A bare `Bash` allow rule (or a wildcard) would permit every command; only exact Bash(<command>) rules exist.
      expect(allow).not.toContain("Bash");
      const commands = allow.filter((r) => r.startsWith("Bash")).map((r) => bashCommand(r));
      for (const c of commands) expect(c, `allow rule for ${c}`).toBeDefined();
      expect(gitWriteRisks(commands as string[])).toEqual([]);
      // Without an allowlist there is no shell at all.
      if (commands.length === 0) expect(tools).not.toContain("Bash");
      // [HELP]: --worktree creates a Git worktree (and branch); --from-pr resumes a PR-linked session. Never emitted.
      for (const f of ["--worktree", "-w", "--tmux", "--from-pr", "--add-dir"]) expect(inv.argv).not.toContain(f);
      // --restricted (file-tool writes to git files need an approver) with nobody to approve.
      expect(inv.argv).toContain("--restricted");
      expect(valuesAfter(inv.argv, "--permission-prompts")).toEqual(["none"]);
      expect(auditInvocation(inv)).toEqual([]);
    });
  }

  it.each([
    "git commit",
    "git commit -m wip",
    "git push",
    "git push origin main",
    "git branch -f main",
    "git branch feature",
    "git update-ref refs/heads/main HEAD",
    "git tag v1",
    "git reset --hard",
    "git checkout -b x",
    "git stash",
    "git config alias.ci commit",
    "git -C . commit",
    "git -c alias.x=commit x",
    "/usr/bin/git push",
    "git ci",
    "gh pr create",
    "env git commit",
  ])("allowlist entry %j makes edit-untrusted Ineligible", (entry) => {
    const r = adapter.compile(request, {
      ...EDIT_UNTRUSTED,
      shell: "allowlist",
      shellAllowlist: ["git status", entry],
    });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
    if (isIneligible(r)) expect(r.detail).toContain("FR-GIT-01");
  });

  it("declares provider deny rules with FR-GIT-03 and FR-GIT-06 as backing controls", () => {
    expect(adapter.gitWriteControl).toMatchObject({
      kind: "provider-deny-rules",
      remainingControls: ["FR-GIT-03", "FR-GIT-06"],
    });
    expect(adapter.gitWriteControl.detail).toMatch(/--disallowedTools/);
  });

  it("probe fails the flags step when --disallowedTools is not in the help text", async () => {
    const help =
      "-p, --print\n--output-format stream-json\n--permission-mode dontAsk\n--permission-prompts\n--tools\n" +
      "--allowedTools\n--safe-mode\n--restricted\n--strict-mcp-config\n--resume\n";
    const runner: ProbeRunner = async (argv) => ({
      exitCode: 0,
      stdout: argv.at(-1) === "--version" ? "2.1.296 (Claude Code)\n" : help,
      stderr: "",
      timedOut: false,
    });
    const r = await adapter.probe(runner);
    expect(r.steps.find((s) => s.step === "flags")).toMatchObject({ ok: false, detail: "missing: --disallowedTools" });
  });
});

describe("claude compile matrix (M3)", () => {
  // T3.5, TDD §4.1.1 (Linux). Profiles come from the real resolver with `profiles.<name>` overrides (owner decisions
  // 10-12), so the matrix is tested on what the controller would hand the adapter.
  const adapter = new ClaudeAdapter({ binaryPath: CLAUDE });
  const R = ["Read", "Grep", "Glob"];
  const RW = [...R, "Edit", "Write"];
  const argvFor = (tools: readonly string[], allow: readonly string[]): string[] => [
    CLAUDE,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--tools",
    tools.join(","),
    "--allowedTools",
    ...allow,
    "--disallowedTools",
    ...CLAUDE_GIT_DENY_RULES,
  ];
  type Name = "inspect-untrusted" | "edit-untrusted" | "test-sandboxed" | "trusted-development";
  type Expected = { argv: string[] } | { reason: "PROFILE_UNSUPPORTED" | "CAPABILITY_MISSING"; detail: RegExp };
  const TS_DETAIL = /test-sandboxed: .*no per-run sandbox.*FR-POL-06.*R-10, Q-16/;
  const rows: Array<[label: string, name: Name, override: ProfileOverride, writable: boolean, expected: Expected]> = [
    ["inspect-untrusted default", "inspect-untrusted", {}, true, { argv: argvFor(R, R) }],
    ["edit-untrusted default", "edit-untrusted", {}, true, { argv: argvFor(RW, RW) }],
    ["trusted-development default", "trusted-development", {}, true, { argv: argvFor(RW, RW) }],
    ["trusted-development, read-only workspace", "trusted-development", {}, false, { argv: argvFor(R, R) }],
    ["trusted-development shell=none", "trusted-development", { shell: "none" }, true, { argv: argvFor(RW, RW) }],
    [
      "trusted-development shell allowlist",
      "trusted-development",
      { shellAllowlist: ["npm test", "git status"] },
      true,
      { argv: argvFor([...RW, "Bash"], [...RW, "Bash(npm test)", "Bash(git status)"]) },
    ],
    [
      "trusted-development file_access=read-only with allowlist",
      "trusted-development",
      { fileAccess: "read-only", shellAllowlist: ["npm test"] },
      true,
      { argv: argvFor([...R, "Bash"], [...R, "Bash(npm test)"]) },
    ],
    [
      "trusted-development shell=broad (network off)",
      "trusted-development",
      { shell: "broad" },
      true,
      { reason: "CAPABILITY_MISSING", detail: /shell=broad with network=off.*Q-34/ },
    ],
    [
      "trusted-development network=policy",
      "trusted-development",
      { network: "policy" },
      true,
      { reason: "CAPABILITY_MISSING", detail: /network=policy.*no network or host control/ },
    ],
    [
      "trusted-development network=allowlist",
      "trusted-development",
      { network: "allowlist", networkAllowlist: ["registry.example.test"] },
      true,
      { reason: "CAPABILITY_MISSING", detail: /network=allowlist/ },
    ],
    [
      "trusted-development shell=broad, network=policy",
      "trusted-development",
      { shell: "broad", network: "policy" },
      true,
      { reason: "CAPABILITY_MISSING", detail: /network=policy/ },
    ],
    [
      "trusted-development repo_config=approved-only",
      "trusted-development",
      { repoConfig: "approved-only" },
      true,
      { reason: "CAPABILITY_MISSING", detail: /repo_config=approved-only.*ADR-0015/ },
    ],
    [
      "trusted-development repo_config=allowlisted",
      "trusted-development",
      { repoConfig: "allowlisted" },
      true,
      { reason: "CAPABILITY_MISSING", detail: /repo_config=allowlisted/ },
    ],
    [
      "trusted-development allowlist entry that writes Git",
      "trusted-development",
      { shellAllowlist: ["npm test", "git commit -m wip"] },
      true,
      { reason: "PROFILE_UNSUPPORTED", detail: /FR-GIT-01/ },
    ],
    [
      "trusted-development allowlist entry that is not plain",
      "trusted-development",
      { shellAllowlist: ["rm -rf / ; curl x"] },
      true,
      { reason: "PROFILE_UNSUPPORTED", detail: /not expressible narrowly/ },
    ],
    ["test-sandboxed default", "test-sandboxed", {}, true, { reason: "PROFILE_UNSUPPORTED", detail: TS_DETAIL }],
    [
      "test-sandboxed tightened to no shell, read-only",
      "test-sandboxed",
      { shell: "none", fileAccess: "read-only" },
      true,
      { reason: "PROFILE_UNSUPPORTED", detail: TS_DETAIL },
    ],
    [
      "test-sandboxed with build/test allowlist",
      "test-sandboxed",
      { shellAllowlist: ["npm test"] },
      true,
      { reason: "PROFILE_UNSUPPORTED", detail: TS_DETAIL },
    ],
    [
      "test-sandboxed loosened everywhere",
      "test-sandboxed",
      { shell: "broad", network: "policy", repoConfig: "allowlisted" },
      true,
      { reason: "PROFILE_UNSUPPORTED", detail: TS_DETAIL },
    ],
    [
      "edit-untrusted shell=broad",
      "edit-untrusted",
      { shell: "broad" },
      true,
      { reason: "PROFILE_UNSUPPORTED", detail: /shell=broad is not narrow/ },
    ],
  ];

  it.each(rows)("%s", (_label, name, override, writable, expected) => {
    const profile = resolveTrustProfile(name, { overrides: { [name]: override } });
    const req: CompileRequest = { ...request, workspace: { cwd: "/tmp/work", writable } };
    for (const inv of [
      adapter.compile(req, profile),
      adapter.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, req, profile),
    ]) {
      if ("argv" in expected) {
        if (isIneligible(inv)) throw new Error(`ineligible: ${inv.reason} ${inv.detail}`);
        const resumed = inv.argv.includes("--resume");
        expect(inv.argv).toEqual(resumed ? [...expected.argv, "--resume", RESUMED_SESSION_ID] : expected.argv);
        expect(auditInvocation(inv)).toEqual([]);
      } else {
        expect(inv).toMatchObject({ ineligible: true, reason: expected.reason });
        if (isIneligible(inv)) expect(inv.detail).toMatch(expected.detail);
      }
    }
  });

  it("privileged stays Ineligible (T3.17), with or without bypass, from any shape", () => {
    const scoped: ResolvedProfile = {
      name: "privileged",
      fileAccess: "scoped",
      shell: "scoped",
      network: "scoped",
      repoConfig: "scoped",
      bypassApproved: false,
    };
    for (const p of [scoped, { ...scoped, bypassApproved: true }, { ...TRUSTED_DEVELOPMENT, bypassApproved: true }]) {
      expect(adapter.compile(request, p)).toEqual({
        ineligible: true,
        reason: "PROFILE_UNSUPPORTED",
        detail: CLAUDE_PRIVILEGED_DETAIL,
      });
    }
    expect(CLAUDE_PRIVILEGED_DETAIL).toContain("bypass/privileged compile awaits T3.17");
  });

  it("a scoped dimension outside privileged is Ineligible", () => {
    expect(adapter.compile(request, { ...TRUSTED_DEVELOPMENT, network: "scoped" })).toMatchObject({
      ineligible: true,
      reason: "PROFILE_UNSUPPORTED",
    });
  });

  /** Every override combination the resolver accepts (applied to each of the four overridable profiles). */
  const sweep = () => {
    const out: Array<{ override: ProfileOverride; writable: boolean }> = [];
    for (const fileAccess of ["read-only", "worktree"] as const)
      for (const shell of ["none", "allowlist", "broad"] as const)
        for (const shellAllowlist of shell === "allowlist" ? [[], ["npm test", "git status"]] : [undefined])
          for (const network of ["off", "allowlist", "policy"] as const)
            for (const repoConfig of ["disabled", "approved-only", "allowlisted"] as const)
              for (const writable of [true, false])
                out.push({
                  override: {
                    fileAccess,
                    shell,
                    network,
                    repoConfig,
                    ...(shellAllowlist ? { shellAllowlist } : {}),
                    ...(network === "allowlist" ? { networkAllowlist: ["registry.example.test"] } : {}),
                  },
                  writable,
                });
    return out;
  };
  const rulesAfter = (argv: readonly string[], flag: string): string[] => {
    const i = argv.indexOf(flag);
    if (i < 0) return [];
    const end = argv.findIndex((a, j) => j > i && a.startsWith("--"));
    return argv.slice(i + 1, end < 0 ? undefined : end);
  };

  for (const name of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
    it(`${name}: every cell compiles with the Git deny rules and no bypass, or is Ineligible with a reason`, () => {
      let compiledCount = 0;
      for (const { override, writable } of sweep()) {
        const label = `${name} ${JSON.stringify(override)} writable=${writable}`;
        const profile = resolveTrustProfile(name, { overrides: { [name]: override } });
        const req: CompileRequest = { ...request, workspace: { cwd: "/tmp/work", writable } };
        for (const inv of [
          adapter.compile(req, profile),
          adapter.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, req, profile),
        ]) {
          if (isIneligible(inv)) {
            expect(["PROFILE_UNSUPPORTED", "CAPABILITY_MISSING"], label).toContain(inv.reason);
            expect(inv.detail, label).not.toBe("");
            continue;
          }
          compiledCount += 1;
          expect(name, label).not.toBe("test-sandboxed"); // R-10, Q-16
          expect(profile.shell, label).not.toBe("broad"); // Q-34: never compiled for Claude today
          if (name === "trusted-development") {
            expect([profile.network, profile.repoConfig], label).toEqual(["off", "disabled"]);
          }
          // FR-GIT-01: the full deny rule set on every compiled invocation, writable or not.
          expect(rulesAfter(inv.argv, "--disallowedTools"), label).toEqual([...CLAUDE_GIT_DENY_RULES]);
          expect(rulesAfter(inv.policyFlags, "--disallowedTools"), label).toEqual([...CLAUDE_GIT_DENY_RULES]);
          const allow = rulesAfter(inv.argv, "--allowedTools");
          expect(allow, label).not.toContain("Bash");
          const commands = allow.filter((r) => r.startsWith("Bash")).map((r) => /^Bash\((.*)\)$/.exec(r)?.[1] ?? "");
          expect(gitWriteRisks(commands), label).toEqual([]);
          // FR-POL-03: no bypass flag; FR-POL-04/08: repository configuration stays off; nothing config-loading.
          expect(auditInvocation(inv), label).toEqual([]);
          for (const f of ["--safe-mode", "--restricted", "--strict-mcp-config"]) expect(inv.argv, label).toContain(f);
          expect(valuesAfter(inv.argv, "--permission-mode"), label).toEqual(["dontAsk"]);
          expect(valuesAfter(inv.argv, "--permission-prompts"), label).toEqual(["none"]);
          for (const arg of inv.argv) expect(FORBIDDEN_ARGS, label).not.toContain(arg);
          const tools = (valuesAfter(inv.argv, "--tools")[0] ?? "").split(",");
          expect(tools.includes("Edit"), label).toBe(
            profile.fileAccess === "worktree" && writable && name !== "inspect-untrusted",
          );
        }
      }
      if (name === "test-sandboxed") expect(compiledCount).toBe(0);
      else expect(compiledCount).toBeGreaterThan(0);
    });
  }

  it("synthetic denial fixtures (PERMISSION_BLOCKED, SANDBOX_VIOLATION) run through the harness without hanging", async () => {
    const cases = claudeDenialCases(makeCwd);
    const started = Date.now();
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.cases.map((c) => c.result?.failureCode)).toEqual([
      undefined,
      "PERMISSION_BLOCKED",
      "PERMISSION_BLOCKED",
      "SANDBOX_VIOLATION",
      "SANDBOX_VIOLATION",
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("claude parseEvent", () => {
  const lines = (name: string) =>
    readFileSync(fixturePath(name), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.includes('"_fixture"'))
      .map((l) => l.replaceAll("{{SESSION_ID}}", DEFAULT_SESSION_ID));
  const parseAll = (name: string) => {
    const state = createParseState();
    return { events: lines(name).flatMap((l) => parseClaudeLine(l, state)), state };
  };

  it("success fixture: session, tool calls, message, usage, result", () => {
    const { events, state } = parseAll("success-edit.jsonl");
    expect(state.nativeSessionId).toBe(DEFAULT_SESSION_ID);
    expect(events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: DEFAULT_SESSION_ID, model: "synthetic-model" },
    ]);
    expect(events).toContainEqual({ kind: "tool_call", tool: "read", name: "Read", target: "README.md" });
    expect(events).toContainEqual({ kind: "tool_call", tool: "edit", name: "Edit", target: "hello.txt" });
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "Updated hello.txt." });
    expect(events).toContainEqual({
      kind: "usage",
      source: "provider_reported",
      metrics: {
        total_cost_usd: 0.01,
        num_turns: 3,
        duration_ms: 1200,
        "usage.input_tokens": 100,
        "usage.output_tokens": 20,
      },
    });
    expect(events.at(-1)).toEqual({ kind: "result", ok: true, summary: "Updated hello.txt." });
    expect(events.filter((e) => e.kind === "unknown")).toEqual([
      { kind: "unknown", rawType: "system:synthetic_future_subtype" },
    ]);
  });

  it("maps error categories, rate limits and permission denials", () => {
    expect(parseAll("auth-missing.jsonl").events).toContainEqual({
      kind: "provider_error",
      category: "auth",
      message: "authentication_failed",
    });
    const rl = parseAll("rate-limit.jsonl").events;
    expect(rl).toContainEqual({
      kind: "rate_limit",
      resetAt: "2027-01-01T00:00:00.000Z",
      reportedCategory: "five_hour",
    });
    expect(rl).toContainEqual({ kind: "provider_error", category: "rate_limit", message: "rate_limit" });
    const pd = parseAll("permission-denied.jsonl").events;
    expect(pd).toContainEqual({ kind: "permission_denied", tool: "Bash" });
    expect(pd).toContainEqual({ kind: "tool_call", tool: "shell", name: "Bash" }); // command text not copied
  });

  it("never yields events for unparseable or non-object lines", () => {
    const s = createParseState();
    expect(parseClaudeLine("this line is deliberately not json {", s)).toEqual([]);
    expect(parseClaudeLine("[1,2]", s)).toEqual([]);
    expect(parseClaudeLine('"x"', s)).toEqual([]);
    expect(s.lines).toBe(3);
  });

  it("thinking blocks are dropped (NFR-PRIV-02) and errored results are not ok", () => {
    const s = createParseState();
    const ev = parseClaudeLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "secret plan" }] } }),
      s,
    );
    expect(ev).toEqual([]);
    expect(parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: true }), s)).toEqual([
      { kind: "result", ok: false, summary: "success" },
    ]);
    expect(parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }), s)).toEqual([
      { kind: "result", ok: false, summary: "error_max_turns" },
    ]);
  });

  it("billing and overload categories map to quota and overloaded", () => {
    const s = createParseState();
    expect(parseClaudeLine(JSON.stringify({ type: "assistant", error: "billing_error" }), s)).toContainEqual({
      kind: "provider_error",
      category: "quota",
      message: "billing_error",
    });
    expect(parseClaudeLine(JSON.stringify({ type: "assistant", error: "server_error" }), s)).toContainEqual({
      kind: "provider_error",
      category: "overloaded",
      message: "server_error",
    });
  });
});

describe("claude conformance on recorded (synthetic) fixtures", () => {
  it("covers the FR-ADP-11 kinds and passes the full suite", async () => {
    const cases = claudeConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("success with edit leaves the file and reports the native session id", async () => {
    const c = claudeConformanceCases(makeCwd)[0];
    if (!c) throw new Error("missing");
    const report = await runConformanceCase(c);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Updated hello.txt.",
    });
    expect(report.result?.unknownEventCount).toBe(1);
    expect(readFileSync(join(c.request.workspace.cwd, "hello.txt"), "utf8")).toContain("synthetic");
  });
});

describe("claude probe and auth preflight (injected runner; the real CLI is never run)", () => {
  const fake = (table: Record<string, Partial<ProbeOutput>>): ProbeRunner & { calls: string[][] } => {
    const calls: string[][] = [];
    const fn = (async (argv: readonly string[]) => {
      calls.push([...argv]);
      const key = argv.slice(1).join(" ");
      const hit = table[key];
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...hit };
    }) as ProbeRunner & { calls: string[][] };
    fn.calls = calls;
    return fn;
  };
  const HELP =
    "-p, --print\n--output-format stream-json\n--permission-mode dontAsk\n--permission-prompts\n--tools\n--allowedTools\n--disallowedTools\n--safe-mode\n--restricted\n--strict-mcp-config\n--resume\n";

  it("probe uses only --version and --help and parses the version", async () => {
    const runner = fake({ "--version": { stdout: "2.1.296 (Claude Code)\n" }, "--help": { stdout: HELP } });
    const r = await new ClaudeAdapter({ binaryPath: CLAUDE }).probe(runner);
    expect(r.binaryVersion).toBe("2.1.296");
    expect(r.steps.every((s) => s.ok)).toBe(true);
    expect(runner.calls.map((c) => c.slice(1))).toEqual([["--version"], ["--help"]]);
  });

  it("probe flags missing documented options", async () => {
    const runner = fake({ "--version": { stdout: "2.1.296 (Claude Code)\n" }, "--help": { stdout: "-p, --print\n" } });
    const r = await new ClaudeAdapter({ binaryPath: CLAUDE }).probe(runner);
    expect(r.steps.find((s) => s.step === "flags")?.ok).toBe(false);
  });

  it("probe reports a missing binary", async () => {
    const r = await new ClaudeAdapter({ binaryPath: "definitely-not-a-binary-xyz" }).probe(fake({}));
    expect(r.binaryVersion).toBeNull();
    expect(r.steps[0]).toMatchObject({ step: "binary", ok: false });
  });

  it("probed version passes the Claude manifest gate", () => {
    const { loaded } = tryLoadManifest("claude");
    expect(evaluateVersionGate("claude", loaded?.manifest, "2.1.296").eligible).toBe(true);
  });

  it("auth preflight uses `auth status --json` and maps logged in / logged out / unknown", async () => {
    const statusIn = readFileSync(fixturePath("auth-status-logged-in.json"), "utf8");
    const statusOut = readFileSync(fixturePath("auth-status-logged-out.json"), "utf8");
    const a = new ClaudeAdapter({ binaryPath: CLAUDE });
    const ok = fake({ "auth status --json": { stdout: statusIn } });
    expect(await a.authPreflight(ok)).toEqual({ state: "OK" });
    expect(ok.calls).toEqual([[CLAUDE, "auth", "status", "--json"]]);
    expect(await a.authPreflight(fake({ "auth status --json": { stdout: statusOut, exitCode: 1 } }))).toEqual({
      state: "AUTH_REQUIRED",
      loginCommand: CLAUDE_LOGIN_COMMAND,
    });
    expect(await a.authPreflight(fake({ "auth status --json": { stdout: statusOut, exitCode: 0 } }))).toMatchObject({
      state: "AUTH_REQUIRED",
    });
    expect(await a.authPreflight(fake({ "auth status --json": { stdout: "not json", exitCode: 1 } }))).toMatchObject({
      state: "UNKNOWN",
    });
    expect(
      await a.authPreflight(fake({ "auth status --json": { spawnError: "ENOENT", exitCode: null } })),
    ).toMatchObject({
      state: "UNKNOWN",
    });
    expect(await a.authPreflight(fake({ "auth status --json": { timedOut: true, exitCode: null } }))).toMatchObject({
      state: "UNKNOWN",
    });
  });
});
