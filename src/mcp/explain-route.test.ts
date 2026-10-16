/**
 * `explain_route` on the MCP server (T7.3; FR-MCP-02, FR-MCP-04, FR-RTE-03, LLD §17.5, ADR-0044 item 7). Through the SDK
 * client, so every result is checked against the published output schema: the tool is listed with closed schemas and
 * the earlier tools are unchanged; an unknown run and another client's run are refused alike; the answer equals the
 * stored route decision; an M2 eligibility-only row is explained as such; nothing is probed or asked of a model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";
import { TOOL_NAMES, WORK_QUEUE_TOOL_NAMES } from "./index.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const explain = (runId: string, clientId?: string) => h.call("explain_route", { run_id: runId }, clientId);

describe("explain_route (T7.3, FR-MCP-02)", () => {
  it("is listed after the earlier tools with a closed input schema and an output schema", async () => {
    const { tools } = await h.client().listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES]);
    expect(TOOL_NAMES.slice(0, 9)).toEqual([
      "delegate_task",
      "continue_task",
      "get_run",
      "cancel_run",
      "get_artifacts",
      "list_capabilities",
      "list_projects",
      "get_capacity",
      "explain_route",
    ]);
    const tool = tools.find((t) => t.name === "explain_route");
    expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["run_id"] });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["run_id"]);
    expect(tool?.outputSchema?.type).toBe("object");
    expect(tool?.description).toMatch(/No model is asked/);
  });

  it("returns the stored decision: candidates, features, weights, scores, the rule and deciding factors", async () => {
    const run = await h.delegate("Fix the parser crash", { provider_preference: "grok" });
    const r = await explain(run.run_id);
    expect(r.isError).toBe(false);
    const row = h.ledger.getRouteDecision(run.run_id);
    if (row === undefined) throw new Error("no decision");
    const features = JSON.parse(row.features_json) as Json;
    const candidates = JSON.parse(row.candidates_json) as Json[];
    expect(r.body).toEqual({
      run_id: run.run_id,
      schema_version: 2,
      decided_at: row.created_at,
      selected_provider: "grok",
      selection: { provider: "grok", basis: "provider_preference", rule: "provider_preference" },
      candidates: candidates.map((c) => ({
        provider: c.provider,
        eligible: true,
        reasons: [],
        score: c.score,
        terms: c.terms,
      })),
      features,
      weights: JSON.parse(row.weights_json ?? "null"),
      // T7.5: the project's first run, so no affine provider and no reason (LLD §17.6).
      affinity: {
        enabled: true,
        project_key: expect.stringMatching(/^ws:[0-9a-f]{64}$/u),
        provider: null,
        model: null,
        held: false,
        affinity_switch_reason: null,
        scored: false,
        applies: true,
        excluded_from_score: null,
      },
      continuation: null,
      project: null,
      deciding_factors: ["selected grok by provider_preference", "no affinity recorded for the project"],
    });
    expect(r.body.features.route_features).toMatchObject({
      classifier: "heuristic.v1",
      task_kind: { value: "bug_fix", source: "heuristic" },
    });
    expect(r.body.candidates.map((c: Json) => c.provider)).toEqual(["fake", "fake-b", "grok"]);
  });

  it("names the excluded providers' codes and the top scores when stage 2 decided", async () => {
    const { down } = await import("../routing/fixtures/harness.js");
    down.add("fake");
    const run = await h.delegate("ok");
    const r = await explain(run.run_id);
    expect(r.body.selected_provider).toBe("fake-b");
    expect(r.body.selection.rule).toBe("configured_order");
    const excluded = r.body.candidates.find((c: Json) => c.provider === "fake");
    expect(excluded).toMatchObject({ eligible: false, score: null, terms: null });
    expect(excluded.reasons[0]).toMatchObject({ code: "CAPABILITY_MISSING" });
    expect(r.body.deciding_factors).toEqual([
      "selected fake-b by configured_order",
      "no affinity recorded for the project",
      `score fake-b ${r.body.candidates[0].score.toFixed(4)}`,
      `score grok ${r.body.candidates[1].score.toFixed(4)}`,
      "fake excluded: CAPABILITY_MISSING",
    ]);
  });

  it("refuses an unknown run and another client's run alike (no existence oracle)", async () => {
    const run = await h.delegate("ok");
    const unknown = await explain("run_00000000000000000000000000");
    const foreign = await explain(run.run_id, "other");
    for (const r of [unknown, foreign]) {
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe("INVALID_REQUEST");
    }
    expect(foreign.body.error.message).toBe(`unknown run ${run.run_id}`);
    const malformed = await h.call("explain_route", { run_id: "nope" });
    const extra = await h.call("explain_route", { run_id: run.run_id, provider: "fake" });
    expect(malformed.body.error.code).toBe("INVALID_REQUEST");
    expect(extra.body.error.code).toBe("INVALID_REQUEST");
  });

  it("explains an M2 eligibility-only row as such, and a run with no row as none recorded", async () => {
    // Runs admitted without a route decision (as the M1 lifecycle allows), explained under the same ownership rule.
    const bare = async () =>
      (
        await h.lifecycle.submit({
          clientId: "orch",
          objective: "ok",
          workspace: h.repo,
          trustProfile: "edit-untrusted",
          provider: "fake",
        })
      ).runId;
    const noRow = await bare();
    const none = await explain(noRow);
    expect(none.body).toMatchObject({
      schema_version: null,
      selection: null,
      candidates: [],
      deciding_factors: ["no route decision recorded"],
    });
    const run = { run_id: await bare() };
    h.ledger.insertRouteDecision({
      runId: run.run_id,
      features_json: JSON.stringify({ trust_profile: "edit-untrusted", required_provider: null }),
      candidates_json: JSON.stringify([
        { provider: "fake", eligible: true, reasons: [], score: null },
        {
          provider: "grok",
          eligible: false,
          reasons: [{ code: "AUTH_REQUIRED", detail: `log in; token file at /home/someone/.secret/x`, evidence: {} }],
          score: null,
        },
      ]),
      selected_provider: "fake",
      reasons_json: JSON.stringify({
        outcome: { kind: "eligible" },
        selection: { provider: "fake", basis: "configured_order" },
      }),
    });
    const m2 = await explain(run.run_id);
    expect(m2.isError).toBe(false);
    expect(m2.body).toMatchObject({
      schema_version: 1,
      features: null,
      weights: null,
      selection: { provider: "fake", basis: "configured_order", rule: null },
    });
    expect(m2.body.deciding_factors).toEqual([
      "eligibility only (decision recorded before scoring)",
      "selected fake by configured_order",
      "grok excluded: AUTH_REQUIRED",
    ]);
    // A path outside the allowed roots is scrubbed from the stored detail (FR-MCP-04).
    expect(m2.body.candidates[1].reasons[0].detail).not.toContain("/home/someone");
  });
});
