/**
 * COMP-POL types (T3.2; FR-POL-01, FR-POL-09; owner decisions 12 and 13).
 */
import type { ResolvedProfile, TrustProfile } from "../adapters/types.js";

/**
 * The input that `privileged` resolves from (FR-POL-09). Deliberately minimal and open: the scope SHAPE is owned by the
 * `privileged_scope` contract designed in T3.16 (LLD §3) and consumed by T3.3; they extend this interface. COMP-POL only
 * requires that a scope object is supplied, stores a frozen copy in the snapshot, and never reads `bypass` from it:
 * `bypassApproved` is always false from the resolver (owner decision 13: bypass is applied later, only from an approved
 * row, T3.4).
 */
export interface PrivilegedScope {
  readonly [field: string]: unknown;
}

/** Profiles that accept `profiles.<name>` overrides. `privileged` is excluded: its contents come from the scope. */
export const OVERRIDABLE_PROFILES = [
  "inspect-untrusted",
  "edit-untrusted",
  "test-sandboxed",
  "trusted-development",
] as const satisfies readonly TrustProfile[];
export type OverridableProfile = (typeof OVERRIDABLE_PROFILES)[number];

/** Per-field override of one profile (owner decision 12). Every field is explicit; there is no wildcard. */
export interface ProfileOverride {
  fileAccess?: "read-only" | "worktree";
  shell?: "none" | "allowlist" | "broad";
  shellAllowlist?: string[];
  network?: "off" | "allowlist" | "policy";
  networkAllowlist?: string[];
  repoConfig?: "disabled" | "approved-only" | "allowlisted";
}
export type ProfileOverrides = Partial<Record<OverridableProfile, ProfileOverride>>;

export const OVERRIDE_FIELDS = [
  "fileAccess",
  "shell",
  "shellAllowlist",
  "network",
  "networkAllowlist",
  "repoConfig",
] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

/** One override that changed a default, as recorded in the run's policy snapshot and listed by `doctor`. */
export interface AppliedOverride {
  readonly profile: OverridableProfile;
  readonly field: OverrideField;
  readonly from: string | readonly string[] | null;
  readonly to: string | readonly string[] | null;
  /** `loosen` widens what the default allows, `tighten` narrows it (list fields: adds entries / removes entries). */
  readonly direction: "loosen" | "tighten" | "change";
}

/**
 * The frozen snapshot stored on the run (`run.policy_snapshot_json`). A {@link ResolvedProfile} plus, only when
 * non-empty, `overrides` (the applied config overrides) and, for `privileged`, `scope`. Default profiles with no
 * overrides serialise exactly as a bare `ResolvedProfile`.
 */
export interface PolicySnapshot extends ResolvedProfile {
  readonly overrides?: readonly AppliedOverride[];
  readonly scope?: PrivilegedScope;
}
