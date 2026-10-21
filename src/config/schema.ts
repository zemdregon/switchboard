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
 * `approval_proxy_kinds` (ADR-0068; default: all three kinds, as before) narrows which approval kinds the proxy lists
 * and decides; `load.ts` refuses it without `approval_proxy: true`.
 *
 * `project_sources` (ADR-0068; FR-PRJ-10 note 2026-10-20): where `create_project` / `update_project` may clone a
 * repository given as `clone_url`. Absent means no clone (fail closed). `clone_root` must be absolute and under an
 * allowed root; `allowed_hosts` defaults to `["github.com"]`; `allowed_owners` is required and non-empty, matched
 * case-insensitively. `load.ts` checks what the schema cannot.
 *
 * `mcp_clients[].tool_profile` (T14.11; FR-CTL-11, LLD §3.4.10): `orchestrator` (default, today's tool set) or `console`
 * (the closed console set; `src/mcp/tool-profile.ts`). `load.ts` refuses `console` with `manage_projects: true`.
 *
 * `providers.claude-code.git_channel` (T9.4b; ADR-0029 item 7, owner decision 36; key and default Delegated): the
 * operator opt-in that lets the Claude Code adapter receive the injected tool channel through a controller-written
 * `--mcp-config` file. Default false (argv unchanged, `commitChannel: "none"`). Accepted only under `claude-code`.
 * Supported for approved privileged bypass runs only (owner decision 2026-10-16, ADR-0033).
 *
 * `skills`, `projects[].skills` and `mcp_clients[].skills` (T16.3; FR-SKL-03, FR-SKL-04, FR-SKL-08, LLD §19.3): off
 * unless `skills.enabled` is true. An absent section is the same as `enabled: false` and changes nothing else.
 * `skills.allow_draft_in_trusted` defaults to false (Q-105, Delegated). Limit ranges are Delegated (LLD §19.3 names
 * defaults only) and live in `src/skills/limits.ts`. A name that does not resolve is not a startup failure.
 * `projects[].skills` is on the configuration-file project only: a dynamic project definition (`projectSchema`) has
 * no `skills` key, the same split as `dependency_seeds` (Delegated).
 */
import {
  BUILTIN_CONFIG_PROVIDER_IDS,
  type ConfigProviderId,
  configProviderIds,
  providerEntries,
  providerGeneration,
} from "../adapters/providers.js";
import { MODEL_ID_PATTERN, type ModelConfig } from "../models/registry.js";
import {
  MAX_MAX_BODY_BYTES,
  MAX_MAX_NAMES,
  MAX_MAX_PER_RUN,
  MAX_MAX_RUN_BYTES,
  MAX_SKILL_ROLES,
  MIN_MAX_BODY_BYTES,
  MIN_MAX_NAMES,
  MIN_MAX_PER_RUN,
  MIN_MAX_RUN_BYTES,
} from "../skills/limits.js";
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

/**
 * `mcp_clients[].approval_proxy_kinds` values (ADR-0068, ADR-0087): LLD §3.4.1 `approval_kind`. Absent means
 * {@link APPROVAL_PROXY_DEFAULT_KINDS}; `project_source` is opt-in and only served when listed explicitly.
 */
export const APPROVAL_PROXY_KINDS = ["privileged_scope", "dynamic_project", "push_revision", "project_source"] as const;
export type ApprovalProxyKind = (typeof APPROVAL_PROXY_KINDS)[number];
/** The kinds a proxy serves without `approval_proxy_kinds` (ADR-0047, unchanged by ADR-0087). */
export const APPROVAL_PROXY_DEFAULT_KINDS: readonly ApprovalProxyKind[] = [
  "privileged_scope",
  "dynamic_project",
  "push_revision",
];

/** `project_sources.allowed_hosts` default (ADR-0068). */
export const DEFAULT_PROJECT_SOURCE_HOSTS = ["github.com"] as const;
/** A host name (lower case, dot-separated labels) as `project_sources.allowed_hosts` accepts it (Delegated). */
export const SOURCE_HOST_PATTERN = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$";
/** A repository owner or name segment (ADR-0068): `[A-Za-z0-9._-]`, not `.` or `..` (checked in `load.ts`). */
export const SOURCE_SEGMENT_PATTERN = "^[A-Za-z0-9._-]{1,100}$";

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
    /** ADR-0068: the approval kinds this proxy may list and decide. Default: all three. */
    approval_proxy_kinds?: (typeof APPROVAL_PROXY_KINDS)[number][];
    /** T14.11 (FR-CTL-11): `orchestrator` (default) or `console`. */
    tool_profile?: ToolProfile;
    /**
     * T16.3 (FR-SKL-08, LLD §19.3): bare skill names this client may see and inject. Absent means every approved name.
     * An empty list means none. Pins (`name@n`) are not visibility keys.
     */
    skills?: string[];
    /** T3.24 (FR-CAP-12, LLD §20.2): honour `light: true` on this client's requests during a host load hold. Default false. */
    allow_light?: boolean;
  }[];
  limits?: {
    global_concurrency?: number;
    per_provider_concurrency?: number;
    /**
     * `min_free_disk_mb` (T3.23, FR-WS-11): the free-disk floor in whole megabytes, off when absent. Below it new runs
     * are held in `QUEUED` (never failed) and an early GC sweep runs; `doctor` reports free space against it.
     */
    min_free_disk_mb?: number;
    /** T3.22 (FR-EXE-09): host-wide verification slots. Any `verification_*` key turns the limiter on. */
    verification_slots?: number;
    /** T3.22: niceness added to verification commands; 0 leaves their priority unchanged. */
    verification_nice?: number;
    /** T3.22: parallelism variables (for example `VITEST_MAX_WORKERS`) given to verification commands only. */
    verification_env?: Record<string, string>;
    /** T9.13 (FR-WS-10): total dependency seed store bound in megabytes; default 10240 (Assumption). */
    seed_store_mb?: number;
    /** T9.13 (FR-WS-10): store entries kept per (project, seed); default 3 (Assumption). */
    seed_entries_per_seed?: number;
  };
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
  git?: {
    sanitize_patterns?: string[];
    /**
     * Pre-push secret scan (FR-GIT-11, LLD §20.9, ADR-0061; T9.14). `allow` is the operator allowlist: a hit of
     * `rule_id` (a stable id of `src/artifacts/redact.ts`) at a repository-relative path the glob matches does not
     * refuse the push. The only in-band way past the scan; at most 64 entries.
     */
    secret_scan?: { allow?: { rule_id: string; path: string }[] };
  };
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
  /** ADR-0068: where `create_project` may clone a `clone_url`. Absent means cloning is refused. */
  project_sources?: { clone_root: string; allowed_hosts?: string[]; allowed_owners: string[] };
  /** Optional OTLP/HTTP trace destination; absent or empty disables telemetry (LLD §7, T8.1). */
  telemetry?: { otlp_endpoint?: string; provider_otlp?: boolean };
  /**
   * Host load hold (T3.24; FR-CAP-12, LLD §20.2). Absent means off: no load is read and dispatch is unchanged. Both keys
   * are required together and `resume_load1` must be lower than `max_load1` (`load.ts` refuses anything else).
   */
  host?: { max_load1: number; resume_load1: number };
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
  /**
   * Switchboard-controlled skills (M16, T16.3; FR-SKL-03, FR-SKL-04, FR-SKL-08, LLD §19.3). Absent means
   * `enabled: false` and every other key at its default. With `enabled` false or absent, nothing else changes.
   */
  skills?: SkillsConfig;
}

