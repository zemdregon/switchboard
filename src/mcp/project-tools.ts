/**
 * Orchestrator-managed projects over MCP (T9.9; FR-PRJ-10, FRD BR-32, LLD §3 and §11.2 step 5a, ADR-0030).
 *
 * `create_project`, `update_project` and `delete_project` exist only for a client whose entry sets `manage_projects`
 * (the server does not list them, and answers any other client as for an unknown tool). Every call, accepted or refused
 * (schema failures included), is one `project_event` row; an accepted create/update/delete is also one
 * `project_revision` row, written in the same transaction as its event.
 *
 * Order of checks (Delegated): input schema (V1, `INVALID_REQUEST`) → strings free of control characters
 * (`INVALID_REQUEST`) → id ownership: a configured project id or another client's dynamic project is
 * `PERMISSION_BLOCKED` with one message for both, an unknown id for update/delete or a deleted one is
 * `INVALID_REQUEST`, an id that already exists for create is `INVALID_REQUEST` (ids are never reused) → structure as in
 * configuration (`INVALID_REQUEST`) → client limits (`PERMISSION_BLOCKED`) → quotas (`PERMISSION_BLOCKED`) → filesystem
 * (out of root or inside the data directory `PERMISSION_BLOCKED`, otherwise `INVALID_REQUEST`) → approval reasons → the
 * write, which re-checks ownership, quotas and that no other revision was written in between.
 *
 * Delete with a non-terminal run (or a `delegate_task`/`continue_task` for the project still being admitted) is
 * `INVALID_REQUEST`, as SRS FR-PRJ-10 and LLD §3 say (FRD BR-32's general "refusals are PERMISSION_BLOCKED" sentence is
 * read as covering limits, not this state check).
 *
 * Resolution for `delegate_task` / `continue_task` / `list_projects` (`resolveForRequest`, `listForClient`): a
 * configured project of the same id always wins (the dynamic one is then ignored); a dynamic project resolves only for
 * its creator, only while that client still has `manage_projects` (Delegated, fail closed), to its in-force revision;
 * the in-force revision is re-checked against the client's current limits and the filesystem rules at every request.
 */
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ProjectConfig, ResolvedMcpClient, ResolvedProject, TrustProfile } from "../config/index.js";
import { effectiveMaxProfile, PROJECT_ID_PATTERN } from "../config/index.js";
import {
  approvalReasons,
  BriefError,
  checkClientLimits,
  checkFilesystem,
  checkRagSharing,
  checkStrings,
  checkStructure,
  type DynamicProjectState,
  type DynamicProjectStore,
  freezeBrief,
  MAX_LIVE_PROJECTS_PER_CLIENT,
  MAX_REVISIONS_PER_PROJECT,
  PROJECT_BRIEF_UNAVAILABLE,
  ProjectRuleError,
  ProjectStoreError,
  toResolved,
} from "../projects/index.js";
import { invalid, ToolError, toToolError } from "./errors.js";
import { inputSchema, PROJECT_TOOL_NAMES, type ProjectToolName } from "./schemas.js";

export interface ProjectToolsDeps {
  readonly store: DynamicProjectStore;
  readonly clientId: string;
  readonly client: ResolvedMcpClient;
  readonly allowedRoots: readonly string[];
  /** The controller data directory; no context may lie inside it. */
  readonly dataDir?: string;
  /** Ids of the configured projects, read at each call (configuration owns them, never MCP). */
  readonly configuredIds: () => ReadonlySet<string>;
  /** Providers the operator disabled in `providers` (outside every client's provider set). */
  readonly disabledProviders: ReadonlySet<string>;
  /** Number of `delegate_task`/`continue_task` calls for the project currently between resolution and admission. */
  readonly admitting: (projectId: string) => number;
  /**
   * T14.9 (FR-CTL-10, ADR-0048): called after a `create_project`/`update_project` write leaves a revision waiting for
   * the operator's approval. Serve announces it as `approval_pending`. Must not throw; never undoes the write.
   */
  readonly onPendingRevision?: (a: PendingRevisionAnnouncement) => void;
  /**
   * T12.1 (FR-RAG-03): called after a delete is written, to remove the project's retrieval store. A failure here does
   * not undo the delete; `serve` prunes stores of deleted projects again at its next start.
   */
  readonly onDeleted?: (projectId: string) => void;
}

