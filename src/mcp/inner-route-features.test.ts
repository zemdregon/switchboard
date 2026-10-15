/** T11.11: real MCP routing and lifecycle quota failover, using only fake provider/backend processes. */
import { afterEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createFakeBackend, type FakeStep } from "../inner/fake-backend.js";
import { createInnerAgent } from "../inner/index.js";
import { createClassifyRouteFeaturesHook } from "../inner/route-features.js";
import type { RunLifecycleOptions } from "../lifecycle/lifecycle.js";
import { replayRouteDecision } from "../routing/decision.js";
import { down, type Harness, startHarness } from "../routing/fixtures/harness.js";

const values = { context_volume: "large", autonomy: "high", reasoning_depth: "high", task_kind: "investigation" };
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setup(script: readonly FakeStep[], enabled = true) {
  const backend = createFakeBackend({ script });
  const service = createInnerAgent(
    resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: "http://127.0.0.1:9", model: "configured-model" },
      tasks: { route_features: { enabled, timeout_ms: 50 } },
    }),
    { backend },
  );
  const contexts: Parameters<NonNullable<RunLifecycleOptions["classifyRouteFeatures"]>>[1][] = [];
  const hook = createClassifyRouteFeaturesHook(service, () => "inherit");
  h = await startHarness({
    lifecycle: {
      classifyRouteFeatures: (
        input: Parameters<NonNullable<RunLifecycleOptions["classifyRouteFeatures"]>>[0],
        context: (typeof contexts)[number],
      ) => {
        contexts.push(context);
        return hook(input, context);
      },
    },
  });
  return { harness: h, backend, contexts };
}
const valid: FakeStep = { kind: "text", text: JSON.stringify(values), model_id: "reported-model" };

describe("injected inner routing on dispatch callers (T11.11)", () => {
  it("stores inner provenance on delegate and continuation; explain/replay never call the backend", async () => {
    const { harness: h, backend, contexts } = await setup([valid]);
    down.add("grok");
    const first = await h.delegate("ok", { provider_preference: "fake-b", require_provider: true });
    expect(first.provider.adapter).toBe("fake-b");
    const continued = await h.ok("continue_task", { meta_session_id: first.meta_session_id, instruction: "ok" });
    await h.settle(continued.run_id);
    expect(contexts[1]).toMatchObject({ metaSessionId: first.meta_session_id });
    const calls = backend.requests.length;
    backend.setScript([{ kind: "error" }]);
    for (const row of h.decisions()) {
      const f = JSON.parse(row.features_json);
      expect(f.route_features).toMatchObject({
        classifier: "route_features.v1",
        task_kind: {
          value: "investigation",
          source: "inner",
          model_id: "reported-model",
          template_version: "route_features.v1",
        },
      });
      expect(row.selected_provider).toBe("fake-b");
      expect(
        JSON.parse(row.candidates_json).filter(
          (c: { provider: string; eligible: boolean }) => c.provider === "grok" && c.eligible,
        ),
      ).toEqual([]);
      expect(replayRouteDecision(row)).toEqual({ schemaVersion: 2, ok: true, differences: [] });
      expect((await h.ok("explain_route", { run_id: row.run_id })).features.route_features).toEqual(f.route_features);
    }
    expect(calls).toBe(2);
    expect(backend.requests).toHaveLength(calls);
  }, 120_000);

  it("classifies the quota failover route only after eligibility, without changing its chosen provider", async () => {
    const { harness: h, backend, contexts } = await setup([valid]);
    const first = await h.delegate("quota");
    await h.waitFor(() => h.ledger.findSuccessorRun(first.run_id) !== undefined);
    const successor = await h.settle(h.ledger.findSuccessorRun(first.run_id)?.id as string);
    expect(successor.status).toBe("SUCCEEDED");
    expect(successor.provider.adapter).toBe("fake-b");
    expect(contexts[1]).toMatchObject({ runId: first.run_id, metaSessionId: first.meta_session_id });
    expect(backend.requests).toHaveLength(2);
    for (const row of h.decisions())
      expect(JSON.parse(row.features_json).route_features.classifier).toBe("route_features.v1");
  }, 120_000);

  it.each(["disabled", "invalid", "error", "hang"] as const)(
    "keeps heuristic routing on %s",
    async (mode) => {
      const step: FakeStep =
        mode === "invalid"
          ? { kind: "text", text: JSON.stringify({ ...values, require_provider: "grok" }) }
          : mode === "error"
            ? { kind: "error" }
            : mode === "hang"
              ? { kind: "hang" }
              : valid;
      const { harness: h, backend } = await setup([step], mode !== "disabled");
      const first = await h.delegate("ok", { provider_preference: "fake-b", require_provider: true });
      expect(first.provider.adapter).toBe("fake-b");
      expect(JSON.parse(h.decisions()[0]?.features_json ?? "{}").route_features.classifier).toBe("heuristic.v1");
      if (mode === "disabled") expect(backend.requests).toHaveLength(0);
    },
    120_000,
  );

  it("does not call the classifier for a required provider that fails eligibility", async () => {
    const { harness: h, backend } = await setup([valid]);
    down.add("grok");
    const result = await h.call("delegate_task", {
      objective: "ok",
      workspace_path: h.repo,
      routing: { provider_preference: "grok", require_provider: true },
    });
    expect(result.isError).toBe(true);
    expect(backend.requests).toHaveLength(0);
    expect(h.decisions()).toHaveLength(0);
  }, 120_000);

  it("fails closed to the heuristic when an injected classifier throws", async () => {
    h = await startHarness({
      lifecycle: {
        classifyRouteFeatures: async () => {
          throw new Error("unavailable");
        },
      },
    });
    const first = await h.delegate("ok");
    expect(first.provider.adapter).toBe("fake");
    expect(JSON.parse(h.decisions()[0]?.features_json ?? "{}").route_features.classifier).toBe("heuristic.v1");
  }, 120_000);
});
