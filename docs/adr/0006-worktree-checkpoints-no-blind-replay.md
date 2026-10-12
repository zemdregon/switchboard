# ADR-0006: Worktree per write-capable run; checkpoints; no blind replay

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-WS-01–07, FR-CAP-05, FR-EXE-06

## Context

The original blueprint retried any CLI run that hit a 429 with exponential backoff. The [verified
research](../research/headless-ai-coding-controller-verified-2026-10-12.md#routing-capacity-and-resilience) points out
that a failed run may already have edited files or run side-effecting commands, so replaying the request against mutated
state is unsafe. It also notes that the controller cannot rely on an upstream orchestrator (for example an unverified
OpenClaw "Lane Queue") to serialize writes.

## Decision

- Every write-capable run gets a controller-created Git worktree on a controller-owned branch, created from a recorded
  base checkpoint commit.
- One write lease per worktree; parallel subtasks get separate worktrees.
- After the run, the controller commits a post-run checkpoint and stores a diff artifact.
- On failure, the controller compares the worktree with the pre-run checkpoint. Unchanged: eligible for retry. Changed:
  roll back to checkpoint or resume the native session; never replay.
- The controller never pushes to remotes or touches the operator's checked-out branch. Integration of result branches is
  the orchestrator's or operator's step.

## Alternatives considered

- **Run in the operator's working tree.** Rejected: unsafe for concurrent runs and for rollback.
- **Copy-on-write directory clones.** Rejected: loses Git's diff/commit tooling; Git worktrees are cheap enough.
- **Automatic merge into the operator's branch.** Deferred: integration conflicts need judgement.

## Consequences

- Workspaces must be Git repositories for write-capable profiles.
- Worktrees consume disk; retention and garbage collection are required (FR-WS-07).

## Revisit when

Repositories are too large for per-run worktrees, or a target orchestrator needs in-place edits.
