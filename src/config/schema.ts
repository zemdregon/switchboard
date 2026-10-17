/**
 * Config JSON Schema (TDD §3.1, FR-OPS-04, NFR-SEC-05). The schema document is the source of truth and is validated by
 * Ajv; `SwitchboardConfig` is hand-written and kept consistent by the tests (TDD §2 allows either mechanism).
 *
 * Proposed (not in the SRS): provider ids are the config ids of the provider registry table (T4.1,
 * `src/adapters/providers.ts`; the seven providers named in AGENTS.md); `weight` is a number in [0, 1]; client ids match `^[a-z0-9][a-z0-9_-]{0,63}$`; concurrency maxima are 64.
 *
 * `mcp_clients[].privileged_approval` (owner decisions 18 and 22, ADR-0019; the key, its values and its default are
 * Delegated): `required` (default) keeps the operator's `approve`/`deny` step for this client's `privileged` requests;
 * `not_required` admits them straight to QUEUED under an approval row written APPROVED by client policy. Only the
 * per-scope approval is lifted: the ceiling, scope validation, scope hash, Git-write denial (FR-GIT-01) and worktree
 * isolation (FR-WS-05) still apply. `load.ts` refuses `not_required` unless the client's ceiling is `privileged`.
 *
 * `mcp_clients[].projects` (T9.2; FR-PRJ-06, LLD §11.1; the fail-closed reading of an absent list is Delegated): the
 * ids of the configured projects the client may use. `load.ts` refuses an id that names no `projects[]` entry. An absent
 * list means no project at all; a request that names a workspace path is unaffected.
 *
 * `mcp_clients[].manage_projects` and `mcp_clients[].max_push_policy` (T9.9; FR-PRJ-10, FRD BR-32, LLD §11.1, ADR-0030):
 * `manage_projects: true` offers the client `create_project`, `update_project` and `delete_project` for dynamic
 * projects (default false: the tools are absent). `max_push_policy` (default `none`) is the widest push policy a dynamic
 * project of this client may declare; `load.ts` refuses it without `manage_projects: true`.
 *
 * `mcp_clients[].approval_proxy` and `mcp_clients[].approval_proxy_targets` (T14.8; FR-CTL-08, ADR-0047, LLD §3.4.8,
 * TDD §3.1): `approval_proxy: true` offers the client `list_pending_approvals` and `decide_approval` (default false: the
 * tools are absent). `approval_proxy_targets` (default: the client itself) lists the client ids whose approvals it may
 * decide; `load.ts` refuses it without `approval_proxy: true` and refuses an id that is not a configured client.
 *
 * `mcp_clients[].tool_profile` (T14.11; FR-CTL-11, LLD §3.4.10): `orchestrator` (default, today's tool set) or `console`
 * (the closed console set; `src/mcp/tool-profile.ts`). `load.ts` refuses `console` with `manage_projects: true`.
 *
 * `providers.claude-code.git_channel` (T9.4b; ADR-0029 item 7, owner decision 36; key and default Delegated): the
 * operator opt-in that lets the Claude Code adapter receive the injected tool channel through a controller-written
 * `--mcp-config` file. Default false (argv unchanged, `commitChannel: "none"`). Accepted only under `claude-code`.
 * Supported for approved privileged bypass runs only (owner decision 2026-10-16, ADR-0033).
 */
import {
  BUILTIN_CONFIG_PROVIDER_IDS,
  type ConfigProviderId,
  configProviderIds,
  providerGeneration,
} from "../adapters/providers.js";
import { MODEL_ID_PATTERN, type ModelConfig } from "../models/registry.js";
import { type BudgetsConfigInput, budgetCapsSchema } from "./budgets.js";
import type { CiTriggerConfigInput } from "./ci-trigger.js";
import { type HttpTransportConfig, httpTransportSchema } from "./http-transport.js";
import {
  type InnerAgentConfig,
  innerAgentSchema,
  PROJECT_INNER_SETTINGS,
  type ProjectInnerSetting,
} from "./inner-agent.js";
import { type NotificationSinkConfig, notificationSinksSchema } from "./notification-sinks.js";
import {
  type ContextRagConfig,
  contextRagSchema,
  type ProjectRagConfig,
  projectRagSchema,
  type RagConfig,
  ragSchema,
} from "./rag.js";

