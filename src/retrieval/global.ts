/**
 * Global index and sharing rules (T12.7; FR-RAG-09, FR-RAG-10, LLD §14.9, ADR-0031, Q-50).
 *
 * The global store (`<data>/rag/global/index.db`) exists only when `rag.global.enabled` is set, and holds:
 * - chunks of the operator's `rag.global.sources` (`origin_project` NULL, `context_id` `source:<label>`), scanned and
 *   embedded like a project context (same scanner, denylist, redaction and installation exclusions); and
 * - chunks copied from a project's own store, only for a project whose effective `contributeToGlobal` is true and only
 *   for the contexts {@link contributingContextIds} allows (`origin_project` the project id, `context_id`
 *   `project:<project id>/<context id>`). Copying re-applies the denylist, the exclusions and the redactor: a file the
 *   rules now skip is not copied, and a chunk whose text the redactor would change is dropped. Vectors are copied, so a
 *   contribution embeds nothing; a project store built for another model or dimension is not copied.
 *
 * Every build replans the whole store, so removing `contribute_to_global`, an `index clear` of the project, deleting
 * the project or removing a source removes its rows at the next build. A source or project store that could not be
 * read keeps its rows and makes the build `partial`.
 *
 * Reading the global store at admission is gated twice (`admission.ts`): the reading project's `useGlobal`, and a map
 * of origins currently allowed to share ({@link globalOrigins}); a row whose origin is not in the map is never served,
 * so a stale row from a project that stopped contributing cannot reach anyone before the next build removes it.
 *
 * Delegated choices (T12.7): a context is "untrusted" (Q-50) when its project's `max_trust_profile` is
 * `inspect-untrusted` or `edit-untrusted`; such a context contributes only when its own `rag` block sets
 * `contribute_to_global: true`. A context block's `contribute_to_global: false` or `mode: "off"` withholds that context.
 * The global store's caps are the installation caps (`rag.caps`), shared across sources and contributions; the same
 * locality gate (§14.4) applies before anything is opened. Nothing here imports the ledger.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { EffectiveProjectRag, RagSettings } from "../config/index.js";
import type { BuildDeps, BuildOutcome, BuildProject, BuildResult } from "./build.js";
import { chunkId } from "./chunk.js";
import { compileExcludes, isDenylisted } from "./denylist.js";
import { embedGated, evaluateEmbeddingGate, type Locality } from "./embedding.js";
import { scanOptionsForContext } from "./options.js";
import { redactForIndex, scanContext } from "./scan.js";
import {
  needsRebuild,
  openRagStore,
  openRagStoreReadOnly,
  type RagMeta,
  type RagStore,
  wipeRagStore,
} from "./store.js";

/** Indexer queue key of the global store; not a valid project id, so it never collides with one. */
export const GLOBAL_INDEX_KEY = "#global";

const SOURCE_PREFIX = "source:";
const PROJECT_PREFIX = "project:";

/** `context_id` of an operator source in the global store. */
export const sourceContextId = (label: string) => `${SOURCE_PREFIX}${label}`;
/** `context_id` of a project context's contribution in the global store. */
export const contributionContextId = (projectId: string, contextId: string) =>
  `${PROJECT_PREFIX}${projectId}/${contextId}`;

const UNTRUSTED_PROFILES: ReadonlySet<string> = new Set(["inspect-untrusted", "edit-untrusted"]);

/** Whether a trust profile marks the project's contexts as untrusted for sharing (Q-50, Delegated). */
export function isUntrustedProfile(profile: string | undefined): boolean {
  return profile !== undefined && UNTRUSTED_PROFILES.has(profile);
}

/**
 * The context ids of `project` whose content may be copied into the global store (FR-RAG-09): none unless retrieval is
 * on and the project contributes; a context with `mode: "off"` or `contribute_to_global: false` is withheld; a context
 * of an untrusted project contributes only when it sets `contribute_to_global: true` itself.
 */
export function contributingContextIds(project: BuildProject): Set<string> {
  const out = new Set<string>();
  const eff = project.effective;
  if (!eff.enabled || !eff.contributeToGlobal) return out;
  for (const c of project.contexts) {
    if (c.rag?.mode === "off" || c.rag?.contribute_to_global === false) continue;
    if (project.untrusted === true && c.rag?.contribute_to_global !== true) continue;
    out.add(c.id);
  }
  return out;
}

/** The label a global snippet carries in the pack: its origin project, or the operator source (FR-RAG-10). */
export type GlobalOrigin =
  | { readonly kind: "project"; readonly projectId: string; readonly root: string }
  | { readonly kind: "source"; readonly label: string; readonly root: string };

