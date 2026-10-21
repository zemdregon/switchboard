/**
 * COMP-MCP: the upstream MCP server over stdio (T2.4; FR-MCP-01, 03–09; ADR-0002; LLD §3). It owns validation and
 * result shaping only; admission, dispatch and cancellation stay in the run lifecycle, and eligibility is the shared
 * stage-1 filter (`src/routing`) reached through `RunLifecycle.checkEligibility`.
 *
 * SDK use: `@modelcontextprotocol/server` 2.3.1 (T13.10, ADR-0062). Its high-level `McpServer.registerTool` takes zod
 * schemas, so this module uses the lower-level `Server` with `tools/list` and `tools/call` request handlers (registered
 * by method name in v2) and publishes the raw JSON Schemas from `./schemas.ts`, validated here with Ajv (TDD §2: Ajv
 * schemas are the source of truth; zod is not a direct dependency). Over stdio the connection follows the client's
 * opening handshake exactly as before; the HTTP transport (`./http.ts`) serves both protocol eras from this same
 * server factory.
 *
 * Client identity is fixed per stdio session (`clientId`, bound by `serve --client <id>`, FR-OPS-04, R-9). Proposed
 * (Delegated) choices, all fail-closed:
 * - Validation order follows FRD §7.1: schema (V1, V2, V9) → workspace (V3, V4) → ceiling (V5) → verification (V7) →
 *   routing hints (V8) → idempotency (V10) → eligibility (V11). The first failure is the single error.
 * - `privileged` (T3.3, LLD §3.1, FRD V13/C7/T1/T2): a client whose ceiling is below `privileged` gets
 *   PERMISSION_BLOCKED (V5); then V13 refuses `privileged` without `privileged_scope` and a scope with any other profile
 *   (INVALID_REQUEST, `details.field = "privileged_scope"`). A malformed scope already failed V1 (schema plus the
 *   "present exactly when allowlist" check run right after Ajv). Admission is T2: AWAITING_APPROVAL plus one PENDING
 *   approval row. `continue_task` resolving `privileged` (requested or defaulted, C4) needs the meta-session's APPROVED
 *   approval for this client (C7, checked after the ceiling) and takes the approved scope as is.
 * - Owner decision 22 (ADR-0019, mechanism Delegated): for a client configured `privileged_approval: "not_required"`
 *   the same validated, hashed scope is admitted by T1 to QUEUED with its approval row written APPROVED by
 *   `client_policy:<client_id>` in the admission transaction. Nothing else is relaxed: the ceiling (V5), V13, the
 *   scope validation, the dispatch-time hash checks, Git-write denial and worktree isolation all still apply.
 * - Proposed: for a `privileged` request V11 defers the adapter compile verdict to dispatch, because at admission
 *   `bypassApproved` is not known yet (it comes from the approval row at dispatch): a provider excluded only by
 *   PROFILE_UNSUPPORTED or CAPABILITY_MISSING is admissible (it still has to pass binary, version, manifest,
 *   enablement, platform, the T3.7 profile-platform rule and auth). At dispatch the adapter's compile, with
 *   `bypassApproved` from the approval, decides; an `Ineligible` there ends the run with its BR-3 code.
 * - `list_capabilities` (T3.7): `supported_profiles` is each provider's compile matrix on this host: the
 *   profile-platform rule (`profilePlatformSupported`), then the adapter's own compile of each resolved profile
 *   (`compileCheck`, the same call the eligibility filter makes). `privileged` is listed only if the adapter compiles
 *   any scope of a small representative set (`REPRESENTATIVE_PRIVILEGED_SCOPES`, Proposed, LLD §3.1 "Listing").
 * - `verification_commands` (T3.10, FR-EXE-08): argv arrays run by the lifecycle after the agent (VERIFYING). V7
 *   refuses a non-empty list under `inspect-untrusted` (INVALID_REQUEST, `details.field`), and re-checks the shape
 *   (non-empty executable, no NUL). `minimum_capability` evaluates against operator-declared model capability in the
 *   model registry (T7.8, FR-RTE-01).
 * - The idempotency hash covers the validated, defaults-filled input with the workspace canonicalised, excluding
 *   `idempotency_key` and `wait_seconds` (which do not change what runs) and independent of the routed provider.
 * - Provider choice among eligible candidates: `provider_preference` if eligible, else candidate (registration) order
 *   (BR-4 tie-break until M7 scoring).
 * - Runs, meta-sessions and artifacts are visible only to the client that created them; another client's id is
 *   reported as unknown (INVALID_REQUEST), so ids are not an existence oracle across clients. Over the network
 *   transport (T13.5, FR-MCP-15, Q-78) the same holds per subject: a meta-session opened over HTTP is bound to the
 *   caller's OAuth client (`subject`) and is unknown to every other subject and to stdio; one opened over stdio is
 *   unknown over HTTP. A run belongs to its meta-session. A meta-session the controller opened to admit a queued work
 *   item has no subject and belongs, like the item, to the client that created the item, over either transport
 *   (FR-QUE-01, FR-QUE-08). An idempotency key another subject used is reported exactly like a key reused with
 *   different parameters.
 * - `continue_task` (T5.6; FRD BR-18, WF-2, WF-3; LLD §15.7; ADR-0038) chooses between a native resume and a handoff.
 *   With no other provider named, the session provider `P0` (latest binding, else latest run) resumes its native
 *   session when it is eligible and its origin directory is usable (T5.7); it is a handoff preferring `P0` when there
 *   is no binding (`no_binding`) or the directory is unusable (`resume_directory_unavailable`). Another provider named
 *   is a handoff routed normally with that preference (`provider_named`); an ineligible `P0` without `require_provider`
 *   is a handoff over the project's other allowed providers (`bound_provider_ineligible`); `require_provider` naming an
 *   ineligible provider fails with its BR-3 code. A named provider the project does not allow is PERMISSION_BLOCKED
 *   before anything is probed. A `privileged` continuation to another provider is refused (Q-61, one constant in
 *   `src/continuity/policy.ts`) before any provider other than `P0` is probed. A handoff builds the bundle before
 *   admission; a failure there is TOOL_FAILURE `HANDOFF_BUNDLE_UNAVAILABLE` with no row written.
 * - Unknown tool names return an INVALID_REQUEST tool error (FR-MCP-07) rather than a JSON-RPC protocol error.
 * - Projects (T9.2; FR-PRJ-03, FR-PRJ-06; FRD V12, BR-23; ADR-0024). `delegate_task` takes exactly one of `workspace_path`
 *   and `project` (the schema's `oneOf`, INVALID_REQUEST). With a project: an unknown id is INVALID_REQUEST; an id the
 *   client's `projects` list lacks is PERMISSION_BLOCKED (an absent list means no project, Delegated fail-closed
 *   reading; workspace_path requests are unaffected); a `container` project is admitted only when the
 *   lifecycle has a container placement for it (T10.1: `serve` wires the `container` backend when a configured project
 *   is `container`; the image pinned in the project is frozen into the snapshot); otherwise it fails TOOL_FAILURE with
 *   `details.reason = ENVIRONMENT_NOT_IMPLEMENTED` before any side effect (Proposed code: LLD §3 names no other).
 *   The workspace is the primary context's path, canonicalised and root-checked at every request (LLD §11.2 step 5), and
 *   its `base_ref` must resolve to a commit. The effective ceiling is the lower of the client's and the project's
 *   (V5 with both limits named in the error details). A project's `allowed_providers` narrows the candidate set; naming a
 *   provider outside it with `require_provider` is PERMISSION_BLOCKED (SRS FR-PRJ-06 wording), and a set that leaves no
 *   registered provider is ELIGIBILITY_NONE (FRD BR-23 "ineligible under BR-1"). `continue_task` takes no project: the
 *   meta-session's own is re-resolved under the same checks (a project removed from configuration is INVALID_REQUEST,
 *   FR-PRJ-09), and the lifecycle refuses any other project (INVALID_REQUEST).
 * - Dynamic projects (T9.9; FR-PRJ-10, BR-32, ADR-0030): see `./project-tools.ts`. The three management tools are listed
 *   and callable only with `manage_projects`; a dynamic project resolves only for its creator, to its in-force revision
 *   (a revision waiting for approval is PERMISSION_BLOCKED with `details.reason = approval_required`), after the same
 *   filesystem checks as at creation, and is frozen into the policy snapshot exactly like a configured project; the
 *   route decision's `project` reasons name the revision.
 * - `list_runs` (T14.1; FR-CTL-01, FR-MCP-04, LLD §3.4.2) is read-only and scoped exactly as `get_run`: only runs this
 *   client started, over this caller's subject, so every row is the envelope `get_run` returns for that run (the same
 *   builder). A `project_id` filter must name a project this client may use (a configured project in its `projects`
 *   list, or a live dynamic project it created): an id it may not use is PERMISSION_BLOCKED; any other id, including
 *   another client's dynamic project, is INVALID_REQUEST, like an unknown run. Rows are newest first (`created_at`,
 *   then `run_id`, both descending); the cursor is an opaque keyset position (Delegated).
 * - `get_digest` (T14.3; FR-CTL-02, FR-TEL-01, LLD §3.4.3) is read-only and scoped as `get_run`: its cursor is a
 *   `run_event.id` of this caller's own runs, and run summaries arrive only as labelled, capped untrusted text
 *   (`./digest.ts` holds the Proposed assembly rules).
 * - `steer_run` (T14.7; FR-CTL-04, FR-SES-03, BR-7, LLD §3.4.4) is scoped as `get_run` (another client's run is
 *   unknown, INVALID_REQUEST) and hands the note to the lifecycle, which records `steer_requested` (length and hash
 *   only) and delivers it by boundary-resume of the same native session (`../lifecycle/steer.ts`). A terminal run is a
 *   no-op returning its envelope. The note never appears in any tool output.
 * - `pause_project` / `resume_project` (T14.6; FR-CTL-05, LLD §3.4.4) take a project exactly as the `list_runs`
 *   filter does (`checkListProject`: unknown → INVALID_REQUEST, outside the client's list → PERMISSION_BLOCKED, the
 *   client's own dynamic project allowed) and set that project's `control_plane_state` row as `mcp:<client_id>`
 *   (`src/control/pause.ts`). The result is the project's own flag; the operator's global pause is not a project flag
 *   and nothing over MCP sets or clears it. Admission is what changes: `delegate_task` / `continue_task` into a paused
 *   project is ELIGIBILITY_NONE with `details.reason` PROJECT_PAUSED (GLOBAL_PAUSED under the operator's pause);
 *   runs already admitted finish.
 * - Project work queue (T15.1; FR-QUE-01, LLD §18.4): `enqueue_work`, `list_work` and `cancel_work` take a project
 *   exactly as the `list_runs` filter does (`checkListProject`). A work item is visible to the client that created it
 *   only; another client's item id is unknown (INVALID_REQUEST), like a run. `enqueue_work` runs the request checks of
 *   `delegate_task` that need no workspace (the ceiling, V5, against the lower of the client's and the project's
 *   maximum now; V13; V7; V8) and writes the item through the ledger; admission later goes through
 *   `../queue/admission.ts` under the same client at that time. Delegated: a project's item count at
 *   `queue.max_items_per_project` is INVALID_REQUEST (LLD §18.1); an MCP idempotency key is stored as `mcp:<key>`, so
 *   it cannot collide with a schedule's or CI trigger's key, and is replayed only for the same project, request,
 *   priority and `depends_on`; `depends_on` names this client's own items. `cancel_work` cancels a PENDING or READY
 *   item and returns any other item unchanged (an admitted item is stopped with `cancel_run`). T15.9 (FR-QUE-08,
 *   LLD §20.8): the tools are also offered over the network transport, but only to an `orchestrator` client, under
 *   the same scope check as `delegate_task` (FR-MCP-14); the mapped client's ceiling applies exactly as on stdio.
 * - Decision requests (T14.15; FR-CTL-13, FR-CTL-08, LLD §20.3): `request_decision` and `list_decisions` for an
 *   `orchestrator` client and `decide` only for an `approval_proxy` one, over both transports, once `serve` wires
 *   `deps.decisions` (`./decision-tools.ts`, `../control/decisions.ts`). `request_decision` takes a project as the
 *   `list_runs` filter does, names only this client's own work item, and runs the `enqueue_work` request checks on
 *   each enqueue entry. A decision is visible to its requester; `decide` resolves only the decisions of the proxy's
 *   targets (another is unknown), and a second resolution is INVALID_REQUEST with `details.reason` CONFLICT (no
 *   taxonomy code names a conflict, as QUEUE_FULL; Delegated).
 * - Skill tools (T16.9; FR-SKL-08, FR-CTL-11, LLD §19.9, ADR-0056 item 12): `list_skills` and `get_skill` exist only
 *   when the skill store is wired (`deps.skills`) and `skills.enabled` is true, and only for an `orchestrator` client
 *   (they are outside the console set). Both read the T16.1 store and write nothing. Visibility is
 *   `mcp_clients[].skills`; a version is shown when LLD §19.5 step 4 would let this client inject it. `defaults` is
 *   `resolveSkills` (`../skills/resolve.ts`, the steps 2 to 4 resolver admission reuses) without request names.
 *   Delegated: `trust_profile` defaults to the client's maximum, or its ceiling in `project`; one above that is
 *   PERMISSION_BLOCKED as in `delegate_task`; a project this client may not use is reported like an unknown one (as
 *   `search_project_context`); every `get_skill` miss (unknown, retired, invisible, version not injectable) is the same
 *   INVALID_REQUEST, which never names the skill; a stored file that fails its hash is TOOL_FAILURE.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CallToolResult, Server, type Tool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type Database from "better-sqlite3";
import {
  type AdapterRegistry,
  acceptedProviderNames,
  acceptsReportedModel,
  canonicalProviderId,
  type ProviderId,
  type ResolvedProfile,
} from "../adapters/index.js";
import type { ArtifactStore } from "../artifacts/index.js";
import {
  capacityProjection,
  capacityProviders,
  type ProviderUsageReaderDeps,
  readProviderUsage,
  usageReadTargets,
  withProviderUsage,
} from "../capacity/index.js";
import {
  type CapacitySettings,
  CONTAINER_NOT_IMPLEMENTED,
  DEFAULT_CAPACITY_CONFIDENCE_RUNS,
  DEFAULT_CAPACITY_WINDOW_SECONDS,
  effectiveMaxProfile,
  groupMembersFor,
  type ModelGroupsConfigInput,
  modelGroupsOf,
  primaryContext,
  projectsForClient,
  type ResolvedConfig,
  type ResolvedModelGroups,
  type ResolvedProject,
  type ResolvedSkills,
  type RoutingSettings,
} from "../config/index.js";
import {
  type BundleBounds,
  buildAndPutHandoffView,
  DEFAULT_BUNDLE_BOUNDS,
  PRIVILEGED_CROSS_PROVIDER_REASON,
  refusesPrivilegedCrossProvider,
  takeAsOf,
} from "../continuity/index.js";
import {
  APPROVAL_PROXY_INPUTS,
  APPROVAL_PROXY_TOOL_NAMES,
  type ApprovalAnnouncement,
  ApprovalProxyError,
  type ApprovalProxyToolName,
  approvalProxyToolDescriptors,
  createApprovalProxy,
  MCP_PROXY_DECIDER_PREFIX,
  proxyTargets,
} from "../control/approval-proxy.js";
import {
  type DecisionAnnouncement,
  DecisionError,
  decisionTextView,
  decisionView,
  requestDecision,
  resolveDecision,
} from "../control/decisions.js";
import { snapshotEnvironment } from "../environment/index.js";
import {
  type DecisionOption,
  type DecisionState,
  type Ledger,
  type RunRecord,
  type RunState,
  type TrustProfile,
  WorkItemDedupeConflictError,
  type WorkItemRow,
  type WorkItemState,
} from "../ledger/index.js";
import {
  type EligibilityAnswer,
  type EligibilityQuestion,
  type HandoffReason,
  type HandoffSubmission,
  type RunLifecycle,
  type RunPriority,
  requestHash,
  type SkillAdmissionPort,
  verificationCommandsProblem,
} from "../lifecycle/index.js";
import type { ModelCapability, ModelRegistry } from "../models/registry.js";
import {
  checkScopeLists,
  type PrivilegedScope,
  type ProjectSnapshot,
  parsePrivilegedScope,
  privilegedEligibilityProfile,
} from "../policy/index.js";
import {
  type DynamicProjectStore,
  type GitRunner,
  normalizedUrl,
  parseRepositoryUrl,
  sourceAllowed,
} from "../projects/index.js";
import { hotPathsProblem, storedHotPaths } from "../queue/hot-paths.js";
import { DEFAULT_QUEUE_MAX_ITEMS_PER_PROJECT, QUEUE_IDEMPOTENCY_PREFIX } from "../queue/scheduler.js";
import { deleteRagStore } from "../retrieval/store.js";
import {
  buildRouteDecision,
  collectAffinityFacts,
  collectPacingInputs,
  collectScoreInputs,
  compileCheck,
  DEFAULT_AFFINITY,
  DEFAULT_WEIGHTS,
  type EligibilityReasonCode,
  explainRoute,
  type GroupEligibility,
  groupStage1,
  planModelPin,
  profilePlatformSupported,
  profileRank,
  type RouteDecisionResult,
  type RouteFeatures,
  requestedMembers,
  requirementsFor,
  TRUST_PROFILE_ORDER,
  withModelPin,
} from "../routing/index.js";
import {
  hasSkillFields,
  runSkillMetadata,
  type SkillRequestFields,
  skillAdmissionPort,
  skillRequestFields,
} from "../skills/admission.js";
import {
  canonicalBody,
  getSkillVersion,
  listSkillNames,
  newestInjectableVersion,
  readSkillContent,
  resolveSkills,
  type SkillGate,
  storeCatalog,
  versionInjectable,
} from "../skills/index.js";
import { gitText } from "../workspace/git.js";
import { type BaseToolDeps, rebaseSessionTool, refreshProjectBase } from "./base-tools.js";
import { type ClosePrArgs, closePr, closePrOffered, recordClosePrRefusal } from "./close-pr.js";
import {
  type AnyDecisionToolName,
  DECIDE_TOOL_NAMES,
  DECISION_TOOL_NAMES,
  decisionInputs,
  decisionToolDescriptors,
} from "./decision-tools.js";
import { assembleDigest, type OpenDecisionItem } from "./digest.js";
import { buildEnvelope, compactEvents, type Envelope } from "./envelope.js";
import { errorEnvelope, invalid, ToolError, toToolError } from "./errors.js";
import type { SubjectBindings } from "./http-subjects.js";
import { type MergeRunDeps, mergeRunPr, updateRunBranch, updateRunOffered } from "./merge-run-pr.js";
import { type OAuthAdmin, UnknownOAuthClientError } from "./oauth-admin.js";
import {
  admitBrief,
  createProjectTools,
  dynamicListItem,
  mergePolicyItem,
  type PendingRevisionAnnouncement,
  type ProjectTools,
  setupItem,
  snapshotSetup,
} from "./project-tools.js";
import { type PublishDeps, publishRun } from "./publish.js";
import {
  BASE_TOOL_NAMES,
  type BaseToolName,
  inputSchema,
  MCP_ARTIFACT_KINDS,
  OAUTH_TOOL_NAMES,
  PROJECT_TOOL_NAMES,
  type ProjectToolName,
  PUBLISH_TOOL_NAMES,
  type PublishToolName,
  SCHEMA_DIALECT,
  SEARCH_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  type SkillToolName,
  TOOL_NAMES,
  TOOL_SCHEMA_VERSION,
  type ToolName,
  toolDescriptors,
  WORK_QUEUE_TOOL_NAMES,
  type WorkQueueToolName,
  withError,
} from "./schemas.js";
import { createScrubber } from "./scrub.js";
import { type SearchContextDeps, searchEnabledFor, searchProjectContext } from "./search-context.js";
import { applyToolProfile, profileOffers } from "./tool-profile.js";

export const SERVER_NAME = "switchboard";
/**
 * Tracks package.json `version`. Read at runtime relative to this module so it
 * works from `src/` (tests), from `dist/` (built CLI) and inside the packed
 * tarball (which always contains the root `package.json`). Falls back to
 * "0.0.0" when the file is missing or unparsable, so a relocated copy still
 * starts instead of crashing at import time.
 */
