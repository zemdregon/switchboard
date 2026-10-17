# Documentation alignment notes

| Field | Value |
| --- | --- |
| Status | Working note. Not a specification, requirement or design owner; it records residual conflicts only. |
| Date | 2026-10-13 |
| Why | A documentation-alignment pass (branch `docs/align-with-code-20261013`) read `src/`, `test/` and `scripts/` as the source of truth and corrected the documents. This file lists the items it could **not** fully resolve. |

Everything else the pass found was fixed in the documents it belongs to (stale counts, file paths, command names,
config keys, API symbols, milestone/status claims, and the ledger filename). The items below are conflicts that need a
decision from the owner of the affected document, or that rest on history this pass cannot verify.

## 1. Provider count: seven or eight

- [BRD §5 and §8](requirements/BRD.md) say "seven CLIs", "seven adapters" and "all seven providers" (owner decision 5,
  2026-10-12).
- [PRD §1](requirements/PRD.md) says "up to eight AI coding CLIs" and [SRS §2](requirements/SRS.md) lists eight,
  including Muse Code (added by owner decision 16, 2026-10-13, as a `Should`, FR-ADP-12).
- The code registers **eight** real config providers (`BUILTIN_PROVIDERS` in `src/adapters/providers.ts`, 2026-10-17),
  including `muse`/`muse-code` (T4.72, Delegated). The code now matches PRD and SRS; only BRD still says seven.

This is a document-set inconsistency, not a code conflict. It is left as-is because choosing "seven" or "eight" is an
owner wording decision (the original seven are Must; Muse Code is a Should addition). No code changed.

## 2. SRS FR-GIT-08 "only by the commit tool" and finalize-only (FR-GIT-09)

- [SRS FR-GIT-08](requirements/SRS.md) says published commits "shall be created only by the commit tool".
- [SRS FR-GIT-09](requirements/SRS.md) (finalize-only, implemented by T9.7) has the **controller** create the commit at
  finalization for an adapter that cannot receive the injected channel; it says "subject to FR-GIT-04 to FR-GIT-08".
- The code implements both: the injected `commit` tool for an `injected` adapter, and the controller's finalize commit
  (`origin = 'finalize_only'`) for a `none` adapter when the context sets `finalize_commit`
  (`src/git/finalize.ts`, `src/lifecycle/lifecycle.ts`).

FR-GIT-09 reads as the exception, but FR-GIT-08's "only" is not literally amended. Left unchanged: an amendment is the
SRS owner's call, and the roadmap already records the finalize-only decision (owner decision 36, Q-43).

## 3. TDD §2 environment claims

- [TDD §2](design/TDD.md) records "Node 22 LTS (`engines` `>=22`, developed on 22.22.0)", "npm 10.9.4", and "developed
  against 2.43" (Git).
- The operator machine recorded in [live-checks-2026-10-13.md](research/live-checks-2026-10-13.md) runs Node v24.21.0,
  npm 11.19.0 and Git 2.53.0; this repository's [AGENTS.md](../AGENTS.md) also records Node 24.21.0.
- The project target is unchanged: `engines.node >= 22`, and CI uses Node 22 (`.github/workflows/ci.yml`); the code's
  floor is `MIN_GIT_VERSION = [2, 32, 0]` (`src/workspace/git.ts`).

The "developed on"/"developed against" figures are historical dev-host claims that this pass cannot verify against the
original machine, so they were left in place. They are not a statement about the code.

## 4. LLD §2 `ProviderId` listing includes `muse` (resolved 2026-10-17)

Resolved by T4.72: the registry (`src/adapters/providers.ts`) now has a `muse` entry, so `BuiltinProviderId` includes
`muse` and the [LLD §2](design/LLD.md) listing matches the code. Recorded here only; no document was changed for it in
this pass.

## 5. HLD §5 data-directory layout banner

The layout table in [HLD §5](design/HLD.md) was headed **Proposed**, but the ledger filename (`ledger.sqlite`), the
artifact layout (`artifacts/ab/cd/<sha256>`) and the worktree layout (`worktrees/<sess>/<run>`) are implemented. The
filename was corrected and the banner softened in this pass; any further "Proposed" detail in that table (for example
whether worktrees could live beside the source repository) is a design question for the HLD owner, not a code conflict.

## 6. Roadmap "Current milestone" field

[ROADMAP §6](ROADMAP.md#6-milestones) now records M4 as `Partial` (T4.1 and T4.7 merged). The one-line "Current
milestone" summary at the top of the roadmap still narrates M0 to M3, M9, M10, M11 and M12 without restating M4; that
field is a summary, not the status table, so it was left unchanged.
