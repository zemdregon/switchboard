/**
 * `switchboard affinity list|reset` (M7, T7.7; FR-RTE-07, FR-OPS-01, LLD §3.2, §17.6). `list` reads the
 * `project_affinity` rows from a read-only ledger handle (no ledger, or one from before migration 0014, lists none).
 * `reset <project_key>` records an operator reset on the project's existing row (`reset_requested_at`, `reset_by`); the
 * next routing step for the project treats it as `user_request`, and the first run that then succeeds consumes it
 * (`routing_affinity_reset`). It works with or without a running daemon: it is one row update, and the daemon reads the
 * row at its next routing step. A project with no row has nothing to reset: NOT_FOUND, nothing written.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config/index.js";
import { createLedger, LEDGER_FILE_NAME, openLedger, type ProjectAffinityRow } from "../ledger/index.js";
import { type CliIo, JSON_SCHEMA_VERSION } from "./io.js";
import { UnknownProjectError } from "./projects.js";

function dataDirFor(io: CliIo, argv: readonly string[]): string {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) }).dataDir;
}

function osUser(io: CliIo): string {
  if (io.user !== undefined) return io.user;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

export interface AffinityListReport {
  schema_version: number;
  projects: ProjectAffinityRow[];
}

export function listAffinity(io: CliIo, argv: readonly string[]): AffinityListReport {
  const file = path.join(dataDirFor(io, argv), LEDGER_FILE_NAME);
  if (!existsSync(file)) return { schema_version: JSON_SCHEMA_VERSION, projects: [] };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_affinity'").get();
    return {
      schema_version: JSON_SCHEMA_VERSION,
      projects: table === undefined ? [] : createLedger(db).listProjectAffinities(),
    };
  } finally {
    db.close();
  }
}

export interface AffinityResetReport {
  schema_version: number;
  project_key: string;
  provider: string;
  reset_by: string;
  reset_requested_at: string;
}

export function resetAffinity(io: CliIo, argv: readonly string[], projectKey: string): AffinityResetReport {
  const dataDir = dataDirFor(io, argv);
  const missing = () => new UnknownProjectError(`no affinity recorded for project ${projectKey}; nothing to reset`);
  if (!existsSync(path.join(dataDir, LEDGER_FILE_NAME))) throw missing();
  const db = openLedger(dataDir);
  try {
    const ledger = createLedger(db, io.now ? { now: io.now } : {});
    const by = osUser(io);
    if (!ledger.requestAffinityReset(projectKey, by)) throw missing();
    const row = ledger.getProjectAffinity(projectKey) as ProjectAffinityRow;
    return {
      schema_version: JSON_SCHEMA_VERSION,
      project_key: projectKey,
      provider: row.provider,
      reset_by: by,
      reset_requested_at: row.reset_requested_at as string,
    };
  } finally {
    db.close();
  }
}

export function renderAffinityList(r: AffinityListReport): string {
  if (r.projects.length === 0) return "no project affinity recorded\n";
  return r.projects
    .map((p) => {
      const reason = p.last_switch_reason ?? "first run";
      const reset =
        p.reset_requested_at !== null ? ` [reset requested by ${p.reset_by} at ${p.reset_requested_at}]` : "";
      return `${p.project_key}: ${p.provider}${p.model !== null ? ` (${p.model})` : ""} since ${p.since}, last switch: ${reason}${reset}\n`;
    })
    .join("");
}

export function renderAffinityReset(r: AffinityResetReport): string {
  return (
    `${r.project_key}: reset recorded by ${r.reset_by} at ${r.reset_requested_at}; the next routing step for the project ` +
    `scores the eligible providers (user_request) instead of keeping ${r.provider}\n`
  );
}
