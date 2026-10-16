/**
 * Dynamic-project ledger store (T9.9; FR-PRJ-10, FRD BR-32, LLD §1 "M9 additions", ADR-0030). Reads and appends the
 * three append-only tables of migration 0004; nothing here is ever updated or deleted.
 *
 * State of a project, derived from its revisions and decisions (Delegated, Proposed):
 * - a revision is **usable** when its status is `ACTIVE`, or `PENDING_APPROVAL` with an `APPROVED` decision;
 * - the project is **deleted** when its latest revision is `DELETED` (its id is never reused);
 * - the **in-force** revision is the highest usable revision of a project that is not deleted; it is what
 *   `delegate_task` resolves. A newer revision that waits for approval, or was rejected, leaves the previous in-force
 *   revision in force (LLD §3 `update_project`);
 * - only the latest revision can be decided, and only once (unique key on the decision table).
 *
 * The creator is the `client_id` of revision 1; every later revision must carry the same client (checked in the write
 * transaction), so a project never changes hands.
 */
import type Database from "better-sqlite3";
import type { ProjectConfig } from "../config/index.js";
import { defaultIds, type IdGenerator } from "../ids/index.js";

export type RevisionStatus = "ACTIVE" | "PENDING_APPROVAL" | "DELETED";
/** What `projects list|show` print per revision. */
export type RevisionState = "active" | "pending_approval" | "approved" | "rejected" | "deleted";

export interface ProjectRevisionRow {
  id: string;
  project_id: string;
  revision: number;
  client_id: string;
  definition_json: string;
  status: RevisionStatus;
  approval_reasons_json: string;
  created_at: string;
}

export interface ProjectDecisionRow {
  id: string;
  project_id: string;
  revision: number;
  decision: "APPROVED" | "REJECTED";
  decided_by: string;
  reason: string | null;
  decided_at: string;
}

export interface ProjectEventRow {
  id: string;
  ts: string;
  actor: "mcp_client" | "operator";
  client_id: string | null;
  operator: string | null;
  action: ProjectAction;
  project_id: string | null;
  revision: number | null;
  outcome: "ACCEPTED" | "REFUSED";
  code: string | null;
  reason: string | null;
  payload_json: string;
}

export type ProjectAction = "create_project" | "update_project" | "delete_project" | "approve" | "reject";

export interface RevisionInfo {
  readonly revision: number;
  readonly status: RevisionStatus;
  readonly state: RevisionState;
  readonly approvalReasons: readonly string[];
  readonly createdAt: string;
  readonly decision?: { decision: "APPROVED" | "REJECTED"; decidedBy: string; decidedAt: string; reason?: string };
  readonly definition: ProjectConfig;
}

export interface DynamicProjectState {
  readonly projectId: string;
  /** The creating MCP client (revision 1). */
  readonly clientId: string;
  readonly revisions: readonly RevisionInfo[];
  readonly latest: RevisionInfo;
  readonly deleted: boolean;
  /** The highest usable revision, unless the project is deleted. */
  readonly inForce?: RevisionInfo;
  /** The latest revision when it is `PENDING_APPROVAL` and undecided. */
  readonly pending?: RevisionInfo;
}

export interface NewProjectEvent {
  readonly actor: "mcp_client" | "operator";
  readonly clientId?: string;
  readonly operator?: string;
  readonly action: ProjectAction;
  readonly projectId?: string;
  readonly revision?: number;
  readonly outcome: "ACCEPTED" | "REFUSED";
  /** Taxonomy code of a refusal (required when REFUSED). */
  readonly code?: string;
  /** Short reason code from a fixed vocabulary. */
  readonly reason?: string;
  /** Bounded: codes, field paths, counts. Never a definition, a path or request text. */
  readonly payload?: Record<string, unknown>;
}

export interface NewRevision {
  readonly projectId: string;
  readonly clientId: string;
  readonly definition: ProjectConfig;
  readonly status: RevisionStatus;
  readonly approvalReasons: readonly string[];
  readonly action: "create_project" | "update_project" | "delete_project";
  /** Event payload (bounded). */
  readonly payload?: Record<string, unknown>;
}

/** A write refused inside the store's transaction; nothing was written. */
export class ProjectStoreError extends Error {
  override readonly name = "ProjectStoreError";
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;

export interface ProjectStoreDeps {
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
}

export class DynamicProjectStore {
  private readonly ids: IdGenerator;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database.Database,
    deps: ProjectStoreDeps = {},
  ) {
    this.ids = deps.ids ?? defaultIds;
    this.now = deps.now ?? (() => new Date());
  }

