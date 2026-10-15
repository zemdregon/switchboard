# Decision memo: headless `-p` or ACP for driving provider CLIs (2026-10-15)

Status: research input and recommendation. *Delegated agent work, not owner-approved.* Every recommendation here is
**Proposed**. Nothing in this memo changes an ADR, a requirement or the roadmap. Where an accepted or proposed ADR
would have to change, section 8 says how, and the change goes through the usual path ([AGENTS.md](../../AGENTS.md)).

## 1. The question

zemdregon asked (2026-10-15): should Switchboard keep driving the coding CLIs through their headless print or exec
modes (`claude -p`, `codex exec`, `grok -p` and so on), or move to the Agent Client Protocol (ACP), or use both?

The question matters now because the next milestone is the control plane (ROADMAP §4.2 decisions 49 to 55): steering a
running run, pausing, and approvals proxied through the chat bot. Headless one-shot runs were chosen when the only
intervention was `cancel_run`.

## 2. Answer

**Use both, with headless as the default, and choose the transport per provider.** Do not migrate wholesale to ACP.

| Provider | Default transport (Proposed) | ACP role | Live control for M14 |
| --- | --- | --- | --- |
| Claude Code | Keep `claude -p`; move to long-lived `--input-format stream-json` for M14 | None. Do not use the ACP adapter | Native: `priority` on queued user messages and the `interrupt` control request |
| Codex | Keep `codex exec --json` | Candidate M14 transport through `codex-acp` (spike S2) | Via `codex-acp` or `codex app-server` `turn/steer`; otherwise stop and resume |
| Grok Build | Keep `grok -p --output-format streaming-json` | Fallback; spike S4 before any use | Stop and resume |
| Cursor | Keep `agent -p --output-format stream-json` | No (reported resume and MCP bugs; no sandbox flag in ACP mode) | Stop and resume |
| OpenCode | Keep `opencode run --format json` | Candidate after spike S5 | Stop and resume |
| Kimi Code | **ACP (`kimi acp`)** once B-1 clears | Primary | `session/cancel` then resume; no steering found |
| Antigravity | Keep `agy -p --output-format stream-json` | No (separate binary, separate login, no stdio MCP) | Stop and resume |

The reasons, in short:

1. **Headless already works and is verified.** Every M2 and M4 adapter, parser, profile compiler and live check
   (`docs/research/live-checks-2026-10-1*.md`) is built on the headless surfaces. Moving them costs the evidence, not
   just the code.
2. **The sandbox and policy controls live on the headless argv.** For Grok, Cursor and Antigravity the ACP entry point
   takes none of the `--sandbox`, `--mode` or permission flags the trust profiles compile to (section 5). ADR-0036
   item 9.5 already says ACP permission answers can never be the only control.
3. **zemdregon's main goal is bypass runs** (owner decision 24) and owner decision 48 makes every ACP permission
   request in a bypass run "allow once". So ACP's biggest feature, a per-tool-call permission callback, does little for
   the runs that matter most. The approvals the chat bot proxies (decision 50) are run-level: privileged scope, dynamic
   projects and push. Switchboard owns those, so they need no provider protocol.
4. **ACP has no standard steering or pause.** v1 has none; the v2 draft explicitly leaves queueing and steering
   unspecified (section 4). Two adapters offer a `_session/steering` extension, but it is not in the specification.
5. **Steering is available where it matters without ACP.** Claude Code's documented stream-json input supports queued
   and interrupting messages. For the rest, "stop at a boundary and resume natively with the note" works through the
   resume support every adapter already has (FR-SES-03).
6. **ACP is the better surface for Kimi**: headless `-p` auto-approves every tool call with no way to ask, while ACP
   offers per-session MCP over stdio, resume and permission requests (section 5.6).
7. **The ACP client is already built** (`src/exec/acp/`, T4.8, about 780 lines with its permission policy), so using
   ACP for one or two providers is cheap. The cost is per adapter, not per transport.

## 3. Method and evidence labels

- **V (primary):** read on the vendor's or the ACP project's own page, repository or package registry on 2026-10-15.
  Delegated research workers read most of these pages; the URLs are in section 11.