export const TRUST_PROFILES = [
  "inspect-untrusted",
  "edit-untrusted",
  "test-sandboxed",
  "trusted-development",
  "privileged",
] as const;
export type TrustProfile = (typeof TRUST_PROFILES)[number];

/**
 * Config provider ids, derived from the provider registry table (`src/adapters/providers.ts`, T4.1, LLD §2): the
 * built-in entries' config ids in table order. `configSchemaFor` extends the schema with runtime-registered entries.
 */
export const PROVIDER_IDS: readonly ConfigProviderId[] = BUILTIN_CONFIG_PROVIDER_IDS;
export type ProviderId = ConfigProviderId;

export const CONFIG_SCHEMA_VERSION = 1;

/** Assumption (T3.21): adapter preflight is cached for 60 seconds unless `timeouts.preflight_ttl_seconds` says otherwise. */
export const DEFAULT_PREFLIGHT_TTL_SECONDS = 60;

/** `mcp_clients[].privileged_approval` values (ADR-0019). The restrictive value is the default. */
export const PRIVILEGED_APPROVAL_MODES = ["required", "not_required"] as const;
export type PrivilegedApprovalMode = (typeof PRIVILEGED_APPROVAL_MODES)[number];
export const DEFAULT_PRIVILEGED_APPROVAL: PrivilegedApprovalMode = "required";

/** `mcp_clients[].tool_profile` values (FR-CTL-11, LLD §3.4.10). `orchestrator` (today's full set) is the default. */
export const TOOL_PROFILES = ["orchestrator", "console"] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];
export const DEFAULT_TOOL_PROFILE: ToolProfile = "orchestrator";

export interface SwitchboardConfig {
  schema_version: 1;
  data_dir?: string;
  allowed_roots: string[];
  mcp_clients: {
    id: string;
    max_trust_profile: TrustProfile;
    privileged_approval?: PrivilegedApprovalMode;
    /** Ids of the projects this client may use (FR-PRJ-06, T9.2). Absent or empty: no project (workspace paths only). */
    projects?: string[];
    /** T9.9 (FR-PRJ-10): offers create/update/delete_project. Default false. */
    manage_projects?: boolean;
    /** T9.9 (FR-PRJ-10): the widest push policy a dynamic project of this client may declare. Default `none`. */
    max_push_policy?: (typeof PUSH_POLICIES)[number];
    /** T14.8 (FR-CTL-08, ADR-0047): offers list_pending_approvals and decide_approval. Default false. */
    approval_proxy?: boolean;
    /** T14.8: client ids whose pending approvals this proxy may decide. Default: the client itself. */
    approval_proxy_targets?: string[];
    /** T14.11 (FR-CTL-11): `orchestrator` (default) or `console`. */
    tool_profile?: ToolProfile;
  }[];
  /**
   * `min_free_disk_mb` (T3.23, FR-WS-11): the free-disk floor in whole megabytes, off when absent. Below it new runs
   * are held in `QUEUED` (never failed) and an early GC sweep runs; `doctor` reports free space against it.
   */
  limits?: { global_concurrency?: number; per_provider_concurrency?: number; min_free_disk_mb?: number };
  providers?: Partial<
    Record<
      ProviderId,
      { enabled?: boolean; weight?: number; concurrency?: number; git_channel?: boolean; models?: ModelConfig }
    >
  >;
  /** Run retention (NFR-DATA-01, FR-WS-07). `interval` is `<n>m`, `<n>h` or `<n>d` (Proposed form). */
  retention?: { days?: number; interval?: string };
  /** Preflight cache TTL in seconds (NFR-PERF-02, T3.21). 0 disables the cache. */
  timeouts?: { preflight_ttl_seconds?: number };
  /** Per-field profile overrides (FR-POL-01, owner decision 12). `privileged` has none: it comes from its scope. */
  profiles?: Partial<Record<Exclude<TrustProfile, "privileged">, ProfileOverrideConfig>>;
  /** Projects (FR-PRJ-01, LLD §11.1; T9.1). Absent means no projects, and every other command behaves as before. */
  projects?: ProjectConfig[];
  /**
   * Commit-message sanitiser additions (FR-GIT-04, LLD §12.4, TDD §3.1; T9.3). Each pattern is a JavaScript regular
   * expression source in the restricted subset of `src/git/safe-pattern.ts` (at most 16, 200 characters each); a line
   * that matches is removed from the message.
   */
  git?: { sanitize_patterns?: string[] };
  /** Inner agent (M11, T11.1; FR-INN-01, LLD §13.1). Absent means off and nothing else changes. */
  inner_agent?: InnerAgentConfig;
  /** Retrieval index (M12, T12.1; FR-RAG-01, LLD §14.1). Absent, or no `embedding`, means off and nothing else changes. */
  rag?: RagConfig;
  /**
   * Handoff bundle bounds (T5.6; ADR-0038 item 5.5, LLD §15.4). Each key defaults to its LLD value; the defaults are
   * Assumptions (no measurement exists).
   */
  continuity?: { max_bundle_bytes?: number; max_diff_excerpt_bytes?: number; max_text_chars?: number };
  /** Network MCP transport (M13, T13.1; FR-MCP-12, LLD §3.3, ADR-0041). Absent or disabled means stdio only. */
  transport?: { http?: HttpTransportConfig };
  /** Capacity and resilience (M6, T6.2; LLD §16.1, ADR-0043). Every key defaults to its LLD value (Assumptions). */
  capacity?: CapacityConfigInput;
  /** Routing (M7, T7.1; LLD §17.1, ADR-0044). Every key defaults to its LLD value (Assumptions, Q-80). */
  routing?: RoutingConfigInput;
  /**
   * Control plane (M14; LLD §3.4.6). T14.4 reads `budgets` (an absent cap is unlimited, never a provider limit); T14.5
   * reads `loop_breaker`, every key defaulting to its LLD Assumption value.
   */
  control_plane?: ControlPlaneConfigInput;
  /** Notification sinks (M14, T14.9; FR-CTL-10, LLD §3.4.9, ADR-0048). Absent or empty means off: no outbound call. */
  notification_sinks?: NotificationSinkConfig[];
  /** CI-failure trigger (M15, T15.3; FR-QUE-03, LLD §18.6, ADR-0050). Absent or `enabled: false` means no `gh` call. */
  ci_trigger?: CiTriggerConfigInput;
  /** Optional OTLP/HTTP trace destination; absent or empty disables telemetry (LLD §7, T8.1). */
  telemetry?: { otlp_endpoint?: string };
  /**
   * Outer sandbox (T3.1; LLD §8.4, ADR-0051). A profile listed in `required_profiles` is refused at admission unless
   * it can run inside the outer sandbox; absent or empty means nothing changes. `privileged` cannot be listed.
   */
  outer_sandbox?: { required_profiles?: Exclude<TrustProfile, "privileged">[] };
  /**
   * Model groups across providers (M7, T7.13; FR-RTE-10, LLD §17.7, ADR-0055).
   * Ordered lists of `{ provider, model }` pairs under operator-named groups.
   */
  model_groups?: ModelGroupsConfigInput;
}

