/**
 * Environment port (LLD §11.3; FR-PRJ-04, FR-PRJ-05, FR-PRJ-07; T10.1). COMP-EXE reaches the provider process through
 * this one port so `host` and `container` share the supervisor: `prepare` turns the adapter's compiled invocation into
 * the one the supervisor spawns, `teardown` runs on every terminal path, and `sweepOrphans` is the startup
 * reconciliation hook (its wiring is T10.2).
 *
 * The port is pure data in and out. It never reads the ledger, never touches credentials and never starts the provider
 * process itself; the lifecycle still audits the prepared invocation (bypass flags, MCP arguments, `--safe-mode`) and
 * spawns it under the supervisor exactly as a host invocation.
 */
import type { Invocation, ResolvedProfile } from "../adapters/types.js";

export type EnvironmentKind = "host" | "container";

/** A declared read-only context of the run's project (FR-PRJ-05): mounted read-only, never written. */
export interface ReadOnlyContextMount {
  readonly id: string;
  /** Canonical absolute path on the host. */
  readonly path: string;
}

/** What the port needs to know about a run. No secrets, no ledger handle. */
export interface RunContext {
  readonly runId: string;
  /** The project the run was admitted under; absent for a run delegated by workspace path (always `host`). */
  readonly projectId?: string;
  /** The run's writable working directory on the host: the controller-created worktree, or the workspace itself. */
  readonly worktreePath: string;
  /** Declared read-only contexts (FR-PRJ-05); empty when the project has none. */
  readonly readOnlyContexts: readonly ReadOnlyContextMount[];
  /** The frozen profile: its `network` decides the container's network mode. */
  readonly profile: ResolvedProfile;
  /** `container` only: the image pinned by digest in the project (FR-PRJ-04, ADR-0013). */
  readonly imageDigest?: string;
  /** `container` only: the project's limits (TDD §3.11). */
  readonly limits?: { readonly cpus?: number; readonly memoryMb?: number; readonly diskMb?: number };
}

export interface ContainerMount {
  readonly source: string;
  readonly target: string;
  readonly readonly: boolean;
}

/** The container's network mode and who enforces the run's network policy inside it (TDD §3.11, Delegated). */
export interface ContainerNetwork {
  /** `none`: no interfaces but loopback. `default`: the runtime's default network, unrestricted by Switchboard. */
  readonly mode: "none" | "default";
  /**
   * `switchboard`: the mode itself is the policy (`off`, or an unrestricted scope). `provider_policy`: the profile
   * says the provider's own policy decides (`policy`), so Switchboard records that it enforces nothing here.
   */
  readonly enforcement: "switchboard" | "provider_policy";
}

/** Facts about the container `prepare` created, for the `environment` run event and the tests. Never a secret. */
export interface ContainerFacts {
  readonly name: string;
  /** The runtime's container id. */
  readonly id: string;
  /** The image id the digest resolved to (never pulled). */
  readonly imageId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly mounts: readonly ContainerMount[];
  readonly network: ContainerNetwork;
  readonly limits: {
    readonly cpus?: number;
    readonly memoryMb?: number;
    readonly pidsLimit: number;
    /** Requested but not enforced by this backend (named gap, TDD §3.11 as built); never claimed. */
    readonly diskMbNotEnforced?: number;
  };
  /** The executable the image's `PATH` resolves (argv[0]'s basename); the host probe path does not apply inside. */
  readonly executable: string;
  /** Environment variable NAMES forwarded into the container (values never recorded). */
  readonly forwardedEnv: readonly string[];
}

export interface PreparedInvocation {
  readonly invocation: Invocation;
  /** Present exactly when the environment is `container`. */
  readonly container?: ContainerFacts;
}

/** Refusal reasons of the container environment; the failure code is `ELIGIBILITY_NONE` (nothing was denied: the run cannot be placed). */
export type EnvironmentRefusalReason =
  | "CONTAINER_RUNTIME_UNAVAILABLE"
  | "CONTAINER_PROJECT_REQUIRED"
  | "CONTAINER_IMAGE_NOT_PINNED"
  | "CONTAINER_IMAGE_NOT_PRESENT"
  | "CONTAINER_IMAGE_AMBIGUOUS"
  | "CONTAINER_IMAGE_HAS_GIT_CLIENT"
  | "CONTAINER_IMAGE_CHECK_FAILED"
  | "CONTAINER_NETWORK_UNENFORCEABLE"
  | "CONTAINER_MOUNT_PATH_INVALID"
  | "CONTAINER_CREATE_FAILED"
  | "CONTAINER_SPEC_MISMATCH";

/** Thrown by `prepare` when no container may be started for the run. The message names what was found. */
export class EnvironmentRefusal extends Error {
  constructor(
    readonly reason: EnvironmentRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentRefusal";
  }
}

/** `environment` run events (FR-PRJ-07). Persisting them in the ledger is T10.2; T10.1 emits them to a callback. */
export interface EnvironmentEvent {
  readonly type: "environment";
  readonly payload: {
    readonly kind: EnvironmentKind;
    readonly step: "image_checked" | "prepared" | "refused" | "removed" | "remove_failed" | "orphan_removed";
    readonly run_id: string;
    readonly container?: string;
    readonly reason?: EnvironmentRefusalReason;
    readonly detail?: string;
  } & Record<string, unknown>;
}

export interface Environment {
  readonly kind: EnvironmentKind;
  /** host: returns the invocation unchanged. container: creates the container and wraps the invocation to run in it. */
  prepare(run: RunContext, invocation: Invocation): Promise<PreparedInvocation>;
  /** Always called, on every terminal path; idempotent. */
  teardown(run: Pick<RunContext, "runId">): Promise<void>;
  /** Startup reconciliation: containers carrying switchboard labels with no matching live run (FR-PRJ-07). */
  sweepOrphans(knownRunIds: ReadonlySet<string>): Promise<{ removed: string[] }>;
}
