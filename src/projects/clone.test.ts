/**
 * ADR-0068: the `clone_url` parser, the allowlist and the clone/reuse rules. Git runs for real against a local bare
 * repository; the test runner rewrites the HTTPS URL to that repository and answers `fetch` itself, so nothing leaves
 * the host and no credential is involved.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectSourcesSettings } from "../config/index.js";
import {
  CloneError,
  checkCloneUrl,
  cloneTarget,
  defaultGitRunner,
  ensureClone,
  type GitRunner,
  normalizedUrl,
  parseRepositoryUrl,
  sourceKey,
} from "./clone.js";

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

/** A runner that maps HTTPS URLs to local repositories, answers `fetch` itself and records every argv. */
function localRunner(remotes: Map<string, string>, calls: string[][]): GitRunner {
  return async (args, opts) => {
    calls.push([...args]);
    if (args.includes("fetch")) return { ok: true, stdout: "" };
    const a = [...args];
    const at = a.indexOf("clone");
    let url: string | undefined;
    if (at >= 0) {
      const u = a.indexOf("--") + 1;
      url = a[u] as string;
      const local = remotes.get(url);
      if (local === undefined) return { ok: false, stdout: "" };
      a[u] = local;
    }
    try {
      const stdout = execFileSync("git", a, {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        env: GIT_ENV,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (url !== undefined) g(a[a.length - 1] as string, "remote", "set-url", "origin", url);
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: "" };
    }
  };
}

let tmp: string;
let settings: ProjectSourcesSettings;
let bare: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-clone-")));
  const cloneRoot = path.join(tmp, "clones");
  mkdirSync(cloneRoot);
  settings = { cloneRoot, allowedHosts: ["github.com"], allowedOwners: ["digifender-llc", "zemdregon"] };
  const work = path.join(tmp, "work");
  mkdirSync(work);
  g(work, "init", "-q", "-b", "main");
  writeFileSync(path.join(work, "README.md"), "hello\n");
  g(work, "add", ".");
  g(work, "commit", "-qm", "init");
  bare = path.join(tmp, "remote.git");
  g(tmp, "clone", "-q", "--bare", work, bare);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("parseRepositoryUrl (ADR-0068)", () => {
  it("accepts https://<host>/<owner>/<repo> with optional .git and trailing slash", () => {
    for (const u of [
      "https://github.com/Digifender-LLC/whumpo-website",
      "https://github.com/Digifender-LLC/whumpo-website.git",
      "https://github.com/Digifender-LLC/whumpo-website/",
      "https://github.com/Digifender-LLC/whumpo-website.git/",
      "https://GitHub.COM/Digifender-LLC/whumpo-website",
    ]) {
      expect(parseRepositoryUrl(u), u).toEqual({ host: "github.com", owner: "Digifender-LLC", repo: "whumpo-website" });
    }
    expect(parseRepositoryUrl("https://github.com/a.b_c-d/r.e_p-o")).toEqual({
      host: "github.com",
      owner: "a.b_c-d",
      repo: "r.e_p-o",
    });
  });

  it("refuses credentials, ports, queries, fragments, other schemes, traversal and odd characters", () => {
    for (const u of [
      "http://github.com/a/b",
      "ssh://git@github.com/a/b.git",
      "git@github.com:a/b.git",
      "git://github.com/a/b",
      "file:///srv/a/b",
      "HTTPS://github.com/a/b",
      "https://user@github.com/a/b",
      "https://user:token@github.com/a/b",
      "https://github.com:443/a/b",
      "https://github.com/a/b?ref=x",
      "https://github.com/a/b#frag",
      "https://github.com/a/b/c",
      "https://github.com/a",
      "https://github.com//b",
      "https://github.com/../b",
      "https://github.com/a/..",
      "https://github.com/./b",
      "https://github.com/a/.git",
      "https://github.com/a/%2e%2e",
      "https://github.com/a b/c",
      "https://github.com/a\\b/c",
      "https://github.com/ä/b",
      "https://github.com/-a/b",
      "https://github.com/a/b//",
      "https://localhost/a/b",
      `https://github.com/a/${"x".repeat(600)}`,
      "",
      42,
    ]) {
      expect(parseRepositoryUrl(u), String(u)).toBeUndefined();
    }
  });

  it("normalises without .git and keys case-insensitively", () => {
    const src = parseRepositoryUrl("https://github.com/Digifender-LLC/Whumpo-Website.git/");
    expect(src && normalizedUrl(src)).toBe("https://github.com/Digifender-LLC/Whumpo-Website");
    expect(src && sourceKey(src)).toBe("github.com/digifender-llc/whumpo-website");
  });
});

describe("checkCloneUrl and cloneTarget (ADR-0068)", () => {
  it("fails closed without project_sources and enforces host and owner (owner case-insensitive)", () => {
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as CloneError;
      }
      throw new Error("expected a refusal");
    };
    expect(err(() => checkCloneUrl("https://github.com/zemdregon/x", undefined))).toMatchObject({
      reason: "CLONE_NOT_CONFIGURED",
      code: "PERMISSION_BLOCKED",
    });
    expect(err(() => checkCloneUrl("ssh://github.com/zemdregon/x", settings))).toMatchObject({
      reason: "CLONE_URL_INVALID",
      code: "INVALID_REQUEST",
    });
    expect(err(() => checkCloneUrl("https://gitlab.com/zemdregon/x", settings))).toMatchObject({
      reason: "CLONE_SOURCE_NOT_ALLOWED",
      code: "PERMISSION_BLOCKED",
    });
    expect(err(() => checkCloneUrl("https://github.com/someone/x", settings))).toMatchObject({
      reason: "CLONE_SOURCE_NOT_ALLOWED",
    });
    const src = checkCloneUrl("https://github.com/Digifender-LLC/Whumpo-Website.git", settings);
    expect(cloneTarget(src, settings)).toBe(
      path.join(settings.cloneRoot, "github.com", "digifender-llc", "whumpo-website"),
    );
  });
});