/**
 * Every global-store `context_id` that may be served now, with the directory its files are checked against: the
 * configured sources, and the contributing contexts of the contributing projects. Built from the configuration, not the
 * store, so a row whose origin stopped sharing is never served.
 */
export function globalOrigins(
  global: RagSettings["global"],
  projects: readonly BuildProject[],
): Map<string, GlobalOrigin> {
  const out = new Map<string, GlobalOrigin>();
  if (!global.enabled) return out;
  for (const s of global.sources) out.set(sourceContextId(s.label), { kind: "source", label: s.label, root: s.path });
  for (const p of projects) {
    const allowed = contributingContextIds(p);
    for (const c of p.contexts) {
      if (allowed.has(c.id)) {
        out.set(contributionContextId(p.id, c.id), { kind: "project", projectId: p.id, root: c.path });
      }
    }
  }
  return out;
}

export interface GlobalBuildInput {
  readonly global: RagSettings["global"];
  /** Installation caps and exclusions (`rag.caps`, `rag.exclude`). */
  readonly caps: RagSettings["caps"];
  readonly exclude: readonly string[];
  /** Every project the daemon serves; only contributing ones are read. */
  readonly projects: readonly BuildProject[];
  /** Allowed roots (FR-POL-10): a source whose real path is outside every one is not indexed. */
  readonly allowedRoots: readonly string[];
}

interface PlannedChunk {
  readonly id: string;
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly textSha256: string;
  /** Copied from a project store; absent for a source chunk, which is embedded. */
  readonly vector?: Buffer;
}

interface PlannedFile {
  readonly storePath: string;
  readonly contextId: string;
  readonly origin: string | null;
  readonly sha256: string;
  readonly bytes: number;
  readonly mtimeNs: bigint;
  /** Loaded lazily for a copied file, so unchanged contributions never read their vectors. */
  chunks: () => PlannedChunk[];
}

type Run = {
  readonly t0: number;
  readonly clock: () => number;
  readonly signal: AbortSignal;
  readonly locality: Locality;
};

/** Build or refresh the global store (LLD §14.9). Skipped, creating nothing, when the global index is off or gated. */
export async function buildGlobalIndex(deps: BuildDeps, input: GlobalBuildInput): Promise<BuildResult> {
  const clock = deps.clock ?? (() => performance.now());
  const t0 = clock();
  const signal = deps.signal ?? new AbortController().signal;
  const skipped = (reason: string, locality: Locality | null): BuildResult =>
    result(deps, { t0, clock }, { outcome: "skipped", reason, meta: undefined, counts: undefined, locality });

  if (!input.global.enabled) return skipped("GLOBAL_OFF", null);
  let locality: Locality;
  try {
    locality = await deps.backend.resolveLocality(signal);
  } catch {
    locality = "remote"; // unresolved is remote (LLD §13.2)
  }
  const gate = evaluateEmbeddingGate({ projectEnabled: true, locality, ...deps.embedding });
  if (!gate.allowed) return skipped(gate.reason, locality);

  const store = openRagStore(deps.dataDir, { kind: "global" });
  try {
    return await buildGlobalInto(deps, input, store, { t0, clock, signal, locality }, false);
  } finally {
    store.close();
  }
}

