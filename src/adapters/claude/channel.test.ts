/**
 * T9.4b (ADR-0029, ADR-0033; FR-GIT-02, FR-POL-03, FR-POL-08): the Claude Code tool channel behind the operator opt-in,
 * offered only to an approved privileged bypass run (owner decision 41), and the argv audit rules that admit
 * `--mcp-config` in exactly the controller's shape and a missing `--safe-mode` only in the approved bypass cases. argv
 * inspection only: the real `claude` binary is never run (the lifecycle replay test is
 * `src/lifecycle/claude-channel.test.ts`).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CHANNEL_MCP_CONFIG_FILE, TOKEN_PREFIX, TOOL_TOKEN_ENV } from "../../git/tool-protocol.js";
import {
  assertMcpAudit,
  assertSafeModeAudit,
  auditMcpArgs,
  auditSafeMode,
  type BypassContext,
  type ChannelAuditContext,
  channelToolRule,
  checkChannelFile,
  IsolationAuditError,
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
  CLAUDE_CHANNEL_BYPASS_ONLY,
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
/** The run the channel is offered to (owner decision 41): approved, privileged, scope sets bypass. */
const approvedReq: CompileRequest = { ...request, bypassApproved: true };
const BYPASS = privilegedProfile({ ...LOOSE_SCOPE, bypass: true });
const BYPASS_CTX: BypassContext = { profile: BYPASS, bypassApproved: true };
const TOKEN_ENV = { [TOOL_TOKEN_ENV]: TOKEN };
const off = new ClaudeAdapter({ binaryPath: CLAUDE });
const on = new ClaudeAdapter({ binaryPath: CLAUDE, gitChannel: true });
const compiled = (a: ClaudeAdapter, p: ResolvedProfile, req: CompileRequest = request): Invocation => {
  const inv = a.compile(req, p);
  if (isIneligible(inv)) throw new Error(`ineligible: ${inv.detail}`);
  return inv;
};
const channelArgs = (shim: ShimSpec, p: ResolvedProfile = BYPASS, req: CompileRequest = approvedReq): ChannelArgs => {
  const extra = on.gitCapabilities.channelArgs?.(shim, req, p);
  if (extra === undefined || isIneligible(extra as Invocation)) throw new Error("channel refused");
  return extra as ChannelArgs;
};
/** What the lifecycle spawns: the compiled argv without `removeFlags`, with the channel fragment appended. */
const withChannel = (inv: Invocation, extra: ChannelArgs): Invocation => {
  const drop = new Set(extra.removeFlags ?? []);
  return {
    ...inv,
    argv: [...inv.argv.filter((a) => !drop.has(a)), ...extra.argv],
    policyFlags: inv.policyFlags.filter((a) => !drop.has(a)),
    env: { ...inv.env, ...extra.env },
  };
};

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
    for (const [p, req] of [
      [INSPECT_UNTRUSTED, request],
      [EDIT_UNTRUSTED, request],
      [TRUSTED_DEVELOPMENT, request],
      [privilegedProfile(LOOSE_SCOPE), request],
      [BYPASS, approvedReq],
    ] as const) {
      const a = compiled(off, p, req);
      const b = compiled(on, p, req);
      expect(b).toEqual(a);
      expect(a.argv).not.toContain("--mcp-config");
      expect(a.env).toEqual({});
      expect(auditMcpArgs(a)).toEqual([]);
    }
  });
});

