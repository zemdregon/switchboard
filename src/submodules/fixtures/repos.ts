/**
 * Test fixtures for the submodule library: local "remote" repositories, an umbrella commit built with plumbing (no
 * `git submodule`), and a network runner that maps the store's https URLs to those local repositories with
 * command-scope `url.<local>.insteadOf` and `protocol.file.allow=always`. Nothing leaves the host; the production argv
 * (https only) is unchanged, and each store's `origin` stays its https URL.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectSourcesSettings } from "../../config/index.js";
import type { GitRunner } from "../../projects/clone.js";

export const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};

/** Plain Git as an operator shell would run it (fixture setup and positive controls only). */
export function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

export function gIn(cwd: string, input: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", input }).trim();
}

export const HOST = "github.test";
export const OWNER = "Acme";

export interface Fixture {
  readonly root: string;
  readonly settings: ProjectSourcesSettings;
  /** https URL (with `.git`) → local repository. */
  readonly remotes: Map<string, string>;
  /** Every argv the network runner saw. */
  readonly calls: string[][];
  readonly runner: GitRunner;
}

export function makeFixture(prefix = "sb-sub-"): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const cloneRoot = path.join(root, "clones");
  mkdirSync(cloneRoot);
  const remotes = new Map<string, string>();
  const calls: string[][] = [];
  return {
    root,
    settings: { cloneRoot, allowedHosts: [HOST], allowedOwners: [OWNER.toLowerCase()] },
    remotes,
    calls,
    runner: localRunner(remotes, calls),
  };
}

/** A runner that records argv and maps every registered https URL to its local repository. */
export function localRunner(remotes: Map<string, string>, calls: string[][]): GitRunner {
  return async (args, opts) => {
    calls.push([...args]);
    const map: string[] = ["-c", "protocol.file.allow=always"];
    for (const [https, local] of remotes) map.push("-c", `url.file://${local}.insteadOf=${https}`);
    try {
      const stdout = execFileSync("git", [...map, ...args], {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        env: GIT_ENV,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: opts.timeoutMs,
      });
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: "" };
    }
  };
}

/** A local "remote" repository `<owner>/<repo>` with one commit of `files`, registered with the runner. */
export function makeRemote(
  fx: Fixture,
  repo: string,
  files: Readonly<Record<string, string>> = { "README.md": `${repo}\n` },
  opts: { branch?: string; owner?: string } = {},
): { dir: string; url: string; head: string } {
  const owner = opts.owner ?? OWNER;
  const dir = path.join(fx.root, "remotes", owner, repo);
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", opts.branch ?? "main");
  g(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  const head = commitFiles(dir, files, "initial");
  const url = `https://${HOST}/${owner}/${repo}.git`;
  fx.remotes.set(url, dir);
  return { dir, url, head };
}

export function commitFiles(dir: string, files: Readonly<Record<string, string>>, message: string): string {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), content);
  }
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "--allow-empty", "-m", message);
  return g(dir, "rev-parse", "HEAD");
}

/**
 * An umbrella repository whose HEAD commit has `gitlinks` (path → sha, mode 160000, written with `update-index`) and,
 * unless `gitmodules` is undefined, that `.gitmodules` text. Returns the repository and its HEAD.
 */
export function makeUmbrella(
  fx: Fixture,
  gitlinks: Readonly<Record<string, string>>,
  gitmodules: string | undefined,
  name = "umbrella",
): { dir: string; head: string } {
  const dir = path.join(fx.root, name);
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "umbrella\n");
  if (gitmodules !== undefined) writeFileSync(path.join(dir, ".gitmodules"), gitmodules);
  g(dir, "add", "-A");
  const info = Object.entries(gitlinks)
    .map(([p, sha]) => `160000 ${sha}\t${p}\n`)
    .join("");
  if (info !== "") gIn(dir, info, "update-index", "--add", "--index-info");
  g(dir, "commit", "-q", "-m", "umbrella");
  return { dir, head: g(dir, "rev-parse", "HEAD") };
}

/** `.gitmodules` text for `[name, path, url]` triples. */
export function gitmodulesText(entries: readonly (readonly [string, string, string])[]): string {
  return entries.map(([name, p, url]) => `[submodule "${name}"]\n\tpath = ${p}\n\turl = ${url}\n`).join("");
}
