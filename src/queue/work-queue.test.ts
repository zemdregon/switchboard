import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import type { ResolvedProfile } from "../adapters/index.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ResolvedProject } from "../config/index.js";
import type { ProjectConfig } from "../config/schema.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
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
  opts: { clients?: QueueFixture["mcpClients"]; projects?: ResolvedProject[]; projectStore?: DynamicProjectStore } = {},
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
  const registry = new AdapterRegistry().register(new FakeAdapter({ scenario: "success" }));
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
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
});
