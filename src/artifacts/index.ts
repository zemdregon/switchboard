import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { defaultRedactor, type Redactor } from "./redact.js";

export {
  createSecretRedactor,
  DEFAULT_SECRET_PATTERNS,
  defaultRedactor,
  REDACTION_MARKER,
  type Redactor,
} from "./redact.js";

export class ArtifactError extends Error {
  override readonly name = "ArtifactError";
  constructor(
    readonly code: "INVALID_HASH" | "NOT_FOUND" | "INTEGRITY_FAILURE",
    message: string,
  ) {
    super(message);
  }
}

export interface StoredArtifact {
  /** SHA-256 (lowercase hex) of the stored (post-redaction) bytes. */
  readonly sha256: string;
  readonly sizeBytes: number;
  /** True when the redactor changed the content. */
  readonly redacted: boolean;
}

export interface ArtifactStoreOptions {
  /** Applied to content BEFORE hashing and writing. Defaults to the secret-pattern redactor. */
  readonly redact?: Redactor;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertHash(hash: string): void {
  if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
    throw new ArtifactError("INVALID_HASH", "artifact hash must be 64 lowercase hex characters");
  }
}

/**
 * Content-addressed artifact store (FR-EXE-05, FR-TEL-03, NFR-SEC-01). Layout follows LLD §1:
 * `<root>/ab/cd/<sha256>` (Proposed: `root` is `<data_dir>/artifacts`; HLD's single-prefix layout is superseded by the
 * LLD schema comment). The address is the SHA-256 of the stored bytes, i.e. after redaction, so the raw secret never
 * reaches disk and the address always verifies against the file.
 */
export class ArtifactStore {
  private readonly redact: Redactor;

  constructor(
    readonly root: string,
    options: ArtifactStoreOptions = {},
  ) {
    this.redact = options.redact ?? defaultRedactor;
  }

  /** Absolute path for a hash; validates the hash first so no input can escape the root. */
  pathFor(hash: string): string {
    assertHash(hash);
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async put(content: Buffer | string): Promise<StoredArtifact> {
    const raw = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const data = this.redact(raw);
    const sha256 = sha256Hex(data);
    const finalPath = this.pathFor(sha256);
    const result: StoredArtifact = { sha256, sizeBytes: data.length, redacted: !data.equals(raw) };

    // Dedup: an existing, intact object is kept as is.
    if (await this.isIntact(finalPath, sha256)) return result;

    const dir = path.dirname(finalPath);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await this.fixDirModes(dir);

    const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      const fh = await open(tmp, "wx", FILE_MODE);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await chmod(tmp, FILE_MODE);
      // rename is atomic and, for identical content, concurrent writers replace the file with identical bytes.
      // It also repairs a corrupt existing object.
      await rename(tmp, finalPath);
    } finally {
      await rm(tmp, { force: true });
    }
    return result;
  }

  /** Read by hash and verify the bytes still hash to the address. */
  async get(hash: string): Promise<Buffer> {
    const file = this.pathFor(hash);
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ArtifactError("NOT_FOUND", `artifact ${hash} not found`);
      }
      throw err;
    }
    if (sha256Hex(data) !== hash) {
      throw new ArtifactError("INTEGRITY_FAILURE", `artifact ${hash} failed integrity verification`);
    }
    return data;
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.pathFor(hash));
      return true;
    } catch (err) {
      if (err instanceof ArtifactError) throw err;
      return false;
    }
  }

  private async isIntact(file: string, hash: string): Promise<boolean> {
    try {
      return sha256Hex(await readFile(file)) === hash;
    } catch {
      return false;
    }
  }

  /** mkdir's mode is subject to umask and ignored for pre-existing dirs; enforce 0700 on root and shard dirs. */
  private async fixDirModes(leafDir: string): Promise<void> {
    let dir = leafDir;
    while (true) {
      await chmod(dir, DIR_MODE);
      if (dir === this.root || path.dirname(dir) === dir) return;
      dir = path.dirname(dir);
      if (!dir.startsWith(this.root)) return;
    }
  }
}
