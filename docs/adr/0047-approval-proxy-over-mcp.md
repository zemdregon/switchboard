# ADR-0047: Approval proxy over MCP for marked clients

- Status: Proposed
- Date: 2026-10-15
- Decided by: zemdregon for the decision itself (owner decision 50, 2026-10-15, answering discovery question 2: "the chat
  bot connected to MCP is allowed to proxy approvals from the owner, but consent page approvals can exist as a secondary
  method"). The controls listed under Decision are **Delegated** (agent, under [owner decision 25](../ROADMAP.md#42-owner-decisions)
  for everything outside bypass mode) and are not owner-approved line by line.
- Amends: the "never through MCP" rule of FR-MCP-06, FR-MCP-14, FR-POL-09 and FR-PRJ-10, for clients marked
  `approval_proxy` only (dated notes added to those rows; their text is unchanged).
- Supersedes in part, once this ADR is accepted: item 6 of [ADR-0017](0017-approved-privileged-scope-bypass.md) ("No MCP
  tool approves") and the statement in item 6 of [ADR-0041](0041-http-transport-with-oauth-2-1.md) that approval stays
  with the operator CLI. Both status lines point here. Until acceptance they stand unchanged.
- Not affected: [ADR-0019](0019-per-client-privileged-approval.md). Its `privileged_approval` setting is an operator
  configuration value that stands in for the CLI approval; it is not an MCP approval and this ADR does not change it.
- Builds on: [ADR-0003](0003-no-credential-handling.md), [ADR-0004](0004-trust-profiles-no-bypass-flags.md),
  [ADR-0041](0041-http-transport-with-oauth-2-1.md) (consent page, FR-MCP-17), [ADR-0030](0030-dynamic-project-revisions-and-approval.md)
  (dynamic project approval).
- Related: FR-CTL-08, FR-CTL-09, FR-MCP-06, FR-MCP-14, FR-MCP-17, FR-OPS-02, FR-POL-09, FR-PRJ-10, FR-GIT-01, FR-WS-05,
  NFR-SEC-01, R-65, [ADR-0048](0048-notification-sinks.md).

## Context

Every approval for a `privileged` run, a dynamic project or a push-enabled revision is given through the operator CLI
(`switchboard approve`, `deny`, `projects approve`). That is the only path today, and FR-MCP-06, FR-MCP-14, FR-POL-09 and
FR-PRJ-10 say MCP never grants one. An operator who is away from a terminal therefore cannot unblock a run, even when
the chat bot that is already watching the work could show the request (discovery note, [§2](../research/orchestration-layer-discovery-2026-10-15.md#2-summary)
and [§5](../research/orchestration-layer-discovery-2026-10-15.md#5-the-single-chatbot-experience-target-proposed)).

zemdregon's answer (2026-10-15) allows a chat client connected to MCP to proxy the owner's approvals, and keeps the
consent page as a secondary method. This deliberately gives a model-driven client the power to approve: a
prompt-injected or compromised proxy client can list an approval and decide it, because the digest it must send back is
the one it was shown. The controls below limit what can be approved and make every proxied decision visible; they do not
stop a proxy client from approving (R-65).

## Decision

1. **Scope.** An MCP client whose operator configuration entry sets `approval_proxy` may list pending approvals and
   decide them through two MCP tools (names fixed in T14.8). The approval kinds it may decide are the ones already
   human-approved on the CLI: `privileged` scopes (including bypass, ADR-0017), dynamic project revisions (FR-PRJ-10)
   and push-enabled or identity-bearing revisions. Clients without the flag get no approval tools; they are absent from
   the tool list, not refused at call time.
2. **Delegated controls (not asked; each is a fail-closed default):**
   a. **Off by default.** `approval_proxy` is set only in operator configuration, read at config load (an invalid value
      refuses the config). It is never settable over MCP and is not part of any token or scope.
   b. **Listed targets only.** A proxy client may decide only approvals raised for the MCP clients the operator lists
      for it (`approval_proxy` targets; default: the client itself). It cannot decide approvals of another client.
   c. **Exact binding.** A decision names the exact `approval_id` and the `approval_digest` that was returned when that
      approval was listed. The digest covers the frozen scope shown (the scope hash of ADR-0017, or the revision hash of
      ADR-0030). A missing, stale or mismatched digest refuses the decision and writes nothing.
   d. **Controller-generated text only.** A listed approval shows only controller-generated fields (kind, run or
      revision ID, project, client, scope summary, requested time). It never shows agent text, prompts, diffs or
      repository content.
   e. **Audit.** Each proxied decision is recorded with `decided_via: mcp_proxy` and the proxy client's ID, in the same
      approval record that the CLI writes (FR-POL-09 timestamp and scope unchanged). This adds one value to an
      existing field of the approval record; the persistence change is covered by this ADR.
   f. **Announced.** Each proxied decision is announced to the configured notification sinks (ADR-0048), with no
      scope text beyond the metadata those sinks carry.
   g. **Unchanged rules.** A proxied approval grants exactly the frozen scope that was listed. It does not widen the
      scope, does not lift Git-write denial (FR-GIT-01) or worktree isolation (FR-WS-05), and does not change a
      client's ceiling (FR-MCP-06). The CLI `approve` and `deny` stay as they are.
3. **Consent-page link as a secondary method (FR-CTL-09).** An approval may also be decided through a single-use,
   expiring link to the M13 consent page. The page is authenticated as FR-MCP-17 requires (operator passphrase or
   pairing code). A link carries no token and no secret, and is revoked when the approval is decided or expires.
4. **What the chat model can see.** It can list pending approvals and their digests. It cannot decide one without
   the controls above, and a model that is told to approve by injected text has no digest it can obtain except
   through the listing, which is shown only to a client the operator has marked.

## Consequences

- The trust boundary for approvals moves from "a person at the operator's terminal" to "a person at the operator's
  terminal, or a client the operator marked, holding a token for it". A prompt-injected or compromised proxy client, or
  a stolen token for it, can approve `privileged` and bypass runs. This is recorded as **R-65** (not blocking; accepted
  by zemdregon through owner decision 50 as a Delegated reading). Its mitigations are the controls in Decision 2.
- A token for a proxy client is a credential Switchboard issues (ADR-0041); it is not a provider credential, so
  ADR-0003 is not engaged. Tokens stay hashed and revocable as in ADR-0041.
- The approval record gains a `decided_via` value, and the list output gains a digest. Both are specified in [LLD
  §3.4.8](../design/LLD.md#348-approval-proxy-tools-fr-ctl-08-adr-0047) before any code (AGENTS.md: a persistence change
  needs an ADR, which this is).
- Bypass runs keep their existing limits: approval never widens scope, and Git-write denial and worktree isolation
  still apply (decisions 22 and 46).
- Nothing changes for deployments that do not set `approval_proxy`.

## Alternatives considered

- **Consent page only.** Kept as the secondary method. As the only path it needs a browser step on every approval, and
  it does not give the chat channel the status it needs to explain what it is asking the operator to approve.
- **CLI only (status quo).** Keeps the rule simple and the trust boundary unchanged, but an operator away from a
  terminal cannot unblock a run. Rejected by owner decision 50.
- **Approval by a chat model without a digest or a listed target.** Rejected: any client that could list approvals
  could then approve them, which is the injection path the controls exist to close.
- **An OAuth scope that grants approval.** Rejected: FR-MCP-14 says a scope never grants `privileged`. Here only
  operator configuration marks a client, and the scope is still `mcp`.

## Revisit when

- The first proxied approval runs in a live deployment, or a proxy client is found to have been prompt-injected.
- zemdregon accepts or changes the Delegated controls in Decision 2 (this ADR stays Proposed until then).
- The MCP 2026-07-28 readiness spike (T14.12) changes how client identity or tool authorisation is carried.