export const SERVER_VERSION: string = readPackageVersion();

function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as { readonly version?: unknown }).version;
      if (typeof version === "string" && version !== "") {
        return version;
      }
    }
  } catch {
    // Fall through to the fallback below.
  }
  return "0.0.0";
}

export interface McpServerDeps {
  readonly lifecycle: RunLifecycle;
  readonly ledger: Ledger;
  readonly artifacts: ArtifactStore;
  readonly registry: AdapterRegistry;
  readonly config: Pick<ResolvedConfig, "allowedRoots" | "mcpClients"> & {
    /** Configured projects (FR-PRJ-01, T9.2). Absent is read as none. */
    readonly projects?: readonly ResolvedProject[];
    /** T9.9: no dynamic project may lie inside the data directory. */
    readonly dataDir?: string;
    /** ADR-0068: where `create_project` may clone a `clone_url`. Absent: every `clone_url` is refused. */
    readonly projectSources?: ResolvedConfig["projectSources"];
    /** T9.9: providers the operator disabled are outside every client's provider set. */
    readonly providers?: ResolvedConfig["providers"];
    /** T5.6: handoff bundle bounds (`continuity.*`, LLD §15.4). Absent means the LLD defaults. */
    readonly continuity?: BundleBounds;
    /** T6.3: estimator settings (`capacity.*`, LLD §16.1). Absent means the LLD defaults. T6.14: subscriptions too. */
    readonly capacity?: Pick<CapacitySettings, "windowSeconds" | "confidenceRuns" | "subscriptions" | "pacing">;
    /** T6.3: slot limits shown by `get_capacity`. Absent means the NFR-PERF-03 default of one per provider. */
    readonly limits?: Pick<ResolvedConfig["limits"], "perProviderConcurrency">;
    /** T7.2, T7.5: `routing.weights` and `routing.affinity` (LLD §17.1). Absent means the LLD defaults. */
    readonly routing?: Partial<RoutingSettings>;
    /** T15.1: `queue.max_items_per_project` (LLD §18.1). Absent means the LLD default. */
    readonly queue?: { readonly maxItemsPerProject?: number };
    /** T7.14 (FR-RTE-10, FR-RTE-11, LLD §17.7): configured model groups. */
    readonly modelGroups?: ResolvedModelGroups;
    readonly model_groups?: ModelGroupsConfigInput;
    readonly configPath?: string;
  };
  /** T7.8, T7.14: model registry for minimum capability and model resolution. */
  readonly models?: ModelRegistry;
  /** T9.9 (FR-PRJ-10): dynamic projects. Required when the client has `manage_projects`; absent means none resolve. */
  readonly projectStore?: DynamicProjectStore;
  /** ADR-0068: the Git runner `create_project` clones with. Absent: `git` from `PATH` (tests inject a local one). */
  readonly projectGit?: GitRunner;
  /**
   * T12.6 (FR-RAG-06): `search_project_context`. Absent (no embedding backend configured) means the tool is never
   * listed; present, it is listed only while retrieval is on for at least one project this client may use.
   */
  readonly searchContext?: SearchContextDeps;
  /**
   * T16.9 (FR-SKL-08): the skill store (`skill_version`, `skill_event` and `<data_dir>/skills/`) and the resolved
   * `skills` settings. Absent, or present with `settings.enabled` false, means `list_skills` and `get_skill` do not
   * exist for this server.
   */
  readonly skills?: SkillToolDeps;
  /** Configured MCP client this session is bound to (`serve --client <id>`). */
  readonly clientId: string;
  /**
   * T13.5 (FR-MCP-15, Q-78): the OAuth client id (token subject) of an HTTP request; absent on stdio. Requires
   * `subjectBindings`.
   */
  readonly subject?: string;
  /** T13.5: meta-session to subject bindings. Absent on stdio means no HTTP-bound meta-session is filtered out. */
  readonly subjectBindings?: SubjectBindings;
  /**
   * The OAuth admin view behind `list_oauth_clients`. Offered only on stdio (no `subject`): a server built for an HTTP
   * subject never lists or serves the tool, even when this is passed (fail closed).
   */
  readonly oauthAdmin?: Pick<OAuthAdmin, "listClients" | "getClient">;
  /** Routing candidate order (BR-4 tie-break). Defaults to registry registration order. */
  readonly candidateOrder?: readonly ProviderId[];
  /** Clock for `get_capacity` (T6.3) and the routing window (T7.2); defaults to the system clock. */
  readonly now?: () => Date;
  /**
   * ADR-0079 (FR-CAP-13): the probe runner and cache `get_capacity` reads provider-reported usage with. Absent means
   * no provider is read and no entry carries `provider_usage`.
   */
  readonly providerUsage?: ProviderUsageReaderDeps;
  /**
   * T14.8 (FR-CTL-08, ADR-0047 2f): announces a `decide_approval` decision to the notification sinks when the
   * lifecycle's transition hook does not (see `src/control/approval-proxy.ts`). Absent means no sink is configured.
   */
  readonly announceApproval?: (a: ApprovalAnnouncement) => void;
  /**
   * T14.6 (FR-CTL-05): announces a `pause_project` / `resume_project` change to the notification sinks (`project_paused`,
   * off the tool's write path). Absent means no sink is configured.
   */
  readonly announcePause?: (a: PauseAnnouncement) => void;
  /**
   * T14.9 (FR-CTL-10, ADR-0048): announces a `create_project` / `update_project` revision that waits for the
   * operator's approval to the notification sinks (`approval_pending`, off the tool's write path). Absent means no
   * sink is configured.
   */
  readonly announcePendingRevision?: (a: PendingRevisionAnnouncement) => void;
  /**
   * T14.15 (FR-CTL-13, LLD §20.3): the decision service. Absent means `request_decision`, `list_decisions` and `decide`
   * do not exist for this server; `announce` tells the sinks a decision is waiting (`decision_requested`, no text).
   */
  readonly decisions?: { readonly announce?: (a: DecisionAnnouncement) => void };
  /**
   * ADR-0069 (LLD §3.4.12): the controller pusher, push-context resolver and `gh` pull-request port behind
   * `publish_run`. Absent means the tool does not exist for this server; present, it is offered only to a client whose
   * `max_push_policy` is `branch`.
   */
  readonly publish?: PublishDeps;
  /**
   * ADR-0070 (LLD §3.4.13): the T15.8 merge port and gate inputs behind `merge_run_pr`. Offered exactly when
   * `publish_run` is and this is present; absent, the tool does not exist for this server.
   */
  readonly mergeRun?: MergeRunDeps;
  /**
   * ADR-0074 (LLD §3.4.15): the ledger handle and fetch environment behind `refresh_project_base` and
   * `rebase_session`. Absent means the tools do not exist for this server; present, they are offered to a client whose
   * ceiling is above `inspect-untrusted`.
   */
  readonly base?: BaseToolDeps;
}

/** T16.9: what the skill tools read. Nothing here is written. */
export interface SkillToolDeps {
  readonly db: Database.Database;
  readonly dataDir: string;
  readonly settings: ResolvedSkills;
}

/** T14.6: what {@link McpServerDeps.announcePause} receives after the project row was written. */
export interface PauseAnnouncement {
  readonly projectId: string;
  readonly paused: boolean;
  readonly clientId: string;
}

export interface SwitchboardMcpServer {
  readonly server: Server;
  readonly clientId: string;
  readonly maxTrustProfile: TrustProfile;
  /** Handle one `tools/call` directly (used by the request handler; exposed for tests). */
  callTool(name: string, args: unknown): Promise<CallToolResult>;
  close(): Promise<void>;
}

type Args = Record<string, unknown>;

/** A project resolved for one request (BR-23): the definition, its primary context's canonical path and the ceiling. */
interface ProjectResolution {
  readonly project: ResolvedProject;
  readonly workspace: string;
  /** The lower of the client's and the project's maximum profile (FR-PRJ-06). */
  readonly effectiveMax: TrustProfile;
  readonly snapshot: ProjectSnapshot;
  /** T9.9: the in-force revision of a dynamic project; absent for a configured one. */
  readonly revision?: number;
}
type Routing = {
  provider_preference?: string;
  require_provider?: boolean;
  minimum_capability?: ModelCapability;
  model_group?: string;
  model?: string;
};

/** The lifecycle's V10 message (`findIdempotentRun`), reused so another subject's key is indistinguishable. */
const IDEMPOTENCY_CONFLICT = "idempotency key reused with different parameters";

const INSTRUCTIONS =
  "Switchboard delegates coding tasks to provider CLIs. delegate_task and continue_task are asynchronous: they return " +
  "a run_id at once; poll get_run (or pass wait_seconds, at most 60) until status is SUCCEEDED, FAILED or CANCELLED, " +
  "then read get_artifacts. Errors carry one failure code from the Switchboard taxonomy.";

