/**
 * `search_project_context` (T12.6, T12.7; FR-RAG-06, FR-RAG-08, FR-RAG-09, FR-RAG-10, LLD §14.7, §14.8, §14.9,
 * ADR-0031): a read-only semantic search over one project's retrieval store, and over the global store for the
 * scopes that allow it, for an MCP client that may use the project.
 *
 * - **Read-only.** Stores are opened `readonly` with `fileMustExist`: a search never creates, migrates, rebuilds or
 *   triggers a build. A missing store, a store with no meta row, or one built for another model or schema is
 *   `status: "unavailable"` (`NOT_BUILT`, `REBUILD_PENDING`), never a tool error (FR-RAG-08).
 * - **Project-scoped.** Only `<data>/rag/projects/<project id>/index.db` of the resolved project is read for
 *   `scope: "project"`; `scope: "global"` reads only `<data>/rag/global/index.db`, and `"both"` reads both (T12.7).
 *   Either global scope still needs `use_global` (else INVALID_REQUEST, LLD §14.7).
 * - **Sharing (T12.7, FR-RAG-10).** A global row reaches the reading project only when the injected origins map
 *   (built from the current configuration by `globalOrigins`, exactly as at admission) still allows its origin to
 *   share, the row's `origin_project` matches that origin (NULL for an operator source), and the origin is not the
 *   reading project itself: a project's own contributions come from its own store, never from the global leg. A row
 *   from a project that stopped contributing is therefore never served, even before the next global build removes
 *   it. No origins function means the global store is not read (`GLOBAL_NOT_AVAILABLE`).
 * - **Gated.** The query is embedded through `embedGated`, so the §14.4 gate table and re-redaction apply to it exactly as
 *   to source text (LLD §14.4 Assumption); a denial or backend failure is `unavailable` with the code.
 * - **Bounded.** At most {@link MAX_SEARCH_LIMIT} results (the `retrieval.top_k` maximum), each `text` at most
 *   {@link MAX_RESULT_TEXT_BYTES} (the chunk bound), and the summed `text` at most {@link MAX_SEARCH_TEXT_BYTES}; a
 *   result that would cross the total is left out and `truncated` is set. `limit` bounds the merged answer of
 *   `"both"`, not each leg.
 * - **Ranked (T12.7).** `"both"` concatenates the two legs' rankings and sorts once by score (cosine similarity,
 *   rounded to six decimals) descending, then path, then start line — the same comparator each leg uses — so project
 *   and global hits interleave purely by rank. Every global hit carries `origin_project` (a contributing project id)
 *   or `source` (an operator source label); project hits carry neither.
 * - **No path outside the project.** A result's `path` is relative to its context root (with `context_id`); a stored path
 *   that is absolute, has a `..` segment or names a context the project no longer has is dropped, and the freshness
 *   check resolves the file with `realpath` and drops it unless it is still inside the context root. A global hit is
 *   checked the same way against its origin's current directory.
 * - **Fresh** (LLD §14.8). Before a snippet is returned its file is compared with `rag_file`: same size and `mtime_ns`
 *   pass cheaply, otherwise the file is hashed; a changed, vanished or unreadable file drops the snippet.
 *   `status` (and, for `"both"`, `index_revision`) follow the project store; a failed global leg keeps the project's
 *   results and reports its code in `reason`. A missing global store, or one with no meta row, keeps
 *   `GLOBAL_NOT_AVAILABLE` (Assumption: the single `reason`/`status` describe the project leg; the global leg only
 *   adds hits or its failure code).
 *
 * Delegated choices (T12.6, not owner-approved): the bounds above; the added output fields `context_id` and
 * `truncated`; candidates are examined in score order up to four times `limit`, so many stale hits give fewer
 * results rather than an unbounded scan; scores are cosine similarity rounded to six decimals; ties order by path then
 * start line. The call is recorded through the injected `record` (a `rag_record` row of kind `retrieval`, counts only,
 * FR-RAG-12); a recording failure never fails the search.
 * Delegated choices (T12.7, not owner-approved): the merge order and the project-leg-wins `status`/`index_revision`
 * above; a global store that is stale or incomplete still serves freshness-checked hits, like the project leg does
 * (admission is the strict path and skips them); a global leg that cannot be read reports the same codes the project
 * leg would (`STORE_UNREADABLE`, `REBUILD_PENDING`, `DIMENSION_MISMATCH`), or `GLOBAL_NOT_AVAILABLE` when the store
 * is missing or was never built.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { effectiveProjectRag, type ProjectRagConfig, type RagSettings } from "../config/index.js";
import {
  MAX_QUERY_LENGTH,
  MAX_RESULT_TEXT_BYTES,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TEXT_BYTES,
} from "../git/tool-protocol.js";
import type { RagRecordInput } from "../ledger/index.js";
import { type EmbeddingBackend, embedGated, type Locality } from "../retrieval/embedding.js";
import type { GlobalOrigin } from "../retrieval/global.js";
import { RAG_SCHEMA_VERSION, ragStoreDir } from "../retrieval/store.js";
import { invalid } from "./errors.js";

export const SEARCH_TOOL_NAME = "search_project_context";
/**
 * The bounds are defined once in the import-free tool protocol (T12.9) so the per-run channel form of this tool
 * (FR-RAG-13) uses the same values; re-exported here unchanged.
 */
