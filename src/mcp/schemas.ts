/**
 * Published JSON Schemas for the MCP tools (LLD §3, FR-MCP-09). These documents are the source of truth (TDD §2): the
 * server validates every tool input against them with Ajv before any side effect, and publishes the same documents
 * as `inputSchema` / `outputSchema` in `tools/list`.
 *
 * Dialect: JSON Schema 2020-12 (LLD §3, version choice Proposed), which is also the MCP default dialect when a schema
 * carries no `$schema`. Only keywords that mean the same in draft-07 are used, so validators of either dialect (the
 * SDK client's default Ajv is draft-07) read them identically. Every object is closed (`additionalProperties: false`).
 *
 * Proposed (not fixed by LLD §3, Delegated): provider-name pattern; `constraints` item length; `verification_commands`
 * bounds; `reason` length; `get_artifacts.max_inline_bytes` maximum (1 MiB); `get_run.include_events.limit` default 50;
 * output-only fields `failure_detail`, `replayed`, `events`, `client_max_profile`, `status_detail`, `schema_dialect`.
 * `continue_task` has no `idempotency_key` (FRD §7.2 C6 and FR-MCP-08 win over the earlier LLD §3 draft).
 */

import { FAILURE_CODES } from "../adapters/failure.js";

/** Bumped on any incompatible change to a published tool schema (Proposed). */
export const TOOL_SCHEMA_VERSION = 1;
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export const TOOL_NAMES = [
  "delegate_task",
  "continue_task",
  "get_run",
  "cancel_run",
  "get_artifacts",
  "list_capabilities",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Artifact kinds an MCP client may read; `provider_stdout`/`provider_stderr` are operator-CLI only (LLD §3). */
export const MCP_ARTIFACT_KINDS = ["diff", "test_report", "changed_files", "log_summary", "handoff_view"] as const;

const TRUST_PROFILE = {
  type: "string",
  enum: ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development", "privileged"],
} as const;
const STATUS = {
  type: "string",
  enum: [
    "AWAITING_APPROVAL",
    "QUEUED",
    "WAITING_CAPACITY",
    "PREFLIGHT",
    "LEASED",
    "RUNNING",
    "VERIFYING",
    "FINALIZING",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
  ],
} as const;
const RUN_ID = { type: "string", pattern: "^run_[0-9A-HJKMNP-TV-Z]{26}$" } as const;
const SESSION_ID = { type: "string", pattern: "^sess_[0-9A-HJKMNP-TV-Z]{26}$" } as const;
const ARTIFACT_ID = { type: "string", pattern: "^art_[0-9A-HJKMNP-TV-Z]{26}$" } as const;
const PROVIDER = { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" } as const;
const WAIT_SECONDS = { type: "integer", minimum: 0, maximum: 60, default: 0 } as const;
const ROUTING = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider_preference: PROVIDER,
    require_provider: { type: "boolean", default: false },
    minimum_capability: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const;
const NULLABLE_STRING = { type: ["string", "null"] } as const;

const ENVELOPE = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "meta_session_id", "status"],
  properties: {
    run_id: RUN_ID,
    meta_session_id: SESSION_ID,
    status: STATUS,
    failure_code: { type: "string" },
    failure_detail: { type: "string", maxLength: 1000 },
    provider: {
      type: "object",
      additionalProperties: false,
      properties: { adapter: NULLABLE_STRING, model: NULLABLE_STRING, adapter_version: NULLABLE_STRING },
    },
    route: {
      type: "object",
      additionalProperties: false,
      properties: { reasons: { type: "array", items: { type: "string" } } },
    },
    result: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", maxLength: 4000 },
        changed_files: { type: "integer", minimum: 0 },
        verification: { type: "array", items: { type: "object" } },
      },
    },
    artifacts: { type: "object", additionalProperties: ARTIFACT_ID },
    usage: {
      type: "object",
      additionalProperties: false,
      properties: { reported: {}, estimated: {}, capacity_confidence: { type: ["number", "null"] } },
    },
    replayed: { type: "boolean" },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seq", "ts", "type", "payload"],
        properties: {
          seq: { type: "integer", minimum: 1 },
          ts: { type: "string" },
          type: { type: "string" },
          payload: {},
        },
      },
    },
  },
} as const;

/** LLD §3 error envelope (FR-MCP-07), delivered with `isError: true`. */
const ERROR = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable"],
      properties: {
        code: { type: "string", enum: [...FAILURE_CODES] },
        message: { type: "string" },
        retryable: { type: "boolean" },
        run_id: RUN_ID,
        details: { type: "object" },
      },
    },
  },
} as const;

/** MCP requires `type: "object"` at the root of an output schema; `anyOf` admits the success shape or the error. */
const withError = (success: object) => ({ type: "object", anyOf: [success, ERROR] }) as const;

