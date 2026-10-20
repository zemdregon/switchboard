import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import type { ResolvedProfile } from "../adapters/index.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { pollCiTriggers } from "../ci/trigger.js";
import type { CiTriggerSettings, ResolvedProject } from "../config/index.js";
import type { ProjectConfig } from "../config/schema.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle, type RunLifecycleOptions } from "../lifecycle/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import type { AdmitWorkDeps } from "./admission.js";
import { runProjectWorkQueueTick } from "./scheduler.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

function projectFor(repo: string): ResolvedProject {
  return {
    id: "app",
    name: "App",
    environment: { kind: "host" },
    contexts: [
      {
        id: "main",
        kind: "repository",
        path: repo,
        baseRef: "main",
        primary: true,
        writable: true,
        sign: false,
        finalizeCommit: false,
        push: { policy: "none" },
      },
    ],
  };
}

interface QueueFixture {
  root: string;
  repo: string;
  db: ReturnType<typeof openLedger>;
  ledger: ReturnType<typeof createLedger>;
  lifecycle: RunLifecycle;
  registry: AdapterRegistry;
  projects: ResolvedProject[];
  mcpClients: Map<string, { id: string; maxTrustProfile: TrustProfile; projects?: string[]; manageProjects?: boolean }>;
  projectStore?: DynamicProjectStore | undefined;
  close(): Promise<void>;
}

