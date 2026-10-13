/**
 * The structured `privileged_scope` (T3.3; LLD §3.1; FR-POL-09; owner decisions 13 and 14; ADR-0016): its closed JSON
 * Schema, the "present exactly when" checks the schema cannot express, the canonical form and the v2 scope hash, and the
 * documented mapping from scope spellings to {@link ResolvedProfile} spellings.
 *
 * Proposed (Delegated, not owner-approved), each the strictest reading of LLD §3.1:
 * - `network.hosts` entries must look like a bare host name (letters, digits, dots and hyphens; no scheme, port, path or
 *   wildcard). LLD §3.1 says "host names, no scheme or path" but gives no pattern.
 * - The "present exactly when" rule is checked in code after the schema (LLD §3.1 says the schema cannot say "iff"); its
 *   failures are reported as V1 schema failures (`INVALID_REQUEST`, `details.field` naming the path).
 * - `bypass` is filled with `false` when omitted, before the canonical form and the hash are computed.
 */
import { createHash } from "node:crypto";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ResolvedProfile } from "../adapters/types.js";
import { canonicalJson } from "../lifecycle/request.js";
import type { PrivilegedScope } from "./types.js";

/** Version of the scope-hash input (LLD §3.1). `v: 1` was never implemented and is withdrawn. */
export const SCOPE_HASH_VERSION = 2;

const LIST_MAX = 64;

/**
 * LLD §3.1 `$defs.privileged_scope`. Closed at every level; only keywords that mean the same in draft-07 and 2020-12
 * (the MCP tool schemas publish it inside `delegate_task`, see `src/mcp/schemas.ts`).
 */
export const PRIVILEGED_SCOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["files", "shell", "network", "repository_config"],
  properties: {
    files: {
      type: "object",
      additionalProperties: false,
      required: ["access"],
      properties: { access: { type: "string", enum: ["read-only", "worktree"] } },
    },
    shell: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["none", "allowlist", "broad"] },
        // Present exactly when mode is "allowlist" (checked in code). Each entry is one exact argv.
        allowlist: {
          type: "array",
          minItems: 1,
          maxItems: LIST_MAX,
          items: {
            type: "array",
            minItems: 1,
            maxItems: LIST_MAX,
            items: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    network: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["off", "allowlist", "on"] },
        // Present exactly when mode is "allowlist" (checked in code). Bare host names (Proposed pattern).
        hosts: {
          type: "array",
          minItems: 1,
          maxItems: LIST_MAX,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 253,
            pattern: "^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$",
          },
        },
      },
    },
    repository_config: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { type: "string", enum: ["disabled", "approved", "enabled"] } },
    },
    bypass: { type: "boolean", default: false },
  },
} as const;

export type ScopeCheck =
  | { readonly ok: true; readonly scope: PrivilegedScope }
  | { readonly ok: false; readonly field: string; readonly message: string };

let validator: ValidateFunction | undefined;
function compiled(): ValidateFunction {
  validator ??= new Ajv2020({ allErrors: false, strict: true, useDefaults: true }).compile(PRIVILEGED_SCOPE_SCHEMA);
  return validator;
}

/** `$.a.b[0]` notation for an Ajv error under `prefix` (the MCP layer uses the same notation). */
function pathOf(prefix: string, e: ErrorObject): string {
  let where = e.instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((acc, s) => (/^\d+$/.test(s) ? `${acc}[${s}]` : `${acc}.${s}`), prefix);
  if (e.keyword === "required") where += `.${String(e.params.missingProperty)}`;
  if (e.keyword === "additionalProperties") where += `.${String(e.params.additionalProperty)}`;
  return where;
}

/**
 * The "present exactly when the mode is `allowlist`" rules of LLD §3.1, on a value that already passed the schema.
 * Returns the first violation, or undefined.
 */
