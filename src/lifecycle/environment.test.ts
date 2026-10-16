/**
 * The environment port in the run lifecycle (T10.1; LLD §11.3, FR-PRJ-04, FR-PRJ-05). The lifecycle sees environments
 * only through `environments.resolve`; these tests drive it with a recording fake. No container runtime is involved
 * (the Docker leg is `src/environment/container-docker.test.ts`, opt-in). Host behaviour must be unchanged: a run by
 * workspace path or under a `host` project never consults a container environment.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type Invocation, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import {
  type Environment,
  EnvironmentRefusal,
  hostEnvironment,
  type PreparedInvocation,
  type RunContext,
} from "../environment/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { type EnvironmentResolver, type EnvironmentSnapshot, RunLifecycle } from "./index.js";

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

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});
const DIGEST = `sha256:${"a".repeat(64)}`;
const HOST_PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "trusted-development",
};
const CONTAINER_PROJECT: ProjectSnapshot = { ...HOST_PROJECT, environment_kind: "container", image_digest: DIGEST };

/** Records every call; `behaviour` decides what `prepare` does. */
function recordingEnvironment(
  behaviour: "pass" | "refuse" | "unspawnable" = "pass",
): Environment & { prepared: Array<{ run: RunContext; inv: Invocation }>; torn: string[] } {
  const prepared: Array<{ run: RunContext; inv: Invocation }> = [];
  const torn: string[] = [];
  return {
    kind: "container",
    prepared,
    torn,
    prepare(run, inv): Promise<PreparedInvocation> {
      prepared.push({ run, inv });
      if (behaviour === "refuse") {
        return Promise.reject(
          new EnvironmentRefusal("CONTAINER_IMAGE_HAS_GIT_CLIENT", "image has a Git client: git at /usr/bin/git"),
        );
      }
      if (behaviour === "unspawnable") {
        return Promise.resolve({
          invocation: { ...inv, argv: ["/nonexistent/switchboard-env-probe", ...inv.argv.slice(1)] },
        });
      }
      return Promise.resolve({ invocation: inv });
    },
    teardown(run) {
      torn.push(run.runId);
      return Promise.resolve();
    },
    sweepOrphans: () => Promise.resolve({ removed: [] }),
  };
}

let root: string;
let repo: string;
let docs: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-env-")));
  repo = path.join(root, "repo");
  docs = path.join(root, "docs");
  mkdirSync(repo);
  mkdirSync(docs);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function start(environments: EnvironmentResolver | undefined): RunLifecycle {
  const ids = createIdGenerator();
  const dataDir = path.join(root, "data");
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  lifecycle = new RunLifecycle({
    ledger,
    workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ scenario: "success", timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    ...(environments !== undefined ? { environments } : {}),
  });
  lifecycle.start();
  return lifecycle;
}

async function runToEnd(l: RunLifecycle, project: ProjectSnapshot | undefined) {
  const { runId } = await l.submit({
    clientId: "c",
    objective: "do the thing",
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...(project !== undefined ? { project } : {}),
  });
  const final = await l.waitForTerminal(runId);
  return { runId, final };
}

const transitions = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === "state_transition")
    .map((e) => ({ ...(JSON.parse(e.payload_json) as Record<string, unknown>) }));
const failedPayload = (runId: string) => transitions(runId).find((t) => t.to === "FAILED");
const states = (runId: string) => transitions(runId).map((t) => t.to);

