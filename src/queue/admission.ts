/**
 * T15.1 (FR-QUE-01, LLD §18.4): admit a queued `request_json` through the same pipeline as MCP `delegate_task`, under
 * `creator_client_id`. Shared by the scheduler; MCP `server.ts` may adopt this module in a later lane.
 */
import type Database from "better-sqlite3";
import { type AdapterRegistry, acceptsReportedModel, canonicalProviderId, type ProviderId } from "../adapters/index.js";
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
import { invalid, ToolError, toToolError } from "../mcp/errors.js";
import { admitBrief, createProjectTools, snapshotSetup } from "../mcp/project-tools.js";
import { createScrubber } from "../mcp/scrub.js";
import type { ModelCapability, ModelRegistry } from "../models/registry.js";
import { type ProjectSnapshot, parsePrivilegedScope, privilegedEligibilityProfile } from "../policy/index.js";
import type { DynamicProjectStore } from "../projects/index.js";
import {
  buildRouteDecision,
  collectAffinityFacts,
  collectPacingInputs,
  collectScoreInputs,
  DEFAULT_AFFINITY,
  DEFAULT_WEIGHTS,
  type GroupEligibility,
  groupStage1,
  planModelPin,
  profileRank,
  type RouteDecisionResult,
  type RouteFeatures,
  requestedMembers,
  withModelPin,
} from "../routing/index.js";
import {
  hasSkillFields,
  SkillAdmissionError,
  type SkillAdmissionSettings,
  skillAdmissionPort,
  skillRequestFields,
} from "../skills/admission.js";
import { gitText } from "../workspace/git.js";

export type AdmitWorkOutcome =
  | { kind: "admitted"; runId: string; replayed: boolean }
  | { kind: "retry" }
  | { kind: "failed"; code: string; detail?: AdmissionFailureDetail };

/**
 * Why a queued item failed admission, recorded on its `admission_failed` event beside `code`. Built only from the
 * controller's own error: the message delegate_task would return (scrubbed: credential-shaped tokens redacted, paths
 * outside the allowed roots replaced, bounded), `field` when the error names one, and for an unexpected exception only
 * its class name (never its message or stack). Never request text or provider output.
 *
 * ADR-0069 (Linus decision under owner ruling 2026-10-20): `reason` and `stage` are CLOSED codes
 * ({@link ADMISSION_FAILURE_REASONS}, {@link ADMISSION_STAGES}), never text copied from an error: a known controller
 * reason code of the error is kept when it is in the list, otherwise the reason is the stage's own code, and an
 * unexpected exception is `INTERNAL_ERROR` at the stage it happened in.
 */
export type AdmissionFailureDetail = {
  message: string;
  reason: AdmissionFailureReason;
  stage: AdmissionStage;
  field?: string;
  error_class?: string;
};

/** The admission steps, in order; the stage of a failure is the step that was running. */
export const ADMISSION_STAGES = [
  "client",
  "project",
  "ceiling",
  "request",
  "routing",
  "skills",
  "eligibility",
  "route",
  "submit",
] as const;
export type AdmissionStage = (typeof ADMISSION_STAGES)[number];

/** Controller reason codes an error may carry in `details.reason` that are kept as is. */
const PASSTHROUGH_REASONS = [
  "ENVIRONMENT_NOT_IMPLEMENTED",
  "PROJECT_BRIEF_UNAVAILABLE",
  "NOT_MANAGEABLE",
  "PROJECT_PAUSED",
  "GROUP_MEMBERS",
  "PROJECT_PROVIDERS",
  "SKILLS_DISABLED",
  "QUEUE_FULL",
  "BASE_REF_UNRESOLVED",
] as const;

/** Each stage's own reason, used when the error carries no pass-through code. */
const STAGE_REASONS = {
  client: "CLIENT_UNKNOWN",
  project: "PROJECT_UNRESOLVED",
  ceiling: "CEILING_EXCEEDED",
  request: "REQUEST_INVALID",
  routing: "ROUTING_INVALID",
  skills: "SKILL_REFUSED",
  eligibility: "NO_ELIGIBLE_PROVIDER",
  route: "ROUTE_FAILED",
  submit: "SUBMIT_REFUSED",
} as const satisfies Record<AdmissionStage, string>;

/** The closed `reason` vocabulary of {@link AdmissionFailureDetail}. */
export const ADMISSION_FAILURE_REASONS = [
  ...PASSTHROUGH_REASONS,
  ...Object.values(STAGE_REASONS),
  "INTERNAL_ERROR",
] as const;
export type AdmissionFailureReason = (typeof ADMISSION_FAILURE_REASONS)[number];

