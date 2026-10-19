/**
 * `ci_trigger` configuration (T15.3; FR-QUE-03, LLD §18.1 and §18.6, ADR-0050). Off by default. Delegated for v1: the
 * per-project trigger (the client it acts as and its fix-up template) is operator configuration here rather than the
 * Proposed `project_ci_trigger` ledger table, so no migration is needed; dedup lives on the T15.1 work item. A template
 * cannot name `privileged` (no privileged scope can be frozen into an unattended trigger), and the named client must
 * already list the project, so the trigger never reaches a project its client cannot.
 *
 * T15.5 (FR-QUE-05): `ci_trigger.max_consecutive_fixes` per publish ref (Assumption default 2); further failures
 * on that ref are recorded in `ci_trigger_event` with no work item, and the project is flagged needs-attention
 * with `ci_fix_stuck` (FR-CTL-03).
 *
 * T15.6 (FR-QUE-06, LLD §20.1, ADR-0050 amendment 1): two per-project switches, both off by default, each enabling one
 * `gh` write verb: `rerun_failed` (`gh run rerun --failed`, once per ref, head SHA and job) and `cancel_stale_queued`
 * (`gh run cancel` of queued runs on superseded heads of the project's published refs).
 */
import type { TrustProfile } from "./schema.js";

export const DEFAULT_CI_POLL_INTERVAL_SECONDS = 120;
/** Assumption default: max consecutive fix-up work items per publish ref before flagging ci_fix_stuck (FR-QUE-05). */
export const DEFAULT_MAX_CONSECUTIVE_FIXES = 2;
export type CiTemplateProfile = Exclude<TrustProfile, "privileged">;

/** `ci_trigger` as written in the config file. */
export interface CiTriggerConfigInput {
  enabled?: boolean;
  poll_interval_seconds?: number;
  gh_binary?: string;
  use_check_runs_fallback?: boolean;
  max_consecutive_fixes?: number;
  projects?: {
    project: string;
    client: string;
    enabled?: boolean;
    max_consecutive_fixes?: number;
    rerun_failed?: boolean;
    cancel_stale_queued?: boolean;
    template: { objective: string; trust_profile: CiTemplateProfile; constraints?: string[] };
  }[];
}

/** A project's trigger: the client it acts as and the delegate_task-shaped template of its fix-up work. */
export interface CiTriggerProjectSettings {
  readonly projectId: string;
  readonly creatorClientId: string;
  readonly enabled: boolean;
  readonly maxConsecutiveFixes: number;
  /** T15.6: rerun the failed jobs of a failed or `CI_INFRA` run once before admitting a fix-up (default false). */
  readonly rerunFailed?: boolean;
  /** T15.6: cancel queued (never in-progress) runs on superseded heads of published refs (default false). */
  readonly cancelStaleQueued?: boolean;
  readonly template: {
    readonly objective: string;
    readonly trustProfile: CiTemplateProfile;
    readonly constraints: readonly string[];
  };
}

/** Resolved `ci_trigger` section; `enabled` false or a zero interval turns every poll off. */
export interface CiTriggerSettings {
  readonly enabled: boolean;
  readonly pollIntervalSeconds: number;
  readonly ghBinary: string;
  readonly useCheckRunsFallback: boolean;
  readonly maxConsecutiveFixes: number;
  readonly projects: readonly CiTriggerProjectSettings[];
}

/** Cross-field checks: a known client that lists a known project, each project at most once. */
export function checkCiTrigger(
  input: CiTriggerConfigInput | undefined,
  clients: ReadonlyMap<string, { projects?: readonly string[] }>,
  projectIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, p] of (input?.projects ?? []).entries()) {
    const at = `$.ci_trigger.projects[${i}]`;
    if (seen.has(p.project)) errors.push(`${at}.project: duplicate project ${JSON.stringify(p.project)}`);
    seen.add(p.project);
    if (!projectIds.has(p.project)) errors.push(`${at}.project: unknown project id ${JSON.stringify(p.project)}`);
    const client = clients.get(p.client);
    if (client === undefined) errors.push(`${at}.client: unknown client id ${JSON.stringify(p.client)}`);
    else if (!(client.projects ?? []).includes(p.project)) {
      errors.push(
        `${at}.client: client ${JSON.stringify(p.client)} does not list project ${JSON.stringify(p.project)}`,
      );
    }
  }
  return errors;
}

export function resolveCiTrigger(input: CiTriggerConfigInput | undefined): CiTriggerSettings {
  const defaultMaxFixes = input?.max_consecutive_fixes ?? DEFAULT_MAX_CONSECUTIVE_FIXES;
  return {
    enabled: input?.enabled === true,
    pollIntervalSeconds: input?.poll_interval_seconds ?? DEFAULT_CI_POLL_INTERVAL_SECONDS,
    ghBinary: input?.gh_binary ?? "gh",
    useCheckRunsFallback: input?.use_check_runs_fallback === true,
    maxConsecutiveFixes: defaultMaxFixes,
    projects: (input?.projects ?? []).map((p) => ({
      projectId: p.project,
      creatorClientId: p.client,
      enabled: p.enabled !== false,
      maxConsecutiveFixes: p.max_consecutive_fixes ?? defaultMaxFixes,
      rerunFailed: p.rerun_failed === true,
      cancelStaleQueued: p.cancel_stale_queued === true,
      template: {
        objective: p.template.objective,
        trustProfile: p.template.trust_profile,
        constraints: [...(p.template.constraints ?? [])],
      },
    })),
  };
}
