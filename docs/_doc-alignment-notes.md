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

## 7. M2 row "453 tests locally" figure (pre-existing, not from PR #635)

The M2 row in [ROADMAP §6](ROADMAP.md#6-milestones) says "453 tests locally" (dating to the FR-GIT-01 argv commit;
PR #635 did not touch the figure). `npx vitest list` on this branch collects 3,499 test cases across 194 files, so
453 is not the suite total; it may be an M2-scope count from that earlier date, but its scope is not stated and the
passing total cannot be verified without running the full suite. Left unchanged: fixing it needs either a scoped
re-count with a stated scope or a full test run, both outside a docs-only alignment pass. It does not block PR #635
(T2.8's own evidence is the live `doctor` note and the `sameVersion` tests, which the T2.8 row cites directly).

## 8. T12.9 "remains Planned" summary vs "Done on fakes" row (pre-existing, not from PR #633)

- The [SRS §5](requirements/SRS.md) capability→requirements mapping (extended by PR #641 to match each
  requirement's own Source column) now includes FR-EXE-09 (CAP-1), FR-WS-10–11 (CAP-4), FR-CTL-12 (CAP-15) and
  FR-QUE-04–05 (CAP-16).
- The [HLD §2](design/HLD.md) component rows still cite the narrower ranges: COMP-MCP `FR-CTL-01..11`, COMP-WS
  `FR-WS-01..07`, COMP-EXE `FR-EXE-01..08`, COMP-RTE `FR-QUE-01..02` (with COMP-PRJ `FR-QUE-03`). Those
  requirements entered the SRS with PR #638, so the gap predates PR #641, which only extended the SRS mapping
  rows (correctly) and added the COMP-SKL row.
- Left unchanged: re-attributing the newer requirements to HLD components is the HLD owner's call (for example
  the SDD puts FR-CTL-12, webhook sink authorization, under COMP-OPS, not COMP-MCP), and the HLD rows are loose
  summaries rather than the traceability owner (the SDD covers every one of these IDs, and
  `node scripts/check-docs.mjs` passes). It does not block PR #641.

The "Current milestone" summary at the top of [ROADMAP §6](ROADMAP.md#6-milestones) says "T12.9 (Could) remains
Planned", while the M12 milestone row in the same table and the T12.9 row in §6.7 both say T12.9 is "Done on fakes
(2026-10-16, Delegated ...)". Both wordings are present on `origin/main`, so the contradiction predates PR #633 (which
only reworded the T12.9 row's channel clause from "stays UNSUPPORTED per T9.4b" to "supported, bypass-only since owner
decision 56"). Left unchanged: reconciling the summary with the row means endorsing another task's Done claim, which
is that task's status decision, not this PR's. It does not block PR #633 (T9.4b's own evidence is the T9.4b status
block, the 2026-10-14 live checks and owner decision 56, all cited directly).

## 9. HLD component rows cite pre-#638 requirement ranges (pre-existing, not from PR #641)

- The [SRS §5](requirements/SRS.md) capability→requirements mapping (extended by PR #641 to match each
  requirement's own Source column) now includes FR-EXE-09 (CAP-1), FR-WS-10–11 (CAP-4), FR-CTL-12 (CAP-15) and
  FR-QUE-04–05 (CAP-16).
- The [HLD §2](design/HLD.md) component rows still cite the narrower ranges: COMP-MCP `FR-CTL-01..11`, COMP-WS
  `FR-WS-01..07`, COMP-EXE `FR-EXE-01..08`, COMP-RTE `FR-QUE-01..02` (with COMP-PRJ `FR-QUE-03`). Those
  requirements entered the SRS with PR #638, so the gap predates PR #641, which only extended the SRS mapping
  rows (correctly) and added the COMP-SKL row.
- Left unchanged: re-attributing the newer requirements to HLD components is the HLD owner's call (for example
  the SDD puts FR-CTL-12, webhook sink authorization, under COMP-OPS, not COMP-MCP), and the HLD rows are loose
  summaries rather than the traceability owner (the SDD covers every one of these IDs, and
  `node scripts/check-docs.mjs` passes). It does not block PR #641.

## 10. M7 wave-B planning notes vs Done rows (pre-existing, not from PR #645)

- The §6.12 sequencing notes still say "T7.8 is blocked on T7.12 (its row)", that T7.9 and T7.12 "wait for
  `src/adapters/**`", and (in §6.12.1) that "T7.9 and T7.12 wait for `src/adapters/**` (T7.12: Q-90)".
- The T7.8, T7.9 and T7.12 rows themselves all record `Done`/`Done on fakes` (2026-10-14 and 2026-10-16), and the M7
  milestone row agrees.
- Both wordings are present on `origin/main`, so the contradiction predates PR #645 (which only flips T7.13 to Done
  and does not touch the wave notes). Left unchanged: the notes are planning history, and reconciling them means
  restating other tasks' sequencing, which is the roadmap owner's call. It does not block PR #645 (T7.13's own
  evidence is the T7.13 status block, cited directly).

