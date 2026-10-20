import { describe, expect, it } from "vitest";
import {
  GIT_GLOBAL_FLAGS,
  GIT_GLOBAL_OPTIONS_WITH_VALUE,
  GIT_READ_ONLY_SUBCOMMANDS,
  GIT_WRITE_SUBCOMMANDS,
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
