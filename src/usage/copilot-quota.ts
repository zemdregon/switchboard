/**
 * GitHub Copilot quota as a usage-only provider (`copilot`): no run adapter, only the quota GitHub reports for the
 * operator's own account. Read through the operator's logged-in `gh` (`gh api /copilot_internal/user`) with the same
 * runner, allowlisted environment and no-shell rule as the CI port (`src/ci/gh-port.ts`, ADR-0050); Switchboard never
 * reads the token.
 *
 * The endpoint is GitHub-internal and undocumented (Assumption: its shape is the one recorded in
 * `fixtures/copilot-internal-user.free.redacted.json`), so parsing is a closed allowlist and fails soft: any field
 * outside it (login, id, tracking ids, endpoints, organisations, ...) is dropped, a malformed snapshot makes the whole
 * answer `unparseable`, and no `gh` output text ever reaches a reason, a log or an error.
 */
import { ghEnv } from "../ci/gh-argv.js";
import { execGh, GH_EXIT_AUTH_REQUIRED, type GhRunner } from "../ci/gh-port.js";

/** The one `gh` argv this module runs (a constant; nothing in it comes from a caller). */
export const COPILOT_QUOTA_ARGV: readonly string[] = Object.freeze(["api", "/copilot_internal/user"]);
export const COPILOT_QUOTA_VIA = "gh api /copilot_internal/user";
export const COPILOT_PROVIDER = "copilot";
/** Delegated: a bounded wait so a stuck `gh` cannot hold `get_capacity`. */
export const DEFAULT_COPILOT_QUOTA_TIMEOUT_MS = 10_000;
/** Delegated: one `gh` call per minute at most; quota figures move slowly and the endpoint is not ours to load. */
export const DEFAULT_COPILOT_QUOTA_TTL_MS = 60_000;

export type CopilotQuotaId = "premium_interactions" | "chat" | "completions";
export type CopilotQuotaUnit = "premium_requests" | "chat_requests" | "code_completions";

/** One quota snapshot. For an unlimited quota the four figures are null. */
export interface CopilotQuotaWindow {
  id: CopilotQuotaId;
  unit: CopilotQuotaUnit;
  unlimited: boolean;
  entitlement: number | null;
  remaining: number | null;
  used: number | null;
  percent_remaining: number | null;
  overage_count: number;
  overage_permitted: boolean;
  reset_at: string | null;
}

export type ProviderQuotaUnavailableReason =
  | "gh_missing"
  | "auth_required"
  | "gh_failed"
  | "timeout"
  | "unparseable"
  | "no_quota";

export interface ProviderQuotaOk {
  provider: "copilot";
  usage_only: true;
  status: "ok";
  source: "provider_reported";
  via: typeof COPILOT_QUOTA_VIA;
  observed_at: string;
  plan: string | null;
  sku: string | null;
  reset_at: { at: string; source: "provider_reported" } | null;
  quotas: CopilotQuotaWindow[];
}

export interface ProviderQuotaUnavailable {
  provider: "copilot";
  usage_only: true;
  status: "unavailable";
  source: "unknown";
  via: typeof COPILOT_QUOTA_VIA;
  observed_at: string;
  reason: ProviderQuotaUnavailableReason;
}

export type ProviderQuotaReport = ProviderQuotaOk | ProviderQuotaUnavailable;

/** Snapshot keys in output order, with their units. */
const WINDOWS: readonly (readonly [CopilotQuotaId, CopilotQuotaUnit])[] = [
  ["premium_interactions", "premium_requests"],
  ["chat", "chat_requests"],
  ["completions", "code_completions"],
];

