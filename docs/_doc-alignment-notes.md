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

  **Update 2026-10-18 (PR #682, M7 `Done` reconciliation):** the §6.12.2 "Blocks Done" instances of this gap are
  reconciled in the same change that flips the M7 row to `Done` (the header now reads "M7 reached `Done` on fakes"
  with "What `Done` needed (history)", and item 3 records T7.9/T7.12 `Done` with the remaining wording gap
  disclosed), because that section directly restates the milestone status. The §6.12.1 wave-planning notes ("Wave B
  ... T7.8 is blocked on T7.12", "Waits for another lane") remain as planning history per the decision above.

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

## 13. Design "(Proposed)" labels vs M6/M7/M15 Done (pre-existing, not from PR #682)

- [HLD COMP-RTE](design/HLD.md) still tags the pacing mechanism "Proposed (owner decision 57, [ADR-0055](adr/0055-model-groups-and-usage-pacing.md);
  built on fakes ...)" and the scheduler tick "M15 (Proposed)"; [LLD §16.9](design/LLD.md#169-usage-windows-and-pacing-fr-cap-09-fr-cap-10),
  [LLD §17.7](design/LLD.md#177-model-groups-fr-rte-10-fr-rte-11) and [LLD §18](design/LLD.md#18-project-queue-schedules-and-ci-triggers-m15-proposed-t150)
  keep "(Proposed)" headers; [ADR-0050](adr/0050-ci-status-via-operator-gh-cli.md) and [ADR-0055](adr/0055-model-groups-and-usage-pacing.md)
  stay Proposed.
- The labels mark design/ADR review state, not build state: ADR-0055's own status line already records every wave-C
  task `Done` 2026-10-17, and the M16 `Done` reconciliation (PR #683, on `main`) likewise left its LLD/TDD "(Proposed)"
  headers in place while flipping the milestone. Neither M6/M7 nor M15 lists ADR acceptance as a verification clause
  (contrast M14, which stays `Partial` pending ADR-0047/ADR-0048).
- Left unchanged: rewording design review-state labels is the design owner's call. PR #682 neither introduces nor
  worsens it (every §6.11/§6.12/§6.14 task was already `Done`; only the milestone rows flip). It does not block
  PR #682.

## 14. SDD FR-RTE-08, Q-90 and LLD §17.6 still describe the T7.5 state (pre-existing, not from PR #684)

- The [T7.12 row](ROADMAP.md) records `Done on fakes` (2026-10-14) for FR-RTE-08 model pinning (the remembered
  model passed to `compile` on adapters that declare it) and notes itself that "LLD §17.6, SDD FR-RTE-08 and Q-90
  still describe the T7.5 state; their update is left to the docs lane".
- [SDD FR-RTE-08](design/SDD.md) still says "the model is remembered but not yet passed to the adapter, so a held
  run uses the adapter default"; [Q-90](ROADMAP.md) still says the model is "not passed to `compile`"; only the
  LLD §17.6 paragraph touched by PR #684 now carries a "(Superseded in one respect ...)" note, and only for the
  `run.model` recording, not for pinning.
- PR #684 neither introduces nor worsens this: it records `run.model` at admission for envelope reporting without
  changing what `compile` receives. Left unchanged: restating the pinning behaviour in the SDD and Q-90 is the
  docs-lane update the T7.12 row already defers, not this PR's. It does not block PR #684 (the fix's own evidence
  is `src/mcp/envelope-model.test.ts`, cited in LLD §17.7 and the T7.14 row).

## 15. `kimi.json` manifest notes still read "admits no version" (from PR #694, out of gate scope)

- PR #694 updates `src/adapters/manifests/kimi.json` to
  `validated_cli_version` `2.1.1`, range `>=2.1.1 <2.2.0`, with a dated
  `Evidence (adapters validate, 2026-10-18)` line appended to `notes`.
- The same `notes` string still opens with the T4.62 sentence "The range admits
  no version (ADR-0009, FR-ADP-09): the adapter fails the version gate with
  ADAPTER_VERSION_UNVERIFIED until T4.68 runs `switchboard adapters validate
  kimi` against a live CLI, so nothing here is a claim that any Kimi Code
  version is validated." That condition is now satisfied, so the sentence is
  stale against the range in the same file.
- Left unchanged: the manifest is `src/**`, and this gate edits documentation
  only (`*.md`, `docs/**`). Refreshing that sentence needs a one-line manifest
  edit by the PR author (or a code-touching follow-up), not an owner decision.
  It does not block PR #694 (the range fields and the evidence line, which are
  what the gate and the version check read, are correct).

## 16. Sink `needs_attention` closed list predates FR-CTL-03 `skill_cleanup_failed` (pre-existing, not from PR #695)

- [SRS FR-CTL-03](requirements/SRS.md) gained a seventh reason, `skill_cleanup_failed` (2026-10-17, T16.6), but
  `NEEDS_ATTENTION_REASONS` in `src/control/sinks.ts` still lists the six earlier reasons, and
  [ADR-0048 item 3](adr/0048-notification-sinks.md) (reworded, not extended, by PR #695) cites "the closed list of
  FR-CTL-03" for `needs_attention`.
- No production producer emits a `needs_attention` sink event today (producers emit `run_terminal`,
  `approval_decided`, `budget_exhausted`, `project_paused` and `queue_low`; the digest/envelope derivation reads
  `needsAttentionOf`, which does include `skill_cleanup_failed`), so nothing is dropped in practice; a future
  producer emitting `needs_attention` / `skill_cleanup_failed` would be dropped as `invalidEvents`.
- Left unchanged: closing the gap needs a code change (extend the sink closed list) or an SRS/ADR owner note, and
  PR #695 neither introduces nor worsens it (FR-CTL-03 was amended after T14.9; the PR only rewords the ADR-0048
  citation). It does not block PR #695.

*Resolved by PR #702 (2026-10-18, Delegated, not owner-approved):* the gap-closing code change above landed here.
`NEEDS_ATTENTION_REASONS` in `src/control/sinks.ts` now lists all seven FR-CTL-03 reasons (the comment cites
`skill_cleanup_failed` from T16.6), `SINK_REASON_CODES.needs_attention` references that list, and production
producers of `needs_attention` now exist (lifecycle `onApprovalPending`/`onNeedsAttention`, CI `onStuck`,
project-tools `onPendingRevision`, all announced through the T14.9 dispatcher in `src/cli/serve.ts`; [LLD
§3.4.9](design/LLD.md#349-notification-sinks-fr-ctl-10-adr-0048) lists them). A `needs_attention` /
`skill_cleanup_failed` event is therefore no longer dropped as `invalidEvents`. No owner decision needed; item kept
as history.

## 17. Roadmap "queue item W1" label has no defining row (pre-existing, repeated by PR #698)

- [ROADMAP §4.2](ROADMAP.md#42-owner-decisions) entries 59 and 60, the T4.28,
  T4.48, T4.58 and T4.68 rows and §6.8.2 all say the `adapters validate`
  compiled-cell fallback is (or follows) "queue item W1" of the T4.4 change.
  No `W1` row exists anywhere in the docs: the label is used but never
  defined. The wording predates this PR (entry 59 in `main` already says
  "(queue item W1)"), and PR #698 only repeats it.
- Left unchanged: defining, renumbering or removing a queue label is the
  roadmap owner's call, and the T4.4 row already documents the fallback
  itself (owner decisions 59 and 60, `COMPILED_CELL_FALLBACK` in
  `src/cli/adapters-validate.ts`, built 2026-10-18), so no fact about the
  code is wrong. It does not block PR #698.

## 18. ROADMAP §4.2 has no entry for owner decision 62 (pre-existing gap widened by PR #697)

- The [§4.2 Owner decisions](ROADMAP.md#42-owner-decisions) list runs to
  decision 60 (2026-10-18; entries 42 onward use escaped `42\.` numbering, so a
  naive grep for `^42.` misses them — the earlier wording of this note wrongly
  said the list ends at 41). No §4.2 entry exists for owner decision 62 (or 61,
  which nothing cites). The §5 document table says owner decisions are
  "Listed in §4.2 only".
- Left unchanged: writing a §4.2 entry for decision 62 would mean restating
  zemdregon's words, which this gate cannot verify and must not invent. The
  substance of decision 62 is recorded where it is cited, with identical wording
  in all 11 spots (the T9.9 block, the M9 row, E4 and the Q-46 row in the
  ROADMAP; the BR-32 and FR-PRJ-10 notes; LLD; TDD; three README spots), each
  naming the refused-by-design outcome and its pin
  `src/git/push-dynamic-refused.test.ts`. Recording the missing §4.2 entry is the
  roadmap owner's call.
- It does not block PR #697: the Q-46 row in §7.3 records the answer with the
  same wording the PR uses everywhere else, and
  `node scripts/check-docs.mjs` does not validate the §4.2 numbering.

## 19. ADR-0030 still cites open Q-46 / "cannot push yet" (accepted ADR, left untouched)

- [ADR-0030](adr/0030-dynamic-project-revisions-and-approval.md) says wiring push
  targets for approved dynamic projects was "not done in T9.9" and that
  "Dynamic projects with push cannot push yet (Q-46)". Since PR #697, Q-46 is
  answered (refused by design, owner decision 62) and the refusal is pinned by
  `src/git/push-dynamic-refused.test.ts`.
- Left unchanged on purpose: ADR-0030 is Accepted, and AGENTS.md forbids editing
  an accepted ADR's decision (a change needs a superseding ADR). No edit is
  needed for correctness: the ADR's operative statements — push contexts resolve
  from the configuration only, so an approved push-enabled dynamic project is
  refused at push time (`CONTEXT_UNKNOWN`), fail closed — still match the code
  (`pushContextResolver(config.projects)` in `src/cli/serve.ts`, `CONTEXT_UNKNOWN`
  in `src/git/push.ts` and `src/cli/git-push.ts`); only the "yet" and the
  open-Q-46 parenthetical are overtaken, and the Q-46 row now records the answer.
- It does not block PR #697.

## 20. Decision 62 relayed text vs the implemented abandon trigger (from PR #712, T9.11 split)

- [Decision 62](ROADMAP.md#42-owner-decisions) (relayed 2026-10-18) answers
  Q-55 with abandon-only removal: the worktree is removed when the
  meta-session reaches `CLOSED` or the operator runs an explicit existing
  command, and the branch and diff artifact are kept until retention GC.
- The code has no `CLOSED` meta-session state (`CHECK (status IN
  ('ACTIVE','ARCHIVED'))` in `src/ledger/migrations/0001_initial.ts`) and
  no explicit abandon command; the only write to `ARCHIVED` is `beginGc`
  in `src/ledger/repo.ts`. Retention GC (`src/workspace/gc.ts`) removes
  the worktree, the `switchboard/<sess>/` branches and the artifact files
  in one unit, so the branch is not kept beyond the worktree.
- PR #712 records this honestly as Delegated ruling 1 under decision 62
  (split notes in the T9.11 row and status block, E7, Q-55, [FRD
  §4.4](requirements/FRD.md#44-worktree-disposition-per-terminal-state),
  [LLD §5](design/LLD.md#5-workspace-and-lease-algorithm) and the SRS
  FR-WS-09 note): "abandoned" reads as `ARCHIVED` by retention GC only,
  pinned by two running tests in
  `src/lifecycle/concurrent-worktrees.test.ts`, with the merge test still
  skipped. FR-WS-09 itself stays Proposed, not accepted, and T9.11 stays
  Partial.
- Left unchanged: the decision-62, Q-55-answer and Q-55-question wordings
  are relayed owner history and are kept verbatim with the split notes
  carrying the current reading. Fully reconciling them (amending FR-WS-09
  to the abandon-only form and accepting it) is the SRS owner's call and
  is the queued amendment follow-up that closes E7's FR-WS-09 part. It
  does not block PR #712 (no code change; docs agree with the code).

## 21. HLD T4.34 subsection still reads "not implemented" (pre-existing, not from PR #709)

- [HLD §2.2](design/HLD.md) T4.34 ("auth preflight (placeholder)") says `authPreflight` returns `UNKNOWN` until T4.34
  and cites the test "auth is UNKNOWN until T4.34".
- The [T4.34 row](ROADMAP.md#68-m4-adapter-expansion-tasks) records `Done` (2026-10-14, Delegated; fixtures only):
  `authPreflight` is implemented in `src/adapters/antigravity/adapter.ts` and the suite is now "antigravity auth
  preflight (T4.34; SYNTHETIC outputs in the shapes of the 2026-10-14 live check C3b, C3c)" in
  `src/adapters/antigravity/antigravity.test.ts`.
- Left unchanged: restating the as-built preflight in the HLD is the design owner's call, and the gap predates
  PR #709 (which touches only T4.33, T4.36 and T4.39). It does not block PR #709 (T4.33's own evidence is the
  T4.33 status block and the suites cited there).

## 22. T4.23 row keeps stale "Status stays" notes (pre-existing, not from PR #709)

- The [T4.23 row](ROADMAP.md#68-m4-adapter-expansion-tasks) header records `Done against its Done-when`
  (2026-10-18, owner decision 65 (a)), but its historical residual-pass notes still say `Status stays`
  (11 occurrences, same pattern PR #709 fixes for T4.33 in T4.33).
- Left unchanged: re-tensing another lane's history belongs to that lane's follow-up, and the gap predates
  PR #709 (which touches only T4.33, T4.36 and T4.39). It does not block PR #709 (no code change; the T4.23
  header and its Done-when evidence agree).

## 23. Roadmap §6.5 intro still says "T3.8 is `Partial`" (pre-existing, not from PR #719)

- [ROADMAP §6.5](ROADMAP.md#65-m3-isolation-tasks) opens with a dated
  2026-10-12 breakdown snapshot saying "T3.8 is `Partial` (controller Git
  driver hardening landed on `m3-wave-a`)", while the T3.8 row itself reads
  Status Done (2026-10-16) and the M3 milestone row lists T3.8 among the
  Done tasks. The wording predates this PR (identical on `main`), and the
  same paragraph carries dated updates (2026-10-16 T3.13, 2026-10-18 T3.8b)
  that supersede the snapshot.
- Left unchanged: the sentence is historical narrative inside an explicitly
  dated snapshot, and rewriting it would falsify the record; the live
  status lives in the T3.8 row and the M3 row, which agree. It does not
  block PR #719.

## 24. TDD §4.7 heading still says "blocked by B-1" (pre-existing, not from PR #713)

- [TDD §4.7](design/TDD.md#47-kimi-code-m4-blocked-by-b-1) is headed
  "Kimi Code (M4, blocked by B-1)", while its body says B-1 is cleared
  (2026-10-15, T4.60/T4.61, ADR-0049) and the Kimi rows (T4.62 to T4.69)
  are Done or operator-only.
- Left unchanged: the heading text is frozen by its anchor
  (`#47-kimi-code-m4-blocked-by-b-1`), which the T4.67 row, LLD and other
  documents cite; renaming it would break those links and
  `scripts/check-docs.mjs`. It does not block PR #713.

## 25. T4.43 waiting-list claim withdrawn: no contradiction found (checked on this branch for PR #713)
- A draft of this note claimed the T4.43 (Cursor parser) row records
  `Done against its Done-when` under owner decision 65 (a) while §6.8.2
  item 2 and the M4 row open-items list (b) still list T4.43 among the
  rows that "stay `Partial` until scrubbed captures replace their
  synthetic lines". Re-checked 2026-10-19 against this branch: neither
  list names T4.43. Item 2 names T4.33, T4.35, T4.36, T4.51, T4.53 and
  T4.56, then records "and so is T4.43 (its remaining native shapes are
  carried by T4.48, item 1)"; the M4 row (b) names the same six and says
  "as T4.43's move to T4.48". Both lists agree with the T4.43 row, so the
  draft premise was false and is withdrawn here rather than left standing.
- No action: there is nothing to reconcile, so no other lane's Done claim
  is endorsed or disturbed (cf. item 8 above for the precedent). It does
  not block PR #713.
