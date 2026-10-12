# ADR-0001: Controller-owned canonical state, provider sessions as optimization

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-SES-01–05, NFR-PRIV-02, [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md)

## Context

The stated intent is persistent cross-provider meta-sessions. The [original
blueprint](../research/headless-ai-coding-controller.md#lossy-context-compaction-and-state-handoff) proposed extracting
each provider's local transcript files (for example `~/.claude/projects/*.jsonl`, `~/.grok/sessions/`), summarizing the
agent trajectory, and using that as the cross-provider state. The [verified
research](../research/headless-ai-coding-controller-verified-2026-10-12.md#meta-session-state-and-cross-provider-continuity)
found that the CLIs already expose documented session IDs and resume commands, that transcript formats are undocumented
internals, and that Git state is provider-independent by construction.

## Decision

The canonical record of a task is controller-owned: objective, constraints, decisions, Git base/head, changed files,
verification results, artifacts and observable run events, stored in the ledger. Provider-native sessions are bindings
used only to resume on the same provider. Cross-provider continuation uses a handoff bundle generated from the canonical
record, and the new agent is told to inspect the repository itself. The controller never parses provider transcript
files.

## Alternatives considered

- **Transcript extraction and summarization** (original blueprint). Rejected: depends on undocumented, changing file
  formats, and stores provider-internal reasoning as state.
- **Native sessions only, no cross-provider continuity.** Rejected: fails the stated meta-session intent.

## Consequences

- Handoff is lossy by design; the receiving agent re-reads the repository. This costs some tokens and time per handoff.
- Retry and rollback can be decided from Git state (see ADR-0006).
- Requires the controller to capture decisions explicitly (from structured result events and orchestrator-supplied
  constraints), which is new work in M5.

## Revisit when

A provider documents a portable, stable session export format that carries materially better state than the handoff
bundle.
