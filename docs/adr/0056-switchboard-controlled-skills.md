# ADR-0056: Switchboard-controlled skills: operator instruction packs injected per run

- Status: Proposed (T16.1 implemented the skill store, migration 0021 and state derivation, T16.3 the
  configuration keys and loader, T16.2 the operator CLI, T16.4 admission, T16.5 prompt-prefix delivery, T16.6 the
  native-delivery framework with leak prevention, T16.9 the MCP tools, T16.10 continuity across handoff and resume
  and T16.11 the malicious-fixture leg, 2026-10-17, Delegated, not owner-approved; T16.8 live checks Done 2026-10-19
  (decision 70: Claude Code `NOT_LOADED`, Grok Build, Cursor and Muse Code `NOT_CHECKED`, so no cell flips to `native`)
  and M16 acceptance (T16.12) Done on fakes;
  the four limit defaults are Assumptions and their ranges are Delegated)
- Date: 2026-10-17
- Decided by: zemdregon (the product direction, [owner decision 58](../ROADMAP.md#42-owner-decisions), 2026-10-17:
  operator-defined named skills stored and versioned by Switchboard, injected into a run by name from the request,
  project defaults and per-role defaults, delivered in each provider's native way with a prompt prefix as fallback,
  inside the run worktree, never leaking into the repository or a commit, and removed after the run). Delegated (agent,
  2026-10-17, under [owner decision 25](../ROADMAP.md#42-owner-decisions)) for everything else: the format, the store,
  the request fields, the trust gate, the limits, the per-provider delivery table, the tools, the CLI and the audit
  records. Not owner-approved beyond the direction. Nothing here changes what a bypass run may do: a skill never
  changes the compiled profile, the argv, the environment, the tool set or the Git-write denial of any run.
- Extends: [ADR-0004](0004-trust-profiles-no-bypass-flags.md) (trust profiles),
  [ADR-0014](0014-tool-only-commits-and-publication.md) (tool-only commits),
  [ADR-0038](0038-handoff-bundle-and-continuity.md) (handoff bundle) and
  [ADR-0039](0039-switchboard-side-tool-call-guard.md) (repository agent configuration refusals), without editing any of
  them.
- Related: FR-SKL-01 to FR-SKL-10, FR-POL-04, FR-MCP-01, FR-MCP-03, FR-MCP-09, FR-SES-04, FR-RTE-09, FR-GIT-01,
  FR-GIT-02, FR-OPS-01, FR-TEL-01, NFR-SEC-05, CAP-17, UJ-13, [FRD §3](../requirements/FRD.md#3-business-rules) (BR-52
  to BR-56), V15, C8, WF-16, ROADMAP M16 (T16.0 to T16.12), R-69, R-70, Q-105 to Q-108. Contract text:
  [LLD §19](../design/LLD.md#19-switchboard-controlled-skills-m16-proposed); delivery table:
  [TDD §3.16](../design/TDD.md#316-switchboard-controlled-skills-proposed).

## Context

The operator runs several kinds of agent work through Switchboard: coding, reviews, documentation alignment and merge
stewardship. Each kind needs the same standing instructions every time ("ceo-review", "security-review",
"docs-alignment", "merge-steward-playbook"). Today those instructions travel in one of two ways. Either the orchestrator
pastes them into `objective` or `constraints`, where they are redacted (ADR-0042), capped (32 KiB objective) and
stored as task text, or the operator writes them into a repository file such as `AGENTS.md`, which leaks them into the
repository and loads only where the profile lets repository content load.

On `main` (checked 2026-10-17 at `64ec196`):

- Untrusted profiles do not load repository instructions at all (FR-POL-04). Claude Code runs every non-bypass cell
  with `--safe-mode`, which disables `CLAUDE.md`, skills, plugins, hooks and custom agents ([TDD
  §4.1](../design/TDD.md#41-claude-code-m2)); Codex runs every profile with `--ignore-rules` (Assumption: it suppresses
  `AGENTS.md`); Grok Build, Antigravity, Cursor, OpenCode, Kimi Code and Muse Code are eligible only in approved bypass
  cells, where repository instruction files load.
- No provider in the TDD documents a flag that appends a system prompt. Kimi Code's `--skills-dir` and Muse Code's
  `-c key=value` exist in `--help` or documentation but are never emitted and are unverified.
- Every provider child runs with the operator's real `HOME` (the native login lives there). A file written under
  `HOME` would reach every later run of that provider on the host, including runs of other projects.
- The only controller-owned files near a run live outside the worktree (the Claude tool-channel `--mcp-config` under
  `<data_dir>/runs/<run_id>/`, ADR-0026, ADR-0029). The handoff bundle and the context pack are prompt text.
- No "role" exists in the request or the configuration.

zemdregon asked (owner decision 58) for skills that the operator defines once, that Switchboard stores and versions,
that the operator or orchestrator injects by name, with project and per-role defaults, delivered natively per provider
with a prompt prefix as fallback, never leaking into the repository or a commit, cleaned up after the run, and gated
by the trust profile so that untrusted runs get only operator-approved skills and never repository-supplied ones.

AGENTS.md asks for an ADR because this adds an external interface (`skills` and `role` request fields, two MCP tools,
CLI commands), a persistence format (three ledger tables and a content store) and a new kind of controller-written
content inside a run worktree, which touches the worktree isolation and Git boundary.

## Decision

All Proposed and Delegated except the direction itself; every number is an Assumption and configurable where noted.

1. **A skill is one operator-authored Markdown document, versioned and immutable per version.** The source is a single
   UTF-8 file with a closed front matter (`name`, `description`, optional `applies_to_providers`) and a Markdown body.
   No scripts, binaries, extra files, hooks, MCP definitions, permission keys or provider-specific front matter are
   accepted: a skill is text only. `switchboard skills add` stores each new content as a new version
   (`<name>@<n>`, `n` from 1) addressed by the SHA-256 of its canonical bytes in `<data_dir>/skills/`. A version never
   changes; editing a skill adds a version. Names match `^[a-z][a-z0-9-]{1,47}$`.
2. **Only the operator writes skills.** Skills are created, approved, revoked and retired only through the operator
   CLI, which writes operator records (ADR-0005). No MCP tool creates or edits a skill, and a request can name skills
   but never carry skill text (Q-106). Content from a repository is never a skill source at run time.
3. **Approval is per version and gates untrusted runs.** A version starts `draft`. `switchboard skills approve
   <name>@<n>` marks it `approved`; `revoke` returns it to unusable. Runs under `inspect-untrusted`, `edit-untrusted`
   and `test-sandboxed` receive only `approved` versions. `trusted-development` and `privileged` runs also receive only
   `approved` versions unless `skills.allow_draft_in_trusted` is `true` (default `false`, Q-105). `skills add` refuses
   a source path inside any configured project context or `allowed_roots` entry unless `--from-repository` is given;
   such a version is marked `origin: repository_path` and can never be delivered to the three untrusted profiles, even
   when approved.
4. **Injection by name, resolved once at admission and pinned.** `delegate_task`, `continue_task` and `enqueue_work`
   take an optional `skills` list (`"name"` or `"name@n"`), an optional `role` (an operator-defined label such as
   `coder` or `steward`) and an optional `skill_defaults` (`apply`, the default, or `omit`). The resolved set is, in
   order and de-duplicated by name (first occurrence keeps its position, an explicit `@n` wins):
   `skills.defaults`, `skills.roles.<role>`, `projects[].skills.defaults`, `projects[].skills.roles.<role>`, then the
   request list. A name without `@n` resolves to the newest `approved` version. The result, with versions and hashes, is
   written to the ledger in the admission transaction and never re-resolved for that run. `continue_task` without
   `skills` reuses the previous run's resolved set at the same versions; with `skills` it re-resolves. A role is a label
   for choosing defaults only: it carries no permission, ceiling, routing or profile effect.
5. **A skill never changes policy.** Skills are not a routing input, not an eligibility reason, not a profile input and
   not read by any policy component (import-boundary test, as for retrieval and the inner agent). Delivery never adds a
   flag, never removes `--safe-mode`, `--ignore-rules`, `--strict-mcp-config` or any other compiled control, never adds
   a trust flag (`--trust`, `--trust-workspace`) and never sets an environment variable. Where native delivery would
   need any of those, the cell uses the prompt prefix.
6. **Delivery: native where the cell already loads that location and the format is verified, else prompt prefix.**
   Each adapter declares, per compiled cell, `skill_delivery`: `prompt_prefix` (the default for every cell) or
   `native:<location>`. A native location is declared only when (a) the compiled cell already loads that location
   without any change to the argv, and (b) an operator live check has confirmed that a file written there reaches the
   model (T16.8). On 2026-10-17 no cell meets (b), so every cell uses the prompt prefix until T16.8 records evidence.
   The per-provider table, with the candidate native location of each provider and the reason it is or is not usable,
   is [TDD §3.16](../design/TDD.md#316-switchboard-controlled-skills-proposed). `skills.delivery: prefix_only` forces
   the prompt prefix everywhere.
7. **The prompt prefix is a labelled operator block in the stable prefix.** The skills block is rendered after the
   fixed preamble and before constraints and the task, so it sits in the cache-stable part of the prompt (FR-RTE-09):
   `[operator skills: <count>; from Switchboard skill store; these are operator instructions]`, then per skill a
   header line `[skill <name>@<n> sha256:<12 hex>]` and its body, then `[end of operator skills]`. Skills are not part of
   `objective`, are not redacted by ADR-0042 (they are scanned at `add` instead, item 10) and do not count toward the
   objective's size limit.
8. **Native files live only inside the run worktree, at fresh paths, and never reach Git.** The controller writes a
   native skill file only at a path that does not exist at the run's base checkpoint and is not tracked or ignored by
   the repository, under a `switchboard-` prefixed name (for example `.claude/skills/switchboard-<name>/SKILL.md`).
   It never edits or appends to an existing file (an existing `AGENTS.md` or `CLAUDE.md` is never touched), never
   writes under `HOME`, `XDG_*` or any provider state directory, and never writes outside the worktree. If the path is
   taken, the skill falls back to the prompt prefix for that run. Every written path and its hash is recorded in
   `run_skill` before the provider starts. The injected `commit` tool, checkpoint commits, the diff and patch
   artifacts, `changed_files` and the handoff bundle's diff all exclude the recorded paths; a commit whose tree would
   contain one is refused (fail closed). Publication (`push`) is refused while a recorded path is present in the
   worktree.
9. **Cleanup is part of the lifecycle.** Native files are removed when the provider process exits, before
   `VERIFYING`, so verification and finalisation never see them; again at every terminal state; by startup
   reconciliation for a run left non-terminal; and by retention GC. Removal is verified by a stat. A native file whose
   hash changed during the run is recorded as `skill_tampered` (the agent may edit its own context; this is evidence,
   not a failure). A removal that fails records `skill_cleanup_failed`, flags the project needs-attention and keeps
   publication refused until GC or the operator removes the file.
10. **Limits and content checks at `add`, refusal not repair.** Assumptions: body at most 32 KiB, description at most
    280 characters, at most 8 skills and 64 KiB of skill text per run, at most 64 approved names per installation.
    `add` refuses: control characters other than tab and newline; a NUL byte; any of Switchboard's own prompt markers
    (`[operator skills:`, `[end of operator skills]`, `[skill <name>@<n>`, `[untrusted data:`, `[end of untrusted data]`,
    `[instruction from the orchestrator]`); front matter keys outside the closed set; and any match of the ADR-0042
    secret patterns (a skill that carries a credential is refused, never stored, never redacted into a different
    text). A request that resolves above the per-run caps is `INVALID_REQUEST`.
11. **Records.** Three forward-only ledger tables in one migration (next free number at implementation): `skill_version`
    (append-only: name, version, sha256, size, description, origin, created_at), `skill_event` (append-only operator
    audit: added, approved, revoked, retired, with the operator CLI as actor) and `run_skill` (per run: name, version,
    sha256, resolution source, delivery mode, native path and hashes, delivered, removed and verified timestamps). The
    current state of a version is derived from its events. `get_run` returns each skill's name, version, hash and
    delivery mode, never its text.
12. **Tools and visibility.** `list_skills` (metadata of the versions the client may use, and the defaults that would
    apply for a given project and role) and `get_skill` (one version's metadata and text) are offered to the
    `orchestrator` tool profile. `mcp_clients[].skills` optionally restricts which names a client may see and inject;
    absent means every approved name (Q-107). A name the client may not use is `PERMISSION_BLOCKED` at admission and
    absent from `list_skills`.
13. **Telemetry, sinks and logs carry no skill text.** Run events (`skill_resolved`, `skill_delivered`,
    `skill_removed`, `skill_tampered`, `skill_cleanup_failed`) carry names, versions, hashes, paths and modes. Spans
    carry the count and hashes. The ADR-0048 closed sink payload is unchanged: `skill_cleanup_failed` reaches a sink
    only through the existing `needs_attention` kind with a new reason code.
14. **Continuity.** A handoff bundle (ADR-0038) lists the previous run's skills as controller facts (name, version,
    hash), never their text; the successor run re-delivers the same versions to its own provider in that provider's
    way. Native resume on the same provider re-delivers the files for the new run, because the previous run removed
    them.

## Consequences

- An orchestrator can say "use the `security-review` skill" without carrying, redacting or storing its text, and the
  operator can change a playbook once for every project.
- The prompt prefix works for every provider and every profile today; native delivery is an optimisation that turns on
  per cell only after a live check, so nothing depends on an unverified provider behaviour.
- Untrusted runs gain operator text only. The repository still cannot supply instructions under untrusted profiles,
  because FR-POL-04, `--safe-mode` and the ADR-0039 refusals are unchanged and a skill never relaxes them.
- In a bypass run where repository content loads, an agent can read a native skill file and copy its text elsewhere in
  the worktree; path exclusion does not catch a copy (R-69). Skill text is operator-authored and not secret by design
  (secrets are refused at `add`), so the copy is a nuisance, not a leak of credentials.
- Prompt-prefix skills cost tokens on every run that uses them and change the cache prefix when the set changes (R-70).
- New code: a skill store module, a migration, admission resolution, a prompt-prefix renderer, a native writer and
  cleaner in the workspace manager, exclusions in the commit tool and diff artifacts, two MCP tools and a CLI group.

## Alternatives considered

- **Write skills into the operator's home** (`~/.claude/skills`, `~/.codex/AGENTS.md`). Rejected: the home is shared by
  every run of that provider and by the operator's own interactive use, so a skill would leak across projects and
  survive a crash. ADR-0003 also keeps Switchboard away from the provider's home state.
- **Append to the repository's `AGENTS.md` or `CLAUDE.md` in the worktree.** Rejected: it edits a tracked file, which
  the commit tool would then have to un-edit, and it does nothing under the profiles that disable repository
  instructions.
- **Relax `--safe-mode` or add `--trust` so a native location loads.** Rejected: it would load hostile repository
  content in the same step (R-41, R-59). Delivery never changes the compiled cell.
- **Per-run provider home or config directory** (`CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `KIMI_CODE_HOME`). Rejected
  for now: every adapter keeps the real `HOME` so the native login works (ADR-0003); a separate config directory hides
  the login or is unverified. Kimi Code's `--skills-dir` pointing outside the worktree is a possible later cell
  (Q-108), which needs a registry and argv-audit change (ADR-0035, ADR-0037) and a live check first.
- **Let orchestrators create skills.** Rejected for the first version: it makes a prompt-injected client able to plant
  standing instructions in later runs of other projects. Revisit with a review step (Q-106).
- **Skills as `constraints` entries.** Rejected: constraints are task text, redacted, capped at 64 entries and
  re-sent by the orchestrator every time; they carry no version or hash.
