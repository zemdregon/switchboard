# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Grok Build, Kimi Code, OpenCode and others) working in
this repository. Humans are welcome to read it too.

## What this repository is

Switchboard is a headless controller that lets one primary orchestrating agent delegate coding work to several
AI coding CLIs (Claude Code, Codex, Grok Build, Antigravity, Cursor, OpenCode, Kimi Code and, as a Should, Muse Code)
through their documented automation surfaces, behind a single MCP tool surface. The roadmap owns the provider list.

The repository contains the research, the specification set and application code under `src/` and `test/`. The M1
foundation is done; M2 and M3 are `Partial`, and parts of M9 are implemented. Milestone status is owned by
[ROADMAP §6](docs/ROADMAP.md#6-milestones); code is evidence of what is implemented, not of what is intended.

## Start here

1. Read the canonical roadmap: [docs/ROADMAP.md](docs/ROADMAP.md). It owns scope, priorities, sequencing, status and
   completion criteria.
2. Before planning or implementing anything, read the roadmap's task entry for your work and every requirement, design
   section and ADR it links.
3. If a task is not on the roadmap, it is not in scope yet. Propose it (PRD and SRS first, then a roadmap entry) rather
   than building it.

## Which document owns what

| Subject | Owner | Path |
| --- | --- | --- |
| Scope, priorities, sequencing, status | Roadmap | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Business problem and outcomes (`BO-*`) | BRD | [docs/requirements/BRD.md](docs/requirements/BRD.md) |
| Users, journeys (`UJ-*`), capabilities (`CAP-*`), non-goals | PRD | [docs/requirements/PRD.md](docs/requirements/PRD.md) |
| Workflows (`WF-*`), business rules (`BR-*`), run state machine | FRD | [docs/requirements/FRD.md](docs/requirements/FRD.md) |
| Every requirement ID (`FR-*`, `NFR-*`) | SRS | [docs/requirements/SRS.md](docs/requirements/SRS.md) |
| Components (`COMP-*`), boundaries, deployment, threats | HLD | [docs/design/HLD.md](docs/design/HLD.md) |
| Component collaboration, requirement→design traceability | SDD | [docs/design/SDD.md](docs/design/SDD.md) |
| Technology choices, testing strategy, adapter strategy | TDD | [docs/design/TDD.md](docs/design/TDD.md) |
| Schemas, interfaces, tool contracts, algorithms | LLD | [docs/design/LLD.md](docs/design/LLD.md) |
| Why architectural decisions were made | ADRs | [docs/adr/](docs/adr/README.md) |

Other documents cite IDs from the owner instead of restating content. Never write a second definition of a requirement,
state machine or schema.

## Keeping documentation in sync

- Update affected documents **in the same change** as the code. When you finish, block or descope roadmap work, update
  its status in [ROADMAP §6](docs/ROADMAP.md#6-milestones) with evidence (a test, a path, a PR link). Never mark work
  done without evidence.
- Any change to a component boundary, persistence format, trust or security boundary, external interface or the
  technology stack needs a new ADR in [docs/adr/](docs/adr/README.md). Do not edit an accepted ADR's decision; supersede
  it with a new one and update the old one's status line.
- Requirement IDs are stable: never renumber or reuse them. Withdraw a requirement by setting its priority to
  `Withdrawn`.
- Run `node scripts/check-docs.mjs` before committing documentation changes. It checks links, anchors, requirement IDs,
  roadmap coverage, SDD traceability and §6 task status markers.

## Conflicts, assumptions and superseded material

- When documents disagree, the owner in the table above wins; fix the other document in the same change. When the owner
  itself looks wrong, say so and fix it with an ADR or roadmap note, not silently.
- Precedence of sources: explicit decisions by zemdregon, then this file, then accepted ADRs, then the owning specification,
  then research. Code is evidence of what is implemented, not of what is intended.
- Label anything you choose without a source as an **Assumption** or **Proposed**, and add open questions to [ROADMAP
  §7](docs/ROADMAP.md#7-risks-blockers-and-open-questions). Do not present invented numbers, dates, approvals or
  compliance obligations as fact.
- Decisions agents make are "Delegated", not owner-approved. Never imply that zemdregon approved something zemdregon did
  not approve.
- Never delete historical material. Mark superseded documents with a banner linking to their replacement, as on [the
  original research blueprint](docs/research/headless-ai-coding-controller.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `assets/switchboard-logo.png` | Product logo (placeholder chosen by zemdregon, 2026-10-13); used by the README. |
| `docs/ROADMAP.md` | Canonical roadmap. |
| `docs/requirements/` | BRD, PRD, FRD, SRS. |
| `docs/design/` | HLD, SDD, TDD, LLD. |
| `docs/adr/` | Architecture decision records and their index. |
| `docs/research/` | Research inputs. Historical record; do not rewrite their findings. |
| `package.json`, `package-lock.json` | Package metadata, scripts and pinned dependencies (`npm ci` installs them). |
| `src/` | Application code: config, ledger, lifecycle, adapters (`claude`, `codex`, `fake`), MCP server, CLI, policy, Git, inner-agent port and fake backend (`inner`), capacity estimator (`capacity`), derived control-plane flags and notification sinks (`control`), environment port with the `host` identity and the `container` backend over a rootless Docker driver (`environment`), CI-failure trigger over the operator's `gh` (`ci`), skill store with migration 0021, state derivation, configuration, admission and the native-delivery framework with leak prevention (`skills`, `src/workspace/native-skills.ts`) and the operator skills CLI (`cli/skills.ts`). |
| `test/` | Cross-cutting tests: live smoke test (opt-in), the `npm pack` smoke test (`test/pack-smoke.test.ts`, pure file-list rules for `scripts/pack-smoke.mjs`) and the malicious-fixture suite. |
| `examples/` | Validated starting-point configs (`examples/README.md`): every `*.json` file loads as is through `loadConfig` (`src/config/examples.test.ts`). |
| `scripts/check-docs.mjs` | Documentation consistency checker (Node.js, no dependencies). |
| `scripts/copy-build-assets.mjs`, `scripts/bench-perf.mjs`, `scripts/live-smoke.mjs`, `scripts/pack-smoke.mjs` | Build asset copy, the performance benchmark, the opt-in live smoke test and the `npm pack` smoke test (`npm run pack:smoke`; `scripts/pack-smoke.d.mts` types its pure helpers for `test/pack-smoke.test.ts`). Live provider plug-ins: `scripts/live/providers/`. |
| `CLAUDE.md` | Imports this file for Claude Code. Do not add separate instructions there. |
| `LICENSE` | Apache License 2.0. |

## Subagent routing and orchestration

The primary agent acts as an orchestrator, coordinating work through context-scoped subagents rather than performing
coding and edits directly. This division of labor optimizes reasoning effort and keeps the main conversation focused on
coordination and decision-making.

When delegating to subagents, route work based on task complexity and requirements. Models are listed from cheapest to
most capable; prices are Anthropic first-party API rates per million input/output tokens as of 2026-09-25 (see the
Anthropic pricing page for current rates):

- **Haiku 4.5 ($1/$5):** Cheapest and fastest. Use for simple, well-defined tasks such as file reads, pattern matching,
  routine edits, small scripts, exploratory searches and quick lookups.
- **Sonnet 5.5 ($2/$10):** Balanced speed and capability for general-purpose work such as multi-file refactoring,
  feature implementation, moderate analysis and code review. The default choice for most substantive tasks.
- **Opus 5.5 ($4/$20):** Strong reasoning for complex, high-stakes work such as architecture decisions, cross-system
  design, deep codebase analysis, security review and intricate bug diagnosis. Use when Sonnet's output quality is
  insufficient.
- **Fable 5.1 ($10/$50):** Anthropic's most capable widely released model and the most expensive. Turns on hard tasks
  can run for many minutes. Reserve it for the most demanding reasoning and long-horizon agentic work where Opus falls
  short.

**Orchestrator responsibilities:** Define the task scope, provide context and constraints, verify subagent work, and
coordinate across multiple efforts. Route simple, independent subtasks to Haiku or Sonnet to reduce latency and cost.
Reserve Opus and Fable for genuinely complex problems requiring deep reasoning or when task failure would be costly.

**Subagent responsibilities:** Execute focused work within defined scope—code writes, edits, file operations, targeted
analysis. Report results clearly so the orchestrator can verify and coordinate the next step.

### Practical delegation rules

- Give every subagent a self-contained brief: the objective, the exact files or paths in scope, the requirement or
  design IDs it must satisfy, and what "done" looks like. Subagents do not see the orchestrator's conversation.
- Keep independent subtasks parallel and dependent ones sequential. Do not let two subagents edit the same file at the
  same time.
- Verify before accepting: read the diff, run the checks listed below, and confirm the cited requirement IDs are
  actually satisfied. A subagent's report is a claim, not evidence.
- Escalate one tier (Haiku → Sonnet → Opus → Fable) only after a lower tier's output fails verification, not
  pre-emptively.

## Verify and merge routine

Standing instructions from zemdregon (2026-10-13 and 2026-10-14): continue the roadmap, and merge a pull request once CI
is good. Refer to the owner as `zemdregon`. The routine that has been used:

1. Work on one branch per logical change, in its own `git worktree`. Merge current `main` into the branch before
   verifying; resolve a `docs/ROADMAP.md` conflict by hand, keeping both sides' rows.
2. Run `npx tsc --noEmit`, `npm run lint`, `node scripts/check-docs.mjs`, `npx markdownlint-cli2 "**/*.md"
   "#node_modules"` and the full `npm test` (about three minutes; run it in the background and read the exit code
   separately).
3. Open the pull request as a draft, wait for all seven checks (CodeQL, Analyze (actions), Analyze
   (javascript-typescript), Typecheck/lint/test/docs (Linux), Markdown lint, Link check, Docs consistency), then mark it
   ready and squash-merge. Stacked pull requests conflict in the roadmap after the first squash; merge `main` in again.
4. Never run `scripts/live-smoke.mjs` or any provider CLI on the operator's logged-in accounts unless the task is an
   operator task. Hot files (ROADMAP §6.9.1) are edited by one task at a time.
5. Work that needs a provider login, the macOS runner or an owner answer is listed in the roadmap (§6.9.2 for M5, the
   "Blocks Done" lists elsewhere, §7.3 for questions); do not guess it.

## Working rules

- **Never handle provider credentials.** Do not commit, log, print or copy API keys, OAuth tokens, `auth.json` files,
  keychain entries or session cookies. Switchboard's design depends on never touching them, and the repository must not
  either.
- **Do not add bypass flags casually.** Code, tests and examples must not invoke provider CLIs with
  `--dangerously-skip-permissions`, `--yolo`, `--force`, `--always-approve`, `--approve-mcps` or `--full-auto` unless a
  design document explicitly calls for it. Today only an operator-approved `privileged` scope that sets `bypass` does
  ([ADR-0017](docs/adr/0017-approved-privileged-scope-bypass.md)).
- **Best-practice defaults outside bypass mode.** zemdregon's only concern is bypass mode (owner decision 25). Where a
  decision does not change what a bypass run (an approved `privileged` scope with `bypass`, ADR-0017) may do, decide it
  yourself using industry best practice (least privilege, fail closed, defence in depth, no claim of a control that is
  not enforced), because the other modes are for people who deploy Switchboard. Record it as **Delegated** with its
  reason, and do not ask zemdregon. Ask only when the choice would restrict or change bypass runs, the Git-write denial
  or worktree isolation that bypass keeps, or a trust or credential boundary.
- **Live provider calls are opt-in.** Tests must pass without any provider CLI installed or logged in. Tests that call a
  real provider must be skipped unless explicitly enabled.
- **Real provider CLI runs go through the budgeted channel only.** Use fakes and synthetics for nearly all work. On the
  Ampere operator host, workers do not call real provider CLIs directly; the only allowed path is
  `~/operator-runs/live-run.sh` (cheapest model, read-only, budgeted), and only as a `pre-check` before starting work or
  a `final-verify` before a pull request is marked ready. Check `~/operator-runs/live-usage.sh` first, ask one scoped
  question per run, never loop or re-run to be sure, and never run it in CI. Record findings in the pull request. See
  `~/operator-runs/LIVE_TESTING.md` on that host.
- **Small, reviewable changes.** One logical change per commit, with a message that says what changed and why. Open pull
  requests as drafts until checks pass.
- **No invented facts.** Do not state CLI flags, model names, limits or prices from memory as fact; cite the research
  document or the provider's documentation, and mark anything unverified as an assumption.
