/**
 * Schedule firing logic (LLD §18.5, §18.7 step 1, FR-QUE-02).
 *
 * Evaluates enabled, approved schedules against the current UTC minute on an injected clock.
 * For each matching schedule not already fired in the current minute, enqueues one `project_work_item`
 * under `creator_client_id` with `source_kind = 'schedule'`, updates `last_fire_at` in the same
 * transaction for dedup, and substitutes `{{schedule_fire_at}}` with the tick timestamp.
 */

import { isAdmissionPaused } from "../control/pause.js";
import type { Ledger } from "../ledger/index.js";
import { cronMatches, formatMinuteAnchor, isSameUtcMinute } from "./cron.js";

export interface ScheduleFireOptions {
  /** Injectable UTC date/time for testing (LLD §18.5). Default `new Date()`. */
  nowUtc?: Date;
  /** Custom pause check. Default `isAdmissionPaused(ledger, projectId)`. */
  isPaused?: (projectId: string) => boolean;
}

export interface ScheduleFireResult {
  dueCount: number;
  firedCount: number;
  skippedCount: number;
  workItemsEnqueued: string[];
}

export function fireDueSchedules(ledger: Ledger, opts: ScheduleFireOptions = {}): ScheduleFireResult {
  const now = opts.nowUtc ?? new Date();
  const tickIso = now.toISOString();
  const minuteBucket = formatMinuteAnchor(now);
  const pauseCheck = opts.isPaused ?? ((projectId: string) => isAdmissionPaused(ledger, projectId));

  const candidates = ledger.listSchedules({ enabled: true, approvalState: "APPROVED" });
  let dueCount = 0;
  let firedCount = 0;
  let skippedCount = 0;
  const workItemsEnqueued: string[] = [];

  for (const candidate of candidates) {
    if (!cronMatches(candidate.cron_expr, now)) {
      continue;
    }
    dueCount++;

    if (candidate.last_fire_at !== null && isSameUtcMinute(candidate.last_fire_at, tickIso)) {
      skippedCount++;
      continue;
    }

    if (pauseCheck(candidate.project_id)) {
      skippedCount++;
      continue;
    }

    // Fire in one immediate transaction with re-check for restart / concurrency safety
    const enqueuedId = ledger.immediate(() => {
      const fresh = ledger.getSchedule(candidate.id);
      if (fresh === undefined || fresh.enabled !== 1 || fresh.approval_state !== "APPROVED") {
        return undefined;
      }
      if (fresh.last_fire_at !== null && isSameUtcMinute(fresh.last_fire_at, tickIso)) {
        return undefined;
      }
      if (pauseCheck(fresh.project_id)) {
        return undefined;
      }

      // Substitute {{schedule_fire_at}} with tick timestamp
      const substitutedJson = fresh.template_json.replaceAll("{{schedule_fire_at}}", tickIso);
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(substitutedJson) as Record<string, unknown>;
      } catch (err) {
        request = { raw: substitutedJson, parse_error: String(err) };
      }

      const priority = typeof request.priority === "number" ? request.priority : 0;
      const idempotencyKey = `schedule:${fresh.id}:${minuteBucket}`;

      const item = ledger.enqueueWorkItem({
        projectId: fresh.project_id,
        creatorClientId: fresh.creator_client_id,
        request,
        sourceKind: "schedule",
        sourceId: fresh.id,
        idempotencyKey,
        priority,
        idempotentReturnExisting: true,
      });

      ledger.updateScheduleLastFire(fresh.id, tickIso);
      return item.id;
    });

    if (enqueuedId !== undefined) {
      firedCount++;
      workItemsEnqueued.push(enqueuedId);
    } else {
      skippedCount++;
    }
  }

  return { dueCount, firedCount, skippedCount, workItemsEnqueued };
}
