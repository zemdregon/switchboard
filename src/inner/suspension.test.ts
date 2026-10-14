/**
 * T11.6 (FR-INN-09, LLD §13.3, §13.4 steps 1 and 11, §13.7, §13.8): quality monitoring and automatic suspension. The
 * rejection rate over the configured window, computed from `inner_call` rows, suspends a task once the minimum sample
 * exists; the task then returns `fallback_suspended` until the operator re-enables it; the state is per task and lives in
 * the ledger. Scripted fake backend only; no network, no provider CLI.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { createFakeBackend, createInnerAgent, type InnerAgentService, type InnerTaskContract } from "./index.js";

const GOOD = { kind: "text", text: '{"title":"Fix login"}' } as const;
const BAD = { kind: "text", text: "this is not json" } as const;

const contract = (
  task: "run_title" | "commit_message" = "run_title",
): InnerTaskContract<{ title: string }, string> => ({
  task,
  template_version: `${task}.v1`,
  system: "Write a title.",
  response_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  },
  sends_source_content: false,
  fallback: () => "fallback",
  accept: (v) => v as { title: string },
});

const dirs: string[] = [];
const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Setup {
  dir: string;
  runId: string;
  open(): {
    svc: InnerAgentService;
    ledger: ReturnType<typeof createLedger>;
    backend: ReturnType<typeof createFakeBackend>;
  };
}

function setup(suspension: { window_calls: number; min_calls: number; rejection_threshold: number }): Setup {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-susp-"));
  dirs.push(dir);
  let opened = 0;
  const tick = () => {
    clock += 1;
    return clock;
  };
  let clock = Date.parse("2026-10-13T00:00:00.000Z");
  const first = openLedger(dir);
  dbs.push(first);
  const seed = createLedger(first, { ids: createIdGenerator() });
  const session = seed.createMetaSession({ objective: "o" });
  const run = seed.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
  const settings = resolveInnerAgent({
    enabled: true,
    backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "m", timeout_ms: 2000 },
    tasks: { run_title: { enabled: true }, commit_message: { enabled: true } },
    suspension,
  });
  return {
    dir,
    runId: run.id,
    // `open` can be called again on the same directory to model a restart: a fresh database handle, ledger and service.
    open() {
      const db = opened++ === 0 ? first : openLedger(dir);
      if (db !== first) dbs.push(db);
      // every ledger write advances the injected clock by 1 ms so "since resumed_at" is unambiguous
      const ledger = createLedger(db, { ids: createIdGenerator(), now: () => new Date(tick()) });
      const backend = createFakeBackend({ script: [GOOD] });
      return { svc: createInnerAgent(settings, { backend, ledger }), ledger, backend };
    },
  };
}

const outcomes = (l: ReturnType<typeof createLedger>, task = "run_title") =>
  l
    .listInnerCalls()
    .filter((r) => r.task === task)
    .map((r) => r.outcome);

describe("T11.6 quality monitoring and suspension", () => {
  it("does not suspend below the minimum sample, however bad the calls are", async () => {
    const s = setup({ window_calls: 10, min_calls: 5, rejection_threshold: 0.4 });
    const { svc, ledger, backend } = s.open();
    backend.setScript([BAD]);
    for (let i = 0; i < 4; i++) await svc.call(contract(), { user: "x", run_id: s.runId });
    expect(outcomes(ledger)).toEqual(Array(4).fill("rejected_validator"));
    expect(svc.isSuspended("run_title")).toBe(false);
    expect(ledger.getInnerTaskState("run_title")).toBeUndefined();
    expect(ledger.listRunEvents(s.runId).filter((e) => e.type === "inner_task_suspended")).toEqual([]);
  });

  it("suspends when the rate exceeds the threshold over the window, then falls back without calling the backend", async () => {
    const s = setup({ window_calls: 10, min_calls: 5, rejection_threshold: 0.4 });
    const { svc, ledger, backend } = s.open();
    backend.setScript([GOOD]);
    for (let i = 0; i < 3; i++) await svc.call(contract(), { user: "x", run_id: s.runId }); // 3 accepted
    backend.setScript([BAD]);
    await svc.call(contract(), { user: "x", run_id: s.runId }); // 1/4 rejected
    await svc.call(contract(), { user: "x", run_id: s.runId }); // 2/5 = 0.4: at the threshold, not above it
    expect(svc.isSuspended("run_title")).toBe(false);
    const r = await svc.call(contract(), { user: "x", run_id: s.runId }); // 3/6 = 0.5 > 0.4
    expect(r.accepted).toBe(false);
    expect(svc.isSuspended("run_title")).toBe(true);

    const state = ledger.getInnerTaskState("run_title");
    expect(state).toMatchObject({ task: "run_title", suspended: true, version: 1, resumed_at: null });
    expect(state?.suspended_basis).toEqual({ window_calls: 10, rejected: 3, total: 6, threshold: 0.4 });

    const ev = ledger.listRunEvents(s.runId).filter((e) => e.type === "inner_task_suspended");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]?.payload_json ?? "{}")).toEqual({
      task: "run_title",
      window_calls: 10,
      rejected: 3,
      total: 6,
      threshold: 0.4,
    });

    // suspended: fallback, no backend request, a fallback_suspended row, no bytes of input touched
    const before = backend.requests.length;
    const again = await svc.call(contract(), { user: "SECRET-INPUT", run_id: s.runId });
    expect(again).toMatchObject({
      accepted: false,
      fallback: "fallback",
      outcome: "fallback_suspended",
      reason: "TASK_SUSPENDED",
    });
    expect(backend.requests.length).toBe(before);
    const last = ledger.listInnerCalls().at(-1);
    expect(last).toMatchObject({ outcome: "fallback_suspended", attempts: 0, latency_ms: 0, reason: "TASK_SUSPENDED" });
    // a fallback is not quality evidence and does not re-suspend or add a second event
    expect(ledger.listRunEvents(s.runId).filter((e) => e.type === "inner_task_suspended")).toHaveLength(1);
    expect(ledger.getInnerTaskState("run_title")?.version).toBe(1);
  });

  it("counts only the last window_calls quality calls: old rejections roll out", async () => {
    const s = setup({ window_calls: 5, min_calls: 5, rejection_threshold: 0.4 });
    const { svc, ledger, backend } = s.open();
    backend.setScript([BAD]);
    await svc.call(contract(), { user: "x" }); // 1 rejected
    await svc.call(contract(), { user: "x" }); // 2 rejected
    backend.setScript([GOOD]);
    for (let i = 0; i < 5; i++) await svc.call(contract(), { user: "x" });
    // at call 5 the window held 2 rejected of 5 = 0.4 (not above); afterwards the rejections rolled out
    expect(svc.isSuspended("run_title")).toBe(false);
    expect(outcomes(ledger).filter((o) => o === "accepted")).toHaveLength(5);
  });

  it("does not count fallback outcomes (gates, unavailable) as quality evidence", async () => {
    const s = setup({ window_calls: 10, min_calls: 3, rejection_threshold: 0.4 });
    const { svc, ledger, backend } = s.open();
    backend.setScript([{ kind: "error" }]);
    for (let i = 0; i < 2; i++) await svc.call(contract(), { user: "x" }); // fallback_unavailable (transport)
    for (let i = 0; i < 4; i++) await svc.call(contract(), { user: "x", project_setting: "off" }); // fallback_disabled
    expect(new Set(outcomes(ledger))).toEqual(new Set(["fallback_unavailable", "fallback_disabled"]));
    expect(svc.isSuspended("run_title")).toBe(false);
    backend.setScript([GOOD]);
    await svc.call(contract(), { user: "x" });
    expect(svc.isSuspended("run_title")).toBe(false);
  });

  it("is per task: suspending one task leaves the others calling the backend", async () => {
    const s = setup({ window_calls: 4, min_calls: 4, rejection_threshold: 0.5 });
    const { svc, ledger, backend } = s.open();
    backend.setScript([BAD]);
    for (let i = 0; i < 4; i++) await svc.call(contract("run_title"), { user: "x" });
    expect(svc.isSuspended("run_title")).toBe(true);
    expect(svc.isSuspended("commit_message")).toBe(false);
    backend.setScript([GOOD]);
    const other = await svc.call(contract("commit_message"), { user: "x" });
    expect(other.accepted).toBe(true);
    expect(ledger.listInnerTaskStates().map((r) => r.task)).toEqual(["run_title"]);
  });

  it("survives a restart: a new database handle, ledger and service still see the suspension", async () => {
    const s = setup({ window_calls: 4, min_calls: 4, rejection_threshold: 0.5 });
    const a = s.open();
    a.backend.setScript([BAD]);
    for (let i = 0; i < 4; i++) await a.svc.call(contract(), { user: "x", run_id: s.runId });
    expect(a.svc.isSuspended("run_title")).toBe(true);

    const b = s.open();
    expect(b.svc.isSuspended("run_title")).toBe(true);
    b.backend.setScript([GOOD]);
    const r = await b.svc.call(contract(), { user: "x" });
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_suspended" });
    expect(b.backend.requests).toHaveLength(0);
  });

  it("suspends a call outside a run too (state only, no run event)", async () => {
    const s = setup({ window_calls: 3, min_calls: 3, rejection_threshold: 0.5 });
    const { svc, ledger, backend } = s.open();
    backend.setScript([BAD]);
    for (let i = 0; i < 3; i++) await svc.call(contract(), { user: "x" });
    expect(svc.isSuspended("run_title")).toBe(true);
    expect(ledger.listRunEvents(s.runId)).toEqual([]);
  });

  it("re-enabling clears the suspension, is recorded, and restarts the window", async () => {
    const s = setup({ window_calls: 4, min_calls: 4, rejection_threshold: 0.5 });
    const { svc, ledger, backend } = s.open();
    expect(svc.resumeTask("run_title")).toBeUndefined(); // never suspended: nothing to do
    backend.setScript([BAD]);
    for (let i = 0; i < 4; i++) await svc.call(contract(), { user: "x", run_id: s.runId });
    expect(svc.isSuspended("run_title")).toBe(true);

    const resumed = svc.resumeTask("run_title");
    expect(resumed).toMatchObject({
      task: "run_title",
      suspended: false,
      suspended_at: null,
      suspended_basis: null,
      version: 2,
    });
    expect(resumed?.resumed_at).toEqual(expect.any(String));
    expect(svc.resumeTask("run_title")).toBeUndefined(); // already enabled: no second record
    expect(ledger.getInnerTaskState("run_title")?.version).toBe(2);
    expect(svc.isSuspended("run_title")).toBe(false);

    // the old rejections are before resumed_at: three fresh rejections are under the minimum sample and do not suspend
    for (let i = 0; i < 3; i++) await svc.call(contract(), { user: "x", run_id: s.runId });
    expect(svc.isSuspended("run_title")).toBe(false);
    expect(outcomes(ledger).slice(-3)).toEqual(Array(3).fill("rejected_validator"));
    // a fourth fresh rejection reaches the minimum and suspends again
    await svc.call(contract(), { user: "x", run_id: s.runId });
    expect(svc.isSuspended("run_title")).toBe(true);
    expect(ledger.getInnerTaskState("run_title")?.version).toBe(3);
    expect(ledger.listRunEvents(s.runId).filter((e) => e.type === "inner_task_suspended")).toHaveLength(2);
  });

  it("resume works on the persisted state with the agent otherwise off, and writes no run event", async () => {
    const s = setup({ window_calls: 3, min_calls: 3, rejection_threshold: 0.5 });
    const a = s.open();
    a.backend.setScript([BAD]);
    for (let i = 0; i < 3; i++) await a.svc.call(contract(), { user: "x", run_id: s.runId });
    const events = a.ledger.listRunEvents(s.runId).length;

    const b = s.open(); // another process (the operator CLI, T11.7)
    expect(b.svc.resumeTask("run_title")?.suspended).toBe(false);
    expect(b.ledger.listRunEvents(s.runId)).toHaveLength(events);
    b.backend.setScript([GOOD]);
    expect((await b.svc.call(contract(), { user: "x" })).accepted).toBe(true);
  });

  it("without a ledger there is no state: never suspended, resume is a no-op", async () => {
    const settings = resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "m" },
      tasks: { run_title: { enabled: true } },
      suspension: { window_calls: 2, min_calls: 1, rejection_threshold: 0.1 },
    });
    const svc = createInnerAgent(settings, { backend: createFakeBackend({ script: [BAD] }) });
    for (let i = 0; i < 3; i++) await svc.call(contract(), { user: "x" });
    expect(svc.isSuspended("run_title")).toBe(false);
    expect(svc.taskState("run_title")).toBeUndefined();
    expect(svc.resumeTask("run_title")).toBeUndefined();
  });
});
