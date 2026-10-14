/**
 * Retrieval stores (T12.1; FR-RAG-01, FR-RAG-03, FR-RAG-14, LLD §14.2). Temporary data directories only; no embedding
 * backend and no repository content.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRagStore,
  needsRebuild,
  openRagStore,
  pruneRagStores,
  RAG_SCHEMA_VERSION,
  RagStoreError,
  ragRoot,
  ragStoreDir,
} from "./store.js";

let tmp: string;
let dataDir: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sb-rag-store-"));
  dataDir = path.join(tmp, "data");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const proj = (projectId: string) => ({ kind: "project" as const, projectId });

describe("openRagStore", () => {
  it("creates one private store per project with the LLD §14.2 schema", () => {
    const s = openRagStore(dataDir, proj("web-app"));
    expect(s.file).toBe(path.join(dataDir, "rag", "projects", "web-app", "index.db"));
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(["rag_chunk", "rag_file", "rag_meta"]);
    expect(s.db.pragma("user_version", { simple: true })).toBe(RAG_SCHEMA_VERSION);
    expect(s.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(s.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(s.meta()).toBeUndefined();
    expect(s.counts()).toEqual({ files: 0, chunks: 0 });
    s.close();
    expect(statSync(path.dirname(s.file)).mode & 0o777).toBe(0o700);
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
  });

  it("keeps projects apart: two projects, two files, and rows in one are not in the other (FR-RAG-03)", () => {
    const a = openRagStore(dataDir, proj("app-a"));
    const b = openRagStore(dataDir, proj("app-b"));
    expect(a.file).not.toBe(b.file);
    a.db.prepare("INSERT INTO rag_file VALUES ('x.ts', 'main', ?, 1, 0, NULL, 1)").run("0".repeat(64));
    expect(a.counts().files).toBe(1);
    expect(b.counts().files).toBe(0);
    a.close();
    b.close();
  });

  it("a project named like the global store does not collide with it", () => {
    expect(ragStoreDir(dataDir, proj("global"))).not.toBe(ragStoreDir(dataDir, { kind: "global" }));
    expect(ragStoreDir(dataDir, { kind: "global" })).toBe(path.join(dataDir, "rag", "global"));
  });

  it("refuses a project id outside the id pattern (no path traversal)", () => {
    for (const bad of ["../escape", "a/b", "", "Upper", "x"]) {
      expect(() => ragStoreDir(dataDir, proj(bad))).toThrow(RagStoreError);
    }
    expect(existsSync(dataDir)).toBe(false);
  });

  it("re-opening is idempotent and keeps the rows; meta reads back; cascade delete works", () => {
    const s = openRagStore(dataDir, proj("web-app"));
    s.db
      .prepare(
        "INSERT INTO rag_meta VALUES (1, 'project', 'web-app', 'operator-model', 4, 3, 1, NULL, '2026-10-14T00:00:00.000Z')",
      )
      .run();
    s.db.prepare("INSERT INTO rag_file VALUES ('x.ts', 'main', ?, 1, 0, NULL, 3)").run("0".repeat(64));
    s.db
      .prepare("INSERT INTO rag_chunk VALUES ('chk_1', 'x.ts', 0, 1, 1, ?, ?, ?)")
      .run(Buffer.from("t"), "0".repeat(64), Buffer.alloc(16));
    s.close();
    const again = openRagStore(dataDir, proj("web-app"));
    expect(again.meta()).toEqual({
      schemaVersion: 1,
      storeKind: "project",
      projectKey: "web-app",
      embeddingModel: "operator-model",
      dimension: 4,
      revision: 3,
      complete: true,
      baseRefSha: null,
      builtAt: "2026-10-14T00:00:00.000Z",
    });
    again.db.prepare("DELETE FROM rag_file WHERE path = 'x.ts'").run();
    expect(again.counts()).toEqual({ files: 0, chunks: 0 });
    again.close();
  });

  it("refuses a store written by a newer schema version (fail closed)", () => {
    const dir = ragStoreDir(dataDir, proj("web-app"));
    mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "index.db"));
    db.pragma(`user_version = ${RAG_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openRagStore(dataDir, proj("web-app"))).toThrow(/newer than this version supports/);
  });
});

describe("needsRebuild", () => {
  const meta = {
    schemaVersion: RAG_SCHEMA_VERSION,
    storeKind: "project" as const,
    projectKey: "p",
    embeddingModel: "m",
    dimension: 8,
    revision: 1,
    complete: true,
    baseRefSha: null,
    builtAt: "t",
  };
  it("serves nothing until rebuilt when the model or dimension changed, or nothing was built", () => {
    expect(needsRebuild(undefined, { model: "m" })).toBe(true);
    expect(needsRebuild(meta, { model: "m", dimension: 8 })).toBe(false);
    expect(needsRebuild(meta, { model: "other" })).toBe(true);
    expect(needsRebuild(meta, { model: "m", dimension: 16 })).toBe(true);
  });
});

describe("deleteRagStore and pruneRagStores (FR-RAG-03, FR-RAG-14)", () => {
  it("deletes only the named store", () => {
    openRagStore(dataDir, proj("app-a")).close();
    openRagStore(dataDir, proj("app-b")).close();
    expect(deleteRagStore(dataDir, proj("app-a"))).toBe(true);
    expect(existsSync(ragStoreDir(dataDir, proj("app-a")))).toBe(false);
    expect(existsSync(ragStoreDir(dataDir, proj("app-b")))).toBe(true);
    expect(deleteRagStore(dataDir, proj("app-a"))).toBe(false);
  });

  it("prunes stores of projects that no longer exist and leaves unknown names alone", () => {
    for (const id of ["live-app", "gone-app"]) openRagStore(dataDir, proj(id)).close();
    openRagStore(dataDir, { kind: "global" }).close();
    mkdirSync(path.join(ragRoot(dataDir), "projects", "Not_An_Id"));
    const r = pruneRagStores(dataDir, new Set(["live-app"]));
    expect(r).toEqual({ removed: ["gone-app"], ignored: ["Not_An_Id"] });
    expect(existsSync(ragStoreDir(dataDir, proj("live-app")))).toBe(true);
    expect(existsSync(ragStoreDir(dataDir, { kind: "global" }))).toBe(true);
  });

  it("a planted symlink in place of a store is removed without touching its target", () => {
    const target = path.join(tmp, "precious");
    mkdirSync(target);
    writeFileSync(path.join(target, "keep.txt"), "keep");
    mkdirSync(path.join(ragRoot(dataDir), "projects"), { recursive: true });
    symlinkSync(target, path.join(ragRoot(dataDir), "projects", "gone-app"));
    expect(pruneRagStores(dataDir, new Set()).removed).toEqual(["gone-app"]);
    expect(readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  it("with no store on disk (no backend configured) it does nothing and creates nothing", () => {
    expect(pruneRagStores(dataDir, new Set())).toEqual({ removed: [], ignored: [] });
    expect(existsSync(dataDir)).toBe(false);
  });
});
