/**
 * `switchboard projects sources list|approve <id>|reject <id>` (ADR-0080 item 8): the operator's path for the owner
 * requests that `request_project_source` writes. An approved owner joins `project_sources.allowed_owners` at once: a
 * running `serve` reads the decision row at its next check. Locking follows `projects approve` (ADR-0005): the
 * data-directory lock is taken when free; while a daemon holds it the decision is still written as one append-only row.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { ApprovalRefusedError } from "../lifecycle/approval.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import {
  ProjectSourceError,
  ProjectSourceGrantStore,
  type ProjectSourceRequestRow,
  type ProjectSourceStatus,
} from "../projects/index.js";
import { type CliIo, JSON_SCHEMA_VERSION } from "./io.js";
import { osUser } from "./projects-dynamic.js";

export interface SourceRequestView {
  id: string;
  client_id: string;
  host: string;
  owner: string;
  requested_at: string;
  status: ProjectSourceStatus;
  decided_by?: string;
  decided_at?: string;
}

export interface SourceDecisionReport {
  schema_version: number;
  request_id: string;
  host: string;
  owner: string;
  decision: "approved" | "rejected";
  decided_by: string;
  decided_at: string;
  daemon_running: boolean;
}

const view = (r: ProjectSourceRequestRow): SourceRequestView => ({ ...r });

function load(io: CliIo, argv: readonly string[]) {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
}

/** Read-only: every request, or none when there is no ledger or no `project_source_request` table. */
export function listSourceRequests(io: CliIo, argv: readonly string[]): SourceRequestView[] {
  const config = load(io, argv);
  const file = path.join(config.dataDir, LEDGER_FILE_NAME);
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_source_request'")
      .get();
    if (!has) return [];
    return new ProjectSourceGrantStore(db).list().map(view);
  } finally {
    db.close();
  }
}

export function decideSourceRequest(
  io: CliIo,
  argv: readonly string[],
  id: string,
  opts: { reject: boolean },
): SourceDecisionReport {
  const config = load(io, argv);
  if (!existsSync(path.join(config.dataDir, LEDGER_FILE_NAME))) {
    throw new ApprovalRefusedError(`unknown project source request ${id}`);
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
      const store = new ProjectSourceGrantStore(db, { ids: createIdGenerator(), ...(io.now ? { now: io.now } : {}) });
      try {
        const row = store.decide({
          requestId: id,
          decision: opts.reject ? "REJECTED" : "APPROVED",
          decidedBy: osUser(io),
        });
        return {
          schema_version: JSON_SCHEMA_VERSION,
          request_id: row.id,
          host: row.host,
          owner: row.owner,
          decision: opts.reject ? "rejected" : "approved",
          decided_by: row.decided_by as string,
          decided_at: row.decided_at as string,
          daemon_running: daemon,
        };
      } catch (err) {
        if (err instanceof ProjectSourceError) throw new ApprovalRefusedError(err.message);
        throw err;
      }
    } finally {
      db.close();
    }
  } finally {
    lock?.release();
  }
}

export function renderSourceRequests(rows: readonly SourceRequestView[]): string {
  if (rows.length === 0) return "No project source requests.\n";
  return `${rows
    .map(
      (r) =>
        `${r.id}\t${r.status.toLowerCase()}\t${r.owner} on ${r.host}\tclient ${r.client_id}\t${r.requested_at}` +
        `${r.decided_by !== undefined ? `\tby ${r.decided_by}` : ""}`,
    )
    .join("\n")}\n`;
}

export function renderSourceDecision(r: SourceDecisionReport): string {
  return (
    `project source request ${r.request_id} (${r.owner} on ${r.host}): ${r.decision} by ${r.decided_by}` +
    `${r.daemon_running ? " (serve is running and reads it at its next check)" : ""}\n`
  );
}