/** `routing` as written in the config file (LLD §17.1). */
export interface RoutingConfigInput {
  weights?: Partial<Record<"success" | "latency" | "capacity" | "security" | "handoff" | "cost" | "pacing", number>>;
  /** T7.4 (LLD §3.2, §17.1): `idle_ttl` accepts only null until expiry is built (Q-52). */
  affinity?: { enabled?: boolean; low_water_mark?: number | null; min_confidence?: number | null; idle_ttl?: null };
}

/** LLD §17.1 bounds of each `routing.weights` value (Assumption, Q-80); the default of 1 lives in `src/routing/score.ts`. */
export const MAX_ROUTING_WEIGHT = 100;
/** T14.16: largest `projects[].queue.stall_hours` (30 days; Assumption, Delegated). */
export const MAX_STALL_HOURS = 720;
/** T14.17 (FR-CTL-15, LLD §20.13): default `projects[].critic.min_diff_lines` (Assumption 400, LLD §20.13). */
export const DEFAULT_CRITIC_MIN_DIFF_LINES = 400;
/** T14.17: largest `projects[].critic.min_diff_lines` (a sanity bound with no source; Assumption, Delegated). */
export const MAX_CRITIC_MIN_DIFF_LINES = 1_000_000;

/** `control_plane` as written in the config file (LLD §3.4.6); `budgets` (T14.4) and `loop_breaker` (T14.5) so far. */
export interface ControlPlaneConfigInput {
  budgets?: BudgetsConfigInput;
  loop_breaker?: {
    identical_failure_threshold?: number;
    stall_minutes?: number;
    max_successors_per_meta_session?: number;
  };
  /** T14.16 (FR-CTL-14, LLD §20.5): push a metadata-only digest to the sinks on this schedule; absent means off. */
  digest_schedule?: { cron: string };
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
  /**
   * Read the operator's GitHub Copilot quota through their logged-in `gh` (`gh api /copilot_internal/user`) for
   * `get_capacity` and `switchboard capacity`. Default true; false is the operator's opt-out.
   */
  copilot_quota?: boolean;
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
/** `capacity.copilot_quota` (Delegated: on, operator opt-out; it only reads the operator's own quota through `gh`). */
export const DEFAULT_COPILOT_QUOTA = true;

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

/** LLD §19.1 skill name. `mcp_clients[].skills` entries are bare names (Delegated: visibility is by name, not pin). */
export const SKILL_NAME_PATTERN = "^[a-z][a-z0-9-]{1,47}$";
/** LLD §19.4: `name` or `name@n` (version 1 to 999999). Used by `skills.defaults` and `skills.roles`. */
export const SKILL_REF_PATTERN = "^[a-z][a-z0-9-]{1,47}(@[1-9][0-9]{0,5})?$";
/** LLD §19.3 role key. */
export const SKILL_ROLE_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";

export const SKILL_DELIVERIES = ["native_preferred", "prefix_only"] as const;
export type SkillDelivery = (typeof SKILL_DELIVERIES)[number];
/** LLD §19.3. `prefix_only` forces the prompt prefix even when a cell could deliver natively (T16.6). */
export const DEFAULT_SKILL_DELIVERY: SkillDelivery = "native_preferred";

/** `skills.defaults` / `skills.roles` and the same pair under `projects[].skills` (LLD §19.3). */
export interface SkillAssignmentConfig {
  defaults?: string[];
  roles?: Record<string, string[]>;
}

/** `skills` as written in the config file (LLD §19.3). Every key is optional; the loader applies the defaults. */
export interface SkillsConfig extends SkillAssignmentConfig {
  enabled?: boolean;
  delivery?: SkillDelivery;
  /** Q-105 Delegated default: false. The loader treats an absent key as false. */
  allow_draft_in_trusted?: boolean;
  max_body_bytes?: number;
  max_per_run?: number;
  max_run_bytes?: number;
  max_names?: number;
}

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
  /**
   * FR-PRJ-02 note (LLD §5.2, ADR-0067): a remote NAME the daemon fetches `base_ref` from into its remote-tracking ref
   * before a meta-session's first worktree is created. Primary context only; absent: no fetch (the local branch as is).
   */
  base_remote?: string;
  /**
   * ADR-0068: MCP-only. A dynamic definition stores the normalised `clone_url` its `path` was cloned from; the
   * configuration file has no such key (`contextSchema` refuses it) and always names `path`.
   */
  clone_url?: string;
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
  /**
   * ADR-0087 item 1 (FR-PRJ-11): opt-in handling of submodules of the primary context. Absent or `off` is ADR-0022
   * exactly. `writable_paths` (worktree-relative POSIX paths, or exactly `["*"]`) and `exclude` hold at most
   * `MAX_SUBMODULE_PATHS` entries each.
   */
  submodules?: ContextSubmodulesConfig;
}