const FAILURE_MESSAGE_MAX = 300;

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
  /**
   * T14.17 (FR-CTL-15, Linus decision v10 (c)): freeze the project snapshot read-only (not writable, no identity, push
   * policy `none`, no finalize commit, no signing), so the run is never offered the Git channel and never publishes.
   */
  readOnlyProject?: boolean;
  models?: ModelRegistry;
  /**
   * T16.4 (FR-SKL-03, LLD §19.4): the skill store (the ledger's own handle) and the resolved `skills` settings. Absent,
   * or `enabled` false, means a queued request with `skills`, `role` or `skill_defaults` fails `INVALID_REQUEST`.
   */
  skills?: { db: Database.Database; settings: SkillAdmissionSettings & { readonly enabled: boolean } };
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

function mapError(err: unknown, scrub: (s: string) => string, stage: AdmissionStage): AdmitWorkOutcome {
  if (err instanceof LifecycleError) {
    if (err.code === "QUEUE_FULL") return { kind: "retry" };
    // T14.4 (FR-CTL-06): an operator budget refusal holds the item in the queue; it is tried again when the cap resets.
    if (err.code === "BUDGET_EXHAUSTED") return { kind: "retry" };
    // T14.6 (FR-CTL-05, LLD §18.4 step 4): a pause holds the item in the queue; it is tried again after resume.
    if (err.code === "PAUSED") return { kind: "retry" };
  }
  if (err instanceof ToolError) {
    const reason = (err.details as { reason?: string }).reason;
    if (err.code === "PERMISSION_BLOCKED" && reason === "approval_required") return { kind: "retry" };
  }
  // T16.4 (LLD §19.5): a skill refusal fails the item with its code, as the same request fails delegate_task. A
  // lifecycle refusal keeps its own code; anything else maps as delegate_task maps it (unexpected: TOOL_FAILURE).
  const mapped = toToolError(err);
  const code = err instanceof SkillAdmissionError || err instanceof LifecycleError ? err.code : mapped.code;
  return { kind: "failed", code, detail: failureDetail(err, mapped, scrub, stage) };
}

function failureDetail(
  err: unknown,
  mapped: ToolError,
  scrub: (s: string) => string,
  stage: AdmissionStage,
): AdmissionFailureDetail {
  const details = mapped.details as { reason?: unknown; field?: unknown };
  const text = (v: unknown): string | undefined =>
    typeof v === "string" ? scrub(v).slice(0, FAILURE_MESSAGE_MAX) : undefined;
  const field = text(details.field);
  const known = err instanceof ToolError || err instanceof LifecycleError || err instanceof SkillAdmissionError;
  const errorClass =
    !known && err instanceof Error && mapped.code === "TOOL_FAILURE" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name)
      ? err.name
      : undefined;
  const passthrough = (PASSTHROUGH_REASONS as readonly unknown[]).includes(details.reason)
    ? (details.reason as AdmissionFailureReason)
    : undefined;
  const reason: AdmissionFailureReason = !known ? "INTERNAL_ERROR" : (passthrough ?? STAGE_REASONS[stage]);
  return {
    message: text(err instanceof LifecycleError ? err.message : mapped.message) ?? "",
    reason,
    stage,
    ...(field !== undefined ? { field } : {}),
    ...(errorClass !== undefined ? { error_class: errorClass } : {}),
  };
}