async function startQueueFixture(
  opts: {
    clients?: QueueFixture["mcpClients"];
    projects?: ResolvedProject[];
    projectStore?: DynamicProjectStore;
    scenario?: FakeScenario;
    /** T15.7: the lifecycle's controller Git preparation of rebase runs. */
    rebasePrep?: RunLifecycleOptions["rebasePrep"];
  } = {},
): Promise<QueueFixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-queue-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const db = openLedger(dataDir);
  const ledger = createLedger(db, { ids: createIdGenerator() });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir,
    allowedRoots: [root],
    ids: createIdGenerator(),
  });
  const registry = new AdapterRegistry().register(new FakeAdapter({ scenario: opts.scenario ?? "success" }));
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    ...(opts.rebasePrep !== undefined ? { rebasePrep: opts.rebasePrep } : {}),
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
  });
  lifecycle.start();
  const projects = opts.projects ?? [projectFor(repo)];
  const mcpClients =
    opts.clients ??
    new Map([
      ["orch", { id: "orch", maxTrustProfile: "edit-untrusted", projects: ["app"] }],
      ["low", { id: "low", maxTrustProfile: "inspect-untrusted", projects: ["app"] }],
    ]);
  return {
    root,
    repo,
    db,
    ledger,
    lifecycle,
    registry,
    projects,
    mcpClients,
    projectStore: opts.projectStore,
    close: async () => {
      await lifecycle.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function admissionDeps(f: QueueFixture) {
  return {
    lifecycle: f.lifecycle,
    ledger: f.ledger,
    registry: f.registry,
    config: {
      allowedRoots: [f.root],
      mcpClients: f.mcpClients,
      projects: f.projects,
      dataDir: path.join(f.root, "data"),
      providers: new Map(),
      limits: { globalConcurrency: 4, perProviderConcurrency: 1 },
      capacity: { windowSeconds: 3600, confidenceRuns: 10, retry: { maxAttempts: 2, baseMs: 20, capMs: 100 } },
      routing: {},
    },
    ...(f.projectStore !== undefined ? { projectStore: f.projectStore } : {}),
  } as unknown as AdmitWorkDeps;
}

describe("project work queue (T15.1)", () => {
  let f: QueueFixture;

  afterEach(async () => {
    await f?.close();
  });

  it("admits a READY item only under the creator client ceiling", async () => {
    f = await startQueueFixture();
    const deps = admissionDeps(f);
    const blocked = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "low",
      request: {
        objective: "ok",
        trust_profile: "edit-untrusted",
        project: "app",
        constraints: [],
        routing: {},
      },
      sourceKind: "mcp",
    });
    expect((await runProjectWorkQueueTick(f.ledger, deps, { maxItemsPerProject: 500, dequeueBatch: 1 })).failed).toBe(
      1,
    );
    expect(f.ledger.getWorkItem(blocked.id)?.state).toBe("FAILED_ADMISSION");

    const okRequest = {
      objective: "ok",
      trust_profile: "inspect-untrusted",
      project: "app",
      constraints: [],
      routing: {},
    };
    const okItem = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "low",
      request: okRequest,
      sourceKind: "mcp",
    });
    expect((await runProjectWorkQueueTick(f.ledger, deps, { maxItemsPerProject: 500, dequeueBatch: 1 })).admitted).toBe(
      1,
    );
    const admitted = f.ledger.getWorkItem(okItem.id);
    expect(admitted?.state).toBe("ADMITTED");
    expect(admitted?.admitted_run_id).toMatch(/^run_/u);
    const runId = admitted?.admitted_run_id;
    if (runId === undefined || runId === null) throw new Error("expected admitted run");
    const run = f.ledger.getRunRecord(runId);
    expect(run?.client_id).toBe("low");
    await f.lifecycle.waitForTerminal(runId);
    expect(f.ledger.getWorkItem(okItem.id)?.state).toBe("DONE");
  });

  it("reconcileAdmittingWorkItems resets ADMITTING without a run (NFR-REL-01 Q2)", async () => {
    f = await startQueueFixture();
    const item = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: { objective: "x" },
      sourceKind: "mcp",
    });
    f.ledger.claimReadyWorkItem("app");
    expect(f.ledger.getWorkItem(item.id)?.state).toBe("ADMITTING");
    expect(f.ledger.reconcileAdmittingWorkItems()).toBe(1);
    expect(f.ledger.getWorkItem(item.id)?.state).toBe("READY");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
  });

  it("keeps READY when a dynamic project revision waits for operator approval (Q10)", async () => {
    f = await startQueueFixture({
      clients: new Map([["mgr", { id: "mgr", maxTrustProfile: "edit-untrusted", manageProjects: true, projects: [] }]]),
      projects: [],
    });
    const store = new DynamicProjectStore(f.db, { ids: createIdGenerator() });
    f.projectStore = store;
    const definition: ProjectConfig = {
      id: "dyn-app",
      name: "Dyn",
      contexts: [
        {
          id: "main",
          kind: "repository",
          path: f.repo,
          base_ref: "main",
          push: { policy: "branch", remote: "origin", branch_prefix: "sb/" },
          identity: { name: "A", email: "a@b.c" },
        },
      ],
    };
    store.appendRevision(
      {
        projectId: "dyn-app",
        clientId: "mgr",
        definition,
        status: "PENDING_APPROVAL",
        approvalReasons: ["push_policy", "commit_identity"],
        action: "create_project",
      },
      () => undefined,
    );
    const item = f.ledger.enqueueWorkItem({
      projectId: "dyn-app",
      creatorClientId: "mgr",
      request: {
        objective: "ok",
        trust_profile: "edit-untrusted",
        project: "dyn-app",
        constraints: [],
        routing: {},
      },
      sourceKind: "mcp",
    });
    const r = await runProjectWorkQueueTick(f.ledger, admissionDeps(f), {
      maxItemsPerProject: 500,
      dequeueBatch: 1,
    });
    expect(r.retried).toBe(1);
    expect(f.ledger.getWorkItem(item.id)?.state).toBe("READY");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
  });

  it("starts a dependent READY when its predecessor is already DONE", async () => {
    f = await startQueueFixture();
    const a = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: { objective: "a" },
      sourceKind: "mcp",
    });
    f.ledger.claimReadyWorkItem("app");
    f.ledger.completeWorkAdmission(a.id, { kind: "admitted", runId: "run_01JH0000000000000000000001" });
    expect(f.ledger.markWorkItemDone(a.id)?.state).toBe("DONE");
    const b = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: { objective: "b" },
      sourceKind: "mcp",
      predecessorIds: [a.id],
    });
    expect(b.state).toBe("READY");
    expect(f.ledger.listDistinctProjectIdsWithReadyWork()).toEqual(["app"]);
  });

  it("keeps a dependent PENDING while a predecessor is unfinished", async () => {
    f = await startQueueFixture();
    const a = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: { objective: "a" },
      sourceKind: "mcp",
    });
    const b = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: { objective: "b" },
      sourceKind: "mcp",
      predecessorIds: [a.id],
    });
    expect(b.state).toBe("PENDING");
    const c = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: { objective: "c" },
      sourceKind: "mcp",
      predecessorIds: [b.id],
    });
    expect(c.state).toBe("PENDING");
  });

  const inspectRequest = {
    objective: "ok",
    trust_profile: "inspect-untrusted",
    project: "app",
    constraints: [],
    routing: {},
  };

  async function admitOne(): Promise<{ itemId: string; runId: string; successorId: string }> {
    const item = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: inspectRequest,
      sourceKind: "mcp",
    });
    const successor = f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: { objective: "after" },
      sourceKind: "mcp",
      predecessorIds: [item.id],
    });
    const r = await runProjectWorkQueueTick(f.ledger, admissionDeps(f), { maxItemsPerProject: 500, dequeueBatch: 1 });
    expect(r.admitted).toBe(1);
    const runId = f.ledger.getWorkItem(item.id)?.admitted_run_id;
    if (runId === undefined || runId === null) throw new Error("expected admitted run");
    return { itemId: item.id, runId, successorId: successor.id };
  }

  it("closes an ADMITTED item with terminal_at when its run ends FAILED (LLD §18.2)", async () => {
    f = await startQueueFixture({ scenario: "task_failure" });
    const { itemId, runId, successorId } = await admitOne();
    expect((await f.lifecycle.waitForTerminal(runId)).state).toBe("FAILED");
    const item = f.ledger.getWorkItem(itemId);
    expect(item?.state).toBe("ADMITTED");
    expect(item?.terminal_at).not.toBeNull();
    // The predecessor never reaches DONE, so its successor stays PENDING and is not admissible (§18.3, §18.8).
    expect(f.ledger.getWorkItem(successorId)?.state).toBe("PENDING");
    expect(f.ledger.countAdmissibleWorkItems("app")).toBe(0);
  });

  it("closes an ADMITTED item with terminal_at when its run is CANCELLED (LLD §18.2)", async () => {
    f = await startQueueFixture({ scenario: "hang" });
    const { itemId, runId, successorId } = await admitOne();
    await f.lifecycle.cancel(runId);
    expect((await f.lifecycle.waitForTerminal(runId)).state).toBe("CANCELLED");
    const item = f.ledger.getWorkItem(itemId);
    expect(item?.state).toBe("ADMITTED");
    expect(item?.terminal_at).not.toBeNull();
    expect(f.ledger.getWorkItem(successorId)?.state).toBe("PENDING");
    expect(f.ledger.countAdmissibleWorkItems("app")).toBe(0);
  });

  it("treats a CANCELLED predecessor as blocking in promotion, enqueue and the admissible count (LLD §18.3, §18.8)", async () => {
    f = await startQueueFixture();
    const enqueue = (objective: string, predecessorIds: string[] = []) =>
      f.ledger.enqueueWorkItem({
        projectId: "app",
        creatorClientId: "orch",
        request: { objective },
        sourceKind: "mcp",
        predecessorIds,
      });
    const cancelled = enqueue("cancelled");
    const a = enqueue("a");
    expect(f.ledger.cancelWorkItem(cancelled.id, "orch")?.state).toBe("CANCELLED");
    const b = enqueue("b", [a.id, cancelled.id]);
    expect(b.state).toBe("PENDING");
    // Enqueue applies the same rule: a CANCELLED predecessor alone does not make a successor READY.
    expect(enqueue("c", [cancelled.id]).state).toBe("PENDING");
    expect(f.ledger.claimReadyWorkItem("app")?.id).toBe(a.id);
    f.ledger.completeWorkAdmission(a.id, { kind: "admitted", runId: "run_01JH0000000000000000000002" });
    expect(f.ledger.markWorkItemDone(a.id)?.state).toBe("DONE");
    expect(f.ledger.getWorkItem(b.id)?.state).toBe("PENDING");
    expect(f.ledger.countAdmissibleWorkItems("app")).toBe(0);
  });
});