export function createSwitchboardServer(deps: McpServerDeps): SwitchboardMcpServer {
  const client = deps.config.mcpClients.get(deps.clientId);
  if (!client) throw new Error(`unknown MCP client ${JSON.stringify(deps.clientId)}; add it to mcp_clients in config`);
  if (!deps.lifecycle.gatesEligibility) {
    // NFR-SEC-06: never accept MCP work with a lifecycle that skips the version/manifest/auth gate at dispatch.
    throw new Error("the run lifecycle must be constructed with eligibility dependencies before serving MCP");
  }
  if (deps.subject !== undefined && deps.subjectBindings === undefined) {
    // FR-MCP-15: an HTTP server that could not record or check its subject must not serve.
    throw new Error("an MCP server for an HTTP subject needs the subject bindings");
  }
  const maxTrustProfile = client.maxTrustProfile;
  const { lifecycle, ledger } = deps;
  const scrub = createScrubber(deps.config.allowedRoots);
  const validators = compileValidators();

  // T16.4 (FR-SKL-03, LLD §19.4, FRD V15, C8): request skill fields resolve only while the store is wired and enabled.
  const skillsOn = deps.skills?.settings.enabled === true;
  const skillFieldsOf = (a: Args, prefix = ""): SkillRequestFields => {
    const fields = skillRequestFields(a);
    if (hasSkillFields(fields) && !skillsOn) {
      const field = (["skills", "role", "skill_defaults"] as const).find((f) => a[f] !== undefined) as string;
      throw invalid("skills, role and skill_defaults need skills.enabled", {
        reason: "SKILLS_DISABLED",
        field: `${prefix}${field}`,
      });
    }
    return fields;
  };
  const skillAdmission = (fields: SkillRequestFields, project?: ResolvedProject): SkillAdmissionPort | undefined =>
    skillsOn && deps.skills !== undefined
      ? skillAdmissionPort({
          db: deps.skills.db,
          settings: deps.skills.settings,
          ...(project?.skills !== undefined ? { project: project.skills } : {}),
          ...(client.skills !== undefined ? { clientSkills: client.skills } : {}),
          fields,
        })
      : undefined;

  // T7.14: resolved model groups and model registry for routing validation.
  const modelGroups: ResolvedModelGroups = modelGroupsOf(deps.config);
  // biome-ignore lint/suspicious/noExplicitAny: lifecycle options hold eligibility deps
  const models: ModelRegistry | undefined = deps.models ?? (deps.lifecycle as any).opts?.eligibility?.models;

  // T9.9: dynamic projects. A client with manage_projects and no store would silently lose its tools: refuse instead.
  if (client.manageProjects === true && deps.projectStore === undefined) {
    throw new Error("a client with manage_projects needs the dynamic project store");
  }
  /** Project ids with a delegate_task/continue_task between resolution and admission (delete_project waits for them). */
  const admittingCount = new Map<string, number>();
  const projectTools: ProjectTools | undefined =
    deps.projectStore === undefined
      ? undefined
      : createProjectTools({
          store: deps.projectStore,
          clientId: deps.clientId,
          client,
          allowedRoots: deps.config.allowedRoots,
          ...(deps.config.dataDir !== undefined ? { dataDir: deps.config.dataDir } : {}),
          ...(deps.config.projectSources !== undefined ? { projectSources: deps.config.projectSources } : {}),
          ...(deps.projectGit !== undefined ? { git: deps.projectGit } : {}),
          configuredIds: () => new Set((deps.config.projects ?? []).map((p) => p.id)),
          disabledProviders: new Set(
            [...(deps.config.providers ?? new Map())].filter(([, v]) => !v.enabled).map(([id]) => id),
          ),
          admitting: (id) => admittingCount.get(id) ?? 0,
          // T12.1 (FR-RAG-03): the project's retrieval store goes with it (a no-op when none was ever built).
          ...(deps.config.dataDir !== undefined
            ? {
                onDeleted: (id: string) =>
                  void deleteRagStore(deps.config.dataDir as string, { kind: "project", projectId: id }),
              }
            : {}),
          // T14.9 (FR-CTL-10, ADR-0048): a revision waiting for the operator reaches the sinks as `approval_pending`.
          ...(deps.announcePendingRevision !== undefined ? { onPendingRevision: deps.announcePendingRevision } : {}),
        });
  // T14.8 (FR-CTL-08, ADR-0047): only for a client the operator marked approval_proxy; otherwise the tools do not exist.
  const approvalProxy =
    client.approvalProxy === true
      ? createApprovalProxy({
          ledger,
          clientId: deps.clientId,
          client,
          ...(deps.projectStore !== undefined ? { projectStore: deps.projectStore } : {}),
          applyDecision: (req) => lifecycle.applyApprovalDecision(req),
          ...(deps.announceApproval !== undefined ? { announce: deps.announceApproval } : {}),
        })
      : undefined;
  const approvalValidators =
    approvalProxy === undefined
      ? undefined
      : (Object.fromEntries(
          APPROVAL_PROXY_TOOL_NAMES.map((n) => [
            n,
            new Ajv2020({ allErrors: true, strict: true }).compile(APPROVAL_PROXY_INPUTS[n]),
          ]),
        ) as Record<ApprovalProxyToolName, ValidateFunction>);
  const whileAdmitting = async <T>(projectId: unknown, fn: () => Promise<T>): Promise<T> => {
    if (typeof projectId !== "string") return fn();
    admittingCount.set(projectId, (admittingCount.get(projectId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (admittingCount.get(projectId) ?? 1) - 1;
      if (n <= 0) admittingCount.delete(projectId);
      else admittingCount.set(projectId, n);
    }
  };

  // ---- helpers ------------------------------------------------------------------------------------------------

  const candidates = (): ProviderId[] => {
    const registered = new Set(deps.registry.list().map((a) => a.id));
    const order = deps.candidateOrder ?? [...registered];
    return order.filter((id) => registered.has(id));
  };

  /**
   * FR-QUE-01, FR-QUE-08 (LLD §20.8): an unbound meta-session the controller opened to admit this client's own work
   * item. Its first run carries the queue's idempotency key, and the item names that run as its admission; only the
   * controller writes `admitted_run_id`, so a caller cannot claim a meta-session by choosing an idempotency key.
   */
  const queuedForClient = (metaSessionId: string): boolean => {
    const first = ledger.listRunsForMetaSession(metaSessionId)[0];
    const key = first?.idempotency_key;
    if (first === undefined || first.client_id !== deps.clientId || !key?.startsWith(QUEUE_IDEMPOTENCY_PREFIX)) {
      return false;
    }
    const item = ledger.getWorkItem(key.slice(QUEUE_IDEMPOTENCY_PREFIX.length));
    return item !== undefined && item.creator_client_id === deps.clientId && item.admitted_run_id === first.id;
  };
  /**
   * T13.5 (Q-78): the meta-session's subject is this caller's (its OAuth client over HTTP, none over stdio). A
   * meta-session admitted from this client's queued work item has no subject and belongs to the item's owner, the
   * mapped client, over either transport (like the item itself).
   */
  const ownSubject = (metaSessionId: string): boolean => {
    if (deps.subjectBindings === undefined) return true;
    const bound = deps.subjectBindings.subjectOf(metaSessionId);
    return bound === deps.subject || (bound === undefined && queuedForClient(metaSessionId));
  };
  /** Bind a meta-session opened by this request to its HTTP subject (stdio records nothing). */
  const bindSubject = (metaSessionId: string): void => {
    if (deps.subject !== undefined) deps.subjectBindings?.bind(metaSessionId, deps.subject);
  };

  const ownRun = (runId: string): RunRecord => {
    const run = ledger.getRunRecord(runId);
    if (!run || run.client_id !== deps.clientId || !ownSubject(run.meta_session_id)) {
      throw invalid(`unknown run ${runId}`);
    }
    return run;
  };

  /** T14.2 (FR-CTL-03): needs-attention is recomputed on every read, at the server clock. */
  const attentionAt = () => ({ now: (deps.now ?? (() => new Date()))() });

  const envelopeOf = (runId: string, extra: Partial<Envelope> = {}): Envelope => ({
    ...buildEnvelope(ledger, ownRun(runId), scrub),
    ...extra,
  });

  /**
   * FRD V5 / V12 / C4 / BR-13 / BR-23: the profile may not exceed the client's ceiling, nor (in a project) the lower of
   * the two. `privileged` is therefore requestable only by a client whose ceiling is `privileged` and in a project that
   * does not lower it.
   */
  const checkCeiling = (profile: TrustProfile, project?: ProjectResolution): void => {
    if (project !== undefined && profileRank(profile) > profileRank(project.effectiveMax)) {
      const byProject = profileRank(profile) <= profileRank(maxTrustProfile);
      throw new ToolError(
        "PERMISSION_BLOCKED",
        byProject
          ? `trust profile ${profile} exceeds the maximum ${project.effectiveMax} of project ${project.snapshot.id}`
          : `trust profile ${profile} exceeds this client's maximum ${maxTrustProfile}`,
        {
          requested: profile,
          client_max_profile: maxTrustProfile,
          project: project.snapshot.id,
          effective_max_profile: project.effectiveMax,
        },
      );
    }
    if (profileRank(profile) > profileRank(maxTrustProfile)) {
      throw new ToolError(
        "PERMISSION_BLOCKED",
        `trust profile ${profile} exceeds this client's maximum ${maxTrustProfile}`,
        { requested: profile, client_max_profile: maxTrustProfile },
      );
    }
  };

  /**
   * FRD V12 / BR-23 / LLD §11.2 steps 1-3, 5: the project, if this client may use it, with its primary context's
   * canonical path. Nothing is written. `profile` decides whether the workspace must be a Git repository (V4); the base
   * ref is verified whatever the profile, since the project's contexts are repositories by definition.
   */
  const resolveProject = async (projectId: string, profile: TrustProfile): Promise<ProjectResolution> => {
    // T9.9: a dynamic project of this client (creator-only; in-force revision; limits and filesystem re-checked).
    const dynamic = await projectTools?.resolveForRequest(projectId);
    const project = dynamic?.project ?? (deps.config.projects ?? []).find((p) => p.id === projectId);
    if (!project) throw invalid(`unknown project ${JSON.stringify(projectId)}`, { field: "project" }); // V12
    if (dynamic === undefined && !(client.projects ?? []).includes(project.id)) {
      throw new ToolError("PERMISSION_BLOCKED", `project ${project.id} is not in this client's project list`, {
        project: project.id,
      });
    }
    const environment = snapshotEnvironment(project);
    // T10.1 (LLD §11.3): a container project needs the lifecycle's container environment for this project now
    // (wired by `serve`); without it the run is refused here, before any side effect, never run on the host.
    if (
      environment.environment_kind === "container" &&
      lifecycle.environmentPlacement({ id: project.id, ...environment })?.environment.kind !== "container"
    ) {
      throw new ToolError("TOOL_FAILURE", `project ${project.id}: ${CONTAINER_NOT_IMPLEMENTED}`, {
        project: project.id,
        reason: "ENVIRONMENT_NOT_IMPLEMENTED",
      });
    }
    const context = primaryContext(project);
    const workspace = await lifecycle.canonicalWorkspace(context.path, profile); // V3, V4 again: config may have changed
    try {
      await gitText(["rev-parse", "--verify", "--end-of-options", `${context.baseRef}^{commit}`], { cwd: workspace });
    } catch {
      throw invalid(`project ${project.id}: base ref ${JSON.stringify(context.baseRef)} does not resolve to a commit`, {
        field: "project",
      });
    }
    const effectiveMax = effectiveMaxProfile(maxTrustProfile, project);
    return {
      project,
      workspace,
      effectiveMax,
      ...(dynamic !== undefined ? { revision: dynamic.revision } : {}),
      snapshot: {
        id: project.id,
        name: project.name,
        ...environment,
        context_id: context.id,
        base_ref: context.baseRef,
        effective_max_profile: effectiveMax,
        ...(project.allowedProviders !== undefined ? { allowed_providers: [...project.allowedProviders] } : {}),
        // T9.4 / Q-41: Git facts frozen at admission (commit identity, push policy).
        writable: context.writable,
        ...(context.identity !== undefined ? { identity: { ...context.identity } } : {}),
        push: { policy: context.push.policy },
        // T9.7 (FR-GIT-09): the finalize-only opt-in, frozen like the identity; absent when off.
        ...(context.finalizeCommit ? { finalize_commit: true as const } : {}),
        // T9.10 (FR-GIT-10): the signing option, frozen the same way; absent when off.
        ...(context.sign ? { sign: true as const } : {}),
        // T5.14 (FR-SES-07): the brief's hash, read now; an unreadable brief refuses the run (fail closed).
        ...admitBrief(project, deps.config.allowedRoots),
        // ADR-0071: the setup step as of admission (the approved, in-force revision of a dynamic project).
        ...snapshotSetup(project),
      },
    };
  };

  /** LLD §11.2 step 4: the candidate set after the project's `allowed_providers`, or the full set outside a project. */
  const projectCandidates = (
    project: ProjectResolution | undefined,
    required: ProviderId | undefined,
  ): { candidates: ProviderId[]; excluded: ProviderId[] } => {
    const all = candidates();
    const allowed = project?.project.allowedProviders;
    if (allowed === undefined) return { candidates: all, excluded: [] };
    // Config ids (`claude-code`) differ from adapter ids (`claude`); a provider with no mapping (the test `fake`) is never allowed.
    // ADR-0076: either spelling is compared by canonical name; a name no entry knows is never allowed.
    const set = new Set<string>(allowed.flatMap((id) => canonicalProviderId(id) ?? []));
    if (required !== undefined && !set.has(required)) {
      throw new ToolError(
        "PERMISSION_BLOCKED",
        `provider ${required} is not allowed in project ${project?.snapshot.id}`,
        { project: project?.snapshot.id, allowed_providers: [...allowed] },
      );
    }
    const kept = all.filter((id) => set.has(id));
    if (kept.length === 0) {
      throw new ToolError("ELIGIBILITY_NONE", `no registered provider is allowed in project ${project?.snapshot.id}`, {
        reason: "PROJECT_PROVIDERS",
        project: project?.snapshot.id,
        allowed_providers: [...allowed],
      });
    }
    return { candidates: kept, excluded: all.filter((id) => !set.has(id)) };
  };

  /**
   * FRD V8 / V14 / FR-RTE-11 (LLD §17.7): provider names must be registered; require_provider needs a named provider;
   * model_group and model are mutually exclusive; model_group must be configured and keep at least one member when
   * narrowed by a provider; an explicit model without a provider must resolve in exactly one enabled provider's registry;
   * continue_task accepts neither (Q-99).
   */
  const checkRouting = (routing: Routing | undefined, isContinue = false): void => {
    if (!routing) return;
    if (isContinue) {
      if (routing.model_group !== undefined || routing.model !== undefined) {
        throw invalid("continue_task accepts neither routing.model_group nor routing.model (Q-99)", {
          field: "routing",
        });
      }
    }
    // ADR-0076: either spelling (`claude`, `claude-code`) names a provider; the request carries the canonical name from
    // here on (request hash, stored queue request, route decision and ledger), so outputs report it as before.
    const given = routing.provider_preference;
    if (given !== undefined) routing.provider_preference = canonicalProviderId(given) ?? given;
    const named = routing.provider_preference;
    if (named !== undefined && !deps.registry.has(named as ProviderId)) {
      const accepted = acceptedProviderNames(deps.registry.list().map((a) => a.id));
      throw invalid(`unknown provider ${given}; accepted names: ${accepted.join(", ")}`, {
        field: "routing.provider_preference",
        providers: accepted,
      });
    }
    if (routing.require_provider === true && named === undefined) {
      throw invalid("routing.require_provider needs routing.provider_preference", { field: "routing" });
    }
    if (routing.minimum_capability !== undefined && !["low", "medium", "high"].includes(routing.minimum_capability)) {
      throw invalid(`unknown minimum_capability ${routing.minimum_capability}`, {
        field: "routing.minimum_capability",
      });
    }

    // T7.14 (FR-RTE-11, LLD §17.7, FRD V14, BR-49)
    if (routing.model_group !== undefined && routing.model !== undefined) {
      throw invalid("give at most one of routing.model_group and routing.model", { field: "routing" });
    }
    if (routing.model_group !== undefined) {
      const group = modelGroups[routing.model_group];
      if (group === undefined) {
        throw invalid(`unknown model_group ${routing.model_group}`, { field: "routing.model_group" });
      }
      if (named !== undefined) {
        const remaining = groupMembersFor(group, named);
        if (remaining.length === 0) {
          throw invalid(`model_group ${routing.model_group} has no members for provider ${named}`, {
            field: "routing.model_group",
          });
        }
      }
    }
    if (routing.model !== undefined && named === undefined && routing.require_provider !== true) {
      if (resolvingProviders(routing.model).length !== 1) {
        throw invalid("name a provider for this model", { field: "routing.model" });
      }
    }
  };

  /** FRD V14: the enabled providers whose restricted registry resolves `model` (an alias or a configured or listed id). */
  const resolvingProviders = (model: string): string[] =>
    deps.registry
      .list()
      .map((a) => a.id)
      .filter((id) => deps.config.providers?.get(id)?.enabled !== false)
      .filter((p) => {
        if (!models?.restricted(p)) return false;
        const res = models.resolve(p, model);
        return res.ok && res.source !== "unrestricted";
      });

  /** FRD V11 / BR-2 / BR-3: map an exclusion to one taxonomy code with per-provider reasons. */
  const eligibilityError = ({ decision }: EligibilityAnswer): ToolError => {
    const reasons = decision.excluded.map((e) => ({
      provider: e.provider,
      code: e.primary.code,
      detail: e.primary.detail.slice(0, 300),
    }));
    const login = decision.excluded.flatMap((e) => e.reasons).find((r) => r.code === "AUTH_REQUIRED")
      ?.evidence.loginCommand;
    const outcome = decision.outcome;
    if (outcome.kind === "eligible") return new ToolError("TOOL_FAILURE", "eligibility mapping error");
    const message =
      outcome.kind === "required_provider_ineligible" && typeof login === "string"
        ? `${outcome.message}; run \`${login}\` natively`
        : outcome.message;
    return new ToolError(outcome.failureCode, message, {
      eligibility: reasons,
      ...(typeof login === "string" ? { login_command: login } : {}),
    });
  };

  /**
   * Providers a request may be admitted to. For `privileged` (Proposed, T3.3) a provider excluded only by the adapter's
   * compile verdict (PROFILE_UNSUPPORTED, CAPABILITY_MISSING) is admissible: compilation of the scope is deferred to
   * dispatch (T3.5, T3.6), which refuses it until then. Every other exclusion (binary, version, manifest, enablement,
   * platform, auth) still refuses admission.
   */
  const admissible = (answer: EligibilityAnswer, privileged: boolean): ProviderId[] => {
    if (!privileged) return [...answer.decision.eligible];
    const deferred = new Set(
      answer.decision.excluded
        .filter((e) => e.reasons.every((r) => r.code === "PROFILE_UNSUPPORTED" || r.code === "CAPABILITY_MISSING"))
        .map((e) => e.provider),
    );
    const ok = new Set([...answer.decision.eligible, ...deferred]);
    return answer.input.facts.map((f) => f.provider).filter((p) => ok.has(p));
  };

  /**
   * T7.2 (FR-RTE-02, FR-RTE-03, LLD §17.3, §17.4): stage 2 over the admissible providers and the self-contained route
   * decision record. `sessionProvider` is the meta-session's provider for a continuation (handoff term), null otherwise.
   * No admissible provider is the BR-3 error, as before.
   */
  const route = (
    given: EligibilityAnswer,
    opts: {
      preference: string | undefined;
      privileged: boolean;
      features: RouteFeatures;
      sessionProvider: string | null;
      basis?: (selected: string) => string;
      project?: { id: string; excluded: readonly ProviderId[]; revision?: number };
      /** T5.6 (LLD §15.7 step 7): how a continuation runs, with its BR-18 reason code; controller values only. */
      continuation?: { mode: "resume" | "handoff"; reason: string; from_provider: string; problem?: string };
      /** T7.5 (LLD §3.2, §17.6): the project and whether affinity applies (false for a continuation). */
      affinity: { projectId: string | null; workspace: string; applies: boolean; requiredProvider: string | null };
      /** T7.15 (LLD §17.7): a group or explicit-model request; candidates are its members. */
      group?: GroupEligibility & { name: string | null; requestedModel: string | null };
    },
  ): RouteDecisionResult & { provider: ProviderId } => {
    const group = opts.group;
    const answer = group !== undefined ? { input: group.input, decision: group.decision } : given;
    const eligible: string[] = group !== undefined ? group.admissible : admissible(answer, opts.privileged);
    const providers = [...new Set(eligible.map((c) => group?.members.find((m) => m.key === c)?.provider ?? c))];
    const suffix =
      opts.privileged && !answer.decision.eligible.length ? "; privileged compile deferred to dispatch" : "";
    const settings = {
      weights: deps.config.routing?.weights ?? DEFAULT_WEIGHTS,
      windowSeconds: deps.config.capacity?.windowSeconds ?? DEFAULT_CAPACITY_WINDOW_SECONDS,
      confidenceRuns: deps.config.capacity?.confidenceRuns ?? DEFAULT_CAPACITY_CONFIDENCE_RUNS,
      ...(deps.config.providers !== undefined ? { providers: deps.config.providers } : {}),
      ...(deps.config.limits !== undefined ? { limits: deps.config.limits } : {}),
    };
    const now = (deps.now ?? (() => new Date()))();
    const scoreInputs = collectScoreInputs(ledger, providers, settings, now, opts.sessionProvider);
    const affinity = collectAffinityFacts(
      ledger,
      { ...opts.affinity, admissible: eligible, decision: answer.decision, scoreInputs },
      deps.config.routing?.affinity ?? DEFAULT_AFFINITY,
    );
    // T7.15 (LLD §16.9, §17.7): the `pacing` term, only when a candidate's provider is in a configured subscription.
    const sub = deps.config.capacity;
    const pacing =
      sub?.subscriptions !== undefined && sub.pacing !== undefined
        ? collectPacingInputs(ledger, { subscriptions: sub.subscriptions, pacing: sub.pacing }, providers, now)
        : undefined;
    const result = buildRouteDecision({
      input: answer.input,
      decision: answer.decision,
      admissible: eligible,
      preference: opts.preference ?? null,
      features: opts.features,
      affinity,
      scoreInputs,
      weights: settings.weights,
      basisSuffix: suffix,
      ...(opts.basis !== undefined ? { basis: opts.basis } : {}),
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      ...(opts.continuation !== undefined ? { continuation: opts.continuation } : {}),
      ...(group !== undefined
        ? { group: { name: group.name, requestedModel: group.requestedModel, members: group.members } }
        : {}),
      ...(pacing !== undefined ? { pacing } : {}),
    });
    if (result.provider === null) throw eligibilityError(answer);
    return { ...result, provider: result.provider as ProviderId };
  };

  /**
   * T7.12 (FR-RTE-08, Q-90, LLD §17.6) and T7.8: on a held decision, pin the project's remembered model when the adapter declares
   * that a reported model id is accepted by its model flag and stage 1 (the model registry and the adapter's own
   * `compile`) still admits the provider with it; otherwise the run keeps the adapter default. With T7.8 minimum_capability,
   * admitted providers compile with the model that satisfied the capability check. The outcome is recorded
   * in the decision's `affinity.model_pin`. Never moves the provider (fail closed: a refused model is not a reason).
   */
  const pinModel = async (
    routed: RouteDecisionResult & { provider: ProviderId },
    question: Omit<EligibilityQuestion, "candidates" | "requiredProvider" | "model">,
    privileged: boolean,
    minimumCapability?: ModelCapability,
    satisfyingModel?: string,
  ): Promise<{ routed: RouteDecisionResult & { provider: ProviderId }; model: string | undefined }> => {
    const adapter = deps.registry.get(routed.provider);
    const plan = planModelPin(routed.affinity, adapter !== undefined && acceptsReportedModel(adapter), privileged);
    const keep = (pin: Parameters<typeof withModelPin>[1]) => ({
      routed: { ...withModelPin(routed, pin), provider: routed.provider },
      model: pin.model ?? undefined,
    });
    if (plan === null) {
      if (minimumCapability !== undefined && satisfyingModel !== undefined) {
        return { routed, model: satisfyingModel };
      }
      return { routed, model: undefined };
    }
    if (plan.candidate === null) {
      if (minimumCapability !== undefined && satisfyingModel !== undefined) {
        return {
          routed: {
            ...withModelPin(routed, { model: satisfyingModel, outcome: "pinned" }),
            provider: routed.provider,
          },
          model: satisfyingModel,
        };
      }
      return keep({ model: null, outcome: plan.outcome });
    }
    const check = await lifecycle.checkEligibility({
      ...question,
      candidates: [routed.provider],
      requiredProvider: routed.provider,
      model: plan.candidate,
      ...(minimumCapability !== undefined ? { minimumCapability } : {}),
    });
    if (!check.decision.eligible.includes(routed.provider)) {
      const code = check.decision.excluded[0]?.primary.code ?? "ELIGIBILITY_NONE";
      if (minimumCapability !== undefined && satisfyingModel !== undefined) {
        return {
          routed: {
            ...withModelPin(routed, { model: satisfyingModel, outcome: "pinned" }),
            provider: routed.provider,
          },
          model: satisfyingModel,
        };
      }
      return keep({ model: null, outcome: "model_refused", refused_code: code });
    }
    return keep({ model: plan.candidate, outcome: "pinned" });
  };

  /**
   * T7.15 (LLD §17.7 Candidates): for a group or explicit-model request, one stage-1 pass per member (its provider
   * required, its model requested: provider reasons, registry resolution, `minimum_capability`, compile with the model),
   * assembled into a member-level answer. Undefined for a request with neither field. No member left after the project
   * narrowing is `ELIGIBILITY_NONE`, as an empty project candidate set.
   */
  const groupCandidates = async (
    routing: Routing | undefined,
    candidates: readonly ProviderId[],
    required: ProviderId | undefined,
    privileged: boolean,
    question: Omit<EligibilityQuestion, "candidates" | "requiredProvider" | "model">,
  ): Promise<(GroupEligibility & { name: string | null; requestedModel: string | null }) | undefined> => {
    const named = requestedMembers(routing, modelGroups, candidates, (m) => {
      const r = resolvingProviders(m);
      return r.length === 1 ? r[0] : undefined;
    });
    if (named === undefined) return undefined;
    if (named.members.length === 0) {
      throw new ToolError("ELIGIBILITY_NONE", "no member of the requested group or model has an allowed provider", {
        reason: "GROUP_MEMBERS",
      });
    }
    const stage1 = await groupStage1(named.members, required ?? null, privileged, (provider, model) =>
      lifecycle.checkEligibility({
        ...question,
        candidates: [provider as ProviderId],
        requiredProvider: provider as ProviderId,
        model,
      }),
    );
    return { ...stage1, name: named.name, requestedModel: named.requestedModel };
  };

  const waitBounded = async (runId: string, seconds: number | undefined): Promise<void> => {
    if (!seconds) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      lifecycle.waitForTerminal(runId).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, seconds * 1000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  };

  // ---- tools --------------------------------------------------------------------------------------------------

  const delegateTask = async (a: Args): Promise<Envelope> => {
    const routing = a.routing as Routing | undefined;
    const profile = a.trust_profile as TrustProfile;
    // V12 / V3 / V4: exactly one of `project` and `workspace_path` (the schema's oneOf has already refused anything else).
    const resolved = a.project !== undefined ? await resolveProject(a.project as string, profile) : undefined;
    const workspace = resolved?.workspace ?? (await lifecycle.canonicalWorkspace(a.workspace_path as string, profile));
    checkCeiling(profile, resolved); // V5 / BR-23
    // V13 (after V5): privileged_scope present exactly when the profile is privileged.
    const scopeArg = a.privileged_scope;
    if (profile === "privileged" && scopeArg === undefined) {
      throw invalid("trust_profile privileged requires privileged_scope", { field: "privileged_scope" });
    }
    if (profile !== "privileged" && scopeArg !== undefined) {
      throw invalid(`privileged_scope is allowed only with trust_profile privileged (got ${profile})`, {
        field: "privileged_scope",
      });
    }
    const scope = scopeArg === undefined ? undefined : parsePrivilegedScope(scopeArg);
    if (scope && !scope.ok)
      throw invalid(`invalid privileged_scope: ${scope.field} ${scope.message}`, { field: scope.field });
    const verification = a.verification_commands as string[][];
    if (verification.length > 0 && profile === "inspect-untrusted") {
      // V7 (Proposed) and owner decision 11: host verification is refused only under inspect-untrusted.
      throw invalid("verification_commands are refused under inspect-untrusted (FRD V7)", {
        field: "verification_commands",
      });
    }
    const verificationProblem = verificationCommandsProblem(verification);
    if (verificationProblem !== undefined) throw invalid(verificationProblem, { field: "verification_commands" }); // V7
    checkRouting(routing); // V8
    const skillFields = skillFieldsOf(a); // V15 (SKILLS_DISABLED); the rest is resolved in the admission transaction

    const canonical = {
      tool: "delegate_task",
      objective: a.objective,
      workspace_path: workspace,
      ...(resolved ? { project: resolved.snapshot.id } : {}),
      constraints: a.constraints,
      trust_profile: profile,
      verification_commands: a.verification_commands,
      routing: routing ?? {},
      priority: a.priority,
      ...(scope?.ok ? { privileged_scope: scope.scope } : {}),
      ...skillFields, // T16.4: part of request_hash (FR-MCP-08)
      ...(a.light === true ? { light: true } : {}), // T3.24: absent unless given, so other hashes are unchanged
    };
    const hash = requestHash(canonical);
    const key = a.idempotency_key as string | undefined;
    if (key !== undefined) {
      // LLD §20.8: the queue's keys are the controller's, so a direct run never becomes a queued item's admission.
      if (key.startsWith(QUEUE_IDEMPOTENCY_PREFIX)) {
        throw invalid(`idempotency_key prefix ${QUEUE_IDEMPOTENCY_PREFIX} is reserved for queued work`, {
          field: "idempotency_key",
        });
      }
      const prior = lifecycle.findIdempotentRun(deps.clientId, key, hash); // V10
      // T13.5: another subject's key reads exactly like a key reused with different parameters.
      if (prior && !ownSubject(prior.meta_session_id)) throw invalid(IDEMPOTENCY_CONFLICT);
      if (prior) {
        await waitBounded(prior.id, a.wait_seconds as number);
        return envelopeOf(prior.id, { replayed: true });
      }
    }

    const required = routing?.require_provider === true ? (routing.provider_preference as ProviderId) : undefined;
    const privileged = scope?.ok === true;
    const minimumCapability = routing?.minimum_capability;
    const narrowed = projectCandidates(resolved, required); // BR-23: before eligibility, so nothing is probed for them
    const question = {
      trustProfile: profile,
      clientMaxProfile: resolved?.effectiveMax ?? maxTrustProfile,
      cwd: workspace,
      ...(scope?.ok ? { profile: privilegedEligibilityProfile(scope.scope) } : {}),
      ...(minimumCapability !== undefined ? { minimumCapability } : {}),
    };
    // T7.15 (LLD §17.7): with a group or an explicit model, each member is a stage-1 candidate.
    const group = await groupCandidates(routing, narrowed.candidates, required, privileged, question);
    const answer =
      group ??
      (await lifecycle.checkEligibility({
        candidates: narrowed.candidates,
        ...(required !== undefined ? { requiredProvider: required } : {}),
        ...question,
      })); // V11
    const admitted = group?.admissible ?? admissible(answer, privileged);
    if (answer.decision.outcome.kind !== "eligible" && admitted.length === 0) throw eligibilityError(answer);
    if (group === undefined && required !== undefined && !admitted.includes(required)) throw eligibilityError(answer);
    const routed0 = route(answer, {
      ...(group !== undefined ? { group } : {}),
      preference: routing?.provider_preference,
      privileged,
      features: await lifecycle.routeFeatures(
        {
          objective: a.objective as string,
          constraints: a.constraints as string[],
          verificationCommands: verification.length,
          writable: profile !== "inspect-untrusted",
        },
        { ...(resolved ? { project: resolved.snapshot } : {}) },
      ),
      sessionProvider: null,
      affinity: {
        projectId: resolved?.snapshot.id ?? null,
        workspace,
        applies: true,
        requiredProvider: required ?? null,
      },
      ...(resolved
        ? {
            project: {
              id: resolved.snapshot.id,
              excluded: narrowed.excluded,
              ...(resolved.revision !== undefined ? { revision: resolved.revision } : {}),
            },
          }
        : {}),
    });
    const capModel = answer.input.facts.find((f) => f.provider === routed0.provider)?.model;
    // T7.15 (LLD §17.7 Run fields): a chosen member runs with its resolved model; no remembered-model pin applies.
    const { routed, model } =
      routed0.member !== null
        ? { routed: routed0, model: routed0.member.model }
        : await pinModel(
            routed0,
            {
              trustProfile: profile,
              clientMaxProfile: resolved?.effectiveMax ?? maxTrustProfile,
              cwd: workspace,
              // The request's own scope, as stage 1: a re-check must never compile the bare name `privileged`.
              ...(scope?.ok ? { profile: privilegedEligibilityProfile(scope.scope) } : {}),
            },
            privileged,
            minimumCapability,
            capModel,
          );
    const provider = routed.provider;
    const skills = skillAdmission(skillFields, resolved?.project);

    const submitted = await lifecycle.submit({
      clientId: deps.clientId,
      objective: a.objective as string,
      workspace,
      trustProfile: profile,
      provider,
      constraints: a.constraints as string[],
      priority: a.priority as RunPriority,
      requestHash: hash,
      routeDecision: routed.record,
      ...(model !== undefined ? { model } : {}),
      ...(resolved ? { project: resolved.snapshot } : {}),
      ...(key !== undefined ? { idempotencyKey: key } : {}),
      ...(verification.length > 0 ? { verificationCommands: verification } : {}),
      ...(skills !== undefined ? { skills } : {}),
      // T3.24 (FR-CAP-12, LLD §20.2): `light` is honoured only for a client configured `allow_light: true`.
      ...(a.light === true && client.allowLight === true ? { light: true } : {}),
      ...(scope?.ok
        ? {
            privileged: {
              scope: scope.scope,
              // ADR-0019: the configured client policy, never anything in the request.
              ...(client.privilegedApproval === "not_required" ? { approvedByClientPolicy: true } : {}),
            },
          }
        : {}),
    });
    if (submitted.replayed) {
      // A concurrent request with the same key won the admission race: it must be this subject's.
      if (!ownSubject(submitted.metaSessionId)) throw invalid(IDEMPOTENCY_CONFLICT);
    } else {
      bindSubject(submitted.metaSessionId);
    }
    await waitBounded(submitted.runId, a.wait_seconds as number);
    return envelopeOf(submitted.runId, submitted.replayed ? { replayed: true } : {});
  };

  const continueTask = async (a: Args): Promise<Envelope> => {
    const sessionId = a.meta_session_id as string;
    const session = ledger.getMetaSession(sessionId);
    const ctx = session ? lifecycle.metaSessionContext(sessionId) : undefined;
    if (!session || !ctx || ctx.clientId !== deps.clientId || !ownSubject(sessionId)) {
      throw invalid(`unknown meta-session ${sessionId}`); // C2; T13.5 (Q-78) for the subject
    }
    if (session.status !== "ACTIVE") throw invalid(`meta-session ${sessionId} is closed`);
    if (ctx.activeRunId !== undefined) {
      throw invalid(`meta-session ${sessionId} has an active run ${ctx.activeRunId}`, { run_id: ctx.activeRunId });
    }
    const profile = (a.trust_profile as TrustProfile | undefined) ?? ctx.trustProfile; // C4
    // BR-23: the meta-session keeps its project; it is re-resolved under the same checks as a new request (FR-PRJ-09).
    const resolved = ctx.projectId !== undefined ? await resolveProject(ctx.projectId, profile) : undefined;
    const workspace = await lifecycle.canonicalWorkspace(ctx.workspace, profile); // C3
    checkCeiling(profile, resolved);
    // C7 (after C4): a privileged continuation runs only under the meta-session's APPROVED approval for this client,
    // with the approved scope as is. The lifecycle re-checks status, ownership and hash in the admission transaction.
    let approval: { id: string; scope: unknown } | undefined;
    if (profile === "privileged") {
      const row = ledger.findApprovalForMetaSession(sessionId, deps.clientId);
      if (row?.status !== "APPROVED") {
        throw invalid(
          `a privileged continuation needs an APPROVED approval for meta-session ${sessionId} (approval is ${
            row?.status ?? "absent"
          }); request a new privileged meta-session with delegate_task`,
          { field: "trust_profile" },
        );
      }
      approval = { id: row.id, scope: JSON.parse(row.scope_json) as unknown };
    }

    const routing = a.routing as Routing | undefined;
    checkRouting(routing, true); // C5 (as V8), Q-99
    const skillFields = skillFieldsOf(a); // C8: absent, the lifecycle reuses the previous run's set (LLD §19.5 step 1)
    const approvedScope = approval ? parsePrivilegedScope(approval.scope) : undefined;
    if (approvedScope && !approvedScope.ok) throw invalid(`meta-session ${sessionId} approval holds an invalid scope`);
    const privileged = approval !== undefined;
    const minimumCapability = routing?.minimum_capability;
    const ask = (candidates: readonly ProviderId[], requiredProvider?: ProviderId) =>
      lifecycle.checkEligibility({
        candidates,
        ...(requiredProvider !== undefined ? { requiredProvider } : {}),
        trustProfile: profile,
        clientMaxProfile: resolved?.effectiveMax ?? maxTrustProfile,
        cwd: workspace,
        ...(approvedScope?.ok ? { profile: privilegedEligibilityProfile(approvedScope.scope) } : {}),
        ...(minimumCapability !== undefined ? { minimumCapability } : {}),
      });

    // ---- BR-18 (LLD §15.7 steps 1 to 4): resume or handoff, and on which provider. Nothing is written here. ----
    const binding = ledger.latestProviderBinding(sessionId);
    const p0 = (binding?.provider ?? ctx.provider) as ProviderId; // step 1: the session provider
    const named = routing?.provider_preference as ProviderId | undefined;
    const required = routing?.require_provider === true ? named : undefined;

    // Step 2, first half: same provider or cross-provider? Only P0 is probed here, so the Q-61 check below runs before
    // any provider other than P0 is probed. `crossTo` is undefined when P0 is the target.
    let answerP0: EligibilityAnswer | undefined;
    let crossTo: string | undefined;
    if (named !== undefined && named !== p0) {
      crossTo = named; // another provider named: a handoff to it (routed normally with that preference, BR-4)
    } else {
      // `require_provider` naming P0 outside the project is PERMISSION_BLOCKED (as in delegate_task); without it, P0
      // outside the project is ineligible like any other reason (BR-23) and is not probed.
      if (required !== undefined) projectCandidates(resolved, p0);
      const allowedSet = resolved?.project.allowedProviders;
      const p0Allowed = allowedSet === undefined || allowedSet.some((id) => canonicalProviderId(id) === p0);
      answerP0 = p0Allowed ? await ask([p0], p0) : undefined;
      if (answerP0 === undefined || !admissible(answerP0, privileged).includes(p0)) {
        if (required !== undefined && answerP0 !== undefined) throw eligibilityError(answerP0); // BR-18 → BR-2 / BR-3
        crossTo = `a provider other than ${p0}`; // P0 ineligible: a handoff over the project's other providers
      }
    }

    // Step 3, Q-61 (ADR-0038 item 8): the ONE check of the policy constant, before anything else is probed or written.
    // Fail closed while Q-61 is open: a `privileged` continuation never runs on a provider other than P0. Same-provider
    // continuations, including a same-provider handoff, keep C7 as is. The lifecycle's handoff guard reads the same
    // constant (defence in depth).
    if (crossTo !== undefined && refusesPrivilegedCrossProvider(profile, p0, crossTo)) {
      throw invalid(
        `a privileged meta-session cannot continue on another provider (${p0} to ${crossTo}) while ROADMAP Q-61 is ` +
          "open; continue on the same provider or start a new privileged meta-session with delegate_task",
        {
          reason: PRIVILEGED_CROSS_PROVIDER_REASON,
          from_provider: p0,
          ...(named !== undefined && named !== p0 ? { to_provider: named } : {}),
        },
      );
    }

    // Step 2, second half, and step 4: the candidates and the mode. The target is chosen by stage 2 below (T7.2); for
    // the same provider the eligibility answer has P0 as its required provider, so it is P0.
    let answer: EligibilityAnswer;
    let preference: string | undefined;
    let sameProvider = false;
    let excluded: readonly ProviderId[] = [];
    let handoffReason: HandoffReason | undefined; // undefined: native resume
    let problem: string | undefined;
    if (crossTo === undefined && answerP0 !== undefined) {
      answer = answerP0;
      sameProvider = true;
      if (binding === undefined) {
        handoffReason = "no_binding"; // no run of this session reported a native session: nothing to resume
      } else {
        // T5.7 (LLD §15.6 step 3): a resume never runs outside its origin's directory; if that is unusable, the
        // continuation becomes a handoff on the same provider (ADR-0038 item 6.4), decided before any write.
        const dir = await lifecycle.resumeDirectoryPlan({
          metaSessionId: sessionId,
          provider: p0,
          nativeSessionId: binding.native_session_id,
          trustProfile: profile,
          workspace,
          resumeCwd: deps.registry.get(p0)?.resumeCwd,
        });
        if (dir.kind === "unavailable") {
          handoffReason = "resume_directory_unavailable";
          problem = dir.problem;
        }
      }
    } else if (named !== undefined && named !== p0) {
      // The named provider is the target, so one the project does not allow is PERMISSION_BLOCKED before anything is
      // probed (step 4, BR-23); eligibility then runs over the project's allowed providers (FR-PRJ-06).
      const narrowed = projectCandidates(resolved, named);
      answer = await ask(narrowed.candidates, required);
      if (required !== undefined && !admissible(answer, privileged).includes(required)) throw eligibilityError(answer);
      if (admissible(answer, privileged).length === 0) throw eligibilityError(answer);
      preference = named;
      excluded = narrowed.excluded;
      handoffReason = "provider_named";
    } else {
      // P0 ineligible and not required: route over the project's other allowed providers (BR-18, FR-PRJ-06).
      const narrowed = projectCandidates(resolved, undefined);
      const others = narrowed.candidates.filter((p) => p !== p0);
      if (others.length === 0) {
        throw answerP0 !== undefined
          ? eligibilityError(answerP0)
          : new ToolError("ELIGIBILITY_NONE", `no provider other than ${p0} is allowed for this meta-session`, {
              bound_provider: p0,
            });
      }
      answer = await ask(others);
      if (admissible(answer, privileged).length === 0) throw eligibilityError(answer);
      excluded = narrowed.excluded;
      handoffReason = "bound_provider_ineligible";
    }

    // Step 5 (handoff only): the bundle at `as_of`, put in the artifact store; no ledger row yet. Any failure is
    // HandoffBundleError (TOOL_FAILURE, HANDOFF_BUNDLE_UNAVAILABLE) and nothing is written (a stored file is a GC orphan).
    let handoff: HandoffSubmission | undefined;
    if (handoffReason !== undefined) {
      const store = deps.artifacts;
      const { built, stored } = await buildAndPutHandoffView(
        { ledger, artifacts: store, redact: (x: Buffer) => store.redactContent(x), store },
        { asOf: takeAsOf(ledger, sessionId), bounds: deps.config.continuity ?? DEFAULT_BUNDLE_BOUNDS },
      );
      handoff = { built, stored, fromProvider: p0, reason: handoffReason };
    }

    // Step 6: one admission transaction (run, view row, route_selected and handoff_built decisions, first event). A
    // handoff gets a fresh native session from the head checkpoint; the lifecycle re-checks that `as_of` is current.
    const mode = handoff ? "handoff" : "resume";
    const reasonCode = handoffReason ?? "same_provider_resume";
    const routed = route(answer, {
      preference,
      privileged,
      features: await lifecycle.routeFeatures(
        {
          objective: a.instruction as string,
          constraints: ctx.constraints,
          verificationCommands: 0,
          writable: profile !== "inspect-untrusted",
        },
        { metaSessionId: sessionId, ...(resolved ? { project: resolved.snapshot } : {}) },
      ),
      sessionProvider: p0,
      affinity: { projectId: ctx.projectId ?? null, workspace, applies: false, requiredProvider: required ?? null },
      basis: (selected) =>
        `${mode} ${reasonCode} from ${p0}; ${
          sameProvider ? `continuation${privileged ? "; privileged compile deferred to dispatch" : ""}` : selected
        }`,
      ...(resolved
        ? {
            project: {
              id: resolved.snapshot.id,
              excluded,
              ...(resolved.revision !== undefined ? { revision: resolved.revision } : {}),
            },
          }
        : {}),
      continuation: { mode, reason: reasonCode, from_provider: p0, ...(problem !== undefined ? { problem } : {}) },
    });
    const target = routed.provider;
    const skills = skillAdmission(skillFields, resolved?.project);
    const submitted = await lifecycle.submit({
      clientId: deps.clientId,
      objective: a.instruction as string,
      metaSessionId: sessionId,
      trustProfile: profile,
      provider: target,
      constraints: [...ctx.constraints],
      priority: ctx.priority,
      ...(handoff
        ? { handoff }
        : { resume: { nativeSessionId: (binding as { native_session_id: string }).native_session_id } }),
      routeDecision: routed.record,
      ...(approval ? { privileged: { approvalId: approval.id } } : {}),
      ...(resolved ? { project: resolved.snapshot } : {}),
      ...(skills !== undefined ? { skills } : {}),
    });
    await waitBounded(submitted.runId, a.wait_seconds as number);
    return envelopeOf(submitted.runId);
  };

  const getRun = async (a: Args): Promise<Envelope> => {
    const run = ownRun(a.run_id as string);
    const inc = a.include_events as { after_seq: number; limit: number } | undefined;
    // T16.4 (FR-SKL-07): the pinned skills' metadata, never their text; absent for a run without skills.
    const skills = deps.skills === undefined ? [] : runSkillMetadata(deps.skills.db, run.id);
    return {
      ...buildEnvelope(ledger, run, scrub, attentionAt()),
      ...(skills.length > 0 ? { skills } : {}),
      ...(inc ? { events: compactEvents(ledger, run.id, inc.after_seq, inc.limit, scrub) } : {}),
    };
  };

  /** T14.1 (LLD §3.4.2): a project filter must name a project this client may use (see the module comment). */
  const checkListProject = (projectId: string): void => {
    if ((projectTools?.listForClient() ?? []).some((e) => e.project.id === projectId)) return;
    const configured = (deps.config.projects ?? []).some((p) => p.id === projectId);
    if (!configured) throw invalid(`unknown project ${JSON.stringify(projectId)}`, { field: "project_id" });
    if (!(client.projects ?? []).includes(projectId)) {
      throw new ToolError("PERMISSION_BLOCKED", `project ${projectId} is not in this client's project list`, {
        project: projectId,
      });
    }
  };

  const listRuns = async (a: Args) => {
    if (a.project_id !== undefined) checkListProject(a.project_id as string);
    const since = a.since === undefined ? undefined : instant(a.since as string, "since");
    const until = a.until === undefined ? undefined : instant(a.until as string, "until");
    const states = a.status !== undefined ? [a.status as RunState] : (a.status_in as RunState[] | undefined)?.slice();
    const limit = a.limit as number;
    let before = a.cursor === undefined ? undefined : decodeRunCursor(a.cursor as string);
    // Over HTTP a meta-session of another subject is filtered after the query, so read in batches until a page is full.
    const page: RunRecord[] = [];
    for (;;) {
      const batch = ledger.listRunsForClient({
        clientId: deps.clientId,
        ...(a.project_id !== undefined ? { projectId: a.project_id as string } : {}),
        ...(states !== undefined ? { states } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(before !== undefined ? { before } : {}),
        limit: limit + 1,
      });
      for (const run of batch) if (page.length <= limit && ownSubject(run.meta_session_id)) page.push(run);
      const last = batch.at(-1);
      if (page.length > limit || last === undefined || batch.length <= limit) break;
      before = { createdAt: last.created_at, id: last.id };
    }
    const rows = page.slice(0, limit);
    const tail = rows.at(-1);
    const attention = attentionAt();
    return {
      runs: rows.map((run) => buildEnvelope(ledger, run, scrub, attention)),
      next_cursor: page.length > limit && tail !== undefined ? encodeRunCursor(tail) : null,
    };
  };

  /** T14.3 (FR-CTL-02, LLD §3.4.3): see `./digest.ts`; scoped exactly as `get_run` and `list_runs`. */
  const getDigest = async (a: Args) =>
    assembleDigest(
      ledger,
      {
        clientId: deps.clientId,
        visible: (run) => ownSubject(run.meta_session_id),
        projectIds: [
          ...projectsForClient(deps.config.projects ?? [], client).map((p) => p.id),
          ...(projectTools?.listForClient().map((e) => e.project.id) ?? []),
          // ADR-0068: an open onboarding decision is visible under the project it proposes.
          ...(decisionsOffered ? ownOnboardingIds() : []),
        ],
      },
      a.since_cursor as string | undefined,
      scrub,
      {
        ...attentionAt(),
        // T14.16 (FR-CTL-14): the configured project's `queue.stall_hours`; unset means no `stalled_progress`.
        stallHours: (id: string) => deps.config.projects?.find((p) => p.id === id)?.queue?.stallHours,
        openDecisions: openDecisionsOf,
      },
    );

  /** T14.15 (FR-CTL-13): this client's open decisions in a project, ids and times only (no decision text). */
  function openDecisionsOf(projectId: string): OpenDecisionItem[] {
    const open = ledger.listDecisions({ requesterClientIds: [deps.clientId], projectId, states: ["open"], limit: 50 });
    return open.map((d) => ({
      decision_id: d.id,
      work_item_id: d.work_item_id,
      reason: "awaiting_decision",
      requested_at: d.created_at,
    }));
  }

  /** T14.6 (FR-CTL-05, LLD §3.4.4): see the module comment; the row is written as `mcp:<client_id>`. */
  const setProjectPaused = async (a: Args, paused: boolean) => {
    const projectId = a.project_id as string;
    checkListProject(projectId);
    const row = ledger.setPaused({ projectId, paused, by: `mcp:${deps.clientId}` });
    deps.announcePause?.({ projectId, paused, clientId: deps.clientId });
    return { project_id: projectId, paused: row.paused === 1 };
  };
  const pauseProject = async (a: Args) => setProjectPaused(a, true);
  const resumeProject = async (a: Args) => setProjectPaused(a, false);

  // ---- T15.1 project work queue (FR-QUE-01, LLD §18.4): see the module comment ------------------------------------

  /** T15.9 (FR-QUE-08, LLD §20.8): offered over HTTP to an orchestrator client (the mapped client's ceiling
   *  applies, as for `delegate_task`); a console client never sees the tools, over either transport. */
  const workQueueOffered = client.toolProfile !== "console";
  const workValidators = compileWorkValidators();

  const ownWorkItem = (id: string): WorkItemRow => {
    const item = ledger.getWorkItem(id);
    if (item === undefined || item.creator_client_id !== deps.clientId) {
      throw invalid(`unknown work item ${id}`, { field: "work_item_id" });
    }
    return item;
  };

  const workView = (item: WorkItemRow, extra: { replayed?: true } = {}) => {
    let profile: unknown;
    try {
      profile = (JSON.parse(item.request_json) as { trust_profile?: unknown }).trust_profile;
    } catch {
      profile = undefined;
    }
    return {
      work_item_id: item.id,
      project_id: item.project_id,
      state: item.state,
      priority: item.priority,
      trust_profile: typeof profile === "string" ? profile : null,
      source_kind: item.source_kind,
      depends_on: ledger.listWorkItemPredecessors(item.id),
      admitted_run_id: item.admitted_run_id,
      last_error_code: item.last_error_code,
      created_at: item.created_at,
      updated_at: item.updated_at,
      terminal_at: item.terminal_at,
      dedupe_key: item.dedupe_key,
      hot_paths: storedHotPaths(item.hot_paths_json),
      superseded_by: item.superseded_by,
      ...extra,
    };
  };

  /** The lower of this client's and the project's maximum profile, for a project `checkListProject` accepted. */
  const listProjectCeiling = (projectId: string): TrustProfile => {
    const project =
      projectTools?.listForClient().find((e) => e.project.id === projectId)?.project ??
      (deps.config.projects ?? []).find((p) => p.id === projectId);
    return project === undefined ? maxTrustProfile : effectiveMaxProfile(maxTrustProfile, project);
  };

  /**
   * The `enqueue_work` request checks that need no workspace (V5 against the lower of the client's and the project's
   * maximum now, V13, V7, V8, V15); `prefix` names the request in `details.field`. Also run on each entry of a
   * decision's enqueue list (T14.15), so a decision can never queue what this client could not queue itself.
   */
  const checkQueuedRequest = (projectId: string, request: Args, prefix = "request."): void => {
    const profile = request.trust_profile as TrustProfile;
    const effectiveMax = listProjectCeiling(projectId);
    if (profileRank(profile) > profileRank(effectiveMax)) {
      // V5 / BR-23 at enqueue; admission checks the ceiling again under the configuration of that time (LLD §18.4).
      throw new ToolError(
        "PERMISSION_BLOCKED",
        `trust profile ${profile} exceeds the maximum ${effectiveMax} this client has in project ${projectId}`,
        {
          requested: profile,
          client_max_profile: maxTrustProfile,
          project: projectId,
          effective_max_profile: effectiveMax,
        },
      );
    }
    const scopeArg = request.privileged_scope;
    if (profile === "privileged" && scopeArg === undefined) {
      throw invalid("trust_profile privileged requires privileged_scope", { field: `${prefix}privileged_scope` });
    }
    if (profile !== "privileged" && scopeArg !== undefined) {
      throw invalid(`privileged_scope is allowed only with trust_profile privileged (got ${profile})`, {
        field: `${prefix}privileged_scope`,
      });
    }
    if (scopeArg !== undefined) {
      const lists = checkScopeLists(scopeArg as never);
      if (lists) throw invalid(`invalid arguments: ${lists.field} ${lists.message}`, { field: lists.field });
      const scope = parsePrivilegedScope(scopeArg);
      if (!scope.ok) throw invalid(`invalid privileged_scope: ${scope.field} ${scope.message}`, { field: scope.field });
    }
    const verification = request.verification_commands as string[][];
    if (verification.length > 0 && profile === "inspect-untrusted") {
      throw invalid("verification_commands are refused under inspect-untrusted (FRD V7)", {
        field: `${prefix}verification_commands`,
      });
    }
    const verificationProblem = verificationCommandsProblem(verification);
    if (verificationProblem !== undefined) {
      throw invalid(verificationProblem, { field: `${prefix}verification_commands` });
    }
    checkRouting(request.routing as Routing | undefined);
    skillFieldsOf(request, prefix); // V15 at enqueue; the fields are stored and resolve at the item's admission
  };

  const enqueueWork = async (a: Args) => {
    const projectId = a.project_id as string;
    checkListProject(projectId);
    const request = a.request as Args;
    checkQueuedRequest(projectId, request);

    const predecessors = [...((a.depends_on as string[] | undefined) ?? [])].sort();
    for (const id of predecessors) ownWorkItem(id);
    const frozen = { ...request, project: projectId }; // LLD §18.2 request_json
    const priority = a.priority as number;
    const key = a.idempotency_key === undefined ? undefined : `mcp:${a.idempotency_key as string}`;
    const dedupeKey = (a.dedupe_key as string | undefined) ?? null;
    const hotPaths = (a.hot_paths as string[] | undefined) ?? null;
    if (hotPaths !== null) {
      const problem = hotPathsProblem(hotPaths);
      if (problem !== undefined) throw invalid(problem, { field: "hot_paths" });
    }
    const fingerprint = (
      p: string,
      req: unknown,
      prio: number,
      preds: string[],
      dedupe: string | null,
      hot: readonly string[],
    ) =>
      requestHash({
        project_id: p,
        request: req,
        priority: prio,
        depends_on: preds,
        ...(dedupe !== null ? { dedupe_key: dedupe } : {}),
        ...(hot.length > 0 ? { hot_paths: hot } : {}),
      });
    const limit = deps.config.queue?.maxItemsPerProject ?? DEFAULT_QUEUE_MAX_ITEMS_PER_PROJECT;
    return ledger.immediate(() => {
      if (key !== undefined) {
        const prior = ledger.findWorkItemByIdempotency(deps.clientId, key);
        if (prior !== undefined) {
          const same =
            fingerprint(
              prior.project_id,
              JSON.parse(prior.request_json),
              prior.priority,
              ledger.listWorkItemPredecessors(prior.id),
              prior.dedupe_key,
              storedHotPaths(prior.hot_paths_json),
            ) === fingerprint(projectId, frozen, priority, predecessors, dedupeKey, hotPaths ?? []);
          if (!same) throw invalid(IDEMPOTENCY_CONFLICT);
          return workView(prior, { replayed: true });
        }
      }
      if (ledger.countWorkItemsForProject(projectId) >= limit) {
        throw invalid(`the work queue of project ${projectId} holds its maximum of ${limit} items`, {
          field: "project_id",
          max_items_per_project: limit,
        });
      }
      let item: WorkItemRow;
      try {
        item = ledger.enqueueWorkItem({
          projectId,
          creatorClientId: deps.clientId,
          request: frozen,
          sourceKind: "mcp",
          idempotencyKey: key ?? null,
          priority,
          predecessorIds: predecessors,
          dedupeKey,
          hotPaths,
        });
      } catch (err) {
        // T15.7 (LLD §20.4): no taxonomy code names a held key, so CONFLICT is the reason (as QUEUE_FULL, errors.ts).
        // The holder's id is not returned: it may belong to another client of the project.
        if (err instanceof WorkItemDedupeConflictError) {
          throw invalid(err.message, { field: "dedupe_key", reason: "CONFLICT" });
        }
        throw err;
      }
      return workView(item);
    });
  };

  const listWork = async (a: Args) => {
    if (a.project_id !== undefined) checkListProject(a.project_id as string);
    const items = ledger.listWorkItems({
      clientId: deps.clientId,
      ...(a.project_id !== undefined ? { projectId: a.project_id as string } : {}),
      ...(a.state_in !== undefined ? { states: a.state_in as WorkItemState[] } : {}),
      limit: a.limit as number,
    });
    return { items: items.map((item) => workView(item)) };
  };

  const cancelWork = async (a: Args) => {
    const item = ownWorkItem(a.work_item_id as string);
    if (item.state !== "PENDING" && item.state !== "READY") return workView(item);
    return workView(ledger.cancelWorkItem(item.id, deps.clientId) ?? ownWorkItem(item.id));
  };

  const workHandlers: Record<WorkQueueToolName, (a: Args) => Promise<object>> = {
    enqueue_work: enqueueWork,
    list_work: listWork,
    cancel_work: cancelWork,
  };

  // ---- T14.15 decision requests (FR-CTL-13, LLD §20.3): see `./decision-tools.ts` ---------------------------------

  /** Orchestrator tools, once `serve` wires the decision service; `decide` additionally needs `approval_proxy`. */
  const decisionsOffered = deps.decisions !== undefined && client.toolProfile !== "console";
  const decideOffered = decisionsOffered && client.approvalProxy === true;
  const decisionValidators = compileDecisionValidators();
  const decisionToolError = (err: unknown): unknown => {
    if (!(err instanceof DecisionError)) return err;
    return invalid(err.message, {
      ...(err.reason === "CONFLICT" ? { reason: "CONFLICT" } : {}),
      ...(err.field !== undefined ? { field: err.field } : {}),
    });
  };

  /**
   * ADR-0068: the project an onboarding decision proposes. `project_id` must not be a configured id or another
   * client's dynamic project (one message for both, as for `create_project`), nor a deleted or usable project of this
   * client; it may be unknown or this client's own project waiting for approval or rejected. The URL is parsed by the
   * clone rules and, when `project_sources` is configured, must be allowed there. Returns the normalised URL.
   */
  const checkOnboarding = (projectId: string, a: Args): string => {
    if (a.work_item_id !== undefined || a.enqueue !== undefined) {
      throw invalid("onboarding cannot be combined with work_item_id or enqueue (the project does not exist yet)", {
        field: a.work_item_id !== undefined ? "work_item_id" : "enqueue",
      });
    }
    const taken = () =>
      new ToolError("PERMISSION_BLOCKED", `project ${projectId} cannot be proposed by this client`, {
        project: projectId,
        reason: "NOT_MANAGEABLE",
      });
    if ((deps.config.projects ?? []).some((p) => p.id === projectId)) throw taken();
    const st = deps.projectStore?.state(projectId);
    if (st !== undefined) {
      if (st.clientId !== deps.clientId) throw taken();
      if (st.deleted) {
        throw invalid(`project ${projectId} was deleted; project ids are not reused`, {
          field: "project_id",
          reason: "ID_DELETED",
        });
      }
      if (st.inForce !== undefined) {
        throw invalid(`project ${projectId} already has an approved revision; ask without onboarding`, {
          field: "project_id",
          reason: "PROJECT_EXISTS",
        });
      }
    }
    const onboarding = a.onboarding as { repository_url: string };
    const src = parseRepositoryUrl(onboarding.repository_url);
    if (src === undefined) {
      throw invalid(
        "onboarding.repository_url must be https://<host>/<owner>/<repo> (optional .git), without " +
          "credentials, port, query or fragment",
        { field: "onboarding.repository_url", reason: "CLONE_URL_INVALID" },
      );
    }
    const sources = deps.config.projectSources;
    if (sources !== undefined && !sourceAllowed(src, sources)) {
      throw new ToolError(
        "PERMISSION_BLOCKED",
        "the repository host or owner is not in this server's project_sources",
        { field: "onboarding.repository_url", reason: "CLONE_SOURCE_NOT_ALLOWED" },
      );
    }
    return normalizedUrl(src);
  };

  const requestDecisionTool = async (a: Args) => {
    const projectId = a.project_id as string;
    const onboardingUrl = a.onboarding !== undefined ? checkOnboarding(projectId, a) : undefined;
    if (onboardingUrl === undefined) checkListProject(projectId);
    const enqueue = (a.enqueue as { request: Args; priority: number }[] | undefined) ?? [];
    enqueue.forEach((e, i) => {
      checkQueuedRequest(projectId, e.request, `enqueue[${i}].request.`);
    });
    const limit = deps.config.queue?.maxItemsPerProject ?? DEFAULT_QUEUE_MAX_ITEMS_PER_PROJECT;
    if (enqueue.length > 0 && ledger.countWorkItemsForProject(projectId) + enqueue.length > limit) {
      throw invalid(`the work queue of project ${projectId} cannot take ${enqueue.length} more items`, {
        field: "enqueue",
        max_items_per_project: limit,
      });
    }
    if (a.work_item_id !== undefined) ownWorkItem(a.work_item_id as string);
    try {
      const row = requestDecision(
        ledger,
        {
          projectId,
          ...(a.work_item_id !== undefined ? { workItemId: a.work_item_id as string } : {}),
          requesterClientId: deps.clientId,
          question: a.question as string,
          options: a.options as DecisionOption[],
          recommendedOption: a.recommended_option as number,
          enqueue,
          ...(onboardingUrl !== undefined ? { onboardingUrl } : {}),
        },
        deps.decisions?.announce,
      );
      return decisionView(row);
    } catch (err) {
      throw decisionToolError(err);
    }
  };

  /**
   * ADR-0068: project ids of this client's open onboarding decisions (the projects may not exist yet), for the digest.
   * Bounded like `openDecisionsOf` (Delegated: the 200 oldest open decisions).
   */
  const ownOnboardingIds = (): Set<string> =>
    new Set(
      ledger
        .listDecisions({ requesterClientIds: [deps.clientId], states: ["open"], limit: 200 })
        .filter((d) => d.onboarding_url !== null)
        .map((d) => d.project_id),
    );

  const listDecisionsTool = async (a: Args) => {
    // ADR-0068: a project id this client asked a decision about (an onboarding proposal) is a valid filter too; the
    // rows are this client's own either way.
    const ownDecision = (id: string) =>
      ledger.listDecisions({ requesterClientIds: [deps.clientId], projectId: id, limit: 1 }).length > 0;
    if (a.project_id !== undefined && !ownDecision(a.project_id as string)) checkListProject(a.project_id as string);
    const rows = ledger.listDecisions({
      requesterClientIds: [deps.clientId],
      ...(a.project_id !== undefined ? { projectId: a.project_id as string } : {}),
      ...(a.state_in !== undefined ? { states: a.state_in as DecisionState[] } : {}),
      limit: a.limit as number,
    });
    return { decisions: rows.map(decisionTextView) };
  };

  const decideTool = async (a: Args) => {
    try {
      const r = resolveDecision(ledger, {
        decisionId: a.decision_id as string,
        option: a.option as number,
        ...(a.note !== undefined ? { note: a.note as string } : {}),
        decidedBy: `${MCP_PROXY_DECIDER_PREFIX}${deps.clientId}`,
        // FR-CTL-08: only the decisions of the clients the operator listed for this proxy (default: itself).
        requesters: proxyTargets(deps.clientId, client),
      });
      return {
        ...decisionView(r.decision),
        action: r.action,
        work_item_state: r.workItem?.state ?? null,
        enqueued_work_item_ids: r.enqueued.map((w) => w.id),
      };
    } catch (err) {
      throw decisionToolError(err);
    }
  };

  const decisionHandlers: Record<AnyDecisionToolName, (a: Args) => Promise<object>> = {
    request_decision: requestDecisionTool,
    list_decisions: listDecisionsTool,
    decide: decideTool,
  };

  const cancelRun = async (a: Args): Promise<Envelope> => {
    const run = ownRun(a.run_id as string);
    await lifecycle.cancel(run.id, (a.reason as string | undefined) ?? "cancel_run");
    return envelopeOf(run.id);
  };

  /** T14.7 (FR-CTL-04, LLD §3.4.4): see `../lifecycle/steer.ts`; scoped exactly as `get_run`. */
  const steerRun = async (a: Args): Promise<Envelope> => {
    const run = ownRun(a.run_id as string);
    lifecycle.steer(run.id, a.note as string);
    return envelopeOf(run.id);
  };

  const getArtifacts = async (a: Args) => {
    const run = ownRun(a.run_id as string);
    const kinds = new Set<string>((a.kinds as string[] | undefined) ?? MCP_ARTIFACT_KINDS);
    const maxInline = a.max_inline_bytes as number;
    const out = [];
    for (const art of ledger.listArtifactsForRun(run.id)) {
      if (!kinds.has(art.kind)) continue;
      let inline: string | undefined;
      if (art.size_bytes <= maxInline) {
        try {
          inline = (await deps.artifacts.get(art.sha256)).toString("utf8");
        } catch {
          inline = undefined; // missing or failed integrity: report metadata only (fail closed)
        }
      }
      out.push({
        artifact_id: art.id,
        kind: art.kind,
        sha256: art.sha256,
        size_bytes: art.size_bytes,
        ...(inline !== undefined ? { inline_text: inline } : {}),
      });
    }
    return { run_id: run.id, artifacts: out };
  };

  const listCapabilities = async () => {
    const cwd = deps.config.allowedRoots[0] ?? process.cwd();
    const providers = [];
    for (const id of candidates()) {
      const answer = await lifecycle.checkEligibility({
        candidates: [id],
        requiredProvider: id,
        trustProfile: "inspect-untrusted",
        clientMaxProfile: "inspect-untrusted",
        cwd,
      });
      providers.push(describeProvider(answer, id, cwd));
    }
    return {
      schema_version: TOOL_SCHEMA_VERSION,
      schema_dialect: SCHEMA_DIALECT,
      client_max_profile: maxTrustProfile,
      providers,
    };
  };

  /**
   * LLD §16.3 `get_capacity` (T6.3; FR-MCP-02, FR-CAP-02, FR-CAP-03): the one capacity projection, for every registered
   * provider in candidate order or for the one named. Read-only. ADR-0079 (FR-CAP-13): with `providerUsage`, each
   * enabled provider whose adapter has a usage reader is asked through its own CLI (no model call, cached a minute)
   * and its entry carries `provider_usage`; nothing else is probed.
   */
  const getCapacity = async (args: Args) => {
    const registered = deps.registry.list().map((a) => a.id);
    const cand = candidates();
    const ids: string[] = [...cand, ...registered.filter((id) => !cand.includes(id))];
    // ADR-0076: either spelling; the answer names the canonical provider.
    const given = args.provider as string | undefined;
    const named = given === undefined ? undefined : (canonicalProviderId(given) ?? given);
    if (named !== undefined && !ids.includes(named)) {
      const accepted = acceptedProviderNames(ids);
      throw invalid(`unknown provider ${JSON.stringify(given)}; accepted names: ${accepted.join(", ")}`, {
        providers: ids,
        accepted_names: accepted,
      });
    }
    // T6.14: pass the capacity object through. Rebuilding a two-field settings object here would drop subscriptions,
    // and get_capacity would disagree with `capacity --json`.
    const settings = deps.config.capacity ?? {
      windowSeconds: DEFAULT_CAPACITY_WINDOW_SECONDS,
      confidenceRuns: DEFAULT_CAPACITY_CONFIDENCE_RUNS,
    };
    const providers = capacityProviders(named === undefined ? ids : [named], {
      ...(deps.config.providers !== undefined ? { providers: deps.config.providers } : {}),
      ...(deps.config.limits !== undefined ? { limits: deps.config.limits } : {}),
    });
    // T6.7: the affinity block shows this client's own runs only.
    const now = (deps.now ?? (() => new Date()))();
    const projection = capacityProjection(ledger, providers, settings, now, deps.clientId);
    if (deps.providerUsage === undefined) return projection;
    const targets = usageReadTargets(
      deps.registry.list().filter((a) => providers.some((p) => p.id === a.id)),
      projection,
    );
    return withProviderUsage(projection, await readProviderUsage(targets, deps.providerUsage, now));
  };

  /**
   * T7.3 (FR-MCP-02, LLD §17.5): the run's stored route decision, explained. The caller must own the run (as `get_run`);
   * nothing is probed, scored again or asked of a model.
   */
  const explainRouteTool = async (a: Args) => {
    const run = ownRun(a.run_id as string);
    return explainRoute(run.id, ledger.getRouteDecision(run.id), scrub);
  };

  /** LLD §3 `list_projects`: the projects this client may use, without paths, remotes, identities or image data. */
  const listProjects = async () => ({
    projects: [
      ...projectsForClient(deps.config.projects ?? [], client).map((p) => ({
        id: p.id,
        name: p.name,
        environment_kind: p.environment.kind,
        contexts: p.contexts.map((c) => ({ id: c.id, kind: c.kind, primary: c.primary, push_policy: c.push.policy })),
        ...(p.maxTrustProfile !== undefined ? { max_trust_profile: p.maxTrustProfile } : {}),
        effective_max_profile: effectiveMaxProfile(maxTrustProfile, p),
        ...(p.allowedProviders !== undefined ? { allowed_providers: [...p.allowedProviders] } : {}),
        ...mergePolicyItem(p),
        ...setupItem(p),
      })),
      // T9.9: this client's dynamic projects (creator-only), marked `source: "dynamic"`.
      ...(projectTools?.listForClient().map((e) => dynamicListItem(e, maxTrustProfile)) ?? []),
    ],
  });

  const describeProvider = (answer: EligibilityAnswer, id: ProviderId, cwd: string) => {
    const facts = answer.input.facts.find((f) => f.provider === id);
    const adapter = deps.registry.get(id);
    // FRD §6 precedence; compile and profile-platform reasons are per-profile and are reported through
    // supported_profiles instead.
    const status = answer.decision.excluded[0]?.reasons.find((r) => !PER_PROFILE_REASONS.has(r.code));
    const adapterStatus =
      status === undefined
        ? "READY"
        : status.code === "NO_MANIFEST" || status.code === "ADAPTER_VERSION_UNVERIFIED"
          ? status.code
          : status.code === "AUTH_REQUIRED" || status.code === "AUTH_UNKNOWN"
            ? "AUTH_REQUIRED"
            : "DISABLED";
    const probed = facts?.probe?.steps.every((s) => s.ok) === true;
    // T3.7: supported_profiles is the provider's compile matrix on this host: the host-platform rule, then the
    // adapter's own compile of each resolved profile (overrides included), exactly as the eligibility filter asks it.
    const supported: TrustProfile[] = [];
    if (adapter && probed) {
      for (const p of TRUST_PROFILE_ORDER) {
        if (!profilePlatformSupported(p, answer.input.platform)) continue;
        let profiles: ResolvedProfile[];
        try {
          profiles =
            p === "privileged"
              ? REPRESENTATIVE_PRIVILEGED_SCOPES.map((sc) => privilegedEligibilityProfile(sc))
              : [lifecycle.resolveProfile(p)];
        } catch {
          continue; // COMP-POL does not resolve this profile: unsupported, fail closed
        }
        const compiles = (profile: ResolvedProfile) =>
          !("ineligible" in compileCheck(adapter, profile, requirementsFor(p, profile), cwd));
        if (profiles.some(compiles)) supported.push(p);
      }
    }
    return {
      provider: id,
      adapter_status: adapterStatus,
      ...(status !== undefined ? { status_detail: scrub(`${status.code}: ${status.detail}`).slice(0, 300) } : {}),
      binary_version: facts?.probe?.binaryVersion ?? null,
      validated_range: facts?.gate?.evidence.validatedRange ?? null,
      auth_state: facts?.auth?.state ?? "NOT_CHECKED",
      supported_profiles: supported,
      transports: [...(adapter?.transports ?? [])],
      models: [],
      sandbox_features: [],
      ...(adapter
        ? {
            git_write_control: {
              kind: adapter.gitWriteControl.kind,
              detail: adapter.gitWriteControl.detail,
              remaining_controls: [...adapter.gitWriteControl.remainingControls],
            },
          }
        : {}),
    };
  };

  /**
   * T12.6 (FR-RAG-06, LLD §14.7): the projects this client may search: its configured `projects` and its own dynamic
   * projects with a revision in force.
   */
  const searchableProjects = (): ResolvedProject[] => [
    ...projectsForClient(deps.config.projects ?? [], client),
    ...(projectTools?.listForClient().flatMap((e) => (e.status === "ACTIVE" ? [e.project] : [])) ?? []),
  ];
  const searchOffered = (): boolean => {
    const sc = deps.searchContext;
    return sc !== undefined && searchableProjects().some((p) => searchEnabledFor(sc.settings, p));
  };
  const searchValidator = new Ajv2020({ allErrors: true, strict: true, useDefaults: true }).compile(
    inputSchema("search_project_context"),
  );
  /**
   * A project this client may not use is reported exactly like an unknown one (LLD §14.7), so the tool is no existence
   * oracle (T16.9: `list_skills` takes its `project` the same way): another client's dynamic project, a configured project missing from `projects`, a deleted or pending one.
   */
  const searchTarget = async (projectId: string): Promise<ResolvedProject> => {
    const unknown = () => invalid(`unknown project ${JSON.stringify(projectId)}`, { field: "project" });
    const configured = (deps.config.projects ?? []).find((p) => p.id === projectId);
    if (configured !== undefined) {
      if (!(client.projects ?? []).includes(configured.id)) throw unknown();
      return configured;
    }
    let dynamic: Awaited<ReturnType<ProjectTools["resolveForRequest"]>>;
    try {
      dynamic = await projectTools?.resolveForRequest(projectId);
    } catch {
      throw unknown();
    }
    if (dynamic === undefined) throw unknown();
    return dynamic.project;
  };
  const searchContextTool = async (a: Args) => {
    const sc = deps.searchContext as SearchContextDeps;
    const project = await searchTarget(a.project as string);
    return searchProjectContext(sc, project, {
      query: a.query as string,
      ...(a.limit !== undefined ? { limit: a.limit as number } : {}),
      scope: a.scope as "project" | "global" | "both",
    });
  };

  /** T16.9 (FR-SKL-08): offered only while the store is wired and `skills.enabled` is true. */
  const skillsOffered = deps.skills?.settings.enabled === true;
  const skillValidators = compileSkillValidators();

  // ADR-0069 (LLD §3.4.12): `publish_run`, scoped exactly as `get_run` (another client's or subject's run is unknown).
  const publishOffered = deps.publish !== undefined && client.maxPushPolicy === "branch";
  const publishValidators = compilePublishValidators();
  const publishRunTool = async (a: Args) => {
    const run = ownRun(a.run_id as string);
    return publishRun(
      { ledger, artifacts: deps.artifacts, clientId: deps.clientId, clientProjects: client.projects ?? [], scrub },
      deps.publish as PublishDeps,
      run,
      { openPullRequest: a.open_pull_request !== false, draft: a.draft === true },
    );
  };
  // ADR-0070 (LLD §3.4.13): `merge_run_pr`, offered exactly when `publish_run` is and the merge port is wired.
  const mergeRunOffered = publishOffered && deps.mergeRun !== undefined;
  const mergeRunPrTool = async (a: Args) =>
    mergeRunPr(
      { ledger, clientId: deps.clientId, clientProjects: client.projects ?? [] },
      deps.publish as PublishDeps,
      deps.mergeRun as MergeRunDeps,
      ownRun(a.run_id as string),
      a.expected_head_sha as string | undefined,
    );
  // ADR-0073 (LLD §3.4.14): `update_run_branch`, offered with `merge_run_pr` when the update port is wired too.
  const updateBranchOffered = mergeRunOffered && updateRunOffered(deps.mergeRun);
  const updateRunBranchTool = async (a: Args) =>
    updateRunBranch(
      { ledger, clientId: deps.clientId, clientProjects: client.projects ?? [] },
      deps.publish as PublishDeps,
      deps.mergeRun as MergeRunDeps,
      ownRun(a.run_id as string),
      a.expected_head_sha as string | undefined,
    );
  // ADR-0078 (LLD §3.4.16): `close_pr`, offered with `publish_run` when the pull-request port can read by number and
  // close; scoped to pull requests `publish_run` created for this client's visible runs of the project.
  const closePrToolOffered = publishOffered && closePrOffered(deps.publish);
  const closePrTool = async (a: Args) =>
    closePr(
      {
        ledger,
        clientId: deps.clientId,
        clientProjects: client.projects ?? [],
        visibleRun: (runId) => {
          const run = ledger.getRunRecord(runId);
          return run !== undefined && run.client_id === deps.clientId && ownSubject(run.meta_session_id);
        },
      },
      deps.publish as PublishDeps,
      a as unknown as ClosePrArgs,
    );
  // ADR-0074 (LLD §3.4.15): scoped like `search_project_context` (projects) and `continue_task` (meta-sessions).
  const baseOffered = deps.base !== undefined && maxTrustProfile !== "inspect-untrusted";
  const baseValidators = compileBaseValidators();
  const oauthAdmin = deps.subject === undefined ? deps.oauthAdmin : undefined;
  const oauthOffered = oauthAdmin !== undefined;
  const oauthValidator = new Ajv2020({ allErrors: true, strict: true, useDefaults: true }).compile(
    inputSchema("list_oauth_clients"),
  );
  /** The client's newest visible run of `projectId` in `repoRoot`: where `refresh_project_base` records its event. */
  const anchorRun = (projectId: string, repoRoot: string): string | undefined => {
    const rows = (deps.base as BaseToolDeps).db
      .prepare(
        `SELECT r.id, r.meta_session_id FROM run r JOIN meta_session m ON m.id = r.meta_session_id
         WHERE r.client_id = ? AND r.project_id = ? AND m.repo_root = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 20`,
      )
      .all(deps.clientId, projectId, repoRoot) as { id: string; meta_session_id: string }[];
    return rows.find((r) => ownSubject(r.meta_session_id))?.id;
  };
  const refreshProjectBaseTool = async (a: Args) => {
    const project = await searchTarget(a.project_id as string);
    return refreshProjectBase(deps.base as BaseToolDeps, project, (root) => anchorRun(project.id, root));
  };
  const rebaseSessionHandler = async (a: Args) => {
    const sessionId = a.session_id as string;
    const session = ledger.getMetaSession(sessionId);
    const ctx = session ? lifecycle.metaSessionContext(sessionId) : undefined;
    if (!session || !ctx || ctx.clientId !== deps.clientId || !ownSubject(sessionId)) {
      throw invalid(`unknown meta-session ${sessionId}`);
    }
    if (session.status !== "ACTIVE") throw invalid(`meta-session ${sessionId} is closed`);
    if (ctx.activeRunId !== undefined) {
      throw invalid(`meta-session ${sessionId} has an active run ${ctx.activeRunId}`, {
        reason: "ACTIVE_RUN",
        run_id: ctx.activeRunId,
      });
    }
    if (ctx.projectId === undefined) {
      throw invalid(`meta-session ${sessionId} has no project, so it has no remote base`, {
        reason: "NOT_REMOTE_BACKED",
      });
    }
    // BR-23 / FR-PRJ-09: the meta-session's project is re-resolved under the current checks.
    const project = await searchTarget(ctx.projectId);
    return rebaseSessionTool(
      deps.base as BaseToolDeps,
      { id: sessionId, repoRoot: session.repo_root },
      project,
      a.expected_head_sha as string | undefined,
    );
  };
  const baseHandlers: Record<BaseToolName, (a: Args) => Promise<object>> = {
    refresh_project_base: refreshProjectBaseTool,
    rebase_session: rebaseSessionHandler,
  };
  const publishHandlers: Record<PublishToolName, (a: Args) => Promise<object>> = {
    publish_run: publishRunTool,
    merge_run_pr: mergeRunPrTool,
    update_run_branch: updateRunBranchTool,
    close_pr: closePrTool,
  };
  const publishToolOffered = (name: string) =>
    (PUBLISH_TOOL_NAMES as readonly string[]).includes(name) &&
    publishOffered &&
    (name !== "merge_run_pr" || mergeRunOffered) &&
    (name !== "update_run_branch" || updateBranchOffered) &&
    (name !== "close_pr" || closePrToolOffered);
  const skillGate = (profile: TrustProfile): SkillGate => ({
    profile,
    allowDraftInTrusted: deps.skills?.settings.allowDraftInTrusted === true,
    ...(client.skills !== undefined ? { clientSkills: client.skills } : {}),
  });
  /** Every get_skill miss: no name, no reason, so the answer is no existence oracle (LLD §19.9). */
  const unknownSkill = () => invalid("unknown skill", { field: "name" });
  const listSkills = async (a: Args) => {
    const sk = deps.skills as SkillToolDeps;
    const project = a.project === undefined ? undefined : await searchTarget(a.project as string);
    const ceiling = project === undefined ? maxTrustProfile : effectiveMaxProfile(maxTrustProfile, project);
    const profile = (a.trust_profile as TrustProfile | undefined) ?? ceiling;
    if (profileRank(profile) > profileRank(ceiling)) {
      throw new ToolError(
        "PERMISSION_BLOCKED",
        project === undefined
          ? `trust profile ${profile} exceeds this client's maximum ${maxTrustProfile}`
          : `trust profile ${profile} exceeds the maximum ${ceiling} this client has in project ${project.id}`,
      );
    }
    const gate = skillGate(profile);
    const catalog = storeCatalog(sk.db);
    const skills: object[] = [];
    for (const name of listSkillNames(sk.db)) {
      const entry = catalog(name);
      const v = entry === undefined ? undefined : newestInjectableVersion(entry, gate);
      if (v === undefined) continue;
      const row = getSkillVersion(sk.db, name, v.version);
      if (row === undefined) continue;
      skills.push({
        name,
        description: row.description,
        version: v.version,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
        approved: v.state === "approved",
        origin: row.origin,
        applies_to_providers: row.applies_to === null ? null : (JSON.parse(row.applies_to) as string[]),
      });
    }
    if (project === undefined) return { skills };
    const resolution = resolveSkills(
      {
        ...gate,
        global: sk.settings,
        ...(project.skills !== undefined ? { project: project.skills } : {}),
        ...(a.role !== undefined ? { role: a.role as string } : {}),
      },
      catalog,
    );
    return {
      skills,
      defaults: resolution.entries.map((e) => ({ name: e.name, version: e.version, source: e.source })),
    };
  };
  const getSkill = async (a: Args) => {
    const sk = deps.skills as SkillToolDeps;
    const name = a.name as string;
    const entry = storeCatalog(sk.db)(name);
    if (entry === undefined) throw unknownSkill();
    const gate = skillGate(maxTrustProfile);
    const v =
      a.version === undefined
        ? newestInjectableVersion(entry, gate)
        : entry.versions.find((x) => x.version === a.version);
    if (v === undefined || !versionInjectable(entry, v, gate)) throw unknownSkill();
    const row = getSkillVersion(sk.db, name, v.version);
    if (row === undefined) throw unknownSkill();
    let text: string;
    try {
      text = readSkillContent(sk.dataDir, row.sha256);
    } catch {
      throw new ToolError("TOOL_FAILURE", "stored skill text is missing or does not match its hash", {
        reason: "SKILL_CONTENT_UNAVAILABLE",
      });
    }
    return {
      name,
      version: v.version,
      sha256: row.sha256,
      description: row.description,
      approved: v.state === "approved",
      body: canonicalBody(text),
    };
  };
  const skillHandlers: Record<SkillToolName, (a: Args) => Promise<object>> = {
    list_skills: listSkills,
    get_skill: getSkill,
  };

  /**
   * Every descriptor this client is offered right now, in `tools/list` order: the single source of truth for the
   * `tools/list` handler below and for the unknown-tool error in `callTool`. Built from the same registered
   * descriptors (`toolDescriptors` plus the approval-proxy descriptors) filtered by the client's tool profile, so
   * `details.tools` can never drift stale again (mcp-test 20261019T195233Z finding 1).
   */
  const offeredDescriptors = () =>
    applyToolProfile(client.toolProfile, [
      ...toolDescriptors({
        manageProjects: client.manageProjects === true && projectTools !== undefined,
        searchContext: searchOffered(),
        workQueue: workQueueOffered,
        skills: skillsOffered,
        publish: publishOffered,
        mergeRunPr: mergeRunOffered,
        updateRunBranch: updateBranchOffered,
        closePr: closePrToolOffered,
        baseTools: baseOffered,
        oauthClients: oauthOffered,
      }),
      // T14.8: listed only for an approval_proxy client (absent, not refused, for every other client).
      ...(approvalProxy !== undefined
        ? approvalProxyToolDescriptors().map((d) => ({ ...d, outputSchema: withError(d.outputSchema) }))
        : []),
      // T14.15: orchestrator tools once wired; `decide` only for an approval_proxy client.
      ...(decisionsOffered ? decisionToolDescriptors(decideOffered) : []),
    ]);
  /** The names `tools/list` returns right now; what the unknown-tool error reports in `details.tools`. */
  const offeredToolNames = (): string[] => offeredDescriptors().map((d) => d.name);

  const handlers: Record<ToolName, (a: Args) => Promise<object>> = {
    delegate_task: delegateTask,
    continue_task: continueTask,
    get_run: getRun,
    cancel_run: cancelRun,
    get_artifacts: getArtifacts,
    list_capabilities: listCapabilities,
    list_projects: listProjects,
    get_capacity: getCapacity,
    explain_route: explainRouteTool,
    list_runs: listRuns,
    get_digest: getDigest,
    steer_run: steerRun,
    pause_project: pauseProject,
    resume_project: resumeProject,
  };

  const ok = (value: object): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  });
  const fail = (err: unknown): CallToolResult => {
    const env = errorEnvelope(toToolError(err), scrub);
    return { content: [{ type: "text", text: JSON.stringify(env) }], structuredContent: { ...env }, isError: true };
  };

  const callTool = async (name: string, rawArgs: unknown): Promise<CallToolResult> => {
    try {
      if (!profileOffers(client.toolProfile, name)) {
        // T14.11 (FR-CTL-11): a tool outside the client's profile is answered exactly like an unknown tool.
        if ((PROJECT_TOOL_NAMES as readonly string[]).includes(name)) {
          projectTools?.recordNotOffered(name as ProjectToolName, rawArgs);
        }
        // ADR-0078: every `close_pr` call is audited, also one this client is not offered.
        if (name === "close_pr") recordClosePrRefusal(ledger, deps.clientId, rawArgs, "TOOL_NOT_OFFERED");
        throw invalid(`unknown tool ${JSON.stringify(name.slice(0, 64))}`, {
          tools: offeredToolNames(),
        });
      }
      if ((PROJECT_TOOL_NAMES as readonly string[]).includes(name)) {
        // T9.9 (FR-PRJ-10): offered only with manage_projects; otherwise answered exactly like an unknown tool, but recorded.
        if (client.manageProjects === true && projectTools !== undefined) {
          return ok(await projectTools.call(name as ProjectToolName, rawArgs));
        }
        projectTools?.recordNotOffered(name as ProjectToolName, rawArgs);
      }
      if ((APPROVAL_PROXY_TOOL_NAMES as readonly string[]).includes(name) && approvalProxy && approvalValidators) {
        // T14.8: a refusal (any failed check) is INVALID_REQUEST and writes nothing.
        const tool = name as ApprovalProxyToolName;
        const args = structuredClone(rawArgs ?? {}) as Args;
        const validate = approvalValidators[tool];
        if (!validate(args)) throw schemaError(validate.errors ?? []);
        try {
          return ok(tool === "list_pending_approvals" ? approvalProxy.list(args) : approvalProxy.decide(args as never));
        } catch (err) {
          if (err instanceof ApprovalProxyError) throw invalid(err.message);
          throw err;
        }
      }
      if ((SEARCH_TOOL_NAMES as readonly string[]).includes(name) && searchOffered()) {
        // T12.6 (FR-RAG-06): read-only; when not offered it is answered exactly like an unknown tool.
        const args = structuredClone(rawArgs ?? {}) as Args;
        if (!searchValidator(args)) throw schemaError(searchValidator.errors ?? []);
        return ok(await searchContextTool(args));
      }
      if ((SKILL_TOOL_NAMES as readonly string[]).includes(name) && skillsOffered) {
        // T16.9 (FR-SKL-08): read-only; when not offered it is answered exactly like an unknown tool.
        const tool = name as SkillToolName;
        const args = structuredClone(rawArgs ?? {}) as Args;
        const validate = skillValidators[tool];
        if (!validate(args)) throw schemaError(validate.errors ?? []);
        return ok(await skillHandlers[tool](args));
      }
      if (name === "close_pr" && !publishToolOffered(name)) {
        // ADR-0078: audited, then answered like an unknown tool below.
        recordClosePrRefusal(ledger, deps.clientId, rawArgs, "TOOL_NOT_OFFERED");
      }
      if (publishToolOffered(name)) {
        // ADR-0069: when not offered (no publish port, or max_push_policy none) it is answered like an unknown tool;
        // ADR-0070: `merge_run_pr` also without the merge port; ADR-0073: `update_run_branch` also without the update
        // port; ADR-0078: `close_pr` also without the port's read-by-number and close.
        const tool = name as PublishToolName;
        const args = structuredClone(rawArgs ?? {}) as Args;
        const validate = publishValidators[tool];
        if (!validate(args)) {
          if (tool === "close_pr") recordClosePrRefusal(ledger, deps.clientId, rawArgs, "SCHEMA_INVALID");
          throw schemaError(validate.errors ?? []);
        }
        return ok(await publishHandlers[tool](args));
      }
      if ((BASE_TOOL_NAMES as readonly string[]).includes(name) && baseOffered) {
        // ADR-0074: when not offered (no base port, or an inspect-only client) it is answered like an unknown tool.
        const tool = name as BaseToolName;
        const args = structuredClone(rawArgs ?? {}) as Args;
        const validate = baseValidators[tool];
        if (!validate(args)) throw schemaError(validate.errors ?? []);
        return ok(await baseHandlers[tool](args));
      }
      if ((OAUTH_TOOL_NAMES as readonly string[]).includes(name) && oauthAdmin !== undefined) {
        // Stdio only: over HTTP `oauthAdmin` is never set, so the name is answered exactly like an unknown tool.
        const args = structuredClone(rawArgs ?? {}) as Args;
        if (!oauthValidator(args)) throw schemaError(oauthValidator.errors ?? []);
        const id = args.client_id as string | undefined;
        try {
          return ok({ clients: id === undefined ? oauthAdmin.listClients() : [oauthAdmin.getClient(id)] });
        } catch (err) {
          if (err instanceof UnknownOAuthClientError) throw invalid(err.message, { field: "client_id" });
          throw err;
        }
      }
      if ((WORK_QUEUE_TOOL_NAMES as readonly string[]).includes(name) && workQueueOffered) {
        // T15.9 (FR-QUE-08): when not offered (a console client) it is answered exactly like an unknown tool.
        const tool = name as WorkQueueToolName;
        const args = structuredClone(rawArgs ?? {}) as Args;
        const validate = workValidators[tool];
        if (!validate(args)) throw schemaError(validate.errors ?? []);
        return ok(await workHandlers[tool](args));
      }
      if (
        ((DECISION_TOOL_NAMES as readonly string[]).includes(name) && decisionsOffered) ||
        ((DECIDE_TOOL_NAMES as readonly string[]).includes(name) && decideOffered)
      ) {
        // T14.15 (FR-CTL-13, FR-CTL-08): when not offered (no approval_proxy for decide, a console client, or no
        // decision service) it is answered exactly like an unknown tool.
        const tool = name as AnyDecisionToolName;
        const args = structuredClone(rawArgs ?? {}) as Args;
        const validate = decisionValidators[tool];
        if (!validate(args)) throw schemaError(validate.errors ?? []);
        return ok(await decisionHandlers[tool](args));
      }
      if (!(TOOL_NAMES as readonly string[]).includes(name)) {
        throw invalid(`unknown tool ${JSON.stringify(name.slice(0, 64))}`, { tools: offeredToolNames() });
      }
      const tool = name as ToolName;
      const args = structuredClone(rawArgs ?? {}) as Args; // defaults are filled in place by Ajv
      const validate = validators[tool];
      if (!validate(args)) throw schemaError(validate.errors ?? [], tool);
      if (tool === "delegate_task" && args.privileged_scope !== undefined) {
        // V1 continued (LLD §3.1): the list-presence rules the JSON Schema cannot express.
        const lists = checkScopeLists(args.privileged_scope as never);
        if (lists) throw invalid(`invalid arguments: ${lists.field} ${lists.message}`, { field: lists.field });
      }
      // T9.9: delete_project waits for requests that are resolving a project but are not admitted yet.
      const admittingProject =
        tool === "delegate_task"
          ? args.project
          : tool === "continue_task"
            ? ledger.getMetaSession(String(args.meta_session_id))?.project_id
            : undefined;
      return ok(await whileAdmitting(admittingProject, () => handlers[tool](args)));
    } catch (err) {
      return fail(err);
    }
  };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler("tools/list", async () => ({
    // T14.11 (FR-CTL-11): a console client sees only the console set; an orchestrator list is unchanged.
    // The cast is the published JSON Schemas (`type: "object"` objects) against the SDK v2 `Tool` literal.
    tools: offeredDescriptors() as unknown as Tool[],
  }));
  server.setRequestHandler("tools/call", async (req) => callTool(req.params.name, req.params.arguments));

  return {
    server,
    clientId: deps.clientId,
    maxTrustProfile,
    callTool,
    close: () => server.close(),
  };
}

/**
 * Serve MCP over this process's stdin/stdout (FR-MCP-01). stdout carries MCP framing only (TDD §3.3). The caller
 * (`switchboard serve`, T2.6) runs reconciliation and `lifecycle.start()` first and owns shutdown.
 */
export async function startStdioServer(deps: McpServerDeps): Promise<SwitchboardMcpServer> {
  const mcp = createSwitchboardServer(deps);
  await mcp.server.connect(new StdioServerTransport());
  return mcp;
}

/** Eligibility reasons that depend on the requested profile, not on the provider as a whole (T3.7). */
const PER_PROFILE_REASONS: ReadonlySet<EligibilityReasonCode> = new Set([
  "PROFILE_UNSUPPORTED",
  "CAPABILITY_MISSING",
  "PROFILE_PLATFORM_UNVERIFIED",
]);

/**
 * Proposed (Delegated, 2026-10-13; LLD §3.1 "Listing"): the scopes `list_capabilities` compiles to decide whether a
 * provider lists `privileged`. A provider is listed when its adapter compiles ANY of them, so `privileged` means "this
 * provider compiles at least one privileged scope here"; each request's own scope is still compiled at dispatch, where
 * an `Ineligible` ends the run with its BR-3 code. No single scope compiles for both adapters (T3.5: Claude has no
 * network control, so it needs network `on`; T3.6: Codex cannot disable commands, so it needs shell `broad` with
 * network `off`), hence a small set rather than the narrowest scope alone. All have `bypass: false`: listing never
 * compiles with `bypassApproved`, which only an approval grants.
 */
const REPRESENTATIVE_PRIVILEGED_SCOPES: readonly PrivilegedScope[] = [
  // The narrowest scope LLD §3.1 allows.
  {
    files: { access: "read-only" },
    shell: { mode: "none" },
    network: { mode: "off" },
    repository_config: { mode: "disabled" },
    bypass: false,
  },
  // Worktree edits, no shell, unrestricted network (the shape a provider without a network control can express).
  {
    files: { access: "worktree" },
    shell: { mode: "none" },
    network: { mode: "on" },
    repository_config: { mode: "disabled" },
    bypass: false,
  },
  // Worktree edits, any command, network off (the shape a sandbox-only provider can express).
  {
    files: { access: "worktree" },
    shell: { mode: "broad" },
    network: { mode: "off" },
    repository_config: { mode: "disabled" },
    bypass: false,
  },
];

function compileValidators(): Record<ToolName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  return Object.fromEntries(TOOL_NAMES.map((n) => [n, ajv.compile(inputSchema(n))])) as Record<
    ToolName,
    ValidateFunction
  >;
}

