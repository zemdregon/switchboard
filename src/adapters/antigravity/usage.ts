/**
 * Antigravity provider-reported usage (T6.20; FR-CAP-13, BR-50, LLD §16.10, ADR-0082 on the ADR-0079 reader, answers
 * Q-101).
 *
 * Source: `agy -p "/usage" --output-format json` and `agy -p "/credits" --output-format json`, recorded on `agy` 1.4.3
 * (fixtures in `fixtures/usage/`). The `agy` changelog says print mode answers these read-only slash commands "without
 * starting an agent turn, spending quota, or leaving a conversation behind"; the recordings show `num_turns` 0, zero
 * tokens and an empty `conversation_id`. `/quota` is an alias of `/usage` (same payload).
 *
 * The CLI uses its own login; Switchboard reads its stdout only and never reads `~/.gemini` (ADR-0003). Signed out,
 * `/usage` prints a sign-in URL and waits for a code (recorded with an empty `HOME`; [LIVE] C6, C13), so it runs only
 * after the adapter's own `authPreflight` (`agy models`, which never starts a sign-in) reports `OK`.
 *
 * Every field is validated: an unknown shape is `unknown` with a reason, never a guessed figure (fail closed,
 * NFR-SEC-06).
 */
import type { ProviderUsageCredits, ProviderUsageResult, ProviderUsageWindow } from "../provider-usage.js";
import { safeExcerpt } from "../provider-usage.js";
import type { AuthResult, ProbeRunner } from "../types.js";

/** `agy` print-mode usage command (recorded 1.4.3). */
export const AGY_USAGE_ARGS: readonly string[] = ["-p", "/usage", "--output-format", "json"];
/** `agy` print-mode AI-credit balance command (recorded 1.4.3). */
export const AGY_CREDITS_ARGS: readonly string[] = ["-p", "/credits", "--output-format", "json"];
export const AGY_USAGE_METHOD = 'agy -p "/usage" --output-format json';
/** Proposed: a recorded call took about 2.4 s; a sign-in wait would take 60 s, so this bound also cuts that short. */
export const AGY_USAGE_TIMEOUT_MS = 20_000;

/**
 * Window kinds as printed in `buckets[].window` (recorded: `5h`, `weekly`). The bucket descriptions say "5-hour limit"
 * and "weekly limit"; any other kind keeps `window_seconds` null.
 */
export const AGY_WINDOW_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  "5h": 5 * 3600,
  weekly: 7 * 24 * 3600,
});

const MAX_WINDOWS = 64;
/** A bucket id or window kind as one safe token. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
/** Own-property read: keys on Object.prototype or `__proto__` are never read as fields. */
const own = (o: Json | undefined, key: string): unknown =>
  o !== undefined && Object.hasOwn(o, key) ? o[key] : undefined;
/** Printable text only, bounded; undefined when empty. */
const text = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = safeExcerpt(v, 120);
  return s === "" ? undefined : s;
};
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** The last stdout line that parses as a JSON object (print mode prints one). */
function lastJsonObject(stdout: string): Json | undefined {
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = obj(JSON.parse(lines[i] as string));
      if (v !== undefined) return v;
    } catch {
      // Not JSON; try the previous line.
    }
  }
  return undefined;
}

/** The `command.data` of a successful print-mode answer to `name`, or a reason it is not one. */
function commandData(stdout: string, name: string): { data: Json } | { reason: string } {
  const doc = lastJsonObject(stdout);
  if (doc === undefined) return { reason: "no JSON result on stdout" };
  const status = own(doc, "status");
  if (status !== "SUCCESS") {
    const error = text(own(doc, "error"));
    return { reason: `status ${text(status) ?? "missing"}${error !== undefined ? `: ${error}` : ""}` };
  }
  if (own(doc, "num_turns") !== 0) return { reason: "the answer started an agent turn" };
  const command = obj(own(doc, "command"));
  if (own(command, "name") !== name) return { reason: `no ${name} command payload` };
  const data = obj(own(command, "data"));
  return data === undefined ? { reason: `no ${name} command data` } : { data };
}

/**
 * One bucket as a window. `id` is the provider's bucket id (unique across groups in the recording); `limit_id` is the
 * name of the group of models that share the bucket, the provider's metered unit (see the fixtures for both).
 */
