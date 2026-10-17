/**
 * T7.15 byte-identity fixtures: route decision requests without a model group and without a subscription. The expected
 * records in `version2-identity.test.ts` were produced by `main`'s `buildRouteDecision` (before T7.15) from exactly these
 * inputs, so an unconfigured decision must stay byte for byte the same.
 */
const base = {
  trustProfile: "edit-untrusted",
  clientMaxProfile: "edit-untrusted",
  requirements: { network: "off", writable: true },
  platform: "linux",
};
const reason = { code: "CAPABILITY_MISSING", detail: "simulated", evidence: { provider: "p3" } };
const inputs = {
  p1: { healthy: 7, counted: 1, median_ms: 41000, capacity_score: 0.6, capacity_confidence: 0.7, session_bound: true },
  p2: { healthy: 3, counted: 0, median_ms: 23000, capacity_score: null, capacity_confidence: 0, session_bound: true },
};
const row = (provider: string) => ({ provider, model: "m-1", reset_requested_at: null });
const affinity = (r: ReturnType<typeof row> | undefined, latest: unknown = null) => ({
  enabled: true,
  applies: true,
  projectKey: "proj",
  row: r,
  requiredProvider: null,
  admissible: ["p1", "p2"],
  excluded: [{ provider: "p3", codes: ["CAPABILITY_MISSING"] }],
  latestOnAffine: latest,
  estimate: null,
  thresholds: { lowWaterMark: null, minConfidence: null },
});
const decision = {
  eligible: ["p1", "p2"],
  excluded: [{ provider: "p3", primary: reason, reasons: [reason], failureCode: "ELIGIBILITY_NONE" }],
  outcome: { kind: "eligible", providers: ["p1", "p2"] },
};
const request = (extra: Record<string, unknown>) => ({
  input: { ...base, candidates: ["p1", "p2", "p3"], facts: [] },
  decision,
  admissible: ["p1", "p2"],
  preference: null,
  features: { classifier: "heuristic.v1", task_kind: { value: "bug_fix", source: "heuristic" } },
  scoreInputs: inputs,
  weights: { success: 3, latency: 1, capacity: 2, security: 1, handoff: 1, cost: 0, pacing: 7 },
  ...extra,
});

export const FIXTURE: Record<string, unknown>[] = [
  request({}),
  request({ affinity: affinity(undefined) }),
  request({ affinity: affinity(row("p2")) }),
  request({ affinity: affinity(row("p1"), { failureCode: "QUOTA_EXHAUSTED", retryExhausted: false }) }),
  request({ preference: "p2", project: { id: "web", excluded: ["p4"] } }),
  request({
    input: {
      ...base,
      candidates: ["p1", "p2", "p3"],
      facts: [
        {
          provider: "p1",
          registered: true,
          enabled: true,
          pacingDeferred: {
            subscription: "s",
            window: "w",
            until: "2026-10-17T01:00:00.000Z",
            source: "controller_estimated",
          },
        },
      ],
    },
    affinity: affinity(row("p2")),
  }),
];
