/**
 * ADR-0090 regression: `trusted-development` runs had Bash (and Write outside the worktree) denied in prod for every
 * Claude model, so tests never ran. Prod streams (2026-10-20/21, Claude Code 2.1.294, init event tools
 * `Bash,Edit,Glob,Grep,Read,Write`, permissionMode `dontAsk` for both models) recorded the same denials on
 * `claude-sonnet-5-5` runs (run_01M5D74KSXB5VVC4FZD0D3Q92C, run_01M5D1YRABBYPBGFGWZGZHT18C) and `claude-opus-5-5` runs
 * (run_01M5D03ET12TRSYNJPTFH0V7MY, run_01M5F25ZM59DMECMVFPVWKWHNM): the cause was the shell allowlist under dontAsk,
 * not the model. These tests pin that the compiled policy never depends on the model, that the prod profile (shell
 * `broad`) gives Bash, Edit and Write confined to the run's worktree, and that Git writes stay with Switchboard's
 * finalize commit on the run branch (FR-GIT-01, FR-GIT-09, ADR-0033).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/index.js";
import { resolveTrustProfile } from "../policy/profiles.js";
import type { ProfileOverride } from "../policy/types.js";
import { auditInvocation } from "./audit.js";
import { CLAUDE_GIT_DENY_RULES, ClaudeAdapter, claudeChannelOffered } from "./claude/index.js";
import { BUILTIN_PROVIDERS } from "./providers.js";
import { guardToolCall } from "./tool-guard.js";
import { type CompileRequest, type Invocation, isIneligible, type ResolvedProfile } from "./types.js";

const CLAUDE = "/opt/synthetic/bin/claude"; // never executed
const WORKTREE = "/srv/synthetic/worktrees/sess_x/run_x";

/** `profiles.trusted-development` of the prod config after the fix (config.template.json, 2026-10-21). */
const PROD_FIXED: ProfileOverride = { fileAccess: "worktree", shell: "broad" };
/** The same block before the fix: the allowlist that Claude Code's dontAsk matcher could not widen. */
const PROD_PRE_FIX: ProfileOverride = {
  fileAccess: "worktree",
  shell: "allowlist",
  shellAllowlist: [
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
  ],
};

/** Every model spelling the prod config routes to Claude Code, plus other families and no model at all. */
const MODELS: ReadonlyArray<string | undefined> = [
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "sonnet",
  "opus",
  "claude-haiku-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-1[1m]",
  undefined,
];

const trusted = (override: ProfileOverride): ResolvedProfile =>
  resolveTrustProfile("trusted-development", { overrides: { "trusted-development": override } });
const req = (model: string | undefined, writable = true): CompileRequest => ({
  runId: "run_x",
  objective: "run `git status` and the tests, then edit scratch.txt",
  constraints: [],
  workspace: { cwd: WORKTREE, writable },
  ...(model !== undefined ? { model } : {}),
});
const compileClaude = (profile: ResolvedProfile, model: string | undefined): Invocation => {
  const inv = new ClaudeAdapter({ binaryPath: CLAUDE }).compile(req(model), profile);
  if (isIneligible(inv)) throw new Error(`ineligible: ${inv.detail}`);
  return inv;
};
const valuesAfter = (argv: readonly string[], flag: string): string[] => {
  const i = argv.indexOf(flag);
  const out: string[] = [];
  for (const a of i < 0 ? [] : argv.slice(i + 1)) {
    if (a.startsWith("-")) break;
    out.push(a);
  }
  return out;
};
const policyWithoutModel = (inv: Invocation): string[] => {
  const argv = [...inv.argv];
  const i = argv.indexOf("--model");
  if (i >= 0) argv.splice(i, 2);
  return argv;
};

