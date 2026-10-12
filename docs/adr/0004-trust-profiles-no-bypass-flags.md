# ADR-0004: Trust profiles compiled per adapter; no automatic bypass flags

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-POL-01–09, NFR-SEC-03, [SRS §3.3](../requirements/SRS.md#33-policy-and-trust-profiles-fr-pol)

## Context

The original blueprint used broad flags to make headless runs autonomous (`--allowedTools "*"`,
`--dangerously-skip-permissions`, `--yolo`, `--trust --approve-mcps --force`). The [verified
research](../research/headless-ai-coding-controller-verified-2026-10-12.md#security-sandboxing-concurrency-and-telemetry)
found several of these are wrong or dangerous (Claude skips the `"*"` glob; `dontAsk` denies rather than approves), and
that providers separate authorization (permission modes, allow/deny rules) from confinement (sandbox profiles).

## Decision

The controller defines five trust profiles (`inspect-untrusted`, `edit-untrusted`, `test-sandboxed`,
`trusted-development`, `privileged`). Each adapter compiles a profile into its strongest native permission rules *and*
sandbox controls, modelled as separate dimensions. An adapter that cannot meet a profile is ineligible for it. Bypass
flags are emitted only under `privileged` with recorded operator approval.

## Alternatives considered

- **One universal permission mode translated per provider.** Rejected: providers' models are not equivalent and the
  translation would silently weaken some.
- **Always wrap in an outer container and allow everything inside.** Rejected as the default: it does not stop
  credential exfiltration when credentials are reachable inside the container, and it hides policy from the provider's
  own controls. An outer sandbox remains an additional layer where useful (TDD).

## Consequences

- Headless runs that hit a denied operation fail with a structured error; the orchestrator must re-delegate with a
  broader profile if appropriate.
- Each adapter needs a profile compilation table and malicious-fixture tests.

## Revisit when

A provider's permission model changes such that a profile cannot be compiled, or real use shows a profile is
consistently too narrow.