export { MAX_QUERY_LENGTH, MAX_RESULT_TEXT_BYTES, MAX_SEARCH_LIMIT, MAX_SEARCH_TEXT_BYTES };
/** Candidates examined per requested result before giving up on stale hits (Delegated). */
export const SEARCH_CANDIDATE_FACTOR = 4;

export type SearchScope = "project" | "global" | "both";
export type SearchStatus = "ok" | "unavailable" | "stale" | "incomplete";

export interface SearchContextDeps {
  readonly dataDir: string;
  readonly settings: RagSettings;
  readonly backend: EmbeddingBackend;
  /** Writes one `rag_record` row of kind `retrieval`; errors are swallowed. */
  readonly record?: (r: RagRecordInput) => void;
  readonly homeDir?: string;
  readonly now?: () => Date;
  readonly clock?: () => number;
  /**
   * T12.7: the global-store origins that may be served now (`globalOrigins` in `src/retrieval/global.ts`, built from
   * the current configuration exactly as at admission). Called only for `scope: "global"` or `"both"`; absent, or
   * throwing, means the global store is not read (`GLOBAL_NOT_AVAILABLE`). `serve` wires this from its live project
   * list; tests pass a fixed map.
   */
  readonly globalOrigins?: () => ReadonlyMap<string, GlobalOrigin>;
}

/** The part of a resolved project the search needs. */
export interface SearchProject {
  readonly id: string;
  readonly rag?: ProjectRagConfig;
  readonly contexts: readonly { readonly id: string; readonly path: string }[];
}

export interface SearchArgs {
  readonly query: string;
  readonly limit?: number;
  readonly scope?: SearchScope;
}

export interface SearchHit {
  readonly snippet_id: string;
  readonly context_id: string;
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly score: number;
  readonly file_sha256: string;
  readonly untrusted: true;
  readonly text: string;
  /** T12.7: global hits from a contributing project carry its id; project hits and operator sources omit it. */
  readonly origin_project?: string;
  /** T12.7: global hits from `rag.global.sources` carry the source label; every other hit omits it. */
  readonly source?: string;
}

export interface SearchResult {
  readonly status: SearchStatus;
  readonly reason?: string;
  readonly index_revision?: number;
  readonly truncated?: true;
  readonly results: SearchHit[];
}

/** Whether retrieval is on for a project at all (the tool is listed only when it is for one of the client's). */
export function searchEnabledFor(settings: RagSettings, project: Pick<SearchProject, "rag">): boolean {
  return effectiveProjectRag(settings, project.rag).enabled;
}

