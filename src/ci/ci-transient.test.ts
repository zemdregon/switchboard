/**
 * T15.6 CI transient handling (FR-QUE-06, LLD §20.1, ADR-0050 amendment 1): `CI_INFRA` classification, rerun once per
 * (ref, head SHA, job) through `gh run rerun --failed`, and the opt-in cancel of queued runs on superseded heads. Every
 * test uses a fake `CiStatusPort` and `CiActionsPort`, or a fake `GhRunner`; no real `gh` runs here or in CI.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CiTriggerProjectSettings, type CiTriggerSettings, loadConfig } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  G4_FIELDS,
  G6_FIELDS,
  G7_FIELDS,
  GhArgvError,
  ghRunCancelArgv,
  ghRunHeadArgv,
  ghRunJobsArgv,
  ghRunListQueuedArgv,
  ghRunRerunFailedArgv,
  isAllowedGhArgv,
  parseRunJobs,
  QUEUED_LIMIT,
} from "./gh-argv.js";
import { GhCiStatusPort, type GhRunner } from "./gh-port.js";
import {
  type CiActionsPort,
  type CiConclusion,
  type CiQueuedRun,
  type CiRunJob,
  type CiRunQuery,
  CiStatusError,
  type CiStatusObservation,
  type CiStatusPort,
  type CiStatusQuery,
  classifyConclusion,
} from "./port.js";
import { type CiTriggerDeps, getCiTriggerRefState, pollCiTriggers, RERUN_VISIBLE_MS } from "./trigger.js";

const SHA_OLD = "1".repeat(40);
const SHA_TIP = "2".repeat(40);
const SHA_FOREIGN = "f".repeat(40);
const REF = "refs/heads/sb/fix-1";
const BRANCH = "sb/fix-1";

class FakeCiStatusPort implements CiStatusPort {
  readonly calls: CiStatusQuery[] = [];
  answer: CiStatusObservation | null = null;

  async latestForPublishedRef(q: CiStatusQuery): Promise<CiStatusObservation | null> {
    this.calls.push(q);
    return this.answer;
  }
}

/** A fake CI host for the write side: per-run attempt and jobs, queued runs, re-read heads, and a call log. */
class FakeActions implements CiActionsPort {
  readonly calls: string[] = [];
  readonly runs = new Map<string, { attempt: number; jobs: CiRunJob[] }>();
  queued: CiQueuedRun[] = [];
  readonly heads = new Map<string, { status: string; headSha: string }>();
  rerunError: CiStatusError | undefined;
  cancelError: CiStatusError | undefined;

  async runJobs(q: CiRunQuery) {
    this.calls.push(`jobs ${q.runId}`);
    const r = this.runs.get(q.runId);
    if (r === undefined) throw new CiStatusError("GH_FAILED");
    return r;
  }
  async rerunFailed(q: CiRunQuery) {
    this.calls.push(`rerun ${q.runId}`);
    if (this.rerunError) throw this.rerunError;
  }
  async queuedRuns(q: { owner: string; repo: string; publishRef: string }) {
    this.calls.push(`queued ${q.publishRef}`);
    return this.queued;
  }
  async runHead(q: CiRunQuery) {
    this.calls.push(`head ${q.runId}`);
    const h = this.heads.get(q.runId);
    if (h === undefined) throw new CiStatusError("GH_FAILED");
    return h;
  }
  async cancelRun(q: CiRunQuery) {
    this.calls.push(`cancel ${q.runId}`);
    if (this.cancelError) throw this.cancelError;
  }
  writes(): string[] {
    return this.calls.filter((c) => c.startsWith("rerun") || c.startsWith("cancel"));
  }
}

const obs = (externalId: string, conclusion: CiConclusion, headSha = SHA_TIP): CiStatusObservation => ({
  externalId,
  conclusion,
  publishRef: REF,
  headSha,
});
const job = (name: string, conclusion: string): CiRunJob => ({ name, status: "completed", conclusion });

