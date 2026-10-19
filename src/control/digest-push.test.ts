/**
 * T14.16 (FR-CTL-14, FR-CTL-02, FR-CTL-10, LLD §20.5, ADR-0048 item 3 as amended): the scheduled digest push and the
 * project progress stall. Hermetic: a real ledger in a temp directory with an injected clock, the real
 * {@link SinkDispatcher} with a capturing transport (no network), and no provider CLI. A canary is planted in a run's
 * objective and request and in a work item's objective; it must never reach a sink.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationSinkSettings } from "../config/notification-sinks.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, WORK_ITEM_STATES } from "../ledger/index.js";
import { RUN_STATES } from "../lifecycle/states.js";
import { assembleDigest } from "../mcp/digest.js";
import { validateCronExpr } from "../schedule/cron.js";
import { collectDigestCounts, DigestPushSchedule, digestPushFor } from "./digest-push.js";
import { deriveProgressStall, progressStallOf } from "./progress-stall.js";
import {
  buildNotificationPayload,
  DIGEST_ATTENTION_REASONS,
  type DigestCounts,
  SinkDispatcher,
  type SinkEvent,
  type SinkRequest,
} from "./sinks.js";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const HOUR = 3_600_000;
const CANARY = "canary-objective-7d1e4b";
let dir: string;
let db: Database.Database;
let ledger: Ledger;
let clock: number;
const now = () => new Date(clock);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-digest-push-"));
  db = openLedger(dir);
  clock = T0;
  ledger = createLedger(db, { ids: createIdGenerator(), now });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const enqueue = (projectId = "web") =>
  ledger.enqueueWorkItem({
    projectId,
    creatorClientId: "orch",
    request: { objective: `do it ${CANARY}`, trust_profile: "edit-untrusted" },
    sourceKind: "mcp",
  });

/** Moves a READY item through admission to DONE at the current clock. */
function complete(itemId: string): void {
  const claimed = ledger.claimReadyWorkItem("web");
  expect(claimed?.id).toBe(itemId);
  const ms = ledger.createMetaSession({ objective: CANARY, projectId: "web" });
  const run = ledger.createRun({
    metaSessionId: ms.id,
    state: "QUEUED",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: { objective: CANARY },
    requestHash: "h",
    clientId: "orch",
    projectId: "web",
  });
  ledger.completeWorkAdmission(itemId, { kind: "admitted", runId: run.id });
  ledger.markWorkItemDone(itemId);
}

const webhook: NotificationSinkSettings = {
  id: "ops",
  kind: "webhook",
  url: "https://hooks.example.test/digest",
  events: new Set(["digest"]),
  maxPerMinute: 10,
};

function capturingDispatcher() {
  const bodies: string[] = [];
  const post = async (r: SinkRequest) => {
    bodies.push(r.body);
    return 204;
  };
  return { bodies, dispatcher: new SinkDispatcher({ sinks: [webhook], post, now: () => clock }) };
}

/** Every leaf of an object, with its path. */
function leaves(v: unknown, at = "$"): [string, unknown][] {
  if (typeof v !== "object" || v === null) return [[at, v]];
  return Object.entries(v).flatMap(([k, x]) => leaves(x, `${at}.${k}`));
}

const PROJECTS = [{ id: "web", queue: { stallHours: 4 } }, { id: "api" }];

