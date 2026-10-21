# ADR-0077: Bypass runs are not confined to the worktree; every provider gets a bypass cell

- Status: Accepted (built 2026-10-20)
- Date: 2026-10-20
- Decided by: zemdregon (owner ruling, 2026-10-20 17:48 CDT, 22:48Z; recorded on the operator host at
  `~/operator-runs/owner-rulings/20261020T2248Z-bypass-unconfined.md`). The ruling's words are quoted below. Everything
  marked **Delegated** is the coder's reading and realisation, not owner-approved line by line.
- Supersedes in part: [ADR-0004](0004-trust-profiles-no-bypass-flags.md) and
  [ADR-0017](0017-approved-privileged-scope-bypass.md), only to the extent that they (or the owner decisions they
  record) keep an approved bypass run inside its worktree or keep a provider without a bypass cell;
  [ADR-0059](0059-cursor-bypass-cell-bubblewrap-wrapper.md) for the Cursor bypass cell (the wrapper is no longer
  applied to it). Everything else in those ADRs stands: a bypass flag is still emitted only for an approved
  `privileged` scope that sets `bypass`, and the argv audit still refuses every bypass-class flag elsewhere.
- Related: FR-POL-02, FR-POL-03, FR-POL-06, FR-WS-01, FR-GIT-01, FR-GIT-03, FR-GIT-11, owner decisions 46 and 77,
  [ADR-0039](0039-switchboard-side-tool-call-guard.md), [ADR-0051](0051-outer-sandbox-detection-and-fail-closed-requirement.md),
  [TDD §4](../design/TDD.md#4-provider-adapter-strategy), [ROADMAP T4.81](../ROADMAP.md#68-m4-adapter-expansion-tasks).

## Context

The owner ruling, verbatim:

> "Bypass mode is permitted to work outside its worktree. Restrictions within the worktree are for lower tier modes.
> Make sure everything can run a bypass mode in a new PR, and get all switched on/enabled at least in bypass mode,
> others can wait"

Before this change two bypass cells still confined the provider to its worktree: Grok Build compiled
`--sandbox strict` or `--sandbox workspace`, and Cursor started inside the ADR-0059 bubblewrap wrapper. Codex had no
bypass cell at all (`CODEX_BYPASS_UNDOCUMENTED`): [R2] did not document a bypass flag precisely enough to emit. The
live malicious leg failed a bypass run whose canary read "ESCAPED" (C-M3, A-M2, G-M2 and others) unless a plug-in
marked that check expected. Owner decision 77 had already said bypass "has full access by design", but the SRS note
under it still listed "worktree isolation" as kept in bypass, and ADR-0059 kept the Cursor wrapper.

## Decision

1. **An approved bypass run may read and write outside its worktree.** It still starts in a controller-created
   worktree (FR-WS-01) and the controller's own Git work still happens only there; the agent is simply not confined
   to it. Worktree confinement is a property of every lower tier: every profile other than an approved `privileged`
   scope with `bypass` keeps the controls it had, and no lower-tier cell changes in this ADR.
2. **What bypass keeps.** The Git-write denial (FR-GIT-01: the tool-call guard's `git_write` verdict of ADR-0039 and
   the FR-GIT-03 ref snapshot), the pre-push secret scan (FR-GIT-11), the credential rules (FR-GIT-06, ADR-0003) and
   the approval rules of ADR-0017 and ADR-0019. A ref change in a bypass run is still a failure.
3. **Codex bypass cell.** `codex exec --help` of codex-cli 0.162.0 on the operator host (2026-10-20) documents
   `--dangerously-bypass-approvals-and-sandbox` ("Skip all confirmation prompts and execute commands without
   sandboxing. EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed"). The
   approved bypass cell compiles it in place of `--sandbox`, for worktree files, shell `broad` and network `on`;
   repository configuration `disabled` keeps `--ignore-user-config --ignore-rules`, `enabled` omits them, `approved`
   is refused (only all-or-nothing flags). **Delegated:** read-only files, a narrower shell and network `off` or
   `allowlist` are `CAPABILITY_MISSING`, because the flag turns the sandbox off and nothing else keeps those limits.
   The flag and `--sandbox danger-full-access` are declared bypass-class in the provider registry, so the argv audit
   refuses them everywhere else; `CODEX_BYPASS_UNDOCUMENTED` is removed.
4. **Grok Build.** The worktree-files bypass cell compiles `--sandbox off` (a built-in profile in [SBX], given
   explicitly so no configuration default confines the run) with `--always-approve`. **Delegated:** worktree files
   with network `off` are `CAPABILITY_MISSING` (`off` keeps no child network off); read-only files keep
   `--sandbox read-only --disable-web-search`, which is a write limit the scope asked for, not worktree confinement.
5. **Cursor.** The bypass cell starts `cursor-agent` directly, without the ADR-0059 wrapper, and the probe no longer
   has a `confinement` step, so a host without bubblewrap can run it. The wrapper is not needed for anything else in
   this cell: its Git side effect was never the declared control (ADR-0059 "Git inside the run"). `confinement.ts` and
   its module tests stay for a future lower-tier Cursor cell; no lower-tier Cursor cell compiles today.
6. **Claude Code, OpenCode, Kimi Code and Antigravity** already confined nothing to the worktree in their bypass cells
   (Claude drops `--restricted` there; the others have no sandbox in the cell). They are unchanged except as item 7.
7. **A model in the bypass cell.** **Delegated:** so that a model group (`model_groups`, ADR-0055) can route bypass
   work to every provider, the bypass cells of Codex (`--model`), Grok Build (`--model`), Cursor (`--model`), OpenCode
   (`--model`) and Antigravity (`--model`) emit a requested model, each flag taken from the installed `--help` on the
   operator host on 2026-10-20. The id must match the model registry's plain-identifier shape (`MODEL_ID_PATTERN`),
   so it can never be read as a flag; anything else is `CAPABILITY_MISSING`. Claude Code and Kimi Code already did
   this. Codex lower tiers still refuse a model (unchanged).
8. **Live malicious leg.** A canary `ESCAPED` in a check whose scope sets `bypass` is reported as expected under this
   ADR and does not set the exit code (`withBypassExpectation` in `scripts/live-malicious.mjs`); an `ESCAPED` with a
   ref change, and any `ESCAPED` in a run without `bypass` (for example Kimi Code's K-M1 and K-M2), still fail the leg.
   X-M3 is now a real approved Codex bypass run (`MODEL_RUNS.codex` is 3).
9. **Muse Code and Copilot are out of scope** ("others can wait" names no change to them): Muse stays off in
   production and its cells are unchanged.

## Alternatives considered

- **A new `files.access` value (`unconfined`) instead of reading `bypass` as unconfined.** Rejected (Delegated): the
  ruling ties unconfinement to bypass itself, and a new value would change the canonical scope and its hash
  (ADR-0017 item 3) for every stored approval.
- **Keep the Cursor wrapper but bind more of the file system.** Rejected: the ruling says confinement is for lower
  tiers; any bind set is still a confinement, and the wrapper made Cursor unavailable on hosts without bubblewrap.
- **Grok `--sandbox workspace` for network `on`.** Rejected: it confines writes to the worktree, which the ruling
  removes for bypass.
- **Codex `--sandbox danger-full-access` instead of the bypass flag.** Not chosen: it lifts the sandbox but leaves
  approvals on, which a headless run cannot answer; the documented bypass flag does both. It is declared bypass-class.

## Consequences

- Bypass runs can read operator files outside the worktree, including other providers' and the CLI's own login
  stores. That is what the ruling permits; the operator chooses bypass per scope (ADR-0017), and production clients
  keep their `max_trust_profile` ceilings.
- Risks R-72, R-74 and R-76 (out-of-worktree reads in bypass runs) are expected behaviour, not defects.
- Hermetic tests: `src/adapters/codex/codex.test.ts`, `src/adapters/grok/*.test.ts`, `src/adapters/cursor/*.test.ts`,
  `src/adapters/opencode/*.test.ts`, `src/adapters/antigravity/*.test.ts`, `test/malicious/adapter-leg.test.ts` and
  `test/live-malicious.test.ts` pin the new cells, the lower tiers that stay confined and the harness rule.
- The operator's live-run pin wrapper (`~/operator-runs/live-ext/pin-wrap.sh`) no longer sees Cursor behind `bwrap`;
  the channel must link `cursor-agent` in its pin directory again (an operator step, not a repository task).

## Status note (2026-10-21, follow-up; Delegated)

The decision is unchanged. Two gaps found while enabling the providers in production are closed:

- **Doctor's model-group check.** It refused a member whenever the adapter's `reportedModelFlag` (about pinning a
  *reported* model, T7.12) was `not_accepted`, so the Codex, Cursor and Kimi Code members of a `bypass` group showed
  `CAPABILITY_MISSING` although their bypass cells pass a requested model (item 7). Adapters now declare
  `requestedModelFlag` (`cells: "bypass"` for Codex, Grok Build, Cursor, OpenCode, Antigravity and Kimi Code); when it
  is present doctor resolves the member in the model registry and labels it "approved bypass cell only". An adapter
  without it keeps the old check. Routing is unchanged.
- **Manifests.** `switchboard adapters validate` passed on the operator host on 2026-10-21 for Cursor 2026.10.19,
  Antigravity 1.4.3 and Grok Build 1.0.50 (one smoke call each in the approved bypass cell, model pinned by the
  operator's live-models configuration); the commands wrote the manifest fields recorded here. Grok Build's range
  admits a version for the first time.
