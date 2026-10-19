# ADR-0061: A pre-push secret scan blocks publication in every run, bypass included

- Status: Accepted for the direction (owner decision 77, answer 2, 2026-10-19); the mechanism below is Proposed until
  ROADMAP T9.14 builds it
- Date: 2026-10-19
- Decided by: zemdregon for the direction. The question in the
  [enhancement discovery](../research/enhancement-discovery-2026-10-19.md) §9 was "Should the pre-push secret scan block
  a bypass push, or only warn and flag it? Recommended: block, with the operator able to push by hand"; the answer on
  2026-10-19 was "block" ([owner decision 77](../ROADMAP.md#42-owner-decisions)). The mechanism and its wording are
  Delegated (agent, 2026-10-19), not owner-approved.
- Related: FR-GIT-11, FR-GIT-02, FR-GIT-05, FR-CTL-03, NFR-SEC-01, CAP-11,
  [ADR-0014](0014-tool-only-commits-and-publication.md), [ADR-0017](0017-approved-privileged-scope-bypass.md),
  [ADR-0028](0028-controller-push-and-credential-reach.md), [ADR-0042](0042-objective-redaction-at-admission.md),
  [LLD §20.9](../design/LLD.md#209-pre-push-secret-scan-fr-git-11-t914-adr-0061)

## Context

Agents never push; the injected push tool or an operator command does (ADR-0014, ADR-0028). Commit messages are
sanitised, but nothing scans file contents before they leave the host. A push is irreversible in practice, so an agent
that writes a secret it read into a file publishes it through the push tool.

The same day, zemdregon answered a related question: bypass runs keep full access by design ("Bypass being bypass is a
feature. If they dont want them to have full access they shouldn't run them on bypass", answer 1). So a bypass run may
read secrets outside its worktree, and the push is the one point where Switchboard can still stop them leaving. Bypass
keeps the Git-write denial and worktree isolation (owner decision 22); this ADR adds a third control that bypass keeps.

## Decision

1. **Scan before every push.** The push tool and the operator push command scan the diff being published (added lines
   of every commit between the remote ref's current tip, or the base checkpoint for a new ref, and the pushed head) with
   a deterministic, in-process rule set. No model is involved (ROADMAP §8 keeps model-assisted redaction Deferred).
2. **A hit blocks, in every profile.** The push is refused with `SECRET_SCAN_BLOCKED`, including in an approved bypass
   run. The finding is recorded as rule id, path and line, never the matched value, and the project is flagged
   `secret_scan_blocked`.
3. **No in-band override.** No MCP tool, request field, privileged scope or bypass flag changes the result. The only
   allowlist is operator configuration (rule id and path glob). The operator can always publish by pushing by hand
   outside Switchboard, as the owner's question proposed.
4. **Commit-time scan warns.** The commit tool runs the same scan over the staged diff and records a hit as a warning
   event without refusing, because a local commit is still reversible.

## Alternatives considered

- **Warn only in bypass runs.** Rejected by owner decision 77, answer 2.
- **An external scanner binary.** Rejected for the first version: a new execution path and dependency; the redactor's
  rules already exist in-process. It can be revisited.
- **Scan at commit and refuse there.** Rejected: it would interrupt bypass work for a reversible step; the push is the
  irreversible one.

## Consequences

- A false positive blocks a push until the operator allowlists the rule and path or pushes by hand.
- A secret in a binary file or in an encoding the rules do not match is not caught; binary files are listed in the event.
- Bypass runs now keep three controls: the Git-write denial, worktree isolation and this scan.

## Revisit when

- False positives block normal work often enough that the operator asks for a different rule set.
- A maintained scanner is available that can run without a new execution path.