function parseBucket(bucket: unknown, group: string | null): ProviderUsageWindow | undefined {
  const b = obj(bucket);
  const id = own(b, "id");
  const kind = own(b, "window");
  const remaining = own(b, "remaining_fraction");
  const reset = own(b, "reset_time");
  if (typeof id !== "string" || !TOKEN_RE.test(id)) return undefined;
  if (typeof kind !== "string" || !TOKEN_RE.test(kind)) return undefined;
  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) return undefined;
  let resetsAt: string | null = null;
  if (reset !== undefined) {
    const ms = typeof reset === "string" ? Date.parse(reset) : Number.NaN;
    if (!Number.isFinite(ms)) return undefined;
    resetsAt = new Date(ms).toISOString();
  }
  const value = round6(remaining);
  return {
    id,
    limit_id: group,
    window_seconds: Object.hasOwn(AGY_WINDOW_SECONDS, kind) ? (AGY_WINDOW_SECONDS[kind] as number) : null,
    used_fraction: round6(1 - value),
    remaining_fraction: value,
    resets_at: resetsAt,
  };
}

/**
 * Windows from `agy -p "/usage" --output-format json` stdout: `command.data.groups[].buckets[]`, each with `id`,
 * `window`, `remaining_fraction` in [0, 1] and `reset_time`. A bucket that fails validation is dropped; no valid bucket
 * at all is a reason.
 */
export function parseAgyUsage(stdout: string): { windows: ProviderUsageWindow[] } | { reason: string } {
  const r = commandData(stdout, "usage");
  if ("reason" in r) return r;
  const groups = own(r.data, "groups");
  if (!Array.isArray(groups)) return { reason: "usage payload has no groups" };
  const windows: ProviderUsageWindow[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const go = obj(g);
    const buckets = own(go, "buckets");
    if (!Array.isArray(buckets)) continue;
    const group = text(own(go, "name")) ?? null;
    for (const b of buckets) {
      const w = parseBucket(b, group);
      if (w === undefined || seen.has(w.id) || windows.length >= MAX_WINDOWS) continue;
      seen.add(w.id);
      windows.push(w);
    }
  }
  return windows.length === 0 ? { reason: "usage payload has no valid bucket" } : { windows };
}

/** The AI-credit balance from `agy -p "/credits" --output-format json` (`command.data.remaining_credits`). */
export function parseAgyCredits(stdout: string): ProviderUsageCredits | undefined {
  const r = commandData(stdout, "credits");
  if ("reason" in r) return undefined;
  const v = own(r.data, "remaining_credits");
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return { has_credits: v > 0, unlimited: false, balance: String(v) };
}

/**
 * Reads the report: `authPreflight` first (no sign-in is ever started), then `/usage` and `/credits` in parallel. Only
 * `/usage` decides whether figures exist; a missing credit balance only leaves `credits` null. The CLI reports no
 * plan and no limit-reached flag, so both are null (a remaining fraction of 0 is shown as reported, not judged).
 */
export async function readAgyUsage(
  argv0: readonly string[],
  runner: ProbeRunner,
  authPreflight: () => Promise<AuthResult>,
  now: Date,
  cwd: string,
): Promise<ProviderUsageResult> {
  const at = now.toISOString();
  const unknown = (error: string): ProviderUsageResult => ({
    provider: "antigravity",
    source: "unknown",
    observed_at: at,
    method: AGY_USAGE_METHOD,
    error,
  });
  const auth = await authPreflight();
  if (auth.state === "AUTH_REQUIRED") return unknown(`agy is not signed in; run \`${auth.loginCommand}\` to sign in`);
  if (auth.state !== "OK") return unknown(safeExcerpt(auth.reason));
  const opts = { cwd, timeoutMs: AGY_USAGE_TIMEOUT_MS };
  const [usage, credits] = await Promise.all([
    runner([...argv0, ...AGY_USAGE_ARGS], opts),
    runner([...argv0, ...AGY_CREDITS_ARGS], opts),
  ]);
  if (usage.spawnError !== undefined) return unknown("agy could not be started");
  if (usage.timedOut) return unknown("agy /usage timed out");
  const parsed = parseAgyUsage(usage.stdout);
  if ("reason" in parsed) return unknown(`agy /usage exit ${usage.exitCode}: ${parsed.reason}`);
  const balance = credits.spawnError === undefined && !credits.timedOut ? parseAgyCredits(credits.stdout) : undefined;
  return {
    provider: "antigravity",
    source: "provider_reported",
    observed_at: at,
    method: AGY_USAGE_METHOD,
    plan: null,
    limit_reached: null,
    limit_reached_type: null,
    windows: parsed.windows,
    credits: balance ?? null,
  };
}
