/**
 * Claude Code subscription usage windows from `rate_limit_event` (ADR-0079; FR-CAP-13, FR-CAP-09, BR-50).
 *
 * Captured 2026-10-21 on Claude Code 2.1.294 (`docs/research/claude-usage-capture-2026-10-21.md`): every
 * `--output-format stream-json` run emits one `rate_limit_event`, `status: "allowed"` included, whose `rate_limit_info`
 * carries `unifiedWindows.<window>.utilization` (used share, 0 to 1) and `.resetsAt` (Unix seconds) for the account's
 * `five_hour` and `seven_day` windows. These are the figures the CLI's own `/usage` command prints. The CLI reads them
 * with its own login; Switchboard only reads the CLI's stdout (ADR-0003).
 *
 * A top-level `utilization` with a `rateLimitType` (the shape the CLI bundle builds when no `unifiedWindows` is
 * present) is read as that one window. Nothing here is computed or estimated: a value that is not a finite number in
 * range, or a window name outside the bounded pattern, is dropped.
 */

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;

/** Window names become metric key prefixes; bounded so a provider value cannot mint arbitrary keys. */
const WINDOW_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** At most this many windows are read from one event (Assumption: the capture shows two). */
export const MAX_USAGE_WINDOWS = 8;

/** Metric key of a window's used share (0 to 1). */
export const usedFractionKey = (window: string): string => `${window}_used_fraction`;
/** Metric key of a window's reset time (ISO 8601). */
export const resetsAtKey = (window: string): string => `${window}_resets_at`;

/** Windows whose length is known from the capture: these are the only ones declared in `USAGE_KEYS`. */
export const CLAUDE_USAGE_WINDOWS: readonly { readonly id: string; readonly lengthSeconds: number }[] = Object.freeze([
  Object.freeze({ id: "five_hour", lengthSeconds: 5 * 3600 }),
  Object.freeze({ id: "seven_day", lengthSeconds: 7 * 24 * 3600 }),
]);

function resetIso(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  const d = new Date(v * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

function utilization(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
}

/**
 * `usage` metrics from one `rate_limit_info`, or `undefined` when it reports no window figure. Each window yields
 * `<window>_used_fraction` and, when present, `<window>_resets_at`.
 */
export function claudeUsageMetrics(info: unknown): Record<string, number | string> | undefined {
  const i = obj(info);
  if (i === undefined) return undefined;
  const out: Record<string, number | string> = {};
  let n = 0;
  const take = (name: string, used: unknown, resets: unknown) => {
    if (n >= MAX_USAGE_WINDOWS || !WINDOW_NAME.test(name)) return;
    const u = utilization(used);
    if (u === undefined) return;
    out[usedFractionKey(name)] = u;
    const r = resetIso(resets);
    if (r !== undefined) out[resetsAtKey(name)] = r;
    n += 1;
  };
  const windows = obj(i.unifiedWindows);
  if (windows !== undefined) {
    for (const [name, w] of Object.entries(windows)) take(name, obj(w)?.utilization, obj(w)?.resetsAt);
  } else if (typeof i.rateLimitType === "string") {
    take(i.rateLimitType, i.utilization, i.resetsAt);
  }
  return n === 0 ? undefined : out;
}
