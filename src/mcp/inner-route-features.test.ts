import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import type { ResolvedProject } from "../config/projects.js";
import type { ProjectInnerSetting } from "../inner/config.js";
import { createFakeBackend, type FakeStep } from "../inner/fake-backend.js";
import { createInnerAgent } from "../inner/index.js";
import { createClassifyRouteFeaturesHook } from "../inner/route-features.js";
import type { RunLifecycleOptions } from "../lifecycle/lifecycle.js";
import { replayRouteDecision } from "../routing/decision.js";
import { classifyRequest } from "../routing/features.js";
import { compiled, down, type Harness, type HarnessOptions, startHarness } from "../routing/fixtures/harness.js";

const values = { context_volume: "large", autonomy: "high", reasoning_depth: "high", task_kind: "investigation" };
let h: Harness | undefined;
const extraDirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of extraDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  extraDirs.length = 0;
});

function createGitRepo(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `sb-test-${name}-`)));
  extraDirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "init",
    ],
    { cwd: dir },
  );
  return dir;
}

interface SetupOptions {
  resolveSetting?: (projectId: string, contextId: string) => ProjectInnerSetting;
  harness?: HarnessOptions;
}

async function setup(script: readonly FakeStep[], enabled = true, options: SetupOptions = {}) {
  const backend = createFakeBackend({ script });
  const contexts: Parameters<NonNullable<RunLifecycleOptions["classifyRouteFeatures"]>>[1][] = [];
  let hook: ReturnType<typeof createClassifyRouteFeaturesHook> | undefined;
  h = await startHarness({
    ...(options.harness ?? {}),
    lifecycle: {
      classifyRouteFeatures: (
        input: Parameters<NonNullable<RunLifecycleOptions["classifyRouteFeatures"]>>[0],
        context: (typeof contexts)[number],
      ) => {
        contexts.push(context);
        if (!hook) throw new Error("hook not initialized");
        return hook(input, context);
      },
      ...(options.harness?.lifecycle ?? {}),
    },
  });
  const service = createInnerAgent(
    resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: "http://127.0.0.1:9", model: "configured-model" },
      tasks: { route_features: { enabled, timeout_ms: 50 } },
    }),
    { backend, ledger: h.ledger },
  );
  hook = createClassifyRouteFeaturesHook(service, options.resolveSetting ?? (() => "inherit"));
  return { harness: h, backend, contexts, service };
}
const valid: FakeStep = { kind: "text", text: JSON.stringify(values), model_id: "reported-model" };

