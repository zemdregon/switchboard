/**
 * T9.4b (ADR-0029; FR-GIT-02, FR-POL-03, FR-POL-08): the Claude Code tool channel behind the operator opt-in, and the
 * argv audit rule that admits `--mcp-config` in exactly the controller's shape. argv inspection only: the real `claude`
 * binary is never run (the lifecycle replay test is `src/lifecycle/claude-channel.test.ts`).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CHANNEL_MCP_CONFIG_FILE, TOKEN_PREFIX, TOOL_TOKEN_ENV } from "../../git/tool-protocol.js";
import {
  assertMcpAudit,
  auditMcpArgs,
  type BypassContext,
  type ChannelAuditContext,
  channelToolRule,
  checkChannelFile,
  McpConfigAuditError,
} from "../audit.js";
import { LOOSE_SCOPE, privilegedProfile } from "../fixtures/privileged.js";
import { startAdapterRun } from "../run.js";
import {
  type ChannelArgs,
  type CompileRequest,
  type Invocation,
  isIneligible,
  type ResolvedProfile,
  type ShimSpec,
} from "../types.js";
import {
  CLAUDE_GIT_CAPABILITIES,
  CLAUDE_GIT_CHANNEL_CAPABILITIES,
  CLAUDE_GIT_DENY_RULES,
  ClaudeAdapter,
  claudeChannelArgs,
} from "./adapter.js";
import { EDIT_UNTRUSTED, INSPECT_UNTRUSTED, RESUMED_SESSION_ID, TRUSTED_DEVELOPMENT } from "./fixtures/cases.js";

const CLAUDE = "/opt/synthetic/bin/claude"; // never executed in these tests
const NODE = "/opt/synthetic/bin/node";
const TOKEN = `${TOKEN_PREFIX}${"A".repeat(43)}`;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
/** A private (0700) directory standing in for the run's channel directory. */
function privateDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sb-cch-"));
  dirs.push(root);
  const dir = path.join(root, "run_x");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

const shimFor = (dir: string, tools: ShimSpec["toolNames"] = ["commit"]): ShimSpec => ({
  command: [
    NODE,
    "/opt/synthetic/switchboard/bin.js",
    "tool-shim",
    "--socket",
    `${dir}/tools.sock`,
    "--tools",
    tools.join(","),
  ],
  socketPath: `${dir}/tools.sock`,
  dir,
  toolNames: tools,
  env: { [TOOL_TOKEN_ENV]: TOKEN },
});

const request: CompileRequest = {
  runId: "run_x",
  objective: "objective",
  constraints: [],
  workspace: { cwd: "/tmp/work", writable: true },
};
const off = new ClaudeAdapter({ binaryPath: CLAUDE });
const on = new ClaudeAdapter({ binaryPath: CLAUDE, gitChannel: true });
const compiled = (a: ClaudeAdapter, p: ResolvedProfile, req: CompileRequest = request): Invocation => {
  const inv = a.compile(req, p);
  if (isIneligible(inv)) throw new Error(`ineligible: ${inv.detail}`);
  return inv;
};
const channelArgs = (shim: ShimSpec, p: ResolvedProfile = EDIT_UNTRUSTED): ChannelArgs => {
  const extra = on.gitCapabilities.channelArgs?.(shim, request, p);
  if (extra === undefined || isIneligible(extra as Invocation)) throw new Error("channel refused");
  return extra as ChannelArgs;
};
/** What the lifecycle spawns: the compiled argv with the channel fragment appended. */
const withChannel = (inv: Invocation, extra: ChannelArgs): Invocation => ({
  ...inv,
  argv: [...inv.argv, ...extra.argv],
  env: { ...inv.env, ...extra.env },
});

describe("opt-in off: no channel, argv byte-identical (T9.4b regression)", () => {
  it("declares commitChannel none with the T9.4 reason and no channelArgs", () => {
    expect(off.gitCapabilities).toBe(CLAUDE_GIT_CAPABILITIES);
    expect(new ClaudeAdapter({ binaryPath: CLAUDE, gitChannel: false }).gitCapabilities).toBe(CLAUDE_GIT_CAPABILITIES);
    expect(CLAUDE_GIT_CAPABILITIES.commitChannel).toBe("none");
    expect(CLAUDE_GIT_CAPABILITIES.channelArgs).toBeUndefined();
  });

  it("edit-untrusted argv snapshot is unchanged, and the opt-in does not change compile either", () => {
    const expected = [
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
      "Read,Grep,Glob,Edit,Write",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "Edit",
      "Write",
      "--disallowedTools",
      ...CLAUDE_GIT_DENY_RULES,
    ];
    expect(compiled(off, EDIT_UNTRUSTED).argv).toEqual(expected);
    for (const p of [INSPECT_UNTRUSTED, EDIT_UNTRUSTED, TRUSTED_DEVELOPMENT, privilegedProfile(LOOSE_SCOPE)]) {
      const a = compiled(off, p);
      const b = compiled(on, p);
      expect(b).toEqual(a);
      expect(a.argv).not.toContain("--mcp-config");
      expect(a.env).toEqual({});
      expect(auditMcpArgs(a)).toEqual([]);
    }
  });
});

