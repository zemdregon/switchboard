/**
 * The `container` environment (LLD §11.3, TDD §3.11, FR-PRJ-05, ADR-0020, ADR-0052; T10.1) over the container-runtime
 * port. `prepare` refuses before anything runs unless every check passes: a rootless runtime, the pinned image present
 * locally (never pulled), no `git` or `gh` on the image's `PATH`, a network mode the runtime can enforce, and a mount set
 * of exactly the run worktree (writable) plus the declared read-only contexts. The provider process is then the one the
 * supervisor spawns, as a `run` of the runtime client that creates, starts and attaches to the container; `teardown`
 * force-removes it (and the scan probe) on every terminal path.
 *
 * Nothing else is mounted: no home directory, data directory, Git directory, credential store or runtime socket
 * (FR-PRJ-05). The worktree is mounted at the same absolute path inside the container, so `cwd` and any paths in the
 * provider's arguments stay valid. The executable is argv[0]'s basename, resolved by the image's `PATH`; the host probe
 * path means nothing inside the image.
 *
 * Delegated choices and named gaps are in ADR-0052 and the TDD §3.11 as-built note.
 */
import path from "node:path";
import type { Invocation, ResolvedProfile } from "../adapters/types.js";
import {
  type ContainerRunSpec,
  type ContainerRuntime,
  ContainerRuntimeError,
  type ContainerRuntimeInfo,
} from "./runtime.js";
import {
  type ContainerFacts,
  type ContainerMount,
  type ContainerNetwork,
  type Environment,
  type EnvironmentEvent,
  EnvironmentRefusal,
  type EnvironmentRefusalReason,
  type PreparedInvocation,
  type RunContext,
  type SweepOptions,
} from "./types.js";

export const SWITCHBOARD_RUN_LABEL = "switchboard.run";
export const SWITCHBOARD_PROJECT_LABEL = "switchboard.project";
/** `run` for the provider container, `probe` for the throwaway image scan (ADR-0020). */
export const SWITCHBOARD_ROLE_LABEL = "switchboard.role";

/** Assumption (R-8): enough for a provider CLI and its tool subprocesses, small enough to stop a fork bomb. */
export const DEFAULT_PIDS_LIMIT = 512;

/**
 * Names never forwarded from the host into the container even when an adapter allowlists them: their values are host
 * paths, host identities or host sockets that mean nothing (or the wrong thing) inside the image. The image's own
 * values apply. `XDG_*` and `DOCKER_*` are excluded by prefix as well.
 */
export const HOST_ONLY_ENV: ReadonlySet<string> = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "GPG_TTY",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
]);

export function containerName(runId: string): string {
  return `switchboard-run-${runId}`;
}
export function probeContainerName(runId: string): string {
  return `switchboard-probe-${runId}`;
}

/**
 * The profile's `network` mapped to a container network mode (TDD §3.11: "off for untrusted profiles; allowlist only
 * if the runtime can enforce one"). Docker enforces no host allowlist, so a non-empty allowlist is refused rather than
 * run unrestricted (fail closed, Delegated). `policy` means the provider's own policy decides, which is recorded as
 * such; a `privileged` scope maps through its own `network.mode` (`on` is unrestricted by the owner's decision).
 */
export function containerNetworkFor(profile: ResolvedProfile): ContainerNetwork | { readonly refused: string } {
  const allowlisted = (hosts: readonly unknown[] | undefined, what: string): ContainerNetwork | { refused: string } =>
    (hosts ?? []).length === 0
      ? { mode: "none", enforcement: "switchboard" }
      : {
          refused:
            `${what} names ${(hosts ?? []).length} allowed host(s), and the container runtime cannot enforce a host ` +
            "allowlist; set the allowlist empty (network off) or use a host environment",
        };
  switch (profile.network) {
    case "off":
      return { mode: "none", enforcement: "switchboard" };
    case "allowlist":
      return allowlisted(profile.networkAllowlist, `profile ${JSON.stringify(profile.name)} network allowlist`);
    case "policy":
      return { mode: "default", enforcement: "provider_policy" };
    case "scoped": {
      const scope = profile.privilegedScope?.scope.network;
      if (scope === undefined) return { refused: "profile is scoped but carries no privileged scope" };
      if (scope.mode === "off") return { mode: "none", enforcement: "switchboard" };
      if (scope.mode === "on") return { mode: "default", enforcement: "switchboard" };
      return allowlisted(scope.mode === "allowlist" ? scope.hosts : [], "the approved scope's network allowlist");
    }
    default:
      return { refused: `unknown network policy ${JSON.stringify(profile.network)}` };
  }
}