describe("opt-in on, approved bypass run: the channel fragment (ADR-0029 items 1-5, ADR-0033)", () => {
  it("declares injected and emits one --mcp-config file, exact-name allow rules and the token in env only", () => {
    expect(on.gitCapabilities).toBe(CLAUDE_GIT_CHANNEL_CAPABILITIES);
    expect(on.gitCapabilities.commitChannel).toBe("injected");
    expect(on.gitCapabilities.detail).toMatch(/UNSUPPORTED/);
    expect(on.gitCapabilities.offersChannel?.(approvedReq, BYPASS)).toBe(true);
    const dir = privateDir();
    const extra = channelArgs(shimFor(dir));
    const file = path.join(dir, CHANNEL_MCP_CONFIG_FILE);
    expect(extra.argv).toEqual(["--mcp-config", file, "--allowedTools", "mcp__switchboard-git__commit"]);
    expect(extra.removeFlags).toEqual(["--safe-mode"]);
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
      const r = claudeChannelArgs(shim, approvedReq, BYPASS);
      expect("ineligible" in r, JSON.stringify(shim.toolNames)).toBe(true);
    }
  });

  it("the spawned argv (fragment applied): no --safe-mode, --strict-mcp-config kept, every audit passes", () => {
    const dir = privateDir();
    const inv = withChannel(compiled(on, BYPASS, approvedReq), channelArgs(shimFor(dir, ["commit", "push"])));
    expect(inv.argv).not.toContain("--safe-mode");
    expect(inv.policyFlags).not.toContain("--safe-mode");
    expect(inv.argv).toContain("--strict-mcp-config");
    expect(inv.argv).toContain("--dangerously-skip-permissions");
    expect(inv.argv).toContain("--disallowedTools");
    expect(inv.env).toEqual(TOKEN_ENV);
    const channel = { mcpConfigPath: path.join(dir, CHANNEL_MCP_CONFIG_FILE), toolNames: ["commit", "push"] };
    expect(auditMcpArgs(inv, channel, BYPASS_CTX)).toEqual([]);
    expect(auditSafeMode(inv, BYPASS_CTX)).toEqual([]);
    expect(inv.argv.slice(-3)).toEqual([
      "--allowedTools",
      "mcp__switchboard-git__commit",
      "mcp__switchboard-git__push",
    ]);
  });
});

describe("opt-in on, every other run: no channel, argv as with the opt-in off (owner decision 41)", () => {
  const unapproved = privilegedProfile({ ...LOOSE_SCOPE, bypass: true });
  const cases: Array<[string, ResolvedProfile, CompileRequest]> = [
    ["inspect-untrusted", INSPECT_UNTRUSTED, request],
    ["edit-untrusted", EDIT_UNTRUSTED, request],
    ["trusted-development", TRUSTED_DEVELOPMENT, request],
    ["privileged without bypass", privilegedProfile(LOOSE_SCOPE), request],
    ["privileged without bypass, approval flag set", privilegedProfile(LOOSE_SCOPE), approvedReq],
    ["privileged bypass scope without an approval", unapproved, request],
  ];
  for (const [label, p, req] of cases) {
    it(`${label}: offersChannel false, channelArgs refused, --safe-mode kept`, () => {
      expect(on.gitCapabilities.offersChannel?.(req, p), label).toBe(false);
      const r = on.gitCapabilities.channelArgs?.(shimFor(privateDir()), req, p);
      expect(r).toEqual({ ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: CLAUDE_CHANNEL_BYPASS_ONLY });
      const a = off.compile(req, p);
      const b = on.compile(req, p);
      expect(b, label).toEqual(a);
      if (!isIneligible(b)) {
        expect(b.argv).toContain("--safe-mode");
        expect(b.argv).not.toContain("--mcp-config");
        expect(auditSafeMode(b, { profile: p, bypassApproved: req.bypassApproved === true })).toEqual([]);
      }
    });
  }

  it("audit: the bypass fragment on a non-bypass argv is refused (--mcp-config and missing --safe-mode)", () => {
    const dir = privateDir();
    const extra = channelArgs(shimFor(dir));
    const channel = { mcpConfigPath: path.join(dir, CHANNEL_MCP_CONFIG_FILE), toolNames: ["commit"] };
    for (const [p, req] of [
      [EDIT_UNTRUSTED, request],
      [TRUSTED_DEVELOPMENT, request],
      [privilegedProfile(LOOSE_SCOPE), request],
    ] as const) {
      const inv = withChannel(compiled(on, p, req), extra);
      const ctx: BypassContext = { profile: p, bypassApproved: false };
      expect(auditMcpArgs(inv, channel, ctx), p.name).toContain(
        "--mcp-config outside an approved bypass run (ADR-0033)",
      );
      expect(auditSafeMode(inv, ctx), p.name).toHaveLength(1);
      expect(() => assertSafeModeAudit(inv, ctx)).toThrow(IsolationAuditError);
      expect(() => startAdapterRun(on, inv, { profile: p, bypassApproved: false, channel })).toThrow(
        McpConfigAuditError,
      );
    }
    // The approved bypass argv itself, presented without the approval, is refused as well.
    const inv = withChannel(compiled(on, BYPASS, approvedReq), extra);
    for (const ctx of [undefined, { profile: BYPASS, bypassApproved: false }]) {
      expect(auditMcpArgs(inv, channel, ctx)).toContain("--mcp-config outside an approved bypass run (ADR-0033)");
      expect(auditSafeMode(inv, ctx)).toHaveLength(1);
    }
  });

  it("audit: --safe-mode missing without the approved bypass channel is refused, also without --mcp-config", () => {
    const strip = (inv: Invocation) => ({ ...inv, argv: inv.argv.filter((a) => a !== "--safe-mode") });
    for (const p of [INSPECT_UNTRUSTED, EDIT_UNTRUSTED, TRUSTED_DEVELOPMENT, privilegedProfile(LOOSE_SCOPE)]) {
      const inv = strip(compiled(on, p));
      expect(auditSafeMode(inv, { profile: p, bypassApproved: false }), p.name).toHaveLength(1);
      expect(() => startAdapterRun(on, inv, { profile: p })).toThrow(IsolationAuditError);
    }
    // An approved bypass run with repository_config disabled and no channel keeps --safe-mode too.
    const bare = strip(compiled(on, BYPASS, approvedReq));
    expect(auditSafeMode(bare, BYPASS_CTX)).toHaveLength(1);
    expect(() => startAdapterRun(on, bare, { profile: BYPASS, bypassApproved: true })).toThrow(IsolationAuditError);
    // Decision 26 omissions stay admitted.
    for (const mode of ["approved", "enabled"] as const) {
      const p = privilegedProfile({ ...LOOSE_SCOPE, bypass: true, repository_config: { mode } });
      const inv = compiled(on, p, approvedReq);
      expect(inv.argv).not.toContain("--safe-mode");
      expect(auditSafeMode(inv, { profile: p, bypassApproved: true })).toEqual([]);
      expect(auditSafeMode(inv, { profile: p, bypassApproved: false })).toHaveLength(1);
    }
  });
});

