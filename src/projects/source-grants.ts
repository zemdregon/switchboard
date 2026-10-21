/**
 * Runtime grants of `project_sources.allowed_owners` (ADR-0080 item 8). A `manage_projects` MCP client requests that an
 * owner be added; an approver client (approval kind `project_source`) or the operator (`switchboard projects sources`)
 * decides it once. An approved owner joins the configured `allowed_owners` at once, with no restart, because every
 * reader asks {@link effectiveProjectSources} at the time of the check. Hosts are never added: a grant can only name a
 * host already in `allowed_hosts`.
 *
 * Both tables are append-only (migration 0037): a request's status is derived from its one decision row.
 * **Delegated** limitation: `allowed_owners` is a single list, not per host, so an approved owner is allowed on every
 * host in `allowed_hosts`, exactly like a configured owner.
 */
import type Database from "better-sqlite3";
import type { ProjectSourcesSettings } from "../config/load.js";
import { SOURCE_SEGMENT_PATTERN } from "../config/schema.js";
import { defaultIds, type IdGenerator } from "../ids/index.js";

export type ProjectSourceStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ProjectSourceRequestRow {
  readonly id: string;
  readonly client_id: string;
  readonly host: string;
  /** Lower case. */
  readonly owner: string;
  readonly requested_at: string;
  readonly status: ProjectSourceStatus;
  readonly decided_by?: string;
  readonly decided_at?: string;
}

export type ProjectSourceReason =
  | "NOT_CONFIGURED"
  | "HOST_NOT_ALLOWED"
  | "OWNER_INVALID"
  | "OWNER_ALREADY_ALLOWED"
  | "UNKNOWN_REQUEST"
  | "ALREADY_DECIDED";

