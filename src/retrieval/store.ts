/**
 * Retrieval stores (T12.1; FR-RAG-01, FR-RAG-03, FR-RAG-14, LLD §14.2, ADR-0031).
 *
 * One SQLite file per project, `<data>/rag/projects/<project id>/index.db`, and one global file
 * `<data>/rag/global/index.db`. They are derived caches opened by COMP-RAG alone, never by the ledger module, so
 * `ledger.db` stays the single writer of canonical state (ADR-0005); a store can be deleted and rebuilt at any time.
 * Same conventions as the ledger (LLD §1): `STRICT` tables, foreign keys on, WAL, `synchronous=FULL`.
 *
 * **Delegated** (T12.1): project stores live under `rag/projects/` rather than directly under `rag/` as the LLD first
 * wrote, so no project id can collide with the `global` store; the LLD is updated in the same change. The directory is
 * created `0700` and the file `0600` (the store holds redacted source text, R-56).
 *
 * Nothing here runs unless the feature is on for a project (`effectiveProjectRag`): with no embedding backend no store
 * is ever created (FR-RAG-04). Deleting a project deletes its store (FR-RAG-03): `deleteRagStore` on `delete_project`,
 * and `pruneRagStores` at `serve` start for projects that no longer exist (a configured project removed from the file).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { PROJECT_ID_PATTERN } from "../config/index.js";

/** Store schema version written to `PRAGMA user_version` and `rag_meta.schema_version`. */
export const RAG_SCHEMA_VERSION = 1;

export type RagStoreKey = { readonly kind: "project"; readonly projectId: string } | { readonly kind: "global" };

export class RagStoreError extends Error {
  override readonly name = "RagStoreError";
  constructor(
    readonly code: "INVALID_KEY" | "SCHEMA_TOO_NEW" | "OUTSIDE_RAG_DIR",
    message: string,
  ) {
    super(message);
  }
}

const PROJECT_ID_RE = new RegExp(PROJECT_ID_PATTERN);

/** `<data>/rag`. */
export function ragRoot(dataDir: string): string {
  return path.join(dataDir, "rag");
}

/** The directory of one store. A project id that does not match the configured id pattern is refused (no traversal). */
export function ragStoreDir(dataDir: string, key: RagStoreKey): string {
  if (key.kind === "global") return path.join(ragRoot(dataDir), "global");
  if (!PROJECT_ID_RE.test(key.projectId)) {
    throw new RagStoreError("INVALID_KEY", "not a valid project id for a retrieval store");
  }
  return path.join(ragRoot(dataDir), "projects", key.projectId);
}

/** LLD §14.2, version 1. */
const MIGRATION_1 = `
CREATE TABLE rag_meta (
  schema_version  INTEGER NOT NULL,
  store_kind      TEXT NOT NULL CHECK (store_kind IN ('project','global')),
  project_key     TEXT,
  embedding_model TEXT NOT NULL,
  dimension       INTEGER NOT NULL CHECK (dimension > 0),
  revision        INTEGER NOT NULL CHECK (revision >= 0),
  complete        INTEGER NOT NULL CHECK (complete IN (0,1)),
  base_ref_sha    TEXT,
  built_at        TEXT NOT NULL,
  CHECK ((store_kind = 'global') = (project_key IS NULL))
) STRICT;
CREATE TABLE rag_file (
  path           TEXT PRIMARY KEY,
  context_id     TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  mtime_ns       INTEGER NOT NULL,
  origin_project TEXT,
  indexed_rev    INTEGER NOT NULL
) STRICT;
CREATE TABLE rag_chunk (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL REFERENCES rag_file(path) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  text        BLOB NOT NULL,
  text_sha256 TEXT NOT NULL,
  vector      BLOB NOT NULL
) STRICT;
CREATE INDEX rag_chunk_path ON rag_chunk(path);
`;

/** The `rag_meta` row, absent until the first build step commits (T12.4). */
export interface RagMeta {
  readonly schemaVersion: number;
  readonly storeKind: "project" | "global";
  readonly projectKey: string | null;
  readonly embeddingModel: string;
  readonly dimension: number;
  readonly revision: number;
  readonly complete: boolean;
  readonly baseRefSha: string | null;
  readonly builtAt: string;
}

