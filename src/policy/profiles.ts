/**
 * COMP-POL profile resolution for M2 (T2.6; FR-POL-01–05, 08, 09; SRS §3.3; ADR-0004). Resolves a trust-profile name to
 * the frozen snapshot stored on the run (`run.policy_snapshot_json`, TDD §3.1) and handed to `adapter.compile`.
 *
 * Only the two M2 profiles resolve (FR-POL-01 milestone column). Every other name, including `privileged`, throws
 * {@link ProfileUnavailableError}: fail closed (NFR-SEC-06), never a downgrade to a weaker or stronger profile
 * (FR-POL-02). `bypassApproved` is always false: no operator approval exists before M3 (FR-POL-03, FR-POL-09).
 *
 * Values follow the SRS §3.3 table:
 *
 * | Profile | fileAccess | shell | network | repoConfig |
 * | --- | --- | --- | --- | --- |
 * | `inspect-untrusted` | read-only | none | off | disabled |
 * | `edit-untrusted` | worktree | allowlist | off | disabled |
 *
 * Proposed (Delegated, not owner-approved): the `edit-untrusted` "narrow allowlist" defaults to an empty list, so no
 * shell command is allowed until a later config key (`profiles.<name>`, TDD §3.1, may only tighten) or an ADR names
 * commands. The SRS names no default commands, and an empty list is the narrowest reading. The config has no
 * `profiles` key yet, so there is nothing to merge; the snapshot is always the default.
 */
import type { ResolvedProfile, TrustProfile } from "../adapters/types.js";

/** Profiles that resolve in M2 (FR-POL-01). */
export const M2_PROFILES: readonly TrustProfile[] = ["inspect-untrusted", "edit-untrusted"];

/** Thrown for a profile this build cannot resolve. Carries the taxonomy code the MCP layer reports (LLD §4). */
export class ProfileUnavailableError extends Error {
  override readonly name = "ProfileUnavailableError";
  /**
   * Proposed: `privileged` maps to PERMISSION_BLOCKED (it needs operator approval, FR-POL-09, which M2 lacks); a
   * profile that no adapter compiles yet maps to ELIGIBILITY_NONE (no provider can satisfy it, FRD BR-3).
   */
  readonly code: "PERMISSION_BLOCKED" | "ELIGIBILITY_NONE";
  constructor(readonly profile: string) {
    const privileged = profile === "privileged";
    super(
      privileged
        ? "the privileged profile needs per-run operator approval, which this version does not provide"
        : `trust profile ${JSON.stringify(profile)} is not available in this version (M2 supports ${M2_PROFILES.join(", ")})`,
    );
    this.code = privileged ? "PERMISSION_BLOCKED" : "ELIGIBILITY_NONE";
  }
}

const DEFAULTS: Readonly<Record<string, ResolvedProfile>> = {
  "inspect-untrusted": {
    name: "inspect-untrusted",
    fileAccess: "read-only",
    shell: "none",
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
  },
  "edit-untrusted": {
    name: "edit-untrusted",
    fileAccess: "worktree",
    shell: "allowlist",
    shellAllowlist: [],
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
  },
};

/**
 * Production `resolveProfile` for `RunLifecycle` (COMP-POL). Returns a fresh, deeply frozen copy so a caller can never
 * mutate the defaults or a stored snapshot.
 */
export function resolveProfile(name: TrustProfile): ResolvedProfile {
  const base = Object.hasOwn(DEFAULTS, name) ? DEFAULTS[name] : undefined;
  if (base === undefined || base.bypassApproved) throw new ProfileUnavailableError(String(name));
  const copy: ResolvedProfile = {
    ...base,
    ...(base.shellAllowlist ? { shellAllowlist: Object.freeze([...base.shellAllowlist]) as string[] } : {}),
  };
  return Object.freeze(copy);
}
