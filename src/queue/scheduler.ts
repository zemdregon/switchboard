/**
 * T15.1 scheduler slice (LLD §18.7 step 3): dequeue READY work items and admit them under `creator_client_id`.
 */
import type { Ledger } from "../ledger/index.js";
import { type AdmitWorkDeps, admitWorkItemRequest } from "./admission.js";

export const DEFAULT_QUEUE_MAX_ITEMS_PER_PROJECT = 500;
export const DEFAULT_QUEUE_DEQUEUE_BATCH = 1;
/** The idempotency key of a run admitted from a work item is this prefix and the item id. */
export const QUEUE_IDEMPOTENCY_PREFIX = "queue:";

export interface QueueSchedulerSettings {
  maxItemsPerProject: number;
  dequeueBatch: number;
}

export function queueSchedulerSettingsFromConfig(config: {
  queue?: Partial<QueueSchedulerSettings>;
}): QueueSchedulerSettings {
  return {
    maxItemsPerProject: config.queue?.maxItemsPerProject ?? DEFAULT_QUEUE_MAX_ITEMS_PER_PROJECT,
    dequeueBatch: config.queue?.dequeueBatch ?? DEFAULT_QUEUE_DEQUEUE_BATCH,
  };
}

export async function runProjectWorkQueueTick(
  ledger: Ledger,
  admission: AdmitWorkDeps,
  settings: QueueSchedulerSettings,
): Promise<{ admitted: number; retried: number; failed: number }> {
  let admitted = 0;
  let retried = 0;
  let failed = 0;
  for (const projectId of ledger.listDistinctProjectIdsWithReadyWork()) {
    for (let i = 0; i < settings.dequeueBatch; i++) {
      const item = ledger.claimReadyWorkItem(projectId);
      if (item === undefined) break;
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(item.request_json) as Record<string, unknown>;
      } catch {
        ledger.completeWorkAdmission(item.id, { kind: "failed", code: "INVALID_REQUEST" });
        failed++;
        continue;
      }
      const idem = `${QUEUE_IDEMPOTENCY_PREFIX}${item.id}`;
      const outcome = await admitWorkItemRequest(admission, item.creator_client_id, item.project_id, request, idem);
      if (outcome.kind === "admitted") {
        ledger.completeWorkAdmission(item.id, { kind: "admitted", runId: outcome.runId });
        admitted++;
      } else if (outcome.kind === "retry") {
        ledger.completeWorkAdmission(item.id, { kind: "retry" });
        retried++;
      } else {
        ledger.completeWorkAdmission(item.id, { kind: "failed", code: outcome.code });
        failed++;
      }
    }
  }
  return { admitted, retried, failed };
}
