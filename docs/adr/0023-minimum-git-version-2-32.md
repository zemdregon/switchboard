# ADR-0023: Minimum Git version raised from 2.30 to 2.32

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions) (best practice for a
  decision that does not affect bypass mode). Not an zemdregon quote and not owner-approved. Recorded as owner decision 30 in
  the roadmap for traceability only.
- Related: [TDD §2](../design/TDD.md#2-technology-choices) and [§3.10](../design/TDD.md#310-git-commits-attribution-and-publication),
  NFR-SEC-03, ROADMAP Q-39, R-44, T9.0

## Context

`MIN_GIT_VERSION` was `[2, 30, 0]`, a conservative floor chosen in T1.5. `scrubbedGitEnv()` in `src/workspace/git.ts`
sets `GIT_CONFIG_GLOBAL=/dev/null` so that controller Git calls ignore the operator's global configuration. The Git
2.32.0 release notes introduce `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`. On 2.30 and 2.31 the variable would be
unknown to Git, so an operator alias, identity, hook path or filter in the global configuration could be read by a
controller call, while `doctor` reported the Git as acceptable. This is inferred from the release notes: no Git older
than 2.43.0 is installed here to test it. The T9.0 spike also found that the layer 3 Git guard (TDD §3.10) wants
`GIT_CONFIG_COUNT`, which the 2.31.0 notes introduce without naming it (inferred).

## Decision

1. `MIN_GIT_VERSION` becomes `[2, 32, 0]`. `doctor` and the workspace manager's Git check read the constant, so a Git
   older than 2.32.0 is a `fail` in `doctor` and `GIT_UNAVAILABLE` at run preparation.
2. The README, TDD §2 and the code comment state 2.32. No requirement ID changes.
3. This has no effect on bypass mode: it adds no permission, approval or flag rule, and only refuses to start on a Git
   too old to honour the controller's own isolation variables.

## Consequences

- Hosts on Git 2.30 or 2.31 must upgrade Git or install a newer one; which distributions still ship those versions was not
  checked.
- Closes R-44 and Q-39. The layer 3 guard no longer needs a further floor change for `GIT_CONFIG_COUNT`.
- Unverified: that 2.32.0 is the exact introduction version (taken from the release notes, not tested on 2.32), and
  every other behaviour on versions other than 2.43.0.

## Alternatives considered

- **Keep 2.30 and document the gap.** Rejected: `doctor` would accept a Git on which the controller's configuration
  isolation does not hold.
- **Raise to a newer floor (for example 2.40 for `--attr-source`).** Rejected: no feature in use needs it, and it would
  exclude more supported hosts for no gain.
- **Branch on the detected version and use another isolation method below 2.32.** Rejected: two code paths to test for
  a version range with no demonstrated need.

## Revisit when

A feature the controller adopts needs a newer Git, or a supported host cannot provide 2.32.