  /** The derived state of one dynamic project, or undefined when no revision exists. */
  state(projectId: string): DynamicProjectState | undefined {
    const revs = this.db
      .prepare("SELECT * FROM project_revision WHERE project_id = ? ORDER BY revision")
      .all(projectId) as ProjectRevisionRow[];
    if (revs.length === 0) return undefined;
    const decisions = this.db
      .prepare("SELECT * FROM project_revision_decision WHERE project_id = ?")
      .all(projectId) as ProjectDecisionRow[];
    return derive(revs, decisions);
  }

  /** One stored revision row by its id (`prv_…`), or undefined. Reads only (T14.8 approval proxy). */
  revisionRow(id: string): ProjectRevisionRow | undefined {
    return this.db.prepare("SELECT * FROM project_revision WHERE id = ?").get(id) as ProjectRevisionRow | undefined;
  }

  /** One stored revision row by project and revision number, or undefined. Reads only (T14.8 approval proxy). */
  revisionRowOf(projectId: string, revision: number): ProjectRevisionRow | undefined {
    return this.db
      .prepare("SELECT * FROM project_revision WHERE project_id = ? AND revision = ?")
      .get(projectId, revision) as ProjectRevisionRow | undefined;
  }

  /** Every dynamic project (optionally of one creating client), ordered by project id. */
  list(clientId?: string): DynamicProjectState[] {
    const ids = (
      clientId === undefined
        ? this.db.prepare("SELECT DISTINCT project_id FROM project_revision ORDER BY project_id").all()
        : this.db
            .prepare("SELECT DISTINCT project_id FROM project_revision WHERE client_id = ? ORDER BY project_id")
            .all(clientId)
    ) as { project_id: string }[];
    return ids.map((r) => this.state(r.project_id)).filter((s): s is DynamicProjectState => s !== undefined);
  }

  /** Projects of a client that are not deleted (the quota count). */
  countLive(clientId: string): number {
    return this.list(clientId).filter((s) => !s.deleted).length;
  }

