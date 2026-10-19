import type { AdapterRegistry } from "../adapters/index.js";
import type { LoadReader } from "../capacity/host-load.js";
import type { ContainerRuntime } from "../environment/runtime.js";
import type { OuterSandboxAvailability } from "../exec/outer-sandbox.js";
import type { InnerBackend } from "../inner/port.js";
import type { EmbeddingBackend } from "../retrieval/embedding.js";
import type { DiskProbe } from "../workspace/disk.js";

/** Injectable process surface so tests call `main` directly (no spawn). */
export interface CliIo {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
  readonly env: Record<string, string | undefined>;
  readonly homedir?: string;
  /** OS user recorded on operator records. */
  readonly user?: string;
  /** Defaults to `process.versions.node`. */
  readonly nodeVersion?: string;
  /** Adapters `doctor` probes. Defaults to the fake adapter only (M1). */
  readonly adapters?: AdapterRegistry;
  readonly now?: () => Date;
  /** Test seam (T11.7): an inner backend to use instead of the one the configuration names (`doctor`, `inner test`). */
  readonly innerBackend?: InnerBackend;
  /** Test seam (T12.4): an embedding backend to use instead of the one `rag.embedding` names (`index`, `doctor`). */
  readonly ragBackend?: EmbeddingBackend;
  /** `adapters validate` only (T4.4): the manifest directory to read and write. Tests inject it; default is the source tree. */
  readonly manifestDir?: string;
  /** `consent hash-passphrase` only (T13.8): test seam for reading stdin. */
  readonly readStdin?: () => Promise<string>;
  /** Test seam (NFR-SEC-04): the effective uid `serve` and `doctor` check. Defaults to `process.geteuid()`. */
  readonly effectiveUid?: () => number | undefined;
  /** Test seam (T3.1): outer-sandbox availability for `doctor` instead of probing this host. */
  readonly outerSandbox?: OuterSandboxAvailability;
  /** Test seam (T10.3): the container runtime `projects validate` and `gc --apply` use instead of rootless Docker. */
  readonly containerRuntime?: () => ContainerRuntime;
  /** Test seam (T3.23): the free-space probe `doctor` and `serve` use for `limits.min_free_disk_mb` instead of `statfs`. */
  readonly diskProbe?: DiskProbe;
  /** Test seam (T3.24): the load reader `doctor` uses for `host.max_load1` instead of `os.loadavg()`. */
  readonly loadReader?: LoadReader;
}

/** Stable `--json` schema version for every command (Proposed). */
export const JSON_SCHEMA_VERSION = 1;

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * Environment names passed to probe and auth-status commands (`doctor`, `serve`). Proposed (T2.6): the same PATH and
 * HOME the Claude and Codex invocations already allow (their `envAllowlist`), because a provider CLI's own status
 * command needs HOME to find the login it cached itself (Assumption, checked by the live smoke test). Switchboard
 * never reads those files; nothing else, and no API-key variable, is passed (ADR-0003, FR-EXE-07).
 */
export const PROBE_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];