describe("trusted-development: Bash, Edit and Write for every Claude model (ADR-0090)", () => {
  const profile = trusted(PROD_FIXED);

  it.each(MODELS.map((m) => [m ?? "(no model)", m] as const))("%s: Bash, Edit, Write enabled and allowed", (_l, m) => {
    const inv = compileClaude(profile, m);
    expect(valuesAfter(inv.argv, "--tools")[0]?.split(",")).toEqual(["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
    const allow = valuesAfter(inv.argv, "--allowedTools");
    for (const t of ["Bash", "Edit", "Write"]) expect(allow).toContain(t);
    expect(valuesAfter(inv.argv, "--permission-mode")).toEqual(["dontAsk"]);
    if (m !== undefined) expect(valuesAfter(inv.argv, "--model")).toEqual([m]);
    expect(auditInvocation(inv)).toEqual([]);
  });

  it("the compiled policy is identical for every model: no per-model permission mapping exists", () => {
    const [first, ...rest] = MODELS.map((m) => compileClaude(profile, m));
    for (const inv of rest) {
      expect(inv.policyFlags).toEqual(first?.policyFlags);
      expect(policyWithoutModel(inv)).toEqual(policyWithoutModel(first as Invocation));
    }
  });

  it("worktree scoping: cwd is the run worktree, --restricted confines file tools, no extra directory or bypass", () => {
    const inv = compileClaude(profile, "claude-sonnet-5-5");
    expect(inv.cwd).toBe(WORKTREE);
    for (const f of ["--restricted", "--safe-mode", "--strict-mcp-config"]) expect(inv.argv).toContain(f);
    for (const f of ["--add-dir", "--dangerously-skip-permissions", "--settings", "--mcp-config"]) {
      expect(inv.argv).not.toContain(f);
    }
  });

  it("a read-only workspace or read-only file access with broad shell is refused, never compiled", () => {
    const a = new ClaudeAdapter({ binaryPath: CLAUDE });
    expect(a.compile(req("claude-opus-5-5", false), profile)).toMatchObject({ reason: "CAPABILITY_MISSING" });
    expect(a.compile(req("claude-opus-5-5"), trusted({ fileAccess: "read-only", shell: "broad" }))).toMatchObject({
      reason: "CAPABILITY_MISSING",
    });
  });

  it("root cause: the pre-fix prod allowlist compiled no bare `Bash` rule, for Sonnet and Opus alike", () => {
    for (const m of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
      const allow = valuesAfter(compileClaude(trusted(PROD_PRE_FIX), m).argv, "--allowedTools");
      expect(allow).not.toContain("Bash");
      // Programs from the denied prod commands that no prefix rule names: `for` loops, `rm`, `timeout`, `git log`.
      for (const program of ["for", "rm", "timeout", "git", "pnpm", "awk"]) {
        expect(allow.some((r) => r.startsWith(`Bash(${program}`))).toBe(false);
      }
    }
  });
});

describe("trusted-development: Git writes stay with Switchboard (FR-GIT-01, FR-GIT-09, ADR-0033)", () => {
  const inv = compileClaude(trusted(PROD_FIXED), "claude-opus-5-5");
  const deny = valuesAfter(inv.argv, "--disallowedTools");

  it("the full Git deny rule set is passed, so the agent itself cannot commit or push", () => {
    expect(deny).toEqual([...CLAUDE_GIT_DENY_RULES]);
    for (const r of ["Bash(git commit *)", "Bash(git push *)", "Bash(git fetch *)", "Bash(gh *)"]) {
      expect(deny).toContain(r);
    }
  });

  it("no injected commit channel outside an approved bypass run: the commit is the finalize commit", () => {
    // Prod sets providers.claude-code.git_channel; the channel still goes only to an approved bypass run.
    for (const m of MODELS) expect(claudeChannelOffered(req(m), trusted(PROD_FIXED))).toBe(false);
  });

  const ctx = { cwd: WORKTREE, home: "/home/synthetic", bypass: false };
  it.each([
    "git status",
    "git log --oneline -5",
    "git diff --stat",
    "git branch -a --contains abc123",
    "npx vitest run src/adapters 2>&1 | tail -15; echo TSC=$?",
    "for f in tests/*.mjs; do node $f; echo EXIT $?; done",
    "rm .scratch.py",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell command, not a template
    "timeout 600 node tests/boundary.mjs; echo EXIT ${PIPESTATUS[0]}",
  ])("the tool-call guard lets ordinary shell through: %j", (command) => {
    expect(guardToolCall({ tool: "shell", command }, ctx)).toBeUndefined();
  });

  it.each(["git commit -m wip", "git push origin HEAD", "git -C /elsewhere commit -m x"])(
    "the tool-call guard still flags an agent Git write: %j",
    (command) => {
      expect(guardToolCall({ tool: "shell", command }, ctx)).toMatchObject({ kind: "git_write" });
    },
  );
});

describe("trusted-development on the other providers is never compiled into a Bash-denying run", () => {
  for (const entry of BUILTIN_PROVIDERS) {
    if (!("create" in entry) || entry.id === "claude" || entry.id === "codex" || entry.id === "fake") continue;
    it(`${entry.id}: Ineligible PROFILE_UNSUPPORTED (routing never picks it), never a narrowed shell`, () => {
      const adapter = entry.create();
      for (const m of MODELS) {
        expect(adapter.compile(req(m), trusted(PROD_FIXED))).toMatchObject({
          ineligible: true,
          reason: "PROFILE_UNSUPPORTED",
        });
      }
    });
  }
});

describe("the switchboard project config case: the prod profile block loads and compiles", () => {
  it("profiles.trusted-development {file_access: worktree, shell: broad} gives Claude Bash, Edit and Write", () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-trusted-")));
    try {
      const configPath = path.join(tmp, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 1,
          allowed_roots: [tmp],
          mcp_clients: [{ id: "linus", max_trust_profile: "privileged", privileged_approval: "not_required" }],
          profiles: { "trusted-development": { file_access: "worktree", shell: "broad" } },
        }),
      );
      const c = loadConfig({ configPath });
      expect(c.profileOverrides).toEqual({ "trusted-development": PROD_FIXED });
      const profile = resolveTrustProfile("trusted-development", { overrides: c.profileOverrides });
      expect(profile).toMatchObject({ shell: "broad", fileAccess: "worktree", network: "off", repoConfig: "disabled" });
      for (const m of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
        const allow = valuesAfter(compileClaude(profile, m).argv, "--allowedTools");
        expect(allow).toEqual(["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
