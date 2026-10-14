/**
 * T7.2 (FR-RTE-03, FR-RTE-02, FR-RTE-04, LLD §17.4, ADR-0044 item 6): every route decision written through the MCP server
 * (plain delegations, a preference, a required provider, a same-provider continuation, a continuation that names another
 * provider and a quota failover) is self-contained: re-running the scorer on the stored row alone reproduces the stored
 * selection, rule, terms and scores exactly. A tampered row is caught, and an M2 eligibility-only row replays as such.
 * No provider CLI is installed or called; the providers are one scripted fake CLI under three ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replayRouteDecision } from "./decision.js";
import { type Harness, type Json, startHarness } from "./fixtures/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness({ maxAttempts: 2 });
});
afterEach(async () => {
  await h.close();
});

describe("route decision replay (T7.2, FR-RTE-03)", () => {
  it("reproduces every stored decision of a mixed session from the stored row alone", async () => {
    // With affinity (T7.5) the project stays on its provider unless a listed reason applies, so the sequence uses the
    // reasons to reach every selection rule.
    const first = await h.delegate("ok"); // first run: configured order
    expect(first.status).toBe("SUCCEEDED");
    // A quota stop on the affine `fake` fails over by stage 2 to another eligible provider (capacity_exhausted).
    const quota = await h.delegate("quota", { provider_preference: "fake" });
    expect(quota.failure_code).toBe("QUOTA_EXHAUSTED");
    await h.waitFor(() => h.ledger.listRunEvents(quota.run_id).some((e) => e.type === "quota_ladder"));
    const ladder = h.ledger.listRunEvents(quota.run_id).find((e) => e.type === "quota_ladder");
    expect(JSON.parse(ladder?.payload_json ?? "{}")).toMatchObject({ outcome: "failover" });
    await h.settle(h.ledger.findSuccessorRun(quota.run_id)?.id as string);
    // Overload on the new affine provider, retried until exhausted; the next run is scored without it.
    const overloaded = await h.delegate("overload");
    expect(overloaded.status).toBe("FAILED");
    if (overloaded.superseded_by !== undefined) await h.settle(overloaded.superseded_by); // the retry fails the same way
    await h.delegate("ok"); // failed_after_retry: scored with history
    await h.delegate("ok", { provider_preference: "grok" }); // affinity holds over a preference
    await h.delegate("ok", { provider_preference: "fake-b", require_provider: true });
    // A same-provider continuation, and one that names another provider (a handoff).
    const resumed = await h.ok("continue_task", { meta_session_id: first.meta_session_id, instruction: "ok" });
    await h.settle(resumed.run_id);
    const handed = await h.ok("continue_task", {
      meta_session_id: first.meta_session_id,
      instruction: "ok",
      routing: { provider_preference: "grok" },
    });
    await h.settle(handed.run_id);

    const rows = h.decisions();
    expect(rows.length).toBe(9);
    const rules = new Set<string>();
    for (const row of rows) {
      const replay = replayRouteDecision(row);
      expect(replay, row.id).toEqual({ schemaVersion: 2, ok: true, differences: [] });
      const reasons = JSON.parse(row.reasons_json) as { selection: { rule: string } };
      rules.add(reasons.selection.rule);
      const features = JSON.parse(row.features_json) as Json;
      expect(features.route_features).toMatchObject({ classifier: "heuristic.v1" });
      expect(JSON.parse(row.weights_json ?? "null")).toEqual({
        success: 1,
        latency: 1,
        capacity: 1,
        security: 1,
        handoff: 1,
        cost: 1,
      });
    }
    expect(rules).toEqual(
      new Set(["configured_order", "score", "affinity", "provider_preference", "required_provider"]),
    );
  }, 60_000);

  it("reports a tampered row and replays an M2 eligibility-only row as version 1", async () => {
    await h.delegate("ok");
    await h.delegate("ok", { provider_preference: "grok" });
    for (const row of h.decisions()) {
      const f = JSON.parse(row.features_json) as Json;
      const p = Object.keys(f.score_inputs)[0] as string;
      f.score_inputs[p].healthy += 5;
      const tampered = replayRouteDecision({ ...row, features_json: JSON.stringify(f) });
      expect(tampered.ok).toBe(false);
      expect(tampered.differences.some((d) => d.startsWith(`score ${p}`))).toBe(true);
      const w = JSON.parse(row.weights_json ?? "{}") as Json;
      expect(replayRouteDecision({ ...row, selected_provider: "nobody" }).ok).toBe(false);
      expect(replayRouteDecision({ ...row, weights_json: JSON.stringify({ ...w, capacity: 7 }) }).ok).toBe(false);
    }
    const m2 = {
      features_json: JSON.stringify({ trust_profile: "edit-untrusted", required_provider: null }),
      weights_json: null,
      candidates_json: JSON.stringify([{ provider: "fake", eligible: true, reasons: [], score: null }]),
      selected_provider: "fake",
      reasons_json: JSON.stringify({ selection: { provider: "fake", basis: "configured_order" } }),
    };
    expect(replayRouteDecision(m2)).toEqual({ schemaVersion: 1, ok: true, differences: [] });
  }, 60_000);
});
