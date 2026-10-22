import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { syntheticBundle } from "../../continuity/fixtures/handoff-bundle.js";
import { INSTRUCTION_MARKER, renderHandoffPrompt } from "../../continuity/render.js";
import { DEFAULT_MAX_LINE_BYTES } from "../../exec/index.js";
import { SIGNING_AGENT_VARIABLES } from "../../git/sign.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import type { ProfileOverride } from "../../policy/types.js";
import { auditInvocation, BYPASS_FLAGS, BypassFlagError, findBypassFlags } from "../audit.js";
import { missingRequiredKinds, runConformanceCase, runConformanceSuite } from "../conformance.js";
import { LOOSE_SCOPE, privilegedProfile, scopeShapes } from "../fixtures/privileged.js";
import { replayLauncher } from "../fixtures/replay.js";
import {
  GIT_GLOBAL_FLAGS,
  GIT_GLOBAL_OPTIONS_WITH_VALUE,
  GIT_PUBLISHING_PROGRAMS,
  GIT_WRITE_SUBCOMMANDS,
  gitWriteRisks,
} from "../git-write.js";
import { evaluateVersionGate, tryLoadManifest } from "../manifest/index.js";
import { providerEntry } from "../providers.js";
import { startAdapterRun } from "../run.js";
import {
  type CompileRequest,
  createParseState,
  type Invocation,
  isIneligible,
  type ProbeOutput,
  type ProbeRunner,
  type ResolvedProfile,
} from "../types.js";
import {
  CLAUDE_BYPASS_FLAG,
  CLAUDE_BYPASS_GIT_DENY_RULES,
  CLAUDE_BYPASS_NOT_APPROVED,
  CLAUDE_BYPASS_OUTSIDE_PRIVILEGED,
  CLAUDE_GIT_DENY_RULES,
  CLAUDE_LOGIN_COMMAND,
  CLAUDE_STDOUT_LINE_BYTES,
  ClaudeAdapter,
} from "./adapter.js";
import {
  claudeConformanceCases,
  claudeDenialCases,
  claudePrivilegedDenialCases,
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

/**
 * Flags or subcommands that load or write provider configuration, bypass policy or escape the worktree. `--mcp-config`
 * stays here: `compile` never emits it; only the opt-in channel fragment does (T9.4b, ADR-0029), and its one admitted
 * shape and every refused form are tested in `./channel.test.ts`.
 */
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
      // T9.10 (FR-GIT-10): the signing key and agent variables stay with the controller's own Git child.
      for (const v of SIGNING_AGENT_VARIABLES) expect(inv.envAllowlist).not.toContain(v);
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
    // privileged without a scope binding; a bypass approval outside privileged (FR-POL-03).
    if (name === "privileged") expect(r).toMatchObject({ detail: expect.stringMatching(/without an approved scope/) });
    else if (bypassApproved) expect(r).toMatchObject({ detail: CLAUDE_BYPASS_OUTSIDE_PRIVILEGED });
  });

  it.each([INSPECT_UNTRUSTED, EDIT_UNTRUSTED, TRUSTED_DEVELOPMENT])(
    "$name with CompileRequest.bypassApproved is Ineligible (a bypass belongs to privileged only)",
    (p) => {
      const a = new ClaudeAdapter({ binaryPath: CLAUDE });
      const req = { ...request, bypassApproved: true };
      for (const r of [
        a.compile(req, p),
        a.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, req, p),
      ])
        expect(r).toEqual({
          ineligible: true,
          reason: "PROFILE_UNSUPPORTED",
          detail: CLAUDE_BYPASS_OUTSIDE_PRIVILEGED,
        });
    },
  );

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

  it("declares resumeCwd as independent and matches the registry entry (T5.12, live cell 2)", () => {
    const a = new ClaudeAdapter({ binaryPath: CLAUDE });
    expect(a.resumeCwd).toBe("independent");
    expect(providerEntry("claude")?.resumeCwd).toBe("independent");
  });

  it("resume from a second worktree compiles for Claude (T5.12 cell 2; resumeCwd independent)", () => {
    const a = new ClaudeAdapter({ binaryPath: CLAUDE });
    expect(a.resumeCwd).toBe("independent");
    const secondWorktree = "/path/to/second/worktree";
    const req: CompileRequest = {
      ...request,
      workspace: { cwd: secondWorktree, writable: true },
    };
    const inv = a.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, req, EDIT_UNTRUSTED);
    if (isIneligible(inv)) throw new Error(inv.detail);
    expect(inv.cwd).toBe(secondWorktree);
    expect(valuesAfter(inv.argv, "--resume")).toEqual([RESUMED_SESSION_ID]);
  });

  it("an unresolved (relative, unprobed) binary is Ineligible", () => {
    expect(new ClaudeAdapter({ binaryPath: "claude-not-probed" }).compile(request, EDIT_UNTRUSTED)).toMatchObject({
      ineligible: true,
      reason: "CAPABILITY_MISSING",
    });
  });
});

