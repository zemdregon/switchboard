/**
 * M7 acceptance on fake adapters (T7.10; ROADMAP §6 M7 row, FR-MCP-02, FR-RTE-01 to 04, 06 to 08). Everything goes
 * through the MCP server as an orchestrator would, plus the operator CLI for `affinity reset`:
 *
 * - given stored features and weights, re-running the scorer reproduces every stored decision;
 * - `explain_route` lists the deciding factors;
 * - a project keeps its last provider and model across meta-sessions, and in a replay of the stored decisions affinity
 *   changes only with an `affinity_switch_reason` from the closed list, never for a better score, lower cost or load;
 * - with several eligible providers and equal capacity no project is spread across providers.
 *
 * No provider CLI is installed or called; the providers are one scripted fake CLI under three ids.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import type { AffinityRecord } from "../routing/affinity.js";
import { replayRouteDecision } from "../routing/decision.js";
import { down, type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";

const CLOSED = ["user_request", "capacity_exhausted", "ineligible", "failed_after_retry"];

let h: Harness;
beforeEach(async () => {
  // Weights that favour success history heavily: a better-scoring provider exists, and it must not move a project.
  const routing = {
    weights: { success: 100, latency: 1, capacity: 1, security: 1, handoff: 1, cost: 1 },
    affinity: { enabled: true, lowWaterMark: null, minConfidence: null },
  };
  h = await startHarness({
    maxAttempts: 2,
    config: { routing },
    lifecycle: { routing: { ...routing, windowSeconds: 3600, confidenceRuns: 10 } },
  });
});
afterEach(async () => {
  await h.close();
});

async function operator(args: string[]): Promise<number> {
  const configPath = path.join(h.root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: path.join(h.root, "data"),
      allowed_roots: [h.root],
      mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted" }],
    }),
  );
  const io: CliIo = { stdout: { write: () => true }, stderr: { write: () => true }, env: {}, user: "operator" };
  return main([...args, "--config", configPath], io);
}

const explain = (runId: string) => h.ok("explain_route", { run_id: runId });

describe("M7 acceptance (T7.10)", () => {
  it("keeps a project's provider and model, switches only for listed reasons, explains and replays every decision", async () => {
    const other = h.newRepo("other");

    // 1. First run of the project: scored (all candidates tie, configured order).
    const r1 = await h.delegate("ok");
    expect(r1.provider.adapter).toBe("fake");
    const e1 = await explain(r1.run_id);
    expect(e1.selection.rule).toBe("configured_order");
    expect(e1.deciding_factors[0]).toBe("selected fake by configured_order");
    expect(e1.features.route_features.classifier).toBe("heuristic.v1");
    const key = h.ledger.listProjectAffinities()[0]?.project_key as string;
    expect(h.ledger.getProjectAffinity(key)).toMatchObject({ provider: "fake", model: "fake-model" });

    // 2. Make grok score better (success history on another project), then route this project again in a new
    // meta-session with a preference for grok: affinity holds provider and model; score and hint are not reasons.
    for (let i = 0; i < 3; i++) await h.delegate("ok", { provider_preference: "grok" }, { workspace_path: other });
    const r2 = await h.delegate("ok", { provider_preference: "grok" });
    expect(r2.provider.adapter).toBe("fake");
    const e2 = await explain(r2.run_id);
    expect(e2.affinity).toMatchObject({ held: true, provider: "fake", model: "fake-model", scored: false });
    const scores = Object.fromEntries(e2.candidates.map((c: Json) => [c.provider, c.score]));
    expect(scores.grok).toBeGreaterThan(scores.fake); // a better score existed and did not move the project
    expect(e2.deciding_factors).toContain("affinity held (fake)");

    // 3. The affine provider becomes ineligible: the project moves with `ineligible`; recovery does not move it back.
    down.add("fake");
    const r3 = await h.delegate("ok");
    down.delete("fake");
    expect(r3.provider.adapter).not.toBe("fake");
    expect((await explain(r3.run_id)).affinity).toMatchObject({ affinity_switch_reason: "ineligible" });
    const moved = r3.provider.adapter as string;
    const r4 = await h.delegate("ok");
    expect(r4.provider.adapter).toBe(moved);
    expect(h.ledger.getProjectAffinity(key)).toMatchObject({ provider: moved, model: `${moved}-model` });

    // 4. The operator resets the project's affinity on the CLI: the next decision is `user_request`.
    expect(await operator(["affinity", "reset", key])).toBe(0);
    const r5 = await h.delegate("ok", { provider_preference: "fake" });
    expect(r5.provider.adapter).toBe("fake");
    expect((await explain(r5.run_id)).affinity).toMatchObject({ affinity_switch_reason: "user_request" });

    // 5. A quota stop fails over and re-bases affinity with `capacity_exhausted`.
    const r6 = await h.delegate("quota");
    expect(r6.failure_code).toBe("QUOTA_EXHAUSTED");
    await h.waitFor(() => h.ledger.findSuccessorRun(r6.run_id) !== undefined);
    const succ = await h.settle(h.ledger.findSuccessorRun(r6.run_id)?.id as string);
    expect(succ.status).toBe("SUCCEEDED");
    expect((await explain(succ.run_id)).affinity).toMatchObject({ affinity_switch_reason: "capacity_exhausted" });

    // Replay every stored decision; per project, a provider change carries a listed reason.
    const rows = h.decisions();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const reasonsSeen = new Set<string>();
    for (const row of rows) {
      expect(replayRouteDecision(row), row.id).toEqual({ schemaVersion: 2, ok: true, differences: [] });
      const a = (JSON.parse(row.reasons_json) as { affinity?: AffinityRecord }).affinity;
      if (a === undefined || !a.applies || a.provider === null) continue;
      if (row.selected_provider !== a.provider) {
        expect(CLOSED).toContain(a.affinity_switch_reason);
        reasonsSeen.add(a.affinity_switch_reason as string);
      } else {
        expect(a.affinity_switch_reason === null || a.affinity_switch_reason === "user_request").toBe(true);
      }
    }
    expect(reasonsSeen).toEqual(new Set(["ineligible", "user_request", "capacity_exhausted"]));
  }, 300_000);

  it("with several eligible providers and equal capacity no project is spread across providers", async () => {
    const repos = [h.repo, h.newRepo("b"), h.newRepo("c")];
    const used = new Map<string, Set<string>>();
    for (let i = 0; i < 9; i++) {
      const repo = repos[i % 3] as string;
      const routing = i % 2 === 0 ? {} : { provider_preference: ["fake", "fake-b", "grok"][i % 3] };
      const run = await h.delegate("ok", routing, { workspace_path: repo });
      used.set(repo, (used.get(repo) ?? new Set()).add(run.provider.adapter as string));
    }
    expect([...used.values()].map((s) => s.size)).toEqual([1, 1, 1]);
  }, 300_000);
});
