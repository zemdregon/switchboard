/**
 * Preflight cache (NFR-PERF-02, T3.21; FRD BR-20). Caches the adapters' own `probe` and `authPreflight` results so that
 * `delegate_task` stage-1 eligibility, dispatch PREFLIGHT and `list_capabilities` do not re-spawn the provider binary
 * on every call.
 *
 * Rules (Delegated decision 29, ROADMAP §4.4):
 * - **Successes only.** A probe is cached only when every step is ok; auth only when the state is `OK`. A failed or
 *   throwing probe, `AUTH_REQUIRED` and `UNKNOWN` are never stored, so a user who installs a CLI or logs in is seen on
 *   the next call (fail closed, NFR-SEC-06).
 * - **Keyed by adapter id plus binary identity.** The identity of the cached probe is the resolved binary path with
 *   its `mtimeMs`, `size` and `ino`, read with `stat` at lookup. A changed identity (an upgrade replaces the file)
 *   invalidates the entry and the auth entry that depends on it. A binary that cannot be `stat`ed is never cached.
 * - **TTL.** An entry older than `ttlMs` is re-probed; this also covers a changed `PATH` resolution and a changed
 *   login state. `ttlMs <= 0` disables caching.
 * - **No secrets.** Only the status results the adapters already return are stored (versions, step outcomes, the
 *   `OK` auth state). Credentials, tokens and environment values never pass through here.
 */
import { statSync } from "node:fs";
import type { AuthResult, ProbeResult, ProbeRunner, ProviderAdapter } from "./types.js";

/** Assumption: 60 seconds; short enough that a login or upgrade is seen quickly, long enough to span one dispatch. */
export const DEFAULT_PREFLIGHT_TTL_MS = 60_000;

export interface BinaryIdentity {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
}

interface Entry {
  readonly probe: ProbeResult;
  readonly identity: BinaryIdentity;
  readonly at: number;
  auth?: { readonly at: number };
}

export interface PreflightCacheOptions {
  readonly ttlMs?: number;
  /** Clock in ms; injectable for tests. */
  readonly now?: () => number;
  /** Identity reader; injectable for tests. Returns undefined when the binary cannot be inspected. */
  readonly identify?: (binaryPath: string) => BinaryIdentity | undefined;
}

function statIdentity(path: string): BinaryIdentity | undefined {
  try {
    const s = statSync(path);
    return { path, mtimeMs: s.mtimeMs, size: s.size, ino: s.ino };
  } catch {
    return undefined;
  }
}

const same = (a: BinaryIdentity, b: BinaryIdentity) =>
  a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;

export class PreflightCache {
  readonly ttlMs: number;
  readonly #now: () => number;
  readonly #identify: (binaryPath: string) => BinaryIdentity | undefined;
  readonly #entries = new Map<string, Entry>();

  constructor(opts: PreflightCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PREFLIGHT_TTL_MS;
    this.#now = opts.now ?? (() => performance.now());
    this.#identify = opts.identify ?? statIdentity;
  }

  /** Drop every entry. */
  clear(): void {
    this.#entries.clear();
  }

  async probe(adapter: ProviderAdapter, runner: ProbeRunner): Promise<ProbeResult> {
    if (this.ttlMs <= 0) return adapter.probe(runner);
    const hit = this.#valid(adapter.id);
    if (hit) return hit.probe;
    this.#entries.delete(adapter.id);
    const probe = await adapter.probe(runner);
    if (probe.steps.length > 0 && probe.steps.every((s) => s.ok)) {
      const identity = this.#identify(probe.binaryPath);
      if (identity) this.#entries.set(adapter.id, { probe, identity, at: this.#now() });
    }
    return probe;
  }

  async authPreflight(adapter: ProviderAdapter, runner: ProbeRunner): Promise<AuthResult> {
    if (this.ttlMs <= 0) return adapter.authPreflight(runner);
    // Auth is cached only against a currently valid probe entry, so a binary change also drops the auth result.
    const entry = this.#valid(adapter.id);
    if (entry?.auth && this.#now() - entry.auth.at < this.ttlMs) return { state: "OK" };
    const auth = await adapter.authPreflight(runner);
    if (auth.state === "OK") {
      const current = this.#valid(adapter.id);
      if (current) current.auth = { at: this.#now() };
    }
    return auth;
  }

  #valid(id: string): Entry | undefined {
    const e = this.#entries.get(id);
    if (!e) return undefined;
    if (this.#now() - e.at >= this.ttlMs) return undefined;
    const now = this.#identify(e.identity.path);
    return now && same(now, e.identity) ? e : undefined;
  }
}
