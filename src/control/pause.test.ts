/**
 * Pause admission on the lifecycle (T14.6; FR-CTL-05, FR-SES-06, LLD §3.4.4, §3.4.7). The ROADMAP done-when at this
 * layer: a paused project admits nothing and its running runs finish. Also the persistence (migration 0018), the
 * `admissionPause` rule, successor refusals and the operator request / apply pair the CLI and `serve` share. Fake CLI
 * only; nothing live.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import {
  createLedger,
  LEDGER_FILE_NAME,
  type Ledger,
  MIGRATIONS,
  migrate,
  openLedger,
  type RunRecord,
  type TrustProfile,
} from "../ledger/index.js";
import { LifecycleError, RunLifecycle, type RunLifecycleOptions } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { needsAttentionOf } from "./needs-attention.js";
import {
  admissionPause,
  applyPauseRequests,
  GLOBAL_PAUSE_SCOPE,
  isAdmissionPaused,
  pauseRefusalDetails,
  pauseRefusalMessage,
  requestGlobalPause,
} from "./pause.js";

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
const PATIENT = { wallClockMs: 60_000, idleMs: 30_000, killGraceMs: 300 };
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** Modes by prompt: `slow` finishes after a delay; `throttled` is a retryable failure; `quota` enters the ladder. */
const CLI = `
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { prompt += c; });
  process.stdin.on("end", () => {
    const p = prompt.trim();
    emit({ type: "session", session_id: "s-1" });
    if (p === "throttled") {
      emit({ type: "error", category: "rate_limit", message: "slow down" });
      process.exitCode = 1;
      return;
    }
    if (p === "quota") {
      emit({ type: "error", category: "quota", message: "limit reached" });
      process.exitCode = 1;
      return;
    }
    if (p === "slow") {
      setTimeout(() => emit({ type: "result", ok: true, summary: "late but done" }), 700);
      return;
    }
    emit({ type: "result", ok: true, summary: "ok" });
  });
}
`;

let root: string;
let repo: string;
let dataDir: string;
let script: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

const PROJECT = {
  id: "web",
  name: "web",
  environment_kind: "host" as const,
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "edit-untrusted" as TrustProfile,
  writable: true,
  push: { policy: "none" as const },
};

function makeLifecycle(over: Partial<RunLifecycleOptions> = {}): RunLifecycle {
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  const l = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ script, timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    breaker: { failureThreshold: 50, openSeconds: 300 },
    retry: { maxAttempts: 5, baseMs: 20, capMs: 100 },
    random: () => 0,
    ...over,
  });
  l.start();
  lifecycle = l;
  return l;
}
const submit = (objective: string, extra: Record<string, unknown> = {}) =>
  (lifecycle as RunLifecycle).submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...extra,
  });
const inProject = (objective: string, extra: Record<string, unknown> = {}) =>
  submit(objective, { project: PROJECT, ...extra });
