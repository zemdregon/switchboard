/**
 * The environment resolver `serve` gives the run lifecycle (T10.1; FR-PRJ-04, FR-PRJ-05, LLD §11.3). The frozen
 * snapshot decides the kind; the project's current definition supplies what the snapshot deliberately does not carry:
 * the declared read-only contexts (every context but the primary, whose worktree is the run's only writable mount) and
 * the limits. Fail closed, never silently on the host: a `container` snapshot gets no placement when no container
 * environment is registered, when the project is no longer defined or no longer `container`, when its pinned image
 * differs from the one frozen at admission (Delegated: a re-pinned project is re-admitted, not run on a stale
 * snapshot), or when a read-only context path cannot be canonicalised. The lifecycle then ends the run
 * `ELIGIBILITY_NONE` before any lease or worktree.
 */
import { realpathSync } from "node:fs";
import type { ResolvedProject } from "../config/projects.js";
import type { ProjectSnapshot } from "../policy/types.js";
import { hostEnvironment } from "./host.js";
import type { EnvironmentRegistry } from "./select.js";
import type { Environment, ReadOnlyContextMount, RunContext } from "./types.js";

/** Structurally the lifecycle's `EnvironmentPlacement` (the lifecycle imports this module, not the reverse). */
export interface ProjectEnvironmentPlacement {
  readonly environment: Environment;
  readonly readOnlyContexts: readonly ReadOnlyContextMount[];
  readonly limits?: RunContext["limits"];
}

export interface ProjectEnvironmentResolverOptions extends EnvironmentRegistry {
  /** The project's definition in force now: configured, or a dynamic project's in-force revision. */
  readonly lookup: (projectId: string) => Pick<ResolvedProject, "environment" | "contexts"> | undefined;
  /** Canonicalises a read-only context path; defaults to `realpathSync`. Throws when the path is unusable. */
  readonly canonical?: (p: string) => string;
}

export function createProjectEnvironmentResolver(opts: ProjectEnvironmentResolverOptions): {
  resolve(
    project: Pick<ProjectSnapshot, "id" | "environment_kind" | "image_digest"> | undefined,
  ): ProjectEnvironmentPlacement | undefined;
} {
  const canonical = opts.canonical ?? ((p: string) => realpathSync(p));
  return {
    resolve(project) {
      if (project?.environment_kind !== "container") {
        return { environment: opts.host ?? hostEnvironment, readOnlyContexts: [] };
      }
      const container = opts.container;
      if (container === undefined) return undefined;
      const def = opts.lookup(project.id);
      if (def === undefined || def.environment.kind !== "container") return undefined;
      if (def.environment.imageDigest !== project.image_digest) return undefined;
      const readOnlyContexts: ReadOnlyContextMount[] = [];
      for (const c of def.contexts) {
        if (c.primary) continue;
        try {
          readOnlyContexts.push({ id: c.id, path: canonical(c.path) });
        } catch {
          return undefined;
        }
      }
      const limits = def.environment.limits;
      return { environment: container, readOnlyContexts, ...(limits !== undefined ? { limits: { ...limits } } : {}) };
    },
  };
}