/** The names forwarded into the container: the invocation's allowlist minus host-only names, plus adapter variables. */
export function forwardedEnvNames(inv: Pick<Invocation, "envAllowlist" | "env">): string[] {
  const names = new Set<string>();
  for (const n of inv.envAllowlist) {
    if (HOST_ONLY_ENV.has(n) || n.startsWith("XDG_") || n.startsWith("DOCKER_")) continue;
    names.add(n);
  }
  for (const n of Object.keys(inv.env)) names.add(n);
  return [...names];
}

/**
 * The mount set (FR-PRJ-05): the worktree writable, each declared context read-only, each at its own host path. A
 * path that is not absolute, contains a character the runtime's mount syntax cannot carry, repeats another or nests
 * inside another is refused: a nested read-only context would shadow part of the worktree, and a duplicate target is
 * undefined behaviour in the runtime.
 */
export function mountPlan(run: RunContext): ContainerMount[] | { readonly invalid: string } {
  const mounts: ContainerMount[] = [{ source: run.worktreePath, target: run.worktreePath, readonly: false }];
  for (const c of run.readOnlyContexts) mounts.push({ source: c.path, target: c.path, readonly: true });
  for (const m of mounts) {
    if (!path.isAbsolute(m.source)) return { invalid: `mount path is not absolute: ${m.source}` };
    if (/[,\n\r]/.test(m.source)) return { invalid: `mount path contains a character the runtime cannot carry` };
    if (path.normalize(m.source) !== m.source || (m.source.length > 1 && m.source.endsWith(path.sep))) {
      return { invalid: `mount path is not normalised: ${m.source}` };
    }
  }
  for (let i = 0; i < mounts.length; i += 1) {
    for (let j = 0; j < mounts.length; j += 1) {
      if (i === j) continue;
      const a = (mounts[i] as ContainerMount).source;
      const b = (mounts[j] as ContainerMount).source;
      if (a === b) return { invalid: `two mounts share the path ${a}` };
      if (b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`)) {
        return { invalid: `mount ${b} nests inside mount ${a}` };
      }
    }
  }
  return mounts;
}

export interface ContainerEnvironmentOptions {
  readonly runtime: ContainerRuntime;
  /** Receives `environment` events (FR-PRJ-07); `environmentEventSink` writes them to the ledger (T10.2). Must not throw. */
  readonly onEvent?: (event: EnvironmentEvent) => void;
  readonly pidsLimit?: number;
}

export function createContainerEnvironment(opts: ContainerEnvironmentOptions): Environment {
  const { runtime } = opts;
  const pidsLimit = opts.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  const emit = (payload: EnvironmentEvent["payload"]): void => {
    opts.onEvent?.({ type: "environment", payload: { ...payload, kind: "container" } });
  };
  const refuse = (runId: string, reason: EnvironmentRefusalReason, detail: string): never => {
    emit({ kind: "container", step: "refused", run_id: runId, reason, detail });
    throw new EnvironmentRefusal(reason, `container environment refused the run (${reason}): ${detail}`);
  };

  const prepare = async (run: RunContext, inv: Invocation): Promise<PreparedInvocation> => {
    const runId = run.runId;
    if (run.projectId === undefined) {
      return refuse(runId, "CONTAINER_PROJECT_REQUIRED", "a container run needs a project (FR-PRJ-04)");
    }
    if (run.imageDigest === undefined) {
      return refuse(runId, "CONTAINER_IMAGE_NOT_PINNED", "the project pins no image digest (ADR-0013)");
    }
    let info: ContainerRuntimeInfo;
    try {
      info = await runtime.info();
    } catch (err) {
      return refuse(runId, "CONTAINER_RUNTIME_UNAVAILABLE", (err as Error).message);
    }
    if (!info.available) return refuse(runId, "CONTAINER_RUNTIME_UNAVAILABLE", info.detail);
    if (!info.rootless) {
      return refuse(
        runId,
        "CONTAINER_RUNTIME_UNAVAILABLE",
        `${info.detail}; only a rootless runtime is used (NFR-SEC-04, TDD §3.11)`,
      );
    }
    const network = containerNetworkFor(run.profile);
    if ("refused" in network) return refuse(runId, "CONTAINER_NETWORK_UNENFORCEABLE", network.refused);
    const mounts = mountPlan(run);
    if ("invalid" in mounts) return refuse(runId, "CONTAINER_MOUNT_PATH_INVALID", mounts.invalid);

    const labels = { [SWITCHBOARD_RUN_LABEL]: runId, [SWITCHBOARD_PROJECT_LABEL]: run.projectId };
    let imageId: string;
    try {
      const resolved = await runtime.resolveImage(run.imageDigest);
      if (resolved.kind === "not_present") {
        return refuse(
          runId,
          "CONTAINER_IMAGE_NOT_PRESENT",
          `no local image has id or digest ${run.imageDigest}; Switchboard never pulls (ADR-0013)`,
        );
      }
      if (resolved.kind === "ambiguous") {
        return refuse(
          runId,
          "CONTAINER_IMAGE_AMBIGUOUS",
          `${resolved.imageIds.length} local images match ${run.imageDigest}`,
        );
      }
      imageId = resolved.imageId;
      // ADR-0020 item 2: the Git-client check, before any run; a scan that cannot complete refuses too.
      const scan = await runtime.scanImageForGitClient(imageId, probeContainerName(runId), {
        ...labels,
        [SWITCHBOARD_ROLE_LABEL]: "probe",
      });
      if (!scan.completed) return refuse(runId, "CONTAINER_IMAGE_CHECK_FAILED", `image ${imageId}: ${scan.detail}`);
      if (scan.found.length > 0) {
        return refuse(
          runId,
          "CONTAINER_IMAGE_HAS_GIT_CLIENT",
          `image ${imageId} has a Git client on its PATH (${scan.detail}); FR-PRJ-05, ADR-0020`,
        );
      }
      emit({ kind: "container", step: "image_checked", run_id: runId, image_id: imageId, detail: scan.detail });
    } catch (err) {
      if (err instanceof EnvironmentRefusal) throw err;
      if (err instanceof ContainerRuntimeError) return refuse(runId, "CONTAINER_IMAGE_CHECK_FAILED", err.message);
      throw err;
    }

    const executable = path.basename(inv.argv[0] ?? "");
    if (executable === "" || executable === "." || executable === "..") {
      return refuse(runId, "CONTAINER_CREATE_FAILED", "the invocation names no executable");
    }
    const forwardEnv = forwardedEnvNames(inv);
    const spec: ContainerRunSpec = {
      name: containerName(runId),
      imageId,
      labels: { ...labels, [SWITCHBOARD_ROLE_LABEL]: "run" },
      mounts,
      network: network.mode,
      ...(run.limits?.cpus !== undefined ? { cpus: run.limits.cpus } : {}),
      ...(run.limits?.memoryMb !== undefined ? { memoryMb: run.limits.memoryMb } : {}),
      pidsLimit,
      workdir: run.worktreePath,
      forwardEnv,
      argv: [executable, ...inv.argv.slice(1)],
    };
    let argv: readonly string[];
    try {
      argv = runtime.runArgv(spec);
    } catch (err) {
      if (err instanceof ContainerRuntimeError) return refuse(runId, "CONTAINER_CREATE_FAILED", err.message);
      throw err;
    }
    const facts: ContainerFacts = {
      name: spec.name,
      id: "",
      imageId,
      labels: spec.labels,
      mounts,
      network,
      limits: {
        ...(spec.cpus !== undefined ? { cpus: spec.cpus } : {}),
        ...(spec.memoryMb !== undefined ? { memoryMb: spec.memoryMb } : {}),
        pidsLimit,
        ...(run.limits?.diskMb !== undefined ? { diskMbNotEnforced: run.limits.diskMb } : {}),
      },
      executable,
      forwardedEnv: forwardEnv,
    };
    emit({
      kind: "container",
      step: "prepared",
      run_id: runId,
      container: spec.name,
      image_id: imageId,
      mounts: mounts.map((m) => ({ target: m.target, readonly: m.readonly })),
      network: network.mode,
      network_enforcement: network.enforcement,
      limits: facts.limits,
      runtime: info.detail,
    });
    return {
      invocation: {
        ...inv,
        argv: [...argv],
        // The client needs the socket and config names; the provider's own allowlist still feeds the `--env NAME`
        // copies, because the supervisor composes the client's environment from it (FR-EXE-07).
        envAllowlist: [...new Set([...runtime.clientEnvAllowlist, ...inv.envAllowlist])],
      },
      container: facts,
    };
  };

  const teardown = async (run: Pick<RunContext, "runId">): Promise<void> => {
    for (const name of [containerName(run.runId), probeContainerName(run.runId)]) {
      try {
        const r = await runtime.remove(name);
        if (r.removed) emit({ kind: "container", step: "removed", run_id: run.runId, container: name });
      } catch (err) {
        emit({
          kind: "container",
          step: "remove_failed",
          run_id: run.runId,
          container: name,
          detail: (err as Error).message,
        });
      }
    }
  };

  // T10.2 (FR-PRJ-07): run and probe containers both carry the run label. A listing failure throws: the caller cannot
  // know that no orphan is left, so startup reconciliation fails closed.
  const sweepOrphans = async (
    knownRunIds: ReadonlySet<string>,
    sweep: SweepOptions = {},
  ): Promise<{ removed: string[] }> => {
    const removed: string[] = [];
    for (const c of await runtime.listByLabel(SWITCHBOARD_RUN_LABEL)) {
      const runId = c.labels[SWITCHBOARD_RUN_LABEL];
      if (runId === undefined || knownRunIds.has(runId)) continue;
      if (sweep.owns !== undefined && !sweep.owns(runId)) continue;
      try {
        const r = await runtime.remove(c.name);
        if (r.removed) {
          removed.push(c.name);
          emit({ kind: "container", step: "orphan_removed", run_id: runId, container: c.name });
        }
      } catch (err) {
        emit({
          kind: "container",
          step: "remove_failed",
          run_id: runId,
          container: c.name,
          detail: (err as Error).message,
        });
      }
    }
    return { removed };
  };

  return { kind: "container", prepare, teardown, sweepOrphans };
}

/**
 * Retention (T10.3, FR-PRJ-09): force-removes every container (run and probe) labelled with one of `runIds`, and returns
 * their names. Unlike `teardown` it throws when the runtime cannot list or remove: the GC step that calls it then keeps
 * the worktrees a container may still mount and is retried on the next pass (roll forward). No volume is removed: this
 * backend creates none (TDD §3.11 as built; no login volume is mounted yet).
 */
export async function removeRunContainers(runtime: ContainerRuntime, runIds: readonly string[]): Promise<string[]> {
  const wanted = new Set(runIds);
  if (wanted.size === 0) return [];
  const removed: string[] = [];
  for (const c of await runtime.listByLabel(SWITCHBOARD_RUN_LABEL)) {
    const runId = c.labels[SWITCHBOARD_RUN_LABEL];
    if (runId === undefined || !wanted.has(runId)) continue;
    if ((await runtime.remove(c.name)).removed) removed.push(c.name);
  }
  return removed.sort();
}
