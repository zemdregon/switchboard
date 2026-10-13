/**
 * COMP-POL types (T3.2; FR-POL-01, FR-POL-09; owner decisions 12 and 13).
 */
import type { ResolvedProfile, TrustProfile } from "../adapters/types.js";

/**
 * The structured `privileged_scope` (LLD §3.1, T3.3; FR-POL-09; owner decisions 13 and 14; ROADMAP Q-23 answered). Every
 * dimension is required and closed; `shell.allowlist` exists exactly when `shell.mode` is `allowlist`, `network.hosts`
 * exactly when `network.mode` is `allowlist` (checked by {@link parsePrivilegedScope} in `./scope.ts`). `bypass` is
 * always present once defaults are filled (`false` when omitted). COMP-POL never derives `bypassApproved` from it: the
 * resolver always returns `bypassApproved: false`; only an `APPROVED` approval row can set it (T3.4, owner decision 13).
 *
 * The scope keeps its own spellings, which differ from {@link ResolvedProfile}'s in three places; `./scope.ts` owns the
 * mapping (`SCOPE_NETWORK_TO_PROFILE`, `SCOPE_REPO_CONFIG_TO_PROFILE`): network `on` has no profile counterpart (the
 * profile value `policy` is not the same thing), repository configuration `approved` is the profile's `approved-only`,
 * and `enabled` is scope-only.
 */
export interface PrivilegedScope {
  readonly files: { readonly access: "read-only" | "worktree" };
  readonly shell:
    | { readonly mode: "none" | "broad" }
    /** Each entry is one exact argv (program and arguments); no wildcard, no shell string. */
    | { readonly mode: "allowlist"; readonly allowlist: readonly (readonly string[])[] };
  readonly network:
    | { readonly mode: "off" | "on" }
    /** Host names only (no scheme, port or path). */
    | { readonly mode: "allowlist"; readonly hosts: readonly string[] };
  readonly repository_config: { readonly mode: "disabled" | "approved" | "enabled" };
  readonly bypass: boolean;
}

/**
 * What a `privileged` policy snapshot records (LLD §2 `ResolvedProfile.privilegedScope`, §3.1): the canonical scope, the
 * v2 scope hash bound to (client, meta-session, scope) and the approval row that covers the run.
 */
export interface PrivilegedScopeBinding {
  readonly scope: PrivilegedScope;
  readonly scopeHash: string;
  readonly approvalId: string;
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
 * non-empty, `overrides` (the applied config overrides); for `privileged`, `ResolvedProfile.privilegedScope` carries
 * the scope, its hash and the approval ID (LLD §2, §3.1). Default profiles with no overrides serialise exactly as a bare
 * `ResolvedProfile`.
 */
export interface PolicySnapshot extends ResolvedProfile {
  readonly overrides?: readonly AppliedOverride[];
}
