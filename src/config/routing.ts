/**
 * `routing` configuration (M7, T7.1 and T7.4; LLD §17.1, ADR-0044). The JSON schema in `schema.ts` checks types and
 * ranges; this module adds the one cross-field rule (the two estimate thresholds are set together or not at all) and
 * resolves defaults. Every default is an Assumption with no source behind it (Q-80, Q-81).
 */
import { readFileSync } from "node:fs";
import { adapterIdForConfigId } from "../adapters/providers.js";
import { DEFAULT_WEIGHTS, SCORE_TERMS, type Weights } from "../routing/score.js";
import type { ModelGroupsConfigInput, RoutingConfigInput, SwitchboardConfig } from "./schema.js";

/** LLD §17.7 default for the seventh weight `routing.weights.pacing` (Assumption, Q-80). */
export const DEFAULT_PACING_WEIGHT = 1;

/** Weights including the optional seventh weight `pacing` (LLD §17.7). Compatible with `Weights`. */
export type RoutingWeights = Weights & { pacing?: number };

/** Resolved `routing.affinity` (LLD §3.2): the estimate trigger is on only when both thresholds are set. */
export interface AffinitySettings {
  enabled: boolean;
  lowWaterMark: number | null;
  minConfidence: number | null;
}

/** Resolved `routing` section; every key set. */
export interface RoutingSettings {
  weights: RoutingWeights;
  affinity: AffinitySettings;
}

export function resolveRouting(input: RoutingConfigInput | undefined): RoutingSettings {
  const weights = Object.fromEntries(SCORE_TERMS.map((t) => [t, input?.weights?.[t] ?? DEFAULT_WEIGHTS[t]])) as Weights;
  const pacing = input?.weights?.pacing;
  return {
    weights: pacing !== undefined ? { ...weights, pacing } : weights,
    affinity: {
      enabled: input?.affinity?.enabled ?? true,
      lowWaterMark: input?.affinity?.low_water_mark ?? null,
      minConfidence: input?.affinity?.min_confidence ?? null,
    },
  };
}

/** Cross-field checks the JSON schema cannot express; one message per problem, JSON-path prefixed. */
export function checkRouting(input: RoutingConfigInput | undefined): string[] {
  const a = input?.affinity;
  const low = a?.low_water_mark ?? null;
  const conf = a?.min_confidence ?? null;
  return (low === null) !== (conf === null)
    ? ["$.routing.affinity: low_water_mark and min_confidence must be set together (LLD §3.2), or both left null"]
    : [];
}

/** One configured model group member (LLD §17.7). */
export interface ResolvedModelGroupMember {
  readonly provider: string;
  readonly model: string;
}

/** One configured model group (LLD §17.7). */
export interface ResolvedModelGroup {
  readonly members: readonly ResolvedModelGroupMember[];
}

/** Configured model groups keyed by group name. */
export type ResolvedModelGroups = Readonly<Record<string, ResolvedModelGroup>>;

/**
 * Resolves raw `model_groups` configuration into `ResolvedModelGroups`.
 * Absent or empty returns an empty record.
 */
export function resolveModelGroups(input: ModelGroupsConfigInput | undefined): ResolvedModelGroups {
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input).map(([name, group]) => [
      name,
      {
        members: group.members.map((m) => ({ provider: m.provider, model: m.model })),
      },
    ]),
  );
}

/**
 * Reads model groups from a config file path.
 * Returns an empty record if the file cannot be read or parsed.
 */
export function readModelGroupsFromConfigPath(configPath: string): ResolvedModelGroups {
  try {
    const text = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(text) as SwitchboardConfig;
    return resolveModelGroups(parsed.model_groups);
  } catch {
    return {};
  }
}

/**
 * The model group table a consumer resolves (T7.14): `modelGroups` if given, else raw `model_groups` if given, else the
 * file at `configPath`, else none. Each step is taken only when the one before it is absent.
 */
export function modelGroupsOf(config: {
  readonly modelGroups?: ResolvedModelGroups;
  readonly model_groups?: ModelGroupsConfigInput;
  readonly configPath?: string;
}): ResolvedModelGroups {
  if (config.modelGroups !== undefined) return config.modelGroups;
  if (config.model_groups !== undefined) return resolveModelGroups(config.model_groups);
  return config.configPath !== undefined ? readModelGroupsFromConfigPath(config.configPath) : {};
}

/**
 * Members of `group` on adapter id `provider` (FR-RTE-11). Members name config provider ids (`claude-code`) while
 * `routing.provider_preference` names adapter ids (`claude`), so each member is mapped first; an id with no config
 * mapping (the test-only fake) is compared as is.
 */
export function groupMembersFor(group: ResolvedModelGroup, provider: string): ResolvedModelGroupMember[] {
  return group.members.filter((m) => (adapterIdForConfigId(m.provider) ?? m.provider) === provider);
}