- **V (repo):** checked in this repository, including the dated live-check notes.
- **V (probe):** observed by running an ACP handshake in this session's cloud container (section 6). No model was
  called, no prompt was sent, no `authenticate` was called and no credential file was read.
- **S (secondary):** search summaries, forum threads or third-party write-ups.
- **I (inferred):** the author's judgement.

## 4. ACP today

| Fact | Label |
| --- | --- |
| The stable protocol is v1 (`protocolVersion: 1`), extended additively through RFDs. | V (primary): `/protocol/v1/overview`, `/rfds/updates` |
| v2 is still a draft, published 2026-07-20. The migration guide says to gate v2 behind version negotiation and feature flags and to support v1 and v2 side by side. | V (primary): `/announcements/acp-v2-draft`, `/protocol/v2/migration` |
| v2 changes the prompt lifecycle: `session/prompt` returns once the message is inserted, and completion arrives as a `state_update` (`running`, `idle`, `requires_action`). It removes `session/load`, `session/set_mode`, `fs/*` and `terminal/*`, and renames `authenticate` to `auth/login`. | V (primary): `/protocol/v2/migration` |
| No steering or queueing in v1 or v2. The v2 prompt RFD says it "does not specify queueing, steering, or whether agents insert new prompts while busy". There is no pause either. | V (primary): `/rfds/v2/prompt`, `/rfds/v2/overview` |
| `session/list`, `session/resume`, `session/close`, elicitation, config options and `usage_update` are stabilized. `session/fork`, MCP-over-ACP, proxy chains and the remote (HTTP and WebSocket) transport are still drafts. | V (primary): `/rfds/updates` and the RFD pages |
| The spec defines no timeout for `session/request_permission`; an unanswered request blocks the turn. | V (primary): `/protocol/v1/prompt-turn`; consequence I |
| Usage is reported per turn by some agents and cumulatively by others. | S: agent-client-protocol issue 1860 |
| Governance: jointly by Zed and JetBrains, "working toward" a foundation. About 130 listed clients. | V (primary): `/community/governance`, `/get-started/clients` |
| TypeScript SDK `@agentclientprotocol/sdk` 1.8.0 (2026-10-09), Apache-2.0, both client and agent sides, about 7.3 million weekly downloads. Rust crate 3.3.0. | V (primary): npm and crates.io registries |
| The registry lists 42 agents. Claude (`claude-acp` 0.91.0) and Codex (`codex-acp` 2.2.2) are **adapters** in the `agentclientprotocol` organisation, crediting the vendor, Zed and JetBrains. Grok, Cursor, OpenCode and Kimi ship ACP natively. Antigravity is a separate Google binary (`antigravity-acp` 1.4.0). | V (primary): `cdn.agentclientprotocol.com/registry/v1/latest/registry.json` |
| The old `@zed-industries/*` adapter packages are deprecated in favour of `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`. | V (probe): `npm view` deprecation messages |

**Reading (I).** ACP is healthy and moving fast: the adapters ship releases weekly and the SDK is stable. The fast
pace is a risk for a controller that pins and audits versions (ADR-0009). v2 will need a second code path.

## 5. Per-provider comparison

Columns: what each surface gives Switchboard. "Profile flags" means the native sandbox and permission controls the
trust-profile compilers emit today (FR-POL-02).

### 5.1 Claude Code