export async function searchProjectContext(
  deps: SearchContextDeps,
  project: SearchProject,
  args: SearchArgs,
): Promise<SearchResult> {
  const clock = deps.clock ?? (() => performance.now());
  const t0 = clock();
  const scope = args.scope ?? "project";
  const effective = effectiveProjectRag(deps.settings, project.rag);
  if (scope !== "project" && !(effective.enabled && effective.useGlobal)) {
    throw invalid(`scope ${scope} needs use_global on project ${project.id}`, { field: "scope" });
  }
  const limit = Math.min(args.limit ?? deps.settings.retrieval.topK, MAX_SEARCH_LIMIT);
  const embedding = deps.settings.embedding;
  let locality: Locality | null = null;
  let embedCalls = 0;

  const finish = (r: SearchResult): SearchResult => {
    try {
      deps.record?.({
        kind: "retrieval",
        projectKey: project.id,
        runId: null,
        backendKind: deps.backend.kind,
        modelId: embedding?.model ?? null,
        locality,
        outcome: r.status,
        reason: r.reason ?? null,
        revision: r.index_revision ?? null,
        chunks: r.results.length,
        bytes: r.results.reduce((n, h) => n + Buffer.byteLength(h.text, "utf8"), 0),
        durationMs: Math.max(0, Math.round(clock() - t0)),
        embedCalls,
      });
    } catch {
      // recording is best effort; the search result stands
    }
    return r;
  };
  const unavailable = (reason: string, revision?: number): SearchResult =>
    finish({
      status: "unavailable",
      reason,
      ...(revision !== undefined ? { index_revision: revision } : {}),
      results: [],
    });

  if (!effective.enabled || embedding === undefined) {
    return unavailable(effective.enabled ? "NO_BACKEND" : effective.reason);
  }
  let origins: ReadonlyMap<string, GlobalOrigin> | undefined;
  if (scope !== "project") {
    try {
      origins = deps.globalOrigins?.();
    } catch {
      origins = undefined;
    }
    if (origins === undefined) return unavailable("GLOBAL_NOT_AVAILABLE");
  }

  // Open the legs this scope reads. A project leg that cannot be read fails the call (fail closed); a global leg
  // that cannot be read only contributes its code to `reason` in `"both"`.
  let pdb: Database.Database | undefined;
  let pmeta: MetaRow | undefined;
  let gdb: Database.Database | undefined;
  let gmeta: MetaRow | undefined;
  let greason: string | undefined;
  try {
    if (scope !== "global") {
      const opened = openLeg(
        path.join(ragStoreDir(deps.dataDir, { kind: "project", projectId: project.id }), "index.db"),
        "NOT_BUILT",
      );
      if (!opened.ok) return unavailable(opened.reason, opened.revision);
      pdb = opened.db;
      pmeta = opened.meta;
      if (pmeta.schema_version !== RAG_SCHEMA_VERSION || pmeta.embedding_model !== embedding.model) {
        return unavailable("REBUILD_PENDING", pmeta.revision);
      }
    }
    if (scope !== "project") {
      const opened = openLeg(
        path.join(ragStoreDir(deps.dataDir, { kind: "global" }), "index.db"),
        "GLOBAL_NOT_AVAILABLE",
      );
      if (!opened.ok) {
        if (scope === "global") return unavailable(opened.reason, opened.revision);
        greason = opened.reason;
      } else if (opened.meta.schema_version !== RAG_SCHEMA_VERSION || opened.meta.embedding_model !== embedding.model) {
        opened.db.close();
        if (scope === "global") return unavailable("REBUILD_PENDING", opened.meta.revision);
        greason = "REBUILD_PENDING";
      } else {
        gdb = opened.db;
        gmeta = opened.meta;
      }
    }
    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    if (scope === "global" && (origins as ReadonlyMap<string, GlobalOrigin>).size === 0) {
      // Nothing may be shared with this project: answer from the global meta row without embedding.
      const meta = gmeta as MetaRow;
      return finish({ status: statusOf(meta, nowMs, deps.settings), index_revision: meta.revision, results: [] });
    }

    const signal = AbortSignal.timeout(embedding.timeoutMs);
    const q = await embedGated(
      {
        backend: deps.backend,
        gates: { allowRemote: embedding.allowRemote, allowSourceContent: embedding.allowSourceContent },
        project: effective,
        recorder: (rec) => {
          locality = rec.locality;
          if (rec.outcome !== "denied") embedCalls += 1;
        },
        ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      },
      [args.query],
      signal,
    );
    const revOf = scope === "global" ? gmeta?.revision : pmeta?.revision;
    if (!q.ok) return unavailable(q.reason, revOf);
    const qv = q.vectors[0] as Float32Array;
    if (q.dimension !== (scope === "global" ? gmeta : pmeta)?.dimension) {
      return unavailable("DIMENSION_MISMATCH", revOf);
    }
    if (gdb !== undefined && gmeta !== undefined && q.dimension !== gmeta.dimension) {
      gdb.close();
      gdb = undefined;
      gmeta = undefined;
      greason = "DIMENSION_MISMATCH";
    }

    type Cand = { id: string; path: string; score: number; start: number; leg: "project" | "global" };
    const tag = <T extends { id: string; path: string; score: number; start: number }>(
      rows: T[],
      leg: Cand["leg"],
    ): Cand[] => rows.map((r) => ({ ...r, leg }));
    let cands: Cand[];
    if (scope === "global") {
      try {
        cands = tag(
          rankGlobal(gdb as Database.Database, qv, (gmeta as MetaRow).dimension, (contextId, originProject) =>
            isServableGlobal((origins as ReadonlyMap<string, GlobalOrigin>).get(contextId), originProject, project.id),
          ),
          "global",
        );
      } catch {
        return unavailable("STORE_UNREADABLE", (gmeta as MetaRow).revision);
      }
    } else {
      try {
        cands = tag(rank(pdb as Database.Database, qv, (pmeta as MetaRow).dimension), "project");
      } catch {
        return unavailable("STORE_UNREADABLE", (pmeta as MetaRow).revision);
      }
      if (gdb !== undefined && gmeta !== undefined) {
        try {
          cands = [
            ...cands,
            ...tag(
              rankGlobal(gdb, qv, gmeta.dimension, (contextId, originProject) =>
                isServableGlobal(
                  (origins as ReadonlyMap<string, GlobalOrigin>).get(contextId),
                  originProject,
                  project.id,
                ),
              ),
              "global",
            ),
          ].sort(byScorePathStart);
        } catch {
          // A global leg that cannot be read only contributes its code to `reason` in `"both"`.
          gdb.close();
          gdb = undefined;
          gmeta = undefined;
          greason = "STORE_UNREADABLE";
        }
      }
    }

    const pfile =
      pdb?.prepare("SELECT context_id, sha256, bytes, mtime_ns FROM rag_file WHERE path = ?").safeIntegers() ?? null;
    const pchunk = pdb?.prepare("SELECT start_line, end_line, text FROM rag_chunk WHERE id = ?") ?? null;
    const gfile =
      gdb
        ?.prepare("SELECT context_id, sha256, bytes, mtime_ns, origin_project FROM rag_file WHERE path = ?")
        .safeIntegers() ?? null;
    const gchunk = gdb?.prepare("SELECT start_line, end_line, text FROM rag_chunk WHERE id = ?") ?? null;
    const roots = new Map<string, string | null>();
    const rootOfProject = async (contextId: string): Promise<string | null> => {
      if (!roots.has(contextId)) {
        const ctx = project.contexts.find((c) => c.id === contextId);
        roots.set(contextId, ctx === undefined ? null : await realpath(ctx.path).catch(() => null));
      }
      return roots.get(contextId) ?? null;
    };
    const rootOfGlobal = async (contextId: string): Promise<string | null> => {
      const key = `global:${contextId}`;
      if (!roots.has(key)) {
        const origin = (origins as ReadonlyMap<string, GlobalOrigin>).get(contextId);
        roots.set(key, origin === undefined ? null : await realpath(origin.root).catch(() => null));
      }
      return roots.get(key) ?? null;
    };
    const fresh = new Map<string, boolean>();
    const results: SearchHit[] = [];
    let total = 0;
    let truncated = false;
    const maxFileBytes = effective.caps.maxFileBytes;
    for (const cand of cands.slice(0, limit * SEARCH_CANDIDATE_FACTOR)) {
      if (results.length >= limit) break;
      const global = cand.leg === "global";
      const fileStmt = (global ? gfile : pfile) as ReturnType<Database.Database["prepare"]> | null;
      const chunkStmt = (global ? gchunk : pchunk) as ReturnType<Database.Database["prepare"]> | null;
      if (fileStmt === null || chunkStmt === null) continue;
      const f = fileStmt.get(cand.path) as
        | { context_id: string; sha256: string; bytes: bigint; mtime_ns: bigint; origin_project?: string | null }
        | undefined;
      if (f === undefined) continue;
      const rel = relativeInContext(cand.path, f.context_id);
      if (rel === undefined) continue;
      // A global row is served only when its origin still shares now and matches the row (FR-RAG-10); the rank-time
      // filter already applied this, and it is re-checked here against the live map.
      let origin: GlobalOrigin | undefined;
      if (global) {
        origin = (origins as ReadonlyMap<string, GlobalOrigin>).get(f.context_id);
        if (!isServableGlobal(origin, f.origin_project ?? null, project.id)) continue;
      }
      const root = global ? await rootOfGlobal(f.context_id) : await rootOfProject(f.context_id);
      if (root === null) continue;
      const freshKey = `${cand.leg}:${cand.path}`;
      if (!fresh.has(freshKey)) fresh.set(freshKey, await isFresh(root, rel, f, maxFileBytes));
      if (fresh.get(freshKey) !== true) continue;
      const c = chunkStmt.get(cand.id) as { start_line: number; end_line: number; text: Buffer } | undefined;
      if (c === undefined) continue;
      const text = boundText(Buffer.from(c.text).toString("utf8"));
      const bytes = Buffer.byteLength(text, "utf8");
      if (total + bytes > MAX_SEARCH_TEXT_BYTES) {
        truncated = true;
        break;
      }
      total += bytes;
      results.push({
        snippet_id: cand.id,
        context_id: f.context_id,
        path: rel,
        start_line: c.start_line,
        end_line: c.end_line,
        score: Math.round(cand.score * 1e6) / 1e6,
        file_sha256: f.sha256,
        untrusted: true,
        text,
        ...(global && origin !== undefined && origin.kind === "project" ? { origin_project: origin.projectId } : {}),
        ...(global && origin !== undefined && origin.kind === "source" ? { source: origin.label } : {}),
      });
    }

    if (scope === "global") {
      const meta = gmeta as MetaRow;
      return finish({
        status: statusOf(meta, nowMs, deps.settings),
        ...(truncated ? { truncated: true as const } : {}),
        index_revision: meta.revision,
        results,
      });
    }
    const meta = pmeta as MetaRow;
    return finish({
      status: statusOf(meta, nowMs, deps.settings),
      ...(greason !== undefined ? { reason: greason } : {}),
      index_revision: meta.revision,
      ...(truncated ? { truncated: true as const } : {}),
      results,
    });
  } finally {
    pdb?.close();
    gdb?.close();
  }
}

