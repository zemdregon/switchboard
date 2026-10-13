import type { AdapterRegistry } from "../adapters/index.js";

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
