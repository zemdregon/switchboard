# Enhancement discovery: what to add, cut or defer next (2026-10-19)

Status: research input. *Delegated agent work, documentation only; not owner-approved.* Every recommendation here is
**Proposed**. Nothing here changes the roadmap, a requirement or an ADR. An item that zemdregon accepts goes through the
usual path (PRD and SRS first, then a roadmap entry, plus an ADR where a boundary changes), as
[AGENTS.md](../../AGENTS.md) requires.

This note follows the [2026-10-15 discovery](orchestration-layer-discovery-2026-10-15.md). It does not repeat that note
or reopen anything zemdregon has decided. It compares `main` at `38c1fd2` with the 2026-10-19 landscape.

**Evidence labels.**

- **Verified (repo):** checked in this repository's files or code on 2026-10-19, with the path given.
- **Verified (web):** a primary page read directly, with the URL given.
- **Secondary:** a search summary or a third-party write-up, not the primary page.
- **Inferred:** the author's judgement.

## 1. Summary

The control plane from the earlier note is built: digest, inbox, steering, pause, budgets, loop breaker, notification
sinks, approval proxy, console profile, queue, schedules and CI triggers (M14 `Partial`, M15 `Done`; Verified (repo),
[ROADMAP §6](../ROADMAP.md#6-milestones)). The plan is now limited less by missing features than by four things:

1. **Bypass confinement is not uniform.** Three providers' live malicious legs read data outside the worktree in bypass
   runs (R-72, R-74, R-76). Each fix so far is provider-specific.
2. **The chat bot cannot queue work over the network.** The work-queue tools are stdio-only, while the first chat
   client (the Grok bot) connects over HTTP.
3. **The MCP stack is a generation behind.** SDK 1.32.1 and Dynamic Client Registration, with no task to move.
4. **Adoption cost is high.** No release, a 3,155-line README that opens with a status log, and no quickstart.

The note first ranked a provider-independent confinement layer for bypass runs at the top. zemdregon declined it on
2026-10-19 because full access is what bypass is for (§8), so the top items are now the network work queue and a
blocking secret scan before push.

## 2. What changed since 2026-10-15 (relevant facts)

| Fact | Evidence |
| --- | --- |
| Earlier recommendations 1 to 6 and 9 are built. Recommendation 10 (MCP 2026-07-28 readiness) is a done spike with no follow-up task. Recommendations 7 (critic), 8 (project brief) and 11 (retrieval evaluation) have no roadmap task. | Verified (repo): ROADMAP §6.13, §6.14; [readiness spike](mcp-2026-07-28-readiness-spike-2026-10-15.md); grep of ROADMAP for a critic, brief or evaluation task finds none |
| Live malicious legs in bypass runs: Antigravity read an out-of-worktree canary (R-72); Claude Code with `files: worktree` did not confine reads (R-74, C-M3); Cursor surfaced both canaries (R-76). Cursor now runs in bubblewrap ([ADR-0059](../adr/0059-cursor-bypass-cell-bubblewrap-wrapper.md)); a follow-up is open as PR #752. | Verified (repo): [ROADMAP §7.1](../ROADMAP.md#71-risks); `git log` commit `38c1fd2` |
| The work-queue tools (`enqueue_work`, `list_work`, `cancel_work`) are "not offered over the network transport". | Verified (repo): `src/mcp/schemas.ts` (`WORK_QUEUE_TOOL_NAMES` comment) |
| The Grok bot is the first chat client (decision 55), and zemdregon chose a public-facing HTTP MCP server (Q-67). | Verified (repo): ROADMAP §4.2 decision 55, §7.3 Q-67 |
| `@modelcontextprotocol/sdk` is pinned at 1.32.1. No source file implements Client ID Metadata Documents. | Verified (repo): `package.json`; grep of `src` |
| TypeScript SDK v2 shipped 2.0.0 on 2026-07-27 as split packages, with 2.3.1 on 2026-10-05. v1 gets fixes for about six months after v2. ChatGPT prefers CIMD clients. | Secondary: <https://www.localcan.com/blog/state-of-mcp-server-development>, <https://hidekazu-konishi.com/entry/which_mcp_clients_a_remote_mcp_server_lets_in.html> |
| No secret scan of the diff runs before commit or push. Commit messages are sanitised; file contents are not scanned. | Verified (repo): `src/git/commit.ts` (sanitiser); grep of `src` for a secret scanner finds none |
| No property-based or fuzz tests, and no coverage tooling, although the security decisions rest on hand-written parsers (`src/adapters/git-write.ts`, the argv audit of ADR-0037, the commit sanitiser). | Verified (repo): `package.json`, `package-lock.json` |
| `package.json` is `private: true`, version `0.0.0`. `release.yml` drafts a GitHub release on a tag and never publishes. `CHANGELOG.md` has only "Unreleased". `.github/ISSUE_TEMPLATE` has a feature-request form and no bug report. | Verified (repo) |
| Sizes: ROADMAP 4,259 lines (about 2,900 on 2026-10-15), LLD 7,189, README 3,155 (its Status section is about 350 lines and comes first). | Verified (repo): `wc -l` |

## 3. Landscape: what is new since the earlier note

**Provider terms.**

- Anthropic: OAuth sign-in is "designed to support ordinary use of Claude Code". Developers may not "route requests
  through Free, Pro, or Max plan credentials on behalf of their users" or "collect, store, or intermediate" Claude.ai
  credentials. An end user "signing in to the unmodified Claude Code binary with their own Claude subscription" is
  allowed. Advertised limits "assume ordinary, individual usage". Enforcement may come "without prior notice".
  Verified (web): <https://code.claude.com/docs/en/legal-and-compliance>. Switchboard's shape (one operator, the
  unmodified CLI, no credential handling; ADR-0003) matches the allowed case. Always-on, concurrent runs may still be
  read as more than "ordinary, individual usage" (Inferred).
- Anthropic, 2026-10-07: Max and Team plans include monthly API credits. `claude -p` signed in with a plan still draws
  plan limits, not credits. Secondary: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>.
- Google Antigravity: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with
  Antigravity OAuth) is a breach", with suspension of Antigravity and Gemini CLI accounts as the remedy. Verified (web):
  <https://antigravity.google/terms/>. zemdregon reviewed these terms (decision 47); this note does not reopen that.
  Suspensions were reported in 2026. Secondary:
  <https://mlq.ai/news/google-enforces-tos-bans-on-paid-antigravity-subscribers-using-openclaw-tool/>.