const trigger = (over: Partial<CiTriggerProjectSettings> = {}): CiTriggerProjectSettings => ({
  projectId: "app",
  creatorClientId: "orch",
  enabled: true,
  maxConsecutiveFixes: 2,
  template: { objective: "Fix CI on {{ci_publish_ref}}", trustProfile: "edit-untrusted", constraints: [] },
  ...over,
});

const settings = (t: Partial<CiTriggerProjectSettings> = {}): CiTriggerSettings => ({
  enabled: true,
  pollIntervalSeconds: 120,
  ghBinary: "gh",
  useCheckRunsFallback: false,
  maxConsecutiveFixes: t.maxConsecutiveFixes ?? 2,
  projects: [trigger(t)],
});

interface Fixture {
  root: string;
  db: ReturnType<typeof openLedger>;
  ledger: Ledger;
  close(): void;
}

function openFixture(): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-ci-t156-")));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const db = openLedger(dataDir);
  const ledger = createLedger(db, { ids: createIdGenerator() });
  return {
    root,
    db,
    ledger,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let pushSeq = 0;
/** An accepted `git_push` row (LLD §12.3); later calls are later pushes, so the last one is the ref's tip. */
function recordPush(f: Fixture, sha: string): void {
  pushSeq++;
  const mm = String(Math.floor(pushSeq / 60) % 60).padStart(2, "0");
  const ss = String(pushSeq % 60).padStart(2, "0");
  f.db
    .prepare(
      `INSERT INTO git_push (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail, requested_by,
         created_at) VALUES (?, NULL, 'app', 'main', 'origin', ?, ?, 'ACCEPTED', NULL, 'agent_tool', ?)`,
    )
    .run(`gps_t156_${String(pushSeq).padStart(22, "0")}`, REF, sha, `2026-10-19T00:${mm}:${ss}.000Z`);
}

let clock = Date.parse("2026-10-19T12:00:00.000Z");
const deps = (f: Fixture, port: CiStatusPort, actions: CiActionsPort | undefined, s: CiTriggerSettings) =>
  ({
    db: f.db,
    ledger: f.ledger,
    port,
    ...(actions ? { actions } : {}),
    settings: s,
    resolveRemote: async () => ({ owner: "acme", repo: "app" }),
    nowMs: () => clock,
  }) satisfies CiTriggerDeps;

const ciItems = (f: Fixture) =>
  f.db.prepare("SELECT source_id FROM project_work_item WHERE source_kind = 'ci_trigger' ORDER BY created_at").all();
const reruns = (f: Fixture) =>
  f.db.prepare("SELECT job_name, run_id, attempt, outcome, head_sha FROM ci_rerun ORDER BY job_name").all();

describe("CI_INFRA classification (T15.6, FR-QUE-06)", () => {
  let f: Fixture;
  afterEach(() => f?.close());

  it("maps cancelled and timed_out to CI_INFRA, failure to failure, and nothing else to either", () => {
    expect(classifyConclusion("cancelled")).toBe("CI_INFRA");
    expect(classifyConclusion("timed_out")).toBe("CI_INFRA");
    expect(classifyConclusion("failure")).toBe("failure");
    expect(classifyConclusion("success")).toBe("success");
    for (const c of ["skipped", "neutral", "pending"] as const) expect(classifyConclusion(c)).toBe("other");
  });

  it("with both switches off a CI_INFRA run is recorded once, admits nothing and makes no actions call", async () => {
    f = openFixture();
    recordPush(f, SHA_TIP);
    const port = new FakeCiStatusPort();
    const actions = new FakeActions();
    const d = deps(f, port, actions, settings());
    port.answer = obs("501", "cancelled");
    const r = await pollCiTriggers(d);
    expect(r.infra).toEqual([{ projectId: "app", publishRef: REF, externalId: "501" }]);
    expect(r.enqueued).toEqual([]);
    expect(ciItems(f)).toEqual([]);
    expect(getCiTriggerRefState(f.db, "app", REF)).toBeUndefined();
    expect((await pollCiTriggers(d)).duplicates).toBe(1);
    // A real failure still enqueues exactly as before, through the same single port call per ref.
    port.answer = obs("502", "failure");
    expect((await pollCiTriggers(d)).enqueued).toHaveLength(1);
    expect(port.calls).toHaveLength(3);
    expect(actions.calls).toEqual([]);
  });

  it("CI_INFRA never counts toward the FR-QUE-05 cap and never sets the stuck flag", async () => {
    f = openFixture();
    const port = new FakeCiStatusPort();
    const d = deps(f, port, undefined, settings({ maxConsecutiveFixes: 1 }));
    recordPush(f, SHA_OLD);
    port.answer = obs("601", "failure", SHA_OLD);
    expect((await pollCiTriggers(d)).enqueued).toHaveLength(1);
    expect(getCiTriggerRefState(f.db, "app", REF)?.consecutiveFixes).toBe(1);
    recordPush(f, SHA_TIP);
    for (const [id, c] of [
      ["602", "cancelled"],
      ["603", "timed_out"],
    ] as const) {
      port.answer = obs(id, c);
      const r = await pollCiTriggers(d);
      expect(r.infra).toHaveLength(1);
      expect(r.recordedOnly).toEqual([]);
    }
    expect(getCiTriggerRefState(f.db, "app", REF)).toMatchObject({ consecutiveFixes: 1, stuck: false });
  });
});

describe("rerun failed jobs once per (ref, head SHA, job) (T15.6)", () => {
  let f: Fixture;
  afterEach(() => f?.close());

  const setup = (over: Partial<CiTriggerProjectSettings> = {}) => {
    f = openFixture();
    recordPush(f, SHA_TIP);
    const port = new FakeCiStatusPort();
    const actions = new FakeActions();
    return { port, actions, d: deps(f, port, actions, settings({ rerunFailed: true, ...over })) };
  };

  it("cancelled → one rerun, no fix-up; rerun red → one fix-up; a second red on the same SHA → no second rerun", async () => {
    const { port, actions, d } = setup();
    port.answer = obs("701", "cancelled");
    actions.runs.set("701", { attempt: 1, jobs: [job("linux", "cancelled"), job("lint", "success")] });
    const r1 = await pollCiTriggers(d);
    expect(r1.reruns).toEqual([
      { projectId: "app", publishRef: REF, headSha: SHA_TIP, runId: "701", jobNames: ["linux"] },
    ]);
    expect(r1.enqueued).toEqual([]);
    expect(r1.infra).toEqual([]);
    expect(reruns(f)).toEqual([
      { job_name: "linux", run_id: "701", attempt: 1, outcome: "requested", head_sha: SHA_TIP },
    ]);

    // The rerun is running: the port sees no terminal run.
    port.answer = null;
    expect((await pollCiTriggers(d)).enqueued).toEqual([]);

    // Attempt 2 is red: one fix-up, no further rerun.
    port.answer = obs("701", "failure");
    actions.runs.set("701", { attempt: 2, jobs: [job("linux", "failure"), job("lint", "success")] });
    const r3 = await pollCiTriggers(d);
    expect(r3.enqueued).toHaveLength(1);
    expect(r3.reruns).toEqual([]);
    expect(getCiTriggerRefState(f.db, "app", REF)?.consecutiveFixes).toBe(1);
    expect((await pollCiTriggers(d)).duplicates).toBe(1);

    // A new run on the same SHA fails the same job: the key is spent, so no second rerun; a fix-up instead.
    port.answer = obs("702", "failure");
    actions.runs.set("702", { attempt: 1, jobs: [job("linux", "failure")] });
    const r5 = await pollCiTriggers(d);
    expect(r5.reruns).toEqual([]);
    expect(r5.enqueued).toHaveLength(1);
    expect(actions.writes()).toEqual(["rerun 701"]);
    expect(ciItems(f)).toEqual([{ source_id: "ci:701" }, { source_id: "ci:702" }]);
  });

  it("a failure is rerun first; a green rerun admits nothing and resets the counter", async () => {
    const { port, actions, d } = setup();
    port.answer = obs("711", "failure");
    actions.runs.set("711", { attempt: 1, jobs: [job("test (ubuntu)", "failure"), job("test (macos)", "failure")] });
    expect((await pollCiTriggers(d)).reruns[0]?.jobNames).toEqual(["test (macos)", "test (ubuntu)"]);
    port.answer = obs("711", "success");
    const r = await pollCiTriggers(d);
    expect(r.enqueued).toEqual([]);
    expect(getCiTriggerRefState(f.db, "app", REF)?.consecutiveFixes).toBe(0);
    expect(ciItems(f)).toEqual([]);
  });

  it("a rerun that is CI_INFRA again is recorded only: no second rerun and no fix-up", async () => {
    const { port, actions, d } = setup();
    port.answer = obs("721", "timed_out");
    actions.runs.set("721", { attempt: 1, jobs: [job("linux", "timed_out")] });
    await pollCiTriggers(d);
    actions.runs.set("721", { attempt: 2, jobs: [job("linux", "cancelled")] });
    port.answer = obs("721", "cancelled");
    const r = await pollCiTriggers(d);
    expect(r.infra).toHaveLength(1);
    expect(r.enqueued).toEqual([]);
    expect(actions.writes()).toEqual(["rerun 721"]);
  });

  it("waits while the requested attempt is not visible yet, then stops waiting after RERUN_VISIBLE_MS", async () => {
    const { port, actions, d } = setup();
    port.answer = obs("731", "failure");
    actions.runs.set("731", { attempt: 1, jobs: [job("linux", "failure")] });
    await pollCiTriggers(d);
    // gh still reports attempt 1 as completed (eventual consistency): neither a fix-up nor a second rerun.
    const r = await pollCiTriggers(d);
    expect(r.enqueued).toEqual([]);
    expect(r.reruns).toEqual([]);
    clock += RERUN_VISIBLE_MS;
    const late = await pollCiTriggers(d);
    expect(late.enqueued).toHaveLength(1);
    expect(actions.writes()).toEqual(["rerun 731"]);
  });

  it("allowlist refusal: no rerun for a job conclusion outside failure, cancelled and timed_out", async () => {
    const { port, actions, d } = setup();
    port.answer = obs("741", "failure");
    actions.runs.set("741", {
      attempt: 1,
      jobs: [
        job("a", "startup_failure"),
        job("b", "action_required"),
        job("c", "neutral"),
        job("d", "skipped"),
        { name: "e", status: "in_progress", conclusion: "" },
      ],
    });
    const r = await pollCiTriggers(d);
    expect(r.reruns).toEqual([]);
    expect(r.enqueued).toHaveLength(1);
    expect(actions.writes()).toEqual([]);
  });

  it("refuses the whole rerun when any failed job was already rerun on this head (fail closed)", async () => {
    const { port, actions, d } = setup();
    port.answer = obs("751", "failure");
    actions.runs.set("751", { attempt: 1, jobs: [job("a", "failure")] });
    await pollCiTriggers(d);
    port.answer = obs("752", "failure");
    actions.runs.set("752", { attempt: 1, jobs: [job("a", "failure"), job("b", "failure")] });
    const r = await pollCiTriggers(d);
    expect(r.reruns).toEqual([]);
    expect(r.enqueued).toHaveLength(1);
    expect(actions.writes()).toEqual(["rerun 751"]);
  });

  it("a gh rerun error spends the key, records the reason and falls through to one fix-up", async () => {
    const { port, actions, d } = setup();
    actions.rerunError = new CiStatusError("AUTH_REQUIRED");
    port.answer = obs("761", "failure");
    actions.runs.set("761", { attempt: 1, jobs: [job("linux", "failure")] });
    const r = await pollCiTriggers(d);
    expect(r.errors).toEqual([{ projectId: "app", publishRef: REF, reason: "AUTH_REQUIRED" }]);
    expect(r.enqueued).toHaveLength(1);
    expect(reruns(f)).toMatchObject([{ job_name: "linux", outcome: "gh_failed" }]);
    actions.rerunError = undefined;
    port.answer = obs("762", "failure");
    actions.runs.set("762", { attempt: 1, jobs: [job("linux", "failure")] });
    expect((await pollCiTriggers(d)).reruns).toEqual([]);
    expect(actions.writes()).toEqual(["rerun 761"]);
  });

  it("an unreadable job list never reruns and never admits; the next poll retries", async () => {
    const { port, actions, d } = setup();
    port.answer = obs("771", "failure");
    const r = await pollCiTriggers(d);
    expect(r.errors).toEqual([{ projectId: "app", publishRef: REF, reason: "GH_FAILED" }]);
    expect(r.enqueued).toEqual([]);
    actions.runs.set("771", { attempt: 1, jobs: [job("linux", "failure")] });
    expect((await pollCiTriggers(d)).reruns).toHaveLength(1);
  });

  it("the once-per-key rows survive a restart (a reopened ledger refuses a second rerun)", async () => {
    const { port, actions, d } = setup();
    port.answer = obs("781", "failure");
    actions.runs.set("781", { attempt: 1, jobs: [job("linux", "failure")] });
    await pollCiTriggers(d);
    f.db.close();
    const db = openLedger(path.join(f.root, "data"));
    const ledger = createLedger(db, { ids: createIdGenerator() });
    const root = f.root;
    f = {
      root,
      db,
      ledger,
      close: () => {
        db.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
    port.answer = obs("782", "failure");
    actions.runs.set("782", { attempt: 1, jobs: [job("linux", "failure")] });
    const r = await pollCiTriggers(deps(f, port, actions, settings({ rerunFailed: true })));
    expect(r.reruns).toEqual([]);
    expect(r.enqueued).toHaveLength(1);
  });
});

describe("cancel queued runs on superseded heads (T15.6)", () => {
  let f: Fixture;
  afterEach(() => f?.close());

  const queued = (runId: string, headSha: string, status = "queued"): CiQueuedRun => ({
    runId,
    status,
    headSha,
    headBranch: BRANCH,
  });

  it("cancels only queued runs on an earlier Switchboard head; in-progress runs are never cancelled", async () => {
    f = openFixture();
    recordPush(f, SHA_OLD);
    recordPush(f, SHA_TIP);
    const port = new FakeCiStatusPort();
    const actions = new FakeActions();
    actions.queued = [
      queued("801", SHA_OLD),
      queued("802", SHA_OLD, "in_progress"),
      queued("803", SHA_TIP),
      queued("804", SHA_FOREIGN),
      queued("805", SHA_OLD),
      { ...queued("806", SHA_OLD), headBranch: "other" },
    ];
    actions.heads.set("801", { status: "queued", headSha: SHA_OLD });
    actions.heads.set("802", { status: "in_progress", headSha: SHA_OLD });
    // 805 started between the list and the re-read: it is in progress now and must not be cancelled.
    actions.heads.set("805", { status: "in_progress", headSha: SHA_OLD });
    const d = deps(f, port, actions, settings({ cancelStaleQueued: true }));
    const r = await pollCiTriggers(d);
    expect(r.cancelled).toEqual([{ projectId: "app", publishRef: REF, headSha: SHA_OLD, runId: "801" }]);
    expect(actions.writes()).toEqual(["cancel 801"]);
    expect(actions.calls.filter((c) => c.startsWith("head"))).toEqual(["head 801", "head 805"]);
    expect(f.db.prepare("SELECT run_id, head_sha, outcome FROM ci_run_cancel").all()).toEqual([
      { run_id: "801", head_sha: SHA_OLD, outcome: "cancelled" },
    ]);
    // A later poll that still lists 801 never cancels it twice.
    const again = await pollCiTriggers(d);
    expect(again.cancelled).toEqual([]);
    expect(actions.writes()).toEqual(["cancel 801"]);
  });

  it("a ref with one published head lists nothing; a cancel error is recorded and never retried", async () => {
    f = openFixture();
    recordPush(f, SHA_TIP);
    const port = new FakeCiStatusPort();
    const actions = new FakeActions();
    const d = deps(f, port, actions, settings({ cancelStaleQueued: true }));
    await pollCiTriggers(d);
    expect(actions.calls).toEqual([]);
    recordPush(f, SHA_OLD);
    recordPush(f, SHA_TIP);
    actions.queued = [queued("811", SHA_OLD)];
    actions.heads.set("811", { status: "queued", headSha: SHA_OLD });
    actions.cancelError = new CiStatusError("GH_FAILED");
    const r = await pollCiTriggers(d);
    expect(r.cancelled).toEqual([]);
    expect(r.errors).toEqual([{ projectId: "app", publishRef: REF, reason: "GH_FAILED" }]);
    await pollCiTriggers(d);
    expect(actions.writes()).toEqual(["cancel 811"]);
  });

  it("with the switch off no queued run is listed or cancelled", async () => {
    f = openFixture();
    recordPush(f, SHA_OLD);
    recordPush(f, SHA_TIP);
    const actions = new FakeActions();
    actions.queued = [queued("821", SHA_OLD)];
    await pollCiTriggers(deps(f, new FakeCiStatusPort(), actions, settings()));
    expect(actions.calls).toEqual([]);
  });
});

describe("GhCiStatusPort write side over a fake gh runner (T15.6, ADR-0050 amendment 1)", () => {
  const fakeGh = (outputs: Record<string, string>) => {
    const calls: (readonly string[])[] = [];
    const runner: GhRunner = async (_binary, argv) => {
      calls.push(argv);
      const out = outputs[`${argv[0]} ${argv[1]} ${argv[argv.length - 1]}`] ?? outputs[`${argv[0]} ${argv[1]}`];
      return out === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: out };
    };
    return { calls, runner };
  };
  const q = { owner: "acme", repo: "app", runId: "42" };

  it("builds G4 to G8 exactly and the audit admits them", async () => {
    const { calls, runner } = fakeGh({
      [`run view ${G4_FIELDS}`]: JSON.stringify({
        attempt: 2,
        jobs: [{ name: "linux", status: "completed", conclusion: "failure", url: "https://x", steps: [{ name: "s" }] }],
      }),
      "run rerun": "",
      "run list": JSON.stringify([
        { databaseId: 7, conclusion: null, status: "queued", headBranch: BRANCH, headSha: SHA_OLD.toUpperCase() },
      ]),
      [`run view ${G7_FIELDS}`]: JSON.stringify({ databaseId: 42, status: "queued", headSha: SHA_OLD }),
      "run cancel": "",
    });
    const port = new GhCiStatusPort({ runner, sourceEnv: {} });
    expect(await port.runJobs(q)).toEqual({
      attempt: 2,
      jobs: [{ name: "linux", status: "completed", conclusion: "failure" }],
    });
    await port.rerunFailed(q);
    expect(await port.queuedRuns({ owner: "acme", repo: "app", publishRef: REF })).toEqual([
      { runId: "7", status: "queued", headSha: SHA_OLD, headBranch: BRANCH },
    ]);
    expect(await port.runHead(q)).toEqual({ status: "queued", headSha: SHA_OLD });
    await port.cancelRun(q);
    expect(calls).toEqual([
      ["run", "view", "42", "--repo", "acme/app", "--json", G4_FIELDS],
      ["run", "rerun", "42", "--failed", "--repo", "acme/app"],
      [
        "run",
        "list",
        "--repo",
        "acme/app",
        "--branch",
        BRANCH,
        "--status",
        "queued",
        "--limit",
        QUEUED_LIMIT,
        "--json",
        G6_FIELDS,
      ],
      ["run", "view", "42", "--repo", "acme/app", "--json", G7_FIELDS],
      ["run", "cancel", "42", "--repo", "acme/app"],
    ]);
    for (const argv of calls) expect(isAllowedGhArgv(argv), argv.join(" ")).toBe(true);
  });

  it("the argv allowlist still refuses every other gh verb and every variant of the two write verbs", () => {
    for (const argv of [
      ["run", "rerun", "42", "--repo", "acme/app"],
      ["run", "rerun", "42", "--failed", "--debug", "--repo", "acme/app"],
      ["run", "rerun", "42", "--job", "9", "--repo", "acme/app"],
      ["run", "rerun", "42", "--failed", "--repo", "acme/app;id"],
      ["run", "cancel", "42", "--force", "--repo", "acme/app"],
      ["run", "cancel", "-1", "--repo", "acme/app"],
      ["run", "delete", "42", "--repo", "acme/app"],
      ["run", "watch", "42", "--repo", "acme/app"],
      ["run", "view", "42", "--repo", "acme/app", "--json", "jobs,displayTitle"],
      ["run", "view", "42", "--repo", "acme/app", "--log-failed"],
      [
        "run",
        "list",
        "--repo",
        "acme/app",
        "--branch",
        BRANCH,
        "--status",
        "in_progress",
        "--limit",
        QUEUED_LIMIT,
        "--json",
        G6_FIELDS,
      ],
      [
        "run",
        "list",
        "--repo",
        "acme/app",
        "--branch",
        BRANCH,
        "--status",
        "queued",
        "--limit",
        "1000",
        "--json",
        G6_FIELDS,
      ],
      ["workflow", "run", "ci.yml", "--repo", "acme/app"],
      ["pr", "merge", "1", "--squash"],
      ["pr", "view", "1", "--json", "number"],
      ["api", "-X", "POST", "repos/acme/app/actions/runs/42/rerun-failed-jobs"],
      ["auth", "token"],
    ]) {
      expect(isAllowedGhArgv(argv), argv.join(" ")).toBe(false);
    }
    for (const build of [ghRunJobsArgv, ghRunRerunFailedArgv, ghRunHeadArgv, ghRunCancelArgv]) {
      expect(() => build("acme", "app", "42 --force")).toThrow(GhArgvError);
      expect(() => build("acme", "app", "0")).toThrow(GhArgvError);
      expect(() => build("ac/me", "app", "42")).toThrow(GhArgvError);
    }
    expect(() => ghRunListQueuedArgv("acme", "app", "--status=in_progress")).toThrow(GhArgvError);
  });

  it("job JSON keeps only name, status and conclusion and refuses unsafe job names", () => {
    expect(() => parseRunJobs(JSON.stringify({ attempt: 0, jobs: [] }))).toThrow();
    expect(() =>
      parseRunJobs(
        JSON.stringify({ attempt: 1, jobs: [{ name: "a\nb", status: "completed", conclusion: "failure" }] }),
      ),
    ).toThrow();
    expect(() =>
      parseRunJobs(
        JSON.stringify({ attempt: 1, jobs: [{ name: "x".repeat(201), status: "completed", conclusion: "failure" }] }),
      ),
    ).toThrow();
    expect(() =>
      parseRunJobs(JSON.stringify({ attempt: 1, jobs: [{ status: "completed", conclusion: "failure" }] })),
    ).toThrow();
  });

  it("a malformed job list from gh is PARSE_FAILED, without gh output in the message", async () => {
    const { runner } = fakeGh({ [`run view ${G4_FIELDS}`]: '{"attempt":1,"jobs":[{"name":"ghp_secret\\u0007"}]}' });
    const err = await new GhCiStatusPort({ runner, sourceEnv: {} }).runJobs(q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiStatusError);
    expect((err as CiStatusError).reason).toBe("PARSE_FAILED");
    expect((err as Error).message).not.toContain("ghp_");
  });
});

describe("ci_trigger T15.6 switches (configuration)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const load = (project: Record<string, unknown>) => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-ci-t156-cfg-")));
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const file = path.join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        data_dir: path.join(dir, "data"),
        allowed_roots: [dir],
        mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted", projects: ["app"] }],
        projects: [
          { id: "app", name: "App", contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main" }] },
        ],
        ci_trigger: {
          enabled: true,
          projects: [
            {
              project: "app",
              client: "orch",
              template: { objective: "Fix", trust_profile: "edit-untrusted" },
              ...project,
            },
          ],
        },
      }),
    );
    return loadConfig({ configPath: file, env: {} });
  };

  it("both switches are off by default and resolve when set", () => {
    expect(load({}).ciTrigger.projects[0]).toMatchObject({ rerunFailed: false, cancelStaleQueued: false });
    expect(load({ rerun_failed: true, cancel_stale_queued: true }).ciTrigger.projects[0]).toMatchObject({
      rerunFailed: true,
      cancelStaleQueued: true,
    });
    expect(() => load({ rerun_failed: "yes" })).toThrow();
  });
});
