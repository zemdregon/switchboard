/**
 * Test-only (excluded from the build): `privileged` profiles over every structured scope shape (LLD §3.1, T3.5, T3.6,
 * T3.17). The profile comes from the real resolver, so the adapters are tested on what the controller hands them.
 */
import { resolveTrustProfile } from "../../policy/profiles.js";
import type { PrivilegedScope } from "../../policy/types.js";
import type { ResolvedProfile } from "../types.js";

/** Placeholder binding values in the resolver's formats; nothing here is a real approval. */
export const TEST_SCOPE_HASH = "0".repeat(64);
export const TEST_APPROVAL_ID = "apv_00000000000000000000000000";

export function privilegedProfile(scope: PrivilegedScope): ResolvedProfile {
  return resolveTrustProfile("privileged", {
    privileged: { scope, scopeHash: TEST_SCOPE_HASH, approvalId: TEST_APPROVAL_ID },
  });
}

/** Shell allowlist used by the sweeps: read-only commands, each one exact argv. */
export const SCOPE_ALLOWLIST: readonly (readonly string[])[] = [
  ["npm", "test"],
  ["git", "status"],
];

/** Every scope the LLD §3.1 schema accepts, with one representative list per allowlist mode. */
export function scopeShapes(): PrivilegedScope[] {
  const out: PrivilegedScope[] = [];
  for (const access of ["read-only", "worktree"] as const)
    for (const shell of [
      { mode: "none" },
      { mode: "allowlist", allowlist: SCOPE_ALLOWLIST },
      { mode: "broad" },
    ] as const satisfies readonly PrivilegedScope["shell"][])
      for (const network of [
        { mode: "off" },
        { mode: "allowlist", hosts: ["registry.example.test"] },
        { mode: "on" },
      ] as const satisfies readonly PrivilegedScope["network"][])
        for (const repo of ["disabled", "approved", "enabled"] as const)
          for (const bypass of [false, true])
            out.push({ files: { access }, shell, network, repository_config: { mode: repo }, bypass });
  return out;
}

/** The loosest scope Decision 18 describes: worktree files, broad shell, network on, repository config disabled. */
export const LOOSE_SCOPE: PrivilegedScope = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "disabled" },
  bypass: false,
};