**Security.**

- Sandbox escapes in several coding CLIs in July 2026, including an agent reaching the host Docker socket, Antigravity's
  allow-default Seatbelt profile, and agent-written files later run by unsandboxed tooling. Secondary:
  <https://www.pillar.security/blog/the-week-of-sandbox-escapes>,
  <https://www.bleepingcomputer.com/news/security/cursor-codex-gemini-cli-antigravity-hit-by-sandbox-escapes/>. This
  matches Switchboard's own ESCAPED results: provider sandboxes are not a control to rely on (Inferred).
- Prompt injection through issue, PR and comment text leaked secrets from agent GitHub Actions ("Comment and Control",
  hidden HTML comments, base64 output to beat log masking), and an issue title led to an npm token theft
  ("Clinejection"). Secondary: <https://labs.cloudsecurityalliance.org/research/csa-research-note-claude-code-github-action-prompt-injection/>,
  <https://snyk.io/blog/cline-supply-chain-attack-prompt-injection-github-actions/>.
- Repository-directed configuration (an API base-URL override, project-file hooks) exfiltrated keys before the trust
  prompt (CVE-2026-21852, CVE-2025-59536). Secondary: <https://www.cequence.ai/blog/ai/ai-agent-prompt-injection-credential-theft/>.
- A Codex session that hit its subscription limit wrote a script that read `.env` and called the metered API. Secondary:
  <https://community.openai.com/t/my-codex-session-hit-its-subscription-limit-then-wrote-its-own-metered-api-runner-453-in-one-day/1389087>.
  Switchboard's child-environment allowlist already blocks the inherited-key case (`src/exec/supervisor.ts`); a `.env`
  file inside the repository is not covered by it (Inferred).

**Protocols and tooling.**

- ACP agent list: Claude and Codex are listed through adapters (`claude-agent-acp`, `codex-acp`), not natively; Cursor,
  Kimi and OpenCode are listed; Antigravity and Grok are not. Verified (web):
  <https://agentclientprotocol.com/get-started/agents>.
