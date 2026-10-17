/**
 * The `container` builder of dependency seeds (T9.13; FR-WS-10, LLD §5.1 "Container projects", ADR-0057 item 3). A
 * seed of a `container` project is built in a container of the project's image, with the same checks as a run's
 * container (rootless runtime, image present by digest and never pulled, no Git client in it, ADR-0052), the build
 * profile's network mode, and only the scratch worktree mounted read-write at its own path. The container carries the
 * triggering run's labels with role `seed`, so the startup orphan sweep (T10.2) removes one a crash left behind; it is
 * started with `--rm` and ends with the build. The build's spawn, bound and output capture are the seed store's (the
 * verification runner); the outer sandbox does not wrap the runtime client (`confinable: false`).
 */
import { randomUUID } from "node:crypto";
import type { ResolvedProfile } from "../adapters/types.js";
import type { TrustProfile } from "../ledger/index.js";
import type { SeedCommandFactory } from "../workspace/seeds.js";
import {
  containerNetworkFor,
  DEFAULT_PIDS_LIMIT,
  SWITCHBOARD_PROJECT_LABEL,
  SWITCHBOARD_ROLE_LABEL,
  SWITCHBOARD_RUN_LABEL,
} from "./container.js";
import type { ContainerRuntime } from "./runtime.js";

/** Label naming the seed entry a build container produces (LLD §5.1). */
export const SWITCHBOARD_SEED_LABEL = "switchboard.seed";

export interface ContainerSeedCommandOptions {
  readonly runtime: ContainerRuntime;
  /** The build profile resolved with the operator's overrides; its `network` decides the container's network mode. */
  readonly profileFor: (name: TrustProfile) => ResolvedProfile;
  readonly pidsLimit?: number;
}

/** A {@link SeedCommandFactory} for `container` seeds. Any check that fails throws (the store records `build_error`). */
export function containerSeedCommand(o: ContainerSeedCommandOptions): SeedCommandFactory {
  return async (ctx) => {
    if (ctx.environment.kind !== "container") throw new Error("not a container seed");
    const info = await o.runtime.info();
    if (!info.available || !info.rootless) throw new Error("no rootless container runtime");
    const network = containerNetworkFor(o.profileFor(ctx.profile));
    if ("refused" in network) throw new Error(network.refused);
    const resolved = await o.runtime.resolveImage(ctx.environment.imageDigest);
    if (resolved.kind !== "found") throw new Error(`image ${resolved.kind}`);
    const labels = {
      [SWITCHBOARD_RUN_LABEL]: ctx.runId,
      [SWITCHBOARD_PROJECT_LABEL]: ctx.projectId,
      [SWITCHBOARD_SEED_LABEL]: ctx.seedKey,
    };
    const suffix = randomUUID().slice(0, 8);
    const scan = await o.runtime.scanImageForGitClient(
      resolved.imageId,
      `switchboard-seedprobe-${ctx.runId}-${suffix}`,
      {
        ...labels,
        [SWITCHBOARD_ROLE_LABEL]: "probe",
      },
    );
    if (!scan.completed || scan.found.length > 0) throw new Error("the image has a Git client or could not be scanned");
    const argv = o.runtime.runArgv({
      name: `switchboard-seed-${ctx.runId}-${suffix}`,
      imageId: resolved.imageId,
      labels: { ...labels, [SWITCHBOARD_ROLE_LABEL]: "seed" },
      mounts: [{ source: ctx.scratch, target: ctx.scratch, readonly: false }],
      network: network.mode,
      pidsLimit: o.pidsLimit ?? DEFAULT_PIDS_LIMIT,
      workdir: ctx.scratch,
      forwardEnv: [],
      argv: [...ctx.spec.install],
    });
    return { argv, envAllowlist: [...o.runtime.clientEnvAllowlist, "PATH", "HOME"], confinable: false };
  };
}
