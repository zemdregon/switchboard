# ADR-0050: CI status through the operator's `gh` CLI (external-input boundary)

- Status: Proposed
- Date: 2026-10-15
- Decided by: Delegated (agent, 2026-10-15) under [owner decision 54](../ROADMAP.md#42-owner-decisions) (answers Q-91;
  zemdregon's verbatim answer: "yes"). The mechanism below is Delegated and not owner-approved beyond that answer.
- Amended: 2026-10-19 (amendment 1 below) for owner decision 76; Delegated wording, not owner-approved beyond the
  decision.
- Related: FR-QUE-03, FR-QUE-06, FR-QUE-07, FR-SUB-01, FR-SUB-02,
  CAP-16, FR-AUTH-01, FR-AUTH-02, NFR-SEC-01, NFR-PRIV-01, [ADR-0003](0003-no-credential-handling.md),
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

## Amendment 1 (2026-10-19): rerun, stale cancel, mergeability and merge

Owner decision 76 ("Add all 7 including auto-merge", 2026-10-19) adds the harness capabilities R1, R4 and R7. They need
`gh` verbs beyond the read-only set of item 1, so this amendment widens the allowlist. Items 2 to 6 apply unchanged to
every verb below, and each write verb is behind its own project switch, off by default.

- **Item 7, rerun failed jobs once** (FR-QUE-06): `gh run rerun <run-id> --failed`, only with
  `ci_trigger.rerun_failed: true`, at most once per (published ref, head SHA, job), and only for a run on a ref the
  project published. A conclusion of `cancelled` or `timed_out` is classed
  `CI_INFRA` and never counts toward the FR-QUE-05 cap (T15.6 settled against `gh` 2.102.0 that no allowlisted
  field marks a runner fault inside a `failure`, so those stay code failures, fail closed).
- **Item 8, cancel stale queued runs** (FR-QUE-06): `gh run cancel <run-id>`, only with
  `ci_trigger.cancel_stale_queued: true`, only for a run whose status is `queued` (never `in_progress`) on a published
  ref whose head SHA is no longer that ref's head. This stays inside "branches the project published".
- **Item 9, read mergeability** (FR-QUE-07, FR-SUB-01): `gh pr view` with the closed `--json` field list
  `number,state,isDraft,mergeable,headRefOid` (G9; no check results — required-check gating is item 10, T15.8), read-only.
- **Item 10, merge** (FR-SUB-02): `gh pr merge <number> --<method> --match-head-commit <sha>`, only for a project
  whose merge policy is on, under the gate of [ADR-0060](0060-opt-in-head-pinned-merge-policy.md).

Every other `gh` verb stays refused, and the argv allowlist test keeps proving it. Exact field names and flags are
checked against the installed `gh` in ROADMAP T15.6 to T15.8 before code relies on them
(T15.6 done: `gh` 2.102.0, `--help` only, no call to GitHub; T15.7 done the same way for item 9, whose closed field
list is `number,state,isDraft,mergeable,headRefOid`; T15.8 pending)
([LLD §20.1](../design/LLD.md#201-ci-transient-handling-fr-que-06-t156),
[§20.4](../design/LLD.md#204-published-ref-conflicts-and-supersede-fr-que-07-t157),
[§20.7](../design/LLD.md#207-opt-in-merge-policy-and-ref-events-fr-sub-01-fr-sub-02-t158-adr-0060)).

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