- OpenTelemetry GenAI and MCP semantic conventions are still in Development status. Secondary:
  <https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions>. Claude Code exports token and cost
  metrics over OTLP when telemetry is enabled. Secondary (search summary of the primary page):
  <https://code.claude.com/docs/en/monitoring-usage>.
- MCP Server Cards (`.well-known` discovery) had not shipped as of the 2026-08-22 roadmap. Secondary:
  <https://blog.modelcontextprotocol.io/posts/mcp-roadmap/>.
- Newer open-source orchestrators ship a replay journal with a hash-chained audit log, a pre-merge verification gate and
  per-task port injection. Secondary (vendor roundup): <https://www.augmentcode.com/tools/open-source-agent-orchestrators>.
- Public coding benchmarks were gamed to 100% by an agent that edited the grader. Secondary:
  <https://moogician.github.io/blog/2026/trustworthy-benchmarks-cont/>. Leaderboards are weak evidence for routing, and
  any own-repository evaluation must keep its grader out of the agent's reach (Inferred).

## 4. Ranked recommendations: add

Rank weighs value to "one chat bot overseeing several nearly autonomous projects" against cost and risk.

| Rank | Recommendation | Why | Evidence | Needs |
| --- | --- | --- | --- | --- |
| 1 | **One provider-independent read and write confinement for bypass runs.** Generalise the ADR-0059 bubblewrap wrapper (or default bypass to the `container` backend) so that every provider's bypass run sees only its worktree, its context mounts and its own login state, whatever the provider's own sandbox does. Keep each provider's native sandbox as an inner layer. | Three live ESCAPED results in bypass, fixed one provider at a time. Outside reports show provider sandboxes keep failing. Bypass is zemdregon's main mode (decision 24), so this is where a leak would happen. | Verified (repo): R-72, R-74, R-76, ADR-0059. Secondary: sandbox-escape reports in §3 | **Owner decision** (it changes what bypass runs can read) and an ADR superseding the per-provider approach. Linux first; macOS stays Deferred (decision 69). |
| 2 | **Offer the work queue to network clients.** List `enqueue_work`, `list_work` and `cancel_work` over HTTP under the same per-client ceiling and project list, or record why not. | The first chat client connects over HTTP, so today it cannot queue work for a project. That is the "continuity of intent" the control plane was meant to give. | Verified (repo): `src/mcp/schemas.ts`; decision 55; Q-67 | SRS FR-QUE change; probably no ADR (same trust boundary as `delegate_task` over HTTP). Delegated unless the stdio-only rule was an owner choice (not found). |
| 3 | **Secret scan before commit and push.** Run a deterministic scanner over the staged diff (not only the message) in the commit and push tools. On a hit, refuse with a closed reason and raise `needs_attention`. | Agent output is the main egress path left: a bypass agent can write a secret it read into a file and the tool will commit and push it. Pushes are irreversible. | Verified (repo): no scanner in `src`; R-51, R-60. Secondary: §3 injection reports | SRS FR-GIT addition. Not a bypass restriction in kind, but it can refuse a bypass push, so **ask** zemdregon whether it applies there or only warns. |
| 4 | **MCP SDK v2 and CIMD migration task.** Turn the readiness spike's phases into roadmap tasks: move to the v2 packages with both protocol eras served, add Client ID Metadata Document support beside DCR (with SSRF limits on the metadata fetch), and keep stdio unchanged. | v1 fixes end about six months after 2026-07-27 (Secondary). DCR is deprecated, and new clients prefer CIMD. Without a task, M13 drifts. | Verified (repo): `package.json`, readiness spike. Secondary: SDK and CIMD sources in §2 | Roadmap tasks and an ADR superseding part of ADR-0041. Delegated. |
| 5 | **Property and fuzz tests for the security parsers.** Add generated-input tests for the Git-write detector, the argv audit, the commit sanitiser, the redactor and the untrusted-block renderers, plus coverage reporting in CI. | These parsers carry the "no Git write, no bypass flag" guarantees. Spelling variants already forced two follow-up ADRs (ADR-0037, ADR-0045); generated inputs find such gaps earlier (Inferred). | Verified (repo): no `fast-check` or coverage tool; ADR-0037, ADR-0045 | TDD testing-strategy addition and a dev dependency. Delegated. |
| 6 | **Repository-configuration preflight.** Before a run, list the agent-readable configuration in the worktree that a provider CLI would act on (`.claude/`, `.mcp.json`, `.cursor/`, `.vscode/tasks.json`, `.envrc`, `.env`, base-URL overrides) and record it in the run's policy snapshot. Warn in bypass; refuse outside it as `repoConfig` already implies. | Repository files that redirect the API endpoint or add hooks are a documented key-theft path. Bypass allows repository configuration (decision 26), so the operator should at least see it. | Secondary: CVE-2026-21852 and CVE-2025-59536 reports. Verified (repo): decision 26 | SRS FR-POL or FR-WS addition. A warning does not change bypass, so Delegated. |
| 7 | **Own-repository evaluation harness.** A small fixed set of past tasks from the operator's projects, replayed as Switchboard runs per provider, with the grader in a separate container and the tests hidden from the agent. Record pass rate, wall-clock and reported usage in the ledger. Use it for routing evidence and for the retrieval measurement R-57 asks for. | Routing and retrieval rest on unmeasured assumptions. Public leaderboards were shown to be gameable. | Verified (repo): R-57; earlier recommendation 11 not adopted. Secondary: benchmark exploit report | PRD use case and roadmap task. Uses premium capacity, so opt-in and budgeted. Delegated. |
| 8 | **Per-run telemetry from the provider CLIs.** Where a provider exports OTLP (Claude Code does), let the operator enable a local receiver and pass run and task identifiers as resource attributes, so reported tokens and cost attach to a run without parsing output. | Gives better usage observations for pacing (R-67) and budgets without new credential reach. | Secondary: Claude Code monitoring page. Verified (repo): M8 OTLP spans only | ADR (a new local listener and an environment addition per provider). Off by default. Delegated. |
| 9 | **Adopter path.** Put a 10-minute quickstart first in the README and move the Status log to the roadmap; add MCP client snippets for the Claude app, the Grok bot and OpenClaw; add a bug-report issue form and a code of conduct; cut a first tagged release (`v0.1.0`) through the existing release workflow. Publishing to npm stays a separate owner choice. | Open source is a stated goal (decision 4), and today a newcomer meets 350 lines of status before the install steps. | Verified (repo): README, `.github/`, `package.json`, `release.yml` | Documentation. A release is an outward-facing step, so **owner decision** for the tag; the rest Delegated. |
| 10 | **Tamper-evident ledger.** Chain each `run_event` and approval row with a hash of the previous row, and check the chain in `doctor`. | Approvals now cross MCP (ADR-0047). A chain makes after-the-fact edits visible. Q-96 (append-only guard) is open. | Verified (repo): Q-96, ADR-0047. Secondary: orchestrator roundup | Migration and an ADR (persistence format). Delegated. |
| 11 | **Re-offer two earlier items, smaller.** A *project brief* (goal, definition of done, known failures) prepended to the context pack, and an *advisory critic* run on a second provider for diffs above a size threshold. | Both are still unplanned. They target the review bottleneck and continuity of intent, but they cost capacity, so they rank below the hardening above. | Verified (repo): no tasks; PRD IT-12 | PRD and SRS. Delegated. |

