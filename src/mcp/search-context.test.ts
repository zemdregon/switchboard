/**
 * `search_project_context` (T12.6; FR-RAG-06, FR-RAG-08, LLD §14.7, §14.8; T12.7 follow-up: FR-RAG-09, FR-RAG-10,
 * `scope: "global"` and `"both"` read the global store). Temporary Git repositories, stores built by
 * the T12.4 build with the deterministic in-process fake embedder; no network, no provider. Server-level cases go
 * through the SDK client, so every result is checked against the published output schema.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterRegistry } from "../adapters/index.js";
import type { ArtifactStore } from "../artifacts/index.js";
import {
  effectiveProjectRag,
  type ProjectRagConfig,
  type RagConfig,
  type ResolvedProject,
  resolveRag,
} from "../config/index.js";
import type { Ledger, RagRecordInput, TrustProfile } from "../ledger/index.js";
import type { RunLifecycle } from "../lifecycle/index.js";
import type { BuildProject } from "../retrieval/build.js";
import { buildProjectIndex } from "../retrieval/build.js";
import type { EmbeddingBackend } from "../retrieval/embedding.js";
import { createFakeEmbedder, FAKE_EMBEDDING_MODEL, type FakeEmbedder } from "../retrieval/fake-embedder.js";
import { buildGlobalIndex, type GlobalBuildInput, globalOrigins } from "../retrieval/global.js";
import { ragStoreDir } from "../retrieval/store.js";
import { TOOL_NAMES, WORK_QUEUE_TOOL_NAMES } from "./schemas.js";
import {
  MAX_RESULT_TEXT_BYTES,
  MAX_SEARCH_TEXT_BYTES,
  relativeInContext,
  type SearchContextDeps,
  type SearchProject,
  searchProjectContext,
} from "./search-context.js";
import { createSwitchboardServer } from "./server.js";

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

const RAG: RagConfig = { embedding: { kind: "http", base_url: "http://127.0.0.1:1", model: FAKE_EMBEDDING_MODEL } };
const SETTINGS = resolveRag(RAG);
const GLOBAL_SETTINGS = resolveRag({ ...RAG, global: { enabled: true, sources: [] } });

let tmp: string;
let dataDir: string;
let fake: FakeEmbedder;
let records: RagRecordInput[];

const put = (base: string, rel: string, content: string) => {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};
const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n");

function newRepo(name: string, files: Record<string, string>): string {
  const repo = path.join(tmp, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) put(repo, rel, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

const target = (id: string, repo: string, rag?: ProjectRagConfig): SearchProject => ({
  id,
  ...(rag !== undefined ? { rag } : {}),
  contexts: [{ id: "main", path: repo }],
});

async function build(p: SearchProject, settings = SETTINGS, over: { now?: () => Date } = {}) {
  const r = await buildProjectIndex(
    {
      dataDir,
      backend: fake,
      embedding: { model: FAKE_EMBEDDING_MODEL, allowRemote: false, allowSourceContent: false },
      homeDir: "/nonexistent-home",
      ...over,
    },
    {
      id: p.id,
      effective: effectiveProjectRag(settings, p.rag),
      contexts: p.contexts.map((c) => ({ ...c, primary: true })),
    },
  );
  expect(["ok", "partial"]).toContain(r.outcome);
  return r;
}

const deps = (over: Partial<SearchContextDeps> = {}): SearchContextDeps => ({
  dataDir,
  settings: SETTINGS,
  backend: fake,
  homeDir: "/nonexistent-home",
  record: (r) => records.push(r),
  ...over,
});

/** A retrieval build project under `settings` (T12.7 tests resolve origins from these). */
const bproj = (id: string, root: string, rag?: ProjectRagConfig, settings = GLOBAL_SETTINGS): BuildProject => ({
  id,
  effective: effectiveProjectRag(settings, rag),
  contexts: [{ id: "main", path: root, primary: true }],
});