/**
 * T14.9 (FR-CTL-10, ADR-0048): what {@link ProjectToolsDeps.onPendingRevision} receives after the revision row was
 * written. Kind follows the approval proxy's rule (LLD §3.4.8): a push approval need is `push_revision`, any other
 * approval need is `dynamic_project`. Ids and closed codes only.
 */
export interface PendingRevisionAnnouncement {
  readonly projectId: string;
  readonly revision: number;
  readonly kind: "dynamic_project" | "push_revision";
}

/** Approval reasons that make a revision a `push_revision` (mirrors the approval proxy's kind rule, LLD §3.4.8). */
const PUSH_APPROVAL_REASONS: ReadonlySet<string> = new Set(["push_policy", "commit_identity", "commit_signing"]);

export interface DynamicResolution {
  readonly project: ResolvedProject;
  readonly revision: number;
}

export interface DynamicListEntry {
  readonly project: ResolvedProject;
  readonly revision: number;
  readonly status: "ACTIVE" | "PENDING_APPROVAL" | "REJECTED";
  readonly pendingRevision?: number;
}

export interface ProjectTools {
  /** Handle one project-management tool call (validation, rules, write, event). Throws a ToolError on refusal. */
  call(name: ProjectToolName, rawArgs: unknown): Promise<object>;
  /** Record a call to a project tool by a client that is not offered them (the caller then answers "unknown tool"). */
  recordNotOffered(name: ProjectToolName, rawArgs: unknown): void;
  /**
   * The dynamic project `projectId` for a request of this client, or undefined when the id is configured or unknown to
   * the store (the caller then applies the configured-project rules). Throws a ToolError for a dynamic project this
   * client may not use now.
   */
  resolveForRequest(projectId: string): Promise<DynamicResolution | undefined>;
  /** This client's dynamic projects for `list_projects` (deleted ones and shadowed ids omitted). */
  listForClient(): DynamicListEntry[];
}

/** Compiled once; the pattern is the configuration's own (`^[a-z][a-z0-9-]{1,40}$`). */
const ID_RE = new RegExp(PROJECT_ID_PATTERN, "u");

