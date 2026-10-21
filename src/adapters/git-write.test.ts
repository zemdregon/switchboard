import { describe, expect, it } from "vitest";
import {
  GIT_GLOBAL_FLAGS,
  GIT_GLOBAL_OPTIONS_WITH_VALUE,
  GIT_READ_ONLY_SUBCOMMANDS,
  GIT_WRITE_SUBCOMMANDS,
  gitDenyRuleSecurityReason,
  gitWriteInCommand,
  gitWriteRisk,
  gitWriteRisks,
} from "./git-write.js";

describe("gitWriteInCommand: git- file paths are not git subprograms (FR-GIT-01)", () => {
  it.each([
    "timeout 600 npx vitest run src/cli/git-push.test.ts",
    "timeout 600 npx vitest run src/adapters/git-write.test.ts src/lifecycle/git-push.test.ts",
    "cat src/cli/git-push.ts",
    "env CI=1 npx vitest run src/cli/git-push.test.ts",
    "nice -n 5 node dist/cli/git-push.js",
    "xargs cat src/cli/git-push.ts",
    "sudo -u root cat docs/git-notes.md",
    "nohup node scripts/git-hooks.mjs",
    "timeout 5 jq . config/git-remotes.json",
    "sh -c 'timeout 60 cat src/cli/git-push.ts'",
    "npx vitest run src/cli/git-push.test.ts && git status",
  ])("%j is not a Git write", (cmd) => {
    expect(gitWriteInCommand(cmd)).toBeUndefined();
  });

  it.each([
    "git-receive-pack x",
    "git-upload-pack .",
    "/usr/lib/git-core/git-push origin",
    "git-commit -m x",
    "git-push.ts",
    "timeout 5 git-receive-pack x",
    "timeout 600 /usr/lib/git-core/git-push origin",
    "env FOO=1 git-commit -m x",
    "xargs git-upload-pack",
    "sudo -u root git-lfs.exe push",
    "timeout 600 npx vitest run src/cli/git-push.test.ts; git-push origin",
    "timeout 600 cat src/cli/git-push.ts && git push",
  ])("%j is still refused", (cmd) => {
    expect(gitWriteInCommand(cmd)).toBeDefined();
  });
});

describe("gitWriteInCommand: read-only git branch forms (FR-GIT-01)", () => {
  it.each([
    "git branch",
    "git branch --show-current",
    "git branch --list",
    "git branch --list 'switchboard/feat'",
    "git branch -l feat",
    "git branch -a",
    "git branch -r",
    "git branch -v",
    "git branch -vv",
    "git branch -avv",
    "git branch --contains",
    "git branch --contains HEAD",
    "git branch --no-contains main",
    "git branch --merged",
    "git branch --merged main",
    "git branch --no-merged origin/main feat",
    "git branch --points-at HEAD",
    "git branch --sort=-committerdate --format='%(refname:short)'",
    "git branch --color=never --no-column",
    "git --no-pager branch -a",
    "git -C /repo branch --show-current",
    "git branch --show-current && git status",
  ])("%j is not a Git write", (cmd) => {
    expect(gitWriteInCommand(cmd)).toBeUndefined();
  });

  it.each([
    "git branch feature",
    "git branch feature main",
    "git branch -- feature",
    "git branch -v feature",
    "git branch -a feature",
    "git branch -d feature",
    "git branch -D feature",
    "git branch --delete feature",
    "git branch -r -d origin/feature",
    "git branch -m old new",
    "git branch -M new",
    "git branch --move new",
    "git branch -c new",
    "git branch -C new",
    "git branch --copy old new",
    "git branch -f main HEAD~1",
    "git branch --force main",
    "git branch -u origin/main",
    "git branch --set-upstream-to=origin/main",
    "git branch --unset-upstream",
    "git branch --edit-description",
    "git branch --track feat origin/feat",
    "git branch --no-track feat",
    "git branch --create-reflog feat",
    "git branch --recurse-submodules feat",
    "git branch -vd feature",
    "git branch --del feature",
    "git branch --list --delete feature",
    "git branch --merged main -d feature",
    "git branch --sort=refname feature",
    "git branch $NAME",
    "git branch --show-current; git branch feature",
  ])("%j is still refused", (cmd) => {
    expect(gitWriteInCommand(cmd)).toBeDefined();
  });

  it("a glob or variable argument is uncertain, not a write: the ref snapshot decides", () => {
    expect(gitWriteInCommand("git branch --list 'switchboard/*'")?.level).toBe("uncertain");
    expect(gitWriteInCommand("git branch --list $P")?.level).toBe("uncertain");
  });

  it("the allowlist check still refuses git branch in any form (listing and writing share the subcommand)", () => {
    expect(gitWriteRisk("git branch --show-current")).toBeDefined();
    expect(gitWriteRisk("git branch")).toBeDefined();
  });
});