/** `routing` as written in the config file (LLD §17.1). */
export interface RoutingConfigInput {
  weights?: Partial<Record<"success" | "latency" | "capacity" | "security" | "handoff" | "cost" | "pacing", number>>;
  /** T7.4 (LLD §3.2, §17.1): `idle_ttl` accepts only null until expiry is built (Q-52). */
  affinity?: { enabled?: boolean; low_water_mark?: number | null; min_confidence?: number | null; idle_ttl?: null };
}

/** LLD §17.1 bounds of each `routing.weights` value (Assumption, Q-80); the default of 1 lives in `src/routing/score.ts`. */
export const MAX_ROUTING_WEIGHT = 100;

/** `control_plane` as written in the config file (LLD §3.4.6); `budgets` (T14.4) and `loop_breaker` (T14.5) so far. */
export interface ControlPlaneConfigInput {
  budgets?: BudgetsConfigInput;
  loop_breaker?: {
    identical_failure_threshold?: number;
    stall_minutes?: number;
    max_successors_per_meta_session?: number;
  };
}

/** `capacity` as written in the config file (LLD §16.1). */
export interface CapacityConfigInput {
  window_seconds?: number;
  confidence_runs?: number;
  queue_horizon_seconds?: number;
  breaker?: { failure_threshold?: number; open_seconds?: number };
  retry?: { max_attempts?: number; base_ms?: number; cap_ms?: number };
  /** T6.13 (FR-CAP-09, LLD §16.9, ADR-0055 item 5): operator-declared subscriptions keyed by the operator's label. */
  subscriptions?: Record<string, SubscriptionConfigInput>;
  /** T6.13 (FR-CAP-10, LLD §16.9): pacing parameters; every key defaults to its LLD value (Assumptions, Q-98). */
  pacing?: { mode?: PacingMode; target_fraction?: number; burst_fraction?: number; min_confidence?: number };
}

