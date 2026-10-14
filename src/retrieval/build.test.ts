/**
 * Incremental build (T12.4; FR-RAG-11, LLD §14.5). Temporary Git repositories and the deterministic in-process fake
 * embedder only; no network, no provider.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EffectiveProjectRag, effectiveProjectRag, resolveRag } from "../config/index.js";
import { type BuildDeps, type BuildProject, buildProjectIndex } from "./build.js";
import { createFakeEmbedder, type FakeEmbedder } from "./fake-embedder.js";
import { openRagStore, ragStoreDir } from "./store.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const SETTINGS = resolveRag({ embedding: { kind: "http", base_url: "http://127.0.0.1:1", model: "m1" } });
const ON = effectiveProjectRag(SETTINGS, undefined) as Extract<EffectiveProjectRag, { enabled: true }>;
const EMBEDDING = { model: "m1", allowRemote: false, allowSourceContent: false };

let tmp: string;
let repo: string;
let dataDir: string;
let fake: FakeEmbedder;

const put = (rel: string, content: string, base = repo) => {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};
const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n");

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-rag-build-")));
  repo = path.join(tmp, "repo");
  dataDir = path.join(tmp, "data");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  put("a.ts", lines("alpha", 50));
  put("b.ts", lines("bravo", 10));
  put("docs/c.md", lines("charlie", 5));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  fake = createFakeEmbedder({ dimension: 16 });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const project = (over: Partial<BuildProject> = {}): BuildProject => ({
  id: "demo",
  effective: ON,
  contexts: [{ id: "main", path: repo, primary: true }],
  ...over,
});
const deps = (over: Partial<BuildDeps> = {}): BuildDeps => ({
  dataDir,
  backend: fake,
  embedding: EMBEDDING,
  homeDir: "/nonexistent-home",
  ...over,
});

function rows() {
  const store = openRagStore(dataDir, { kind: "project", projectId: "demo" });
  try {
    return {
      meta: store.meta(),
      files: store.db.prepare("SELECT path, indexed_rev FROM rag_file ORDER BY path").all() as {
        path: string;
        indexed_rev: number;
      }[],
      chunks: store.db.prepare("SELECT id, path, text FROM rag_chunk ORDER BY path, ordinal").all() as {
        id: string;
        path: string;
        text: Buffer;
      }[],
    };
  } finally {
    store.close();
  }
}

describe("buildProjectIndex", () => {
  it("builds a complete index with context-prefixed paths, base_ref_sha at HEAD and a revision", async () => {
    const r = await buildProjectIndex(deps(), project());
    expect(r).toMatchObject({
      outcome: "ok",
      reason: null,
      complete: true,
      files: 3,
      filesEmbedded: 3,
      filesRemoved: 0,
    });
    expect(r.chunks).toBe(4); // a.ts is 50 lines: two 40-line windows
    const s = rows();
    expect(s.files.map((f) => f.path)).toEqual(["main/a.ts", "main/b.ts", "main/docs/c.md"]);
    expect(s.meta).toMatchObject({ complete: true, dimension: 16, embeddingModel: "m1", projectKey: "demo" });
    expect(s.meta?.baseRefSha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(s.meta?.revision).toBe(r.revision);
  });

  it("a changed file re-indexes only itself; an unchanged rebuild embeds nothing and keeps the revision", async () => {
    await buildProjectIndex(deps({ batchChunks: 1 }), project());
    const before = rows();
    const calls = fake.requests.length;

    const idle = await buildProjectIndex(deps(), project());
    expect(idle).toMatchObject({ outcome: "ok", filesEmbedded: 0, embedCalls: 0, revision: before.meta?.revision });
    expect(fake.requests.length).toBe(calls);

    put("b.ts", `${lines("bravo", 10)}\nbravo changed`);
    const r = await buildProjectIndex(deps(), project());
    expect(r).toMatchObject({ outcome: "ok", filesEmbedded: 1, embedCalls: 1, complete: true });
    const sent = fake.requests.slice(calls).flat();
    expect(sent.every((t) => t.includes("bravo"))).toBe(true);
    expect(sent.some((t) => t.includes("alpha") || t.includes("charlie"))).toBe(false);

    const after = rows();
    expect(after.meta?.revision).toBe((before.meta?.revision as number) + 1);
    const rev = (p: string, s: typeof before) => s.files.find((f) => f.path === p)?.indexed_rev;
    expect(rev("main/a.ts", after)).toBe(rev("main/a.ts", before));
    expect(rev("main/docs/c.md", after)).toBe(rev("main/docs/c.md", before));
    expect(rev("main/b.ts", after)).toBe(after.meta?.revision);
  });

  it("a deleted file is removed with its chunks", async () => {
    await buildProjectIndex(deps(), project());
    unlinkSync(path.join(repo, "docs/c.md"));
    git(repo, "add", "-A");
    const r = await buildProjectIndex(deps(), project());
    expect(r).toMatchObject({ outcome: "ok", filesRemoved: 1, filesEmbedded: 0, files: 2 });
    expect(rows().chunks.some((c) => c.path === "main/docs/c.md")).toBe(false);
  });

  it("caps mark the store incomplete with the cap named", async () => {
    const r = await buildProjectIndex(deps(), project({ effective: { ...ON, caps: { ...ON.caps, maxFiles: 1 } } }));
    expect(r).toMatchObject({ outcome: "partial", reason: "max_files", complete: false, files: 1 });
    expect(rows().meta?.complete).toBe(false);
  });

  it("max_build_ms stops between batches as partial; the next build resumes by diff and completes", async () => {
    let t = 0;
    const clock = () => (t += 1000); // every reading advances one second
    const capped = project({ effective: { ...ON, caps: { ...ON.caps, maxBuildMs: 2500 } } });
    const r = await buildProjectIndex(deps({ clock, batchChunks: 1 }), capped);
    expect(r).toMatchObject({ outcome: "partial", reason: "max_build_ms", complete: false });
    expect(r.filesEmbedded).toBeGreaterThan(0);
    expect(r.filesEmbedded).toBeLessThan(3);

    const calls = fake.requests.length;
    const next = await buildProjectIndex(deps(), capped);
    expect(next).toMatchObject({ outcome: "ok", complete: true, files: 3, filesEmbedded: 3 - r.filesEmbedded });
    expect(fake.requests.length - calls).toBe(1);
  });

  it("a backend failure stops the build as failed and keeps what was committed", async () => {
    await buildProjectIndex(deps(), project());
    const before = rows();
    put("b.ts", "bravo edited");
    const r = await buildProjectIndex(deps({ backend: createFakeEmbedder({ failWith: "UNREACHABLE" }) }), project());
    expect(r).toMatchObject({ outcome: "failed", reason: "UNREACHABLE" });
    expect(rows().meta).toEqual(before.meta); // previous revision, still complete and queryable
  });

  it("is skipped before any store exists when retrieval is off or the privacy gate refuses the backend", async () => {
    const off = await buildProjectIndex(deps(), project({ effective: { enabled: false, reason: "PROJECT_OFF" } }));
    expect(off).toMatchObject({ outcome: "skipped", reason: "PROJECT_OFF" });
    const remote = createFakeEmbedder({ locality: "remote" });
    const denied = await buildProjectIndex(deps({ backend: remote }), project());
    expect(denied).toMatchObject({ outcome: "skipped", reason: "REMOTE_NOT_ALLOWED", locality: "remote" });
    const noSource = await buildProjectIndex(
      deps({ backend: remote, embedding: { ...EMBEDDING, allowRemote: true } }),
      project(),
    );
    expect(noSource).toMatchObject({ outcome: "skipped", reason: "SOURCE_CONTENT_NOT_ALLOWED" });
    expect(remote.requests).toEqual([]);
    expect(existsSync(ragStoreDir(dataDir, { kind: "project", projectId: "demo" }))).toBe(false);
  });

  it("a model change wipes the store and re-embeds everything; a dimension change mid-build restarts once", async () => {
    await buildProjectIndex(deps(), project());
    const m2 = await buildProjectIndex(deps({ embedding: { ...EMBEDDING, model: "m2" } }), project());
    expect(m2).toMatchObject({ outcome: "ok", filesEmbedded: 3 });
    expect(rows().meta?.embeddingModel).toBe("m2");

    const wide = createFakeEmbedder({ dimension: 32 });
    put("b.ts", "bravo again");
    const d = await buildProjectIndex(deps({ backend: wide, embedding: { ...EMBEDDING, model: "m2" } }), project());
    expect(d).toMatchObject({ outcome: "ok", complete: true, files: 3, filesEmbedded: 3 });
    expect(rows().meta?.dimension).toBe(32);
  });

  it("two contexts with the same relative path never collide; an unreadable context keeps its rows", async () => {
    const other = path.join(tmp, "other");
    mkdirSync(other);
    put("b.ts", "other bravo", other);
    const two = project({
      contexts: [
        { id: "main", path: repo, primary: true },
        { id: "lib", path: other, primary: false },
      ],
    });
    const r = await buildProjectIndex(deps(), two);
    expect(r).toMatchObject({ outcome: "ok", files: 4 });
    expect(rows().files.map((f) => f.path)).toContain("lib/b.ts");

    rmSync(other, { recursive: true });
    const again = await buildProjectIndex(deps(), two);
    expect(again).toMatchObject({ outcome: "partial", reason: "context_unreadable", filesRemoved: 0, files: 4 });
  });

  it("an aborted build stops as partial and leaves the store consistent", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await buildProjectIndex(deps({ signal: ctrl.signal }), project());
    expect(r).toMatchObject({ outcome: "partial", reason: "aborted", filesEmbedded: 0 });
    expect(fake.requests).toEqual([]);
  });

  it("stores only redacted text: a planted secret never reaches the store or the backend", async () => {
    const canary = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    put("config.ts", `export const token = "${canary}";\n`);
    git(repo, "add", "-A");
    await buildProjectIndex(deps(), project());
    expect(
      rows()
        .chunks.map((c) => c.text.toString("utf8"))
        .join("\n"),
    ).not.toContain(canary);
    expect(fake.requests.flat().join("\n")).not.toContain(canary);
  });
});
