/**
 * `search_project_context` (T12.6; FR-RAG-06, FR-RAG-08, LLD §14.7, §14.8, ADR-0031): a read-only semantic search over
 * one project's retrieval store, for an MCP client that may use the project.
 *
 * - **Read-only.** The store is opened `readonly` with `fileMustExist`: a search never creates, migrates, rebuilds or
 *   triggers a build. A missing store, a store with no meta row, or one built for another model or schema is
 *   `status: "unavailable"` (`NOT_BUILT`, `REBUILD_PENDING`), never a tool error (FR-RAG-08).
 * - **Project-scoped.** Only `<data>/rag/projects/<project id>/index.db` of the resolved project is read; the global
 *   store is not (T12.7 builds it), so `scope: "global"` is `unavailable` with `GLOBAL_NOT_AVAILABLE` and `"both"` gives
 *   the project's results with that reason. Either scope still needs `use_global` (else INVALID_REQUEST, LLD §14.7).
 * - **Gated.** The query is embedded through `embedGated`, so the §14.4 gate table and re-redaction apply to it exactly as
 *   to source text (LLD §14.4 Assumption); a denial or backend failure is `unavailable` with the code.
 * - **Bounded.** At most {@link MAX_SEARCH_LIMIT} results (the `retrieval.top_k` maximum), each `text` at most
 *   {@link MAX_RESULT_TEXT_BYTES} (the chunk bound), and the summed `text` at most {@link MAX_SEARCH_TEXT_BYTES}; a
 *   result that would cross the total is left out and `truncated` is set.
 * - **No path outside the project.** A result's `path` is relative to its context root (with `context_id`); a stored path
 *   that is absolute, has a `..` segment or names a context the project no longer has is dropped, and the freshness
 *   check resolves the file with `realpath` and drops it unless it is still inside the context root.
 * - **Fresh** (LLD §14.8). Before a snippet is returned its file is compared with `rag_file`: same size and `mtime_ns`
 *   pass cheaply, otherwise the file is hashed; a changed, vanished or unreadable file drops the snippet.
 *   `status` is `stale` when the store is older than `retrieval.max_staleness`, else `incomplete` when the last build
 *   did not finish, else `ok`.
 *
 * Delegated choices (T12.6, not owner-approved): the bounds above; the added output fields `context_id` and
 * `truncated`; candidates are examined in score order up to four times `limit`, so many stale hits give fewer
 * results rather than an unbounded scan; scores are cosine similarity rounded to six decimals; ties order by path then
 * start line. The call is recorded through the injected `record` (a `rag_record` row of kind `retrieval`, counts only,
 * FR-RAG-12); a recording failure never fails the search.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { effectiveProjectRag, type ProjectRagConfig, type RagSettings } from "../config/index.js";
import type { RagRecordInput } from "../ledger/index.js";
import { type EmbeddingBackend, embedGated, type Locality } from "../retrieval/embedding.js";
import { RAG_SCHEMA_VERSION, ragStoreDir } from "../retrieval/store.js";
import { invalid } from "./errors.js";

export const SEARCH_TOOL_NAME = "search_project_context";
/** The `retrieval.top_k` schema maximum (LLD §14.1). */
export const MAX_SEARCH_LIMIT = 32;
/** The chunk bound of the scanner (T12.0, LLD §14.3). */
export const MAX_RESULT_TEXT_BYTES = 4096;
/** Total `text` bytes in one response (Delegated: the `get_artifacts` inline default). */
export const MAX_SEARCH_TEXT_BYTES = 65_536;
/** Candidates examined per requested result before giving up on stale hits (Delegated). */
export const SEARCH_CANDIDATE_FACTOR = 4;
export const MAX_QUERY_LENGTH = 2000;

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
  if (scope === "global") return unavailable("GLOBAL_NOT_AVAILABLE");

  const file = path.join(ragStoreDir(deps.dataDir, { kind: "project", projectId: project.id }), "index.db");
  if (!existsSync(file)) return unavailable("NOT_BUILT");
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return unavailable("STORE_UNREADABLE");
  }
  try {
    let meta: MetaRow;
    try {
      if ((db.pragma("user_version", { simple: true }) as number) !== RAG_SCHEMA_VERSION) {
        return unavailable("REBUILD_PENDING");
      }
      const row = db.prepare("SELECT * FROM rag_meta LIMIT 1").get() as MetaRow | undefined;
      if (row === undefined) return unavailable("NOT_BUILT");
      meta = row;
    } catch {
      return unavailable("STORE_UNREADABLE");
    }
    if (meta.schema_version !== RAG_SCHEMA_VERSION || meta.embedding_model !== embedding.model) {
      return unavailable("REBUILD_PENDING", meta.revision);
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
    if (!q.ok) return unavailable(q.reason, meta.revision);
    const qv = q.vectors[0] as Float32Array;
    if (q.dimension !== meta.dimension) return unavailable("DIMENSION_MISMATCH", meta.revision);

    let ranked: { id: string; path: string; score: number; start: number }[];
    try {
      ranked = rank(db, qv, meta.dimension);
    } catch {
      return unavailable("STORE_UNREADABLE", meta.revision);
    }

    const roots = new Map<string, string | null>();
    const rootOf = async (contextId: string): Promise<string | null> => {
      if (!roots.has(contextId)) {
        const ctx = project.contexts.find((c) => c.id === contextId);
        roots.set(contextId, ctx === undefined ? null : await realpath(ctx.path).catch(() => null));
      }
      return roots.get(contextId) ?? null;
    };
    const fileStmt = db
      .prepare("SELECT context_id, sha256, bytes, mtime_ns FROM rag_file WHERE path = ?")
      .safeIntegers();
    const chunkStmt = db.prepare("SELECT start_line, end_line, text FROM rag_chunk WHERE id = ?");
    const fresh = new Map<string, boolean>();
    const results: SearchHit[] = [];
    let total = 0;
    let truncated = false;
    const maxFileBytes = effective.caps.maxFileBytes;
    for (const cand of ranked.slice(0, limit * SEARCH_CANDIDATE_FACTOR)) {
      if (results.length >= limit) break;
      const f = fileStmt.get(cand.path) as
        | { context_id: string; sha256: string; bytes: bigint; mtime_ns: bigint }
        | undefined;
      if (f === undefined) continue;
      const rel = relativeInContext(cand.path, f.context_id);
      if (rel === undefined) continue;
      const root = await rootOf(f.context_id);
      if (root === null) continue;
      if (!fresh.has(cand.path)) fresh.set(cand.path, await isFresh(root, rel, f, maxFileBytes));
      if (fresh.get(cand.path) !== true) continue;
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
      });
    }

    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    const builtMs = Date.parse(meta.built_at);
    const stale = !Number.isFinite(builtMs) || nowMs - builtMs > deps.settings.retrieval.maxStalenessMs;
    const status: SearchStatus = stale ? "stale" : meta.complete === 1 ? "ok" : "incomplete";
    return finish({
      status,
      ...(scope === "both" ? { reason: "GLOBAL_NOT_AVAILABLE" } : {}),
      index_revision: meta.revision,
      ...(truncated ? { truncated: true as const } : {}),
      results,
    });
  } finally {
    db.close();
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
  out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start));
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
