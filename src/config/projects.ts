/**
 * Project and context resolution (FR-PRJ-01, FR-PRJ-02, FR-PRJ-04; T9.1). This file holds the structural rules that
 * `loadConfig` enforces at startup (unique ids, one primary context, environment fields consistent with the kind, a
 * push policy that needs an identity). The filesystem rules (absolute path, allowed root, Git repository, base ref)
 * live in `src/cli/projects.ts` and run only from `switchboard projects validate`, so a config that merely lists a
 * project starts `serve` exactly as before. Nothing here starts a container: `container` is accepted as a shape only
 * (M10).
 */

import { isBranchPrefix, isRemoteName } from "../git/push-names.js";
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
