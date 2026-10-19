# ADR-0020: Container images contain no Git client

- Status: Accepted (the rule); the runtime and login mechanism in ADR-0013 were Proposed until the T10.0 spike and are
  Accepted since 2026-10-18 (operator results; no provider needed a Git client, none marked `host`-only)
- Date: 2026-10-13
- Decided by: zemdregon (owner decision 24: "since we are containerizing, we could simply not include a git tool, then git
  is handled by switchboard on the host"; asked for this ADR in owner decision 25). The checks and failure behaviour
  below are Delegated (agent, 2026-10-13) and not owner-approved.
- Related: FR-PRJ-04, FR-PRJ-05, FR-GIT-01 to FR-GIT-09, FR-AUTH-01, [TDD §3.11](../design/TDD.md#311-container-environments),
  [ADR-0013](0013-projects-environments-and-contexts.md) (amended), [ADR-0014](0014-tool-only-commits-and-publication.md),
  [ADR-0017](0017-approved-privileged-scope-bypass.md), ROADMAP R-38, R-40, T10.0, T10.1, T10.3

## Context

Approved bypass runs (ADR-0017) let an agent act without permission prompts, which is zemdregon's main usability goal.
On a host, Git-write denial depends on provider deny rules that are unverified under bypass (R-38). In a container, the
guarantee can hold by construction: an agent with no Git client cannot commit, push or rewrite refs. ADR-0013 left the
container image open beyond "operator-supplied and pinned by digest".

## Decision

1. A `container` project's image shall have no Git client: no `git` and no `gh` executable on the container's `PATH`.
2. `projects validate` and container creation check this by looking up those names on the image's `PATH`
   (Proposed mechanism: run `command -v` for each through the runtime with no network and a read-only root). An image
   that has either starts no run, and the error names the executable found.
3. Git operations for the run (diff, checkpoints, commit, push) are done by the controller on the host, never in the
   container (FR-GIT-02 to FR-GIT-09; ADR-0014). The worktree's Git directory is not mounted (TDD §3.11).
4. The check is a guard against mistakes, not a sandbox: it does not stop an agent that has shell and network from
   fetching a Git client or writing Git files into the worktree. That residual risk is R-40 and is handled by the
   unmounted Git directory, host-side Git hardening (`src/workspace/git.ts`) and the ref snapshots (FR-GIT-03).
5. A provider CLI that cannot run without a Git client is marked `host`-only for container projects (T10.0 finding).
6. `host` environments are unchanged and keep the provider deny rules (FR-GIT-01), FR-GIT-03 snapshots and FR-GIT-06.

## Alternatives considered

- **Keep a Git client and rely on provider deny rules.** Rejected: unverified under bypass (R-38).
- **Mount a read-only Git directory.** Rejected: refs and config stay readable and the hooks and filter surface returns.
- **Always run in a container.** Rejected earlier (ADR-0013): both environment kinds stay first-class.

## Consequences

- Operators build or choose a Git-free image; Switchboard never builds images (ADR-0013).
- Agents in containers cannot inspect history; they see the worktree files only.
- T10.0, T10.1 and T10.3 carry the checks; FR-PRJ-05 already states the requirement, so no requirement ID changes.
