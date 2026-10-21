/**
 * ADR-0094: in an approved privileged bypass run, Git commands that only download or read run, local ref verbs are
 * left to the deny rules and the FR-GIT-03 ref check, and pushes, remote changes and configuration stay writes. Pure
 * string checks: no provider CLI and no Git process.
 */
import { describe, expect, it } from "vitest";
import { CLAUDE_BYPASS_GIT_DENY_RULES, CLAUDE_GIT_DENY_RULES } from "./claude/adapter.js";
import { claudeDenialClass } from "./claude/parse.js";
import { recoveredDenialWarnings } from "./failure.js";
import { gitBypassReadVerdict, gitWriteInCommand } from "./git-write.js";
import { guardToolCall } from "./tool-guard.js";

const bypass = (c: string) => gitWriteInCommand(c, { bypass: true });

describe("gitWriteInCommand in bypass mode (ADR-0094)", () => {
  it.each([
    "git fetch",
    "git fetch origin",
    "git fetch origin main",
    "git fetch --all --prune",
    "git fetch -p origin",
    "git fetch --tags origin",
    "git fetch --depth 1 origin main",
    "git fetch --depth=50 --no-tags origin",
    "git fetch -j4 --multiple origin upstream",
    "git fetch --dry-run origin",
    "git fetch https://github.com/zemdregon/switchboard.git main",
    "git fetch git@github.com:zemdregon/switchboard.git",
    "git fetch -- origin main",
    "git remote",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "git remote update",
    "git remote update --prune origin",
    "git ls-remote origin",
    "git ls-remote --heads --tags https://github.com/zemdregon/switchboard.git 'refs/heads/*'",
    "git --no-pager fetch origin",
    "git fetch origin && git status",
    "cd /tmp/x && git fetch origin; git log origin/main..HEAD",
    "timeout 60 git fetch origin",
    "bash -c 'git fetch origin && git status'",
  ])("%j is not a write", (cmd) => {
    expect(bypass(cmd)).toBeUndefined();
  });

  it.each([
    "git commit -m wip",
    'git commit -am "$MSG"',
    "git pull",
    "git pull --ff-only",
    "git pull --ff-only origin main",
    "git reset --hard HEAD~1",
    "git merge origin/main",
    "git checkout -- src/app.ts",
    "git checkout HEAD~1 -- README.md",
    "git reset --soft HEAD~2",
    "git fetch origin && git pull --ff-only",
  ])("%j is local (denied or put back by the ref check; not a run failure)", (cmd) => {
    expect(bypass(cmd)?.level).toBe("local");
  });

  it.each([
    "git push",
    "git push origin HEAD:main",
    "git fetch origin main:main",
    "git fetch origin +refs/heads/*:refs/remotes/origin/*",
    "git fetch origin 'refs/heads/*'",
    "git fetch --force origin",
    "git fetch -f origin",
    "git fetch --prune-tags origin",
    "git fetch --refmap= origin main",
    "git fetch --update-head-ok origin",
    "git fetch --set-upstream origin main",
    "git fetch --prefetch origin",
    "git fetch --upload-pack=/tmp/x origin",
    "git fetch 'ext::sh -c touch% /tmp/pwned'",
    "git fetch $REMOTE",
    "git remote add up https://example.test/r.git",
    "git remote set-url origin https://example.test/r.git",
    "git remote remove origin",
    "git remote rename origin up",
    "git remote prune origin",
    "git remote set-head origin -a",
    "git remote --verbose add x y",
    "git ls-remote --upload-pack=/tmp/x origin",
    "git -C /home/op/repo fetch origin",
    "git --git-dir=../x/.git fetch",
    "git -C ../main commit -m x",
    "git --work-tree=../main checkout main",
    "git -c core.sshCommand=/tmp/x fetch origin",
    "git config user.email x@example.test",
    "git update-ref refs/heads/main HEAD",
    "git submodule update --init",
    "git commit --exec x",
    "git checkout main",
    "git switch -c feature",
    "git stash",
    "git branch feature",
    "git tag v1",
    "git checkout -b scratch -- x",
    "git pull origin main:main",
    "git pull --force origin",
    "git pull 'ext::sh -c x'",
    "git branch -D main",
    "git branch -f main HEAD",
    "git branch -m main old",
    "git tag -f v1",
    "git tag -d v1",
    "git checkout -B main",
    "git switch -C main",
    "git checkout --ignore-other-worktrees main",
    "git-receive-pack .",
    "git fetch origin; git push origin main",
    "git commit -m x && git push",
  ])("%j is still a write", (cmd) => {
    expect(bypass(cmd)?.level).toBe("write");
  });

  it("gh stays uncertain-or-worse (never allowed by this check)", () => {
    expect(bypass("gh pr create")?.level).toBeDefined();
  });

  it.each(["git fetch origin", "git remote update", "git commit -m x", "git pull --ff-only"])(
    "outside bypass %j is still a write (unchanged)",
    (cmd) => {
      expect(gitWriteInCommand(cmd)?.level).toBe("write");
    },
  );

  it("ls-remote is not a write outside bypass either way it is parsed", () => {
    expect(gitBypassReadVerdict("ls-remote", ["origin"])).toBeUndefined();
  });
});

