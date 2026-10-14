/**
 * Incremental index build for one project store (T12.4; FR-RAG-11, LLD §14.5, ADR-0031).
 *
 * 1. **Gate first**: retrieval off for the project, or a backend the §14.4 table refuses, returns `skipped` with the
 *    reason code before any store is opened or created.
 * 2. **Scan** every context of the project (`scanContext`, §14.3) with the project's caps shared across contexts; a
 *    context's `rag` block narrows it (`scanOptionsForContext`).
 * 3. **Diff** by content hash against `rag_file`: new or changed files are embedded, files no longer listed are removed
 *    (their chunks cascade), unchanged files are kept untouched. A context whose scan failed keeps its rows.
 * 4. **Embed and commit** changed files in bounded batches through `embedGated` (the gate is evaluated again for every
 *    batch); each batch is one SQLite transaction that bumps `revision` and leaves `complete = 0`, and the loop yields
 *    to the event loop between batches, so a build never holds the daemon's thread for long.
 * 5. **Finish**: `complete = 1` only when every scan reached its end within the caps and nothing stopped the build;
 *    otherwise the outcome is `partial` (a cap, `max_build_ms`, an unreadable context or an abort) or `failed` (a gate
 *    denial or backend error mid-build), with the reason code. A crash leaves the last committed batch; the next build
 *    resumes by diff.
 *
 * Delegated choices (T12.4): the store path of a file is `<context id>/<path relative to the context root>` (context ids
 * cannot contain `/`), so two contexts of one project never collide, and chunk ids are derived from that store path;
 * `base_ref_sha` is the primary context's `HEAD` when it is a Git repository (the scan reads the checked-out tree); a
 * stored model, dimension or schema that differs from the configuration wipes the store first, and a dimension change
 * seen mid-build wipes it and starts again once; vectors are stored as the platform's float32 bytes (little-endian on
 * every supported platform). Nothing here imports the ledger: the caller records the result (`rag_record`).
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { ContextRagConfig, EffectiveProjectRag } from "../config/index.js";
import { gitText } from "../workspace/git.js";
import { type Chunk, chunkId } from "./chunk.js";
import {
  type EmbeddingBackend,
  type EmbeddingCallRecorder,
  embedGated,
  evaluateEmbeddingGate,
  type Locality,
} from "./embedding.js";
import { scanOptionsForContext } from "./options.js";
import { type ScannedFile, scanContext } from "./scan.js";
import { needsRebuild, openRagStore, type RagMeta, type RagStore, wipeRagStore } from "./store.js";

/** Chunks per embedding batch and per transaction (Assumption, Delegated: the `http` backend's request size). */
export const BUILD_BATCH_CHUNKS = 32;

export interface BuildContext {
  readonly id: string;
  readonly path: string;
  readonly primary: boolean;
  readonly rag?: ContextRagConfig;
}

export interface BuildProject {
  readonly id: string;
  readonly contexts: readonly BuildContext[];
  readonly effective: EffectiveProjectRag;
  /** T12.7 (Q-50): the project's `max_trust_profile` is an untrusted one; its contexts contribute only when they opt in. */
  readonly untrusted?: boolean;
}

export type BuildOutcome = "ok" | "partial" | "failed" | "skipped";

export interface BuildResult {
  /** The project id, or null for the global store (T12.7). */
  readonly projectKey: string | null;
  readonly outcome: BuildOutcome;
  /** A cap name, `max_build_ms`, `aborted`, `context_unreadable`, a gate reason or a backend code; null when `ok`. */
  readonly reason: string | null;
  readonly revision: number | null;
  readonly complete: boolean;
  /** Store totals after the build. */
  readonly files: number;
  readonly chunks: number;
  readonly bytes: number;
  readonly filesEmbedded: number;
  readonly filesRemoved: number;
  readonly embedCalls: number;
  readonly durationMs: number;
  readonly backendKind: "local" | "http";
  readonly locality: Locality | null;
  readonly modelId: string;
}

export interface BuildDeps {
  readonly dataDir: string;
  readonly backend: EmbeddingBackend;
  /** `rag.embedding`: the configured model and the installation's gates. */
  readonly embedding: { readonly model: string; readonly allowRemote: boolean; readonly allowSourceContent: boolean };
  readonly recorder?: EmbeddingCallRecorder;
  readonly batchChunks?: number;
  readonly signal?: AbortSignal;
  readonly homeDir?: string;
  /** Wall clock for `built_at`. */
  readonly now?: () => Date;
  /** Monotonic milliseconds for `max_build_ms` and durations. */
  readonly clock?: () => number;
  /** `HEAD` of a context root, or null; default reads it with the hardened Git helper. */
  readonly headOf?: (root: string) => Promise<string | null>;
}

interface Planned {
  readonly storePath: string;
  readonly contextId: string;
  readonly file: ScannedFile;
  readonly chunks: Chunk[];
}

