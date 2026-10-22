/**
 * Dynamic projects on the operator CLI (T9.9; FR-PRJ-10, FRD BR-32, ADR-0030).
 *
 * - `projects list|show` add the dynamic projects from the ledger to the configured ones: `source` (`config` or
 *   `dynamic`), and for a dynamic project its creator, the state of its latest revision, that revision's number, the
 *   revision in force and any revision waiting for approval. The definition shown is the latest revision's, so the
 *   operator reviews exactly what `projects approve` would approve. Read-only: no lock, no migration (a ledger that
 *   predates migration 0004, or no ledger at all, has no dynamic projects).
 * - `projects approve <id> [--revision n] [--reject]` decides the latest revision when it waits for approval (the only
 *   approval path; no MCP tool can approve). Locking follows `approve`/`deny` (ADR-0005): the data-directory lock is
 *   taken when free; while a `serve` daemon holds it the decision is still written, as one append-only row the daemon
 *   reads on its next request. **Delegated** (time-of-check guard): when the project has more than one revision,
 *   `--revision` is required, so a client cannot swap in a new revision between the operator's `projects show` and
 *   `projects approve`.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { ApprovalRefusedError } from "../lifecycle/approval.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import {
  type DynamicProjectState,
  DynamicProjectStore,
  ProjectStoreError,
  type RevisionState,
  toResolved,
} from "../projects/index.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";
import { type ProjectView, toProjectView, UnknownProjectError } from "./projects.js";

export type SourcedProjectView = ProjectView & {
  source: "config" | "dynamic";
  /** Dynamic only: the MCP client that created it. */
  creator?: string;
  /** Dynamic only: number and state of the latest revision (whose definition is shown). */
  revision?: number;
  state?: RevisionState;
  in_force_revision?: number;
  pending_revision?: number;
  approval_needed?: string[];
};

export interface RevisionView {
  revision: number;
  state: RevisionState;
  created_at: string;
  approval_needed: string[];
  decided_by?: string;
  decided_at?: string;
}

function load(io: CliIo, argv: readonly string[]): ResolvedConfig {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
}

/** Read-only: every dynamic project in the ledger, or none when there is no ledger or no `project_revision` table. */
function readDynamic(dataDir: string): DynamicProjectState[] {
  const file = path.join(dataDir, LEDGER_FILE_NAME);
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_revision'").get();
    if (!has) return [];
    return new DynamicProjectStore(db).list();
  } finally {
    db.close();
  }
}

function dynamicView(st: DynamicProjectState): SourcedProjectView {
  return {
    ...toProjectView(toResolved(st.latest.definition)),
    source: "dynamic",
    creator: st.clientId,
    revision: st.latest.revision,
    state: st.latest.state,
    ...(st.inForce !== undefined ? { in_force_revision: st.inForce.revision } : {}),
    ...(st.pending !== undefined ? { pending_revision: st.pending.revision } : {}),
    ...(st.latest.approvalReasons.length > 0 ? { approval_needed: [...st.latest.approvalReasons] } : {}),
  };
}

/** `projects list`: configured projects, then dynamic ones (deleted included, so the history stays visible). */
export function listAllProjects(io: CliIo, argv: readonly string[]): SourcedProjectView[] {
  const config = load(io, argv);
  return [
    ...config.projects.map((p) => ({ ...toProjectView(p), source: "config" as const })),
    ...readDynamic(config.dataDir).map(dynamicView),
  ];
}

/** `projects show <id>`: a configured project wins over a dynamic one of the same id (configuration owns it). */
export function showAnyProject(
  io: CliIo,
  argv: readonly string[],
  id: string,
): { project: SourcedProjectView; revisions?: RevisionView[] } {
  const config = load(io, argv);
  const configured = config.projects.find((p) => p.id === id);
  if (configured) return { project: { ...toProjectView(configured), source: "config" } };
  const st = readDynamic(config.dataDir).find((s) => s.projectId === id);
  if (!st) throw new UnknownProjectError(`unknown project ${id}`);
  return {
    project: dynamicView(st),
    revisions: st.revisions.map((r) => ({
      revision: r.revision,
      state: r.state,
      created_at: r.createdAt,
      approval_needed: [...r.approvalReasons],
      ...(r.decision !== undefined ? { decided_by: r.decision.decidedBy, decided_at: r.decision.decidedAt } : {}),
    })),
  };
}