describe("rebase items (T15.7, FR-QUE-07, LLD §20.4)", () => {
  let f: QueueFixture;
  afterEach(async () => {
    await f?.close();
  });

  const REF = "refs/heads/sb/feature-1";
  const SHA = "2".repeat(40);
  const ciSettings: CiTriggerSettings = {
    enabled: true,
    pollIntervalSeconds: 120,
    ghBinary: "gh",
    useCheckRunsFallback: false,
    maxConsecutiveFixes: 2,
    projects: [
      {
        projectId: "app",
        creatorClientId: "orch",
        enabled: true,
        maxConsecutiveFixes: 2,
        template: { objective: "Fix CI", trustProfile: "edit-untrusted", constraints: [] },
      },
    ],
  };
  const settings = { maxItemsPerProject: 500, dequeueBatch: 1 };

  /** A finished queued task of `orch` whose run pushed {@link SHA} to {@link REF}; then one conflicting poll. */
  async function publishedAndConflicting(): Promise<{ metaSessionId: string; rebaseItemId: string }> {
    const deps = admissionDeps(f);
    f.ledger.enqueueWorkItem({
      projectId: "app",
      creatorClientId: "orch",
      request: { objective: "Build it", trust_profile: "edit-untrusted", project: "app", constraints: [], routing: {} },
      sourceKind: "mcp",
    });
    expect((await runProjectWorkQueueTick(f.ledger, deps, settings)).admitted).toBe(1);
    const runId = f.db.prepare("SELECT admitted_run_id AS id FROM project_work_item").get() as { id: string };
    expect((await f.lifecycle.waitForTerminal(runId.id)).state).toBe("SUCCEEDED");
    const metaSessionId = f.ledger.getRunRecord(runId.id)?.meta_session_id as string;
    f.db
      .prepare(
        `INSERT INTO git_push (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail, requested_by,
           created_at) VALUES ('gps_t157_rebase_000000000001', ?, 'app', 'main', 'origin', ?, ?, 'ACCEPTED', NULL,
           'agent_tool', '2026-10-19T01:00:00.000Z')`,
      )
      .run(runId.id, REF, SHA);
    const r = await pollCiTriggers({
      db: f.db,
      ledger: f.ledger,
      port: { latestForPublishedRef: async () => null },
      pulls: {
        pullRequestForPublishedRef: async () => ({
          number: 5,
          state: "OPEN",
          isDraft: false,
          mergeable: "CONFLICTING",
          headSha: SHA,
        }),
      },
      settings: ciSettings,
      resolveRemote: async () => ({ owner: "acme", repo: "app" }),
    });
    expect(r.rebases).toHaveLength(1);
    return { metaSessionId, rebaseItemId: r.rebases[0]?.workItemId as string };
  }

  it("admits the rebase item as a continuation of the publishing meta-session and prepares the merge before spawn", async () => {
    const preps: { runId: string; worktreePath: string; repoRoot: string; baseRef: string }[] = [];
    f = await startQueueFixture({
      rebasePrep: async (q) => {
        preps.push(q);
        return { ok: true, mergeParentSha: "a".repeat(40), conflictedPaths: 1 };
      },
    });
    const { metaSessionId, rebaseItemId } = await publishedAndConflicting();
    expect((await runProjectWorkQueueTick(f.ledger, admissionDeps(f), settings)).admitted).toBe(1);
    const item = f.ledger.getWorkItem(rebaseItemId);
    const runId = item?.admitted_run_id as string;
    expect(f.ledger.getRunRecord(runId)?.meta_session_id).toBe(metaSessionId);
    expect(f.ledger.getRunRebase(runId)).toMatchObject({ work_item_id: rebaseItemId, publish_ref: REF, head_sha: SHA });
    expect((await f.lifecycle.waitForTerminal(runId)).state).toBe("SUCCEEDED");
    expect(preps).toHaveLength(1);
    expect(preps[0]).toMatchObject({ runId, baseRef: "main" });
    const events = f.db
      .prepare("SELECT payload_json FROM run_event WHERE run_id = ? AND type = 'rebase_prepared'")
      .all(runId) as {
      payload_json: string;
    }[];
    expect(events.map((e) => JSON.parse(e.payload_json))).toEqual([
      { merge_parent_sha: "a".repeat(40), conflicted_paths: 1 },
    ]);

    // A crash after the run was admitted but before the item recorded it: the next tick completes the admission with
    // the recorded run instead of starting a second one.
    f.db
      .prepare("UPDATE project_work_item SET state = 'READY', admitted_run_id = NULL, terminal_at = NULL WHERE id = ?")
      .run(rebaseItemId);
    const runsBefore = (f.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
    expect((await runProjectWorkQueueTick(f.ledger, admissionDeps(f), settings)).admitted).toBe(1);
    expect(f.ledger.getWorkItem(rebaseItemId)?.admitted_run_id).toBe(runId);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n).toBe(runsBefore);
  });

  it("fails the rebase run before spawn when the preparation fails or is not wired (fail closed)", async () => {
    f = await startQueueFixture({ rebasePrep: async () => ({ ok: false, reason: "WORKTREE_DIRTY" }) });
    const { rebaseItemId } = await publishedAndConflicting();
    await runProjectWorkQueueTick(f.ledger, admissionDeps(f), settings);
    const runId = f.ledger.getWorkItem(rebaseItemId)?.admitted_run_id as string;
    const done = await f.lifecycle.waitForTerminal(runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("TOOL_FAILURE");
    await f.close();

    f = await startQueueFixture();
    const second = await publishedAndConflicting();
    await runProjectWorkQueueTick(f.ledger, admissionDeps(f), settings);
    const run2 = f.ledger.getWorkItem(second.rebaseItemId)?.admitted_run_id as string;
    expect((await f.lifecycle.waitForTerminal(run2)).state).toBe("FAILED");
  });
});
