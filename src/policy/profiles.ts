/**
 * COMP-POL profile resolution (T2.6, T3.2; FR-POL-01-05, 08, 09; SRS section 3.3; ADR-0004). Resolves a trust-profile
 * name to the frozen snapshot stored on the run (`run.policy_snapshot_json`, TDD 3.1) and handed to `adapter.compile`.
 *
 * Two entry points:
 * - {@link resolveTrustProfile}: all five profiles, with `profiles.<name>` overrides and, for `privileged`, a scope.
 * - {@link resolveProfile} / {@link createProfileResolver}: the M2-gated resolver wired into `RunLifecycle`. Until
 *   T3.3/T3.7 the MCP layer must keep refusing every profile except the two M2 profiles, so these throw
 *   {@link ProfileUnavailableError} for the rest: fail closed (NFR-SEC-06), never a downgrade (FR-POL-02).
 *
 * `bypassApproved` is always false here (FR-POL-03, FR-POL-09; owner decision 13): a bypass is applied later only from
 * an approved `privileged` row (T3.4).
 *
 * Defaults follow the SRS section 3.3 table:
 *
 * | Profile | fileAccess | shell | network | repoConfig |
 * | --- | --- | --- | --- | --- |
 * | `inspect-untrusted` | read-only | none | off | disabled |
 * | `edit-untrusted` | worktree | allowlist | off | disabled |
 * | `test-sandboxed` | worktree | allowlist | off | disabled |
 * | `trusted-development` | worktree | allowlist | off | disabled |
 * | `privileged` | scoped | scoped | scoped | scoped (from the scope object only) |
 *
 * Proposed (Delegated, not owner-approved; ROADMAP Q-17), each the strictest reading of an unspecified SRS cell:
 * - `edit-untrusted` "narrow allowlist": empty, so no shell command until an operator override names commands.
 * - `test-sandboxed` "build/test commands": empty allowlist; "allowlisted hosts": network off; "controller-approved
 *   only" repository config: `disabled` (no approval mechanism exists yet).
 * - `trusted-development` "broader shell": an empty allowlist, not `broad`; "policy-based" network: off; "allowlisted"
 *   repository config: `disabled`. Operators loosen these per field through `profiles.<name>` (owner decision 12).
 */
import type { ResolvedProfile, TrustProfile } from "../adapters/types.js";
import {
  type AppliedOverride,
  OVERRIDABLE_PROFILES,
  OVERRIDE_FIELDS,
  type OverridableProfile,
  type OverrideField,
  type PolicySnapshot,
  type PrivilegedScope,
  type ProfileOverride,
  type ProfileOverrides,
} from "./types.js";

/** Profiles that the M2-gated resolver accepts (FR-POL-01). The MCP layer keeps refusing the rest until T3.3/T3.7. */
export const M2_PROFILES: readonly TrustProfile[] = ["inspect-untrusted", "edit-untrusted"];

/** Thrown for a profile this build cannot resolve. Carries the taxonomy code the MCP layer reports (LLD section 4). */
export class ProfileUnavailableError extends Error {
  override readonly name = "ProfileUnavailableError";
  /**
   * Proposed: `privileged` maps to PERMISSION_BLOCKED (it needs an operator-approved scope, FR-POL-09); a profile that
   * this resolver does not offer maps to ELIGIBILITY_NONE (no provider can satisfy it, FRD BR-3).
   */
  readonly code: "PERMISSION_BLOCKED" | "ELIGIBILITY_NONE";
  constructor(
    readonly profile: string,
    reason?: string,
  ) {
    const privileged = profile === "privileged";
    super(
      reason ??
        (privileged
          ? "the privileged profile needs per-run operator approval, which this version does not provide"
          : `trust profile ${JSON.stringify(profile)} is not available in this version (M2 supports ${M2_PROFILES.join(", ")})`),
    );
    this.code = privileged ? "PERMISSION_BLOCKED" : "ELIGIBILITY_NONE";
  }
}

/** Thrown for an invalid `profiles.<name>` override. The message starts with the config path of the offending key. */
export class ProfileOverrideError extends Error {
  override readonly name = "ProfileOverrideError";
}

