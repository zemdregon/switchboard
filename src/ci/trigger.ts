/**
 * CI-failure trigger (T15.3; FR-QUE-03, LLD §18.6 trigger logic, §18.7 scheduler step 2). On each poll, for every
 * project whose trigger is enabled and not paused, each published ref (`published-refs.ts`) is asked of the
 * {@link CiStatusPort}. A `failure`, `cancelled` or `timed_out` conclusion for the published tip, with an `external_id`
 * not seen for the project, enqueues one T15.1 work item (`source_kind = 'ci_trigger'`) under the trigger's
 * `creator_client_id`; scheduler step 3 admits it under that client's current ceiling (LLD §18.4), never a wider one.
 *
 * Dedup is by `(project_id, external_id)` only, never by text: the work item's `source_id` is `ci:<external_id>` and its
 * idempotency key `ci_trigger:<project>:<external_id>`, written in the one enqueue transaction, so a restart can neither
 * lose nor repeat an enqueue (no separate event row to reconcile). An optional operator-forwarded summary is untrusted
 * (`untrusted.ts`): it cannot cause, block or shape admission, and reaches the objective only through its template token.
 */
import type Database from "better-sqlite3";
import { type CiTriggerSettings, DEFAULT_CI_POLL_INTERVAL_SECONDS } from "../config/ci-trigger.js";
import { isAdmissionPaused } from "../control/pause.js";
import type { Ledger } from "../ledger/index.js";
import { isDatabaseId } from "./gh-argv.js";
import { CiStatusError, type CiStatusErrorReason, type CiStatusPort, FAILING_CONCLUSIONS } from "./port.js";
import { listPublishedRefs } from "./published-refs.js";
import { renderCiObjective, untrustedExternalText } from "./untrusted.js";

export const CI_SOURCE_PREFIX = "ci:";

export const DISABLED_CI_TRIGGER: CiTriggerSettings = {
  enabled: false,
  pollIntervalSeconds: DEFAULT_CI_POLL_INTERVAL_SECONDS,
  ghBinary: "gh",
  useCheckRunsFallback: false,
  projects: [],
};

export type CiTriggerErrorReason = CiStatusErrorReason | "REMOTE_UNRESOLVED" | "OBSERVATION_MISMATCH" | "QUEUE_LIMIT";

/** A recorded poll error: reason codes and controller facts only, never `gh` output or event text. */
export interface CiTriggerError {
  readonly projectId: string;
  readonly publishRef: string;
  readonly reason: CiTriggerErrorReason;
}

export interface CiTriggerDeps {
  readonly db: Database.Database;
  readonly ledger: Ledger;
  readonly port: CiStatusPort;
  readonly settings: CiTriggerSettings;
  /** `owner/repo` of a project's remote (read-only local `git`), or undefined when it is not a github.com remote. */
  readonly resolveRemote: (projectId: string, remote: string) => Promise<{ owner: string; repo: string } | undefined>;
  /** Operator-forwarded notification text for an observation, if any (untrusted; may be absent). */
  readonly untrustedSummary?: (q: { projectId: string; publishRef: string; externalId: string }) => string | undefined;
  /** `queue.max_items_per_project` (LLD §18.1). */
  readonly maxItemsPerProject?: number;
}

export interface CiTriggerPollResult {
  /** Port calls made. */
  polled: number;
  enqueued: { projectId: string; workItemId: string; externalId: string }[];
  duplicates: number;
  errors: CiTriggerError[];
}

