# Discovery: what Switchboard still needs to be a single-chatbot control plane (2026-10-15)

Status: research input. *Delegated agent work, documentation only; not owner-approved.* Every recommendation here is
**Proposed**. None of it changes the roadmap, the requirements or an ADR. If zemdregon accepts an item, it goes through
the usual path (PRD and SRS first, then a roadmap entry, plus an ADR where a boundary changes), as
[AGENTS.md](../../AGENTS.md) requires.

## 1. The question

zemdregon asked (2026-10-15): what else should Switchboard have to be the best orchestration and management layer for
the coding CLIs? The goal is scoped context, RAG and everything else behind one simple MCP, so that **one chat bot is
enough to keep tabs on several projects that run nearly autonomously in the background**.

This note compares that goal with the current plan ([ROADMAP](../ROADMAP.md), [PRD](../requirements/PRD.md),
[SRS](../requirements/SRS.md), ADRs and code on `main` at `066a03c`) and with comparable tools. It then ranks what to
add, what to cut or defer, and what the chat experience should look like.

**Evidence labels.**

- **Verified (repo):** checked in this repository's files or code on 2026-10-15.
- **Verified (web):** a page the research read directly, with the URL given.
- **Secondary:** taken from a search summary or a third-party write-up, not the primary page.
- **Inferred:** the author's judgement.

## 2. Summary

The plan is strong on everything *beneath* the orchestrator: isolation, trust profiles, no credential handling,
controlled commits, continuity, affinity, capacity and retrieval. It is thin on everything *above* it. Today the MCP
surface assumes a machine orchestrator that remembers its own `run_id`s and polls them. A person talking to one chat bot
needs four other things:

1. **Attention.** One question ("what needs me?") answered across all projects.
2. **Reach.** Alerts that arrive while the chat is closed, and approvals from a phone.
3. **Control.** Steering, pausing and budgets on work that runs unattended.
4. **Continuity of intent.** A durable per-project goal and queue, so that "nearly autonomous" does not mean "only while
   a chat session is open".

The top recommendation is therefore a **control-plane layer**: an inbox, a digest, notifications, steering, pausing and
budgets. It should come before any new provider or retrieval feature, and only after M2's live verification closes.

## 3. What the plan has today (relevant facts)

