# Business Requirements Document (BRD)

| | |
|---|---|
| Status | Draft, baseline for milestone M1 |
| Owns | The business problem, business outcomes BO-1..BO-6, stakeholders, business constraints, value proposition, success measures per outcome, business risks and the open question about who Switchboard is for. |
| Does not own | Capabilities, users and journeys ([PRD](PRD.md)); requirements ([SRS](SRS.md)); scope, priorities, sequencing and milestone status ([ROADMAP](../ROADMAP.md)); architecture decisions ([ADRs](../adr/README.md)). |
| Last reconciled | 2026-10-12 |

Nothing described here is implemented. As of 2026-10-12 the repository holds documentation only: no code, tests, CI or configuration. Every success measure below is a measure to be taken once the named milestone delivers, not a result.

Sources: [R1] is the [original blueprint](../research/headless-ai-coding-controller.md), whose introduction carries zemdregon's stated intent and is superseded on technical details; [R2] is the [verified research of 2026-10-12](../research/headless-ai-coding-controller-verified-2026-10-12.md), which supersedes R1 where they conflict.

## 1. Business problem

The most capable AI coding agents are distributed as separate, proprietary command-line tools: Claude Code, Grok Build, Antigravity (`agy`), Codex, Cursor CLI, OpenCode and Kimi Code. Each has its own subscription, its own quota and reset behaviour, its own headless flags and output format, and its own session store ([R1] introduction, [R2]).

For someone who pays for several of these subscriptions and drives them from a primary orchestrating agent (the stated examples are OpenClaw and Grok Bot), this causes five problems:

1. **Paid capacity is stranded.** Work lands on whichever tool the person or agent happens to use; the others sit idle until the person switches by hand, while the busy one hits its quota.
2. **Compliance and account risk.** The tempting shortcuts, such as reusing session tokens or scripting login pages, put the subscriptions at risk. [R1] states the constraint plainly: avoid OAuth and login interaction, and use only documented headless modes. [R2] adds that documented support is not a blanket grant for every use.
3. **Unattended agents are dangerous.** Autonomous agents run shell commands and edit files. Running them unattended on a host that holds provider credentials needs a security boundary, which the provider tools do not supply uniformly ([R2] credential boundary).
4. **Context is lost on every switch.** Provider-native sessions are not portable, so changing provider mid-task discards the decisions, diffs and failed attempts accumulated so far.
5. **Opacity and drift.** Without a record it is unclear which tool ran what, why, at what cost, or whether a CLI update has quietly changed behaviour or weakened a safety flag ([R2] on CLI churn).

Switchboard is the proposed answer: a headless controller that wraps the provider CLIs through their documented automation modes and presents one delegation surface to the orchestrator ([PRD](PRD.md) describes the product; [ADR-0001](../adr/0001-controller-owned-canonical-state.md) and [ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md) the core decisions).

## 2. Business outcomes

