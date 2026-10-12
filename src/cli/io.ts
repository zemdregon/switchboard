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
