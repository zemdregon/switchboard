/**
 * Ledger access for the retrieval index (T12.4; FR-RAG-11, FR-RAG-12, FR-RAG-14, LLD §14.10, ADR-0046): `rag_record`
 * (append-only counts) and `rag_request` (operator rebuild and clear requests). This lives with the ledger, not in
 * `src/retrieval/`, so no retrieval module imports ledger code (the import test in `src/retrieval/embedding.test.ts`);
 * the `serve` daemon and the `index` CLI pass the results across.
 */
import type Database from "better-sqlite3";
import { createIdGenerator, type IdGenerator } from "../ids/index.js";

export type RagRecordKind = "index_built" | "retrieval" | "clear";

/** One `rag_record` row: counts, codes and durations only (FR-RAG-12). */
export interface RagRecordInput {
  readonly kind: RagRecordKind;
  /** NULL for the global store. */
  readonly projectKey: string | null;
  readonly runId?: string | null;
  readonly backendKind?: "local" | "http" | null;
  readonly modelId?: string | null;
  readonly locality?: "local" | "remote" | null;
  readonly outcome: string;
  readonly reason?: string | null;
  readonly revision?: number | null;
  readonly files?: number | null;
  readonly chunks?: number | null;
  readonly bytes?: number | null;
  readonly durationMs?: number | null;
  readonly embedCalls?: number | null;
  /** `retrieval` only (T12.5): the packed snippets' ids and `text_sha256` values, never their text (FR-RAG-05). */
  readonly snippets?: readonly { readonly id: string; readonly textSha256: string }[] | null;
}

export interface RagRecordRow {
  readonly id: string;
  readonly kind: RagRecordKind;
  readonly project_key: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly revision: number | null;
  readonly files: number | null;
  readonly chunks: number | null;
  readonly bytes: number | null;
  readonly duration_ms: number | null;
  readonly embed_calls: number | null;
  readonly created_at: string;
}

export type RagRequestKind = "rebuild" | "clear";

export interface RagRequestRow {
  readonly id: string;
  readonly kind: RagRequestKind;
  readonly store_kind: "project" | "global";
  readonly project_key: string | null;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly applied_at: string | null;
  readonly outcome: "applied" | "rejected" | null;
  readonly detail: string | null;
}

export interface RagLedgerOptions {
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
}

/** True once migration 0015 is applied (a read-only handle on an older ledger has neither table). */
export function hasRagTables(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rag_request'").get() !== undefined;
}

export class RagLedger {
  private readonly ids: IdGenerator;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database.Database,
    opts: RagLedgerOptions = {},
  ) {
    this.ids = opts.ids ?? createIdGenerator();
    this.now = opts.now ?? (() => new Date());
  }

  record(r: RagRecordInput): string {
    const id = this.ids.id("rag");
    this.db
      .prepare(
        `INSERT INTO rag_record (id, kind, project_key, run_id, backend_kind, model_id, locality, outcome, reason, revision,
           files, chunks, bytes, snippet_ids_json, duration_ms, embed_calls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.kind,
        r.projectKey,
        r.runId ?? null,
        r.backendKind ?? null,
        r.modelId ?? null,
        r.locality ?? null,
        r.outcome,
        r.reason ?? null,
        r.revision ?? null,
        r.files ?? null,
        r.chunks ?? null,
        r.bytes ?? null,
        r.snippets == null ? null : JSON.stringify(r.snippets.map((x) => ({ id: x.id, text_sha256: x.textSha256 }))),
        r.durationMs ?? null,
        r.embedCalls ?? null,
        this.now().toISOString(),
      );
    return id;
  }

  /** Newest first. */
  listRecords(projectKey?: string | null, limit = 50): RagRecordRow[] {
    const where =
      projectKey === undefined ? "" : projectKey === null ? "WHERE project_key IS NULL" : "WHERE project_key = ?";
    return this.db
      .prepare(
        `SELECT id, kind, project_key, outcome, reason, revision, files, chunks, bytes, duration_ms, embed_calls, created_at
         FROM rag_record ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...(projectKey ? [projectKey] : []), limit) as RagRecordRow[];
  }

  request(kind: RagRequestKind, projectKey: string | null, requestedBy: string): RagRequestRow {
    const id = this.ids.id("rrq");
    this.db
      .prepare(
        `INSERT INTO rag_request (id, kind, store_kind, project_key, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, kind, projectKey === null ? "global" : "project", projectKey, requestedBy, this.now().toISOString());
    return this.db.prepare("SELECT * FROM rag_request WHERE id = ?").get(id) as RagRequestRow;
  }

  /** Oldest first. */
  pending(): RagRequestRow[] {
    return this.db
      .prepare("SELECT * FROM rag_request WHERE applied_at IS NULL ORDER BY requested_at, id")
      .all() as RagRequestRow[];
  }

  /** Close a pending request once; returns false when it was already closed. */
  settle(id: string, outcome: "applied" | "rejected", detail: string | null): boolean {
    return (
      this.db
        .prepare("UPDATE rag_request SET applied_at = ?, outcome = ?, detail = ? WHERE id = ? AND applied_at IS NULL")
        .run(this.now().toISOString(), outcome, detail, id).changes === 1
    );
  }
}