describe("scheduled digest push (T14.16)", () => {
  it("sends a metadata-only digest on schedule: closed keys, integer counts, no objective text", async () => {
    const ms = ledger.createMetaSession({ objective: CANARY, projectId: "web" });
    ledger.createRun({
      metaSessionId: ms.id,
      state: "AWAITING_APPROVAL",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: { objective: CANARY },
      requestHash: "h",
      clientId: "orch",
      projectId: "web",
    });
    enqueue();
    enqueue();
    const { bodies, dispatcher } = capturingDispatcher();
    const push = new DigestPushSchedule({
      cron: validateCronExpr("0 * * * *"),
      emit: (e) => dispatcher.emit(e),
      counts: (at) => collectDigestCounts(ledger, { now: at, projects: PROJECTS }),
    });

    clock = T0 + 59_000; // 10:00:59, inside the matching minute
    expect(push.tick(now())).toBe(true);
    expect(push.tick(now())).toBe(false); // same minute: once
    clock = T0 + 60_000; // 10:01 does not match "0 * * * *"
    expect(push.tick(now())).toBe(false);
    await dispatcher.drain();

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    expect(body).not.toContain(CANARY);
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["project_id", "event_kind", "reason_code", "run_id", "link", "counts"]);
    expect(payload).toMatchObject({
      project_id: "*",
      event_kind: "digest",
      reason_code: "digest",
      run_id: null,
      link: "switchboard://digest",
    });
    // No body field of any kind, at any depth: every counts leaf is a non-negative integer.
    for (const [at, v] of leaves(payload.counts)) {
      expect(Number.isSafeInteger(v) && (v as number) >= 0, at).toBe(true);
      expect(at).not.toMatch(/objective|summary|text|body|message|prompt|transcript|decision/);
    }
    const counts = payload.counts as DigestCounts;
    expect(Object.keys(counts.runs_by_state)).toEqual([...RUN_STATES]);
    expect(Object.keys(counts.queue_by_state)).toEqual([...WORK_ITEM_STATES]);
    expect(Object.keys(counts.needs_attention_by_reason)).toEqual([...DIGEST_ATTENTION_REASONS]);
    expect(counts.runs_by_state.AWAITING_APPROVAL).toBe(1);
    expect(counts.needs_attention_by_reason.awaiting_approval).toBe(1);
    expect(counts.needs_attention_by_reason.stalled_progress).toBe(0);
    expect(counts.queue_by_state.READY).toBe(2);
    expect(counts.pending_approvals).toBe(0);
    expect(counts.paused_projects).toBe(0);
  });

  it("counts a stalled project in the pushed digest", () => {
    enqueue();
    clock = T0 + 4 * HOUR;
    const counts = collectDigestCounts(ledger, { now: now(), projects: PROJECTS });
    expect(counts.needs_attention_by_reason.stalled_progress).toBe(1);
  });

  it("is off when the schedule is unset: nothing is built and nothing is sent", async () => {
    enqueue();
    const { bodies, dispatcher } = capturingDispatcher();
    let collected = 0;
    const counts = (at: Date) => {
      collected += 1;
      return collectDigestCounts(ledger, { now: at, projects: PROJECTS });
    };
    expect(digestPushFor({ cron: undefined, sinks: dispatcher, counts })).toBeUndefined();
    expect(digestPushFor({ cron: validateCronExpr("* * * * *"), sinks: undefined, counts })).toBeUndefined();
    // A configured schedule outside its minute sends nothing either.
    const hourly = digestPushFor({ cron: validateCronExpr("0 3 * * *"), sinks: dispatcher, counts });
    for (let m = 0; m < 120; m++) {
      clock = T0 + m * 60_000;
      expect(hourly?.tick(now())).toBe(false);
    }
    await dispatcher.drain();
    expect(bodies).toHaveLength(0);
    expect(collected).toBe(0);
  });

  it("refuses a digest whose counts carry a string, an extra key or a missing key, and counts on other kinds", () => {
    const good = collectDigestCounts(ledger, { now: now(), projects: PROJECTS });
    const event = (counts: unknown): SinkEvent =>
      ({ projectId: "*", eventKind: "digest", reasonCode: "digest", runId: null, counts }) as SinkEvent;
    expect(buildNotificationPayload(event(good), undefined)?.counts).toEqual(good);
    expect(buildNotificationPayload(event(undefined), undefined)).toBeUndefined();
    expect(buildNotificationPayload(event({ ...good, objective: 0 }), undefined)).toBeUndefined();
    expect(buildNotificationPayload(event({ ...good, pending_approvals: CANARY }), undefined)).toBeUndefined();
    expect(buildNotificationPayload(event({ ...good, paused_projects: 1.5 }), undefined)).toBeUndefined();
    expect(
      buildNotificationPayload(event({ ...good, runs_by_state: { ...good.runs_by_state, QUEUED: CANARY } }), undefined),
    ).toBeUndefined();
    expect(
      buildNotificationPayload(event({ ...good, queue_by_state: { ...good.queue_by_state, note: 1 } }), undefined),
    ).toBeUndefined();
    const { pending_approvals: _gone, ...missing } = good;
    expect(buildNotificationPayload(event(missing), undefined)).toBeUndefined();
    expect(
      buildNotificationPayload(
        { projectId: "web", eventKind: "queue_low", reasonCode: "queue_low", runId: null, counts: good },
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe("progress stall (T14.16)", () => {
  const stall = () => progressStallOf(ledger, "web", { now: now(), stallHours: 4 });

  it("raises stalled_progress after the window with READY items and no completion", () => {
    enqueue();
    clock = T0 + 4 * HOUR - 1;
    expect(stall()).toEqual({ active: false });
    clock = T0 + 4 * HOUR;
    expect(stall()).toEqual({ active: true, reason: "stalled_progress" });
  });

  it("does not raise without READY items", () => {
    clock = T0 + 100 * HOUR;
    expect(stall()).toEqual({ active: false });
    const item = enqueue();
    clock += 1;
    complete(item.id); // the only item is DONE: nothing READY
    clock += 100 * HOUR;
    expect(stall()).toEqual({ active: false });
  });

  it("does not raise when a completion happened inside the window, and the next completion clears it", () => {
    const first = enqueue();
    enqueue();
    clock = T0 + 3 * HOUR;
    complete(first.id); // DONE inside the window; the second item is still READY
    clock = T0 + 5 * HOUR; // 5 h since the oldest READY, 2 h since the DONE
    expect(stall()).toEqual({ active: false });
    clock = T0 + 7 * HOUR; // 4 h since the DONE
    expect(stall()).toEqual({ active: true, reason: "stalled_progress" });
    const second = ledger.listWorkItems({ clientId: "orch", projectId: "web", states: ["READY"], limit: 10 })[0];
    enqueue();
    complete(second?.id as string);
    expect(stall()).toEqual({ active: false }); // cleared by the next completion
  });

  it("is off when the window is unset, and an unparseable clock raises nothing", () => {
    enqueue();
    clock = T0 + 1000 * HOUR;
    expect(progressStallOf(ledger, "web", { now: now(), stallHours: undefined })).toEqual({ active: false });
    expect(
      deriveProgressStall(
        { readyCount: 1, oldestReadyCreatedAt: "not a time", lastDoneAt: null },
        { now: now(), stallHours: 1 },
      ),
    ).toEqual({ active: false });
  });

  it("is raised on get_digest as a project-level flag, and absent when not stalled", () => {
    enqueue();
    const scope = { clientId: "orch", visible: () => true, projectIds: ["web", "api"] };
    const digest = () =>
      assembleDigest(ledger, scope, undefined, (s) => s, {
        now: now(),
        stallHours: (id) => (id === "web" ? 4 : undefined),
      });
    expect(digest().projects.find((p) => p.project_id === "web")).not.toHaveProperty("project_needs_attention");
    clock = T0 + 4 * HOUR;
    const projects = digest().projects;
    expect(projects.find((p) => p.project_id === "web")?.project_needs_attention).toEqual({
      active: true,
      reason: "stalled_progress",
    });
    expect(projects.find((p) => p.project_id === "api")).not.toHaveProperty("project_needs_attention");
  });
});