| Fact | Evidence |
| --- | --- |
| The MCP server advertises **tools only**: `capabilities: { tools: {} }`. It has no resources, prompts or subscriptions. | Verified (repo): `src/mcp/server.ts` (server construction) |
| The tools are `delegate_task`, `continue_task`, `get_run`, `cancel_run`, `get_artifacts`, `list_capabilities`, `list_projects`, `get_capacity` and `explain_route`. Optional extras are dynamic-project tools (FR-PRJ-10) and `search_project_context` (T12.6). **No tool lists runs or reports changes since a point in time.** A client that loses a `run_id` cannot find the run again over MCP. | Verified (repo): `handlers` in `src/mcp/server.ts`; FR-MCP-01 and FR-MCP-02 in [SRS](../requirements/SRS.md#31-mcp-interface-fr-mcp) |
| The server instructions tell clients to "poll get_run (or pass wait_seconds, at most 60)". The interaction model is pull-only. | Verified (repo): `INSTRUCTIONS` in `src/mcp/server.ts` |
| `privileged` approval exists **only** on the operator CLI (`switchboard approve`). MCP can never grant it (FR-MCP-06, FR-MCP-14, FR-POL-09). Approval of dynamic projects is also an operator action (FR-PRJ-10). | Verified (repo): [SRS](../requirements/SRS.md), [FRD §2.1](../requirements/FRD.md) |
| The only way to intervene in a running run is `cancel_run`. There is no steering, pause or follow-up message. Elicitation requests from provider CLIs are refused with `-32601`. | Verified (repo): FRD §2.1 permission matrix; [LLD](../design/LLD.md) ACP client notes |
| Network MCP over Streamable HTTP with OAuth 2.1 is done (M13), so a remote chat app can connect. Client registration uses **Dynamic Client Registration** (FR-MCP-16). | Verified (repo): ROADMAP §6 M13 row, [ADR-0041](../adr/0041-http-transport-with-oauth-2-1.md) |
| The orchestrators zemdregon will test against are a Grok bot, OpenClaw and the regular Claude app (owner decision 36). | Verified (repo): [ROADMAP §4.2](../ROADMAP.md#42-owner-decisions) decision 36 |
| zemdregon's main usability goal is bypass runs in which agents never ask for permission (owner decision 24). | Verified (repo): ROADMAP §4.2 decision 24 |
| PR, CI and merge subscriptions (CAP-14, FR-SUB-01) are **Deferred**, "after everything else" (owner decision 43). | Verified (repo): [PRD §3](../requirements/PRD.md#3-capabilities), [ROADMAP §8](../ROADMAP.md#8-deferred-and-excluded-work) |
| No milestone after M1 is `Done` except M13. M2 waits on operator live checks. | Verified (repo): ROADMAP §6 table |
| The Codex adapter uses `codex exec --json`, not the removed `codex mcp-server`, and does not emit `--full-auto`. | Verified (repo): `src/adapters/codex/adapter.ts` header; Verified (web): <https://learn.chatgpt.com/docs/mcp-server.md> |
| `@modelcontextprotocol/sdk` is pinned at 1.32.1. | Verified (repo): `package.json` |

## 4. Landscape: what comparable tools offer

Every tool below has the same core: one worktree, container or VM per task, plus a diff or PR review surface.
Switchboard has that too. They differ in the oversight layer.

| Tool | Oversight features relevant here | Evidence |
| --- | --- | --- |
| GitHub Copilot coding agent: Agent HQ and mission control | One place to "assign, steer, and track" agents from anywhere, including GitHub Mobile. Steering input is applied "as soon as its current tool call completes". Status at a glance, with a cue to "jump in when Copilot needs your input". | Verified (web): <https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/>, <https://github.blog/news-insights/company-news/welcome-home-agents/> |
| Claude Code agent view and projects | Background dispatch, `claude agents --json`, a "Needs input" state, peek-and-reply to a running session, worktree lock per session, scheduled routines. Spend controls: `--max-budget-usd` and usage attribution. | Verified (web): <https://code.claude.com/docs/en/agents>, <https://code.claude.com/docs/en/agent-view>, <https://code.claude.com/docs/en/costs> |
| Cursor Cloud Agents | Start from mobile, web, Slack, GitHub or Linear. A spend limit is required before first use. Takeover of a running agent. A diagnostics MCP for transcripts and events. Automations. | Verified (web): <https://cursor.com/docs/cloud-agent> |
| Google Jules | Scheduled tasks you can pause and resume; proactively suggested tasks; a critic and a planning critic; CI Fixer for failed checks on its own PRs; an API with an immutable, filterable activity feed and `sendMessage`. | Verified (web): <https://jules.google/docs/changelog/>, <https://developers.google.com/jules/api> |
| Omnara | Mobile push when an agent needs you, one-tap approvals, live intervention for Claude Code and Codex. | Secondary: <https://www.producthunt.com/products/omnara> |
| Conductor, Claude Squad, Vibe Kanban, Nimbalyst (formerly Crystal) | Local multi-agent managers: worktree per agent, kanban or TUI status, diff review, notifications. Nimbalyst adds an iOS app. | Secondary: <https://www.conductor.build>, <https://github.com/smtg-ai/claude-squad>, <https://github.com/BloopAI/vibe-kanban>, <https://github.com/stravu/crystal> |

**The common bar** (Inferred from the table):

- a "needs you" state and inbox;
- notifications that reach a phone;
- steering at tool-call boundaries;
- scheduled and recurring work;
- automatic fixing of CI on the agent's own PRs;
- a critic or review pass;
- spend limits;
- an incremental, event-sourced activity feed.

Switchboard is the only tool here that is multi-provider, subscription-based, self-hosted and fronted by MCP. That is its
niche. The oversight layer is where it falls short of the bar.

**Protocol state.**

- **MCP 2026-07-28 is the current stable spec.** Verified (web): <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
  and the [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog). Relevant changes:
  - The core is stateless: the `initialize` handshake and session ID are gone.
  - Multi Round-Trip Requests replace server-initiated elicitation and sampling.
  - `subscriptions/listen` replaces `resources/subscribe`.
  - Long-running work is the opt-in **Tasks extension** (`tasks/get`, `tasks/update`, `tasks/cancel`).
  - **Dynamic Client Registration is deprecated** in favour of Client ID Metadata Documents.
  - Sampling and Roots are deprecated.
- **A2A 1.0** defines task states that include `INPUT_REQUIRED` and `AUTH_REQUIRED`, plus webhook push notifications.
  Verified (web): <https://a2a-protocol.org/latest/specification/>.
- **ACP** is the editor-to-agent subprocess protocol. Remote transport is still "a work in progress". Verified (web):
  <https://agentclientprotocol.com/get-started/introduction>.

**Context practice.**

- Anthropic's guidance favours just-in-time retrieval, compaction, structured notes and summarising subagents. Verified
  (web): <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>.
- Cursor's current search docs describe a local grep-style index and say it "does not store embeddings of your codebase
  for search". Verified (web): <https://cursor.com/docs/context/codebase-indexing>.
- A Claude Code lead has said agentic search "generally works better" than vector RAG for code. Secondary:
  <https://officechai.com/ai/claude-researcher-explains-how-agentic-search-performed-better-than-rag-for-code-generation/>.
- AGENTS.md is used by more than 60k projects and read by most of the CLIs Switchboard targets. Verified (web):
  <https://agents.md/>.

**Risks seen elsewhere.**

- **The lethal trifecta:** private data, untrusted input and an egress path in one agent. Verified (web):
  <https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/>.
- **MCP tool poisoning.** Verified (web):
  <https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks>.
- **Token multiplication with parallel agents:** about 7x for Claude Code agent teams in plan mode. Verified (web):
  <https://code.claude.com/docs/en/costs>.
- **A review bottleneck.** More PRs arrive, but time to merge grows. Secondary, primary papers not read:
  <https://www.alphaxiv.org/abs/2607.07980.md>.

## 5. The single-chatbot experience (target, Proposed)

The chat bot is just an MCP client. The Claude app over M13 HTTP is one example; the Grok bot and OpenClaw are others.
The experience must work when the chat is closed for hours, so Switchboard owns the state and the chat bot only reads it
and acts on it.

**Morning check.** The user asks "anything need me?" The bot calls one tool and answers:

> 3 projects active overnight. **Needs you (2):** `api` run failed verification three times on the same test and is
> parked; `site` wants approval to push `release/1.4` (approve link sent to your phone). **Finished (4):** two branches
> ready for review in `api`, smallest first (+42/−8, tests passed, critic: no issues). **Spend:** Claude Code about 60%
> of the daily budget used; Codex idle. Nothing is running now.

**Alert while away.** A notification arrives through a channel the operator configured (for example ntfy, email or a
webhook). It carries the project, the event kind, a one-line reason and a link, and no code or prompt text. Examples:
"api: run parked after 3 identical failures", "site: approval needed".

**Approve.** The link opens Switchboard's own consent page, the same page M13 already serves, authenticated by passphrase
or pairing code. The operator approves there. The chat bot can *see* that an approval is pending, but it can never grant
one, so a prompt-injected chat model still cannot approve anything.

**Steer.** The user says "tell the api run to skip the flaky test and keep going". `steer_run` delivers the note at the
next tool-call or turn boundary. Where a provider takes no live input, it stops at a boundary and resumes the same native
session with the note. "Pause everything" pauses dispatch globally, and running work stops at its next boundary.

**Queue.** The user says "next for api: bump dependencies weekly, and fix CI whenever it breaks on our branches". This
becomes a durable schedule and a trigger in the project's queue, not something the chat bot must remember.

## 6. Ranked recommendations: add

The rank weighs value to the stated goal against cost and risk. Owner decisions are needed where noted.

| Rank | Recommendation | Why | Fits with | Needs |
| --- | --- | --- | --- | --- |
| 1 | **Attention inbox and digest over MCP.** Add `list_runs` (filtered by project, status and time) and `get_digest(since_cursor)`. The digest returns, per project: what needs attention, what finished, what failed, pending approvals, and budget state. It also returns a new cursor taken from the append-only `run_event` ledger. Add a derived **`NEEDS_ATTENTION`** flag, with a reason, on runs that are parked, failed after retries, awaiting approval or stalled. | The chat bot cannot answer "what's going on?" today. Verified gap: no run-listing tool. This is cheap because the ledger already holds the events (FR-TEL-01, FR-SES-05). | FR-MCP-04 compact envelopes; scoped per client like `get_run`. | SRS FR-MCP additions; no ADR (read-only, same trust boundary). |
| 2 | **Out-of-band notifications.** Operator-configured sinks (generic webhook first, then ntfy or email), each with an event filter and rate limit. Payloads hold only metadata: no code, prompts, diffs or untrusted agent text beyond a length-capped, labelled summary. | Chat apps do not hold an MCP stream open. Under MCP 2026-07-28, notifications travel on a request's stream or through `subscriptions/listen`, and client support for that in chat apps is unknown (Inferred). Alerts must not depend on the chat being open. | CAP-8 telemetry boundary; NFR-PRIV-01 redaction. | New egress path: **ADR** (data that leaves the host). Not bypass-relevant, so **Delegated** under the working rules. |
| 3 | **Steer, pause and kill switch.** `steer_run(run_id, note)` at the next boundary: live input where the adapter supports it, otherwise stop at a boundary and resume natively with the note (FR-SES-03). Add `pause_project`, `resume_project` and an operator-only `pause_all`. | Matches the GitHub, Claude Code and Cursor bar. `cancel_run` loses momentum. Unattended work needs a global brake. | FR-SES-06 (one active run per meta-session); BR-7 (no blind replay), because steering is a continuation, not a replay. | FRD state additions (`PAUSED`). Per-adapter live-input support is unverified, so it needs a spike per adapter. |
| 4 | **Autonomy guardrails and budgets.** Per-project and global caps: runs per day, concurrent runs, wall-clock per run, and *reported* usage per window. A **loop breaker**: the same failure code or the same failing check N times in a meta-session parks the work as `NEEDS_ATTENTION`. **Stall detection**: no events for T minutes. A ceiling on successor runs per meta-session. | Without these, "nearly autonomous" risks runaway spend and stuck loops, both documented elsewhere (§4). FR-CAP-05 bounds retries per failure but not repeated failing *tasks*. | ADR-0007 (no invented quota numbers): caps are operator-set values, never presented as provider limits. | SRS FR-CAP additions. Owner input only on defaults. Delegated otherwise. |
| 5 | **Remote approval without MCP authority.** Pending approvals for privileged scope, dynamic projects and push-enabled publication appear in the digest. Each carries a single-use approval link to the existing consent page, authenticated by passphrase or pairing code (FR-MCP-17 machinery). The CLI stays a valid path. | Today an approval waits until the operator reaches a terminal. That defeats the phone and chat goal. This keeps FR-MCP-06's rule that MCP never grants `privileged`. | M13 consent page; FR-POL-09; FR-OPS-02. | **Owner decision plus ADR**: it changes how a trust boundary is crossed, even though the boundary itself does not move. |
| 6 | **Durable project queue, schedules and triggers.** Per project: a queue of pending tasks with dependencies and priority, cron-style schedules, and triggers. The first trigger is "CI failed on a branch this project published", which brings CAP-14 forward in a narrowed form. Each item is admitted exactly like a `delegate_task` from the client that created it, under that client's ceiling. | This makes work continue while the chat is closed. Jules and Claude Code routines are the precedent. | FR-PRJ-10 dynamic projects; CAP-14 / FR-SUB-01 (Deferred); owner decision 43 says "after everything else". | **Owner decision** to re-sequence CAP-14. Reading CI status needs a credential path, and ADR-0003 forbids Switchboard handling credentials, so this needs an ADR (for example, use the operator's `gh` login as an external CLI, the way provider CLIs are used). |
| 7 | **Review pipeline before the human.** Optional critic run on a *different* provider under `inspect-untrusted`, read-only, over the diff. Its verdict is labelled advisory. Results are ranked by reviewability: diff size, verification passed, critic verdict. PR drafts already exist (IT-2). | Review capacity, not agent throughput, is the real limit (§4). The critic is advisory only, like IT-12, and never decides run status. | FR-INN-06 spirit (no authority); FR-EXE-08 verification. | PRD use case and SRS. Uses the premium capacity of a second provider, so it should be opt-in per project. |
| 8 | **Project brief and memory.** A controller-owned, per-project record: goal, definition of done, conventions, a decisions log, and known failures. It is written by the operator or the owning client, and is labelled untrusted when it comes from agents. It is prepended to the context pack before retrieval snippets and kept small. | It gives continuity of intent across meta-sessions and providers. The handoff bundle covers only one meta-session (FR-SES-04). It matches the "structured notes" practice (§4). | CAP-13 context pack (LLD §14.11); AGENTS.md stays the repository's own file. | PRD and SRS. No ADR if it reuses the context-pack trust rules (ADR-0031). |
| 9 | **One simple chat-facing tool profile.** A per-client `tool_profile`. `console` exposes a handful of tools: `status`/`get_digest`, `delegate_task`, `steer_run`, `pause`, `list_runs`, `get_run`. `orchestrator` exposes the full set. Descriptions stay short. Details go through `get_run` and artifacts rather than more tools. | "One simple MCP". Every tool description costs context on every chat turn (Inferred). | FR-OPS-04 client entries. | SRS. Delegated. |
| 10 | **MCP 2026-07-28 readiness spike.** Check SDK support for the stateless core, MRTR, `subscriptions/listen` and the Tasks extension, and whether the target chat apps (Claude app, Grok bot, OpenClaw) speak it. Plan the move from DCR (FR-MCP-16) to Client ID Metadata Documents. Consider mapping `delegate_task` onto the Tasks extension where clients support it. | M13 was built on a registration method the spec now deprecates. Clients may change underneath it. | ADR-0041, FR-MCP-12 to FR-MCP-17. | A spike, then an ADR superseding part of ADR-0041 if needed. |
| 11 | **Measure retrieval before extending it.** A small fixed task set run with and without the context pack, recording tokens, turns and success. Freeze T12.6 (agent-callable search) and further global-index work until the evaluation shows a gain. | R-57 already says the saving is unmeasured. The field has moved toward agentic search plus memory files (§4). | CAP-13, BO-9, R-57. | Roadmap task. Delegated. |

## 7. Ranked recommendations: cut, defer or reorder

| Rank | Recommendation | Reason |
| --- | --- | --- |
| 1 | **Finish live verification before new features.** Close M2's operator live checks (ROADMAP §9), then the M4, M5 and M6 "Blocks Done" lists. | Almost everything is `Partial` on fakes and synthetic fixtures. A control plane over unverified adapters would report confident status about behaviour nobody has seen. *Update 2026-10-16 (Delegated, ROADMAP reconcile):* M2's `npm run test:live` smoke **ran on Ampere 2026-10-14** ([live-checks-2026-10-14-claude-codex.md](live-checks-2026-10-14-claude-codex.md)); residual **Operator** cells (C-12, C-G2, X-4, X-9, X-G1) remain NOT_CHECKED per that record. |
| 2 | **Defer Muse Code (FR-ADP-12).** | zemdregon has no access yet (Q-27, "not yet"), and the evidence is third-party (R-33). |
| 3 | **Freeze the deployment-wide index and agent-callable search** (T12.7 follow-ups, T12.6) until recommendation 11 has data. | Unmeasured benefit, extra cross-project risk (R-55, R-56). |
| 4 | **Demote inner-agent routing classification (IT-3).** | Sticky affinity (ADR-0032) means most runs never reach stage-2 scoring, so the feature rarely matters (Inferred). |
| 5 | **Put OTel export (M8) after notifications.** | One person with a chat bot benefits more from alerts than from traces. |
| 6 | **Lighten the documentation weight.** The roadmap is about 2,900 lines and the LLD about 4,800 (Verified (repo), `wc -l`). Consider a short status page per milestone, with detail moved into task PRs. | Process cost now competes with delivery for one maintainer (R-6). This is a suggestion, not a rule change. |

**Keep as they are** (Inferred): automatic merge deferred, the upstream ACP server deferred, learned routing deferred,
and multi-user operation excluded.

## 8. Risks the new layer introduces

| Risk | Why it matters | Proposed control |
| --- | --- | --- |
| The chat bot is an LLM that holds `delegate_task` and reads agent-written summaries. Injected text in a run summary could steer it into new delegations: the lethal-trifecta pattern (§4). | Higher reach than a scripted orchestrator. | Digest text from agents is labelled untrusted and length-capped. The client's trust ceiling stays at `edit-untrusted` or lower by default. Approvals stay out of band (recommendation 5). Schedules and triggers created by a chat client wait for operator approval when they widen what the client could do in one call (as FR-PRJ-10 does for projects). |
| Notifications are a new egress path. | A leak of code or secrets to a third-party push service. | Metadata-only payloads, deterministic redaction, operator-chosen sinks, off by default. |
| Autonomy amplifies spend and review load. | More output than the operator can review; budgets exhausted by schedules. | Recommendations 4 and 7; default schedules off; digest ranks by reviewability. |
| MCP spec churn. | A client update could break M13 or the chat bot connection. | Recommendation 10; keep stdio working; pin and test the SDK. |
| Scope for one maintainer (R-6) grows again. | Slower delivery of everything. | Section 7 cuts. Build recommendations 1 to 4 first: they reuse the ledger and lifecycle that already exist. |

## 9. Suggested order (Proposed)

1. M2 live verification (section 7, rank 1).
2. A new "control plane" milestone carrying recommendations 1, 3, 4 and 9 (no new boundary), then 2 (ADR).
3. Recommendation 5 (owner decision and ADR) and recommendation 10 (spike).
4. Recommendations 6 and 7 (owner decision on CAP-14), with 8 alongside.
5. Recommendation 11 before any further retrieval work.

## 10. Questions for zemdregon

1. Should the control plane (inbox, digest, steering, pause, budgets) become the next milestone after M2's live checks,
   ahead of the remaining M4 adapters?
2. May approvals happen from a phone through Switchboard's own consent page (recommendation 5)? The chat model would
   still never be able to approve.
3. Should PR and CI events (CAP-14) move forward in a narrowed form ("fix CI on our own branches"), rather than wait
   until everything else is done?
4. Which notification channel do you want first: a generic webhook, ntfy, email or a chat app?
5. Which chat client matters most first: the Claude app over HTTP, the Grok bot or OpenClaw?
