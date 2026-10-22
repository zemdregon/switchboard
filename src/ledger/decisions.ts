/**
 * Decision-request persistence (T14.15; FR-CTL-13, LLD §20.3): the `decision_request` rows of migration 0030. A ledger
 * slice as `control-plane.ts`, spread into {@link Ledger}. It only reads and writes rows; who may request, list and
 * decide, the parking of the work item and the enqueue list live in `src/control/decisions.ts`, which runs these calls
 * inside one `BEGIN IMMEDIATE` transaction.
 *
 * `question`, the option labels and `note` are untrusted client text. They are stored here and returned only through
 * the reads below; no event payload, sink payload or log line carries them.
 */

import type Database from "better-sqlite3";
import type { IdGenerator } from "../ids/index.js";

/** LLD §20.3: what resolving an option does to the parked work item and the decision's enqueue list. */
export const DECISION_ACTIONS = ["resume", "reroute", "cancel", "none"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const DECISION_STATES = ["open", "decided", "withdrawn"] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

/** One option as stored in `options_json`; options are numbered from 1 in stored order. */
export interface DecisionOption {
  readonly label: string;
  readonly action: DecisionAction;
}

export interface DecisionRequestRow {
  id: string;
  project_id: string;
  work_item_id: string | null;
  requester_client_id: string;
  question: string;
  options_json: string;
  recommended_option: number;
  enqueue_json: string;
  state: DecisionState;
  decided_option: number | null;
  decided_by: string | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
  /** ADR-0068 (migration 0032): the normalised repository URL of an onboarding decision; NULL otherwise. */
  onboarding_url: string | null;
}

export interface NewDecisionRequest {
  readonly projectId: string;
  readonly workItemId: string | null;
  readonly requesterClientId: string;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  readonly recommendedOption: number;
  /** Work items in the `enqueue_work` shape (`{ request, priority }`), inserted only on resolution. */
  readonly enqueue: readonly unknown[];
  /** ADR-0068: the normalised repository URL of an onboarding decision. */
  readonly onboardingUrl?: string;
}

export interface DecisionListFilter {
  /** Decisions requested by any of these clients. Empty means none. */
  readonly requesterClientIds: readonly string[];
  readonly projectId?: string;
  readonly states?: readonly DecisionState[];
  readonly limit: number;
}

export interface DecisionLedgerSlice {
  /** Insert an `open` decision. Joins a caller's transaction. */
  insertDecision(input: NewDecisionRequest): DecisionRequestRow;
  getDecision(id: string): DecisionRequestRow | undefined;
  /** Oldest first (`created_at`, then `id`). */
  listDecisions(filter: DecisionListFilter): DecisionRequestRow[];
  /**
   * Compare-and-set `open` to `decided` or `withdrawn`. Returns the row, or undefined (nothing written) when the
   * decision is unknown or no longer open, so a second resolution never applies anything.
   */
  closeDecision(input: {
    id: string;
    state: "decided" | "withdrawn";
    option: number | null;
    decidedBy: string;
    note: string | null;
  }): DecisionRequestRow | undefined;
}

const COLS = `id, project_id, work_item_id, requester_client_id, question, options_json, recommended_option,
  enqueue_json, state, decided_option, decided_by, note, created_at, decided_at, onboarding_url`;

export function createDecisionLedgerSlice(
  db: Database.Database,
  deps: { ids: IdGenerator; ts: () => string },
): DecisionLedgerSlice {
  const { ids, ts } = deps;
  const getDecision = (id: string) =>
    db.prepare(`SELECT ${COLS} FROM decision_request WHERE id = ?`).get(id) as DecisionRequestRow | undefined;

  return {
    insertDecision(input) {
      const id = ids.id("dec");
      db.prepare(
        `INSERT INTO decision_request (id, project_id, work_item_id, requester_client_id, question, options_json,
           recommended_option, enqueue_json, state, created_at, onboarding_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(
        id,
        input.projectId,
        input.workItemId,
        input.requesterClientId,
        input.question,
        JSON.stringify(input.options.map((o) => ({ label: o.label, action: o.action }))),
        input.recommendedOption,
        JSON.stringify(input.enqueue),
        ts(),
        input.onboardingUrl ?? null,
      );
      return getDecision(id) as DecisionRequestRow;
    },

    getDecision,

    listDecisions(filter) {
      if (filter.requesterClientIds.length === 0) return [];
      const where = [`requester_client_id IN (${filter.requesterClientIds.map(() => "?").join(", ")})`];
      const args: unknown[] = [...filter.requesterClientIds];
      if (filter.projectId !== undefined) {
        where.push("project_id = ?");
        args.push(filter.projectId);
      }
      if (filter.states !== undefined) {
        if (filter.states.length === 0) return [];
        where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        args.push(...filter.states);
      }
      return db
        .prepare(`SELECT ${COLS} FROM decision_request WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ?`)
        .all(...args, filter.limit) as DecisionRequestRow[];
    },

    closeDecision(input) {
      const n = db
        .prepare(
          `UPDATE decision_request SET state = ?, decided_option = ?, decided_by = ?, note = ?, decided_at = ?
           WHERE id = ? AND state = 'open'`,
        )
        .run(input.state, input.option, input.decidedBy, input.note, ts(), input.id).changes;
      return n === 0 ? undefined : getDecision(input.id);
    },
  };
}
