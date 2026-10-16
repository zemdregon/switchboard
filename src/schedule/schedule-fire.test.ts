import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import type { AdmitWorkDeps } from "../queue/admission.js";
import { runProjectWorkQueueTick } from "../queue/scheduler.js";
import { WorkspaceManager } from "../workspace/index.js";
import { fireDueSchedules } from "./fire.js";
import { determineScheduleApprovalState } from "./widening.js";

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

describe("Schedule firing and injected-clock matrix (T15.2, FR-QUE-02, LLD §18.5)", () => {
  let root: string;
  let dataDir: string;
  let db: ReturnType<typeof openLedger>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-sch-test-")));
    dataDir = path.join(root, "data");
    mkdirSync(dataDir);
    db = openLedger(dataDir);
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  // S1: Inert until enabled
  it("S1: a schedule is inert until enabled (off by default)", () => {
    const ledger = createLedger(db);
    const sch = ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "*/1 * * * *",
      template: { objective: "do work", trust_profile: "inspect-untrusted", project: "proj-1" },
    });
    expect(sch.enabled).toBe(0);

    // Advance 3 minutes, tick each minute
    const t0 = new Date("2026-10-16T11:00:00.000Z");
    for (let m = 0; m < 3; m++) {
      const now = new Date(t0.getTime() + m * 60_000);
      const res = fireDueSchedules(ledger, { nowUtc: now });
      expect(res.firedCount).toBe(0);
      expect(res.workItemsEnqueued).toHaveLength(0);
    }

    const items = ledger.listWorkItems({ clientId: "client-a", limit: 10 });
    expect(items).toHaveLength(0);
  });

  // S2: Enable then fire once
  it("S2: enabling fires one work item at due minute with source_kind=schedule and updates last_fire_at", () => {
    const ledger = createLedger(db);
    const sch = ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "*/5 * * * *",
      template: { objective: "work", trust_profile: "inspect-untrusted", project: "proj-1" },
    });

    ledger.enableSchedule(sch.id);

    const dueTime = new Date("2026-10-16T11:05:00.000Z");
    const res = fireDueSchedules(ledger, { nowUtc: dueTime });

    expect(res.dueCount).toBe(1);
    expect(res.firedCount).toBe(1);
    expect(res.workItemsEnqueued).toHaveLength(1);

    const itemId = res.workItemsEnqueued[0];
    expect(itemId).toBeDefined();
    const workItem = itemId ? ledger.getWorkItem(itemId) : undefined;
    expect(workItem).toBeDefined();
    expect(workItem?.source_kind).toBe("schedule");
    expect(workItem?.source_id).toBe(sch.id);
    expect(workItem?.creator_client_id).toBe("client-a");
    expect(workItem?.project_id).toBe("proj-1");
    expect(workItem?.state).toBe("READY");

    const updatedSch = ledger.getSchedule(sch.id);
    expect(updatedSch?.last_fire_at).toBe(dueTime.toISOString());
  });

  // S3: Same minute dedup
  it("S3: second tick in the same minute does not enqueue duplicate items", () => {
    const ledger = createLedger(db);
    ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "* * * * *",
      template: { objective: "minutely task", trust_profile: "inspect-untrusted", project: "proj-1" },
      enabled: true,
    });

    const t = new Date("2026-10-16T11:05:10.000Z");
    const res1 = fireDueSchedules(ledger, { nowUtc: t });
    expect(res1.firedCount).toBe(1);

    // Second tick 30 seconds later in the same minute
    const tSameMin = new Date("2026-10-16T11:05:40.000Z");
    const res2 = fireDueSchedules(ledger, { nowUtc: tSameMin });
    expect(res2.dueCount).toBe(1);
    expect(res2.firedCount).toBe(0);
    expect(res2.skippedCount).toBe(1);

    const items = ledger.listWorkItems({ clientId: "client-a", limit: 10 });
    expect(items).toHaveLength(1);
  });

  // S4: Restart same minute
  it("S4: after restart in the same minute, no duplicate item is enqueued", () => {
    let ledger = createLedger(db);
    ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "0 * * * *",
      template: { objective: "hourly", trust_profile: "inspect-untrusted", project: "proj-1" },
      enabled: true,
    });

    const fireTime = new Date("2026-10-16T12:00:15.000Z");
    const res1 = fireDueSchedules(ledger, { nowUtc: fireTime });
    expect(res1.firedCount).toBe(1);

    // Simulate process crash / restart: close db and open new ledger connection
    db.close();
    db = openLedger(dataDir);
    ledger = createLedger(db);

    // Tick again same minute
    const restartTime = new Date("2026-10-16T12:00:45.000Z");
    const res2 = fireDueSchedules(ledger, { nowUtc: restartTime });
    expect(res2.firedCount).toBe(0);
    expect(res2.skippedCount).toBe(1);

    const items = ledger.listWorkItems({ clientId: "client-a", limit: 10 });
    expect(items).toHaveLength(1);
  });

  // S5: Crash before commit simulation
  it("S5: crash before commit rolls back both work item and last_fire_at; fires cleanly on next tick", () => {
    const ledger = createLedger(db);
    const sch = ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "0 * * * *",
      template: { objective: "hourly", trust_profile: "inspect-untrusted", project: "proj-1" },
      enabled: true,
    });

    const fireTime = new Date("2026-10-16T12:00:00.000Z");

    // Simulate a crash inside the transaction before commit
    expect(() => {
      ledger.immediate(() => {
        ledger.enqueueWorkItem({
          projectId: sch.project_id,
          creatorClientId: sch.creator_client_id,
          request: { objective: "crash test" },
          sourceKind: "schedule",
          sourceId: sch.id,
        });
        throw new Error("simulated crash before commit");
      });
    }).toThrow(/simulated crash/u);

    // After rollback, schedule last_fire_at is still null and queue is empty
    expect(ledger.getSchedule(sch.id)?.last_fire_at).toBeNull();
    expect(ledger.listWorkItems({ clientId: "client-a", limit: 10 })).toHaveLength(0);

    // Next tick fires cleanly
    const res = fireDueSchedules(ledger, { nowUtc: fireTime });
    expect(res.firedCount).toBe(1);
    expect(ledger.listWorkItems({ clientId: "client-a", limit: 10 })).toHaveLength(1);
  });

  // S6: disable stops future fires
  it("S6: disable stops future fires while preserving existing items", () => {
    const ledger = createLedger(db);
    const sch = ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "* * * * *",
      template: { objective: "job", trust_profile: "inspect-untrusted", project: "proj-1" },
      enabled: true,
    });

    const t1 = new Date("2026-10-16T11:00:00.000Z");
    const res1 = fireDueSchedules(ledger, { nowUtc: t1 });
    expect(res1.firedCount).toBe(1);

    // Disable schedule
    const disabled = ledger.disableSchedule(sch.id);
    expect(disabled?.enabled).toBe(0);
    expect(disabled?.disabled_at).toBeDefined();

    // Advance to next minute
    const t2 = new Date("2026-10-16T11:01:00.000Z");
    const res2 = fireDueSchedules(ledger, { nowUtc: t2 });
    expect(res2.dueCount).toBe(0);
    expect(res2.firedCount).toBe(0);

    // Existing work item remains
    const items = ledger.listWorkItems({ clientId: "client-a", limit: 10 });
    expect(items).toHaveLength(1);
  });

  // S7: {{schedule_fire_at}} token substitution
  it("S7: substitutes {{schedule_fire_at}} with the tick timestamp in request_json", () => {
    const ledger = createLedger(db);
    ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "0 0 * * *",
      template: {
        objective: "Daily summary generated at {{schedule_fire_at}} for audit",
        trust_profile: "inspect-untrusted",
        project: "proj-1",
      },
      enabled: true,
    });

    const tickTime = new Date("2026-10-16T00:00:00.000Z");
    const res = fireDueSchedules(ledger, { nowUtc: tickTime });
    expect(res.firedCount).toBe(1);

    const itemId = res.workItemsEnqueued[0];
    expect(itemId).toBeDefined();
    const item = itemId ? ledger.getWorkItem(itemId) : undefined;
    expect(item).toBeDefined();
    const parsedRequest = JSON.parse(item?.request_json ?? "{}") as { objective: string };
    expect(parsedRequest.objective).toBe("Daily summary generated at 2026-10-16T00:00:00.000Z for audit");
  });

  // S8: Invalid cron rejected at create time
  it("S8: invalid cron expression is rejected at creation (INVALID_REQUEST)", () => {
    const ledger = createLedger(db);
    expect(() =>
      ledger.createSchedule({
        projectId: "proj-1",
        creatorClientId: "client-a",
        cronExpr: "invalid cron expression",
        template: {},
      }),
    ).toThrow();
  });

  // S9: Widening chat schedule starts in PENDING_APPROVAL and enabled=0
  it("S9: widening schedule from a chat client waits for operator approval", () => {
    const chatClient: ResolvedMcpClient = {
      id: "chat-agent",
      maxTrustProfile: "inspect-untrusted",
      privilegedApproval: "required",
    };

    // Chat client attempts to create schedule with edit-untrusted template (above ceiling)
    const wideningTemplate = {
      objective: "modify code",
      trust_profile: "edit-untrusted",
      project: "proj-1",
    };

    const approvalState = determineScheduleApprovalState(wideningTemplate, chatClient);
    expect(approvalState).toBe("PENDING_APPROVAL");

    const ledger = createLedger(db);
    const sch = ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: chatClient.id,
      cronExpr: "* * * * *",
      template: wideningTemplate,
      approvalState,
      enabled: true, // Attempting to enable immediately
    });

    // Forced off by default because approval_state is PENDING_APPROVAL
    expect(sch.enabled).toBe(0);
    expect(sch.approval_state).toBe("PENDING_APPROVAL");

    // Cannot enable without approve
    expect(() => ledger.enableSchedule(sch.id)).toThrow(/cannot enable schedule in approval_state PENDING_APPROVAL/u);

    // Ticking does not fire
    const res = fireDueSchedules(ledger, { nowUtc: new Date("2026-10-16T11:00:00.000Z") });
    expect(res.dueCount).toBe(0);
    expect(res.firedCount).toBe(0);
  });

  // S10: Approve widening schedule then enable
  it("S10: operator approval enables schedule to fire under chat client's creator_client_id", () => {
    const ledger = createLedger(db);
    const sch = ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "chat-agent",
      cronExpr: "* * * * *",
      template: { objective: "approved task", trust_profile: "edit-untrusted", project: "proj-1" },
      approvalState: "PENDING_APPROVAL",
    });

    // Operator approves
    const approved = ledger.approveSchedule(sch.id);
    expect(approved?.approval_state).toBe("APPROVED");
    expect(approved?.enabled).toBe(0); // Off by default until explicit enable

    // Explicit enable
    ledger.enableSchedule(sch.id);

    // Tick fires
    const dueTime = new Date("2026-10-16T11:00:00.000Z");
    const res = fireDueSchedules(ledger, { nowUtc: dueTime });
    expect(res.firedCount).toBe(1);

    const itemId = res.workItemsEnqueued[0];
    expect(itemId).toBeDefined();
    const workItem = itemId ? ledger.getWorkItem(itemId) : undefined;
    expect(workItem?.creator_client_id).toBe("chat-agent");
    expect(workItem?.source_kind).toBe("schedule");
  });

  // S11: Admission ceiling on queue dequeue tick
  it("S11: enqueued schedule item dequeues and admits through creator client's ceiling (T15.1 integration)", async () => {
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "test.txt"), "hello\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "init");

    const project: ResolvedProject = {
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

    const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
    const workspace = new WorkspaceManager({
      db,
      artifacts,
      dataDir,
      allowedRoots: [root],
      ids: createIdGenerator(),
    });
    const registry = new AdapterRegistry().register(new FakeAdapter({ scenario: "success" }));
    const ledger = createLedger(db, { ids: createIdGenerator() });

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

    const mcpClients = new Map<string, ResolvedMcpClient>([
      ["client-low", { id: "client-low", maxTrustProfile: "inspect-untrusted", projects: ["app"] }],
      ["client-high", { id: "client-high", maxTrustProfile: "edit-untrusted", projects: ["app"] }],
    ]);

    const admissionDeps: AdmitWorkDeps = {
      lifecycle,
      ledger,
      registry,
      config: {
        allowedRoots: [root],
        mcpClients,
        projects: [project],
        dataDir,
        providers: new Map(),
        limits: { globalConcurrency: 4, perProviderConcurrency: 1 },
        capacity: { windowSeconds: 3600, confidenceRuns: 10, retry: { maxAttempts: 2, baseMs: 20, capMs: 100 } },
        routing: {},
      },
    } as unknown as AdmitWorkDeps;

    // Schedule 1: creator client-low requests edit-untrusted (above ceiling)
    ledger.createSchedule({
      projectId: "app",
      creatorClientId: "client-low",
      cronExpr: "* * * * *",
      template: { objective: "too high", trust_profile: "edit-untrusted", project: "app" },
      enabled: true,
    });

    // Schedule 2: creator client-high requests edit-untrusted (within ceiling)
    ledger.createSchedule({
      projectId: "app",
      creatorClientId: "client-high",
      cronExpr: "* * * * *",
      template: { objective: "allowed", trust_profile: "edit-untrusted", project: "app" },
      enabled: true,
    });

    const fireTime = new Date("2026-10-16T11:00:00.000Z");
    const fireRes = fireDueSchedules(ledger, { nowUtc: fireTime });
    expect(fireRes.firedCount).toBe(2);

    // Dequeue step
    const tickResult = await runProjectWorkQueueTick(ledger, admissionDeps, {
      maxItemsPerProject: 500,
      dequeueBatch: 2,
    });
    expect(tickResult.admitted).toBe(1);
    expect(tickResult.failed).toBe(1);

    const lowId = fireRes.workItemsEnqueued[0];
    const highId = fireRes.workItemsEnqueued[1];
    expect(lowId).toBeDefined();
    expect(highId).toBeDefined();
    const workLow = lowId ? ledger.getWorkItem(lowId) : undefined;
    const workHigh = highId ? ledger.getWorkItem(highId) : undefined;
    expect(workLow?.state).toBe("FAILED_ADMISSION");
    expect(workHigh?.state).toBe("ADMITTED");
    expect(workHigh?.admitted_run_id).toBeDefined();

    await lifecycle.shutdown();
  });

  // S12: UTC boundary
  it("S12: respects UTC boundary for midnight cron 0 0 * * *", () => {
    const ledger = createLedger(db);
    ledger.createSchedule({
      projectId: "proj-1",
      creatorClientId: "client-a",
      cronExpr: "0 0 * * *",
      template: { objective: "midnight UTC", trust_profile: "inspect-untrusted", project: "proj-1" },
      enabled: true,
    });

    // 23:59 UTC: does not fire
    const tBefore = new Date("2026-10-15T23:59:00.000Z");
    expect(fireDueSchedules(ledger, { nowUtc: tBefore }).firedCount).toBe(0);

    // 00:00 UTC: fires exactly once
    const tMidnight = new Date("2026-10-16T00:00:00.000Z");
    const res = fireDueSchedules(ledger, { nowUtc: tMidnight });
    expect(res.firedCount).toBe(1);

    // 00:01 UTC: does not fire
    const tAfter = new Date("2026-10-16T00:01:00.000Z");
    expect(fireDueSchedules(ledger, { nowUtc: tAfter }).firedCount).toBe(0);
  });

  // Pause check: paused projects skip firing
  it("skips firing when project or global admission is paused", () => {
    const ledger = createLedger(db);
    ledger.createSchedule({
      projectId: "proj-paused",
      creatorClientId: "client-a",
      cronExpr: "* * * * *",
      template: { objective: "paused task", trust_profile: "inspect-untrusted", project: "proj-paused" },
      enabled: true,
    });

    const now = new Date("2026-10-16T11:00:00.000Z");

    // When pause check returns true for project
    const resPaused = fireDueSchedules(ledger, {
      nowUtc: now,
      isPaused: (pid) => pid === "proj-paused",
    });
    expect(resPaused.dueCount).toBe(1);
    expect(resPaused.firedCount).toBe(0);
    expect(resPaused.skippedCount).toBe(1);

    // When not paused, fires
    const resUnpaused = fireDueSchedules(ledger, {
      nowUtc: now,
      isPaused: () => false,
    });
    expect(resUnpaused.firedCount).toBe(1);
  });
});
