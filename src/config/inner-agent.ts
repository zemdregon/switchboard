/**
 * `inner_agent` configuration (T11.1; FR-INN-01, FR-INN-03, FR-INN-05, FR-INN-16, LLD §13.1, ADR-0016).
 *
 * The schema is strict (an unknown key aborts startup, NFR-SEC-06) and has NO credential field: no key, token, header,
 * password or environment-variable name. A string value that looks like a credential is also refused at load (FR-INN-03,
 * LLD §13.1), using the artifact redactor's secret patterns, and the message never echoes the value.
 *
 * This file lives in `src/config/` (not `src/inner/`) so that `config/schema.ts` and `config/load.ts`, which COMP-POL-side
 * and push-path modules already import, never import the inner-agent service (FR-INN-06, import-boundary test). The
 * service re-exports these types from `src/inner/config.ts`.
 *
 * Defaults are the LLD §13.1 example values, all "proposed targets". With no section, or `enabled: false`, nothing is
 * resolved and every task uses its fallback (FR-INN-01). There is no default backend, model or task.
 *
 * Assumptions (not fixed by the LLD):
 * - bounds: `timeout_ms` 100..600000, `max_concurrency` 1..16, `max_output_tokens` 1..16384, `input_budget_bytes` floor
 *   1024 (LLD) and ceiling 1048576, `breaker.failure_threshold` 1..100, `breaker.open_ms` 1000..3600000,
 *   `suspension.window_calls` 1..10000, `min_calls` 1..window_calls, `rejection_threshold` in (0, 1];
 * - `base_url` is `http://` or `https://` with no userinfo, query or fragment; the Unix-socket form the LLD mentions is
 *   not defined in §13.2 and is left to T11.3, so it is refused until then;
 * - `shares_subscription_with` must be a known config provider id (`configProviderIds()`).
 * - `cli` requires `provider` (only `opencode` is named, FR-INN-04) and refuses `base_url`; `http` requires `base_url` and
 *   refuses `provider`.
 * - A task `timeout_ms` may only be lower than or equal to the backend's (LLD: "may only be lower").
 */
import { DEFAULT_SECRET_PATTERNS, PREFIXED_PATTERNS } from "../artifacts/redact.js";

export const INNER_TASKS = [
  "commit_message",
  "pr_draft",
  "route_features",
  "handoff_condense",
  "log_summary",
  "run_title",
] as const;
export type InnerTask = (typeof INNER_TASKS)[number];

/** Tasks that send repository content, so `allow_source_content` applies (LLD §13.1, §13.5). */
export const SOURCE_CONTENT_TASKS = ["commit_message", "pr_draft", "handoff_condense", "log_summary"] as const;

export const INNER_BACKEND_KINDS = ["http", "cli"] as const;
export type InnerBackendKind = (typeof INNER_BACKEND_KINDS)[number];
export const COMMIT_MESSAGE_MODES = ["draft_if_missing", "always", "never"] as const;
export type CommitMessageMode = (typeof COMMIT_MESSAGE_MODES)[number];
/** The only `cli` provider FR-INN-04 names. */
export const INNER_CLI_PROVIDERS = ["opencode"] as const;

/**
 * Per-project and per-context setting (LLD §13.1, FR-INN-16). There is deliberately no `on`: a project or context can only
 * restrict what the installation-level configuration allows.
 */
export const PROJECT_INNER_SETTINGS = ["off", "local_only", "inherit"] as const;
export type ProjectInnerSetting = (typeof PROJECT_INNER_SETTINGS)[number];

/** Most restrictive first: `off` over `local_only` over `inherit` (LLD §13.1). */
export function mostRestrictiveInnerSetting(
  ...settings: readonly (ProjectInnerSetting | undefined)[]
): ProjectInnerSetting {
  let best: ProjectInnerSetting = "inherit";
  for (const s of settings) {
    if (s === undefined) continue;
    if (PROJECT_INNER_SETTINGS.indexOf(s) < PROJECT_INNER_SETTINGS.indexOf(best)) best = s;
  }
  return best;
}

/** The file shape (snake_case), as written by the operator. */
export interface InnerAgentConfig {
  enabled?: boolean;
  backend?: {
    kind: InnerBackendKind;
    base_url?: string;
    provider?: (typeof INNER_CLI_PROVIDERS)[number];
    model: string;
    timeout_ms?: number;
    max_concurrency?: number;
    allow_remote?: boolean;
    shares_subscription_with?: string | null;
  };
  tasks?: { [T in InnerTask]?: InnerTaskConfig };
  breaker?: { failure_threshold?: number; open_ms?: number };
  suspension?: { window_calls?: number; min_calls?: number; rejection_threshold?: number };
}

export interface InnerTaskConfig {
  enabled?: boolean;
  /** `commit_message` only. */
  mode?: CommitMessageMode;
  /** Tasks in {@link SOURCE_CONTENT_TASKS} only. */
  allow_source_content?: boolean;
  input_budget_bytes?: number;
  max_output_tokens?: number;
  timeout_ms?: number;
}