/** One poll over every enabled project (LLD §18.7 step 2). Never throws for a single project or ref. */
export async function pollCiTriggers(deps: CiTriggerDeps): Promise<CiTriggerPollResult> {
  const result: CiTriggerPollResult = { polled: 0, enqueued: [], duplicates: 0, errors: [] };
  const { settings, ledger, db } = deps;
  if (!settings.enabled || settings.pollIntervalSeconds === 0) return result;
  const maxItems = deps.maxItemsPerProject ?? 500;
  for (const trigger of settings.projects) {
    if (!trigger.enabled) continue;
    const projectId = trigger.projectId;
    if (isAdmissionPaused(ledger, projectId)) continue;
    const remotes = new Map<string, { owner: string; repo: string } | undefined>();
    for (const ref of listPublishedRefs(db, projectId)) {
      const fail = (reason: CiTriggerErrorReason) =>
        result.errors.push({ projectId, publishRef: ref.publishRef, reason });
      if (!remotes.has(ref.remote)) remotes.set(ref.remote, await deps.resolveRemote(projectId, ref.remote));
      const gh = remotes.get(ref.remote);
      if (gh === undefined) {
        fail("REMOTE_UNRESOLVED");
        continue;
      }
      let obs: Awaited<ReturnType<CiStatusPort["latestForPublishedRef"]>>;
      try {
        result.polled++;
        obs = await deps.port.latestForPublishedRef({ ...gh, publishRef: ref.publishRef, headSha: ref.headSha });
      } catch (err) {
        fail(err instanceof CiStatusError ? err.reason : "GH_FAILED");
        continue;
      }
      if (obs === null || !FAILING_CONCLUSIONS.has(obs.conclusion)) continue;
      if (
        obs.publishRef !== ref.publishRef ||
        obs.headSha.toLowerCase() !== ref.headSha ||
        !isDatabaseId(obs.externalId)
      ) {
        fail("OBSERVATION_MISMATCH");
        continue;
      }
      const sourceId = `${CI_SOURCE_PREFIX}${obs.externalId}`;
      const seen = db
        .prepare(
          "SELECT 1 FROM project_work_item WHERE project_id = ? AND source_kind = 'ci_trigger' AND source_id = ?",
        )
        .get(projectId, sourceId);
      if (seen !== undefined) {
        result.duplicates++;
        continue;
      }
      if (ledger.countWorkItemsForProject(projectId) >= maxItems) {
        fail("QUEUE_LIMIT");
        continue;
      }
      const raw = deps.untrustedSummary?.({ projectId, publishRef: ref.publishRef, externalId: obs.externalId });
      const summary = raw === undefined || raw === "" ? undefined : untrustedExternalText(raw);
      const objective = renderCiObjective(
        trigger.template.objective,
        { publishRef: ref.publishRef, headSha: ref.headSha, conclusion: obs.conclusion, externalId: obs.externalId },
        summary,
      );
      const item = ledger.enqueueWorkItem({
        projectId,
        creatorClientId: trigger.creatorClientId,
        request: {
          objective,
          trust_profile: trigger.template.trustProfile,
          project: projectId,
          constraints: [...trigger.template.constraints],
          routing: {},
        },
        sourceKind: "ci_trigger",
        sourceId,
        idempotencyKey: `ci_trigger:${projectId}:${obs.externalId}`,
        idempotentReturnExisting: true,
      });
      result.enqueued.push({ projectId, workItemId: item.id, externalId: obs.externalId });
    }
  }
  return result;
}

/** Paces {@link pollCiTriggers} to `poll_interval_seconds` on the `serve` scheduler tick; one poll at a time. */
export class CiTriggerPoller {
  private lastPollMs: number | undefined;
  private inFlight = false;
  /** Errors of the latest poll (reason codes only), for logs and a later `doctor` check. */
  lastErrors: readonly CiTriggerError[] = [];

  constructor(
    private readonly deps: CiTriggerDeps,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** Runs a poll when due; undefined when off, not due, or a poll is still running. */
  async tick(): Promise<CiTriggerPollResult | undefined> {
    const { enabled, pollIntervalSeconds } = this.deps.settings;
    if (!enabled || pollIntervalSeconds === 0 || this.inFlight) return undefined;
    const now = this.nowMs();
    if (this.lastPollMs !== undefined && now - this.lastPollMs < pollIntervalSeconds * 1000) return undefined;
    this.lastPollMs = now;
    this.inFlight = true;
    try {
      const r = await pollCiTriggers(this.deps);
      this.lastErrors = r.errors;
      return r;
    } finally {
      this.inFlight = false;
    }
  }
}
