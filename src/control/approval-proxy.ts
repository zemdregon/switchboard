/**
 * Approval proxy (T14.8; FR-CTL-08, FR-MCP-06, FR-MCP-14, FR-POL-09, FR-PRJ-10, ADR-0047, LLD §3.4.8). The logic behind
 * the two MCP tools `list_pending_approvals` and `decide_approval`, which `src/mcp/server.ts` offers only to a client
 * whose operator configuration sets `mcp_clients[].approval_proxy`.
 *
 * Kinds (LLD §3.4.1 `approval_kind`):
 * - `privileged_scope`: a `PENDING` `approval` row whose run is AWAITING_APPROVAL and passes every scope hash check
 *   (`checkDecidable`, LLD §3.1). `approval_id` is the row id (`apv_…`); the digest binds the row's `scope_hash`.
 * - `dynamic_project` / `push_revision`: the latest revision of a dynamic project, `PENDING_APPROVAL` and undecided
 *   (ADR-0030). `approval_id` is the revision row id (`prv_…`). `push_revision` when the revision needs approval for a
 *   push policy, a commit identity or commit signing; `dynamic_project` otherwise.
 *
 * Kinds a proxy serves (ADR-0068): `mcp_clients[].approval_proxy_kinds` (default all three, ADR-0047 as before). An
 * approval of a kind outside the list is neither listed nor decidable, and is refused with the same single message as
 * every other failed check. So an operator can let a client approve dynamic project revisions but not privileged runs.
 *
 * Delegated choices (not owner-approved; recorded in LLD §3.4.8):
 * - `revision_hash` (ADR-0030 names no stored hash): hex SHA-256 over the canonical JSON of the revision row's
 *   controller-stored fields `{ v: 1, project_id, revision, client_id, definition_json, approval_reasons_json,
 *   created_at }`. Any change to what the operator would approve changes the hash.
 * - One refusal message for every failed check (unknown id, not pending, not a listed target, digest missing or
 *   different): a proxy learns nothing about approvals it may not see. Every refusal writes nothing.
 * - `scope_summary` is assembled from closed vocabularies and counts only: no shell argv, host name, path, objective,
 *   prompt or other request or agent text.
 * - A privileged decision is recorded the way the CLI records one (an `operator_decision_requested` event, then the
 *   shared `applyApprovalDecision` through the lifecycle), with `requested_by` and therefore `decided_by` set to
 *   `mcp_proxy:<proxy_client_id>`; the check, the record and the transition share one `BEGIN IMMEDIATE` transaction.
 * - Sink announcement (ADR-0047 2f, ADR-0048): a privileged approve is announced by the lifecycle's transition hook
 *   (T3, `approval_decided` / `privileged_scope`, T14.9), so it is not announced again here; a privileged deny and every
 *   project revision decision are announced through `announce` after the transaction commits.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { APPROVAL_PROXY_KINDS, type ResolvedMcpClient } from "../config/index.js";
import type { ApprovalRow, Ledger, RunRecord, RunState } from "../ledger/index.js";
import {
  ApprovalRefusedError,
  checkDecidable,
  type DecisionToApply,
  OPERATOR_DECISION_REQUESTED,
  type OperatorDecision,
} from "../lifecycle/approval.js";
import { canonicalJson } from "../lifecycle/request.js";
import { parsePrivilegedScope } from "../policy/index.js";
import type { DynamicProjectStore, ProjectRevisionRow } from "../projects/index.js";
import { ProjectStoreError } from "../projects/index.js";
import { NO_PROJECT_ID } from "./sinks.js";

export const APPROVAL_PROXY_TOOL_NAMES = ["list_pending_approvals", "decide_approval"] as const;
export type ApprovalProxyToolName = (typeof APPROVAL_PROXY_TOOL_NAMES)[number];

/** LLD §3.4.1 `approval_kind`. */
export type ApprovalKind = "privileged_scope" | "dynamic_project" | "push_revision";

/** `decided_by` prefix of a decision made through `decide_approval` (LLD §3.4.7, §3.4.8). */
export const MCP_PROXY_DECIDER_PREFIX = "mcp_proxy:";

