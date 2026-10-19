/**
 * `search_project_context` (T12.6, T12.7; FR-RAG-06, FR-RAG-08, FR-RAG-10, LLD §14.7, §14.8, §14.9, ADR-0031): a
 * read-only semantic search over one project's retrieval store and, for `scope: "global"` or `"both"`, the global store,
 * for an MCP client that may use the project.
 *
 * - **Read-only.** Each store is opened `readonly` with `fileMustExist`: a search never creates, migrates, rebuilds or
 *   triggers a build. A missing store, a store with no meta row, or one built for another model or schema is
 *   `status: "unavailable"` (`NOT_BUILT`, `REBUILD_PENDING`), never a tool error (FR-RAG-08).
 * - **Project-scoped.** `scope: "project"` reads only `<data>/rag/projects/<project id>/index.db` of the resolved
 *   project; `"global"` reads only `<data>/rag/global/index.db`; `"both"` reads the two and merges them by score. Either
 *   global scope needs `use_global` (else INVALID_REQUEST, LLD §14.7).
 * - **Global sharing (T12.7, FR-RAG-10).** A global row is served only when its origin is in the injected
 *   `globalOrigins` map (built from the current configuration, exactly as at admission), the row's `origin_project`
 *   matches it, and the origin is not the reading project: a row of a project that stopped contributing is never served,
 *   even before the next global build removes it. Each global hit names its origin (`origin_project` or `source`) and is
 *   freshness-checked against the origin's directory. Fail closed: no `globalOrigins`, a missing global store or one
 *   never built is `GLOBAL_NOT_AVAILABLE`. For `"global"` any global failure is `unavailable` with its code; for
 *   `"both"` the project's results stand and the global failure code is the `reason`.
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
 * Delegated choices (T12.7, not owner-approved): `limit` and the byte bounds apply to the merged answer of `"both"`;
 * `status` and `index_revision` describe the global store for `"global"` and the project store for `"both"`; a stale or
 * incomplete global store still serves freshness-checked hits, as the project store does here (admission skips a stale
 * global store); a global hit's `context_id` is its global-store context id (`project:<id>/<context>` or
 * `source:<label>`).
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
   * T12.7: the global-store origins that may be served now (`globalOrigins` in `src/retrieval/global.ts`). Called only
   * for `scope: "global"` or `"both"`; absent or throwing means the global store is not read (`GLOBAL_NOT_AVAILABLE`).
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
  /** T12.7: a global hit contributed by another project names it; every other hit omits it. */
  readonly origin_project?: string;
  /** T12.7: a global hit from an operator source (`rag.global.sources`) names its label; every other hit omits it. */
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
  }

  let own: Store | undefined;
  let glob: Store | undefined;
  let globalReason: string | undefined;
  try {
    if (scope !== "global") {
      const o = openStore(
        path.join(ragStoreDir(deps.dataDir, { kind: "project", projectId: project.id }), "index.db"),
        "NOT_BUILT",
        embedding.model,
      );
      if (!o.ok) return unavailable(o.reason, o.revision);
      own = o.store;
    }
    if (scope !== "project") {
      const o =
        origins === undefined
          ? { ok: false as const, reason: "GLOBAL_NOT_AVAILABLE", revision: undefined }
          : openStore(
              path.join(ragStoreDir(deps.dataDir, { kind: "global" }), "index.db"),
              "GLOBAL_NOT_AVAILABLE",
              embedding.model,
            );
      if (o.ok) glob = o.store;
      else if (scope === "global") return unavailable(o.reason, o.revision);
      else globalReason = o.reason;
    }
    // The store `status` and `index_revision` describe: the project's, or the global one for `scope: "global"`.
    const main = (own ?? glob) as Store;

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
    if (!q.ok) return unavailable(q.reason, main.meta.revision);
    const qv = q.vectors[0] as Float32Array;
    if (q.dimension !== main.meta.dimension) return unavailable("DIMENSION_MISMATCH", main.meta.revision);
    if (glob !== undefined && glob !== main && q.dimension !== glob.meta.dimension) {
      glob.db.close();
      glob = undefined;
      globalReason = "DIMENSION_MISMATCH";
    }

    let ranked: Candidate[] = [];
    if (own !== undefined) {
      try {
        ranked = rank(own.db, qv, own.meta.dimension);
      } catch {
        return unavailable("STORE_UNREADABLE", own.meta.revision);
      }
    }
    if (glob !== undefined) {
      const servable = (contextId: string, originProject: string | null) =>
        isServable(origins?.get(contextId), originProject, project.id);
      try {
        ranked = [...ranked, ...rank(glob.db, qv, glob.meta.dimension, servable)].sort(byScore);
      } catch {
        if (scope === "global") return unavailable("STORE_UNREADABLE", glob.meta.revision);
        glob.db.close();
        glob = undefined;
        globalReason = "STORE_UNREADABLE";
      }
    }

    const roots = new Map<string, string | null>();
    const rootOf = async (key: string, dir: string | undefined): Promise<string | null> => {
      if (!roots.has(key)) roots.set(key, dir === undefined ? null : await realpath(dir).catch(() => null));
      return roots.get(key) ?? null;
    };
    const stmts = (s: Store) => ({
      file: s.db
        .prepare("SELECT context_id, sha256, bytes, mtime_ns, origin_project FROM rag_file WHERE path = ?")
        .safeIntegers(),
      chunk: s.db.prepare("SELECT start_line, end_line, text FROM rag_chunk WHERE id = ?"),
    });
    const ownStmts = own !== undefined ? stmts(own) : undefined;
    const globStmts = glob !== undefined ? stmts(glob) : undefined;
    const fresh = new Map<string, boolean>();
    const results: SearchHit[] = [];
    let total = 0;
    let truncated = false;
    const maxFileBytes = effective.caps.maxFileBytes;
    for (const cand of ranked.slice(0, limit * SEARCH_CANDIDATE_FACTOR)) {
      if (results.length >= limit) break;
      const st = cand.global ? globStmts : ownStmts;
      if (st === undefined) continue;
      const f = st.file.get(cand.path) as
        | { context_id: string; sha256: string; bytes: bigint; mtime_ns: bigint; origin_project: string | null }
        | undefined;
      if (f === undefined) continue;
      const rel = relativeInContext(cand.path, f.context_id);
      if (rel === undefined) continue;
      let origin: GlobalOrigin | undefined;
      let root: string | null;
      if (cand.global) {
        // Re-checked against the row itself: served only if its origin may share now and is not this project.
        origin = origins?.get(f.context_id);
        if (origin === undefined || !isServable(origin, f.origin_project, project.id)) continue;
        root = await rootOf(`g:${f.context_id}`, origin.root);
      } else {
        root = await rootOf(`p:${f.context_id}`, project.contexts.find((c) => c.id === f.context_id)?.path);
      }
      if (root === null) continue;
      const freshKey = `${cand.global ? "g" : "p"}:${cand.path}`;
      if (!fresh.has(freshKey)) fresh.set(freshKey, await isFresh(root, rel, f, maxFileBytes));
      if (fresh.get(freshKey) !== true) continue;
      const c = st.chunk.get(cand.id) as { start_line: number; end_line: number; text: Buffer } | undefined;
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
        ...(origin?.kind === "project" ? { origin_project: origin.projectId } : {}),
        ...(origin?.kind === "source" ? { source: origin.label } : {}),
      });
    }

    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    const builtMs = Date.parse(main.meta.built_at);
    const stale = !Number.isFinite(builtMs) || nowMs - builtMs > deps.settings.retrieval.maxStalenessMs;
    const status: SearchStatus = stale ? "stale" : main.meta.complete === 1 ? "ok" : "incomplete";
    return finish({
      status,
      ...(globalReason !== undefined ? { reason: globalReason } : {}),
      index_revision: main.meta.revision,
      ...(truncated ? { truncated: true as const } : {}),
      results,
    });
  } finally {
    own?.db.close();
    glob?.db.close();
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

interface Store {
  readonly db: Database.Database;
  readonly meta: MetaRow;
}

/**
 * One store opened read-only with its meta row, or the reason it cannot serve: `missing` when the file or its meta row
 * is absent, `REBUILD_PENDING` for another schema or model, `STORE_UNREADABLE` otherwise. A refused store is closed.
 */
function openStore(
  file: string,
  missing: string,
  model: string,
): { ok: true; store: Store } | { ok: false; reason: string; revision?: number } {
  if (!existsSync(file)) return { ok: false, reason: missing };
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return { ok: false, reason: "STORE_UNREADABLE" };
  }
  let refused: { ok: false; reason: string; revision?: number };
  try {
    if ((db.pragma("user_version", { simple: true }) as number) !== RAG_SCHEMA_VERSION) {
      refused = { ok: false, reason: "REBUILD_PENDING" };
    } else {
      const meta = db.prepare("SELECT * FROM rag_meta LIMIT 1").get() as MetaRow | undefined;
      if (meta === undefined) refused = { ok: false, reason: missing };
      else if (meta.schema_version !== RAG_SCHEMA_VERSION || meta.embedding_model !== model) {
        refused = { ok: false, reason: "REBUILD_PENDING", revision: meta.revision };
      } else return { ok: true, store: { db, meta } };
    }
  } catch {
    refused = { ok: false, reason: "STORE_UNREADABLE" };
  }
  db.close();
  return refused;
}