describe("ensureClone (ADR-0068)", () => {
  const URL_ = "https://github.com/zemdregon/fixture.git";
  const src = () => checkCloneUrl("https://github.com/Zemdregon/Fixture", settings);

  it("clones into place with fixed, shell-free argv and leaves no temporary directory", async () => {
    const calls: string[][] = [];
    const r = await ensureClone(src(), {
      settings,
      git: localRunner(new Map([[URL_.replace("zemdregon/fixture", "Zemdregon/Fixture"), bare]]), calls),
    });
    const target = path.join(settings.cloneRoot, "github.com", "zemdregon", "fixture");
    expect(r).toEqual({ path: target, outcome: "cloned" });
    expect(existsSync(path.join(target, "README.md"))).toBe(true);
    expect(readdirSync(path.dirname(target))).toEqual(["fixture"]);
    const clone = calls.find((c) => c.includes("clone")) as string[];
    expect(clone.slice(0, 7)).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--no-recurse-submodules",
      "--",
    ]);
    expect(clone[7]).toBe("https://github.com/Zemdregon/Fixture.git");
  });

  it("reuses an earlier clone of the same repository (case-insensitive) and fetches it", async () => {
    const remotes = new Map([
      ["https://github.com/Zemdregon/Fixture.git", bare],
      ["https://github.com/zemdregon/fixture.git", bare],
    ]);
    const calls: string[][] = [];
    await ensureClone(src(), { settings, git: localRunner(remotes, calls) });
    const again = await ensureClone(checkCloneUrl("https://github.com/zemdregon/fixture", settings), {
      settings,
      git: localRunner(remotes, calls),
    });
    expect(again.outcome).toBe("reused");
    expect(calls.filter((c) => c.includes("clone"))).toHaveLength(1);
    expect(calls.some((c) => c.includes("fetch"))).toBe(true);
  });

  it("a failed clone is CLONE_FAILED with the fixed text, and leaves neither target nor temporary directory", async () => {
    const calls: string[][] = [];
    const err = await ensureClone(src(), { settings, git: localRunner(new Map(), calls) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneError);
    expect(err).toMatchObject({ reason: "CLONE_FAILED", code: "TOOL_FAILURE" });
    expect((err as Error).message).toBe(
      "repository could not be cloned with the server's git credentials; the operator may need to grant access",
    );
    const parent = path.join(settings.cloneRoot, "github.com", "zemdregon");
    expect(readdirSync(parent)).toEqual([]);
  });

  it("never touches an existing target that is not a clone of this repository", async () => {
    const target = path.join(settings.cloneRoot, "github.com", "zemdregon", "fixture");
    const remotes = new Map([["https://github.com/Zemdregon/Fixture.git", bare]]);
    const conflict = async () =>
      ensureClone(src(), { settings, git: localRunner(remotes, []) }).catch((e: unknown) => e as CloneError);

    // a plain directory with a file
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "keep.txt"), "mine\n");
    expect(await conflict()).toMatchObject({ reason: "CLONE_TARGET_CONFLICT", code: "PERMISSION_BLOCKED" });
    expect(readdirSync(target)).toEqual(["keep.txt"]);

    // a repository whose origin is another repository
    rmSync(target, { recursive: true });
    g(tmp, "clone", "-q", bare, target);
    g(target, "remote", "set-url", "origin", "https://github.com/zemdregon/other.git");
    expect(await conflict()).toMatchObject({ reason: "CLONE_TARGET_CONFLICT" });
    expect(g(target, "remote", "get-url", "origin")).toBe("https://github.com/zemdregon/other.git");

    // a repository without origin
    g(target, "remote", "remove", "origin");
    expect(await conflict()).toMatchObject({ reason: "CLONE_TARGET_CONFLICT" });

    // a symbolic link, even to a matching clone
    rmSync(target, { recursive: true });
    const elsewhere = path.join(tmp, "elsewhere");
    g(tmp, "clone", "-q", bare, elsewhere);
    g(elsewhere, "remote", "set-url", "origin", "https://github.com/zemdregon/fixture.git");
    symlinkSync(elsewhere, target);
    expect(await conflict()).toMatchObject({ reason: "CLONE_TARGET_CONFLICT" });
    expect(existsSync(path.join(elsewhere, "README.md"))).toBe(true);
  });

  it("refuses a directory inside another repository (its origin would be the parent's)", async () => {
    const parent = path.join(settings.cloneRoot, "github.com", "zemdregon");
    mkdirSync(path.dirname(parent), { recursive: true });
    g(tmp, "clone", "-q", bare, parent);
    g(parent, "remote", "set-url", "origin", "https://github.com/zemdregon/fixture.git");
    mkdirSync(path.join(parent, "fixture"));
    const err = await ensureClone(src(), { settings, git: localRunner(new Map(), []) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "CLONE_TARGET_CONFLICT" });
  });

  it("the default runner runs git without a shell and reports failure without output", async () => {
    expect((await defaultGitRunner(["--version"], { timeoutMs: 10_000 })).ok).toBe(true);
    const bad = await defaultGitRunner(["rev-parse", "--show-toplevel"], { cwd: tmp, timeoutMs: 10_000 });
    expect(bad.ok).toBe(false);
    const quoted = await defaultGitRunner(["--version; echo injected"], { timeoutMs: 10_000 });
    expect(quoted.ok).toBe(false);
    expect(quoted.stdout).not.toMatch(/injected/);
  });
});
