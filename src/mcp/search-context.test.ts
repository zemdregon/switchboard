/**
 * `search_project_context` (T12.6, T12.7; FR-RAG-06, FR-RAG-08, FR-RAG-10, LLD §14.7, §14.8). Temporary Git repositories, stores built by
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
import { type BuildProject, buildProjectIndex } from "../retrieval/build.js";
import type { EmbeddingBackend } from "../retrieval/embedding.js";
import { createFakeEmbedder, FAKE_EMBEDDING_MODEL, type FakeEmbedder } from "../retrieval/fake-embedder.js";
import { buildGlobalIndex, globalOrigins } from "../retrieval/global.js";
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

  it("needs use_global for scope global or both; without global origins the global store is not read", async () => {
    const p = target("demo", repo);
    await build(p);
    await expect(searchProjectContext(deps(), p, { query: "x", scope: "global" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const g = target("demo", repo, { use_global: true });
    const gd = deps({ settings: GLOBAL_SETTINGS });
    expect(await searchProjectContext(gd, g, { query: "x", scope: "global" })).toMatchObject({
      status: "unavailable",
      reason: "GLOBAL_NOT_AVAILABLE",
      results: [],
    });
    const both = await searchProjectContext(gd, g, { query: "parseInvoiceHeader", scope: "both", limit: 1 });
    expect(both).toMatchObject({ status: "ok", reason: "GLOBAL_NOT_AVAILABLE" });
    expect(both.results[0]?.path).toBe("src/parser.ts");
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

// ---- T12.7: scope "global" and "both" read the global store ------------------------------------------------------

describe("searchProjectContext over the global store (T12.7, FR-RAG-09, FR-RAG-10)", () => {
  let repoA: string;
  let handbook: string;
  let settings: ReturnType<typeof resolveRag>;
  beforeEach(() => {
    repoA = newRepo("alpha", {
      "lib/ledger.ts": "export function reconcileLedgerBalances(entries) { return settleLedgerEntries(entries); }\n",
    });
    handbook = path.join(tmp, "handbook");
    put(handbook, "style.md", "Colour palette guidance: prefer teal accents and muted slate backgrounds.\n");
    settings = resolveRag({ ...RAG, global: { enabled: true, sources: [{ path: handbook, label: "handbook" }] } });
  });

  const toBuild = (p: SearchProject): BuildProject => ({
    id: p.id,
    effective: effectiveProjectRag(settings, p.rag),
    contexts: p.contexts.map((c) => ({ ...c, primary: true })),
  });
  /** alpha contributes, bravo (the default repo) uses the global index; both project stores and the global one built. */
  async function setup(alphaRag: ProjectRagConfig = { contribute_to_global: true }) {
    const alpha = target("alpha", repoA, alphaRag);
    const bravo = target("bravo", repo, { use_global: true });
    await build(alpha, settings);
    await build(bravo, settings);
    const r = await buildGlobalIndex(
      {
        dataDir,
        backend: fake,
        embedding: { model: FAKE_EMBEDDING_MODEL, allowRemote: false, allowSourceContent: false },
        homeDir: "/nonexistent-home",
      },
      {
        global: settings.global,
        caps: settings.caps,
        exclude: settings.exclude,
        projects: [toBuild(alpha), toBuild(bravo)],
        allowedRoots: [tmp],
      },
    );
    expect(r.outcome).toBe("ok");
    return { alpha, bravo };
  }
  const gdeps = (projects: SearchProject[]) =>
    deps({ settings, globalOrigins: () => globalOrigins(settings.global, projects.map(toBuild)) });

  it("scope global returns global-index results labelled with their origin, never the reader's own store", async () => {
    const { alpha, bravo } = await setup();
    const r = await searchProjectContext(gdeps([alpha, bravo]), bravo, {
      query: "reconcileLedgerBalances settleLedgerEntries",
      scope: "global",
    });
    expect(r.status).toBe("ok");
    expect(r.reason).toBeUndefined();
    expect(r.index_revision).toBeGreaterThan(0);
    expect(r.results[0]).toMatchObject({
      context_id: "project:alpha/main",
      path: "lib/ledger.ts",
      origin_project: "alpha",
      untrusted: true,
    });
    expect(r.results[0]?.text).toContain("reconcileLedgerBalances");
    expect(r.results[0]?.source).toBeUndefined();
    // bravo's own files are not in the global store, so the global scope never returns them
    expect(r.results.some((h) => h.path === "src/parser.ts")).toBe(false);
    for (const h of r.results) expect(h.origin_project !== undefined || h.source !== undefined).toBe(true);

    const s = await searchProjectContext(gdeps([alpha, bravo]), bravo, {
      query: "Colour palette teal accents slate",
      scope: "global",
    });
    expect(s.results[0]).toMatchObject({ context_id: "source:handbook", path: "style.md", source: "handbook" });
    expect(s.results[0]?.origin_project).toBeUndefined();
    expect(records.at(-1)).toMatchObject({ kind: "retrieval", projectKey: "bravo", outcome: "ok" });
  });

  it("scope both merges project and global hits by score under one limit", async () => {
    const { alpha, bravo } = await setup();
    const query = "parseInvoiceHeader tokenizeInvoice reconcileLedgerBalances settleLedgerEntries";
    const r = await searchProjectContext(gdeps([alpha, bravo]), bravo, { query, scope: "both", limit: 32 });
    expect(r.status).toBe("ok");
    expect(r.reason).toBeUndefined();
    const own = r.results.find((h) => h.path === "src/parser.ts");
    const shared = r.results.find((h) => h.path === "lib/ledger.ts");
    expect(own).toMatchObject({ context_id: "main" });
    expect(own?.origin_project).toBeUndefined();
    expect(own?.source).toBeUndefined();
    expect(shared).toMatchObject({ context_id: "project:alpha/main", origin_project: "alpha" });
    const scores = r.results.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // the revision is the project store's
    const projectOnly = await searchProjectContext(gdeps([alpha, bravo]), bravo, { query });
    expect(r.index_revision).toBe(projectOnly.index_revision);
    expect(projectOnly.results.some((h) => h.origin_project !== undefined || h.source !== undefined)).toBe(false);

    const one = await searchProjectContext(gdeps([alpha, bravo]), bravo, { query, scope: "both", limit: 1 });
    expect(one.results).toHaveLength(1);
    expect(one.results[0]?.snippet_id).toBe(r.results[0]?.snippet_id);
  });

  it("serves no row of a project that stopped contributing, and never a project its own contribution", async () => {
    const { bravo } = await setup();
    const query = "reconcileLedgerBalances settleLedgerEntries";
    // alpha's configuration no longer contributes; its rows are still in the store until the next global build
    const stopped = target("alpha", repoA);
    const r = await searchProjectContext(gdeps([stopped, bravo]), bravo, { query, scope: "global", limit: 32 });
    expect(r.status).toBe("ok");
    expect(r.results.some((h) => h.origin_project === "alpha")).toBe(false);
    expect(JSON.stringify(r.results)).not.toContain("reconcileLedgerBalances");

    const self = target("alpha", repoA, { contribute_to_global: true, use_global: true });
    const mine = await searchProjectContext(gdeps([self, bravo]), self, { query, scope: "global", limit: 32 });
    expect(mine.results.some((h) => h.origin_project === "alpha")).toBe(false);
  });

  it("drops a global hit whose origin file changed since the build", async () => {
    const { alpha, bravo } = await setup();
    put(repoA, "lib/ledger.ts", "export const replaced = true;\n");
    const r = await searchProjectContext(gdeps([alpha, bravo]), bravo, {
      query: "reconcileLedgerBalances settleLedgerEntries",
      scope: "global",
      limit: 32,
    });
    expect(r.results.some((h) => h.path === "lib/ledger.ts")).toBe(false);
  });

  it("scope global stays fail-closed GLOBAL_NOT_AVAILABLE when the global index is unavailable", async () => {
    const alpha = target("alpha", repoA, { contribute_to_global: true });
    const bravo = target("bravo", repo, { use_global: true });
    await build(alpha, settings);
    await build(bravo, settings);
    const globalFile = path.join(ragStoreDir(dataDir, { kind: "global" }), "index.db");
    expect(existsSync(globalFile)).toBe(false);
    const none = { status: "unavailable", reason: "GLOBAL_NOT_AVAILABLE", results: [] };

    // the global store was never built
    const calls = fake.requests.length;
    expect(await searchProjectContext(gdeps([alpha, bravo]), bravo, { query: "x", scope: "global" })).toEqual(none);
    expect(fake.requests.length).toBe(calls); // the query is not embedded
    // no global origins wired, or the origins cannot be resolved
    await setup();
    expect(await searchProjectContext(deps({ settings }), bravo, { query: "x", scope: "global" })).toEqual(none);
    const throwing = deps({
      settings,
      globalOrigins: () => {
        throw new Error("ledger unreadable");
      },
    });
    expect(await searchProjectContext(throwing, bravo, { query: "x", scope: "global" })).toEqual(none);
    expect(existsSync(globalFile)).toBe(true);

    // scope both keeps the project's results and names the global failure
    rmSync(globalFile);
    const both = await searchProjectContext(gdeps([alpha, bravo]), bravo, {
      query: "parseInvoiceHeader reconcileLedgerBalances",
      scope: "both",
      limit: 32,
    });
    expect(both).toMatchObject({ status: "ok", reason: "GLOBAL_NOT_AVAILABLE" });
    expect(both.results.some((h) => h.path === "src/parser.ts")).toBe(true);
    expect(both.results.some((h) => h.origin_project !== undefined || h.source !== undefined)).toBe(false);
  });
});