describe("gitWriteRisk (FR-GIT-01 lexical check)", () => {
  it.each([
    "git commit",
    "git commit -m x",
    "git push",
    "git push origin main",
    "git branch -f main",
    "git branch feature",
    "git tag v1",
    "git update-ref refs/heads/x HEAD",
    "git symbolic-ref HEAD refs/heads/x",
    "git reset --hard",
    "git checkout -b x",
    "git switch -c x",
    "git merge x",
    "git rebase main",
    "git cherry-pick abc",
    "git stash",
    "git fetch",
    "git pull",
    "git notes add",
    "git worktree add ../x",
    "git config alias.ci commit",
    "git -C . commit",
    "git --no-pager commit",
    "git -P commit",
    "git -p status",
    "git --no-optional-locks commit",
    "git --literal-pathspecs commit",
    "git --glob-pathspecs add",
    "git --no-replace-objects commit",
    "git --bare update-ref refs/heads/x HEAD",
    "git --namespace=x push",
    "git --config-env=user.name=HOME commit",
    "git --exec-path=/x commit",
    "git --attr-source=HEAD commit",
    "git reflog expire --expire=now --all",
    "git reflog delete HEAD@{1}",
    "git pack-refs --all",
    "git gc --prune=now",
    "git prune",
    "git maintenance run",
    "git repack -ad",
    "git hash-object -w x",
    "git -c alias.x=commit x",
    "git --git-dir=/repo/.git commit",
    "git --work-tree . status",
    "/usr/bin/git push",
    "git-receive-pack x",
    "git ci",
    "git frobnicate",
    "gh pr create",
    "gh",
    "env git commit",
    "xargs git push",
    "sh -c git",
    "git grep -Ogit x",
    "git grep --open-files-in-pager=sh x",
  ])("%j could write Git", (cmd) => {
    expect(gitWriteRisk(cmd)).toBeDefined();
  });

  it.each([
    "git",
    "git status",
    "git diff --stat",
    "git log -n 5",
    "git show HEAD",
    "git rev-parse HEAD",
    "npm test",
    "ls",
    "cat README.md",
  ])("%j is not a Git write", (cmd) => {
    expect(gitWriteRisk(cmd)).toBeUndefined();
  });

  it("the write and read-only lists are disjoint and cover commit, ref changes and push", () => {
    for (const v of GIT_WRITE_SUBCOMMANDS) expect(GIT_READ_ONLY_SUBCOMMANDS).not.toContain(v);
    for (const v of ["commit", "branch", "tag", "update-ref", "reset", "push"])
      expect(GIT_WRITE_SUBCOMMANDS).toContain(v);
  });

  it("every global option spelling and every new subcommand is covered (R-43)", () => {
    for (const o of [...GIT_GLOBAL_OPTIONS_WITH_VALUE, ...GIT_GLOBAL_FLAGS])
      expect(gitWriteRisk(`git ${o} x commit`), o).toBeDefined();
    for (const v of ["reflog", "pack-refs", "gc", "prune", "maintenance", "repack", "hash-object"]) {
      expect(GIT_WRITE_SUBCOMMANDS).toContain(v);
      expect(gitWriteRisk(`git ${v}`), v).toBeDefined();
    }
  });

  it("gitWriteRisks returns only the risky entries with reasons", () => {
    expect(gitWriteRisks(["git status", "git push", "npm test"])).toEqual([
      { command: "git push", reason: expect.stringContaining("push") },
    ]);
  });
});

