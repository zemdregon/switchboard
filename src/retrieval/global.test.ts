/**
 * Global index and sharing rules (T12.7; FR-RAG-09, FR-RAG-10, LLD §14.9). Temporary directories, the T12.4 project
 * build and the deterministic in-process fake embedder only; no network, no provider.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveProjectRag, type ProjectRagConfig, type RagSettings, resolveRag } from "../config/index.js";
import { type ContextPackDeps, retrieveContextPack } from "./admission.js";
import { type BuildContext, type BuildDeps, type BuildProject, buildProjectIndex } from "./build.js";
import { createFakeEmbedder, type FakeEmbedder } from "./fake-embedder.js";
import {
  buildGlobalIndex,
  contributingContextIds,
  type GlobalBuildInput,
  globalOrigins,
  isUntrustedProfile,
} from "./global.js";
import { openRagStore, ragStoreDir } from "./store.js";

const EMBEDDING = { model: "m1", allowRemote: false, allowSourceContent: false };
const BUILT_AT = new Date("2026-10-14T12:00:00.000Z");

let tmp: string;
let repoA: string;
let repoB: string;
let source: string;
let dataDir: string;
let fake: FakeEmbedder;
let settings: RagSettings;

const put = (base: string, rel: string, content: string) => {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};
const lines = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${tag} ${tag}${i % 5} ${tag}`).join("\n");

function settingsWith(global: { enabled: boolean } | undefined): RagSettings {
  return resolveRag({
    embedding: { kind: "http", base_url: "http://127.0.0.1:1", model: "m1" },
    ...(global !== undefined ? { global: { ...global, sources: [{ path: source, label: "handbook" }] } } : {}),
  });
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-rag-global-")));
  repoA = path.join(tmp, "a");
  repoB = path.join(tmp, "b");
  source = path.join(tmp, "handbook");
  dataDir = path.join(tmp, "data");
  put(repoA, "parser.ts", lines("parser", 30));
  put(repoA, "notes/private.md", lines("private", 10));
  put(repoB, "widget.ts", lines("widget", 30));
  put(source, "colour.md", lines("colour", 10));
  fake = createFakeEmbedder({ dimension: 32 });
  settings = settingsWith({ enabled: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const proj = (
  id: string,
  root: string,
  rag: ProjectRagConfig | undefined,
  over: Partial<BuildProject> = {},
  ctx: Partial<BuildContext> = {},
): BuildProject => ({
  id,
  effective: effectiveProjectRag(settings, rag),
  contexts: [{ id: "main", path: root, primary: true, ...ctx }],
  ...over,
});

const deps = (over: Partial<BuildDeps> = {}): BuildDeps => ({
  dataDir,
  backend: fake,
  embedding: EMBEDDING,
  homeDir: "/nonexistent-home",
  now: () => BUILT_AT,
  ...over,
});

const globalInput = (projects: BuildProject[], over: Partial<GlobalBuildInput> = {}): GlobalBuildInput => ({
  global: settings.global,
  caps: settings.caps,
  exclude: settings.exclude,
  projects,
  allowedRoots: [tmp],
  ...over,
});

async function buildAll(projects: BuildProject[], over: Partial<GlobalBuildInput> = {}) {
  for (const p of projects) expect((await buildProjectIndex(deps(), p)).outcome).toBe("ok");
  return buildGlobalIndex(deps(), globalInput(projects, over));
}

function globalFiles() {
  const store = openRagStore(dataDir, { kind: "global" });
  try {
    return store.db.prepare("SELECT path, context_id, origin_project FROM rag_file ORDER BY path").all() as {
      path: string;
      context_id: string;
      origin_project: string | null;
    }[];
  } finally {
    store.close();
  }
}

const packDeps = (): ContextPackDeps => ({
  dataDir,
  backend: fake,
  embedding: EMBEDDING,
  retrieval: settings.retrieval,
  homeDir: "/nonexistent-home",
  now: () => new Date(BUILT_AT.getTime() + 60_000),
  nonce: () => "n0nce",
});

describe("sharing rules (FR-RAG-09)", () => {
  it("are off on every side by default", () => {
    const def = settingsWith(undefined);
    const p: BuildProject = {
      id: "alpha",
      effective: effectiveProjectRag(def, { use_global: true, contribute_to_global: true }),
      contexts: [{ id: "main", path: repoA, primary: true }],
    };
    expect(p.effective).toMatchObject({ enabled: true, useGlobal: false, contributeToGlobal: false });
    expect(contributingContextIds(p).size).toBe(0);
    expect(globalOrigins(def.global, [p]).size).toBe(0);
    // Global enabled, project silent: neither flag.
    expect(effectiveProjectRag(settings, undefined)).toMatchObject({ useGlobal: false, contributeToGlobal: false });
    // Neither flag implies the other.
    expect(effectiveProjectRag(settings, { use_global: true })).toMatchObject({ contributeToGlobal: false });
    expect(effectiveProjectRag(settings, { contribute_to_global: true })).toMatchObject({ useGlobal: false });
  });

  it("withhold a context that opts out or is off, and an untrusted project's contexts unless they opt in", () => {
    const on = { contribute_to_global: true };
    expect([...contributingContextIds(proj("alpha", repoA, on))]).toEqual(["main"]);
    expect(contributingContextIds(proj("alpha", repoA, on, {}, { rag: { contribute_to_global: false } })).size).toBe(0);
    expect(contributingContextIds(proj("alpha", repoA, on, {}, { rag: { mode: "off" } })).size).toBe(0);
    expect(contributingContextIds(proj("alpha", repoA, on, { untrusted: true })).size).toBe(0);
    expect([
      ...contributingContextIds(proj("alpha", repoA, on, { untrusted: true }, { rag: { contribute_to_global: true } })),
    ]).toEqual(["main"]);
    // A context's opt-in does not make a non-contributing project contribute.
    expect(
      contributingContextIds(proj("alpha", repoA, undefined, {}, { rag: { contribute_to_global: true } })).size,
    ).toBe(0);
    expect(isUntrustedProfile("inspect-untrusted")).toBe(true);
    expect(isUntrustedProfile("edit-untrusted")).toBe(true);
    expect(isUntrustedProfile("trusted-development")).toBe(false);
    expect(isUntrustedProfile(undefined)).toBe(false);
  });
});

describe("buildGlobalIndex (FR-RAG-09)", () => {
  it("creates nothing while the global index is off, or when the locality gate refuses the backend", async () => {
    settings = settingsWith(undefined);
    const off = await buildGlobalIndex(deps(), globalInput([]));
    expect(off).toMatchObject({ projectKey: null, outcome: "skipped", reason: "GLOBAL_OFF" });
    settings = settingsWith({ enabled: true });
    const remote = createFakeEmbedder({ dimension: 32, locality: "remote" });
    const gated = await buildGlobalIndex(deps({ backend: remote }), globalInput([]));
    expect(gated).toMatchObject({ outcome: "skipped", reason: "REMOTE_NOT_ALLOWED", locality: "remote" });
    expect(remote.requests).toEqual([]);
    expect(existsSync(ragStoreDir(dataDir, { kind: "global" }))).toBe(false);
  });

  it("holds operator sources and contributing projects only, each row labelled with its origin", async () => {
    const a = proj("alpha", repoA, { contribute_to_global: true });
    const b = proj("bravo", repoB, undefined);
    const r = await buildAll([a, b]);
    expect(r).toMatchObject({ projectKey: null, outcome: "ok", complete: true });
    expect(globalFiles()).toEqual([
      { path: "project:alpha/main/notes/private.md", context_id: "project:alpha/main", origin_project: "alpha" },
      { path: "project:alpha/main/parser.ts", context_id: "project:alpha/main", origin_project: "alpha" },
      { path: "source:handbook/colour.md", context_id: "source:handbook", origin_project: null },
    ]);
    // Contributions copy vectors: the global build embedded the source only.
    expect(r.embedCalls).toBe(1);
    const unchanged = await buildGlobalIndex(deps(), globalInput([a, b]));
    expect(unchanged).toMatchObject({ outcome: "ok", filesEmbedded: 0, embedCalls: 0, revision: r.revision });
  });

  it("removes a project's rows when it stops contributing, and re-applies the exclusions to contributions", async () => {
    const a = proj("alpha", repoA, { contribute_to_global: true });
    await buildAll([a]);
    const excluded = proj("alpha", repoA, { contribute_to_global: true, exclude: ["notes/**"] });
    await buildGlobalIndex(deps(), globalInput([excluded])); // the project store still holds notes/private.md
    expect(globalFiles().map((f) => f.path)).toEqual(["project:alpha/main/parser.ts", "source:handbook/colour.md"]);
    const r = await buildGlobalIndex(deps(), globalInput([proj("alpha", repoA, undefined)]));
    expect(r.filesRemoved).toBe(1);
    expect(globalFiles().map((f) => f.path)).toEqual(["source:handbook/colour.md"]);
  });

  it("does not take an untrusted project's content unless the context opts in", async () => {
    const a = proj("alpha", repoA, { contribute_to_global: true }, { untrusted: true });
    await buildAll([a]);
    expect(globalFiles().map((f) => f.origin_project)).toEqual([null]);
  });

  it("drops a source outside the allowed roots (fail closed)", async () => {
    const r = await buildAll([], { allowedRoots: [repoA] });
    expect(r).toMatchObject({ outcome: "partial", reason: "source_outside_roots" });
    expect(existsSync(path.join(ragStoreDir(dataDir, { kind: "global" }), "index.db"))).toBe(true);
    expect(globalFiles()).toEqual([]);
  });
});

describe("global snippets at admission (FR-RAG-10)", () => {
  async function setup(aRag: ProjectRagConfig | undefined, bRag: ProjectRagConfig | undefined) {
    const a = proj("alpha", repoA, aRag);
    const b = proj("bravo", repoB, bRag);
    await buildAll([a, b]);
    return { a, b, origins: globalOrigins(settings.global, [a, b]) };
  }
  const ask = (
    p: BuildProject,
    origins: ReturnType<typeof globalOrigins>,
    objective = "parser parser0 parser1 parser2 parser3 parser4",
  ) => retrieveContextPack(packDeps(), { project: p, objective, baseCommit: null, globalOrigins: origins });

  it("reach project B only when A contributes and B uses, each labelled with its origin", async () => {
    const { b, origins } = await setup({ contribute_to_global: true }, { use_global: true });
    const r = await ask(b, origins);
    expect(r.outcome).toBe("ok");
    expect(r.globalSnippets).toBeGreaterThan(0);
    expect(r.globalRevision).not.toBeNull();
    const text = r.text as string;
    expect(text).toContain("deployment-wide index");
    expect(text).toMatch(/--- snippet \d+: origin_project "alpha" context "main" path "parser\.ts" lines 1-30 /);
    const s = await ask(b, origins, "colour colour0 colour");
    expect(s.text).toMatch(/--- snippet \d+: source "handbook" path "colour\.md" /);
  });

  it("do not reach B when B does not use the global index", async () => {
    const { b, origins } = await setup({ contribute_to_global: true }, undefined);
    const r = await ask(b, origins);
    expect(r.globalSnippets).toBe(0);
    expect(r.globalRevision).toBeNull();
    expect(r.text ?? "").not.toContain("parser");
  });

  it("do not reach B once A stops contributing, even before the next build removes A's rows", async () => {
    const { b } = await setup({ contribute_to_global: true }, { use_global: true });
    const now = globalOrigins(settings.global, [proj("alpha", repoA, undefined), b]);
    const r = await ask(b, now);
    expect(r.text ?? "").not.toContain('origin_project "alpha"');
    expect(r.text ?? "").not.toContain("parser parser0");
  });

  it("never serve a project its own contribution from the global store", async () => {
    const { a, origins } = await setup({ contribute_to_global: true, use_global: true }, undefined);
    const r = await ask(a, origins);
    expect(r.outcome).toBe("ok");
    expect(r.text).not.toContain('origin_project "alpha"');
    expect(r.text).toContain('context "main" path "parser.ts"');
  });

  it("drop a global snippet whose origin file changed, and flag a missing global store without failing", async () => {
    const { b, origins } = await setup({ contribute_to_global: true }, { use_global: true });
    put(repoA, "parser.ts", `${lines("parser", 30)}\nchanged`);
    const r = await ask(b, origins);
    expect(r.text ?? "").not.toContain('path "parser.ts"');
    expect(r.droppedChanged).toBeGreaterThan(0);
    rmSync(ragStoreDir(dataDir, { kind: "global" }), { recursive: true });
    const missing = await ask(b, origins, "widget widget0");
    expect(missing.outcome).toBe("ok");
    expect(missing.flags).toContain("global_unavailable");
  });
});
