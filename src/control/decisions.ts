/**
 * Decision requests (T14.15; FR-CTL-13, FR-CTL-03, FR-CTL-08, FR-CTL-09, FR-CTL-10, FR-QUE-01, LLD §20.3). The logic
 * behind the MCP tools `request_decision`, `list_decisions` and `decide` (`src/mcp/decision-tools.ts`), the operator
 * CLI `switchboard decisions list|decide` (`src/cli/decisions.ts`) and the consent-page link (FR-CTL-09).
 *
 * - **Request.** `requestDecision` records an `open` decision and, when it names a work item, parks that item
 *   (`PARKED_DECISION`, which the §18.7 dequeue never claims) in the same `BEGIN IMMEDIATE` transaction. The item must
 *   be the requester's own, in the decision's project, and PENDING or READY; other items keep running.
 * - **Resolve.** `resolveDecision` closes the decision (compare-and-set from `open`, so a second resolution is
 *   refused `CONFLICT` and applies nothing), applies the chosen option's action to the parked item and inserts the
 *   decision's enqueue list, all in one transaction. The enqueued items carry the requester as `creator_client_id`, so
 *   the scheduler admits them later under the requester's ceiling (FR-QUE-01), never the decider's. Each has the
 *   idempotency key `decision:<decision_id>:<n>`, which the ledger refuses twice: exactly once.
 * - **Text.** The question, the option labels and the note are untrusted client text. They never reach an event, a
 *   sink payload or a log line; only `list_decisions` and the operator CLI return them, labelled
 *   {@link DECISION_UNTRUSTED_LABEL}.
 *
 * Delegated choices (not owner-approved; recorded in LLD §20.3 "As built"):
 * - Actions: `resume` returns the item to the queue and inserts the enqueue list; `reroute` cancels the item and inserts
 *   the list; `cancel` cancels the item and inserts nothing; `none` returns the item to the queue and inserts nothing.
 * - Linus decision (a): no timer, a decision stays open until resolved. `withdrawn` is reserved for the requester or the
 *   operator CLI; this row builds no withdrawal entry point, so nothing writes it yet.
 * - Linus decision (b): the consent link reuses the FR-CTL-09 machinery (`./consent-link.ts`, `./consent-link-page.ts`)
 *   unchanged. Its Approve / Deny form chooses one option per link, so {@link withDecisionLinks} offers one item per
 *   option: Approve decides that option as `consent_link`; Deny writes nothing and leaves the decision open (fail
 *   closed). The page shows controller fields only (decision id, option number, action, recommendation), never the
 *   untrusted text, which the operator reads with `switchboard decisions list`.
 */
import { createHash } from "node:crypto";
import {
  DECISION_ACTIONS,
  type DecisionAction,
  type DecisionOption,
  type DecisionRequestRow,
  type Ledger,
  type WorkItemRow,
} from "../ledger/index.js";
import { canonicalJson } from "../lifecycle/request.js";
import type { ApprovalKind, ApprovalProxyItem } from "./approval-proxy.js";
import { type ConsentApprovalSource, ConsentLinkRefusedError } from "./consent-link.js";

export const MAX_DECISION_QUESTION = 2000;
export const MAX_DECISION_LABEL = 200;
export const MAX_DECISION_NOTE = 2000;
export const MIN_DECISION_OPTIONS = 2;
export const MAX_DECISION_OPTIONS = 6;
/** Work items one decision may enqueue (Assumption, a sanity bound). */
export const MAX_DECISION_ENQUEUE = 8;
/** The label on every piece of decision text a tool returns. */
export const DECISION_UNTRUSTED_LABEL = "untrusted_client_text";
/** `decided_by` of the operator CLI and of the consent page (LLD §20.3); a proxy is `mcp_proxy:<client_id>`. */
export const CLI_DECIDER = "cli";
export const CONSENT_LINK_DECIDER = "consent_link";
/** The needs-attention reason and sink reason code of an open decision (FR-CTL-03 as amended). */
export const AWAITING_DECISION = "awaiting_decision";

/** Why a request or resolution was refused. Nothing was written. */
export type DecisionRefusal = "UNKNOWN" | "CONFLICT" | "INVALID";