/** Revision approval reasons that make a revision a `push_revision` (ADR-0047 1: push-enabled or identity-bearing). */
const PUSH_REASONS: ReadonlySet<string> = new Set(["push_policy", "commit_identity", "commit_signing"]);
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_SUMMARY = 512;

/** LLD §3.4.1 `approval_proxy_item`. */
export interface ApprovalProxyItem {
  readonly approval_id: string;
  readonly approval_digest: string;
  readonly kind: ApprovalKind;
  readonly project_id?: string;
  readonly run_id?: string;
  readonly revision?: number;
  readonly target_client_id: string;
  readonly scope_summary: string;
  readonly requested_at: string;
}

export interface DecideResult {
  readonly approval_id: string;
  readonly status: "APPROVED" | "DENIED";
}

/** What the sinks are told about one decision (the closed `notification_payload` fields, ADR-0048). */
export interface ApprovalAnnouncement {
  readonly projectId: string;
  readonly kind: ApprovalKind;
  readonly runId: string | null;
}

/** A refused proxy call. Nothing was written. The MCP layer answers `INVALID_REQUEST`. */
export class ApprovalProxyError extends Error {
  override readonly name = "ApprovalProxyError";
}

export interface ApprovalProxyDeps {
  /** The ledger; the project store must use the same database connection (one decision transaction). */
  readonly ledger: Ledger;
  /** The configured MCP client this session is bound to, and its entry. */
  readonly clientId: string;
  readonly client: ResolvedMcpClient;
  /** Dynamic projects; absent means no revision is listed or decided. */
  readonly projectStore?: DynamicProjectStore;
  /** The lifecycle's `applyApprovalDecision` (T3 to QUEUED, T19 to CANCELLED, then dispatch). Runs in our transaction. */
  readonly applyDecision: (req: DecisionToApply) => RunState;
  /** Sink announcement for the decisions the transition hook does not announce. Must not throw. */
  readonly announce?: (a: ApprovalAnnouncement) => void;
}

export interface ApprovalProxy {
  list(input: { project_id?: string }): { approvals: ApprovalProxyItem[] };
  decide(input: { approval_id: string; approval_digest: string; decision: "approve" | "deny" }): DecideResult;
}

/** The client ids whose approvals `client` may list and decide (default: itself). Empty without `approval_proxy`. */
export function proxyTargets(clientId: string, client: ResolvedMcpClient): ReadonlySet<string> {
  if (client.approvalProxy !== true) return new Set();
  return new Set(client.approvalProxyTargets ?? [clientId]);
}

/** The approval kinds `client` may list and decide (ADR-0068; default all three). Empty without `approval_proxy`. */
export function proxyKinds(client: ResolvedMcpClient): ReadonlySet<ApprovalKind> {
  if (client.approvalProxy !== true) return new Set();
  return new Set(client.approvalProxyKinds ?? APPROVAL_PROXY_KINDS);
}

/** LLD §3.4.8 `approval_digest`: hex SHA-256 over the canonical JSON of ledger-only fields. */
export function approvalDigest(
  input: { approvalId: string; kind: ApprovalKind; targetClientId: string; requestedAt: string } & (
    | { scopeHash: string }
    | { revisionHash: string }
  ),
): string {
  const bound = "scopeHash" in input ? { scope_hash: input.scopeHash } : { revision_hash: input.revisionHash };
  return createHash("sha256")
    .update(
      canonicalJson({
        v: 1,
        approval_id: input.approvalId,
        kind: input.kind,
        ...bound,
        target_client_id: input.targetClientId,
        requested_at: input.requestedAt,
      }),
    )
    .digest("hex");
}

/** Delegated `revision_hash` (ADR-0030 revision; see the module comment). */
export function revisionHash(row: ProjectRevisionRow): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        v: 1,
        project_id: row.project_id,
        revision: row.revision,
        client_id: row.client_id,
        definition_json: row.definition_json,
        approval_reasons_json: row.approval_reasons_json,
        created_at: row.created_at,
      }),
    )
    .digest("hex");
}

