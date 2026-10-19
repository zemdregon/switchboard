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

  **Update 2026-10-19 (doc-align gate for PR #759, T14.16):** this PR widens the same gap by one ID. Its SDD row
  maps FR-CTL-14 to COMP-OPS, COMP-RTE and COMP-LED while the HLD rows still cite COMP-MCP `FR-CTL-01..11` and
  COMP-RTE `FR-QUE-01..02`. Left unchanged for the same reason: re-attribution is the HLD owner's call, the SDD
  covers FR-CTL-14, and `node scripts/check-docs.mjs` passes. It does not block PR #759.

  **Update 2026-10-19 (doc-align gate for PR #764, T9.14):** this PR widens the same gap by one more ID. Its SDD
  row maps FR-GIT-11 to COMP-GIT, COMP-POL and COMP-LED while the HLD COMP-GIT row still reads `FR-GIT-01..09`
  (which already excluded FR-GIT-10, pre-existing). Left unchanged for the same reason: re-attribution is the
  HLD owner's call, the SDD covers FR-GIT-11, and `node scripts/check-docs.mjs` passes. It does not block
  PR #764.

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

## 24. T6.15 free-text quota mappings vs FR-ADP-04, ADR-0055 item 11 and Q-100 (from PR #700, RESOLVED)

- PR #700 (`sb/2026-10-18-fix-t615-cursor-kimi-limit-signals`) maps two stderr
  signals to `QUOTA_EXHAUSTED` in `classifyFailure` by phrase matching on one
  stderr-tail line: Cursor's out-of-usage line (`ActionRequiredError` plus `out
  of usage`, `cursorQuotaClassification` in `src/adapters/cursor/adapter.ts`)
  and Kimi Code's 5-hour usage-limit line (`403` plus `usage limit`,
  `kimiQuotaClassification` in `src/adapters/kimi/adapter.ts`, checked before
  the auth mapping because the CLI labels the stop `provider.auth_error`).
- T6.11's own evidence (ROADMAP T6.15's sibling row) classifies both signals as
  free text with no structured field — Cursor "no (class name only)", Kimi
  "kind and status are inside free text" ([limit captures
  2026-10-17](research/limit-captures-2026-10-17.md)) — and names only
  Antigravity's `AGY_ERROR.status`/`error_code` as the T6.15 candidates.
- That collided with three standing rules: [SRS
  FR-ADP-04](requirements/SRS.md) (Must: no inferring status by
  pattern-matching free text), [ADR-0055](adr/0055-model-groups-and-usage-pacing.md)
  item 11 (accepted: mapping only from structured output; a free-text-only
  signal stays unclassified until a decision says otherwise, Q-100), and the
  Q-100 delegated default itself (fail closed: only structured signals mapped),
  plus T6.15's own Done-when ("a free-text-only signal stays unmapped") and its
  2026-10-17 evidence ("Free-text-only signals stay unmapped (Claude Code,
  Codex, Cursor CLI, Kimi Code)"). The PR cited only Delegated authority.
- **Resolved 2026-10-18 by owner decision 64** (ROADMAP §4.2 entry 64): the two stderr signatures count as
  structured-enough captured distinctive signatures ([ADR-0058](adr/0058-captured-limit-signatures.md), which
  supersedes ADR-0055 item 11 in part), with the [FR-ADP-04](requirements/SRS.md) and
  [FR-CAP-11](requirements/SRS.md) one-exception amendments and the Q-100 answer. SDD FR-CAP-11 and LLD §16.9 now
  point at ADR-0058 instead of here; this note stands as the resolved history. PR #700 is unblocked on this item.

## 25. `antigravity.json` manifest notes still read "admits no version" (from the T4.38 re-implementation, out of gate scope)

- The T4.38 re-implementation updates `src/adapters/manifests/antigravity.json` to
  `validated_cli_version` `1.4.2`, range `>=1.4.2 <1.5.0`, with a dated
  `Evidence (adapters validate, 2026-10-18)` line appended to `notes`.
- The same `notes` string still opens with the T4.32 sentence "The range admits
  no version (ADR-0009, ROADMAP 6.8 conventions): the adapter fails the version
  gate with ADAPTER_VERSION_UNVERIFIED until `switchboard adapters validate
  antigravity` passes a version, so nothing here is a claim that any agy version
  is validated." That condition is now satisfied, so the sentence is
  stale against the range in the same file.
- Left unchanged: the manifest is `src/**`, and this gate edits documentation
  only (`*.md`, `docs/**`). Refreshing that sentence needs a one-line manifest
  edit by the PR author (or a code-touching follow-up), not an owner decision.
  It does not block the T4.38 re-implementation (the range fields and the evidence line, which are
  what the gate and the version check read, are correct).
- Same staleness, same scope: the header comments in
  `src/adapters/antigravity/adapter.ts` ("The manifest range admits no
  version, so none of this runs before `adapters validate` passes a version")
  and `src/adapters/antigravity/protocol.ts` ("The manifest range admits no
  version, so none of this runs until `adapters validate` passes a version")
  were true under the old `<0.0.0` range and are overtaken by the new
  `>=1.4.2 <1.5.0` range the same way. They need a code-touching follow-up,
  not an owner decision, and do not block the T4.38 re-implementation. (Kimi has the identical
  shape since PR #694: `kimi.json` admits `>=2.1.1 <2.2.0` while
  `src/adapters/kimi/adapter.ts` and `src/adapters/kimi/protocol.ts` still
  say the range admits no version; see item 15.)

## 26. TDD §4.7 heading still says "blocked by B-1" (pre-existing, not from PR #713)

- [TDD §4.7](design/TDD.md#47-kimi-code-m4-blocked-by-b-1) is headed
  "Kimi Code (M4, blocked by B-1)", while its body says B-1 is cleared
  (2026-10-15, T4.60/T4.61, ADR-0049) and the Kimi rows (T4.62 to T4.69)
  are Done or operator-only.
- Left unchanged: the heading text is frozen by its anchor
  (`#47-kimi-code-m4-blocked-by-b-1`), which the T4.67 row, LLD and other
  documents cite; renaming it would break those links and
  `scripts/check-docs.mjs`. It does not block PR #713.

## 27. T4.43 waiting-list claim withdrawn: no contradiction found (checked on this branch for PR #713)

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

## 28. Kimi manifest `notes` still says `-p`/`--prompt` are unaudited (pre-existing, not from PR #713)

- `src/adapters/manifests/kimi.json` `notes` says "`-p` and `--prompt`
  are not declared to the audit ... the compile gate alone keeps
  `--prompt` to the approved bypass cell", while the code
  (`providerScopedBypassFlags` in `src/adapters/providers.ts`,
  `src/adapters/audit.ts`), the T4.62 row ("As built (2026-10-16)"),
  ADR-0049, ADR-0035, LLD §2, TDD §4.7, the README Kimi section and the
  Q-95 resolution all record the provider-scoped declaration.
  Verified 2026-10-19: the stale sentence is already on `origin/main`
  (the scoped-flags code and the T4.62 "As built" note landed before
  this PR), so PR #713 neither introduces nor worsens it.
- Left unchanged: the manifest lives in `src/` and the doc-align gate
  edits documentation only (`*.md`, `docs/**`). A code-lane follow-up
  should sync the `notes` sentence (mechanical; no owner decision
  needed). It does not block PR #713.

## 29. README Status waiting-list still names T4.53/T4.56 (pre-existing, other lanes, not from PR #713)

- The README Status bullet lists T4.53 and T4.56 among the "rows waiting
  on uncaptured live shapes", while ROADMAP §6.8.2 item 2 and the M4 row
  open-items list (b) record both as `Done` against their Done-when
  under owner decision 65 (a)/(b), with remaining shapes carried by
  T4.58. The README sentence predates those Done markers (PR #713 only
  removed the Kimi rows from that list) and the rows belong to the
  OpenCode lane.
- Left unchanged: re-wording another lane's waiting list would endorse
  its Done claims (cf. items 8 and 24 above). It does not block PR #713.

## 30. ADR-0049 item 1 compile spelling vs as-built `=` form (pre-existing, not from PR #713)

- [ADR-0049](adr/0049-kimi-code-transport-and-bypass-class.md) item 1
  (Accepted 2026-10-15) says the approved bypass compile is exactly
  `kimi -m <model> -p <prompt> --output-format stream-json`, while the
  as-built code compiles one-word `--model=<alias>` / `--prompt=`
  (`MODEL_FLAG`/`--prompt=` in `src/adapters/kimi/adapter.ts`,
  `protocol.ts`; pinned by `src/adapters/kimi/kimi.test.ts` and the
  replay dialect `src/adapters/fixtures/replay-dialects/kimi.mjs`,
  which refuses the two-word forms). The ADR's own Implementation
  section (T4.62, 2026-10-16) already records that the compile emits
  `--prompt=<prompt>`, and TDD §4.7, the T4.62 row and the README Kimi
  section all use the `=` form; only the item-1 decision sentence keeps
  the old spelling. Verified 2026-10-19: the `=` form predates this PR,
  so PR #713 neither introduces nor worsens it.
- Left unchanged: item 1 is an accepted decision text and is not edited
  per AGENTS.md (a superseding ADR belongs to the Kimi lane, and the
  spelling difference changes no bypass behaviour). It does not block
  PR #713.

## 31. Kimi adapter code comments still label `tool_calls` fields an Assumption (pre-existing, not from PR #713)

- `src/adapters/kimi/protocol.ts` (header comment on the `stream-json`
  records: "their field names below are an **Assumption** ... until
  T4.68 captures a tool call"; `TOOL_CALLS_KEY`: "item shape
  **Assumption**") and `src/adapters/kimi/adapter.ts` (header: "the
  documented tool records (field names an Assumption)" and "synthetic
  fixtures plus the one [CAP] capture"; `toolCallEvent`: "Assumption:
  `{id, type:"function", function:{name, arguments}}`") still read as
  written before the 2026-10-16 T4.68 follow-up-2 capture, while the
  capture exists in the repo
  (`src/adapters/kimi/fixtures/captured_tool_call.jsonl`,
  `captured_tool_error.jsonl`, replayed by
  `src/adapters/kimi/live-capture.test.ts`) and the T4.63 row, TDD
  §4.7, the README Kimi section and `test/malicious/adapters/kimi.case.ts`
  (this PR) all record the `tool_calls`/`tool` field names as Observed
  since that capture. The adapter.ts header also still says "the
  manifest range admits no version" while `src/adapters/manifests/kimi.json`
  admits `>=2.1.1 <2.2.0` since the 2026-10-18 live validate pass.
  Verified 2026-10-19: the stale sentences predate this PR (code last
  touched by #690, a T4.64 stdin fix), so PR #713 neither introduces
  nor worsens them; behaviour is unchanged, only comments lag.
- Left unchanged: both files live in `src/` and the doc-align gate
  edits documentation only (`*.md`, `docs/**`). A code-lane follow-up
  should sync the comments (mechanical; no owner decision needed).
  It does not block PR #713.

## 32. README Status waiting-list still names T4.35/T4.51 (pre-existing, other lanes, not from PR #713)

- The README Status bullet lists T4.35 and T4.51 among the "rows
  waiting on uncaptured live shapes", while the roadmap records both
  as `Done`: T4.35 (Antigravity conformance incl. resume) under owner
  decision 67 ([PR #724](https://github.com/zemdregon/switchboard/pull/724),
  on `main`; §6.8.2 item 2 decision-67 update carries the live resume
  run by T4.38) and T4.51 (OpenCode operator live checks) as `Done`
  2026-10-18 with live evidence
  (`docs/research/live-checks-2026-10-18-opencode.md`;
  [PR #721](https://github.com/zemdregon/switchboard/pull/721), on
  `main`). The README sentence predates those Done markers (PR #713
  only removed the Kimi rows from that list) and the rows belong to
  the Antigravity and OpenCode lanes.
- Left unchanged: re-wording another lane's waiting list would endorse
  its Done claims (cf. items 8, 24 and 29 above). It does not block
  PR #713.

## 33. `opencode.json` notes and `adapter.ts` header still read "admits no version" (PR #726, out of scope)

- Renumbered from 26 when PR #713 merged `main`: both branches added an
  item 26; PR #713 items 26 to 32 kept their numbers.
- PR #726 updates `src/adapters/manifests/opencode.json` to
  `validated_cli_version` `2.0.23`, range `>=2.0.23 <2.1.0`, with a dated
  `Evidence (adapters validate, 2026-10-18)` line appended to `notes`.
- The same `notes` string still opens with the T4.52 sentence "The range admits
  no version (ADR-0009, ROADMAP 6.8 conventions): the adapter fails the version
  gate with ADAPTER_VERSION_UNVERIFIED until `switchboard adapters validate
  opencode` passes a version, so nothing here is a claim that any OpenCode
  version is validated." That condition is now satisfied, so the sentence is
  stale against the range in the same file. The `src/adapters/opencode/adapter.ts`
  and `src/adapters/opencode/protocol.ts` header comments (each saying the
  manifest range admits no version, so none of this runs before `adapters
  validate` passes a version) are stale the same way.
- Left unchanged: the manifest and the adapter are `src/**`, and this gate
  edits documentation only (`*.md`, `docs/**`). Refreshing those sentences
  needs a one-line `src/**` edit by the PR author (or a code-touching
  follow-up), not an owner decision. It does not block PR #726 (the range
  fields and the evidence line, which are what the gate and the version check
  read, are correct).
- Same shape, same scope: `src/inner/cli-backend.ts` ("`src/adapters/
  manifests/opencode.json` admits no version (`<0.0.0`)") and
  `src/inner/index.ts` ("The shipped OpenCode manifest admits no version")
  still describe the pre-T4.58 range; both are `src/**`, so they are listed
  here rather than fixed. The owner document for that range is the manifest
  itself (range fields correct); the docs (`HLD.md` CLI-backend gate line,
  ROADMAP T4.52 with an "at the time" qualifier) now state the current range.
- Still open after PR #741 (checked on this branch; pre-existing, not from
  this PR, which only appended the live-smoke evidence line): the same
  manifest `notes` lists the never-emitted flags as `--continue`, `--fork`,
  `--server`, `--share`, `--model`, `--agent`, `--file`, while the adapter
  header (`src/adapters/opencode/adapter.ts`), the case file
  (`test/malicious/adapters/opencode.case.ts` `neverEnabledFlags`) and the
  README trust-profile table all list `--continue`, `--fork`, `--server`,
  `--attach`, `--share`, `--dir`, `--model` (plus generic bypass flags in
  the case file). The code-side list is what the compile test pins and the
  leg checks, so the manifest's `--agent`/`--file` pair is stale against it.
  Same scope as above: `src/**`, listed here rather than fixed; it does not
  block PR #741 (the range fields and evidence lines the gate reads are
  correct).

## 34. `claude.json` notes keep the pre-validation range prose (pre-existing, not from PR #729)

- `src/adapters/manifests/claude.json` carries `validated_version_range`
  `>=2.1.294 <2.2.0` (rewritten by the T4.11 operator run on 2026-10-14, with
  a dated `Evidence (adapters validate, 2026-10-14)` line in `notes`), but
  the same `notes` string still opens with the 2026-10-12 sentence
  "Assumption: the range >=2.1.296 <2.2.0 (same minor series) is a Proposed
  conservative bound, not a provider statement". That bound is stale against
  the range field in the same file (2.1.294 is below the 2.1.296 floor it
  names, and is the validated version).
- Left unchanged: the manifest is `src/**`, and this gate edits documentation
  only (`*.md`, `docs/**`). Refreshing that sentence needs a one-line manifest
  edit by the PR author (or a code-touching follow-up), not an owner decision.
  It does not block PR #729 (the range field and the evidence lines, which are
  what the gate and the version check read, are correct; the T3.9 sentences PR
  #729 appends to `notes` describe the 2026-10-18 run accurately). PR #742
  appends the 2026-10-19 T3.9 sentences (C-G2 rerun, C-M3 `ESCAPED`/R-74);
  those describe the new run accurately. The stale opening sentence persists;
  still a one-line `src/**` fix, still not blocking.

## 35. `codex.json` T9.0 paragraph and both adapters' `GIT_CAPABILITIES.detail` strings (pre-existing, not from PR #742)

- `src/adapters/manifests/codex.json` `notes` still carries its 2026-10-13
  T9.0 paragraph ("codex is still not installed on the development host" and
  "Result: T9.0 is not done for Codex (ROADMAP 6.3)"), and the same paragraph
  shape survives in `src/adapters/manifests/claude.json`
  ("Result: T9.0 is Partial for Claude Code (ROADMAP 6.3)"). The roadmap owns
  status and says T9.0 is **Done** since the 2026-10-16 reconciliation
  (ROADMAP §6.3 T9.0 table; E2), and codex-cli 0.162.0 has since run live
  (validated 2026-10-14; X-G1 through the T3.9 leg on 2026-10-19). The
  `CODEX_GIT_CAPABILITIES.detail` and `CLAUDE_GIT_CAPABILITIES.detail` strings
  in `src/adapters/codex/adapter.ts` and `src/adapters/claude/adapter.ts`
  carry the same stale "not installed, Unverified" rationale (same conclusion,
  stale reason). ROADMAP §6.3 already discloses all of this as "a `src/`
  follow-up, not changed here".
- Left unchanged: manifests and adapters are `src/**`, and this gate edits
  documentation only (`*.md`, `docs/**`). Refreshing those sentences needs
  `src/**` edits by the PR author (or a code-touching follow-up), not an
  owner decision. It does not block PR #742 (the range fields, the evidence
  lines and the newly appended 2026-10-19 T3.9 sentences, which are what the
  gate and the version check read, are correct; the roadmap rows state the
  current status).

## 36. README manifest-version list still names T4.68 (pre-existing, Kimi lane, not from PR #745)

- The README bullet ("`adapters validate` is implemented for every
  registered provider ...") says Grok Build, Cursor and the other M4
  adapters "still need operator captures before their manifests admit a
  version (ROADMAP T4.28, T4.48, T4.68 and §6.8.2)". Kimi Code's manifest
  has admitted `>=2.1.1 <2.2.0` since the T4.68 live `adapters validate`
  pass on 2026-10-18 (same bullet, two lines above), so the T4.68
  citation was already stale on `origin/main` before this PR; PR #745
  only removed its own lane's entry (T4.38, now Done) from that list.
- Left unchanged: the T4.68 citation belongs to the Kimi lane (cf. items
  8, 24, 29 and 32 above for the precedent of not re-wording another
  lane's list). It does not block PR #745.

## 37. `cursor.json` notes and adapter headers still read "admits no version" (PR #747, out of scope)

- PR #747 updates `src/adapters/manifests/cursor.json` to
  `validated_cli_version` `2026.10.16`, range `>=2026.10.16 <2026.11.0`,
  with dated `Evidence (adapters validate, 2026-10-19)` and live-leg
  sentences appended to `notes`.
- The same `notes` string still opens with the T4.42 sentence "The range admits
  no version (ADR-0009, ROADMAP 6.8 conventions): the adapter fails the version
  gate with ADAPTER_VERSION_UNVERIFIED until `switchboard adapters validate
  cursor` passes a version, so nothing here is a claim that any Cursor CLI
  version is validated." That condition is now satisfied, so the sentence is
  stale against the range in the same file.
- Left unchanged: the manifest is `src/**`, and this gate edits documentation
  only (`*.md`, `docs/**`). Refreshing that sentence needs a one-line manifest
  edit by the PR author (or a code-touching follow-up), not an owner decision.
  It does not block PR #747 (the range fields and the evidence lines, which are
  what the gate and the version check read, are correct).
- Same staleness, same scope: the header comments in
  `src/adapters/cursor/adapter.ts` ("The manifest range admits no
  version, so none of this runs before `adapters validate` passes a version")
  and `src/adapters/cursor/protocol.ts` ("The manifest range admits no
  version, so none of this runs until `adapters validate` passes a version")
  were true under the old `<0.0.0` range and are overtaken by the new
  `>=2026.10.16 <2026.11.0` range the same way. They need a code-touching
  follow-up, not an owner decision, and do not block PR #747 (cf. items 15,
  25 and 33 for the identical Kimi, Antigravity and OpenCode shape).

## 38. CI Linux job timeout 10 -> 20 minutes (PR #751, no doc impact, checked 2026-10-19)

- PR #751 changes only `timeout-minutes: 10` to `20` for the Linux job in
  `.github/workflows/ci.yml` (the macOS job also used 20 before its removal in PR #761).
- No document states a CI job timeout value: [TDD §3.8](design/TDD.md#38-ci-pipeline)
  describes the pipeline jobs without timeouts, and greps for `timeout-minutes`,
  `10 minutes` and `20 minutes` across `docs/`, `README.md`, `CONTRIBUTING.md`
  and `SECURITY.md` find nothing CI-related. No document is stale.
- `node scripts/check-docs.mjs` passes; no doc edits needed for this PR.
  Recorded here only; it does not block PR #751.

## 39. ROADMAP §4.2 has no entries for the Cursor 06:15 / 06:41 / 08:12 CDT rulings (PR #752 widens a pre-existing gap)

- The owner rulings of 2026-10-19 06:15 CDT ("NOT_CHECKED counts as a fail",
  U-M1 `mustRun`), 06:41 CDT (ADR-0059 option A, bubblewrap wrapper) and
  08:12 CDT (`HELD` only when the stream's tool calls show every asked action
  attempted; U-M2/U-M3 join U-M1 as `mustRun`) are cited inline — in the
  ROADMAP T4.48 row, R-76 and Q-79, TDD §4.5, the ADR-0059 status note,
  `scripts/live-malicious.mjs`, `scripts/live/providers/cursor.mjs` and the
  README Cursor section — with identical wording in every spot, but no
  [§4.2 Owner decisions](ROADMAP.md#42-owner-decisions) entries. The §5
  document table says owner decisions are "Listed in §4.2 only". The 06:15
  and 06:41 citations predate this PR (PR #750, on `main`); this PR adds
  the 08:12 citations.
- Left unchanged: writing §4.2 entries would mean restating zemdregon's words
  and minting the next decision number, which this gate cannot verify and
  must not invent (cf. item 18 above for decision 62). Recording those
  entries is the roadmap owner's call. It does not block PR #752 (the
  substance of each ruling is recorded where it is cited, and
  `node scripts/check-docs.mjs` does not validate the §4.2 numbering).

## 40. FR-ADP-09 enable-condition vs Kimi adapter staying disabled (pre-existing, not from PR #755)

- [SRS FR-ADP-09](requirements/SRS.md) says the Kimi adapter "shall be enabled once that contract is pinned".
  The contract is pinned since 2026-10-18 (`adapters validate kimi` passed on CLI 2.1.1, manifest range
  `>=2.1.1 <2.2.0`), conformance is Done (T4.65), yet the adapter stays disabled: T4.68 closed Partial-by-ruling
  (owner ruling 05:22 CDT, then the 08:45 CDT bypass-only ruling implemented by PR #755), with permission gating
  Deferred to ROADMAP §8.
- [HLD §2](design/HLD.md) ("Disabled until the CLI contract is pinned (FR-ADP-09)") reads as if pinning alone
  enables; it predates the validate pass and neither it nor FR-ADP-09 records the ruling that keeps the adapter
  disabled past pinning.
- Left unchanged: reconciling "enabled once pinned" with "disabled by ruling" (amend FR-ADP-09, or record the
  ruling as the superseding condition) is the SRS/HLD owners' call, and it predates PR #755, which changes no
  enablement. It does not block PR #755.

## 41. T4.48 closure (PR #757): accepted-ADR body and historical range parentheticals left unchanged

- ADR-0059's Consequences still say "the live malicious leg (U-M1 to U-M3)
  must be rerun by the steward after merge; T4.48 stays Partial until every
  cell is PASS and U-M1 actually ran". The rerun has happened (w1703:
  U-M1/U-M2 HELD, U-M3 NOT_CHECKED, closed per owner decision 77 answer 1)
  and the T4.48 row is Done, so the sentence is overtaken.
- Left unchanged: ADR-0059 is Accepted, and AGENTS.md forbids editing an
  accepted ADR's decision (supersede, do not rewrite). The closure is
  recorded in the ADR's 2026-10-19 owner-decision-77 status note (added by
  this PR), and owner decision 77 outranks the ADR per the AGENTS.md
  precedence (explicit owner decisions first). It does not block PR #757.
- The T4.42 row ("`src/adapters/manifests/cursor.json` (range `<0.0.0` ...)")
  and the T4.49 row ("the compliance manifest ... still `<0.0.0`") still
  name the pre-validation `<0.0.0` range, although the manifest admits
  `>=2026.10.16 <2026.11.0` since the T4.48 live `adapters validate` pass.
- Left unchanged: both are dated Done-against-Done-when evidence snapshots
  of what was true when those rows closed, not claims about the current
  range; rewriting them would falsify the history (cf. item 37 for the same
  range change in `src/**`, which this gate cannot touch). The current
  range is stated in the T4.48 row, TDD §4.5.6, the README Cursor section
  and the manifest itself. It does not block PR #757.

## 41. ADR-0061 Consequences still says binary secrets "are not caught" (from PR #764, blocks)

- [ADR-0061](adr/0061-pre-push-secret-scan-blocks-every-run.md) Consequences says "A secret in a binary file or in
  an encoding the rules do not match is not caught; binary files are listed in the event."
- The code T9.14 builds diffs every file as text: `outgoingDiffArgs` in `src/git/secret-scan.ts` passes `--text`,
  the hardened helper adds `--no-textconv --no-ext-diff` and neutralises every driver
  (`src/workspace/git.ts`), and `scanDiffText` tests the added lines of every file against every rule; paths Git
  counts as binary are still scanned and are separately listed from `numstat`. The HLD threat row and
  [LLD §20.9](design/LLD.md#209-pre-push-secret-scan-fr-git-11-t914-adr-0061) "Implemented" on this branch agree:
  binary-counted files "are still scanned and are listed in the event".
- Before this PR the documents were consistent (the ADR's Proposed mechanism and the HLD row both said binary
  files are not scanned); the implementation's Delegated `--text` choice introduced the contradiction, and this
  branch updates HLD and LLD but not the ADR. The encoding half of the sentence is still true; the binary half
  is contradicted by the code.
- Left unchanged: ADR-0061 carries Accepted status for the direction, and AGENTS.md forbids editing an accepted
  ADR's decision (supersede with a new ADR instead). Rewording the consequence, or accepting the Delegated
  `--text` behaviour as the mechanism in a superseding note, is the design owner's call. The error direction is
  safe (the documents understate the protection), but the code contradicts a decision record and this PR
  introduces it, so per the gate rule it blocks PR #764 until the owner resolves it.
- Resolved 2026-10-19 by Linus ruling (DOC-CONFLICT #764): ADR-0061 Amendment 2026-10-19 added; code kept
  (--text scans binaries).

## 41. HLD §1.2 "No network listener" and the FRD Orchestrator transport cell (pre-existing, not from PR #762)

- [HLD §1.2](design/HLD.md#12-explicit-exclusions) still excludes "No network
  listener: MCP is stdio only; HTTP/SSE is deferred", while the M13 network
  transport (Streamable HTTP with OAuth 2.1, ADR-0041 Accepted 2026-10-14,
  T13.1 to T13.9 Done) is built and this PR extends it to the work-queue
  tools (T15.9). Likewise the [FRD actor table](requirements/FRD.md) still
  gives the Orchestrator upstream agent "MCP over stdio (COMP-MCP)".
- PR #762 neither introduces nor worsens either: both were already overtaken
  by M13 before this branch. Left unchanged: restating the transport
  exclusion is the HLD/FRD owners' call (cf. item 13 for the same
  as-built-vs-review-label precedent). It does not block PR #762 (the live
  transport facts are stated in the M13 row, LLD §3.3 and LLD §20.8, which
  this PR updates where it touches them).

## 42. SRS FR-CAP-12 "light admitted" vs the `allow_light` gate (pre-existing, not from PR #760)

- [SRS FR-CAP-12](requirements/SRS.md) says "A request or work item marked
  `light` is admitted while held", unconditionally.
- The code honours `light` only for a client whose configuration sets
  `mcp_clients[].allow_light: true` (default `false`); from any other
  client the flag is ignored, not refused (`src/mcp/server.ts`,
  `src/queue/admission.ts`, `src/lifecycle/lifecycle.ts`). [LLD
  §20.2](design/LLD.md#202-host-load-hold-fr-cap-12-t324) (text predating
  PR #760), the README config table and TDD §3.1 all document the gate as
  Delegated least privilege.
- PR #760 neither introduces nor worsens this: the SRS sentence and the
  LLD gate text were both already on `main` before the branch; the PR
  only adds the as-built note and marks T3.24 Done. Left unchanged:
  narrowing the SRS guarantee to "from an allowed client" is the SRS
  owner's call. It does not block PR #760.

## 43. TDD §3.8 cited a 2026-10-18 "macOS merge waiver" with no §4.2 entry (from PR #761, resolved on the branch)

- PR #761 removes the macOS CI job and records the removal in TDD §2 (CI row) and §3.8 as "removed under the
  owner's macOS merge waiver" / "under the owner's 2026-10-18 macOS merge waiver: the merge gate is the Linux
  job".
- No [§4.2 Owner decisions](ROADMAP.md#42-owner-decisions) entry (§4.2 runs to decision 77) records such a waiver,
  and the §5 document table says owner decisions are "Listed in §4.2 only".
- Left unchanged: writing a §4.2 entry would mean restating zemdregon's words and minting decision context this
  gate cannot verify and must not invent (cf. items 18 and 39 for the same precedent). Recording that entry is
  the roadmap owner's call. It does not block PR #761: the operative fact — CI is Linux-only
  (`.github/workflows/ci.yml` holds one job, `Typecheck, lint, test, docs check (Linux)`) — is verified against
  the code, and the merge-gate reading agrees with ADR-0060, which already recorded the macOS leg as dropped from
  gating, and with the AGENTS.md "seven checks" merge routine, which lists the Linux job only.
- Resolution (doc-align gate on the PR #761 branch): TDD §2 and §3.8 reworded to cite the ruling recorded in
  ADR-0060 ("the macOS leg was dropped from gating by a ruling") instead of a dated owner waiver, so no §4.2
  entry is needed and no owner approval is implied. Resolved, not outstanding.

## 44. Stale macOS-runner / present-tense CI-leg wording left by PR #761 (fixed by the doc-align gate on the branch)

- TDD §5 (implementation strategy, M4 row) listed "macOS CI leg (NFR-PORT-02)" in the present tense as the
  technical approach; past-tensed to "ran 2026-10-14, removed 2026-10-19 when CI went Linux-only, §3.8",
  matching the T4.10 owner row in ROADMAP §6.8 (ROADMAP owns status; TDD §5 gives the approach only).
- AGENTS.md verify-and-merge routine step 5 still said "the macOS runner"; no macOS runner exists in
  `.github/workflows/ci.yml` any more. Reworded to "a Mac with native logins", matching the T4.12 row
  ("reopen when a Mac with native logins is available"). Step 3 already lists the Linux job only, so the
  "seven checks" count is unchanged and verified.
- Checked and left unchanged: SRS NFR-PORT-02 still reads Verify `T (CI)` — the macOS code-path unit tests
  (`src/exec/proc-info.ts`, `src/reconcile/process.test.ts` over injected macOS tables) still run in Linux
  CI, so the verification method still holds; narrowing it is the SRS owner's call. SDD NFR-PORT-02 row
  still points at TDD §2, which still documents the CI history.
