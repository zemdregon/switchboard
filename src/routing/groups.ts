/**
 * Model-group candidates (T7.15; FR-RTE-11, BR-49, LLD §17.7, ADR-0055). With `routing.model_group` (or an explicit
 * `routing.model`) a candidate is a member keyed `<provider>/<model>`, not a provider. Stage 1 per member is the
 * provider's own stage-1 reasons, registry resolution of the model, the `minimum_capability` floor against it and the
 * adapter's compile check with it, in that order: exactly what one eligibility pass with the provider required and the
 * model requested returns (`collectFacts`). This module turns those per-member passes into one member-level eligibility
 * input and decision for stage 2. Pure: the caller runs the passes.
 */
import { adapterIdForConfigId } from "../adapters/providers.js";
import type { ProviderId } from "../adapters/types.js";
import type { EligibilityDecision, EligibilityInput, ExcludedProvider } from "./eligibility.js";

/** One group member as a stage-2 candidate (stored in `features_json.members`, LLD §17.7). */
export interface RouteMember {
  /** `<provider>/<model>`, with the adapter provider id and the configured or requested model. */
  key: string;
  /** Adapter provider id (as `run.provider`). */
  provider: string;
  /** The resolved model id (the registry's resolution; the configured id when unrestricted or not resolved). */
  model: string;
  /** The model id as configured in the group or named in the request. */
  configured: string;
  /** Position in the group: the last tie-break. */
  order: number;
}

/** What `buildRouteDecision` needs to know about a group or explicit-model request (LLD §17.7). */
export interface RouteGroup {
  name: string | null;
  requestedModel: string | null;
  members: RouteMember[];
}

export function memberKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * The group's members as adapter ids, narrowed to `candidates` (the registered providers a project allows) and, with
 * `provider`, to that provider's members (LLD §17.7 Request 3). Member order is kept; `order` is the group position.
 */
export function groupMembers(
  members: readonly { provider: string; model: string }[],
  candidates: readonly string[],
  provider?: string,
): { provider: string; model: string; order: number }[] {
  return members
    .map((m, order) => ({ provider: adapterIdForConfigId(m.provider) ?? m.provider, model: m.model, order }))
    .filter((m) => candidates.includes(m.provider) && (provider === undefined || m.provider === provider));
}

/** One member's stage-1 pass: eligibility with the member's provider required and its model requested. */
export interface MemberPass {
  member: { provider: string; model: string; order: number };
  input: EligibilityInput;
  decision: EligibilityDecision;
}

export interface GroupEligibility {
  members: RouteMember[];
  /** Candidates are member keys; `facts` holds one entry per provider (the pacing deferral is per provider). */
  input: EligibilityInput;
  decision: EligibilityDecision;
  /** Member keys selection may pick: the eligible ones, or for `privileged` also those refused only by compile. */
  admissible: string[];
}

/**
 * Assemble the member-level stage-1 result. `requiredProvider` is the request's `require_provider` target (BR-2): the
 * outcome is then `required_provider_ineligible` when none of its members is eligible. For `privileged`, a member
 * excluded only by the adapter's compile verdict is admissible, as for providers (FRD V11, compile deferred to dispatch).
 */
