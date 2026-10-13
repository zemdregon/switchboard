/**
 * Config JSON Schema (TDD §3.1, FR-OPS-04, NFR-SEC-05). The schema document is the source of truth and is validated by
 * Ajv; `SwitchboardConfig` is hand-written and kept consistent by the tests (TDD §2 allows either mechanism).
 *
 * Proposed (not in the SRS): provider ids are limited to the seven providers named in AGENTS.md; `weight` is a number
 * in [0, 1]; client ids match `^[a-z0-9][a-z0-9_-]{0,63}$`; concurrency maxima are 64.
 *
 * `mcp_clients[].privileged_approval` (owner decisions 18 and 22, ADR-0019; the key, its values and its default are
 * Delegated): `required` (default) keeps the operator's `approve`/`deny` step for this client's `privileged` requests;
 * `not_required` admits them straight to QUEUED under an approval row written APPROVED by client policy. Only the
 * per-scope approval is lifted: the ceiling, scope validation, scope hash, Git-write denial (FR-GIT-01) and worktree
 * isolation (FR-WS-05) still apply. `load.ts` refuses `not_required` unless the client's ceiling is `privileged`.
 */

export const TRUST_PROFILES = [
  "inspect-untrusted",
  "edit-untrusted",
  "test-sandboxed",
  "trusted-development",
  "privileged",
] as const;
export type TrustProfile = (typeof TRUST_PROFILES)[number];

export const PROVIDER_IDS = [
  "claude-code",
  "codex",
  "grok-build",
  "antigravity",
  "cursor",
  "opencode",
  "kimi-code",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const CONFIG_SCHEMA_VERSION = 1;

/** `mcp_clients[].privileged_approval` values (ADR-0019). The restrictive value is the default. */
export const PRIVILEGED_APPROVAL_MODES = ["required", "not_required"] as const;
export type PrivilegedApprovalMode = (typeof PRIVILEGED_APPROVAL_MODES)[number];
export const DEFAULT_PRIVILEGED_APPROVAL: PrivilegedApprovalMode = "required";

export interface SwitchboardConfig {
  schema_version: 1;
  data_dir?: string;
  allowed_roots: string[];
  mcp_clients: { id: string; max_trust_profile: TrustProfile; privileged_approval?: PrivilegedApprovalMode }[];
  limits?: { global_concurrency?: number; per_provider_concurrency?: number };
  providers?: Partial<Record<ProviderId, { enabled?: boolean; weight?: number }>>;
  /** Run retention (NFR-DATA-01, FR-WS-07). `interval` is `<n>m`, `<n>h` or `<n>d` (Proposed form). */
  retention?: { days?: number; interval?: string };
  /** Per-field profile overrides (FR-POL-01, owner decision 12). `privileged` has none: it comes from its scope. */
  profiles?: Partial<Record<Exclude<TrustProfile, "privileged">, ProfileOverrideConfig>>;
}

export interface ProfileOverrideConfig {
  file_access?: "read-only" | "worktree";
  shell?: "none" | "allowlist" | "broad";
  shell_allowlist?: string[];
  network?: "off" | "allowlist" | "policy";
  network_allowlist?: string[];
  repo_config?: "disabled" | "approved-only" | "allowlisted";
}

const providerProps = Object.fromEntries(
  PROVIDER_IDS.map((id) => [
    id,
    {
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean" }, weight: { type: "number", minimum: 0, maximum: 1 } },
    },
  ]),
);

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
    profiles: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        TRUST_PROFILES.filter((p) => p !== "privileged").map((p) => [p, profileOverrideSchema]),
      ),
    },
  },
} as const;
