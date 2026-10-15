# ADR-0050: CI status through the operator's `gh` CLI (external-input boundary)

- Status: Proposed
- Date: 2026-10-15
- Decided by: Delegated (agent, 2026-10-15) under [owner decision 54](../ROADMAP.md#42-owner-decisions) (answers Q-91;
  zemdregon's verbatim answer: "yes"). The mechanism below is Delegated and not owner-approved beyond that answer.
- Related: FR-QUE-03, CAP-16, FR-AUTH-01, FR-AUTH-02, NFR-SEC-01, NFR-PRIV-01, [ADR-0003](0003-no-credential-handling.md),
  [ADR-0011](0011-single-operator-local-deployment.md), owner decisions 51 and 54, [LLD §18](../design/LLD.md#18-project-queue-schedules-and-ci-triggers-m15-proposed-t150)

## Context

Owner decision 51 schedules a narrowed CAP-14 behaviour in M15: when CI fails on a branch a project published, Switchboard
may enqueue work to fix it (FR-QUE-03). Reading GitHub Actions or check-run status needs access to the repository host.
[ADR-0003](0003-no-credential-handling.md) forbids the controller from holding, reading or copying provider or host
credentials. **Q-91** asked which credential path may be used; **owner decision 54** answered that CI status is read by
running the operator's logged-in `gh` CLI as an external tool, with Switchboard handling no credential.

Provider CLIs already follow this pattern: the controller spawns a subprocess and relies on credentials the operator
configured outside Switchboard ([ADR-0003](0003-no-credential-handling.md), FR-AUTH-01). FR-QUE-03 adds a second class of
external tool for host CI facts, not agent work. Any optional human- or bot-supplied text that accompanies a trigger is
untrusted and must not drive policy.

## Decision

1. **Subprocess only.** CI status for FR-QUE-03 is obtained only by executing the `gh` binary on the host with a closed
   allowlist of subcommands and flags fixed in [LLD §18.6](../design/LLD.md#186-ci-failure-trigger-fr-que-03-adr-0050).
   Switchboard does not call the GitHub HTTP API directly, does not read `GH_TOKEN`, `GITHUB_TOKEN` or netrc for this
   purpose, and does not store a GitHub credential in configuration or the ledger.
2. **Same trust model as provider CLIs.** The `gh` process runs as the same OS user as the controller ([ADR-0011](0011-single-operator-local-deployment.md))
   and uses whatever login the operator established with `gh auth login`. An unauthenticated or expired session yields a
   recorded trigger error (`AUTH_REQUIRED` class) and **no** enqueue; the operator re-authenticates with `gh` natively.
3. **Structured output only.** Switchboard parses only JSON emitted by allowlisted `gh` invocations (`--json` with a closed
   field list). Free-text fields from `gh` (titles, log excerpts) are not copied into prompts, policy, MCP responses or
   notification payloads. Dedup keys use stable ids from that JSON (for example check-run or workflow-run id), not message
   text.
4. **Untrusted trigger text.** If the operator or an external integration supplies a CI-failure notification (for example
   a webhook body forwarded into a file or CLI), that text is stored at most as a length-capped, labelled
   `untrusted_external_text` record ([LLD §18.6](../design/LLD.md#186-ci-failure-trigger-fr-que-03-adr-0050)). It is
   never parsed for commands, never selects a profile or ceiling, and never authorises admission by itself; admission still
   requires a failed CI conclusion read through `gh` for a publish ref the project owns.
5. **No credential in the Switchboard process.** The controller does not import `gh` credentials into its own environment
   for this feature, does not log subprocess stdout or stderr beyond reason codes, and redacts token-shaped substrings in
   any trigger error summary (NFR-SEC-01).
6. **Tests use a port.** Production code depends on a small `CiStatusPort` (name **Proposed** in LLD §18.6). Unit and
   integration tests inject a fake implementation; only operator verification runs the real `gh` binary, outside CI.

## Alternatives considered

- **GitHub App or PAT in Switchboard configuration.** Rejected: it is credential handling forbidden by ADR-0003 and would
  widen the attack surface if the ledger or logs leaked the token.
- **Inbound GitHub webhooks to Switchboard.** Rejected for M15: it needs a new listener, signature verification and secret
  storage. The narrowed trigger uses polled or operator-forwarded events plus `gh` confirmation; a native webhook path stays
  with the Deferred general FR-SUB-01 design.
- **Trust webhook payload without `gh` confirmation.** Rejected: event text is explicitly untrusted in FR-QUE-03; only
  structured `gh` JSON may admit work.

## Consequences

- Operators must install and log in to `gh` on the host where `serve` runs if they enable CI triggers.
- CI trigger behaviour is unavailable in environments without `gh` even when provider CLIs work.
- A compromised OS user session can read CI status through `gh` whether or not Switchboard runs; Switchboard does not add
  a new credential store.
- [NFR-PRIV-01](../requirements/SRS.md#41-security-nfr-sec) outbound traffic includes allowlisted `gh` subprocess
  invocations when the CI trigger is enabled, alongside provider CLIs.
- HLD records this as trust boundary **TB-15** ([HLD §3](../design/HLD.md#3-trust-boundaries)).

## Revisit when

- GitHub documents a scoped, non-interactive credential intended for local automation that ADR-0003's revisit clause
  accepts, and zemdregon chooses to adopt it.
- A second host API (not GitHub) needs the same pattern; it needs its own ADR or an extension here.
- Operator demand justifies first-class webhooks with a documented verification story and no long-lived secret in the ledger.
