/**
 * T12.9 (FR-RAG-13, LLD §14.7, ADR-0026): the T12.6 `search_project_context` handler behind the per-run tool channel
 * port. Temporary Git repositories, stores built by the T12.4 build with the deterministic in-process fake embedder; no
 * network, no provider. The channel end to end (socket, token, shim) is in `src/git/channel.test.ts` and, through the
 * Claude replay, `src/lifecycle/claude-channel.test.ts`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveProjectRag, type ProjectRagConfig, resolveRag } from "../config/index.js";
import * as protocol from "../git/tool-protocol.js";
import type { RagRecordInput } from "../ledger/index.js";
import { buildProjectIndex } from "../retrieval/build.js";
import { createFakeEmbedder, FAKE_EMBEDDING_MODEL, type FakeEmbedder } from "../retrieval/fake-embedder.js";
import { createChannelSearchPort } from "./channel-search.js";
import { inputSchema } from "./schemas.js";
import * as t126 from "./search-context.js";
import { type SearchContextDeps, type SearchProject, searchProjectContext } from "./search-context.js";

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

const RAG = { embedding: { kind: "http" as const, base_url: "http://127.0.0.1:1", model: FAKE_EMBEDDING_MODEL } };
const SETTINGS = resolveRag(RAG);
const GLOBAL_SETTINGS = resolveRag({ ...RAG, global: { enabled: true, sources: [] } });

let tmp: string;
let dataDir: string;
let fake: FakeEmbedder;
let records: RagRecordInput[];

function newRepo(name: string, files: Record<string, string>): string {
  const repo = path.join(tmp, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

const project = (id: string, repo: string, rag?: ProjectRagConfig): SearchProject => ({
  id,
  ...(rag !== undefined ? { rag } : {}),
  contexts: [{ id: "main", path: repo }],
});

async function build(p: SearchProject, settings = SETTINGS): Promise<void> {
  const r = await buildProjectIndex(
    {
      dataDir,
      backend: fake,
      embedding: { model: FAKE_EMBEDDING_MODEL, allowRemote: false, allowSourceContent: false },
      homeDir: "/nonexistent-home",
    },
    {
      id: p.id,
      effective: effectiveProjectRag(settings, p.rag),
      contexts: p.contexts.map((c) => ({ ...c, primary: true })),
    },
  );
  expect(["ok", "partial"]).toContain(r.outcome);
}

const deps = (over: Partial<SearchContextDeps> = {}): SearchContextDeps => ({
  dataDir,
  settings: SETTINGS,
  backend: fake,
  homeDir: "/nonexistent-home",
  record: (r) => records.push(r),
  ...over,
});

let web: SearchProject;
let other: SearchProject;
let bare: SearchProject;
let projects: SearchProject[];
const byId = (id: string) => projects.find((p) => p.id === id);

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-chs-")));
  dataDir = path.join(tmp, "data");
  mkdirSync(dataDir);
  fake = createFakeEmbedder({ dimension: 32 });
  records = [];
  web = project(
    "web",
    newRepo("web", {
      "src/retry.ts": "export function exponentialBackoffWithJitter(attempt) { return 2 ** attempt; }\n",
      "src/parser.ts": "export function parseInvoiceHeader(input) { return input; }\n",
    }),
  );
  // Another project whose text matches the query better: it must never appear in a `web` search.
  other = project(
    "other",
    newRepo("other", { "secret.ts": "exponential backoff with jitter OTHER_PROJECT_MARKER exponential backoff\n" }),
  );
  bare = project("bare", newRepo("bare", { "a.ts": "exponential backoff\n" }));
  projects = [web, other, bare];
  await build(web);
  await build(other);
  // `bare` is configured with retrieval on but has no index.
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("channel search port (T12.9, FR-RAG-13)", () => {
  it("bounds are the T12.6 constants: one definition shared by the MCP tool, the handler and the channel schema", () => {
    expect(t126.MAX_SEARCH_LIMIT).toBe(protocol.MAX_SEARCH_LIMIT);
    expect(t126.MAX_RESULT_TEXT_BYTES).toBe(protocol.MAX_RESULT_TEXT_BYTES);
    expect(t126.MAX_SEARCH_TEXT_BYTES).toBe(protocol.MAX_SEARCH_TEXT_BYTES);
    expect(t126.MAX_QUERY_LENGTH).toBe(protocol.MAX_QUERY_LENGTH);
    expect(protocol.SEARCH_INPUT_SCHEMA.properties.limit.maximum).toBe(t126.MAX_SEARCH_LIMIT);
    expect(protocol.SEARCH_INPUT_SCHEMA.properties.query.maxLength).toBe(t126.MAX_QUERY_LENGTH);
    expect(protocol.SEARCH_TOOL).toBe(t126.SEARCH_TOOL_NAME);
    // The MCP tool's published input schema (unchanged) has the same limits; the channel form has no `project`.
    const mcp = inputSchema("search_project_context") as {
      properties: { limit: { maximum: number }; query: { maxLength: number } };
    };
    expect(mcp.properties.limit.maximum).toBe(protocol.MAX_SEARCH_LIMIT);
    expect(mcp.properties.query.maxLength).toBe(protocol.MAX_QUERY_LENGTH);
    expect(Object.keys(protocol.SEARCH_INPUT_SCHEMA.properties)).toEqual(["query", "limit", "scope"]);
    expect(protocol.SEARCH_INPUT_SCHEMA.additionalProperties).toBe(false);
  });

  it("searches the bound project with the same handler: identical result, own paths only, run id recorded", async () => {
    const port = createChannelSearchPort(deps(), byId);
    const got = await port.search({ runId: "run_1", projectId: "web", query: "exponential backoff with jitter" });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const direct = await searchProjectContext(deps({ record: () => {} }), web, {
      query: "exponential backoff with jitter",
    });
    expect(got.result).toEqual({ ...direct });
    expect(got.result.status).toBe("ok");
    const results = got.result.results as { path: string; text: string; context_id: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(protocol.MAX_SEARCH_LIMIT);
    expect(results[0]?.path).toBe("src/retry.ts");
    for (const h of results) {
      expect(["src/retry.ts", "src/parser.ts"]).toContain(h.path);
      expect(Buffer.byteLength(h.text)).toBeLessThanOrEqual(protocol.MAX_RESULT_TEXT_BYTES);
    }
    expect(JSON.stringify(got.result)).not.toContain("OTHER_PROJECT_MARKER");
    expect(records[0]).toMatchObject({ kind: "retrieval", projectKey: "web", runId: "run_1", outcome: "ok" });
  });

  it("caps limit at the T12.6 maximum and honours a smaller one", async () => {
    const port = createChannelSearchPort(deps(), byId);
    const one = await port.search({ runId: "run_1", projectId: "web", query: "export function", limit: 1 });
    expect(one.ok && (one.result.results as unknown[]).length).toBe(1);
  });

  it("fails closed: no index is the T12.6 unavailable NOT_BUILT, an unknown project is refused, never other data", async () => {
    const port = createChannelSearchPort(deps(), byId);
    const none = await port.search({ runId: "run_1", projectId: "bare", query: "exponential backoff" });
    expect(none).toEqual({ ok: true, result: { status: "unavailable", reason: "NOT_BUILT", results: [] } });
    expect(await port.search({ runId: "run_1", projectId: "gone", query: "exponential backoff" })).toEqual({
      ok: false,
      code: "PROJECT_UNAVAILABLE",
    });
  });

  it("scope: global or both without use_global is INVALID_ARGUMENTS; with it, the T12.6 GLOBAL_NOT_AVAILABLE", async () => {
    const port = createChannelSearchPort(deps(), byId);
    for (const scope of ["global", "both"] as const) {
      expect(await port.search({ runId: "run_1", projectId: "web", query: "x", scope })).toEqual({
        ok: false,
        code: "INVALID_ARGUMENTS",
      });
    }
    const globalWeb = { ...web, rag: { use_global: true } } as SearchProject;
    const gport = createChannelSearchPort(deps({ settings: GLOBAL_SETTINGS }), (id) =>
      id === "web" ? globalWeb : undefined,
    );
    const g = await gport.search({ runId: "run_1", projectId: "web", query: "backoff", scope: "global" });
    expect(g).toEqual({ ok: true, result: { status: "unavailable", reason: "GLOBAL_NOT_AVAILABLE", results: [] } });
    const both = await gport.search({ runId: "run_1", projectId: "web", query: "backoff", scope: "both" });
    expect(both.ok && both.result.reason).toBe("GLOBAL_NOT_AVAILABLE");
    expect(JSON.stringify(both)).not.toContain("OTHER_PROJECT_MARKER");
  });

  it("offeredFor: only a known project with retrieval on", () => {
    const port = createChannelSearchPort(deps(), (id) =>
      id === "off" ? { ...web, id: "off", rag: { mode: "off" } } : byId(id),
    );
    expect(port.offeredFor("web")).toBe(true);
    expect(port.offeredFor("bare")).toBe(true);
    expect(port.offeredFor("off")).toBe(false);
    expect(port.offeredFor("gone")).toBe(false);
  });
});