const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const runCount = () => (db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
};
const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"];
async function settled(sess: string): Promise<RunRecord[]> {
  const runs = () => ledger.listRunsForMetaSession(sess);
  await until(() => runs().every((r) => TERMINAL.includes(r.state)));
  await sleep(60);
  await until(() => runs().every((r) => TERMINAL.includes(r.state)));
  return runs();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-pause-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  script = path.join(root, "cli.mjs");
  writeFileSync(script, CLI);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("control_plane_state persistence (T14.6, LLD §3.4.7, migration 0018)", () => {
  it("0018 adds the pause table and the append-only operator signal table on a version 17 database", () => {
    const d = new Database(path.join(root, "fresh.sqlite"));
    try {
      d.pragma("foreign_keys = ON");
      const upTo17 = MIGRATIONS.filter((m) => m.version <= 17);
      expect(migrate(d, undefined, upTo17)).toEqual(upTo17.map((m) => m.version));
      expect(migrate(d, undefined, MIGRATIONS.filter((m) => m.version <= 18))).toEqual([18]);
      expect(() => d.prepare("INSERT INTO control_plane_state (project_id, paused) VALUES ('p', 2)").run()).toThrow(
        /CHECK/u,
      );
      d.prepare("INSERT INTO control_plane_state (project_id, paused, budget_flags_json) VALUES ('p', 1, '{}')").run();
      expect(() =>
        d.prepare("INSERT INTO control_plane_state (project_id, paused, budget_flags_json) VALUES ('q', 1, 'x')").run(),
      ).toThrow(/CHECK/u);
      d.prepare(
        "INSERT INTO control_plane_event (id, ts, type, scope, payload_json) VALUES ('cpe_1', 't', 'operator_pause_requested', '*', '{}')",
      ).run();
      expect(() => d.prepare("UPDATE control_plane_event SET scope = 'x'").run()).toThrow(/append-only/u);
      expect(() => d.prepare("DELETE FROM control_plane_event").run()).toThrow(/append-only/u);
      expect(() =>
        d
          .prepare(
            "INSERT INTO control_plane_event (id, ts, type, scope, payload_json) VALUES ('evt_1', 't', 'operator_pause_requested', '*', '{}')",
          )
          .run(),
      ).toThrow(/CHECK/u);
    } finally {
      d.close();
    }
  });

  it("setPaused upserts the row with who and when, keeps budget_flags_json, and is idempotent", () => {
    expect(ledger.getControlPlaneState("web")).toBeUndefined();
    const first = ledger.setPaused({ projectId: "web", paused: true, by: "mcp:orch" });
    expect(first).toMatchObject({ project_id: "web", paused: 1, paused_by: "mcp:orch", budget_flags_json: null });
    expect(first.paused_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    db.prepare("UPDATE control_plane_state SET budget_flags_json = '{\"k\":1}' WHERE project_id = 'web'").run();
    const again = ledger.setPaused({ projectId: "web", paused: true, by: "mcp:other" });
    expect(again).toMatchObject({ paused: 1, paused_by: "mcp:other", budget_flags_json: '{"k":1}' });
    const resumed = ledger.setPaused({ projectId: "web", paused: false, by: "mcp:orch" });
    expect(resumed).toMatchObject({ paused: 0, paused_by: "mcp:orch", budget_flags_json: '{"k":1}' });
  });

  it("admissionPause: the project's row or the global row holds; missing rows do not; a workspace-path run sees only the global row", () => {
    expect(admissionPause(ledger, "web")).toBeUndefined();
    expect(admissionPause(ledger, undefined)).toBeUndefined();
    ledger.setPaused({ projectId: "web", paused: true, by: "mcp:orch" });
    expect(admissionPause(ledger, "web")).toMatchObject({ scope: "project", project_id: "web", paused_by: "mcp:orch" });
    expect(admissionPause(ledger, "api")).toBeUndefined();
    expect(admissionPause(ledger, undefined)).toBeUndefined();
    ledger.setPaused({ projectId: GLOBAL_PAUSE_SCOPE, paused: true, by: "op" });
    expect(admissionPause(ledger, "api")).toMatchObject({ scope: "global", project_id: "*", paused_by: "op" });
    expect(admissionPause(ledger, undefined)).toMatchObject({ scope: "global" });
    // The project's own flag wins the explanation when both hold.
    expect(admissionPause(ledger, "web")?.scope).toBe("project");
    expect(isAdmissionPaused(ledger, "api")).toBe(true);
    ledger.setPaused({ projectId: GLOBAL_PAUSE_SCOPE, paused: false, by: "op" });
    expect(isAdmissionPaused(ledger, "api")).toBe(false);
    expect(isAdmissionPaused(ledger, "web")).toBe(true);
  });

  it("the refusal names its scope and never a provider, a run or agent text", () => {
    const project = { scope: "project" as const, project_id: "web", paused_by: "mcp:orch", paused_at: "t" };
    const global = { scope: "global" as const, project_id: "*", paused_by: "op", paused_at: "t" };
    expect(pauseRefusalDetails(project)).toEqual({ reason: "PROJECT_PAUSED", project_id: "web" });
    expect(pauseRefusalDetails(global)).toEqual({ reason: "GLOBAL_PAUSED" });
    expect(pauseRefusalMessage(project)).toContain("resume_project");
    expect(pauseRefusalMessage(global)).toContain("switchboard resume");
  });
});

describe("pause holds admission (T14.6, FR-CTL-05)", () => {
  it("a paused project admits nothing: delegate and continue are refused PAUSED with no run row; resume admits again", async () => {
    makeLifecycle();
    const first = await inProject("ok");
    const [done] = await settled(first.metaSessionId);
    expect(done?.state).toBe("SUCCEEDED");
    const before = runCount();

    ledger.setPaused({ projectId: "web", paused: true, by: "mcp:orch" });
    const refused = await inProject("ok").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LifecycleError);
    expect((refused as LifecycleError).code).toBe("PAUSED");
    expect((refused as LifecycleError).details).toEqual({ reason: "PROJECT_PAUSED", project_id: "web" });
    const continued = await inProject("ok", { metaSessionId: first.metaSessionId }).catch((e: unknown) => e);
    expect((continued as LifecycleError).code).toBe("PAUSED");
    expect(runCount()).toBe(before);
    // Another project and a workspace-path run (no project) are not held by a project pause.
    const other = await submit("ok", { project: { ...PROJECT, id: "api", name: "api" } });
    const bare = await submit("ok");
    await settled(other.metaSessionId);
    await settled(bare.metaSessionId);
    expect(runCount()).toBe(before + 2);

    ledger.setPaused({ projectId: "web", paused: false, by: "mcp:orch" });
    const after = await inProject("ok", { metaSessionId: first.metaSessionId });
    expect(after.state).toBe("QUEUED");
    const runs = await settled(first.metaSessionId);
    expect(runs.map((r) => r.state)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });

  it("the global pause holds every admission, including a workspace-path run, until resume", async () => {
    makeLifecycle();
    ledger.setPaused({ projectId: GLOBAL_PAUSE_SCOPE, paused: true, by: "op" });
    // One at a time: a second promise created before the first is awaited would reject with no handler attached.
    for (const attempt of [() => inProject("ok"), () => submit("ok")]) {
      const err = await attempt().catch((e: unknown) => e);
      expect((err as LifecycleError).code).toBe("PAUSED");
      expect((err as LifecycleError).details).toEqual({ reason: "GLOBAL_PAUSED" });
    }
    expect(runCount()).toBe(0);
    ledger.setPaused({ projectId: GLOBAL_PAUSE_SCOPE, paused: false, by: "op" });
    const r = await submit("ok");
    expect((await settled(r.metaSessionId))[0]?.state).toBe("SUCCEEDED");
  });

  it("running runs finish: a run RUNNING when its project is paused ends SUCCEEDED, is never cancelled, and no run gains a needs_attention reason", async () => {
    makeLifecycle();
    const running = await inProject("slow");
    await until(() => ledger.getRunRecord(running.runId)?.state === "RUNNING");
    ledger.setPaused({ projectId: "web", paused: true, by: "mcp:orch" });
    // While the run is still RUNNING under the pause: no pause-derived attention (FR-CTL-03 has no such reason).
    const live = ledger.getRunRecord(running.runId) as RunRecord;
    expect(live.state).toBe("RUNNING");
    expect(needsAttentionOf(ledger, live, { now: new Date() })).toEqual({ active: false });
    // A new admission into the paused project is refused while that run is still going.
    expect(((await inProject("ok").catch((e: unknown) => e)) as LifecycleError).code).toBe("PAUSED");

    const [finished] = await settled(running.metaSessionId);
    expect(finished?.state).toBe("SUCCEEDED");
    expect(finished?.id).toBe(running.runId);
    expect(events(running.runId).some((e) => e.type === "cancel_requested" || e.p.reason === "paused")).toBe(false);
    expect(ledger.listRunsForMetaSession(running.metaSessionId)).toHaveLength(1);
    // FR-SES-06 unchanged: still one non-terminal run per meta-session, and the pause does not add a state.
    expect(TERMINAL).toContain(finished?.state);
  });

  it("a retry successor is a new admission: refused while paused with retry_not_scheduled reason paused; the quota ladder returns the same", async () => {
    makeLifecycle();
    const throttled = await inProject("throttled");
    ledger.setPaused({ projectId: "web", paused: true, by: "mcp:orch" });
    const runs = await settled(throttled.metaSessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("FAILED");
    expect(events(throttled.runId).find((e) => e.type === "retry_not_scheduled")?.p).toEqual({
      reason: "paused",
      scope: "project",
    });

    ledger.setPaused({ projectId: "web", paused: false, by: "mcp:orch" });
    // Admitted first, then the operator pauses everything: the quota ladder admits no failover or wait successor.
    const quota = await inProject("quota");
    ledger.setPaused({ projectId: GLOBAL_PAUSE_SCOPE, paused: true, by: "op" });
    const ladder = await settled(quota.metaSessionId);
    expect(ladder).toHaveLength(1);
    expect(events(quota.runId).find((e) => e.type === "quota_ladder")?.p).toMatchObject({
      outcome: "returned",
      reason: "paused",
      scope: "global",
    });
  });
});

describe("operator pause requests (T14.6, the CLI and serve share them)", () => {
  it("direct: the request is applied in the same transaction and marked cli_direct", () => {
    const r = requestGlobalPause(ledger, { paused: true, requestedBy: "op", direct: true });
    expect(r).toMatchObject({ outcome: "applied", paused: true, requestedBy: "op" });
    expect(ledger.getControlPlaneState(GLOBAL_PAUSE_SCOPE)).toMatchObject({ paused: 1, paused_by: "op" });
    expect(ledger.listControlPlaneEvents(GLOBAL_PAUSE_SCOPE).map((e) => e.type)).toEqual([
      "operator_pause_requested",
      "operator_pause_applied",
    ]);
    expect(JSON.parse(ledger.listControlPlaneEvents(GLOBAL_PAUSE_SCOPE)[1]?.payload_json ?? "{}")).toEqual({
      request_event_id: r.requestEventId,
      paused: true,
      applied_by: "cli_direct",
    });
    expect(ledger.listPendingPauseRequests()).toEqual([]);
    expect(applyPauseRequests(ledger)).toEqual([]);
    const resumed = requestGlobalPause(ledger, { paused: false, requestedBy: "op2", direct: true });
    expect(resumed).toMatchObject({ outcome: "applied", paused: false });
    expect(ledger.getControlPlaneState(GLOBAL_PAUSE_SCOPE)).toMatchObject({ paused: 0, paused_by: "op2" });
  });

  it("under a daemon: only the request is recorded; the daemon applies each pending request once, oldest first", () => {
    const r = requestGlobalPause(ledger, { paused: true, requestedBy: "op", direct: false });
    expect(r).toMatchObject({ outcome: "requested", paused: false });
    expect(ledger.getControlPlaneState(GLOBAL_PAUSE_SCOPE)).toBeUndefined();
    expect(ledger.listPendingPauseRequests()).toMatchObject([{ requestEventId: r.requestEventId, paused: true }]);
    const r2 = requestGlobalPause(ledger, { paused: false, requestedBy: "op", direct: false });
    expect(applyPauseRequests(ledger)).toMatchObject([
      { requestEventId: r.requestEventId, scope: "*", paused: true, requestedBy: "op" },
      { requestEventId: r2.requestEventId, scope: "*", paused: false, requestedBy: "op" },
    ]);
    expect(ledger.getControlPlaneState(GLOBAL_PAUSE_SCOPE)).toMatchObject({ paused: 0, paused_by: "op" });
    expect(ledger.listPendingPauseRequests()).toEqual([]);
    expect(applyPauseRequests(ledger)).toEqual([]);
    expect(ledger.listControlPlaneEvents(GLOBAL_PAUSE_SCOPE).map((e) => e.type)).toEqual([
      "operator_pause_requested",
      "operator_resume_requested",
      "operator_pause_applied",
      "operator_pause_applied",
    ]);
  });

  it("a global pause recorded under a daemon holds admission once the daemon applies it, and not before", async () => {
    makeLifecycle();
    requestGlobalPause(ledger, { paused: true, requestedBy: "op", direct: false });
    const admitted = await submit("ok");
    await settled(admitted.metaSessionId);
    applyPauseRequests(ledger);
    expect(((await submit("ok").catch((e: unknown) => e)) as LifecycleError).details).toEqual({
      reason: "GLOBAL_PAUSED",
    });
  });

  it("the ledger file is the only state: a fresh handle on the same directory sees the pause", () => {
    requestGlobalPause(ledger, { paused: true, requestedBy: "op", direct: true });
    const other = new Database(path.join(dataDir, LEDGER_FILE_NAME), { readonly: true, fileMustExist: true });
    try {
      expect(other.prepare("SELECT paused FROM control_plane_state WHERE project_id = '*'").get()).toEqual({
        paused: 1,
      });
    } finally {
      other.close();
    }
  });
});
