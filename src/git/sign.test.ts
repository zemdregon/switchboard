/**
 * T9.10 (FR-GIT-10, FRD BR-33, LLD §12.3.1): the controller-side signing step. Only a THROWAWAY unprotected GnuPG key
 * in a temporary `GNUPGHOME` is used (`fixtures/throwaway-gpg.ts`); the signing tests skip when `gpg` is missing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createThrowawaySigner, gpgAvailable, type ThrowawaySigner } from "./fixtures/throwaway-gpg.js";
import {
  hasSignature,
  repoSigningConfigUnsafe,
  SIGNING_AGENT_VARIABLES,
  SIGNING_ENV_ALLOWLIST,
  signedCommitTree,
  signingEnv,
  testSignature,
} from "./sign.js";

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

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Ada Maintainer",
  GIT_AUTHOR_EMAIL: "ada@example.test",
  GIT_AUTHOR_DATE: "1791885600 +0000",
  GIT_COMMITTER_NAME: "Ada Maintainer",
  GIT_COMMITTER_EMAIL: "ada@example.test",
  GIT_COMMITTER_DATE: "1791885600 +0000",
};

let root: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-sign-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("signing environment (allowlist, fail closed)", () => {
  it("copies only the allowlisted variables and fixes prompts and locale", () => {
    const env = signingEnv({
      PATH: "/bin",
      HOME: "/h",
      GNUPGHOME: "/g",
      SSH_AUTH_SOCK: "/s",
      GPG_AGENT_INFO: "/a",
      XDG_RUNTIME_DIR: "/r",
      GIT_CONFIG_PARAMETERS: "'gpg.program'='/evil'",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_SSH_COMMAND: "evil",
      DISPLAY: ":0",
      SWITCHBOARD_TOOL_TOKEN: "sbt1_x",
      EMPTY: "",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      GNUPGHOME: "/g",
      SSH_AUTH_SOCK: "/s",
      GPG_AGENT_INFO: "/a",
      XDG_RUNTIME_DIR: "/r",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    });
    for (const key of Object.keys(env)) {
      expect([...SIGNING_ENV_ALLOWLIST, "GIT_TERMINAL_PROMPT", "LC_ALL"]).toContain(key);
    }
    // The agent and key variables are part of the allowlist (controller side only) and named for the provider check.
    for (const v of ["GNUPGHOME", "SSH_AUTH_SOCK", "GPG_AGENT_INFO"]) expect(SIGNING_AGENT_VARIABLES).toContain(v);
  });
});

describe("repository-local signing configuration is refused (REPO_CONFIG_UNSAFE precedent)", () => {
  it("flags gpg.* and user.signingkey at local scope, through an include and in config.worktree", async () => {
    expect(await repoSigningConfigUnsafe(repo)).toBe(false);
    g(repo, "config", "gpg.program", "/bin/false");
    expect(await repoSigningConfigUnsafe(repo)).toBe(true);
    g(repo, "config", "--unset", "gpg.program");
    g(repo, "config", "user.signingkey", "ABCDEF");
    expect(await repoSigningConfigUnsafe(repo)).toBe(true);
    g(repo, "config", "--unset", "user.signingkey");
    writeFileSync(path.join(root, "inc.cfg"), '[gpg "ssh"]\n\tprogram = /bin/false\n');
    g(repo, "config", "include.path", path.join(root, "inc.cfg"));
    expect(await repoSigningConfigUnsafe(repo)).toBe(true);
    g(repo, "config", "--unset", "include.path");
    g(repo, "config", "extensions.worktreeConfig", "true");
    g(repo, "config", "--worktree", "gpg.format", "ssh");
    expect(await repoSigningConfigUnsafe(repo)).toBe(true);
    g(repo, "config", "--worktree", "--unset", "gpg.format");
    expect(await repoSigningConfigUnsafe(repo)).toBe(false);
  });
});

describe.skipIf(!gpgAvailable())("signed commit-tree with a throwaway GnuPG key", () => {
  let signer: ThrowawaySigner;
  beforeEach(() => {
    signer = createThrowawaySigner();
  });
  afterEach(() => signer.dispose());

  it("produces a commit whose signature verifies, with exactly the given identity and message", async () => {
    const tree = g(repo, "rev-parse", "HEAD^{tree}");
    const parent = g(repo, "rev-parse", "HEAD");
    const r = await signedCommitTree({
      cwd: repo,
      tree,
      parent,
      message: "Signed change\n",
      identityEnv: IDENTITY_ENV,
      sourceEnv: signer.env,
      timeoutMs: 30_000,
    });
    if (!r.ok) throw new Error(`signing failed: ${r.reason}`);
    expect(await hasSignature(repo, r.sha)).toBe(true);
    execFileSync("git", ["verify-commit", r.sha], { cwd: repo, env: signer.verifyEnv, stdio: "ignore" });
    const raw = g(repo, "cat-file", "commit", r.sha);
    expect(raw).toContain("author Ada Maintainer <ada@example.test> 1791885600 +0000");
    // The message is exactly the input: nothing about the run is added, no trailer.
    expect(g(repo, "log", "-1", "--format=%B", r.sha)).toBe("Signed change");
    // The signature names only the operator's key (here the throwaway one).
    const shown = execFileSync("git", ["log", "-1", "--format=%G?|%GF|%GS", r.sha], {
      cwd: repo,
      env: signer.verifyEnv,
      encoding: "utf8",
    }).trim();
    expect(shown).toBe(`G|${signer.fingerprint}|Throwaway Test Key <throwaway@example.test>`);
  });

  it("a failing signing program yields no commit (no unsigned fallback)", async () => {
    writeFileSync(
      path.join(signer.home, ".gitconfig"),
      `[user]\n\tsigningkey = ${signer.fingerprint}\n[gpg]\n\tprogram = /nonexistent/gpg\n`,
    );
    const before = g(repo, "count-objects", "-v");
    const r = await signedCommitTree({
      cwd: repo,
      tree: g(repo, "rev-parse", "HEAD^{tree}"),
      parent: g(repo, "rev-parse", "HEAD"),
      message: "x\n",
      identityEnv: IDENTITY_ENV,
      sourceEnv: signer.env,
      timeoutMs: 30_000,
    });
    expect(r).toEqual({ ok: false, reason: "sign_failed" });
    expect(g(repo, "count-objects", "-v")).toBe(before);
  });

  it("an unknown key fails, and a signing program that hangs is killed by the timeout", async () => {
    writeFileSync(
      path.join(signer.home, ".gitconfig"),
      "[user]\n\tsigningkey = 0000000000000000000000000000000000000000\n",
    );
    const args = {
      cwd: repo,
      tree: g(repo, "rev-parse", "HEAD^{tree}"),
      parent: g(repo, "rev-parse", "HEAD"),
      message: "x\n",
      identityEnv: IDENTITY_ENV,
      sourceEnv: signer.env,
    };
    expect(await signedCommitTree({ ...args, timeoutMs: 30_000 })).toEqual({ ok: false, reason: "sign_failed" });
    const hang = path.join(root, "hang.sh");
    writeFileSync(hang, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    writeFileSync(path.join(signer.home, ".gitconfig"), `[gpg]\n\tprogram = ${hang}\n`);
    const t0 = Date.now();
    expect(await signedCommitTree({ ...args, timeoutMs: 500 })).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("projects validate's test signature succeeds with the operator's setup and fails without a key", async () => {
    const scratch = path.join(root, "scratch");
    expect(await testSignature({ sourceEnv: signer.env, scratchDir: scratch, timeoutMs: 30_000 })).toEqual({
      ok: true,
    });
    writeFileSync(
      path.join(signer.home, ".gitconfig"),
      "[user]\n\tsigningkey = 0000000000000000000000000000000000000000\n",
    );
    expect(await testSignature({ sourceEnv: signer.env, scratchDir: scratch, timeoutMs: 30_000 })).toEqual({
      ok: false,
      reason: "sign_failed",
    });
    // The scratch repository is removed after each attempt.
    expect(existsSync(scratch) ? execFileSync("ls", [scratch], { encoding: "utf8" }).trim() : "").toBe("");
  });
});