/** `HEAD` of a Git context root, or null for a non-Git context or any Git error. */
export async function contextHead(root: string): Promise<string | null> {
  try {
    await lstat(path.join(root, ".git"));
    return await gitText(["rev-parse", "--verify", "HEAD"], { cwd: root });
  } catch {
    return null;
  }
}

export async function buildProjectIndex(deps: BuildDeps, project: BuildProject): Promise<BuildResult> {
  const clock = deps.clock ?? (() => performance.now());
  const t0 = clock();
  const signal = deps.signal ?? new AbortController().signal;
  const base = {
    projectKey: project.id,
    backendKind: deps.backend.kind,
    modelId: deps.embedding.model,
    filesEmbedded: 0,
    filesRemoved: 0,
    embedCalls: 0,
  };
  const skipped = (reason: string, locality: Locality | null): BuildResult => ({
    ...base,
    outcome: "skipped",
    reason,
    revision: null,
    complete: false,
    files: 0,
    chunks: 0,
    bytes: 0,
    durationMs: Math.max(0, Math.round(clock() - t0)),
    locality,
  });

  const effective = project.effective;
  if (!effective.enabled) return skipped(effective.reason, null);
  let locality: Locality;
  try {
    locality = await deps.backend.resolveLocality(signal);
  } catch {
    locality = "remote"; // unresolved is remote (LLD §13.2)
  }
  const gate = evaluateEmbeddingGate({ projectEnabled: true, locality, ...deps.embedding });
  if (!gate.allowed) return skipped(gate.reason, locality);

  const store = openRagStore(deps.dataDir, { kind: "project", projectId: project.id });
  try {
    return await buildInto(deps, project, store, { t0, clock, signal, locality, base }, false);
  } finally {
    store.close();
  }
}

interface RunState {
  readonly t0: number;
  readonly clock: () => number;
  readonly signal: AbortSignal;
  readonly locality: Locality;
  readonly base: Pick<
    BuildResult,
    "projectKey" | "backendKind" | "modelId" | "filesEmbedded" | "filesRemoved" | "embedCalls"
  >;
}

