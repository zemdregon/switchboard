import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { buildRouteDecision, type RouteDecisionRequest, replayRouteDecision } from "../routing/decision.js";
import { classifyRequest } from "../routing/features.js";
import { DEFAULT_WEIGHTS } from "../routing/score.js";
import { createFakeBackend, type FakeStep } from "./fake-backend.js";
import { createInnerAgent } from "./index.js";
import { buildRouteFeaturesInput, classifyRouteFeatures, createClassifyRouteFeaturesHook } from "./route-features.js";

const input = { objective: "Fix parser", constraints: ["private constraint"], verificationCommands: 1, writable: true };
const values = { context_volume: "large", autonomy: "high", reasoning_depth: "high", task_kind: "investigation" };
function setup(
  script: readonly FakeStep[] = [{ kind: "text", text: JSON.stringify(values), model_id: "reported-model" }],
  enabled = true,
) {
  const backend = createFakeBackend({ script });
  const service = createInnerAgent(
    resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: "http://127.0.0.1:9", model: "configured-model" },
      tasks: { route_features: { enabled, timeout_ms: 50 } },
    }),
    { backend },
  );
  return { backend, service };
}

describe("routing classification (T11.11)", () => {
  it("records enumerated features with reported model and template; replay needs no backend", async () => {
    const { backend, service } = setup();
    const features = await classifyRouteFeatures(service, input);
    expect(features.classifier).toBe("route_features.v1");
    for (const key of ["context_volume", "autonomy", "reasoning_depth", "task_kind"] as const) {
      expect(features[key]).toEqual({
        value: values[key],
        source: "inner",
        model_id: "reported-model",
        template_version: "route_features.v1",
      });
    }
    const req: RouteDecisionRequest = {
      input: {
        candidates: ["fake", "codex", "claude"],
        trustProfile: "edit-untrusted",
        clientMaxProfile: "edit-untrusted",
        platform: "linux",
        requiredProvider: "codex",
        requirements: { network: "off", writable: true },
        facts: [],
      },
      decision: {
        eligible: ["fake", "codex"],
        excluded: [
          {
            provider: "claude",
            primary: { code: "PROVIDER_DISABLED", detail: "off", evidence: {} },
            failureCode: "ELIGIBILITY_NONE",
            reasons: [{ code: "PROVIDER_DISABLED", detail: "off", evidence: {} }],
          },
        ],
        outcome: { kind: "eligible", providers: ["fake", "codex"] },
      },
      admissible: ["fake", "codex"],
      preference: "fake",
      features,
      scoreInputs: {},
      weights: DEFAULT_WEIGHTS,
    };
    const decision = buildRouteDecision(req);
    expect(decision.provider).toBe("codex");
    const baseline = buildRouteDecision({ ...req, features: classifyRequest(input) });
    expect(decision.record.candidates_json).toBe(baseline.record.candidates_json);
    expect(decision.record.reasons_json).toBe(baseline.record.reasons_json);
    expect(JSON.parse(decision.record.features_json).route_features).toEqual(features);
    backend.setScript([{ kind: "error" }]);
    const root = mkdtempSync(path.join(tmpdir(), "sb-route-features-"));
    const db = openLedger(path.join(root, "ledger"));
    try {
      const ledger = createLedger(db);
      const session = ledger.createMetaSession({ objective: input.objective });
      const run = ledger.createRun({
        metaSessionId: session.id,
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: "h",
        clientId: "test",
      });
      ledger.insertRouteDecision({ ...decision.record, runId: run.id });
      const stored = ledger.getRouteDecision(run.id);
      if (stored === undefined) throw new Error("missing stored decision");
      expect(JSON.parse(stored?.features_json ?? "{}").route_features).toEqual(features);
      expect(replayRouteDecision(stored)).toEqual({ schemaVersion: 2, ok: true, differences: [] });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
    expect(backend.requests).toHaveLength(1);
    expect(buildRouteDecision({ ...req, input: { ...req.input, requiredProvider: "claude" } }).provider).toBeNull();
    const { requiredProvider: _required, ...unrequired } = req.input;
    expect(buildRouteDecision({ ...req, input: unrequired }).provider).toBe("fake");
  });
  it.each([
    { kind: "empty" },
    { kind: "error" },
    { kind: "hang" },
    { kind: "text", text: JSON.stringify({ ...values, require_provider: "claude" }) },
    { kind: "text", text: JSON.stringify({ ...values, autonomy: "unlimited" }) },
    { kind: "text", text: JSON.stringify({ context_volume: "small" }) },
  ] satisfies FakeStep[])("falls back on invalid or unavailable output: $kind", async (step) => {
    const { service } = setup([step]);
    expect(await classifyRouteFeatures(service, input)).toEqual(classifyRequest(input));
  });
  it("redacts a planted secret and does not pass constraint text or writable profile into the prompt", async () => {
    const { backend, service } = setup();
    const secret = `sk-${"planted0123456789ABCDEF"}`;
    await classifyRouteFeatures(service, { ...input, objective: `Fix parser using ${secret}` });
    const prompt = backend.requests.map((r) => r.user).join("\n");
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain("private constraint");
    expect(prompt).not.toContain("writable");
  });
  it("disabled task makes no calls; input contains only permitted metadata and objective", async () => {
    const { backend, service } = setup(undefined, false);
    expect(await classifyRouteFeatures(service, input)).toEqual(classifyRequest(input));
    expect(backend.requests).toEqual([]);
    const prompt = buildRouteFeaturesInput(input, {
      fileCount: 12,
      sizeBand: "small",
      extensions: { ".ts": 10, "private path": 2 },
    });
    expect(JSON.parse(prompt)).toEqual({
      objective: "Fix parser",
      constraints: 1,
      verification_commands: 1,
      repository: { file_count: 12, size_band: "small", extensions: { ".ts": 10 } },
    });
    expect(prompt).not.toContain("private");
    expect(prompt).not.toContain("writable");
  });
  it("serve hook resolves project privacy at call time and falls back when off or the resolver throws", async () => {
    const { backend, service } = setup();
    const seen: { projectId: string; contextId: string }[] = [];
    const hook = createClassifyRouteFeaturesHook(service, (projectId, contextId) => {
      seen.push({ projectId, contextId });
      if (projectId === "throw") throw new Error("resolver failed");
      return projectId === "denied" ? "off" : "inherit";
    });
    const project = (id: string) => ({ project: { id, context_id: "main" } });
    expect((await hook(input, project("demo"))).classifier).toBe("route_features.v1");
    expect((await hook(input, {})).classifier).toBe("route_features.v1");
    expect((await hook(input, project("denied"))).classifier).toBe("heuristic.v1");
    expect((await hook(input, project("throw"))).classifier).toBe("heuristic.v1");
    expect(seen).toEqual([
      { projectId: "demo", contextId: "main" },
      { projectId: "denied", contextId: "main" },
      { projectId: "throw", contextId: "main" },
    ]);
    expect(backend.requests).toHaveLength(2);
  });
});