function compileSkillValidators(): Record<SkillToolName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  return Object.fromEntries(SKILL_TOOL_NAMES.map((n) => [n, ajv.compile(inputSchema(n))])) as Record<
    SkillToolName,
    ValidateFunction
  >;
}

function compilePublishValidators(): Record<PublishToolName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  return Object.fromEntries(PUBLISH_TOOL_NAMES.map((n) => [n, ajv.compile(inputSchema(n))])) as Record<
    PublishToolName,
    ValidateFunction
  >;
}

function compileBaseValidators(): Record<BaseToolName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  return Object.fromEntries(BASE_TOOL_NAMES.map((n) => [n, ajv.compile(inputSchema(n))])) as Record<
    BaseToolName,
    ValidateFunction
  >;
}

function compileWorkValidators(): Record<WorkQueueToolName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  return Object.fromEntries(WORK_QUEUE_TOOL_NAMES.map((n) => [n, ajv.compile(inputSchema(n))])) as Record<
    WorkQueueToolName,
    ValidateFunction
  >;
}

function compileDecisionValidators(): Record<AnyDecisionToolName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  const inputs = decisionInputs();
  const names = [...DECISION_TOOL_NAMES, ...DECIDE_TOOL_NAMES];
  return Object.fromEntries(names.map((n) => [n, ajv.compile(inputs[n])])) as Record<
    AnyDecisionToolName,
    ValidateFunction
  >;
}