describe("environment port in the lifecycle (T10.1)", () => {
  it("host default unchanged: no resolver, a run by workspace path and a host project both succeed on the host", async () => {
    const l = start(undefined);
    const byPath = await runToEnd(l, undefined);
    expect(byPath.final.state, byPath.final.failure_detail ?? "").toBe("SUCCEEDED");
    const hostProject = await runToEnd(l, HOST_PROJECT);
    expect(hostProject.final.state, hostProject.final.failure_detail ?? "").toBe("SUCCEEDED");
  });

  it("a resolver is asked once per run with the frozen snapshot; a host answer keeps the identity environment", async () => {
    const asked: Array<EnvironmentSnapshot | undefined> = [];
    const container = recordingEnvironment();
    const l = start({
      resolve(project) {
        asked.push(project);
        return project?.environment_kind === "container"
          ? { environment: container, readOnlyContexts: [] }
          : { environment: hostEnvironment, readOnlyContexts: [] };
      },
    });
    const r = await runToEnd(l, HOST_PROJECT);
    expect(r.final.state, r.final.failure_detail ?? "").toBe("SUCCEEDED");
    expect(asked).toEqual([HOST_PROJECT]);
    expect(container.prepared).toEqual([]);
    expect(container.torn).toEqual([]);
  });

  it("a container run with no container environment is refused before any lease or worktree (fail closed)", async () => {
    const l = start(undefined);
    const r = await runToEnd(l, CONTAINER_PROJECT);
    expect(r.final.state).toBe("FAILED");
    expect(r.final.failure_code).toBe("ELIGIBILITY_NONE");
    expect(r.final.failure_detail).toContain("no container environment is available for project web");
    expect(failedPayload(r.runId)).toMatchObject({
      reason: "ENVIRONMENT_UNAVAILABLE",
      stage: "environment",
      environment_kind: "container",
    });
    expect(states(r.runId)).not.toContain("LEASED");
    expect(states(r.runId)).not.toContain("RUNNING");
  });

  it("a resolver that answers host for a container snapshot is refused the same way", async () => {
    const l = start({ resolve: () => ({ environment: hostEnvironment, readOnlyContexts: [] }) });
    const r = await runToEnd(l, CONTAINER_PROJECT);
    expect(r.final.state).toBe("FAILED");
    expect(r.final.failure_code).toBe("ELIGIBILITY_NONE");
    expect(r.final.failure_detail).toContain("resolver answered host");
    expect(failedPayload(r.runId)?.reason).toBe("ENVIRONMENT_UNAVAILABLE");
  });

  it("a container run: prepare gets the run facts just before spawn, the run succeeds, teardown runs once at the end", async () => {
    const container = recordingEnvironment("pass");
    const l = start({
      resolve: (project) =>
        project?.environment_kind === "container"
          ? {
              environment: container,
              readOnlyContexts: [{ id: "docs", path: docs }],
              limits: { cpus: 1, memoryMb: 256 },
            }
          : undefined,
    });
    const r = await runToEnd(l, CONTAINER_PROJECT);
    expect(r.final.state, r.final.failure_detail ?? "").toBe("SUCCEEDED");
    expect(container.prepared).toHaveLength(1);
    const { run, inv } = container.prepared[0] as { run: RunContext; inv: Invocation };
    expect(run.runId).toBe(r.runId);
    expect(run.projectId).toBe("web");
    expect(run.imageDigest).toBe(DIGEST);
    expect(run.readOnlyContexts).toEqual([{ id: "docs", path: docs }]);
    expect(run.limits).toEqual({ cpus: 1, memoryMb: 256 });
    expect(run.profile.name).toBe("edit-untrusted");
    // The worktree the lifecycle created, not the workspace itself (FR-WS-08: each run mounts its own worktree).
    expect(run.worktreePath).not.toBe(repo);
    expect(run.worktreePath.startsWith(path.join(root, "data"))).toBe(true);
    expect(inv.cwd).toBe(run.worktreePath);
    expect(inv.argv[0]).toBe(process.execPath);
    expect(container.torn).toEqual([r.runId]);
    expect(states(r.runId)).toContain("RUNNING");
  });

  it("a container refusal ends the run ELIGIBILITY_NONE with the reason, before spawn, and still tears down", async () => {
    const container = recordingEnvironment("refuse");
    const l = start({ resolve: () => ({ environment: container, readOnlyContexts: [] }) });
    const r = await runToEnd(l, CONTAINER_PROJECT);
    expect(r.final.state).toBe("FAILED");
    expect(r.final.failure_code).toBe("ELIGIBILITY_NONE");
    expect(r.final.failure_detail).toContain("git at /usr/bin/git");
    expect(failedPayload(r.runId)).toMatchObject({
      reason: "CONTAINER_IMAGE_HAS_GIT_CLIENT",
      stage: "environment",
      environment_kind: "container",
    });
    expect(states(r.runId)).toContain("LEASED");
    expect(states(r.runId)).not.toContain("RUNNING");
    expect(container.prepared).toHaveLength(1);
    expect(container.torn).toEqual([r.runId]);
  });

  it("the prepared invocation is what is spawned: an unspawnable wrapper fails the run and teardown still runs", async () => {
    const container = recordingEnvironment("unspawnable");
    const l = start({ resolve: () => ({ environment: container, readOnlyContexts: [] }) });
    const r = await runToEnd(l, CONTAINER_PROJECT);
    expect(r.final.state).toBe("FAILED");
    expect(r.final.failure_code).toBe("PROCESS_CRASH");
    expect(container.torn).toEqual([r.runId]);
  });
});