/** A controller-generated summary of a privileged scope: closed vocabulary and counts only. */
export function privilegedScopeSummary(scopeJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopeJson) as unknown;
  } catch {
    return "privileged scope (unreadable)";
  }
  const s = parsePrivilegedScope(parsed);
  if (!s.ok) return "privileged scope (invalid)";
  const { files, shell, network, repository_config, bypass } = s.scope;
  const shellText = shell.mode === "allowlist" ? `allowlist of ${shell.allowlist.length} command(s)` : shell.mode;
  const netText = network.mode === "allowlist" ? `allowlist of ${network.hosts.length} host(s)` : network.mode;
  return (
    `privileged scope: files ${files.access}; shell ${shellText}; network ${netText}; ` +
    `repository config ${repository_config.mode}; bypass ${bypass ? "yes" : "no"}`
  ).slice(0, MAX_SUMMARY);
}

function revisionKind(reasons: readonly string[]): "dynamic_project" | "push_revision" {
  return reasons.some((r) => PUSH_REASONS.has(r)) ? "push_revision" : "dynamic_project";
}

function revisionSummary(row: ProjectRevisionRow, reasons: readonly string[]): string {
  // Reasons are the closed `APPROVAL_REASONS` vocabulary (src/projects/rules.ts); anything else is not repeated.
  const known = reasons.filter((r) => /^[a-z_]{1,40}$/.test(r));
  return `dynamic project revision ${row.revision}: approval needed for ${known.join(", ") || "review"}`.slice(
    0,
    MAX_SUMMARY,
  );
}