export class DecisionError extends Error {
  override readonly name = "DecisionError";
  constructor(
    readonly reason: DecisionRefusal,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** One entry of a decision's enqueue list: the `enqueue_work` request and queue priority. */
export interface DecisionEnqueueItem {
  readonly request: Record<string, unknown>;
  readonly priority?: number;
}

export interface RequestDecisionInput {
  readonly projectId: string;
  readonly workItemId?: string;
  readonly requesterClientId: string;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  readonly recommendedOption: number;
  readonly enqueue?: readonly DecisionEnqueueItem[];
}

/** What the sinks are told about a new decision: the project only (ADR-0048 item 3 as amended). */
export interface DecisionAnnouncement {
  readonly projectId: string;
}

/** Control characters other than tab, line feed and carriage return (an escape sequence must not reach a terminal). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class refuses control characters on purpose
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const hasControl = (s: string): boolean => CONTROL.test(s);

function checkText(value: string, max: number, field: string, allowEmpty = false): void {
  if ((!allowEmpty && value.length === 0) || value.length > max) {
    throw new DecisionError("INVALID", `${field} must have ${allowEmpty ? 0 : 1} to ${max} characters`, field);
  }
  if (hasControl(value)) throw new DecisionError("INVALID", `${field} must not contain control characters`, field);
}

/**
 * Record an open decision and park its work item, in one transaction. The MCP schema already bounds every field; the
 * bounds are checked again here so no other caller can store more. Returns the row.
 */
export function requestDecision(
  ledger: Ledger,
  input: RequestDecisionInput,
  announce?: (a: DecisionAnnouncement) => void,
): DecisionRequestRow {
  checkText(input.question, MAX_DECISION_QUESTION, "question");
  const n = input.options.length;
  if (n < MIN_DECISION_OPTIONS || n > MAX_DECISION_OPTIONS) {
    throw new DecisionError(
      "INVALID",
      `options must list ${MIN_DECISION_OPTIONS} to ${MAX_DECISION_OPTIONS} options`,
      "options",
    );
  }
  input.options.forEach((o, i) => {
    checkText(o.label, MAX_DECISION_LABEL, `options[${i}].label`);
    if (!(DECISION_ACTIONS as readonly string[]).includes(o.action)) {
      throw new DecisionError("INVALID", `options[${i}].action is not a decision action`, `options[${i}].action`);
    }
  });
  if (!Number.isInteger(input.recommendedOption) || input.recommendedOption < 1 || input.recommendedOption > n) {
    throw new DecisionError("INVALID", `recommended_option must name one of the ${n} options`, "recommended_option");
  }
  const enqueue = input.enqueue ?? [];
  if (enqueue.length > MAX_DECISION_ENQUEUE) {
    throw new DecisionError("INVALID", `enqueue lists at most ${MAX_DECISION_ENQUEUE} work items`, "enqueue");
  }
  const row = ledger.immediate(() => {
    if (input.workItemId !== undefined) {
      const item = ledger.getWorkItem(input.workItemId);
      // Another client's item is unknown, as in `cancel_work`.
      if (item === undefined || item.creator_client_id !== input.requesterClientId) {
        throw new DecisionError("UNKNOWN", `unknown work item ${input.workItemId}`, "work_item_id");
      }
      if (item.project_id !== input.projectId) {
        throw new DecisionError("INVALID", "the work item belongs to another project", "work_item_id");
      }
      // Checked before the insert: an item already parked has an open decision (one per item, migration 0030).
      if (item.state !== "PENDING" && item.state !== "READY") {
        throw new DecisionError(
          "INVALID",
          `only a PENDING or READY work item can wait for a decision (this one is ${item.state})`,
          "work_item_id",
        );
      }
    }
    const decision = ledger.insertDecision({
      projectId: input.projectId,
      workItemId: input.workItemId ?? null,
      requesterClientId: input.requesterClientId,
      question: input.question,
      options: input.options,
      recommendedOption: input.recommendedOption,
      enqueue,
    });
    // Same transaction as the state check above, so the park cannot miss; a miss rolls the decision back too.
    if (input.workItemId !== undefined && ledger.parkWorkItem(input.workItemId, decision.id) === undefined) {
      throw new Error(`work item ${input.workItemId} could not be parked`);
    }
    return decision;
  });
  try {
    announce?.({ projectId: row.project_id });
  } catch {
    // Best effort (ADR-0048 item 6): an announcement never changes the request.
  }
  return row;
}

export interface ResolveDecisionInput {
  readonly decisionId: string;
  /** 1-based option number. */
  readonly option: number;
  readonly note?: string;
  /** `cli`, `mcp_proxy:<client_id>` or `consent_link`. */
  readonly decidedBy: string;
  /** Only decisions requested by one of these clients may be resolved; absent means any (the operator). */
  readonly requesters?: ReadonlySet<string>;
}

export interface ResolvedDecision {
  readonly decision: DecisionRequestRow;
  readonly action: DecisionAction;
  readonly workItem: WorkItemRow | undefined;
  readonly enqueued: readonly WorkItemRow[];
}

/** The stored options of a decision. A row the ledger wrote always parses; anything else is refused. */
export function decisionOptions(row: DecisionRequestRow): DecisionOption[] {
  const parsed = JSON.parse(row.options_json) as unknown;
  if (!Array.isArray(parsed)) throw new Error("decision options are unreadable");
  return parsed.map((o) => {
    const { label, action } = o as { label?: unknown; action?: unknown };
    if (typeof label !== "string" || !(DECISION_ACTIONS as readonly string[]).includes(action as string)) {
      throw new Error("decision options are unreadable");
    }
    return { label, action: action as DecisionAction };
  });
}

function decisionEnqueue(row: DecisionRequestRow): DecisionEnqueueItem[] {
  const parsed = JSON.parse(row.enqueue_json) as unknown;
  if (!Array.isArray(parsed)) throw new Error("decision enqueue list is unreadable");
  return parsed as DecisionEnqueueItem[];
}

/**
 * Resolve a decision once: close it, apply the option's action to the parked item and insert the enqueue list, in one
 * transaction. Throws {@link DecisionError} (nothing written) for an unknown or invisible decision (`UNKNOWN`), one that
 * is no longer open (`CONFLICT`) and an option or note out of bounds (`INVALID`).
 */
export function resolveDecision(ledger: Ledger, input: ResolveDecisionInput): ResolvedDecision {
  if (input.note !== undefined) checkText(input.note, MAX_DECISION_NOTE, "note", true);
  return ledger.immediate(() => {
    const row = ledger.getDecision(input.decisionId);
    if (row === undefined || (input.requesters !== undefined && !input.requesters.has(row.requester_client_id))) {
      throw new DecisionError("UNKNOWN", `unknown decision ${input.decisionId}`, "decision_id");
    }
    if (row.state !== "open") {
      throw new DecisionError("CONFLICT", `decision ${row.id} is already ${row.state}; nothing changed`, "decision_id");
    }
    const options = decisionOptions(row);
    const chosen = Number.isInteger(input.option) ? options[input.option - 1] : undefined;
    if (chosen === undefined) {
      throw new DecisionError("INVALID", `option must name one of the ${options.length} options`, "option");
    }
    const decision = ledger.closeDecision({
      id: row.id,
      state: "decided",
      option: input.option,
      decidedBy: input.decidedBy,
      note: input.note === undefined || input.note === "" ? null : input.note,
    });
    if (decision === undefined) {
      throw new DecisionError("CONFLICT", `decision ${row.id} is no longer open; nothing changed`, "decision_id");
    }
    let workItem: WorkItemRow | undefined;
    if (row.work_item_id !== null) {
      const back = chosen.action === "resume" || chosen.action === "none";
      workItem = ledger.unparkWorkItem(row.work_item_id, row.id, back ? "resume" : "cancel");
      // The item is parked for exactly this decision (the unique open index, and cancel_work refuses it).
      if (workItem === undefined) throw new Error(`work item ${row.work_item_id} is not parked`);
    }
    const enqueued: WorkItemRow[] = [];
    if (chosen.action === "resume" || chosen.action === "reroute") {
      decisionEnqueue(row).forEach((entry, i) => {
        enqueued.push(
          ledger.enqueueWorkItem({
            projectId: row.project_id,
            creatorClientId: row.requester_client_id,
            request: { ...entry.request, project: row.project_id }, // LLD §18.2 request_json, as enqueue_work
            sourceKind: "decision",
            sourceId: row.id,
            idempotencyKey: `decision:${row.id}:${i + 1}`,
            priority: entry.priority ?? 0,
          }),
        );
      });
    }
    return { decision, action: chosen.action, workItem, enqueued };
  });
}

// ---- views ------------------------------------------------------------------------------------------------------

export interface UntrustedClientText {
  readonly text: string;
  readonly label: typeof DECISION_UNTRUSTED_LABEL;
}

const untrusted = (text: string): UntrustedClientText => ({ text, label: DECISION_UNTRUSTED_LABEL });

/** A decision without any of its text: what `request_decision`, `decide` and `get_digest` return. */
export function decisionView(row: DecisionRequestRow) {
  const options = decisionOptions(row);
  return {
    decision_id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    state: row.state,
    option_count: options.length,
    recommended_option: row.recommended_option,
    enqueue_count: decisionEnqueue(row).length,
    decided_option: row.decided_option,
    decided_by: row.decided_by,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

/** A decision with its text, every piece labelled untrusted: `list_decisions` and `decisions list --json`. */
export function decisionTextView(row: DecisionRequestRow) {
  return {
    ...decisionView(row),
    requester_client_id: row.requester_client_id,
    question: untrusted(row.question),
    options: decisionOptions(row).map((o, i) => ({ option: i + 1, action: o.action, label: untrusted(o.label) })),
    note: row.note === null ? null : untrusted(row.note),
  };
}

// ---- consent link (FR-CTL-09, Linus decision (b)) ----------------------------------------------------------------

/** Separates the decision id from the option number in a consent item's `approval_id`. */
const OPTION_SEPARATOR = "#";
const CONSENT_ITEM_RE = /^(dec_[0-9A-HJKMNP-TV-Z]{26})#([1-6])$/u;

/**
 * The page prints `kind` as a label and the link store never reads it; this value is never passed to the approval
 * proxy or to a sink, which keep their closed `ApprovalKind` list.
 */
const DECISION_CONSENT_KIND = "decision_request" as unknown as ApprovalKind;

function consentItems(row: DecisionRequestRow): ApprovalProxyItem[] {
  const options = decisionOptions(row);
  const optionsSha256 = createHash("sha256").update(row.options_json).digest("hex");
  return options.map((o, i) => {
    const option = i + 1;
    // Binds the item to the stored options: a link names exactly this option of exactly this decision.
    const bound = {
      v: 1,
      decision_id: row.id,
      option,
      action: o.action,
      options_sha256: optionsSha256,
      created_at: row.created_at,
    };
    const digest = createHash("sha256").update(canonicalJson(bound)).digest("hex");
    const recommended = option === row.recommended_option ? " (recommended)" : "";
    return {
      approval_id: `${row.id}${OPTION_SEPARATOR}${option}`,
      approval_digest: digest,
      kind: DECISION_CONSENT_KIND,
      project_id: row.project_id,
      target_client_id: row.requester_client_id,
      scope_summary:
        `decision ${row.id}: option ${option} of ${options.length}, action ${o.action}${recommended}. ` +
        "Approve chooses this option; Deny leaves the decision open. Read the question and options with " +
        "switchboard decisions list.",
      requested_at: row.created_at,
    };
  });
}

/**
 * The approvals source of the consent page, plus one item per option of every open decision of `clientIds`. The link
 * store and the page are used unchanged; a decision item is decided here, every other item by `inner`.
 */
export function withDecisionLinks(
  inner: ConsentApprovalSource,
  ledger: Ledger,
  clientIds: readonly string[],
): ConsentApprovalSource {
  const openItems = (): ApprovalProxyItem[] => {
    const rows = ledger.listDecisions({ requesterClientIds: [...new Set(clientIds)], states: ["open"], limit: 1000 });
    return rows.flatMap(consentItems);
  };
  const findDecisionItem = (approvalId: string) => {
    const m = CONSENT_ITEM_RE.exec(approvalId);
    if (m === null) return undefined;
    const row = ledger.getDecision(m[1] as string);
    if (row === undefined || row.state !== "open" || !clientIds.includes(row.requester_client_id)) return undefined;
    const item = consentItems(row).find((i) => i.approval_id === approvalId);
    return item === undefined ? undefined : { row, option: Number(m[2]), item };
  };
  return {
    pending: () => [...inner.pending(), ...openItems()],
    find: (approvalId) => (approvalId.startsWith("dec_") ? findDecisionItem(approvalId)?.item : inner.find(approvalId)),
    decide(approvalId, digest, decision) {
      if (!approvalId.startsWith("dec_")) return inner.decide(approvalId, digest, decision);
      const refused = "the decision is no longer open or has changed; nothing changed";
      const found = findDecisionItem(approvalId);
      if (found === undefined || found.item.approval_digest !== digest) throw new ConsentLinkRefusedError(refused);
      if (decision === "deny") return "DENIED"; // the decision stays open (see the module comment)
      try {
        resolveDecision(ledger, { decisionId: found.row.id, option: found.option, decidedBy: CONSENT_LINK_DECIDER });
      } catch (err) {
        if (err instanceof DecisionError) throw new ConsentLinkRefusedError(refused);
        throw err;
      }
      return "APPROVED";
    },
  };
}