/** A `capacity.subscriptions.<name>` entry (LLD §16.9): config provider ids sharing 1..4 usage windows. */
export interface SubscriptionConfigInput {
  providers: string[];
  windows: UsageWindowConfigInput[];
}

export interface UsageWindowConfigInput {
  id: string;
  length_seconds: number;
  /** `anchor` (an ISO instant) is required with `fixed` and refused otherwise (checked in `capacity.ts`). */
  reset: { kind: UsageWindowResetKind; anchor?: string };
  budget?: { unit: UsageBudgetUnit; value: number };
}

export const PACING_MODES = ["gate", "score", "off"] as const;
export type PacingMode = (typeof PACING_MODES)[number];
export const USAGE_WINDOW_RESET_KINDS = ["provider_reported", "fixed", "rolling"] as const;
export type UsageWindowResetKind = (typeof USAGE_WINDOW_RESET_KINDS)[number];
export const USAGE_BUDGET_UNITS = ["runs", "reported_tokens", "reported_cost_usd"] as const;
export type UsageBudgetUnit = (typeof USAGE_BUDGET_UNITS)[number];
/** LLD §16.9 name and id shapes and bounds. */
export const SUBSCRIPTION_NAME_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";
export const USAGE_WINDOW_ID_PATTERN = "^[a-z0-9_-]{1,32}$";
export const MIN_SUBSCRIPTION_WINDOW_SECONDS = 60;
export const MAX_SUBSCRIPTION_WINDOW_SECONDS = 2678400;
/** LLD §16.9 pacing defaults (**Assumptions**, Q-98): T, B and the lowest estimate confidence the gate acts on. */
export const DEFAULT_PACING_MODE: PacingMode = "gate";
export const DEFAULT_PACING_TARGET_FRACTION = 0.95;
export const DEFAULT_PACING_BURST_FRACTION = 0.1;
export const DEFAULT_PACING_MIN_CONFIDENCE = 0.5;

/**
 * LLD §16.1 defaults (T6.1; **Assumptions**, no measurement; Q-69 to Q-72). The retry values are LLD §9's proposed
 * targets; a queue horizon of 0 means a run never waits for a provider reset unless the operator opts in (Q-72).
 */
export const DEFAULT_CAPACITY_WINDOW_SECONDS = 3600;
export const DEFAULT_CAPACITY_CONFIDENCE_RUNS = 10;
export const DEFAULT_CAPACITY_QUEUE_HORIZON_SECONDS = 0;
export const DEFAULT_BREAKER_FAILURE_THRESHOLD = 3;
export const DEFAULT_BREAKER_OPEN_SECONDS = 300;
export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_MS = 2000;
export const DEFAULT_RETRY_CAP_MS = 120000;

/**
 * LLD §15.4 defaults and the minimum of `continuity.max_bundle_bytes` (Assumptions, ADR-0038 item 5.5). They equal
 * `DEFAULT_BUNDLE_BOUNDS` and `MIN_BUNDLE_BYTES` of `src/continuity/bundle-schema.ts` (a test keeps them equal).
 */
export const DEFAULT_CONTINUITY_MAX_BUNDLE_BYTES = 65536;
export const MIN_CONTINUITY_MAX_BUNDLE_BYTES = 16384;
export const DEFAULT_CONTINUITY_MAX_DIFF_EXCERPT_BYTES = 32768;
export const DEFAULT_CONTINUITY_MAX_TEXT_CHARS = 2000;
/**
 * Upper limits (Assumption, Delegated, T5.6: the LLD names none). They keep an operator typo from producing a prompt of
 * many megabytes; 1 MiB is 16 times the default bundle.
 */
export const MAX_CONTINUITY_BYTES = 1_048_576;
export const MAX_CONTINUITY_TEXT_CHARS = 65_536;

/** Context kinds delivered in M9 (FR-PRJ-02); any other value fails validation. */
export const CONTEXT_KINDS = ["repository"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];
export const ENVIRONMENT_KINDS = ["host", "container"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];
export const PUSH_POLICIES = ["none", "branch"] as const;

/** LLD §11.1 gives `^[a-z][a-z0-9-]{1,40}$` for project ids. Context ids reuse the shape with a 1 character minimum (Assumption). */
export const PROJECT_ID_PATTERN = "^[a-z][a-z0-9-]{1,40}$";
export const CONTEXT_ID_PATTERN = "^[a-z][a-z0-9-]{0,40}$";
/** Assumption: an OCI-style digest, as in the LLD §11.1 example (`sha256:...`). */
export const IMAGE_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";