export function createProjectTools(deps: ProjectToolsDeps): ProjectTools {
  const { store, clientId, client } = deps;
  const clientMax: TrustProfile = client.maxTrustProfile;
  const limits = { maxTrustProfile: clientMax, maxPushPolicy: client.maxPushPolicy ?? "none" } as const;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validators = Object.fromEntries(PROJECT_TOOL_NAMES.map((n) => [n, ajv.compile(inputSchema(n))])) as Record<
    ProjectToolName,
    ValidateFunction
  >;

  /** One message for a configured project and another client's: no existence oracle beyond the code. */
  const notManageable = (id: string) =>
    new ToolError("PERMISSION_BLOCKED", `project ${id} is not a dynamic project of this client`, {
      project: id,
      reason: "NOT_MANAGEABLE",
    });

  const fromRule = (err: ProjectRuleError) =>
    new ToolError(err.code, err.message, {
      reason: err.reason,
      ...(err.field !== undefined ? { field: err.field } : {}),
    });

  /** The project id a call names, only when it is a well-formed id (never junk or oversized text in the ledger). */
  const namedId = (name: ProjectToolName, a: unknown): string | undefined => {
    if (a === null || typeof a !== "object") return undefined;
    const rec = a as Record<string, unknown>;
    const p = rec.project;
    const candidate =
      name === "create_project"
        ? p !== null && typeof p === "object"
          ? (p as Record<string, unknown>).id
          : undefined
        : rec.id;
    return typeof candidate === "string" && ID_RE.test(candidate) ? candidate : undefined;
  };

  const refused = (name: ProjectToolName, rawArgs: unknown, err: ToolError) => {
    const pid = namedId(name, rawArgs);
    const reason = typeof err.details.reason === "string" ? err.details.reason : "INVALID_ARGUMENTS";
    const field = typeof err.details.field === "string" ? err.details.field.slice(0, 200) : undefined;
    store.recordEvent({
      actor: "mcp_client",
      clientId,
      action: name,
      ...(pid !== undefined ? { projectId: pid } : {}),
      outcome: "REFUSED",
      code: err.code,
      reason,
      payload: field !== undefined ? { field } : {},
    });
  };

  /** Ownership of an existing id: configured or another client's is PERMISSION_BLOCKED. */
  const ownState = (id: string): DynamicProjectState | undefined => {
    if (deps.configuredIds().has(id)) throw notManageable(id);
    const st = store.state(id);
    if (st !== undefined && st.clientId !== clientId) throw notManageable(id);
    return st;
  };

  const checkDefinition = (def: ProjectConfig): void => {
    checkStructure(def);
    checkClientLimits(def, limits, deps.disabledProviders);
    checkRagSharing(def);
  };

  const pendingMessage = (revision: number, inForce: number | undefined) =>
    `revision ${revision} waits for the operator's approval (switchboard projects approve) and cannot start runs ` +
    `until then${inForce !== undefined ? `; revision ${inForce} stays in force` : ""}`;

  const write = (
    action: "create_project" | "update_project",
    def: ProjectConfig,
    seenLatest: number | undefined,
    reasons: string[],
  ) => {
    const status = reasons.length > 0 ? "PENDING_APPROVAL" : "ACTIVE";
    const row = store.appendRevision(
      { projectId: def.id, clientId, definition: def, status, approvalReasons: reasons, action },
      (cur) => {
        if (deps.configuredIds().has(def.id)) throw notManageable(def.id);
        if (cur !== undefined && cur.clientId !== clientId) throw notManageable(def.id);
        if ((cur?.latest.revision ?? undefined) !== seenLatest) {
          throw invalid(`project ${def.id} changed while this call was checked; retry`, {
            reason: "CONCURRENT_UPDATE",
          });
        }
        if (cur === undefined && store.countLive(clientId) >= MAX_LIVE_PROJECTS_PER_CLIENT) {
          throw quotaError("PROJECT_QUOTA", `this client already has ${MAX_LIVE_PROJECTS_PER_CLIENT} dynamic projects`);
        }
      },
    );
    const inForce = store.state(def.id)?.inForce?.revision;
    if (status === "PENDING_APPROVAL") {
      // T14.9 (FR-CTL-10, ADR-0048): the revision waits for the operator; announced off the tool path, best effort
      // (ADR-0048 item 6). A failure here never undoes the write above.
      try {
        deps.onPendingRevision?.({
          projectId: def.id,
          revision: row.revision,
          kind: reasons.some((r) => PUSH_APPROVAL_REASONS.has(r)) ? "push_revision" : "dynamic_project",
        });
      } catch {
        // Best effort: the announcement must not change the tool result.
      }
    }
    return {
      id: def.id,
      revision: row.revision,
      status,
      ...(reasons.length > 0 ? { approval_needed: reasons, message: pendingMessage(row.revision, inForce) } : {}),
      ...(inForce !== undefined ? { in_force_revision: inForce } : {}),
    };
  };

  const createProject = async (a: Record<string, unknown>) => {
    const def = a.project as ProjectConfig;
    checkStrings(def);
    const existing = ownState(def.id);
    if (existing !== undefined) {
      throw invalid(
        existing.deleted
          ? `project ${def.id} was deleted; project ids are not reused`
          : `project ${def.id} already exists; use update_project`,
        { reason: existing.deleted ? "ID_DELETED" : "ID_EXISTS", field: "$.project.id" },
      );
    }
    checkDefinition(def);
    if (store.countLive(clientId) >= MAX_LIVE_PROJECTS_PER_CLIENT) {
      throw quotaError("PROJECT_QUOTA", `this client already has ${MAX_LIVE_PROJECTS_PER_CLIENT} dynamic projects`);
    }
    await checkFilesystem(def, deps.allowedRoots, deps.dataDir);
    return write("create_project", def, undefined, approvalReasons(def, undefined, clientMax));
  };

  const liveOwn = (id: string): DynamicProjectState => {
    const st = ownState(id);
    if (st === undefined) throw invalid(`unknown project ${id}`, { reason: "UNKNOWN_PROJECT", field: "$.id" });
    if (st.deleted) throw invalid(`project ${id} was deleted`, { reason: "PROJECT_DELETED", field: "$.id" });
    return st;
  };

  const updateProject = async (a: Record<string, unknown>) => {
    const id = a.id as string;
    const def = a.project as ProjectConfig;
    checkStrings(def);
    const st = liveOwn(id);
    if (def.id !== id) {
      throw invalid("project.id must equal id (a project cannot be renamed)", {
        reason: "ID_MISMATCH",
        field: "$.project.id",
      });
    }
    checkDefinition(def);
    if (st.revisions.length >= MAX_REVISIONS_PER_PROJECT) {
      throw quotaError("REVISION_QUOTA", `project ${id} already has ${MAX_REVISIONS_PER_PROJECT} revisions`);
    }
    await checkFilesystem(def, deps.allowedRoots, deps.dataDir);
    return write("update_project", def, st.latest.revision, approvalReasons(def, st.inForce?.definition, clientMax));
  };

  const deleteProject = async (a: Record<string, unknown>) => {
    const id = a.id as string;
    const st = liveOwn(id);
    const busy = () => {
      if (store.nonTerminalRuns(id) > 0 || deps.admitting(id) > 0) {
        throw invalid(`project ${id} has a run that has not finished; wait for it or cancel it first`, {
          reason: "ACTIVE_RUN",
          project: id,
        });
      }
    };
    busy();
    const row = store.appendRevision(
      {
        projectId: id,
        clientId,
        definition: st.latest.definition,
        status: "DELETED",
        approvalReasons: [],
        action: "delete_project",
      },
      (cur) => {
        if (cur === undefined || cur.clientId !== clientId) throw notManageable(id);
        if (cur.deleted) throw invalid(`project ${id} was deleted`, { reason: "PROJECT_DELETED" });
        if (cur.latest.revision !== st.latest.revision) {
          throw invalid(`project ${id} changed while this call was checked; retry`, { reason: "CONCURRENT_UPDATE" });
        }
        busy(); // same transaction as the write: a run admitted meanwhile is seen here
      },
    );
    try {
      deps.onDeleted?.(id);
    } catch {
      // The delete is recorded; the store is pruned at the next `serve` start (FR-RAG-03).
    }
    return { id, revision: row.revision, status: "DELETED" };
  };

  const handlers: Record<ProjectToolName, (a: Record<string, unknown>) => Promise<object>> = {
    create_project: createProject,
    update_project: updateProject,
    delete_project: deleteProject,
  };

  const call = async (name: ProjectToolName, rawArgs: unknown): Promise<object> => {
    try {
      const args = structuredClone(rawArgs ?? {}) as Record<string, unknown>;
      const validate = validators[name];
      if (!validate(args)) throw schemaError(validate.errors ?? []);
      return await handlers[name](args);
    } catch (err) {
      const te =
        err instanceof ProjectRuleError
          ? fromRule(err)
          : err instanceof ProjectStoreError
            ? notManageable(namedId(name, rawArgs) ?? "")
            : toToolError(err);
      refused(name, rawArgs, te);
      throw te;
    }
  };

  const recordNotOffered = (name: ProjectToolName, rawArgs: unknown) => {
    refused(name, rawArgs, new ToolError("INVALID_REQUEST", "tool not offered", { reason: "TOOL_NOT_OFFERED" }));
  };

  const resolveForRequest = async (projectId: string): Promise<DynamicResolution | undefined> => {
    if (deps.configuredIds().has(projectId)) return undefined; // configuration wins
    const st = store.state(projectId);
    if (st === undefined) return undefined;
    if (st.clientId !== clientId || client.manageProjects !== true) {
      throw new ToolError("PERMISSION_BLOCKED", `project ${projectId} is not available to this client`, {
        project: projectId,
        ...(st.clientId === clientId ? { reason: "MANAGE_PROJECTS_OFF" } : {}),
      });
    }
    if (st.deleted) throw invalid(`project ${projectId} was deleted`, { field: "project" }); // FR-PRJ-09
    const rev = st.inForce;
    if (rev === undefined) {
      throw new ToolError(
        "PERMISSION_BLOCKED",
        `project ${projectId} has no approved revision yet; the operator must approve it (projects approve)`,
        {
          project: projectId,
          reason: st.latest.state === "rejected" ? "revision_rejected" : "approval_required",
        },
      );
    }
    const def = rev.definition;
    // The client's limits may have been lowered since the revision was written (fail closed, Delegated).
    try {
      checkClientLimits(def, limits, new Set());
    } catch (err) {
      if (err instanceof ProjectRuleError) {
        throw new ToolError("PERMISSION_BLOCKED", `project ${projectId}: ${err.message}`, {
          project: projectId,
          reason: err.reason,
        });
      }
      throw err;
    }
    // LLD §11.2 step 5: the paths may have changed since the revision was written.
    try {
      await checkFilesystem(def, deps.allowedRoots, deps.dataDir);
    } catch (err) {
      if (err instanceof ProjectRuleError) {
        throw new ToolError(err.code, `project ${projectId}: ${err.message}`, {
          project: projectId,
          field: "project",
          reason: err.reason,
        });
      }
      throw err;
    }
    return { project: toResolved(def), revision: rev.revision };
  };

  const listForClient = (): DynamicListEntry[] => {
    if (client.manageProjects !== true) return [];
    const configured = deps.configuredIds();
    const out: DynamicListEntry[] = [];
    for (const st of store.list(clientId)) {
      if (st.deleted || configured.has(st.projectId)) continue;
      const shown = st.inForce ?? st.latest;
      const status =
        st.inForce !== undefined ? "ACTIVE" : st.latest.state === "rejected" ? "REJECTED" : "PENDING_APPROVAL";
      out.push({
        project: toResolved(shown.definition),
        revision: shown.revision,
        status,
        ...(st.pending !== undefined && st.pending.revision !== shown.revision
          ? { pendingRevision: st.pending.revision }
          : {}),
      });
    }
    return out;
  };

  return { call, recordNotOffered, resolveForRequest, listForClient };
}