async function buildInto(
  deps: BuildDeps,
  project: BuildProject,
  store: RagStore,
  run: RunState,
  restarted: boolean,
): Promise<BuildResult> {
  const effective = project.effective as Extract<EffectiveProjectRag, { enabled: true }>;
  const caps = effective.caps;
  const deadline = run.t0 + caps.maxBuildMs;
  const nowIso = () => (deps.now ?? (() => new Date()))().toISOString();
  const db = store.db;
  let meta: RagMeta | undefined = store.meta();
  if (meta !== undefined && needsRebuild(meta, { model: deps.embedding.model })) {
    wipeRagStore(store);
    meta = undefined;
  }

  // Scan every context; the caps are shared across the project's contexts.
  let incomplete: string | undefined;
  const planned = new Map<string, Planned>();
  const failedContexts = new Set<string>();
  const used = { files: 0, chunks: 0, bytes: 0 };
  for (const ctx of project.contexts) {
    if (run.signal.aborted) break;
    const opts = scanOptionsForContext(effective, ctx.rag);
    if (opts === undefined) continue;
    let r: Awaited<ReturnType<typeof scanContext>>;
    try {
      r = await scanContext(ctx.path, {
        ...opts,
        maxFiles: Math.max(0, opts.maxFiles - used.files),
        maxChunks: Math.max(0, opts.maxChunks - used.chunks),
        maxTotalBytes: Math.max(0, opts.maxTotalBytes - used.bytes),
        ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      });
    } catch {
      failedContexts.add(ctx.id);
      incomplete ??= "context_unreadable";
      continue;
    }
    const byPath = new Map<string, Chunk[]>();
    for (const c of r.chunks) {
      const list = byPath.get(c.path) ?? [];
      list.push(c);
      byPath.set(c.path, list);
    }
    for (const f of r.files) {
      const storePath = `${ctx.id}/${f.path}`;
      const chunks = (byPath.get(f.path) ?? []).map((c) => ({
        ...c,
        path: storePath,
        id: chunkId(storePath, c.ordinal, c.textSha256),
      }));
      planned.set(storePath, { storePath, contextId: ctx.id, file: f, chunks });
      used.files += 1;
      used.chunks += chunks.length;
      used.bytes += chunks.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
    }
    if (!r.complete) incomplete ??= r.incompleteReason;
  }

  const existing = db.prepare("SELECT path, context_id, sha256 FROM rag_file").all() as {
    path: string;
    context_id: string;
    sha256: string;
  }[];
  const known = new Map(existing.map((e) => [e.path, e]));
  const changed = [...planned.values()].filter((p) => known.get(p.storePath)?.sha256 !== p.file.sha256);
  const removed = run.signal.aborted
    ? []
    : existing.filter((e) => !planned.has(e.path) && !failedContexts.has(e.context_id)).map((e) => e.path);

  let filesEmbedded = 0;
  let embedCalls = 0;
  let stop: { outcome: "partial" | "failed"; reason: string } | undefined;

  if (removed.length > 0 && meta !== undefined) {
    const rev = meta.revision + 1;
    db.transaction(() => {
      const del = db.prepare("DELETE FROM rag_file WHERE path = ?");
      for (const p of removed) del.run(p);
      db.prepare("UPDATE rag_meta SET revision = ?, complete = 0").run(rev);
    })();
    meta = store.meta();
  }

  const batchChunks = deps.batchChunks ?? BUILD_BATCH_CHUNKS;
  const insFile = db.prepare(
    `INSERT INTO rag_file (path, context_id, sha256, bytes, mtime_ns, origin_project, indexed_rev)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );
  const insChunk = db.prepare(
    `INSERT INTO rag_chunk (id, path, ordinal, start_line, end_line, text, text_sha256, vector)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const delFile = db.prepare("DELETE FROM rag_file WHERE path = ?");

  let i = 0;
  while (i < changed.length) {
    if (run.signal.aborted) {
      stop = { outcome: "partial", reason: "aborted" };
      break;
    }
    if (run.clock() > deadline) {
      stop = { outcome: "partial", reason: "max_build_ms" };
      break;
    }
    const batch: Planned[] = [];
    let n = 0;
    while (i < changed.length && (batch.length === 0 || n < batchChunks)) {
      const p = changed[i++] as Planned;
      batch.push(p);
      n += p.chunks.length;
    }
    const texts = batch.flatMap((p) => p.chunks.map((c) => c.text));
    const res = await embedGated(
      {
        backend: deps.backend,
        gates: { allowRemote: deps.embedding.allowRemote, allowSourceContent: deps.embedding.allowSourceContent },
        project: effective,
        recorder: (rec) => {
          if (rec.outcome !== "denied") embedCalls += 1;
          deps.recorder?.(rec);
        },
        ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      },
      texts,
      run.signal,
    );
    if (!res.ok) {
      stop = {
        outcome: run.signal.aborted ? "partial" : "failed",
        reason: run.signal.aborted ? "aborted" : res.reason,
      };
      break;
    }
    if (texts.length > 0 && meta !== undefined && res.dimension !== meta.dimension) {
      wipeRagStore(store);
      if (!restarted) return buildInto(deps, project, store, run, true);
      stop = { outcome: "failed", reason: "DIMENSION_CHANGED" };
      break;
    }
    const dimension = texts.length > 0 ? res.dimension : (meta?.dimension ?? 0);
    if (dimension === 0) continue; // only empty files and no store yet: nothing to anchor a meta row; retried next build
    const rev = (meta?.revision ?? 0) + 1;
    db.transaction(() => {
      let v = 0;
      for (const p of batch) {
        delFile.run(p.storePath);
        insFile.run(p.storePath, p.contextId, p.file.sha256, p.file.bytes, p.file.mtimeNs, rev);
        for (const c of p.chunks) {
          const vec = res.vectors[v++] as Float32Array;
          insChunk.run(
            c.id,
            c.path,
            c.ordinal,
            c.startLine,
            c.endLine,
            Buffer.from(c.text, "utf8"),
            c.textSha256,
            Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
          );
        }
      }
      if (meta === undefined) {
        db.prepare(
          `INSERT INTO rag_meta (schema_version, store_kind, project_key, embedding_model, dimension, revision, complete,
             base_ref_sha, built_at)
           VALUES (?, 'project', ?, ?, ?, ?, 0, NULL, ?)`,
        ).run(1, project.id, deps.embedding.model, dimension, rev, nowIso());
      } else {
        db.prepare("UPDATE rag_meta SET revision = ?, complete = 0").run(rev);
      }
    })();
    meta = store.meta();
    filesEmbedded += batch.length;
    await yieldToLoop();
  }

  if (stop === undefined && run.signal.aborted) stop = { outcome: "partial", reason: "aborted" };
  const complete = stop === undefined && incomplete === undefined;
  if (stop === undefined && meta !== undefined) {
    const primary = project.contexts.find((c) => c.primary) ?? project.contexts[0];
    const head = primary === undefined ? null : await (deps.headOf ?? contextHead)(primary.path);
    db.prepare("UPDATE rag_meta SET complete = ?, base_ref_sha = ?, built_at = ?").run(
      complete ? 1 : 0,
      head,
      nowIso(),
    );
    meta = store.meta();
  }
  // Otherwise a stopped build leaves `complete = 0` if it committed anything, and the previous revision untouched if not.
  const counts = store.counts();
  const bytes = (db.prepare("SELECT COALESCE(SUM(length(text)), 0) AS n FROM rag_chunk").get() as { n: number }).n;
  const outcome: BuildOutcome = stop?.outcome ?? (incomplete !== undefined ? "partial" : "ok");
  return {
    ...run.base,
    outcome,
    reason: stop?.reason ?? incomplete ?? null,
    revision: meta?.revision ?? null,
    complete: meta?.complete ?? false,
    files: counts.files,
    chunks: counts.chunks,
    bytes,
    filesEmbedded,
    filesRemoved: removed.length,
    embedCalls,
    durationMs: Math.max(0, Math.round(run.clock() - run.t0)),
    locality: run.locality,
  };
}