/** A refused request or decision. Nothing was written. */
export class ProjectSourceError extends Error {
  override readonly name = "ProjectSourceError";
  constructor(
    readonly reason: ProjectSourceReason,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectSourceGrantDeps {
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
  /** The configured `project_sources` (static). Absent: every request is refused with `NOT_CONFIGURED`. */
  readonly config?: ProjectSourcesSettings;
}

/** Live view of `project_sources`: re-evaluated at every call so an approval applies to the next check. */
export type ProjectSourcesGetter = () => ProjectSourcesSettings | undefined;

const SEGMENT_RE = new RegExp(SOURCE_SEGMENT_PATTERN, "u");

interface JoinedRow {
  id: string;
  client_id: string;
  host: string;
  owner: string;
  requested_at: string;
  decision: "APPROVED" | "REJECTED" | null;
  decided_by: string | null;
  decided_at: string | null;
}

const SELECT = `SELECT r.id, r.client_id, r.host, r.owner, r.requested_at,
  d.decision AS decision, d.decided_by AS decided_by, d.decided_at AS decided_at
  FROM project_source_request r LEFT JOIN project_source_decision d ON d.request_id = r.id`;

function toRow(r: JoinedRow): ProjectSourceRequestRow {
  return {
    id: r.id,
    client_id: r.client_id,
    host: r.host,
    owner: r.owner,
    requested_at: r.requested_at,
    status: r.decision ?? "PENDING",
    ...(r.decided_by !== null ? { decided_by: r.decided_by } : {}),
    ...(r.decided_at !== null ? { decided_at: r.decided_at } : {}),
  };
}

export class ProjectSourceGrantStore {
  private readonly ids: IdGenerator;
  private readonly now: () => Date;
  private readonly config: ProjectSourcesSettings | undefined;

  constructor(
    private readonly db: Database.Database,
    deps: ProjectSourceGrantDeps = {},
  ) {
    this.ids = deps.ids ?? defaultIds;
    this.now = deps.now ?? (() => new Date());
    this.config = deps.config;
  }

  /**
   * Ask for `owner` on `host`. Idempotent: an undecided or approved request for the same host and owner is returned
   * as it is. A rejected one does not block a new request. Throws {@link ProjectSourceError}.
   */
  request(input: { clientId: string; host: string; owner: string }): ProjectSourceRequestRow {
    return this.requestOutcome(input).row;
  }

  /** As {@link request}, also telling whether this call wrote a new request row (an announcement is due only then). */
  requestOutcome(input: { clientId: string; host: string; owner: string }): {
    row: ProjectSourceRequestRow;
    created: boolean;
  } {
    const cfg = this.config;
    if (cfg === undefined) throw new ProjectSourceError("NOT_CONFIGURED", "this server has no project_sources");
    const host = input.host.toLowerCase();
    if (!cfg.allowedHosts.includes(host)) {
      throw new ProjectSourceError(
        "HOST_NOT_ALLOWED",
        "the host is not in this server's project_sources allowed_hosts",
      );
    }
    const { owner: raw } = input;
    if (!SEGMENT_RE.test(raw) || raw === "." || raw === ".." || raw.startsWith("-")) {
      throw new ProjectSourceError(
        "OWNER_INVALID",
        "owner must be a repository owner name ([A-Za-z0-9._-], at most 100)",
      );
    }
    const owner = raw.toLowerCase();
    if (cfg.allowedOwners.includes(owner)) {
      throw new ProjectSourceError("OWNER_ALREADY_ALLOWED", "the owner is already in project_sources allowed_owners");
    }
    return this.db
      .transaction((): { row: ProjectSourceRequestRow; created: boolean } => {
        const existing = (
          this.db
            .prepare(`${SELECT} WHERE r.host = ? AND r.owner = ? ORDER BY r.requested_at DESC, r.id DESC`)
            .all(host, owner) as JoinedRow[]
        )
          .map(toRow)
          .find((r) => r.status !== "REJECTED");
        if (existing !== undefined) return { row: existing, created: false };
        const id = this.ids.id("psr");
        const requestedAt = this.now().toISOString();
        this.db
          .prepare(
            "INSERT INTO project_source_request (id, client_id, host, owner, requested_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, input.clientId, host, owner, requestedAt);
        return {
          row: { id, client_id: input.clientId, host, owner, requested_at: requestedAt, status: "PENDING" },
          created: true,
        };
      })
      .immediate();
  }

  /** Decide one request, once. Throws `UNKNOWN_REQUEST` or `ALREADY_DECIDED`. */
  decide(input: { requestId: string; decision: "APPROVED" | "REJECTED"; decidedBy: string }): ProjectSourceRequestRow {
    return this.db
      .transaction((): ProjectSourceRequestRow => {
        const row = this.get(input.requestId);
        if (row === undefined)
          throw new ProjectSourceError("UNKNOWN_REQUEST", `unknown project source request ${input.requestId}`);
        if (row.status !== "PENDING") {
          throw new ProjectSourceError(
            "ALREADY_DECIDED",
            `project source request ${input.requestId} was already decided`,
          );
        }
        const decidedAt = this.now().toISOString();
        this.db
          .prepare(
            "INSERT INTO project_source_decision (id, request_id, decision, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(this.ids.id("psd"), input.requestId, input.decision, input.decidedBy, decidedAt);
        return { ...row, status: input.decision, decided_by: input.decidedBy, decided_at: decidedAt };
      })
      .immediate();
  }

  get(id: string): ProjectSourceRequestRow | undefined {
    const r = this.db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as JoinedRow | undefined;
    return r === undefined ? undefined : toRow(r);
  }

  /** Undecided requests, oldest first. */
  pending(): ProjectSourceRequestRow[] {
    return (this.db.prepare(`${SELECT} WHERE d.id IS NULL ORDER BY r.requested_at, r.id`).all() as JoinedRow[]).map(
      toRow,
    );
  }

  /** Every request, oldest first (operator listing). */
  list(): ProjectSourceRequestRow[] {
    return (this.db.prepare(`${SELECT} ORDER BY r.requested_at, r.id`).all() as JoinedRow[]).map(toRow);
  }

  /** Distinct lower-case owners with an approved request, optionally on one host. */
  approvedOwners(host?: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT r.owner AS owner FROM project_source_request r
         JOIN project_source_decision d ON d.request_id = r.id
         WHERE d.decision = 'APPROVED'${host !== undefined ? " AND r.host = ?" : ""} ORDER BY r.owner`,
      )
      .all(...(host !== undefined ? [host.toLowerCase()] : [])) as { owner: string }[];
    return rows.map((r) => r.owner);
  }
}

/**
 * `config` with `allowedOwners` = configured owners plus approved owners, read at each call. Hosts are never added; an
 * approved owner of a host the configuration has since dropped is ignored. Absent `config` stays absent (no
 * `project_sources`, no grants).
 */
export function effectiveProjectSources(
  config: ProjectSourcesSettings | undefined,
  store: Pick<ProjectSourceGrantStore, "approvedOwners"> | undefined,
): ProjectSourcesGetter {
  return () => {
    if (config === undefined || store === undefined) return config;
    const owners = new Set(config.allowedOwners);
    for (const host of config.allowedHosts) for (const o of store.approvedOwners(host)) owners.add(o);
    return { ...config, allowedOwners: [...owners] };
  };
}