const EMBEDDING = { model: FAKE_EMBEDDING_MODEL, allowRemote: false, allowSourceContent: false };

/** Deps with the global origins of `projects` (T12.7): the tool reads the global store only through this map. */
const globalDeps = (projects: BuildProject[], over: Partial<SearchContextDeps> = {}): SearchContextDeps =>
  deps({ settings: GLOBAL_SETTINGS, globalOrigins: () => globalOrigins(GLOBAL_SETTINGS.global, projects), ...over });

async function buildGlobal(projects: BuildProject[], over: Partial<GlobalBuildInput> = {}) {
  const r = await buildGlobalIndex(
    { dataDir, backend: fake, embedding: EMBEDDING, homeDir: "/nonexistent-home" },
    {
      global: GLOBAL_SETTINGS.global,
      caps: GLOBAL_SETTINGS.caps,
      exclude: GLOBAL_SETTINGS.exclude,
      projects,
      allowedRoots: [tmp],
      ...over,
    },
  );
  expect(["ok", "partial"]).toContain(r.outcome);
  return r;
}

let repo: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-rag-search-")));
  dataDir = path.join(tmp, "data");
  mkdirSync(dataDir);
  fake = createFakeEmbedder({ dimension: 32 });
  records = [];
  repo = newRepo("repo", {
    "src/parser.ts": "export function parseInvoiceHeader(input) { return tokenizeInvoice(input); }\n",
    "src/retry.ts": "export function exponentialBackoffWithJitter(attempt) { return Math.random() * 2 ** attempt; }\n",
    "docs/guide.md": lines("guide", 12),
  });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("searchProjectContext (T12.6, FR-RAG-06)", () => {
  it("returns the best snippets, relative to the context root, labelled untrusted, and records counts only", async () => {
    const p = target("demo", repo);
    const built = await build(p);
    const r = await searchProjectContext(deps(), p, { query: "exponential backoff with jitter", limit: 2 });
    expect(r.status).toBe("ok");
    expect(r.index_revision).toBe(built.revision);
    expect(r.results).toHaveLength(2);
    const top = r.results[0];
    expect(top).toMatchObject({
      context_id: "main",
      path: "src/retry.ts",
      start_line: 1,
      end_line: 1,
      untrusted: true,
      file_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      snippet_id: expect.stringMatching(/^chk_[0-9a-f]{24}$/u),
    });
    expect(top?.text).toContain("exponentialBackoffWithJitter");
    expect((r.results[0]?.score ?? 0) >= (r.results[1]?.score ?? 0)).toBe(true);
    for (const h of r.results) {
      expect(path.isAbsolute(h.path)).toBe(false);
      expect(h.path.split("/")).not.toContain("..");
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "retrieval",
      projectKey: "demo",
      outcome: "ok",
      chunks: 2,
      embedCalls: 1,
    });
    expect(JSON.stringify(records[0])).not.toContain("exponential");
  });

  it("uses retrieval.top_k when limit is absent and never more than 32", async () => {
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.ts`, `alpha beta ${i}\n`]));
    const big = newRepo("big", files);
    const p = target("big", big);
    await build(p);
    expect((await searchProjectContext(deps(), p, { query: "alpha beta" })).results).toHaveLength(8);
    expect((await searchProjectContext(deps(), p, { query: "alpha beta", limit: 99 })).results).toHaveLength(32);
  });

  it("bounds each text and the response's total text, and says when a result was left out", async () => {
    const line = "x".repeat(99);
    const files = Object.fromEntries(
      Array.from({ length: 34 }, (_, i) => [`f${i}.txt`, Array.from({ length: 40 }, () => `${line}`).join("\n")]),
    );
    const big = newRepo("wide", files);
    const p = target("wide", big);
    await build(p);
    const r = await searchProjectContext(deps(), p, { query: "x", limit: 32 });
    expect(r.truncated).toBe(true);
    const total = r.results.reduce((n, h) => n + Buffer.byteLength(h.text), 0);
    expect(total).toBeLessThanOrEqual(MAX_SEARCH_TEXT_BYTES);
    expect(r.results.length).toBeGreaterThan(0);
    for (const h of r.results) expect(Buffer.byteLength(h.text)).toBeLessThanOrEqual(MAX_RESULT_TEXT_BYTES);
  });

  it("drops a snippet whose file changed or vanished, and keeps one whose file was only touched (LLD §14.8)", async () => {
    const p = target("demo", repo);
    await build(p);
    const q = { query: "parseInvoiceHeader exponentialBackoffWithJitter", limit: 8 };
    const paths = async () => (await searchProjectContext(deps(), p, q)).results.map((h) => h.path).sort();
    expect(await paths()).toEqual(["docs/guide.md", "src/parser.ts", "src/retry.ts"]);
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(repo, "src/parser.ts"), later, later); // same content, new mtime: hashed, kept
    writeFileSync(path.join(repo, "src/retry.ts"), "export const changed = 1;\n");
    unlinkSync(path.join(repo, "docs/guide.md"));
    expect(await paths()).toEqual(["src/parser.ts"]);
  });

  it("returns no file that now resolves outside the context root", async () => {
    const p = target("demo", repo);
    await build(p);
    const outside = path.join(tmp, "outside.ts");
    const indexed = path.join(repo, "src/retry.ts");
    writeFileSync(
      outside,
      "export function exponentialBackoffWithJitter(attempt) { return Math.random() * 2 ** attempt; }\n",
    );
    const st = statSync(indexed);
    unlinkSync(indexed);
    symlinkSync(outside, indexed);
    utimesSync(outside, st.atime, st.mtime);
    const r = await searchProjectContext(deps(), p, { query: "exponential backoff with jitter", limit: 8 });
    expect(r.results.map((h) => h.path)).not.toContain("src/retry.ts");
  });

  it("refuses store paths that are absolute, escape or name another context", () => {
    expect(relativeInContext("main/src/a.ts", "main")).toBe("src/a.ts");
    for (const bad of ["main/../x", "main//x", "main/./x", "other/x", "main/", "/etc/passwd", "main/a\\..\\b"]) {
      expect(relativeInContext(bad, "main")).toBeUndefined();
    }
  });

  it("is read-only: no store is created, and a search changes no file of an existing store", async () => {
    const p = target("demo", repo);
    const none = await searchProjectContext(deps(), p, { query: "anything" });
    expect(none).toEqual({ status: "unavailable", reason: "NOT_BUILT", results: [] });
    expect(existsSync(path.join(dataDir, "rag"))).toBe(false);
    expect(fake.requests).toHaveLength(0);

    await build(p);
    const dir = ragStoreDir(dataDir, { kind: "project", projectId: "demo" });
    const snapshot = () =>
      readdirSync(dir)
        .filter((f) => f === "index.db")
        .map((f) => [f, statSync(path.join(dir, f)).mtimeMs, statSync(path.join(dir, f)).size]);
    const before = snapshot();
    await searchProjectContext(deps(), p, { query: "parseInvoiceHeader" });
    expect(snapshot()).toEqual(before);
  });

  it("is unavailable, not an error, when the store was built for another model", async () => {
    const p = target("demo", repo);
    await build(p);
    const other = resolveRag({ embedding: { kind: "http", base_url: "http://127.0.0.1:1", model: "other-model" } });
    const r = await searchProjectContext(deps({ settings: other }), p, { query: "parse" });
    expect(r).toMatchObject({ status: "unavailable", reason: "REBUILD_PENDING", results: [] });
  });

  it("applies the embedding gate to the query: a remote backend without both flags is never sent it", async () => {
    const p = target("demo", repo);
    await build(p);
    const remote = createFakeEmbedder({ dimension: 32, locality: "remote" });
    const r = await searchProjectContext(deps({ backend: remote }), p, { query: "parseInvoiceHeader" });
    expect(r).toMatchObject({ status: "unavailable", reason: "REMOTE_NOT_ALLOWED", results: [] });
    expect(remote.requests).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({ outcome: "unavailable", reason: "REMOTE_NOT_ALLOWED", locality: "remote" });
  });

  it("is unavailable with the backend's code when embedding the query fails or the dimension differs", async () => {
    const p = target("demo", repo);
    await build(p);
    const failing = createFakeEmbedder({ dimension: 32, failWith: "ECONNREFUSED" });
    expect(await searchProjectContext(deps({ backend: failing }), p, { query: "x" })).toMatchObject({
      status: "unavailable",
      reason: "ECONNREFUSED",
    });
    const wide = createFakeEmbedder({ dimension: 48 });
    expect(await searchProjectContext(deps({ backend: wide }), p, { query: "x" })).toMatchObject({
      status: "unavailable",
      reason: "DIMENSION_MISMATCH",
    });
  });

  it("is unavailable when retrieval is off for the project", async () => {
    const p = target("demo", repo, { mode: "off" });
    expect(await searchProjectContext(deps(), p, { query: "x" })).toEqual({
      status: "unavailable",
      reason: "PROJECT_OFF",
      results: [],
    });
  });

  it("flags a store older than max_staleness as stale and a partial build as incomplete", async () => {
    const p = target("demo", repo);
    await build(p, SETTINGS, { now: () => new Date(Date.now() - 2 * 86_400_000) });
    expect((await searchProjectContext(deps(), p, { query: "parseInvoiceHeader" })).status).toBe("stale");

    const capped = target("capped", newRepo("capped", { "a.ts": "alpha\n", "b.ts": "bravo\n", "c.ts": "charlie\n" }), {
      caps: { max_files: 1 },
    });
    const r = await build(capped);
    expect(r.complete).toBe(false);
    expect((await searchProjectContext(deps(), capped, { query: "alpha" })).status).toBe("incomplete");
  });

  it("needs use_global for scope global or both, and reports a missing global store as GLOBAL_NOT_AVAILABLE", async () => {
    const p = target("demo", repo);
    await build(p);
    await expect(searchProjectContext(deps(), p, { query: "x", scope: "global" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(searchProjectContext(deps(), p, { query: "x", scope: "both" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const g = target("demo", repo, { use_global: true });
    const gd = globalDeps([]);
    expect(await searchProjectContext(gd, g, { query: "x", scope: "global" })).toMatchObject({
      status: "unavailable",
      reason: "GLOBAL_NOT_AVAILABLE",
      results: [],
    });
    const both = await searchProjectContext(gd, g, { query: "parseInvoiceHeader", scope: "both", limit: 1 });
    expect(both).toMatchObject({ status: "ok", reason: "GLOBAL_NOT_AVAILABLE" });
    expect(both.results[0]?.path).toBe("src/parser.ts");
    expect(both.results[0]).not.toHaveProperty("origin_project");
    expect(both.results[0]).not.toHaveProperty("source");
    // "both" is fail closed on the project leg: a missing project store wins over the global one.
    const missing = target("bravo", repo, { use_global: true });
    expect(await searchProjectContext(gd, missing, { query: "x", scope: "both" })).toMatchObject({
      status: "unavailable",
      reason: "NOT_BUILT",
    });
  });

  it("does not read the global store without an origins function (fail closed)", async () => {
    const repoA = newRepo("proj-a", { "alpha.ts": "export function zebraAlphaMarker() { return 1; }\n" });
    const a = target("alpha", repoA, { contribute_to_global: true, use_global: true });
    const b = target("bravo", repoA, { use_global: true });
    await build(a, GLOBAL_SETTINGS);
    const projects = [
      bproj("alpha", repoA, { contribute_to_global: true, use_global: true }),
      bproj("bravo", repoA, {
        use_global: true,
      }),
    ];
    await buildGlobal(projects);
    expect(
      await searchProjectContext(deps({ settings: GLOBAL_SETTINGS }), b, {
        query: "zebraAlphaMarker",
        scope: "global",
      }),
    ).toMatchObject({ status: "unavailable", reason: "GLOBAL_NOT_AVAILABLE", results: [] });
  });

  it("scope global serves another project's contributions with origin labels, never the reader's own", async () => {
    const repoA = newRepo("proj-a", { "alpha.ts": "export function zebraAlphaMarker() { return 1; }\n" });
    const repoC = newRepo("proj-c", { "charlie.ts": "export function quasarCharlieMarker() { return 2; }\n" });
    const a = target("alpha", repoA, { contribute_to_global: true, use_global: true });
    const b = target("bravo", repoA, { use_global: true });
    await build(a, GLOBAL_SETTINGS);
    await build(target("charlie", repoC, { contribute_to_global: true }), GLOBAL_SETTINGS);
    const projects = [
      bproj("alpha", repoA, { contribute_to_global: true, use_global: true }),
      bproj("charlie", repoC, { contribute_to_global: true }),
      bproj("bravo", repoA, { use_global: true }),
    ];
    await buildGlobal(projects);
    const gd = globalDeps(projects);
    // B has no project store of its own: the answer comes only from the global store.
    const r = await searchProjectContext(gd, b, {
      query: "zebraAlphaMarker quasarCharlieMarker",
      scope: "global",
      limit: 8,
    });
    expect(r.status).toBe("ok");
    expect(typeof r.index_revision).toBe("number");
    expect(r.results.length).toBeGreaterThan(0);
    for (const h of r.results) {
      expect(["alpha", "charlie"]).toContain(h.origin_project);
      expect(h.source).toBeUndefined();
      expect(h.context_id.startsWith("project:")).toBe(true);
      expect(h.path.includes("project:")).toBe(false);
    }
    expect(r.results.some((h) => h.origin_project === "alpha" && h.text.includes("zebraAlphaMarker"))).toBe(true);
    expect(r.results.some((h) => h.origin_project === "charlie" && h.text.includes("quasarCharlieMarker"))).toBe(true);
    // A's own contributions never come back through the global leg, even to A.
    const ra = await searchProjectContext(gd, a, {
      query: "zebraAlphaMarker quasarCharlieMarker",
      scope: "global",
      limit: 8,
    });
    expect(ra.results.every((h) => h.origin_project !== "alpha")).toBe(true);
    expect(ra.results.some((h) => h.origin_project === "charlie")).toBe(true);
  });

  it("does not serve a contribution whose origin stopped sharing, even before the next build", async () => {
    const repoA = newRepo("proj-a", { "alpha.ts": "export function zebraAlphaMarker() { return 1; }\n" });
    const b = target("bravo", repoA, { use_global: true });
    await build(target("alpha", repoA, { contribute_to_global: true }), GLOBAL_SETTINGS);
    await buildGlobal([
      bproj("alpha", repoA, { contribute_to_global: true }),
      bproj("bravo", repoA, { use_global: true }),
    ]);
    // A stops contributing; its rows are still in the store until the next global build removes them.
    const narrowed = [bproj("alpha", repoA, { use_global: true }), bproj("bravo", repoA, { use_global: true })];
    const r = await searchProjectContext(globalDeps(narrowed), b, {
      query: "zebraAlphaMarker",
      scope: "global",
      limit: 8,
    });
    expect(r.results).toEqual([]);
    expect(r.reason).toBeUndefined();
  });

  it("serves operator sources with a source label and no origin_project", async () => {
    const srcDir = path.join(tmp, "ops");
    put(srcDir, "runbook.md", "opsSourceMarker deploy checklist\n");
    const withSource = resolveRag({
      ...RAG,
      global: { enabled: true, sources: [{ path: srcDir, label: "ops" }] },
    });
    const b = target("bravo", repo, { use_global: true });
    const projects: BuildProject[] = [
      {
        id: "bravo",
        effective: effectiveProjectRag(withSource, { use_global: true }),
        contexts: [{ id: "main", path: repo, primary: true }],
      },
    ];
    await buildGlobal(projects, { global: withSource.global, caps: withSource.caps, exclude: withSource.exclude });
    const gd = deps({ settings: withSource, globalOrigins: () => globalOrigins(withSource.global, projects) });
    const r = await searchProjectContext(gd, b, {
      query: "opsSourceMarker deploy checklist",
      scope: "global",
      limit: 4,
    });
    expect(r.status).toBe("ok");
    expect(r.results.length).toBeGreaterThan(0);
    for (const h of r.results) {
      expect(h.source).toBe("ops");
      expect(h.origin_project).toBeUndefined();
      expect(h.context_id).toBe("source:ops");
    }
    expect(r.results.some((h) => h.text.includes("opsSourceMarker"))).toBe(true);
  });

  it("scope both merges project and global hits by score within one limit", async () => {
    const repoA = newRepo("proj-a", { "alpha.ts": "export function zebraAlphaMarker() { return 1; }\n" });
    const repoB = newRepo("proj-b", { "bravo.ts": "export function bravoMarker() { return 3; }\n" });
    const b = target("bravo", repoB, { use_global: true });
    await build(target("alpha", repoA, { contribute_to_global: true }), GLOBAL_SETTINGS);
    await build(b, GLOBAL_SETTINGS);
    const projects = [
      bproj("alpha", repoA, { contribute_to_global: true }),
      bproj("bravo", repoB, { use_global: true }),
    ];
    await buildGlobal(projects);
    const gd = globalDeps(projects);
    const r = await searchProjectContext(gd, b, { query: "bravoMarker zebraAlphaMarker", scope: "both", limit: 5 });
    expect(r).toMatchObject({ status: "ok", index_revision: expect.any(Number) });
    expect(r.reason).toBeUndefined();
    const own = r.results.filter((h) => h.origin_project === undefined && h.source === undefined);
    const shared = r.results.filter((h) => h.origin_project === "alpha");
    expect(own.length).toBeGreaterThan(0);
    expect(shared.length).toBeGreaterThan(0);
    expect(own[0]?.text).toContain("bravoMarker");
    for (let i = 1; i < r.results.length; i++) {
      expect((r.results[i - 1]?.score ?? 0) >= (r.results[i]?.score ?? 0)).toBe(true);
    }
    const one = await searchProjectContext(gd, b, { query: "bravoMarker zebraAlphaMarker", scope: "both", limit: 1 });
    expect(one.results).toHaveLength(1);
    // The single limit bounds the merged answer: the top hit is the merged ranking's first, whichever leg wins
    // (here the global hit outranks the project's under the fake embedder; the rule is score order, not leg).
    expect(one.results[0]?.snippet_id).toBe(r.results[0]?.snippet_id);
  });

  it("reports REBUILD_PENDING when the global store was built for another model", async () => {
    const repoA = newRepo("proj-a", { "alpha.ts": "export function zebraAlphaMarker() { return 1; }\n" });
    await build(target("alpha", repoA, { contribute_to_global: true }), GLOBAL_SETTINGS);
    const projects = [
      bproj("alpha", repoA, { contribute_to_global: true }),
      bproj("bravo", repoA, { use_global: true }),
    ];
    await buildGlobal(projects);
    const other = resolveRag({
      embedding: { kind: "http", base_url: "http://127.0.0.1:1", model: "other-model" },
      global: { enabled: true, sources: [] },
    });
    const gd = deps({ settings: other, globalOrigins: () => globalOrigins(other.global, projects) });
    expect(
      await searchProjectContext(gd, target("bravo", repoA, { use_global: true }), {
        query: "zebraAlphaMarker",
        scope: "global",
      }),
    ).toMatchObject({ status: "unavailable", reason: "REBUILD_PENDING" });
  });

  it("an unreadable chunk table is STORE_UNREADABLE on its own leg and only a reason in both", async () => {
    const repoA = newRepo("proj-a", { "alpha.ts": "export function zebraAlphaMarker() { return 1; }\n" });
    const repoB = newRepo("proj-b", { "bravo.ts": "export function bravoMarker() { return 3; }\n" });
    const b = target("bravo", repoB, { use_global: true });
    await build(target("alpha", repoA, { contribute_to_global: true }), GLOBAL_SETTINGS);
    await build(b, GLOBAL_SETTINGS);
    const projects = [
      bproj("alpha", repoA, { contribute_to_global: true }),
      bproj("bravo", repoB, { use_global: true }),
    ];
    await buildGlobal(projects);
    const gd = globalDeps(projects);
    // Corrupt the global leg after the build: its meta row still opens, its chunks do not.
    const corrupt = new Database(path.join(ragStoreDir(dataDir, { kind: "global" }), "index.db"));
    corrupt.exec("DROP TABLE rag_chunk");
    corrupt.close();
    expect(await searchProjectContext(gd, b, { query: "zebraAlphaMarker", scope: "global", limit: 4 })).toMatchObject({
      status: "unavailable",
      reason: "STORE_UNREADABLE",
      results: [],
    });
    const both = await searchProjectContext(gd, b, { query: "bravoMarker zebraAlphaMarker", scope: "both", limit: 4 });
    expect(both).toMatchObject({ status: "ok", reason: "STORE_UNREADABLE" });
    expect(both.results.length).toBeGreaterThan(0);
    expect(both.results.every((h) => h.origin_project === undefined && h.source === undefined)).toBe(true);
    // Corrupt the project leg instead: the call fails closed.
    const pcorrupt = new Database(path.join(ragStoreDir(dataDir, { kind: "project", projectId: "bravo" }), "index.db"));
    pcorrupt.exec("DROP TABLE rag_chunk");
    pcorrupt.close();
    expect(await searchProjectContext(gd, b, { query: "bravoMarker", scope: "project", limit: 4 })).toMatchObject({
      status: "unavailable",
      reason: "STORE_UNREADABLE",
      results: [],
    });
  });
});

// ---- through the MCP server -------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

function project(id: string, repoPath: string, rag?: ProjectRagConfig): ResolvedProject {
  return {
    id,
    name: id,
    environment: { kind: "host" },
    contexts: [
      { id: "main", kind: "repository", path: repoPath, primary: true, baseRef: "main", push: { policy: "none" } },
    ],
    ...(rag !== undefined ? { rag } : {}),
  } as unknown as ResolvedProject;
}

async function connect(opts: {
  clientId: string;
  projects: ResolvedProject[];
  clients: Record<string, string[] | undefined>;
  search?: SearchContextDeps;
}) {
  const mcpClients = new Map(
    Object.entries(opts.clients).map(([id, projects]) => [
      id,
      { id, maxTrustProfile: "edit-untrusted" as TrustProfile, ...(projects !== undefined ? { projects } : {}) },
    ]),
  );
  const mcp = createSwitchboardServer({
    lifecycle: { gatesEligibility: true } as unknown as RunLifecycle,
    ledger: {} as Ledger,
    artifacts: {} as ArtifactStore,
    registry: { list: () => [] } as unknown as AdapterRegistry,
    config: { allowedRoots: [tmp], mcpClients, projects: opts.projects, dataDir },
    clientId: opts.clientId,
    ...(opts.search !== undefined ? { searchContext: opts.search } : {}),
  });
  const client = new Client({ name: opts.clientId, version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(s);
  await client.connect(c);
  const names = (await client.listTools()).tools.map((t) => t.name); // caches output schemas for validation
  const call = async (args: Json) => {
    const res = await client.callTool({ name: "search_project_context", arguments: args });
    return {
      isError: res.isError === true,
      body: JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json,
    };
  };
  return { names, call, close: () => client.close() };
}

describe("search_project_context on the MCP server (T12.6, FR-RAG-06)", () => {
  it("is listed only with a backend and a project of the client's that has retrieval on", async () => {
    const projects = [project("demo", repo), project("quiet", repo, { mode: "off" })];
    const clients = { orch: ["demo"], quietonly: ["quiet"], none: undefined };
    const withSearch = await connect({ clientId: "orch", projects, clients, search: deps() });
    expect(withSearch.names).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES, "search_project_context"]);
    for (const clientId of ["quietonly", "none"]) {
      const s = await connect({ clientId, projects, clients, search: deps() });
      expect(s.names).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES]);
      const r = await s.call({ project: "quiet", query: "x" });
      expect(r.isError).toBe(true);
      expect(r.body.error.message).toMatch(/unknown tool/u);
    }
    const noBackend = await connect({ clientId: "orch", projects, clients });
    expect(noBackend.names).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES]);
  });

  it("searches only the client's projects: another project is refused exactly like an unknown one", async () => {
    const other = newRepo("other", { "secret-plan.ts": "export const otherProjectMarker = 'zebra quartz';\n" });
    const projects = [project("demo", repo), project("theirs", other)];
    await build(target("demo", repo));
    await build(target("theirs", other));
    const s = await connect({ clientId: "orch", projects, clients: { orch: ["demo"] }, search: deps() });

    const own = await s.call({ project: "demo", query: "zebra quartz otherProjectMarker", limit: 32 });
    expect(own.isError).toBe(false);
    expect(own.body.status).toBe("ok");
    expect(JSON.stringify(own.body)).not.toContain("otherProjectMarker");

    const theirs = await s.call({ project: "theirs", query: "zebra" });
    const missing = await s.call({ project: "nosuch", query: "zebra" });
    expect(theirs.isError).toBe(true);
    expect(theirs.body.error.code).toBe("INVALID_REQUEST");
    expect(theirs.body.error.message).toBe('unknown project "theirs"');
    expect(missing.body.error.message).toBe('unknown project "nosuch"');
    expect(theirs.body.error.details).toEqual(missing.body.error.details);
  });

  it("validates the input: an empty or oversized query, a limit above 32 and unknown keys are refused", async () => {
    await build(target("demo", repo));
    const s = await connect({
      clientId: "orch",
      projects: [project("demo", repo)],
      clients: { orch: ["demo"] },
      search: deps(),
    });
    for (const args of [
      { project: "demo", query: "" },
      { project: "demo", query: "q".repeat(2001) },
      { project: "demo", query: "q", limit: 33 },
      { project: "demo", query: "q", limit: 0 },
      { project: "demo", query: "q", path: "/etc" },
      { query: "q" },
    ]) {
      const r = await s.call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.body.error.code).toBe("INVALID_REQUEST");
    }
    const r = await s.call({ project: "demo", query: "parseInvoiceHeader", limit: 1 });
    expect(r.isError).toBe(false);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0]).toMatchObject({ path: "src/parser.ts", untrusted: true });
  });

  it("answers a failed backend with status unavailable, not a tool error (FR-RAG-08)", async () => {
    await build(target("demo", repo));
    const failing: EmbeddingBackend = createFakeEmbedder({ dimension: 32, failWith: "TIMEOUT" });
    const s = await connect({
      clientId: "orch",
      projects: [project("demo", repo)],
      clients: { orch: ["demo"] },
      search: deps({ backend: failing }),
    });
    const r = await s.call({ project: "demo", query: "parse" });
    expect(r).toEqual({
      isError: false,
      body: { status: "unavailable", reason: "TIMEOUT", index_revision: 1, results: [] },
    });
  });
});