export interface EnvironmentConfig {
  kind: EnvironmentKind;
  /** `container` only (M10; shape only in M9). */
  image_digest?: string;
  limits?: { cpus?: number; memory_mb?: number; disk_mb?: number };
}

export interface ContextConfig {
  id: string;
  kind: ContextKind;
  path: string;
  base_ref: string;
  primary?: boolean;
  writable?: boolean;
  push?: { policy: (typeof PUSH_POLICIES)[number]; remote?: string; branch_prefix?: string };
  identity?: { name: string; email: string };
  /** Shape only until T9.10 (FR-GIT-10). */
  sign?: boolean;
  /**
   * T9.7 (FR-GIT-09, FRD BR-30, owner decision 36): opt-in to finalize-only mode. Default false. When true, a successful
   * run whose adapter cannot receive the injected tool channel gets one controller commit at FINALIZING.
   */
  finalize_commit?: boolean;
  /** T11.3 (LLD §13.1, FR-INN-16): `off` or `local_only` restrict the inner agent for runs in this context; default `inherit`. */
  inner_agent?: ProjectInnerSetting;
  /** T12.1 (LLD §14.1, FR-RAG-01): narrowing-only retrieval settings for this context. */
  rag?: ContextRagConfig;
}

export interface ProjectConfig {
  id: string;
  name: string;
  environment?: EnvironmentConfig;
  /** Shape only until T9.2 (FR-PRJ-06 enforcement). */
  max_trust_profile?: TrustProfile;
  allowed_providers?: ProviderId[];
  /** T11.3 (LLD §13.1, FR-INN-16): `off` or `local_only` restrict the inner agent for this project; default `inherit`. */
  inner_agent?: ProjectInnerSetting;
  /** T12.1 (LLD §14.1, FR-RAG-01, 09, 10): narrowing-only retrieval settings; sharing flags default false. */
  rag?: ProjectRagConfig;
  contexts: ContextConfig[];
}

export interface ProfileOverrideConfig {
  file_access?: "read-only" | "worktree";
  shell?: "none" | "allowlist" | "broad";
  shell_allowlist?: string[];
  network?: "off" | "allowlist" | "policy";
  network_allowlist?: string[];
  repo_config?: "disabled" | "approved-only" | "allowlisted";
}

/** `providers.<id>.models` (T4.5, FR-ADP-05, LLD §2.1; shape Delegated). */
const modelsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ids: { type: "array", uniqueItems: true, maxItems: 256, items: { type: "string", pattern: MODEL_ID_PATTERN } },
    aliases: {
      type: "object",
      maxProperties: 256,
      propertyNames: { pattern: MODEL_ID_PATTERN },
      additionalProperties: { type: "string", pattern: MODEL_ID_PATTERN },
    },
    context_limits: {
      type: "object",
      maxProperties: 256,
      propertyNames: { pattern: MODEL_ID_PATTERN },
      additionalProperties: { type: "integer", minimum: 1 },
    },
    capabilities: {
      type: "object",
      maxProperties: 256,
      propertyNames: { pattern: MODEL_ID_PATTERN },
      additionalProperties: { type: "string", enum: ["low", "medium", "high"] },
    },
  },
} as const;

const providerPropsFor = (ids: readonly string[]) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          weight: { type: "number", minimum: 0, maximum: 1 },
          // T6.9 (NFR-PERF-03, LLD §16.1): this provider's slot limit; default `limits.per_provider_concurrency`.
          concurrency: { type: "integer", minimum: 1, maximum: 64 },
          models: modelsSchema,
          // T9.4b (ADR-0029): Claude Code only; any other provider refuses the key (additionalProperties: false).
          ...(id === "claude-code" ? { git_channel: { type: "boolean" } } : {}),
        },
      },
    ]),
  );
const providerProps = providerPropsFor(PROVIDER_IDS);

const stringList = {
  type: "array",
  items: { type: "string", minLength: 1 },
} as const;

/** LLD §17.7 name pattern for operator-configured model groups. */
export const MODEL_GROUP_NAME_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";
export const MAX_MODEL_GROUPS = 32;
export const MAX_GROUP_MEMBERS = 32;

