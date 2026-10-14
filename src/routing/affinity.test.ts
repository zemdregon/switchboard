/**
 * T7.5 (FR-RTE-06, FR-RTE-07, FR-CAP-06 amended, BR-45, Q-51, LLD §3.2, §17.6): the affinity step on scripted fake
 * adapters through the MCP server. A project keeps its provider across meta-sessions; each listed reason moves it and
 * is recorded; a preference alone does not; the old provider recovering does not move it back; a failed first run
 * creates no row; disabled affinity reads and writes nothing; T6.7's switch counts show the recorded reasons. Every
 * decision still replays exactly (T7.2).
 */
import { afterEach, describe, expect, it } from "vitest";
import { replayRouteDecision } from "./decision.js";
import { down, type Harness, type Json, startHarness } from "./fixtures/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const start = async (opts: Parameters<typeof startHarness>[0] = {}) => {
  h = await startHarness(opts);
  return h;
};
const affinityOf = async (hh: Harness, runId: string): Promise<Json> =>
  (await hh.ok("explain_route", { run_id: runId })).affinity as Json;
const row = (hh: Harness) => hh.ledger.listProjectAffinities()[0];
const eventsOf = (hh: Harness, runId: string, type: string) =>
  hh.ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => JSON.parse(e.payload_json) as Json);
const replayAll = (hh: Harness) => {
  for (const r of hh.decisions()) expect(replayRouteDecision(r), r.id).toMatchObject({ ok: true, schemaVersion: 2 });
};