export const SUBMODULE_MODES = ["off", "recursive"] as const;
/** ADR-0087 item 1: at most this many paths in each of `writable_paths` and `exclude`. */
export const MAX_SUBMODULE_PATHS = 512;

/** ADR-0087 item 1: `projects[].contexts[].submodules`. */
export interface ContextSubmodulesConfig {
  mode: (typeof SUBMODULE_MODES)[number];
  writable_paths?: string[];
  exclude?: string[];
}

/** ADR-0087 item 7: `projects[].merge_policy.checks`. */
export const MERGE_POLICY_CHECKS = ["required", "all_reported"] as const;
export type MergePolicyChecks = (typeof MERGE_POLICY_CHECKS)[number];

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
  /**
   * T9.13 (FR-WS-10, LLD §5.1, ADR-0057): ignored directories the controller fills into each fresh worktree from its
   * seed store. Configuration only: a dynamic project definition (FR-PRJ-10) cannot carry the key (Delegated).
   */
  dependency_seeds?: DependencySeedConfig[];
  /**
   * T16.3 (FR-SKL-03, LLD §19.3): project default skill names, applied after the global ones. Configuration file only
   * (not a dynamic project definition). Absent means this project adds no defaults.
   */
  skills?: SkillAssignmentConfig;
  /**
   * T15.4 (FR-QUE-04, LLD §18.8): low-water mark for the project work queue (off by default).
   */
  queue?: {
    low_water?: number;
    /** T14.16 (FR-CTL-14, LLD §20.5): `stalled_progress` window in hours; absent means off. */
    stall_hours?: number;
  };
  /**
   * T5.14 (FR-SES-07, LLD §20.13): the operator's project brief, a file outside every allowed root and context, at most
   * 4 KiB. Configuration file only (not a dynamic project definition, Delegated). Absent means no brief.
   */
  brief_file?: string;
  /**
   * T14.17 (FR-CTL-15, LLD §20.13): one read-only advisory critic run on another provider after a large diff. Off by
   * default. Configuration file only (not a dynamic project definition; Delegated): it admits runs on its own.
   */
  critic?: {
    enabled?: boolean;
    min_diff_lines?: number;
  };
  /**
   * T15.8 (FR-SUB-02, LLD §20.7, ADR-0060): the opt-in, head-pinned merge policy. Off by default. A dynamic project
   * definition may carry it, but a revision that turns it on waits for operator approval (`merge_policy`, FR-PRJ-10).
   */
  merge_policy?: {
    enabled?: boolean;
    method?: MergePolicyMethod;
    required_reports?: MergePolicyReport[];
    /**
     * ADR-0070: the `verification_result` at the head must be `passed` (default true, T15.8's gate). False skips that
     * one condition; `required_reports` still apply. Setting it false in a dynamic definition waits for approval.
     */
    require_verification?: boolean;
    /**
     * ADR-0087 item 7: which checks must pass. `required` (default) is today's gate; `all_reported` needs at least one
     * check to have run and every reported check to pass. `all_reported` waits for approval (`merge_checks`).
     */
    checks?: MergePolicyChecks;
  };
  /**
   * ADR-0071: dependency setup commands the controller runs in each run's worktree after it is prepared and before the
   * agent starts (argv, no shell), with network only to `network.hosts` through the controller's allowlisting proxy.
   * `host` environments only. A dynamic definition may carry it, but turning it on or changing it waits for operator
   * approval (`project_setup`, FR-PRJ-10).
   */
  setup?: ProjectSetupConfig;
}

