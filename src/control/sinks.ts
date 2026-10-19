/**
 * Notification sinks (T14.9; FR-CTL-10, LLD §3.4.1 and §3.4.9, ADR-0048).
 *
 * Operator-configured, off by default: `serve` builds a {@link SinkDispatcher} only when `notification_sinks[]` names at
 * least one sink, so with none no request is ever made. Two kinds, a generic HTTPS webhook (the operator may point it at
 * the Grok bot's deployment-generated webhook; owner decision 53, no Grok-specific code) and ntfy.
 *
 * Closed payload (ADR-0048 item 3): {@link buildNotificationPayload} builds the five `notification_payload` fields from
 * controller-generated values only and refuses anything outside the closed lists: the project id (a configured id
 * pattern, {@link NO_PROJECT_ID} or {@link ALL_PROJECTS_ID}), one `sink_event_kind`, a reason code from the closed list
 * for that kind, a run id (`run_` + ULID) or null, and a link to the configured MCP resource (ADR-0048 item 5; a
 * `switchboard://` placeholder when no HTTP transport is configured). There is no
 * free-text field, so no prompt, objective, summary, diff, log line or agent text can reach a sink.
 *
 * Delivery never affects a run (ADR-0048 item 6): {@link SinkDispatcher.emit} is synchronous, never throws and never
 * awaits; each delivery starts on a later turn of the event loop, has a bounded timeout (5 s, LLD §3.4.9's proposed
 * target) and reports a fixed outcome code to `onOutcome`. Outcomes never carry a URL, topic, token, authorization,
 * payload or an error's own text (a TLS or DNS error names the host), so a caller can log or record them as they are
 * (FR-TEL-03).
 * Events over a sink's `max_per_minute` in a sliding 60 s window are dropped and reported as `rate_limited`, never
 * queued.
 *
 * Delegated (T14.9, T14.14, recorded in LLD §3.4.9): `run_terminal` carries the terminal state as its reason code; a run
 * admitted without a project carries `project_id` `-`; the webhook body is exactly the payload as JSON (carrying an
 * Authorization header when configured, FR-CTL-12); the ntfy sink uses ntfy's JSON publish (POST to the server root
 * with `topic` in the body; ntfy publish docs, "Publish as JSON"), with a fixed title and a message templated from the
 * same closed fields.
 */
import https from "node:https";
import type { NotificationSinkSettings, SinkEventKind } from "../config/notification-sinks.js";
import { PROJECT_ID_PATTERN } from "../config/schema.js";
import { isPrefixedId } from "../ids/index.js";
import { type RunState, WORK_ITEM_STATES, type WorkItemState } from "../ledger/index.js";
import { RUN_STATES } from "../lifecycle/states.js";
import { NEEDS_ATTENTION_PRIORITY, type NeedsAttentionReason } from "./needs-attention.js";
import { STALLED_PROGRESS } from "./progress-stall.js";

/** `project_id` of an event for a run admitted without a project (workspace path only). Not a valid project id. */
export const NO_PROJECT_ID = "-";
/** `project_id` of an event that applies to every project (a global pause, T14.6). Not a valid project id. */
export const ALL_PROJECTS_ID = "*";

/** FR-CTL-03 / LLD §3.4.1 `needs_attention_reason` (seven values; `skill_cleanup_failed` from T16.6). */
export const NEEDS_ATTENTION_REASONS = [
  "awaiting_approval",
  "parked_loop",
  "failed_after_retry",
  "stalled",
  "budget_exhausted",
  "ci_fix_stuck",
  "skill_cleanup_failed",
] as const;
/** ADR-0047 / LLD §3.4.1 `approval_kind`. */
export const APPROVAL_KINDS = ["privileged_scope", "dynamic_project", "push_revision"] as const;

/** The closed reason codes each event kind may carry (ADR-0048 item 3; the run_terminal and pause rows are Delegated). */
export const SINK_REASON_CODES: { readonly [K in SinkEventKind]: readonly string[] } = {
  run_terminal: ["SUCCEEDED", "FAILED", "CANCELLED"],
  needs_attention: NEEDS_ATTENTION_REASONS,
  approval_pending: APPROVAL_KINDS,
  approval_decided: APPROVAL_KINDS,
  budget_exhausted: ["budget_exhausted"],
  project_paused: ["project_paused", "global_paused"],
  queue_low: ["queue_low"],
  digest: ["digest"],
};

