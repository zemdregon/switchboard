# ADR-0013: Projects own environments and contexts

- Status: Accepted (the concept); container details are Proposed until Q-6 and Q-7 are answered
- Date: 2026-10-12
- Decided by: Ender (projects as first-class, an environment plus contexts, environments likely containers; message of
  2026-10-12). Delegated (agent, 2026-10-12) for the mechanism: config-defined projects, two environment kinds, the
  ceiling rule and milestone placement.
- Related: FR-PRJ-01–09, FR-WS-01–02, FR-POL-06, FR-POL-10, FR-MCP-06, [ADR-0004](0004-trust-profiles-no-bypass-flags.md),
  [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md), [ADR-0011](0011-single-operator-local-deployment.md)

## Context

Until now a delegation named a bare `workspace_path`. Ender wants Switchboard to manage *projects*: the environment the
coding agents operate from, likely a container of some kind, and the *contexts* of that project, such as repositories.
A bare path says nothing about where the agent runs, which repositories belong together, or what ceiling applies to a
given body of work, and it gives the orchestrator no stable thing to refer to.

Two existing constraints matter. [R2] reports that a dedicated OS user does not isolate provider credentials from a
same-user agent shell, so an outer sandbox is an open evaluation ([TDD §3.4](../design/TDD.md#34-security-engineering),
risk R-8, R-10). And FR-AUTH-01 forbids moving credentials between identities or machines, which a container environment
could be tempted to do to give the provider CLI its login.

## Decision

- A **project** is a named, operator-defined unit with one **environment** and one or more **contexts**. Projects are
  defined in the schema-validated configuration (not created by the orchestrator in this decision) and snapshotted into
  every run's policy snapshot. The ledger stores only the project ID on meta-sessions and runs.
- **Environment kinds:** `host` (today's behaviour: the provider process runs directly on the operator's machine under
  its native sandbox) and `container` (the provider process runs in a controller-managed container that mounts only the
  run's worktree and declared read-only contexts). `host` ships first; `container` follows once the runtime and the
  provider-login question are settled.
- **Context kinds:** only `repository` (a local Git repository under an allowed root). The schema is extensible; an
  unknown kind fails validation.
- **Relationships.** The workspace manager still creates one worktree per write-capable run and owns the lease
  ([ADR-0006](0006-worktree-checkpoints-no-blind-replay.md)); the project supplies the repository, base ref and
  environment, and a container mounts the worktree. A meta-session belongs to one project for its whole life. A project
  may cap the trust profile and the providers; the effective ceiling is the lower of the client's and the project's
  ([ADR-0004](0004-trust-profiles-no-bypass-flags.md)). A container never relaxes a profile by itself: it can make an
  adapter eligible for a profile only if its manifest declares credential confinement in container mode and the
  malicious-fixture suite passes (FR-POL-02, FR-POL-06).
- The orchestrator references projects (`delegate_task` takes a project, `list_projects` lists them) but cannot create or
  edit them.

## Alternatives considered

- **Projects as a label over `workspace_path`.** Rejected: no environment, no ceiling, and nothing to hang container
  isolation on.
- **Projects created and destroyed by the orchestrator over MCP.** Deferred (open question Q-7): creating a project can
  mount host paths and start containers, which is a trust-boundary crossing the current MCP client ceiling does not cover.
- **Always run in a container.** Rejected for now: provider logins live in each CLI's own store, and getting them into a
  container without the controller copying credentials is unresolved (Q-6).
- **Rely only on provider-native sandboxes.** Kept for `host`; the container kind exists because [R2] reports uneven
  native sandboxing (Claude Code has none documented).

## Consequences

- Configuration grows a `projects[]` section and each MCP client entry gains a project allowlist.
- A new component, the Project Manager (COMP-PRJ), owns project resolution and, in M10, the container lifecycle.
- Container orphans become a reconciliation concern (FR-PRJ-07), and per-run container limits partly answer risk R-8.
- Open: which container runtime, whether the provider CLI is installed inside the image, and how a native login reaches
  it (for example the operator running the native login command inside a per-project volume). Container work (M10) is
  gated on these.

## Revisit when

Q-6 or Q-7 is answered, or an orchestrator needs to create projects at run time, or a second context kind is wanted.
