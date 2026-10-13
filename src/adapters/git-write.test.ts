import { describe, expect, it } from "vitest";
import {
  GIT_GLOBAL_FLAGS,
  GIT_GLOBAL_OPTIONS_WITH_VALUE,
  GIT_READ_ONLY_SUBCOMMANDS,
  GIT_WRITE_SUBCOMMANDS,
  gitWriteRisk,
  gitWriteRisks,
} from "./git-write.js";

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
