/**
 * ADR-0096: the Git guard reads what the shell runs (redirections are not arguments), lets read-only Git invocations
 * through in every run (`git checkout <path>`, `git remote -v`), treats a denied read-only `gh` as recoverable, and a
 * guard `git_write` on a call the provider itself refused as a local Git verb no longer fails a run that did its work.
 * Pushes, remote changes, configuration, branch and tag creation and `checkout <branch>` stay writes, and a flagged
 * call the provider did not refuse now fails Claude Code and Codex runs too. Synthetic Claude streams replayed through
 * `startAdapterRun`; no provider CLI and no Git process.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude/adapter.js";
import { EDIT_UNTRUSTED } from "./claude/fixtures/cases.js";
import { claudeDenialClass } from "./claude/parse.js";
import { CodexAdapter } from "./codex/adapter.js";
import { recoveredDenialWarnings } from "./failure.js";
import { replayLauncher } from "./fixtures/replay.js";
import {
  deniedCommandSummary,
  gitDenyRuleSecurityReason,
  gitWriteInCommand,
  isCheckoutPathForm,
  splitSimpleCommands,
} from "./git-write.js";
import { startAdapterRun } from "./run.js";
import { guardToolCall } from "./tool-guard.js";
import { isIneligible, type NormalizedEvent, type RunResult } from "./types.js";

const bypass = (c: string) => gitWriteInCommand(c, { bypass: true });
const plain = (c: string) => gitWriteInCommand(c);

describe("splitSimpleCommands redirections (ADR-0096)", () => {
  it("drops unquoted redirections and their targets only when asked", () => {
    const cmd = "git branch -a 2>/dev/null >> log.txt; git log 2>&1 >| out < in | tail -3";
    expect(splitSimpleCommands(cmd, { redirections: "drop" })).toEqual([
      ["git", "branch", "-a"],
      ["git", "log"],
      ["tail", "-3"],
    ]);
    expect(splitSimpleCommands("git log > /tmp/x")).toEqual([["git", "log", ">", "/tmp/x"]]);
  });

  it("keeps quoted text, a word before the operator, and a target that is a substitution", () => {
    expect(splitSimpleCommands(`git commit -m "a > b" x>y`, { redirections: "drop" })).toEqual([
      ["git", "commit", "-m", "a > b", "x"],
    ]);
    expect(splitSimpleCommands(`git log > "$(git push)"`, { redirections: "drop" })).toEqual([
      ["git", "log", "$(git push)"],
    ]);
    expect(splitSimpleCommands("git log >$(git push)", { redirections: "drop" })).toEqual([
      ["git", "log"],
      ["git", "push"],
    ]);
  });
});

describe("gitWriteInCommand: read-only forms in every run (ADR-0096)", () => {
  it.each([
    "git branch --show-current 2>/dev/null",
    "git branch -a 2>/dev/null | head -20",
    "git branch -r --contains abc1234 2>&1",
    "git status > /tmp/status.txt",
    "git remote",
    "git remote -v",
    "git remote -v 2>/dev/null",
    "git remote get-url origin",
    "git remote show origin",
  ])("%j is not a write, bypass or not", (cmd) => {
    expect(plain(cmd)).toBeUndefined();
    expect(bypass(cmd)).toBeUndefined();
  });

  it.each(["git fetch origin 2>&1 | tail -3", "git fetch --prune origin >/dev/null 2>&1"])(
    "%j is not a write in an approved bypass run (redirections are not fetch arguments)",
    (cmd) => {
      expect(bypass(cmd)).toBeUndefined();
      expect(plain(cmd)?.level).toBe("write");
    },
  );

  it.each([
    "git checkout -- public-app/visitor.js",
    "git checkout public-app/visitor.js",
    "git checkout .",
    "git checkout ./src",
    "git checkout docs/",
    "git checkout HEAD -- a.ts",
    "git checkout HEAD~1 src/a.ts src/b.ts",
    "git checkout main README",
    "git checkout --ours -- conflicted.ts",
    "git checkout -q -- a.ts 2>/dev/null",
    "git checkout .github/workflows",
  ])("%j is a path checkout: local, never a write", (cmd) => {
    expect(plain(cmd)?.level).toBe("local");
    expect(bypass(cmd)?.level).toBe("local");
  });

  it.each([
    "git checkout main",
    "git checkout release/1.2",
    "git checkout switchboard/sess_x/run_y",
    "git checkout HEAD~1",
    "git checkout -b scratch",
    "git checkout -b scratch a.ts",
    "git checkout -B main",
    "git checkout --orphan x",
    "git checkout --detach -- a.ts",
    "git checkout --track origin/x",
    "git checkout --recurse-submodules main",
    "git checkout $BRANCH",
    "git checkout --",
    "git checkout main 2>/dev/null",
    "git -C ../main checkout -- a.ts",
  ])("%j still moves HEAD or creates a branch: a write", (cmd) => {
    expect(plain(cmd)?.level).toBe("write");
    expect(bypass(cmd)?.level).toBe("write");
  });

  it.each([
    "git push origin HEAD 2>&1",
    "git push --force origin main >/dev/null",
    "git remote add up https://example.test/r.git",
    "git remote set-url origin https://example.test/r.git 2>/dev/null",
    "git remote -v; git remote remove origin",
    "git config user.email x@example.test > /dev/null",
    "git branch feature 2>/dev/null",
    "git branch -D main",
    "git tag v1 2>&1",
    "git switch main",
    "git stash",
    "git update-ref refs/heads/main HEAD",
    "git log >$(git push)",
  ])("%j is still a write in every run", (cmd) => {
    expect(plain(cmd)?.level).toBe("write");
    expect(bypass(cmd)?.level).toBe("write");
  });

  it("`git remote update` stays a bypass-only read (it fetches)", () => {
    expect(plain("git remote update")?.level).toBe("write");
    expect(bypass("git remote update")).toBeUndefined();
  });

  it("isCheckoutPathForm needs a path, not a branch-like word", () => {
    expect(isCheckoutPathForm(["--", "a.ts"])).toBe(true);
    expect(isCheckoutPathForm(["a.ts"])).toBe(true);
    expect(isCheckoutPathForm(["feature"])).toBe(false);
    expect(isCheckoutPathForm(["v1.2"])).toBe(false);
    expect(isCheckoutPathForm([])).toBe(false);
  });

  it("the tool-call guard no longer flags these reads", () => {
    const ctx = { cwd: "/w", home: "/home/canary", bypass: false };
    for (const command of ["git checkout public-app/visitor.js", "git remote -v", "git branch --show-current 2>&1"]) {
      expect(guardToolCall({ tool: "shell", command }, ctx)).toBeUndefined();
    }
    expect(guardToolCall({ tool: "shell", command: "git checkout main" }, ctx)).toMatchObject({ kind: "git_write" });
  });
});

describe("gitDenyRuleSecurityReason: denied reads are recoverable (ADR-0096)", () => {
  it.each([
    "git remote -v",
    "git remote get-url origin",
    "git remote -v && git branch -a",
    "gh pr view 327",
    "gh pr checks 327",
    "gh pr list --state open --json number,title",
    "gh run view 123 --log-failed",
    "gh issue list",
    "gh repo view",
    "gh status",
    "git status 2>/dev/null; gh pr diff 12",
  ])("a denied %j never ran and is local", (cmd) => {
    expect(gitDenyRuleSecurityReason(cmd)).toBeUndefined();
    expect(claudeDenialClass("Bash", "rule", cmd)).toBe("git_rule_local");
  });

  it.each([
    "gh pr create --fill",
    "gh pr merge 12",
    "gh pr checkout 12",
    "gh pr view 12 --web",
    "gh api repos/o/r/pulls -X POST",
    "gh api repos/o/r",
    "gh repo clone o/r",
    "gh auth status --show-token",
    "gh pr view $N",
    "gh",
    "git remote add x y",
    "git remote update",
    "git push origin main",
    "timeout 30 gh pr view 1",
  ])("a denied %j stays security-class", (cmd) => {
    expect(gitDenyRuleSecurityReason(cmd)).toBeDefined();
    expect(claudeDenialClass("Bash", "rule", cmd)).toBe("git_write");
  });
});

describe("a call the provider refused as a local Git verb does not fail the run (ADR-0096)", () => {
  const flagged = (callId: string | undefined, reason = "`git branch <name>` creates a branch"): NormalizedEvent => ({
    kind: "tool_call",
    tool: "shell",
    name: "Bash",
    violation: { kind: "git_write", reason },
    ...(callId !== undefined ? { callId } : {}),
  });
  const denied = (callId: string | undefined, denial: "git_rule_local" | "git_write"): NormalizedEvent => ({
    kind: "permission_denied",
    tool: "Bash",
    denial,
    ...(callId !== undefined ? { callId } : {}),
  });

  it("matches the refusal by call id", () => {
    expect(recoveredDenialWarnings([flagged("t1"), denied("t1", "git_rule_local")])).toEqual([
      { code: "GIT_RULE_DENIED_RECOVERED", tool: "Bash", count: 1 },
    ]);
  });

  it("blocks without a matching refusal, with a security-class refusal, or without ids", () => {
    expect(recoveredDenialWarnings([flagged("t1"), denied("t2", "git_rule_local")])).toBeUndefined();
    expect(recoveredDenialWarnings([flagged("t1"), denied("t1", "git_write")])).toBeUndefined();
    expect(recoveredDenialWarnings([flagged(undefined), denied(undefined, "git_rule_local")])).toBeUndefined();
    expect(recoveredDenialWarnings([flagged("t1")])).toBeUndefined();
  });

  it("a provider_state violation still blocks even when the call was refused", () => {
    const ev: NormalizedEvent = {
      kind: "tool_call",
      tool: "shell",
      name: "Bash",
      violation: { kind: "provider_state", reason: "names ~/.claude" },
      callId: "t1",
    };
    expect(recoveredDenialWarnings([ev, denied("t1", "git_rule_local")])).toBeUndefined();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "sb-git-guard-reads-"));
  dirs.push(d);
  return d;
};

const S = "{{SESSION_ID}}";
const init = { type: "system", subtype: "init", session_id: S, model: "synthetic-model", cwd: ".", tools: ["Bash"] };
const bash = (id: string, command: string) => ({
  type: "assistant",
  session_id: S,
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
const ruleDenial = (id: string) => ({
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: id,
  decision_reason_type: "rule",
  message: "scrubbed",
  session_id: S,
});
const success = { type: "result", subtype: "success", is_error: false, result: "Committed the work.", session_id: S };

/** Replay a synthetic Claude Code stream through the real adapter and `startAdapterRun` (tool-call guard included). */
async function replayClaude(lines: readonly object[]): Promise<RunResult> {
  const file = path.join(tmp(), "stream.jsonl");
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const adapter = new ClaudeAdapter({
    binaryPath: process.execPath,
    launcherArgs: replayLauncher("claude", file, []),
    timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
  });
  const inv = adapter.compile(
    {
      runId: "run_git_guard_reads",
      objective: "synthetic",
      constraints: [],
      workspace: { cwd: tmp(), writable: true },
    },
    EDIT_UNTRUSTED,
  );
  if (isIneligible(inv)) throw new Error(inv.detail);
  return (await startAdapterRun(adapter, inv, { profile: EDIT_UNTRUSTED }).done).result;
}

