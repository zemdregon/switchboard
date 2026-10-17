/**
 * T15.1 (FR-QUE-01, LLD §18.4): admit a queued `request_json` through the same pipeline as MCP `delegate_task`, under
 * `creator_client_id`. Shared by the scheduler; MCP `server.ts` may adopt this module in a later lane.
 */
import {
  type AdapterRegistry,
  acceptsReportedModel,
  adapterIdForConfigId,
  type ProviderId,
} from "../adapters/index.js";
import {
  CONTAINER_NOT_IMPLEMENTED,
  DEFAULT_CAPACITY_CONFIDENCE_RUNS,
  DEFAULT_CAPACITY_WINDOW_SECONDS,
  effectiveMaxProfile,
  groupMembersFor,
  type ModelGroupsConfigInput,
  modelGroupsOf,
  primaryContext,
  type ResolvedConfig,
  type ResolvedModelGroups,
  type ResolvedProject,
} from "../config/index.js";
import { snapshotEnvironment } from "../environment/index.js";
import type { Ledger, TrustProfile } from "../ledger/index.js";
import {
  type EligibilityAnswer,
  type EligibilityQuestion,
  LifecycleError,
  type RunLifecycle,
  type RunPriority,
  requestHash,
  verificationCommandsProblem,
} from "../lifecycle/index.js";
import { invalid, ToolError } from "../mcp/errors.js";
import { createProjectTools } from "../mcp/project-tools.js";
import type { ModelCapability, ModelRegistry } from "../models/registry.js";
import { type ProjectSnapshot, parsePrivilegedScope } from "../policy/index.js";
import type { DynamicProjectStore } from "../projects/index.js";
import {
  buildRouteDecision,
  collectAffinityFacts,
  collectScoreInputs,
  DEFAULT_AFFINITY,
  DEFAULT_WEIGHTS,
  planModelPin,
  profileRank,
  type RouteDecisionResult,
  type RouteFeatures,
  withModelPin,
} from "../routing/index.js";
import { gitText } from "../workspace/git.js";

export type AdmitWorkOutcome =
  | { kind: "admitted"; runId: string; replayed: boolean }
  | { kind: "retry" }
  | { kind: "failed"; code: string };

export interface AdmitWorkDeps {
  lifecycle: RunLifecycle;
  ledger: Ledger;
  registry: AdapterRegistry;
  config: Pick<
    ResolvedConfig,
    "allowedRoots" | "mcpClients" | "projects" | "dataDir" | "providers" | "capacity" | "limits" | "routing"
  > & {
    modelGroups?: ResolvedModelGroups;
    model_groups?: ModelGroupsConfigInput;
    configPath?: string;
  };
  projectStore?: DynamicProjectStore;
  candidateOrder?: readonly ProviderId[];
  models?: ModelRegistry;
}

interface ProjectResolution {
  project: ResolvedProject;
  workspace: string;
  effectiveMax: TrustProfile;
  revision?: number;
  snapshot: ProjectSnapshot;
}

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

const eligibilityError = ({ decision }: EligibilityAnswer): ToolError => {
  const outcome = decision.outcome;
  if (outcome.kind === "eligible") return new ToolError("TOOL_FAILURE", "eligibility mapping error");
  return new ToolError(outcome.failureCode, outcome.message, {
    eligibility: decision.excluded.map((e) => ({
      provider: e.provider,
      code: e.primary.code,
      detail: e.primary.detail.slice(0, 300),
    })),
  });
};

function mapError(err: unknown): AdmitWorkOutcome {
  if (err instanceof LifecycleError) {
    if (err.code === "QUEUE_FULL") return { kind: "retry" };
    // T14.4 (FR-CTL-06): an operator budget refusal holds the item in the queue; it is tried again when the cap resets.
    if (err.code === "BUDGET_EXHAUSTED") return { kind: "retry" };
    // T14.6 (FR-CTL-05, LLD §18.4 step 4): a pause holds the item in the queue; it is tried again after resume.
    if (err.code === "PAUSED") return { kind: "retry" };
    return { kind: "failed", code: err.code };
  }
  if (err instanceof ToolError) {
    const reason = (err.details as { reason?: string }).reason;
    if (err.code === "PERMISSION_BLOCKED" && reason === "approval_required") return { kind: "retry" };
    return { kind: "failed", code: err.code };
  }
  return { kind: "failed", code: "TOOL_FAILURE" };
}