interface InnerCallAudit {
  task: string;
  run_id: string | null;
  meta_session_id: string | null;
  outcome: string;
}
function innerCalls(h: Harness): InnerCallAudit[] {
  return h.db
    .prepare("SELECT task, run_id, meta_session_id, outcome FROM inner_call ORDER BY created_at, id")
    .all() as InnerCallAudit[];
}
const REPLAY_OK = { schemaVersion: 2, ok: true, differences: [] };
/** The bounded shape of a stored `route_features` object (LLD §13.6): five keys, four tagged enumerated values. */
function expectBoundedFeatures(features: Record<string, unknown>, source: "inner" | "heuristic"): void {
  expect(Object.keys(features).sort()).toEqual([
    "autonomy",
    "classifier",
    "context_volume",
    "reasoning_depth",
    "task_kind",
  ]);
  const allowed = {
    context_volume: ["small", "medium", "large"],
    autonomy: ["low", "medium", "high"],
    reasoning_depth: ["low", "medium", "high"],
    task_kind: ["bug_fix", "feature", "refactor", "test", "docs", "investigation", "other"],
  } as const;
  for (const [key, choices] of Object.entries(allowed)) {
    const feature = features[key] as Record<string, unknown>;
    expect(
      Object.keys(feature)
        .filter((k) => feature[k] !== undefined)
        .sort(),
    ).toEqual(source === "inner" ? ["model_id", "source", "template_version", "value"] : ["source", "value"]);
    expect(feature.source).toBe(source);
    expect(choices).toContain(feature.value);
  }
}

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
    const innerCalls = h.db
      .prepare("SELECT task, run_id, meta_session_id, outcome FROM inner_call ORDER BY created_at, id")
      .all() as {
      task: string;
      run_id: string | null;
      meta_session_id: string | null;
      outcome: string;
    }[];
    expect(innerCalls).toHaveLength(2);
    expect(innerCalls[0]).toMatchObject({
      task: "route_features",
      run_id: null,
      meta_session_id: null,
      outcome: "accepted",
    });
    expect(innerCalls[1]).toMatchObject({
      task: "route_features",
      run_id: null,
      meta_session_id: first.meta_session_id,
      outcome: "accepted",
    });
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
    const innerCalls = h.db
      .prepare("SELECT task, run_id, meta_session_id, outcome FROM inner_call ORDER BY created_at, id")
      .all() as {
      task: string;
      run_id: string | null;
      meta_session_id: string | null;
      outcome: string;
    }[];
    expect(innerCalls).toHaveLength(2);
    expect(innerCalls[0]).toMatchObject({
      task: "route_features",
      run_id: null,
      meta_session_id: null,
      outcome: "accepted",
    });
    expect(innerCalls[1]).toMatchObject({
      task: "route_features",
      run_id: first.run_id,
      meta_session_id: first.meta_session_id,
      outcome: "accepted",
    });
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

  it("resolves project privacy on MCP delegate and continuation, falling back when off or throwing", async () => {
    const repoPath = createGitRepo("proj");
    const projects: ResolvedProject[] = [
      {
        id: "demo",
        name: "Demo",
        environment: { kind: "host" },
        innerAgent: "inherit",
        contexts: [
          {
            id: "main",
            kind: "repository",
            path: repoPath,
            baseRef: "main",
            primary: true,
            writable: true,
            push: { policy: "branch" },
            sign: false,
            finalizeCommit: false,
          },
        ],
      },
      {
        id: "denied",
        name: "Denied",
        environment: { kind: "host" },
        innerAgent: "off",
        contexts: [
          {
            id: "main",
            kind: "repository",
            path: repoPath,
            baseRef: "main",
            primary: true,
            writable: true,
            push: { policy: "branch" },
            sign: false,
            finalizeCommit: false,
          },
        ],
      },
      {
        id: "failing",
        name: "Failing",
        environment: { kind: "host" },
        innerAgent: "inherit",
        contexts: [
          {
            id: "main",
            kind: "repository",
            path: repoPath,
            baseRef: "main",
            primary: true,
            writable: true,
            push: { policy: "branch" },
            sign: false,
            finalizeCommit: false,
          },
        ],
      },
    ];

    const seen: { projectId: string; contextId: string }[] = [];
    const {
      harness: h,
      backend,
      contexts,
    } = await setup([valid, valid], true, {
      resolveSetting: (projectId, contextId) => {
        seen.push({ projectId, contextId });
        if (projectId === "denied") return "off";
        if (projectId === "failing") throw new Error("privacy resolver threw");
        return "inherit";
      },
      harness: {
        lifecycle: { allowedRoots: [repoPath] },
        config: {
          allowedRoots: [repoPath],
          projects,
          mcpClients: new Map([
            ["orch", { id: "orch", maxTrustProfile: "edit-untrusted", projects: ["demo", "denied", "failing"] }],
            ["other", { id: "other", maxTrustProfile: "edit-untrusted" }],
          ]),
        },
      },
    });

    const demoRun = await h.ok("delegate_task", {
      project: "demo",
      objective: "investigate parser",
      trust_profile: "edit-untrusted",
    });
    await h.settle(demoRun.run_id);
    expect(contexts[0]).toMatchObject({ project: { id: "demo", context_id: "main" } });
    const demoDecisions = h.decisions().filter((d) => d.run_id === demoRun.run_id);
    expect(demoDecisions).toHaveLength(1);
    expect(JSON.parse(demoDecisions[0]?.features_json ?? "{}").route_features.classifier).toBe("route_features.v1");

    const demoContinued = await h.ok("continue_task", {
      meta_session_id: demoRun.meta_session_id,
      instruction: "next step",
    });
    await h.settle(demoContinued.run_id);
    expect(contexts[1]).toMatchObject({
      metaSessionId: demoRun.meta_session_id,
      project: { id: "demo", context_id: "main" },
    });
    const demoContinuedDecisions = h.decisions().filter((d) => d.run_id === demoContinued.run_id);
    expect(demoContinuedDecisions).toHaveLength(1);
    expect(JSON.parse(demoContinuedDecisions[0]?.features_json ?? "{}").route_features.classifier).toBe(
      "route_features.v1",
    );
    expect(backend.requests).toHaveLength(2);

    const deniedRun = await h.ok("delegate_task", {
      project: "denied",
      objective: "fix bug",
      trust_profile: "edit-untrusted",
    });
    await h.settle(deniedRun.run_id);
    const deniedDecisions = h.decisions().filter((d) => d.run_id === deniedRun.run_id);
    expect(deniedDecisions).toHaveLength(1);
    expect(JSON.parse(deniedDecisions[0]?.features_json ?? "{}").route_features.classifier).toBe("heuristic.v1");
    expect(backend.requests).toHaveLength(2);

    const deniedContinued = await h.ok("continue_task", {
      meta_session_id: deniedRun.meta_session_id,
      instruction: "next step",
    });
    await h.settle(deniedContinued.run_id);
    const deniedContinuedDecisions = h.decisions().filter((d) => d.run_id === deniedContinued.run_id);
    expect(deniedContinuedDecisions).toHaveLength(1);
    expect(JSON.parse(deniedContinuedDecisions[0]?.features_json ?? "{}").route_features.classifier).toBe(
      "heuristic.v1",
    );
    expect(backend.requests).toHaveLength(2);

    const failingRun = await h.ok("delegate_task", {
      project: "failing",
      objective: "refactor engine",
      trust_profile: "edit-untrusted",
    });
    await h.settle(failingRun.run_id);
    const failingDecisions = h.decisions().filter((d) => d.run_id === failingRun.run_id);
    expect(failingDecisions).toHaveLength(1);
    expect(JSON.parse(failingDecisions[0]?.features_json ?? "{}").route_features.classifier).toBe("heuristic.v1");
    expect(backend.requests).toHaveLength(2);

    expect(seen).toEqual([
      { projectId: "demo", contextId: "main" },
      { projectId: "demo", contextId: "main" },
      { projectId: "denied", contextId: "main" },
      { projectId: "denied", contextId: "main" },
      { projectId: "failing", contextId: "main" },
    ]);
  }, 120_000);

  it("does not re-invoke route classification on replayed delegate_task with same idempotency key", async () => {
    const { harness: h, backend } = await setup([valid]);
    const first = await h.call("delegate_task", {
      objective: "ok",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      idempotency_key: "idem-t1111",
    });
    expect(first.isError).toBe(false);
    expect(first.body).not.toHaveProperty("replayed");
    expect(backend.requests).toHaveLength(1);
    await h.settle(first.body.run_id);
    const stored = h.decisions();
    expect(stored.map((row) => row.run_id)).toEqual([first.body.run_id]);
    expect(innerCalls(h)).toHaveLength(1);

    // T11.11/T11.14 residual: the replay answers from the ledger. With the backend now erroring, no classifier call, no
    // new `inner_call` row and no new decision row are written, and the stored decision is byte-identical.
    backend.setScript([{ kind: "error" }]);
    const replayed = await h.call("delegate_task", {
      objective: "ok",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      idempotency_key: "idem-t1111",
    });
    expect(replayed.isError).toBe(false);
    expect(replayed.body).toMatchObject({ replayed: true, run_id: first.body.run_id });
    expect(backend.requests).toHaveLength(1);
    expect(h.decisions()).toEqual(stored);
    expect(innerCalls(h)).toHaveLength(1);
    expect((await h.ok("explain_route", { run_id: first.body.run_id })).features.route_features).toEqual(
      JSON.parse(stored[0]?.features_json ?? "{}").route_features,
    );
    expect(backend.requests).toHaveLength(1);
  }, 120_000);

  it.each([
    {
      label: "required provider (narrowed candidates)",
      routing: { provider_preference: "fake-b", require_provider: true },
      required: "fake-b",
      verdicts: [["fake-b", true]],
      rule: "required_provider",
      // Same workspace: a required provider is chosen before affinity, so the two runs select by the same rule.
      freshWorkspace: false,
    },
    {
      label: "preference only with grok down (excluded candidate)",
      routing: { provider_preference: "fake-b" },
      required: null,
      verdicts: [
        ["fake", true],
        ["fake-b", true],
        ["grok", false],
      ],
      rule: "provider_preference",
      // Fresh workspace for the twin: the first run's success would otherwise hold the choice by affinity (T7.5), a
      // selection rule change that has nothing to do with the classifier.
      freshWorkspace: true,
    },
  ])(
    "changes nothing but the stored features ($label): eligibility, require_provider, selection, compile inputs and compile verdict match a heuristic run",
    async ({ routing, required, verdicts: expectedVerdicts, rule, freshWorkspace }) => {
      // First call accepted, every later call errors: run 1 stores inner features, run 2 the heuristic, same request.
      const { harness: h, backend } = await setup([valid, { kind: "error" }]);
      down.add("grok");
      const objective = "investigate the parser canary-7f3c";
      const inner = await h.delegate(objective, routing);
      const twinWorkspace = freshWorkspace ? h.newRepo("twin") : h.repo;
      const heuristic = await h.settle(
        (
          await h.ok("delegate_task", {
            objective,
            workspace_path: twinWorkspace,
            trust_profile: "edit-untrusted",
            routing,
          })
        ).run_id,
      );
      expect(inner.status).toBe("SUCCEEDED");
      expect(heuristic.status).toBe("SUCCEEDED");
      expect(backend.requests).toHaveLength(2);
      const [a, b] = h.decisions();
      if (a === undefined || b === undefined) throw new Error("expected two route decisions");
      expect([a.run_id, b.run_id]).toEqual([inner.run_id, heuristic.run_id]);

      // The only difference between the two stored decisions is `route_features`, and both are bounded.
      const { route_features: innerFeatures, ...restA } = JSON.parse(a.features_json);
      const { route_features: heuristicFeatures, ...restB } = JSON.parse(b.features_json);
      expect(innerFeatures.classifier).toBe("route_features.v1");
      expectBoundedFeatures(innerFeatures, "inner");
      expect(heuristicFeatures).toEqual(
        classifyRequest({ objective, constraints: [], verificationCommands: 0, writable: true }),
      );
      expectBoundedFeatures(heuristicFeatures, "heuristic");
      expect(innerFeatures).not.toEqual(heuristicFeatures);
      // `score_inputs` is the capacity window, which the first run's own success moves (T7.2); it is not read from the
      // classifier either way, so it is compared by shape only.
      const { score_inputs: scoreA, ...fixedA } = restA;
      const { score_inputs: scoreB, ...fixedB } = restB;
      expect(fixedA).toEqual(fixedB);
      const admissible = expectedVerdicts.filter(([, eligible]) => eligible).map(([provider]) => provider);
      expect(Object.keys(scoreA)).toEqual(admissible);
      expect(Object.keys(scoreB)).toEqual(admissible);
      expect(fixedA).toMatchObject({ required_provider: required, provider_preference: "fake-b", admissible });

      // Eligibility (each candidate's verdict and reasons; the stage-2 score beside them moves with the capacity
      // window), selection and weights: identical.
      type Candidate = { provider: string; eligible: boolean; reasons: unknown[] };
      const verdicts = (row: typeof a) =>
        (JSON.parse(row.candidates_json) as Candidate[]).map(({ provider, eligible, reasons }) => ({
          provider,
          eligible,
          reasons,
        }));
      expect(verdicts(a)).toEqual(verdicts(b));
      expect(verdicts(a).map((c) => [c.provider, c.eligible])).toEqual(expectedVerdicts);
      expect(a.weights_json).toBe(b.weights_json);
      expect(a.selected_provider).toBe("fake-b");
      expect(b.selected_provider).toBe("fake-b");
      const reasonsA = JSON.parse(a.reasons_json);
      const reasonsB = JSON.parse(b.reasons_json);
      for (const key of ["outcome", "request_reason", "selection"]) expect(reasonsA[key]).toEqual(reasonsB[key]);
      expect(reasonsA.selection).toMatchObject({ provider: "fake-b", rule });
      for (const row of [a, b]) expect(replayRouteDecision(row)).toEqual(REPLAY_OK);

      // Compile: the verdict (provider, no model pin) and its inputs (the stored request and policy snapshot) are the
      // same for both runs. The compiled argv is not persisted, so this is the pin on it (ROADMAP T11.11 note).
      expect(compiled).toEqual([
        { provider: "fake-b", runId: inner.run_id, model: undefined },
        { provider: "fake-b", runId: heuristic.run_id, model: undefined },
      ]);
      type RunRow = {
        id: string;
        provider: string;
        model: string | null;
        trust_profile: string;
        request_json: string;
        policy_snapshot_json: string;
      };
      const runs = h.db
        .prepare(
          "SELECT id, provider, model, trust_profile, request_json, policy_snapshot_json FROM run ORDER BY created_at, id",
        )
        .all() as RunRow[];
      expect(runs.map((r) => r.id)).toEqual([inner.run_id, heuristic.run_id]);
      const { workspace: workspaceA, ...requestA } = JSON.parse(runs[0]?.request_json ?? "{}");
      const { workspace: workspaceB, ...requestB } = JSON.parse(runs[1]?.request_json ?? "{}");
      expect([workspaceA, workspaceB]).toEqual([h.repo, twinWorkspace]);
      expect(requestA).toEqual(requestB);
      expect(runs[1]).toEqual({ ...runs[0], id: heuristic.run_id, request_json: runs[1]?.request_json });
      expect(runs[0]?.provider).toBe("fake-b");
      expect(runs[0]?.model).toBeNull();

      // Audit rows: one per classification, no run id at admission, and no prompt text (FR-INN-16).
      const audit = h.db.prepare("SELECT * FROM inner_call ORDER BY created_at, id").all() as Record<string, unknown>[];
      expect(
        audit.map(({ task, run_id, meta_session_id, outcome }) => ({ task, run_id, meta_session_id, outcome })),
      ).toEqual([
        { task: "route_features", run_id: null, meta_session_id: null, outcome: "accepted" },
        { task: "route_features", run_id: null, meta_session_id: null, outcome: "fallback_unavailable" },
      ]);
      expect(JSON.stringify(audit)).not.toContain("canary-7f3c");
      expect(JSON.stringify(audit)).not.toContain("fake-b");
    },
    120_000,
  );

  it("replays and explains the quota failover decision with the backend off; a continuation after the failover classifies under the session and never re-routes", async () => {
    const { harness: h, backend, contexts } = await setup([valid]);
    const first = await h.delegate("quota");
    await h.waitFor(() => h.ledger.findSuccessorRun(first.run_id) !== undefined);
    const successorId = h.ledger.findSuccessorRun(first.run_id)?.id as string;
    const successor = await h.settle(successorId);
    expect(first.status).toBe("FAILED");
    expect(successor.status).toBe("SUCCEEDED");
    expect(successor.provider.adapter).toBe("fake-b");
    expect(successor.meta_session_id).toBe(first.meta_session_id);
    expect(backend.requests).toHaveLength(2);

    // Replay and explain read the stored rows only: the backend is erroring from here on and is never called.
    backend.setScript([{ kind: "error" }]);
    const [admitted, failover] = h.decisions();
    if (admitted === undefined || failover === undefined) throw new Error("expected two route decisions");
    expect([admitted.run_id, failover.run_id]).toEqual([first.run_id, successorId]);
    expect(JSON.parse(failover.reasons_json).continuation).toEqual({
      mode: "handoff",
      reason: "quota_failover",
      from_provider: "fake",
    });
    const failoverFeatures = JSON.parse(failover.features_json);
    expect(failoverFeatures.required_provider).toBeNull();
    expect(failoverFeatures.route_features).toMatchObject({
      classifier: "route_features.v1",
      task_kind: { value: "investigation", source: "inner", model_id: "reported-model" },
    });
    expectBoundedFeatures(failoverFeatures.route_features, "inner");
    for (const row of [admitted, failover]) {
      expect(replayRouteDecision(row)).toEqual(REPLAY_OK);
      expect((await h.ok("explain_route", { run_id: row.run_id })).features.route_features).toEqual(
        JSON.parse(row.features_json).route_features,
      );
    }
    expect(backend.requests).toHaveLength(2);
    expect(innerCalls(h)).toEqual([
      { task: "route_features", run_id: null, meta_session_id: null, outcome: "accepted" },
      { task: "route_features", run_id: first.run_id, meta_session_id: first.meta_session_id, outcome: "accepted" },
    ]);

    // A continuation after the failover: classified under the session (no run yet), the backend fails, the heuristic is
    // stored, and the decision still resumes on the provider the failover chose. The harness's scripted spare cannot
    // resume a native session (`resumeArgs` binds to `fake` only, `src/routing/fixtures/harness.ts`), so the run then
    // fails at dispatch exactly as it does with no classifier at all; the serve-level case covers a resumed run.
    const continued = await h.ok("continue_task", { meta_session_id: first.meta_session_id, instruction: "ok" });
    const third = await h.settle(continued.run_id);
    expect(third.provider.adapter).toBe("fake-b");
    expect(third).toMatchObject({ status: "FAILED", failure_code: "ELIGIBILITY_NONE" });
    expect(third.failure_detail).toMatch(/binding is for fake-b/u);
    expect(contexts).toHaveLength(3);
    expect(contexts[2]).toEqual({ metaSessionId: first.meta_session_id });
    expect(backend.requests).toHaveLength(3);
    const continuation = h.decisions()[2];
    if (continuation === undefined) throw new Error("expected a continuation route decision");
    expect(continuation.run_id).toBe(continued.run_id);
    expect(continuation.selected_provider).toBe("fake-b");
    expect(JSON.parse(continuation.reasons_json).continuation).toMatchObject({
      mode: "resume",
      from_provider: "fake-b",
    });
    expect(JSON.parse(continuation.features_json).route_features).toEqual(
      classifyRequest({ objective: "ok", constraints: [], verificationCommands: 0, writable: true }),
    );
    expect(replayRouteDecision(continuation)).toEqual(REPLAY_OK);
    expect(innerCalls(h)[2]).toEqual({
      task: "route_features",
      run_id: null,
      meta_session_id: first.meta_session_id,
      outcome: "fallback_unavailable",
    });
    // Resume compiles are not logged by the harness; the failed and successor runs compiled on their routed providers.
    expect(compiled).toEqual([
      { provider: "fake", runId: first.run_id, model: undefined },
      { provider: "fake-b", runId: successorId, model: undefined },
    ]);
  }, 120_000);
});