/** Reasons a pushed digest counts: the run-level list plus the project-level `stalled_progress` (FR-CTL-14). */
export const DIGEST_ATTENTION_REASONS: readonly (NeedsAttentionReason | typeof STALLED_PROGRESS)[] = [
  ...NEEDS_ATTENTION_PRIORITY,
  STALLED_PROGRESS,
];

/**
 * T14.16 (FR-CTL-14, ADR-0048 item 3 as amended, LLD §20.5): the `counts` object of a `digest` event. Every leaf is a
 * non-negative integer under a key from a closed list; there is no string anywhere in it, so no objective, agent text,
 * decision text, path or id can travel in it. Hold and open-decision counts join when T3.24 and T14.15 build them.
 */
export interface DigestCounts {
  readonly runs_by_state: Readonly<Record<RunState, number>>;
  readonly needs_attention_by_reason: Readonly<Record<(typeof DIGEST_ATTENTION_REASONS)[number], number>>;
  readonly queue_by_state: Readonly<Record<WorkItemState, number>>;
  readonly pending_approvals: number;
  readonly paused_projects: number;
}

const DIGEST_COUNT_GROUPS = {
  runs_by_state: RUN_STATES,
  needs_attention_by_reason: DIGEST_ATTENTION_REASONS,
  queue_by_state: WORK_ITEM_STATES,
} as const;
const DIGEST_COUNT_SCALARS = ["pending_approvals", "paused_projects"] as const;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Exactly the closed keys with integer values, rebuilt key by key; undefined when anything is missing or extra. */
function closedCounts(input: unknown): DigestCounts | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const src = input as Record<string, unknown>;
  const top = [...Object.keys(DIGEST_COUNT_GROUPS), ...DIGEST_COUNT_SCALARS];
  if (Object.keys(src).length !== top.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const [group, keys] of Object.entries(DIGEST_COUNT_GROUPS)) {
    const g = src[group];
    if (typeof g !== "object" || g === null || Object.keys(g).length !== keys.length) return undefined;
    const built: Record<string, number> = {};
    for (const k of keys) {
      const v = (g as Record<string, unknown>)[k];
      if (!isCount(v)) return undefined;
      built[k] = v;
    }
    out[group] = built;
  }
  for (const k of DIGEST_COUNT_SCALARS) {
    if (!isCount(src[k])) return undefined;
    out[k] = src[k];
  }
  return out as unknown as DigestCounts;
}

/** LLD §3.4.1 `notification_payload`: these five fields, plus `counts` on a `digest` event only (ADR-0048 item 3). */
export interface NotificationPayload {
  readonly project_id: string;
  readonly event_kind: SinkEventKind;
  readonly reason_code: string;
  readonly run_id: string | null;
  readonly link: string;
  readonly counts?: DigestCounts;
}

/** What a producer hands the dispatcher: ids and closed codes only (and integer counts for `digest`). */
export interface SinkEvent {
  readonly projectId: string;
  readonly eventKind: SinkEventKind;
  readonly reasonCode: string;
  readonly runId: string | null;
  readonly counts?: DigestCounts;
}

const PROJECT_ID_RE = new RegExp(PROJECT_ID_PATTERN);
const MAX_LINK = 2048;

/**
 * The link of an event (LLD §3.4.9, ADR-0048 item 5): the configured MCP resource URL itself, which names a route this
 * server serves, never a per-run or digest page (none exists) and never a consent-page token. Without an HTTP
 * transport there is no served route, so the link is a `switchboard://run/<run_id>` or `switchboard://digest`
 * placeholder. It carries no token, digest or passphrase.
 */
export function sinkLink(linkBase: string | undefined, runId: string | null): string {
  if (linkBase === undefined) return runId === null ? "switchboard://digest" : `switchboard://run/${runId}`;
  return new URL(linkBase).href;
}

