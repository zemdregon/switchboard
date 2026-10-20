/**
 * A provider that already reported its final successful result is not failed by a later timeout (FR-EXE-01, LLD §8, ADR-0067;
 * regression of prod run run_01M5BZDDH2S2ANYFX32R337ER5). Claude Code emitted `result` (success) and then stayed alive
 * while a background shell ran; five minutes later the idle timeout fired and the run ended PROCESS_TIMEOUT. The fake
 * CLI's `edit_files` plan reproduces it with `linger` (result, then idle) and the plain failure with `stall` (no result).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "./fake/adapter.js";
import { FAKE_PROFILE } from "./fake/cases.js";
import { isIneligible } from "./index.js";
import { settleAfterFinalResult, startAdapterRun } from "./run.js";
import type { ExitInfo, NormalizedEvent } from "./types.js";

const SHORT = { wallClockMs: 10_000, idleMs: 400, killGraceMs: 300 };
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function runPlan(plan: object) {
  const cwd = mkdtempSync(path.join(tmpdir(), "sb-settled-"));
  dirs.push(cwd);
  const adapter = new FakeAdapter({ scenario: "edit_files", timeouts: SHORT });
  const inv = adapter.compile(
    { runId: "run_settled", objective: JSON.stringify(plan), constraints: [], workspace: { cwd, writable: true } },
    FAKE_PROFILE,
  );
  if (isIneligible(inv)) throw new Error(inv.detail);
  return startAdapterRun(adapter, inv).done;
}

describe("final result before a timeout (FR-EXE-01)", () => {
  it("a run that lingers after its successful result succeeds and records which bound settled it", async () => {
    const out = await runPlan({ files: { "a.txt": "x\n" }, summary: "work complete", linger: true });
    expect(out.exit.outcome).toBe("timeout");
    expect(out.exit.timeoutKind).toBe("idle");
    expect(out.result).toMatchObject({ ok: true, summary: "work complete" });
    expect(out.settledAfterResult).toBe("idle");
    expect(out.groupEmpty).toBe(true);
  });

  it("a run that goes quiet before any result still ends PROCESS_TIMEOUT (idle timeout)", async () => {
    const out = await runPlan({ files: { "a.txt": "x\n" }, stall: true });
    expect(out.result).toMatchObject({ ok: false, failureCode: "PROCESS_TIMEOUT", failureDetail: "idle timeout" });
    expect(out.settledAfterResult).toBeUndefined();
  });

  it("a failed final result is never upgraded", async () => {
    const out = await runPlan({ files: {}, ok: false, linger: true });
    expect(out.result.ok).toBe(false);
    expect(out.settledAfterResult).toBeUndefined();
  });

  it("a run that exits normally is unchanged", async () => {
    const out = await runPlan({ files: { "a.txt": "x\n" }, summary: "done" });
    expect(out.exit.outcome).toBe("exited");
    expect(out.result.ok).toBe(true);
    expect(out.settledAfterResult).toBeUndefined();
  });
});

describe("settleAfterFinalResult", () => {
  const adapter = new FakeAdapter({ scenario: "edit_files" });
  const timeout: ExitInfo = {
    outcome: "timeout",
    timeoutKind: "idle",
    exitCode: null,
    signal: "SIGTERM",
    expectedExitCodes: [0],
  };
  const ok: NormalizedEvent = { kind: "result", ok: true, summary: "done" };

  it("settles when only bookkeeping events follow the result", () => {
    const events: NormalizedEvent[] = [
      ok,
      { kind: "unknown", rawType: "system" },
      { kind: "usage", source: "provider_reported", metrics: {} },
    ];
    expect(settleAfterFinalResult(adapter, events, timeout)).toMatchObject({ ok: true, summary: "done" });
  });

  it("does not settle when the agent kept working after the result", () => {
    const after: NormalizedEvent[] = [
      { kind: "message", role: "assistant", text: "one more thing" },
      { kind: "tool_call", tool: "shell", name: "Bash" } as NormalizedEvent,
    ];
    for (const e of after) expect(settleAfterFinalResult(adapter, [ok, e], timeout)).toBeUndefined();
  });

  it("keeps the adapter's own fail-closed rules (an error event anywhere still fails)", () => {
    const events: NormalizedEvent[] = [{ kind: "provider_error", category: "tool", message: "x" }, ok];
    expect(settleAfterFinalResult(adapter, events, timeout)).toBeUndefined();
  });

  it("never settles for an adapter that does not declare settlesAfterFinalResult (the timeout decides)", () => {
    const undeclared = { extractResult: adapter.extractResult.bind(adapter) };
    expect(settleAfterFinalResult(undeclared, [ok], timeout)).toBeUndefined();
  });

  it("applies to timeouts only: no result, a crash or a cancellation is never settled", () => {
    expect(settleAfterFinalResult(adapter, [], timeout)).toBeUndefined();
    for (const outcome of ["crashed", "cancelled", "protocol_error"] as const) {
      expect(settleAfterFinalResult(adapter, [ok], { ...timeout, outcome })).toBeUndefined();
    }
  });
});