describe("claude compile: trusted-development shell allowlist rule form (ADR-0066)", () => {
  // Regression: prod runs run_01M5BST5DB1MXXSRY3DM3KR1KE and run_01M5BST5YTYSQKW0KGPRCWM2F8 (Claude Code 2.1.294,
  // dontAsk) had every Bash call with arguments denied, `npx tsc --noEmit` included, because the entry `npx` compiled
  // to the exact rule `Bash(npx)`. The operator allowlist of profiles.trusted-development, as configured there:
  const PROD_ALLOWLIST = [
    "cat",
    "cp",
    "diff",
    "echo",
    "find",
    "grep",
    "head",
    "ls",
    "make",
    "mkdir",
    "mv",
    "node",
    "npm",
    "npx",
    "python3",
    "rg",
    "sed",
    "tail",
    "wc",
    "go",
    "cargo",
  ];
  /**
   * The documented Bash rule matching (code.claude.com/docs/en/permissions, read 2026-10-20): "A rule with no `*`
   * matches one exact command"; a trailing ` *` matches the bare command and the command with any arguments, and the
   * space keeps `Bash(ls *)` from matching `lsof`. Compound commands are split before matching, so only simple
   * commands are checked here.
   */
  const allows = (rules: readonly string[], command: string): boolean =>
    rules.some((r) => {
      const body = /^Bash\((.*)\)$/.exec(r)?.[1];
      if (body === undefined) return false;
      if (!body.endsWith(" *")) return command === body;
      const prefix = body.slice(0, -2);
      return command === prefix || command.startsWith(`${prefix} `);
    });
  const allowRules = (profile: ResolvedProfile): string[] => {
    const argv = compiled(profile).argv;
    const i = argv.indexOf("--allowedTools");
    const end = argv.indexOf("--disallowedTools");
    return argv.slice(i + 1, end);
  };
  const trusted = (shellAllowlist: string[]): ResolvedProfile => ({
    ...TRUSTED_DEVELOPMENT,
    shellAllowlist,
  });

  it("the prod allowlist compiles `Bash(<entry>)` and `Bash(<entry> *)` for every entry, with Bash enabled", () => {
    const inv = compiled(trusted(PROD_ALLOWLIST));
    expect(valuesAfter(inv.argv, "--tools")[0]).toBe("Read,Grep,Glob,Edit,Write,Bash");
    const rules = allowRules(trusted(PROD_ALLOWLIST));
    expect(rules.filter((r) => r.startsWith("Bash"))).toEqual(
      PROD_ALLOWLIST.flatMap((e) => [`Bash(${e})`, `Bash(${e} *)`]),
    );
    // Never a bare `Bash` or a rule that is only a wildcard.
    expect(rules).not.toContain("Bash");
    expect(rules).not.toContain("Bash(*)");
    expect(auditInvocation(inv)).toEqual([]);
  });

  it.each([
    ["npx tsc --noEmit", true],
    ["npx tsc --version", true],
    ["npx vitest run src/adapters", true],
    ["npm run lint", true],
    ["node scripts/check-docs.mjs", true],
    ["make", true],
    ["ls", true],
    ["ls -la", true],
    ["lsof -i", false],
    ["npxx tsc", false],
    ["curl https://example.org", false],
    ["git commit -m x", false],
    ["git status", false],
  ] as const)("prod allowlist: %j allowed=%s under the documented matcher", (command, expected) => {
    expect(allows(allowRules(trusted(PROD_ALLOWLIST)), command)).toBe(expected);
  });

  it("the pre-fix exact form would not have allowed `npx tsc --noEmit` (the bug this pins)", () => {
    expect(allows(["Bash(npx)"], "npx tsc --noEmit")).toBe(false);
    expect(allows(["Bash(npx)", "Bash(npx *)"], "npx tsc --noEmit")).toBe(true);
  });

  it("entries with arguments keep them as the rule prefix", () => {
    const rules = allowRules(trusted(["npm test", "npm run build"]));
    expect(rules).toContain("Bash(npm test *)");
    expect(allows(rules, "npm test -- --watch")).toBe(true);
    expect(allows(rules, "npm install left-pad")).toBe(false);
  });

  it.each([["git status"], ["git log"], ["/usr/bin/git diff"], ["git-receive-pack"]])(
    "a git entry %j stays an exact rule (appended arguments could add a write path)",
    (entry) => {
      const r = new ClaudeAdapter({ binaryPath: CLAUDE }).compile(request, trusted([entry]));
      if (isIneligible(r)) return; // refused by gitWriteRisks (FR-GIT-01): also never a prefix rule
      const rules = allowRules(trusted([entry]));
      expect(rules).toContain(`Bash(${entry})`);
      expect(rules).not.toContain(`Bash(${entry} *)`);
    },
  );

  it("a bare `git` entry never becomes `Bash(git *)`", () => {
    const rules = allowRules(trusted(["git"]));
    expect(rules).toContain("Bash(git)");
    expect(rules).not.toContain("Bash(git *)");
    expect(allows(rules, "git commit -m x")).toBe(false);
  });

  it("edit-untrusted keeps exact rules for the same allowlist (SRS: edits without arbitrary execution)", () => {
    const rules = allowRules({
      ...EDIT_UNTRUSTED,
      shell: "allowlist",
      shellAllowlist: PROD_ALLOWLIST,
    });
    expect(rules.filter((r) => r.startsWith("Bash"))).toEqual(PROD_ALLOWLIST.map((e) => `Bash(${e})`));
    expect(allows(rules, "npx tsc --noEmit")).toBe(false);
  });

  it("trusted-development still refuses entries that could write Git or are not plain", () => {
    const a = new ClaudeAdapter({ binaryPath: CLAUDE });
    for (const e of ["git commit", "gh", "env", "xargs", "npx *", "npm test; git push"]) {
      expect(a.compile(request, trusted(["npx", e])), e).toMatchObject({
        ineligible: true,
        reason: "PROFILE_UNSUPPORTED",
      });
    }
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
      // R-43: every Git global option spelling, including ones that do not change the target (`--no-pager`, `-P`).
      for (const o of [...GIT_GLOBAL_OPTIONS_WITH_VALUE, ...GIT_GLOBAL_FLAGS])
        expect(deny).toContain(`Bash(git ${o} *)`);
      for (const o of GIT_GLOBAL_OPTIONS_WITH_VALUE.filter((x) => x.startsWith("--")))
        expect(deny).toContain(`Bash(git ${o}=*)`);
      for (const o of [
        "--no-pager",
        "-P",
        "--no-optional-locks",
        "--literal-pathspecs",
        "--no-replace-objects",
        "--bare",
      ])
        expect(deny).toContain(`Bash(git ${o} *)`);
      for (const v of ["reflog", "pack-refs", "gc", "prune", "maintenance"]) expect(deny).toContain(`Bash(git ${v} *)`);
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
    "git --no-pager commit",
    "git -P commit",
    "git --no-optional-locks commit",
    "git --literal-pathspecs commit",
    "git --no-replace-objects branch x",
    "git --bare update-ref refs/heads/x HEAD",
    "git --namespace=x update-ref refs/heads/x HEAD",
    "git --config-env=user.name=HOME commit",
    "git --exec-path=/x commit",
    "git reflog expire --all",
    "git pack-refs --all",
    "git gc",
    "git prune",
    "git maintenance run",
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
      // ADR-0066: command-prefix rules; the `git` entry stays exact.
      { argv: argvFor([...RW, "Bash"], [...RW, "Bash(npm test)", "Bash(npm test *)", "Bash(git status)"]) },
    ],
    [
      "trusted-development file_access=read-only with allowlist",
      "trusted-development",
      { fileAccess: "read-only", shellAllowlist: ["npm test"] },
      true,
      { argv: argvFor([...R, "Bash"], [...R, "Bash(npm test)", "Bash(npm test *)"]) },
    ],
    [
      // ADR-0090: was CAPABILITY_MISSING (Q-34); `Bash` with the allow rule `Bash`, Git deny rules kept.
      "trusted-development shell=broad (network off)",
      "trusted-development",
      { shell: "broad" },
      true,
      { argv: argvFor([...RW, "Bash"], [...RW, "Bash"]) },
    ],
    [
      "trusted-development shell=broad, read-only workspace",
      "trusted-development",
      { shell: "broad" },
      false,
      { reason: "CAPABILITY_MISSING", detail: /shell=broad on a read-only workspace.*ADR-0090/ },
    ],
    [
      "trusted-development shell=broad, file_access=read-only",
      "trusted-development",
      { shell: "broad", fileAccess: "read-only" },
      true,
      { reason: "CAPABILITY_MISSING", detail: /file_access=read-only with shell=broad.*ADR-0090/ },
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
        // FR-POL-03: a bypass approval on a non-privileged profile never compiles.
        expect(adapter.compile({ ...req, bypassApproved: true }, profile), label).toMatchObject({
          ineligible: true,
          reason: "PROFILE_UNSUPPORTED",
        });
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
          // ADR-0090: `broad` compiles for trusted-development only (Q-34 still refuses it elsewhere), and only on a
          // writable worktree.
          const broad = profile.shell === "broad";
          if (broad)
            expect([name, profile.fileAccess, writable], label).toEqual(["trusted-development", "worktree", true]);
          if (name === "trusted-development") {
            expect([profile.network, profile.repoConfig], label).toEqual(["off", "disabled"]);
          }
          // FR-GIT-01: the full deny rule set on every compiled invocation, writable or not.
          expect(rulesAfter(inv.argv, "--disallowedTools"), label).toEqual([...CLAUDE_GIT_DENY_RULES]);
          expect(rulesAfter(inv.policyFlags, "--disallowedTools"), label).toEqual([...CLAUDE_GIT_DENY_RULES]);
          const allow = rulesAfter(inv.argv, "--allowedTools");
          expect(allow.includes("Bash"), label).toBe(broad);
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

describe("claude privileged compile matrix (T3.5, T3.17; TDD §4.1.1; decisions 13, 18, 19)", () => {
  const adapter = new ClaudeAdapter({ binaryPath: CLAUDE });
  const R = ["Read", "Grep", "Glob"];
  const RW = [...R, "Edit", "Write"];
  const rulesAfter = (argv: readonly string[], flag: string): string[] => {
    const i = argv.indexOf(flag);
    if (i < 0) return [];
    const end = argv.findIndex((a, j) => j > i && a.startsWith("--"));
    return argv.slice(i + 1, end < 0 ? undefined : end);
  };
  const head = [CLAUDE, "-p", "--output-format", "stream-json", "--verbose"];
  const tail = (
    tools: readonly string[],
    allow: readonly string[],
    rules: readonly string[] = CLAUDE_GIT_DENY_RULES,
  ) => ["--tools", tools.join(","), "--allowedTools", ...allow, "--disallowedTools", ...rules];
  /** bypass false: exactly the trusted-development layout. */
  const nativeArgv = (tools: readonly string[], allow: readonly string[]) => [
    ...head,
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    ...tail(tools, allow),
  ];
  /** Approved bypass: no --restricted, no --permission-mode; the rest kept (decision 19). */
  const bypassArgv = (tools: readonly string[], allow: readonly string[]) => [
    ...head,
    "--safe-mode",
    "--strict-mcp-config",
    "--dangerously-skip-permissions",
    "--permission-prompts",
    "none",
    ...tail(tools, allow, CLAUDE_BYPASS_GIT_DENY_RULES),
  ];

  it("loose scope, bypass false: native rules like trusted-development, plus Bash and WebFetch", () => {
    const inv = compiled(privilegedProfile(LOOSE_SCOPE));
    const tools = [...RW, "Bash", "WebFetch"];
    expect(inv.argv).toEqual(nativeArgv(tools, tools));
    expect(findBypassFlags(inv)).toEqual([]);
  });

  it("loose scope, bypass true and approved: --dangerously-skip-permissions, no --restricted, Git deny rules kept", () => {
    const profile = privilegedProfile({ ...LOOSE_SCOPE, bypass: true });
    const req = { ...request, bypassApproved: true };
    const tools = [...RW, "Bash", "WebFetch"];
    for (const inv of [
      compiled(profile, req),
      adapter.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, req, profile) as Invocation,
    ]) {
      const resumed = inv.argv.includes("--resume");
      expect(inv.argv).toEqual([...bypassArgv(tools, tools), ...(resumed ? ["--resume", RESUMED_SESSION_ID] : [])]);
      expect(inv.policyFlags).toContain(CLAUDE_BYPASS_FLAG);
      // The audit refuses it without the run context and admits it with the approved privileged context only.
      expect(auditInvocation(inv)).toEqual([CLAUDE_BYPASS_FLAG]);
      expect(auditInvocation(inv, { profile, bypassApproved: true })).toEqual([]);
      expect(auditInvocation(inv, { profile, bypassApproved: false })).toEqual([CLAUDE_BYPASS_FLAG]);
      expect(auditInvocation(inv, { profile: privilegedProfile(LOOSE_SCOPE), bypassApproved: true })).toEqual([
        CLAUDE_BYPASS_FLAG,
      ]);
      expect(auditInvocation(inv, { profile: TRUSTED_DEVELOPMENT, bypassApproved: true })).toEqual([
        CLAUDE_BYPASS_FLAG,
      ]);
      // startAdapterRun refuses before spawning in every context but the approved one (no process is started here).
      expect(() => startAdapterRun(adapter, inv)).toThrow(BypassFlagError);
      expect(() => startAdapterRun(adapter, inv, { profile, bypassApproved: false })).toThrow(BypassFlagError);
      expect(() => startAdapterRun(adapter, inv, { profile: TRUSTED_DEVELOPMENT, bypassApproved: true })).toThrow(
        BypassFlagError,
      );
    }
  });

  it("bypass true without approval is Ineligible with the FR-POL-03 reason, never compiled without the flag", () => {
    const profile = privilegedProfile({ ...LOOSE_SCOPE, bypass: true });
    for (const req of [request, { ...request, bypassApproved: false }]) {
      expect(adapter.compile(req, profile)).toEqual({
        ineligible: true,
        reason: "PROFILE_UNSUPPORTED",
        detail: CLAUDE_BYPASS_NOT_APPROVED,
      });
    }
    // The LLD §2 carrier (profile.bypassApproved, set by the lifecycle at dispatch) approves exactly like the request's.
    const viaProfile = compiled({ ...profile, bypassApproved: true });
    expect(viaProfile.argv).toEqual(compiled(profile, { ...request, bypassApproved: true }).argv);
    expect(findBypassFlags(viaProfile)).toEqual([CLAUDE_BYPASS_FLAG]);
  });

  describe("repository_config under an approved bypass (owner decision 26, Q-37, ADR-0021; UNVERIFIED live, R-41)", () => {
    const approvedReq = { ...request, bypassApproved: true };
    const bypassScope = (mode: "approved" | "enabled", bypass = true) => ({
      ...LOOSE_SCOPE,
      bypass,
      repository_config: { mode },
    });
    const tools = [...RW, "Bash", "WebFetch"];
    const expected = (isolation: readonly string[]) => [
      ...head,
      ...isolation,
      "--dangerously-skip-permissions",
      "--permission-prompts",
      "none",
      ...tail(tools, tools, CLAUDE_BYPASS_GIT_DENY_RULES),
    ];

    it("approved + bypass: no --safe-mode, --strict-mcp-config and the Git deny rules kept", () => {
      const profile = privilegedProfile(bypassScope("approved"));
      const inv = compiled(profile, approvedReq);
      expect(inv.argv).toEqual(expected(["--strict-mcp-config"]));
      expect(inv.argv).not.toContain("--safe-mode");
      expect(rulesAfter(inv.argv, "--disallowedTools")).toEqual([...CLAUDE_BYPASS_GIT_DENY_RULES]);
      expect(auditInvocation(inv, { profile, bypassApproved: true })).toEqual([]);
    });

    it("enabled + bypass: neither --safe-mode nor --strict-mcp-config, Git deny rules kept", () => {
      const profile = privilegedProfile(bypassScope("enabled"));
      for (const inv of [
        compiled(profile, approvedReq),
        adapter.resumeArgs(
          { provider: "claude", nativeSessionId: RESUMED_SESSION_ID },
          approvedReq,
          profile,
        ) as Invocation,
      ]) {
        expect(inv.argv.filter((a) => a !== "--resume" && a !== RESUMED_SESSION_ID)).toEqual(expected([]));
        expect(inv.policyFlags).not.toContain("--safe-mode");
        expect(inv.policyFlags).not.toContain("--strict-mcp-config");
        expect(rulesAfter(inv.argv, "--disallowedTools")).toEqual([...CLAUDE_BYPASS_GIT_DENY_RULES]);
        expect(auditInvocation(inv, { profile, bypassApproved: true })).toEqual([]);
      }
    });

    it("never --restricted in any bypass invocation", () => {
      for (const mode of ["approved", "enabled"] as const) {
        const inv = compiled(privilegedProfile(bypassScope(mode)), approvedReq);
        expect(inv.argv).not.toContain("--restricted");
      }
    });

    it.each(["approved", "enabled"] as const)("%s with bypass true but not approved stays Ineligible", (mode) => {
      for (const req of [request, { ...request, bypassApproved: false }]) {
        expect(adapter.compile(req, privilegedProfile(bypassScope(mode)))).toMatchObject({
          ineligible: true,
          reason: "CAPABILITY_MISSING",
        });
      }
    });

    it.each(["approved", "enabled"] as const)("%s with bypass false stays Ineligible, even if approved", (mode) => {
      for (const req of [request, approvedReq]) {
        expect(adapter.compile(req, privilegedProfile(bypassScope(mode, false)))).toMatchObject({
          ineligible: true,
          reason: "CAPABILITY_MISSING",
        });
      }
    });
  });

  it.each([
    [
      "read-only, no shell, network on",
      { files: { access: "read-only" }, shell: { mode: "none" } },
      [...R, "WebFetch"],
    ],
    [
      "worktree, exact allowlist, network on",
      {
        shell: {
          mode: "allowlist",
          allowlist: [
            ["npm", "test"],
            ["git", "status"],
          ],
        },
      },
      [...RW, "Bash", "WebFetch"],
    ],
  ] as const)("bypass false, %s compiles natively", (_l, part, tools) => {
    const inv = compiled(privilegedProfile({ ...LOOSE_SCOPE, ...part } as typeof LOOSE_SCOPE));
    const allow = tools.flatMap((t) => (t === "Bash" ? ["Bash(npm test)", "Bash(git status)"] : [t]));
    expect(inv.argv).toEqual(nativeArgv(tools, allow));
  });

  it.each([
    [
      "the list_capabilities narrowest scope (network off)",
      { network: { mode: "off" } },
      "CAPABILITY_MISSING",
      /network=off/,
    ],
    [
      "network allowlist",
      { network: { mode: "allowlist", hosts: ["a.example.test"] } },
      "CAPABILITY_MISSING",
      /network=allowlist/,
    ],
    [
      "repository_config approved without bypass",
      { repository_config: { mode: "approved" } },
      "CAPABILITY_MISSING",
      /approved.*ADR-0015/,
    ],
    [
      "repository_config enabled without bypass",
      { repository_config: { mode: "enabled" } },
      "CAPABILITY_MISSING",
      /enabled.*--restricted/,
    ],
    ["read-only files with broad shell", { files: { access: "read-only" } }, "CAPABILITY_MISSING", /writing files/],
    [
      "allowlist with bypass",
      { shell: { mode: "allowlist", allowlist: [["npm", "test"]] }, bypass: true },
      "CAPABILITY_MISSING",
      /allow rules cannot narrow Bash/,
    ],
    [
      "allowlist entry that writes Git",
      { shell: { mode: "allowlist", allowlist: [["git", "commit"]] } },
      "PROFILE_UNSUPPORTED",
      /FR-GIT-01/,
    ],
    [
      "allowlist word that is not plain",
      { shell: { mode: "allowlist", allowlist: [["sh", "-c", "a;b"]] } },
      "PROFILE_UNSUPPORTED",
      /not expressible/,
    ],
  ] as const)("%s is Ineligible", (_l, part, reason, detail) => {
    for (const bypassApproved of [false, true]) {
      const r = adapter.compile(
        { ...request, bypassApproved },
        privilegedProfile({ ...LOOSE_SCOPE, ...part } as typeof LOOSE_SCOPE),
      );
      expect(r).toMatchObject({ ineligible: true, reason });
      if (isIneligible(r)) expect(r.detail).toMatch(detail);
    }
  });

  it("table: every scope shape x bypass x bypassApproved x writable, compile and resume", () => {
    let compiledCount = 0;
    let bypassCount = 0;
    for (const scope of scopeShapes()) {
      // The approval reaches the adapter on the request or on the profile (LLD §2 carrier), or not at all.
      const carriers = [
        [undefined, "request"],
        [false, "request"],
        [true, "request"],
        [false, "profile"],
        [true, "profile"],
      ] as const;
      for (const [bypassApproved, via] of carriers) {
        const base = privilegedProfile(scope);
        const profile = via === "profile" ? { ...base, bypassApproved: bypassApproved === true } : base;
        for (const writable of [true, false]) {
          const label = `${JSON.stringify(scope)} approved=${bypassApproved} via=${via} writable=${writable}`;
          const req: CompileRequest = {
            ...request,
            workspace: { cwd: "/tmp/work", writable },
            ...(bypassApproved !== undefined && via === "request" ? { bypassApproved } : {}),
          };
          const approved = bypassApproved === true;
          const shouldCompile =
            scope.network.mode === "on" &&
            (scope.repository_config.mode === "disabled" || (scope.bypass && approved)) &&
            !(scope.shell.mode === "allowlist" && scope.bypass) &&
            !(scope.shell.mode === "broad" && scope.files.access === "read-only") &&
            !(scope.bypass && !approved);
          for (const inv of [
            adapter.compile(req, profile),
            adapter.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, req, profile),
          ]) {
            if (isIneligible(inv)) {
              expect(shouldCompile, `${label}: ${inv.detail}`).toBe(false);
              expect(["PROFILE_UNSUPPORTED", "CAPABILITY_MISSING"], label).toContain(inv.reason);
              expect(inv.detail, label).not.toBe("");
              continue;
            }
            expect(shouldCompile, label).toBe(true);
            compiledCount += 1;
            const bypass = scope.bypass && approved;
            if (bypass) bypassCount += 1;
            // FR-POL-03: the bypass flag iff privileged ∧ scope.bypass ∧ bypassApproved; nothing else from the list.
            expect(findBypassFlags(inv), label).toEqual(bypass ? [CLAUDE_BYPASS_FLAG] : []);
            expect(auditInvocation(inv, { profile, bypassApproved: approved }), label).toEqual([]);
            // Decision 19: --restricted absent iff bypass; dontAsk absent iff bypass; the rest always.
            expect(inv.argv.includes("--restricted"), label).toBe(!bypass);
            expect(valuesAfter(inv.argv, "--permission-mode"), label).toEqual(bypass ? [] : ["dontAsk"]);
            // Decision 26 (Q-37): repository_config approved/enabled only in an approved bypass run, which then drops
            // --safe-mode, and --strict-mcp-config too for enabled.
            const repo = scope.repository_config.mode;
            expect(inv.argv.includes("--safe-mode"), label).toBe(repo === "disabled");
            expect(inv.argv.includes("--strict-mcp-config"), label).toBe(repo !== "enabled");
            if (repo !== "disabled") expect(bypass, label).toBe(true);
            expect(valuesAfter(inv.argv, "--permission-prompts"), label).toEqual(["none"]);
            // FR-GIT-01: the full Git deny rule set on every compiled invocation, bypass included.
            // ADR-0094: an approved bypass run gets the narrower bypass rule set.
            const denyRules = bypass ? CLAUDE_BYPASS_GIT_DENY_RULES : CLAUDE_GIT_DENY_RULES;
            expect(rulesAfter(inv.argv, "--disallowedTools"), label).toEqual([...denyRules]);
            expect(rulesAfter(inv.policyFlags, "--disallowedTools"), label).toEqual([...denyRules]);
            // Never beyond the worktree, nothing config-loading: no --bare/--settings/--mcp-config/--add-dir/--worktree.
            for (const arg of inv.argv) expect(FORBIDDEN_ARGS, label).not.toContain(arg);
            for (const f of ["--worktree", "-w", "--tmux", "--from-pr", "--add-dir"])
              expect(inv.argv, label).not.toContain(f);
            for (const sub of CONFIG_SUBCOMMANDS) expect(inv.argv.slice(1), label).not.toContain(sub);
            const tools = (valuesAfter(inv.argv, "--tools")[0] ?? "").split(",");
            expect(tools.includes("Edit"), label).toBe(scope.files.access === "worktree" && writable);
            expect(tools.includes("Bash"), label).toBe(scope.shell.mode !== "none");
            expect(tools, label).toContain("WebFetch");
            const allow = rulesAfter(inv.argv, "--allowedTools");
            for (const r of allow) expect(r, label).not.toContain("*");
            expect(allow.includes("Bash"), label).toBe(scope.shell.mode === "broad");
            const commands = allow.filter((r) => r.startsWith("Bash(")).map((r) => /^Bash\((.*)\)$/.exec(r)?.[1] ?? "");
            expect(gitWriteRisks(commands), label).toEqual([]);
            expect(inv.stdin).toEqual({ kind: "text", value: request.objective });
          }
        }
      }
    }
    expect(compiledCount).toBeGreaterThan(0);
    expect(bypassCount).toBeGreaterThan(0);
  });

  it("synthetic denial fixtures under privileged (bypass false, and approved bypass) pass the harness", async () => {
    const cases = claudePrivilegedDenialCases(makeCwd);
    const started = Date.now();
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name} ${k.detail ?? ""}`),
    );
    expect(failing).toEqual([]);
    expect(report.cases.map((c) => c.result?.failureCode)).toEqual([
      undefined,
      "PERMISSION_BLOCKED",
      "SANDBOX_VIOLATION",
      undefined,
      "PERMISSION_BLOCKED",
      "SANDBOX_VIOLATION",
    ]);
    expect(Date.now() - started).toBeLessThan(15_000);
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
    // the command line is a transient field for the tool-call guard (ADR-0039); `startAdapterRun` drops it before storage
    expect(pd).toContainEqual({ kind: "tool_call", tool: "shell", name: "Bash", command: "synthetic-command" });
  });

  it("maps system/permission_denied once, de-duplicated against result.permission_denials (C-10)", () => {
    const { events, state } = parseAll("permission-denied-system.jsonl");
    expect(events.filter((e) => e.kind === "permission_denied")).toEqual([{ kind: "permission_denied", tool: "Bash" }]);
    expect(state.unknownEvents).toBe(0);
    // Without the system event, the result's entry is still reported (the existing fixture).
    expect(parseAll("permission-denied.jsonl").events.filter((e) => e.kind === "permission_denied")).toHaveLength(1);
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

describe("claude oversize tool-result line (run_01M5BST6XW3JGHKCCNW6EJ8R6V, trimmed recording)", () => {
  // The recorded failing line: an Edit's `user` event echoing the whole 1.5 MB pre-edit file in `originalFile`.
  const RECORDED_LINE_BYTES = 1_550_255;
  const template = readFileSync(fixturePath("oversize-edit-result.jsonl"), "utf8").trimEnd().split("\n");
  const bigIndex = template.findIndex((l) => l.startsWith(`{"type":"user"`) && l.includes("{{ORIGINAL_FILE}}"));
  /** The fixture with `originalFile` filled so its line is exactly `lineBytes` bytes; `cut` truncates that line. */
  const inflated = (lineBytes: number, cut = false): string => {
    const line = template[bigIndex] ?? "";
    const room = lineBytes - Buffer.byteLength(line) + "{{ORIGINAL_FILE}}".length;
    const row = "| T9.14 | row \\u00a7 |\\n"; // JSON-escaped text, as Claude Code writes it
    const filler = row.repeat(Math.floor(room / row.length)) + "x".repeat(room % row.length); // never splits an escape
    const big = line.replace("{{ORIGINAL_FILE}}", filler);
    const lines = cut ? [...template.slice(0, bigIndex), big.slice(0, big.length / 2)] : template.with(bigIndex, big);
    const file = join(makeCwd(), "stdout.jsonl");
    writeFileSync(file, cut ? lines.join("\n") : `${lines.join("\n")}\n`);
    return file;
  };
  const caseFor = (file: string, kind: "success" | "malformed_output", expectOk: boolean) => ({
    kind,
    profile: EDIT_UNTRUSTED,
    adapter: new ClaudeAdapter({
      binaryPath: process.execPath,
      launcherArgs: replayLauncher("claude", file),
      timeouts: { wallClockMs: 20_000, idleMs: 5_000, killGraceMs: 300 },
    }),
    request: {
      runId: "run_claude_oversize",
      objective: "synthetic objective",
      constraints: [],
      workspace: { cwd: makeCwd(), writable: true },
    },
    expect: expectOk
      ? { ok: true, nativeSessionId: DEFAULT_SESSION_ID }
      : { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" as const },
  });

  it("the recorded line is valid JSON over the 1 MiB default and under the Claude cap", () => {
    const line = readFileSync(inflated(RECORDED_LINE_BYTES), "utf8").split("\n")[bigIndex] ?? "";
    expect(Buffer.byteLength(line)).toBe(RECORDED_LINE_BYTES);
    expect(RECORDED_LINE_BYTES).toBeGreaterThan(DEFAULT_MAX_LINE_BYTES);
    expect(RECORDED_LINE_BYTES).toBeLessThan(CLAUDE_STDOUT_LINE_BYTES);
    const doc = JSON.parse(line) as { type: string; tool_use_result: { originalFile: string } };
    expect(doc.type).toBe("user");
    expect(doc.tool_use_result.originalFile).toContain("\u00a7");
    expect(compiled(EDIT_UNTRUSTED).maxLineBytes).toBe(CLAUDE_STDOUT_LINE_BYTES);
  });

  it("a recorded-size Edit result line no longer fails the run", async () => {
    const report = await runConformanceCase(caseFor(inflated(RECORDED_LINE_BYTES), "success", true));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: true, summary: "Updated docs/ROADMAP.md." });
  });

  it("a line over the Claude cap still fails closed as OUTPUT_PROTOCOL_ERROR", async () => {
    const report = await runConformanceCase(caseFor(inflated(CLAUDE_STDOUT_LINE_BYTES + 1), "malformed_output", false));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
  });

  it("a truncated final oversize line still fails closed as OUTPUT_PROTOCOL_ERROR", async () => {
    const report = await runConformanceCase(caseFor(inflated(RECORDED_LINE_BYTES, true), "malformed_output", false));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
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

describe("handoff runs change the prompt only (T5.5, LLD §15.5, ADR-0038 item 5.1)", () => {
  const handoffRef = { bundleArtifactId: "art_01HANDOFF", bundleSha256: "f".repeat(64) };
  const { prompt } = renderHandoffPrompt({ bundle: syntheticBundle(), instruction: "Fix the failing test." });
  const withoutStdin = (inv: Invocation) => ({ ...inv, stdin: undefined });

  it.each([INSPECT_UNTRUSTED, EDIT_UNTRUSTED, TRUSTED_DEVELOPMENT])(
    "$name: argv, environment, policy flags and cwd equal the same-provider compile; stdin is the rendered prompt",
    (profile) => {
      const plain = compiled(profile, { ...request, constraints: ["keep the public API"] });
      const handoff = compiled(profile, { ...request, objective: prompt, constraints: [], handoff: handoffRef });
      expect(withoutStdin(handoff)).toEqual(withoutStdin(plain));
      expect(handoff.stdin).toEqual({ kind: "text", value: prompt });
      expect(handoff.argv.join("\n")).not.toContain(INSTRUCTION_MARKER);
      expect(auditInvocation(handoff)).toEqual([]);
    },
  );

  it("no adapter reads CompileRequest.handoff: the same request with it compiles identically", () => {
    expect(compiled(EDIT_UNTRUSTED, { ...request, handoff: handoffRef })).toEqual(compiled(EDIT_UNTRUSTED, request));
  });
});