interface MetaRow {
  readonly schema_version: number;
  readonly embedding_model: string;
  readonly dimension: number;
  readonly revision: number;
  readonly complete: number;
  readonly built_at: string;
}

/**
 * Open one retrieval store read-only and read its meta row. A missing file or a store with no meta row reports
 * `missing` (`NOT_BUILT` for a project store, `GLOBAL_NOT_AVAILABLE` for the global one); anything else unreadable
 * is `STORE_UNREADABLE` or `REBUILD_PENDING`. A store this function reports `ok: false` for is already closed.
 */
function openLeg(
  file: string,
  missing: string,
): { ok: true; db: Database.Database; meta: MetaRow } | { ok: false; reason: string; revision?: number } {
  if (!existsSync(file)) return { ok: false, reason: missing };
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return { ok: false, reason: "STORE_UNREADABLE" };
  }
  try {
    if ((db.pragma("user_version", { simple: true }) as number) !== RAG_SCHEMA_VERSION) {
      db.close();
      return { ok: false, reason: "REBUILD_PENDING" };
    }
    const row = db.prepare("SELECT * FROM rag_meta LIMIT 1").get() as MetaRow | undefined;
    if (row === undefined) {
      db.close();
      return { ok: false, reason: missing };
    }
    return { ok: true, db, meta: row };
  } catch {
    db.close();
    return { ok: false, reason: "STORE_UNREADABLE" };
  }
}

