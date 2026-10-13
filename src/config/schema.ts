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
 * `providers.claude-code.git_channel` (T9.4b; ADR-0029 item 7, owner decision 36; key and default Delegated): the
 * operator opt-in that lets the Claude Code adapter receive the injected tool channel through a controller-written
 * `--mcp-config` file. Default false (argv unchanged, `commitChannel: "none"`). Accepted only under `claude-code`.
 * UNSUPPORTED until the ADR-0029 live checks pass.
 */
import {
  BUILTIN_CONFIG_PROVIDER_IDS,
  type ConfigProviderId,
  configProviderIds,
  providerGeneration,
} from "../adapters/providers.js";

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
  }[];
  limits?: { global_concurrency?: number; per_provider_concurrency?: number };
  providers?: Partial<Record<ProviderId, { enabled?: boolean; weight?: number; git_channel?: boolean }>>;
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
}

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
}

export interface ProjectConfig {
  id: string;
  name: string;
  environment?: EnvironmentConfig;
  /** Shape only until T9.2 (FR-PRJ-06 enforcement). */
  max_trust_profile?: TrustProfile;
  allowed_providers?: ProviderId[];
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
    contexts: { type: "array", minItems: 1, items: contextSchema },
  },
} as const;

/** Defaults (Proposed): 30 days (NFR-DATA-01), GC pass every 24 hours. */
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
        },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        global_concurrency: { type: "integer", minimum: 1, maximum: 64 },
        per_provider_concurrency: { type: "integer", minimum: 1, maximum: 64 },
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
    git: {
      type: "object",
      additionalProperties: false,
      properties: {
        sanitize_patterns: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 200 } },
      },
    },
    profiles: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        TRUST_PROFILES.filter((p) => p !== "privileged").map((p) => [p, profileOverrideSchema]),
      ),
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