/** ADR-0071: `projects[].setup.cache`, the shared package-manager cache under `<data_dir>/caches`. */
export const SETUP_CACHES = ["pnpm", "npm", "none"] as const;
export type SetupCache = (typeof SETUP_CACHES)[number];
/** ADR-0071: the closed allowlist of non-secret variables `setup.env` may set. */
export const SETUP_ENV_KEYS = ["CI", "NODE_ENV", "NO_COLOR"] as const;
export type SetupEnvKey = (typeof SETUP_ENV_KEYS)[number];
/** ADR-0071 bounds (Delegated): commands, argv length, argument length, hosts, timeout. */
export const MAX_SETUP_COMMANDS = 8;
export const MAX_SETUP_ARGS = 32;
export const MAX_SETUP_ARG_LENGTH = 1024;
export const MAX_SETUP_HOSTS = 8;
export const DEFAULT_SETUP_TIMEOUT_SECONDS = 600;
export const MAX_SETUP_TIMEOUT_SECONDS = 1800;
export const DEFAULT_SETUP_HOSTS: readonly string[] = ["registry.npmjs.org"];
/**
 * A DNS hostname, lower case, at least two labels, the last starting with a letter (so never an IP literal), no port,
 * no wildcard, no trailing dot (ADR-0071; Delegated).
 */
