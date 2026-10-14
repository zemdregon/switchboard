/**
 * COMP-MCP: the upstream MCP server over stdio (T2.4; FR-MCP-01, 03–09; ADR-0002; LLD §3). It owns validation and
 * result shaping only; admission, dispatch and cancellation stay in the run lifecycle, and eligibility is the shared
 * stage-1 filter (`src/routing`) reached through `RunLifecycle.checkEligibility`.
 *
 * SDK use: `@modelcontextprotocol/sdk` 1.32.1. Its high-level `McpServer.registerTool` takes zod schemas, so this
 * module uses the lower-level `Server` with `tools/list` and `tools/call` request handlers and publishes the raw JSON
 * Schemas from `./schemas.ts`, validated here with Ajv (TDD §2: Ajv schemas are the source of truth; zod is not a
 * direct dependency).
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
 *   (non-empty executable, no NUL). `minimum_capability` fails ELIGIBILITY_NONE: it is a hard constraint (BR-4) and no
 *   model registry exists before M7.
 * - The idempotency hash covers the validated, defaults-filled input with the workspace canonicalised, excluding
 *   `idempotency_key` and `wait_seconds` (which do not change what runs) and independent of the routed provider.
 * - Provider choice among eligible candidates: `provider_preference` if eligible, else candidate (registration) order
 *   (BR-4 tie-break until M7 scoring).
 * - Runs, meta-sessions and artifacts are visible only to the client that created them; another client's id is
 *   reported as unknown (INVALID_REQUEST), so ids are not an existence oracle across clients. Over the network
 *   transport (T13.5, FR-MCP-15, Q-78) the same holds per subject: a meta-session opened over HTTP is bound to the
 *   caller's OAuth client (`subject`) and is unknown to every other subject and to stdio; one opened over stdio is
 *   unknown over HTTP. A run belongs to its meta-session. An idempotency key another subject used is reported exactly
 *   like a key reused with different parameters.
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
 *   reading; workspace_path requests are unaffected); a `container` project fails TOOL_FAILURE with
 *   `details.reason = ENVIRONMENT_NOT_IMPLEMENTED` before any side effect (M10, Proposed code: LLD §3 names no other).
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
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type AdapterRegistry,
  adapterIdForConfigId,
  type ProviderId,
  type ResolvedProfile,
} from "../adapters/index.js";
import type { ArtifactStore } from "../artifacts/index.js";
import { capacityProjection, capacityProviders } from "../capacity/index.js";
import {
  type CapacitySettings,
  CONTAINER_NOT_IMPLEMENTED,
  DEFAULT_CAPACITY_CONFIDENCE_RUNS,
  DEFAULT_CAPACITY_WINDOW_SECONDS,
  effectiveMaxProfile,
  primaryContext,
  projectsForClient,
  type ResolvedConfig,
  type ResolvedProject,
} from "../config/index.js";
import {
  type BundleBounds,
  buildAndPutHandoffView,
  DEFAULT_BUNDLE_BOUNDS,
  PRIVILEGED_CROSS_PROVIDER_REASON,
  refusesPrivilegedCrossProvider,
  takeAsOf,
} from "../continuity/index.js";
import type { Ledger, RunRecord, TrustProfile } from "../ledger/index.js";
import {
  type EligibilityAnswer,
  type HandoffReason,
  type HandoffSubmission,
  type RunLifecycle,
  type RunPriority,
  requestHash,
  verificationCommandsProblem,
} from "../lifecycle/index.js";
import {
  checkScopeLists,
  type PrivilegedScope,
  type ProjectSnapshot,
  parsePrivilegedScope,
  resolveTrustProfile,
} from "../policy/index.js";
import type { DynamicProjectStore } from "../projects/index.js";
import {
  compileCheck,
  type EligibilityReasonCode,
  profilePlatformSupported,
  profileRank,
  requirementsFor,
  TRUST_PROFILE_ORDER,
  toRouteDecisionJson,
} from "../routing/index.js";
import { gitText } from "../workspace/git.js";
import { buildEnvelope, compactEvents, type Envelope } from "./envelope.js";
import { errorEnvelope, invalid, ToolError, toToolError } from "./errors.js";
import type { SubjectBindings } from "./http-subjects.js";
import { createProjectTools, dynamicListItem, type ProjectTools } from "./project-tools.js";
import {
  inputSchema,
  MCP_ARTIFACT_KINDS,
  PROJECT_TOOL_NAMES,
  type ProjectToolName,
  SCHEMA_DIALECT,
  TOOL_NAMES,
  TOOL_SCHEMA_VERSION,
  type ToolName,
  toolDescriptors,
} from "./schemas.js";
import { createScrubber } from "./scrub.js";

export const SERVER_NAME = "switchboard";
/** Proposed: tracks package.json `version`. */
export const SERVER_VERSION = "0.0.0";

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
    /** T9.9: providers the operator disabled are outside every client's provider set. */
    readonly providers?: ResolvedConfig["providers"];
    /** T5.6: handoff bundle bounds (`continuity.*`, LLD §15.4). Absent means the LLD defaults. */
    readonly continuity?: BundleBounds;
    /** T6.3: estimator settings (`capacity.*`, LLD §16.1). Absent means the LLD defaults. */
    readonly capacity?: Pick<CapacitySettings, "windowSeconds" | "confidenceRuns">;
    /** T6.3: slot limits shown by `get_capacity`. Absent means the NFR-PERF-03 default of one per provider. */
    readonly limits?: Pick<ResolvedConfig["limits"], "perProviderConcurrency">;
  };
  /** T9.9 (FR-PRJ-10): dynamic projects. Required when the client has `manage_projects`; absent means none resolve. */
  readonly projectStore?: DynamicProjectStore;
  /** Configured MCP client this session is bound to (`serve --client <id>`). */
  readonly clientId: string;
  /**
   * T13.5 (FR-MCP-15, Q-78): the OAuth client id (token subject) of an HTTP request; absent on stdio. Requires
   * `subjectBindings`.
   */
  readonly subject?: string;
  /** T13.5: meta-session to subject bindings. Absent on stdio means no HTTP-bound meta-session is filtered out. */
  readonly subjectBindings?: SubjectBindings;
  /** Routing candidate order (BR-4 tie-break). Defaults to registry registration order. */
  readonly candidateOrder?: readonly ProviderId[];
  /** Clock for `get_capacity` (T6.3); defaults to the system clock. */
  readonly now?: () => Date;
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
type Routing = { provider_preference?: string; require_provider?: boolean; minimum_capability?: string };

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
          configuredIds: () => new Set((deps.config.projects ?? []).map((p) => p.id)),
          disabledProviders: new Set(
            [...(deps.config.providers ?? new Map())].filter(([, v]) => !v.enabled).map(([id]) => id),
          ),
          admitting: (id) => admittingCount.get(id) ?? 0,
        });
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

  /** T13.5 (Q-78): the meta-session's subject is this caller's (its OAuth client over HTTP, none over stdio). */
  const ownSubject = (metaSessionId: string): boolean =>
    deps.subjectBindings === undefined || deps.subjectBindings.subjectOf(metaSessionId) === deps.subject;
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
    if (project.environment.kind === "container") {
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
        environment_kind: project.environment.kind,
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
    const set = new Set<string>(allowed.flatMap((id) => adapterIdForConfigId(id) ?? []));
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

  /** FRD V8: provider names must be registered; `require_provider` needs a named provider. */
  const checkRouting = (routing: Routing | undefined): void => {
    if (!routing) return;
    const named = routing.provider_preference;
    if (named !== undefined && !deps.registry.has(named as ProviderId)) {
      throw invalid(`unknown provider ${named}`, { field: "routing.provider_preference" });
    }
    if (routing.require_provider === true && named === undefined) {
      throw invalid("routing.require_provider needs routing.provider_preference", { field: "routing" });
    }
    if (routing.minimum_capability !== undefined) {
      throw new ToolError(
        "ELIGIBILITY_NONE",
        "minimum_capability cannot be evaluated yet (no model registry); omit it",
        { field: "routing.minimum_capability" },
      );
    }
  };

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

  const selectProvider = (answer: EligibilityAnswer, preference: string | undefined, privileged = false) => {
    const eligible = admissible(answer, privileged);
    const suffix = privileged && !answer.decision.eligible.length ? "; privileged compile deferred to dispatch" : "";
    if (preference !== undefined && eligible.includes(preference as ProviderId)) {
      return { provider: preference as ProviderId, basis: `provider_preference${suffix}` };
    }
    const first = eligible[0];
    if (first === undefined) throw eligibilityError(answer);
    return { provider: first, basis: `configured_order${suffix}` };
  };

  const routeRecord = (
    answer: EligibilityAnswer,
    provider: ProviderId,
    basis: string,
    project?: { id: string; excluded: readonly ProviderId[]; revision?: number },
    /** T5.6 (LLD §15.7 step 7): how a continuation runs, with its BR-18 reason code; controller values only. */
    continuation?: { mode: "resume" | "handoff"; reason: string; from_provider: string; problem?: string },
  ) => {
    const json = toRouteDecisionJson(answer.input, answer.decision);
    const reasons = {
      ...(JSON.parse(json.reasons_json) as object),
      selection: { provider, basis },
      ...(continuation !== undefined ? { continuation } : {}),
      ...(project !== undefined
        ? {
            project: {
              id: project.id,
              excluded_providers: [...project.excluded],
              ...(project.revision !== undefined ? { revision: project.revision } : {}),
            },
          }
        : {}),
    };
    return { ...json, selected_provider: provider, reasons_json: JSON.stringify(reasons) };
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
    };
    const hash = requestHash(canonical);
    const key = a.idempotency_key as string | undefined;
    if (key !== undefined) {
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
    const narrowed = projectCandidates(resolved, required); // BR-23: before eligibility, so nothing is probed for them
    const answer = await lifecycle.checkEligibility({
      candidates: narrowed.candidates,
      ...(required !== undefined ? { requiredProvider: required } : {}),
      trustProfile: profile,
      clientMaxProfile: resolved?.effectiveMax ?? maxTrustProfile,
      cwd: workspace,
      ...(scope?.ok ? { profile: eligibilityProfile(scope.scope) } : {}),
    }); // V11
    if (answer.decision.outcome.kind !== "eligible" && admissible(answer, privileged).length === 0) {
      throw eligibilityError(answer);
    }
    if (required !== undefined && !admissible(answer, privileged).includes(required)) throw eligibilityError(answer);
    const { provider, basis } = selectProvider(answer, routing?.provider_preference, privileged);

    const submitted = await lifecycle.submit({
      clientId: deps.clientId,
      objective: a.objective as string,
      workspace,
      trustProfile: profile,
      provider,
      constraints: a.constraints as string[],
      priority: a.priority as RunPriority,
      requestHash: hash,
      routeDecision: routeRecord(
        answer,
        provider,
        basis,
        resolved
          ? {
              id: resolved.snapshot.id,
              excluded: narrowed.excluded,
              ...(resolved.revision !== undefined ? { revision: resolved.revision } : {}),
            }
          : undefined,
      ),
      ...(resolved ? { project: resolved.snapshot } : {}),
      ...(key !== undefined ? { idempotencyKey: key } : {}),
      ...(verification.length > 0 ? { verificationCommands: verification } : {}),
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
    checkRouting(routing); // C5 (as V8)
    const approvedScope = approval ? parsePrivilegedScope(approval.scope) : undefined;
    if (approvedScope && !approvedScope.ok) throw invalid(`meta-session ${sessionId} approval holds an invalid scope`);
    const privileged = approval !== undefined;
    const ask = (candidates: readonly ProviderId[], requiredProvider?: ProviderId) =>
      lifecycle.checkEligibility({
        candidates,
        ...(requiredProvider !== undefined ? { requiredProvider } : {}),
        trustProfile: profile,
        clientMaxProfile: resolved?.effectiveMax ?? maxTrustProfile,
        cwd: workspace,
        ...(approvedScope?.ok ? { profile: eligibilityProfile(approvedScope.scope) } : {}),
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
      const p0Allowed = allowedSet === undefined || allowedSet.some((id) => adapterIdForConfigId(id) === p0);
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

    // Step 2, second half, and step 4: the target and the mode.
    let target: ProviderId;
    let answer: EligibilityAnswer;
    let basis: string;
    let excluded: readonly ProviderId[] = [];
    let handoffReason: HandoffReason | undefined; // undefined: native resume
    let problem: string | undefined;
    if (crossTo === undefined && answerP0 !== undefined) {
      target = p0;
      answer = answerP0;
      basis = "continuation";
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
      if (privileged) basis += "; privileged compile deferred to dispatch";
    } else if (named !== undefined && named !== p0) {
      // The named provider is the target, so one the project does not allow is PERMISSION_BLOCKED before anything is
      // probed (step 4, BR-23); eligibility then runs over the project's allowed providers (FR-PRJ-06).
      const narrowed = projectCandidates(resolved, named);
      answer = await ask(narrowed.candidates, required);
      if (required !== undefined && !admissible(answer, privileged).includes(required)) throw eligibilityError(answer);
      ({ provider: target, basis } = selectProvider(answer, named, privileged));
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
      ({ provider: target, basis } = selectProvider(answer, undefined, privileged));
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
      routeDecision: routeRecord(
        answer,
        target,
        `${mode} ${reasonCode} from ${p0}; ${basis}`,
        resolved
          ? {
              id: resolved.snapshot.id,
              excluded,
              ...(resolved.revision !== undefined ? { revision: resolved.revision } : {}),
            }
          : undefined,
        { mode, reason: reasonCode, from_provider: p0, ...(problem !== undefined ? { problem } : {}) },
      ),
      ...(approval ? { privileged: { approvalId: approval.id } } : {}),
      ...(resolved ? { project: resolved.snapshot } : {}),
    });
    await waitBounded(submitted.runId, a.wait_seconds as number);
    return envelopeOf(submitted.runId);
  };

  const getRun = async (a: Args): Promise<Envelope> => {
    const run = ownRun(a.run_id as string);
    const inc = a.include_events as { after_seq: number; limit: number } | undefined;
    return envelopeOf(run.id, inc ? { events: compactEvents(ledger, run.id, inc.after_seq, inc.limit, scrub) } : {});
  };

  const cancelRun = async (a: Args): Promise<Envelope> => {
    const run = ownRun(a.run_id as string);
    await lifecycle.cancel(run.id, (a.reason as string | undefined) ?? "cancel_run");
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
   * provider in candidate order or for the one named. Read-only; it never probes or calls a provider.
   */
  const getCapacity = async (args: Args) => {
    const ids: string[] = candidates();
    const named = args.provider as string | undefined;
    if (named !== undefined && !ids.includes(named)) {
      throw invalid(`unknown provider ${JSON.stringify(named)}`, { providers: ids });
    }
    const settings = {
      windowSeconds: deps.config.capacity?.windowSeconds ?? DEFAULT_CAPACITY_WINDOW_SECONDS,
      confidenceRuns: deps.config.capacity?.confidenceRuns ?? DEFAULT_CAPACITY_CONFIDENCE_RUNS,
    };
    const providers = capacityProviders(named === undefined ? ids : [named], {
      ...(deps.config.providers !== undefined ? { providers: deps.config.providers } : {}),
      ...(deps.config.limits !== undefined ? { limits: deps.config.limits } : {}),
    });
    return capacityProjection(ledger, providers, settings, (deps.now ?? (() => new Date()))());
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
              ? REPRESENTATIVE_PRIVILEGED_SCOPES.map((sc) => eligibilityProfile(sc))
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

  const handlers: Record<ToolName, (a: Args) => Promise<object>> = {
    delegate_task: delegateTask,
    continue_task: continueTask,
    get_run: getRun,
    cancel_run: cancelRun,
    get_artifacts: getArtifacts,
    list_capabilities: listCapabilities,
    list_projects: listProjects,
    get_capacity: getCapacity,
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
      if ((PROJECT_TOOL_NAMES as readonly string[]).includes(name)) {
        // T9.9 (FR-PRJ-10): offered only with manage_projects; otherwise answered exactly like an unknown tool, but recorded.
        if (client.manageProjects === true && projectTools !== undefined) {
          return ok(await projectTools.call(name as ProjectToolName, rawArgs));
        }
        projectTools?.recordNotOffered(name as ProjectToolName, rawArgs);
      }
      if (!(TOOL_NAMES as readonly string[]).includes(name)) {
        throw invalid(`unknown tool ${JSON.stringify(name.slice(0, 64))}`, { tools: [...TOOL_NAMES] });
      }
      const tool = name as ToolName;
      const args = structuredClone(rawArgs ?? {}) as Args; // defaults are filled in place by Ajv
      const validate = validators[tool];
      if (!validate(args)) throw schemaError(validate.errors ?? []);
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDescriptors({ manageProjects: client.manageProjects === true && projectTools !== undefined }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments));

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

/**
 * The snapshot V11 compiles against for a `privileged` request: the scope resolved with placeholder hash and approval
 * ID (the real ones exist only inside the admission transaction). `bypassApproved` is false whatever the scope says
 * (it is known only at dispatch), so {@link admissible} defers an adapter's compile refusal to dispatch.
 */
function eligibilityProfile(scope: PrivilegedScope): ResolvedProfile {
  return resolveTrustProfile("privileged", {
    privileged: {
      scope,
      scopeHash: "0".repeat(64),
      approvalId: "apv_00000000000000000000000000",
    },
  });
}

function compileValidators(): Record<ToolName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  return Object.fromEntries(TOOL_NAMES.map((n) => [n, ajv.compile(inputSchema(n))])) as Record<
    ToolName,
    ValidateFunction
  >;
}

function schemaError(errors: readonly ErrorObject[]): ToolError {
  // FRD V12: the root `oneOf` of delegate_task says it better than the branch errors it leaves behind.
  if (errors.some((e) => e.keyword === "oneOf" && e.instancePath === "")) {
    return invalid("invalid arguments: exactly one of workspace_path and project is required", {
      field: "project",
      errors: [{ path: "$", message: "must have exactly one of workspace_path and project" }],
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
