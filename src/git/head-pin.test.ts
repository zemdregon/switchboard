/**
 * T8.10 (FR-EXE-10, LLD §20.6): `readHeadPin` computes the worktree's tree with a temporary index and keeps the commit
 * only when the trees match. Real Git in temporary directories; the run's index, `HEAD` and refs must be untouched.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHeadPin } from "./head-pin.js";

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

const PUBLISH = "refs/heads/switchboard/pub/sess_TEST";

let root: string;
let repo: string;
let base: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-headpin-")));
  repo = path.join(root, "repo");
  g(root, "init", "-q", "-b", "main", repo);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  base = g(repo, "rev-parse", "HEAD");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Everything a pin must leave alone: the run's index bytes, `HEAD`, every ref and the status. */
function state() {
  const index = createHash("sha256")
    .update(readFileSync(path.join(repo, ".git", "index")))
    .digest("hex");
  return {
    index,
    head: g(repo, "rev-parse", "HEAD"),
    refs: g(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    status: g(repo, "status", "--porcelain"),
  };
}

describe("readHeadPin (T8.10, LLD §20.6)", () => {
  it("a clean worktree pins HEAD and its tree", async () => {
    const before = state();
    const pin = await readHeadPin(repo, PUBLISH, root);
    expect(pin).toEqual({ headSha: base, treeSha: g(repo, "rev-parse", "HEAD^{tree}") });
    expect(state()).toEqual(before);
  });

  it("a dirty worktree (modified, staged or untracked) records the tree but no SHA, touching nothing", async () => {
    for (const dirty of [
      () => writeFileSync(path.join(repo, "a.txt"), "changed\n"),
      () => {
        writeFileSync(path.join(repo, "b.txt"), "staged\n");
        g(repo, "add", "b.txt");
      },
      () => writeFileSync(path.join(repo, "c.txt"), "untracked\n"),
    ]) {
      g(repo, "reset", "-q", "--hard", base);
      g(repo, "clean", "-qfd");
      dirty();
      const before = state();
      const pin = await readHeadPin(repo, PUBLISH, root);
      expect(pin.headSha).toBeNull();
      expect(pin.treeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.treeSha).not.toBe(g(repo, "rev-parse", "HEAD^{tree}"));
      expect(state()).toEqual(before);
    }
  });

  it("ignored files do not make a worktree dirty", async () => {
    writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "ignore");
    writeFileSync(path.join(repo, "out.log"), "noise\n");
    expect((await readHeadPin(repo, PUBLISH, root)).headSha).toBe(g(repo, "rev-parse", "HEAD"));
  });

  it("with a publish ref, the published commit is pinned when the worktree matches it (LLD §12.3 commits)", async () => {
    // The commit tool's shape: the publish ref moves, the worktree's HEAD stays at the base.
    writeFileSync(path.join(repo, "a.txt"), "published\n");
    const tmpIndex = path.join(root, "idx");
    const env = { ...GIT_ENV, GIT_INDEX_FILE: tmpIndex };
    execFileSync("git", ["read-tree", base], { cwd: repo, env });
    execFileSync("git", ["add", "-A"], { cwd: repo, env });
    const tree = execFileSync("git", ["write-tree"], { cwd: repo, env, encoding: "utf8" }).trim();
    const published = execFileSync("git", ["commit-tree", tree, "-p", base, "-m", "pub"], {
      cwd: repo,
      env,
      encoding: "utf8",
    }).trim();
    g(repo, "update-ref", PUBLISH, published);

    const before = state();
    expect(await readHeadPin(repo, PUBLISH, root)).toEqual({ headSha: published, treeSha: tree });
    expect(state()).toEqual(before);

    // A later edit that is not published: no SHA, neither the publish head nor HEAD.
    writeFileSync(path.join(repo, "a.txt"), "unpublished\n");
    expect((await readHeadPin(repo, PUBLISH, root)).headSha).toBeNull();
  });

  it("fails closed: not a repository gives no SHA and no tree, and never throws", async () => {
    expect(await readHeadPin(path.join(root, "nowhere"), PUBLISH, root)).toEqual({ headSha: null, treeSha: null });
  });
});