describe("Claude Code runs end to end (ADR-0096)", () => {
  it("a refused `git branch <name>` after real work is a warning, not PERMISSION_BLOCKED", async () => {
    const r = await replayClaude([init, bash("t1", "git branch wh-001-evidence"), ruleDenial("t1"), success]);
    expect(r).toMatchObject({ ok: true, warnings: [{ code: "GIT_RULE_DENIED_RECOVERED", tool: "Bash", count: 1 }] });
  });

  it("a refused read-only `gh pr checks` and `git checkout <path>` do not fail the run", async () => {
    const r = await replayClaude([
      init,
      bash("t1", "gh pr checks 327"),
      ruleDenial("t1"),
      bash("t2", "git checkout public-app/visitor.js"),
      ruleDenial("t2"),
      success,
    ]);
    expect(r).toMatchObject({ ok: true, warnings: [{ code: "GIT_RULE_DENIED_RECOVERED", tool: "Bash", count: 2 }] });
  });

  it("a refused push still fails the run", async () => {
    const r = await replayClaude([init, bash("t1", "git push origin HEAD 2>&1"), ruleDenial("t1"), success]);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(r.failureDetail).toMatch(/^git write attempted: `git push`/);
  });

  it("a flagged write the provider did not refuse fails the run (previously a success)", async () => {
    const r = await replayClaude([init, bash("t1", "git push origin HEAD"), success]);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    const b = await replayClaude([init, bash("t1", "git branch feature"), success]);
    expect(b).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });
});

