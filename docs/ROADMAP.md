# Switchboard Roadmap

| Field | Value |
| --- | --- |
| Status | **Canonical.** Single source of truth for scope, priorities, dependencies, sequencing, status and completion criteria. |
| Does not own | Requirements ([SRS](requirements/SRS.md)), behaviour ([FRD](requirements/FRD.md)), design ([HLD](design/HLD.md), [SDD](design/SDD.md), [TDD](design/TDD.md), [LLD](design/LLD.md)), decision rationale ([ADRs](adr/README.md)). |
| Last reconciled | 2026-10-13 |
| Current milestone | M0 and M1 complete (M1 gaps `Partial` in §6.1). **M2: `Partial`**: T2.1 to T2.8 are implemented and tested on fakes and synthetic fixtures; not `Done` until the operator's live smoke run (which now also covers the FR-GIT-01 checks), a recorded Codex version (NFR-PERF-02 is implemented by T3.21, Delegated decision 29; §6.2, §6.2.1, §9). The FR-GIT-01 argv check is in place. **M3: `Planned`**, broken into tasks in §6.5 (2026-10-12) with owner decisions 10 to 13 and 17 recorded (17 and the Delegated machine-readable scope on 2026-10-13); wave A is implemented in part (`Partial`: code for T3.2, T3.8's controller leg and T3.12's algorithm landed through PR #14 and its wiring (`doctor`, `switchboard gc`, `serve`) is `Partial` in §6.5; per-task status in §6.5, §9). M9 and M10 (projects, controlled commits, containers) follow M3; M11 (inner agent, owner decision 14) is planned after M9 |

## 1. How to use this roadmap

Read this first, then the documents it links for the milestone you are working on. Update the status column in §6 in the
same change that completes or blocks work, citing evidence (a test, a file path, a PR). Do not mark anything done
without evidence. Agent working rules are in [AGENTS.md](../AGENTS.md).

## 2. Product summary

**Purpose.** Switchboard is a local, headless controller that lets one primary AI orchestrator delegate coding tasks to
the operator's existing AI coding subscriptions (Claude Code, Codex, Grok Build, Antigravity, Cursor CLI, OpenCode, Kimi
Code, and since 2026-10-13 Muse Code) through each vendor's documented automation surface, behind one small MCP
tool interface. It owns policy,
workspace isolation, cross-provider task state, routing and capacity estimation, so the orchestrator does not have to.

**Users.** The *operator* (the account owner who installs Switchboard and logs in to each CLI; Ender first; Switchboard
is published as open source so anyone can run their own installation with their own subscriptions) and the
*orchestrator* (an MCP client agent such as OpenClaw or Grok Bot). See [PRD §2](requirements/PRD.md).

**Desired outcomes.** BO-1 to BO-8 in the [BRD](requirements/BRD.md): more work per paid subscription, no credential
handling, safe unattended runs, continuity across providers, visibility, resilience to CLI churn, agent work that
reaches the repository as ordinary commits with the audit record kept internally, and cheap text work handled by an
operator-chosen inner model instead of premium capacity.

**In scope.** Capabilities CAP-1 to CAP-12 in the [PRD](requirements/PRD.md), including projects (the environments
agents operate from and their contexts, CAP-10), controlled commits and publication (CAP-11) and the inner agent
(CAP-12). "Application" in this
project means the MCP tool surface plus the operator CLI; "backend" means the controller daemon and its ledger,
workspace manager, router and adapters.

**Non-goals.** Owned by [PRD §6](requirements/PRD.md#6-non-goals). In short: no web UI (a read-only usage dashboard is
deferred), no login or OAuth handling, no hosted or multi-user service, no reimplementation of provider APIs, no claim
of Terms-of-Service compliance, no automatic merges into the operator's branches, and no push that is not made by a
policy-gated Switchboard tool (off by default); agents never commit or push themselves.

## 3. Current state and target state

### 3.1 Audit findings (2026-10-12)