/** Constant-time comparison of two digests; false unless both are well-formed and equal. */
function sameDigest(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !DIGEST_RE.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

const REFUSED =
  "decide_approval refused: the approval is unknown, no longer pending, not listed for this client, or its " +
  "approval_digest does not match the one list_pending_approvals returned; nothing changed";

interface PrivilegedCandidate {
  readonly kind: "privileged_scope";
  readonly item: ApprovalProxyItem;
  readonly row: ApprovalRow;
  readonly run: RunRecord;
}
interface RevisionCandidate {
  readonly kind: "dynamic_project" | "push_revision";
  readonly item: ApprovalProxyItem;
  readonly row: ProjectRevisionRow;
}
type Candidate = PrivilegedCandidate | RevisionCandidate;

export function createApprovalProxy(deps: ApprovalProxyDeps): ApprovalProxy {
  const { ledger, clientId, client } = deps;
  const targets = proxyTargets(clientId, client);
  const kinds = proxyKinds(client);
  const decider = `${MCP_PROXY_DECIDER_PREFIX}${clientId}`;

  const privilegedCandidate = (row: ApprovalRow): PrivilegedCandidate | undefined => {
    if (!kinds.has("privileged_scope") || row.status !== "PENDING") return undefined;
    const run = ledger.getRunRecord(row.run_id);
    if (!run || !targets.has(run.client_id)) return undefined;
    try {
      if (checkDecidable(ledger, run).id !== row.id) return undefined;
    } catch (err) {
      if (err instanceof ApprovalRefusedError) return undefined;
      throw err;
    }
    const item: ApprovalProxyItem = {
      approval_id: row.id,
      approval_digest: approvalDigest({
        approvalId: row.id,
        kind: "privileged_scope",
        scopeHash: row.scope_hash,
        targetClientId: run.client_id,
        requestedAt: row.requested_at,
      }),
      kind: "privileged_scope",
      ...(run.project_id !== null ? { project_id: run.project_id } : {}),
      run_id: run.id,
      target_client_id: run.client_id,
      scope_summary: privilegedScopeSummary(row.scope_json),
      requested_at: row.requested_at,
    };
    return { kind: "privileged_scope", item, row, run };
  };

  const pendingRevisionRows = (projectId?: string): ProjectRevisionRow[] => {
    if (deps.projectStore === undefined || targets.size === 0) return [];
    const out: ProjectRevisionRow[] = [];
    for (const st of deps.projectStore.list()) {
      if (projectId !== undefined && st.projectId !== projectId) continue;
      if (st.pending === undefined || !targets.has(st.clientId)) continue;
      const row = deps.projectStore.revisionRowOf(st.projectId, st.pending.revision);
      if (row !== undefined && row.status === "PENDING_APPROVAL" && targets.has(row.client_id)) out.push(row);
    }
    return out;
  };

  const revisionCandidate = (row: ProjectRevisionRow): RevisionCandidate => {
    let reasons: string[] = [];
    try {
      const parsed = JSON.parse(row.approval_reasons_json) as unknown;
      if (Array.isArray(parsed)) reasons = parsed.filter((r): r is string => typeof r === "string");
    } catch {
      // An unreadable reason list is summarised as "review" and listed as dynamic_project.
    }
    const kind = revisionKind(reasons);
    const item: ApprovalProxyItem = {
      approval_id: row.id,
      approval_digest: approvalDigest({
        approvalId: row.id,
        kind,
        revisionHash: revisionHash(row),
        targetClientId: row.client_id,
        requestedAt: row.created_at,
      }),
      kind,
      project_id: row.project_id,
      revision: row.revision,
      target_client_id: row.client_id,
      scope_summary: revisionSummary(row, reasons),
      requested_at: row.created_at,
    };
    return { kind, item, row };
  };

  /** A pending revision row as a candidate of a kind this proxy serves, or undefined (ADR-0068). */
  const servedRevision = (row: ProjectRevisionRow): RevisionCandidate | undefined => {
    const c = revisionCandidate(row);
    return kinds.has(c.kind) ? c : undefined;
  };

  /** The decidable approval named `approvalId` for this client, or undefined. Reads only. */
  const find = (approvalId: string): Candidate | undefined => {
    if (targets.size === 0) return undefined;
    if (approvalId.startsWith("apv_")) {
      const row = ledger.getApproval(approvalId);
      return row ? privilegedCandidate(row) : undefined;
    }
    if (approvalId.startsWith("prv_") && deps.projectStore !== undefined) {
      const row = deps.projectStore.revisionRow(approvalId);
      if (row === undefined) return undefined;
      // Only the latest, undecided, pending revision of a project is decidable (store rules); same listing path.
      const pending = pendingRevisionRows(row.project_id).find((r) => r.id === row.id);
      return pending === undefined ? undefined : servedRevision(pending);
    }
    return undefined;
  };

  return {
    list(input) {
      if (targets.size === 0) return { approvals: [] };
      const privileged = ledger
        .listApprovals({ status: "PENDING" })
        .map(privilegedCandidate)
        .filter((c): c is PrivilegedCandidate => c !== undefined)
        .filter((c) => input.project_id === undefined || c.run.project_id === input.project_id)
        .map((c) => c.item);
      const revisions = pendingRevisionRows(input.project_id)
        .map(servedRevision)
        .filter((c): c is RevisionCandidate => c !== undefined)
        .map((c) => c.item);
      const approvals = [...privileged, ...revisions].sort(
        (a, b) => a.requested_at.localeCompare(b.requested_at) || a.approval_id.localeCompare(b.approval_id),
      );
      return { approvals };
    },

    decide(input) {
      const decision: OperatorDecision = input.decision === "approve" ? "APPROVED" : "DENIED";
      let announcement: ApprovalAnnouncement | undefined;
      const result = ledger.immediate((): DecideResult => {
        const c = find(input.approval_id);
        if (c === undefined || !sameDigest(input.approval_digest, c.item.approval_digest)) {
          throw new ApprovalProxyError(REFUSED);
        }
        if (c.kind === "privileged_scope") {
          const event = ledger.appendRunEvent({
            runId: c.run.id,
            type: OPERATOR_DECISION_REQUESTED,
            payload: {
              decision,
              approval_id: c.row.id,
              requested_by: decider,
              scope_hash: c.row.scope_hash,
            },
          });
          try {
            deps.applyDecision({
              requestEventId: event.id,
              runId: c.run.id,
              decision,
              requestedBy: decider,
              requestedAt: event.ts,
              scopeHash: c.row.scope_hash,
            });
          } catch (err) {
            // Rolls back the request event too: a refused decision writes nothing.
            if (err instanceof ApprovalRefusedError) throw new ApprovalProxyError(REFUSED);
            throw err;
          }
          if (decision === "DENIED") {
            announcement = { projectId: c.run.project_id ?? NO_PROJECT_ID, kind: c.kind, runId: c.run.id };
          }
          return { approval_id: c.row.id, status: decision };
        }
        const store = deps.projectStore as DynamicProjectStore;
        try {
          store.decide({
            projectId: c.row.project_id,
            revision: c.row.revision,
            decision: decision === "APPROVED" ? "APPROVED" : "REJECTED",
            decidedBy: decider,
          });
        } catch (err) {
          if (err instanceof ProjectStoreError) throw new ApprovalProxyError(REFUSED);
          throw err;
        }
        announcement = { projectId: c.row.project_id, kind: c.kind, runId: null };
        return { approval_id: c.row.id, status: decision };
      });
      if (announcement !== undefined) {
        const a = announcement;
        try {
          deps.announce?.(a);
        } catch {
          // Best effort (ADR-0048 item 6): an announcement never changes the decision.
        }
      }
      return result;
    },
  };
}

// ---- MCP tool documents (LLD §3.4.8). Static controller text only: no agent, request or repository text. ---------

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["approval_id", "approval_digest", "kind", "requested_at", "target_client_id"],
  properties: {
    approval_id: { type: "string" },
    approval_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    kind: { enum: ["privileged_scope", "dynamic_project", "push_revision"] },
    project_id: { type: "string" },
    run_id: { type: "string" },
    revision: { type: "integer" },
    target_client_id: { type: "string" },
    scope_summary: { type: "string", maxLength: MAX_SUMMARY },
    requested_at: { type: "string" },
  },
} as const;