export interface ModelGroupMemberInput {
  provider: ProviderId;
  model: string;
}

export interface ModelGroupInput {
  members: ModelGroupMemberInput[];
}

export type ModelGroupsConfigInput = Record<string, ModelGroupInput>;

/** `model_groups` schema (T7.13; FR-RTE-10, LLD §17.7, ADR-0055). */
const modelGroupsSchemaFor = (ids: readonly string[]) =>
  ({
    type: "object",
    maxProperties: MAX_MODEL_GROUPS,
    propertyNames: { pattern: MODEL_GROUP_NAME_PATTERN },
    additionalProperties: {
      type: "object",
      additionalProperties: false,
      required: ["members"],
      properties: {
        members: {
          type: "array",
          minItems: 1,
          maxItems: MAX_GROUP_MEMBERS,
          uniqueItems: true,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "model"],
            properties: {
              provider: { enum: [...ids] },
              model: { type: "string", pattern: MODEL_ID_PATTERN },
            },
          },
        },
      },
    },
  }) as const;
const profileOverrideSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    file_access: { enum: ["read-only", "worktree"] },
    shell: { enum: ["none", "allowlist", "broad"] },
    shell_allowlist: stringList,
    network: { enum: ["off", "allowlist", "policy"] },
    network_allowlist: stringList,
    repo_config: { enum: ["disabled", "approved-only", "allowlisted"] },
  },
} as const;

const contextSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "path", "base_ref"],
  properties: {
    id: { type: "string", pattern: CONTEXT_ID_PATTERN },
    kind: { enum: [...CONTEXT_KINDS] },
    path: { type: "string", minLength: 1 },
    base_ref: { type: "string", minLength: 1 },
    primary: { type: "boolean" },
    writable: { type: "boolean" },
    push: {
      type: "object",
      additionalProperties: false,
      required: ["policy"],
      properties: {
        policy: { enum: [...PUSH_POLICIES] },
        remote: { type: "string", minLength: 1 },
        branch_prefix: { type: "string", minLength: 1 },
      },
    },
    identity: {
      type: "object",
      additionalProperties: false,
      required: ["name", "email"],
      properties: { name: { type: "string", minLength: 1 }, email: { type: "string", minLength: 3 } },
    },
    sign: { type: "boolean" },
    finalize_commit: { type: "boolean" },
    inner_agent: { enum: [...PROJECT_INNER_SETTINGS] },
    rag: contextRagSchema,
  },
} as const;

/** One `projects[]` entry (LLD §11.1). Also the shape of a dynamic project definition (T9.9, FR-PRJ-10). */
export const projectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "contexts"],
  properties: {
    id: { type: "string", pattern: PROJECT_ID_PATTERN },
    name: { type: "string", minLength: 1 },
    environment: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { enum: [...ENVIRONMENT_KINDS] },
        image_digest: { type: "string", pattern: IMAGE_DIGEST_PATTERN },
        limits: {
          type: "object",
          additionalProperties: false,
          properties: {
            cpus: { type: "number", exclusiveMinimum: 0 },
            memory_mb: { type: "integer", minimum: 1 },
            disk_mb: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    max_trust_profile: { enum: [...TRUST_PROFILES] },
    allowed_providers: { type: "array", uniqueItems: true, items: { enum: [...PROVIDER_IDS] } },
    inner_agent: { enum: [...PROJECT_INNER_SETTINGS] },
    rag: projectRagSchema,
    contexts: { type: "array", minItems: 1, items: contextSchema },
  },
} as const;

/** Defaults (Proposed): 30 days (NFR-DATA-01), GC pass every 24 hours. */
/** `ci_trigger` (T15.3; FR-QUE-03, LLD §18.1, §18.6; types and resolution in `ci-trigger.ts`). */
const ciTriggerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    // 0 turns polling off at the operator level (LLD §18.1); the upper bound is a Proposed sanity limit (one day).
    poll_interval_seconds: { type: "integer", minimum: 0, maximum: 86400 },
    gh_binary: { type: "string", minLength: 1, maxLength: 4096, pattern: "^[^\\s;|&$`<>]+$" },
    use_check_runs_fallback: { type: "boolean" },
    projects: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["project", "client", "template"],
        properties: {
          project: { type: "string", pattern: PROJECT_ID_PATTERN },
          client: { type: "string", minLength: 1 },
          enabled: { type: "boolean" },
          template: {
            type: "object",
            additionalProperties: false,
            required: ["objective", "trust_profile"],
            properties: {
              objective: { type: "string", minLength: 1, maxLength: 32768 },
              trust_profile: { enum: TRUST_PROFILES.filter((p) => p !== "privileged") },
              constraints: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 2000 } },
            },
          },
        },
      },
    },
  },
} as const;

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_RETENTION_INTERVAL = "24h";