describe("resume in an approved bypass run", () => {
  it("resume keeps the same shape (the fragment follows --resume)", () => {
    const dir = privateDir();
    const r = on.resumeArgs({ provider: "claude", nativeSessionId: RESUMED_SESSION_ID }, approvedReq, BYPASS);
    if (isIneligible(r)) throw new Error(r.detail);
    const inv = withChannel(r, channelArgs(shimFor(dir)));
    const channel = { mcpConfigPath: path.join(dir, CHANNEL_MCP_CONFIG_FILE), toolNames: ["commit"] };
    expect(auditMcpArgs(inv, channel, BYPASS_CTX)).toEqual([]);
    expect(auditSafeMode(inv, BYPASS_CTX)).toEqual([]);
    expect(inv.argv.indexOf("--resume")).toBeLessThan(inv.argv.indexOf("--mcp-config"));
  });
});

describe("approved bypass runs (owner decisions 13, 26, 41; ADR-0017, ADR-0021, ADR-0033)", () => {
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
    // Same argv without the approval is refused twice over; on another repository_config strict is required.
    const notBypass = [
      "--mcp-config without --strict-mcp-config",
      "--mcp-config outside an approved bypass run (ADR-0033)",
    ];
    expect(auditMcpArgs(inv, channel, { profile, bypassApproved: false })).toEqual(notBypass);
    expect(auditMcpArgs(inv, channel, { profile: privilegedProfile(scope("approved")), bypassApproved: true })).toEqual(
      ["--mcp-config without --strict-mcp-config"],
    );
    expect(auditMcpArgs(inv, channel)).toEqual(notBypass);
  });

  it("repository_config disabled or approved: --strict-mcp-config kept", () => {
    for (const mode of ["disabled", "approved"] as const) {
      const dir = privateDir();
      const profile = privilegedProfile(scope(mode));
      const inv = withChannel(compiled(on, profile, approvedReq), channelArgs(shimFor(dir), profile));
      expect(inv.argv, mode).toContain("--strict-mcp-config");
      expect(inv.argv, mode).not.toContain("--safe-mode");
      const channel = { mcpConfigPath: path.join(dir, CHANNEL_MCP_CONFIG_FILE), toolNames: ["commit"] };
      expect(auditMcpArgs(inv, channel, { profile, bypassApproved: true })).toEqual([]);
      expect(auditSafeMode(inv, { profile, bypassApproved: true })).toEqual([]);
    }
  });
});

