import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDenylisted } from "./denylist.js";
import { type ScanOptions, scanContext } from "./scan.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });

const OPTS: ScanOptions = {
  maxFileBytes: 10_000,
  maxFiles: 1000,
  maxChunks: 10_000,
  maxTotalBytes: 10_000_000,
  exclude: [],
  homeDir: "/nonexistent-home",
};

let tmp: string;
let root: string;
let outside: string;

const put = (rel: string, content: string | Buffer, base = root) => {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};
const marker = (name: string) => `MARKER_${name}_9f3a`;
const allText = (r: { chunks: { text: string }[] }) => r.chunks.map((c) => c.text).join("\n---\n");
const reasonOf = (r: { skipped: { path: string; reason: string }[] }, p: string) =>
  r.skipped.find((s) => s.path === p)?.reason;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-retr-")));
  root = path.join(tmp, "repo");
  outside = path.join(tmp, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function plant(): void {
  put("src/ok.ts", `export const ok = "${marker("ok")}";\n`);
  put("nested/.git/HEAD", "ref: refs/heads/main\n");
  put("nested/code.ts", marker("nested"));
  put("pointer/.git", "gitdir: ../elsewhere\n");
  put("pointer/code.ts", marker("pointer"));
  put("secret-target.txt", marker("escape-file"), outside);
  put("deep/outside.txt", marker("escape-dir"), outside);
  symlinkSync(path.join(outside, "secret-target.txt"), path.join(root, "link-file.txt"));
  symlinkSync(outside, path.join(root, "link-dir"));
  put("data.bin", Buffer.concat([Buffer.from(marker("binary")), Buffer.from([0, 1, 2])]));
  put("big.txt", `${marker("big")}${"x".repeat(OPTS.maxFileBytes)}`);
  put("vendor/lib/a.js", marker("vendor"));
  for (const n of [
    ".env",
    ".env.local",
    "server.key",
    "cert.pem",
    "id_rsa",
    "aws-credentials.txt",
    "my_secret.json",
    ".netrc",
    ".npmrc",
  ]) {
    put(`conf/${n}`, marker(`deny-${n}`));
  }
}

function assertNeverRead(r: Awaited<ReturnType<typeof scanContext>>): void {
  const text = allText(r);
  expect(text).toContain(marker("ok"));
  for (const m of [
    "nested",
    "pointer",
    "escape-file",
    "escape-dir",
    "binary",
    "big",
    "vendor",
    "ignored",
    "deny-.env",
    "deny-.env.local",
    "deny-server.key",
    "deny-cert.pem",
    "deny-id_rsa",
    "deny-aws-credentials.txt",
    "deny-my_secret.json",
    "deny-.netrc",
    "deny-.npmrc",
  ]) {
    expect(text, m).not.toContain(marker(m));
  }
}

describe("scanContext in a Git context", () => {
  it("never reads excluded, escaping, binary, oversized, ignored or denylisted files", async () => {
    plant();
    put(".gitignore", "ignored.txt\n");
    put("ignored.txt", marker("ignored"));
    sh(root, "init", "-q");
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", "x");
    put("untracked.txt", "untracked content\n");
    const r = await scanContext(root, { ...OPTS, exclude: ["vendor/**"] });
    assertNeverRead(r);
    expect(r.complete).toBe(true);
    expect(r.files.map((f) => f.path)).toContain("untracked.txt");
    expect(r.files.map((f) => f.path)).not.toContain("ignored.txt");
    expect(reasonOf(r, "nested")).toBe("nested_repository");
    expect(reasonOf(r, "pointer")).toBe("nested_repository");
    expect(reasonOf(r, "link-file.txt")).toBe("symlink_escape");
    expect(reasonOf(r, "link-dir")).toBe("symlink_escape");
    expect(reasonOf(r, "data.bin")).toBe("binary");
    expect(reasonOf(r, "big.txt")).toBe("oversized");
    expect(reasonOf(r, "vendor/lib/a.js")).toBe("excluded");
    for (const n of [
      ".env",
      ".env.local",
      "server.key",
      "cert.pem",
      "id_rsa",
      "aws-credentials.txt",
      "my_secret.json",
      ".netrc",
      ".npmrc",
    ]) {
      expect(reasonOf(r, `conf/${n}`), n).toBe("denylisted");
    }
    expect(r.skipped.map((s) => s.path)).toEqual([...r.skipped.map((s) => s.path)].sort());
  });

  it("follows a symlink to a file inside the root but never a symlinked directory", async () => {
    put("real/inner.txt", "inner content\n");
    symlinkSync(path.join(root, "real", "inner.txt"), path.join(root, "alias.txt"));
    symlinkSync(path.join(root, "real"), path.join(root, "dirlink"));
    sh(root, "init", "-q");
    sh(root, "add", "-A");
    const r = await scanContext(root, OPTS);
    expect(r.files.map((f) => f.path)).toEqual(["alias.txt", "real/inner.txt"]);
    expect(reasonOf(r, "dirlink")).toBe("special_file");
  });

  it("never reads through a tracked directory that was replaced by a symlink", async () => {
    put("docs/readme.md", "tracked\n");
    put("inside/readme.md", marker("inside-dir"));
    sh(root, "init", "-q");
    sh(root, "add", "-A");
    sh(root, "commit", "-q", "-m", "x");
    put("readme.md", marker("escape-parent"), outside);
    rmSync(path.join(root, "docs"), { recursive: true });
    symlinkSync(outside, path.join(root, "docs"));
    const moved = await scanContext(root, OPTS);
    expect(allText(moved)).not.toContain(marker("escape-parent"));
    expect(reasonOf(moved, "docs/readme.md")).toBe("symlink_escape");
    unlinkSync(path.join(root, "docs"));
    symlinkSync(path.join(root, "inside"), path.join(root, "docs"));
    const inner = await scanContext(root, OPTS);
    expect(reasonOf(inner, "docs/readme.md")).toBe("special_file");
    expect(inner.files.map((f) => f.path)).toContain("inside/readme.md");
  });

  it("does not run a repository-configured filter or hook", async () => {
    put("a.txt", "hello\n");
    sh(root, "init", "-q");
    put(".gitattributes", "*.txt filter=evil\n");
    sh(root, "config", "filter.evil.clean", `touch ${path.join(tmp, "PWNED")}; cat`);
    const r = await scanContext(root, OPTS);
    expect(r.files.map((f) => f.path)).toContain("a.txt");
    expect(() => execFileSync("test", ["-e", path.join(tmp, "PWNED")])).toThrow();
  });
});

describe("scanContext in a non-Git context", () => {
  it("walks the directory, applies exclude globs and still skips nested repositories", async () => {
    plant();
    const r = await scanContext(root, { ...OPTS, exclude: ["vendor/**"] });
    expect(allText(r)).toContain(marker("ok"));
    for (const m of [
      "nested",
      "pointer",
      "escape-file",
      "escape-dir",
      "binary",
      "big",
      "vendor",
      "deny-.env",
      "deny-id_rsa",
    ]) {
      expect(allText(r), m).not.toContain(marker(m));
    }
    expect(reasonOf(r, "nested")).toBe("nested_repository");
    expect(reasonOf(r, "pointer")).toBe("nested_repository");
    expect(reasonOf(r, "link-file.txt")).toBe("symlink_escape");
    expect(reasonOf(r, "link-dir")).toBe("symlink_escape");
    expect(reasonOf(r, "vendor/lib/a.js")).toBe("excluded");
    expect(reasonOf(r, "conf/.env")).toBe("denylisted");
  });
});

describe("redaction before chunking", () => {
  it("never lets a canary secret into a chunk and keeps line numbers", async () => {
    const ghp = `ghp_${"Z".repeat(36)}`;
    const apiKey = `api_${"key"} = "${"Q".repeat(24)}"`;
    const pem = [
      `-----BEGIN ${"RSA PRIVATE"} KEY-----`,
      "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo",
      "MDEyMzQ1Njc4OWFiY2RlZg",
      `-----END ${"RSA PRIVATE"} KEY-----`,
    ].join("\n");
    put("src/cfg.ts", ["// first", `const t = "${ghp}";`, apiKey, pem, "const last = 1;", ""].join("\n"));
    const r = await scanContext(root, OPTS);
    const text = allText(r);
    expect(text).not.toContain(ghp);
    expect(text).not.toContain("Q".repeat(24));
    expect(text).not.toContain("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("const last = 1;");
    const c = r.chunks[0];
    expect(c?.startLine).toBe(1);
    expect(c?.endLine).toBe(8); // 1 comment + 1 token + 1 key + 4 PEM lines + 1 last line
    const lines = (c?.text ?? "").split("\n");
    expect(lines[7]).toBe("const last = 1;");
    expect(r.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.files[0]?.mtimeNs).toBeTypeOf("bigint");
  });
});

describe("caps", () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) put(`f${i}.txt`, `file number ${i}\n`);
  });
  it("max_files", async () => {
    const r = await scanContext(root, { ...OPTS, maxFiles: 3 });
    expect(r).toMatchObject({ complete: false, incompleteReason: "max_files" });
    expect(r.files).toHaveLength(3);
  });
  it("max_chunks", async () => {
    const r = await scanContext(root, { ...OPTS, maxChunks: 2 });
    expect(r).toMatchObject({ complete: false, incompleteReason: "max_chunks" });
    expect(r.chunks).toHaveLength(2);
    expect(r.files).toHaveLength(2);
  });
  it("max_total_bytes", async () => {
    const r = await scanContext(root, { ...OPTS, maxTotalBytes: 35 });
    expect(r).toMatchObject({ complete: false, incompleteReason: "max_total_bytes" });
    expect(r.files).toHaveLength(2);
  });
  it("complete when nothing is hit", async () => {
    const r = await scanContext(root, OPTS);
    expect(r.complete).toBe(true);
    expect(r.incompleteReason).toBeUndefined();
    expect(r.files).toHaveLength(5);
  });
});

describe("isDenylisted", () => {
  it("matches the built-in names and not ordinary files", () => {
    for (const n of [
      ".env",
      ".env.prod",
      "a.PEM",
      "x.p12",
      "k.pfx",
      "id_ed25519.pub",
      "id_ecdsa",
      "id_dsa",
      "App.JKS",
      "x.keystore",
      "_netrc",
      ".pypirc",
      ".git-credentials",
      ".htpasswd",
      "MyToken.ts",
      "Password.md",
      "oauth.ts",
    ]) {
      expect(isDenylisted(`dir/${n}`), n).toBe(true);
    }
    for (const n of ["index.ts", "README.md", "environment.ts", "keys.txt"]) expect(isDenylisted(n), n).toBe(false);
  });
});
