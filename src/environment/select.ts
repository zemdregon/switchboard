/**
 * Picking the environment for a run from the frozen policy snapshot (FR-PRJ-04, LLD §11.2 step 6, LLD §11.3). The
 * snapshot's `project.environment_kind` (and, for containers, `project.image_digest`) is the only input: a run
 * delegated by workspace path has no `project` and is `host`. A `container` run with no container environment
 * registered is refused, never silently run on the host (fail closed).
 */
import type { ResolvedProject } from "../config/projects.js";
import type { ProjectSnapshot } from "../policy/types.js";
import { hostEnvironment } from "./host.js";
import type { Environment, EnvironmentKind } from "./types.js";

/** Environments the lifecycle may use, by kind. `host` defaults to the identity implementation. */
export interface EnvironmentRegistry {
  readonly host?: Environment;
  readonly container?: Environment;
}

export function environmentKindOf(
  snapshot: { readonly project?: Pick<ProjectSnapshot, "environment_kind"> | undefined } | undefined,
): EnvironmentKind {
  return snapshot?.project?.environment_kind === "container" ? "container" : "host";
}

/** The environment for `kind`, or undefined when none is registered for it (the lifecycle then refuses the run). */
export function selectEnvironment(
  kind: EnvironmentKind,
  registry: EnvironmentRegistry | undefined,
): Environment | undefined {
  if (kind === "host") return registry?.host ?? hostEnvironment;
  return registry?.container;
}

/**
 * The environment fields of a project's snapshot (FR-PRJ-04: the kind and, for containers, the image digest are
 * recorded in the run's policy snapshot). For the admission path to spread into `ProjectSnapshot`.
 */
export function snapshotEnvironment(
  project: Pick<ResolvedProject, "environment">,
): Pick<ProjectSnapshot, "environment_kind" | "image_digest"> {
  const { kind, imageDigest } = project.environment;
  return {
    environment_kind: kind,
    ...(kind === "container" && imageDigest !== undefined ? { image_digest: imageDigest } : {}),
  };
}
