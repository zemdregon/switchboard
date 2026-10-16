/**
 * The container-runtime port behind the `container` environment (TDD §3.11: "the port is small ... so the choice stays
 * replaceable"). One implementation exists, the Docker CLI driver (`./docker-runtime.ts`, ADR-0052); unit tests script a
 * fake. Every method is a thin, data-only wrapper over one runtime command; policy (what to mount, which network, the
 * Git-client rule) lives in `./container.ts`, never here.
 */
import type { ContainerMount } from "./types.js";

export interface ContainerRuntimeInfo {
  /** The runtime answered and may be used. False with a `detail` otherwise; never a guess. */
  readonly available: boolean;
  /** NFR-SEC-04, TDD §3.11: a root-owned daemon is out; the container environment refuses a non-rootless runtime. */
  readonly rootless: boolean;
  readonly serverVersion: string | null;
  /** Absolute path of the client executable, or null when none was found. */
  readonly clientPath: string | null;
  /** One line for operators and the `environment` event. */
  readonly detail: string;
}

export type ImageResolution =
  | { readonly kind: "found"; readonly imageId: string }
  | { readonly kind: "not_present" }
  | { readonly kind: "ambiguous"; readonly imageIds: readonly string[] };

export interface GitClientScan {
  /** True only when the scan script ran to its end marker; anything else is "could not verify" (fail closed). */
  readonly completed: boolean;
  readonly found: ReadonlyArray<{ readonly name: "git" | "gh"; readonly path: string }>;
  readonly detail: string;
}

/** The `run` arguments the driver assembles for the provider container; the environment supplies the policy. */
export interface ContainerRunSpec {
  readonly name: string;
  readonly imageId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly mounts: readonly ContainerMount[];
  readonly network: "none" | "default";
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly pidsLimit: number;
  /** Absolute path inside the container (the same as the host worktree path: paths in argv stay valid). */
  readonly workdir: string;
  /** Environment variable names copied from the client's environment into the container (`--env NAME`). */
  readonly forwardEnv: readonly string[];
  /** The command inside the image: executable name resolved by the image's `PATH`, then the provider arguments. */
  readonly argv: readonly string[];
}

export interface ContainerInspection {
  readonly id: string;
  readonly running: boolean;
  readonly privileged: boolean;
  readonly networkMode: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly mounts: readonly ContainerMount[];
}

export class ContainerRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerRuntimeError";
  }
}

export interface ContainerRuntime {
  readonly name: string;
  info(): Promise<ContainerRuntimeInfo>;
  /** Looks the digest up among the images already present; never pulls (ADR-0013). */
  resolveImage(digest: string): Promise<ImageResolution>;
  /**
   * ADR-0020 item 2: runs the `PATH` scan for `git` and `gh` in a throwaway container named `probeName` (no network,
   * read-only root). A scan that cannot complete is reported as such, never as "clean".
   */
  scanImageForGitClient(
    imageId: string,
    probeName: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<GitClientScan>;
  /**
   * The argv the supervisor spawns for the run: it creates, starts and attaches to the container in one process, so
   * the lifecycle's pre-spawn audits see the provider's own arguments unchanged after the runtime flags, and the
   * container's environment is taken from the client process the supervisor composed (FR-EXE-07).
   */
  runArgv(spec: ContainerRunSpec): readonly string[];
  /** Environment variable names the client process needs to reach the runtime (socket, config); nothing else. */
  readonly clientEnvAllowlist: readonly string[];
  inspect(name: string): Promise<ContainerInspection | null>;
  /** Force-removes `name`; `removed` is false when it was already gone. Throws on any other failure. */
  remove(name: string): Promise<{ removed: boolean }>;
  listByLabel(
    label: string,
  ): Promise<ReadonlyArray<{ readonly name: string; readonly labels: Readonly<Record<string, string>> }>>;
}