describe("the failure detail names what was denied (ADR-0096)", () => {
  it.each([
    ["gh pr create --fill", true, "`gh pr create`: `gh` can push to a Git host"],
    ["git push origin HEAD 2>&1 | tail -3", true, "`git push; tail`: `git push` is not a local git verb"],
    ["git log -1 && git remote add up https://example.test/r.git", false, "`git log; git remote`"],
    ["curl -s https://example.test/x", true, "`curl`: no git invocation found"],
    ["npm run build", false, "`npm`"],
  ])("%j -> %j", (command, reason, expected) => {
    expect(deniedCommandSummary(command, { reason })).toBe(expected);
  });

  it("shows no argument value, path, URL or token", () => {
    const secret = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    const tokenUser = ["x", "access", "token"].join("-");
    for (const command of [
      `GH_TOKEN=${secret} gh api /user`,
      `curl -H "Authorization: Bearer ${secret}" https://example.test`,
      `git push https://${tokenUser}:${secret}@example.test/r.git HEAD`,
      `git -c http.extraHeader="Authorization: ${secret}" push`,
      `/tmp/${secret}/run.sh`,
      `echo ${secret}; echo 2; echo 3; git push ${secret}`,
    ]) {
      const summary = deniedCommandSummary(command, { reason: true }) ?? "";
      expect(summary).not.toContain(secret.slice(0, 12));
      expect(summary).not.toMatch(/example\.test|Bearer|\/tmp/);
    }
    expect(deniedCommandSummary(undefined)).toBeUndefined();
    expect(deniedCommandSummary("  ")).toBeUndefined();
  });

  it("a Claude Code run names the blocking denial and its command, never the recovered one before it", async () => {
    const modeDenial = { ...ruleDenial("t1"), decision_reason_type: "mode" };
    const r = await replayClaude([
      init,
      bash("t1", "npm view left-pad"),
      modeDenial,
      bash("t2", "curl -s https://example.test/x"),
      ruleDenial("t2"),
      success,
    ]);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(r.failureDetail).toBe("denied: Bash (git_write: `curl`: no git invocation found)");
  });

  it("a denial only in result.permission_denials still names its command (unclassified)", async () => {
    const result = { ...success, permission_denials: [{ tool_name: "Bash", tool_use_id: "t1" }] };
    const r = await replayClaude([init, bash("t1", "gh pr view 12 --json state"), result]);
    expect(r).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: Bash (`gh pr view`)",
    });
  });
});

describe("Codex runs (ADR-0096)", () => {
  it("a call the tool-call guard flagged is not a clean success", () => {
    const codex = new CodexAdapter();
    const exit = { outcome: "exited" as const, exitCode: 0, signal: null, expectedExitCodes: [0] };
    const events: NormalizedEvent[] = [
      { kind: "tool_call", tool: "shell", name: "exec", violation: { kind: "git_write", reason: "`git push`" } },
      { kind: "result", ok: true },
    ];
    expect(codex.extractResult(events, exit)).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(codex.extractResult([{ kind: "result", ok: true }], exit)).toMatchObject({ ok: true });
  });
});