export interface ProjectApprovalReport {
  schema_version: number;
  project_id: string;
  revision: number;
  decision: "approved" | "rejected";
  state: RevisionState;
  in_force_revision: number | null;
  approval_needed: string[];
  decided_by: string;
  decided_at: string;
  daemon_running: boolean;
}

/** Parses `--revision`: a positive integer. */
export function parseRevision(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || String(n) !== text) {
    throw new UsageError("--revision must be a positive integer");
  }
  return n;
}

export function approveProject(
  io: CliIo,
  argv: readonly string[],
  id: string,
  opts: { revision?: number; reject: boolean },
): ProjectApprovalReport {
  const config = load(io, argv);
  if (config.projects.some((p) => p.id === id)) {
    throw new ApprovalRefusedError(`project ${id} is a configured project; only dynamic projects are approved`);
  }
  if (!existsSync(path.join(config.dataDir, LEDGER_FILE_NAME))) throw new UnknownProjectError(`unknown project ${id}`);
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
      const store = new DynamicProjectStore(db, { ids: createIdGenerator(), ...(io.now ? { now: io.now } : {}) });
      const st = store.state(id);
      if (st === undefined) throw new UnknownProjectError(`unknown project ${id}`);
      if (opts.revision === undefined && st.revisions.length > 1) {
        throw new UsageError(
          `project ${id} has ${st.revisions.length} revisions; name the one you reviewed with --revision ` +
            `(latest is ${st.latest.revision}; see projects show ${id})`,
        );
      }
      try {
        const { state, decision } = store.decide({
          projectId: id,
          ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
          decision: opts.reject ? "REJECTED" : "APPROVED",
          decidedBy: osUser(io),
        });
        const rev = state.revisions.find((r) => r.revision === decision.revision);
        return {
          schema_version: JSON_SCHEMA_VERSION,
          project_id: id,
          revision: decision.revision,
          decision: opts.reject ? "rejected" : "approved",
          state: rev?.state ?? (opts.reject ? "rejected" : "approved"),
          in_force_revision: state.inForce?.revision ?? null,
          approval_needed: [...(rev?.approvalReasons ?? [])],
          decided_by: decision.decided_by,
          decided_at: decision.decided_at,
          daemon_running: daemon,
        };
      } catch (err) {
        if (err instanceof ProjectStoreError) throw new ApprovalRefusedError(err.message);
        throw err;
      }
    } finally {
      db.close();
    }
  } finally {
    lock?.release();
  }
}

export function osUser(io: CliIo): string {
  if (io.user !== undefined) return io.user;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

export function renderAllProjects(projects: readonly SourcedProjectView[]): string {
  if (projects.length === 0) return "No projects configured.\n";
  return `${projects
    .map((p) => {
      const base = `${p.id}\t${p.environment.kind}\t${p.contexts.length} context(s)\t${p.name}\t${p.source}`;
      return p.source === "dynamic"
        ? `${base} (client ${p.creator}, revision ${p.revision} ${p.state}` +
            `${p.in_force_revision !== undefined ? `, in force ${p.in_force_revision}` : ", none in force"})`
        : base;
    })
    .join("\n")}\n`;
}

export function renderDynamicDetail(
  project: SourcedProjectView,
  revisions: readonly RevisionView[] | undefined,
): string {
  if (project.source !== "dynamic") return "";
  const lines = [
    `  source: dynamic (created by MCP client ${project.creator})`,
    `  latest revision: ${project.revision} (${project.state})${
      project.approval_needed ? `; needs approval for: ${project.approval_needed.join(", ")}` : ""
    }`,
    `  in force: ${project.in_force_revision ?? "none"}`,
  ];
  for (const r of revisions ?? []) {
    lines.push(`  revision ${r.revision}: ${r.state} at ${r.created_at}${r.decided_by ? ` (by ${r.decided_by})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderProjectApproval(r: ProjectApprovalReport): string {
  return (
    `project ${r.project_id} revision ${r.revision}: ${r.decision} by ${r.decided_by}; ` +
    `in force: ${r.in_force_revision ?? "none"}${r.daemon_running ? " (serve is running and reads it on its next request)" : ""}\n`
  );
}