/** LLD §14.8: stale when the store is older than `retrieval.max_staleness`, else incomplete unless it finished. */
function statusOf(meta: MetaRow, nowMs: number, settings: RagSettings): SearchStatus {
  const builtMs = Date.parse(meta.built_at);
  const stale = !Number.isFinite(builtMs) || nowMs - builtMs > settings.retrieval.maxStalenessMs;
  return stale ? "stale" : meta.complete === 1 ? "ok" : "incomplete";
}

/**
 * A global row may reach the reading project only when its origin may share now and matches the row, and the origin
 * is not the reading project itself (FR-RAG-10). The same rule as admission's `isServable` in
 * `src/retrieval/admission.ts`: a project's own contributions come from its own store, never from the global leg.
 */
function isServableGlobal(
  origin: GlobalOrigin | undefined,
  originProject: string | null,
  reader: string,
): origin is GlobalOrigin {
  if (origin === undefined) return false;
  if (origin.kind === "source") return originProject === null;
  return origin.projectId === originProject && origin.projectId !== reader;
}

/** Score descending, then path, then start line: the order every leg ranks in and `"both"` merges in. */
function byScorePathStart(
  a: { readonly score: number; readonly path: string; readonly start: number },
  b: { readonly score: number; readonly path: string; readonly start: number },
): number {
  return b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start);
}

