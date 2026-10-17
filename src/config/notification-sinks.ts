/**
 * `notification_sinks[]` configuration (T14.9, T14.14; FR-CTL-10, FR-CTL-12, LLD §3.4.9, ADR-0048 items 1, 2, 4 and 7).
 *
 * Off when absent or empty: no sink is resolved and no outbound notification is ever made. The schema is strict (an
 * unknown key aborts startup, NFR-SEC-06). A webhook URL, webhook authorization, ntfy server, topic and token are
 * operator configuration that may grant write access to the destination, so every message here names the key and never
 * echoes a value (FR-TEL-03).
 *
 * Delegated (T14.9, fail closed; key names are LLD §3.4.9's):
 * - `url` (webhook) and `ntfy.server` must be `https://` with no userinfo, query or fragment (ADR-0048 item 7: HTTPS
 *   only, certificate verification on). Plain HTTP is refused even for loopback.
 * - `authorization` (webhook, FR-CTL-12), when set, is sent as the `Authorization` header to the webhook destination.
 * - `ntfy.topic` follows ntfy's topic name rule (`[-_A-Za-z0-9]{1,64}`, ntfy publish docs); `ntfy.token`, when set, is
 *   sent as `Authorization: Bearer` to the ntfy server only.
 * - `events` defaults to every `sink_event_kind`; at least one, no repeats.
 * - `max_per_minute` defaults to 10 (**Assumption**, no source; LLD §3.4.9 names no default); at most 600.
 * - At most 8 sinks (**Assumption**), each `id` once.
 */

/** LLD §3.4.1 `sink_event_kind`: the closed list of events a sink can receive. */
export const SINK_EVENT_KINDS = [
  "run_terminal",
  "needs_attention",
  "approval_pending",
  "approval_decided",
  "budget_exhausted",
  "project_paused",
  "queue_low",
] as const;
export type SinkEventKind = (typeof SINK_EVENT_KINDS)[number];

export const SINK_KINDS = ["webhook", "ntfy"] as const;
export type SinkKind = (typeof SINK_KINDS)[number];

/** Assumptions (Delegated, T14.9); see the module comment. */
export const DEFAULT_SINK_MAX_PER_MINUTE = 10;
export const MAX_SINK_MAX_PER_MINUTE = 600;
export const MAX_NOTIFICATION_SINKS = 8;
export const NTFY_TOPIC_PATTERN = "^[-_A-Za-z0-9]{1,64}$";
export const SINK_ID_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";

/** One `notification_sinks[]` entry as written in the config file (LLD §3.4.9). */
export interface NotificationSinkConfig {
  id: string;
  kind: SinkKind;
  url?: string;
  authorization?: string;
  ntfy?: { server: string; topic: string; token?: string };
  events?: SinkEventKind[];
  max_per_minute?: number;
}

export const notificationSinksSchema = {
  type: "array",
  maxItems: MAX_NOTIFICATION_SINKS,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "kind"],
    properties: {
      id: { type: "string", pattern: SINK_ID_PATTERN },
      kind: { enum: [...SINK_KINDS] },
      url: { type: "string", minLength: 1, maxLength: 2048 },
      authorization: { type: "string", minLength: 1, maxLength: 512 },
      ntfy: {
        type: "object",
        additionalProperties: false,
        required: ["server", "topic"],
        properties: {
          server: { type: "string", minLength: 1, maxLength: 2048 },
          topic: { type: "string", pattern: NTFY_TOPIC_PATTERN },
          token: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      events: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...SINK_EVENT_KINDS] } },
      max_per_minute: { type: "integer", minimum: 1, maximum: MAX_SINK_MAX_PER_MINUTE },
    },
  },
} as const;

/** A resolved sink. `url` is the full delivery URL (the ntfy server's root for `ntfy`); never log this object. */
export interface NotificationSinkSettings {
  readonly id: string;
  readonly kind: SinkKind;
  readonly url: string;
  /** `webhook` only, when configured (FR-CTL-12). */
  readonly authorization?: string;
  /** `ntfy` only. */
  readonly topic?: string;
  /** `ntfy` only, when configured. */
  readonly token?: string;
  readonly events: ReadonlySet<SinkEventKind>;
  readonly maxPerMinute: number;
}

/** Problems with an https URL, or none. Never includes the URL itself. */
function httpsProblems(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return ["not a valid URL"];
  }
  const errs: string[] = [];
  if (url.protocol !== "https:") errs.push("must use https (ADR-0048 item 7)");
  if (url.username !== "" || url.password !== "") errs.push("must not contain userinfo");
  if (url.search !== "" || url.hash !== "") errs.push("must not have a query or fragment");
  return errs;
}

/** Semantic checks beyond the schema; messages name the key and never echo a configured value. */
export function checkNotificationSinks(sinks: readonly NotificationSinkConfig[] | undefined): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const [i, s] of (sinks ?? []).entries()) {
    const at = `$.notification_sinks[${i}]`;
    if (seen.has(s.id)) errs.push(`${at}.id: used by more than one sink`);
    seen.add(s.id);
    if (s.kind === "webhook") {
      if (s.url === undefined) errs.push(`${at}.url: required for kind webhook`);
      else for (const p of httpsProblems(s.url)) errs.push(`${at}.url: ${p}`);
      if (s.ntfy !== undefined) errs.push(`${at}.ntfy: only for kind ntfy`);
    } else {
      if (s.ntfy === undefined) errs.push(`${at}.ntfy: required for kind ntfy`);
      else for (const p of httpsProblems(s.ntfy.server)) errs.push(`${at}.ntfy.server: ${p}`);
      if (s.url !== undefined) errs.push(`${at}.url: only for kind webhook`);
      if (s.authorization !== undefined) errs.push(`${at}.authorization: only for kind webhook`);
    }
  }
  return errs;
}

/** Resolve a checked list (call {@link checkNotificationSinks} first). Empty means off: no request is ever made. */
export function resolveNotificationSinks(
  sinks: readonly NotificationSinkConfig[] | undefined,
): NotificationSinkSettings[] {
  return (sinks ?? []).map((s) => {
    const common = {
      id: s.id,
      kind: s.kind,
      events: new Set(s.events ?? SINK_EVENT_KINDS),
      maxPerMinute: s.max_per_minute ?? DEFAULT_SINK_MAX_PER_MINUTE,
    };
    if (s.kind === "webhook") {
      return {
        ...common,
        url: new URL(s.url as string).href,
        ...(s.authorization !== undefined ? { authorization: s.authorization } : {}),
      };
    }
    const n = s.ntfy as NonNullable<NotificationSinkConfig["ntfy"]>;
    // JSON publish goes to the server's root (ntfy publish docs, "Publish as JSON"); a sub-path install keeps its path.
    const server = new URL(n.server);
    if (!server.pathname.endsWith("/")) server.pathname += "/";
    return { ...common, url: server.href, topic: n.topic, ...(n.token !== undefined ? { token: n.token } : {}) };
  });
}
