/**
 * T3.12: `serve`'s retention GC interval timer. A process-level test cannot cover the interval: the smallest
 * configurable `retention.interval` is `1m` (the schema rejects anything smaller), so waiting for a real interval
 * pass in a spawned daemon is infeasible. These tests cover the extracted scheduling seam instead
 * (`scheduleRetentionGc` in `./serve.ts`, wired into `runDaemon` with no behaviour change): the pass runs at the
 * configured interval and never at scheduling time (the startup pass stays the explicit pre-lifecycle call), an
 * interval above `MAX_TIMER_MS` is capped (Node would otherwise clamp the delay to 1 ms with a
 * `TimeoutOverflowWarning`), a throwing or rejecting pass is logged without secrets and never stops later passes,
 * and shutdown clears the timer without holding the event loop. No provider, process or platform API is touched, so
 * this runs everywhere (no darwin skip, unlike the spawned-daemon suites).
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_TIMER_MS,
  type Logger,
  type RetentionGcTimers,
  scheduleRetentionGc,
} from "./serve.js";

interface StubEntry {
  callback: () => void;
  ms: number;
  cleared: boolean;
  unrefCalls: number;
}

function stubTimers(): { timers: RetentionGcTimers; entries: Map<object, StubEntry> } {
  const entries = new Map<object, StubEntry>();
  const setIntervalStub = ((callback: () => void, ms: number) => {
    const entry: StubEntry = { callback, ms, cleared: false, unrefCalls: 0 };
    const timer = {
      unref: () => {
        entry.unrefCalls += 1;
      },
    };
    entries.set(timer, entry);
    return timer;
  }) as unknown as typeof setInterval;
  const clearIntervalStub = ((timer: unknown) => {
    const entry = entries.get(timer as object);
    if (entry !== undefined) entry.cleared = true;
  }) as unknown as typeof clearInterval;
  return { timers: { setInterval: setIntervalStub, clearInterval: clearIntervalStub }, entries };
}

function onlyEntry(entries: Map<object, StubEntry>): StubEntry {
  expect(entries.size).toBe(1);
  const entry = [...entries.values()][0];
  if (entry === undefined) throw new Error("no timer scheduled");
  return entry;
}

function errorLog(): Pick<Logger, "error"> & { messages: unknown[][] } {
  const messages: unknown[][] = [];
  return {
    messages,
    error: (...args: unknown[]) => {
      messages.push(args);
    },
  };
}

describe("serve retention GC interval timer (T3.12)", () => {
  it("runs the pass at the configured interval, never at scheduling time", () => {
    const { timers, entries } = stubTimers();
    const run = vi.fn((): undefined | Promise<unknown> => undefined);
    const handle = scheduleRetentionGc(60_000, run, timers);
    // The startup pass is the explicit pre-lifecycle `await gcPass("startup")` in runDaemon, not this timer.
    expect(run).not.toHaveBeenCalled();
    const entry = onlyEntry(entries);
    expect(entry.ms).toBe(60_000);
    expect(handle.delayMs).toBe(60_000);
    expect(entry.unrefCalls).toBe(1);
    entry.callback();
    entry.callback();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("caps an interval above MAX_TIMER_MS instead of overflowing the Node timer", () => {
    for (const intervalMs of [MAX_TIMER_MS + 1, 30 * 24 * 60 * 60 * 1000]) {
      const { timers, entries } = stubTimers();
      const handle = scheduleRetentionGc(intervalMs, () => undefined, timers);
      expect(handle.delayMs).toBe(MAX_TIMER_MS);
      expect(onlyEntry(entries).ms).toBe(MAX_TIMER_MS);
    }
  });

  it("a synchronously throwing pass is logged without secrets and later passes still run", () => {
    const { timers, entries } = stubTimers();
    const log = errorLog();
    const run = vi.fn((): undefined | Promise<unknown> => undefined);
    run.mockImplementationOnce(() => {
      throw new Error("boom\nsecond line holds not-a-real-secret");
    });
    scheduleRetentionGc(60_000, run, timers, log);
    const entry = onlyEntry(entries);
    entry.callback();
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.messages).toEqual([["retention gc failed", { when: "interval", error: "boom" }]]);
    expect(JSON.stringify(log.messages)).not.toContain("not-a-real-secret");
    entry.callback();
    expect(run).toHaveBeenCalledTimes(2);
    expect(log.messages).toHaveLength(1);
  });

  it("a rejecting pass is logged without secrets and later passes still run", async () => {
    const { timers, entries } = stubTimers();
    const log = errorLog();
    const run = vi.fn((): undefined | Promise<unknown> => undefined);
    run.mockImplementationOnce(() => Promise.reject(new Error("async boom\nsecond line holds not-a-real-secret")));
    scheduleRetentionGc(60_000, run, timers, log);
    const entry = onlyEntry(entries);
    entry.callback();
    await new Promise((r) => setImmediate(r));
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.messages).toEqual([["retention gc failed", { when: "interval", error: "async boom" }]]);
    expect(JSON.stringify(log.messages)).not.toContain("not-a-real-secret");
    entry.callback();
    expect(run).toHaveBeenCalledTimes(2);
    expect(log.messages).toHaveLength(1);
  });

  it("shutdown stops the timer", () => {
    const { timers, entries } = stubTimers();
    const handle = scheduleRetentionGc(60_000, () => undefined, timers);
    const entry = onlyEntry(entries);
    expect(entry.cleared).toBe(false);
    handle.stop();
    expect(entry.cleared).toBe(true);
  });
});
