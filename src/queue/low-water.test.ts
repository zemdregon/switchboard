import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SinkEvent } from "../control/sinks.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { attachQueueLowWater, QueueLowWaterTracker } from "./low-water.js";

describe("Queue low-water unit tests (T15.4, FR-QUE-04)", () => {
  let tmp: string;
  let db: ReturnType<typeof openLedger>;
  let ledger: Ledger;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sb-low-water-test-"));
    db = openLedger(tmp);
    ledger = createLedger(db, { ids: createIdGenerator() });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dummyRequest = {
    objective: "Test work item",
    workspace_path: "/tmp",
    trust_profile: "inspect-untrusted" as const,
  };

  describe("countAdmissibleWorkItems", () => {
    it("returns 0 when no items exist", () => {
      expect(ledger.countAdmissibleWorkItems("proj-a")).toBe(0);
    });

    it("counts READY items and isolates projects", () => {
      ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      ledger.enqueueWorkItem({
        projectId: "proj-b",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });

      expect(ledger.countAdmissibleWorkItems("proj-a")).toBe(2);
      expect(ledger.countAdmissibleWorkItems("proj-b")).toBe(1);
      expect(ledger.countAdmissibleWorkItems("proj-c")).toBe(0);
    });

    it("counts PENDING items whose direct and transitive dependencies can still be met", () => {
      const item1 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      const item2 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
        predecessorIds: [item1.id],
      });
      ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
        predecessorIds: [item2.id],
      });

      // item1 is READY, item2 is PENDING (dep item1), item3 is PENDING (dep item2)
      // All 3 are admissible
      expect(ledger.countAdmissibleWorkItems("proj-a")).toBe(3);

      // Cancel item1: item2 and item3 can no longer have dependencies met
      ledger.cancelWorkItem(item1.id, "client-1");
      expect(ledger.countAdmissibleWorkItems("proj-a")).toBe(0);
    });

    it("does not count PENDING item when predecessor FAILED_ADMISSION", () => {
      const item1 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
        predecessorIds: [item1.id],
      });

      expect(ledger.countAdmissibleWorkItems("proj-a")).toBe(2);

      // Claim item1 and mark FAILED_ADMISSION
      ledger.claimReadyWorkItem("proj-a");
      ledger.completeWorkAdmission(item1.id, { kind: "failed", code: "PERMISSION_BLOCKED" });

      expect(ledger.getWorkItem(item1.id)?.state).toBe("FAILED_ADMISSION");
      // item1 is FAILED_ADMISSION (not READY or PENDING), item2 cannot be met
      expect(ledger.countAdmissibleWorkItems("proj-a")).toBe(0);
    });

    it("counts PENDING item when predecessor is ADMITTED or DONE", () => {
      const item1 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      const item2 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
        predecessorIds: [item1.id],
      });

      // Admit item1 to a run
      ledger.claimReadyWorkItem("proj-a");
      ledger.completeWorkAdmission(item1.id, { kind: "admitted", runId: "run_01JH0000000000000000000001" });
      expect(ledger.getWorkItem(item1.id)?.state).toBe("ADMITTED");

      // item1 is ADMITTED (not counted in queue), but item2 is PENDING with admissible dep
      expect(ledger.countAdmissibleWorkItems("proj-a")).toBe(1);

      // Mark item1 DONE: item2 becomes READY
      ledger.markWorkItemDone(item1.id);
      expect(ledger.getWorkItem(item2.id)?.state).toBe("READY");
      expect(ledger.countAdmissibleWorkItems("proj-a")).toBe(1);
    });
  });

  describe("QueueLowWaterTracker", () => {
    it("never emits when low_water is unset or < 1", () => {
      const emitted: SinkEvent[] = [];
      const tracker = new QueueLowWaterTracker({
        ledger,
        getLowWaterMark: () => undefined,
        emit: (e) => emitted.push(e),
      });

      tracker.check("proj-a");
      expect(emitted).toHaveLength(0);
      expect(tracker.isArmed("proj-a")).toBe(false);

      const trackerZero = new QueueLowWaterTracker({
        ledger,
        getLowWaterMark: () => 0,
        emit: (e) => emitted.push(e),
      });
      trackerZero.check("proj-a");
      expect(emitted).toHaveLength(0);
    });

    it("arms at/above mark, emits once on drop below mark, re-arms on refill", () => {
      const emitted: SinkEvent[] = [];
      const tracker = attachQueueLowWater({
        ledger,
        getLowWaterMark: (pid) => (pid === "proj-a" ? 3 : undefined),
        emit: (e) => emitted.push(e),
      });

      expect(tracker.isArmed("proj-a")).toBe(false);

      // Enqueue 1 item (count = 1 < 3): stays disarmed, no emit
      ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      expect(tracker.isArmed("proj-a")).toBe(false);
      expect(emitted).toHaveLength(0);

      // Enqueue 2nd item (count = 2 < 3): stays disarmed, no emit
      const item2 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      expect(tracker.isArmed("proj-a")).toBe(false);
      expect(emitted).toHaveLength(0);

      // Enqueue 3rd item (count = 3 >= 3): ARMS, no emit
      const item3 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      expect(tracker.isArmed("proj-a")).toBe(true);
      expect(emitted).toHaveLength(0);

      // Enqueue 4th item (count = 4 >= 3): stays armed, no emit
      const item4 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      expect(tracker.isArmed("proj-a")).toBe(true);
      expect(emitted).toHaveLength(0);

      // Drain from 4 to 3 (cancel item4): count = 3 >= 3 -> stays armed, no emit
      ledger.cancelWorkItem(item4.id, "client-1");
      expect(tracker.isArmed("proj-a")).toBe(true);
      expect(emitted).toHaveLength(0);

      // Drain from 3 to 2 (cancel item3): count = 2 < 3 -> EMITS 1st event, DISARMS
      ledger.cancelWorkItem(item3.id, "client-1");
      expect(tracker.isArmed("proj-a")).toBe(false);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual({
        projectId: "proj-a",
        eventKind: "queue_low",
        reasonCode: "queue_low",
        runId: null,
      });

      // Drain from 2 to 1 (cancel item2): count = 1 < 3 -> stays disarmed, no duplicate emit
      ledger.cancelWorkItem(item2.id, "client-1");
      expect(tracker.isArmed("proj-a")).toBe(false);
      expect(emitted).toHaveLength(1);

      // Refill to 2: count = 2 < 3 -> stays disarmed
      ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      expect(tracker.isArmed("proj-a")).toBe(false);
      expect(emitted).toHaveLength(1);

      // Refill to 3: count = 3 >= 3 -> RE-ARMS
      const item6 = ledger.enqueueWorkItem({
        projectId: "proj-a",
        creatorClientId: "client-1",
        request: dummyRequest,
        sourceKind: "mcp",
      });
      expect(tracker.isArmed("proj-a")).toBe(true);
      expect(emitted).toHaveLength(1);

      // Drain from 3 to 2 again: EMITS 2nd event, DISARMS
      ledger.cancelWorkItem(item6.id, "client-1");
      expect(tracker.isArmed("proj-a")).toBe(false);
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toEqual({
        projectId: "proj-a",
        eventKind: "queue_low",
        reasonCode: "queue_low",
        runId: null,
      });
    });

    it("init arms without emitting if queue is already at or above mark", () => {
      for (let i = 0; i < 3; i++) {
        ledger.enqueueWorkItem({
          projectId: "proj-a",
          creatorClientId: "client-1",
          request: dummyRequest,
          sourceKind: "mcp",
        });
      }

      const emitted: SinkEvent[] = [];
      const tracker = new QueueLowWaterTracker({
        ledger,
        getLowWaterMark: () => 3,
        emit: (e) => emitted.push(e),
      });

      expect(tracker.isArmed("proj-a")).toBe(false);
      tracker.init("proj-a");
      expect(tracker.isArmed("proj-a")).toBe(true);
      expect(emitted).toHaveLength(0);
    });
  });
});