export const SETUP_HOST_PATTERN =
  "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$";

/** ADR-0071: one `projects[].setup` (configuration file and dynamic definitions). */
export interface ProjectSetupConfig {
  commands: string[][];
  network?: { hosts?: string[] };
  cache?: SetupCache;
  timeout_seconds?: number;
  env?: Partial<Record<SetupEnvKey, string>>;
}

/** T15.8: `projects[].merge_policy.method`, one `gh pr merge` flag each; `squash` by default (LLD §20.7). */
export const MERGE_POLICY_METHODS = ["squash", "merge", "rebase"] as const;
export type MergePolicyMethod = (typeof MERGE_POLICY_METHODS)[number];
/** T15.8: reports `required_reports` may name (closed list; the docs-alignment skill's report, FR-SKL-11). */
export const MERGE_POLICY_REPORTS = ["docs-alignment"] as const;
export type MergePolicyReport = (typeof MERGE_POLICY_REPORTS)[number];

/** One `projects[].dependency_seeds[]` entry (LLD §5.1). Paths are relative to the primary context. */
export interface DependencySeedConfig {
  id: string;
  lockfile: string;
  directory: string;
  /** argv, no shell; the same shape rules as `verification_commands`. */
  install: string[];
  /** Default 600 (Assumption). */
  timeout_seconds?: number;
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

/**
 * ADR-0087 item 1: one worktree-relative path (or `*`): no leading `/`, no control character. The segment rules
 * (empty, `.`, `..`, `.git`, backslash) are structural: `checkProjects`.
 */
const submodulePathList = {
  type: "array",
  maxItems: MAX_SUBMODULE_PATHS,
  uniqueItems: true,
  items: {
    type: "string",
    minLength: 1,
    maxLength: 256,
    pattern: "^[^/\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$",
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
    base_remote: { type: "string", minLength: 1 },
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
    submodules: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: [...SUBMODULE_MODES] },
        writable_paths: submodulePathList,
        exclude: submodulePathList,
      },
    },
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
    queue: {
      type: "object",
      additionalProperties: false,
      properties: {
        low_water: { type: "integer", minimum: 1 },
        // T14.16: the upper bound (30 days) is an Assumption, a sanity limit with no source (Delegated).
        stall_hours: { type: "integer", minimum: 1, maximum: MAX_STALL_HOURS },
      },
    },
    // T15.8 (FR-SUB-02, LLD §20.7): turning it on in a dynamic definition waits for operator approval.
    merge_policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        method: { enum: [...MERGE_POLICY_METHODS] },
        required_reports: { type: "array", uniqueItems: true, items: { enum: [...MERGE_POLICY_REPORTS] } },
        // ADR-0070: false skips the verification_result-at-head condition; turning it off waits for approval.
        require_verification: { type: "boolean" },
        // ADR-0087 item 7: `all_reported` waits for approval (`merge_checks`); the default is `required`.
        checks: { enum: [...MERGE_POLICY_CHECKS] },
      },
    },
    // ADR-0071: changing it in a dynamic definition waits for approval (`project_setup`).
    setup: {
      type: "object",
      additionalProperties: false,
      required: ["commands"],
      properties: {
        commands: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SETUP_COMMANDS,
          items: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SETUP_ARGS,
            items: { type: "string", minLength: 1, maxLength: MAX_SETUP_ARG_LENGTH, pattern: "^[^\\u0000]*$" },
          },
        },
        network: {
          type: "object",
          additionalProperties: false,
          properties: {
            hosts: {
              type: "array",
              maxItems: MAX_SETUP_HOSTS,
              uniqueItems: true,
              items: { type: "string", maxLength: 253, pattern: SETUP_HOST_PATTERN },
            },
          },
        },
        cache: { enum: [...SETUP_CACHES] },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_SETUP_TIMEOUT_SECONDS },
        env: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            SETUP_ENV_KEYS.map((k) => [k, { type: "string", maxLength: 64, pattern: "^[A-Za-z0-9._-]{0,64}$" }]),
          ),
        },
      },
    },
    contexts: { type: "array", minItems: 1, items: contextSchema },
  },
} as const;

