/**
 * Q-62 to Q-65 (ADR-0039): the escapes the 2026-10-14 live checks found, reproduced with fakes and canary strings. No
 * provider CLI, credential file or real Git write is involved: command lines are plain strings, and the one run test
 * uses the fake CLI's `tool_calls` scenario, which runs nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  commandReachesProviderState,
  pathReachesProviderState,
  workspaceReachesProviderState,
} from "../policy/provider-state.js";
import { REPO_AGENT_CONFIG_PATHS, repoAgentConfigRefusal } from "../policy/repo-agent-config.js";
import { FakeAdapter } from "./fake/adapter.js";
import { FAKE_PROFILE } from "./fake/cases.js";
import { gitWriteInCommand, splitSimpleCommands } from "./git-write.js";
import { startAdapterRun } from "./run.js";
import { guardToolCall } from "./tool-guard.js";
import type { Invocation } from "./types.js";

const HOME = "/home/canary";
const level = (c: string) => gitWriteInCommand(c)?.level;

describe("gitWriteInCommand: parsed words, not a command-string prefix (Q-62)", () => {
  it("splits compound lines, quotes and substitutions", () => {
    expect(splitSimpleCommands("a b; c && d | e\nf $(g h) `i j`")).toEqual([
      ["a", "b"],
      ["c"],
      ["d"],
      ["e"],
      ["f"],
      ["g", "h"],
      ["i", "j"],
    ]);
    expect(splitSimpleCommands(`git commit -m 'a; b' "c d"`)).toEqual([["git", "commit", "-m", "a; b", "c d"]]);
  });

  it.each([
    // the two forms that escaped Grok's `Bash(git commit*)` deny rule
    "git -C . commit --allow-empty -m x2",
    "/usr/bin/git commit --allow-empty -m x3",
    // forms the checks did not try
    "git -C . push origin main",
    "/usr/bin/git push origin main",
    "git -C /tmp/r -c user.name=x commit -m y",
    "env GIT_AUTHOR_NAME=x git commit -m y",
    "GIT_DIR=/r/.git git branch evil",
    "command git commit -m y",
    "timeout 5 git push",
    "nice -n 5 git tag v1",
    "sudo -u root git reset --hard",
    "sh -c 'git commit --allow-empty -m x4'",
    'bash -lc "cd sub && git -C .. commit -m z"',
    "eval git push",
    "echo ok; git commit -m y",
    "true && git update-ref refs/heads/x HEAD",
    "echo $(git commit -m y)",
    "git --git-dir=/r/.git --work-tree=/r commit -m y",
    "git --no-pager -c core.pager=x log",
    "git -c alias.st=commit st",
    "git -c core.hooksPath=/tmp/h status",
    "git log -O/bin/sh",
    "/opt/tools/git-receive-pack /r",
    "xargs git push",
    "{ git commit -m y; }",
    "cd /r && /usr/bin/git -C /r commit -m y",
  ])("write: %s", (c) => {
    expect(level(c)).toBe("write");
  });

  it.each([
    "git status",
    "git -C . status --short",
    "/usr/bin/git log --oneline -5",
    "git --no-pager diff HEAD~1",
    "git rev-parse HEAD",
    "echo 'git commit' > notes.txt",
    "grep -r commit src",
    "ls -la; cat README.md",
    "npm test",
  ])("not a write: %s", (c) => {
    expect(level(c)).toBeUndefined();
  });

  it("is uncertain, not clean, for dynamic or unknown subcommands", () => {
    expect(level('"$G" commit')).toBe("uncertain");
    expect(level("git ci -m y")).toBe("uncertain");
    expect(level("git $SUB")).toBe("uncertain");
    expect(level("gh pr create")).toBe("uncertain");
  });
});

describe("provider state directories (Q-62 credential reach, Q-64)", () => {
  const cwd = "/work/repo";
  it("names a state directory through ~, $HOME, absolute and relative words", () => {
    for (const c of [
      "cat ~/.grok/auth.json",
      "test -r $HOME/.grok/auth.json && echo A",
      `ls $\{HOME}/.cursor`,
      `cat ${HOME}/.codex/auth.json`,
      "cp ../../../home/canary/.claude/.credentials.json /tmp/x",
      "echo x > FILE=~/.grok/sandbox.toml",
    ]) {
      expect(commandReachesProviderState(c, { cwd, home: HOME }), c).toBeDefined();
    }
    expect(commandReachesProviderState("ls ~ ; cat ~/notes.txt ; cat ~/.bashrc", { cwd, home: HOME })).toBeUndefined();
    expect(pathReachesProviderState("~/.gemini/settings.json", { cwd, home: HOME })).toBe(`${HOME}/.gemini`);
    expect(pathReachesProviderState("src/a.ts", { cwd, home: HOME })).toBeUndefined();
  });

  it("refuses a working directory inside, or containing, a state directory", () => {
    expect(workspaceReachesProviderState(`${HOME}/.grok/sessions/x`, HOME)).toMatch(/inside/);
    expect(workspaceReachesProviderState(HOME, HOME)).toMatch(/contains/);
    expect(workspaceReachesProviderState("/", HOME)).toMatch(/contains/);
    expect(workspaceReachesProviderState(`${HOME}/projects/app`, HOME)).toBeUndefined();
  });
});

describe("guardToolCall", () => {
  const ctx = { cwd: "/work/repo", home: HOME, bypass: false };
  it("flags a git write in any run, bypass included; provider state only outside bypass", () => {
    const call = { tool: "shell" as const, command: "git -C . commit -m x" };
    expect(guardToolCall(call, ctx)).toMatchObject({ kind: "git_write" });
    expect(guardToolCall(call, { ...ctx, bypass: true })).toMatchObject({ kind: "git_write" });
    const read = { tool: "shell" as const, command: "cat ~/.grok/auth.json" };
    expect(guardToolCall(read, ctx)).toMatchObject({ kind: "provider_state" });
    expect(guardToolCall(read, { ...ctx, bypass: true })).toBeUndefined();
    expect(guardToolCall({ tool: "read", target: `${HOME}/.codex/auth.json` }, ctx)).toMatchObject({
      kind: "provider_state",
    });
    expect(guardToolCall({ tool: "shell", command: "git status" }, ctx)).toBeUndefined();
  });

  // The git- path and read-only `git branch` fixes in `gitWriteInCommand` must not open a credential read: once a line
  // is no longer a Git write, the provider-state check still sees it.
  it("a git- path or read-only git branch is allowed, a credential read beside it stays denied", () => {
    const shell = (command: string) => ({ tool: "shell" as const, command });
    for (const command of [
      "timeout 600 npx vitest run src/cli/git-push.test.ts",
      "cat src/cli/git-push.ts",
      "git branch --show-current",
      "git branch --list 'switchboard/*'",
    ]) {
      expect(guardToolCall(shell(command), ctx), command).toBeUndefined();
    }
    for (const command of [
      `timeout 600 npx vitest run src/cli/git-push.test.ts && cat ${HOME}/.codex/auth.json`,
      `timeout 600 cat ${HOME}/.claude/.credentials.json`,
      "cat src/cli/git-push.ts; cat ~/.grok/auth.json",
      "git branch --show-current && cat ~/.codex/auth.json",
      `git branch -a; cp ${HOME}/.claude/.credentials.json /tmp/x`,
    ]) {
      expect(guardToolCall(shell(command), ctx), command).toMatchObject({ kind: "provider_state" });
    }
    for (const command of [
      `cat ${HOME}/.codex/auth.json && git branch -D main`,
      "timeout 600 cat src/cli/git-push.ts; git-push origin",
    ]) {
      expect(guardToolCall(shell(command), ctx), command).toMatchObject({ kind: "git_write" });
      expect(guardToolCall(shell(command), { ...ctx, bypass: true }), command).toMatchObject({ kind: "git_write" });
    }
  });
});

describe("repo-local agent config is refused while repoConfig is disabled (Q-63)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-q63-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses the antigravity `.agents` MCP server and hook files; allows an approved scope", () => {
    mkdirSync(join(dir, ".agents"));
    writeFileSync(join(dir, ".agents", "mcp_config.json"), '{"canary":"not-a-secret"}');
    writeFileSync(join(dir, ".agents", "hooks.json"), '{"canary":"not-a-secret"}');
    expect(repoAgentConfigRefusal("antigravity", "disabled", dir)).toMatch(
      /\.agents\/mcp_config\.json, \.agents\/hooks\.json/,
    );
    expect(repoAgentConfigRefusal("antigravity", "approved-only", dir)).toBeUndefined();
    expect(repoAgentConfigRefusal("antigravity", "scoped", dir)).toBeUndefined();
    // another provider's paths are not this provider's problem; an adapter that isolates config is not listed
    expect(repoAgentConfigRefusal("cursor", "disabled", dir)).toBeUndefined();
    expect(repoAgentConfigRefusal("claude", "disabled", dir)).toBeUndefined();
  });

  it("covers the paths the live checks named for grok, cursor and opencode", () => {
    expect(REPO_AGENT_CONFIG_PATHS.grok).toContain(".mcp.json");
    expect(REPO_AGENT_CONFIG_PATHS.cursor).toContain(".cursor/mcp.json");
    expect(REPO_AGENT_CONFIG_PATHS.opencode).toContain("opencode.json");
  });
});

describe("a run whose provider ignored its deny rules is failed by Switchboard (Q-62, Q-64)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-q64-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runPlan = async (calls: unknown[]) => {
    const adapter = new FakeAdapter({ scenario: "tool_calls" });
    const inv = adapter.compile(
      { runId: "r", objective: JSON.stringify({ calls }), constraints: [], workspace: { cwd: dir, writable: true } },
      FAKE_PROFILE,
    ) as Invocation;
    const out = await startAdapterRun(adapter, inv, { baseEnv: { ...process.env, HOME } }).done;
    const failure = adapter.classifyFailure({
      events: out.events,
      exit: out.exit,
      stderrTail: "",
      timedOut: false,
      cancelled: false,
    });
    return { out, failure };
  };

  it("fails a run that attempted `git -C . commit`, and never stores the command text", async () => {
    const { out, failure } = await runPlan([
      { tool: "shell", name: "bash", command: "git -C . commit --allow-empty -m CANARY-COMMIT" },
    ]);
    const call = out.events.find((e) => e.kind === "tool_call");
    expect(call).toMatchObject({ violation: { kind: "git_write" } });
    expect(JSON.stringify(out.events)).not.toContain("CANARY-COMMIT");
    expect(failure.code).toBe("PERMISSION_BLOCKED");
  });

  it("fails a run that named the provider login file, without reading it", async () => {
    const { failure } = await runPlan([{ tool: "shell", name: "bash", command: "test -r ~/.grok/auth.json" }]);
    expect(failure.code).toBe("SANDBOX_VIOLATION");
  });

  it("leaves an ordinary run alone", async () => {
    const { failure } = await runPlan([{ tool: "shell", name: "bash", command: "git status && ls" }]);
    expect(failure.code).not.toBe("PERMISSION_BLOCKED");
    expect(failure.code).not.toBe("SANDBOX_VIOLATION");
  });
});