describe("opt-in on: the channel fragment (ADR-0029 items 1-5)", () => {
  it("declares injected and emits one --mcp-config file, exact-name allow rules and the token in env only", () => {
    expect(on.gitCapabilities).toBe(CLAUDE_GIT_CHANNEL_CAPABILITIES);
    expect(on.gitCapabilities.commitChannel).toBe("injected");
    expect(on.gitCapabilities.detail).toMatch(/UNSUPPORTED/);
    const dir = privateDir();
    const extra = channelArgs(shimFor(dir));
    const file = path.join(dir, CHANNEL_MCP_CONFIG_FILE);
    expect(extra.argv).toEqual(["--mcp-config", file, "--allowedTools", "mcp__switchboard-git__commit"]);
    expect(extra.env).toEqual({ [TOOL_TOKEN_ENV]: TOKEN });
    expect(extra.files).toHaveLength(1);
    const f = extra.files?.[0];
    expect(f?.name).toBe(CHANNEL_MCP_CONFIG_FILE);
    const def = JSON.parse(f?.contents ?? "{}");
    expect(Object.keys(def)).toEqual(["mcpServers"]);
    expect(Object.keys(def.mcpServers)).toEqual(["switchboard-git"]);
    expect(def.mcpServers["switchboard-git"]).toEqual({
      type: "stdio",
      command: NODE,
      args: ["/opt/synthetic/switchboard/bin.js", "tool-shim", "--socket", `${dir}/tools.sock`, "--tools", "commit"],
      env: { [TOOL_TOKEN_ENV]: `\${${TOOL_TOKEN_ENV}}` },
    });
    // No secret in argv or the file (FR-POL-08).
    expect(extra.argv.join(" ")).not.toContain(TOKEN_PREFIX);
    expect(f?.contents).not.toContain(TOKEN_PREFIX);
    expect(f?.contents).not.toContain(TOKEN);
  });

  it("push offered: both exact rules, never a wildcard or a server-wide rule", () => {
    const extra = channelArgs(shimFor(privateDir(), ["commit", "push"]));
    const rules = extra.argv.slice(extra.argv.indexOf("--allowedTools") + 1);
    expect(rules).toEqual(["mcp__switchboard-git__commit", "mcp__switchboard-git__push"]);
    for (const r of rules) expect(r).not.toContain("*");
  });

  it("does not add a bypass flag, --strict-mcp-config, --tools or any other flag", () => {
    const extra = channelArgs(shimFor(privateDir(), ["commit", "push"]));
    expect(extra.argv.filter((a) => a.startsWith("-"))).toEqual(["--mcp-config", "--allowedTools"]);
  });

  it("refuses a malformed shim (relative command, unknown tool, extra env, token in argv, relative dir)", () => {
    const dir = privateDir();
    const good = shimFor(dir);
    const bad: ShimSpec[] = [
      { ...good, command: ["node", ...good.command.slice(1)] },
      { ...good, command: [] },
      { ...good, toolNames: [] },
      { ...good, toolNames: ["commit", "commit"] },
      { ...good, toolNames: ["commit", "rm" as "push"] },
      { ...good, env: { ...good.env, OTHER: "x" } },
      { ...good, env: {} },
      { ...good, command: [...good.command, TOKEN] },
      { ...good, dir: "relative/dir" },
      { ...good, dir: `${dir}/../x` },
    ];
    for (const shim of bad) {
      const r = claudeChannelArgs(shim);
      expect("ineligible" in r, JSON.stringify(shim.toolNames)).toBe(true);
    }
  });

  it("edit-untrusted, trusted-development and privileged non-bypass keep --safe-mode, --restricted, --strict-mcp-config and pass the audit", () => {
    const dir = privateDir();
    const shim = shimFor(dir, ["commit", "push"]);
    const channel: ChannelAuditContext = {
      mcpConfigPath: path.join(dir, CHANNEL_MCP_CONFIG_FILE),
      toolNames: ["commit", "push"],
    };
    for (const p of [EDIT_UNTRUSTED, TRUSTED_DEVELOPMENT, privilegedProfile(LOOSE_SCOPE)]) {
      const inv = withChannel(compiled(on, p), channelArgs(shim, p));
      for (const f of ["--safe-mode", "--restricted", "--strict-mcp-config", "--permission-mode"]) {
        expect(inv.argv, `${p.name} ${f}`).toContain(f);
      }
      expect(inv.argv).not.toContain("--dangerously-skip-permissions");
      expect(auditMcpArgs(inv, channel, { profile: p, bypassApproved: false })).toEqual([]);
      // The original allow list is untouched; the channel rules follow in their own occurrence.
      expect(inv.argv.filter((a) => a === "--allowedTools")).toHaveLength(2);
      expect(inv.argv.slice(-3)).toEqual([
        "--allowedTools",
        "mcp__switchboard-git__commit",
        "mcp__switchboard-git__push",
      ]);
    }
  });

  it("resume keeps the same shape (the fragment follows --resume)", () => {
    const dir = privateDir();
    const r = on.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, request, EDIT_UNTRUSTED);
    if (isIneligible(r)) throw new Error(r.detail);
    const inv = withChannel(r, channelArgs(shimFor(dir)));
    const channel = { mcpConfigPath: path.join(dir, CHANNEL_MCP_CONFIG_FILE), toolNames: ["commit"] };
    expect(auditMcpArgs(inv, channel)).toEqual([]);
    expect(inv.argv.indexOf("--resume")).toBeLessThan(inv.argv.indexOf("--mcp-config"));
  });
});