/** `list_projects` entry of a dynamic project: the configured shape plus `source`, `revision`, `status`. */
export function dynamicListItem(e: DynamicListEntry, clientMax: TrustProfile) {
  const p = e.project;
  return {
    id: p.id,
    name: p.name,
    environment_kind: p.environment.kind,
    contexts: p.contexts.map((c) => ({ id: c.id, kind: c.kind, primary: c.primary, push_policy: c.push.policy })),
    ...(p.maxTrustProfile !== undefined ? { max_trust_profile: p.maxTrustProfile } : {}),
    effective_max_profile: effectiveMaxProfile(clientMax, p),
    ...(p.allowedProviders !== undefined ? { allowed_providers: [...p.allowedProviders] } : {}),
    source: "dynamic" as const,
    revision: e.revision,
    status: e.status,
    ...(e.pendingRevision !== undefined ? { pending_revision: e.pendingRevision } : {}),
  };
}

function quotaError(reason: string, message: string): ToolError {
  return new ToolError("PERMISSION_BLOCKED", message, { reason });
}

function schemaError(errors: readonly ErrorObject[]): ToolError {
  const list = errors.slice(0, 10).map((e) => {
    let where = e.instancePath
      .split("/")
      .slice(1)
      .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((acc, s) => (/^\d+$/.test(s) ? `${acc}[${s}]` : `${acc}.${s}`), "$");
    if (e.keyword === "required") where += `.${String(e.params.missingProperty)}`;
    if (e.keyword === "additionalProperties") where += `.${String(e.params.additionalProperty).slice(0, 64)}`;
    return { path: where.slice(0, 200), message: e.message ?? "invalid" };
  });
  const first = list[0];
  return invalid(`invalid arguments: ${first ? `${first.path} ${first.message}` : "schema validation failed"}`, {
    reason: "INVALID_ARGUMENTS",
    errors: list,
    ...(first ? { field: first.path } : {}),
  });
}

/**
 * T5.14 (FR-SES-07, LLD §20.13; Linus decisions (a) and (b), WORK QUEUE v10): the project brief at admission. Reads the
 * file, keeps its text in this process by hash and returns the hash for the frozen project snapshot; nothing for a
 * project without `brief_file`. A brief that cannot be read or breaks a rule refuses the run (`TOOL_FAILURE`, not
 * retryable, `PROJECT_BRIEF_UNAVAILABLE`); the message names the rule, never the path or the text.
 */
export function admitBrief(
  project: Pick<ResolvedProject, "id" | "briefFile" | "contexts">,
  allowedRoots: readonly string[],
): { brief_sha256?: string } {
  if (project.briefFile === undefined) return {};
  try {
    return {
      brief_sha256: freezeBrief(project.briefFile, [...allowedRoots, ...project.contexts.map((c) => c.path)]).sha256,
    };
  } catch (err) {
    if (!(err instanceof BriefError)) throw err;
    throw new ToolError("TOOL_FAILURE", `project ${project.id}: its brief_file ${err.message}`, {
      project: project.id,
      reason: PROJECT_BRIEF_UNAVAILABLE,
    });
  }
}