export interface RagStore {
  readonly key: RagStoreKey;
  readonly file: string;
  /** The open handle, for the build and search modules of COMP-RAG only. */
  readonly db: Database.Database;
  meta(): RagMeta | undefined;
  counts(): { files: number; chunks: number };
  close(): void;
}

/**
 * Open (creating if needed) a store and bring its schema to {@link RAG_SCHEMA_VERSION}. A store written by a newer
 * version is refused rather than guessed at (fail closed); the caller treats it as unavailable.
 */
export function openRagStore(dataDir: string, key: RagStoreKey): RagStore {
  const dir = ragStoreDir(dataDir, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = path.join(dir, "index.db");
  const db = new Database(file);
  try {
    chmodSync(file, 0o600);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  const metaStmt = db.prepare("SELECT * FROM rag_meta LIMIT 1");
  return {
    key,
    file,
    db,
    meta: () => {
      const r = metaStmt.get() as Record<string, unknown> | undefined;
      if (r === undefined) return undefined;
      return {
        schemaVersion: r.schema_version as number,
        storeKind: r.store_kind as "project" | "global",
        projectKey: (r.project_key as string | null) ?? null,
        embeddingModel: r.embedding_model as string,
        dimension: r.dimension as number,
        revision: r.revision as number,
        complete: r.complete === 1,
        baseRefSha: (r.base_ref_sha as string | null) ?? null,
        builtAt: r.built_at as string,
      };
    },
    counts: () => ({
      files: (db.prepare("SELECT COUNT(*) AS n FROM rag_file").get() as { n: number }).n,
      chunks: (db.prepare("SELECT COUNT(*) AS n FROM rag_chunk").get() as { n: number }).n,
    }),
    close: () => db.close(),
  };
}

function migrate(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > RAG_SCHEMA_VERSION) {
    throw new RagStoreError("SCHEMA_TOO_NEW", `retrieval store schema ${version} is newer than this version supports`);
  }
  if (version < 1) {
    db.transaction(() => {
      db.exec(MIGRATION_1);
      db.pragma(`user_version = ${RAG_SCHEMA_VERSION}`);
    })();
  }
}

/**
 * True when a store's meta row no longer matches the configuration (schema, model or dimension), so nothing may be
 * served from it until it is rebuilt (LLD §14.2). A store with no meta row has nothing to serve either.
 */
export function needsRebuild(meta: RagMeta | undefined, want: { model: string; dimension?: number }): boolean {
  if (meta === undefined) return true;
  if (meta.schemaVersion !== RAG_SCHEMA_VERSION || meta.embeddingModel !== want.model) return true;
  return want.dimension !== undefined && meta.dimension !== want.dimension;
}

/** Delete one store's directory (vectors and chunk text; FR-RAG-03, FR-RAG-14). Returns whether anything was removed. */
export function deleteRagStore(dataDir: string, key: RagStoreKey): boolean {
  const dir = ragStoreDir(dataDir, key);
  const root = ragRoot(dataDir);
  const rel = path.relative(root, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new RagStoreError("OUTSIDE_RAG_DIR", "refusing to delete outside the retrieval directory");
  }
  if (!existsSync(dir) && !isSymlink(dir)) return false;
  // `rmSync` never follows a symlink: a planted link is removed itself, not its target.
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Delete the store of every project not in `liveProjectIds` (a configured project removed from the file, or a dynamic
 * project deleted while the daemon was down). Entries whose name is not a valid project id are left alone and reported,
 * since this code never created them. Returns the removed project ids, sorted.
 */
export function pruneRagStores(
  dataDir: string,
  liveProjectIds: ReadonlySet<string>,
): { removed: string[]; ignored: string[] } {
  const dir = path.join(ragRoot(dataDir), "projects");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { removed: [], ignored: [] };
  }
  const removed: string[] = [];
  const ignored: string[] = [];
  for (const name of names.sort()) {
    if (!PROJECT_ID_RE.test(name)) {
      ignored.push(name);
      continue;
    }
    if (liveProjectIds.has(name)) continue;
    if (deleteRagStore(dataDir, { kind: "project", projectId: name })) removed.push(name);
  }
  return { removed, ignored };
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