export async function admitWorkItemRequest(
  deps: AdmitWorkDeps,
  creatorClientId: string,
  projectId: string,
  request: Record<string, unknown>,
  idempotencyKey: string,
  /**
   * T15.7 (LLD §20.4): a rebase item continues the meta-session that published the conflicting ref and asks the
   * lifecycle to merge the current base into its worktree (`run_rebase`). Continuations take no idempotency key; the
   * scheduler checks `run_rebase` for the item first instead.
   */
  rebase?: { workItemId: string; metaSessionId: string; publishRef: string; headSha: string },
): Promise<AdmitWorkOutcome> {
  const client = deps.config.mcpClients.get(creatorClientId);
  if (!client) {
    return {
      kind: "failed",
      code: "PERMISSION_BLOCKED",
      detail: { message: "the item's creator client is not configured", reason: "CLIENT_UNKNOWN", stage: "client" },
    };
  }
  const maxTrustProfile = client.maxTrustProfile;
  const { lifecycle, ledger, registry } = deps;
  const scrub = createScrubber(deps.config.allowedRoots);

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
    try {
      await gitText(["rev-parse", "--verify", "--end-of-options", `${context.baseRef}^{commit}`], { cwd: workspace });
    } catch {
      // As delegate_task (V12): INVALID_REQUEST naming the field, never a raw Git error mapped to TOOL_FAILURE.
      throw invalid(`project ${project.id}: base ref ${JSON.stringify(context.baseRef)} does not resolve to a commit`, {
        field: "project",
        reason: "BASE_REF_UNRESOLVED",
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
        ...(deps.readOnlyProject === true
          ? { writable: false, push: { policy: "none" as const } }
          : {
              writable: context.writable,
              ...(context.identity !== undefined ? { identity: { ...context.identity } } : {}),
              push: { policy: context.push.policy },
              ...(context.finalizeCommit ? { finalize_commit: true as const } : {}),
              ...(context.sign ? { sign: true as const } : {}),
              // ADR-0071: the setup step as of admission; a read-only (critic) run gets none.
              ...snapshotSetup(project),
            }),
        ...admitBrief(project, deps.config.allowedRoots),
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
    // ADR-0076: either spelling is compared by canonical name; a name no entry knows is never allowed.
    const set = new Set<string>(allowed.flatMap((id) => canonicalProviderId(id) ?? []));
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
      /** T7.15 (LLD §17.7): a group or explicit-model request; candidates are its members. */
      group?: GroupEligibility & { name: string | null; requestedModel: string | null };
    },
  ): RouteDecisionResult & { provider: ProviderId } => {
    const group = opts.group;
    if (group !== undefined) return routeWith({ input: group.input, decision: group.decision }, group.admissible, opts);
    return routeWith(answer, admissible(answer, opts.privileged), opts);
  };

  const routeWith = (
    answer: EligibilityAnswer,
    eligible: string[],
    opts: Parameters<typeof route>[1],
  ): RouteDecisionResult & { provider: ProviderId } => {
    const group = opts.group;
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
    const now = new Date();
    const scoreInputs = collectScoreInputs(ledger, providers, settings, now, null);
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
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      ...(group !== undefined
        ? { group: { name: group.name, requestedModel: group.requestedModel, members: group.members } }
        : {}),
      ...(pacing !== undefined ? { pacing } : {}),
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

  let stage: AdmissionStage = "project";
  try {
    const profile = request.trust_profile as TrustProfile;
    const resolved = await resolveProject(projectId, profile);
    const workspace = resolved.workspace;
    stage = "ceiling";
    checkCeiling(profile, resolved);
    stage = "request";
    const scopeArg = request.privileged_scope;
    // V13, as delegate_task: privileged_scope present exactly when the profile is privileged.
    if (profile === "privileged" && scopeArg === undefined) {
      throw invalid("trust_profile privileged requires privileged_scope", { field: "privileged_scope" });
    }
    if (profile !== "privileged" && scopeArg !== undefined) {
      throw invalid(`privileged_scope is allowed only with trust_profile privileged (got ${profile})`, {
        field: "privileged_scope",
      });
    }
    const scope = scopeArg === undefined ? undefined : parsePrivilegedScope(scopeArg);
    if (scope && !scope.ok) {
      throw invalid(`invalid privileged_scope: ${scope.field} ${scope.message}`, { field: scope.field });
    }
    const verification = (request.verification_commands as string[][]) ?? [];
    if (verification.length > 0 && profile === "inspect-untrusted") {
      throw invalid("verification_commands refused under inspect-untrusted", { field: "verification_commands" });
    }
    const verificationProblem = verificationCommandsProblem(verification);
    if (verificationProblem !== undefined) throw invalid(verificationProblem, { field: "verification_commands" });

    stage = "routing";
    const routing = { ...((request.routing ?? {}) as object) } as {
      require_provider?: boolean;
      provider_preference?: ProviderId;
      minimum_capability?: ModelCapability;
      model_group?: string;
      model?: string;
    };
    // ADR-0076: enqueue_work stores the canonical name; an item stored by another path is normalised here on read.
    if (routing.provider_preference !== undefined) {
      routing.provider_preference = canonicalProviderId(routing.provider_preference) ?? routing.provider_preference;
    }

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
    /** FRD V14: the enabled providers whose restricted registry resolves `model`. */
    const resolvingProviders = (model: string): string[] =>
      registry
        .list()
        .map((a) => a.id)
        .filter((id) => deps.config.providers?.get(id)?.enabled !== false)
        .filter((p) => {
          if (!models?.restricted(p)) return false;
          const res = models.resolve(p, model);
          return res.ok && res.source !== "unrestricted";
        });
    if (routing.model !== undefined && routing.provider_preference === undefined && routing.require_provider !== true) {
      if (resolvingProviders(routing.model).length !== 1) {
        throw invalid("name a provider for this model", { field: "routing.model" });
      }
    }
    // T16.4 (LLD §19.4): the queued fields resolve here, at the item's own admission, never at enqueue.
    stage = "skills";
    const skillFields = skillRequestFields(request);
    const skillsOn = deps.skills?.settings.enabled === true;
    if (hasSkillFields(skillFields) && !skillsOn) {
      throw invalid("skills, role and skill_defaults need skills.enabled", { reason: "SKILLS_DISABLED" });
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
      ...skillFields,
      ...(request.light === true ? { light: true } : {}), // T3.24: as delegate_task
    };
    const hash = requestHash(canonical);
    const required = routing.require_provider === true ? (routing.provider_preference as ProviderId) : undefined;
    const privileged = scope?.ok === true;
    const minimumCapability = routing.minimum_capability;
    stage = "eligibility";
    const narrowed = projectCandidates(resolved, required);
    const question = {
      trustProfile: profile,
      clientMaxProfile: resolved.effectiveMax,
      cwd: workspace,
      // V11, as delegate_task: compile against the request's scope. Without it `checkEligibility` resolves the bare
      // name `privileged`, which always throws, and every queued privileged item failed TOOL_FAILURE.
      ...(scope?.ok ? { profile: privilegedEligibilityProfile(scope.scope) } : {}),
      ...(minimumCapability !== undefined ? { minimumCapability } : {}),
    };
    // T7.15 (LLD §17.7): with a group or an explicit model, each member is a stage-1 candidate.
    const named = requestedMembers(routing, modelGroups, narrowed.candidates, (m) => {
      const r = resolvingProviders(m);
      return r.length === 1 ? r[0] : undefined;
    });
    if (named !== undefined && named.members.length === 0) {
      throw new ToolError("ELIGIBILITY_NONE", "no member of the requested group or model has an allowed provider", {
        reason: "GROUP_MEMBERS",
      });
    }
    const group =
      named === undefined
        ? undefined
        : {
            ...(await groupStage1(named.members, required ?? null, privileged, (provider, model) =>
              lifecycle.checkEligibility({
                ...question,
                candidates: [provider as ProviderId],
                requiredProvider: provider as ProviderId,
                model,
              }),
            )),
            name: named.name,
            requestedModel: named.requestedModel,
          };
    const answer =
      group ??
      (await lifecycle.checkEligibility({
        candidates: narrowed.candidates,
        ...(required !== undefined ? { requiredProvider: required } : {}),
        ...question,
      }));
    const admitted = group?.admissible ?? admissible(answer, privileged);
    if (answer.decision.outcome.kind !== "eligible" && admitted.length === 0) throw eligibilityError(answer);
    if (group === undefined && required !== undefined && !admitted.includes(required)) throw eligibilityError(answer);
    stage = "route";
    const routed0 = route(answer, {
      ...(group !== undefined ? { group } : {}),
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
    // T7.15 (LLD §17.7 Run fields): a chosen member runs with its resolved model; no remembered-model pin applies.
    const { routed, model } =
      routed0.member !== null
        ? { routed: routed0, model: routed0.member.model }
        : await pinModel(
            routed0,
            // The request's own scope, as stage 1 above: a re-check must never compile the bare name `privileged`.
            {
              trustProfile: profile,
              clientMaxProfile: resolved.effectiveMax,
              cwd: workspace,
              ...(scope?.ok ? { profile: privilegedEligibilityProfile(scope.scope) } : {}),
            },
            privileged,
            minimumCapability,
            capModel,
          );

    stage = "submit";
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
      ...(rebase === undefined
        ? { idempotencyKey }
        : {
            metaSessionId: rebase.metaSessionId,
            rebase: { workItemId: rebase.workItemId, publishRef: rebase.publishRef, headSha: rebase.headSha },
          }),
      ...(skillsOn && deps.skills !== undefined
        ? {
            skills: skillAdmissionPort({
              db: deps.skills.db,
              settings: deps.skills.settings,
              ...(resolved.project.skills !== undefined ? { project: resolved.project.skills } : {}),
              ...(client.skills !== undefined ? { clientSkills: client.skills } : {}),
              fields: skillFields,
            }),
          }
        : {}),
      ...(verification.length > 0 ? { verificationCommands: verification } : {}),
      // T3.24 (FR-CAP-12): the creating client's `allow_light`, read at the item's admission as its other settings.
      ...(request.light === true && client.allowLight === true ? { light: true } : {}),
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
    return mapError(err, scrub, stage);
  }
}
