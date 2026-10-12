/**
 * Config JSON Schema (TDD §3.1, FR-OPS-04, NFR-SEC-05). The schema document is the source of truth and is validated by
 * Ajv; `SwitchboardConfig` is hand-written and kept consistent by the tests (TDD §2 allows either mechanism).
 *
 * Proposed (not in the SRS): provider ids are limited to the seven providers named in AGENTS.md; `weight` is a number
 * in [0, 1]; client ids match `^[a-z0-9][a-z0-9_-]{0,63}$`; concurrency maxima are 64.
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

export interface SwitchboardConfig {
  schema_version: 1;
  data_dir?: string;
  allowed_roots: string[];
  mcp_clients: { id: string; max_trust_profile: TrustProfile }[];
  limits?: { global_concurrency?: number; per_provider_concurrency?: number };
  providers?: Partial<Record<ProviderId, { enabled?: boolean; weight?: number }>>;
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
    providers: { type: "object", additionalProperties: false, properties: providerProps },
  },
} as const;