const STRICT_BASE = {
  fileAccess: "worktree",
  shell: "allowlist",
  shellAllowlist: [] as string[],
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
} as const;

const DEFAULTS: Readonly<Record<OverridableProfile, ResolvedProfile>> = {
  "inspect-untrusted": {
    name: "inspect-untrusted",
    fileAccess: "read-only",
    shell: "none",
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
  },
  "edit-untrusted": { name: "edit-untrusted", ...STRICT_BASE },
  // Proposed (Q-17): strictest reading, see the module comment.
  "test-sandboxed": { name: "test-sandboxed", ...STRICT_BASE },
  // Proposed (Q-17): strictest reading, see the module comment.
  "trusted-development": { name: "trusted-development", ...STRICT_BASE },
};

/** Restrictiveness order per scalar field: a higher index allows more. */
const RANK = {
  fileAccess: ["read-only", "worktree"],
  shell: ["none", "allowlist", "broad"],
  network: ["off", "allowlist", "policy"],
  repoConfig: ["disabled", "approved-only", "allowlisted"],
} as const;
type ScalarField = keyof typeof RANK;

const CONFIG_KEY: Record<OverrideField, string> = {
  fileAccess: "file_access",
  shell: "shell",
  shellAllowlist: "shell_allowlist",
  network: "network",
  networkAllowlist: "network_allowlist",
  repoConfig: "repo_config",
};

function fail(profile: string, field: OverrideField | undefined, message: string): never {
  const where = field === undefined ? `$.profiles.${profile}` : `$.profiles.${profile}.${CONFIG_KEY[field]}`;
  throw new ProfileOverrideError(`${where}: ${message}`);
}

function checkList(profile: string, field: "shellAllowlist" | "networkAllowlist", list: readonly string[]): void {
  const seen = new Set<string>();
  for (const e of list) {
    if (typeof e !== "string" || e.trim() === "") fail(profile, field, "entries must be non-empty strings");
    // Proposed: a bare "*" is a wildcard in disguise; owner decision 12 wants every loosening explicit.
    if (e.trim() === "*") fail(profile, field, 'a wildcard entry "*" is not permitted; list each entry explicitly');
    if (seen.has(e)) fail(profile, field, `duplicate entry ${JSON.stringify(e)}`);
    seen.add(e);
  }
}

/**
 * Applies one profile's overrides to its default (owner decision 12). Returns the merged profile (bypassApproved
 * false) and the list of overrides that actually changed a default. Throws {@link ProfileOverrideError}.
 */
function applyOverride(
  name: OverridableProfile,
  override: ProfileOverride | undefined,
): { profile: ResolvedProfile; applied: AppliedOverride[] } {
  const base = DEFAULTS[name];
  const applied: AppliedOverride[] = [];
  const merged: ResolvedProfile = { ...base, bypassApproved: false };
  if (base.shellAllowlist) merged.shellAllowlist = [...base.shellAllowlist];
  if (override === undefined) return { profile: merged, applied };

  for (const key of Object.keys(override)) {
    if (!(OVERRIDE_FIELDS as readonly string[]).includes(key)) fail(name, undefined, `unknown override field ${key}`);
  }
  for (const field of ["fileAccess", "shell", "network", "repoConfig"] as const satisfies readonly ScalarField[]) {
    const v = override[field];
    if (v === undefined) continue;
    const order: readonly string[] = RANK[field];
    if (!order.includes(v)) fail(name, field, `must be one of ${order.join(", ")}`);
    const from = base[field];
    if (v === from) continue;
    (merged as unknown as Record<string, string>)[field] = v;
    applied.push({
      profile: name,
      field,
      from,
      to: v,
      direction: order.indexOf(v) > order.indexOf(from) ? "loosen" : "tighten",
    });
  }

  for (const field of ["shellAllowlist", "networkAllowlist"] as const) {
    const v = override[field];
    if (v === undefined) continue;
    if (!Array.isArray(v)) fail(name, field, "must be an array of strings");
    checkList(name, field, v);
    const scalar = field === "shellAllowlist" ? "shell" : "network";
    if (merged[scalar] !== "allowlist") {
      fail(
        name,
        field,
        `requires ${CONFIG_KEY[scalar]} to be "allowlist" (the resulting value is "${merged[scalar]}")`,
      );
    }
    const from = base[field] ?? [];
    const added = v.some((e) => !from.includes(e));
    const removed = from.some((e) => !v.includes(e));
    if (!added && !removed) continue;
    merged[field] = [...v];
    applied.push({
      profile: name,
      field,
      from: [...from],
      to: [...v],
      direction: added ? "loosen" : "tighten",
    });
  }

  // A list field is meaningless unless its scalar field is "allowlist"; drop a list that the scalar override orphaned.
  if (merged.shell !== "allowlist") delete merged.shellAllowlist;
  else merged.shellAllowlist ??= [];
  if (merged.network !== "allowlist") delete merged.networkAllowlist;
  else merged.networkAllowlist ??= [];
  // Without an explicit list, switching to "allowlist" yields the strictest list: empty.
  return { profile: merged, applied };
}