/**
 * `projects[].dependency_seeds` (T9.13, FR-WS-10, LLD §5.1). Bounds are Assumptions (Delegated); the path rules that a
 * schema cannot say (normalised, not under `.git`, no nesting) are `checkProjects`'.
 */
const dependencySeedsSchema = {
  type: "array",
  maxItems: 8,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "lockfile", "directory", "install"],
    properties: {
      id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,40}$" },
      lockfile: { type: "string", minLength: 1, maxLength: 1024 },
      directory: { type: "string", minLength: 1, maxLength: 1024 },
      install: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: { type: "string", maxLength: 4096, pattern: "^[^\\u0000]*$" },
      },
      timeout_seconds: { type: "integer", minimum: 1, maximum: 3600 },
    },
  },
} as const;

/** One `name` or `name@n` list (LLD §19.3). A fresh object each call: Ajv rejects one schema object compiled twice. */
function skillRefListSchema(): {
  type: "array";
  uniqueItems: true;
  maxItems: number;
  items: { type: "string"; pattern: string };
} {
  return {
    type: "array",
    uniqueItems: true,
    maxItems: MAX_MAX_NAMES,
    items: { type: "string", pattern: SKILL_REF_PATTERN },
  };
}

/** `skills.roles.<role>[]` and `projects[].skills.roles.<role>[]`. An unknown key is a role name that fails the pattern. */
function skillRolesSchema(): {
  type: "object";
  maxProperties: number;
  propertyNames: { pattern: string };
  additionalProperties: ReturnType<typeof skillRefListSchema>;
} {
  return {
    type: "object",
    maxProperties: MAX_SKILL_ROLES,
    propertyNames: { pattern: SKILL_ROLE_PATTERN },
    additionalProperties: skillRefListSchema(),
  };
}

