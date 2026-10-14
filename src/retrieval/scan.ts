import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SECRET_PATTERNS } from "../artifacts/redact.js";
import { redactInput } from "../inner/pipeline.js";
import { git } from "../workspace/git.js";
import { findNestedRepositories, nestedPathspecArgs } from "../workspace/nested.js";
import { type Chunk, chunkText } from "./chunk.js";
import { compileExcludes, isDenylisted } from "./denylist.js";

/**
 * Retrieval-index scanner (T12.2; FR-RAG-02, LLD §14.3, TDD §3.13.3, ADR-0031, ADR-0022).
 *
 * Walks one context root in stable (code point) order and returns redacted chunks. Nothing outside the root is read:
 * a symlink whose target leaves the root is skipped, symlinked directories are never descended, nested repositories
 * (`findNestedRepositories`, any `.git` entry) are skipped whole, special files are never opened, and every file is
 * opened by its resolved path with `O_NOFOLLOW`. Names on the secret denylist and operator `exclude` globs are skipped
 * BEFORE the file is opened. The denylist is best effort, not a guarantee (R-56); the content is also redacted before
 * chunking, so neither a chunk nor any returned field holds unredacted text.
 *
 * A Git context (a `.git` entry at the root) is enumerated with `git ls-files -z --cached --others --exclude-standard`
 * through the hardened `git` helper (scrubbed environment, no hooks, no fsmonitor, filter and diff drivers neutralised;
 * `ls-files` runs no filter). Ignored files are never listed, so `ignored` is not reported for them. A non-Git context
 * is walked directly and only the operator globs apply.
 *
 * Delegated choices: a symlink to a directory inside the root is reported as `special_file` (never followed); the
 * denylist and excludes are applied to both the link path and its resolved path; redaction keeps line numbers by
 * replacing a multi-line PEM private key block with one marker followed by the same number of newlines; carriage
 * returns are stripped by the shared control-character step, so CRLF files chunk like LF files; caps are applied per
 * file (a file whose chunks would cross a cap is not indexed at all, keeping the index consistent); a path with a
 * symlinked parent directory is skipped (`symlink_escape` when its real location leaves the root). Residual risk: a
 * directory swapped for a symlink between that check and the open is not detected (`O_NOFOLLOW` covers the last
 * component only); the agent-writable run worktree is never scanned (LLD §14.5), only the project's contexts.
 */

export type SkipReason =
  | "nested_repository"
  | "symlink_escape"
  | "special_file"
  | "binary"
  | "oversized"
  | "ignored"
  | "denylisted"
  | "excluded"
  | "unreadable";

export type IncompleteReason = "max_files" | "max_chunks" | "max_total_bytes";

export interface ScanOptions {
  maxFileBytes: number;
  maxFiles: number;
  maxChunks: number;
  /** Cap on the bytes of chunk text. */
  maxTotalBytes: number;
  /** Operator globs (`*`, `**`, `?`) on the root-relative POSIX path. */
  exclude: readonly string[];
  /** Home directory scrubbed from text by the redactor; defaults to the process home. */
  homeDir?: string;
}

export interface ScannedFile {
  path: string;
  /** sha256 hex of the raw content read. */
  sha256: string;
  bytes: number;
  mtimeNs: bigint;
}

export interface ScanResult {
  files: ScannedFile[];
  chunks: Chunk[];
  skipped: { path: string; reason: SkipReason }[];
  complete: boolean;
  incompleteReason?: IncompleteReason;
}

const BINARY_PROBE_BYTES = 8000;
const PEM_BLOCKS = DEFAULT_SECRET_PATTERNS.filter((re) => re.source.includes("PRIVATE KEY"));

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const toPosix = (p: string) => p.split(path.sep).join("/");

/** Redact `text`; a multi-line private key block collapses to one marker plus its newlines so line numbers hold. */
export function redactForIndex(text: string, homeDir?: string): string {
  let pre = text;
  for (const re of PEM_BLOCKS) {
    pre = pre.replace(new RegExp(re.source, re.flags), (m) => `[REDACTED]${"\n".repeat(m.split("\n").length - 1)}`);
  }
  return redactInput(pre, homeDir !== undefined ? { homeDir } : {});
}

async function enumerateGit(root: string, nestedArgs: string[]): Promise<string[]> {
  const r = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...nestedArgs], { cwd: root });
  return r.stdout
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "");
}

async function enumerateWalk(root: string, nested: ReadonlySet<string>): Promise<string[]> {
  const out: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(rel === "" ? root : path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!nested.has(childRel)) stack.push(childRel);
      } else out.push(childRel); // files, symlinks (including to directories) and special files; classified later
    }
  }
  return out;
}

