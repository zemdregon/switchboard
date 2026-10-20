/**
 * `switchboard decisions list|decide` (T14.15; FR-CTL-13, FR-OPS-01, LLD §20.3): the operator side of decision requests.
 *
 * - `decisions list [--project <id>] [--state <state>]` reads the ledger only. It shows every configured client's
 *   decisions with their question, options and note, labelled untrusted: an MCP client wrote that text (control
 *   characters are refused when it is stored, so nothing in it can drive the terminal).
 * - `decisions decide <dec_id> --option <n> [--note <text>]` resolves one open decision as `cli`: the decision, the
 *   chosen action on the parked work item and the enqueue list share one transaction (`src/control/decisions.ts`).
 *   Deciding twice is refused (`CONFLICT`). It writes the ledger beside a running daemon (one WAL transaction, as
 *   `consent pair`): nothing of a decision lives in the daemon's memory, and the scheduler reads the items from the
 *   ledger at its next tick. Without a daemon it holds the data-directory lock while it writes.
 */
import { loadConfig } from "../config/index.js";
import { CLI_DECIDER, type DecisionError, decisionTextView, resolveDecision } from "../control/decisions.js";
import { createLedger, DECISION_STATES, type DecisionState, openLedger } from "../ledger/index.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";

export type DecisionListItem = ReturnType<typeof decisionTextView>;

export interface DecisionListReport {
  schema_version: number;
  decisions: DecisionListItem[];
}

export interface DecisionDecideReport {
  schema_version: number;
  decision: DecisionListItem;
  action: string;
  work_item_state: string | null;
  enqueued_work_item_ids: string[];
}

function configOf(io: CliIo, argv: readonly string[]) {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
}

export function listDecisions(
  io: CliIo,
  argv: readonly string[],
  filter: { projectId?: string; state?: string },
): DecisionListReport {
  if (filter.state !== undefined && !(DECISION_STATES as readonly string[]).includes(filter.state)) {
    throw new UsageError(`--state must be one of ${DECISION_STATES.join(", ")}`);
  }
  const config = configOf(io, argv);
  const db = openLedger(config.dataDir);
  try {
    const ledger = createLedger(db, io.now ? { now: io.now } : {});
    const rows = ledger.listDecisions({
      requesterClientIds: [...config.mcpClients.keys()],
      ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
      ...(filter.state !== undefined ? { states: [filter.state as DecisionState] } : {}),
      limit: 1000,
    });
    return { schema_version: JSON_SCHEMA_VERSION, decisions: rows.map(decisionTextView) };
  } finally {
    db.close();
  }
}

/** Parse `--option`: a 1-based option number. */
export function parseOption(raw: string | undefined): number {
  if (raw === undefined) throw new UsageError("decisions decide requires --option <n>");
  if (!/^[1-6]$/u.test(raw)) throw new UsageError("--option must be an option number from 1 to 6");
  return Number(raw);
}

export function decideDecision(
  io: CliIo,
  argv: readonly string[],
  decisionId: string,
  input: { option: number; note?: string },
): DecisionDecideReport {
  const dataDir = configOf(io, argv).dataDir;
  let lock: ReturnType<typeof acquireDataDirLock> | undefined;
  try {
    lock = acquireDataDirLock(dataDir);
  } catch (err) {
    // A running daemon holds the lock; the decision is a single WAL transaction, safe beside it.
    if (!(err instanceof LockError) || inspectDataDirLock(dataDir).state !== "held") throw err;
  }
  const db = openLedger(dataDir, io.now ? { now: io.now } : {});
  try {
    const ledger = createLedger(db, io.now ? { now: io.now } : {});
    const r = resolveDecision(ledger, {
      decisionId,
      option: input.option,
      ...(input.note !== undefined ? { note: input.note } : {}),
      decidedBy: CLI_DECIDER,
    });
    return {
      schema_version: JSON_SCHEMA_VERSION,
      decision: decisionTextView(r.decision),
      action: r.action,
      work_item_state: r.workItem?.state ?? null,
      enqueued_work_item_ids: r.enqueued.map((w) => w.id),
    };
  } finally {
    db.close();
    lock?.release();
  }
}

/** The CLI error code of a refused decision (`fail` in `./main.ts`). */
export function decisionFailureCode(err: DecisionError): "NOT_FOUND" | "CONFLICT" | "REFUSED" {
  if (err.reason === "UNKNOWN") return "NOT_FOUND";
  return err.reason === "CONFLICT" ? "CONFLICT" : "REFUSED";
}

const UNTRUSTED = "(untrusted client text)";

function renderOne(d: DecisionListItem): string {
  const lines = [
    `${d.decision_id}  ${d.state}  project ${d.project_id}`,
    `  requested by ${d.requester_client_id} at ${d.created_at}; work item ${d.work_item_id ?? "none"}`,
    `  enqueues ${d.enqueue_count} item(s) on resume or reroute`,
    // ADR-0068: controller-normalised URL (no credential, query or fragment); the project does not exist yet.
    ...("onboarding" in d && d.onboarding !== undefined
      ? [`  onboarding: proposes a new project from ${d.onboarding.repository_url}`]
      : []),
    `  question ${UNTRUSTED}: ${d.question.text}`,
  ];
  for (const o of d.options) {
    const recommended = o.option === d.recommended_option ? " (recommended)" : "";
    lines.push(`  ${o.option}. [${o.action}]${recommended} ${o.label.text} ${UNTRUSTED}`);
  }
  if (d.state !== "open") {
    lines.push(`  decided: option ${d.decided_option ?? "-"} by ${d.decided_by} at ${d.decided_at}`);
  }
  if (d.note !== null) lines.push(`  note ${UNTRUSTED}: ${d.note.text}`);
  return `${lines.join("\n")}\n`;
}

export function renderDecisionList(r: DecisionListReport): string {
  return r.decisions.length === 0 ? "No decisions.\n" : r.decisions.map(renderOne).join("");
}

export function renderDecisionDecide(r: DecisionDecideReport): string {
  const ids = r.enqueued_work_item_ids;
  const item = r.work_item_state === null ? "no work item" : `work item now ${r.work_item_state}`;
  const queued = ids.length === 0 ? "nothing enqueued" : `enqueued ${ids.join(", ")}`;
  const head = `decision ${r.decision.decision_id} decided: option ${r.decision.decided_option} (${r.action})`;
  return `${head}; ${item}; ${queued}\n`;
}