export const configSchema = {
  $id: "https://switchboard.invalid/schemas/config.v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Switchboard config",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "allowed_roots", "mcp_clients"],
  properties: {
    schema_version: { const: CONFIG_SCHEMA_VERSION },
    data_dir: { type: "string", minLength: 1 },
    allowed_roots: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
    mcp_clients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "max_trust_profile"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
          max_trust_profile: { enum: [...TRUST_PROFILES] },
          privileged_approval: { enum: [...PRIVILEGED_APPROVAL_MODES] },
          projects: { type: "array", uniqueItems: true, items: { type: "string", pattern: PROJECT_ID_PATTERN } },
          manage_projects: { type: "boolean" },
          max_push_policy: { enum: [...PUSH_POLICIES] },
          approval_proxy: { type: "boolean" },
          approval_proxy_targets: {
            type: "array",
            uniqueItems: true,
            minItems: 1,
            items: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
          },
          tool_profile: { enum: [...TOOL_PROFILES] },
        },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        global_concurrency: { type: "integer", minimum: 1, maximum: 64 },
        per_provider_concurrency: { type: "integer", minimum: 1, maximum: 64 },
        // T3.23 (FR-WS-11): whole megabytes; the upper bound (about 1 PB) is a typo guard (Assumption, Delegated).
        min_free_disk_mb: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
      },
    },
    providers: {
      type: "object",
      additionalProperties: false,
      properties: providerProps,
    },
    retention: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: { type: "integer", minimum: 1, maximum: 3650 },
        interval: { type: "string", pattern: "^[1-9][0-9]{0,5}[mhd]$" },
      },
    },
    timeouts: {
      type: "object",
      additionalProperties: false,
      properties: {
        preflight_ttl_seconds: { type: "integer", minimum: 0, maximum: 3600 },
      },
    },
    projects: { type: "array", items: projectSchema },
    inner_agent: innerAgentSchema,
    rag: ragSchema,
    continuity: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_bundle_bytes: { type: "integer", minimum: MIN_CONTINUITY_MAX_BUNDLE_BYTES, maximum: MAX_CONTINUITY_BYTES },
        max_diff_excerpt_bytes: { type: "integer", minimum: 0, maximum: MAX_CONTINUITY_BYTES },
        max_text_chars: { type: "integer", minimum: 1, maximum: MAX_CONTINUITY_TEXT_CHARS },
      },
    },
    git: {
      type: "object",
      additionalProperties: false,
      properties: {
        sanitize_patterns: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 200 } },
      },
    },
    transport: {
      type: "object",
      additionalProperties: false,
      properties: { http: httpTransportSchema },
    },
    capacity: {
      type: "object",
      additionalProperties: false,
      properties: {
        window_seconds: { type: "integer", minimum: 60, maximum: 604800 },
        confidence_runs: { type: "integer", minimum: 1, maximum: 1000 },
        queue_horizon_seconds: { type: "integer", minimum: 0, maximum: 86400 },
        breaker: {
          type: "object",
          additionalProperties: false,
          properties: {
            failure_threshold: { type: "integer", minimum: 1, maximum: 100 },
            open_seconds: { type: "integer", minimum: 1, maximum: 86400 },
          },
        },
        retry: {
          type: "object",
          additionalProperties: false,
          properties: {
            max_attempts: { type: "integer", minimum: 1, maximum: 10 },
            base_ms: { type: "integer", minimum: 1, maximum: 600000 },
            cap_ms: { type: "integer", minimum: 1, maximum: 3600000 },
          },
        },
        // T6.13 (LLD §16.9): provider ids, the one-subscription rule and the `fixed` anchor are checked in `capacity.ts`.
        subscriptions: {
          type: "object",
          maxProperties: 64,
          propertyNames: { pattern: SUBSCRIPTION_NAME_PATTERN },
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["providers", "windows"],
            properties: {
              providers: {
                type: "array",
                minItems: 1,
                maxItems: 16,
                uniqueItems: true,
                items: { type: "string", minLength: 1 },
              },
              windows: {
                type: "array",
                minItems: 1,
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "length_seconds", "reset"],
                  properties: {
                    id: { type: "string", pattern: USAGE_WINDOW_ID_PATTERN },
                    length_seconds: {
                      type: "integer",
                      minimum: MIN_SUBSCRIPTION_WINDOW_SECONDS,
                      maximum: MAX_SUBSCRIPTION_WINDOW_SECONDS,
                    },
                    reset: {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind"],
                      properties: {
                        kind: { enum: [...USAGE_WINDOW_RESET_KINDS] },
                        anchor: { type: "string", minLength: 1, maxLength: 64 },
                      },
                    },
                    budget: {
                      type: "object",
                      additionalProperties: false,
                      required: ["unit", "value"],
                      properties: {
                        unit: { enum: [...USAGE_BUDGET_UNITS] },
                        value: { type: "number", exclusiveMinimum: 0 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        pacing: {
          type: "object",
          additionalProperties: false,
          properties: {
            mode: { enum: [...PACING_MODES] },
            target_fraction: { type: "number", minimum: 0.5, maximum: 1 },
            burst_fraction: { type: "number", minimum: 0, maximum: 0.5 },
            min_confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
    control_plane: {
      type: "object",
      additionalProperties: false,
      properties: {
        // T14.4 (FR-CTL-06, LLD §3.4.6): operator caps; unset means unlimited. Ranges are in `budgets.ts`.
        budgets: {
          type: "object",
          additionalProperties: false,
          properties: {
            global: budgetCapsSchema,
            projects: {
              type: "object",
              propertyNames: { pattern: PROJECT_ID_PATTERN },
              additionalProperties: budgetCapsSchema,
            },
          },
        },
        // LLD §3.4.6 lower bounds; the upper bounds are Proposed sanity limits (T14.5, Delegated).
        loop_breaker: {
          type: "object",
          additionalProperties: false,
          properties: {
            identical_failure_threshold: { type: "integer", minimum: 2, maximum: 100 },
            stall_minutes: { type: "integer", minimum: 1, maximum: 10080 },
            max_successors_per_meta_session: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    routing: {
      type: "object",
      additionalProperties: false,
      properties: {
        weights: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            ["success", "latency", "capacity", "security", "handoff", "cost", "pacing"].map((t) => [
              t,
              { type: "number", minimum: 0, maximum: MAX_ROUTING_WEIGHT },
            ]),
          ),
        },
        affinity: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            low_water_mark: { type: ["number", "null"], minimum: 0, maximum: 1 },
            min_confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
            idle_ttl: { type: "null" },
          },
        },
      },
    },
    model_groups: modelGroupsSchemaFor(PROVIDER_IDS),
    notification_sinks: notificationSinksSchema,
    ci_trigger: ciTriggerSchema,
    telemetry: {
      type: "object",
      additionalProperties: false,
      properties: { otlp_endpoint: { type: "string" } },
    },
    profiles: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        TRUST_PROFILES.filter((p) => p !== "privileged").map((p) => [p, profileOverrideSchema]),
      ),
    },
    outer_sandbox: {
      type: "object",
      additionalProperties: false,
      properties: {
        required_profiles: {
          type: "array",
          uniqueItems: true,
          items: { enum: TRUST_PROFILES.filter((p) => p !== "privileged") },
        },
      },
    },
  },
} as const;

/**
 * The config schema for the given config provider ids (T4.1): {@link configSchema} with `providers` and
 * `projects[].allowed_providers` rebuilt from `ids`; every other part is the same object structure. With the built-in
 * ids it is deep-equal to {@link configSchema}.
 */
export function configSchemaFor(ids: readonly string[]): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: a structural copy of a JSON schema document, edited at two known paths
  const schema = structuredClone(configSchema) as any;
  schema.properties.providers.properties = providerPropsFor(ids);
  schema.properties.projects.items.properties.allowed_providers.items.enum = [...ids];
  schema.properties.model_groups = modelGroupsSchemaFor(ids);
  return schema as Record<string, unknown>;
}

/**
 * The schema config validation uses now: {@link configSchema} while no provider is registered at runtime, else
 * {@link configSchemaFor} over every registered config id. `generation` changes whenever that set changes.
 */
export function currentConfigSchema(): { readonly generation: number; readonly schema: Record<string, unknown> } {
  const generation = providerGeneration();
  return { generation, schema: generation === 0 ? configSchema : configSchemaFor(configProviderIds()) };
}