  /** Runs of the project that are not terminal (FR-PRJ-10: deletion is refused while any exists). */
  nonTerminalRuns(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM run WHERE project_id = ? AND state NOT IN (${TERMINAL.map(() => "?").join(", ")})`,
      )
      .get(projectId, ...TERMINAL) as { n: number };
    return row.n;
  }

  /**
   * Append the next revision and its `ACCEPTED` event in one `BEGIN IMMEDIATE` transaction. `check` runs first, inside
   * the transaction, against the current state (undefined for a new id); throwing aborts with nothing written.
   */
  appendRevision(input: NewRevision, check: (current: DynamicProjectState | undefined) => void): ProjectRevisionRow {
    return this.db
      .transaction((): ProjectRevisionRow => {
        const current = this.state(input.projectId);
        check(current);
        if (current !== undefined && current.clientId !== input.clientId) {
          throw new ProjectStoreError("NOT_CREATOR", "the project belongs to another client");
        }
        const revision = (current?.latest.revision ?? 0) + 1;
        const row: ProjectRevisionRow = {
          id: this.ids.id("prv"),
          project_id: input.projectId,
          revision,
          client_id: input.clientId,
          definition_json: JSON.stringify(input.definition),
          status: input.status,
          approval_reasons_json: JSON.stringify(input.approvalReasons),
          created_at: this.now().toISOString(),
        };
        this.db
          .prepare(
            `INSERT INTO project_revision (id, project_id, revision, client_id, definition_json, status,
                                           approval_reasons_json, created_at)
             VALUES (@id, @project_id, @revision, @client_id, @definition_json, @status, @approval_reasons_json, @created_at)`,
          )
          .run(row);
        this.insertEvent({
          actor: "mcp_client",
          clientId: input.clientId,
          action: input.action,
          projectId: input.projectId,
          revision,
          outcome: "ACCEPTED",
          ...(input.status === "PENDING_APPROVAL" ? { reason: "PENDING_APPROVAL" } : {}),
          payload: { status: input.status, approval_needed: [...input.approvalReasons], ...input.payload },
        });
        return row;
      })
      .immediate();
  }

  /**
   * `projects approve` / `--reject` (operator only; no MCP path, FRD BR-32). Decides the latest revision, which must be
   * `PENDING_APPROVAL` and undecided; `revision`, when given, must name it. Writes the decision and its event in one
   * transaction.
   */
  decide(input: {
    projectId: string;
    revision?: number;
    decision: "APPROVED" | "REJECTED";
    decidedBy: string;
    reason?: string;
  }): { state: DynamicProjectState; decision: ProjectDecisionRow } {
    return this.db
      .transaction(() => {
        const current = this.state(input.projectId);
        if (current === undefined)
          throw new ProjectStoreError("UNKNOWN_PROJECT", `unknown dynamic project ${input.projectId}`);
        const target = input.revision ?? current.latest.revision;
        const rev = current.revisions.find((r) => r.revision === target);
        if (rev === undefined) {
          throw new ProjectStoreError("UNKNOWN_REVISION", `project ${input.projectId} has no revision ${target}`);
        }
        if (rev.decision !== undefined) {
          throw new ProjectStoreError(
            "ALREADY_DECIDED",
            `revision ${target} of ${input.projectId} was already ${rev.decision.decision.toLowerCase()}`,
          );
        }
        if (rev.status !== "PENDING_APPROVAL") {
          throw new ProjectStoreError(
            "NOT_PENDING",
            `revision ${target} of ${input.projectId} is ${rev.state}; only a revision waiting for approval can be decided`,
          );
        }
        if (target !== current.latest.revision) {
          throw new ProjectStoreError(
            "SUPERSEDED",
            `revision ${target} of ${input.projectId} was superseded by revision ${current.latest.revision}`,
          );
        }
        const decision: ProjectDecisionRow = {
          id: this.ids.id("prd"),
          project_id: input.projectId,
          revision: target,
          decision: input.decision,
          decided_by: input.decidedBy,
          reason: input.reason ?? null,
          decided_at: this.now().toISOString(),
        };
        this.db
          .prepare(
            `INSERT INTO project_revision_decision (id, project_id, revision, decision, decided_by, reason, decided_at)
             VALUES (@id, @project_id, @revision, @decision, @decided_by, @reason, @decided_at)`,
          )
          .run(decision);
        this.insertEvent({
          actor: "operator",
          operator: input.decidedBy,
          action: input.decision === "APPROVED" ? "approve" : "reject",
          projectId: input.projectId,
          revision: target,
          outcome: "ACCEPTED",
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
        return { state: this.state(input.projectId) as DynamicProjectState, decision };
      })
      .immediate();
  }

  /** Append one audit event on its own (a refused call). */
  recordEvent(e: NewProjectEvent): string {
    return this.insertEvent(e);
  }

  /** Events of one project (or every event when undefined), oldest first. */
  listEvents(projectId?: string): ProjectEventRow[] {
    return (
      projectId === undefined
        ? this.db.prepare("SELECT * FROM project_event ORDER BY ts, id").all()
        : this.db.prepare("SELECT * FROM project_event WHERE project_id = ? ORDER BY ts, id").all(projectId)
    ) as ProjectEventRow[];
  }

  private insertEvent(e: NewProjectEvent): string {
    const id = this.ids.id("pev");
    this.db
      .prepare(
        `INSERT INTO project_event (id, ts, actor, client_id, operator, action, project_id, revision, outcome, code, reason,
                                    payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.now().toISOString(),
        e.actor,
        e.clientId ?? null,
        e.operator ?? null,
        e.action,
        e.projectId ?? null,
        e.revision ?? null,
        e.outcome,
        e.outcome === "REFUSED" ? (e.code ?? "INVALID_REQUEST") : null,
        e.reason ?? null,
        JSON.stringify(e.payload ?? {}),
      );
    return id;
  }
}

function derive(revs: readonly ProjectRevisionRow[], decisions: readonly ProjectDecisionRow[]): DynamicProjectState {
  const byRev = new Map(decisions.map((d) => [d.revision, d]));
  const revisions: RevisionInfo[] = revs.map((r) => {
    const d = byRev.get(r.revision);
    const state: RevisionState =
      r.status === "DELETED"
        ? "deleted"
        : r.status === "ACTIVE"
          ? "active"
          : d === undefined
            ? "pending_approval"
            : d.decision === "APPROVED"
              ? "approved"
              : "rejected";
    return {
      revision: r.revision,
      status: r.status,
      state,
      approvalReasons: JSON.parse(r.approval_reasons_json) as string[],
      createdAt: r.created_at,
      ...(d !== undefined
        ? {
            decision: {
              decision: d.decision,
              decidedBy: d.decided_by,
              decidedAt: d.decided_at,
              ...(d.reason !== null ? { reason: d.reason } : {}),
            },
          }
        : {}),
      definition: JSON.parse(r.definition_json) as ProjectConfig,
    };
  });
  const latest = revisions[revisions.length - 1] as RevisionInfo;
  const deleted = latest.status === "DELETED";
  const usable = revisions.filter((r) => r.state === "active" || r.state === "approved");
  const inForce = deleted ? undefined : usable[usable.length - 1];
  return {
    projectId: (revs[0] as ProjectRevisionRow).project_id,
    clientId: (revs[0] as ProjectRevisionRow).client_id,
    revisions,
    latest,
    deleted,
    ...(inForce !== undefined ? { inForce } : {}),
    ...(latest.state === "pending_approval" ? { pending: latest } : {}),
  };
}