export const APPROVAL_PROXY_INPUTS: Record<ApprovalProxyToolName, Record<string, unknown>> = {
  list_pending_approvals: {
    type: "object",
    additionalProperties: false,
    properties: { project_id: { type: "string", maxLength: 64 } },
  },
  decide_approval: {
    type: "object",
    additionalProperties: false,
    required: ["approval_id", "approval_digest", "decision"],
    properties: {
      approval_id: { type: "string", minLength: 1, maxLength: 64 },
      approval_digest: { type: "string", pattern: "^[0-9a-f]{64}$", maxLength: 64 },
      decision: { enum: ["approve", "deny"] },
    },
  },
};

export const APPROVAL_PROXY_OUTPUTS: Record<ApprovalProxyToolName, Record<string, unknown>> = {
  list_pending_approvals: {
    type: "object",
    required: ["approvals"],
    properties: { approvals: { type: "array", items: ITEM_SCHEMA } },
  },
  decide_approval: {
    type: "object",
    required: ["approval_id", "status"],
    properties: { approval_id: { type: "string" }, status: { enum: ["APPROVED", "DENIED"] } },
  },
};

export const APPROVAL_PROXY_DESCRIPTIONS: Record<ApprovalProxyToolName, string> = {
  list_pending_approvals:
    "List the pending approvals this client may decide for the operator: privileged scopes and dynamic project " +
    "revisions of the clients the operator listed for it, of the kinds the operator allows it. Each item has an approval_id and an approval_digest computed " +
    "by the controller from ledger state, plus controller-generated fields only. Optional project_id filters the list.",
  decide_approval:
    "Approve or deny one pending approval for the operator. Pass the exact approval_id and the approval_digest that " +
    "list_pending_approvals returned for it; a missing, stale or different digest, or an approval this client may not " +
    "decide, is refused with INVALID_REQUEST and changes nothing. The decision is recorded as made through the MCP " +
    "proxy by this client and announced to the configured notification sinks.",
};

export interface ApprovalProxyToolDescriptor {
  name: ApprovalProxyToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/** `tools/list` entries for an `approval_proxy` client (fresh copies). */
export function approvalProxyToolDescriptors(): ApprovalProxyToolDescriptor[] {
  return APPROVAL_PROXY_TOOL_NAMES.map((name) => ({
    name,
    description: APPROVAL_PROXY_DESCRIPTIONS[name],
    inputSchema: structuredClone(APPROVAL_PROXY_INPUTS[name]),
    outputSchema: structuredClone(APPROVAL_PROXY_OUTPUTS[name]),
  }));
}