export function checkScopeLists(
  scope: { shell: { mode: string; allowlist?: unknown }; network: { mode: string; hosts?: unknown } },
  prefix = "$.privileged_scope",
): { field: string; message: string } | undefined {
  const pairs = [
    ["shell", scope.shell.mode, "allowlist" in scope.shell, "allowlist"],
    ["network", scope.network.mode, "hosts" in scope.network, "hosts"],
  ] as const;
  for (const [dim, mode, present, list] of pairs) {
    if (mode === "allowlist" && !present) {
      return { field: `${prefix}.${dim}.${list}`, message: `${dim}.${list} is required when ${dim}.mode is allowlist` };
    }
    if (mode !== "allowlist" && present) {
      return {
        field: `${prefix}.${dim}.${list}`,
        message: `${dim}.${list} is allowed only when ${dim}.mode is allowlist (it is ${mode})`,
      };
    }
  }
  return undefined;
}

/**
 * Validate and normalise a `privileged_scope` (V1 for the scope, LLD §3.1): the closed schema, then the list rules.
 * Returns a deep copy with defaults filled (`bypass` present); never mutates the input.
 */
export function parsePrivilegedScope(value: unknown, prefix = "$.privileged_scope"): ScopeCheck {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    return { ok: false, field: prefix, message: "must be a plain JSON object" };
  }
  const validate = compiled();
  if (!validate(copy)) {
    const e = validate.errors?.[0];
    return e
      ? { ok: false, field: pathOf(prefix, e), message: e.message ?? "invalid" }
      : { ok: false, field: prefix, message: "invalid" };
  }
  const scope = copy as PrivilegedScope;
  const lists = checkScopeLists(scope as never, prefix);
  if (lists) return { ok: false, ...lists };
  return { ok: true, scope };
}

/** `scope_json` (LLD §3.1): sorted keys, list order kept as given. Expects a parsed (defaults-filled) scope. */
export function canonicalScopeJson(scope: PrivilegedScope): string {
  return canonicalJson(scope);
}

/**
 * `scope_hash` v2 (LLD §3.1): hex SHA-256 over `canonicalJson({ v: 2, client_id, meta_session_id, scope })`. The same
 * for every run of one meta-session and client under one scope; different for any other client, meta-session or scope
 * (owner decision 14).
 */
export function privilegedScopeHash(input: {
  readonly clientId: string;
  readonly metaSessionId: string;
  readonly scope: PrivilegedScope;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        v: SCOPE_HASH_VERSION,
        client_id: input.clientId,
        meta_session_id: input.metaSessionId,
        scope: input.scope,
      }),
    )
    .digest("hex");
}

// ---- Spelling alignment (LLD §3.1 table) ---------------------------------------------------------------------------
//
// The scope keeps the LLD §3.1 spellings and `ResolvedProfile` keeps the M2 spellings; neither enum is renamed (the
// least invasive fix: M2 profiles, overrides, config and adapters are untouched). For `privileged` the snapshot's scalar
// fields stay `scoped` and adapters (T3.5, T3.6) read `privilegedScope.scope` through these maps. `null` means "no
// profile counterpart": an adapter must compile that value from the scope itself or return `Ineligible` naming the
// dimension, never map it onto a nearby profile value.

/** `files.access` -> `fileAccess`: identical values. */
export const SCOPE_FILES_TO_PROFILE = {
  "read-only": "read-only",
  worktree: "worktree",
} as const satisfies Record<PrivilegedScope["files"]["access"], ResolvedProfile["fileAccess"]>;

/** `shell.mode` -> `shell`: identical values. Note the list shapes differ: scope argv arrays vs profile strings. */
export const SCOPE_SHELL_TO_PROFILE = {
  none: "none",
  allowlist: "allowlist",
  broad: "broad",
} as const satisfies Record<PrivilegedScope["shell"]["mode"], ResolvedProfile["shell"]>;

/** `network.mode` -> `network`: scope `on` (unrestricted) has no counterpart; profile `policy` is not offered in a scope. */
export const SCOPE_NETWORK_TO_PROFILE = {
  off: "off",
  allowlist: "allowlist",
  on: null,
} as const satisfies Record<PrivilegedScope["network"]["mode"], ResolvedProfile["network"] | null>;

/** `repository_config.mode` -> `repoConfig`: `approved` is `approved-only`; `enabled` (all loaded) is scope-only. */
export const SCOPE_REPO_CONFIG_TO_PROFILE = {
  disabled: "disabled",
  approved: "approved-only",
  enabled: null,
} as const satisfies Record<PrivilegedScope["repository_config"]["mode"], ResolvedProfile["repoConfig"] | null>;
