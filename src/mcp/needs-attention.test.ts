/**
 * T14.2 (FR-CTL-03, LLD §3.4.1): `get_run` and `list_runs` carry the derived `needs_attention` through the SDK client,
 * so each result is checked against the published output schema. A finished run has `{ active: false }` and no reason;
 * a run planted in a state with a reason shows it on both tools, and the `list_runs` row still equals `get_run`.
 * The `delegate_task` envelope is unchanged. Fake CLIs only; nothing live.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunState } from "../ledger/index.js";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

/** A run of client `orch` planted straight into the ledger (no dispatch: neither state is picked up). */
function planted(state: RunState, attempt = 1): string {
  const session = h.ledger.createMetaSession({ objective: "o" });
  const run = h.ledger.createRun({
    metaSessionId: session.id,
    state: state === "FAILED" ? "RUNNING" : state,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "orch",
    attempt,
  });
  if (state === "FAILED") {
    h.ledger.casRunState({
      runId: run.id,
      from: "RUNNING",
      to: "FAILED",
      expectedVersion: run.version,
      set: { failure_code: "VERIFY_FAILED" },
      payload: { to: "FAILED" },
    });
  }
  return run.id;
}

const rowOf = async (runId: string): Promise<Json> =>
  (await h.ok("list_runs", {})).runs.find((r: Json) => r.run_id === runId);

describe("needs_attention on get_run and list_runs (T14.2, FR-CTL-03)", () => {
  it("a finished run carries { active: false } with no reason; delegate_task's envelope has no field", async () => {
    const submitted = await h.ok("delegate_task", {
      objective: "Fix the parser crash",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
    });
    expect(submitted.needs_attention).toBeUndefined();
    const delegated = await h.settle(submitted.run_id);
    expect(delegated.status).toBe("SUCCEEDED");
    const got = await h.ok("get_run", { run_id: delegated.run_id });
    expect(got.needs_attention).toEqual({ active: false });
    expect(await rowOf(delegated.run_id)).toEqual(got);
  });

  it("awaiting_approval and failed_after_retry show on both tools, matching get_run row for row", async () => {
    const waiting = planted("AWAITING_APPROVAL");
    const exhausted = planted("FAILED", 8);
    const retryable = planted("FAILED", 1);
    expect((await h.ok("get_run", { run_id: waiting })).needs_attention).toEqual({
      active: true,
      reason: "awaiting_approval",
    });
    expect((await h.ok("get_run", { run_id: exhausted })).needs_attention).toEqual({
      active: true,
      reason: "failed_after_retry",
    });
    expect((await h.ok("get_run", { run_id: retryable })).needs_attention).toEqual({ active: false });
    const { runs } = await h.ok("list_runs", {});
    for (const row of runs) expect(row).toEqual(await h.ok("get_run", { run_id: row.run_id }));
    expect(runs.map((r: Json) => r.needs_attention?.reason)).toEqual(
      expect.arrayContaining(["awaiting_approval", "failed_after_retry"]),
    );
  });

  it("include_events keeps working alongside the flag", async () => {
    const waiting = planted("AWAITING_APPROVAL");
    const got = await h.ok("get_run", { run_id: waiting, include_events: { after_seq: 0, limit: 10 } });
    expect(got.needs_attention).toEqual({ active: true, reason: "awaiting_approval" });
    expect(Array.isArray(got.events)).toBe(true);
  });
});