/** LLD §13.1 example values (all proposed targets). */
export const INNER_DEFAULTS = {
  backend: { timeoutMs: 15_000, maxConcurrency: 2 },
  breaker: { failureThreshold: 3, openMs: 60_000 },
  suspension: { windowCalls: 50, minCalls: 20, rejectionThreshold: 0.4 },
  tasks: {
    commit_message: { inputBudgetBytes: 24_000, maxOutputTokens: 400 },
    pr_draft: { inputBudgetBytes: 48_000, maxOutputTokens: 1200 },
    route_features: { inputBudgetBytes: 8000, maxOutputTokens: 100, timeoutMs: 5000 },
    handoff_condense: { inputBudgetBytes: 32_000, maxOutputTokens: 800 },
    log_summary: { inputBudgetBytes: 32_000, maxOutputTokens: 400 },
    run_title: { inputBudgetBytes: 2000, maxOutputTokens: 80 },
  },
} as const;

const taskProps = (task: InnerTask) => ({
  enabled: { type: "boolean" },
  ...(task === "commit_message" ? { mode: { enum: [...COMMIT_MESSAGE_MODES] } } : {}),
  ...((SOURCE_CONTENT_TASKS as readonly string[]).includes(task) ? { allow_source_content: { type: "boolean" } } : {}),
  input_budget_bytes: { type: "integer", minimum: 1024, maximum: 1_048_576 },
  max_output_tokens: { type: "integer", minimum: 1, maximum: 16_384 },
  timeout_ms: { type: "integer", minimum: 100, maximum: 600_000 },
});

/** The `inner_agent` subschema, embedded in the config schema. No credential property exists anywhere in it. */
export const innerAgentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    backend: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "model"],
      properties: {
        kind: { enum: [...INNER_BACKEND_KINDS] },
        base_url: { type: "string", minLength: 1, maxLength: 2048 },
        provider: { enum: [...INNER_CLI_PROVIDERS] },
        model: { type: "string", minLength: 1, maxLength: 256 },
        timeout_ms: { type: "integer", minimum: 100, maximum: 600_000 },
        max_concurrency: { type: "integer", minimum: 1, maximum: 16 },
        allow_remote: { type: "boolean" },
        shares_subscription_with: { type: ["string", "null"], minLength: 1 },
      },
    },
    tasks: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        INNER_TASKS.map((t) => [t, { type: "object", additionalProperties: false, properties: taskProps(t) }]),
      ),
    },
    breaker: {
      type: "object",
      additionalProperties: false,
      properties: {
        failure_threshold: { type: "integer", minimum: 1, maximum: 100 },
        open_ms: { type: "integer", minimum: 1000, maximum: 3_600_000 },
      },
    },
    suspension: {
      type: "object",
      additionalProperties: false,
      properties: {
        window_calls: { type: "integer", minimum: 1, maximum: 10_000 },
        min_calls: { type: "integer", minimum: 1, maximum: 10_000 },
        rejection_threshold: { type: "number", exclusiveMinimum: 0, maximum: 1 },
      },
    },
  },
} as const;

const SECRET_REGEXES: readonly RegExp[] = [...DEFAULT_SECRET_PATTERNS, ...PREFIXED_PATTERNS].map(
  (re) => new RegExp(re.source, re.flags.replace("g", "")),
);

/** True if a string looks like a credential (best effort, the artifact redactor's patterns). */
export function looksLikeCredential(value: string): boolean {
  return SECRET_REGEXES.some((re) => re.test(value));
}

