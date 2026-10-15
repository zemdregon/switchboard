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
import { down, type Harness, type HarnessOptions, startHarness } from "../routing/fixtures/harness.js";

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

    const replayed = await h.call("delegate_task", {
      objective: "ok",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
      idempotency_key: "idem-t1111",
    });
    expect(replayed.isError).toBe(false);
    expect(replayed.body).toMatchObject({ replayed: true });
    expect(backend.requests).toHaveLength(1);
  }, 120_000);
});
