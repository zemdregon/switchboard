/**
 * Background index scheduler for the `serve` daemon (T12.4; FR-RAG-11, LLD §14.5).
 *
 * `trigger` only queues a project and returns at once: it never awaits a build, and the first step of a build runs on a
 * later turn of the event loop, so no caller (startup, an operator request, admission in T12.5) is ever held by one.
 * Builds run one at a time, in trigger order, with a project queued at most once. A periodic timer (unref'd, so it never
 * keeps the process alive) re-triggers every project for the freshness check. `exclusive` waits for the project's
 * running build to be aborted and finish, then runs an operator action (clear, rebuild) with no build of that project
 * running. `stop` aborts the running build and drops the queue.
 *
 * The scheduler knows nothing about stores or the ledger: `build` and `onResult` are injected.
 */
import type { BuildResult } from "./build.js";

/** Freshness re-check interval (Assumption, Delegated: a quarter of an hour; the build itself is incremental). */
export const RAG_REFRESH_INTERVAL_MS = 15 * 60_000;

export interface RagIndexerDeps {
  /** Build one project's store; `undefined` when the project no longer exists. */
  build(projectId: string, signal: AbortSignal): Promise<BuildResult | undefined>;
  /** Project ids to index at start and at every periodic check. */
  projects(): readonly string[];
  onResult?(result: BuildResult): void;
  onError?(projectId: string, err: unknown): void;
  intervalMs?: number;
}

export class RagIndexer {
  private readonly queue: string[] = [];
  private readonly held = new Set<string>();
  private running: { projectId: string; ctrl: AbortController; done: Promise<void> } | undefined;
  private draining: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly deps: RagIndexerDeps) {}

  /** Queue every project now and start the periodic check. Returns at once. */
  start(): void {
    this.triggerAll();
    this.timer = setInterval(() => this.triggerAll(), this.deps.intervalMs ?? RAG_REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  triggerAll(): void {
    for (const id of this.deps.projects()) this.trigger(id);
  }

  /** Queue one project. Never waits for the build. */
  trigger(projectId: string): void {
    if (this.stopped || this.queue.includes(projectId)) return;
    this.queue.push(projectId);
    this.kick();
  }

  /** The project being built, if any. */
  current(): string | undefined {
    return this.running?.projectId;
  }

  queued(): readonly string[] {
    return [...this.queue];
  }

  /** Resolves when the queue is empty and nothing is running (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.draining !== undefined) await this.draining;
  }

  /**
   * Run `fn` for a project with none of its builds running: a queued build is dropped, a running one is aborted and
   * awaited, and no build of the project starts until `fn` settles.
   */
  async exclusive<T>(projectId: string, fn: () => T | Promise<T>): Promise<T> {
    this.held.add(projectId);
    try {
      const i = this.queue.indexOf(projectId);
      if (i >= 0) this.queue.splice(i, 1);
      const r = this.running;
      if (r !== undefined && r.projectId === projectId) {
        r.ctrl.abort();
        await r.done;
      }
      return await fn();
    } finally {
      this.held.delete(projectId);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.queue.length = 0;
    this.running?.ctrl.abort();
    await this.idle();
  }

  private kick(): void {
    if (this.draining !== undefined) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (!this.stopped && this.queue.length > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r)); // the trigger's caller always continues first
    while (!this.stopped && this.queue.length > 0) {
      const projectId = this.queue.shift() as string;
      if (this.held.has(projectId)) continue;
      const ctrl = new AbortController();
      let finished: () => void = () => {};
      const done = new Promise<void>((r) => {
        finished = r;
      });
      this.running = { projectId, ctrl, done };
      try {
        const result = await this.deps.build(projectId, ctrl.signal);
        if (result !== undefined) this.deps.onResult?.(result);
      } catch (err) {
        this.deps.onError?.(projectId, err);
      } finally {
        this.running = undefined;
        finished();
      }
    }
  }
}
