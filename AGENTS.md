# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Grok Build, Kimi Code, OpenCode and others) working in
this repository. Humans are welcome to read it too. This is the project agent guide: it says what the repository is, who
owns what, how to build and check changes, how to delegate, and how to open a pull request.

## What this repository is

Switchboard is a planned headless controller that lets one primary orchestrating agent delegate coding work to several
AI coding CLIs (Claude Code, Codex, Grok Build, Antigravity, Cursor, OpenCode, Kimi Code) through their documented
automation surfaces, behind a single MCP tool surface. Kimi Code is deferred, not removed: its adapter stays in the
architecture as a disabled slot until its new CLI interface is pinned ([ROADMAP
§8](docs/ROADMAP.md#8-deferred-and-excluded-work)).

The repository currently contains research and the specification set only. There is no application code yet.

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
  roadmap coverage and SDD traceability.

## Conflicts, assumptions and superseded material

- When documents disagree, the owner in the table above wins; fix the other document in the same change. When the owner
  itself looks wrong, say so and fix it with an ADR or roadmap note, not silently.
- Precedence of sources: explicit decisions by Ender, then this file, then accepted ADRs, then the owning specification,
  then research. Code is evidence of what is implemented, not of what is intended.
- Label anything you choose without a source as an **Assumption** or **Proposed**, and add open questions to [ROADMAP
  §7](docs/ROADMAP.md#7-risks-blockers-and-open-questions). Do not present invented numbers, dates, approvals or
  compliance obligations as fact.
- Decisions agents make are "Delegated", not owner-approved. Never imply that Ender approved something Ender did not
  approve.
- Never delete historical material. Mark superseded documents with a banner linking to their replacement, as on [the
  original research blueprint](docs/research/headless-ai-coding-controller.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `docs/ROADMAP.md` | Canonical roadmap. |
| `docs/requirements/` | BRD, PRD, FRD, SRS. |
| `docs/design/` | HLD, SDD, TDD, LLD. |
| `docs/adr/` | Architecture decision records and their index. |
| `docs/research/` | Research inputs. Historical record; do not rewrite their findings. |
| `scripts/check-docs.mjs` | Documentation consistency checker (Node.js, no dependencies). |
| `.github/workflows/docs-lint.yml` | CI: Markdown lint, link check and docs consistency, all blocking. |
| `.markdownlint-cli2.jsonc` | Markdown lint configuration shared by CI and local runs. |
| `.github/` (other) | PR template, issue templates, CODEOWNERS, Dependabot and link-check configuration. |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md` | Human-facing entry points. Keep them consistent with this file. |
| `CLAUDE.md` | Imports this file for Claude Code. Do not add separate instructions there. |
| `LICENSE` | Apache License 2.0. |

There is no application code, `package.json`, or test suite yet. The first code arrives with roadmap task T1.1 (see
[ROADMAP §6.1](docs/ROADMAP.md#61-m1-foundation-tasks)). Do not scaffold it earlier.

## Subagent routing and orchestration

The primary agent acts as an orchestrator, coordinating work through context-scoped subagents rather than performing
coding and edits directly. This division of labor optimizes reasoning effort and keeps the main conversation focused on
coordination and decision-making.

When delegating to subagents, route work based on task complexity and requirements. Models are listed from cheapest to
most capable; prices are Anthropic first-party API rates per million input/output tokens, last checked against Anthropic's
[pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-12 (the page is authoritative; recheck
it before relying on a price):

- **Haiku 5.5 ($0.10/$0.50 for prompts up to 100,000 tokens; $0.50/$2.50 above that):** Cheapest and fastest. Use for
  simple, well-defined tasks such as file reads, pattern matching, routine edits, small scripts, exploratory searches
  and quick lookups.
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
  pre-emptively. Say which tier failed and why in the next brief.
- Match the tier to the task up front. Mechanical work (committing a pasted document, renaming, reformatting, lint
  fixes, link repair) starts on Haiku. Sonnet is the default for substantive documentation or code work. Opus and Fable
  are for demanding work, not a safe default.
- Tell every subagent which paths it may write and that it must not touch anything else, and have it list the files it
  changed in its report.
- Subagents follow the same [working rules](#working-rules): no credentials, no bypass flags, no invented facts. Say so
  in the brief when the task touches provider material.
- Prefer a fresh subagent per logical change over one long-running subagent, so each diff stays small and reviewable.
- Subagents never open, merge or approve pull requests, and never push to a branch they were not assigned. The
  orchestrator owns git and GitHub operations.
- If a subagent's report cannot be verified from the diff or command output, treat the work as not done.

### Model names and prices

Model names and prices above come from the Anthropic pricing page. Checked on 2026-10-12: Sonnet 5.5, Opus 5.5 and
Fable 5.1 match the figures above. Haiku 4.5 ($1/$5) was replaced here by Haiku 5.5 because the pricing page lists
Haiku 5.5 as the current Haiku model; its price depends on prompt length. Nothing here is a commitment about what the
operator pays: subscription plans and negotiated rates differ. Re-verify and update the date whenever you edit this
section.

## Working rules

- **Never handle provider credentials.** Do not commit, log, print or copy API keys, OAuth tokens, `auth.json` files,
  keychain entries or session cookies. Switchboard's design depends on never touching them, and the repository must not
  either.
- **Do not add bypass flags casually.** Code, tests and examples must not invoke provider CLIs with
  `--dangerously-skip-permissions`, `--yolo`, `--force`, `--always-approve`, `--approve-mcps` or `--full-auto` unless a
  design document explicitly calls for it.
- **Live provider calls are opt-in.** Tests must pass without any provider CLI installed or logged in. Tests that call a
  real provider must be skipped unless explicitly enabled.
- **Small, reviewable changes.** One logical change per commit, with a message that says what changed and why. Open pull
  requests as drafts until checks pass.
- **No invented facts.** Do not state CLI flags, model names, limits or prices from memory as fact; cite the research
  document or the provider's documentation, and mark anything unverified as an assumption.

## Build, test and lint commands

Only the commands below exist today. Do not document or invoke others until the task that creates them is done.

| Purpose | Command | Notes |
| --- | --- | --- |
| Documentation consistency | `node scripts/check-docs.mjs` | Links, anchors, requirement IDs, roadmap coverage, SDD traceability. No dependencies. |
| Markdown lint (all files, including `docs/`) | `npx --yes markdownlint-cli2@0.23.3 "**/*.md"` | Configuration in `.markdownlint-cli2.jsonc`; 120-column limit outside tables and code. |
| Link check (outside `docs/`) | `npx --yes markdown-link-check@3.13.7 --quiet --config .github/markdown-link-check.json README.md CONTRIBUTING.md SECURITY.md AGENTS.md CLAUDE.md` | CI runs it over every Markdown file outside `docs/`. |

All three run in the `docs-lint` workflow and are blocking. Run them before every commit that touches Markdown.

There is no build, typecheck, unit-test or code-lint command yet. Roadmap task T1.1 adds them; when it lands, update this
table in the same change. The planned stack (npm, `tsc --noEmit`, Vitest, Biome) is in [TDD
§2](docs/design/TDD.md#2-technology-choices) and is pinned in M1, so treat it as Proposed until then.

## TypeScript conventions

These bind once code exists (ADR-0010 and [TDD §2](docs/design/TDD.md#2-technology-choices)). Where the TDD marks a
choice as pinned in M1, follow what M1 pinned.

- TypeScript with `strict` enabled, on the current Node.js LTS line, using the official MCP TypeScript SDK for the
  upstream server ([ADR-0010](docs/adr/0010-typescript-node-stack.md), [ADR-0002](docs/adr/0002-mcp-upstream-acp-downstream.md)).
- One language across adapters and schemas. Types derive from the published JSON Schemas (Ajv validates them), not the
  other way round; do not write a second definition of a schema ([LLD](docs/design/LLD.md) owns schemas).
- Run Git and provider CLIs through `execFile` or `spawn` with an argument array and no shell. Spawn providers in their
  own process group so cancel kills the whole tree.
- Standard output is reserved for MCP framing. Logs are structured JSON on standard error with redaction.
- SQLite access stays behind the ledger component, with forward-only migrations ([ADR-0005](docs/adr/0005-sqlite-ledger.md)).
- Provider-specific behaviour lives only in that provider's adapter module, manifest, fixtures and registry entry
  (NFR-MAINT-01). Adapters are version-gated ([ADR-0009](docs/adr/0009-version-gated-adapters.md)).
- Never reference credential paths or read provider transcripts or token files ([ADR-0003](docs/adr/0003-no-credential-handling.md)).
- Tests must pass with no provider CLI installed. Provider behaviour is tested against recorded fixtures and a fake
  provider CLI; live calls are opt-in and skipped by default.

## Git and pull request workflow

- **Branch from `main`.** One logical change per branch and one pull request per change. Do not stack unrelated work on
  an existing branch. If a branch's pull request is already merged, start a fresh branch from the latest `main`.
- **Commits.** One logical change per commit, with a message that says what changed and why. Do not add model or tool
  identifiers to commit messages, pull request titles or file contents unless the task is about them.
- **Pull requests start as drafts** and become ready only when the checks pass. Fill in the
  [pull request template](.github/pull_request_template.md): Before, After, How and the checklist. Tracking labels do not
  belong in the opening section.
- **Squash merge.** Pull requests are merged by squashing into a single commit on `main`, so the pull request title and
  description are the permanent record. Write them for a reader who never sees the branch history. (Convention
  **Proposed** by an agent; repository merge settings are not recorded in this repository.)
- **Review.** `.github/CODEOWNERS` names Ender as the default owner. Agents do not approve or merge their own pull
  requests.
- **Never force-push** a shared branch, rewrite published history, or push directly to `main`.
- **Do not commit** secrets, `auth.json` files, tokens, local settings, build output or scratch files.

## Verification rules

A claim of "done" needs evidence. Before opening or updating a pull request:

1. Run `node scripts/check-docs.mjs` and the Markdown lint command above, and read their output. Fix findings; do not
   edit the lint configuration to silence them without a reason recorded in the pull request.
2. Read your own diff. Confirm that every requirement, design section and ADR you cite exists and says what you claim.
3. Confirm that the change keeps IDs stable: no renumbered or reused `FR-*`, `NFR-*`, `CAP-*`, `BO-*`, `WF-*`, `BR-*` or
   `COMP-*` IDs, and no second definition of something another document owns.
4. For provider facts (flags, models, limits, prices, terms), cite the source and the date it was checked, or label the
   statement an Assumption.
5. Once code exists, also run the typecheck, lint and test commands, and show that a bug fix's test fails without the
   fix.
6. After CI runs, read the result on the latest commit. A green local run does not replace CI, and a red CI is not
   somebody else's problem.
7. Report faithfully: say what failed, what you skipped and what you could not verify. Do not describe unverified work
   as done.

Verification of a subagent's work follows the same rules (see [delegation rules](#practical-delegation-rules)).

## Updating the roadmap

The [roadmap](docs/ROADMAP.md) owns status. When your change finishes, blocks, defers or descopes work:

1. Update the status in [ROADMAP §6](docs/ROADMAP.md#6-milestones) (milestone row and, for M1 and M2, the task table)
   in the same change, with evidence: a test name, a file path or a pull request link. Never mark work `Done` without
   evidence.
2. Use only the defined status values: `Done`, `In progress`, `Partial`, `Planned`, `Blocked`, `Deferred`.
3. New scope goes through the PRD and SRS first, then gets a roadmap entry. Do not add work to the roadmap that no
   requirement covers.
4. Record blocked work as a blocker in [§7.2](docs/ROADMAP.md#72-blockers) and deferred or excluded work in
   [§8](docs/ROADMAP.md#8-deferred-and-excluded-work), each with the reason. A deferral also states what condition
   brings the work back. Deferred work is not removed: keep its requirement ID, mark the requirement's priority
   `Deferred` in the [SRS](docs/requirements/SRS.md), and keep the documents consistent.
5. Add decisions the owner made to [§4.2](docs/ROADMAP.md#42-owner-decisions). Record decisions an agent made as
   "Delegated" in §4.4.
6. Bump "Last reconciled" at the top of the roadmap when you reconcile it with the other documents.
7. Run `node scripts/check-docs.mjs`; it checks roadmap coverage of the requirements.
