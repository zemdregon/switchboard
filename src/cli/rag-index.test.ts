/**
 * `switchboard index status|rebuild|clear`, the `doctor` retrieval section and the daemon's application of operator
 * index requests (T12.4; FR-RAG-11, FR-RAG-14, LLD §14.5, §14.10, ADR-0046). The embedding backend is the in-process
 * deterministic fake (`CliIo.ragBackend`); no network, no provider.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry } from "../adapters/index.js";
import { loadConfig } from "../config/index.js";
import { openLedger, RagLedger } from "../ledger/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import { createFakeEmbedder, type FakeEmbedder } from "../retrieval/fake-embedder.js";
import { openRagStore, ragStoreDir } from "../retrieval/store.js";
import type { CliIo } from "./io.js";
import { main } from "./main.js";
import { startServeRag } from "./rag-index.js";

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

let tmp: string;
let repo: string;
let dataDir: string;
let configPath: string;
let fake: FakeEmbedder;

const RAG = { embedding: { kind: "http", base_url: "http://127.0.0.1:1", model: "test-embed" } };

function writeConfig(rag: Record<string, unknown> | undefined, projectRag?: Record<string, unknown>) {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      projects: [
        {
          id: "demo",
          name: "Demo",
          contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main" }],
          ...(projectRag !== undefined ? { rag: projectRag } : {}),
        },
        {
          id: "quiet",
          name: "Quiet",
          rag: { mode: "off" },
          contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main" }],
        },
      ],
      ...(rag !== undefined ? { rag } : {}),
    }),
  );
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-rag-cli-")));
  repo = path.join(tmp, "repo");
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.ts"), "export const alpha = 1;\n");
  writeFileSync(path.join(repo, "b.ts"), "export const bravo = 2;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  fake = createFakeEmbedder({ dimension: 8 });
  writeConfig(RAG);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const baseIo = (extra: Partial<CliIo> = {}): CliIo => ({
  stdout: { write: () => true },
  stderr: { write: () => true },
  env: {},
  user: "tester",
  homedir: path.join(tmp, "home"),
  adapters: new AdapterRegistry().register(new FakeAdapter()),
  ragBackend: fake,
  ...extra,
});

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io = baseIo({ stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, ...extra });
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

/** Run the daemon's side in process: start indexing, apply pending requests, wait for the builds. */
async function daemon(): Promise<void> {
  const config = loadConfig({ argv: ["--config", configPath], env: {} });
  const db = openLedger(dataDir);
  const log = { info: () => {}, warn: () => {} };
  const rag = startServeRag({ io: baseIo(), config, db, log });
  try {
    await rag?.applyRequests();
    await rag?.indexer.idle();
  } finally {
    await rag?.stop();
    db.close();
  }
}

const storeDir = () => ragStoreDir(dataDir, { kind: "project", projectId: "demo" });

