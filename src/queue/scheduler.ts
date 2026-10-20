/**
 * T15.1 scheduler slice (LLD §18.7 step 3): dequeue READY work items and admit them under `creator_client_id`. T15.7:
 * the dequeue skips an item whose `hot_paths` overlap a running item (`claimReadyWorkItem`), and a rebase item is
 * admitted as a continuation of the publishing meta-session.
 */
import type { Ledger } from "../ledger/index.js";
import { type AdmitWorkDeps, admitWorkItemRequest } from "./admission.js";

export const DEFAULT_QUEUE_MAX_ITEMS_PER_PROJECT = 500;
export const DEFAULT_QUEUE_DEQUEUE_BATCH = 1;

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
        ledger.completeWorkAdmission(item.id, {
          kind: "failed",
          code: "INVALID_REQUEST",
          detail: { message: "request_json is not valid JSON" },
        });
        failed++;
        continue;
      }
      const idem = `queue:${item.id}`;
      // T15.7 (LLD §20.4): a rebase item continues the publishing meta-session. A run already admitted for it (a crash
      // after submit) completes the admission instead of a second run.
      const conflict = ledger.getRefConflictForWorkItem(item.id);
      const rebase =
        conflict?.kind === "rebase" && conflict.meta_session_id !== null
          ? {
              workItemId: item.id,
              metaSessionId: conflict.meta_session_id,
              publishRef: conflict.publish_ref,
              headSha: conflict.head_sha,
            }
          : undefined;
      const prior = rebase === undefined ? undefined : ledger.findRunRebaseForWorkItem(item.id);
      if (prior !== undefined) {
        ledger.completeWorkAdmission(item.id, { kind: "admitted", runId: prior.run_id });
        admitted++;
        continue;
      }
      const outcome = await admitWorkItemRequest(
        admission,
        item.creator_client_id,
        item.project_id,
        request,
        idem,
        rebase,
      );
      if (outcome.kind === "admitted") {
        ledger.completeWorkAdmission(item.id, { kind: "admitted", runId: outcome.runId });
        admitted++;
      } else if (outcome.kind === "retry") {
        ledger.completeWorkAdmission(item.id, { kind: "retry" });
        retried++;
      } else {
        ledger.completeWorkAdmission(item.id, {
          kind: "failed",
          code: outcome.code,
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        });
        failed++;
      }
    }
  }
  return { admitted, retried, failed };
}