/** `copilot_plan` and `access_type_sku` are kept only as short lower-case identifiers. */
const IDENTIFIER = /^[a-z0-9_]{1,64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class Unparseable extends Error {}

function unavailable(reason: ProviderQuotaUnavailableReason, readAt: Date): ProviderQuotaUnavailable {
  return {
    provider: COPILOT_PROVIDER,
    usage_only: true,
    status: "unavailable",
    source: "unknown",
    via: COPILOT_QUOTA_VIA,
    observed_at: readAt.toISOString(),
    reason,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A finite number, or undefined when absent; anything else is unparseable. */
function optNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Unparseable();
  return v;
}

function optBoolean(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Unparseable();
  return v;
}

/** A canonical ISO instant from an ISO string, or null. */
function isoInstant(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 64 || !ISO_INSTANT.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function identifier(v: unknown): string | null {
  return typeof v === "string" && IDENTIFIER.test(v) ? v : null;
}

function resetAt(user: Record<string, unknown>): string | null {
  const utc = isoInstant(user.quota_reset_date_utc);
  if (utc !== null) return utc;
  const d = user.quota_reset_date;
  return typeof d === "string" && ISO_DATE.test(d) ? isoInstant(`${d}T00:00:00.000Z`) : null;
}

function parseWindow(id: CopilotQuotaId, unit: CopilotQuotaUnit, s: unknown, reset: string | null): CopilotQuotaWindow {
  if (!isRecord(s)) throw new Unparseable();
  const unlimited = optBoolean(s.unlimited);
  if (unlimited === undefined) throw new Unparseable();
  const overageCount = optNumber(s.overage_count) ?? 0;
  if (!Number.isInteger(overageCount) || overageCount < 0) throw new Unparseable();
  const base = {
    id,
    unit,
    unlimited,
    overage_count: overageCount,
    overage_permitted: optBoolean(s.overage_permitted) ?? false,
    reset_at: reset,
  };
  if (unlimited) return { ...base, entitlement: null, remaining: null, used: null, percent_remaining: null };
  const entitlement = optNumber(s.entitlement);
  const remainingFloat = optNumber(s.quota_remaining);
  const remainingInt = optNumber(s.remaining);
  const percent = optNumber(s.percent_remaining);
  if (entitlement === undefined || entitlement < 0) throw new Unparseable();
  const raw = remainingFloat ?? remainingInt;
  if (raw === undefined) throw new Unparseable();
  const remaining = round2(raw);
  return {
    ...base,
    entitlement,
    remaining,
    used: Math.max(0, round2(entitlement - remaining)),
    percent_remaining: percent === undefined ? null : round2(percent),
  };
}

/**
 * Pure: the report for one `gh api /copilot_internal/user` stdout read at `readAt`. Only the allowlisted fields are
 * read; anything malformed yields `unparseable`, no snapshot at all `no_quota`.
 */
export function parseCopilotQuota(stdout: string, readAt: Date): ProviderQuotaReport {
  let user: unknown;
  try {
    user = JSON.parse(stdout);
  } catch {
    return unavailable("unparseable", readAt);
  }
  if (!isRecord(user)) return unavailable("unparseable", readAt);
  const snapshots = user.quota_snapshots;
  if (snapshots === undefined || snapshots === null) return unavailable("no_quota", readAt);
  if (!isRecord(snapshots)) return unavailable("unparseable", readAt);
  const reset = resetAt(user);
  const quotas: CopilotQuotaWindow[] = [];
  let observed: string | null = null;
  try {
    for (const [id, unit] of WINDOWS) {
      const s = snapshots[id];
      if (s === undefined || s === null) continue;
      quotas.push(parseWindow(id, unit, s, reset));
      observed ??= isoInstant((s as Record<string, unknown>).timestamp_utc);
    }
  } catch {
    return unavailable("unparseable", readAt);
  }
  if (quotas.length === 0) return unavailable("no_quota", readAt);
  return {
    provider: COPILOT_PROVIDER,
    usage_only: true,
    status: "ok",
    source: "provider_reported",
    via: COPILOT_QUOTA_VIA,
    observed_at: observed ?? readAt.toISOString(),
    plan: identifier(user.copilot_plan),
    sku: identifier(user.access_type_sku),
    reset_at: reset === null ? null : { at: reset, source: "provider_reported" },
    quotas,
  };
}

export interface CopilotQuotaReaderOptions {
  readonly runner?: GhRunner;
  /** `gh` binary (default `gh`, resolved on PATH); `serve` passes `ci_trigger.gh_binary`. */
  readonly binary?: string;
  /** Environment the allowlisted variables are copied from (default `process.env`). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** How long a report (ok or unavailable) is served from memory. */
  readonly ttlMs?: number;
  readonly now?: () => Date;
}

export type CopilotQuotaReader = () => Promise<ProviderQuotaReport>;

/**
 * A reader that runs `gh api /copilot_internal/user` at most once per `ttlMs`; concurrent callers share the one call in
 * flight. Never throws: every failure is an `unavailable` report with a fixed reason.
 */
export function createCopilotQuotaReader(opts: CopilotQuotaReaderOptions = {}): CopilotQuotaReader {
  const runner = opts.runner ?? execGh;
  const binary = opts.binary ?? "gh";
  const sourceEnv = opts.sourceEnv ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COPILOT_QUOTA_TIMEOUT_MS;
  const ttlMs = opts.ttlMs ?? DEFAULT_COPILOT_QUOTA_TTL_MS;
  const now = opts.now ?? (() => new Date());
  let cached: { readonly at: number; readonly report: ProviderQuotaReport } | undefined;
  let inflight: Promise<ProviderQuotaReport> | undefined;

  const read = async (readAt: Date): Promise<ProviderQuotaReport> => {
    try {
      const r = await runner(binary, COPILOT_QUOTA_ARGV, { env: ghEnv(sourceEnv), timeoutMs });
      if (r.notFound === true) return unavailable("gh_missing", readAt);
      if (r.timedOut === true) return unavailable("timeout", readAt);
      if (r.exitCode === GH_EXIT_AUTH_REQUIRED) return unavailable("auth_required", readAt);
      if (r.exitCode !== 0) return unavailable("gh_failed", readAt);
      return parseCopilotQuota(r.stdout, readAt);
    } catch {
      return unavailable("gh_failed", readAt);
    }
  };

  return () => {
    const readAt = now();
    const t = readAt.getTime();
    if (cached !== undefined && t >= cached.at && t - cached.at < ttlMs) return Promise.resolve(cached.report);
    if (inflight !== undefined) return inflight;
    const p = read(readAt).then((report) => {
      cached = { at: t, report };
      inflight = undefined;
      return report;
    });
    inflight = p;
    return p;
  };
}
