/** Glue between an adapter and the exec supervisor: probe runner and a single-invocation runner. */
import { type AcpDecide, type AcpRunEvent, runAcpAgent } from "../exec/acp/client.js";
import { acpState } from "../exec/acp/events.js";
import { supervise } from "../exec/index.js";
import { type AcpPermissionSnapshot, approvedBypass, decidePermission } from "../policy/acp-permission.js";
import {
  assertAcpPlanAudit,
  assertBypassAudit,
  assertMcpAudit,
  assertSafeModeAudit,
  bypassPermitted,
  type ChannelAuditContext,
} from "./audit.js";
import { acpDeclarations } from "./providers.js";
import { guardEvent, type ToolGuardContext } from "./tool-guard.js";
import {
  type AcpMessage,
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

function tailOf(stderr: Buffer): string {
  return stderr.subarray(Math.max(0, stderr.length - STDERR_TAIL_BYTES)).toString("utf8");
}

/**
 * `extractResult` is not given the stderr tail (the adapter contract), so a provider that reports a usage-limit stop
 * only on stderr (Cursor, T6.15) ends `TOOL_FAILURE` on its exit code. When the folded result is exactly that, the
 * adapter's `classifyFailure` is asked again with the captured tail; only a `QUOTA_EXHAUSTED` verdict replaces it, so
 * no other code, success included, changes (Assumption: quota is the one stderr-only verdict the adapters hold).
 */
function withStderrQuota(
  adapter: ProviderAdapter,
  result: RunResult,
  events: readonly NormalizedEvent[],
  exit: ExitInfo,
  stderrTail: string,
): RunResult {
  if (result.ok || result.failureCode !== "TOOL_FAILURE" || stderrTail === "") return result;
  const c = adapter.classifyFailure({
    events,
    exit,
    stderrTail,
    timedOut: exit.outcome === "timeout",
    cancelled: exit.outcome === "cancelled",
  });
  return c.code === "QUOTA_EXHAUSTED" ? { ...result, failureCode: c.code, failureDetail: c.detail } : result;
}

/** ProbeRunner backed by the supervisor. Only PATH is inherited. */
export function createProbeRunner(envAllowlist: readonly string[] = ["PATH"]): ProbeRunner {
  return async (argv, opts) => {
    const stdinText = opts?.stdinText;
    const until = stdinText !== undefined ? opts?.holdStdinUntil : undefined;
    let held = until !== undefined;
    const run = supervise({
      argv,
      envAllowlist,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(until !== undefined
        ? {
            keepStdinOpen: true,
            // Lines that are not JSON objects are only captured (the caller judges them), never a protocol error.
            isIgnorableLine: (line: string) => !line.trimStart().startsWith("{"),
            onEvent: (value: unknown) => {
              if (held && until(value)) {
                held = false;
                run.endStdin();
              }
            },
          }
        : stdinText !== undefined
          ? { stdinText }
          : {}),
      wallClockMs: opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      killGraceMs: 500,
    });
    if (until !== undefined && stdinText !== undefined) run.writeStdin(stdinText);
    const r = await run.result;
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      timedOut: r.outcome === "timeout",
      ...(r.error ? { spawnError: r.error.message } : {}),
      ...(until !== undefined ? { stdinOpenAtEnd: held } : {}),
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
  /** `acp-stdio` only: every message the client wrote (for a `provider_stdin` artifact after the redactor, item 3). */
  stdin?: Buffer;
}

/** What an `acp-stdio` run needs beyond the invocation (ADR-0036 item 9; T4.8). */
export interface AdapterRunAcpOptions {
  /** The frozen policy snapshot the permission answers are derived from. Required for `acp-stdio`. */
  snapshot: AcpPermissionSnapshot;
  /** Receives `acp_initialized`, `acp_permission` and `acp_request_refused` (persist as run events). */
  onRunEvent?: (event: AcpRunEvent) => void;
  /** Test seam: replaces `decidePermission`. Production callers never set it. */
  decide?: AcpDecide;
  /** Test seams for the Proposed bounds of ADR-0036 items 4 and 9.1. */
  initializeTimeoutMs?: number;
  sessionTimeoutMs?: number;
  permissionDecisionMs?: number;
  now?: () => number;
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
  /**
   * T9.4b: the run's injected tool channel as the controller opened it (definition path, offered tools). Without it
   * every `--mcp-config` and every MCP allow rule is refused (`./audit.ts` {@link assertMcpAudit}).
   */
  channel?: ChannelAuditContext;
  /** Passed to the supervisor: called after spawn, before any output is read, so pid/pgid can be persisted. */
  onSpawn?: (info: { pid: number; pgid: number }) => void;
  /** Required when the invocation's transport is `acp-stdio` (T4.8). */
  acp?: AdapterRunAcpOptions;
}

/** The guard's context for one run: HOME from the run's base environment (Switchboard's own when absent). */
function toolGuardContext(cwd: string, opts: AdapterRunOptions, bypass: boolean): ToolGuardContext {
  const home = (opts.baseEnv ?? process.env).HOME;
  return { cwd, bypass, ...(home ? { home } : {}) };
}

export interface AdapterRun {
  cancel(): Promise<void>;
  done: Promise<AdapterRunOutcome>;
}

/**
 * Spawn `inv` under the supervisor, feed each stdout JSONL document through `adapter.parseEvent`, and fold the
 * result with `adapter.extractResult`. Throws BypassFlagError before spawning if the audit refuses a bypass flag: every
 * bypass flag is refused unless `opts.profile` is `privileged`, `opts.bypassApproved` is true and the profile's scope
 * sets bypass (T3.17, `./audit.ts`). Throws McpConfigAuditError before spawning if `--mcp-config` or an MCP allow rule
 * is not exactly the controller's channel shape in an approved bypass run (T9.4b, ADR-0033), and IsolationAuditError if
 * a Claude Code argv lacks `--safe-mode` outside the approved bypass cases that omit it.
 */
export function startAdapterRun(adapter: ProviderAdapter, inv: Invocation, opts: AdapterRunOptions = {}): AdapterRun {
  if (inv.transport !== "subprocess-jsonl" && inv.transport !== "acp-stdio") {
    throw new Error(`unsupported transport: ${inv.transport}`);
  }
  const ctx =
    opts.profile !== undefined ? { profile: opts.profile, bypassApproved: opts.bypassApproved === true } : undefined;
  // T4.62 (ADR-0049 item 1): the adapter id adds that provider's scoped bypass-class flags (Kimi Code's `-p`/`--prompt`).
  assertBypassAudit(inv, ctx, adapter.id);
  // T4.8 (ADR-0036 items 7.3 and 10): the ACP plan is audited like argv; an `acp` plan elsewhere is refused too.
  assertAcpPlanAudit(inv, adapter.id, ctx);
  // T9.4b (ADR-0029 item 6): `--mcp-config` only in the controller's one channel shape; no other MCP rule.
  assertMcpAudit(inv, opts.channel, ctx);
  // ADR-0033 (owner decision 41): Claude Code keeps `--safe-mode` except in the approved bypass cases that omit it.
  if (adapter.id === "claude") assertSafeModeAudit(inv, ctx);

  if (inv.transport === "acp-stdio") return startAcpRun(adapter, inv, opts, bypassPermitted(ctx));

  const state = createParseState();
  if (inv.resumeNativeSessionId !== undefined) state.resumeNativeSessionId = inv.resumeNativeSessionId;
  const events: NormalizedEvent[] = [];
  const guardCtx = toolGuardContext(inv.cwd, opts, bypassPermitted(ctx));
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
      for (const parsed of adapter.parseEvent(JSON.stringify(value), state)) {
        const ev = guardEvent(parsed, guardCtx);
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
      result: withStderrQuota(adapter, adapter.extractResult(events, exit), events, exit, tailOf(r.stderr)),
      events,
      exit,
      stderrTail: tailOf(r.stderr),
      groupEmpty: r.groupEmpty,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  });
  return { cancel: () => run.cancel(), done };
}

/**
 * `acp-stdio` (FR-EXE-03, ADR-0036; T4.8): the shared ACP client drives the session; the adapter's `parseEvent` sees only
 * `session/update` notifications and the `session/prompt` response. Permission answers come from `decidePermission`
 * over the frozen snapshot, whose bypass carrier must agree with the run's (both `bypassApproved` values true and the
 * audit's {@link bypassPermitted}) before the allow-everything answer of owner decision 48 is reachable.
 */
function startAcpRun(
  adapter: ProviderAdapter,
  inv: Invocation,
  opts: AdapterRunOptions,
  bypassAdmitted: boolean,
): AdapterRun {
  const acp = opts.acp;
  if (acp === undefined) throw new Error("acp-stdio run without a permission snapshot");
  const plan = inv.acp;
  if (plan === undefined) throw new Error("acp-stdio invocation without an acp plan");
  const snapshot: AcpPermissionSnapshot = {
    ...acp.snapshot,
    profile: { ...acp.snapshot.profile, bypassApproved: acp.snapshot.profile.bypassApproved && bypassAdmitted },
  };
  const decl = acpDeclarations(adapter.id);
  const state = createParseState();
  const deniedToolCallIds = acpState(state).deniedToolCallIds;
  const events: NormalizedEvent[] = [];
  const guardCtx = toolGuardContext(inv.cwd, opts, bypassAdmitted);
  const push = (raw: NormalizedEvent) => {
    const ev = guardEvent(raw, guardCtx);
    events.push(ev);
    opts.onEvent?.(ev);
  };
  const run = runAcpAgent({
    argv: inv.argv,
    cwd: inv.cwd,
    envAllowlist: inv.envAllowlist,
    extraEnv: inv.env,
    ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
    wallClockMs: inv.timeouts.wallClockMs,
    idleMs: inv.timeouts.idleMs,
    killGraceMs: inv.timeouts.killGraceMs,
    maxLineBytes: inv.maxLineBytes,
    ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
    plan,
    parse: (msg: AcpMessage) => adapter.parseEvent(msg, state),
    onEvent: push,
    ...(acp.onRunEvent ? { onRunEvent: acp.onRunEvent } : {}),
    decide: acp.decide ?? ((params) => decidePermission(params, snapshot, decl)),
    deniedToolCallIds,
    bypassModeIds: decl?.bypassModeIds ?? [],
    approvedBypass: approvedBypass(snapshot.profile),
    ...(acp.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: acp.initializeTimeoutMs } : {}),
    ...(acp.sessionTimeoutMs !== undefined ? { sessionTimeoutMs: acp.sessionTimeoutMs } : {}),
    ...(acp.permissionDecisionMs !== undefined ? { permissionDecisionMs: acp.permissionDecisionMs } : {}),
    ...(acp.now ? { now: acp.now } : {}),
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
      result: withStderrQuota(adapter, adapter.extractResult(events, exit), events, exit, tailOf(r.stderr)),
      events,
      exit,
      stderrTail: tailOf(r.stderr),
      groupEmpty: r.groupEmpty,
      stdout: r.stdout,
      stderr: r.stderr,
      stdin: r.sent,
    };
  });
  return { cancel: () => run.cancel(), done };
}
