/**
 * Minimum capability routing tests (FR-RTE-01, BR-1, BR-3, BR-4, T7.8).
 *
 * A request with `routing.minimum_capability` evaluates against operator-declared model capabilities in the model
 * registry. Admitted providers compile with the model that satisfied the capability check. Undeclared models fail
 * closed with `CAPABILITY_MISSING`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistry } from "../models/registry.js";
import { replayRouteDecision } from "./decision.js";
import { compiled, type Harness, type Json, pinning, startHarness } from "./fixtures/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const models = new ModelRegistry(
  new Map([
    [
      "fake",
      {
        ids: ["fake-low", "fake-high"],
        capabilities: { "fake-low": "low", "fake-high": "high" },
      },
    ],
    [
      "fake-b",
      {
        ids: ["fake-b-med"],
        capabilities: { "fake-b-med": "medium" },
      },
    ],
  ]),
);

const start = async (m: ModelRegistry = models) => {
  h = await startHarness({ models: m });
  return h;
};

const compiledFor = (runId: string) => compiled.filter((c) => c.runId === runId).map((c) => c.model);
const storedModel = (hh: Harness, runId: string) =>
  (JSON.parse(hh.ledger.getRunRecord(runId)?.request_json ?? "{}") as { model?: string }).model;
const replayAll = (hh: Harness) => {
  for (const r of hh.decisions()) expect(replayRouteDecision(r), r.id).toMatchObject({ ok: true, schemaVersion: 2 });
};

describe("minimum_capability routing (T7.8, FR-RTE-01)", () => {
  it("routes only to providers with a declared model at or above the floor and compiles with that model", async () => {
    const hh = await start();
    pinning.add("fake");
    pinning.add("fake-b");

    // minimum_capability: high. Only fake has a declared model with capability >= high (fake-high).
    // fake-b has medium, grok has no declared capability.
    const res = await hh.delegate("ok", { minimum_capability: "high" });
    expect(res).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(compiledFor(res.run_id)).toEqual(["fake-high"]);
    expect(storedModel(hh, res.run_id)).toBe("fake-high");

    // Check explain_route: excluded candidates show CAPABILITY_MISSING
    const explained = await hh.ok("explain_route", { run_id: res.run_id });
    const candidates = explained.candidates as { provider: string; eligible: boolean; reasons: { code: string }[] }[];
    const fakeBCand = candidates.find((c) => c.provider === "fake-b");
    const grokCand = candidates.find((c) => c.provider === "grok");
    expect(fakeBCand?.eligible).toBe(false);
    expect(fakeBCand?.reasons[0]?.code).toBe("CAPABILITY_MISSING");
    expect(grokCand?.eligible).toBe(false);
    expect(grokCand?.reasons[0]?.code).toBe("CAPABILITY_MISSING");

    replayAll(hh);
  }, 120_000);

  it("admits multiple providers meeting the floor and respects provider_preference", async () => {
    const hh = await start();
    pinning.add("fake");
    pinning.add("fake-b");

    // minimum_capability: medium. Both fake (fake-high >= medium) and fake-b (fake-b-med >= medium) are eligible.
    // Preference for fake-b selects fake-b.
    const res = await hh.delegate("ok", { minimum_capability: "medium", provider_preference: "fake-b" });
    expect(res).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake-b" } });
    expect(compiledFor(res.run_id)).toEqual(["fake-b-med"]);
    expect(storedModel(hh, res.run_id)).toBe("fake-b-med");

    replayAll(hh);
  }, 120_000);

  it("none eligible returns ELIGIBILITY_NONE with the reason", async () => {
    // Only low capability declared across all providers
    const lowOnlyModels = new ModelRegistry(
      new Map([
        [
          "fake",
          {
            ids: ["fake-low"],
            capabilities: { "fake-low": "low" },
          },
        ],
      ]),
    );
    const hh = await start(lowOnlyModels);

    const call = await hh.call("delegate_task", {
      objective: "ok",
      workspace_path: hh.repo,
      trust_profile: "edit-untrusted",
      routing: { minimum_capability: "high" },
    });
    expect(call.isError).toBe(true);
    expect(call.body.error).toMatchObject({
      code: "ELIGIBILITY_NONE",
    });
    expect(call.body.error.message).toContain("CAPABILITY_MISSING");
  }, 60_000);

  it("require_provider keeps BR-3 behaviour when required provider does not meet the floor", async () => {
    const hh = await start();
    // fake-b only has medium capability; require_provider fake-b with minimum_capability high fails with ELIGIBILITY_NONE
    const call = await hh.call("delegate_task", {
      objective: "ok",
      workspace_path: hh.repo,
      trust_profile: "edit-untrusted",
      routing: { require_provider: true, provider_preference: "fake-b", minimum_capability: "high" },
    });
    expect(call.isError).toBe(true);
    expect(call.body.error).toMatchObject({
      code: "ELIGIBILITY_NONE",
    });
    expect(call.body.error.message).toContain("required provider fake-b is ineligible: CAPABILITY_MISSING");
  }, 60_000);

  it("undeclared models fail closed (CAPABILITY_MISSING) even for minimum_capability low", async () => {
    // Provider has model in ids, but NO declared capability
    const noCapModels = new ModelRegistry(
      new Map([
        [
          "fake",
          {
            ids: ["fake-low"],
            // no capabilities block
          },
        ],
      ]),
    );
    const hh = await start(noCapModels);

    const call = await hh.call("delegate_task", {
      objective: "ok",
      workspace_path: hh.repo,
      trust_profile: "edit-untrusted",
      routing: { minimum_capability: "low" },
    });
    expect(call.isError).toBe(true);
    expect(call.body.error).toMatchObject({
      code: "ELIGIBILITY_NONE",
    });
    expect(
      call.body.error.details.eligibility.find((e: { provider: string; detail: string }) => e.provider === "fake")
        ?.detail,
    ).toContain("no model in the fake model registry meets minimum_capability");
  }, 60_000);

  it("subsequent run with affinity pins the model that satisfied the capability check", async () => {
    const hh = await start();
    pinning.add("fake");

    // First run with minimum_capability: high
    const first = await hh.delegate("ok", { minimum_capability: "high" });
    expect(first).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(compiledFor(first.run_id)).toEqual(["fake-high"]);

    // Second run on same project with minimum_capability: high: affinity holds and pins fake-high
    const second = await hh.delegate("ok", { minimum_capability: "high" });
    expect(second).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(compiledFor(second.run_id)).toEqual(["fake-high"]);
    expect(storedModel(hh, second.run_id)).toBe("fake-high");

    const aff = (await hh.ok("explain_route", { run_id: second.run_id })).affinity as Json;
    expect(aff).toMatchObject({
      held: true,
      model_pin: { model: "fake-high", outcome: "pinned" },
    });

    replayAll(hh);
  }, 120_000);

  it("when remembered model has lower capability, request with higher floor compiles with floor-satisfying model", async () => {
    const hh = await start();
    pinning.add("fake");

    // First run with minimum_capability: low uses fake-low
    const first = await hh.delegate("ok", { minimum_capability: "low" });
    expect(first).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(compiledFor(first.run_id)).toEqual(["fake-low"]);

    // Second run needs minimum_capability: high. fake-low cannot be used; fake-high satisfies the floor.
    const second = await hh.delegate("ok", { minimum_capability: "high" });
    expect(second).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(compiledFor(second.run_id)).toEqual(["fake-high"]);
    expect(storedModel(hh, second.run_id)).toBe("fake-high");

    replayAll(hh);
  }, 120_000);
});
