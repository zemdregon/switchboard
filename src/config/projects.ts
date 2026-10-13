/**
 * Project and context resolution (FR-PRJ-01, FR-PRJ-02, FR-PRJ-04; T9.1). This file holds the structural rules that
 * `loadConfig` enforces at startup (unique ids, one primary context, environment fields consistent with the kind, a
 * push policy that needs an identity). The filesystem rules (absolute path, allowed root, Git repository, base ref)
 * live in `src/cli/projects.ts` and run only from `switchboard projects validate`, so a config that merely lists a
 * project starts `serve` exactly as before. Nothing here starts a container: `container` is accepted as a shape only
 * (M10).
 */
import type {
  ContextConfig,
  ContextKind,
  EnvironmentKind,
  ProjectConfig,
  ProviderId,
  SwitchboardConfig,
  TrustProfile,
} from "./schema.js";

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