## 11. LLD §18.3 `CANCELLED` predecessor: Proposed fail-closed vs implemented unblock (pre-existing, not from PR #660)

- [LLD §18.3](design/LLD.md#183-priority-and-dependencies-fr-que-01) says a predecessor in `CANCELLED` or
  `FAILED_ADMISSION` blocks the successor until the operator removes the edge or cancels the successor
  (**Proposed** fail-closed behaviour).
- The code (`isBlockingPredecessor` in `src/ledger/work-queue.ts`) treats `CANCELLED` like `DONE`: only a
  predecessor outside `DONE`/`CANCELLED` blocks, so `FAILED_ADMISSION` blocks but `CANCELLED` unblocks.
- PR #660 refactors that check into a shared helper and reuses it for the enqueue-time initial state, preserving the
  `CANCELLED`-unblocks semantics; it neither introduces nor worsens the divergence. Left unchanged: adopting the
  Proposed fail-closed behaviour for `CANCELLED` is the LLD owner's call. It does not block PR #660 (the fix's own
  evidence is the `src/queue/work-queue.test.ts` T15.1 tests, cited in LLD §18.3).

  **Resolved 2026-10-17 by PR #665** (`sb/2026-10-17-fix-stuck-running`): `isBlockingPredecessor` now blocks on every
  predecessor outside `DONE` (only `DONE` satisfies an edge), `closeWorkItemForRun` in `src/ledger/work-queue.ts`
  (called from `casRunState` in `src/ledger/repo.ts`) stamps `terminal_at` on an `ADMITTED` item whose run ends
  `FAILED`/`CANCELLED`, and LLD §18.2–18.3/§18.8 plus the ROADMAP T15.1 row describe the new behaviour. Code and
  documents agree; no owner decision remains open on this item.

## 12. T7.12 model-pinning docs lane: LLD §17.6, SDD FR-RTE-08 and Q-90 still describe T7.5 (pre-existing, not from PR #682)

- The T7.12 row in [ROADMAP §6.12](ROADMAP.md#612-m7-routing-tasks) is `Done on fakes` (2026-10-14): a held decision
  on a declaring adapter compiles with the remembered model (`planModelPin`, `withModelPin`, `pinModel`,
  `src/routing/model-pin.test.ts`).
- [LLD §17.6](design/LLD.md#176-affinity-details-fills-32), the SDD FR-RTE-08 row and [Q-90](ROADMAP.md#7-risks-blockers-and-open-questions)
  still describe the T7.5 state (model remembered but not pinned); the T7.12 row itself says their update is left to
  the docs lane. The README [Routing and affinity](../README.md#routing-and-affinity) section does describe pinning.
- Left unchanged: the LLD/SDD wording is the design owner's call, and the gap is disclosed in the T7.12 row. The M7
  `Done` reconciliation (PR #682) neither introduces nor worsens it: T7.12 has been `Done` since 2026-10-14 and the
  acceptance evidence (`src/mcp/m7-acceptance.test.ts`, `src/routing/model-pin.test.ts`) is cited in-row.