/** The closed payload of an event, or undefined when any field is outside its closed list (the event is dropped). */
export function buildNotificationPayload(
  event: SinkEvent,
  linkBase: string | undefined,
): NotificationPayload | undefined {
  const reasons = SINK_REASON_CODES[event.eventKind] as readonly string[] | undefined;
  if (reasons === undefined || !reasons.includes(event.reasonCode)) return undefined;
  const p = event.projectId;
  if (p !== NO_PROJECT_ID && p !== ALL_PROJECTS_ID && !PROJECT_ID_RE.test(p)) return undefined;
  if (event.runId !== null && !isPrefixedId(event.runId, "run")) return undefined;
  const link = sinkLink(linkBase, event.runId);
  if (link.length > MAX_LINK) return undefined;
  // Fixed key order; built from the checked fields only.
  const base = { project_id: p, event_kind: event.eventKind, reason_code: event.reasonCode, run_id: event.runId, link };
  // T14.16: `counts` exactly on `digest` (required there, refused elsewhere), rebuilt from the closed keys.
  if (event.eventKind !== "digest") return event.counts === undefined ? base : undefined;
  const counts = event.runId === null ? closedCounts(event.counts) : undefined;
  return counts === undefined ? undefined : { ...base, counts };
}

/**
 * Once-per-key emission gate (T14.9): `claim` returns true the first time a key is seen and false after, so a repeated
 * observation (a retried skill removal pass, a second scheduler tick over the same stuck ref) emits once per
 * (run, reason). Keys name only closed ids and codes (a run id, a reason, a project and ref), never agent or
 * request text.
 */