const INPUTS = {
  delegate_task: {
    type: "object",
    additionalProperties: false,
    required: ["objective", "workspace_path", "trust_profile"],
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 32768 },
      workspace_path: { type: "string", minLength: 1, maxLength: 4096 },
      constraints: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 }, default: [] },
      trust_profile: TRUST_PROFILE,
      verification_commands: {
        type: "array",
        maxItems: 16,
        items: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", maxLength: 4096 } },
        default: [],
      },
      routing: ROUTING,
      priority: { type: "string", enum: ["interactive", "normal", "batch"], default: "normal" },
      wait_seconds: WAIT_SECONDS,
      idempotency_key: { type: "string", minLength: 8, maxLength: 128 },
    },
  },
  continue_task: {
    type: "object",
    additionalProperties: false,
    required: ["meta_session_id", "instruction"],
    properties: {
      meta_session_id: SESSION_ID,
      instruction: { type: "string", minLength: 1, maxLength: 32768 },
      routing: ROUTING,
      trust_profile: TRUST_PROFILE,
      wait_seconds: WAIT_SECONDS,
    },
  },
  get_run: {
    type: "object",
    additionalProperties: false,
    required: ["run_id"],
    properties: {
      run_id: RUN_ID,
      include_events: {
        type: "object",
        additionalProperties: false,
        properties: {
          after_seq: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  },
  cancel_run: {
    type: "object",
    additionalProperties: false,
    required: ["run_id"],
    properties: { run_id: RUN_ID, reason: { type: "string", maxLength: 500 } },
  },
  get_artifacts: {
    type: "object",
    additionalProperties: false,
    required: ["run_id"],
    properties: {
      run_id: RUN_ID,
      kinds: { type: "array", uniqueItems: true, items: { type: "string", enum: [...MCP_ARTIFACT_KINDS] } },
      max_inline_bytes: { type: "integer", minimum: 0, maximum: 1_048_576, default: 65_536 },
    },
  },
  list_capabilities: { type: "object", additionalProperties: false, properties: {} },
} as const;

const ARTIFACT_LIST = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "artifacts"],
  properties: {
    run_id: RUN_ID,
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artifact_id", "kind", "sha256", "size_bytes"],
        properties: {
          artifact_id: ARTIFACT_ID,
          kind: { type: "string", enum: [...MCP_ARTIFACT_KINDS] },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          size_bytes: { type: "integer", minimum: 0 },
          inline_text: { type: "string" },
        },
      },
    },
  },
} as const;

const CAPABILITIES = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "providers"],
  properties: {
    schema_version: { type: "integer" },
    schema_dialect: { type: "string" },
    client_max_profile: TRUST_PROFILE,
    providers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "adapter_status", "auth_state", "supported_profiles", "transports"],
        properties: {
          provider: { type: "string" },
          adapter_status: {
            type: "string",
            enum: ["DISABLED", "NO_MANIFEST", "ADAPTER_VERSION_UNVERIFIED", "AUTH_REQUIRED", "DEGRADED", "READY"],
          },
          status_detail: { type: "string" },
          binary_version: NULLABLE_STRING,
          validated_range: NULLABLE_STRING,
          auth_state: { type: "string", enum: ["OK", "AUTH_REQUIRED", "UNKNOWN", "NOT_CHECKED"] },
          supported_profiles: { type: "array", items: TRUST_PROFILE },
          transports: { type: "array", items: { type: "string" } },
          models: { type: "array", items: { type: "string" } },
          sandbox_features: { type: "array", items: { type: "string" } },
          // FR-GIT-01: how the adapter denies Git writes, or its declaration that the provider documents no control.
          git_write_control: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "detail", "remaining_controls"],
            properties: {
              kind: { type: "string", enum: ["provider-deny-rules", "none-documented"] },
              detail: { type: "string" },
              remaining_controls: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

const OUTPUTS = {
  delegate_task: withError(ENVELOPE),
  continue_task: withError(ENVELOPE),
  get_run: withError(ENVELOPE),
  cancel_run: withError(ENVELOPE),
  get_artifacts: withError(ARTIFACT_LIST),
  list_capabilities: withError(CAPABILITIES),
} as const;

const DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  delegate_task:
    "Start a coding task in a new meta-session. Asynchronous: returns run_id and meta_session_id at once (status " +
    "QUEUED or later); poll get_run, or pass wait_seconds (0-60) for a bounded wait that never cancels the run. " +
    "trust_profile above this client's maximum fails PERMISSION_BLOCKED. Routing hints only narrow provider choice.",
  continue_task:
    "Continue an idle meta-session on the same provider by resuming its native session. Asynchronous like " +
    "delegate_task. Cross-provider handoff is not available yet.",
  get_run:
    "Current envelope of a run: status, failure code, provider, route reasons, summary, changed-file count and " +
    "artifact ids. Optionally returns compact events after a sequence number.",
  cancel_run:
    "Request cancellation. Asynchronous: the returned status may still be non-terminal; poll get_run. Cancelling a " +
    "finished run returns it unchanged.",
  get_artifacts:
    "List a run's artifacts (diff, changed_files, ...) with hashes; small ones are returned inline as text.",
  list_capabilities:
    "Providers with adapter status, version, validated range, auth state, supported trust profiles, transports and " +
    "how Git writes are denied (FR-GIT-01).",
};

export interface ToolDescriptor {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/** `tools/list` payload. Returns fresh copies so callers cannot mutate the published documents. */
export function toolDescriptors(): ToolDescriptor[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: structuredClone(INPUTS[name]) as Record<string, unknown>,
    outputSchema: structuredClone(OUTPUTS[name]) as Record<string, unknown>,
  }));
}

export function inputSchema(name: ToolName): Record<string, unknown> {
  return structuredClone(INPUTS[name]) as Record<string, unknown>;
}

export function outputSchema(name: ToolName): Record<string, unknown> {
  return structuredClone(OUTPUTS[name]) as Record<string, unknown>;
}