describe("affinity step (T7.5)", () => {
  it("keeps a project on its provider across meta-sessions; a preference is not a reason; require_provider is", async () => {
    const hh = await start();
    const first = await hh.delegate("ok");
    expect(first.provider.adapter).toBe("fake");
    expect(await affinityOf(hh, first.run_id)).toMatchObject({
      enabled: true,
      provider: null,
      held: false,
      affinity_switch_reason: null,
      scored: true,
      applies: true,
    });
    expect(row(hh)).toMatchObject({ provider: "fake", last_run_id: first.run_id, last_switch_reason: null });
    expect(eventsOf(hh, first.run_id, "routing_affinity_switched")).toEqual([
      expect.objectContaining({ from_provider: null, to_provider: "fake", reason: null }),
    ]);

    // A new meta-session with a preference for another provider: affinity holds (the hint is not a reason, LLD §3.2).
    const second = await hh.delegate("ok", { provider_preference: "grok" });
    expect(second.provider.adapter).toBe("fake");
    expect(await affinityOf(hh, second.run_id)).toMatchObject({
      provider: "fake",
      held: true,
      affinity_switch_reason: null,
      scored: false,
    });
    expect(eventsOf(hh, second.run_id, "routing_affinity_held")).toHaveLength(1);

    // require_provider naming another provider is a user request; the project moves and stays there.
    const third = await hh.delegate("ok", { provider_preference: "fake-b", require_provider: true });
    expect(third.provider.adapter).toBe("fake-b");
    expect(await affinityOf(hh, third.run_id)).toMatchObject({ held: false, affinity_switch_reason: "user_request" });
    expect(row(hh)).toMatchObject({ provider: "fake-b", last_switch_reason: "user_request" });
    const fourth = await hh.delegate("ok");
    expect(fourth.provider.adapter).toBe("fake-b");
    expect(await affinityOf(hh, fourth.run_id)).toMatchObject({ held: true, provider: "fake-b" });
    // require_provider naming the affine provider holds.
    const fifth = await hh.delegate("ok", { provider_preference: "fake-b", require_provider: true });
    expect(await affinityOf(hh, fifth.run_id)).toMatchObject({ held: true, affinity_switch_reason: null });
    replayAll(hh);
  }, 120_000);

  it("ineligible moves the project; the old provider recovering does not move it back (Q-51)", async () => {
    const hh = await start();
    await hh.delegate("ok");
    down.add("fake");
    const moved = await hh.delegate("ok");
    expect(moved.provider.adapter).toBe("fake-b");
    expect(await affinityOf(hh, moved.run_id)).toMatchObject({
      provider: "fake",
      affinity_switch_reason: "ineligible",
    });
    down.delete("fake");
    const after = await hh.delegate("ok");
    expect(after.provider.adapter).toBe("fake-b");
    expect(await affinityOf(hh, after.run_id)).toMatchObject({ held: true, provider: "fake-b" });
    expect(row(hh)).toMatchObject({ provider: "fake-b", last_switch_reason: "ineligible" });
    replayAll(hh);
  }, 120_000);

  it("a quota failover re-bases affinity with capacity_exhausted", async () => {
    const hh = await start();
    await hh.delegate("ok");
    const quota = await hh.delegate("quota");
    expect(quota).toMatchObject({ provider: { adapter: "fake" }, failure_code: "QUOTA_EXHAUSTED" });
    await hh.waitFor(() => hh.ledger.findSuccessorRun(quota.run_id) !== undefined);
    const successor = hh.ledger.findSuccessorRun(quota.run_id);
    const done = await hh.settle(successor?.id as string);
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake-b" } });
    expect(await affinityOf(hh, done.run_id)).toMatchObject({
      provider: "fake",
      held: false,
      affinity_switch_reason: "capacity_exhausted",
      applies: true,
    });
    expect(row(hh)).toMatchObject({ provider: "fake-b", last_switch_reason: "capacity_exhausted" });
    replayAll(hh);
  }, 120_000);

  it("a quota stop on the affine provider without failover gives capacity_exhausted at the next routing step", async () => {
    const hh = await start();
    await hh.delegate("ok");
    const quota = await hh.delegate("quota", { provider_preference: "fake", require_provider: true });
    expect(quota.failure_code).toBe("QUOTA_EXHAUSTED");
    const next = await hh.delegate("ok");
    expect(next.provider.adapter).not.toBe("fake");
    expect(await affinityOf(hh, next.run_id)).toMatchObject({
      affinity_switch_reason: "capacity_exhausted",
      excluded_from_score: "fake",
      scored: true,
    });
    replayAll(hh);
  }, 120_000);

  it("an exhausted retry chain on the affine provider gives failed_after_retry", async () => {
    const hh = await start({ maxAttempts: 2 });
    await hh.delegate("ok");
    const failed = await hh.delegate("overload");
    expect(failed.provider.adapter).toBe("fake");
    const retry = await hh.settle(failed.superseded_by as string);
    expect(retry).toMatchObject({ status: "FAILED", failure_code: "PROVIDER_OVERLOADED" });
    await hh.waitFor(() => eventsOf(hh, retry.run_id, "retry_not_scheduled").length > 0);
    const next = await hh.delegate("ok");
    expect(next.provider.adapter).not.toBe("fake");
    expect(await affinityOf(hh, next.run_id)).toMatchObject({ affinity_switch_reason: "failed_after_retry" });
    expect(row(hh)).toMatchObject({ provider: next.provider.adapter, last_switch_reason: "failed_after_retry" });
    replayAll(hh);
  }, 120_000);

  it("a failed first run creates no row; the next decision is again a first run", async () => {
    const hh = await start({ maxAttempts: 1 });
    const failed = await hh.delegate("overload", { provider_preference: "fake" });
    expect(failed.status).toBe("FAILED");
    expect(hh.ledger.listProjectAffinities()).toEqual([]);
    const next = await hh.delegate("ok");
    expect(await affinityOf(hh, next.run_id)).toMatchObject({ provider: null, affinity_switch_reason: null });
  }, 120_000);

  it("disabled affinity reads and writes no row", async () => {
    const off = { routing: { affinity: { enabled: false, lowWaterMark: null, minConfidence: null } } };
    const hh = await start({ config: off, lifecycle: off });
    const a = await hh.delegate("ok");
    await hh.delegate("ok", { provider_preference: "grok" });
    expect(hh.ledger.listProjectAffinities()).toEqual([]);
    expect(await affinityOf(hh, a.run_id)).toMatchObject({ enabled: false, applies: false, held: false });
    replayAll(hh);
  }, 120_000);

  it("a continuation does not move the project (FR-SES-03 governs)", async () => {
    const hh = await start();
    const first = await hh.delegate("ok");
    const handed = await hh.ok("continue_task", {
      meta_session_id: first.meta_session_id,
      instruction: "ok",
      routing: { provider_preference: "grok" },
    });
    const done = await hh.settle(handed.run_id);
    expect(done.provider.adapter).toBe("grok");
    expect(await affinityOf(hh, done.run_id)).toMatchObject({ applies: false, held: false });
    expect(row(hh)).toMatchObject({ provider: "fake", last_run_id: first.run_id });
  }, 120_000);

  it("get_capacity's switch counts show the recorded reasons instead of unrecorded (T6.7)", async () => {
    const hh = await start();
    await hh.delegate("ok");
    await hh.delegate("ok", { provider_preference: "fake-b", require_provider: true });
    await hh.delegate("ok");
    const cap = await hh.ok("get_capacity", {});
    expect(cap.affinity.projects).toEqual([
      expect.objectContaining({ runs: 3, kept: 1, switched: { user_request: 1 } }),
    ]);
  }, 120_000);
});
