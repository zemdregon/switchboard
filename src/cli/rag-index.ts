/**
 * Retrieval index operations (T12.4; FR-RAG-11, FR-RAG-14, LLD §14.1, §14.5, §14.10, ADR-0046):
 * `switchboard index status|rebuild|clear [project|global]`, the `doctor` section, and the `serve` wiring of the
 * background build.
 *
 * - `status` is read-only: it opens stores and the ledger read-only and creates nothing.
 * - `rebuild` and `clear` write only operator records (`rag_request` rows) that the `serve` daemon applies within its
 *   operator poll. When no daemon holds the data-directory lock, `clear` takes the lock and applies itself at once (as
 *   `approve` does); `rebuild` stays pending until `serve` starts, since only the daemon builds.
 * - `clear` deletes the store's vectors and chunk text (the whole store directory) and writes one `rag_record` row of
 *   kind `clear` with the counts it removed; the ledger keeps nothing else (FR-RAG-14).
 * - The bare word `global` names the global store (Delegated: a project whose id is literally `global` is covered by
 *   the no-argument form only). The daemon builds the global store (T12.7) only while `rag.global.enabled` is set, so
 *   `rebuild global` is refused otherwise.
 *
 * Retrieval content never passes through here: reports hold counts, revisions, hashes of nothing and reason codes.
 */
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  type EffectiveProjectRag,
  effectiveProjectRag,
  loadConfig,
  type RagSettings,
  type ResolvedConfig,
  type ResolvedProject,
} from "../config/index.js";
import { hasRagTables, LEDGER_FILE_NAME, openLedger, RagLedger, type RagRequestRow } from "../ledger/index.js";
import type { ContextPackOutcome, ContextPackRequest } from "../lifecycle/index.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import { DynamicProjectStore, toResolved } from "../projects/index.js";
import { retrieveContextPack } from "../retrieval/admission.js";
import { type BuildProject, type BuildResult, buildProjectIndex, contextHead } from "../retrieval/build.js";
import type { EmbeddingBackend, Locality } from "../retrieval/embedding.js";
import { buildGlobalIndex, GLOBAL_INDEX_KEY, globalOrigins, isUntrustedProfile } from "../retrieval/global.js";
import { createHttpEmbedder } from "../retrieval/http-embedder.js";
import { RagIndexer } from "../retrieval/indexer.js";
import { deleteRagStore, inspectRagStore, type RagStoreKey, ragRoot } from "../retrieval/store.js";
import type { CheckStatus, DoctorCheck } from "./doctor.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";
import { UnknownProjectError } from "./projects.js";

export const GLOBAL_TARGET = "global";

type Embedding = NonNullable<RagSettings["embedding"]>;

/** Every project the daemon serves: configured ones, then dynamic ones with a revision in force (T9.9). */
export function ragProjects(config: ResolvedConfig, db: Database.Database | undefined): ResolvedProject[] {
  const out = [...config.projects];
  if (db === undefined) return out;
  const configured = new Set(out.map((p) => p.id));
  try {
    for (const s of new DynamicProjectStore(db).list()) {
      if (s.deleted || s.inForce === undefined || configured.has(s.projectId)) continue;
      out.push(toResolved(s.inForce.definition));
    }
  } catch {
    // an older or unreadable ledger: configured projects only
  }
  return out;
}

export function toBuildProject(rag: RagSettings, p: ResolvedProject): BuildProject {
  return {
    id: p.id,
    effective: effectiveProjectRag(rag, p.rag),
    ...(isUntrustedProfile(p.maxTrustProfile) ? { untrusted: true } : {}),
    contexts: p.contexts.map((c) => ({
      id: c.id,
      path: c.path,
      primary: c.primary,
      ...(c.rag !== undefined ? { rag: c.rag } : {}),
    })),
  };
}

/** The configured embedding backend (the `http` kind; `local` is refused at load, T12.0), or the test seam. */
export function ragBackendFor(io: Pick<CliIo, "ragBackend">, embedding: Embedding): EmbeddingBackend {
  return io.ragBackend ?? createHttpEmbedder(embedding);
}