describe("audit: everything but the one channel shape is refused (ADR-0029 item 6, ADR-0015)", () => {
  const dir = "/data/runs/run_x";
  const file = `${dir}/${CHANNEL_MCP_CONFIG_FILE}`;
  const channel: ChannelAuditContext = { mcpConfigPath: file, toolNames: ["commit"] };
  const base = compiled(off, EDIT_UNTRUSTED);
  const inv = (tail: string[], policyFlags: string[] = base.policyFlags, env: Record<string, string> = TOKEN_ENV) => ({
    argv: [...base.argv, ...tail],
    policyFlags,
    env,
  });
  const good = ["--mcp-config", file, "--allowedTools", channelToolRule("commit")];

  it("admits the exact shape, in an approved bypass run with the token set", () => {
    expect(auditMcpArgs(inv(good), channel, BYPASS_CTX)).toEqual([]);
  });

  it("refuses the exact shape outside an approved bypass run (ADR-0033)", () => {
    for (const ctx of [
      undefined,
      { profile: EDIT_UNTRUSTED, bypassApproved: false },
      { ...BYPASS_CTX, bypassApproved: false },
    ]) {
      expect(auditMcpArgs(inv(good), channel, ctx)).toEqual(["--mcp-config outside an approved bypass run (ADR-0033)"]);
    }
  });

  it("refuses the exact shape when the token variable is unset or empty (it would stay a literal reference)", () => {
    for (const env of [{}, { [TOOL_TOKEN_ENV]: "" }, { OTHER: TOKEN }]) {
      expect(auditMcpArgs(inv(good, base.policyFlags, env), channel, BYPASS_CTX)).toEqual([
        `--mcp-config without ${TOOL_TOKEN_ENV} in the provider environment`,
      ]);
    }
    expect(auditMcpArgs({ argv: inv(good).argv, policyFlags: [] }, channel, BYPASS_CTX)).toHaveLength(1);
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
      expect(auditMcpArgs(inv(tail), ctx, BYPASS_CTX).length, label).toBeGreaterThan(0);
      expect(() => assertMcpAudit(inv(tail), ctx, BYPASS_CTX), label).toThrow(McpConfigAuditError);
    });
  }

  it("refuses --mcp-config when --strict-mcp-config is missing outside decision 26", () => {
    const argv = [...base.argv.filter((a) => a !== "--strict-mcp-config"), ...good];
    expect(auditMcpArgs({ argv, policyFlags: [], env: TOKEN_ENV }, channel, BYPASS_CTX)).toEqual([
      "--mcp-config without --strict-mcp-config",
    ]);
  });

  it("refuses --mcp-config or MCP rules carried in policyFlags", () => {
    const pf = (extra: string[]) => auditMcpArgs(inv([], [...base.policyFlags, ...extra]), channel, BYPASS_CTX);
    expect(pf(["--mcp-config", file]).length).toBeGreaterThan(0);
    expect(pf(["mcp__switchboard-git__*"]).length).toBeGreaterThan(0);
  });

  it("refuses an unexpected or relative definition path in the context itself", () => {
    for (const p of [
      "relative/mcp-config.json",
      "/data/runs/run_x/other.json",
      "/data/runs/run_x/../x/mcp-config.json",
    ]) {
      const argv = [...base.argv, "--mcp-config", p];
      expect(
        auditMcpArgs({ argv, policyFlags: [], env: TOKEN_ENV }, { mcpConfigPath: p, toolNames: ["commit"] }, BYPASS_CTX)
          .length,
        p,
      ).toBeGreaterThan(0);
    }
  });

  it("startAdapterRun refuses before spawning (no process is started here)", () => {
    const evil = { ...base, argv: [...base.argv, "--mcp-config", "/home/op/.mcp.json"] };
    expect(() => startAdapterRun(off, evil)).toThrow(McpConfigAuditError);
    expect(() => startAdapterRun(off, evil, { channel })).toThrow(McpConfigAuditError);
    expect(() => startAdapterRun(off, evil, { channel, profile: BYPASS, bypassApproved: true })).toThrow(
      McpConfigAuditError,
    );
  });
});