/** `projects[].skills` (configuration file only). Unknown keys abort startup. */
function projectSkillsSchema(): {
  type: "object";
  additionalProperties: false;
  properties: { defaults: ReturnType<typeof skillRefListSchema>; roles: ReturnType<typeof skillRolesSchema> };
} {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      defaults: skillRefListSchema(),
      roles: skillRolesSchema(),
    },
  };
}

/**
 * `skills` (T16.3, LLD §19.3). Strict: an unknown key aborts startup. Limit bounds are the Delegated ranges in
 * `src/skills/limits.ts`. Defaults are applied by the loader, not by the schema, so an absent key stays absent here.
 */
function skillsSectionSchema(): {
  type: "object";
  additionalProperties: false;
  properties: Record<string, unknown>;
} {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      defaults: skillRefListSchema(),
      roles: skillRolesSchema(),
      delivery: { enum: [...SKILL_DELIVERIES] },
      allow_draft_in_trusted: { type: "boolean" },
      max_body_bytes: { type: "integer", minimum: MIN_MAX_BODY_BYTES, maximum: MAX_MAX_BODY_BYTES },
      max_per_run: { type: "integer", minimum: MIN_MAX_PER_RUN, maximum: MAX_MAX_PER_RUN },
      max_run_bytes: { type: "integer", minimum: MIN_MAX_RUN_BYTES, maximum: MAX_MAX_RUN_BYTES },
      max_names: { type: "integer", minimum: MIN_MAX_NAMES, maximum: MAX_MAX_NAMES },
    },
  };
}

/** `mcp_clients[].skills`: bare names. Absent (the property omitted) means every approved name. */
function clientSkillListSchema(): {
  type: "array";
  uniqueItems: true;
  maxItems: number;
  items: { type: "string"; pattern: string };
} {
  return {
    type: "array",
    uniqueItems: true,
    maxItems: MAX_MAX_NAMES,
    items: { type: "string", pattern: SKILL_NAME_PATTERN },
  };
}

/** `projects[].critic` (T14.17; FR-CTL-15, LLD §20.13). */
const projectCriticSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    min_diff_lines: { type: "integer", minimum: 1, maximum: MAX_CRITIC_MIN_DIFF_LINES },
  },
} as const;

/**
 * A `projects[]` entry of the configuration file: {@link projectSchema} plus `dependency_seeds` (T9.13), `skills`
 * (T16.3), `critic` (T14.17) and `brief_file` (T5.14).
 */