function collectStrings(value: unknown, at: string, out: { at: string; value: string }[]): void {
  if (typeof value === "string") out.push({ at, value });
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) collectStrings(v, `${at}[${i}]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectStrings(v, `${at}.${k}`, out);
  }
}

/**
 * Cross-field checks the JSON schema cannot express. Returns one line per violation, each starting with its JSON path.
 * Messages never contain the offending value.
 */
export function checkInnerAgent(cfg: InnerAgentConfig | undefined, knownProviderIds: readonly string[]): string[] {
  if (cfg === undefined) return [];
  const errs: string[] = [];
  const at = "$.inner_agent";

  const strings: { at: string; value: string }[] = [];
  collectStrings(cfg, at, strings);
  for (const s of strings) {
    if (looksLikeCredential(s.value)) {
      errs.push(
        `${s.at}: looks like a credential; Switchboard holds none (FR-INN-03, ADR-0003); use an operator-run local gateway`,
      );
    }
  }

  const b = cfg.backend;
  if (cfg.enabled === true && b === undefined)
    errs.push(`${at}.backend: required when enabled is true (no default backend)`);
  if (b !== undefined) {
    const bat = `${at}.backend`;
    if (b.kind === "http") {
      if (b.base_url === undefined) errs.push(`${bat}.base_url: required for the http kind`);
      else errs.push(...checkBaseUrl(b.base_url, `${bat}.base_url`));
      if (b.provider !== undefined) errs.push(`${bat}.provider: valid only for the cli kind`);
    } else {
      if (b.base_url !== undefined) errs.push(`${bat}.base_url: valid only for the http kind`);
      if (b.provider === undefined) errs.push(`${bat}.provider: required for the cli kind`);
    }
    if (b.shares_subscription_with != null && !knownProviderIds.includes(b.shares_subscription_with)) {
      errs.push(`${bat}.shares_subscription_with: must name a configured provider id or be null`);
    }
  }

  const backendTimeout = b?.timeout_ms ?? INNER_DEFAULTS.backend.timeoutMs;
  for (const [name, t] of Object.entries(cfg.tasks ?? {})) {
    if (t?.timeout_ms !== undefined && t.timeout_ms > backendTimeout) {
      errs.push(`${at}.tasks.${name}.timeout_ms: may only be lower than the backend timeout_ms (${backendTimeout})`);
    }
  }
  const s = cfg.suspension;
  if (s?.min_calls !== undefined && s.min_calls > (s.window_calls ?? INNER_DEFAULTS.suspension.windowCalls)) {
    errs.push(`${at}.suspension.min_calls: must not exceed window_calls`);
  }
  return errs;
}

function checkBaseUrl(raw: string, at: string): string[] {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return [`${at}: not a valid URL`];
  }
  const errs: string[] = [];
  if (u.protocol !== "http:" && u.protocol !== "https:") errs.push(`${at}: scheme must be http or https`);
  if (u.username !== "" || u.password !== "")
    errs.push(`${at}: must not carry userinfo (no credential in configuration)`);
  if (u.search !== "" || raw.includes("?")) errs.push(`${at}: must not carry a query string`);
  if (u.hash !== "" || raw.includes("#")) errs.push(`${at}: must not carry a fragment`);
  return errs;
}

/** The resolved, fully defaulted form (camelCase), present only when the operator wrote an `inner_agent` section. */
export interface InnerAgentSettings {
  /** The master switch; false when the section says so or omits `enabled`. */
  readonly enabled: boolean;
  /** Absent only while `enabled` is false and the operator wrote no backend. */
  readonly backend:
    | {
        readonly kind: InnerBackendKind;
        readonly baseUrl: string | undefined;
        readonly provider: string | undefined;
        readonly model: string;
        readonly timeoutMs: number;
        readonly maxConcurrency: number;
        readonly allowRemote: boolean;
        readonly sharesSubscriptionWith: string | null;
      }
    | undefined;
  readonly tasks: { readonly [T in InnerTask]: InnerTaskSettings };
  readonly breaker: { readonly failureThreshold: number; readonly openMs: number };
  readonly suspension: { readonly windowCalls: number; readonly minCalls: number; readonly rejectionThreshold: number };
}

export interface InnerTaskSettings {
  readonly enabled: boolean;
  /** `commit_message` only; `draft_if_missing` there. */
  readonly mode: CommitMessageMode | undefined;
  readonly allowSourceContent: boolean;
  readonly inputBudgetBytes: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number | undefined;
}

/** Resolve a validated section (call {@link checkInnerAgent} first). */
export function resolveInnerAgent(cfg: InnerAgentConfig): InnerAgentSettings {
  const b = cfg.backend;
  const tasks = Object.fromEntries(
    INNER_TASKS.map((t) => {
      const c = cfg.tasks?.[t];
      const d = INNER_DEFAULTS.tasks[t] as { inputBudgetBytes: number; maxOutputTokens: number; timeoutMs?: number };
      const settings: InnerTaskSettings = {
        enabled: c?.enabled === true,
        mode: t === "commit_message" ? (c?.mode ?? "draft_if_missing") : undefined,
        allowSourceContent: c?.allow_source_content === true,
        inputBudgetBytes: c?.input_budget_bytes ?? d.inputBudgetBytes,
        maxOutputTokens: c?.max_output_tokens ?? d.maxOutputTokens,
        timeoutMs: c?.timeout_ms ?? d.timeoutMs,
      };
      return [t, settings];
    }),
  ) as { [T in InnerTask]: InnerTaskSettings };
  return {
    enabled: cfg.enabled === true,
    backend:
      b === undefined
        ? undefined
        : {
            kind: b.kind,
            baseUrl: b.base_url,
            provider: b.provider,
            model: b.model,
            timeoutMs: b.timeout_ms ?? INNER_DEFAULTS.backend.timeoutMs,
            maxConcurrency: b.max_concurrency ?? INNER_DEFAULTS.backend.maxConcurrency,
            allowRemote: b.allow_remote === true,
            sharesSubscriptionWith: b.shares_subscription_with ?? null,
          },
    tasks,
    breaker: {
      failureThreshold: cfg.breaker?.failure_threshold ?? INNER_DEFAULTS.breaker.failureThreshold,
      openMs: cfg.breaker?.open_ms ?? INNER_DEFAULTS.breaker.openMs,
    },
    suspension: {
      windowCalls: cfg.suspension?.window_calls ?? INNER_DEFAULTS.suspension.windowCalls,
      minCalls: cfg.suspension?.min_calls ?? INNER_DEFAULTS.suspension.minCalls,
      rejectionThreshold: cfg.suspension?.rejection_threshold ?? INNER_DEFAULTS.suspension.rejectionThreshold,
    },
  };
}