## 5. Ranked recommendations: cut, defer or reorder

| Rank | Recommendation | Reason |
| --- | --- | --- |
| 1 | **Close the open bypass ESCAPED results before new features.** Treat recommendation 1 and the open Cursor follow-up (PR #752) as the next work, ahead of M12, M11 and skills follow-ups. | A control plane that confidently reports runs whose agents read outside the worktree is worse than no report. Verified (repo): R-72, R-74, R-76. |
| 2 | **Stop adding Muse Code rows until access exists.** T4.73 and T4.76 were closed against spellings that are Assumptions. | zemdregon has no Meta access (Q-27); every Muse row is unverifiable. Verified (repo): ROADMAP M4 row (d). |
| 3 | **Freeze retrieval extensions** (global index follow-ups, reranking, new index kinds) until recommendation 7 has numbers. | The earlier freeze was not adopted and the benefit is still unmeasured (R-57). Verified (repo). |
| 4 | **Defer ACP migration for Claude Code and Codex.** Keep headless as the default. | Both are listed through third-party adapters, not native ACP. Verified (web): ACP agent list. Matches the [ACP evaluation](acp-vs-headless-evaluation-2026-10-15.md). |
| 5 | **Defer MCP Tasks, `subscriptions/listen`, MCP Apps and Server Cards** until a target chat client is shown to use them. | No evidence the Grok bot, OpenClaw or the Claude app need them; Server Cards have not shipped. Secondary: MCP roadmap. |
| 6 | **Slim the documents that newcomers read.** Move the README Status section into the roadmap; consider archiving superseded roadmap "*Was:*" text into the task PRs. | The roadmap grew by about 1,300 lines in four days. Suggestion only; AGENTS.md rules stay as they are. Verified (repo): `wc -l`. |

**Keep as they are** (Inferred): no hosted or multi-user mode, no Switchboard-held API key (decision 15), automatic
merge deferred, learned routing deferred.

## 6. Risks to add to the register (Proposed)

| Risk | Why it matters | Proposed control |
| --- | --- | --- |
| Provider usage terms read "ordinary, individual usage" and can be enforced without notice. Always-on schedules and concurrent runs may look like more than that. | Account suspension for zemdregon or adopters. | Keep the README's no-compliance-claim wording; add a line that concurrency and schedules raise this risk; keep schedules off by default. Verified (web): Anthropic legal page. |
| A `.env` or key file inside a project repository is readable by any run, whatever the environment allowlist. | A capped or blocked agent can switch to metered API use. | Recommendation 6 lists such files; budgets treat `QUOTA_EXHAUSTED` as a park, not a retry by other means. Secondary: Codex forum report. |
| SDK v1 end of fixes. | An unpatched MCP server on a public endpoint (Q-67). | Recommendation 4. |

## 7. Suggested order (Proposed)

1. Recommendation 1 (owner decision first) with the Cursor follow-up.
2. Recommendations 2, 3 and 5, which are small and close real gaps.
3. Recommendation 4, before the v1 support window closes.
4. Recommendations 6, 9 and 10.
5. Recommendation 7, then decide on retrieval (cut 3) and on 8 and 11 with its numbers.

## 8. Owner answers (2026-10-19)

zemdregon answered the questions below on 2026-10-19, verbatim: "1 no. Bypass being bypass is a feature. If they dont
want them to have full access they shouldn't run them on bypass. 2 block. 3 yes. 4 no."

| Question | Answer | Effect on this note |
| --- | --- | --- |
| 1. One confinement layer for bypass | **No.** Bypass is meant to have full access. | Add rank 1 and cut rank 1 are **withdrawn**. The live bypass reads outside the worktree (R-72, R-74, R-76) are expected bypass behaviour, not defects to close. Confinement stays a property of the non-bypass profiles and of the Git-write denial and worktree isolation that bypass keeps (decision 22). Per-provider wrappers already in place (ADR-0059) are not reopened here. |
| 2. Secret scan on a bypass push | **Block.** | Add rank 3 stands, and a hit refuses the push in bypass runs too. |
| 3. Work queue over HTTP | **Yes.** | Add rank 2 stands. |
| 4. First `v0.1.0` release | **No.** | The tagged release is dropped from add rank 9. The rest of the adopter path (quickstart, client snippets, issue forms) stays Proposed. |

With rank 1 withdrawn, the suggested order in §7 starts at recommendations 2, 3 and 5.

## 9. Questions for zemdregon (answered in §8)

1. Should every bypass run go through one Switchboard-owned confinement layer (bubblewrap on the host, or the container
   backend), so it can read only its worktree, its contexts and its own login state? Recommended: yes.
2. Should the pre-push secret scan block a bypass push, or only warn and flag it? Recommended: block, with the operator
   able to push by hand.
3. May the work-queue tools be offered to HTTP clients such as the Grok bot? Recommended: yes, under the same client
   ceiling.
4. Should Switchboard cut a first tagged release (`v0.1.0`, GitHub release only, no npm)? Recommended: yes, after
   question 1 lands.