export async function admitWorkItemRequest(
  deps: AdmitWorkDeps,
  creatorClientId: string,
  projectId: string,
  request: Record<string, unknown>,
  idempotencyKey: string,
): Promise<AdmitWorkOutcome> {
  const client = deps.config.mcpClients.get(creatorClientId);
  if (!client) return { kind: "failed", code: "PERMISSION_BLOCKED" };
  const maxTrustProfile = client.maxTrustProfile;
  const { lifecycle, ledger, registry } = deps;

  const projectTools =
    deps.projectStore === undefined
      ? undefined
      : createProjectTools({
          store: deps.projectStore,
          clientId: creatorClientId,
          client,
          allowedRoots: deps.config.allowedRoots,
          ...(deps.config.dataDir !== undefined ? { dataDir: deps.config.dataDir } : {}),
          configuredIds: () => new Set((deps.config.projects ?? []).map((p) => p.id)),
          disabledProviders: new Set(
            [...(deps.config.providers ?? new Map())].filter(([, v]) => !v.enabled).map(([id]) => id),
          ),
          admitting: () => 0,
        });

  const candidates = (): ProviderId[] => {
    const registered = new Set(registry.list().map((a) => a.id));
    const order = deps.candidateOrder ?? [...registered];
    return order.filter((id) => registered.has(id));
  };

  const checkCeiling = (profile: TrustProfile, project?: ProjectResolution): void => {
    if (project !== undefined && profileRank(profile) > profileRank(project.effectiveMax)) {
      throw new ToolError("PERMISSION_BLOCKED", `trust profile exceeds project ceiling`, {
        project: project.snapshot.id,
        effective_max_profile: project.effectiveMax,
      });
    }
    if (profileRank(profile) > profileRank(maxTrustProfile)) {
      throw new ToolError("PERMISSION_BLOCKED", `trust profile exceeds client ceiling`, {
        client_max_profile: maxTrustProfile,
      });
    }
  };

  const resolveProject = async (pid: string, profile: TrustProfile): Promise<ProjectResolution> => {
    const dynamic = await projectTools?.resolveForRequest(pid);
    const project = dynamic?.project ?? (deps.config.projects ?? []).find((p) => p.id === pid);
    if (!project) throw invalid(`unknown project ${JSON.stringify(pid)}`, { field: "project" });
    if (dynamic === undefined && !(client.projects ?? []).includes(project.id)) {
      throw new ToolError("PERMISSION_BLOCKED", `project not in client list`, { project: project.id });
    }
    const environment = snapshotEnvironment(project);
    if (
      environment.environment_kind === "container" &&
      lifecycle.environmentPlacement({ id: project.id, ...environment })?.environment.kind !== "container"
    ) {
      throw new ToolError("TOOL_FAILURE", CONTAINER_NOT_IMPLEMENTED, {
        project: project.id,
        reason: "ENVIRONMENT_NOT_IMPLEMENTED",
      });
    }
    const context = primaryContext(project);
    const workspace = await lifecycle.canonicalWorkspace(context.path, profile);
    await gitText(["rev-parse", "--verify", "--end-of-options", `${context.baseRef}^{commit}`], { cwd: workspace });
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
        writable: context.writable,
        ...(context.identity !== undefined ? { identity: { ...context.identity } } : {}),
        push: { policy: context.push.policy },
        ...(context.finalizeCommit ? { finalize_commit: true as const } : {}),
        ...(context.sign ? { sign: true as const } : {}),
      },
    };
  };

  const projectCandidates = (
    project: ProjectResolution | undefined,
    required: ProviderId | undefined,
  ): { candidates: ProviderId[]; excluded: ProviderId[] } => {
    const all = candidates();
    const allowed = project?.project.allowedProviders;
    if (allowed === undefined) return { candidates: all, excluded: [] };
    const set = new Set<string>(allowed.flatMap((id) => adapterIdForConfigId(id) ?? []));
    if (required !== undefined && !set.has(required)) {
      throw new ToolError("PERMISSION_BLOCKED", `provider not allowed in project`, { project: project?.snapshot.id });
    }
    const kept = all.filter((id) => set.has(id));
    if (kept.length === 0) {
      throw new ToolError("ELIGIBILITY_NONE", `no provider allowed`, { project: project?.snapshot.id });
    }
    const excluded = all.filter((id) => !set.has(id));
    return { candidates: kept, excluded };
  };

  const route = (
    answer: EligibilityAnswer,
    opts: {
      preference: string | undefined;
      privileged: boolean;
      features: RouteFeatures;
      project?: { id: string; excluded: readonly ProviderId[]; revision?: number };
      affinity: { projectId: string | null; workspace: string; applies: boolean; requiredProvider: string | null };
    },
  ): RouteDecisionResult & { provider: ProviderId } => {
    const eligible = admissible(answer, opts.privileged);
    const settings = {
      weights: deps.config.routing?.weights ?? DEFAULT_WEIGHTS,
      windowSeconds: deps.config.capacity?.windowSeconds ?? DEFAULT_CAPACITY_WINDOW_SECONDS,
      confidenceRuns: deps.config.capacity?.confidenceRuns ?? DEFAULT_CAPACITY_CONFIDENCE_RUNS,
      ...(deps.config.providers !== undefined ? { providers: deps.config.providers } : {}),
      ...(deps.config.limits !== undefined ? { limits: deps.config.limits } : {}),
    };
    const now = new Date();
    const scoreInputs = collectScoreInputs(ledger, eligible, settings, now, null);
    const affinity = collectAffinityFacts(
      ledger,
      { ...opts.affinity, admissible: eligible, decision: answer.decision, scoreInputs },
      deps.config.routing?.affinity ?? DEFAULT_AFFINITY,
    );
    const result = buildRouteDecision({
      input: answer.input,
      decision: answer.decision,
      admissible: eligible,
      preference: opts.preference ?? null,
      features: opts.features,
      affinity,
      scoreInputs,
      weights: settings.weights,
      ...(opts.project !== undefined ? { project: opts.project } : {}),
    });
    if (result.provider === null) throw eligibilityError(answer);
    return { ...result, provider: result.provider as ProviderId };
  };

  const pinModel = async (
    routed: RouteDecisionResult & { provider: ProviderId },
    question: Omit<EligibilityQuestion, "candidates" | "requiredProvider" | "model">,
    privileged: boolean,
    minimumCapability?: ModelCapability,
    satisfyingModel?: string,
  ): Promise<{ routed: RouteDecisionResult & { provider: ProviderId }; model: string | undefined }> => {
    const adapter = registry.get(routed.provider);
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

  try {
    const profile = request.trust_profile as TrustProfile;
    const resolved = await resolveProject(projectId, profile);
    const workspace = resolved.workspace;
    checkCeiling(profile, resolved);
    const scopeArg = request.privileged_scope;
    if (profile === "privileged" && scopeArg === undefined) {
      throw invalid("privileged requires privileged_scope", { field: "privileged_scope" });
    }
    const scope = scopeArg === undefined ? undefined : parsePrivilegedScope(scopeArg);
    if (scope && !scope.ok) throw invalid("invalid privileged_scope", { field: "privileged_scope" });
    const verification = (request.verification_commands as string[][]) ?? [];
    if (verification.length > 0 && profile === "inspect-untrusted") {
      throw invalid("verification_commands refused under inspect-untrusted", { field: "verification_commands" });
    }
    const verificationProblem = verificationCommandsProblem(verification);
    if (verificationProblem !== undefined) throw invalid(verificationProblem, { field: "verification_commands" });

    const routing = (request.routing ?? {}) as {
      require_provider?: boolean;
      provider_preference?: ProviderId;
      minimum_capability?: ModelCapability;
      model_group?: string;
      model?: string;
    };

    // T7.14 (FR-RTE-11, LLD §17.7, FRD V14, BR-49)
    const modelGroups: ResolvedModelGroups = modelGroupsOf(deps.config);
    // biome-ignore lint/suspicious/noExplicitAny: lifecycle options hold eligibility deps
    const models = deps.models ?? (deps.lifecycle as any).opts?.eligibility?.models;

    if (routing.model_group !== undefined && routing.model !== undefined) {
      throw invalid("give at most one of routing.model_group and routing.model", { field: "routing" });
    }
    if (routing.model_group !== undefined) {
      const group = modelGroups[routing.model_group];
      if (group === undefined) {
        throw invalid(`unknown model_group ${routing.model_group}`, { field: "routing.model_group" });
      }
      const named = routing.provider_preference;
      if (named !== undefined) {
        const remaining = groupMembersFor(group, named);
        if (remaining.length === 0) {
          throw invalid(`model_group ${routing.model_group} has no members for provider ${named}`, {
            field: "routing.model_group",
          });
        }
      }
    }
    if (routing.model !== undefined && routing.provider_preference === undefined && routing.require_provider !== true) {
      const targetModel = routing.model;
      const enabledProviders = registry
        .list()
        .map((a) => a.id)
        .filter((id) => deps.config.providers?.get(id)?.enabled !== false);
      const resolving = enabledProviders.filter((p) => {
        if (!models?.restricted(p)) return false;
        const res = models.resolve(p, targetModel);
        return res.ok && res.source !== "unrestricted";
      });
      if (resolving.length !== 1) {
        throw invalid("name a provider for this model", { field: "routing.model" });
      }
    }
    const canonical = {
      tool: "delegate_task",
      objective: request.objective,
      workspace_path: workspace,
      project: resolved.snapshot.id,
      constraints: request.constraints,
      trust_profile: profile,
      verification_commands: request.verification_commands,
      routing,
      priority: request.priority,
      ...(scope?.ok ? { privileged_scope: scope.scope } : {}),
    };
    const hash = requestHash(canonical);
    const required = routing.require_provider === true ? (routing.provider_preference as ProviderId) : undefined;
    const privileged = scope?.ok === true;
    const minimumCapability = routing.minimum_capability;
    const narrowed = projectCandidates(resolved, required);
    const answer = await lifecycle.checkEligibility({
      candidates: narrowed.candidates,
      ...(required !== undefined ? { requiredProvider: required } : {}),
      trustProfile: profile,
      clientMaxProfile: resolved.effectiveMax,
      cwd: workspace,
      ...(minimumCapability !== undefined ? { minimumCapability } : {}),
    });
    if (answer.decision.outcome.kind !== "eligible" && admissible(answer, privileged).length === 0) {
      throw eligibilityError(answer);
    }
    if (required !== undefined && !admissible(answer, privileged).includes(required)) throw eligibilityError(answer);
    const routed0 = route(answer, {
      preference: routing.provider_preference,
      privileged,
      features: await lifecycle.routeFeatures(
        {
          objective: request.objective as string,
          constraints: (request.constraints as string[]) ?? [],
          verificationCommands: verification.length,
          writable: profile !== "inspect-untrusted",
        },
        { project: resolved.snapshot },
      ),
      affinity: {
        projectId: resolved.snapshot.id,
        workspace,
        applies: true,
        requiredProvider: required ?? null,
      },
      project: {
        id: resolved.snapshot.id,
        excluded: narrowed.excluded,
        ...(resolved.revision !== undefined ? { revision: resolved.revision } : {}),
      },
    });
    const capModel = answer.input.facts.find((f) => f.provider === routed0.provider)?.model;
    const { routed, model } = await pinModel(
      routed0,
      { trustProfile: profile, clientMaxProfile: resolved.effectiveMax, cwd: workspace },
      privileged,
      minimumCapability,
      capModel,
    );

    const submitted = await lifecycle.submit({
      clientId: creatorClientId,
      objective: request.objective as string,
      workspace,
      trustProfile: profile,
      provider: routed.provider,
      constraints: (request.constraints as string[]) ?? [],
      priority: (request.priority as RunPriority) ?? "normal",
      requestHash: hash,
      routeDecision: routed.record,
      ...(model !== undefined ? { model } : {}),
      project: resolved.snapshot,
      idempotencyKey,
      ...(verification.length > 0 ? { verificationCommands: verification } : {}),
      ...(scope?.ok
        ? {
            privileged: {
              scope: scope.scope,
              ...(client.privilegedApproval === "not_required" ? { approvedByClientPolicy: true } : {}),
            },
          }
        : {}),
    });
    return { kind: "admitted", runId: submitted.runId, replayed: submitted.replayed };
  } catch (err) {
    return mapError(err);
  }
}