| Need | Headless `claude -p` | ACP (`@agentclientprotocol/claude-agent-acp`) |
| --- | --- | --- |
| Structured output | `stream-json` (V primary: code.claude.com/docs/en/headless) | `session/update` |
| Profile flags | Full argv: `--permission-mode`, `--tools`, `--disallowedTools`, `--setting-sources`, `--strict-mcp-config`, `--safe-mode` (V probe: `claude --help`, 2.1.300) | Only through the non-standard `_meta.claudeCode.options` passthrough; default `settingSources` is user, project and local (V probe: `dist/acp-agent.js`) |
| Per-run MCP | `--mcp-config` plus `--strict-mcp-config`, already used (ADR-0029) | `mcpServers`; advertises http and sse (V probe) |
| Resume | `--resume`, `--session-id` | `loadSession`, `resume`, `fork`, `list` (V probe) |
| Steering | `--input-format stream-json`: user messages with `priority` `next` (same turn, after running tools), `later` (new turn) or `now` (interrupts) (V primary: agent-sdk docs) | `_session/steering` extension, advertised in `_meta.steering.supported` (V probe) |
| Cancel | `interrupt` control request with a receipt; SIGINT ends the turn first (V primary) | `session/cancel` (maps to the SDK's `interrupt()`) |
| Permission callback | `--permission-prompt-tool <mcp tool>` or `--permission-prompts host` or `none` (V probe: help text) | `session/request_permission` via the SDK's `canUseTool` |
| Auth | Native login | `authMethods: []`; uses the CLI's login (V probe) |

**Recommendation: keep headless; do not use the ACP adapter.** The adapter wraps the Agent SDK, which spawns the same
CLI, so it adds a third-party layer and a weekly-changing dependency while hiding the argv the profiles are audited on
(ADR-0035, ADR-0037). In the probe, with an empty `HOME` and a stripped environment, the adapter still listed skills
that were not in that `HOME` (V probe; the source was not traced, presumably machine-wide settings in this container).
Everything M14 needs is in Claude's own documented stream-json control surface.

### 5.2 Codex

| Need | `codex exec --json` | `codex app-server` | ACP (`@agentclientprotocol/codex-acp`) |
| --- | --- | --- | --- |
| Status | Documented for automation (V primary: developers.openai.com/codex/noninteractive) | "Experimental", "not supported for production workloads" (V primary: /codex/app-server; V probe: help text) | Adapter that starts the app-server (V primary: README; V probe: bundle calls `turn/steer`, `turn/interrupt`, `thread/resume`) |
| Profile flags | `--sandbox`, `--ignore-user-config`, `--ignore-rules` (V probe: 0.160.1 help) | `approvalPolicy` and `sandbox` on `thread/start` and `turn/start` | Approval and sandbox modes as config options (V primary: README) |
| Per-run MCP | Only via `-c mcp_servers.*` (I) | Config layers; inline per thread not confirmed | `mcpServers`, stdio and http (V primary: README; V probe: `mcpCapabilities.http`) |
| Resume | `codex exec resume` | `thread/resume`, `thread/fork` | `loadSession`, `resume`, `fork`, `list` (V probe) |
| Steering | None | `turn/steer` (needs `expectedTurnId`) | `_session/steering` advertised (V probe) |
| Permission callback | None | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | `session/request_permission` |
| Auth | Native login | Native login | Without a login, `session/new` returns `-32000 Authentication required` (V probe), which ADR-0036 item 6 already maps to `AUTH_REQUIRED` |

**Recommendation: keep `codex exec` as the default.** For M14 live steering, spike `codex-acp` (S2) because it reuses
Switchboard's existing ACP client and fails closed on auth. `codex app-server` direct is the fallback if the adapter's
extra layer causes problems, but it is a second bespoke protocol marked experimental. `codex mcp-server` is removed
(V primary: CLI reference).

### 5.3 Grok Build

- Headless `grok -p` with `streaming-json` is built and live-checked (V repo: `live-checks-2026-10-14-grok.md`,
  T4.23).
- `grok agent stdio` is documented as the ACP entry point (V primary: docs.x.ai/build/cli/headless-scripting). Its
  `--help` lists only `--debug`, `--debug-file` and `--leader-socket`: no `--sandbox`, `--permission-mode`, `--allow`
  or `--deny` (V repo). The sandbox might apply through `GROK_SANDBOX` or config (V primary: /build/features/sandbox),
  untested for ACP.
- Per-session `mcpServers`: [HL] says `session/new` takes them (TDD §4.3), but the MCP pages do not cover ACP; not
  tested. Permission requests over ACP: not documented, not tested.
- Auth: `authenticate` with `cached_token` is documented, which Switchboard would not call (ADR-0036 item 6). Whether
  `session/new` works without it: unknown.

**Recommendation: keep headless.** ACP stays the fallback (TDD §4.3) and becomes the route to an injected tool channel
only if spike S4 shows the sandbox applies and `mcpServers` over stdio works.

### 5.4 Cursor

- Headless print mode is built and live-checked (V repo: `live-checks-2026-10-14-cursor.md`).
- `agent acp` exists (hidden in `--help`); `initialize` advertises `loadSession`, `sessionCapabilities.list` and MCP
  http and sse (V repo). ACP mode documents no `--sandbox`, `--force` or `--mode` (V primary: cursor.com/docs/cli/acp).
- `session/load` was reported broken with no fix announced (S: Cursor forum, April 2026). `mcpServers` on `session/new`
  were reported ignored, then said by staff to be unblocked on 2026-10-04, unconfirmed (S: Cursor forum).
- Extension methods `cursor/ask_question` and `cursor/create_plan` block until answered (V primary).

**Recommendation: keep headless.** Revisit only if Cursor's ACP gains sandbox controls and the resume bug is closed.

### 5.5 OpenCode

- `opencode run --format json` is built and live-checked; `run` talks to a background `opencode serve` (V repo:
  `live-checks-2026-10-14-opencode.md`).
- `opencode acp` 1.19.0: `initialize` advertises `loadSession`, `resume`, `fork`, `list`, `close` and MCP http and
  sse; `authMethods` names a terminal login; `session/new` works without a login and offers modes `build` and `plan` as
  config options; no steering extension (V probe).
- The serve HTTP API has a permission reply endpoint, abort and `prompt_async` (V primary: opencode.ai/docs/server).
  That is a persistent local service, deferred by FR-EXE-04.
- Config deny rules failed to deny in the live check (V repo). That weakens every surface, not only ACP.

**Recommendation: keep `opencode run`.** Spike S5 checks whether `opencode acp` sends `session/request_permission` for
`ask` rules and honours stdio `mcpServers`; if both hold, ACP becomes the better OpenCode transport because the
controller could then deny what the provider's own rules fail to deny.

### 5.6 Kimi Code

- Headless: "In `-p` mode, no human approval is requested"; tool calls follow the `auto` policy and only static deny
  rules apply (V primary: kimi.com/code/docs, `kimi-command`).
- `kimi acp`: `session/new` forwards `mcpServers` over stdio, http and sse; `session/load`, `session/resume`,
  `session/list`, `session/fork`; `session/request_permission` for approvals and questions; `session/set_mode`;
  `session/cancel`; `authenticate` returns `-32000` with no token (V primary: `kimi-acp`).

**Recommendation: ACP as Kimi's default transport** once B-1 clears (T4.61 to T4.63). It is the only Kimi surface with
a per-run MCP channel and a controller-side permission answer.

### 5.7 Antigravity

- Headless `agy -p` with `stream-json` is built (V repo: T4.33). `agy acp` is not a subcommand (V repo).
- The ACP server is a separate Google binary. It does not reuse the `agy` login: `session/new` returned
  `-32000 Authentication required` with the real `HOME` (V repo: `live-checks-2026-10-14-antigravity.md` C16). Logging
  it in needs `authenticate`, which Switchboard never calls.
- It advertises MCP http and sse but not stdio, so the stdio tool shim (ADR-0026) does not fit, and it takes none of
  `agy`'s sandbox or mode flags (V repo, C15).

**Recommendation: keep headless.** Not worth a spike now.

## 6. Probe results (this session)

Run in the cloud container on 2026-10-15 with a minimal JSON-RPC client: `initialize` (protocol 1, `fs` and
`terminal` false), then `session/new` with an empty `mcpServers`. Each agent ran with an empty temporary `HOME` and only
`PATH` in its environment. No prompt, no `authenticate`.

| Agent | `initialize` | `session/new` |
| --- | --- | --- |
| `@agentclientprotocol/claude-agent-acp` 0.91.0 (Claude Code CLI 2.1.300 on the host) | Protocol 1; `loadSession`; sessions `list`, `resume`, `fork`, `close`, `delete`, `additionalDirectories`; MCP http and sse; `authMethods: []`; `_meta.steering.supported: true`; `_meta.claudeCode.promptQueueing: true` | Returned a session with modes `default`, `acceptEdits`, `plan`, `auto` and model and effort config options; then listed host skills not present in the temporary `HOME` |
| `@agentclientprotocol/codex-acp` 2.2.2 (bundles `@openai/codex` 0.160.1) | Protocol 1; `loadSession`; sessions `resume`, `list`, `close`, `delete`, `fork`, `additionalDirectories`, `subagents`; MCP `http: true`, `sse: false`, `acp: false`; auth methods `api-key`, `chat-gpt`; `_meta.steering.supported: true` | `-32000 Authentication required` (fails closed). It needs `CODEX_HOME` to exist, otherwise the app-server exits 1 |
| `opencode acp` 1.19.0 | Protocol 1; `loadSession`; sessions `close`, `fork`, `list`, `resume`; MCP http and sse; one terminal-style auth method | Returned a session; `session/list` worked |

Limits: one container, Linux x64, no logged-in provider, so nothing about tool calls, permission requests, sandboxing or
MCP injection was observed.

## 7. What the control plane needs, by transport

| M14 need | Headless | ACP |
| --- | --- | --- |
| Steer a running run | Claude: native stream-json queueing. Others: stop at a boundary, resume natively with the note | Only through the non-standard `_session/steering` (Claude and Codex adapters); otherwise cancel and re-prompt in the same session |
| Pause | Cancel at a boundary, park, resume later (all adapters resume) | Same; no pause in the protocol |
| Approvals via the chat bot | Run-level approvals are Switchboard's own (decision 50) and need no provider protocol | Same. Per-tool approval is possible only over ACP, Claude's permission-prompt tool or `codex app-server` |
| Bypass runs (decision 24) | No prompts by construction | Every request auto-allowed once (decision 48) |
| "Needs you" status | Derived from events and exit | Plus `requires_action` in v2 |

**Design rule (Proposed).** Define `steer_run` and pause as transport-neutral adapter capabilities: `steering: live`
where the adapter has a documented in-turn channel, otherwise `steering: boundary-resume`. Every adapter supports the
second today, so M14 does not wait for any transport change.

**Per-tool approval from a person (Proposed, needs an ADR).** Holding a live agent process for hours while the owner
decides is fragile (no timeout in the spec, process lifetime, idle timers). The safer default is deny, park the run as
needing attention, and resume with the decision applied. Live holding, if wanted, should be bounded by a short timeout.

## 8. Proposed document changes (not made here)

1. **ADR-0002**: no change. Item 3 already allows ACP downstream alongside JSONL.
2. **ADR-0036** (Proposed): leave the per-run design. A follow-up ADR would: allow the client to *send* an
   adapter-declared steering extension (`_session/steering`) when the agent advertises it (item 11 only covers requests
   from the agent); and, if the owner wants live per-tool approval, carve an exception to item 9.1 for a request routed
   to a person under M14, with a timeout and deny on expiry.
3. **New ADR**: the per-provider transport table of section 2, superseding the transport sentences in TDD §4.3, §4.5.2,
   §4.6 and §4.7 only where they change (Kimi becomes ACP-first).
4. **New ADR or TDD row**: Claude Code long-lived stream-json mode for M14 (one process per run is kept; the run stays
   open for steering), including which control requests Switchboard sends.
5. **TDD technology table**: note that `@agentclientprotocol/sdk` reached 1.x; keep the own client (it is built and
   enforces ADR-0036's limits) and reconsider when v2 support is needed.
6. **ROADMAP §7**: add the spikes below as tasks and the open questions as Q entries.

## 9. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| ACP v2 lands and adapters drop v1 | The client breaks for ACP providers | Version gate (ADR-0009); keep headless as the fallback for every provider except Kimi |
| Adapter churn (weekly releases) for Claude and Codex | Unaudited behaviour changes | Pin exact versions; do not adopt the Claude adapter; spike Codex before adopting |
| Provider controls missing in ACP mode (Grok, Cursor, Antigravity) | A profile compiles weaker than on headless | ADR-0036 item 9.5 already makes such profiles ineligible |
| Unanswered permission request blocks a turn | Run hangs until the idle timer | The client answers at once (ADR-0036 item 9.1); a person-routed answer needs a timeout |
| Claude stream-json raw control messages are documented only through the SDK | Wire changes break steering | Spike S1; gate on the CLI's advertised `capabilities` in `system/init` |
| Provider terms on wrapping (Antigravity FAQ; Anthropic's Agent SDK policy on subscription logins) | Account risk | Unchanged by this memo: Switchboard drives the operator's own unmodified CLI under their own login; owner decision 47 covers Antigravity |

## 10. Spike plan for what is unverified

Small, ordered by value to M14. Live steps go through the operator's budgeted channel only (AGENTS.md), one scoped
question each.

| Spike | Question | How | Live? |
| --- | --- | --- | --- |
| S0 | Can M14 steering be designed without any provider? | Add `steering` capability declarations; make the fake CLI and fake ACP agent support boundary-resume and `_session/steering`; tests only | No |
| S1 | Claude stream-json: does a `priority: next` user message land in the running turn, and does `interrupt` return a receipt? | One cheap read-only `claude -p --input-format stream-json --output-format stream-json` run; record the event sequence | Yes, one run |
| S2 | `codex-acp`: does it reuse the native login, honour the sandbox mode, pass the environment to stdio `mcpServers`, send `request_permission`, and accept `_session/steering`? | One read-only session on the operator host | Yes, one run |
| S3 | Kimi ACP | Already T4.61; add `mcpServers` stdio and environment inheritance to its checklist | Yes (T4.61) |
| S4 | Grok `agent stdio`: does `session/new` work without `authenticate`, does `GROK_SANDBOX` apply, does it send `request_permission`, does stdio `mcpServers` work? | One read-only session | Yes, one run |
| S5 | `opencode acp`: `request_permission` for `ask` rules; stdio `mcpServers` | One session with a free model and a scratch config | Yes, one run (no paid model) |

Cursor and Antigravity: no spike until the reported bugs or the auth gap close.

## 11. Sources

Repository: [ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md),
[ADR-0036](../adr/0036-per-run-acp-stdio-client.md), [TDD §4](../design/TDD.md#4-provider-adapter-strategy),
[control-plane discovery](orchestration-layer-discovery-2026-10-15.md), the live-check notes in this folder, and
`src/exec/acp/`.

Primary, retrieved 2026-10-15:

- ACP: <https://agentclientprotocol.com/protocol/v1/prompt-turn>, <https://agentclientprotocol.com/protocol/v2/migration>,
  <https://agentclientprotocol.com/rfds/v2/prompt>, <https://agentclientprotocol.com/rfds/v2/overview>,
  <https://agentclientprotocol.com/rfds/updates>, <https://agentclientprotocol.com/announcements/acp-v2-draft>,
  <https://agentclientprotocol.com/community/governance>, <https://agentclientprotocol.com/get-started/registry>,
  <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>,
  <https://registry.npmjs.org/@agentclientprotocol/sdk>
- Claude Code: <https://code.claude.com/docs/en/headless>, <https://code.claude.com/docs/en/cli-reference>,
  <https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode>,
  <https://code.claude.com/docs/en/agent-sdk/user-input>, <https://code.claude.com/docs/en/agent-sdk/overview>,
  <https://github.com/agentclientprotocol/claude-agent-acp>
- Codex: <https://developers.openai.com/codex/noninteractive>, <https://developers.openai.com/codex/cli/reference>,
  <https://developers.openai.com/codex/app-server>, <https://github.com/agentclientprotocol/codex-acp>
- Grok Build: <https://docs.x.ai/build/cli/headless-scripting>, <https://docs.x.ai/build/features/sandbox>,
  <https://docs.x.ai/build/features/mcp-servers>
- Cursor: <https://cursor.com/docs/cli/acp>, <https://cursor.com/docs/cli/headless>
- OpenCode: <https://opencode.ai/docs/acp/>, <https://opencode.ai/docs/server/>, <https://opencode.ai/docs/cli/>
- Kimi Code: <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html>,
  <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html>

Secondary: agent-client-protocol issues 1860 and 1979; claude-agent-acp issues 825 and 976; Cursor forum threads
153823 and 155516 on ACP `mcpServers` and `session/load`.