/** Brute-force cosine similarity over every stored vector (LLD §14.6 step 3, T12.0), best first. */
function rank(
  db: Database.Database,
  q: Float32Array,
  dimension: number,
): { id: string; path: string; score: number; start: number }[] {
  let qn = 0;
  for (const x of q) qn += x * x;
  qn = Math.sqrt(qn);
  const out: { id: string; path: string; score: number; start: number }[] = [];
  const rows = db.prepare("SELECT id, path, start_line, vector FROM rag_chunk").iterate() as IterableIterator<{
    id: string;
    path: string;
    start_line: number;
    vector: Buffer;
  }>;
  for (const r of rows) {
    if (r.vector.byteLength !== dimension * 4) continue;
    const v = new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength));
    let dot = 0;
    let vn = 0;
    for (let i = 0; i < dimension; i++) {
      const x = v[i] as number;
      dot += x * (q[i] as number);
      vn += x * x;
    }
    if (vn === 0 || qn === 0) continue;
    out.push({ id: r.id, path: r.path, score: dot / (Math.sqrt(vn) * qn), start: r.start_line });
  }
  out.sort(byScorePathStart);
  return out;
}

/**
 * Brute-force cosine over the global store's vectors (LLD §14.6 step 3, T12.0), best first, skipping rows no client
 * of the reading project may see (FR-RAG-10). The join drops chunks whose file row is gone, as the select loop would.
 */
function rankGlobal(
  db: Database.Database,
  q: Float32Array,
  dimension: number,
  servable: (contextId: string, originProject: string | null) => boolean,
): { id: string; path: string; score: number; start: number }[] {
  let qn = 0;
  for (const x of q) qn += x * x;
  qn = Math.sqrt(qn);
  const out: { id: string; path: string; score: number; start: number }[] = [];
  const rows = db
    .prepare(
      `SELECT c.id, c.path, c.start_line, c.vector, f.context_id, f.origin_project
       FROM rag_chunk c JOIN rag_file f ON f.path = c.path`,
    )
    .iterate() as IterableIterator<{
    id: string;
    path: string;
    start_line: number;
    vector: Buffer;
    context_id: string;
    origin_project: string | null;
  }>;
  for (const r of rows) {
    if (!servable(r.context_id, r.origin_project ?? null)) continue;
    if (r.vector.byteLength !== dimension * 4) continue;
    const v = new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength));
    let dot = 0;
    let vn = 0;
    for (let i = 0; i < dimension; i++) {
      const x = v[i] as number;
      dot += x * (q[i] as number);
      vn += x * x;
    }
    if (vn === 0 || qn === 0) continue;
    out.push({ id: r.id, path: r.path, score: dot / (Math.sqrt(vn) * qn), start: r.start_line });
  }
  out.sort(byScorePathStart);
  return out;
}

/**
 * The path relative to the context root from a store path `<context id>/<relative path>` (T12.4), or undefined when it
 * does not have that shape or could leave the root.
 */
export function relativeInContext(storePath: string, contextId: string): string | undefined {
  const prefix = `${contextId}/`;
  if (!storePath.startsWith(prefix)) return undefined;
  const rel = storePath.slice(prefix.length);
  if (rel === "" || rel.includes("\0") || rel.includes("\\") || path.posix.isAbsolute(rel)) return undefined;
  if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) return undefined;
  return rel;
}

/** LLD §14.8: the file still has the indexed content and still resolves inside its context root. */
async function isFresh(
  root: string,
  rel: string,
  f: { sha256: string; bytes: bigint; mtime_ns: bigint },
  maxFileBytes: number,
): Promise<boolean> {
  try {
    const abs = path.join(root, ...rel.split("/"));
    const real = await realpath(abs);
    const back = path.relative(root, real);
    if (back === "" || back.startsWith("..") || path.isAbsolute(back)) return false;
    const st = await lstat(real, { bigint: true });
    if (!st.isFile()) return false;
    if (st.size !== f.bytes) return false;
    if (st.mtimeNs === f.mtime_ns) return true;
    if (Number(st.size) > maxFileBytes) return false;
    const fh = await open(real, "r");
    try {
      const buf = Buffer.alloc(maxFileBytes + 1);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      if (n > maxFileBytes) return false;
      return createHash("sha256").update(buf.subarray(0, n)).digest("hex") === f.sha256;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** At most {@link MAX_RESULT_TEXT_BYTES} UTF-8 bytes, cut on a code-point boundary. */
function boundText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_TEXT_BYTES) return text;
  let out = "";
  let n = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (n + b > MAX_RESULT_TEXT_BYTES) break;
    out += ch;
    n += b;
  }
  return out;
}
