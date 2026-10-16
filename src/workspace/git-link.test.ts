/**
 * The worktree `.git` link guard (T10.3, ADR-0053): what counts as the worktree's own link, what is restored, and that
 * a restore never follows a symlink or recreates a worktree that is gone.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWorktreeGitLink, inspectWorktreeGitLink } from "./git-link.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

let root: string;
let repo: string;
let wt: string;
let original: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-gitlink-")));
  repo = path.join(root, "repo");
  wt = path.join(root, "wt");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(repo, "worktree", "add", "-q", "-b", "run", wt);
  original = readFileSync(path.join(wt, ".git"), "utf8");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const link = () => path.join(wt, ".git");
const expectRestored = () => {
  expect(readFileSync(link(), "utf8")).toBe(`gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
  expect(g(wt, "symbolic-ref", "HEAD")).toBe("refs/heads/run");
};

describe("worktree .git link (T10.3, ADR-0053)", () => {
  it("the link Git wrote is the worktree's own and is left untouched", async () => {
    expect(await ensureWorktreeGitLink(repo, wt)).toEqual({ ok: true });
    expect(readFileSync(link(), "utf8")).toBe(original);
  });

  it.each([
    [
      "a file pointing at the repository's Git directory",
      () => writeFileSync(link(), `gitdir: ${path.join(repo, ".git")}\n`),
      "file",
    ],
    ["unreadable content", () => writeFileSync(link(), "nonsense"), "file"],
    ["nothing", () => rmSync(link()), "missing"],
    [
      "a directory (the agent's own repository)",
      () => {
        rmSync(link());
        mkdirSync(path.join(link(), "refs", "heads"), { recursive: true });
        writeFileSync(path.join(link(), "HEAD"), "ref: refs/heads/main\n");
      },
      "directory",
    ],
  ] as const)("%s is found and restored", async (_what, plant, found) => {
    plant();
    expect(await inspectWorktreeGitLink(repo, wt)).toMatchObject({ ok: false, found });
    expect(await ensureWorktreeGitLink(repo, wt)).toMatchObject({ ok: false, found });
    expectRestored();
    expect(await inspectWorktreeGitLink(repo, wt)).toEqual({ ok: true });
  });

  it("a symlink is replaced without following it: its target is left alone", async () => {
    const target = path.join(root, "outside.txt");
    writeFileSync(target, `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
    rmSync(link());
    symlinkSync(target, link());
    expect(await ensureWorktreeGitLink(repo, wt)).toMatchObject({ ok: false, found: "symlink" });
    expectRestored();
    expect(existsSync(target)).toBe(true);
  });

  it("another worktree's link is not this worktree's", async () => {
    const other = path.join(root, "other");
    g(repo, "worktree", "add", "-q", "-b", "other", other);
    writeFileSync(link(), readFileSync(path.join(other, ".git"), "utf8"));
    expect(await ensureWorktreeGitLink(repo, wt)).toMatchObject({ ok: false, found: "file" });
    expectRestored();
  });

  it("a worktree that is gone is left gone; one the repository does not list fails closed", async () => {
    rmSync(wt, { recursive: true, force: true });
    expect(await ensureWorktreeGitLink(repo, wt)).toEqual({ ok: "no_worktree" });
    expect(existsSync(wt)).toBe(false);
    const stray = path.join(root, "stray");
    mkdirSync(stray);
    await expect(ensureWorktreeGitLink(repo, stray)).rejects.toThrow(/lists no worktree/);
  });
});
