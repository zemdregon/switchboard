/**
 * Project and context resolution (FR-PRJ-01, FR-PRJ-02, FR-PRJ-04; T9.1). This file holds the structural rules that
 * `loadConfig` enforces at startup (unique ids, one primary context, environment fields consistent with the kind, a
 * push policy that needs an identity). The filesystem rules (absolute path, allowed root, Git repository, base ref)
 * live in `src/cli/projects.ts` and run only from `switchboard projects validate`, so a config that merely lists a
 * project starts `serve` exactly as before. Nothing here starts a container: `container` is accepted as a shape only
 * (M10).
 */

import { isBranchPrefix, isRemoteName } from "../git/push-names.js";
import { mostRestrictiveInnerSetting, type ProjectInnerSetting } from "./inner-agent.js";
import type {
  ContextConfig,
  ContextKind,
  EnvironmentKind,
  ProjectConfig,
  ProviderId,
  SwitchboardConfig,
  TrustProfile,
} from "./schema.js";
import { TRUST_PROFILES } from "./schema.js";

/** Shown by `projects validate` and by `delegate_task` for a `container` project until M10 (FR-PRJ-05). */
export const CONTAINER_NOT_IMPLEMENTED = "container environments are not implemented yet (M10)";

export interface ResolvedContext {
  readonly id: string;
  readonly kind: ContextKind;
  /** The path exactly as written in the config; canonicalised and checked by `projects validate` (and again at admission, T9.2). */
  readonly path: string;
  readonly baseRef: string;
  readonly primary: boolean;
  readonly writable: boolean;
  readonly push: { policy: "none" | "branch"; remote?: string; branchPrefix?: string };
  readonly identity?: { name: string; email: string };
  readonly sign: boolean;
  /** T9.7 (FR-GIT-09, BR-30): finalize-only opt-in; default false. */
  readonly finalizeCommit: boolean;
  /** T11.3 (LLD §13.1): present only when the context sets `inner_agent`; absent reads as `inherit`. */
  readonly innerAgent?: ProjectInnerSetting;
}

export interface ResolvedProject {
  readonly id: string;
  readonly name: string;
  readonly environment: {
    kind: EnvironmentKind;
    imageDigest?: string;
    limits?: { cpus?: number; memoryMb?: number; diskMb?: number };
  };
  /** Shape only in T9.1; enforced from T9.2 (FR-PRJ-06). */
  readonly maxTrustProfile?: TrustProfile;
  readonly allowedProviders?: readonly ProviderId[];
  /** T11.3 (LLD §13.1): present only when the project sets `inner_agent`; absent reads as `inherit`. */
  readonly innerAgent?: ProjectInnerSetting;
  readonly contexts: readonly ResolvedContext[];
}

/** Structural violations as `<json path>: <message>` lines, in the loader's format. */
export function checkProjects(cfg: SwitchboardConfig): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const [i, p] of (cfg.projects ?? []).entries()) {
    const at = `$.projects[${i}]`;
    if (ids.has(p.id)) errs.push(`${at}.id: duplicate project id ${JSON.stringify(p.id)}`);
    ids.add(p.id);

    const env = p.environment ?? { kind: "host" as const };
    if (env.kind === "host") {
      for (const k of ["image_digest", "limits"] as const) {
        if (env[k] !== undefined) errs.push(`${at}.environment.${k}: only valid for a container environment`);
      }
    } else if (env.image_digest === undefined) {
      errs.push(`${at}.environment.image_digest: required for a container environment (image pinned by digest)`);
    }

    const cids = new Set<string>();
    for (const [j, c] of p.contexts.entries()) {
      const cat = `${at}.contexts[${j}]`;
      if (cids.has(c.id)) errs.push(`${cat}.id: duplicate context id ${JSON.stringify(c.id)} in project ${p.id}`);
      cids.add(c.id);
      const isPrimary = isPrimaryContext(p, c);
      if (c.writable === true && !isPrimary) {
        errs.push(`${cat}.writable: only the primary context is writable (LLD §11.1)`);
      }
      // T9.6 (ADR-0028): `remote` is a remote NAME resolved by Git at push time, never a URL (which could carry
      // credentials into the ledger, NFR-SEC-01); the message never echoes the value.
      if (c.push?.remote !== undefined && !isRemoteName(c.push.remote)) {
        errs.push(
          `${cat}.push.remote: must be the name of a remote configured in the repository (letters, digits, '.', '_', '-'; not a URL)`,
        );
      }
      if (c.push?.branch_prefix !== undefined && !isBranchPrefix(c.push.branch_prefix)) {
        errs.push(
          `${cat}.push.branch_prefix: must be a branch-name prefix (letters, digits, '.', '_', '-', '/'; no '..', '//', leading '/', '-' or '.', or 'refs/')`,
        );
      }
      if (c.push?.policy === "branch") {
        if (c.push.remote === undefined) errs.push(`${cat}.push.remote: required when push.policy is branch`);
        if (c.push.branch_prefix === undefined) {
          errs.push(`${cat}.push.branch_prefix: required when push.policy is branch`);
        }
      }
      if (c.push !== undefined && c.push.policy !== "none" && c.identity === undefined) {
        errs.push(`${cat}.identity: required when push.policy is not none (LLD §11.1)`);
      }
      // T9.7 (FR-GIT-09, BR-30): the finalize-only commit is written with the context identity into the primary,
      // writable context, so the opt-in is refused where it could never apply (fail closed rather than silently ignored).
      if (c.finalize_commit === true) {
        if (c.identity === undefined) errs.push(`${cat}.identity: required when finalize_commit is true (FR-GIT-09)`);
        if (!isPrimary || c.writable === false) {
          errs.push(`${cat}.finalize_commit: only the primary, writable context can enable finalize_commit`);
        }
      }
      // T9.10 (FR-GIT-10, BR-33): only published commits are signed, and only the primary, writable context with an
      // identity publishes, so `sign` elsewhere is refused rather than silently ignored (fail closed; Delegated).
      if (c.sign === true) {
        if (c.identity === undefined) errs.push(`${cat}.identity: required when sign is true (FR-GIT-10)`);
        if (!isPrimary || c.writable === false) {
          errs.push(`${cat}.sign: only the primary, writable context can enable sign`);
        }
      }
    }
    const primaries = p.contexts.filter((c) => isPrimaryContext(p, c)).length;
    if (primaries !== 1) {
      errs.push(`${at}.contexts: exactly one context must be primary ("primary": true); found ${primaries}`);
    }
  }
  return errs;
}