export function groupEligibility(
  passes: readonly MemberPass[],
  requiredProvider: string | null,
  privileged: boolean,
): GroupEligibility {
  const members: RouteMember[] = [];
  const eligible: string[] = [];
  const excluded: ExcludedProvider[] = [];
  const facts = new Map<string, EligibilityInput["facts"][number]>();
  const admissible: string[] = [];
  for (const p of passes) {
    const f = p.input.facts.find((x) => x.provider === p.member.provider);
    if (f !== undefined && !facts.has(f.provider)) facts.set(f.provider, f);
    const key = memberKey(p.member.provider, p.member.model);
    members.push({
      key,
      provider: p.member.provider,
      model: f?.model ?? p.member.model,
      configured: p.member.model,
      order: p.member.order,
    });
    const ex = p.decision.excluded.find((e) => e.provider === p.member.provider);
    if (p.decision.eligible.includes(p.member.provider as ProviderId) && ex === undefined) {
      eligible.push(key);
      admissible.push(key);
      continue;
    }
    const primary = ex?.primary ?? {
      code: "ADAPTER_NOT_REGISTERED" as const,
      detail: `no eligibility facts for ${key}`,
      evidence: { provider: p.member.provider },
    };
    excluded.push({
      provider: key as ProviderId,
      primary,
      reasons: ex?.reasons ?? [primary],
      failureCode: ex?.failureCode ?? "ELIGIBILITY_NONE",
    });
    const compileOnly = ex?.reasons.every((r) => r.code === "PROFILE_UNSUPPORTED" || r.code === "CAPABILITY_MISSING");
    if (privileged && compileOnly === true) admissible.push(key);
  }
  const first = passes[0]?.input;
  const { model: _model, ...requirements } = first?.requirements ?? { network: "off" as const, writable: false };
  const input: EligibilityInput = {
    candidates: members.map((m) => m.key as ProviderId),
    ...(requiredProvider !== null ? { requiredProvider: requiredProvider as ProviderId } : {}),
    trustProfile: first?.trustProfile ?? "inspect-untrusted",
    clientMaxProfile: first?.clientMaxProfile ?? "inspect-untrusted",
    requirements,
    platform: first?.platform ?? process.platform,
    facts: [...facts.values()],
  };
  const request = passes.map((p) => p.decision.requestReason).find((r) => r !== undefined);
  let outcome: EligibilityDecision["outcome"] = { kind: "eligible", providers: eligible as ProviderId[] };
  const ceiling = passes.map((p) => p.decision.outcome).find((o) => o.kind === "client_ceiling_exceeded");
  if (ceiling !== undefined) outcome = ceiling;
  else if (eligible.length === 0) {
    const why = excluded.map((e) => `${e.provider}: ${e.primary.code}`).join("; ");
    const ex = excluded[0];
    outcome =
      requiredProvider !== null && ex !== undefined
        ? {
            kind: "required_provider_ineligible",
            provider: requiredProvider as ProviderId,
            failureCode: ex.failureCode,
            message: `required provider ${requiredProvider} has no eligible member: ${why}`,
          }
        : {
            kind: "none_eligible",
            failureCode: "ELIGIBILITY_NONE",
            message: `no group member is eligible${why ? ` (${why})` : ""}`,
          };
  }
  return {
    members,
    input,
    decision: {
      eligible: eligible as ProviderId[],
      excluded,
      ...(request !== undefined ? { requestReason: request } : {}),
      outcome,
    },
    admissible,
  };
}

/** The routing fields of a request that select members (LLD §17.7 Request). */
export interface GroupRequest {
  model_group?: string;
  model?: string;
  provider_preference?: string;
}

/**
 * The members a group or explicit-model request names, narrowed to `candidates` and to `provider_preference` (LLD §17.7
 * Request 3), or undefined for a request with neither field (candidates are providers). An explicit `model` makes one
 * candidate for the named provider, else for `modelProvider`, the one provider whose registry resolves it (validated
 * before admission, FRD V14). The request was validated by the caller: an unknown group never reaches here.
 */
export function requestedMembers(
  routing: GroupRequest | undefined,
  groups: Readonly<Record<string, { members: readonly { provider: string; model: string }[] }>>,
  candidates: readonly string[],
  modelProvider: (model: string) => string | undefined,
):
  | {
      name: string | null;
      requestedModel: string | null;
      members: { provider: string; model: string; order: number }[];
    }
  | undefined {
  if (routing?.model_group !== undefined) {
    const group = groups[routing.model_group];
    return {
      name: routing.model_group,
      requestedModel: null,
      members: groupMembers(group?.members ?? [], candidates, routing.provider_preference),
    };
  }
  if (routing?.model !== undefined) {
    const provider = routing.provider_preference ?? modelProvider(routing.model);
    return {
      name: null,
      requestedModel: routing.model,
      members: provider === undefined ? [] : groupMembers([{ provider, model: routing.model }], candidates),
    };
  }
  return undefined;
}

/** Run one stage-1 pass per member (provider required, model requested) and assemble the member-level result. */
export async function groupStage1(
  members: readonly { provider: string; model: string; order: number }[],
  requiredProvider: string | null,
  privileged: boolean,
  check: (provider: string, model: string) => Promise<{ input: EligibilityInput; decision: EligibilityDecision }>,
): Promise<GroupEligibility> {
  const passes: MemberPass[] = [];
  for (const member of members) passes.push({ member, ...(await check(member.provider, member.model)) });
  return groupEligibility(passes, requiredProvider, privileged);
}