export class OnceGate {
  private readonly seen = new Set<string>();
  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

/** One HTTP request a sink makes. */
export interface SinkRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** Sends one request and resolves with the HTTP status; rejects on a transport error or abort. */
export type SinkPost = (req: SinkRequest) => Promise<number>;

/** The request a sink sends for a payload. Every value comes from the payload or the sink's configuration. */
export function sinkRequestFor(
  sink: NotificationSinkSettings,
  payload: NotificationPayload,
): Omit<SinkRequest, "signal"> {
  if (sink.kind === "webhook") {
    return {
      url: sink.url,
      headers: {
        "content-type": "application/json",
        ...(sink.authorization !== undefined ? { authorization: sink.authorization } : {}),
      },
      body: JSON.stringify(payload),
    };
  }
  const body = {
    topic: sink.topic,
    title: `Switchboard: ${payload.event_kind}`,
    message:
      `project_id=${payload.project_id} reason_code=${payload.reason_code} run_id=${payload.run_id ?? "none"}` +
      (payload.counts === undefined ? "" : ` ${digestCountsLine(payload.counts)}`),
    click: payload.link,
    tags: ["switchboard"],
  };
  return {
    url: sink.url,
    headers: {
      "content-type": "application/json",
      ...(sink.token !== undefined ? { authorization: `Bearer ${sink.token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

/** The ntfy message tail of a digest: `group.key=n` for every non-zero integer, closed keys only. */
function digestCountsLine(counts: DigestCounts): string {
  const parts: string[] = [];
  for (const group of Object.keys(DIGEST_COUNT_GROUPS) as (keyof typeof DIGEST_COUNT_GROUPS)[]) {
    for (const [k, n] of Object.entries(counts[group])) if (n > 0) parts.push(`${group}.${k}=${n}`);
  }
  for (const k of DIGEST_COUNT_SCALARS) parts.push(`${k}=${counts[k]}`);
  return parts.join(" ");
}

/**
 * Default transport: HTTPS only, certificate verification on (Node's default, not overridable here), no redirect
 * followed, no proxy variable read, no connection reuse; the response body is discarded unread.
 */
export const httpsPost: SinkPost = (req) =>
  new Promise<number>((resolve, reject) => {
    const url = new URL(req.url);
    if (url.protocol !== "https:") {
      reject(new Error("refused: not https"));
      return;
    }
    const r = https.request(
      url,
      {
        method: "POST",
        agent: false,
        headers: { ...req.headers, "content-length": String(Buffer.byteLength(req.body)) },
        signal: req.signal,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    r.on("error", reject);
    r.end(req.body);
  });

export type SinkFailureReason = "timeout" | "transport_error" | "http_status" | "rate_limited";

/** One delivery outcome. Never carries a URL, topic, token, payload or error text. */
export interface SinkOutcome {
  readonly sinkId: string;
  readonly eventKind: SinkEventKind;
  readonly runId: string | null;
  readonly ok: boolean;
  readonly reason?: SinkFailureReason;
  /** The HTTP status when `reason` is `http_status`. */
  readonly status?: number;
}

export interface SinkDispatcherOptions {
  readonly sinks: readonly NotificationSinkSettings[];
  /** `transport.http.public_url` when the HTTP transport is configured (link base, LLD §3.4.9). */
  readonly linkBase?: string;
  /** Per-delivery timeout; default {@link DEFAULT_SINK_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Transport; default {@link httpsPost}. Tests substitute a loopback transport. */
  readonly post?: SinkPost;
  /** Called once per delivery attempt or drop. Exceptions it throws are swallowed. */
  readonly onOutcome?: (outcome: SinkOutcome) => void;
  readonly now?: () => number;
}

/** LLD §3.4.9 proposed target. */
export const DEFAULT_SINK_TIMEOUT_MS = 5000;
const WINDOW_MS = 60_000;

export class SinkDispatcher {
  readonly #sinks: readonly NotificationSinkSettings[];
  readonly #linkBase: string | undefined;
  readonly #timeoutMs: number;
  readonly #post: SinkPost;
  readonly #onOutcome: ((o: SinkOutcome) => void) | undefined;
  readonly #now: () => number;
  readonly #sent = new Map<string, number[]>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #aborts = new Set<AbortController>();
  #closed = false;
  /** Events refused by {@link buildNotificationPayload} (outside a closed list). */
  invalidEvents = 0;

  constructor(opts: SinkDispatcherOptions) {
    this.#sinks = opts.sinks;
    this.#linkBase = opts.linkBase;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
    this.#post = opts.post ?? httpsPost;
    this.#onOutcome = opts.onOutcome;
    this.#now = opts.now ?? Date.now;
  }

  /** Sink ids, for a startup log line (never the destinations). */
  get sinkIds(): string[] {
    return this.#sinks.map((s) => s.id);
  }

  /** Queue an event for every sink whose filter accepts it. Synchronous; never throws; never waits for delivery. */
  emit(event: SinkEvent): void {
    try {
      if (this.#closed) return;
      const targets = this.#sinks.filter((s) => s.events.has(event.eventKind));
      if (targets.length === 0) return;
      const payload = buildNotificationPayload(event, this.#linkBase);
      if (payload === undefined) {
        this.invalidEvents += 1;
        return;
      }
      for (const sink of targets) {
        if (!this.#admit(sink)) {
          this.#report({
            sinkId: sink.id,
            eventKind: payload.event_kind,
            runId: payload.run_id,
            ok: false,
            reason: "rate_limited",
          });
          continue;
        }
        const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
          .then(() => this.#deliver(sink, payload))
          .finally(() => this.#inflight.delete(p));
        this.#inflight.add(p);
      }
    } catch {
      // Best effort (ADR-0048 item 6): a sink problem must never reach the caller.
    }
  }

  /** Resolve once every delivery started so far has finished (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  /** Stop accepting events and abort deliveries in flight. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const a of this.#aborts) a.abort();
    await this.drain();
  }

  #admit(sink: NotificationSinkSettings): boolean {
    const now = this.#now();
    const recent = (this.#sent.get(sink.id) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= sink.maxPerMinute) {
      this.#sent.set(sink.id, recent);
      return false;
    }
    recent.push(now);
    this.#sent.set(sink.id, recent);
    return true;
  }

  async #deliver(sink: NotificationSinkSettings, payload: NotificationPayload): Promise<void> {
    const base = { sinkId: sink.id, eventKind: payload.event_kind, runId: payload.run_id };
    if (this.#closed) return;
    const ac = new AbortController();
    this.#aborts.add(ac);
    const timer = setTimeout(() => ac.abort(), this.#timeoutMs);
    timer.unref?.();
    try {
      const status = await this.#post({ ...sinkRequestFor(sink, payload), signal: ac.signal });
      if (status >= 200 && status < 300) this.#report({ ...base, ok: true });
      else this.#report({ ...base, ok: false, reason: "http_status", status });
    } catch {
      // The error's own text is never used: it can name the destination host.
      this.#report({ ...base, ok: false, reason: ac.signal.aborted ? "timeout" : "transport_error" });
    } finally {
      clearTimeout(timer);
      this.#aborts.delete(ac);
    }
  }

  #report(outcome: SinkOutcome): void {
    try {
      this.#onOutcome?.(outcome);
    } catch {
      // A logging or ledger problem must not escape either.
    }
  }
}

/**
 * The `onOutcome` `serve` uses: a failure or drop is logged and, for an event with a run, appended to the ledger as a
 * `sink_delivery_failed` run event (LLD §3.4.9). Both carry the sink id, event kind, reason code and HTTP status only,
 * never the destination, token or payload (NFR-SEC-01, FR-TEL-03). Successes are not recorded.
 */
export function sinkOutcomeRecorder(deps: {
  readonly log: { warn(msg: string, fields?: Record<string, unknown>): void };
  readonly appendRunEvent: (e: { runId: string; type: string; payload: unknown }) => unknown;
}): (o: SinkOutcome) => void {
  return (o) => {
    if (o.ok) return;
    const fields = {
      sink_id: o.sinkId,
      event_kind: o.eventKind,
      reason_code: o.reason,
      ...(o.status !== undefined ? { status: o.status } : {}),
    };
    deps.log.warn("notification sink delivery failed", { ...fields, ...(o.runId !== null ? { run_id: o.runId } : {}) });
    if (o.runId !== null) deps.appendRunEvent({ runId: o.runId, type: "sink_delivery_failed", payload: fields });
  };
}

/** The run-transition notice `serve` receives from the lifecycle (structurally `TransitionNotice`). */
export interface RunTransition {
  readonly runId: string;
  readonly from: string;
  readonly to: string;
  readonly rule: string;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * Sink events for one run transition: `run_terminal` when the run reaches a terminal state, and `approval_decided`
 * (`privileged_scope`) when an operator approval moves it from AWAITING_APPROVAL to QUEUED (FRD T3). Pending and
 * attention events are announced by their own hooks (T14.9, through {@link SinkDispatcher.emit}): `approval_pending`
 * at admission (FRD T2) and at a dynamic-project revision write, and `needs_attention` at the same admission point
 * (`awaiting_approval`), at the loop-breaker park (`parked_loop`), at a successor-cap failure (`failed_after_retry`),
 * at a skill cleanup failure (`skill_cleanup_failed`) and at a fresh CI stuck flag (`ci_fix_stuck`). A budget refusal
 * is already announced as `budget_exhausted`, so it is not announced again as `needs_attention`; stalled runs have no
 * event-time hook (stall is derived on read only).
 */
export function sinkEventsForTransition(t: RunTransition, projectId: string | null | undefined): SinkEvent[] {
  const project = projectId ?? NO_PROJECT_ID;
  const out: SinkEvent[] = [];
  if (t.from === "AWAITING_APPROVAL" && t.to === "QUEUED" && t.rule === "T3") {
    out.push({ projectId: project, eventKind: "approval_decided", reasonCode: "privileged_scope", runId: t.runId });
  }
  if (TERMINAL.has(t.to)) out.push({ projectId: project, eventKind: "run_terminal", reasonCode: t.to, runId: t.runId });
  return out;
}

/**
 * A transition hook for `RunLifecycleOptions.onTransition`: returns at once and looks the run's project up on a later
 * turn of the event loop, outside the transition's transaction, then emits. Never throws.
 */
export function transitionNotifier(
  dispatcher: SinkDispatcher,
  projectOf: (runId: string) => string | null | undefined,
): (t: RunTransition) => void {
  return (t) => {
    setImmediate(() => {
      try {
        for (const e of sinkEventsForTransition(t, projectOf(t.runId))) dispatcher.emit(e);
      } catch {
        // Best effort (ADR-0048 item 6).
      }
    });
  };
}