| Area | Finding | Evidence |
| --- | --- | --- |
| Source code, tests, config, CI | None exist. Nothing is implemented. | Repository tree at commit `d41c10c`: only `LICENSE` and `docs/research/` |
| Agent instructions | None existed before this change. Now [AGENTS.md](../AGENTS.md) (with `CLAUDE.md` importing it). | — |
| Roadmap / plan | **No authoritative roadmap existed.** The plan was fragmented across two research documents. The closest thing to a plan was the eight-stage "production sequence" table at the end of the verified research. | [R2 § MCP, ACP, and the recommended production architecture](research/headless-ai-coding-controller-verified-2026-10-12.md#mcp-acp-and-the-recommended-production-architecture) |
| Original blueprint | Describes intent and an architecture, but many concrete flags, permission settings, quota assumptions and the transcript-extraction approach are contradicted by later verified research. Retained as historical record, marked **superseded where it conflicts**. | [headless-ai-coding-controller.md](research/headless-ai-coding-controller.md) |
| Verified research | Current as of 2026-10-12. Reviews the blueprint point by point and recommends corrections. Used as the primary technical source. Not itself a requirements or design document. | [headless-ai-coding-controller-verified-2026-10-12.md](research/headless-ai-coding-controller-verified-2026-10-12.md) |
| Requirements and design documents | None existed. Created in this change (see §5). | — |

### 3.2 Target state

An open-source, single-operator-per-installation controller for Linux and macOS that passes conformance and
malicious-fixture suites for all seven providers (Kimi Code once its contract is pinned), is installable by other people
from its README, exposes the MCP tools in [SRS §3.1](requirements/SRS.md#31-mcp-interface-fr-mcp), continues work across
providers from controller-owned state, routes with explainable decisions, and reports capacity as confidence-weighted
estimates. Architecture: [HLD](design/HLD.md).

## 4. Constraints, assumptions, decisions and conflicts

### 4.1 How sources are classified

| Class | Meaning | Where recorded |
| --- | --- | --- |
| **Owner decision** | Explicitly decided by Ender. | Listed in §4.2 only. |
| **Stated intent** | Requirements stated in the original blueprint's introduction, which Ender supplied as the project brief. Treated as approved intent, not as approved design. | §4.3 |
| **Delegated decision** | Made by an agent during the 2026-10-12 planning task under Ender's delegation. Binding for implementation until revised, not owner-approved. | ADRs marked "Delegated", and §4.4 |
| **Assumption** | Conservative choice where information is missing. Must be confirmed or replaced. | §4.5 |

### 4.2 Owner decisions

1. The two research documents are project research for Switchboard (PRs #1 and #2, merged).
2. Agent work in this project routes model tiers by task difficulty (Haiku for simple, mechanical work; Opus or Fable
   only for demanding work). Recorded in [AGENTS.md](../AGENTS.md#subagent-routing-and-orchestration).
3. The documentation set and roadmap in this change were requested by Ender. Their *content* is delegated, not approved.
4. Switchboard is built for Ender's own use and published as open source so other people can run it with their own
   subscriptions (2026-10-12).
5. Ender holds every subscription named in the research. All seven providers must be integrated; Claude Code and Codex
   are the first integrations (2026-10-12).
6. Switchboard controls *projects*: the environments the coding agents operate from (likely a container of some kind)
   and the *contexts* of those projects, such as repositories (2026-10-12). Recorded in
   [ADR-0013](adr/0013-projects-environments-and-contexts.md); the mechanism is delegated.
7. The agents have no commit or push controls. Commits and pushes are made by Switchboard tools injected into the agent,
   so there are no co-author trailers, "generated by" footers or session IDs and a commit looks like any other commit
   (2026-10-12). Recorded in [ADR-0014](adr/0014-tool-only-commits-and-publication.md); the mechanism, and keeping an
   internal audit trail of which agent produced which commit, are delegated.
8. An orchestrator may create and change projects over MCP (2026-10-12, answer "yes" to Q-7). Recorded in
   [ADR-0013](adr/0013-projects-environments-and-contexts.md). The gating (client opt-in, the client's own limits,
   operator approval for containers and push, creator-only visibility) is delegated.
9. Agents may push, through the injected `push` tool, and commit signing is wanted (2026-10-12, answer "yes" to Q-9).
   Recorded in [ADR-0014](adr/0014-tool-only-commits-and-publication.md). Reading: the question had two parts and "yes"
   was taken for both. Branch scope, the per-context opt-in (push stays off until a context enables it) and the
   signing mechanism are delegated. Ender left Q-6 (container runtime and logins) and Q-8 (commit identity) to the agent,
   so those choices are delegated, not owner decisions.
10. Codex under `inspect-untrusted` and `edit-untrusted`: the native Codex sandbox is accepted for now, and Codex stays
    eligible for those profiles (2026-10-12). *Consequence for the plan:* commands that Codex runs inside its sandbox,
    and whether that sandbox keeps them away from Codex's own credential store, are recorded as **unverified**, not as
    confined; the FR-POL-06 gap for Codex stays open until the live malicious leg (T3.9) checks it; the README's "no
    shell" wording is wrong for Codex and is corrected (T3.14). This answers the profile part of Q-11.
11. Verification commands (FR-EXE-08) may run on the host under `edit-untrusted` (2026-10-12). *Consequence:* confined
    verification through an outer sandbox (T3.11) is optional hardening, not a prerequisite for the verification stage
    (T3.10). Verification under `inspect-untrusted` is still refused ([FRD V7](requirements/FRD.md#71-delegate_task),
    Proposed; the SRS says nothing that overrides it).
12. Profile overrides in configuration (`profiles.<name>`, FR-POL-01) may loosen the defaults when the change is
    recorded in the run's policy snapshot (2026-10-12). *Consequence:* TDD §3.1's "may only tighten" contradicted
    FR-POL-01 and is corrected in this change (T3.15); T3.2 requires a loosening to be explicit in the config,
    validated, listed in the policy snapshot and reported by `doctor`.
13. Provider permission-bypass flags (`--dangerously-skip-permissions`, `--yolo` and the others in FR-POL-03) may be
    emitted only when the operator-approved `privileged` scope explicitly sets bypass and the approval row covers that
    scope (2026-10-12). *Consequence:* this narrows FR-POL-03 and BR-14 rather than widening them, but it changes an
    external interface and [AGENTS.md](../AGENTS.md#working-rules) allows a bypass flag only where a design document
    calls for it. Before any code emits a bypass flag: an [LLD §3](design/LLD.md#3-mcp-tool-contracts) contract change
    for the `privileged_scope` shape and a new ADR (Delegated wording, citing this decision) (T3.16), and the argv audit
    and `BYPASS_FLAGS` tests changed to allow a bypass flag only for an approved privileged scope with `bypassApproved`
    (T3.17).
<!-- markdownlint-disable-next-line MD029 -->
14. Switchboard has an *inner agent*: a self-hosted model, a cheap or free OpenCode model, or another model of the
    user's choosing, used for many cheap tasks so the main provider CLIs do not have to do them: commit and PR writing,
    task routing for auto mode, and other tasks the drafter judges to fit (2026-10-13). Recorded in
    [ADR-0016](adr/0016-inner-agent.md). Ender's wording covers only the product idea. Everything else is delegated and
    Proposed: the backend kinds, which tasks are in scope ([PRD §3.1](requirements/PRD.md#31-inner-agent-task-catalogue)),
    the rule that it has no authority over security or run status, validation, fallback, privacy and the M11
    placement. (Numbers 10 to 13 are used by the open M3 plan, PR #13.)
<!-- markdownlint-disable-next-line MD029 -->
15. Ender told the agent to go with its recommendations on Q-23 to Q-26 (2026-10-13): no hosted API key in
    Switchboard; M11 after M9; `draft_if_missing` for commit messages and PR drafts off unless enabled; the OpenCode
    `cli` kind stays Should until T11.0. The recommendations were already the defaults in force, so no requirement
    changed. They are now owner-chosen, not only delegated.
<!-- markdownlint-disable-next-line MD029 -->
16. Muse Code (Meta's `muse` CLI) is added to the provider support plan (2026-10-13). Ender said it is "not a must
yet", so FR-ADP-12 is `Should`, in M4 (Q-27 keeps the access question open). Evidence is third-party and unverified
    ([research note](research/muse-code-2026-10-13.md)); the adapter design is delegated.
<!-- markdownlint-disable-next-line MD029 -->
17. "Initial privileged approval lasts forever" (2026-10-13, Ender's answer to Q-29; numbered 14 while the M3 plan was
    open, renumbered on merge because main used 14). *Reading (the orchestrator's
    interpretation of the answer, recorded so that Ender can correct it):* the operator's approval of the **first**
    `privileged` run in a meta-session for a given scope is durable. It never expires, is never revoked automatically,
    and covers later runs of the **same** meta-session with the **same** scope, including `continue_task`
    continuations, without a new approval. A different scope, a different meta-session or a different MCP client needs
    a new approval. A bypass flag is still emitted only when the approved scope sets `bypass: true` (decision 13).
    *Consequences for the plan:* the approval binding in [LLD §3.1](design/LLD.md#31-privileged-scope-m3) moves from one
    run to (client, meta-session, canonical scope); `continue_task` may resolve `privileged` on a meta-session with an
    `APPROVED` approval, taking the approved scope as is and never widening it ([FRD C7](requirements/FRD.md#72-continue_task),
    reversing Q-29's Proposed default); FR-POL-09, FR-POL-03, BR-14, WF-7 and
    [ADR-0017](adr/0017-approved-privileged-scope-bypass.md) are amended (IDs unchanged); T3.3 and T3.4 change. Whether
    the operator needs a way to revoke a durable approval is Q-30.

<!-- markdownlint-disable-next-line MD029 -->
18. Design principle (2026-10-13): Ender prefers bypass modes for his own workloads. The less restrictive modes are
    for him; the more restrictive profiles exist for other people who deploy Switchboard. Bypass runs should be very
    loose and give agents the most freedom, so the restrictive defaults stay and loosening is explicit. *Consequence:*
    no default changes; every loosening (an approved `bypass: true` scope, a `profiles.<name>` override, the
    `privileged_approval` setting of decision 22) stays opt-in, explicit in the scope or the operator's configuration,
    and recorded. Later choices between a restrictive and a permissive option for bypass runs lean permissive, within
    decision 22's limits. *Residual risk:* the permissive choices below (R-38, R-39) apply to anyone who opts in, not
    only to Ender.
<!-- markdownlint-disable-next-line MD029 -->
19. Answer to Q-33 (2026-10-13): for an approved `bypass: true` run on Claude Code, the adapter omits `--restricted`
    (and keeps the other isolation flags) instead of making `privileged` with bypass `Ineligible`. *Consequence:*
    recorded in [ADR-0018](adr/0018-claude-bypass-omits-restricted.md), which partly supersedes
    [ADR-0015](adr/0015-claude-untrusted-isolation-flags.md) for approved bypass runs only; T3.5 compiles that cell; the
    lifecycle no longer refuses every `privileged` run at dispatch, and the adapter's
    compile decides (T3.18). *Residual risk:* R-38 (whether the `--disallowedTools` Git deny rules still hold under
    bypass is unverified).
<!-- markdownlint-disable-next-line MD029 -->
20. `edit-untrusted` stays as in M2 (2026-10-13): a `profiles.edit-untrusted` override that loosens `network` or
    `repo_config` is not enforced; the run uses the strict settings. *Consequence:* a known limit, documented in the
    [README](../README.md#trust-profiles) and the configuration table ([TDD §3.1](design/TDD.md#31-configuration)); no
    code change. As the code stands (checked 2026-10-13), the Claude adapter compiles `edit-untrusted` with network off
    at the tool level and repository configuration disabled whatever the override says, while the Codex adapter makes
    such a run `Ineligible: CAPABILITY_MISSING` (it compiles only network `off` and repository configuration
    `disabled` for every profile). The override is still listed by `doctor` and recorded in the policy snapshot.
    *Residual risk:* R-25 (an operator may believe a loosening applies when it does not); the opposite risk (silent
    widening) does not arise.
<!-- markdownlint-disable-next-line MD029 -->
21. Codex `trusted-development` stays eligible with `shell: broad` (2026-10-13): Codex runs it in its `workspace-write`
    sandbox, and Git writes are limited only by that sandbox, which is unverified (decision 10's reasoning extended to
    `trusted-development`). *Consequence:* T3.6's matrix keeps that cell compilable (as the code already does); FR-GIT-01
    for Codex `trusted-development` rests on the sandbox Assumption until the live check X-G1 (T3.9). *Residual risk:*
    R-23 and R-37 (sandbox behaviour unverified); a Codex `trusted-development` agent may be able to write Git if the
    sandbox does not block the worktree's Git directory.
<!-- markdownlint-disable-next-line MD029 -->
22. In approved bypass runs only the **per-scope approval** is lifted (2026-10-13); Git-write denial (FR-GIT-01, owner
    decision 7) and worktree isolation (FR-WS-05) stay enforced. *Delegated realisation (not owner-approved):* a
    per-client configuration setting `mcp_clients[].privileged_approval`, `"required"` (default, the restrictive
    choice for other deployers, decision 18) or `"not_required"`. With `not_required`, a `privileged` request from that
    client (ceiling still `privileged`; scope still validated, canonicalised, hashed and recorded; `bypass` still
    explicit in the scope) is admitted straight to QUEUED, with its approval row written `APPROVED` and
    `decided_by = "client_policy:<client_id>"` in the same admission transaction, so the audit trail is kept and the
    durable-approval rule of decision 17 applies to its continuations; `approve` and `deny` keep working for clients
    with `required`. Recorded in [ADR-0019](adr/0019-per-client-privileged-approval.md), which amends
    [ADR-0017](adr/0017-approved-privileged-scope-bypass.md)'s approval requirement for those clients; FR-POL-09,
    FR-POL-03, FR-MCP-06, BR-13, BR-14, WF-7 and [LLD §3.1](design/LLD.md#31-privileged-scope-m3) carry dated notes;
    T3.18. *Residual risk:* R-39 (approval-free privileged runs for those clients).
<!-- markdownlint-disable-next-line MD029 -->
23. Answer to Q-36 (2026-10-13; Ender: "Refuse network off at tool level"): a Claude Code `privileged` scope with
    network `off` or `allowlist` stays `Ineligible: CAPABILITY_MISSING`, as T3.5 implements, so a privileged scope never
    claims a network limit that Claude enforces only at the tool level. *Consequence:* no code or requirement change;
    Q-36's Proposed default is now owner-chosen, and [TDD §4.1.1](design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30)
    cites this decision. *Reading (recorded so that Ender can correct it):* the answer is taken for Q-36 only. Q-34
    (whether tool-level `off` is enough for `edit-untrusted` and `trusted-development`) and Q-37 (repository
    configuration `enabled` in a privileged scope) are not answered and stay open with their defaults.
<!-- markdownlint-disable-next-line MD029 -->
24. Bypass without prompts; host and container agents (2026-10-13). Ender, verbatim: "My main concern for my usability
    of the product is having a bypass mode where all agents never have to ask for my permission, but since we are
    containerizing, we could simply not include a git tool, then git is handled by switchboard on the host. However,
    switchboard should support host-run agents as well as container agents, depending on how the user wants to set them
    up." *Owner direction:* (a) his main usability goal is a bypass mode in which agents never ask for his permission;
    (b) Switchboard supports both host-run and container-run agents, chosen per project (its environment) by whoever
    deploys it; (c) in a container environment the image ships without a Git tool (no `git`, no `gh`), so FR-GIT-01
    holds by construction rather than through provider deny rules, and Git (commit, push) is done by Switchboard on the
    host through the injected tools (FR-GIT-02 to FR-GIT-09, [ADR-0014](adr/0014-tool-only-commits-and-publication.md));
    (d) host-run agents keep the existing controls (Git deny rules where the provider has them, FR-GIT-03 ref
    snapshots, FR-GIT-06). The mechanism is Delegated. *Already in the plan:* (a) is decisions 13, 17, 19 and 22
    (approved `bypass: true` scope, durable approval, per-client `privileged_approval: "not_required"`; T3.18 done),
    though not every provider compiles a bypass scope yet (Codex does not); (b) is FR-PRJ-04's two environment kinds,
    `host` in M9 and `container` in M10, set per project in configuration ([LLD §11.1](design/LLD.md#111-configuration-shape)),
    with "always run in a container" already rejected in [ADR-0013](adr/0013-projects-environments-and-contexts.md);
    for (c), a container already mounts neither the Git directory nor any credential store (FR-PRJ-05,
    [TDD §3.11](design/TDD.md#311-container-environments)), the injected tools already run in the controller, and BR-31
    already allows `push` in a container with no credentials mounted. *What changes (Delegated, dated notes, no new
    IDs):* FR-PRJ-05 now requires an image with no Git client, checked before a run; FR-PRJ-04 says both kinds are
    first-class and chosen per project; FR-GIT-01 says how it holds in each kind; [TDD §3.10](design/TDD.md#310-git-commits-attribution-and-publication)
    and §3.11 follow; T10.0, T10.1 and T10.3 gain the checks (§6.4). Sequence unchanged (M3, then M9, then M10); Q-38
    was decided in decision 25. *Residual risk:* R-38 for host-run Claude bypass until C-G2; R-40 (provider
    CLIs that need Git; a Git client fetched or Git files written by an agent with shell and network).

<!-- markdownlint-disable-next-line MD029 -->
25. Delegation rule, Q-34, Q-38 and the container-image ADR (2026-10-13). Ender, verbatim: "Q37: explain. Q34 unless it
    affects bypass mode you make the decisions (add that to agents) my only concern is with bypass mode, other modes
    are for other users, so choose the industry best choices/practices. Q38 you pick. Container ADR sure make it".
    *Owner direction:* (a) a decision that does not affect bypass mode is the agent's, made by industry best practice;
    this is now a working rule in [AGENTS.md](../AGENTS.md) ("Best-practice defaults outside bypass mode"); (b) Q-37
    was asked to be explained, not answered, and stays open because it affects bypass runs; (c) the container-image
    ADR is wanted. *Delegated decisions made under (a), not owner-approved:* **Q-34** (no bypass effect): tool-level
    network `off` stays acceptable for `inspect-untrusted`, `edit-untrusted` and `trusted-development` when every shell
    command is an explicit allowlist entry the operator chose (least privilege), and stays `Ineligible:
    CAPABILITY_MISSING` with a `broad` Claude shell, as T3.5 implements; to avoid claiming an unenforced control,
    `list_capabilities` and the docs describe such `off` as "tool level only", never as an enforced network block, and
    R-36 stays open until the outer sandbox (T3.1) or the live check (T3.9) enforces it. **Q-38** (the order only
    affects when the container route arrives, not what bypass may do): the order stays M3, M9, M10, because M10 needs
    the M9 projects and injected tools; the document-only spike T10.0 may start any time after M3 (it needs no M9 code)
    so the container route is verified early. **Container image:** [ADR-0020](adr/0020-container-image-without-git-client.md)
    records the no-Git-client image rule of decision 24 (c) and amends ADR-0013's container mechanism.

<!-- markdownlint-disable-next-line MD029 -->
26. Answer to Q-37: repository configuration in approved bypass runs (2026-10-13). Ender, verbatim: "bypass mode allow
    all agents to make the changes". *Consequence (Delegated realisation, not owner-approved in detail):* in an
    approved bypass run (a `privileged` scope with `bypass: true` and the run's `bypassApproved`), `repository_config`
    modes `approved` and `enabled` compile, so repository hooks, MCP definitions and instruction files may load. Claude
    Code: the bypass argv omits `--safe-mode` for both; `--strict-mcp-config` is kept for `approved` (no repository MCP
    definition loads) and omitted for `enabled` (the repository's `.mcp.json` can load); `--restricted` stays absent
    ([ADR-0018](adr/0018-claude-bypass-omits-restricted.md)); `--permission-prompts none`, the tool lists and the
    FR-GIT-01 Git deny rules are unchanged, and `--mcp-config` stays barred. Recorded in
    [ADR-0021](adr/0021-repository-config-in-approved-bypass-runs.md); implemented by T3.19. A non-bypass `privileged`
    scope, a bypass scope without approval, and every other profile keep `Ineligible: CAPABILITY_MISSING` for
    `approved` and `enabled`. Codex stays refused for repository configuration because its `bypass: true` is itself
    `Ineligible` (flag undocumented); the decision applies once a Codex bypass is documented. Worktree isolation
    (FR-WS-05) and Git-write denial are unchanged. *Reading (recorded so that Ender can correct it):* "allow all agents
    to make the changes" is read as "allow every provider adapter's bypass run to load repository configuration", not
    as lifting any other limit; the split `approved` (MCP still blocked) versus `enabled` (MCP loads) is the agent's
    choice. **Unverified:** that omitting `--safe-mode` and `--strict-mcp-config` loads exactly those items under
    `claude --help` 2.1.296; the help text does not say. A live check is required (T3.9). *Residual risk:* R-41.

<!-- markdownlint-disable-next-line MD029 -->
27. Answer to Q-31: nested repositories in a run worktree (2026-10-13). **Delegated decision (agent), under [owner
    decision 25](#42-owner-decisions); not an Ender quote and not owner-approved.** It does not affect bypass mode (it
    fails no run, so Ender's bypass runs stay unobstructed), so by decision 25 (a) it is the agent's, by best practice.
    The controller never lets Git descend into a nested repository and does not fail the run. Before each controller
    Git operation that scans the worktree (`assessMutation`: `status`, `diff`; `finalize` and `rollback`: `add -A`,
    `diff --cached`), it enumerates every directory below the worktree root that holds a `.git` entry of any kind
    (directory, gitdir-pointer file or symlink) without following symlinks and without running Git, and excludes each
    with a `:(exclude,top,literal)<path>` pathspec (`glob` with escapes for a name that is not valid UTF-8);
    `status` and `diff` also pass `--ignore-submodules=all`. The worktree root's own `.git` is never nested. Each skipped
    path is a non-fatal warning: `nested_repositories_skipped` in the `workspace_assessment` run event and in the
    terminal run payload (no schema change). **Consequence, stated plainly:** files inside a nested repository are not
    captured in checkpoints, diffs or commits, so change detection is weaker there; a gitlink entry the run itself had
    staged is still committed as a pointer. Recorded in [ADR-0022](adr/0022-nested-repositories-excluded-from-controller-git.md);
    implemented by T3.20; residual risk R-35 (mitigated).

<!-- markdownlint-disable-next-line MD029 -->
28. Answers to Q-18 and Q-19, and the fix for R-42: retention GC (2026-10-13). **Delegated decision (agent), under
    [owner decision 25](#42-owner-decisions); not an Ender quote and not owner-approved.** None of it affects bypass mode
    (retention touches only idle, terminal meta-sessions and refuses nothing a bypass run needs), so by decision 25 (a)
    it is the agent's, by best practice. (a) **Q-18:** the retention unit is a whole idle meta-session (no lease, only
    terminal runs, newest activity older than `retention.days`), never a single run, because collecting one run can
    break the checkpoint chain of the rest. (b) **Q-19:** `run_event` rows are kept: the table is append-only by trigger
    ([ADR-0005](adr/0005-sqlite-ledger.md)) and is the audit record, so NFR-DATA-01 is amended (dated note in the SRS):
    retention applies to worktrees, controller branches and artifact files, not events. (c) **R-42:** GC marks first.
    One `BEGIN IMMEDIATE` transaction re-checks idleness, sets the meta-session `ARCHIVED` and appends `gc_intent`;
    only then are worktrees, `switchboard/` branches and artifact files removed, and a second transaction sets
    `deleted_at` and appends `gc_outcome`. Admission refuses an `ARCHIVED` meta-session with `INVALID_REQUEST` (no new
    error code), both in validation and inside the admission transaction, and `continue_task` already refused a session
    that is not `ACTIVE`. An `ARCHIVED` session whose collection is unfinished is a GC candidate again and rolls
    forward. Wording in FR-SES-06 gains a dated note; no ID changes and no schema or migration change.
<!-- markdownlint-disable-next-line MD029 -->
29. Answer to Q-14: the adapter preflight cache (2026-10-13). **Delegated decision (agent), under [owner
    decision 25](#42-owner-decisions); not an Ender quote and not owner-approved.** It has no bypass effect (it only
    avoids re-running status commands the controller already runs; no permission, approval or flag changes), so by
    decision 25 (a) it is the agent's, by best practice. NFR-PERF-02 becomes task **T3.21** in the M3 table (§6.5): an
    in-process `PreflightCache` (`src/adapters/preflight-cache.ts`) wraps `probe` and `authPreflight` in `delegate_task`
    stage-1 eligibility, dispatch PREFLIGHT and `list_capabilities`. It caches **successes only** (every probe step ok;
    auth `OK`); a failed or throwing probe, `AUTH_REQUIRED` and `UNKNOWN` are never cached, so an install or a login is
    seen on the next call (fail closed, NFR-SEC-06). An entry is keyed by adapter id and invalidated when the resolved
    binary's path, `mtime`, size or inode changes, or after the TTL (**Assumption**: 60 s, config
    `timeouts.preflight_ttl_seconds`, integer 0 to 3600, 0 disables; the pre-existing `timeouts.*` row in
    [TDD §3.1](design/TDD.md#31-configuration) named a "preflight TTL" but no key existed). Only the status results the
    adapters already return are stored; no credential or token passes through. `doctor` and `adapters validate` stay
    uncached (they are explicit checks). *Numbering:* this entry uses 29, leaving 28 to a parallel change. No ADR: the
    cache realizes [ADR-0009](adr/0009-version-gated-adapters.md) and [SDD](design/SDD.md) NFR-PERF-02 (preflight cache
    keyed on binary version plus TTL) and changes no component boundary or persistence; the config key is recorded in
    TDD §3.1 and LLD §11.1. *Unverified:* real provider CLI probe cost and whether an in-place upgrade always changes
    `mtime` or size (a same-size, same-`mtime` replacement is caught only by the TTL).
<!-- markdownlint-disable-next-line MD029 -->
30. Answer to Q-39: minimum Git version (2026-10-13). **Delegated decision (agent), under [owner
    decision 25](#42-owner-decisions); not an Ender quote and not owner-approved.** It has no bypass effect (no
    permission, approval or flag rule changes; it only refuses a Git too old for the controller's own isolation
    variables), so by decision 25 (a) it is the agent's, by best practice. `MIN_GIT_VERSION` in `src/workspace/git.ts`
    goes from 2.30 to **2.32**, because `scrubbedGitEnv()` already relies on `GIT_CONFIG_GLOBAL` (Git 2.32.0 release notes).
    It changes the technology stack's stated floor, so it is recorded in
    [ADR-0023](adr/0023-minimum-git-version-2-32.md). `doctor`, the workspace manager's Git check, the README and TDD §2
    state 2.32; no requirement ID changes and no SRS requirement names a version. Residual risk R-44 is mitigated.
    *Unverified:* the 2.32 introduction version rests on the release notes, not on a test against an old Git.

Decisions 10 to 13, 17, 19, 21 and 22 each choose the less restrictive of the options put to Ender (decision 18 is the
principle behind the 2026-10-13 ones); decisions 20 and 23 keep the stricter behaviour already implemented. Their residual
risks are recorded for Ender as R-23 to R-26, R-34, R-38 and R-39 in §7.1 (not blocking); decision 24's as R-38 and
R-40; decision 26's as R-41; decision 27's as R-35 (mitigated); decision 28's as R-42 (mitigated);
decision 29 has none beyond the stale-for-TTL window noted in it; decision 30 closes R-44.

### 4.3 Stated intent (confirmed constraints)

From the [original blueprint's
introduction](research/headless-ai-coding-controller.md#introduction-to-the-cli-native-orchestration-paradigm):

- C-1 Wrap the seven provider CLIs through their headless or documented automation modes, not raw model APIs.
- C-2 No web interface, except restricted dashboards purely for usage monitoring and telemetry.
- C-3 Never interact with OAuth or subscription login flows; rely on credentials cached by the native CLIs.
- C-4 Own model definitions and route by task complexity.
- C-5 Tier-aware load balancing across subscriptions.
- C-6 Persistent cross-provider meta-sessions.
- C-7 Expose capabilities to a primary orchestrator (for example OpenClaw or Grok Bot) as an MCP or ACP server.

### 4.4 Material delegated decisions

| Decision | Record |
| --- | --- |
| The verified research supersedes the original blueprint wherever they conflict (see §4.6). | This roadmap; banner on the original research doc |
| Controller-owned canonical state; no transcript parsing | [ADR-0001](adr/0001-controller-owned-canonical-state.md) |
| MCP upstream (async-first tools); ACP as downstream transport; upstream ACP deferred | [ADR-0002](adr/0002-mcp-upstream-acp-downstream.md) |
| No credential handling; compliance manifests; no "ToS compliant" claims | [ADR-0003](adr/0003-no-credential-handling.md) |
| Five trust profiles; no automatic bypass flags | [ADR-0004](adr/0004-trust-profiles-no-bypass-flags.md) |
| SQLite ledger | [ADR-0005](adr/0005-sqlite-ledger.md) |
| Worktree per write-capable run; no blind replay | [ADR-0006](adr/0006-worktree-checkpoints-no-blind-replay.md) |
| Capacity as confidence estimate; bounded priority queue | [ADR-0007](adr/0007-capacity-as-confidence-estimate.md) |
| Two-stage routing; learned routing deferred | [ADR-0008](adr/0008-two-stage-routing.md) |
| Version-gated adapters | [ADR-0009](adr/0009-version-gated-adapters.md) |
| TypeScript on Node.js | [ADR-0010](adr/0010-typescript-node-stack.md) |
| Single-operator, local, Linux-first | [ADR-0011](adr/0011-single-operator-local-deployment.md) |
| Telemetry at the wrapper boundary | [ADR-0012](adr/0012-telemetry-at-wrapper-boundary.md) |
| Projects (environment plus contexts) defined in configuration; `host` environments first, `container` with a Proposed rootless runtime (Q-6, delegated); an orchestrator can create projects only within its client's limits and with operator approval for containers and push | [ADR-0013](adr/0013-projects-environments-and-contexts.md) |
| Agents never commit or push; injected `commit` and `push` tools do, push off by default; published commits sanitised and separate from internal checkpoints; provenance kept in the ledger | [ADR-0014](adr/0014-tool-only-commits-and-publication.md) |
| Operator CLI commands run as short-lived processes that write only operator records; one `serve` daemon per data directory performs all side effects | [ADR-0005](adr/0005-sqlite-ledger.md), [SDD §6](design/SDD.md#6-design-questions-settled-during-reconciliation) |
| `adapters validate` moved from M8 to M4 so new CLI versions can be accepted as soon as most adapters exist | This roadmap, FR-OPS-02 |
| `privileged_scope` is machine-readable (2026-10-13; Ender left Q-28 to the agent: "pick the best choice"). Each dimension is a closed enum, with an argv-exact command list or host list where the mode is `allowlist`; adapters compile the privileged profile from it and return `Ineligible` with a reason for any dimension they cannot express. Rationale: a free-text scope cannot be compiled by adapters, cannot be validated or compared, and makes the scope hash cover words rather than behaviour | [LLD §3.1](design/LLD.md#31-privileged-scope-m3), [ADR-0017](adr/0017-approved-privileged-scope-bypass.md) (amended before merge) |
| Delivery order: a thin MCP vertical slice with one adapter (M2) comes *before* adapter expansion, unlike the research's stage order where the MCP protocol came seventh. Rationale: the orchestrator can use and test the controller early; routing and capacity still come after execution semantics are trustworthy, which is the research's actual concern. | This roadmap |

### 4.5 Assumptions

| ID | Assumption | Impact if wrong |
| --- | --- | --- |
| A-1 | *Resolved by owner decision 4.* Each installation serves one operator using that operator's own logins; open-source users run their own installations. Hosted or shared multi-user operation remains out of scope. | A hosted service would change compliance scope, auth model and deployment (ADR-0011, ADR-0003). |
| A-2 | Linux is the first host; macOS follows in M4 because open-source users are likely to run it. | If most users turn out to be on macOS, move NFR-PORT-02 earlier. |
| A-3 | *Resolved by owner decision 5:* Claude Code and Codex are the M2 adapters. | — |
| A-4 | The first orchestrator is any stdio MCP client; acceptance tests use a scripted MCP test client rather than a specific product. | A specific orchestrator may need HTTP transport or different tool shapes. |
| A-5 | *Resolved by owner decision 5:* all seven subscriptions are held and all seven adapters are Must. | — |

### 4.6 Conflicts between sources and how they were resolved

Resolution rule: the verified research is a direct, dated review of the original blueprint against provider
documentation, so its technical findings win. Where the original carries Ender's *stated intent* (§4.3), the intent is
kept and only the mechanism changes.

| Topic | Original blueprint | Verified research | Resolution |
| --- | --- | --- | --- |
| Permission flags | `--allowedTools "*"`, `--dangerously-skip-permissions`, `--yolo`, `--trust --approve-mcps --force` | `"*"` is skipped; bypass flags grant too much; trust, MCP approval, command approval and sandbox are separate | Trust profiles, no automatic bypass ([ADR-0004](adr/0004-trust-profiles-no-bypass-flags.md)) |
| Codex interface | `codex -p`, custom JSON wrapper | `codex exec --json` emits JSONL natively | Use native JSONL (TDD §4) |
| Kimi Code | `kimi run`, K2.7, 256K context | Legacy CLI archived 2026-09-23; new contract unknown | Adapter blocked until pinned (FR-ADP-09) |
| Context windows | Hard-coded per CLI | Model properties, change over time | Model registry (FR-ADP-05) |
| Cross-provider state | Parse provider transcripts, summarize trajectories | Controller-owned state; Git is canonical | [ADR-0001](adr/0001-controller-owned-canonical-state.md); intent C-6 kept |
| Quota / NCU | NCU as precise share of remaining quota | Only confidence-weighted estimates are defensible | [ADR-0007](adr/0007-capacity-as-confidence-estimate.md); intent C-5 kept |
| Rate limiting | Leaky bucket ingress, token bucket egress, blind retry | Priority queue, semaphores, breakers; no replay after mutation | [ADR-0006](adr/0006-worktree-checkpoints-no-blind-replay.md), [ADR-0007](adr/0007-capacity-as-confidence-estimate.md) |
| Routing | Brand-to-tier table, IRT | Eligibility then empirical scoring | [ADR-0008](adr/0008-two-stage-routing.md); intent C-4 kept |
| Telemetry | Inject global Claude hooks | Observe at wrapper boundary | [ADR-0012](adr/0012-telemetry-at-wrapper-boundary.md) |
| MCP vs ACP | "MCP or ACP server" | MCP upstream, ACP downstream | [ADR-0002](adr/0002-mcp-upstream-acp-downstream.md); intent C-7 met via MCP |
| Compliance claim | "Absolute ToS compliance" | Documented automation is not a blanket contractual grant | NFR-COMP-01 |
| OpenClaw "Lane Queue" | Relied on for write serialization | Could not be verified | Controller enforces its own leases (FR-WS-02) |
| "Frees 96% of context" | Claimed | Not defensible | Dropped |

## 5. Documentation map

| Path | Purpose | Status | Authoritative for |
| --- | --- | --- | --- |
| [AGENTS.md](../AGENTS.md) | Agent instructions | Current | How agents work in this repo |
| [docs/ROADMAP.md](ROADMAP.md) | This document | Canonical | Scope, priorities, sequencing, status |
| [docs/requirements/BRD.md](requirements/BRD.md) | Business requirements | Draft baseline | Problem, outcomes `BO-*`, stakeholders, success measures |
| [docs/requirements/PRD.md](requirements/PRD.md) | Product requirements | Draft baseline | Users, journeys `UJ-*`, capabilities `CAP-*`, non-goals, product acceptance |
| [docs/requirements/FRD.md](requirements/FRD.md) | Functional behaviour | Draft baseline | Workflows `WF-*`, business rules `BR-*`, run state machine, permissions, validation |
| [docs/requirements/SRS.md](requirements/SRS.md) | Software requirements | Draft baseline | Every requirement ID (`FR-*`, `NFR-*`) and its verification method |
| [docs/design/HLD.md](design/HLD.md) | High-level design | Draft baseline | Boundaries, components `COMP-*`, trust boundaries, deployment, data flows, threats |
| [docs/design/SDD.md](design/SDD.md) | Software design | Draft baseline | Component collaboration, shared patterns, requirement→design traceability |
| [docs/design/TDD.md](design/TDD.md) | Technical design | Draft baseline | Technology choices, cross-cutting concerns, per-provider adapter strategy, test strategy |
| [docs/design/LLD.md](design/LLD.md) | Low-level design | Draft baseline (M1–M2 detail) | Schemas, interfaces, tool contracts, failure taxonomy, algorithms |
| [docs/adr/](adr/README.md) | Decision records | 17 accepted (13 and 14 record Ender's 2026-10-12 decisions and 16 his 2026-10-13 decision, mechanisms delegated; 15 is delegated; 17 is Delegated wording recording owner decisions 13 and 17) | Why each architectural decision was made |
| [docs/research/headless-ai-coding-controller-verified-2026-10-12.md](research/headless-ai-coding-controller-verified-2026-10-12.md) | Verified research | Current reference | Evidence for provider behaviour as of 2026-10-12 |
| [docs/research/headless-ai-coding-controller.md](research/headless-ai-coding-controller.md) | Original blueprint | **Superseded** where it conflicts (§4.6); retained for stated intent | Stated intent C-1 to C-7 only |
| `scripts/check-docs.mjs` | Documentation link and ID checker | Current | Mechanical consistency of this set |

## 6. Milestones

Status values: `Done`, `In progress`, `Partial`, `Planned`, `Blocked`, `Deferred`. No milestone has dates; none were
set. Sizes are not estimated. M9 and M10 were added on 2026-10-12 for owner decisions 6 and 7 (projects; tool-only
commits); M11 on 2026-10-13 for owner decision 14 (inner agent).

| ID | Milestone | Status | Depends on | Requirements delivered (first delivery) | Acceptance criteria | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| M0 | Documentation baseline | In progress (this change); Done on merge | — | NFR-MAINT-02, NFR-COMP-01 | Document set in §5 exists; `node scripts/check-docs.mjs` passes; AGENTS.md points here | Docs check script; review |
| M1 | Foundation | **Done** (2026-10-12): every acceptance criterion has a passing test (166 tests locally); first CI run unconfirmed; requirement gaps marked `Partial` in §6.1 | M0 | FR-ADP-01, FR-AUTH-01, FR-POL-10, FR-WS-01–06, FR-SES-01, 02 (schema), 05 (events), FR-CAP-04 (queue, global limit), FR-EXE-01, 02, 05–07, FR-SES-06, FR-TEL-01, 03, FR-OPS-01 (`doctor`, `runs`), 03, 04, NFR-SEC-01, 02, 04–06, NFR-REL-01–02, NFR-PERF-03 (global), NFR-PORT-01, NFR-PRIV-01 | A fake provider CLI runs through the full lifecycle transactionally; cancel kills the process tree; `SIGKILL` of the controller mid-run followed by restart leaves a consistent ledger; a failed run that mutated files is rolled back, not replayed; CI green on Linux | Automated integration and fault-injection tests in CI; evidence in §6.1 |
| M2 | Claude Code and Codex adapters + MCP vertical slice | **Partial** (2026-10-12): T2.1 to T2.8 implemented with tests on fakes and synthetic fixtures (453 tests locally); not `Done`, see "Blocks Done" in §6.2. FR-GIT-01 (added on main, PR #11) is shown by argv and policy inspection: Claude Code compiles documented deny rules, Codex declares that none is documented; live behaviour is unverified (§6.2 item 4) | M1 | FR-MCP-01, 03–09, FR-ADP-02–04, 06, 11 (Claude Code, Codex), FR-POL-01 (two profiles), 02–05, 07, 08, FR-AUTH-02, FR-GIT-01 (Claude Code, Codex), FR-SES-03 (Claude Code, Codex), FR-RTE-01 (eligibility), FR-CAP-01 (record), FR-OPS-01 (`serve`), NFR-PERF-01, 02, NFR-OBS-01, NFR-PRIV-02, NFR-MAINT-03 | For each of Claude Code and Codex, a scripted MCP client delegates an edit task under `edit-untrusted`, polls to `SUCCEEDED`, retrieves a diff artifact and continues the same native session; a new user following the README reaches a passing `doctor`; missing login yields `AUTH_REQUIRED`; unknown CLI version yields `ADAPTER_VERSION_UNVERIFIED`; no bypass flag appears in any compiled invocation; no compiled invocation leaves a Git write operation (commit, ref change, push) permitted (FR-GIT-01) | Conformance suite on recorded fixtures in CI; one opt-in live smoke test run by the operator; argv inspection test |
| M3 | Isolation | Planned; tasks in §6.5 (planning done 2026-10-12). Can reach only `Partial` without live provider runs (§6.5.2) | M2 | FR-POL-01 (all), 06, 09, FR-WS-07, FR-EXE-08, FR-OPS-02 (`approve`, `deny`), NFR-SEC-03 (Claude Code, Codex), NFR-DATA-01 | Malicious-fixture suite shows no escape for each profile on Claude Code and Codex; `privileged` runs wait for `approve` and end `CANCELLED` on `deny`; verification commands run and are recorded; retention deletes artifacts, worktrees and branches together | Malicious-fixture suite; integration tests |
| M4 | Adapter expansion | Planned (Kimi Code part blocked by B-1; Muse Code is Should) | M3, M9 (Proposed) | FR-ADP-05, 07, 08, 09, 10, 11 (others), 12, FR-EXE-03, FR-OPS-02 (`adapters validate`), NFR-SEC-03 (others), NFR-MAINT-01, NFR-PORT-02 | Grok Build, Antigravity, Cursor and OpenCode adapters pass conformance and malicious-fixture suites; the test suite passes on macOS; Kimi Code passes once B-1 clears (M4 may be marked `Partial` until then, with only Kimi outstanding); ACP transport used where it is the adapter's chosen surface; adding an adapter touched only its own module, manifest, fixtures and registry entry; `adapters validate` accepts a new CLI version only after its live checks pass | Conformance and fixture suites per adapter; diff inspection |
| M5 | Continuity | Planned | M4 | FR-SES-02 (populated), 03 (all), 04, 05 (handoff view) | Provider A edits and tests; provider B continues from the handoff bundle and completes the task; no provider transcript file is opened (verified by file-access test) | End-to-end test with two fake adapters plus one opt-in live pair |
| M6 | Capacity and resilience | Planned | M5 | FR-MCP-02 (`get_capacity`), 10, FR-CAP-01 (use), 02–07, FR-OPS-05, NFR-PERF-03 (per provider) | Injected rate-limit, overload, quota and crash failures produce the behaviour in FRD WF-5, with successor runs linked to their predecessors; `get_capacity` and `switchboard capacity` never return `explicit_remaining` unless the provider reported it | Fault-injection tests with fake adapters |
| M7 | Routing | Planned | M6 | FR-MCP-02 (`explain_route`), FR-RTE-01 (full), 02–04 | Given stored features and weights, re-running the scorer reproduces every stored decision; `explain_route` lists the deciding factors | Deterministic replay test |
| M8 | Hardening | Planned | M7 | FR-TEL-02 | OTel traces reach a test collector with no forbidden attributes; a scheduled version canary on the operator's machine flags CLI updates before they reach routing | Collector test; version-bump test |
| M9 | Projects and controlled commits | Planned. Numbered after M8 to keep existing milestone IDs stable; **sequenced after M3 and before M4** (Proposed) so new adapters declare their Git controls once | M3 | FR-PRJ-01–04, 06, 08, 10, FR-GIT-01 (fixtures), 02–10, FR-WS-05 (publication) | A scripted MCP client lists projects and delegates to one (`host` environment, one repository context) and the lower of client and project ceilings applies; the agent's `commit` tool call produces a commit on the publish ref with the configured identity and no trailer, footer or identifier even when the message contains them; an agent attempt to commit, move a ref or push (shell or provider built-in) leaves nothing on the publish ref and appears as `git_policy_violation`; with push `none` nothing leaves the host, with `branch` against a local bare remote only the publish ref arrives and never checkpoint commits or run branches; every published commit has a `git_commit` row naming run, provider and model; a client with `manage_projects` can create a `host` project within its limits and use it, a `container` or push-enabled revision stays unusable until `projects approve`, and a client without the flag has no project-management tools; with `sign: true` the published commit verifies against the operator's key and a failed signature creates no commit; adapters that cannot take the channel without a bypass flag run in finalize-only mode only on opt-in | Fake-adapter integration tests with real Git repos and a local bare remote; sanitiser fixtures; malicious-fixture additions for Claude Code and Codex; argv inspection |
| M10 | Container environments | Planned; B-2 resolved by delegation (Proposed), starts with a spike. Route to Ender's bypass goal (owner decision 24, §6.4); order after M9 kept (Q-38, owner decision 25) | M9 | FR-PRJ-05, 07, 09, FR-GIT-01 (container environments, by construction) | A `container` project mounts only the run worktree and declared read-only contexts, applies its limits and network policy, and is removed at run end and after a controller crash; no home directory, data directory, push credential or runtime socket is mounted; the container leg of the malicious-fixture suite shows no escape | Opt-in container integration tests (skipped in CI until a runtime is chosen); fault injection; inspection of mounts |
| M11 | Inner agent | Planned (Proposed). Owner decision 14; numbered after M10 to keep milestone IDs stable; **sequenced after M9** (Proposed). Tasks that use another milestone's output wait for it (§6.6) | M2 (configuration, ledger); M9 for commit and PR tasks; M3, M4, M5, M7 for the tasks that use them | FR-INN-01–17 | With no inner agent configured nothing changes and the suite passes; with a fake backend, enabled tasks are used and invalid, empty, slow or unreachable output falls back without failing or delaying a run beyond the bound; a commit with no agent message gets a sanitised drafted message with no trailer, footer or identifier even when the backend returns them; inner usage never appears in provider usage or capacity unless a shared subscription is declared; a `remote` backend needs `allow_remote` and diffs need the per-task opt-in, and a planted secret never reaches a captured prompt; no inner output reaches any policy component; `doctor` and `inner status` report state | Fake-backend integration and fault-injection tests; hostile-backend sanitiser fixtures; import-boundary test; secret-in-prompt test; inspection of the privacy gates; one opt-in live run against an operator-chosen backend |

### 6.1 M1 Foundation: tasks

Each task lists objective, references, dependencies and completion checks. Tasks are in dependency order; T1.3 to T1.6
can run in parallel after T1.2.

Task status: **T1.1 to T1.11 Done** (2026-10-12). Evidence is local: `npm test` passes (13 files, 166 tests),
alongside typecheck, lint and `node scripts/check-docs.mjs`. Caveats: the first CI run is unconfirmed, and GitHub
Actions are not yet pinned by SHA (`setup-node` uses a tag).

- **T1.1:** `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`,
  `.github/workflows/ci.yml`; versions recorded in [TDD §2](design/TDD.md#2-technology-choices).
- **T1.2:** `src/config/` and `src/lock/`; `src/config/config.test.ts` (precise rejection messages, symlink
  canonicalization), `src/lock/lock.test.ts` (second acquisition fails clearly, stale lock recovered).
- **T1.3:** `src/ledger/`, `src/ids/`; `src/ledger/ledger.test.ts` (migration from empty DB, WAL, append-only
  triggers on `run_event`), `src/ids/ids.test.ts`.
- **T1.4:** `src/artifacts/`; `src/artifacts/artifacts.test.ts` (SHA-256 addressing, redaction before write).
- **T1.5:** `src/workspace/`; `src/workspace/workspace.test.ts` (second lease refused, operator tree untouched, mutated
  failure rolled back, non-Git refused for write profiles).
- **T1.6:** `src/exec/`; `src/exec/supervisor.test.ts` (child and grandchild killed on cancel, env allowlist, oversize
  and malformed lines give `OUTPUT_PROTOCOL_ERROR`), `src/exec/jsonl.test.ts`.
- **T1.7:** `src/adapters/`; `src/adapters/adapters.test.ts` (fake adapter scenarios, conformance harness, no bypass
  flags in compiled argv).
- **T1.8:** `src/lifecycle/`; `src/lifecycle/lifecycle.test.ts` (state-machine table, admission, queue bound,
  priority, concurrency, one active run per meta-session, per-edge outcomes, cancel in each state).
- **T1.9:** `src/reconcile/`; `src/reconcile/reconcile.test.ts` (real `SIGKILL` of a controller child during RUNNING,
  restart ends `FAILED/PROCESS_CRASH`, orphan killed, PID-reuse guard, per-state WF-8 outcomes).
- **T1.10:** `src/cli/`; `src/cli/cli.test.ts` (no login command, `doctor`, `runs list|show|cancel` with `--json`,
  cancel with and without a lock holder, daemon-side application).
- **T1.11:** this reconciliation; design-doc changes are listed in the change description and carried in the documents
  named in §6.1.1.

#### 6.1.1 M1 requirements not fully evidenced

These requirements are in the M1 row of §6, but the evidence above does not fully cover them. They stay `Partial`
until the gap closes; none blocks M2 work.

| Requirement | Status | Gap |
| --- | --- | --- |
| FR-OPS-01 | Partial | `doctor`, `runs list`, `runs show`, `runs cancel` are tested; `serve` is M2 (T2.6) |
| NFR-PORT-01 | Partial | CI targets `ubuntu-24.04` (x86-64) only, the first CI run is unconfirmed, and arm64 is untested (TDD §2 says an arm64 runner is to be confirmed) |
| NFR-SEC-01 | Partial | Secret redaction is tested for artifacts only; no secret-pattern scan covers the ledger, CLI output or logs |
| FR-TEL-03 | Partial | Same gap as NFR-SEC-01; no test asserts that `run_event` payloads and CLI output omit prompts and environment values |
| NFR-SEC-04 | Partial | Inspection-only requirement; no check or recorded review that the controller runs unprivileged |
| NFR-PRIV-01 | Partial | Inspection-only requirement; no recorded review (no network code exists, but nothing asserts it) |
| NFR-SEC-06 | Partial | Fail-closed cases are tested (unreadable worktree, unreadable pending outcome, bypass flag, unknown schema version); "ledger cannot be opened, refuse to serve" waits for `serve` |

All other requirements in the M1 row have at least one passing test named in the task notes above.

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T1.1 | Scaffold the TypeScript project, lint/format, test runner and a GitHub Actions workflow running typecheck, lint, tests and `node scripts/check-docs.mjs` on Linux | [TDD §2](design/TDD.md#2-technology-choices), ADR-0010, NFR-PORT-01 | — | CI passes on an empty test; `npm test` works locally; versions pinned and recorded in TDD §2 |
| T1.2 | Config file with schema validation: data directory, allowed workspace roots, concurrency, provider enablement and weights, named MCP client entries with max trust profile; data-directory lock so only one `serve` runs | FR-OPS-04, FR-POL-10, NFR-SEC-05, NFR-PERF-03, [TDD §3.1](design/TDD.md#31-configuration), [ADR-0005](adr/0005-sqlite-ledger.md) | T1.1 | Invalid config is rejected with a precise message; paths are canonicalized (symlink test); a second `serve` on the same data directory fails clearly |
| T1.3 | SQLite ledger with forward-only migrations and the M1 tables; append-only `run_event` | [LLD §1](design/LLD.md#1-data-model), ADR-0005, FR-SES-01, 02, 05, FR-TEL-01 | T1.2 | Migration test from empty DB; append-only enforced (update/delete on `run_event` fails); WAL enabled |
| T1.4 | Content-addressed artifact store with redaction hook | FR-EXE-05, FR-TEL-03, NFR-SEC-01 | T1.2 | Artifacts addressed by SHA-256; secret-pattern fixture is redacted before write |
| T1.5 | Workspace manager: base checkpoint, worktree on controller branch, write lease, post-run checkpoint, diff artifact, mutation detection, rollback | [LLD §5](design/LLD.md#5-workspace-and-lease-algorithm), ADR-0006, FR-WS-01–06 | T1.3 | Tests: second lease on same worktree refused; operator branch and working tree untouched; mutated failure rolls back to checkpoint; non-Git workspace refused for write profiles |
| T1.6 | Execution supervisor: spawn in process group, env allowlist, timeout, cancel (graceful then forced), separate stdout/stderr capture, line-framed JSONL reader | [LLD §8](design/LLD.md), FR-EXE-01, 02, 05, 07, NFR-REL-02 | T1.2 | Tests: child and grandchild both killed on cancel; env outside allowlist absent in child; oversize or malformed line yields `OUTPUT_PROTOCOL_ERROR` without crashing |
| T1.7 | Adapter contract and a fake provider CLI with scripted behaviours (success, task failure, auth missing, rate limit, partial mutation then failure, malformed output, hang) | [LLD §2](design/LLD.md#2-adapter-contract), FR-ADP-01 | T1.6 | Fake adapter passes the conformance harness skeleton that M2 will reuse |
| T1.8 | Run lifecycle orchestration (internal API, no MCP yet): queue → preflight → lease → run → finalize, following the FRD state machine, with bounded priority queue, global concurrency and one active run per meta-session | [FRD §4](requirements/FRD.md#4-canonical-run-state-machine) WF-1, WF-4, WF-5, FR-CAP-04, FR-SES-06, [LLD §10](design/LLD.md#10-idempotency-and-ordering) | T1.3–T1.7 | Every FRD transition reachable in M1 has a test; illegal transitions rejected; a second active run on one meta-session is refused |
| T1.9 | Startup reconciliation | FR-EXE-06, NFR-REL-01, FRD WF-8 | T1.8 | Fault-injection test: `SIGKILL` controller during RUNNING, restart, run ends `FAILED/PROCESS_CRASH` with workspace assessed |
| T1.10 | Operator CLI: `doctor` (fake adapter), `runs list`, `runs show`, `runs cancel`, each with `--json`; cancel is written as an operator record the daemon applies | FR-OPS-01, FR-OPS-03, [SDD §3](design/SDD.md#3-interface-responsibilities-and-error-propagation) | T1.8 | CLI tests on output; cancel works with and without a running daemon; no login command exists |
| T1.11 | Update this roadmap's status and any design docs changed during M1 | NFR-MAINT-02 | all | §6 shows M1 `Done` with links to the tests |

### 6.2 M2 Claude Code adapter and MCP slice: tasks

Status (2026-10-12), per task. Evidence is local (`npm test`: 23 files, 453 tests, plus build, typecheck, lint and
`node scripts/check-docs.mjs`); the first CI run on this branch is unconfirmed. Every provider-facing result below is on
fakes or **synthetic** fixtures; nothing has run against a real Claude Code or Codex binary.

| Task | Status | Evidence | Caveat |
| --- | --- | --- | --- |
| T2.1 | Done on fixtures | `src/adapters/manifest/manifest.test.ts` ("shipped manifests", "version gate", "AdapterRegistry.gate": unknown version yields `ADAPTER_VERSION_UNVERIFIED`); manifests in `src/adapters/manifests/` | The Codex range is intentionally empty (`<0.0.0`), so Codex fails the gate (Q-12) |
| T2.2 | Partial: done on synthetic fixtures, including the FR-GIT-01 argv check | `src/adapters/claude/claude.test.ts` ("claude compile: argv policy", "claude compile: no permitted Git write operation (FR-GIT-01)", "claude conformance on recorded (synthetic) fixtures", probe and auth); `src/adapters/codex/codex.test.ts` ("Codex conformance suite", "compile: argv and policy", "Git write operations (FR-GIT-01)", "probe (FR-ADP-02 steps 1-5)"); `src/adapters/git-write.test.ts`; `list_capabilities` `git_write_control` in `src/mcp/mcp.test.ts`; manifest notes in `src/adapters/manifests/`; [ADR-0015](adr/0015-claude-untrusted-isolation-flags.md) | Event shapes and flags unverified (R-21, R-22, Q-10, Q-13); probe skips the FR-ADP-02 smoke step. FR-GIT-01: the Claude deny-rule form is from the `claude --help` 2.1.296 example only and its matching semantics are Assumptions; Codex has no documented control and its sandbox's effect on the Git directory is an Assumption (Blocks Done item 4) |
| T2.3 | Done | `src/routing/routing.test.ts` ("eligibility filter (T2.3, FR-RTE-01, FR-MCP-05)": disabled, ceiling, binary missing, version, no manifest, auth, capability, shell allowlist, platform, `require_provider`) | Hard constraints available in M2 only |
| T2.4 | Done against the fake adapter and replay fixtures | `src/mcp/mcp.test.ts` ("tool surface", "vertical slice against the fake adapter", "Claude and Codex adapters on recorded replay fixtures", "validation", "per-client trust ceiling", "idempotency", "cancel_run", "dispatch-time gate") | Claude runs use replay fixtures (synthetic); Codex end to end only with test doubles for version and auth |
| T2.5 | Done | `src/usage/usage.test.ts` ("usageObservationsFromEvents", "usage_observation ledger helpers": `provider_reported` label, append-only, no estimates); `src/mcp/mcp.test.ts` ("usage in get_run (T2.5)") | Codex usage event shape is an Assumption |
| T2.6 | Done on fakes; live run not performed | `src/cli/serve.test.ts` (stdio framing, end to end, lock, SIGKILL reconcile, operator cancel, SIGTERM, refuses to start); `test/live-smoke.test.ts` and `scripts/live-smoke.mjs` (`npm run test:live`, skipped unless `SWITCHBOARD_LIVE_TESTS=1`) | The operator has not run the live test (see "Blocks Done") |
| T2.7 | Done, on the fake adapter | `scripts/bench-perf.mjs` (`npm run bench`); results and findings in [TDD §3.6.1](design/TDD.md#361-controller-overhead-benchmark-t27) | Target confirmed for controller-owned work only, on a sandbox host (see §6.2.1) |
| T2.8 | Partial | `README.md` (install, native login, config, profiles, `doctor`, serve, live smoke, troubleshooting); `doctor` behaviour in `src/cli/cli.test.ts` | "A fresh machine reaches a passing `doctor`" is verified only for the no-provider case (see "Blocks Done") |
| Policy (cross-task) | Done | `src/policy/policy.test.ts` ("resolveProfile (COMP-POL, M2)": two profiles, frozen snapshots, no `privileged`, fail closed, no bypass flag on Claude or Codex) | FR-POL-01 (all profiles) is M3 |

**Blocks Done.** M2 stays `Partial` against its acceptance criteria because:

1. The opt-in live smoke test (`npm run test:live`) has not been run by the operator against real Claude Code or Codex.
   Event shapes, error categories, flag spellings and auth behaviour are therefore unconfirmed (R-21, R-22, Q-10, Q-13),
   and the criteria "polls to `SUCCEEDED`, retrieves a diff artifact and continues the same native session" and
   "missing login yields `AUTH_REQUIRED`" are shown on fakes and synthetic fixtures only.
2. The Codex manifest range is empty, so Codex cannot pass the version gate or `doctor` until an operator records a real
   `codex --version` (Q-12). No command exists to record one: `adapters validate` is scheduled for M4 (FR-OPS-02).
3. "A new user following the README reaches a passing `doctor`" is verified only for the no-provider case (both
   providers `[warn]`, exit 0, which proves the environment and config only). A machine with a provider installed has
   not been checked, and an installed Codex fails `doctor` by design today.
4. FR-GIT-01 (Claude Code, Codex) and the M2 criterion "no compiled invocation leaves a Git write operation (commit,
   ref change, push) permitted" are shown by argv inspection only (T2.2 row). Claude Code: every invocation carries
   `--disallowedTools` Git write deny rules and `--restricted`, has no Bash tool without an allowlist, and an allowlist
   entry that could write Git is `Ineligible`; that the CLI accepts and enforces the rules as assumed is unverified.
   Codex: no control is documented, so the adapter declares `none-documented` and a non-empty allowlist is
   `Ineligible`; the remaining controls are FR-GIT-03 (M9, not yet built) and FR-GIT-06, and whether the
   `workspace-write` sandbox blocks the worktree's Git directory is an Assumption. The live smoke test now reports
   G-1 (no foreign ref or commit after a benign run), C-G2 and X-G1 (`NOT_CHECKED`: they need a deliberate Git write
   attempt, left to the T9.5 malicious fixtures). No provider flag disables commit attribution (R-19).

Criteria met on fakes or fixtures: "unknown CLI version yields `ADAPTER_VERSION_UNVERIFIED`" (manifest, routing, MCP and
`doctor` tests) and "no bypass flag appears in any compiled invocation" (argv tests in `claude.test.ts`, `codex.test.ts`,
`policy.test.ts`).

#### 6.2.1 M2 requirements that are Partial or unowned

| Requirement | Status | Gap and reason |
| --- | --- | --- |
| NFR-PERF-02 (Must, M2) | **Implemented by T3.21** (2026-10-13, Delegated, decision 29) | Preflight (`probe`, `authPreflight`) successes are cached by adapter id and binary identity with a configurable TTL (`timeouts.preflight_ttl_seconds`, default 60 s, Assumption) in `delegate_task`, at dispatch and in `list_capabilities`; failures are never cached. Evidence in the T3.21 row and [TDD §3.6.1](design/TDD.md#361-controller-overhead-benchmark-t27). Unverified against a live provider CLI |
| NFR-PERF-01 | Partial | The proposed 2 s p95 target is confirmed for controller-owned work on the fake adapter in a sandbox container only (about 0.34 s p95 uncached); real provider probe cost and a reference machine are unmeasured |
| NFR-SEC-04 | Partial | `serve` does not refuse to run as root and nothing records a review; still inspection-only, as in §6.1.1 |
| FR-ADP-02 | Partial | The probes cover binary, version, command, flags and (separately) auth; the harmless structured-output smoke test (step 7) is skipped by the probes |
| FR-ADP-03, FR-ADP-04, FR-ADP-06, FR-ADP-11 (Claude Code, Codex) | Partial | Tested on synthetic fixtures only; unconfirmed against live CLIs (R-21, R-22, Q-13) |
| FR-AUTH-02 | Partial | Claude parses `auth status --json` (assumed shape); Codex returns `UNKNOWN` because no status command is documented, so Codex is ineligible (Q-10) |
| FR-POL-02 (Codex) | Partial | Codex has no documented shell allowlist or model flag in the adapter's sources; it returns `Ineligible` for those requirements (Q-11, settled in M3). Until T2.2's FR-GIT-01 change a non-empty allowlist compiled and was silently not enforced; it is now `Ineligible` |
| FR-OPS-01 (`serve`) | Partial | `serve` is implemented and tested (`src/cli/serve.test.ts`, including refusing to start when the ledger cannot be opened) but has not been run against a live provider, and has no root check (NFR-SEC-04) |
| FR-GIT-01 (Claude Code, Codex) | Partial | Shown by argv and policy inspection (T2.2 row); live behaviour of the Claude deny rules and of the Codex sandbox on the Git directory unverified; Codex relies on FR-GIT-03 (M9) and FR-GIT-06 by declaration (Blocks Done item 4) |
| Compile-time `Ineligible` in the lifecycle | **Closed** (2026-10-13, T3.7, Delegated agent work) | *Was:* after preflight, `src/lifecycle/lifecycle.ts` ended a run on an adapter `Ineligible` from `compile` with `PERMISSION_BLOCKED`. *Now:* it ends FAILED (FRD T10) with the [FRD BR-3](requirements/FRD.md#3-business-rules) code of the adapter's reason (`ELIGIBILITY_NONE` for `PROFILE_UNSUPPORTED` and `CAPABILITY_MISSING`), with `reason`, `stage: "compile"` and `eligibility` in the transition event; preflight compiles the run's frozen policy snapshot. Evidence: `src/lifecycle/lifecycle.test.ts` ("T10: a profile the adapter cannot compile ends FAILED/ELIGIBILITY_NONE", "compile-time Ineligible with stage-1 eligibility (T3.7 …)") |

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T2.1 | Pin the Claude Code and Codex version ranges and record their compliance manifests | FR-POL-07, FR-ADP-03, [LLD §6](design/LLD.md#6-compliance-manifest) | M1 | Manifest file exists and is loaded; unknown version → `ADAPTER_VERSION_UNVERIFIED` test |
| T2.2 | Claude Code adapter, then Codex adapter: probe, auth preflight, compile for `inspect-untrusted` and `edit-untrusted`, parse structured output, resume | [TDD §4](design/TDD.md#4-provider-adapter-strategy), FR-ADP-02, 04, 06, FR-POL-02–05, 08, FR-AUTH-02, FR-SES-03 | T2.1 | Conformance suite passes on recorded fixtures; argv test proves no bypass flags, no global config writes and no permitted Git write operation (FR-GIT-01; the deny-rule syntax and any provider commit or attribution setting are not in the research and are verified against the installed CLI here, then recorded in the manifest notes) |
| T2.3 | Eligibility filter | FR-RTE-01, FR-MCP-05, ADR-0008 | T2.2 | Tests for each hard constraint available in M2 |
| T2.4 | MCP server on stdio with `delegate_task`, `continue_task` (same provider), `get_run`, `cancel_run`, `get_artifacts`, `list_capabilities`; schema validation; per-client max profile; idempotency key | [LLD §3](design/LLD.md#3-mcp-tool-contracts), FR-MCP-01, 03–09 | T2.3 | Scripted MCP client test passes end to end against the fake adapter and against Claude fixtures |
| T2.5 | Record provider-reported usage observations | FR-CAP-01 | T2.2 | Usage stored with source labels, separate from estimates |
| T2.6 | `switchboard serve`; opt-in live smoke test documented for the operator | FR-OPS-01 | T2.4 | Operator can run the live test with one command; it is skipped in CI |
| T2.8 | User documentation: README with install, native login for Claude Code and Codex, config, trust profiles and `doctor` troubleshooting | NFR-MAINT-03, NFR-COMP-01 | T2.6 | A fresh machine reaches a passing `doctor` following only the README |
| T2.7 | Measure NFR-PERF-01 and either confirm or revise the proposed target | NFR-PERF-01 | T2.4 | Benchmark result recorded in TDD |

### 6.3 M9 Projects and controlled commits: tasks

*Proposed breakdown, written when M9 was added; revisit when M3 completes.* Each task lists its references and its
completion check. Design: [LLD §11](design/LLD.md#11-projects-contexts-and-environments),
[LLD §12](design/LLD.md#12-injected-git-tools-commits-and-publication),
[TDD §3.10](design/TDD.md#310-git-commits-attribution-and-publication).

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T9.0 | Spike: settle the open mechanisms. Per-run Git configuration for agent processes; the Git plumbing for building a commit from a path subset; how Claude Code and Codex accept a per-run MCP definition; whether their sandboxes let the shim reach a Unix socket; deny-rule syntax for Git writes; any provider commit or attribution setting | TDD §3.10, FR-GIT-01, 02, R-18, R-19 | M3 | Findings (commands and flags verified against the installed CLIs, or the adapter marked `finalize-only` with evidence) are written into TDD §3.10, LLD §12 and the manifest notes; `MIN_GIT_VERSION` revisited |
| T9.1 | Project and context schema in the config loader, `projects list`, `projects show`, `projects validate` (`host`) | FR-PRJ-01, 02, 04, 08, [LLD §11.1](design/LLD.md#111-configuration-shape) | T9.0 | Unknown context kind and out-of-root path rejected; commands have `--json`; schema published |
| T9.2 | `project_id` migration, policy-snapshot fields, `delegate_task` `project` input, `list_projects`, lower-of-two ceiling, per-client project list | FR-PRJ-03, 06, FRD V12, BR-23 | T9.1 | Tests: both/neither of project and path rejected, ceiling arithmetic, client list enforced, run and meta-session carry the project |
| T9.3 | `git_commit` and `git_push` tables; publish ref; commit algorithm; sanitiser with built-in rules and operator patterns | FR-GIT-04, 07, 08, [LLD §12.3–12.4](design/LLD.md#123-commit-algorithm-and-refs) | T9.0 | Fixtures of typical attribution trailers, footers and session IDs leave none in the commit; checkpoint commits are not reachable from the publish ref; provenance row written in the same transaction |
| T9.4 | Shim subcommand, per-run socket and token, `COMP-GIT` service, `GitCapabilities` for the fake adapter, Claude Code and Codex | FR-GIT-01, 02, [LLD §12.2](design/LLD.md#122-channel) | T9.2, T9.3 | Fake adapter commits through the tool end to end; token and run-state checks refuse stale or foreign calls |
| T9.5 | Ref snapshots at LEASED and FINALIZING; violation handling; malicious fixtures for `git commit`, ref changes and push attempts | FR-GIT-01, 03, BR-27 | T9.4 | Every scripted attempt leaves the publish ref unchanged and appends `git_policy_violation`; legitimate tool commits are not flagged |
| T9.6 | Push policy, credential-reach rule, `push` tool and operator command; `runs show` provenance view | FR-GIT-05, 06, 07, BR-29, BR-31, FR-WS-05 | T9.4 | Against a local bare remote: policy `none` offers no tool; `branch` pushes only the publish ref; force, default branch, tags and run branches refused; host-with-shell withholds `push` |
| T9.7 | Finalize-only mode for adapters that cannot take the channel (Should) | FR-GIT-09, BR-30 | T9.3 | Opt-in commit at FINALIZING passes the same sanitiser and provenance tests |
| T9.8 | Update the README (projects, commit behaviour, push default), roadmap status and any document the work proved wrong | NFR-MAINT-02, NFR-MAINT-03 | T9.1–T9.7, T9.9, T9.10 | §6 shows M9 `Done` with links to the tests |
| T9.9 | `manage_projects` client flag, `project_revision` table, `create_project`, `update_project`, `delete_project`, creator-only visibility, `projects approve` | FR-PRJ-10, BR-32, [LLD §3](design/LLD.md#3-mcp-tool-contracts), [LLD §11.1](design/LLD.md#111-configuration-shape) | T9.2 | Tests: tools absent without the flag; configured projects and other clients' projects refused; path outside allowed roots, ceiling, provider and push widening beyond the client rejected; `container` and push revisions stay `PENDING_APPROVAL` until `projects approve`; delete with an active run refused; every call is an event |
| T9.10 | Optional commit signing: `sign` context option, controller-side signing with the operator's Git configuration, `projects validate` test signature | FR-GIT-10, BR-33, [LLD §12.3.1](design/LLD.md#1231-signing-fr-git-10-proposed) | T9.3, T9.6 | A signed commit verifies; failure returns `SIGNING_FAILED` and leaves the publish ref unchanged; the key and agent variables never reach the provider process (environment inspection); refused where BR-31 withholds `push` |

**T9.0 status (2026-10-13; Delegated): Partial.** Verified only against the installed tools: Git 2.43.0 in throwaway
repositories and the help text of `claude` 2.1.296 (no prompt run, no login, no credential touched, no bypass flag run).
No production code changed. Findings: [TDD §3.10](design/TDD.md#310-git-commits-attribution-and-publication) (dated
note), [LLD §12.2–12.3.1](design/LLD.md#12-injected-git-tools-commits-and-publication) (dated notes), the notes in
`src/adapters/manifests/claude.json` and `codex.json` (`npm test -- src/adapters/manifest`).

| Part of T9.0 | Status | Evidence and what remains |
| --- | --- | --- |
| Per-run Git configuration (layer 3) | Done for Git 2.43.0 | Exact commands and results in TDD §3.10: environment variant (`GIT_CONFIG_COUNT` with `core.hooksPath`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`) blocks commit, branch, tag, `update-ref` and push; it is a guard, not a boundary (`-c` and an unset variable defeat it). Minimum Git versions: `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` 2.32 (release notes); `GIT_CONFIG_COUNT` 2.31 inferred; hook introduction version unverified |
| Plumbing for a commit from a path subset | Done for Git 2.43.0 | LLD §12.3 note: temporary index, `add --`, `write-tree`, `commit-tree`, `update-ref` with compare-and-swap, checkpoint commits unreachable from the publish ref, worktree index unchanged. Untested cases listed there |
| `MIN_GIT_VERSION` revisited | Done (2026-10-13, Delegated decision 30) | Raised to 2.32 by [ADR-0023](adr/0023-minimum-git-version-2-32.md) (Q-39 decided, R-44 mitigated): `src/workspace/git.ts`, test `the version gate rejects Git 2.31 and accepts 2.32` in `src/workspace/workspace.test.ts`, README, TDD §2 and §3.10 |
| Deny-rule syntax for Git writes | Partial | Help documents only the `Bash(git *)` example; emitted-rule gaps listed in R-43 are closed in code (2026-10-13: every global option spelling and the missing subcommands are denied; `src/adapters/git-write.ts`, `src/adapters/claude/adapter.ts`, tests in `git-write.test.ts` and `claude.test.ts`); matching semantics (including whether Claude normalises global options) still need the live check C-G2 (T3.9) |
| Claude Code per-run MCP definition | Partial | Flags found in the help (`--mcp-config`, `--strict-mcp-config`); JSON shape, allow-rule form, permission behaviour and the `--safe-mode` interaction **unverified**; ADR-0015 bars the flag (Q-40, proposed ADR); R-18 |
| Sandbox reach to a Unix socket | `Unknown: live check` (both providers) | Help names no sandbox option for Claude; nothing in [R2] for Codex |
| Provider commit or attribution setting | Done for Claude Code help text | None beyond `--bare` (unusable, ADR-0015); the FR-GIT-04 sanitiser stays necessary (R-19) |
| Codex (all questions) | Not done: **Unverified** | `codex` is not installed and [R2] is silent; the adapter stays `none-documented`, finalize-only is the only evidenced design. Needs an installed binary |
| Signing (FR-GIT-10) | Partial | GnuPG with an unprotected throwaway key signs headlessly with `commit-tree -S` and a failure yields no commit (LLD §12.3.1 note); SSH, X.509, passphrase-protected and hardware keys unverified |
| Adapters marked `finalize-only` with evidence | Not done | No adapter has evidence either way; a Claude channel stays undeclared until the live checks answer R-18 |

Remaining before T9.0 can be marked Done: a live (opt-in) check of Claude's MCP behaviour and Git deny-rule matching, an
installed Codex, and the decision on Q-40 (Q-39 is decided, decision 30). T9.3 may start on the verified plumbing; T9.4
must not assume an injected channel for any provider.

### 6.4 M10 Container environments: tasks

*Proposed.* Q-6 was left to the agent, so the runtime and login mechanism are delegated and verified by T10.0 before any
other M10 task.

**M10 and the bypass goal (note, 2026-10-13; not a re-sequencing).** Owner decision 24 makes container environments the
route to Ender's stated main usability goal, bypass runs with no permission prompts and no Git risk: in a container the
image has no Git client and neither the Git directory nor any credential store is mounted, so an approved bypass run
there does not depend on provider Git deny rules holding under bypass (R-38). Host-run agents stay supported with the
existing controls. The current sequence is unchanged: M3, then M9 (projects, `host` environments, the injected `commit`
and `push` tools that container runs also need), then M10. Q-38 (bring M10 forward) was decided on 2026-10-13 (owner decision
25): the order stays, and the document-only spike T10.0 may start early.

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T10.0 | Spike: verify the Proposed rootless runtime and in-volume native login for each provider, and that each provider CLI works in an image with no Git client (owner decision 24; R-40); amend ADR-0013 or supersede it (the image rule is [ADR-0020](adr/0020-container-image-without-git-client.md)) | Q-6, FR-AUTH-01, FR-PRJ-05, [TDD §3.11](design/TDD.md#311-container-environments) | M9 | Findings recorded, ADR updated, R-13 and R-40 updated; a provider whose login cannot work in a container, or that cannot run without a Git client, is marked `host`-only |
| T10.1 | Environment port with a container implementation: mounts, limits, network policy, labels, teardown; refuse an image with a Git client | FR-PRJ-04, 05, [LLD §11.3](design/LLD.md#113-environment-port) | T10.0 | Opt-in tests show only the worktree and declared read-only contexts mounted and the container removed at run end; an image with `git` or `gh` on its `PATH` starts no run |
| T10.2 | Startup orphan sweep and `environment` run events | FR-PRJ-07, FR-EXE-06 | T10.1 | Fault injection: `SIGKILL` mid-run, restart, container gone before worktree assessment |
| T10.3 | Container leg of the malicious-fixture suite, including Git-write attempts under an approved bypass scope; `projects validate` checks, including the no-Git-client check; retention of containers and volumes | NFR-SEC-03, FR-PRJ-05, 08, 09, FR-GIT-01, 03 | T10.1 | Fixtures show no escape; a bypass run's Git-write attempts leave every ref unchanged; GC removes containers with worktrees |

### 6.5 M3 Isolation: tasks

*Planned, Delegated breakdown (2026-10-12), reconciled with owner decisions 10 to 13 (§4.2), and on 2026-10-13 with
owner decision 17 (durable meta-session approval) and the Delegated machine-readable `privileged_scope` (§4.4, Q-28).*
The documentation-only tasks T3.14, T3.15 and T3.16 are done; T3.8 is `Partial` (controller Git driver hardening
landed on `m3-wave-a`); no other code task has started.
Claims about the code below were checked against branch `m2-git-write-deny` (PR #12, unmerged), on which M3 builds for
its FR-GIT-01 work. Design: [SRS §3.3](requirements/SRS.md#33-policy-and-trust-profiles-fr-pol),
[FRD WF-7](requirements/FRD.md#wf-7-privileged-approval), [FRD §4.2](requirements/FRD.md#42-transition-table),
[TDD §3.4](design/TDD.md#34-security-engineering), [LLD §5](design/LLD.md#5-workspace-and-lease-algorithm).

Facts the breakdown relies on (verified 2026-10-12): the `approval` table and its "changes only from `PENDING`" trigger
already exist in `src/ledger/migrations/0001_initial.ts`, but `src/ledger/repo.ts` has no approval helpers; the config
schema (`src/config/schema.ts`) has no `profiles` or `retention` keys; `src/policy/profiles.ts` resolves only the two M2
profiles with `bypassApproved: false`; `src/adapters/run.ts` already refuses a bypass flag unless `bypassApproved`;
the lifecycle's compile-time `Ineligible` ends `PERMISSION_BLOCKED` (`src/lifecycle/lifecycle.ts`, §6.2.1); there is no
`approve` or `deny` command. On the development host `claude` and `prlimit` are installed; `codex` and `bwrap` are not.

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T3.0 | Spike: native controls per profile, provider and platform for Claude Code and Codex (file access, shell, network, repository config, sandbox, approval and bypass flags), from [R2] and the installed `claude --help`; Codex from documentation only (not installed), marked unverified | [TDD §4.1–4.2](design/TDD.md#4-provider-adapter-strategy), FR-POL-02, FR-POL-06, R-7, R-10, Q-11 | — | A per-profile, per-provider, per-platform matrix with a source for every cell is written into TDD §4.1 and §4.2; each cell that cannot be compiled names its `Ineligible` reason; nothing is stated from memory **Done** (2026-10-13, Delegated agent work, docs only; help text and documentation, no prompt run, no live check): [TDD §4.1.1](design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30) and [TDD §4.2.1](design/TDD.md#421-codex-native-controls-per-profile-and-platform-t30) give every Linux cell (five profiles × file access, shell, network, repository config, native sandbox, approval, bypass) a source (installed `claude --help` 2.1.296, an [R2] line or the adapter code) or `Unknown: live check in T3.9`; macOS and Windows are 'not supported yet' (NFR-PORT-02, NFR-PORT-03); every Codex cell is Unverified (documentation only). R-10 finding: the installed help has no sandbox or network option. Manifest notes updated (`src/adapters/manifests/claude.json`, `codex.json`); new R-36, R-37, Q-32 to Q-34; `node scripts/check-docs.mjs` and `npm test -- src/adapters/manifest` pass |
| T3.1 | Outer-sandbox evaluation for R-8 and FR-POL-06: bubblewrap, Landlock and `prlimit` around the provider process and around verification commands; availability detection; fail closed where a profile or config requires it. **Optional hardening** after decisions 10 and 11, not a prerequisite for any other task | [TDD §3.4](design/TDD.md#34-security-engineering), R-8, R-10, FR-POL-06, Q-22 | — | New ADR (next free number) records the decision and its limits (credentials the CLI itself needs, network use it cannot tell apart); `doctor` reports availability; a test shows a configured-but-missing sandbox refuses the run rather than running unconfined |
| T3.2 | COMP-POL defaults for all five profiles from SRS §3.3; `profiles.<name>` overrides that may tighten or, per decision 12, loosen; `retention.days` and `retention.interval` config keys | FR-POL-01, NFR-DATA-01, FR-WS-07, [TDD §3.1](design/TDD.md#31-configuration), `src/policy/profiles.ts`, `src/config/schema.ts`, Q-17 | — | Tests: every profile resolves to a frozen snapshot; an override that loosens a default is rejected unless written explicitly (Proposed form: a per-field override, no wildcard) and, when accepted, appears in the run's policy snapshot and in `doctor` output; unknown keys rejected; `privileged` resolves only with an approved scope (T3.4); contents SRS §3.3 leaves open use conservative Proposed defaults recorded in TDD §3.1 (Q-17); the `src/policy/profiles.ts` comment "may only tighten" is corrected |
| T3.3 | Privileged admission: `delegate_task` with `privileged` and a `privileged_scope` that passes the structured shape ([LLD §3.1](design/LLD.md#31-privileged-scope-m3): every dimension required, closed enums, `allowlist` lists present exactly when the mode is `allowlist`, argv-exact command entries, unknown keys rejected) enters AWAITING_APPROVAL (FRD T2) with a `PENDING` approval row (canonical scope JSON and the scope hash bound to client, meta-session and scope) in the same transaction; no process, no worktree. `continue_task` on a meta-session that has an `APPROVED` approval for the calling client resolves `privileged` with the approved scope as is (FRD C7, owner decision 17) and enters QUEUED (FRD T1) with the approval ID in its policy snapshot and no new approval row; otherwise a `privileged` continuation is `INVALID_REQUEST`. `get_run` shows the approval status and `requested_at` (never the scope content); `runs show` shows the scope, `bypass`, the scope hash and the runs the approval covers. Approval helpers in the ledger repo, including lookup by meta-session and client. The resolver input `PrivilegedScope` in `src/policy/types.ts` (an open record today) is narrowed to the structured type here | FR-POL-09, FR-MCP-06, BR-13, BR-14, V13, C7, decision 17, [FRD WF-7](requirements/FRD.md#wf-7-privileged-approval), [LLD §1](design/LLD.md#1-data-model), [LLD §3.1](design/LLD.md#31-privileged-scope-m3), [ADR-0017](adr/0017-approved-privileged-scope-bypass.md) | T3.2, T3.16 | Tests: ceiling below `privileged` gives `PERMISSION_BLOCKED`; ceiling `privileged` gives AWAITING_APPROVAL and exactly one `PENDING` row; a missing scope, an unknown key, a missing dimension, an `allowlist` mode without its list or a list without `allowlist` gives `INVALID_REQUEST` naming the field; idempotent replay returns the same run; `continue_task` on an approved meta-session is QUEUED with the approved scope and no second row; on a meta-session whose approval is `PENDING`, `DENIED` or absent, or from another client, it is `INVALID_REQUEST`; a new `delegate_task` with an identical scope gets a new meta-session and a new `PENDING` row; BR-13's M2 milestone note is replaced **Done** (2026-10-13, Delegated agent work; mechanism Proposed): every listed case is a test in `src/mcp/mcp.test.ts` ("privileged admission") and `src/lifecycle/lifecycle.test.ts` ("privileged admission"); scope shape, canonical form, v2 hash and the scope-to-profile spelling map in `src/policy/scope.ts` (`src/policy/policy.test.ts`); approval helpers in `src/ledger/repo.ts` (`src/ledger/ledger.test.ts`); `runs show` approval section and cancel closing a `PENDING` row `DENIED` (Q-15 default) in `src/cli/cli.test.ts` and `src/reconcile/reconcile.test.ts`; BR-13 note replaced, [FRD V11](requirements/FRD.md#71-delegate_task) and [LLD §3.1](design/LLD.md#31-privileged-scope-m3) record the compile deferral. Safety boundary: no `privileged` run is compiled or started (dispatch fails it `ELIGIBILITY_NONE` before any probe, lease or process until T3.5/T3.6), no bypass flag, no approve or deny command (T3.4), no migration |
| T3.4 | Operator `approve <run_id>` and `deny <run_id>` as top-level commands (FR-OPS-02, FRD §2.1, WF-7; not `runs approve`), each with `--json`; each acts on the `PENDING` approval row of the run that requested it (the meta-session's first `privileged` run), never on a later run; written as an operator record applied by `serve`, or applied directly under the data-directory lock when no daemon runs (same pattern as `runs cancel`); startup reconciliation applies decided approvals. `bypassApproved` is set, for any run of the meta-session, only from an `APPROVED` row whose scope hash equals the hash recomputed from that run's client, meta-session and snapshot scope, and whose scope sets bypass ([LLD §3.1](design/LLD.md#31-privileged-scope-m3)); the approval is durable (owner decision 17): no expiry, no automatic approval, no automatic revocation (revocation is Q-30). Cancelling a run in AWAITING_APPROVAL is unchanged (Q-15) | FR-POL-09, FR-OPS-02, FR-POL-03, BR-14, WF-7, WF-8, decision 17, [SDD §3](design/SDD.md#3-interface-responsibilities-and-error-propagation), Q-15 | T3.3 | Tests: `approve` moves the run to QUEUED and it runs; `deny` ends it `CANCELLED` with a decided row (timestamp, OS user); a second decision is refused; `approve` on a run not AWAITING_APPROVAL (including a later run of an approved meta-session) is a CLI error with no state change; a scope-hash mismatch leaves `bypassApproved` false; a continuation of an approved meta-session gets `bypassApproved` (when the scope sets bypass) without a new `approve`, and a run in another meta-session with an identical scope does not; works with and without `serve`; restart applies a decision recorded while the daemon was down; no MCP tool can approve; orchestrator cancel while waiting ends `CANCELLED` (approval status per Q-15); cancelling a later run leaves the approval row unchanged. **Partial** (2026-10-13, Delegated agent work; mechanism Proposed): every listed case is a test except "and it runs": an approved run reaches dispatch and is still refused `ELIGIBILITY_NONE` before any probe, lease or process until T3.5/T3.6, and the computed `bypassApproved` is recorded in its transition event but handed to no compile and no argv (no bypass flag; T3.17 not started). Evidence: top-level `approve`/`deny` with `--json` in `src/cli/main.ts` and `src/cli/runs.ts`, decision records in `src/cli/operator.ts`, decision rules, `applyApprovalDecision` and `evaluateBypass` in `src/lifecycle/approval.ts`, dispatch check in `src/lifecycle/lifecycle.ts`, startup application in `src/reconcile/reconcile.ts`; tests `src/cli/cli.test.ts` ("approve/deny": state checks, second decision refused, refusals write nothing, `--json` shape, with and without a daemon), `src/cli/serve.test.ts` ("privileged end to end": 24 h fake clock across a restart still AWAITING_APPROVAL, approve → QUEUED → documented refusal, deny → CANCELLED with no worktree or spawn, no MCP approve tool), `src/reconcile/reconcile.test.ts` (decision recorded while down applied at startup; AWAITING_APPROVAL survives a `SIGKILL` restart), `src/lifecycle/lifecycle.test.ts` (tampered or mismatched hash → FAILED `PERMISSION_BLOCKED` before spawn; `bypassApproved` only from an `APPROVED` matching row, for a continuation and not for another meta-session) |
| T3.5 | Claude Code compile matrix for `test-sandboxed`, `trusted-development` and `privileged`, with an `Ineligible` reason for every cell it cannot compile; `privileged` is compiled from the structured scope ([LLD §3.1](design/LLD.md#31-privileged-scope-m3)): each dimension maps to a native control or makes the run `Ineligible` with a reason naming the dimension, never silently dropped or widened; FR-GIT-01 deny rules kept in every write-capable profile, `privileged` included, whatever the scope says; bypass flag only per T3.16 and T3.17 | FR-POL-01, 02, 03, 06, FR-GIT-01, [TDD §4.1](design/TDD.md#41-claude-code-m2), [ADR-0015](adr/0015-claude-untrusted-isolation-flags.md), R-10 | T3.0, T3.2; T3.3 for the `privileged` cell (scope type); T3.4 and T3.17 for its bypass | Argv tests per profile; `test-sandboxed` stays `Ineligible` for Claude until FR-POL-06 confinement is shown (R-10) or T3.1 supplies it; no Git write permitted in any compiled invocation; a `privileged` scope dimension Claude cannot express gives `Ineligible` with a reason; a bypass flag appears only for an approved scope that sets bypass **Done** (2026-10-13, Delegated agent work; compile choices Proposed; argv tests and synthetic fixtures only, no prompt run, live behaviour unverified until T3.9; every flag from the installed `claude --help` 2.1.296 as cited in [TDD §4.1.1](design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30)). Non-privileged cells (unchanged since the Partial entry): `matrixIneligible` in `src/adapters/claude/adapter.ts`; `inspect-untrusted` and `edit-untrusted` as in M2; `trusted-development` with the `edit-untrusted` flags when network is `off`, shell `none` or an exact allowlist and repository config `disabled`, other cells `Ineligible: CAPABILITY_MISSING`; `test-sandboxed` `Ineligible: PROFILE_UNSUPPORTED` in every cell (R-10, Q-16). `privileged` (`privilegedPlan`): compiled from the scope when network is `on` (`WebFetch` in `--tools`) and repository config `disabled`; network `off`/`allowlist`, repository config `approved`/`enabled`, read-only files with broad shell and an exact allowlist under bypass are `Ineligible: CAPABILITY_MISSING`; a Git-write or non-plain allowlist entry `Ineligible: PROFILE_UNSUPPORTED`. `bypass: false` compiles with the `trusted-development` flags; `bypass: true` with the run's `bypassApproved` adds `--dangerously-skip-permissions`, omits `--restricted` and `--permission-mode` (decision 19) and keeps `--safe-mode`, `--strict-mcp-config`, `--permission-prompts none` and the Git deny rules; without `bypassApproved` it is `Ineligible: PROFILE_UNSUPPORTED`. Evidence: `src/adapters/claude/claude.test.ts` ("claude compile matrix (M3)" as before; "claude privileged compile matrix": every scope shape × bypass × `bypassApproved` (on the request or the profile) × writable, compile and resume, showing the bypass flag iff privileged ∧ scope bypass ∧ approved, `--restricted` absent iff bypass, the full `--disallowedTools` set always, no `--bare`/`--settings`/`--mcp-config`/`--add-dir`/`--worktree`; exact argv rows; `claudePrivilegedDenialCases` in `src/adapters/claude/fixtures/cases.ts` end `PERMISSION_BLOCKED`/`SANDBOX_VIOLATION` through the harness with and without bypass); a mutation of the compile gate fails these tests. **Assumptions, unverified (R-26, live check T3.9, live-smoke C-G2):** Git deny rules and `--tools` still apply under `--dangerously-skip-permissions`; omitting `--permission-mode` is right. The `list_capabilities` narrowest scope (network `off`) is `Ineligible` for Claude, so Claude does not list `privileged` there |
| T3.6 | Codex compile matrix for the same three profiles, as T3.5, including `privileged` compiled from the structured scope with an `Ineligible` reason for each dimension Codex cannot express and the FR-GIT-01 rules kept whatever the scope says; Codex's in-sandbox command execution under the untrusted profiles is accepted per decision 10 and declared unverified | FR-POL-01, 02, 03, 06, FR-GIT-01, [TDD §4.2](design/TDD.md#42-codex-m2), Q-11, R-22 | T3.0, T3.2; T3.3 for the `privileged` cell (scope type); T3.4 and T3.17 for its bypass | As T3.5 for Codex; the manifest notes and `list_capabilities` say that credential confinement is unverified; network allowlists that Codex cannot express (in a profile or a `privileged` scope) are `Ineligible`, never downgraded **Done** (2026-10-13, Delegated agent work; compile choices Proposed; synthetic fixtures only, `codex` not installed, every cell Unverified (documentation only) as in [TDD §4.2.1](design/TDD.md#421-codex-native-controls-per-profile-and-platform-t30)). Non-privileged cells unchanged since the Partial entry (`src/adapters/codex/adapter.ts`; decision 10, R-23; `test-sandboxed` `Ineligible` per Q-32; non-empty command allowlist, network other than `off`, repository config other than `disabled` and a requested model `Ineligible: CAPABILITY_MISSING`; `gitWriteControl` `none-documented`). `privileged` (`#privileged`): a scope with `bypass: false` compiles only with shell `broad`, network `off` (Assumption) and repository config `disabled`, as `trusted-development`; shell `none`/`allowlist`, network `allowlist`/`on`, repository config `approved`/`enabled` and a requested model are `Ineligible: CAPABILITY_MISSING`; `bypass: true` is `Ineligible: PROFILE_UNSUPPORTED` ("bypass/privileged flag not documented in R2: verify live") whatever the approval, because [R2] names `--yolo` and `--full-auto` (L28, L125, L126) without documenting their effect; no Codex bypass flag is emitted. Evidence: `src/adapters/codex/codex.test.ts` ("compile matrix (M3, T3.6; TDD §4.2.1)" as before; "privileged compile matrix (T3.6, T3.17; TDD §4.2.1)": every scope shape × `bypassApproved` × writable, compile and resume, never a bypass flag; synthetic `sandbox_denied`/`permission_denied` under `privileged` end `SANDBOX_VIOLATION`/`PERMISSION_BLOCKED` through the harness). The narrowest scope (shell `none`) is `Ineligible` for Codex, so it does not list `privileged` |
| T3.7 | Profile-aware eligibility, and compile-time `Ineligible` in the lifecycle mapped to the BR-3 codes instead of `PERMISSION_BLOCKED` | FR-RTE-01, FR-POL-02, [FRD BR-3](requirements/FRD.md#3-business-rules), §6.2.1, `src/lifecycle/lifecycle.ts`, `src/routing/` | T3.2 (the BR-3 mapping alone has no dependency) | Tests: each profile filters providers by their compile result; a race-time compile `Ineligible` ends with the BR-3 code; the §6.2.1 row is closed **Done** (2026-10-13, Delegated agent work; choices Proposed; fakes, synthetic fixtures and argv-free compile checks only, no live provider): the eligibility filter and `list_capabilities` take per-profile support from one call, `compileCheck` in `src/routing/collect.ts` (the adapter's own `compile` of the resolved profile, overrides included), after a host-platform rule (`profilePlatformSupported`, `PROFILE_PLATFORM_UNVERIFIED` → `ELIGIBILITY_NONE`; Linux only, every profile counted as sandbox-dependent until M4, Q-35); the lifecycle resolver (`createProfileResolver`, `src/policy/profiles.ts`) now resolves all four non-privileged profiles instead of only the two M2 ones, so `test-sandboxed` and `trusted-development` are decided by compile; `supported_profiles` lists `privileged` only if the adapter compiles the narrowest scope (neither Claude Code nor Codex does before T3.17); the T3.3 deferral is unchanged (a `privileged` request is admitted when its only exclusions are `PROFILE_UNSUPPORTED`/`CAPABILITY_MISSING`; a platform exclusion refuses it). Evidence: `src/routing/routing.test.ts` ("per-profile eligibility (M3)": five profiles × Claude Code and Codex on Linux against each adapter's direct compile, a loosening override, `darwin` and `win32`, the LLD §2 reason mapping); `src/lifecycle/lifecycle.test.ts` (compile `Ineligible` at LEASED → FAILED `ELIGIBILITY_NONE` with the reason in the event, at PREFLIGHT → T8 `ELIGIBILITY_NONE`, `VERSION_UNVERIFIED` → `ADAPTER_VERSION_UNVERIFIED`, preflight compiles the frozen snapshot; the M1 T10 test that expected `PERMISSION_BLOCKED` now expects `ELIGIBILITY_NONE`); `src/mcp/mcp.test.ts` ("list_capabilities supported_profiles (T3.7 …)": the matrix on Linux equals each adapter's compile, empty off Linux, `test-sandboxed` delegate → `ELIGIBILITY_NONE` with reasons, privileged admission on Linux and its refusal on `darwin`); `src/policy/policy.test.ts` (resolver gate lifted). FRD T10 and [LLD §3](design/LLD.md#3-mcp-tool-contracts) (`supported_profiles`) updated; §6.2.1 row closed |
| T3.8 | Malicious-fixture suite, controller leg (CI, fake provider). Controller-side invariants first, with minimal benign fake-provider behaviours: environment allowlist holds; operator checkout refs and working tree unchanged; controller Git runs with hooks disabled; no canary token in the ledger, logs or MCP envelopes; symlinks handled safely in diffs, artifacts and GC; repository hooks, MCP definitions and agent instructions not loaded | NFR-SEC-03 (controller leg), FR-POL-04, FR-EXE-07, FR-WS-05, FR-TEL-03, NFR-SEC-01 | — (GC symlink cases after T3.12) | Each invariant has a test that fails when the invariant is broken (shown by a deliberately broken variant during review); runs in CI without any provider installed; **Partial** (2026-10-13, Delegated agent work): controller Git filter/diff-driver weakness fixed in `src/workspace/git.ts`: configured filter (`clean`/`smudge`/`process`) and diff (`textconv`/external `command`) drivers are enumerated and blanked on every controller Git call, and `git diff` always gets `--no-textconv --no-ext-diff` ([TDD §3.4](design/TDD.md#34-security-engineering)). Evidence: `test/malicious/controller.test.ts`, where the formerly `it.fails` test now passes, plus per-operation tests, each with an unhardened-Git positive control. Still open: T3.8b and the live leg (T3.9), Q-20 (`setsid`); the nested-repository gap (Q-31, R-35) is closed by T3.20 |
| T3.8b | **Owner-reviewed sub-task.** Adversarial fake-provider scenarios (escape attempts beyond T3.8's benign behaviours). A previous drafting attempt was stopped partway by a safety classifier, so the scenario list and its content go to Ender for review before anything is written | NFR-SEC-03, R-3 | T3.8; Ender's review | Ender has approved the scenario list in writing; the scenarios then run in CI like T3.8 |
| T3.9 | Live malicious leg for Claude Code and Codex: operator-run, opt-in (skipped unless the live-test variables are set), canary files and tokens only, never real credentials; each check reports `HELD`, `ESCAPED` or `NOT_CHECKED`. Covers FR-POL-06 for Codex (decision 10), Claude `test-sandboxed` confinement (R-10), FR-GIT-01 checks C-G2 and X-G1, and bypass behaviour under an approved scope | NFR-SEC-03, FR-POL-06, FR-GIT-01, [TDD §3.6](design/TDD.md#36-testing-strategy), Q-21 | T3.5, T3.6, T3.8; M2 live smoke run (§6.2 "Blocks Done"); for Codex, Q-10 and Q-12 | The operator has run it and the results are recorded here and in the manifest notes; every `ESCAPED` makes the affected cell `Ineligible` or opens a risk; CI skips it |
| T3.10 | Verification stage: VERIFYING (FRD T11, T14) runs `verification_commands` as argv arrays (no shell) in the run worktree with the run's environment allowlist and timeout; any failure gives `TEST_FAILURE` (BR-16); results stored as a redacted `test_report` artifact and in the envelope; host execution under `edit-untrusted` allowed (decision 11); refused under `inspect-untrusted` (V7); cancel and crash handled per §4.3 and WF-8 | FR-EXE-08, BR-16, V7, WF-8, FR-TEL-03, NFR-SEC-01 | T3.2 | Tests: pass, fail, timeout, cancel during VERIFYING, crash during VERIFYING ends `PROCESS_CRASH` and is not re-run; output redacted; README no longer says verification is refused |
| T3.11 | Optional confined verification: run verification commands inside the outer sandbox from T3.1 when configured | FR-EXE-08, FR-POL-06, decision 11 | T3.1, T3.10 | Opt-in tests (skipped when the sandbox is unavailable) show writes outside the worktree refused; unconfigured behaviour unchanged |
| T3.12 | Retention and GC: configurable retention; the collected unit is a whole idle meta-session (Q-18, decided: decision 28, Delegated); crash-safe order (mark and intent, Git action, outcome); worktrees, `switchboard/` branches and artifact files removed together; `run_event` rows kept (Q-19, decided: decision 28); orphan sweep reported by `doctor` | FR-WS-07, NFR-DATA-01, [LLD §5](design/LLD.md#5-workspace-and-lease-algorithm), FR-PRJ-09 (later) | T3.2 for the config keys (the algorithm can start earlier) | Tests: expired unit removed completely; active or recent units untouched; never touches branches outside `switchboard/`; `SIGKILL` mid-GC then restart completes or rolls forward; symlinked paths not followed out of the data directory; NFR-DATA-01 wording or Q-19 settled (done, decision 28); **Partial** (2026-10-13, Delegated agent work): the algorithm (`src/workspace/gc.ts`, `src/workspace/gc.test.ts`: every test above) is now wired into the product. `doctor` reports retention and the read-only orphan sweep (`checkRetentionAndOrphans` in `src/cli/doctor.ts`; `findOrphans`, `planRetentionGc` in `src/workspace/gc.ts`); `switchboard gc` is a dry run unless `--apply`, `--apply` needs `retention.days` set, refuses while a `serve` daemon holds the data-directory lock and holds the lock itself (`src/cli/gc.ts`); `serve` runs one pass after reconciliation and before the lifecycle starts or MCP accepts calls, then every `retention.interval`, only when the config sets `retention.days` (`ResolvedConfig.retentionEnabled`, `src/config/load.ts`; the 30 day default is a value, not a switch; no new config key). Evidence: `src/cli/gc.test.ts` (doctor with an orphan, dry run changes nothing, apply removes an expired unit and leaves recent and non-terminal ones, refusal without `retention.days`, refusal under the lock, roll-forward), `src/cli/serve.test.ts` ("serve runs retention GC after reconciliation": retention unset collects nothing; set collects the expired idle unit and leaves recent and awaiting-approval ones), `src/config/config.test.ts`. Still open: orphans are reported, never removed (LLD §5 says GC removes them after the retention period; not implemented); the interval pass is not covered by a test (the shortest interval is `1m`); the process-level `SIGKILL`-mid-GC test is covered only through the in-process crash injection at every step (`gc.test.ts`) and the roll-forward test in `src/cli/gc.test.ts`. **R-42 closed in code and tests (decision 28):** mark-first `ledger.beginGc` (idleness re-checked and `ARCHIVED` set in one transaction), admission refusing `ARCHIVED` in `src/lifecycle/lifecycle.ts`, roll-forward of marked sessions in `listGcCandidates`; tests in `src/workspace/gc.test.ts` ("skips a session whose run was admitted after the candidate list was read", "marks the session ARCHIVED before any worktree, branch or file is removed", crash-after-each-step convergence) and `src/lifecycle/lifecycle.test.ts` (continuation of an archived session refused, also when archived between validation and admission; no run written). NFR-DATA-01 wording amended in the SRS (decision 28) |
| T3.13 | Documentation and status: README (profiles, approval, verification, retention), TDD §4 matrices, LLD §3 and §5 detail, this roadmap's status with evidence | NFR-MAINT-02, NFR-MAINT-03 | All other M3 tasks | §6 shows M3 `Partial` or `Done` with evidence per task; §6.5.2 updated |
| T3.14 | Correct the README's "no shell" wording for Codex under `inspect-untrusted` and `edit-untrusted`: Codex runs commands inside its native sandbox, and credential confinement is unverified (decision 10); align the TDD §3.4 credential-boundary sentence and TDD §4.2 | Decision 10, FR-POL-06, NFR-COMP-01, R-23 | — | **Done** (2026-10-12, Delegated agent work, docs only): [README.md](../README.md#trust-profiles) trust-profile table and "Codex and the shell" note, with loosening overrides and the privileged scope listed as planned in M3 only; [TDD §3.4](design/TDD.md#34-security-engineering) credential-boundary bullet; [TDD §3.10](design/TDD.md#310-git-commits-attribution-and-publication) layer 1; [TDD §4.2](design/TDD.md#42-codex-m2) "Commands under untrusted profiles" row; `node scripts/check-docs.mjs` passes |
| T3.15 | Correct TDD §3.1 `profiles.<name>` from "may only tighten" to FR-POL-01's rule (decision 12) | Decision 12, FR-POL-01 | — | **Done in this change** (2026-10-12): [TDD §3.1](design/TDD.md#31-configuration) row updated |
| T3.16 | Design the privileged scope before any bypass code: [LLD §3](design/LLD.md#3-mcp-tool-contracts) `delegate_task` gains `privileged_scope` (files, shell, network, repository config, and an explicit `bypass` boolean), its validation and how its hash is computed; a new ADR (next free number: 0016 at planning time, renumbered ADR-0017 when main's ADR-0016 merged first) records decision 13, Delegated wording citing Ender's decision, complementing [ADR-0004](adr/0004-trust-profiles-no-bypass-flags.md) | Decision 13, FR-POL-03, FR-POL-09, BR-14, FR-MCP-03, [AGENTS.md](../AGENTS.md#working-rules) | — | **Done** (2026-10-12, Delegated agent work, docs only; mechanism Proposed): [LLD §3.1](design/LLD.md#31-privileged-scope-m3) (shape, V13 validation, scope hash, approve and bypass checks, envelope `approval`), [LLD §1](design/LLD.md#1-data-model) and §2 comments; [ADR-0017](adr/0017-approved-privileged-scope-bypass.md) (complements ADR-0004, which is unchanged); [FRD](requirements/FRD.md#3-business-rules) BR-14, V13, C7, WF-7 and the permission matrix; SRS FR-POL-03 and FR-MCP-03 amended (IDs unchanged); SDD FR-POL-03 and FR-POL-09 rows; TDD §3.4, HLD TB-2 and AGENTS.md point to ADR-0017; open points Q-28, Q-29; `node scripts/check-docs.mjs` passes. **Amended 2026-10-13** (docs only, before merge): structured scope (Delegated, Q-28 answered, §4.4) and the meta-session-bound approval (owner decision 17) in LLD §3.1, ADR-0017, FRD BR-14, V13, C7, T1, T2, WF-7, SRS FR-POL-03 and FR-POL-09; new R-34 and Q-30 |
| T3.17 | Change the argv audit and its tests: `BYPASS_FLAGS` stays the single list; a bypass flag is allowed only when the run's resolved profile is `privileged`, `bypassApproved` is true and the approved scope sets bypass; every other case still fails | Decision 13, FR-POL-03, `src/adapters/audit.ts`, `src/adapters/run.ts`, `src/policy/policy.test.ts`, adapter argv tests | T3.16 | Tests: a bypass flag in any non-privileged, unapproved or bypass-false invocation is refused before spawn; the approved, bypass-true case passes; the M2 tests asserting no bypass flag still pass for the other four profiles **Partial** (2026-10-13, Delegated agent work; mechanism Proposed). Adapter side done: `BYPASS_FLAGS` is still the single list; `auditInvocation(inv, ctx)` and `assertBypassAudit` in `src/adapters/audit.ts` admit a flag only when the context is `privileged` with `bypassApproved` and scope `bypass`, and refuse every flag without a context; `startAdapterRun` (`src/adapters/run.ts`) throws `BypassFlagError` before spawn unless its new `profile` option and `bypassApproved` satisfy that. Evidence: `src/adapters/adapters.test.ts` ("bypass audit gate (T3.17 ...)": every profile × `bypassApproved` × every `BYPASS_FLAGS` entry, bare and `=value`, in argv or `policyFlags`, refused before spawn except the approved bypass-true case, which spawns the fake CLI and leaves an empty process group); the M2/M3 "no bypass flag" sweeps for the four non-privileged profiles still pass; a mutation of the gate makes these tests fail. **Open:** the lifecycle must pass the run's profile to `startAdapterRun` (`profile` option); until it does, every bypass flag is refused at spawn (fail closed). `src/policy/policy.test.ts` is unchanged |
| T3.18 | Owner decisions 19 and 22 in the controller: (a) per-client `mcp_clients[].privileged_approval` (`required` default, `not_required`; Delegated realisation of decision 22): a `not_required` client's `privileged` request is admitted to QUEUED (FRD T1) with its approval row decided `APPROVED` by `client_policy:<client_id>` in the admission transaction; (b) the T3.3/T3.4 dispatch refusal of every `privileged` run is removed: the adapter's compile decides (preflight eligibility and LEASED), with `bypassApproved` only from `evaluateBypass` | Decisions 17, 19, 22, FR-POL-09, FR-POL-03, FR-MCP-06, [FRD BR-13, BR-14](requirements/FRD.md#3-business-rules), [WF-7](requirements/FRD.md#wf-7-privileged-approval), [LLD §3.1](design/LLD.md#31-privileged-scope-m3), [TDD §3.1](design/TDD.md#31-configuration), [ADR-0018](adr/0018-claude-bypass-omits-restricted.md), [ADR-0019](adr/0019-per-client-privileged-approval.md) | T3.3, T3.4 | **Done** (2026-10-13, Delegated agent work, branch `m3-bypass`): `src/config/config.test.ts` ("mcp_clients[].privileged_approval"), `src/cli/cli.test.ts` ("doctor privileged approval"), `src/lifecycle/lifecycle.test.ts` ("approval by client policy", "an approved privileged run is compiled by its adapter"), `src/mcp/mcp.test.ts` ("privileged_approval not_required"), `src/cli/serve.test.ts` ("a client configured privileged_approval not_required"). Required clients are unchanged (AWAITING_APPROVAL); a ceiling below `privileged` is still `PERMISSION_BLOCKED`; a tampered hash still fails `PERMISSION_BLOCKED` before spawn. The real adapters' `privileged` cells are T3.5 and T3.6 |
| T3.19 | Owner decision 26 (Q-37) in the Claude adapter: in an approved bypass run `repository_config` `approved` and `enabled` compile (`CLAUDE_BYPASS_REPO_CONFIG_ISOLATION_FLAGS`: no `--safe-mode`; `--strict-mcp-config` kept for `approved`, omitted for `enabled`); every other case stays `Ineligible: CAPABILITY_MISSING`; Codex unchanged (bypass undocumented) | Decision 26, Q-37, [ADR-0021](adr/0021-repository-config-in-approved-bypass-runs.md), [ADR-0018](adr/0018-claude-bypass-omits-restricted.md), FR-POL-03, FR-GIT-01, [TDD §4.1.1](design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30), [LLD §3.1](design/LLD.md#31-privileged-scope-m3) | T3.5, T3.17 | **Done** (2026-10-13, Delegated agent work) for the compile and audit: `src/adapters/claude/claude.test.ts` ("repository_config under an approved bypass": `approved` omits `--safe-mode` and keeps `--strict-mcp-config` and the Git deny rules; `enabled` omits both; unapproved bypass and `bypass: false` stay Ineligible; no `--restricted`; the scope-shape table), `npm test` passing; the audit gate needed no change (only flags are omitted). **Open:** the flag behaviour is unverified (R-41); the live check belongs to T3.9 |
| T3.20 | Close the nested-repository gap (Q-31, R-35; decision 27, Delegated): `src/workspace/nested.ts` enumerates nested `.git` entries without Git and without following symlinks; `assessMutation`, `finalize` and `rollback` exclude them by pathspec (and `--ignore-submodules=all` on `status`/`diff`); the skipped paths are returned and recorded as `nested_repositories_skipped` in the `workspace_assessment` event and the terminal run payload; no run fails | Q-31, R-35, decision 27, decision 25, FR-WS-05, NFR-SEC-03, [TDD §3.4](design/TDD.md#34-security-engineering), [ADR-0022](adr/0022-nested-repositories-excluded-from-controller-git.md) | T3.8 | **Done** (2026-10-13, Delegated agent work): `src/workspace/nested.test.ts` (a failing-first test with a benign marker-file filter in a nested repository: marker absent after `assessMutation`, `finalize` and `rollback`, for a `.git` directory and a `.git` file; positive control that the filter runs under direct Git in the nested repository and from an unhardened parent `status`; warning in the assessment and finalize results; root `.git` not nested; spaces, unicode, glob characters and non-UTF-8 names; symlinks not followed). The event and payload wiring in `src/lifecycle/lifecycle.ts` and `src/reconcile/reconcile.ts` is typechecked but has no dedicated test. **Open:** weaker change detection inside nested repositories (accepted); T3.8b |
| T3.21 | NFR-PERF-02 preflight cache (Q-14, decision 29, Delegated): `PreflightCache` in `src/adapters/preflight-cache.ts` caches `probe` and `authPreflight` successes only, keyed by adapter id and the binary's path, `mtime`, size and inode, with `timeouts.preflight_ttl_seconds` (Assumption: default 60, 0 disables, strict integer 0 to 3600); wired through `collectFacts` (`delegate_task` stage 1, `list_capabilities`), the lifecycle PREFLIGHT and `serve`; never caches a failure, `AUTH_REQUIRED` or `UNKNOWN`; stores no credentials | NFR-PERF-02, FR-ADP-03, BR-20, Q-14, decision 29, decision 25, [TDD §3.1](design/TDD.md#31-configuration), [ADR-0009](adr/0009-version-gated-adapters.md) | T3.2 | **Done** (2026-10-13, Delegated agent work): `src/adapters/preflight-cache.test.ts` (second call within the TTL does not call the adapter; TTL expiry re-probes; a changed `mtime` or size, or a missing binary, invalidates probe and auth; failed, throwing, `AUTH_REQUIRED` and `UNKNOWN` results are not cached; `ttl 0` disables; the fake adapter through `collectFacts` spawns nothing on the second collection and spawns again after `clear()`), `src/config/config.test.ts` (key default, bounds, strictness), and `npm run bench -- --cached` (TDD §3.6.1). **Open:** the lifecycle and `serve` wiring has no dedicated test (the bench exercises it end to end); real provider probe cost unmeasured |

#### 6.5.1 Order, waves and hot files

- **Wave A (can start now; none needs a live provider):** T3.0, T3.1, T3.2, T3.7 (the BR-3 mapping part), T3.8, T3.12
  (algorithm). T3.14, T3.15 and T3.16 are done.
- **Wave B:** T3.3 (after T3.2, T3.16), T3.17 (after T3.16), T3.10 (after T3.2), rest of T3.7 (after T3.2).
- **Wave C:** T3.4 (after T3.3), T3.5 and T3.6 (after T3.0, T3.2; their `privileged` cell after T3.3, which defines
  the structured scope type, and its bypass after T3.4 and T3.17), T3.11 (after T3.1, T3.10), T3.8b (after Ender's
  review).
- **Wave D:** T3.9 (operator), T3.13.
- **Hot files:** `src/lifecycle/lifecycle.ts` (T3.3, T3.4, T3.7, T3.10), `src/mcp/*` (T3.3, including `continue_task`,
  and T3.10), `src/cli/serve.ts` (T3.4, T3.12), `src/ledger/repo.ts` (T3.3, T3.4, T3.10, T3.12) and
  `src/policy/types.ts` (T3.2, T3.3, which narrows `PrivilegedScope`). Tasks sharing a hot file run one after another,
  never in parallel (AGENTS.md); T3.3 goes before T3.10 in the lifecycle and MCP code.
- No code that emits a bypass flag merges before T3.16 and T3.17.

#### 6.5.2 What M3 cannot complete without live providers

M3 can reach `Partial` at best on fakes and fixtures. These need operator-run live checks (T3.9) and, for Codex, the M2
items Q-10 (auth status) and Q-12 (version range) first:

- NFR-SEC-03 for Claude Code and Codex: "no escape" on real CLIs.
- FR-POL-06: Codex credential confinement (decision 10) and Claude `test-sandboxed` confinement (R-10).
- FR-POL-02 per-profile compilation on real CLIs (flag spellings and behaviour, R-21, R-22).
- FR-GIT-01 live checks C-G2 and X-G1.
- Bypass behaviour under an approved `privileged` scope (decision 13).

FR-POL-09, FR-OPS-02 (`approve`, `deny`), FR-EXE-08, FR-WS-07 and NFR-DATA-01 can be shown on fakes.

### 6.6 M11 Inner agent: tasks

*Proposed breakdown, written when M11 was added; revisit when M9 completes.* Design: [ADR-0016](adr/0016-inner-agent.md),
[LLD §13](design/LLD.md#13-inner-agent), [TDD §3.12](design/TDD.md#312-inner-agent), [PRD
§3.1](requirements/PRD.md#31-inner-agent-task-catalogue). Order of delivery: the core and the `http` backend first, then
the commit-message task (the highest-value one), then the others as the milestones they need complete. No task here may
call a live model in the default test run.

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T11.0 | Spike: on the installed OpenCode, find whether a one-shot `opencode run` with an operator-chosen model can be run with no tools, an empty working directory and no repository config. Record the flags verified, or record that it cannot and mark the `cli` kind `Ineligible` | FR-INN-04, Q-26, [R2] OpenCode | — | The result and the checked flags are written into TDD §4.6 with the version and date, or the limitation is recorded and FR-INN-04 re-prioritised |
| T11.1 | Config schema for `inner_agent`, the backend port, a scripted fake backend, the `inner_call` table, the disabled-by-default path, and the import-boundary test | FR-INN-01, 02, 05, 06, LLD §13.1–13.3 | M2 | Config rejects unknown keys and a credential-looking value; with no section the suite behaves as before; a test fails if COMP-POL, an adapter's profile compiler, the retry logic or the push path imports the inner-agent service |
| T11.2 | Call pipeline: redaction, input budget, call, schema validation, one re-ask, per-call timeout, circuit breaker, fallback result, `inner_call` and run events | FR-INN-07, 08, 16 (redaction, no body logging), LLD §13.4 | T11.1 | Fake-backend tests: invalid, empty, oversized, slow, erroring and non-UTF-8 outputs all fall back within the bound; breaker opens and probes; a planted secret never appears in the captured prompt or in any log |
| T11.3 | `http` backend, locality classification, `allow_remote`, `allow_source_content`, project and context `inner_agent` override | FR-INN-03, 16, LLD §13.2, §13.5, [LLD §11](design/LLD.md#11-projects-contexts-and-environments) | T11.2, T9.1 | Against a local fake HTTP server: a `remote` backend is refused without opt-in, diffs are refused without the per-task opt-in, `local_only` and `off` projects never call a remote backend |
| T11.4 | Commit-message task: optional `message` on the `commit` tool, modes `draft_if_missing`, `always`, `never`, prompt without identifiers, sanitiser on the result, provenance note | FR-INN-10, FR-GIT-04, [LLD §12.1](design/LLD.md#121-tool-contracts), [LLD §12.4](design/LLD.md#124-message-sanitisation) | T11.2, T9.3, T9.4 | A hostile fake backend returning `Co-authored-by:` lines, a run ID and a "generated by" footer yields a clean commit; empty or unavailable output returns the tool error and no commit; the agent's own message wins in the default mode |
| T11.5 | Usage accounting: `inner_call` records only, nothing in `usage_observation` or capacity; `shares_subscription_with` observation and the `doctor` warning | FR-INN-15, ADR-0007 | T11.1 | `get_capacity` and the estimator are byte-identical with and without inner calls; with the flag set, one labelled observation per call appears |
| T11.6 | Quality monitoring and automatic suspension | FR-INN-09 | T11.2 | Rejection rate above the configured threshold over the window suspends the task, which then falls back until re-enabled |
| T11.7 | `doctor` inner-agent section, `inner status`, `inner test` with the built-in fixture | FR-INN-17 | T11.3, T11.6 | Plain-text and `--json` output; `inner test` sends no repository data (asserted on the captured prompt) |
| T11.8 | PR-draft task and the `pr_draft` artifact kind | FR-INN-11, [LLD §3](design/LLD.md#3-mcp-tool-contracts) | T11.4 | Draft passes the sanitiser; Switchboard makes no call to any pull-request API (test asserts no such client exists) |
| T11.9 | Log and verification-output summary | FR-INN-13, FR-EXE-08 | T11.2, M3 | Statuses, exit codes and counts in the envelope come from records in every test; the summary carries a source label and a raw-artifact pointer; fallback is deterministic head and tail |
| T11.10 | Handoff-bundle condensation | FR-INN-13, FR-SES-04 | T11.2, M5 | Structured bundle fields are identical with and without the inner agent; condensed fields are labelled and link to raw artifacts |
| T11.11 | Routing classification feature | FR-INN-12, FR-RTE-04, ADR-0008 | T11.2, M7 | Stored feature with source, model and template version; replay reproduces the decision with the backend off; the feature never changes eligibility or `require_provider` |
| T11.12 | Run title and one-line summary (Could) | FR-INN-14 | T11.2 | Length cap and control-character stripping tested |
| T11.13 | `cli` backend using OpenCode (Should) | FR-INN-04, FR-ADP-08, FR-ADP-03 | T11.0, M4 (OpenCode adapter and manifest) | Runs only on a version inside the manifest range and only with the verified tool-free flags; otherwise reports `Ineligible`; no bypass flag in argv (argv audit) |
| T11.14 | Update the README (configuration, privacy, `doctor`, `inner`), roadmap status and any document the work proved wrong | NFR-MAINT-02, NFR-MAINT-03 | T11.1–T11.8 | §6 shows M11 with status and links to tests |

Later milestones (M4–M8) are intentionally kept at the level of the table in §6; break them into tasks when the
preceding milestone completes.

## 7. Risks, blockers and open questions

### 7.1 Risks

| ID | Risk | Effect on plan | Mitigation |
| --- | --- | --- | --- |
| R-1 | Provider CLIs change flags, output or auth behaviour (already happened with Kimi) | Adapters break or weaken security | Version gating, conformance suites, manifests (ADR-0009) |
| R-2 | Provider terms restrict automated or third-party use for some plans | A provider may be unusable | Compliance manifest review per provider; each user runs their own installation with their own logins (ADR-0003, ADR-0011) |
| R-11 | Publishing as open source invites users to run Switchboard in ways the terms do not allow (shared logins, hosted service) | Account risk for those users; reputational risk for the project | README states the single-operator model and that terms compliance is each user's responsibility (NFR-COMP-01, NFR-MAINT-03) |
| R-3 | Same-user credential exfiltration by a prompt-injected agent | Credential theft | FR-POL-06; provider-native sandboxes; untrusted profiles without shell; M3 fixtures |
| R-4 | Native sandbox support differs by platform | Fewer eligible providers on some hosts | Eligibility is per platform; Linux first |
| R-5 | Capacity is opaque | Throttling mid-task | Confidence estimates, backpressure, checkpointed retries (ADR-0007) |
| R-6 | Scope (seven adapters, all Must) is large for one maintainer | Slow delivery | Vertical slice with two adapters first; the rest added one at a time behind the same conformance suite; open-source contributors can add adapters (NFR-MAINT-01) |
| R-7 | Research facts are dated 2026-10-12 and not re-verified here | Flags in TDD may be stale by implementation | Each adapter task starts by verifying against the installed CLI |
| R-8 | No per-run disk or CPU limits | A runaway agent fills the disk or starves the host | Timeouts, concurrency limits and retention for now; revisit in M3 with the outer-sandbox evaluation ([TDD §3.4](design/TDD.md#34-security-engineering)) |
| R-9 | MCP client identity over stdio is only as strong as the orchestrator's launch config (`serve --client <id>`) | A misconfigured orchestrator gets another client's trust ceiling | Keep ceilings low by default; `privileged` always needs operator approval (FR-POL-09) |
| R-10 | Claude Code has no documented native sandbox in the research | Claude may be ineligible for `test-sandboxed` (FR-POL-06); M2's two profiles are unaffected because they allow no arbitrary shell | Settle in M3 with the malicious-fixture suite; other adapters cover those profiles if needed |
| R-12 | A controller crash between spawning a provider process and committing its `pid`, `pgid` and start ticks leaves an orphan that startup reconciliation cannot find (LLD §8) | An unsupervised provider process may keep writing to a worktree until it exits; the run is still assessed and ended | Known limit of M1 (the pid is only known after spawn). **Proposed:** revisit with a launcher or cgroup-based tracking if it matters in M3 |
| R-13 | Container environments need the provider CLI's login inside the container, and FR-AUTH-01 forbids the controller copying or moving credentials | `container` projects may be unusable, or need a per-container native login | Proposed in-volume native login (Q-6, delegated); T10.0 verifies it; host environments unaffected (ADR-0013) |
| R-14 | The message sanitiser is a pattern list; attribution in unusual wording, or written into file contents, is not caught | Commits or files may carry a marker contrary to owner decision 7 | Fixtures of typical output; operator-added patterns; file contents out of scope by design; review of published commits (ADR-0014) |
| R-15 | In a `host` environment a same-user agent shell can read ambient Git credentials | An agent could push around the tool | Withhold the `push` tool there (FR-GIT-06, BR-31); no credentials in the agent environment; containers in M10 |
| R-16 | Removing provider attribution from commits may conflict with a provider's terms; not reviewed | Account or policy risk for the operator | Record the review in the compliance manifest notes (FR-POL-07); no compliance claim (NFR-COMP-01); the operator's call |
| R-17 | Provenance links to commits by SHA; an operator rebase or squash breaks the link | Gaps in the audit trail | Also store tree hash and patch ID (FR-GIT-07); best effort |
| R-18 | A per-run injected MCP channel may be impossible without a bypass flag, or blocked by a provider sandbox, for some providers | Those adapters fall back to controller-made commits | T9.0 spike; finalize-only mode (FR-GIT-09). *T9.0 spike (2026-10-13; Delegated, partial).* Claude Code: `claude --help` 2.1.296 documents `--mcp-config` and `--strict-mcp-config`, so a per-run definition needs no global configuration and, if an MCP tool needs no bypass flag, none; whether it does, the JSON shape, the allow-rule form and whether `--safe-mode` also disables the server are **unverified** (live check). ADR-0015 and the argv audit bar `--mcp-config`, so the channel needs a narrowing ADR first (Q-40). Socket reach from any provider sandbox: `Unknown: live check`. Codex: **Unverified** (not installed; nothing in [R2]). Until checked, no adapter may declare an injected channel and the finalize-only mode stays the fallback |
| R-19 | The verified research documents no provider setting for commit behaviour or attribution, nor how to supply a per-run MCP definition | Provider-specific controls cannot be relied on until checked | The layered design does not depend on them (TDD §3.10); each adapter verifies against the installed CLI (T2.2, T9.0). T2.2 result: `claude --help` 2.1.296 documents deny rules (`--disallowedTools`) but names attribution only under `--bare`, which is unusable (ADR-0015); Codex: nothing in [R2], CLI not installed. T9.0 result (2026-10-13): `claude mcp --help`, `claude mcp add --help` and `claude --help` 2.1.296 add `--mcp-config` and `--strict-mcp-config` (above) and nothing on commit behaviour; attribution is still named only under `--bare`. Codex: still nothing in [R2], CLI not installed, every cell Unverified |
| R-20 | An orchestrator that can create projects widens what a compromised or prompt-injected orchestrator can reach | New mounts, providers, ceilings or push rights through a project it created | `manage_projects` off by default; limits are the client's own; operator approval for containers, push and widening; creator-only visibility; every call recorded (FR-PRJ-10, HLD TB-9) |
| R-21 | Claude stream-json event shapes and error category strings are unverified; the adapter was written against `claude --help` 2.1.296 text and synthetic fixtures (`src/adapters/claude/parse.ts`; [ADR-0015](adr/0015-claude-untrusted-isolation-flags.md)) | Misparsed events or misclassified failures on a real CLI | Live smoke test (T2.6) before M2 is called done; classify unknown shapes as `OUTPUT_PROTOCOL_ERROR`, never success |
| R-22 | Codex event shapes and the `--sandbox read-only` spelling are unverified (`src/adapters/codex/protocol.ts`); no Codex binary was available | Misparsed events, or a sandbox flag that does not mean what the adapter assumes | Live smoke test (T2.6); the probe requires the flags in `codex exec --help` |
| R-23 | *For Ender, not blocking.* Owner decision 10 keeps Codex eligible under the untrusted profiles on its native sandbox alone. A prompt-injected Codex agent runs commands inside that sandbox, and whether they can read `~/.codex` credentials (or reach other same-user files) is unverified | Credential exfiltration through a Codex run on an untrusted repository; FR-POL-06 stays open for Codex | Recorded as unverified in the README and manifest notes (T3.14, T3.6); live canary check (T3.9); outer sandbox as optional hardening (T3.1); the operator can disable Codex (`providers.codex.enabled`) |
| R-24 | *For Ender, not blocking.* Owner decision 11 lets verification commands run on the host under `edit-untrusted`. Those commands execute code the untrusted agent just wrote (tests, build scripts) as the operator's user, outside any provider sandbox | Code from an untrusted run executes on the host with the operator's file access, including provider credential files and network | Argv only, no shell; environment allowlist; worktree cwd; timeout (T3.10); confined verification optional (T3.11); orchestrators should supply verification only for repositories they trust |
| R-25 | *For Ender, not blocking.* Owner decision 12 lets `profiles.<name>` loosen defaults. A malicious or mistaken config change can widen every run of a profile (for example shell or network for `edit-untrusted`) | Weaker isolation than the profile name suggests, applied silently to later runs | Loosening must be explicit and validated, appears in every run's policy snapshot and in `doctor` (T3.2); the config file is operator-owned |
| R-26 | *For Ender, not blocking.* Owner decision 13 allows bypass flags under an approved `privileged` scope. A bypass flag disables the provider's native approvals and some of its controls for that run, and a scope approved without careful reading grants that to an orchestrator's request | A privileged run can do whatever the provider allows without prompts, including Git writes the deny rules would otherwise block, if the provider's bypass overrides them | Bypass only when the scope sets it explicitly and the approval's scope hash matches (T3.4, T3.17); `runs show` displays the scope before `approve`; no expiry and no automatic approval; [ADR-0017](adr/0017-approved-privileged-scope-bypass.md) and [LLD §3.1](design/LLD.md#31-privileged-scope-m3) record the limits (T3.16, done) |
| R-27 | *Proposed (owner decision 14).* A cheap model writes a vague, wrong or misleading commit message or PR draft, and it enters published history | Poor history; reviewers misled | Agent text wins by default; sanitiser and non-empty check (FR-INN-10); `inner status` shows rejection rates and suspension (FR-INN-09); `never` mode; the provenance record notes the drafting source |
| R-28 | *Proposed.* Repository content or an orchestrator's request contains prompt injection aimed at the inner model | A bad draft, a misleading title or summary, or a skewed routing feature | The inner agent has no authority (FR-INN-06), no tools (FR-INN-02), validated output (FR-INN-07), and routing features cannot touch eligibility (FR-INN-12) |
| R-29 | *Proposed.* Source code or logs are sent to a `remote` inner backend that the operator or the provider may retain or train on; deterministic redaction misses a secret | Data leaves the host from the controller itself | `local`/`remote` classification, `allow_remote`, per-task `allow_source_content`, per-project `local_only`, redaction before every call, no body logging (FR-INN-16); the examples default to local |
| R-30 | *Proposed.* A condensed handoff or log summary drops or invents a fact, and the next agent or the orchestrator trusts it | Wasted work or a wrong conclusion | Additive and labelled, raw artifact pointers, statuses from records only, the next agent still inspects the repository (FR-INN-13) |
| R-31 | *Proposed.* The inner backend draws on the same subscription as a routed provider (for example a Claude Code or OpenCode login also used for coding) | Capacity estimates are blind to real consumption; the saving is lost | `shares_subscription_with` records an `inner_agent` observation and `doctor` warns (FR-INN-15) |
| R-32 | *Proposed.* Model or server churn changes output quality or format under a fixed prompt template; the `cli` kind's flags change (as R-1) | Rising fallback rates, silent quality drift | Versioned templates, per-task outcome records and suspension (FR-INN-05, 09), `inner test`; the `cli` kind is version-gated (FR-INN-04) |
| R-33 | *Proposed (owner decision 16).* Muse Code facts come from a third-party user report and an SDK crate, not Meta's documentation; the CLI self-updates hourly and its flags (`--yolo`, `-w`, `--approval-mode`), JSONL kinds, auth precedence (`META_API_KEY` first) and trust gating are unverified; exit code 0 does not mean success | A misbuilt adapter, a bypass flag emitted, or a stale fixture | Version gate and `MUSE_NO_AUTO_UPDATE=1` if confirmed (ADR-0009); `--yolo` and its parts in the argv audit; never pass `META_API_KEY`; read Meta's docs and capture `echo`-provider fixtures before M4 code; success judged by records and verification (BR-16) |
| R-34 | *For Ender, not blocking.* Owner decision 17 makes the first `privileged` approval in a meta-session durable. Per-run oversight is gone: a later `continue_task` continuation runs with the same bypass and broad privileges without the operator taking a fresh look, and the instruction it carries was never reviewed | A prompt-injected or mistaken orchestrator uses a long-lived approved meta-session for work the operator would not have approved, with provider approvals bypassed if the scope sets `bypass` | The approval is bound to one client, one meta-session and one canonical scope, so a continuation cannot widen it and any other scope or session needs a new approval ([LLD §3.1](design/LLD.md#31-privileged-scope-m3)); every covered run records the approval ID in its policy snapshot and ledger events, and `runs show` lists the runs an approval covers; the per-client ceiling is re-checked on every request (FRD C4), so lowering it stops further continuations; the operator can cancel any run; an explicit revoke command is open (Q-30) |
| R-35 | *For Ender, not blocking; mitigated 2026-10-13 (decision 27, T3.20).* A run worktree can contain a gitlink to an agent-created nested repository. Controller `status`, `diff` and `add -A` then started a child `git status` that uses that repository's own configuration, including filter drivers, which the controller's `-c` overrides do not reach (reproduced on Git 2.43.0 with a benign marker-file filter: `status`, `diff HEAD` and `add -A` each ran it; an untracked nested repository that is not yet a gitlink is not entered by `status`). Gap in the driver hardening of [TDD §3.4](design/TDD.md#34-security-engineering) | Code from an untrusted run could execute inside a controller Git call as the operator's user, outside any provider sandbox | **Mitigated** by [ADR-0022](adr/0022-nested-repositories-excluded-from-controller-git.md): nested repositories are excluded from every worktree-scanning controller Git call; evidence `src/workspace/nested.test.ts` (marker absent after `assessMutation`, `finalize` and `rollback`; positive controls show the driver runs under direct Git). Residual: files inside a nested repository are not captured in checkpoints, diffs or commits; a repository created after the scan and before the Git call is not covered (the provider process has ended by then, but this is not enforced); the scan does not cover Git calls outside `src/workspace/manager.ts` (none scan the worktree today). Not verified live: T3.8b adversarial scenarios (owner-reviewed) remain out of scope |
| R-36 | Neither the installed `claude --help` 2.1.296 nor [R2] for Codex documents a network control for commands the agent runs (T3.0, [TDD §4.1.1](design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30)). For Claude, network `off` holds only at the tool level (no `WebFetch`); any compiled `Bash` command, such as an operator's `edit-untrusted` allowlist entry, can use the network. For Codex, network `off` rests on the Assumption that the sandbox blocks it (R-22) | A run whose profile says network `off` may still reach the network through an allowed command | Q-34; T3.5 and T3.6 make network `off` with a `broad` Claude shell `Ineligible`; outer sandbox (T3.1, optional); live check T3.9 |
| R-37 | [R2] states neither the Linux host prerequisites of Codex's bubblewrap sandbox nor what Codex does when the sandbox cannot start, nor how `codex exec` handles an action that would need approval (T3.0, [TDD §4.2.1](design/TDD.md#421-codex-native-controls-per-profile-and-platform-t30)) | On some hosts Codex may fail every run, or run without the confinement decision 10 relies on; an action needing approval may hang or be handled in a way the adapter does not classify | Live check T3.9 (sandbox start, network off, approval handling); the probe and `doctor` report the prerequisites once known; run timeouts bound a hang (FR-POL-05) |
| R-38 | *For Ender, not blocking (owner decision 19).* An approved `bypass: true` Claude Code run omits `--restricted` ([ADR-0018](adr/0018-claude-bypass-omits-restricted.md)), so it loses the protections `--restricted` gives the settings files and Git files, and runs with the provider's permission bypass. Whether the `--disallowedTools` Git deny rules (FR-GIT-01) still hold under bypass is **unverified**: the live check C-G2 in `scripts/live-smoke.mjs` reports `NOT_CHECKED` today and does not run a bypass run | If the deny rules do not hold under bypass, FR-GIT-01 is not enforced in bypass runs, and only FR-GIT-03 (ref snapshot and violation detection, M9) and FR-GIT-06 (no Git credentials in the agent environment) remain; the agent could commit, or alter Git configuration, inside its worktree | Bypass only for an approved scope that sets `bypass: true` (decisions 13, 22), worktree isolation (FR-WS-05), the argv audit (T3.17); extend C-G2 to a deliberate Git write in an approved bypass run (T3.9); if it fails, make Claude bypass runs `Ineligible` again or rely on FR-GIT-03 once M9 lands. *Scope (owner decision 24, 2026-10-13):* the risk does not apply in a `container` environment (M10, planned, not built), whose image has no Git client and which mounts neither the Git directory nor any credential store (FR-PRJ-05), so FR-GIT-01 does not rest on the deny rules there (R-40 covers what remains). For host-run bypass it stays open until C-G2 records a result |
| R-39 | *For Ender, not blocking (owner decision 22, Delegated realisation).* A client configured `privileged_approval: "not_required"` gets `privileged` runs, including `bypass: true` runs, with no operator review of the scope ([ADR-0019](adr/0019-per-client-privileged-approval.md)). A prompt-injected or mistaken orchestrator on that client can start any scope it can express, at once, and continue it without limit (decision 17) | Broad, unattended privileged work on the operator's machine for anything that can reach that client's stdio session (R-9) | Off by default (`required`); refused by config validation unless the client's ceiling is `privileged`; `doctor` warns for every such client; the scope is still validated, hashed and recorded, the row names `client_policy:<client_id>`, and `runs show` lists it; Git-write denial (FR-GIT-01, subject to R-38) and worktree isolation (FR-WS-05) stay enforced; the operator can switch the client back to `required` or lower its ceiling and cancel runs |
| R-40 | *For Ender, not blocking (owner decision 24, Delegated mechanism).* Two limits of "no Git client in the container image". (1) A provider CLI may need a Git client for its own work (repository detection, status or diff context); whether each one runs without it is unverified. (2) Absence of a Git client is a property of the image, not a boundary: an agent with a shell and network (a bypass run) can fetch a Git client or write Git files directly | (1) Some providers may be usable only in `host` environments. (2) The agent can create a nested repository in its worktree (which the controller's host-side Git calls would then meet, R-35), but cannot reach the operator's refs or credentials, because the Git directory and credential stores are not mounted (FR-PRJ-05) | (1) T10.0 checks each provider and marks one that needs Git `host`-only. (2) The no-Git-client check is for the image as supplied (T10.1); FR-GIT-01 in containers rests on the mounts, with FR-GIT-03 detection kept; the nested-repository default of Q-31 applies; container leg of the malicious-fixture suite (T10.3) |
| R-41 | *For Ender, not blocking (owner decision 26, Delegated realisation).* An approved bypass run with `repository_config` `approved` or `enabled` loads repository content: instruction files, skills, plugins and hooks (no `--safe-mode`), and for `enabled` the repository's MCP definitions (no `--strict-mcp-config`), on top of the provider's permission bypass and the absent `--restricted` (R-38). Whether omitting those flags loads exactly those items is **unverified**: `claude --help` 2.1.296 does not say, and the live check is not yet written (T3.9) | Hostile or mistaken repository content (a hook that runs a command, an MCP server, instructions that steer the agent) executes or steers with the operator's permissions and without prompts; Ender accepts this for his own workloads | Only for an approved scope that sets `bypass: true` and `repository_config` `approved` or `enabled` (decisions 13, 22, 26); `approved` keeps `--strict-mcp-config`; Git-write denial (FR-GIT-01, subject to R-38), worktree isolation (FR-WS-05) and the argv audit (T3.17) unchanged; extend the T3.9 live check to a bypass run in a fixture repository with a hook, an instruction file and an `.mcp.json`; if the flags do not behave as assumed, make these cells `Ineligible` again |
| R-42 | *Delegated, not blocking; mitigated 2026-10-13 (decision 28).* Retention GC's `serve` interval pass was not excluded from `continue_task`: a meta-session idle past `retention.days` is chosen by the ledger query, and a `continue_task` admitted while that unit was being collected could find its worktree, checkpoint branches or artifacts gone. The startup pass cannot race it (it runs before MCP accepts calls) | Rare (needs a continuation of a session idle for the whole retention period, within one unit's collection window); before the fix the continued run failed or started from a missing checkpoint | **Mitigated:** GC marks first. `ledger.beginGc` re-checks idleness and sets `ARCHIVED` in one `BEGIN IMMEDIATE` transaction before any removal, so a session with a newly admitted run is skipped; admission refuses an `ARCHIVED` meta-session (`INVALID_REQUEST`, in validation and again inside the admission transaction); a marked but unfinished session rolls forward on the next pass. Evidence: `src/workspace/gc.test.ts`, `src/lifecycle/lifecycle.test.ts` (see T3.12). Residual: a refused client sees `INVALID_REQUEST` and must start a new task (a collected session cannot be continued by design); no process-level test of two real processes racing (SQLite serialises the two transactions) |
| R-43 | *Delegated, not blocking; mitigated 2026-10-13 (T9.0 follow-up), matcher normalisation still unverified.* The Claude Git deny rules (`Bash(git <verb>)`, `Bash(git <verb> *)`) are lexical and list the subcommand directly after `git`. Git accepts global options before the subcommand: on Git 2.43.0 `git --no-pager commit`, `git -P commit` and `git --no-optional-locks commit` each created a commit in a test repository, and `--config-env`, `--exec-path`, `--namespace` and `--bare` are not denied either. `GIT_WRITE_SUBCOMMANDS` also lacks ref-affecting `reflog`, `pack-refs`, `gc`, `prune` and `maintenance` (`git pack-refs --all` and `git reflog expire` ran). Whether Claude's matcher normalises global options is unverified | A Claude run with a shell could still commit while the rules look complete; FR-GIT-01 on a host would rest on FR-GIT-03 detection and the layer 3 guard | **Mitigated (2026-10-13):** `src/adapters/git-write.ts` adds `GIT_GLOBAL_OPTIONS_WITH_VALUE` and `GIT_GLOBAL_FLAGS` (every global option in the Git 2.43.0 usage text: `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`, `--exec-path`, `--attr-source`, `-p`, `-P`, `--paginate`, `--no-pager`, `--no-optional-locks`, `--literal-pathspecs`, `--glob-pathspecs`, `--noglob-pathspecs`, `--icase-pathspecs`, `--no-replace-objects`, `--bare`) and the write subcommands `reflog`, `pack-refs`, `gc`, `prune`, `maintenance`, `repack`, `hash-object`; the Claude adapter emits `Bash(git <opt> *)` (and `Bash(git <opt>=*)` for long value options) for each, keeping the existing rule syntax; this only denies more and applies in bypass runs too (decision 22). Evidence: tests in `src/adapters/git-write.test.ts` and `src/adapters/claude/claude.test.ts`; behaviour probed on Git 2.43.0 in a throwaway repository (each listed option except `--bare` let `git branch` create a ref; each listed subcommand changed refs, packed-refs, reflogs or objects). `add`, `rm`, `mv`, `restore` and `clean` change the index or work tree only and are not FR-GIT-01 writes. **Still unverified:** whether Claude's matcher normalises global options (the help text does not say), so the explicit spellings are denied as belt and braces; a spelling not in the Git 2.43.0 usage text (a newer Git option) is not denied by the Claude rules; run the live check C-G2 (T3.9). The layer 3 guard (TDD §3.10) blocks the `-c`-less cases via the environment |
| R-44 | *Delegated, not blocking; mitigated 2026-10-13 (decision 30, ADR-0023).* `MIN_GIT_VERSION` was 2.30 but `scrubbedGitEnv()` sets `GIT_CONFIG_GLOBAL=/dev/null`, which the Git 2.32.0 release notes introduce; on 2.30 or 2.31 the controller's Git calls might read the operator's global configuration (inferred from the notes; no such Git is installed to test) | A controller call could pick up an operator alias, identity, hook path or filter on an old Git that `doctor` accepts | **Mitigated:** floor raised to 2.32 (Q-39 decided; [ADR-0023](adr/0023-minimum-git-version-2-32.md); `src/workspace/git.ts`, `doctor` and the version-gate test). The 2.32 introduction version still rests on the release notes |

Numbering: R-36, R-37 and Q-32 to Q-35 (§7.3) were written on the M3 wave B branch as R-29, R-30 and Q-27 to
Q-30. PR #17 merged all but Q-30 into main under those numbers, which main already used for other items; they were
renumbered on 2026-10-13 when main was merged back into that branch. Main's own R-29, R-30 and Q-27 to Q-30 keep
their meaning.

### 7.2 Blockers

| ID | Blocker | Blocks | Unblocked by |
| --- | --- | --- | --- |
| B-1 | Kimi Code's current automation contract is not pinned | FR-ADP-09 | Moonshot documentation or a validated installed version |
| B-2 | *Resolved by delegation, 2026-10-12 (Proposed):* a rootless runtime and an in-volume native login, to be verified by T10.0. Ender left Q-6 to the agent; he has not approved the mechanism. | M10 (FR-PRJ-05, 07, 09) | T10.0 findings |

No blocker affects M1, M2 or M9.

### 7.3 Open questions for Ender (not blocking M2 unless noted)

| ID | Question | Default in force |
| --- | --- | --- |
| Q-1 | *Answered 2026-10-12:* built for Ender, published open source for others (owner decision 4). | — |
| Q-2 | *Answered 2026-10-12:* all seven held; Claude Code and Codex first (owner decision 5). | — |
| Q-3 | Do you prefer a language other than TypeScript? | TypeScript (ADR-0010); cheapest to change before M1 |
| Q-4 | Which orchestrator will you use first? | Any stdio MCP client (A-4) |
| Q-5 | `QUEUE_FULL` (bounded queue, FR-CAP-04) has no entry in the [LLD §4](design/LLD.md#4-failure-taxonomy) taxonomy. **Resolved for M2 (Proposed, Delegated; not owner-approved):** MCP maps it to `ELIGIBILITY_NONE` with `details.reason = "QUEUE_FULL"` (`src/mcp/mcp.test.ts`, "a full ingress queue maps to ELIGIBILITY_NONE with reason QUEUE_FULL"). A dedicated code needs an [LLD §4](design/LLD.md#4-failure-taxonomy) and [SRS](requirements/SRS.md) decision first | `ELIGIBILITY_NONE` with `details.reason` `QUEUE_FULL`; internal `LifecycleError` code stays `QUEUE_FULL` |
| Q-6 | *Answered by delegation 2026-10-12 ("the rest you pick"):* a rootless OCI-compatible runtime, and the operator runs each provider's native login once inside the project's container volume (TDD §3.11). Not an owner decision. | — |
| Q-7 | *Answered 2026-10-12:* yes (owner decision 8). Gating delegated (FR-PRJ-10). | — |
| Q-8 | *Answered by delegation 2026-10-12 ("the rest you pick"):* the operator's own Git identity, copied explicitly into each context's configuration (TDD §3.10). Not an owner decision. | — |
| Q-9 | *Answered 2026-10-12:* yes (owner decision 9), read as push allowed and signing wanted. Push stays off until a context enables it; publish ref only, never the default branch; signing is controller-side (FR-GIT-10). | — |
| Q-10 | Codex auth preflight returns `UNKNOWN` because no status command is documented (R2, TDD §4.2), so Codex runs are `ELIGIBILITY_NONE` until a status mechanism is verified. Which mechanism should be used, if any? | Ineligible (fail closed, NFR-SEC-06); a structured auth error mid-run still ends `AUTH_REQUIRED` |
| Q-11 | *Profile part answered 2026-10-12 by owner decision 10: Codex stays eligible for `inspect-untrusted` and `edit-untrusted` on its native sandbox; the model-flag part stays open.* Codex has no documented shell allowlist or model flag in the adapter's sources, which may conflict with FR-POL-02 (and the model constraint). Settle whether Codex meets FR-POL-02 or is limited to read-only profiles | Adapter compiles only what it can express and returns `Ineligible` otherwise; to settle in M3 |
| Q-12 | The Codex manifest range is empty, so every Codex binary is `ADAPTER_VERSION_UNVERIFIED`. Which `codex --version` will the operator validate? | Fail closed until the operator records one (T2.1 note, `adapters validate`) |
| Q-13 | Are the Claude and Codex assumptions in R-21 and R-22 correct on real CLIs? | Unconfirmed; the opt-in live smoke test (T2.6) must confirm or correct each, and the fixtures and TDD §4.1–4.2 are updated with the result |
| Q-14 | *Decided 2026-10-13 by [Delegated decision 29](#42-owner-decisions) under owner decision 25 (not owner-approved):* NFR-PERF-02 becomes task T3.21 (M3, §6.5), implemented. Original question: NFR-PERF-02 (Must, M2: cache adapter preflight, invalidate on binary version change or a configurable TTL) was unimplemented and no task owned it; should it become a task, and in which milestone? | None. The 60 s default TTL is an Assumption (§4.5 style); revisit after a live probe-cost measurement |
| Q-15 | When a run in AWAITING_APPROVAL is cancelled (FRD §4.3 "approval record closed as not granted"), which `approval.status` is written? The schema allows `PENDING`, `APPROVED`, `DENIED`, `EXPIRED`; WF-7 says there is no expiry. A distinct `CANCELLED` status needs a forward migration | **Proposed:** `DENIED`, with the cancel and who requested it recorded in a `run_event`; no migration (T3.4). Implemented as this default in T3.3: `decided_by` is `cancel_run` (MCP) or the requesting OS user (`runs cancel`), plus an `approval_closed` event |
| Q-16 | Does FR-POL-06 ("untrusted profiles") cover `test-sandboxed`, or only `inspect-untrusted` and `edit-untrusted`? | Treated as covering `test-sandboxed` (fail closed): Claude stays `Ineligible` for it until confinement is shown (R-10, T3.5) |
| Q-17 | SRS §3.3 leaves profile contents unspecified: which build and test commands and which network hosts `test-sandboxed` allows; what "broader shell" and "policy-based" network mean for `trusted-development`; and the mechanism for "controller-approved" and "allowlisted" repository configuration | Conservative Proposed defaults in T3.2 (empty allowlists, network off), recorded in TDD §3.1; operators widen them through `profiles.<name>` (decision 12) |
| Q-18 | What is the retention (GC) unit: a terminal run, or a whole meta-session idle past the retention period? Collecting single runs can break a meta-session's checkpoint chain | *Decided 2026-10-13 by [owner decision 25](#42-owner-decisions) (Delegated, best practice; no bypass effect), recorded as decision 28:* a whole idle meta-session (implemented in T3.12). Not owner-approved |
| Q-19 | NFR-DATA-01 says events have configurable retention, but `run_event` is append-only by trigger (ADR-0005) and is the audit record. Should NFR-DATA-01 be amended to keep events, or should GC delete events through a migration that relaxes the trigger? | *Decided 2026-10-13 by [owner decision 25](#42-owner-decisions) (Delegated, best practice; no bypass effect), recorded as decision 28:* keep `run_event` rows (append-only audit, ADR-0005); NFR-DATA-01 amended in the SRS with a dated note: retention applies to worktrees, controller branches and artifact files, not events. Not owner-approved |
| Q-20 | A provider process that calls `setsid` leaves the process group the supervisor kills, and R-12 already leaves a crash window before the `pid` is recorded. Should M3 add a launcher or cgroup-based tracking? | Not in M3's task list; process-group kill and startup reconciliation only (R-12) |
| Q-21 | Where may live canaries be placed for T3.9: only in a temporary `HOME` and worktree the test creates, or also beside the real provider credential directories, which would test confinement more faithfully but touches the operator's real home? | **Proposed:** temporary locations only; checks needing real credential paths report `NOT_CHECKED` |
| Q-22 | Should an outer sandbox (bubblewrap or similar, T3.1) become a required host dependency for some profiles, or stay optional? | Optional hardening (decisions 10 and 11); nothing requires it |
| Q-23 | *Answered 2026-10-13:* no. Hosted-model keys stay outside Switchboard (local gateway or the `cli` kind), as proposed (owner decision 15). | — |
| Q-24 | *Answered 2026-10-13:* M11 after M9, core, `http` backend and commit-message task first, as proposed (owner decision 15). | — |
| Q-25 | *Answered 2026-10-13:* `draft_if_missing` with the agent's text winning; PR drafts are Should and off unless enabled, as proposed (owner decision 15). | — |
| Q-26 | *Answered 2026-10-13* by taking the proposal: the `cli` kind stays Should and `Ineligible` until the T11.0 spike verifies a tool-free one-shot (owner decision 15). The technical question itself is still open. | — |
| Q-27 | *Partly answered 2026-10-13:* Ender said Muse Code is "not a must yet", so FR-ADP-12 stays `Should` (owner decision 16). Still open: does Ender hold Meta access, and by which login (device-code `muse login`, or an API key, which Switchboard cannot pass)? | `Should`, M4; no adapter work depends on it before M4 (FR-ADP-12) |
| Q-28 | *Answered 2026-10-13 by delegation (Ender: "pick the best choice"):* the `privileged_scope` dimensions are machine-readable (closed enums plus argv-exact command and host lists), compiled by adapters into native controls, `Ineligible` where a provider cannot express a dimension ([LLD §3.1](design/LLD.md#31-privileged-scope-m3); Delegated decision in §4.4, not an owner decision). | — |
| Q-29 | *Answered 2026-10-13:* yes, within the approved scope (owner decision 17, "initial privileged approval lasts forever"). A continuation of a meta-session with an `APPROVED` approval may resolve `privileged` and takes the approved scope as is ([FRD C7](requirements/FRD.md#72-continue_task)); the earlier Proposed default (refuse) is withdrawn. | — |
| Q-30 | Owner decision 17 makes an approval durable with no automatic revocation (R-34). Does the operator need a way to **revoke** a durable approval, so that later runs of that meta-session stop resolving `privileged`? The `approval` table changes only from `PENDING` (LLD §1), so a revoke needs either a new status and a forward migration that relaxes the trigger, or a sibling revocation record | **Proposed (not implemented, no task yet):** a `revoke <run_id>` operator command (the run that requested the approval) that appends an `approval_revoked` `run_event` to that run; the lifecycle checks for it at admission and dispatch and treats a revoked approval as absent (`INVALID_REQUEST` for a new continuation, `PERMISSION_BLOCKED` before spawn for a queued one); no schema change. Until Ender decides, an approval can be stopped only by lowering the client's ceiling or by cancelling runs |
| Q-31 | Nested repositories in a run worktree: a gitlink to an agent-created nested repository makes controller `status`/`diff`/`add -A` start a child `git status` that runs that repository's own filter drivers (reproduced on Git 2.43; `diff.ignoreSubmodules=dirty` covers status/diff but not `add -A`). How should the controller neutralise this: refuse or quarantine nested `.git` directories in a run worktree, enumerate nested configs, or pass `--ignore-submodules` everywhere and accept weaker change detection? See R-35 | **Answered/decided 2026-10-13 ([decision 27](#42-owner-decisions), Delegated agent decision under owner decision 25, not an Ender quote).** Not "fail the run": exclude nested repositories from every controller Git call that scans the worktree, record a non-fatal warning per skipped path, accept weaker change detection inside nested repositories. [ADR-0022](adr/0022-nested-repositories-excluded-from-controller-git.md), T3.20, R-35 |
| Q-32 | *Still open after 2026-10-13 (checked against owner decisions 10 and 21):* decision 10 covers `inspect-untrusted` and `edit-untrusted`, decision 21 covers `trusted-development`; neither names `test-sandboxed`, so this question is not answered and its default stays. Owner decision 10 accepts Codex's native sandbox for `inspect-untrusted` and `edit-untrusted`. Does it also cover `test-sandboxed`, where Codex cannot limit commands to build and test commands (no documented allowlist, Q-11) and FR-POL-06 is read as applying (Q-16)? ([TDD §4.2.1](design/TDD.md#421-codex-native-controls-per-profile-and-platform-t30)) | **Proposed (Delegated):** not covered, fail closed: Codex stays `Ineligible: PROFILE_UNSUPPORTED` for `test-sandboxed` until answered, or until T3.9 records `HELD` for Codex credential confinement |
| Q-33 | *Answered 2026-10-13 by owner decision 19:* for an approved `bypass: true` run the Claude adapter omits `--restricted` and keeps the other isolation flags, rather than making the run `Ineligible` ([ADR-0018](adr/0018-claude-bypass-omits-restricted.md); residual risk R-38). The earlier Proposed default (`Ineligible`) is withdrawn. Original question: the installed `claude --help` says `--restricted` "refuses bypassPermissions"; should T3.5 make such a run `Ineligible`, or drop `--restricted` and lose its settings-file and Git-file protections? | — |
| Q-34 | *Decided 2026-10-13 by [owner decision 25](#42-owner-decisions) (Delegated, best practice; no bypass effect):* tool-level network `off` stays acceptable with an explicit allowlist and is described as "tool level only"; a `broad` Claude shell with `off` stays `Ineligible: CAPABILITY_MISSING`; revisit after T3.1 or T3.9. Original question: with no documented network control for agent-run commands (R-36), should a profile with network `off` be `Ineligible` whenever any shell command is compiled, or is tool-level `off` enough until T3.1 or T3.9? | — |
| Q-35 | T3.7 needs a host-platform rule for profiles, but the per-profile matrices ([TDD §4.1.1](design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30), [TDD §4.2.1](design/TDD.md#421-codex-native-controls-per-profile-and-platform-t30)) evaluate Linux only. Which profiles are "sandbox-dependent", and so `Ineligible` on a host whose cells are unverified? | **Proposed (Delegated, fail closed):** all five (`SANDBOX_DEPENDENT_PROFILES` in `src/routing/eligibility.ts`), so on macOS and Windows no profile is eligible and `list_capabilities` lists none (`PROFILE_PLATFORM_UNVERIFIED` → `ELIGIBILITY_NONE`); M4 (NFR-PORT-02) narrows the set per verified cell |
| Q-36 | *Answered 2026-10-13 by [owner decision 23](#42-owner-decisions) ("Refuse network off at tool level"):* a Claude Code privileged network `off` (or `allowlist`) stays `Ineligible: CAPABILITY_MISSING`, as implemented; `list_capabilities` still lists `privileged` for Claude through a network `on` scope ([LLD §3.1](design/LLD.md#31-privileged-scope-m3) "Listing"). Original question: T3.5 compiles a Claude Code `privileged` scope only with network `on`, because `claude --help` 2.1.296 has no network or host control (R-36); should a privileged network `off` be accepted at the tool level instead (no `WebFetch`, as `inspect-untrusted` and `edit-untrusted` do, Q-34), knowing that any compiled shell command can still reach the network? | — |
| Q-37 | A `privileged` scope with `repository_config: enabled` (all repository hooks, MCP definitions and instructions loaded) is refused by both adapters: Claude would need to drop `--safe-mode` as well as `--restricted`, and Codex documents only all-or-nothing switches (T3.5, T3.6). Should `enabled` be compilable for approved scopes, in line with owner decision 18 (loose bypass runs)? | **Answered 2026-10-13 by [owner decision 26](#42-owner-decisions)** ("bypass mode allow all agents to make the changes"): `approved` and `enabled` compile in an approved bypass run (Claude: no `--safe-mode`; `--strict-mcp-config` kept for `approved`, omitted for `enabled`); unchanged elsewhere. Codex stays refused until its bypass is documented. Claude flag behaviour **unverified** (R-41, T3.9). Original default: refused (`Ineligible`) for both providers; `approved` also refused (no per-item control documented) |
| Q-38 | *Decided 2026-10-13 by [owner decision 25](#42-owner-decisions) (Ender: "you pick"; Delegated):* the order stays M3, M9, M10 (M10 needs the M9 projects and injected tools), and the document-only spike T10.0 may start early. Original question: should M10 be brought forward ahead of M9's remaining work (T9.7, T9.9, T9.10)? | — |
| Q-39 | *Decided 2026-10-13 by [Delegated decision 30](#42-owner-decisions) under owner decision 25 (not owner-approved), [ADR-0023](adr/0023-minimum-git-version-2-32.md): 2.32.0.* Original question: Raise `MIN_GIT_VERSION` from 2.30 to 2.32? Reasons: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` (2.32.0 release notes) are already used by `scrubbedGitEnv()`; the layer 3 guard needs `GIT_CONFIG_COUNT` (2.31, inferred from the 2.31.0 notes). It changes the stated floor of the technology stack, so AGENTS.md requires an ADR | **Decided:** yes, 2.32.0. `MIN_GIT_VERSION`, its test, README and TDD updated; `doctor` reads the constant |
| Q-40 | *Proposed ADR, not written (T9.0 finding; Delegated).* ADR-0015 says the Claude adapter never emits `--mcp-config`, and `src/adapters/audit.ts` and `claude.test.ts` enforce it; FR-GIT-02's injected channel needs it. May the adapter emit `--mcp-config` carrying only the controller-generated shim definition, always with `--strict-mcp-config`, while operator and repository definitions stay barred? This touches a trust boundary and an accepted ADR | **Proposed:** yes, narrowly, after the live check shows `--safe-mode` and permissions allow the shim (R-18). Until then no Claude channel is declared |

## 8. Deferred and excluded work

| Item | Status | Reason | Requirement |
| --- | --- | --- | --- |
| Read-only usage dashboard | Deferred | Allowed by C-2 but not needed to deliver outcomes | FR-TEL-04 |
| Upstream ACP server | Deferred | MCP satisfies C-7 | ADR-0002 |
| Learned (contextual-bandit) routing | Deferred | Needs outcome data | FR-RTE-05 |
| OpenCode persistent `serve`/`attach` transport | Deferred | `opencode run` suffices first | FR-EXE-04 |
| Native Windows host | Deferred | Linux first | NFR-PORT-03 |
| HTTP/SSE MCP transport | Deferred | stdio fits local use | ADR-0002 |
| Automatic merge of result branches | Deferred | Needs judgement | ADR-0006 |
| Multi-user or hosted operation | Excluded | Compliance and credential risk | ADR-0011 |
| Context kinds other than `repository`; remote-clone contexts; multiple writable contexts in one run | Deferred | Not asked for yet; the schema is extensible | FR-PRJ-02 |
| Rewriting attribution inside file contents | Excluded | Out of the commit boundary; the controller does not edit what agents write | FR-GIT-04, R-14 |
| Model-assisted secret or PII redaction (inner agent) | Deferred | A miss is a silent leak and sending content to find secrets is itself exposure; deterministic redaction stays the control. Revisit as an add-only advisory pass on a `local` backend | FR-INN-18 |
| Inner agent exposed to orchestrators as a tool | Excluded | Makes Switchboard a model proxy and widens TB-1; no requirement behind it | ADR-0016 |
| Inner-agent tasks IT-10 to IT-14 (prompt rewriting, test selection, diff pre-review, commit splitting, changelogs) | Deferred or excluded | Each changes intent, verification or authority, or has no requirement; see [PRD §3.1](requirements/PRD.md#31-inner-agent-task-catalogue) | — |

## 9. Next actionable milestone

**Close M2, then M3.** M2 is `Partial` (§6, §6.2). Its code and documentation are in place; the remaining work needs the
operator or Ender, in this order:

1. **Operator live smoke run.** Run `SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live` (and
   `codex`) with native logins. Record which assumptions held; correct the fixtures, TDD §4.1 to §4.2, R-21, R-22,
   Q-10 and Q-13 with the result.
2. **Codex version (Q-12).** Record a real `codex --version` in the Codex manifest range. There is no command for this
   yet (`adapters validate` is M4), so it is a reviewed manifest edit that must follow a passing live check.
3. **NFR-PERF-02 (Q-14).** Decided and implemented as T3.21 (Delegated decision 29, 2026-10-13); Ender may revise the
   60 s TTL default or the successes-only rule.
4. Re-run `doctor` on a machine with a provider installed and update the "Blocks Done" list in §6.2.
5. **Git write denial (FR-GIT-01).** Argv check done (T2.2 row; Delegated agent work, 2026-10-12). What remains is
   the live confirmation in step 1 (checks G-1, C-G2, X-G1) and the M9 detection layer (FR-GIT-03).

**M3 Isolation is planned** (§6.5, 2026-10-12; owner decisions 10 to 13 and 17 in §4.2). Every remaining M2 item above needs
the operator or Ender, so agent work proceeds meanwhile on M3 **wave A** (§6.5.1), none of which needs a live provider:
T3.0 (native-controls spike), T3.1 (outer-sandbox evaluation), T3.2 (profile defaults and config keys), the BR-3
mapping part of T3.7, T3.8 (controller-side malicious-fixture invariants) and T3.12 (GC algorithm). T3.14 (README
Codex correction) and T3.16 (privileged scope contract in [LLD §3.1](design/LLD.md#31-privileged-scope-m3) and
[ADR-0017](adr/0017-approved-privileged-scope-bypass.md)) are done, so T3.17 (argv audit) and, after T3.2, T3.3 can
start. No code that emits a bypass flag lands before T3.17. Open M3 questions for Ender: Q-15 to Q-22 and Q-30 (Q-31
was decided by decision 27; Q-28 and Q-29 were answered on 2026-10-13, Q-33 by decision 19); residual risks of decisions
10 to 13, 17, 19 and 22: R-23 to R-26, R-34, R-38 and R-39; R-35 (the nested-repository gap) is mitigated by T3.20. T3.18
(decisions 19 and 22 in the controller) is done.
Notes carried from M2:

- **`QUEUE_FULL`** maps to `ELIGIBILITY_NONE` with a reason (Q-5, Proposed); a dedicated code needs an LLD §4 and SRS
  change.
- **Idempotency keys** apply to new meta-sessions only (FRD §7.2 C6); `continue_task` rejects a key.
- **Compile-time `Ineligible`** in the lifecycle ended `PERMISSION_BLOCKED` (§6.2.1); fixed by T3.7 (2026-10-13), which
  maps it to the BR-3 code.
- M1 `Partial` requirements in §6.1.1 (arm64 CI, secret scan beyond artifacts) remain open, as does NFR-SEC-04 for `serve`.
- M9 (projects and the injected commit and push tools) follows M3 and is sequenced before M4; M10 (container
  environments, the route to bypass without Git risk, owner decision 24) follows M9 (Q-38 decided, owner
  decision 25).

### 9.1 How an agent picks up work

1. Read [AGENTS.md](../AGENTS.md), then this roadmap's §6 to find the first milestone whose status is not `Done`. A
   `Partial` milestone is closed from its "Blocks Done" list before the next one starts, unless every remaining item
   needs the operator or Ender; agents then work on the next milestone's tasks that do not depend on those items (as M3
   wave A does while M2 waits for the live smoke run).
2. Take the first task in that milestone's task table whose dependencies are done. If the milestone has no task table
   yet (M4 onward), break it into tasks in the same format first, from its row in §6 and the requirements it lists, and
   add them here before coding.
3. Read every reference in the task row: the SRS requirements, the FRD workflow or rule, the LLD/TDD section and the
   ADRs. Those are the contract; this roadmap only sequences them.
4. Implement with tests that prove the task's "Done when" checks and the cited requirements' verification method.
5. In the same change, update the task's status here with evidence, and fix any document the work proved wrong (or add
   an ADR if an architectural decision changed).
6. Run `node scripts/check-docs.mjs` and the test suite before opening the pull request.

## 10. Keeping this roadmap current

- Change status in §6 in the same change as the work, with evidence.
- New scope goes through the PRD and SRS first, then gets a milestone here.
- A conflict between documents is resolved in favour of the owner named in §5, and the losing document is corrected in
  the same change.
