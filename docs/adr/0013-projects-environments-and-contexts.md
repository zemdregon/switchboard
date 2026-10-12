# ADR-0013: Projects own environments and contexts

- Status: Accepted (the concept and orchestrator-managed projects); the container mechanism is Proposed (Delegated)
- Date: 2026-10-12
- Decided by: Ender (projects as first-class, an environment plus contexts, environments likely containers; message of
  2026-10-12). Delegated (agent, 2026-10-12) for the mechanism: config-defined projects, two environment kinds, the
  ceiling rule and milestone placement. Ender answered Q-7 "yes" (2026-10-12): the orchestrator may create and change
  projects over MCP; the gating below is Delegated. Ender left Q-6 to the agent ("the rest you pick"): the container
  runtime and login mechanism below are Delegated and Proposed.
- Related: FR-PRJ-01–10, FR-WS-01–02, FR-POL-06, FR-POL-10, FR-MCP-06, [ADR-0004](0004-trust-profiles-no-bypass-flags.md),
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

- A **project** is a named, operator-defined unit with one **environment** and one or more **contexts**. Operator
  projects are
  defined in the schema-validated configuration; *dynamic* projects are created by an orchestrator over MCP (below).
  Both are snapshotted into every run's policy snapshot. The ledger stores the project ID on meta-sessions and runs, and
  append-only `project_revision` rows for dynamic projects.
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
- **Orchestrator-managed projects (Q-7: yes).** A client entry with `manage_projects` (default off) may call
  `create_project`, `update_project` and `delete_project` for dynamic projects. It can never touch configured projects.
  The limits are the client's own: paths under allowed roots, ceiling, providers and push policy no wider than its entry
  (`max_push_policy`, default `none`). A `container` environment, any push policy, and any widening stay
  `PENDING_APPROVAL` until the operator approves on the CLI; the approval has no MCP path. Dynamic projects are visible
  only to their creator and the operator, and every call is recorded. This keeps the trust-boundary crossing (mounting
  paths, starting containers, granting push) under the operator's control.
- **Container runtime and logins (Q-6, Delegated, Proposed).** A rootless OCI-compatible runtime (rootless Podman is the
  likely candidate; unverified), driven through its CLI behind the environment port. Provider logins are done by the
  operator running the provider's own login inside the project's container volume once; the controller copies nothing
  (FR-AUTH-01). M10 is unblocked on that basis, with a spike to verify it for each provider.

## Alternatives considered

- **Projects as a label over `workspace_path`.** Rejected: no environment, no ceiling, and nothing to hang container
  isolation on.
- **Orchestrator creates projects with no approval step.** Rejected: creating a project can mount host paths, start
  containers and grant push, which the client ceiling alone does not cover. Hence the approval gate above.
- **Always run in a container.** Rejected for now: provider logins live in each CLI's own store, and getting them into a
  container without the controller copying credentials is only a Proposed mechanism, to be verified in M10.
- **Rely only on provider-native sandboxes.** Kept for `host`; the container kind exists because [R2] reports uneven
  native sandboxing (Claude Code has none documented).

## Consequences

- Configuration grows a `projects[]` section and each MCP client entry gains a project allowlist.
- A new component, the Project Manager (COMP-PRJ), owns project resolution and, in M10, the container lifecycle.
- Container orphans become a reconciliation concern (FR-PRJ-07), and per-run container limits partly answer risk R-8.
- Still to verify in the M10 spike: that the rootless runtime fits the host, that the provider CLI can live in an
  operator-pinned image, and that each provider's native login works inside the volume and is acceptable under its terms
  (R-2).

## Revisit when

The M10 spike contradicts the rootless-runtime or in-volume-login choice, an orchestrator needs approval-free project
creation, or a second context kind is wanted.