describe("tool-call guard (ADR-0094)", () => {
  const call = (command: string) => ({ tool: "shell" as const, command });
  const ctx = (b: boolean) => ({ cwd: "/w", home: "/home/canary", bypass: b });

  it("an approved bypass run may fetch and run local verbs without a violation", () => {
    expect(guardToolCall(call("git fetch origin && git status"), ctx(true))).toBeUndefined();
    expect(guardToolCall(call("git commit -m x"), ctx(true))).toBeUndefined();
  });

  it("an approved bypass run still gets git_write for a push or a fetch into a local branch", () => {
    expect(guardToolCall(call("git push origin main"), ctx(true))).toMatchObject({ kind: "git_write" });
    expect(guardToolCall(call("git fetch origin main:main"), ctx(true))).toMatchObject({ kind: "git_write" });
  });

  it("a run that is not an approved bypass run still gets git_write for git fetch", () => {
    expect(guardToolCall(call("git fetch origin"), ctx(false))).toMatchObject({
      kind: "git_write",
    });
  });
});

describe("Claude bypass deny rules (ADR-0094)", () => {
  it("drop the fetch rules and narrow the remote rules to remote changes", () => {
    expect(CLAUDE_BYPASS_GIT_DENY_RULES).not.toContain("Bash(git fetch)");
    expect(CLAUDE_BYPASS_GIT_DENY_RULES).not.toContain("Bash(git fetch *)");
    expect(CLAUDE_BYPASS_GIT_DENY_RULES).not.toContain("Bash(git remote)");
    expect(CLAUDE_BYPASS_GIT_DENY_RULES).not.toContain("Bash(git remote *)");
    for (const v of ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune"]) {
      expect(CLAUDE_BYPASS_GIT_DENY_RULES).toContain(`Bash(git remote ${v} *)`);
    }
    const kept = CLAUDE_GIT_DENY_RULES.filter((r) => !/^Bash\(git (fetch|remote)( \*)?\)$/.test(r));
    expect(CLAUDE_BYPASS_GIT_DENY_RULES.slice(0, kept.length)).toEqual(kept);
    for (const r of ["Bash(git push *)", "Bash(git pull *)", "Bash(git commit *)", "Bash(git -C *)", "Bash(gh *)"]) {
      expect(CLAUDE_BYPASS_GIT_DENY_RULES).toContain(r);
    }
  });

  it("a denied git pull is recoverable; a denied push or remote change still blocks", () => {
    expect(claudeDenialClass("Bash", "rule", "git pull --ff-only")).toBe("git_rule_local");
    expect(claudeDenialClass("Bash", "rule", "git push origin main")).toBe("git_write");
    expect(claudeDenialClass("Bash", "rule", "git remote add x y")).toBe("git_write");
    expect(recoveredDenialWarnings([{ kind: "permission_denied", tool: "Bash", denial: "git_rule_local" }])).toEqual([
      { code: "GIT_RULE_DENIED_RECOVERED", tool: "Bash", count: 1 },
    ]);
  });
});