const configProjectSchema = {
  ...projectSchema,
  properties: {
    ...projectSchema.properties,
    dependency_seeds: dependencySeedsSchema,
    skills: projectSkillsSchema(),
    critic: projectCriticSchema,
    // T5.14: a path; the file rules (outside the roots, at most 4 KiB, UTF-8) are `loadConfig`'s.
    brief_file: { type: "string", minLength: 1, maxLength: 4096 },
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
    max_consecutive_fixes: { type: "integer", minimum: 1 },
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
          max_consecutive_fixes: { type: "integer", minimum: 1 },
          // T15.6 (FR-QUE-06, ADR-0050 amendment 1): each switch enables one `gh` write verb; both off by default.
          rerun_failed: { type: "boolean" },
          cancel_stale_queued: { type: "boolean" },
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
          approval_proxy_kinds: {
            type: "array",
            uniqueItems: true,
            minItems: 1,
            items: { enum: [...APPROVAL_PROXY_KINDS] },
          },
          tool_profile: { enum: [...TOOL_PROFILES] },
          skills: clientSkillListSchema(),
          allow_light: { type: "boolean" },
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
        // T3.22 (FR-EXE-09, LLD §8.1). Bounds are Proposed sanity limits (Delegated).
        verification_slots: { type: "integer", minimum: 1, maximum: 64 },
        verification_nice: { type: "integer", minimum: 0, maximum: 19 },
        verification_env: {
          type: "object",
          maxProperties: 16,
          // Upper-case names only; never Git, loader, signing/agent or the allowlist's own PATH/HOME (defence in depth).
          propertyNames: {
            pattern: "^[A-Z][A-Z0-9_]{0,63}$",
            not: { pattern: "^(GIT_|LD_|DYLD_|PATH$|HOME$|GNUPGHOME$|GPG_AGENT_INFO$|SSH_AUTH_SOCK$|NODE_OPTIONS$)" },
          },
          additionalProperties: { type: "string", maxLength: 256, pattern: "^[^\\u0000]*$" },
        },
        // T9.13 (FR-WS-10, LLD §5.1). Bounds are Proposed sanity limits (Delegated).
        seed_store_mb: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
        seed_entries_per_seed: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    // T3.24 (FR-CAP-12, LLD §20.2): 1-minute load averages; the upper bound is a typo guard (Assumption, Delegated).
    host: {
      type: "object",
      additionalProperties: false,
      required: ["max_load1", "resume_load1"],
      properties: {
        max_load1: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
        resume_load1: { type: "number", exclusiveMinimum: 0, maximum: 100_000 },
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
    projects: { type: "array", items: configProjectSchema },
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
        secret_scan: {
          type: "object",
          additionalProperties: false,
          properties: {
            allow: {
              type: "array",
              maxItems: 64,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["rule_id", "path"],
                properties: {
                  rule_id: { type: "string", minLength: 1, maxLength: 64 },
                  path: { type: "string", minLength: 1, maxLength: 400 },
                },
              },
            },
          },
        },
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
        copilot_quota: { type: "boolean" },
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
        // T14.16 (FR-CTL-14, LLD §20.5): the §18.5 cron syntax (five fields, UTC), checked in `control-plane.ts`.
        digest_schedule: {
          type: "object",
          additionalProperties: false,
          required: ["cron"],
          properties: { cron: { type: "string", minLength: 1, maxLength: 256 } },
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
    skills: skillsSectionSchema(),
    notification_sinks: notificationSinksSchema,
    ci_trigger: ciTriggerSchema,
    // ADR-0068: bounds are Delegated sanity limits.
    project_sources: {
      type: "object",
      additionalProperties: false,
      required: ["clone_root", "allowed_owners"],
      properties: {
        clone_root: { type: "string", minLength: 1, maxLength: 4096 },
        allowed_hosts: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: "string", maxLength: 253, pattern: SOURCE_HOST_PATTERN },
        },
        allowed_owners: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: { type: "string", pattern: SOURCE_SEGMENT_PATTERN },
        },
      },
    },
    telemetry: {
      type: "object",
      additionalProperties: false,
      properties: { otlp_endpoint: { type: "string" }, provider_otlp: { type: "boolean" } },
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
export function currentConfigSchema(opts: { readonly testFakeAdapter?: boolean } = {}): {
  readonly generation: number;
  readonly schema: Record<string, unknown>;
} {
  const generation = providerGeneration();
  const schema = generation === 0 ? configSchema : configSchemaFor(configProviderIds());
  if (opts.testFakeAdapter !== true) return { generation, schema };
  // biome-ignore lint/suspicious/noExplicitAny: a structural copy of a JSON schema document, edited at one known path
  const widened = structuredClone(schema) as any;
  widened.properties.model_groups = modelGroupsSchemaFor(memberProviderIds(true));
  return { generation, schema: widened };
}

/**
 * Provider ids a `model_groups` member or a `capacity.subscriptions.<s>.providers[]` entry may name: every registered
 * config id, plus the test-only adapter ids (`fake`, which has no config id) when `testFakeAdapter` says that adapter is
 * registered (`serve`'s test-only switch; TDD §3.6). Without it the list, and so every message, is as before.
 */
export function memberProviderIds(testFakeAdapter: boolean): string[] {
  const ids = configProviderIds();
  return testFakeAdapter ? [...ids, ...providerEntries().flatMap((e) => (e.kind === "test" ? [e.id] : []))] : ids;
}