describe("index status", () => {
  it("with no embedding backend reports retrieval off in text and JSON, and creates nothing", async () => {
    writeConfig(undefined);
    const t = await run(["index", "status"]);
    expect(t.code).toBe(0);
    expect(t.out).toContain("retrieval: off (no embedding backend configured)");
    expect(t.out).toContain("demo: off (NO_BACKEND); no index yet");
    const j = JSON.parse((await run(["index", "status", "--json"])).out);
    expect(j.backend).toBeNull();
    expect(j.stores.map((s: { project_key: string }) => s.project_key)).toEqual(["demo", "quiet"]);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("after a background build shows revision, completeness, counts and freshness; JSON has stable keys", async () => {
    expect((await run(["index", "status", "demo"])).out).toContain("demo: on; no index yet");
    await daemon();
    const t = await run(["index", "status", "demo"]);
    expect(t.code).toBe(0);
    expect(t.out).toContain("backend: local test-embed, locality local");
    expect(t.out).toMatch(/demo: on; revision 1, complete, 2 files, 2 chunks, .* fresh/);
    expect(t.out).toContain("last build: ok");
    const j = JSON.parse((await run(["index", "status", "demo", "--json"])).out);
    expect(j.schema_version).toBe(1);
    expect(j.backend).toEqual({
      kind: "local",
      model: "test-embed",
      locality: "local",
      allow_remote: false,
      allow_source_content: false,
      gate: null,
    });
    expect(j.stores[0]).toMatchObject({
      store: "project",
      project_key: "demo",
      mode: "on",
      exists: true,
      files: 2,
      chunks: 2,
      revision: 1,
      complete: true,
      stale: false,
      head_changed: false,
      base_ref_sha: git(repo, "rev-parse", "HEAD"),
      last_build: { outcome: "ok", reason: null },
      pending_requests: [],
      error: null,
    });
    expect(JSON.stringify(j)).not.toContain("alpha"); // counts only, never chunk text
  });

  it("flags a store stale once HEAD moves", async () => {
    await daemon();
    writeFileSync(path.join(repo, "c.ts"), "export const c = 3;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more");
    const j = JSON.parse((await run(["index", "status", "demo", "--json"])).out);
    expect(j.stores[0]).toMatchObject({ stale: true, head_changed: true });
    expect((await run(["index", "status", "demo"])).out).toContain("stale (HEAD moved)");
  });

  it("an unknown project is NOT_FOUND", async () => {
    const r = await run(["index", "status", "nope", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error.code).toBe("NOT_FOUND");
  });
});

describe("index clear", () => {
  it("without a daemon deletes vectors and chunk text at once and the ledger keeps only counts", async () => {
    await daemon();
    expect(existsSync(storeDir())).toBe(true);
    const r = await run(["index", "clear", "demo", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ kind: "clear", daemon_running: false });
    expect(j.requests[0]).toMatchObject({
      project_key: "demo",
      status: "applied",
      cleared: { removed: true, files: 2, chunks: 2 },
    });
    expect(existsSync(storeDir())).toBe(false);

    const db = openLedger(dataDir);
    try {
      const rows = db.prepare("SELECT * FROM rag_record WHERE kind = 'clear'").all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        project_key: "demo",
        outcome: "ok",
        files: 2,
        chunks: 2,
        snippet_ids_json: null,
      });
      expect(JSON.stringify(rows)).not.toContain("alpha");
      expect(new RagLedger(db).pending()).toEqual([]);
      // rag_record is append-only
      expect(() => db.prepare("UPDATE rag_record SET outcome = 'x'").run()).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM rag_record").run()).toThrow(/append-only/);
    } finally {
      db.close();
    }
    expect((await run(["index", "clear", "demo"])).out).toContain("demo: nothing stored; recorded");
  });

  it("while serve holds the lock only records the request; the daemon applies it", async () => {
    await daemon();
    const lock = acquireDataDirLock(dataDir);
    let text: string;
    try {
      const r = await run(["index", "clear", "demo"]);
      expect(r.code).toBe(0);
      text = r.out;
    } finally {
      lock.release();
    }
    expect(text).toContain("demo: clear requested; the running serve daemon applies it within a second");
    expect(existsSync(storeDir())).toBe(true);
    const pending = JSON.parse((await run(["index", "status", "demo", "--json"])).out).stores[0].pending_requests;
    expect(pending).toMatchObject([{ kind: "clear", requested_by: "tester" }]);

    // The daemon applies the clear first, then its start-up build recreates the index for a project still on.
    const config = loadConfig({ argv: ["--config", configPath], env: {} });
    const db = openLedger(dataDir);
    const rag = startServeRag({ io: baseIo(), config, db, log: { info: () => {}, warn: () => {} } });
    try {
      await rag?.applyRequests();
      const req = db.prepare("SELECT outcome, detail FROM rag_request").get();
      expect(req).toEqual({ outcome: "applied", detail: "files=2 chunks=2" });
      const cleared = db.prepare("SELECT files, chunks FROM rag_record WHERE kind = 'clear'").get();
      expect(cleared).toEqual({ files: 2, chunks: 2 });
    } finally {
      await rag?.stop();
      db.close();
    }
  });
});

describe("index rebuild", () => {
  it("records a request that serve applies: the store is rebuilt from scratch in the background", async () => {
    await daemon();
    const embedded = fake.requests.flat().length;
    const r = await run(["index", "rebuild", "demo", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      kind: "rebuild",
      requests: [{ project_key: "demo", status: "requested" }],
    });
    expect((await run(["index", "rebuild"])).out).toContain("demo: rebuild requested; serve applies it when it starts");
    await daemon();
    expect(fake.requests.flat().length - embedded).toBe(2); // both files embedded again, once
    const j = JSON.parse((await run(["index", "status", "demo", "--json"])).out);
    expect(j.stores[0]).toMatchObject({ revision: 1, complete: true, pending_requests: [] });
  });

  it("refuses global while it is off, an unknown project and a project with retrieval off", async () => {
    expect((await run(["index", "rebuild", "global"])).code).toBe(2);
    expect((await run(["index", "rebuild", "nope"])).code).toBe(1);
    const off = await run(["index", "rebuild", "quiet"]);
    expect(off.code).toBe(2);
    expect(off.err).toContain("retrieval is off for project quiet (PROJECT_OFF)");
    expect((await run(["index", "frobnicate"])).code).toBe(2);
  });
});

describe("global index (T12.7)", () => {
  it("serve builds it after the projects from contributions only, and rebuild global is accepted", async () => {
    writeConfig({ ...RAG, global: { enabled: true } }, { contribute_to_global: true });
    await daemon();
    const store = openRagStore(dataDir, { kind: "global" });
    try {
      expect(store.db.prepare("SELECT path, origin_project FROM rag_file ORDER BY path").all()).toEqual([
        { path: "project:demo/main/a.ts", origin_project: "demo" },
        { path: "project:demo/main/b.ts", origin_project: "demo" },
      ]);
    } finally {
      store.close();
    }
    const r = await run(["index", "rebuild", "global", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).requests).toMatchObject([{ project_key: null, status: "requested" }]);
    await daemon();
    const db = openLedger(dataDir);
    try {
      const built = db
        .prepare("SELECT outcome FROM rag_record WHERE kind = 'index_built' AND project_key IS NULL")
        .all() as { outcome: string }[];
      expect(built.map((b) => b.outcome)).toEqual(["ok", "ok"]);
      expect(db.prepare("SELECT outcome, detail FROM rag_request WHERE project_key IS NULL").get()).toMatchObject({
        outcome: "applied",
        detail: "QUEUED",
      });
    } finally {
      db.close();
    }
  });

  it("is not built while off, even for a project that sets contribute_to_global", async () => {
    writeConfig(RAG, { contribute_to_global: true });
    await daemon();
    expect(existsSync(ragStoreDir(dataDir, { kind: "global" }))).toBe(false);
  });
});

describe("doctor retrieval section", () => {
  it("is absent without an embedding backend", async () => {
    writeConfig(undefined);
    const j = JSON.parse((await run(["doctor", "--json"])).out);
    expect(j.retrieval).toBeUndefined();
    expect((await run(["doctor"])).out).not.toContain("Retrieval index:");
  });

  it("reports backend, locality, probe, index size, revision and staleness without changing ok", async () => {
    await daemon();
    const t = await run(["doctor"]);
    expect(t.out).toContain("Retrieval index:");
    expect(t.out).toContain("[ok]   Retrieval backend: local test-embed, locality local");
    expect(t.out).toContain("[ok]   Retrieval backend probe: reachable, dimension 8");
    expect(t.out).toMatch(/\[ok\] {3}Index demo: on; revision 1, complete, 2 files/);
    expect(t.out).toContain("[skip] Index quiet: off (PROJECT_OFF)");
    const j = JSON.parse((await run(["doctor", "--json"])).out);
    expect(j.retrieval.probe).toEqual({ attempted: true, reachable: true, dimension: 8, detail: "OK" });
    expect(j.retrieval.stores[0]).toMatchObject({ project_key: "demo", revision: 1, complete: true, stale: false });
  });

  it("does not probe a remote backend the gate refuses", async () => {
    const remote = createFakeEmbedder({ locality: "remote" });
    let probed = false;
    const spy = {
      ...remote,
      probe: async (s: AbortSignal) => {
        probed = true;
        return remote.probe(s);
      },
    };
    const t = await run(["doctor"], { ragBackend: spy });
    expect(t.out).toContain("[warn] Retrieval backend: local test-embed, locality remote; refused by the privacy gate");
    expect(t.out).toContain("[skip] Retrieval backend probe: not attempted (REMOTE_NOT_ALLOWED)");
    expect(probed).toBe(false);
  });
});

describe("context pack wiring (T12.5)", () => {
  async function withRag<T>(
    fn: (rag: NonNullable<ReturnType<typeof startServeRag>>, db: ReturnType<typeof openLedger>) => Promise<T>,
  ) {
    const config = loadConfig({ argv: ["--config", configPath], env: {} });
    const db = openLedger(dataDir);
    const rag = startServeRag({ io: baseIo(), config, db, log: { info: () => {}, warn: () => {} } });
    if (rag === undefined) throw new Error("retrieval did not start");
    try {
      return await fn(rag, db);
    } finally {
      await rag.stop();
      db.close();
    }
  }
  const ask = (rag: NonNullable<ReturnType<typeof startServeRag>>, projectId = "demo") =>
    rag.prepareContextPack({
      runId: "run_01TESTTESTTESTTESTTESTTEST",
      projectId,
      objective: "export const alpha",
      baseCommit: null,
      signal: new AbortController().signal,
    });

  it("records one retrieval row with snippet ids and hashes, no text, and returns a bounded event", async () => {
    await withRag(async (rag, db) => {
      await rag.indexer.idle();
      const out = await ask(rag);
      expect(out?.text).toContain("UNTRUSTED REFERENCE DATA");
      expect(out?.event).toMatchObject({ outcome: "ok", revision: 1, flags: [], dropped_changed: 0 });
      const row = db.prepare("SELECT * FROM rag_record WHERE kind = 'retrieval'").get() as Record<
        string,
        string | number | null
      >;
      expect(row).toMatchObject({ id: out?.event.record_id, project_key: "demo", outcome: "ok", revision: 1 });
      expect(row.run_id).toBe("run_01TESTTESTTESTTESTTESTTEST");
      const snippets = JSON.parse(row.snippet_ids_json as string) as { id: string; text_sha256: string }[];
      expect(snippets.length).toBe(out?.event.snippets);
      for (const s of snippets) {
        expect(Object.keys(s).sort()).toEqual(["id", "text_sha256"]);
        expect(s.id).toMatch(/^chk_[0-9a-f]{24}$/);
        expect(s.text_sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      // No retrieved text anywhere in the ledger row.
      expect(JSON.stringify(row)).not.toContain("alpha");
    });
  });

  it("a project with retrieval off is inert; a missing store is skipped and recorded", async () => {
    await withRag(async (rag, db) => {
      expect(await ask(rag, "quiet")).toBeUndefined();
      await rag.indexer.stop(); // nothing builds meanwhile: the store stays missing
      const out = await ask(rag);
      expect(out).toMatchObject({ text: null, event: { outcome: "skipped", reason: "NO_INDEX" } });
      expect(db.prepare("SELECT outcome, reason FROM rag_record WHERE kind = 'retrieval'").all()).toEqual([
        { outcome: "skipped", reason: "NO_INDEX" },
      ]);
    });
  });
});