describe("audit: the read-only search tool (T12.9, FR-RAG-13): one more exact name, nothing else", () => {
  const dir = "/data/runs/run_x";
  const file = `${dir}/${CHANNEL_MCP_CONFIG_FILE}`;
  const withSearch: ChannelAuditContext = { mcpConfigPath: file, toolNames: ["commit", "search_project_context"] };
  const commitOnly: ChannelAuditContext = { mcpConfigPath: file, toolNames: ["commit"] };
  const base = compiled(off, EDIT_UNTRUSTED);
  const inv = (rules: string[]) => ({
    argv: [...base.argv, "--mcp-config", file, "--allowedTools", ...rules],
    policyFlags: base.policyFlags,
    env: TOKEN_ENV,
  });
  const SEARCH_RULE = "mcp__switchboard-git__search_project_context";

  it("the fragment names the search tool by its exact rule when the channel offers it", () => {
    const extra = channelArgs(shimFor(privateDir(), ["commit", "search_project_context"]));
    const rules = extra.argv.slice(extra.argv.indexOf("--allowedTools") + 1);
    expect(rules).toEqual(["mcp__switchboard-git__commit", SEARCH_RULE]);
    expect(channelToolRule("search_project_context")).toBe(SEARCH_RULE);
    expect(auditMcpArgs(inv(rules), withSearch, BYPASS_CTX)).toEqual([]);
    expect(
      auditMcpArgs(inv(rules), { ...withSearch, toolNames: ["commit", "push", "search_project_context"] }, BYPASS_CTX),
    ).toEqual([]);
  });

  const refused: Array<[string, string[], ChannelAuditContext]> = [
    ["the search rule when the channel does not offer it", ["mcp__switchboard-git__commit", SEARCH_RULE], commitOnly],
    ["a search wildcard", ["mcp__switchboard-git__commit", "mcp__switchboard-git__search*"], withSearch],
    ["a server wildcard next to the search rule", [SEARCH_RULE, "mcp__switchboard-git__*"], withSearch],
    [
      "a foreign tool name on the channel server",
      [SEARCH_RULE, "mcp__switchboard-git__search_global_context"],
      withSearch,
    ],
    ["the search tool on a second server", ["mcp__switchboard-search__search_project_context"], withSearch],
    ["the MCP tool's other server", ["mcp__switchboard__search_project_context"], withSearch],
    [
      "a channel context that lists a name outside TOOL_NAMES",
      ["mcp__switchboard-git__read_file"],
      { mcpConfigPath: file, toolNames: ["commit", "read_file"] },
    ],
    ["a comma-joined wildcard", [`${SEARCH_RULE},mcp__switchboard-git__*`], withSearch],
  ];
  for (const [label, rules, ctx] of refused) {
    it(`refuses ${label}`, () => {
      expect(auditMcpArgs(inv(rules), ctx, BYPASS_CTX).length, label).toBeGreaterThan(0);
      expect(() => assertMcpAudit(inv(rules), ctx, BYPASS_CTX), label).toThrow(McpConfigAuditError);
    });
  }

  it("the Claude fragment refuses a shim offering a tool outside TOOL_NAMES", () => {
    const shim = shimFor(privateDir(), ["commit", "search_everything" as "search_project_context"]);
    expect("ineligible" in claudeChannelArgs(shim, approvedReq, BYPASS)).toBe(true);
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
    const base = { ...compiled(off, EDIT_UNTRUSTED), env: TOKEN_ENV };
    const ctx = { mcpConfigPath: file, toolNames: ["commit"] };
    const withFile = { ...base, argv: [...base.argv, "--mcp-config", file] };
    expect(() => assertMcpAudit(withFile, ctx, BYPASS_CTX)).not.toThrow();
    chmodSync(file, 0o640);
    expect(() => assertMcpAudit(withFile, ctx, BYPASS_CTX)).toThrow(/accessible to other users/);
  });
});
