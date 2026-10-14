/**
 * T7.12 (FR-RTE-08, Q-90, LLD §17.6): model pinning. When affinity holds and the request names no model, the project's
 * remembered model goes to `compile` only for an adapter that declares that a model id its native session reports is
 * accepted by its model flag, and only when stage 1 (the model registry and the adapter's own `compile`) still admits
 * it; otherwise the run keeps the adapter default and `affinity.model_pin` says why. A model changes only for
 * `user_request` or `ineligible`. Scripted fake adapters only; no provider CLI is run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../adapters/claude/index.js";
import { CodexAdapter } from "../adapters/codex/index.js";
import { CursorAdapter } from "../adapters/cursor/adapter.js";
import { acceptsReportedModel } from "../adapters/index.js";
import { type AffinityRecord, planModelPin } from "./affinity.js";
import { replayRouteDecision } from "./decision.js";
import { compiled, down, type Harness, type Json, pinning, refusesModel, startHarness } from "./fixtures/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const start = async () => {
  h = await startHarness();
  return h;
};
const affinityOf = async (hh: Harness, runId: string): Promise<Json> =>
  (await hh.ok("explain_route", { run_id: runId })).affinity as Json;
const compiledFor = (runId: string) => compiled.filter((c) => c.runId === runId).map((c) => c.model);
const storedModel = (hh: Harness, runId: string) =>
  (JSON.parse(hh.ledger.getRunRecord(runId)?.request_json ?? "{}") as { model?: string }).model;
const replayAll = (hh: Harness) => {
  for (const r of hh.decisions()) expect(replayRouteDecision(r), r.id).toMatchObject({ ok: true, schemaVersion: 2 });
};

describe("model pinning at compile (T7.12)", () => {
  it("a held decision on an adapter that declares the field compiles with the remembered model", async () => {
    const hh = await start();
    pinning.add("fake");
    const first = await hh.delegate("ok");
    expect(first).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    // A first run is scored, not held: nothing to pin, no model_pin, the adapter default.
    expect((await affinityOf(hh, first.run_id)).model_pin).toBeUndefined();
    expect(compiledFor(first.run_id)).toEqual([undefined]);
    expect(hh.ledger.listProjectAffinities()[0]).toMatchObject({ provider: "fake", model: "fake-model" });

    const second = await hh.delegate("ok");
    expect(second).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(await affinityOf(hh, second.run_id)).toMatchObject({
      held: true,
      model: "fake-model",
      model_pin: { model: "fake-model", outcome: "pinned" },
    });
    expect(compiledFor(second.run_id)).toEqual(["fake-model"]);
    expect(storedModel(hh, second.run_id)).toBe("fake-model");
    // The project keeps its model: the held run reported it again.
    expect(hh.ledger.listProjectAffinities()[0]).toMatchObject({ provider: "fake", model: "fake-model" });
    replayAll(hh);
  }, 120_000);

  it("an adapter that does not declare it (Codex today) compiles with no model and the decision records why", async () => {
    const hh = await start();
    await hh.delegate("ok");
    const held = await hh.delegate("ok");
    expect(await affinityOf(hh, held.run_id)).toMatchObject({
      held: true,
      model: "fake-model",
      model_pin: { model: null, outcome: "adapter_not_declared" },
    });
    expect(compiledFor(held.run_id)).toEqual([undefined]);
    expect(storedModel(hh, held.run_id)).toBeUndefined();
    replayAll(hh);
  }, 120_000);

  it("a model the adapter refuses keeps the provider and its default (fail closed, not a switch reason)", async () => {
    const hh = await start();
    pinning.add("fake");
    refusesModel.add("fake");
    await hh.delegate("ok");
    const held = await hh.delegate("ok");
    expect(held).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(await affinityOf(hh, held.run_id)).toMatchObject({
      held: true,
      affinity_switch_reason: null,
      model_pin: { model: null, outcome: "model_refused", refused_code: "CAPABILITY_MISSING" },
    });
    expect(compiledFor(held.run_id)).toEqual([undefined]);
    replayAll(hh);
  }, 120_000);

  it("a model changes only for user_request or ineligible: the new provider runs with its adapter default", async () => {
    const hh = await start();
    for (const id of ["fake", "fake-b", "grok"]) pinning.add(id);
    await hh.delegate("ok");
    // user_request: the project moves to fake-b, which has no remembered model for it yet.
    const moved = await hh.delegate("ok", { provider_preference: "fake-b", require_provider: true });
    expect(moved.provider.adapter).toBe("fake-b");
    const movedAffinity = await affinityOf(hh, moved.run_id);
    expect(movedAffinity).toMatchObject({ held: false, affinity_switch_reason: "user_request" });
    expect(movedAffinity.model_pin).toBeUndefined();
    expect(compiledFor(moved.run_id)).toEqual([undefined]);
    // Held on fake-b: its own reported model is pinned, never fake's.
    const held = await hh.delegate("ok");
    expect(await affinityOf(hh, held.run_id)).toMatchObject({
      held: true,
      model_pin: { model: "fake-b-model", outcome: "pinned" },
    });
    expect(compiledFor(held.run_id)).toEqual(["fake-b-model"]);
    // ineligible: fake-b goes down, the project moves, and the new provider gets no pinned model.
    down.add("fake-b");
    const away = await hh.delegate("ok");
    expect(away.provider.adapter).not.toBe("fake-b");
    expect(await affinityOf(hh, away.run_id)).toMatchObject({ affinity_switch_reason: "ineligible" });
    expect(compiledFor(away.run_id)).toEqual([undefined]);
    replayAll(hh);
  }, 120_000);

  it("admission refuses a model that is not a plain id", async () => {
    const hh = await start();
    await expect(
      hh.lifecycle.submit({
        clientId: "orch",
        objective: "ok",
        workspace: hh.repo,
        trustProfile: "edit-untrusted",
        provider: "fake",
        model: "--not-a-model",
      }),
    ).rejects.toThrow(/plain model id/);
  }, 60_000);
});

describe("planModelPin and the adapter declarations (T7.12)", () => {
  const record = (over: Partial<AffinityRecord> = {}): AffinityRecord => ({
    enabled: true,
    project_key: "p",
    provider: "fake",
    model: "m-a",
    held: true,
    affinity_switch_reason: null,
    scored: false,
    applies: true,
    excluded_from_score: null,
    ...over,
  });

  it("pins only a held, applying decision with a remembered model on a declaring adapter outside privileged", () => {
    expect(planModelPin(record(), true, false)).toEqual({ candidate: "m-a", outcome: "pinned" });
    expect(planModelPin(record(), false, false)).toEqual({ candidate: null, outcome: "adapter_not_declared" });
    expect(planModelPin(record({ model: null }), true, false)).toEqual({
      candidate: null,
      outcome: "no_remembered_model",
    });
    expect(planModelPin(record(), true, true)).toEqual({ candidate: null, outcome: "privileged" });
    expect(planModelPin(record({ held: false, affinity_switch_reason: "user_request" }), true, false)).toBeNull();
    expect(planModelPin(record({ applies: false }), true, false)).toBeNull();
    expect(planModelPin(null, true, false)).toBeNull();
  });

  it("Claude declares accepted; Cursor and Codex do not; a missing or malformed declaration is not accepted", () => {
    expect(acceptsReportedModel(new ClaudeAdapter())).toBe(true);
    expect(acceptsReportedModel(new CursorAdapter())).toBe(false);
    expect(acceptsReportedModel(new CodexAdapter())).toBe(false);
    expect(acceptsReportedModel({})).toBe(false);
    expect(acceptsReportedModel({ reportedModelFlag: "accepted" })).toBe(false);
    expect(acceptsReportedModel({ reportedModelFlag: { kind: "maybe" } })).toBe(false);
  });
});