/**
 * Validates `profiles.<name>` overrides for all four overridable profiles without resolving a run. Used by the config
 * loader so a bad override fails at load time (NFR-SEC-06). Throws {@link ProfileOverrideError}.
 */
export function validateProfileOverrides(overrides: ProfileOverrides): AppliedOverride[] {
  for (const key of Object.keys(overrides)) {
    if (!(OVERRIDABLE_PROFILES as readonly string[]).includes(key)) {
      throw new ProfileOverrideError(`$.profiles.${key}: unknown or non-overridable profile`);
    }
  }
  return OVERRIDABLE_PROFILES.flatMap((n) => applyOverride(n, overrides[n]).applied);
}

function deepFreezeCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy)) as T;
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepFreezeCopy(v)]))) as T;
  }
  return value;
}

export interface ResolveOptions {
  /** `profiles.<name>` overrides from the config (owner decision 12). */
  overrides?: ProfileOverrides;
  /** Required for `privileged`, forbidden meaning for every other profile (ignored). Opaque shape, T3.16. */
  scope?: PrivilegedScope;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * Resolves any of the five trust profiles to a deeply frozen {@link PolicySnapshot} (FR-POL-01). Overrides that changed
 * a default are listed in `snapshot.overrides` (only when non-empty). `privileged` resolves only from an explicit scope
 * object (FR-POL-09) and never sets `bypassApproved` (owner decision 13). Throws {@link ProfileUnavailableError} for an
 * unknown name or a missing/malformed scope, and {@link ProfileOverrideError} for an invalid override.
 */
export function resolveTrustProfile(name: TrustProfile, options: ResolveOptions = {}): PolicySnapshot {
  if (name === "privileged") {
    const scope = options.scope;
    if (!isPlainObject(scope)) {
      throw new ProfileUnavailableError(
        "privileged",
        "the privileged profile resolves only from an explicit scope object (FR-POL-09)",
      );
    }
    return deepFreezeCopy<PolicySnapshot>({
      name: "privileged",
      fileAccess: "scoped",
      shell: "scoped",
      network: "scoped",
      repoConfig: "scoped",
      bypassApproved: false,
      scope: scope as PrivilegedScope,
    });
  }
  if (!Object.hasOwn(DEFAULTS, name)) throw new ProfileUnavailableError(String(name));
  const { profile, applied } = applyOverride(name, options.overrides?.[name]);
  return deepFreezeCopy<PolicySnapshot>(applied.length > 0 ? { ...profile, overrides: applied } : profile);
}

/**
 * The `resolveProfile` for `RunLifecycle` (COMP-POL): M2-gated, with config overrides. Only the M2 profiles resolve;
 * everything else, `privileged` included, throws {@link ProfileUnavailableError} until T3.3/T3.7 open the MCP path.
 */
export function createProfileResolver(overrides: ProfileOverrides = {}): (name: TrustProfile) => ResolvedProfile {
  return (name) => {
    if (!M2_PROFILES.includes(name)) throw new ProfileUnavailableError(String(name));
    return resolveTrustProfile(name, { overrides });
  };
}

/** M2-gated resolver with no overrides: a fresh, deeply frozen copy of the SRS defaults. */
export const resolveProfile: (name: TrustProfile) => ResolvedProfile = createProfileResolver();
