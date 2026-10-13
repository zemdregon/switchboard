# ADR-0016: An inner agent handles cheap, low-stakes tasks, with no authority over security

- Status: Accepted (the decision); every mechanism marked Proposed is unverified
- Date: 2026-10-13
- Decided by: Ender (the product decision, 2026-10-13: Switchboard has an inner agent, a self-hosted, cheap or free model
  of the user's choosing, for many cheap tasks such as commit and PR writing and task routing for auto mode, to lighten
  that load off the other models, with further tasks left to the drafter's judgement). Delegated (agent, 2026-10-13) for
  everything else: the backend kinds, which tasks are in scope, the validation, fallback and privacy rules, and the
  milestone placement.
- Related: FR-INN-01–18, FR-GIT-04, FR-RTE-04, FR-SES-04, FR-CAP-01–03, NFR-PRIV-01, NFR-SEC-01,
  [ADR-0003](0003-no-credential-handling.md), [ADR-0007](0007-capacity-as-confidence-estimate.md),
  [ADR-0008](0008-two-stage-routing.md), [ADR-0012](0012-telemetry-at-wrapper-boundary.md),
  [ADR-0014](0014-tool-only-commits-and-publication.md)
- Extends: [ADR-0014](0014-tool-only-commits-and-publication.md) (item 3, where a commit message may come from), without
  changing its decision. [ADR-0008](0008-two-stage-routing.md) is unchanged: the inner agent can only supply stage-2
  features.

## Context

Much of what a controller needs a language model for is small: a commit message, a pull-request description, a one-line
run title, a summary of a 4,000-line test log, a first guess at how hard a request is. Spending a Claude Code or Codex
turn on these uses the subscription capacity the whole product exists to conserve (BO-1), and the agent that did the
coding has to write the message too. Ender wants a cheap or free model to take that work, chosen by the user: a
self-hosted model, a cheap or free model reached through OpenCode, or something else.

Three constraints come from the existing design. The controller must never handle provider credentials (ADR-0003). All
controller data stays on the host except provider CLI traffic and configured telemetry (NFR-PRIV-01), so sending a diff
to a hosted model is a new kind of egress. And a weak model must not be able to weaken security: the whole policy design
fails closed on facts the controller checks itself (NFR-SEC-06).

## Decision

1. **One optional inner agent per installation**, configured by the operator, with no default backend or model
   (FR-INN-01). Switchboard behaves exactly as before when none is configured.
2. **It is a model call, not a coding agent.** Each call is stateless, single-turn text completion with no tools, no file
   or shell access and no loop (FR-INN-02). The name follows Ender's wording; the mechanism is deliberately narrow.
3. **Two backend kinds.** `http`: an endpoint the operator runs or reaches, holding no credential in Switchboard's
   configuration; a key-bearing hosted service goes through an operator-run local gateway (FR-INN-03). `cli`: a one-shot
   headless run of an installed provider CLI that holds its own login, first `opencode run` with a free or cheap model
   (FR-INN-04, Proposed, flags unverified). Both keep ADR-0003 intact.
4. **Tasks are opt-in, individually.** The catalogue and the recommendation on each candidate are in
   [PRD §3.1](../requirements/PRD.md#31-inner-agent-task-catalogue). In scope: commit message, PR draft, routing
   classification, handoff and log summarisation, run titles. Out of scope or deferred: anything a security or
   correctness decision depends on (FR-INN-06), including model-assisted redaction (FR-INN-18).
5. **No authority over security.** No inner output reaches policy, eligibility, approvals, ceilings, the sanitiser rules,
   redaction, failure classification or any run status (FR-INN-06). This is enforced by structure (the service is not
   injectable into those components, checked by an import-boundary test) and not by prompting.
6. **Outputs are untrusted data.** Schema, bounds, control-character stripping, at most one re-ask, then the fallback
   (FR-INN-07). Commit and PR text additionally passes the ADR-0014 sanitiser, and the prompt carries no controller,
   provider, run or session identifier, so the model cannot echo one (FR-INN-10, FR-INN-11).
7. **Failure is invisible to the run.** Every task has a deterministic fallback; the inner agent never fails or delays a
   run beyond a bounded per-call timeout; a circuit breaker and automatic task suspension handle a dead or poor model
   (FR-INN-08, FR-INN-09). For commit messages the fallback is a tool error asking the agent for a message, not a
   generated stand-in (FR-INN-10).
8. **Usage is separate from capacity.** Inner calls are recorded in `inner_call`, never as provider usage and never in a
   capacity estimate (FR-INN-15). The one exception is honesty: if the operator says the backend shares a subscription
   with a routed provider, that provider gets an observation labelled `inner_agent`, so ADR-0007's estimate is not blind
   to real consumption.
9. **Privacy is explicit.** `local` versus `remote` backends; `remote` needs an opt-in, sending source content needs a
   second per-task opt-in, projects can force `off` or `local_only`, deterministic redaction runs before every call, and
   bodies are not logged (FR-INN-16). NFR-PRIV-01 is amended to name this egress.
10. **Replay stays deterministic.** A routing classification is stored as a feature with its source, model and template
    version, and `explain_route` replays from the stored value (FR-INN-12).
11. **Placement.** New milestone M11, sequenced after M9 (Proposed). Tasks that need another milestone's output wait for
    it (ROADMAP §6.6).

## Alternatives considered

- **Let the main provider write commit messages and summaries (status quo).** Rejected as the only path: it spends
  premium capacity on mechanical work, which is what Ender wants to stop. Kept as the fallback.
- **Make the inner agent a full agent with tools (for example a cheap OpenCode run in the repository).** Rejected: a
  weak model with a shell and write access defeats the isolation work (ADR-0004, ADR-0006), and repository content is
  untrusted input to it.
- **Expose the inner agent to orchestrators as an MCP tool.** Rejected for now: it turns Switchboard into a general model
  proxy, widens TB-1, and has no owner requirement behind it.
- **Use the inner agent to decide eligibility, trust profiles or permissions.** Rejected outright: a cheap, injectable
  model must never hold a security decision (FR-INN-06).
- **Model-assisted secret or PII redaction.** Deferred (FR-INN-18): a miss is a silent leak, and detecting secrets by
  sending content to a model is itself the exposure, especially for a hosted model. Deterministic redaction stays the
  control. An add-only advisory pass on a `local` backend could be reconsidered later.
- **Store a hosted-service API key in Switchboard's config or environment.** Not adopted: it would change ADR-0003 and
  FR-AUTH-01 for a convenience a local gateway already provides. Left as an open question for Ender (Q-23).
- **Count inner usage as provider usage with an NCU conversion.** Rejected: ADR-0007 already rejected precise
  compute-unit accounting, and mixing a cheap model's tokens into provider estimates would corrupt both.

## Consequences

- A new component, COMP-INN (the inner-agent service), and a new trust boundary, TB-10 (controller to the inner backend).
- A new external egress path from the controller process itself, not only from provider CLIs. It is off unless
  configured, `local` by default in every example, and gated for `remote`.
- Commit text produced by a model enters published history. The sanitiser and the agent-text-wins default limit the
  damage, but a cheap model can write a vague or wrong message (R-27). The provenance record still names the run, and
  now notes that the inner agent drafted the message.
- Summaries can mislead (R-30). They are labelled, additive and backed by raw artifacts, and never carry statuses.
- Prompt injection in repository content can reach the inner model (R-28). Its output has no authority and is
  validated, so the worst case is a bad draft, a misleading title or a skewed routing feature, not an escalation.
- The `get_artifacts` kinds gain `pr_draft`, and the injected `commit` tool's `message` parameter becomes optional when
  the commit-message task is enabled. Both are interface changes covered by this ADR and by LLD §3 and §12.1.
- Tests must pass with no inner backend (a fake backend is part of the suite); live inner calls are opt-in like all live
  provider calls.

## Revisit when

A user needs a key-bearing hosted backend without a gateway (Q-23); several hundred inner calls show rejection or
fallback rates that justify different defaults; a provider documents a tool-free one-shot mode that makes the `cli` kind
verifiable; or a use appears that needs the inner agent exposed to orchestrators.
