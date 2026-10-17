import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

/**
 * Content store (T16.1; FR-SKL-01, LLD §19.2): `<data_dir>/skills/<sha256>.md`, file 0600, directory 0700. A file is
 * written once through a temporary file, `fsync` and rename, and is never edited. This module has no delete for a
 * stored file: the only removal is {@link discardUnreferenced}, which `addSkill` uses for a file it just created when
 * the ledger transaction then fails, so no `skill_version` row can name it.
 */

export const SKILLS_DIR_NAME = "skills";
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export class SkillStoreError extends Error {
  override readonly name = "SkillStoreError";
}

export function skillsDir(dataDir: string): string {
  return path.join(dataDir, SKILLS_DIR_NAME);
}

export function skillContentPath(dataDir: string, sha256: string): string {
  if (!SHA256_HEX.test(sha256)) throw new SkillStoreError("not a SHA-256 hex digest");
  return path.join(skillsDir(dataDir), `${sha256}.md`);
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readIfPresent(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Write canonical skill text under its hash. Returns `created: false` when an identical file already exists (an
 * earlier version with the same content). A file present under the name with other bytes is an error, never replaced.
 */
export function writeSkillContent(dataDir: string, sha256: string, text: string): { path: string; created: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (sha256Of(bytes) !== sha256) throw new SkillStoreError("content does not match its SHA-256");
  const dir = skillsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = skillContentPath(dataDir, sha256);
  const existing = readIfPresent(file);
  if (existing !== undefined) {
    if (sha256Of(existing) !== sha256)
      throw new SkillStoreError(`stored skill file ${sha256}.md does not match its hash`);
    return { path: file, created: false };
  }
  const tmp = path.join(dir, `.${sha256}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  renameSync(tmp, file);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return { path: file, created: true };
}

/** Read a stored version's canonical text, verifying its hash. */
export function readSkillContent(dataDir: string, sha256: string): string {
  const bytes = readIfPresent(skillContentPath(dataDir, sha256));
  if (bytes === undefined) throw new SkillStoreError(`skill file ${sha256}.md is missing`);
  if (sha256Of(bytes) !== sha256) throw new SkillStoreError(`skill file ${sha256}.md does not match its hash`);
  return bytes.toString("utf8");
}

/** Remove a file this process just created, only when no `skill_version` row names it (checked by the caller). */
export function discardUnreferenced(dataDir: string, sha256: string): void {
  rmSync(skillContentPath(dataDir, sha256), { force: true });
}