/**
 * A global row may reach the reading project only when its origin may share now and matches the row, and the origin is
 * not the reading project itself (FR-RAG-10); the same rule as admission's in `src/retrieval/admission.ts`.
 */
function isServable(origin: GlobalOrigin | undefined, originProject: string | null, reader: string): boolean {
  if (origin === undefined) return false;
  if (origin.kind === "source") return originProject === null;
  return origin.projectId === originProject && origin.projectId !== reader;
}

interface Candidate {
  readonly id: string;
  readonly path: string;
  readonly score: number;
  readonly start: number;
  readonly global: boolean;
}

/** Score descending, then path, then start line: each store's order and the merge order of `"both"`. */
const byScore = (a: Candidate, b: Candidate) =>
  b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start);

/**
 * Brute-force cosine similarity over every stored vector (LLD §14.6 step 3, T12.0), best first. With `servable` the
 * store is the global one and a row whose origin it refuses is never scored.
 */
function rank(
  db: Database.Database,
  q: Float32Array,
  dimension: number,
  servable?: (contextId: string, originProject: string | null) => boolean,
): Candidate[] {
  let qn = 0;
  for (const x of q) qn += x * x;
  qn = Math.sqrt(qn);
  const global = servable !== undefined;
  const out: Candidate[] = [];
  const rows = db
    .prepare(
      global
        ? `SELECT c.id, c.path, c.start_line, c.vector, f.context_id, f.origin_project
           FROM rag_chunk c JOIN rag_file f ON f.path = c.path`
        : "SELECT id, path, start_line, vector FROM rag_chunk",
    )
    .iterate() as IterableIterator<{
    id: string;
    path: string;
    start_line: number;
    vector: Buffer;
    context_id?: string;
    origin_project?: string | null;
  }>;
  for (const r of rows) {
    if (servable !== undefined && !servable(r.context_id as string, r.origin_project ?? null)) continue;
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
    out.push({ id: r.id, path: r.path, score: dot / (Math.sqrt(vn) * qn), start: r.start_line, global });
  }
  out.sort(byScore);
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