/** A sole context is primary unless it says otherwise; with several, only an explicit `primary: true` counts. */
function isPrimaryContext(p: ProjectConfig, c: ContextConfig): boolean {
  return p.contexts.length === 1 ? c.primary !== false : c.primary === true;
}

export function resolveProjects(cfg: SwitchboardConfig): ResolvedProject[] {
  return (cfg.projects ?? []).map((p) => {
    const env = p.environment ?? { kind: "host" as const };
    return {
      id: p.id,
      name: p.name,
      environment: {
        kind: env.kind,
        ...(env.image_digest !== undefined ? { imageDigest: env.image_digest } : {}),
        ...(env.limits !== undefined
          ? {
              limits: {
                ...(env.limits.cpus !== undefined ? { cpus: env.limits.cpus } : {}),
                ...(env.limits.memory_mb !== undefined ? { memoryMb: env.limits.memory_mb } : {}),
                ...(env.limits.disk_mb !== undefined ? { diskMb: env.limits.disk_mb } : {}),
              },
            }
          : {}),
      },
      ...(p.max_trust_profile !== undefined ? { maxTrustProfile: p.max_trust_profile } : {}),
      ...(p.allowed_providers !== undefined ? { allowedProviders: [...p.allowed_providers] } : {}),
      ...(p.inner_agent !== undefined ? { innerAgent: p.inner_agent } : {}),
      contexts: p.contexts.map((c) => {
        const primary = isPrimaryContext(p, c);
        return {
          id: c.id,
          kind: c.kind,
          path: c.path,
          baseRef: c.base_ref,
          primary,
          writable: c.writable ?? primary,
          push: {
            policy: c.push?.policy ?? "none",
            ...(c.push?.remote !== undefined ? { remote: c.push.remote } : {}),
            ...(c.push?.branch_prefix !== undefined ? { branchPrefix: c.push.branch_prefix } : {}),
          },
          ...(c.identity !== undefined ? { identity: { ...c.identity } } : {}),
          sign: c.sign ?? false,
          finalizeCommit: c.finalize_commit ?? false,
          ...(c.inner_agent !== undefined ? { innerAgent: c.inner_agent } : {}),
        };
      }),
    };
  });
}

/** The lower of two trust profiles on the order `inspect-untrusted` < ... < `privileged` (FR-PRJ-06, LLD §11.2). */
export function lowerProfile(a: TrustProfile, b: TrustProfile): TrustProfile {
  return TRUST_PROFILES.indexOf(a) <= TRUST_PROFILES.indexOf(b) ? a : b;
}

/**
 * The effective maximum profile of a request in a project: the lower of the calling client's maximum (FR-MCP-06) and
 * the project's own (FR-PRJ-06, BR-23). A project without `max_trust_profile` does not lower the client's.
 */
export function effectiveMaxProfile(clientMax: TrustProfile, project: ResolvedProject): TrustProfile {
  return project.maxTrustProfile === undefined ? clientMax : lowerProfile(clientMax, project.maxTrustProfile);
}

/** The projects a client may use, in configuration order. A client with no list may use none (fail closed). */
export function projectsForClient(
  projects: readonly ResolvedProject[],
  client: { readonly projects?: readonly string[] },
): ResolvedProject[] {
  const allowed = new Set(client.projects ?? []);
  return projects.filter((p) => allowed.has(p.id));
}

/** The one primary context of a project (`checkProjects` guarantees exactly one at load time). */
export function primaryContext(project: ResolvedProject): ResolvedContext {
  const primary = project.contexts.find((c) => c.primary);
  if (!primary) throw new Error(`project ${project.id} has no primary context`);
  return primary;
}

/**
 * The effective inner-agent setting for a run (LLD §13.1, FR-INN-16): the most restrictive of the project's and the
 * context's (`off` over `local_only` over `inherit`). No project (a run started by `workspace_path`) is `inherit`, and a
 * context id that names no context of the project contributes nothing (the project's own setting still applies).
 */
export function effectiveInnerSetting(
  project: Pick<ResolvedProject, "innerAgent" | "contexts"> | undefined,
  contextId?: string,
): ProjectInnerSetting {
  if (project === undefined) return "inherit";
  const context = contextId === undefined ? undefined : project.contexts.find((c) => c.id === contextId);
  return mostRestrictiveInnerSetting(project.innerAgent, context?.innerAgent);
}
