/**
 * Schedule widening detection (LLD §18.5, Discovery §8).
 *
 * Schedules created by a chat client that would enqueue a privileged run or wider profile than the creator's
 * current ceiling wait for operator approval (row state PENDING_APPROVAL on the schedule until switchboard schedule approve).
 */

import { effectiveMaxProfile, type ResolvedMcpClient, type ResolvedProject } from "../config/index.js";
import type { ScheduleApprovalState, TrustProfile } from "../ledger/index.js";
import { profileRank } from "../routing/eligibility.js";

/**
 * Check if the schedule template would widen the reach of the creating client beyond what it can do in one call.
 */
export function isScheduleWidening(
  template: Record<string, unknown>,
  creatorClient: ResolvedMcpClient | undefined,
  project?: ResolvedProject,
): boolean {
  if (creatorClient === undefined) return false;

  const rawProfile = template.trust_profile;
  const requestedProfile = typeof rawProfile === "string" ? (rawProfile as TrustProfile) : "inspect-untrusted";

  // Check client ceiling
  if (profileRank(requestedProfile) > profileRank(creatorClient.maxTrustProfile)) {
    return true;
  }

  // Privileged requests require operator approval unless client policy lifts it
  if (requestedProfile === "privileged") {
    if (creatorClient.maxTrustProfile !== "privileged") return true;
    if (creatorClient.privilegedApproval !== "not_required") return true;
  }

  // Check project effective ceiling
  if (project !== undefined) {
    const effectiveMax = effectiveMaxProfile(creatorClient.maxTrustProfile, project);
    if (profileRank(requestedProfile) > profileRank(effectiveMax)) {
      return true;
    }
  }

  return false;
}

/**
 * Determine the initial approval_state for a new schedule.
 */
export function determineScheduleApprovalState(
  template: Record<string, unknown>,
  creatorClient: ResolvedMcpClient | undefined,
  project?: ResolvedProject,
): ScheduleApprovalState {
  if (creatorClient === undefined) return "APPROVED";
  return isScheduleWidening(template, creatorClient, project) ? "PENDING_APPROVAL" : "APPROVED";
}