describe("search_project_context scope global on the MCP server (T12.7)", () => {
  it("returns origin-labelled global hits that match the published output schema", async () => {
    const repoA = newRepo("alpha", { "lib/ledger.ts": "export function reconcileLedgerBalances() { return 1; }\n" });
    const settings = resolveRag({ ...RAG, global: { enabled: true, sources: [] } });
    const alpha = project("alpha", repoA, { contribute_to_global: true });
    const bravo = project("bravo", repo, { use_global: true });
    const builds = [alpha, bravo].map((p) => ({
      id: p.id,
      effective: effectiveProjectRag(settings, p.rag),
      contexts: [{ id: "main", path: p.id === "alpha" ? repoA : repo, primary: true }],
    }));
    await build(target("alpha", repoA, { contribute_to_global: true }), settings);
    await build(target("bravo", repo, { use_global: true }), settings);
    await buildGlobalIndex(
      {
        dataDir,
        backend: fake,
        embedding: { model: FAKE_EMBEDDING_MODEL, allowRemote: false, allowSourceContent: false },
        homeDir: "/nonexistent-home",
      },
      {
        global: settings.global,
        caps: settings.caps,
        exclude: settings.exclude,
        projects: builds,
        allowedRoots: [tmp],
      },
    );
    const s = await connect({
      clientId: "orch",
      projects: [alpha, bravo],
      clients: { orch: ["bravo"] },
      search: deps({ settings, globalOrigins: () => globalOrigins(settings.global, builds) }),
    });
    for (const scope of ["global", "both"]) {
      const r = await s.call({ project: "bravo", query: "reconcileLedgerBalances", scope, limit: 32 });
      expect(r.isError).toBe(false);
      expect(r.body.status).toBe("ok");
      expect(r.body.results.find((h: Json) => h.path === "lib/ledger.ts")).toMatchObject({
        origin_project: "alpha",
        context_id: "project:alpha/main",
      });
    }
    await s.close();
  });
});