describe("approved bypass runs (owner decisions 13, 26; ADR-0017, ADR-0021)", () => {
  const approvedReq = { ...request, bypassApproved: true };
  const scope = (mode: "disabled" | "approved" | "enabled") => ({
    ...LOOSE_SCOPE,
    bypass: true,
    repository_config: { mode },
  });

  it("repository_config enabled: no --strict-mcp-config, and the audit admits that only for the approved bypass", () => {
    const dir = privateDir();
    const profile = privilegedProfile(scope("enabled"));
    const inv = withChannel(compiled(on, profile, approvedReq), channelArgs(shimFor(dir), profile));
    expect(inv.argv).not.toContain("--strict-mcp-config");
    expect(inv.argv).toContain("--dangerously-skip-permissions");
    const channel = { mcpConfigPath: path.join(dir, CHANNEL_MCP_CONFIG_FILE), toolNames: ["commit"] };
    const approved: BypassContext = { profile, bypassApproved: true };
    expect(auditMcpArgs(inv, channel, approved)).toEqual([]);
    // Same argv without the approval, or on another repository_config, is refused (strict required).
    expect(auditMcpArgs(inv, channel, { profile, bypassApproved: false })).toEqual([
      "--mcp-config without --strict-mcp-config",
    ]);
    expect(auditMcpArgs(inv, channel, { profile: privilegedProfile(scope("approved")), bypassApproved: true })).toEqual(
      ["--mcp-config without --strict-mcp-config"],
    );
    expect(auditMcpArgs(inv, channel)).toEqual(["--mcp-config without --strict-mcp-config"]);
  });

  it("repository_config disabled or approved: --strict-mcp-config kept", () => {
    for (const mode of ["disabled", "approved"] as const) {
      const dir = privateDir();
      const profile = privilegedProfile(scope(mode));
      const inv = withChannel(compiled(on, profile, approvedReq), channelArgs(shimFor(dir), profile));
      expect(inv.argv, mode).toContain("--strict-mcp-config");
      const channel = { mcpConfigPath: path.join(dir, CHANNEL_MCP_CONFIG_FILE), toolNames: ["commit"] };
      expect(auditMcpArgs(inv, channel, { profile, bypassApproved: true })).toEqual([]);
    }
  });
});