Each outcome is observable in operation and is served by one or more capabilities in the [PRD](PRD.md#3-capabilities). Requirements that implement them are in the [SRS](SRS.md) and cite these IDs.

| ID | Outcome | Rationale |
|---|---|---|
| BO-1 | Use several already-paid AI coding subscriptions from one orchestrator without manual switching, getting more done per subscription. | The core value. The subscriptions are sunk cost; the gain comes from spreading work across them, using each one's quota before it lapses and avoiding idle or exhausted tools. Stated intent in [R1]: tier-aware load balancing across subscriptions, exposed to one primary orchestrator. |
| BO-2 | Use providers only through documented automation surfaces; never handle provider credentials (account and terms risk). | A banned or throttled account costs more than any saving. This outcome keeps the system inside what each provider documents and keeps Switchboard from becoming a credential store ([ADR-0003](../adr/0003-no-credential-handling.md)). It is a risk-reduction aim, not a claim of terms compliance (see §4). |
| BO-3 | Unattended agent runs cannot damage the host, escape their workspace, or exfiltrate credentials beyond policy. | The value of delegation is that nobody watches each run. That is only acceptable if the worst case is bounded by policy ([ADR-0004](../adr/0004-trust-profiles-no-bypass-flags.md), [ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md)). |
| BO-4 | Engineering work continues across providers without losing project state. | A task should survive a quota wall, an auth expiry or a provider change. State is owned by the controller, with provider sessions as an optimisation ([ADR-0001](../adr/0001-controller-owned-canonical-state.md)). Stated intent in [R1]: persistent cross-provider meta-sessions. |
| BO-5 | The operator can see what ran where, why it was routed there, what it changed and what it consumed. | Trust in an autonomous system depends on being able to audit it. Routing reasons and usage must be visible, and estimates must not be passed off as authoritative provider quota ([ADR-0007](../adr/0007-capacity-as-confidence-estimate.md), [ADR-0008](../adr/0008-two-stage-routing.md)). |
| BO-6 | Provider CLI churn cannot silently break the system or weaken its security. | Seven fast-moving CLIs will change flags and output. A version the controller has not validated must be treated as unusable, not guessed at ([ADR-0009](../adr/0009-version-gated-adapters.md)). |

## 3. Stakeholders

| Stakeholder | Role | Interest | Influence |
|---|---|---|---|
| zemdregon (GitHub `zemdregon`) | Owner and, by assumption, sole operator ([ADR-0011](../adr/0011-single-operator-local-deployment.md)) | Installs and configures Switchboard, logs in to each provider natively, sets policy, approves privileged runs, reads audit data. | Owns all scope decisions. zemdregon's explicit decisions to date are limited to committing the two research documents as project research and preferring that model choice match task difficulty in project process. Every ADR is "Delegated" and has not been individually reviewed or approved by zemdregon. |
| Orchestrator agent (for example OpenClaw, Grok Bot) | Machine consumer | Calls the MCP tools to delegate work and collect compact, predictable results; needs stable schemas, structured errors and bounded waits. | Shapes the tool surface; has no authority to raise its own trust level ([SRS FR-MCP-06](SRS.md#31-mcp-interface-fr-mcp)). |
| Provider vendors (Anthropic, xAI, Google, OpenAI, Cursor, OpenCode, Moonshot AI) | External parties | Their terms, quotas and documented automation surfaces constrain what Switchboard may do. They are not consulted and have no relationship with the project. | Can change CLIs, limits or terms at any time (BO-6, risks in §7). |

No other stakeholders are known. In particular no other users, team, customers, compliance function or funder has been identified (see the open question in §8).

## 4. Business constraints

| Constraint | Source |
|---|---|
| Subscription-based use: the product exists to use subscriptions the operator already pays for. API-key mode is not the default; it may be added later per provider behind the same compliance manifest. | [R1] intent; [ADR-0003](../adr/0003-no-credential-handling.md) |
| Documented automation only: providers are driven through their documented headless or protocol modes (JSON/JSONL output, ACP). No reverse engineering, binary patching or protocol reimplementation. | [R1] intent; [R2]; [SRS FR-AUTH-01](SRS.md#34-authentication-boundary-fr-auth) |
| No credential handling and no login interaction: the operator logs in with each native CLI; Switchboard reads auth state only through the provider's own status command or a harmless headless call. | [R1] intent; [ADR-0003](../adr/0003-no-credential-handling.md) |
| No claim of terms compliance: documentation and output describe use of "documented automation surfaces". Commercial, resale, multi-user or credential-sharing use needs a per-provider policy review first. | [R2]; [SRS NFR-COMP-01](SRS.md#46-privacy-data-and-compliance-nfr-priv-nfr-data-nfr-comp) |
| Single operator, local deployment, Linux first. | [ADR-0011](../adr/0011-single-operator-local-deployment.md) |
| No web interface, except possibly restricted usage and telemetry dashboards (deferred). | [R1] intent; [SRS FR-OPS-03](SRS.md#311-operator-cli-fr-ops), FR-TEL-04 |
| Data stays on the host apart from provider CLI traffic and telemetry the operator configures. | [SRS NFR-PRIV-01](SRS.md#46-privacy-data-and-compliance-nfr-priv-nfr-data-nfr-comp) |
| No budget, staffing or deadline has been stated. Assumption: the work is paced by the milestones in the [ROADMAP](../ROADMAP.md#6-milestones), without calendar dates. | Not stated |

## 5. Value proposition

For an operator who already holds several AI coding subscriptions and drives them from an orchestrating agent, Switchboard is a local controller that:

- gives the orchestrator one small tool surface instead of seven CLIs (BO-1);
- spreads work across subscriptions by eligibility and a visible score, and responds to quota and auth problems instead of failing blindly (BO-1, BO-4);
- stays inside documented automation and never touches credentials (BO-2);
- runs agents under named trust profiles in isolated Git worktrees, never pushing to remotes or touching the operator's checked-out branch (BO-3);
- keeps a controller-owned record so a task can move between providers (BO-4);
- records routing reasons, changes and usage, labelling estimates as estimates (BO-5);
- refuses to route to CLI versions it has not validated (BO-6).

Unlike calling each CLI directly, this keeps one audit trail and one security policy. Unlike calling the model APIs directly, it keeps each vendor's agent loop and sandboxing, which [R1] identifies as the reason the CLIs are worth using. The value is a hypothesis until the milestones in §6 are met; no measurement exists.

## 6. Success measures

Each measure is observable from the ledger, CLI output or test results. Numeric thresholds are *(proposed target)*: chosen during this planning task, not established, and subject to revision after measurement. Milestones are defined in the [ROADMAP](../ROADMAP.md#6-milestones).

| Outcome | Measure | Observed how | Earliest milestone |
|---|---|---|---|
| BO-1 | An orchestrator completes a delegated task end to end with no manual provider switch. | Demonstration against the Claude Code adapter via MCP | M2 |
| BO-1 | At least 3 providers are routable in the same installation, with tasks running on more than one of them. | `switchboard doctor` output and `runs list` | M4 |
| BO-1 | When a provider reports quota exhaustion and another eligible provider exists, the task completes elsewhere without operator action. | Failover test and run history | M6 |
| BO-1 | Share of delegated tasks that finish without operator intervention is at least 80% over a sample of 20 runs *(proposed target)*. | `runs list` filtered by terminal state | M7 |
| BO-2 | Zero credential values in the database, artifacts, logs, telemetry or MCP responses. | Secret-pattern scan of fixtures and outputs ([SRS NFR-SEC-01](SRS.md#41-security-nfr-sec)) | M1 |
| BO-2 | Every enabled provider has a compliance manifest for its installed version; a provider without one is not routed to. | `doctor` output; eligibility test | M2 |
| BO-2 | No login or OAuth code path exists. | Code review gate ([SRS FR-AUTH-01](SRS.md#34-authentication-boundary-fr-auth)) | M1 onward |
| BO-3 | The malicious-fixture suite shows no escape from any profile's limits for every enabled adapter. | Test results ([SRS NFR-SEC-03](SRS.md#41-security-nfr-sec)) | M3 (Claude), M4 (others) |
| BO-3 | Operator's checked-out branch and working tree are unchanged after every run; no remote push occurs. | Workspace tests | M1 |
| BO-3 | Every `privileged` run has a recorded operator approval. | Ledger query on `approval` records | M3 |
| BO-4 | A task continues on the same provider by native resume, and on a different provider via a handoff bundle, with objective, decisions, changed files and failed attempts preserved. | Demonstration and handoff tests | M5 |
| BO-4 | After killing the controller at any point and restarting, every run is terminal or correctly resumed. | Fault-injection test ([SRS NFR-REL-01](SRS.md#42-reliability-nfr-rel)) | M1 |
| BO-5 | For any run, `runs show` or `get_run` returns the routing decision with reasons, policy snapshot, adapter version, changed files and reported versus estimated usage. | Demonstration ([SRS NFR-OBS-01](SRS.md#45-maintainability-and-observability-nfr-maint-nfr-obs)) | M2 (basic), M7 (scored routing reasons) |
| BO-5 | No output presents a capacity estimate as provider-authoritative remaining quota. | Test and inspection ([SRS FR-CAP-03](SRS.md#38-capacity-scheduling-and-resilience-fr-cap)) | M6 |
| BO-6 | A binary version outside an adapter's validated range makes that adapter ineligible until the operator revalidates it. | Adapter tests | M2 |
| BO-6 | Each adapter passes its recorded-fixture conformance suite. | CI results | M2 (Claude), M4 (others) |
| BO-6 | A version canary detects CLI changes. | CI or scheduled-job results | M8 |

## 7. Business risks

The authoritative risk register, blockers and open questions are in [ROADMAP §7](../ROADMAP.md#7-risks-blockers-and-open-questions). The risks that bear on business outcomes:

| Risk | Outcome affected | Note |
|---|---|---|
| A provider changes its terms or restricts automated use of subscriptions. | BO-1, BO-2 | Outside Switchboard's control. The compliance manifest records what was reviewed and for which version ([R2]). |
| Documented automation support is read as permission for any use. | BO-2 | Documentation avoids claims of terms compliance ([SRS NFR-COMP-01](SRS.md#46-privacy-data-and-compliance-nfr-priv-nfr-data-nfr-comp)). |
| The credential store and the agent share an OS user, so sandboxing may be weaker than hoped on some providers. | BO-3 | Arbitrary shell is disabled on untrusted profiles for adapters that cannot confine commands ([SRS FR-POL-06](SRS.md#33-policy-and-trust-profiles-fr-pol)). Some providers may be unusable under untrusted profiles. |
| Quota information is incomplete, so capacity estimates are wrong. | BO-1, BO-5 | Capacity is modelled as a confidence-weighted estimate, not a fact ([ADR-0007](../adr/0007-capacity-as-confidence-estimate.md)). |
| CLI churn outpaces validation. | BO-6 | Version gating makes failure visible and safe, at the cost of operator effort on each update. |
| Kimi Code's automation contract is not pinned. | BO-1 | Kimi Code adapter is blocked until the contract is pinned ([SRS FR-ADP-09](SRS.md#32-provider-adapters-fr-adp)). |
| Sustained effort is required for seven adapters by a single maintainer. | BO-1 | Assumption: no staffing is committed. Sequencing in the [ROADMAP](../ROADMAP.md#6-milestones) delivers value from the first adapter. |

## 8. Open question: personal tool or product

It is not stated whether Switchboard is a personal tool or a product for others. **Assumption:** it is a personal tool for one operator ([ADR-0011](../adr/0011-single-operator-local-deployment.md), a delegated decision, not an owner decision). Consequences of the assumption: no user accounts, no network listener, no hosted service, no sharing of credentials or subscriptions between people, and no product-support obligations.

If zemdregon intends otherwise, this BRD needs new stakeholders, outcomes and constraints, and the provider-terms review in [NFR-COMP-01](SRS.md#46-privacy-data-and-compliance-nfr-priv-nfr-data-nfr-comp) becomes a precondition. zemdregon's answer is needed; it is tracked in [ROADMAP §7](../ROADMAP.md#7-risks-blockers-and-open-questions).

## 9. Outcome to capability map

Capabilities are defined in [PRD §3](PRD.md#3-capabilities). The map shows which capabilities serve each outcome; a capability may serve several.

| Outcome | Capabilities that serve it |
|---|---|
| BO-1 | CAP-1 Task delegation via MCP; CAP-2 Provider adapters; CAP-6 Routing with explanation; CAP-7 Capacity estimation and backpressure |
| BO-2 | CAP-2 Provider adapters (version/auth preflight, compliance manifests); CAP-3 Policy and trust profiles (no bypass flags, no global config changes); CAP-8 Telemetry and audit (redaction) |
| BO-3 | CAP-3 Policy and trust profiles; CAP-4 Workspace isolation; CAP-9 Operator CLI (privileged approval) |
| BO-4 | CAP-5 Meta-sessions and cross-provider continuity; CAP-4 Workspace isolation (checkpoints, rollback); CAP-7 Capacity estimation and backpressure (failover) |
| BO-5 | CAP-6 Routing with explanation; CAP-7 Capacity estimation and backpressure; CAP-8 Telemetry and audit; CAP-9 Operator CLI |
| BO-6 | CAP-2 Provider adapters (version gating, conformance); CAP-9 Operator CLI (`doctor`, `adapters validate`) |