const keyFor = (projectKey: string | null): RagStoreKey =>
  projectKey === null ? { kind: "global" } : { kind: "project", projectId: projectKey };

function osUser(io: CliIo): string {
  if (io.user !== undefined) return io.user;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

// ---- clear (shared by the CLI and the daemon) -------------------------------------------------------------------------

export interface ClearResult {
  readonly project_key: string | null;
  readonly removed: boolean;
  readonly files: number;
  readonly chunks: number;
  readonly bytes: number;
}

/** Delete one store and record the counts it held (FR-RAG-14). A store this version cannot read is still deleted. */
export function clearRagStore(dataDir: string, rag: RagLedger, projectKey: string | null): ClearResult {
  const key = keyFor(projectKey);
  let counts = { files: 0, chunks: 0, textBytes: 0, revision: null as number | null };
  try {
    const ins = inspectRagStore(dataDir, key);
    if (ins !== undefined) {
      counts = { files: ins.files, chunks: ins.chunks, textBytes: ins.textBytes, revision: ins.meta?.revision ?? null };
    }
  } catch {
    // unreadable store: delete it anyway, counts unknown (recorded as zero)
  }
  const removed = deleteRagStore(dataDir, key);
  rag.record({
    kind: "clear",
    projectKey,
    outcome: removed ? "ok" : "empty",
    revision: counts.revision,
    files: counts.files,
    chunks: counts.chunks,
    bytes: counts.textBytes,
  });
  return { project_key: projectKey, removed, files: counts.files, chunks: counts.chunks, bytes: counts.textBytes };
}

// ---- serve wiring -----------------------------------------------------------------------------------------------------

export interface ServeRagLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface ServeRag {
  readonly indexer: RagIndexer;
  /**
   * T12.5 (FR-RAG-05, FR-RAG-08, LLD §14.6): the context pack for one run, behind the lifecycle's `contextPack` port.
   * Records one `rag_record` row of kind `retrieval` (snippet ids and hashes, no text) and returns the run event's
   * payload. When the store is missing, stale, flagged or had a changed file, it queues a refresh (never awaited).
   */
  prepareContextPack(request: ContextPackRequest): Promise<ContextPackOutcome | undefined>;
  /** Apply pending `index rebuild|clear` requests; called from the daemon's operator poll. */
  applyRequests(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start background indexing for `serve`, or return undefined when no embedding backend is configured (the feature is
 * inert, FR-RAG-04). Never awaits a build: `start` only queues every project (FR-RAG-11).
 */
export function startServeRag(opts: {
  readonly io: Pick<CliIo, "ragBackend" | "homedir">;
  readonly config: ResolvedConfig;
  readonly db: Database.Database;
  readonly log: ServeRagLogger;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}): ServeRag | undefined {
  const embedding = opts.config.rag.embedding;
  if (embedding === undefined) return undefined;
  const { config, db, log } = opts;
  const backend = ragBackendFor(opts.io, embedding);
  const rag = new RagLedger(db, opts.now ? { now: opts.now } : {});
  const projectsNow = () => ragProjects(config, db).map((p) => toBuildProject(config.rag, p));

  const indexer: RagIndexer = new RagIndexer({
    // T12.7: the global store is queued after every project, so it copies their latest contributions.
    projects: () => [
      ...projectsNow()
        .filter((p) => p.effective.enabled)
        .map((p) => p.id),
      ...(config.rag.global.enabled ? [GLOBAL_INDEX_KEY] : []),
    ],
    build: async (projectId, signal): Promise<BuildResult | undefined> => {
      const buildDeps = {
        dataDir: config.dataDir,
        backend,
        embedding,
        signal,
        ...(opts.io.homedir !== undefined ? { homeDir: opts.io.homedir } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      };
      if (projectId === GLOBAL_INDEX_KEY) {
        return buildGlobalIndex(buildDeps, {
          global: config.rag.global,
          caps: config.rag.caps,
          exclude: config.rag.exclude,
          projects: projectsNow(),
          allowedRoots: config.allowedRoots,
        });
      }
      const project = projectsNow().find((p) => p.id === projectId);
      if (project === undefined) return undefined;
      return buildProjectIndex(buildDeps, project);
    },
    onResult: (r) => {
      // A contributing project whose store changed refreshes the global store (never awaited).
      if (r.projectKey !== null && (r.filesEmbedded > 0 || r.filesRemoved > 0) && config.rag.global.enabled) {
        const p = projectsNow().find((x) => x.id === r.projectKey);
        if (p?.effective.enabled === true && p.effective.contributeToGlobal) indexer.trigger(GLOBAL_INDEX_KEY);
      }
      rag.record({
        kind: "index_built",
        projectKey: r.projectKey,
        backendKind: r.backendKind,
        modelId: r.modelId,
        locality: r.locality,
        outcome: r.outcome,
        reason: r.reason,
        revision: r.revision,
        files: r.files,
        chunks: r.chunks,
        bytes: r.bytes,
        durationMs: r.durationMs,
        embedCalls: r.embedCalls,
      });
      log.info("retrieval index build finished", {
        project_key: r.projectKey ?? "global",
        outcome: r.outcome,
        reason: r.reason,
        revision: r.revision,
        files: r.files,
        chunks: r.chunks,
        files_embedded: r.filesEmbedded,
        files_removed: r.filesRemoved,
        duration_ms: r.durationMs,
      });
    },
    onError: (projectId, err) =>
      log.warn("retrieval index build failed", {
        project_key: projectId,
        error: (err instanceof Error ? err.message : String(err)).split("\n")[0],
      }),
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
  });

  let applying = false;
  const applyRequests = async (): Promise<void> => {
    if (applying) return;
    applying = true;
    try {
      for (const req of rag.pending()) {
        const settled = await applyDaemonRequest(req, { config, rag, indexer, projects: projectsNow() });
        log.info("operator index request applied", {
          request_id: req.id,
          kind: req.kind,
          project_key: req.project_key,
          outcome: settled.outcome,
          detail: settled.detail,
        });
      }
    } catch (err) {
      log.warn("applying operator index requests failed", {
        error: (err instanceof Error ? err.message : String(err)).split("\n")[0],
      });
    } finally {
      applying = false;
    }
  };

  const prepareContextPack = async (request: ContextPackRequest): Promise<ContextPackOutcome | undefined> => {
    const project = projectsNow().find((p) => p.id === request.projectId);
    if (project === undefined || !project.effective.enabled) return undefined;
    const r = await retrieveContextPack(
      {
        dataDir: config.dataDir,
        backend,
        embedding,
        retrieval: config.rag.retrieval,
        ...(opts.io.homedir !== undefined ? { homeDir: opts.io.homedir } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      },
      {
        project,
        objective: request.objective,
        baseCommit: request.baseCommit,
        ...(request.primaryRoot !== undefined ? { primaryRoot: request.primaryRoot } : {}),
        ...(project.effective.useGlobal ? { globalOrigins: globalOrigins(config.rag.global, projectsNow()) } : {}),
        signal: request.signal,
      },
    );
    // LLD §14.5 step 1: a run for the project refreshes a store that is missing, stale or behind the run's base.
    if (
      r.reason === "NO_INDEX" ||
      r.reason === "REBUILD_PENDING" ||
      r.outcome === "stale" ||
      r.droppedChanged > 0 ||
      r.flags.includes("base_ref_mismatch")
    ) {
      indexer.trigger(project.id);
    }
    if (r.flags.includes("global_unavailable") || r.flags.includes("global_stale")) indexer.trigger(GLOBAL_INDEX_KEY);
    const recordId = rag.record({
      kind: "retrieval",
      projectKey: r.projectKey,
      runId: request.runId,
      backendKind: r.backendKind,
      modelId: r.modelId,
      locality: r.locality,
      outcome: r.outcome,
      reason: r.reason,
      revision: r.revision,
      chunks: r.snippets.length,
      bytes: r.text === null ? 0 : Buffer.byteLength(r.text, "utf8"),
      durationMs: r.durationMs,
      embedCalls: r.embedCalls,
      snippets: r.snippets,
    });
    return {
      text: r.text,
      event: {
        record_id: recordId,
        outcome: r.outcome,
        ...(r.reason !== null ? { reason: r.reason } : {}),
        revision: r.revision,
        snippets: r.snippets.length,
        global_snippets: r.globalSnippets,
        global_revision: r.globalRevision,
        tokens_est: r.tokensEst,
        candidates: r.candidates,
        dropped_changed: r.droppedChanged,
        flags: [...r.flags],
        duration_ms: r.durationMs,
      },
    };
  };

  indexer.start();
  return { indexer, applyRequests, prepareContextPack, stop: () => indexer.stop() };
}

async function applyDaemonRequest(
  req: RagRequestRow,
  ctx: { config: ResolvedConfig; rag: RagLedger; indexer: RagIndexer; projects: readonly BuildProject[] },
): Promise<{ outcome: "applied" | "rejected"; detail: string | null }> {
  const settle = (outcome: "applied" | "rejected", detail: string | null) => {
    ctx.rag.settle(req.id, outcome, detail);
    return { outcome, detail };
  };
  if (req.kind === "clear") {
    const key = req.project_key;
    const r =
      key === null
        ? await ctx.indexer.exclusive(GLOBAL_INDEX_KEY, () => clearRagStore(ctx.config.dataDir, ctx.rag, null))
        : await ctx.indexer.exclusive(key, () => clearRagStore(ctx.config.dataDir, ctx.rag, key));
    return settle("applied", r.removed ? `files=${r.files} chunks=${r.chunks}` : "EMPTY");
  }
  if (req.project_key === null) {
    if (!ctx.config.rag.global.enabled) return settle("rejected", "GLOBAL_OFF");
    await ctx.indexer.exclusive(GLOBAL_INDEX_KEY, () => deleteRagStore(ctx.config.dataDir, { kind: "global" }));
    ctx.indexer.trigger(GLOBAL_INDEX_KEY);
    return settle("applied", "QUEUED");
  }
  const key = req.project_key;
  const project = ctx.projects.find((p) => p.id === key);
  if (project === undefined) return settle("rejected", "UNKNOWN_PROJECT");
  if (!project.effective.enabled) return settle("rejected", project.effective.reason);
  await ctx.indexer.exclusive(key, () => deleteRagStore(ctx.config.dataDir, { kind: "project", projectId: key }));
  ctx.indexer.trigger(key);
  return settle("applied", "QUEUED");
}

// ---- status -----------------------------------------------------------------------------------------------------------

export interface RagBackendView {
  readonly kind: "http" | "local";
  readonly model: string;
  readonly locality: Locality | null;
  readonly allow_remote: boolean;
  readonly allow_source_content: boolean;
  /** The §14.4 gate for source content: null when allowed, else the reason code. */
  readonly gate: string | null;
}

export interface RagStoreView {
  readonly store: "project" | "global";
  readonly project_key: string | null;
  /** `on`, or `off` with `off_reason`. */
  readonly mode: "on" | "off";
  readonly off_reason: string | null;
  readonly exists: boolean;
  readonly files: number;
  readonly chunks: number;
  readonly text_bytes: number;
  readonly disk_bytes: number;
  readonly revision: number | null;
  readonly complete: boolean | null;
  readonly built_at: string | null;
  readonly base_ref_sha: string | null;
  readonly age_ms: number | null;
  /** Older than `retrieval.max_staleness`, or the primary context's `HEAD` moved since the build; null if never built. */
  readonly stale: boolean | null;
  readonly head_changed: boolean | null;
  readonly last_build: { outcome: string; reason: string | null; at: string } | null;
  readonly pending_requests: { id: string; kind: string; requested_by: string; requested_at: string }[];
  /** Set when the store cannot be read (for example, written by a newer version). */
  readonly error: string | null;
}

export interface IndexStatusReport {
  readonly schema_version: number;
  /** Null when no embedding backend is configured: retrieval is off everywhere. */
  readonly backend: RagBackendView | null;
  readonly stores: RagStoreView[];
}

function dataDirConfig(io: CliIo, argv: readonly string[]): ResolvedConfig {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
}

async function withReadOnlyLedger<T>(
  dataDir: string,
  fn: (db: Database.Database | undefined) => Promise<T>,
): Promise<T> {
  const file = path.join(dataDir, LEDGER_FILE_NAME);
  if (!existsSync(file)) return fn(undefined);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export async function backendView(
  io: Pick<CliIo, "ragBackend">,
  embedding: Embedding | undefined,
): Promise<{ view: RagBackendView | null; backend: EmbeddingBackend | undefined }> {
  if (embedding === undefined) return { view: null, backend: undefined };
  const backend = ragBackendFor(io, embedding);
  let locality: Locality | null;
  try {
    locality = await backend.resolveLocality(AbortSignal.timeout(embedding.timeoutMs));
  } catch {
    locality = "remote"; // unresolved is remote (LLD §13.2)
  }
  const gate =
    locality === "local"
      ? null
      : !embedding.allowRemote
        ? "REMOTE_NOT_ALLOWED"
        : !embedding.allowSourceContent
          ? "SOURCE_CONTENT_NOT_ALLOWED"
          : null;
  return {
    backend,
    view: {
      kind: backend.kind,
      model: embedding.model,
      locality,
      allow_remote: embedding.allowRemote,
      allow_source_content: embedding.allowSourceContent,
      gate,
    },
  };
}

/** Store names present on disk under `rag/projects/` (valid or not; `inspectRagStore` refuses an invalid one). */
function storesOnDisk(dataDir: string): string[] {
  try {
    return readdirSync(path.join(ragRoot(dataDir), "projects")).sort();
  } catch {
    return [];
  }
}

async function storeView(
  config: ResolvedConfig,
  projectKey: string | null,
  effective: EffectiveProjectRag | undefined,
  primaryRoot: string | undefined,
  ledger: { records: RagLedger | undefined; pending: RagRequestRow[] },
  now: Date,
): Promise<RagStoreView> {
  const key = keyFor(projectKey);
  let ins: ReturnType<typeof inspectRagStore>;
  let error: string | null = null;
  try {
    ins = inspectRagStore(config.dataDir, key);
  } catch (err) {
    error = (err as { code?: string }).code ?? "UNREADABLE";
  }
  const meta = ins?.meta;
  const ageMs = meta ? Math.max(0, now.getTime() - Date.parse(meta.builtAt)) : null;
  let headChanged: boolean | null = null;
  if (meta?.baseRefSha && primaryRoot !== undefined) {
    const head = await contextHead(primaryRoot);
    headChanged = head === null ? null : head !== meta.baseRefSha;
  }
  const last = ledger.records?.listRecords(projectKey, 20).find((r) => r.kind === "index_built");
  const off =
    projectKey === null
      ? config.rag.global.enabled
        ? null
        : "GLOBAL_OFF"
      : effective === undefined
        ? "UNKNOWN_PROJECT"
        : effective.enabled
          ? null
          : effective.reason;
  return {
    store: projectKey === null ? "global" : "project",
    project_key: projectKey,
    mode: off === null ? "on" : "off",
    off_reason: off,
    exists: ins !== undefined,
    files: ins?.files ?? 0,
    chunks: ins?.chunks ?? 0,
    text_bytes: ins?.textBytes ?? 0,
    disk_bytes: ins?.diskBytes ?? 0,
    revision: meta?.revision ?? null,
    complete: meta ? meta.complete : null,
    built_at: meta?.builtAt ?? null,
    base_ref_sha: meta?.baseRefSha ?? null,
    age_ms: ageMs,
    stale: ageMs === null ? null : ageMs > config.rag.retrieval.maxStalenessMs || headChanged === true,
    head_changed: headChanged,
    last_build: last ? { outcome: last.outcome, reason: last.reason, at: last.created_at } : null,
    pending_requests: ledger.pending
      .filter((p) => p.project_key === projectKey)
      .map((p) => ({ id: p.id, kind: p.kind, requested_by: p.requested_by, requested_at: p.requested_at })),
    error,
  };
}

/** Build the status report for every store, one project, or the global store. Read-only. */
export async function ragStatus(
  io: CliIo,
  config: ResolvedConfig,
  target: string | undefined,
): Promise<IndexStatusReport> {
  const { view } = await backendView(io, config.rag.embedding);
  const now = (io.now ?? (() => new Date()))();
  return withReadOnlyLedger(config.dataDir, async (db) => {
    const usable = db !== undefined && hasRagTables(db);
    const ledger = {
      records: usable ? new RagLedger(db) : undefined,
      pending: usable ? new RagLedger(db).pending() : [],
    };
    const projects = ragProjects(config, db);
    const byId = new Map(projects.map((p) => [p.id, p]));
    let keys: (string | null)[];
    if (target === GLOBAL_TARGET) keys = [null];
    else if (target !== undefined) {
      if (!byId.has(target) && !storesOnDisk(config.dataDir).includes(target)) {
        throw new UnknownProjectError(`unknown project ${target}`);
      }
      keys = [target];
    } else {
      const names = new Set([...projects.map((p) => p.id), ...storesOnDisk(config.dataDir)]);
      keys = [...names].sort();
      if (config.rag.global.enabled || existsSync(path.join(ragRoot(config.dataDir), "global"))) keys.push(null);
    }
    const stores: RagStoreView[] = [];
    for (const k of keys) {
      const p = k === null ? undefined : byId.get(k);
      const primary = p?.contexts.find((c) => c.primary) ?? p?.contexts[0];
      stores.push(
        await storeView(
          config,
          k,
          p === undefined ? undefined : effectiveProjectRag(config.rag, p.rag),
          primary?.path,
          ledger,
          now,
        ),
      );
    }
    return { schema_version: JSON_SCHEMA_VERSION, backend: view, stores };
  });
}

export async function indexStatus(io: CliIo, argv: readonly string[], target?: string): Promise<IndexStatusReport> {
  return ragStatus(io, dataDirConfig(io, argv), target);
}

const fmtBytes = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;

function storeDetail(s: RagStoreView): string {
  if (s.error !== null) return `unreadable store (${s.error})`;
  const mode = s.mode === "on" ? "on" : `off (${s.off_reason})`;
  if (!s.exists) return `${mode}; no index yet`;
  if (s.revision === null) return `${mode}; empty store, ${fmtBytes(s.disk_bytes)} on disk`;
  const fresh = s.stale ? `stale${s.head_changed ? " (HEAD moved)" : ""}` : "fresh";
  return (
    `${mode}; revision ${s.revision}, ${s.complete ? "complete" : "INCOMPLETE"}, ${s.files} files, ` +
    `${s.chunks} chunks, ${fmtBytes(s.text_bytes)} text, ${fmtBytes(s.disk_bytes)} on disk; built ${s.built_at}, ${fresh}`
  );
}

export function renderStoreLine(s: RagStoreView): string {
  return `${s.project_key ?? "global"}: ${storeDetail(s)}`;
}

function backendDetail(b: RagBackendView): string {
  return (
    `${b.kind} ${b.model}, locality ${b.locality ?? "unknown"}` +
    (b.gate === null ? "" : `; refused by the privacy gate (${b.gate}), nothing is built`)
  );
}

export function renderBackendLine(b: RagBackendView | null): string {
  return b === null ? "retrieval: off (no embedding backend configured)" : `backend: ${backendDetail(b)}`;
}

export function renderIndexStatus(r: IndexStatusReport): string {
  const lines = [renderBackendLine(r.backend)];
  if (r.stores.length === 0) lines.push("no projects");
  for (const s of r.stores) {
    lines.push(renderStoreLine(s));
    if (s.last_build) {
      lines.push(
        `  last build: ${s.last_build.outcome}${s.last_build.reason ? ` (${s.last_build.reason})` : ""} at ${s.last_build.at}`,
      );
    }
    for (const p of s.pending_requests)
      lines.push(`  pending ${p.kind} requested by ${p.requested_by} at ${p.requested_at}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- rebuild and clear ------------------------------------------------------------------------------------------------

export interface IndexRequestReport {
  readonly schema_version: number;
  readonly kind: "rebuild" | "clear";
  readonly daemon_running: boolean;
  readonly requests: {
    readonly id: string;
    readonly project_key: string | null;
    /** `requested`: the daemon applies it (or, for rebuild, `serve` at its next start); `applied`: done now. */
    readonly status: "requested" | "applied";
    readonly cleared?: ClearResult;
  }[];
}

/**
 * `index rebuild|clear [target]`. Writes one `rag_request` per store; with no daemon, `clear` is applied at once under
 * the data-directory lock.
 */
export function indexRequest(
  io: CliIo,
  argv: readonly string[],
  kind: "rebuild" | "clear",
  target?: string,
): IndexRequestReport {
  const config = dataDirConfig(io, argv);
  if (kind === "rebuild" && target === GLOBAL_TARGET && !config.rag.global.enabled) {
    throw new UsageError("the global index is off (rag.global.enabled is not set); nothing to rebuild");
  }
  let lock: ReturnType<typeof acquireDataDirLock> | undefined;
  let daemon = false;
  try {
    lock = acquireDataDirLock(config.dataDir);
  } catch (err) {
    if (!(err instanceof LockError) || inspectDataDirLock(config.dataDir).state !== "held") throw err;
    daemon = true;
  }
  try {
    const db = openLedger(config.dataDir);
    try {
      const projects = ragProjects(config, db);
      const byId = new Map(projects.map((p) => [p.id, p]));
      let keys: (string | null)[];
      if (target === GLOBAL_TARGET) keys = [null];
      else if (target !== undefined) {
        const onDisk = storesOnDisk(config.dataDir).includes(target);
        if (!byId.has(target) && !(kind === "clear" && onDisk))
          throw new UnknownProjectError(`unknown project ${target}`);
        if (kind === "rebuild") {
          const eff = effectiveProjectRag(config.rag, byId.get(target)?.rag);
          if (!eff.enabled) {
            throw new UsageError(`retrieval is off for project ${target} (${eff.reason}); nothing to rebuild`);
          }
        }
        keys = [target];
      } else if (kind === "rebuild") {
        keys = projects.filter((p) => effectiveProjectRag(config.rag, p.rag).enabled).map((p) => p.id);
        if (config.rag.global.enabled && config.rag.embedding !== undefined) keys.push(null);
      } else {
        keys = storesOnDisk(config.dataDir);
        if (existsSync(path.join(ragRoot(config.dataDir), "global"))) keys.push(null);
      }
      const rag = new RagLedger(db, io.now ? { now: io.now } : {});
      const by = osUser(io);
      const requests: IndexRequestReport["requests"][number][] = [];
      for (const k of keys) {
        const row = rag.request(kind, k, by);
        if (kind === "clear" && !daemon) {
          const cleared = clearRagStore(config.dataDir, rag, k);
          rag.settle(row.id, "applied", cleared.removed ? `files=${cleared.files} chunks=${cleared.chunks}` : "EMPTY");
          requests.push({ id: row.id, project_key: k, status: "applied", cleared });
        } else {
          requests.push({ id: row.id, project_key: k, status: "requested" });
        }
      }
      return { schema_version: JSON_SCHEMA_VERSION, kind, daemon_running: daemon, requests };
    } finally {
      db.close();
    }
  } finally {
    lock?.release();
  }
}

export function renderIndexRequest(r: IndexRequestReport): string {
  if (r.requests.length === 0) return `nothing to ${r.kind}\n`;
  return r.requests
    .map((q) => {
      const name = q.project_key ?? "global";
      if (q.status === "applied" && q.cleared) {
        return q.cleared.removed
          ? `${name}: cleared ${q.cleared.files} files, ${q.cleared.chunks} chunks (vectors and chunk text deleted; the ledger keeps the counts)\n`
          : `${name}: nothing stored; recorded\n`;
      }
      const when = r.daemon_running
        ? "the running serve daemon applies it within a second"
        : "serve applies it when it starts";
      return `${name}: ${r.kind} requested; ${when}\n`;
    })
    .join("");
}

// ---- doctor -----------------------------------------------------------------------------------------------------------

export interface RagDoctorSection {
  readonly checks: DoctorCheck[];
  readonly backend: RagBackendView;
  readonly probe: {
    readonly attempted: boolean;
    readonly reachable: boolean | null;
    readonly dimension: number | null;
    /** A fixed code from the backend, or the gate reason when the probe was not attempted. */
    readonly detail: string | null;
  };
  readonly stores: RagStoreView[];
}

const chk = (id: string, label: string, status: CheckStatus, detail: string): DoctorCheck => ({
  id,
  label,
  status,
  detail,
});

/**
 * FR-RAG-14: backend, locality, reachability (`probe` sends only its built-in text, and never to a remote endpoint the
 * gate refuses), and per store the size, revision, completeness and staleness. Present only when `rag.embedding` is
 * configured, so the report is unchanged otherwise. Findings are at most warnings and never change `ok`.
 */
export async function ragDoctorSection(io: CliIo, cfg: ResolvedConfig): Promise<RagDoctorSection | undefined> {
  const embedding = cfg.rag.embedding;
  if (embedding === undefined) return undefined;
  const status = await ragStatus(io, cfg, undefined);
  const { backend } = await backendView(io, embedding);
  const view = status.backend as RagBackendView;
  const checks: DoctorCheck[] = [
    chk("rag_backend", "Retrieval backend", view.gate === null ? "ok" : "warn", backendDetail(view)),
  ];
  let probe: RagDoctorSection["probe"] = { attempted: false, reachable: null, dimension: null, detail: view.gate };
  if (view.gate === "REMOTE_NOT_ALLOWED" || backend === undefined) {
    checks.push(chk("rag_probe", "Retrieval backend probe", "skip", `not attempted (${view.gate ?? "NO_BACKEND"})`));
  } else {
    try {
      const p = await backend.probe(AbortSignal.timeout(embedding.timeoutMs));
      probe = { attempted: true, reachable: p.reachable, dimension: p.dimension ?? null, detail: p.detail };
    } catch {
      probe = { attempted: true, reachable: false, dimension: null, detail: "FAILED" };
    }
    checks.push(
      chk(
        "rag_probe",
        "Retrieval backend probe",
        probe.reachable ? "ok" : "warn",
        probe.reachable
          ? `reachable${probe.dimension !== null ? `, dimension ${probe.dimension}` : ""}`
          : `unreachable (${probe.detail}); indexes are not built and retrieval falls back to none`,
      ),
    );
  }
  for (const s of status.stores) {
    const healthy = s.error === null && s.exists && s.complete === true && s.stale === false;
    const st: CheckStatus = s.mode === "off" ? "skip" : healthy ? "ok" : "warn";
    checks.push(
      chk(`rag_index_${s.project_key ?? "global"}`, `Index ${s.project_key ?? "global"}`, st, storeDetail(s)),
    );
  }
  return { checks, backend: view, probe, stores: status.stores };
}

export function renderRagDoctor(s: RagDoctorSection, mark: Record<CheckStatus, string>): string[] {
  return ["", "Retrieval index:", ...s.checks.map((c) => `${mark[c.status]} ${c.label}: ${c.detail}`)];
}