function schemaError(errors: readonly ErrorObject[], tool?: string): ToolError {
  // FRD V12: the root `oneOf` of delegate_task says it better than the branch errors it leaves behind.
  if (errors.some((e) => e.keyword === "oneOf" && e.instancePath === "")) {
    return invalid("invalid arguments: exactly one of workspace_path and project is required", {
      field: "project",
      errors: [{ path: "$", message: "must have exactly one of workspace_path and project" }],
    });
  }
  // T14.1: the root `not` of list_runs.
  if (errors.some((e) => e.keyword === "not" && e.instancePath === "")) {
    return invalid("invalid arguments: give at most one of status and status_in", {
      field: "status_in",
      errors: [{ path: "$", message: "must not have both status and status_in" }],
    });
  }
  // T7.14 (Q-99): continue_task rejects routing.model_group and routing.model before checkRouting runs.
  if (
    (!tool || tool === "continue_task") &&
    errors.some(
      (e) =>
        e.keyword === "additionalProperties" &&
        e.instancePath === "/routing" &&
        (e.params.additionalProperty === "model_group" || e.params.additionalProperty === "model"),
    )
  ) {
    return invalid("continue_task accepts neither routing.model_group nor routing.model (Q-99)", {
      field: "routing",
    });
  }
  const list = errors.slice(0, 10).map((e) => {
    // `$.a.b[0]` notation (as config errors use): JSON pointers would read like filesystem paths.
    let where = e.instancePath
      .split("/")
      .slice(1)
      .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((acc, s) => (/^\d+$/.test(s) ? `${acc}[${s}]` : `${acc}.${s}`), "$");
    if (e.keyword === "required") where += `.${String(e.params.missingProperty)}`;
    if (e.keyword === "additionalProperties") where += `.${String(e.params.additionalProperty)}`;
    return { path: where, message: e.message ?? "invalid" };
  });
  const first = list[0];
  return invalid(`invalid arguments: ${first ? `${first.path} ${first.message}` : "schema validation failed"}`, {
    errors: list,
    ...(first ? { field: first.path } : {}),
  });
}

/** T14.1: a schema-shaped ISO-8601 instant as the ledger's canonical UTC form; an impossible date is INVALID_REQUEST. */
function instant(value: string, field: string): string {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const ms = Date.parse(value);
  // Date.parse rolls an impossible day over (February 31 reads as March 3), so check the calendar day first.
  if (Number.isNaN(ms) || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) {
    throw invalid(`invalid arguments: $.${field} is not a valid date-time`, { field });
  }
  return new Date(ms).toISOString();
}

const RUN_CURSOR =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)\|(run_[0-9A-HJKMNP-TV-Z]{26})$/u;

/** T14.1 (LLD §3.4.2, Delegated): the opaque cursor is the last row's keyset position, base64url-encoded. */
function encodeRunCursor(run: RunRecord): string {
  return Buffer.from(`${run.created_at}|${run.id}`, "utf8").toString("base64url");
}

function decodeRunCursor(cursor: string): { createdAt: string; id: string } {
  const m = RUN_CURSOR.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw invalid("invalid arguments: $.cursor is not a cursor list_runs returned", { field: "cursor" });
  }
  return { createdAt: m[1], id: m[2] };
}