describe("gitDenyRuleSecurityReason: which Git deny-rule hits are security-class (ADR-0072 follow-up)", () => {
  it.each([
    'for f in $(git ls-files src | head -20); do echo "$f $(git log -1 --format=%cs -- "$f")"; done; git branch -a',
    "git branch -a",
    "git tag -l",
    "git stash list",
    "git log --oneline -5 && git status",
    "git checkout -b feature",
    "git switch main",
    "git reset --hard HEAD",
    "LC_ALL=C git --no-pager log -1",
    "if git branch --show-current; then echo ok; fi",
  ])("local: %j", (cmd) => {
    expect(gitDenyRuleSecurityReason(cmd)).toBeUndefined();
  });

  it.each([
    ["git push origin x", /not a local git verb/],
    ["git send-pack ../r main", /not a local git verb/],
    ["git remote add up https://example.test/r.git", /not a local git verb/],
    ["git fetch https://example.test/r.git", /not a local git verb/],
    ["git pull", /not a local git verb/],
    ["git config core.hooksPath /tmp/h", /not a local git verb/],
    ["git update-ref refs/heads/main HEAD~1", /not a local git verb/],
    ["git symbolic-ref HEAD refs/heads/x", /not a local git verb/],
    ["git -C ../x branch", /global option `-C`/],
    ["git -c alias.l=!sh log", /global option `-c`/],
    ["git --git-dir=../x/.git branch -a", /global option `--git-dir`/],
    ["git --work-tree ../x status", /global option `--work-tree`/],
    ["git --exec-path=/tmp log", /global option `--exec-path`/],
    ["gh pr merge 1", /`gh` can push/],
    ["/usr/bin/gh api repos", /`gh` can push/],
    ["GIT_DIR=../x/.git git branch -a", /GIT_ variable/],
    ["git-receive-pack .", /git subprogram/],
    ["git $SUB", /dynamic git subcommand/],
    ["$CMD branch", /dynamic program/],
    ["sh -c 'git push origin x'", /may run git or gh/],
    ["env git push", /runs `git`/],
    ["find . -exec git push \\;", /runs `git`/],
    ['echo "$(git push origin x)"; git branch -a', /not a local git verb/],
    ["git grep -Ovim x", /runs a program/],
    ["git log --output=/tmp/x", /writes elsewhere/],
    ["echo nothing to see", /no git invocation/],
    ["", /not found/],
    [undefined, /not found/],
    [`git log ${"a".repeat(20_000)}`, /too long/],
  ])("security-class: %j", (cmd, reason) => {
    expect(gitDenyRuleSecurityReason(cmd)).toMatch(reason);
  });
});

describe("ADR-0087 item 4: submodule commands stay agent-blocked (only the controller commits in submodules)", () => {
  it.each([
    "git submodule",
    "git submodule status",
    "git submodule update --init --recursive",
    "git submodule add https://github.test/acme/lib libs/lib",
    "git submodule foreach git commit -am x",
    "git submodule sync",
    "git -C libs/lib submodule update",
    "sh -c 'git submodule update --init'",
    "env X=1 git submodule update",
  ])("%j is a Git write", (cmd) => {
    expect(gitWriteInCommand(cmd)?.level).toBe("write");
    expect(gitWriteRisk(cmd)).toBeDefined();
  });

  it.each([
    "git checkout --recurse-submodules main",
    "git switch --recurse-submodules feat",
    "git reset --hard --recurse-submodules HEAD",
    "git pull --recurse-submodules",
    "git fetch --recurse-submodules=yes",
    "git push --recurse-submodules=on-demand origin main",
    "git -c submodule.recurse=true checkout main",
  ])("%j (a write that recurses into submodules) is a Git write", (cmd) => {
    expect(gitWriteInCommand(cmd)?.level).toBe("write");
    expect(gitWriteRisk(cmd)).toBeDefined();
  });

  it("git clone --recurse-submodules is never accepted as read-only", () => {
    const cmd = "git clone --recurse-submodules https://github.test/acme/umbrella";
    expect(gitWriteInCommand(cmd)).toBeDefined();
    expect(gitWriteRisk(cmd)).toBeDefined();
  });

  it("a denied `git submodule` is security-class, not a local verb", () => {
    expect(gitDenyRuleSecurityReason("git submodule update --init")).toMatch(/not a local git verb/u);
    expect(gitDenyRuleSecurityReason("git submodule status")).toMatch(/not a local git verb/u);
  });
});