export async function scanContext(root: string, opts: ScanOptions): Promise<ScanResult> {
  const realRoot = await realpath(root);
  const nestedRepos = await findNestedRepositories(realRoot);
  const nestedSet = new Set(nestedRepos.paths);
  const isExcluded = compileExcludes(opts.exclude);
  const skipped: ScanResult["skipped"] = nestedRepos.paths.map((p) => ({ path: p, reason: "nested_repository" }));
  const underNested = (rel: string) => nestedRepos.paths.some((n) => rel === n || rel.startsWith(`${n}/`));

  const isGit = await lstat(path.join(realRoot, ".git")).then(
    () => true,
    () => false,
  );
  const listed = isGit
    ? await enumerateGit(realRoot, nestedPathspecArgs(nestedRepos))
    : await enumerateWalk(realRoot, nestedSet);
  const rels = [...new Set(listed.filter((p) => !underNested(p)))].sort(cmp);

  const files: ScannedFile[] = [];
  const chunks: Chunk[] = [];
  let totalBytes = 0;
  let incompleteReason: IncompleteReason | undefined;

  for (const rel of rels) {
    if (rel.includes("�")) {
      skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }
    const skip = async (reason: SkipReason) => void skipped.push({ path: rel, reason });
    if (isDenylisted(rel)) {
      await skip("denylisted");
      continue;
    }
    if (isExcluded(rel)) {
      await skip("excluded");
      continue;
    }
    // Classify without following, then resolve a symlink and require the target to stay inside the root.
    let abs = path.join(realRoot, ...rel.split("/"));
    try {
      const l = await lstat(abs);
      if (l.isSymbolicLink()) {
        const target = await realpath(abs);
        const targetRel = toPosix(path.relative(realRoot, target));
        if (targetRel === "" || targetRel.startsWith("..") || path.isAbsolute(targetRel)) {
          await skip("symlink_escape");
          continue;
        }
        if (underNested(targetRel) || targetRel.split("/").includes(".git")) {
          await skip("nested_repository");
          continue;
        }
        if (isDenylisted(targetRel)) {
          await skip("denylisted");
          continue;
        }
        if (isExcluded(targetRel)) {
          await skip("excluded");
          continue;
        }
        abs = target;
      } else {
        // `lstat` refuses a symlink only in the last component: a tracked `a/b.txt` whose directory `a` was replaced by
        // a symlink would otherwise be read through it. Any path whose real location differs is skipped, as escaping
        // when it leaves the root and as a symlinked directory (never descended) otherwise.
        const real = await realpath(abs);
        if (real !== abs) {
          const realRel = toPosix(path.relative(realRoot, real));
          await skip(realRel.startsWith("..") || path.isAbsolute(realRel) ? "symlink_escape" : "special_file");
          continue;
        }
      }
      const s = await stat(abs);
      if (!s.isFile()) {
        await skip("special_file");
        continue;
      }
      if (s.size > opts.maxFileBytes) {
        await skip("oversized");
        continue;
      }
      const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: Buffer;
      let mtimeNs: bigint;
      try {
        const fst = await fh.stat({ bigint: true });
        if (!fst.isFile()) {
          await skip("special_file");
          continue;
        }
        mtimeNs = fst.mtimeNs;
        const buf = Buffer.alloc(opts.maxFileBytes + 1);
        let n = 0;
        while (n < buf.length) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
          if (bytesRead === 0) break;
          n += bytesRead;
        }
        if (n > opts.maxFileBytes) {
          await skip("oversized");
          continue;
        }
        raw = buf.subarray(0, n);
      } finally {
        await fh.close();
      }
      if (raw.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
        await skip("binary");
        continue;
      }
      const redacted = redactForIndex(raw.toString("utf8"), opts.homeDir);
      const fileChunks = chunkText(rel, redacted);
      const chunkBytes = fileChunks.reduce((a, c) => a + Buffer.byteLength(c.text, "utf8"), 0);
      if (files.length >= opts.maxFiles) incompleteReason = "max_files";
      else if (chunks.length + fileChunks.length > opts.maxChunks) incompleteReason = "max_chunks";
      else if (totalBytes + chunkBytes > opts.maxTotalBytes) incompleteReason = "max_total_bytes";
      if (incompleteReason !== undefined) break;
      totalBytes += chunkBytes;
      chunks.push(...fileChunks);
      files.push({ path: rel, sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length, mtimeNs });
    } catch {
      await skip("unreadable");
    }
  }

  skipped.sort((a, b) => cmp(a.path, b.path));
  return {
    files,
    chunks,
    skipped,
    complete: incompleteReason === undefined,
    ...(incompleteReason !== undefined ? { incompleteReason } : {}),
  };
}
