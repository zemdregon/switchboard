/**
 * T8.2 wrapper-boundary span builders (FR-TEL-02, FR-TEL-03, LLD §7, ADR-0012).
 *
 * Spans are built from controller-observed facts only — admission rows, the spawn callback and process exit — never
 * from provider transcripts, stdout/stderr text or provider global hook config. The builders accept only the typed
 * facts below and set only LLD §7 allowlisted keys, so a forbidden category (prompt text, constraints, command lines,
 * file contents, environment values) has no path onto a span attribute by construction. The export-time drop filter
 * for any other key remains T8.4; span parent links land with the collector test in T8.3.
 */
import type { CompletedSpan, Telemetry } from "./index.js";

export const CONTROLLER_DELEGATE_SPAN = "controller.delegate";
export const PROVIDER_SPAWN_SPAN = "provider.spawn";

/**
 * Facts the controller observed about one delegation (one admitted `delegate_task`/`continue_task`). Only
 * controller-side fields; the objective/constraints stay out by construction.
 */
export interface DelegateSpanFacts {
  readonly runId: string;
  readonly sessionId: string;
  readonly provider: string | null;
  readonly trustProfile: string;
  /** T7.12: the model pinned at admission, when the request pinned one. */
  readonly model?: string;
  /** T6.5: the ledger attempt number; recorded only for a retry successor (attempt > 1). */
  readonly attempt?: number;
  /** Terminal run state observed at span end. */
  readonly terminalState: string;
  /** Run failure code when the terminal state is FAILED. */
  readonly failureCode?: string | null;
}

/** Facts the controller observed about the provider process of one run. */
export interface SpawnSpanFacts {
  readonly runId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly trustProfile: string;
  /** Preflight-reported adapter binary version. */
  readonly adapterVersion?: string | undefined;
  /** T7.12: the model pinned at admission, when the request pinned one. */
  readonly model?: string;
  /** The invocation transport the adapter compiled (`subprocess-jsonl`, `acp-stdio`). */
  readonly transport?: string;
  /** T6.5: recorded only for a retry successor (attempt > 1). */
  readonly attempt?: number;
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
}

/** `controller.delegate`: one per admitted delegation (LLD §7); a root until T8.3 adds parent links. */
export function delegateSpan(startTime: number, endTime: number, facts: DelegateSpanFacts): CompletedSpan {
  return {
    name: CONTROLLER_DELEGATE_SPAN,
    startTime,
    endTime,
    attributes: {
      "run.id": facts.runId,
      "session.id": facts.sessionId,
      ...(facts.provider !== null ? { provider: facts.provider } : {}),
      trust_profile: facts.trustProfile,
      ...(facts.model !== undefined ? { model: facts.model } : {}),
      ...(facts.attempt !== undefined && facts.attempt > 1 ? { "retry.attempt": facts.attempt } : {}),
      "run.state": facts.terminalState,
      ...(facts.terminalState === "FAILED" && facts.failureCode ? { "failure.code": facts.failureCode } : {}),
      duration_ms: Math.max(0, endTime - startTime),
    },
  };
}

/** `provider.spawn`: the provider process lifetime of one run (LLD §7). */
export function spawnSpan(startTime: number, endTime: number, facts: SpawnSpanFacts): CompletedSpan {
  return {
    name: PROVIDER_SPAWN_SPAN,
    startTime,
    endTime,
    attributes: {
      "run.id": facts.runId,
      "session.id": facts.sessionId,
      provider: facts.provider,
      trust_profile: facts.trustProfile,
      ...(facts.adapterVersion !== undefined ? { "adapter.version": facts.adapterVersion } : {}),
      ...(facts.model !== undefined ? { model: facts.model } : {}),
      ...(facts.transport !== undefined ? { transport: facts.transport } : {}),
      ...(facts.attempt !== undefined && facts.attempt > 1 ? { "retry.attempt": facts.attempt } : {}),
      ...(facts.exitCode !== null && facts.exitCode !== undefined ? { "exit.code": facts.exitCode } : {}),
      ...(facts.exitSignal !== null && facts.exitSignal !== undefined ? { "exit.signal": facts.exitSignal } : {}),
      duration_ms: Math.max(0, endTime - startTime),
    },
  };
}

/**
 * Per-process span tracker owned by `RunLifecycle`. Starts are remembered by run id; finishes build the completed
 * span from the allowlisted facts and hand it to the telemetry sink fire-and-forget. Without a start fact (a run
 * admitted before telemetry existed) no span is invented. Every method never throws: telemetry must not fail a run.
 */
export class SpanTracker {
  private readonly delegateStarts = new Map<string, number>();
  private readonly spawnStarts = new Map<string, number>();

  constructor(private readonly telemetry: Telemetry | undefined) {}

  delegateStarted(runId: string, startTime: number): void {
    if (!this.telemetry) return;
    this.delegateStarts.set(runId, startTime);
  }

  delegateFinished(runId: string, endTime: number, facts: DelegateSpanFacts): void {
    const startTime = this.delegateStarts.get(runId);
    this.delegateStarts.delete(runId);
    if (startTime === undefined) return;
    this.submit(delegateSpan(startTime, endTime, facts));
  }

  spawnStarted(runId: string, startTime: number): void {
    if (!this.telemetry) return;
    this.spawnStarts.set(runId, startTime);
  }

  spawnFinished(runId: string, endTime: number, facts: SpawnSpanFacts): void {
    const startTime = this.spawnStarts.get(runId);
    this.spawnStarts.delete(runId);
    if (startTime === undefined) return;
    this.submit(spawnSpan(startTime, endTime, facts));
  }

  /** Drops a started spawn without emitting (no exit facts were observed; the tracker never invents them). */
  discardSpawn(runId: string): void {
    this.spawnStarts.delete(runId);
  }

  private submit(span: CompletedSpan): void {
    try {
      this.telemetry?.recordSpan(span);
    } catch {
      // Best effort only (T8.1): export failures are dropped, never surfaced to a run.
    }
  }
}
