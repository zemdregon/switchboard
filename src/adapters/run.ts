/** Glue between an adapter and the exec supervisor: probe runner and a single-invocation runner. */
import { supervise } from "../exec/index.js";
import { assertBypassAudit } from "./audit.js";
import {
  createParseState,
  type ExitInfo,
  type Invocation,
  type NormalizedEvent,
  type ProbeRunner,
  type ProviderAdapter,
  type ResolvedProfile,
  type RunResult,
} from "./types.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000; // Proposed
const STDERR_TAIL_BYTES = 4096; // Proposed

/** ProbeRunner backed by the supervisor. Only PATH is inherited. */
export function createProbeRunner(envAllowlist: readonly string[] = ["PATH"]): ProbeRunner {
  return async (argv, opts) => {
    const r = await supervise({
      argv,
      envAllowlist,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      wallClockMs: opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      killGraceMs: 500,
    }).result;
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      timedOut: r.outcome === "timeout",
      ...(r.error ? { spawnError: r.error.message } : {}),
    };
  };
}

export interface AdapterRunOutcome {
  result: RunResult;
  events: NormalizedEvent[];
  exit: ExitInfo;
  stderrTail: string;
  groupEmpty: boolean;
  /** Raw captured streams, for the provider_stdout / provider_stderr artifacts (FR-EXE-05). */
  stdout: Buffer;
  stderr: Buffer;
}

export interface AdapterRunOptions {
  /** Called for every normalized event as it is parsed. */
  onEvent?: (event: NormalizedEvent) => void;
  /** Base environment for allowlisted names. Defaults to process.env. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * True only with a recorded approval (FR-POL-03, LLD §3.1 "Bypass"): computed by the lifecycle from an `APPROVED`
   * approval row whose scope sets bypass. On its own it admits nothing: see {@link AdapterRunOptions.profile}.
   */
  bypassApproved?: boolean;
  /**
   * The run's resolved profile (T3.17). A bypass flag passes the argv audit only when this is `privileged`,
   * `bypassApproved` is true and `profile.privilegedScope.scope.bypass` is true; without it every bypass flag is refused.
   */
  profile?: Pick<ResolvedProfile, "name" | "privilegedScope">;
  /** Passed to the supervisor: called after spawn, before any output is read, so pid/pgid can be persisted. */
  onSpawn?: (info: { pid: number; pgid: number }) => void;
}

export interface AdapterRun {
  cancel(): Promise<void>;
  done: Promise<AdapterRunOutcome>;
}

/**
 * Spawn `inv` under the supervisor, feed each stdout JSONL document through `adapter.parseEvent`, and fold the
 * result with `adapter.extractResult`. Throws BypassFlagError before spawning if the audit refuses a bypass flag: every
 * bypass flag is refused unless `opts.profile` is `privileged`, `opts.bypassApproved` is true and the profile's scope
 * sets bypass (T3.17, `./audit.ts`).
 */
export function startAdapterRun(adapter: ProviderAdapter, inv: Invocation, opts: AdapterRunOptions = {}): AdapterRun {
  if (inv.transport !== "subprocess-jsonl") throw new Error(`unsupported transport: ${inv.transport}`);
  assertBypassAudit(
    inv,
    opts.profile !== undefined ? { profile: opts.profile, bypassApproved: opts.bypassApproved === true } : undefined,
  );

  const state = createParseState();
  const events: NormalizedEvent[] = [];
  const run = supervise({
    argv: inv.argv,
    cwd: inv.cwd,
    envAllowlist: inv.envAllowlist,
    extraEnv: inv.env,
    ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
    ...(inv.stdin?.kind === "text" ? { stdinText: inv.stdin.value } : {}),
    wallClockMs: inv.timeouts.wallClockMs,
    idleMs: inv.timeouts.idleMs,
    killGraceMs: inv.timeouts.killGraceMs,
    maxLineBytes: inv.maxLineBytes,
    ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
    // The supervisor already parsed the line; the adapter contract takes the line text, so re-serialize.
    onEvent: (value) => {
      for (const ev of adapter.parseEvent(JSON.stringify(value), state)) {
        events.push(ev);
        opts.onEvent?.(ev);
      }
    },
  });

  const done = run.result.then((r): AdapterRunOutcome => {
    const exit: ExitInfo = {
      outcome: r.outcome,
      exitCode: r.exitCode,
      signal: r.signal,
      ...(r.timeoutKind ? { timeoutKind: r.timeoutKind } : {}),
      expectedExitCodes: inv.expectedExitCodes,
    };
    return {
      result: adapter.extractResult(events, exit),
      events,
      exit,
      stderrTail: r.stderr.subarray(Math.max(0, r.stderr.length - STDERR_TAIL_BYTES)).toString("utf8"),
      groupEmpty: r.groupEmpty,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  });
  return { cancel: () => run.cancel(), done };
}