describe("audit: everything but the one channel shape is refused (ADR-0029 item 6, ADR-0015)", () => {
  const dir = "/data/runs/run_x";
  const file = `${dir}/${CHANNEL_MCP_CONFIG_FILE}`;
  const channel: ChannelAuditContext = { mcpConfigPath: file, toolNames: ["commit"] };
  const base = compiled(off, EDIT_UNTRUSTED);
  const inv = (tail: string[], policyFlags: string[] = base.policyFlags) => ({
    argv: [...base.argv, ...tail],
    policyFlags,
  });
  const good = ["--mcp-config", file, "--allowedTools", channelToolRule("commit")];

  it("admits the exact shape", () => {
    expect(auditMcpArgs(inv(good), channel)).toEqual([]);
  });

  const refusedCases: Array<[string, string[], ChannelAuditContext | undefined]> = [
    ["no channel at all", good, undefined],
    ["channel without a written definition", good, { toolNames: ["commit"] }],
    ["inline JSON", ["--mcp-config", '{"mcpServers":{}}'], channel],
    ["another path", ["--mcp-config", "/home/op/.mcp.json"], channel],
    ["a sibling path with the same name", ["--mcp-config", `/data/runs/run_y/${CHANNEL_MCP_CONFIG_FILE}`], channel],
    ["a second occurrence", [...good, "--mcp-config", file], channel],
    ["a second value", ["--mcp-config", file, "/home/op/.mcp.json"], channel],
    ["the = form", [`--mcp-config=${file}`], channel],
    ["the = form with JSON", ['--mcp-config={"mcpServers":{}}'], channel],
    ["a server-wide rule", ["--allowedTools", "mcp__switchboard-git"], channel],
    ["a wildcard rule", ["--allowedTools", "mcp__switchboard-git__*"], channel],
    ["a global MCP wildcard", ["--allowedTools", "mcp__*"], channel],
    ["another server's tool", ["--allowedTools", "mcp__github__create_pull_request"], channel],
    ["a tool not offered", ["--allowedTools", channelToolRule("push")], channel],
    ["a comma-joined wildcard", ["--allowedTools", "Read,mcp__switchboard-git__*"], channel],
    ["an MCP rule outside --allowedTools", ["--permission-prompt-tool", channelToolRule("commit")], channel],
    ["an MCP rule without a channel", ["--allowedTools", channelToolRule("commit")], undefined],
  ];
  for (const [label, tail, ctx] of refusedCases) {
    it(`refuses ${label}`, () => {
      expect(auditMcpArgs(inv(tail), ctx).length, label).toBeGreaterThan(0);
      expect(() => assertMcpAudit(inv(tail), ctx), label).toThrow(McpConfigAuditError);
    });
  }

  it("refuses --mcp-config when --strict-mcp-config is missing outside decision 26", () => {
    const argv = [...base.argv.filter((a) => a !== "--strict-mcp-config"), ...good];
    expect(auditMcpArgs({ argv, policyFlags: [] }, channel)).toEqual(["--mcp-config without --strict-mcp-config"]);
  });

  it("refuses --mcp-config or MCP rules carried in policyFlags", () => {
    expect(auditMcpArgs(inv([], [...base.policyFlags, "--mcp-config", file]), channel).length).toBeGreaterThan(0);
    expect(auditMcpArgs(inv([], [...base.policyFlags, "mcp__switchboard-git__*"]), channel).length).toBeGreaterThan(0);
  });

  it("refuses an unexpected or relative definition path in the context itself", () => {
    for (const p of [
      "relative/mcp-config.json",
      "/data/runs/run_x/other.json",
      "/data/runs/run_x/../x/mcp-config.json",
    ]) {
      const argv = [...base.argv, "--mcp-config", p];
      expect(
        auditMcpArgs({ argv, policyFlags: [] }, { mcpConfigPath: p, toolNames: ["commit"] }).length,
        p,
      ).toBeGreaterThan(0);
    }
  });

  it("startAdapterRun refuses before spawning (no process is started here)", () => {
    const evil = { ...base, argv: [...base.argv, "--mcp-config", "/home/op/.mcp.json"] };
    expect(() => startAdapterRun(off, evil)).toThrow(McpConfigAuditError);
    expect(() => startAdapterRun(off, evil, { channel })).toThrow(McpConfigAuditError);
  });
});

describe("audit: the definition file itself (defence in depth)", () => {
  it("passes a 0600 file in a 0700 directory, refuses missing, open-mode, linked or group-readable ones", () => {
    const dir = privateDir();
    const file = path.join(dir, CHANNEL_MCP_CONFIG_FILE);
    expect(checkChannelFile(file)).toEqual(["channel file is missing"]);
    writeFileSync(file, "{}", { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(checkChannelFile(file)).toEqual([]);
    chmodSync(file, 0o644);
    expect(checkChannelFile(file)).toEqual(["channel file is accessible to other users"]);
    chmodSync(file, 0o600);
    chmodSync(dir, 0o750);
    expect(checkChannelFile(file)).toEqual(["channel directory is accessible to other users"]);
    chmodSync(dir, 0o700);
    const link = path.join(dir, "link.json");
    symlinkSync(file, link);
    expect(checkChannelFile(link)).toContain("channel file is not a plain file");
    // assertMcpAudit runs the file check only when argv carries the definition.
    const base = compiled(off, EDIT_UNTRUSTED);
    const ctx = { mcpConfigPath: file, toolNames: ["commit"] };
    expect(() => assertMcpAudit({ ...base, argv: [...base.argv, "--mcp-config", file] }, ctx)).not.toThrow();
    chmodSync(file, 0o640);
    expect(() => assertMcpAudit({ ...base, argv: [...base.argv, "--mcp-config", file] }, ctx)).toThrow(
      /accessible to other users/,
    );
  });
});