async function buildGlobalInto(
  deps: BuildDeps,
  input: GlobalBuildInput,
  store: RagStore,
  run: Run,
  restarted: boolean,
): Promise<BuildResult> {
  const db = store.db;
  const nowIso = () => (deps.now ?? (() => new Date()))().toISOString();
  const deadline = run.t0 + input.caps.maxBuildMs;
  let meta: RagMeta | undefined = store.meta();
  if (meta !== undefined && needsRebuild(meta, { model: deps.embedding.model })) {
    wipeRagStore(store);
    meta = undefined;
  }

  const planned = new Map<string, PlannedFile>();
  /** `context_id`s whose rows are kept because their origin could not be read this time. */
  const keep = new Set<string>();
  const used = { files: 0, chunks: 0, bytes: 0 };
  let incomplete: string | undefined;
  const fits = (chunks: number, bytes: number): boolean => {
    if (used.files + 1 > input.caps.maxFiles) incomplete ??= "max_files";
    else if (used.chunks + chunks > input.caps.maxChunks) incomplete ??= "max_chunks";
    else if (used.bytes + bytes > input.caps.maxTotalBytes) incomplete ??= "max_total_bytes";
    else {
      used.files += 1;
      used.chunks += chunks;
      used.bytes += bytes;
      return true;
    }
    return false;
  };

  // Operator sources: scanned like a context, under the installation's exclusions.
  const realRoots = await Promise.all(input.allowedRoots.map((r) => realpath(r).catch(() => path.resolve(r))));
  for (const src of input.global.sources) {
    if (run.signal.aborted) break;
    const contextId = sourceContextId(src.label);
    let real: string;
    try {
      real = await realpath(src.path);
    } catch {
      keep.add(contextId);
      incomplete ??= "source_unreadable";
      continue;
    }
    if (!realRoots.some((r) => isUnder(real, r))) {
      incomplete ??= "source_outside_roots"; // its rows are removed: fail closed
      continue;
    }
    let r: Awaited<ReturnType<typeof scanContext>>;
    try {
      r = await scanContext(real, {
        maxFileBytes: input.caps.maxFileBytes,
        maxFiles: Math.max(0, input.caps.maxFiles - used.files),
        maxChunks: Math.max(0, input.caps.maxChunks - used.chunks),
        maxTotalBytes: Math.max(0, input.caps.maxTotalBytes - used.bytes),
        exclude: input.exclude,
        ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      });
    } catch {
      keep.add(contextId);
      incomplete ??= "source_unreadable";
      continue;
    }
    for (const f of r.files) {
      const storePath = `${contextId}/${f.path}`;
      const chunks = r.chunks
        .filter((c) => c.path === f.path)
        .map((c) => ({
          id: chunkId(storePath, c.ordinal, c.textSha256),
          ordinal: c.ordinal,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          textSha256: c.textSha256,
        }));
      const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
      if (!fits(chunks.length, bytes)) break;
      planned.set(storePath, {
        storePath,
        contextId,
        origin: null,
        sha256: f.sha256,
        bytes: f.bytes,
        mtimeNs: f.mtimeNs,
        chunks: () => chunks,
      });
    }
    if (!r.complete) incomplete ??= r.incompleteReason;
  }

  // Contributions: copied from each contributing project's own store.
  const readers: RagStore[] = [];
  try {
    for (const project of input.projects) {
      if (run.signal.aborted) break;
      const allowed = contributingContextIds(project);
      if (allowed.size === 0) continue;
      const contextIds = [...allowed].map((c) => contributionContextId(project.id, c));
      let src: RagStore | undefined;
      try {
        src = openRagStoreReadOnly(deps.dataDir, { kind: "project", projectId: project.id });
      } catch {
        for (const c of contextIds) keep.add(c);
        incomplete ??= "contribution_unreadable";
        continue;
      }
      if (src === undefined) continue; // no store (never built, or cleared): its contributions go
      readers.push(src);
      const pmeta = src.meta();
      if (pmeta === undefined || needsRebuild(pmeta, { model: deps.embedding.model })) {
        for (const c of contextIds) keep.add(c);
        incomplete ??= "contribution_pending";
        continue;
      }
      if (meta !== undefined && pmeta.dimension !== meta.dimension) {
        for (const c of contextIds) keep.add(c);
        incomplete ??= "contribution_dimension";
        continue;
      }
      planContributions(deps, project, allowed, src, planned, fits);
    }

    // Diff against what the store holds.
    const existing = db.prepare("SELECT path, context_id, sha256 FROM rag_file").all() as {
      path: string;
      context_id: string;
      sha256: string;
    }[];
    const known = new Map(existing.map((e) => [e.path, e]));
    const changed = [...planned.values()].filter((p) => known.get(p.storePath)?.sha256 !== p.sha256);
    const removed = run.signal.aborted
      ? []
      : existing.filter((e) => !planned.has(e.path) && !keep.has(e.context_id)).map((e) => e.path);

    if (removed.length > 0 && meta !== undefined) {
      const rev = meta.revision + 1;
      db.transaction(() => {
        const del = db.prepare("DELETE FROM rag_file WHERE path = ?");
        for (const p of removed) del.run(p);
        db.prepare("UPDATE rag_meta SET revision = ?, complete = 0").run(rev);
      })();
      meta = store.meta();
    }

    const insFile = db.prepare(
      `INSERT INTO rag_file (path, context_id, sha256, bytes, mtime_ns, origin_project, indexed_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insChunk = db.prepare(
      `INSERT INTO rag_chunk (id, path, ordinal, start_line, end_line, text, text_sha256, vector)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const delFile = db.prepare("DELETE FROM rag_file WHERE path = ?");
    const commit = (batch: { file: PlannedFile; chunks: PlannedChunk[]; vectors: Buffer[] }[], dimension: number) => {
      const rev = (meta?.revision ?? 0) + 1;
      db.transaction(() => {
        for (const { file, chunks, vectors } of batch) {
          delFile.run(file.storePath);
          insFile.run(file.storePath, file.contextId, file.sha256, file.bytes, file.mtimeNs, file.origin, rev);
          for (const [i, c] of chunks.entries()) {
            insChunk.run(
              c.id,
              file.storePath,
              c.ordinal,
              c.startLine,
              c.endLine,
              Buffer.from(c.text, "utf8"),
              c.textSha256,
              vectors[i] as Buffer,
            );
          }
        }
        if (meta === undefined) {
          db.prepare(
            `INSERT INTO rag_meta (schema_version, store_kind, project_key, embedding_model, dimension, revision,
               complete, base_ref_sha, built_at)
             VALUES (?, 'global', NULL, ?, ?, ?, 0, NULL, ?)`,
          ).run(1, deps.embedding.model, dimension, rev, nowIso());
        } else {
          db.prepare("UPDATE rag_meta SET revision = ?, complete = 0").run(rev);
        }
      })();
      meta = store.meta();
    };

    let stop: { outcome: "partial" | "failed"; reason: string } | undefined;
    let filesEmbedded = 0;
    let embedCalls = 0;
    const batchChunks = deps.batchChunks ?? 32;
    const project: EffectiveProjectRag = {
      enabled: true,
      caps: input.caps,
      exclude: input.exclude,
      useGlobal: false,
      contributeToGlobal: false,
    };

    // Copied files first (no embedding), then sources, both in bounded batches with a yield between them.
    const copies = changed.filter((p) => p.origin !== null);
    const sources = changed.filter((p) => p.origin === null);
    let i = 0;
    while (i < copies.length && stop === undefined) {
      if (run.signal.aborted) stop = { outcome: "partial", reason: "aborted" };
      else if (run.clock() > deadline) stop = { outcome: "partial", reason: "max_build_ms" };
      if (stop !== undefined) break;
      const batch: { file: PlannedFile; chunks: PlannedChunk[]; vectors: Buffer[] }[] = [];
      let n = 0;
      while (i < copies.length && (batch.length === 0 || n < batchChunks)) {
        const file = copies[i++] as PlannedFile;
        const chunks = file.chunks();
        batch.push({ file, chunks, vectors: chunks.map((c) => c.vector as Buffer) });
        n += chunks.length;
      }
      const dim = meta?.dimension ?? dimensionOf(batch);
      if (dim === 0) continue;
      commit(batch, dim);
      filesEmbedded += batch.length;
      await yieldToLoop();
    }

    i = 0;
    while (i < sources.length && stop === undefined) {
      if (run.signal.aborted) stop = { outcome: "partial", reason: "aborted" };
      else if (run.clock() > deadline) stop = { outcome: "partial", reason: "max_build_ms" };
      if (stop !== undefined) break;
      const batch: { file: PlannedFile; chunks: PlannedChunk[]; vectors: Buffer[] }[] = [];
      let n = 0;
      while (i < sources.length && (batch.length === 0 || n < batchChunks)) {
        const file = sources[i++] as PlannedFile;
        const chunks = file.chunks();
        batch.push({ file, chunks, vectors: [] });
        n += chunks.length;
      }
      const texts = batch.flatMap((b) => b.chunks.map((c) => c.text));
      const res = await embedGated(
        {
          backend: deps.backend,
          gates: { allowRemote: deps.embedding.allowRemote, allowSourceContent: deps.embedding.allowSourceContent },
          project,
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
        if (!restarted) {
          for (const r of readers) r.close();
          readers.length = 0;
          return buildGlobalInto(deps, input, store, run, true);
        }
        stop = { outcome: "failed", reason: "DIMENSION_CHANGED" };
        break;
      }
      const dimension = texts.length > 0 ? res.dimension : (meta?.dimension ?? 0);
      if (dimension === 0) continue;
      let v = 0;
      for (const b of batch) {
        for (const _ of b.chunks) {
          const vec = res.vectors[v++] as Float32Array;
          b.vectors.push(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
        }
      }
      commit(batch, dimension);
      filesEmbedded += batch.length;
      await yieldToLoop();
    }

    if (stop === undefined && run.signal.aborted) stop = { outcome: "partial", reason: "aborted" };
    if (stop === undefined && meta !== undefined) {
      db.prepare("UPDATE rag_meta SET complete = ?, built_at = ?").run(incomplete === undefined ? 1 : 0, nowIso());
      meta = store.meta();
    }
    const outcome: BuildOutcome = stop?.outcome ?? (incomplete !== undefined ? "partial" : "ok");
    const counts = store.counts();
    const bytes = (db.prepare("SELECT COALESCE(SUM(length(text)), 0) AS n FROM rag_chunk").get() as { n: number }).n;
    return result(deps, run, {
      outcome,
      reason: stop?.reason ?? incomplete ?? null,
      meta,
      counts: { ...counts, bytes, filesEmbedded, filesRemoved: removed.length, embedCalls },
      locality: run.locality,
    });
  } finally {
    for (const r of readers) r.close();
  }
}

/** Plan the files of one contributing project, re-applying the denylist, exclusions and redactor. */
function planContributions(
  deps: BuildDeps,
  project: BuildProject,
  allowed: ReadonlySet<string>,
  src: RagStore,
  planned: Map<string, PlannedFile>,
  fits: (chunks: number, bytes: number) => boolean,
): void {
  const excludes = new Map<string, (rel: string) => boolean>();
  for (const c of project.contexts) {
    const opts = scanOptionsForContext(project.effective, c.rag);
    if (opts !== undefined && allowed.has(c.id)) excludes.set(c.id, compileExcludes(opts.exclude));
  }
  const files = src.db
    .prepare("SELECT path, context_id, sha256, bytes, mtime_ns FROM rag_file ORDER BY path")
    .safeIntegers(true)
    .all() as { path: string; context_id: string; sha256: string; bytes: bigint; mtime_ns: bigint }[];
  const chunkStmt = src.db.prepare(
    `SELECT ordinal, start_line, end_line, text, text_sha256, vector FROM rag_chunk WHERE path = ? ORDER BY ordinal`,
  );
  const sizeStmt = src.db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(length(text)), 0) AS b FROM rag_chunk WHERE path = ?",
  );
  for (const f of files) {
    const isExcluded = excludes.get(f.context_id);
    if (isExcluded === undefined) continue;
    const rel = f.path.slice(f.context_id.length + 1);
    if (isDenylisted(rel) || isExcluded(rel)) continue;
    const contextId = contributionContextId(project.id, f.context_id);
    const storePath = `${contextId}/${rel}`;
    const size = sizeStmt.get(f.path) as { n: number; b: number };
    if (!fits(size.n, size.b)) return;
    const sourcePath = f.path;
    planned.set(storePath, {
      storePath,
      contextId,
      origin: project.id,
      sha256: f.sha256,
      bytes: Number(f.bytes),
      mtimeNs: f.mtime_ns,
      chunks: () => {
        const out: PlannedChunk[] = [];
        for (const r of chunkStmt.all(sourcePath) as {
          ordinal: number;
          start_line: number;
          end_line: number;
          text: Buffer;
          text_sha256: string;
          vector: Buffer;
        }[]) {
          const text = r.text.toString("utf8");
          if (redactForIndex(text, deps.homeDir) !== text) continue; // the redactor would change it: not copied
          out.push({
            id: chunkId(storePath, r.ordinal, r.text_sha256),
            ordinal: r.ordinal,
            startLine: r.start_line,
            endLine: r.end_line,
            text,
            textSha256: r.text_sha256,
            vector: Buffer.from(r.vector),
          });
        }
        return out;
      },
    });
  }
}

function dimensionOf(batch: readonly { vectors: Buffer[] }[]): number {
  for (const b of batch) for (const v of b.vectors) return v.byteLength / 4;
  return 0;
}

function isUnder(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function result(
  deps: BuildDeps,
  run: { t0: number; clock: () => number },
  r: {
    outcome: BuildOutcome;
    reason: string | null;
    meta: RagMeta | undefined;
    counts:
      | {
          files: number;
          chunks: number;
          bytes: number;
          filesEmbedded: number;
          filesRemoved: number;
          embedCalls: number;
        }
      | undefined;
    locality: Locality | null;
  },
): BuildResult {
  return {
    projectKey: null,
    backendKind: deps.backend.kind,
    modelId: deps.embedding.model,
    outcome: r.outcome,
    reason: r.reason,
    revision: r.meta?.revision ?? null,
    complete: r.meta?.complete ?? false,
    files: r.counts?.files ?? 0,
    chunks: r.counts?.chunks ?? 0,
    bytes: r.counts?.bytes ?? 0,
    filesEmbedded: r.counts?.filesEmbedded ?? 0,
    filesRemoved: r.counts?.filesRemoved ?? 0,
    embedCalls: r.counts?.embedCalls ?? 0,
    durationMs: Math.max(0, Math.round(run.clock() - run.t0)),
    locality: r.locality,
  };
}
