/**
 * COMP-POL types (T3.2; FR-POL-01, FR-POL-09; owner decisions 12 and 13).
 */
import type { ResolvedProfile, TrustProfile } from "../adapters/types.js";

/**
 * The structured `privileged_scope` (LLD §3.1, T3.3; FR-POL-09; owner decisions 13 and 17; ROADMAP Q-28 answered). Every
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
 * The project a run was admitted under (FR-PRJ-03, FR-PRJ-04, FR-PRJ-06; T9.2), frozen into the policy snapshot as
 * `project`. Absent for a run delegated by workspace path. Host environments only until M10: `environment_kind` is
 * recorded so a `container` run can be told apart later (the image digest joins it in M10). Never holds a path or
 * credential; `repository` paths stay in configuration. Proposed shape (Delegated), LLD §11.2 step 6.
 */
export interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly environment_kind: "host" | "container";
  /** The primary repository context whose worktree is the agent's working directory. */
  readonly context_id: string;
  readonly base_ref: string;
  /** The lower of the client's and the project's ceiling when the run was admitted (FR-PRJ-06). */
  readonly effective_max_profile: TrustProfile;
  /** The project's allowed providers when it declared any; absent means no restriction. */
  readonly allowed_providers?: readonly string[];
  /**
   * T9.4 (ROADMAP Q-41, ADR-0026): the primary context's Git facts as of admission, so a configuration edit after
   * admission cannot change the identity a run's commits use or the push policy it runs under. `writable` is the
   * context's own flag; `identity` is absent when the context configures none (then no commit tool is offered). Not
   * secrets: an author name and e-mail address, and the push policy name. The remote and branch prefix are NOT frozen:
   * the schema does not restrict `remote` to a remote name, so it could hold a URL with credentials, which must never
   * reach the ledger (NFR-SEC-01); T9.6 decides how the push target is resolved. Absent on snapshots written before
   * T9.4; such runs are offered no commit tool.
   */
  readonly writable?: boolean;
  readonly identity?: { readonly name: string; readonly email: string };
  readonly push?: { readonly policy: "none" | "branch" };
  /**
   * T9.7 (FR-GIT-09, FRD BR-30, owner decision 36): the primary context's finalize-only opt-in, frozen at admission.
   * Present (and `true`) only when the context enabled it; absent means off (also on snapshots written before T9.7).
   */
  readonly finalize_commit?: true;
}

/**
 * The frozen snapshot stored on the run (`run.policy_snapshot_json`). A {@link ResolvedProfile} plus, only when
 * non-empty, `overrides` (the applied config overrides); for `privileged`, `ResolvedProfile.privilegedScope` carries
 * the scope, its hash and the approval ID (LLD §2, §3.1). Default profiles with no overrides serialise exactly as a bare
 * `ResolvedProfile`.
 */
export interface PolicySnapshot extends ResolvedProfile {
  readonly overrides?: readonly AppliedOverride[];
  /** Only for a run delegated to a project (T9.2). */
  readonly project?: ProjectSnapshot;
}
