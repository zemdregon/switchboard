/**
 * Config-id vs adapter-id audit (T7.13, T7.14, T6.13 follow-up; mcp-test-results 20261017T204625Z hunch). Model group
 * members and `capacity.subscriptions.<s>.providers[]` name config provider ids (`grok-build`); the ledger, the registry
 * and `routing.provider_preference` name adapter ids (`grok`). Each site below is driven with `grok-build`, whose two ids
 * differ, through the same MCP server an orchestrator uses (the routing harness: `grok` is a scripted fake there, no
 * provider CLI is called). The settings come from `resolveCapacity` over the config-id input, as `loadConfig` builds them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { capacityProviders, pacingDeferrals } from "../capacity/index.js";
import { resolveCapacity } from "../config/capacity.js";
import type { ResolvedConfig } from "../config/index.js";
import { groupMembersFor } from "../config/routing.js";
import { ModelRegistry } from "../models/registry.js";
import { collectPacingInputs } from "./decision.js";
import { type Harness, type Json, startHarness } from "./fixtures/harness.js";
import { groupMembers, memberKey } from "./groups.js";

const GROUPS = {
  "cfg-ids": {
    members: [
      { provider: "grok-build", model: "grok-mini" },
      { provider: "fake", model: "fake-mini" },
    ],
  },
};
const REGISTRY = new ModelRegistry(
  new Map([
    ["fake", { ids: ["fake-mini"] }],
    ["grok", { ids: ["grok-mini"] }],
  ]),
);
const window = (anchor: string) => ({
  id: "hour",
  length_seconds: 3600,
  reset: { kind: "fixed" as const, anchor },
  budget: { unit: "runs" as const, value: 1 },
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("config id vs adapter id at every site that compares them (grok-build is adapter grok)", () => {
  it("subscription, pacing facts, get_capacity, explain_route member keys and narrowing all agree on grok", async () => {
    const anchor = new Date(Date.now() - 60_000).toISOString();
    const score = resolveCapacity({
      subscriptions: { beta: { providers: ["grok-build"], windows: [window(anchor)] } },
      pacing: { mode: "score" },
    });
    // Site: capacity.subscriptions resolution (src/config/capacity.ts): config id kept for display, adapter id for rows.
    expect(score.subscriptions?.map((s) => [s.providers, s.adapterIds])).toEqual([[["grok-build"], ["grok"]]]);
    const subscriptions = score.subscriptions ?? [];
    const pacing = score.pacing;
    if (pacing === undefined) throw new Error("pacing resolved");
    h = await startHarness({
      models: REGISTRY,
      config: { model_groups: GROUPS, capacity: { windowSeconds: 3600, confidenceRuns: 10, subscriptions, pacing } },
    });

    // Site: routing.provider_preference narrowing (src/config/routing.ts groupMembersFor, src/routing/groups.ts).
    expect(groupMembersFor(GROUPS["cfg-ids"], "grok")).toEqual([{ provider: "grok-build", model: "grok-mini" }]);
    expect(groupMembers(GROUPS["cfg-ids"].members, ["fake", "fake-b", "grok"], "grok")).toEqual([
      { provider: "grok", model: "grok-mini", order: 0 },
    ]);
    const started = await h.ok("delegate_task", {
      objective: "ok",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      routing: { model_group: "cfg-ids", provider_preference: "grok" },
    });
    const run = await h.settle(started.run_id as string);
    expect(run.status, JSON.stringify(run)).toBe("SUCCEEDED");
    expect(run.provider.adapter).toBe("grok");

    // Site: explain_route member keys (src/routing/groups.ts memberKey over adapter ids, src/routing/explain.ts).
    const explained = await h.ok("explain_route", { run_id: started.run_id });
    expect(explained.candidates.map((c: Json) => c.provider)).toEqual([memberKey("grok", "grok-mini")]);
    expect(explained.features.members).toEqual([expect.objectContaining({ key: "grok/grok-mini", provider: "grok" })]);
    // Site: route-decision pacing inputs (src/routing/decision.ts collectPacingInputs, keyed by adapter id).
    expect(explained.features.candidate_subscription).toEqual({ grok: "beta" });
    expect(explained.deciding_factors.some((s: string) => s.startsWith("pacing: grok "))).toBe(true);

    // Site: get_capacity pacing[] (src/capacity/usage-window.ts, projection.ts): the grok run counts against beta,
    // and the row shows the subscription's config ids. `switchboard doctor` prints its pacing line from this projection.
    const capacity = await h.ok("get_capacity", {});
    expect(capacity.pacing).toEqual([expect.objectContaining({ subscription: "beta", providers: ["grok-build"] })]);
    expect(capacity.pacing[0].windows[0].used_fraction.value).toBe(1);

    // Site: the pacing gate deferral (src/capacity/pacing-gate.ts), which eligibility applies per run.provider.
    const gate = resolveCapacity({
      subscriptions: { beta: { providers: ["grok-build"], windows: [window(anchor)] } },
      pacing: { mode: "gate" },
    });
    const gateSettings = { subscriptions: gate.subscriptions ?? [], pacing: gate.pacing ?? pacing };
    const deferrals = pacingDeferrals(h.ledger, gateSettings, new Date());
    expect([...deferrals.keys()]).toEqual(["grok"]);
    expect(collectPacingInputs(h.ledger, gateSettings, ["grok", "fake"], new Date())?.candidateSubscription).toEqual({
      fake: null,
      grok: "beta",
    });
  }, 60_000);

  it("capacity provider rows read providers.<config id> for an adapter id (src/capacity/providers.ts)", () => {
    const providers: ResolvedConfig["providers"] = new Map([
      ["grok-build", { enabled: false, weight: 3, concurrency: 2 }],
    ]);
    expect(capacityProviders(["grok", "fake"], { providers })).toEqual([
      { id: "grok", enabled: false, weight: 3, concurrencyLimit: 2 },
      { id: "fake", enabled: true, weight: null, concurrencyLimit: 1 },
    ]);
  });
});
