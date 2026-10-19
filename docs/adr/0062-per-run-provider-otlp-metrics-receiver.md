# ADR-0062: Per-run loopback OTLP/HTTP metrics receiver for provider telemetry

- Status: Proposed (Delegated, agent, 2026-10-19; direction from owner decision 77 via ROADMAP T8.15, not
  owner-approved)
- Date: 2026-10-19
- Decided by: Delegated (agent, 2026-10-19) under owner decision 77 as relayed by WORK QUEUE v10 (Linus decisions
  v10-D1 and v10-D6). Not owner-approved.
- Related: FR-TEL-06, FR-TEL-03, FR-CAP-01, FR-EXE-07, [ADR-0012](0012-telemetry-at-wrapper-boundary.md),
  [LLD §20.13](../design/LLD.md#2013-tamper-evident-ledger-provider-telemetry-evaluation-brief-and-critic-t813-t815-t814-t514-t1417)

## Context

Some provider CLIs can export OpenTelemetry metrics (token counts, cost figures). FR-TEL-06 (added 2026-10-19 for
owner decision 77) asks that, where a provider CLI exports OTel metrics and the operator enables it for that provider
(off by default), the controller receive them on a loopback-only OTLP listener for the run, pass the run and task
identifiers as resource attributes, and record received token and cost figures as reported usage observations
(FR-CAP-01). No attribute forbidden by FR-TEL-03 may be stored. The listener needs an ADR before code (SRS, SDD).

## Decision

1. **Off by default, one switch.** `telemetry.provider_otlp` (default `false`). Off means no listener opens: no
   socket, no extra environment, no behaviour change. On alone still opens nothing unless the run's provider manifest
   declares OTLP support (item 4).
2. **One listener per run, loopback only, lifetime of the run.** When active, the controller binds `127.0.0.1` with an
   ephemeral port (`127.0.0.1:0`) before the provider process spawns and closes it when the run leaves RUNNING. It
   never binds any other interface; the bound address is loopback by construction (explicit `127.0.0.1`, not
   `localhost`, so no DNS or IPv6 wildcard is involved).
3. **OTLP/HTTP JSON only, no new dependency.** `POST /v1/metrics` with `Content-Type: application/json` only, parsed
   with the existing JSON tooling over `node:http`. No protobuf, no gRPC, no new runtime dependency (Linus decision
   v10-D6, WORK QUEUE v10; Delegated, not owner-approved). Anything else is refused: wrong path 404, wrong method 405,
   non-JSON content type 415, body over the cap 413, malformed body 400. A provider that only exports protobuf is
   recorded as unsupported in its manifest note.
4. **Per-provider declaration in the compliance manifest.** The provider's documented OTLP variables are named in its
   manifest (`otlp_metrics`: the endpoint variable, an optional protocol variable pinned to `http/json`, an optional
   resource-attributes variable, and the provider-documentation citation) only after they are checked against the
   provider's documentation. Anything uncited stays undeclared, and an undeclared provider gets no listener and no
   extra environment. This row declares none: no provider's OTLP metrics export was verified against provider
   documentation here, so every manifest keeps `otlp_metrics` absent.
5. **Trust boundary: the payload is untrusted.** Data arriving at the listener comes from the provider process and is
   treated as untrusted input. Only allowlisted metric names map to observation keys (token counts and cost in USD);
   every other metric is ignored. Data-point attributes other than the token-type split key are dropped; resource
   attributes from the payload are ignored entirely. The run and task identifiers (`run.id`, `session.id`, matching
   the LLD §7 span keys) are injected by the controller as resource attributes through the invocation environment, never
   trusted from the payload. Nothing forbidden by FR-TEL-03 (prompts, credentials, environment, full output) can pass:
   the intake stores numbers only.
6. **Body cap (Assumption).** 1 MiB per request; over-cap bodies are refused with 413 before parsing. Small enough to
   bound memory, large enough for per-interval metric batches.
7. **Recorded as reported.** Mapped figures become `usage_observation` rows with `source = 'provider_reported'` for
   that run (FR-CAP-01: labelled by source, kept separate from controller estimates), written in the run's terminal
   transaction with the other provider-reported usage. No figures means no rows (null, never zero).

## Alternatives considered

- **A single long-lived collector for all runs.** Rejected: attribution would depend on trusting the payload's run
   identifier, and a shared socket widens the lifetime and blast radius. Per-run listeners keep attribution
   controller-side.
- **OTLP/gRPC or protobuf.** Rejected for this version (v10-D6): a new dependency and a binary parsing surface for no
   declared provider. Recorded as unsupported per provider until a manifest cites protobuf-only export in provider docs.
- **Trusting the payload's resource attributes for run attribution.** Rejected: the provider process is outside the
   trust boundary; attribution is injected by the controller.

## Consequences

- With the switch off (the default), or for any provider without a manifest declaration, behaviour is unchanged and
   provably so (no socket opens).
- Metrics a provider sends under names outside the allowlist are silently ignored; cost figures in other currencies or
   under other names are not recorded until a later ADR extends the map with cited documentation.
- The receiver adds one loopback HTTP server per active run; it is closed on every run exit path with the run's other
   per-run resources.

## Revisit when

- A provider's documentation is checked and its OTLP metrics variables are declared in its manifest (then that
   provider, and only that provider, gets a listener when the switch is on).
- A declared provider exports protobuf only (needs a protobuf decision first).
