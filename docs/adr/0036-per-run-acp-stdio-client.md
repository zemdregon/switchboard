# ADR-0036: Per-run ACP stdio client with no client capabilities and profile-derived permission answers

- Status: Proposed
- Date: 2026-10-13
- Decided by: Delegated (agent, 2026-10-13, ROADMAP T4.7), under [owner decision 25](../ROADMAP.md#42-owner-decisions)
  for everything outside bypass mode. Not a zemdregon quote and not owner-approved. Item 9.4 (what the client answers in
  an approved bypass run) touches bypass runs and the Git-write denial they keep, so it is **open for zemdregon**
  (open item 1 below); the rest does not change what a bypass run may do.
- Related: FR-EXE-03, FR-EXE-01, FR-EXE-02, FR-EXE-04, FR-EXE-05, FR-EXE-06, FR-EXE-07, FR-POL-02, FR-POL-03,
  FR-POL-08, FR-AUTH-01, FR-AUTH-02, FR-ADP-04, FR-GIT-01, FR-GIT-02, NFR-SEC-06, NFR-PRIV-02,
  [ADR-0002](0002-mcp-upstream-acp-downstream.md) (item 3), [ADR-0003](0003-no-credential-handling.md),
  [ADR-0017](0017-approved-privileged-scope-bypass.md), [ADR-0026](0026-per-run-tool-channel-socket-and-token.md),
  [ADR-0029](0029-claude-code-receives-tool-shim-via-mcp-config.md),
  [ADR-0033](0033-claude-channel-bypass-only-without-safe-mode.md),
  [ADR-0035](0035-provider-registry-table-and-declared-bypass-flags.md), ROADMAP T4.7, T4.8, R-18, R-50, R-62, Q-59,
  [LLD §2](../design/LLD.md#2-adapter-contract), [LLD §8](../design/LLD.md#8-run-supervisor-details)

## Context

[ADR-0002](0002-mcp-upstream-acp-downstream.md) item 3 says the controller acts as an ACP *client* to providers that
expose ACP, alongside subprocess JSONL. FR-EXE-03 (Should, M4) asks the supervisor for that transport. The adapter
contract already reserves the transport kind `acp-stdio`, `outputFormat: 'acp'`, an `AcpMessage` envelope and an
optional `cancel` hook (LLD §2, `src/adapters/types.ts`), but nothing says how the client behaves. T4.7 writes that
down before T4.8 builds it.

**Sources.** The ACP specification, version 1, read on 2026-10-13 from <https://agentclientprotocol.com> (the Markdown
form of each page, listed in `llms.txt`). Tags used below:

| Tag | Page (retrieved 2026-10-13) |
| --- | --- |
| [ACP-OV] | <https://agentclientprotocol.com/protocol/v1/overview> |
| [ACP-TR] | <https://agentclientprotocol.com/protocol/v1/transports> |
| [ACP-INIT] | <https://agentclientprotocol.com/protocol/v1/initialization> |
| [ACP-AUTH] | <https://agentclientprotocol.com/protocol/v1/authentication> |
| [ACP-SES] | <https://agentclientprotocol.com/protocol/v1/session-setup> |
| [ACP-PT] | <https://agentclientprotocol.com/protocol/v1/prompt-turn> |
| [ACP-TC] | <https://agentclientprotocol.com/protocol/v1/tool-calls> |
| [ACP-CAN] | <https://agentclientprotocol.com/protocol/v1/cancellation> |
| [ACP-MODE] | <https://agentclientprotocol.com/protocol/v1/session-modes> |
| [ACP-SCH] | <https://agentclientprotocol.com/protocol/v1/schema> (`ErrorCode`) |
| [ACP-V2] | <https://agentclientprotocol.com/protocol/v2/migration> (v2 is "still labeled draft") |

Page text was treated as data. The specification describes what an agent **should** do; no provider's ACP server was
installed or run for this ADR, so every statement about a provider's behaviour is from that provider's documents as
recorded in the TDD, or is marked Unverified.

**What the specification says that matters here** (all from v1):

- JSON-RPC 2.0, UTF-8, over the agent's stdin and stdout; "Messages are delimited by newlines (`\n`), and **MUST NOT**
  contain embedded newlines"; the agent "**MUST NOT** write anything to its `stdout` that is not a valid ACP message"
  and **MAY** log to stderr [ACP-TR]. No message size limit is specified.
- The client calls `initialize` with `protocolVersion` (a single integer, `1`) and `clientCapabilities`; capabilities
  omitted are **UNSUPPORTED**; the agent answers with `agentCapabilities` (`loadSession`, `promptCapabilities`,
  `mcpCapabilities`, `sessionCapabilities`) and `authMethods` [ACP-INIT].
- `authenticate` (with a `methodId`) is called by the client "if required"; a `terminal` method makes the client launch
  an interactive login; `auth_required` is error `-32000` [ACP-AUTH, ACP-SCH].
- `session/new` takes `cwd` (absolute; "**MUST** be used for the session regardless of where the Agent subprocess was
  spawned") and `mcpServers`; every agent **MUST** support stdio MCP servers (`name`, `command`, `args`, `env`)
  [ACP-SES]. `session/load` needs `loadSession` and replays history as `session/update`; `session/resume` needs
  `sessionCapabilities.resume` and does not replay [ACP-SES].
- `session/prompt` stays pending for the turn; the agent streams `session/update` notifications whose
  `sessionUpdate` variants include `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
  `plan`, `current_mode_update` and `usage_update`, and ends with a `stopReason` (`end_turn`, `max_tokens`,
  `max_turn_requests`, `refusal`, `cancelled`) [ACP-PT].
- `session/cancel` is a notification; on cancel the client "**MUST** respond to all pending
  `session/request_permission` requests with the `cancelled` outcome" and the agent answers the prompt with
  `cancelled` [ACP-PT]. `$/cancel_request` cancels a single request; `-32800` is "Request cancelled" [ACP-CAN].
- The agent **MAY** call `session/request_permission` (a client baseline method) with a `toolCall` and `options`, each
  with an `optionId` and a `kind` (`allow_once`, `allow_always`, `reject_once`, `reject_always`); the client answers
  `{"outcome":"selected","optionId":...}` or `{"outcome":"cancelled"}` and "**MAY** automatically allow or reject
  permission requests according to the user settings". The option `kind` is "a hint". A tool call's `name` is "opaque,
  informational metadata: [names] do not advertise a capability or grant authorization" [ACP-TC].
- `fs/*` and `terminal/*` are optional client methods, available only if the client advertises them [ACP-OV,
  ACP-INIT]. Session modes (`session/set_mode`, `current_mode_update`) "often affect ... whether they request
  permission before running" [ACP-MODE].
- v2 changes the prompt lifecycle, removes `fs/*`, `terminal/*`, `session/load` and `session/set_mode`, and renames
  `authenticate` to `auth/login`; it is "still labeled draft" [ACP-V2].

**Providers whose documents name ACP** (from the M4 spikes, all documentation only, retrieved 2026-10-13):

| Provider | Entry point | Source | Chosen M4 transport |
| --- | --- | --- | --- |
| Grok Build | `grok agent stdio` | [TDD §4.3.1](../design/TDD.md#431-grok-build-native-controls-per-profile-and-platform-t420) ([HL]: `initialize` returns `authMethods`; `session/new` takes `mcpServers`) | JSONL; ACP is the fallback |
| Cursor | `agent acp` (hidden command) | [TDD §4.5.2](../design/TDD.md#452-transport-decision) ([C4]: a permission request the client must answer or "tool execution can block"; extension methods `cursor/ask_question`, `cursor/create_plan` that block on a reply) | JSONL; ACP deferred |
| OpenCode | `opencode acp` | [TDD §4.6](../design/TDD.md#46-opencode-m4) ([D-cli], [D-acp]) | JSONL (`opencode run`); ACP is the fallback |
| Kimi Code (2.x) | `kimi acp` | [TDD §4.7](../design/TDD.md#47-kimi-code-m4-blocked-by-b-1) (K6: `session/new` with `mcpServers`, `session/resume`, `session/load`, `session/request_permission`, `session/set_mode`; `authenticate` returns `-32000` with no token) | Unverified: T4.61; blocked by B-1 |

Kimi's archived legacy CLI also had ACP ([R2] L60, L148), but it is not evidence for the current CLI (B-1, TDD §4.7).
**Antigravity:** Google's documentation of the native `agy` CLI read on 2026-10-13 does not document ACP
([TDD §4.4](../design/TDD.md#44-antigravity-agy-m4)). A **separate** official Google ACP server exists: the ACP
registry lists `antigravity-acp` ("Google Antigravity", 1.3.0, author Google LLC), linked from Google's Zed guide
([TDD §4.4.4](../design/TDD.md#444-separate-acp-adapter-owner-lead-2026-10-13)). Its behaviour (what it wraps, login,
permission requests, per-session `mcpServers`) is Unverified until T4.31 (C14 to C17), and Google's FAQ wording on
wrapping is an open compliance question (Q-59). Claude Code and Codex have no ACP entry point in the sources read.

## Decision

1. **Where it lives.** A provider-neutral ACP client in `src/exec/acp/` (Proposed layout: `framing.ts` for the
   newline-delimited JSON-RPC reader and writer, `client.ts` for the session state machine). It uses the supervisor's
   existing spawn, process-group, environment and timer code (`src/exec/supervisor.ts`); it is not a second
   supervisor. The permission decision is a pure function in `src/policy/acp-permission.ts` that reads only the frozen
   policy snapshot and the request (item 9). Adapters supply provider facts through data on their `Invocation` (LLD §2,
   `acp` plan) and through declarations; no adapter talks JSON-RPC itself, and adapter `parseEvent` sees only
   `session/update` notifications and the final `session/prompt` response.
2. **One agent process per run.** The supervisor spawns the adapter's argv (for example `grok agent stdio`) once per
   run, in its own process group, with the allowlisted environment (FR-EXE-07), `cwd` = the run worktree, and kills
   the group when the run ends. The client sends one `initialize`, at most one session setup call and exactly one
   `session/prompt`; a continuation is a new run that resumes (item 7). No agent process outlives its run and none is
   shared between runs, so this is not the persistent local-service transport that FR-EXE-04 defers. (TDD §4.5.2 says
   Cursor's ACP "needs ... a persistent process, which FR-EXE-04 defers"; under this item that is not so. Open item
   for the orchestrator: reconcile that sentence.)
3. **Framing and limits** (same targets as JSONL, LLD §8). Stdout is split on `\n` (a trailing `\r` tolerated); each
   line must be one UTF-8 JSON object with `"jsonrpc": "2.0"`. Maximum message size 1 MiB (Proposed target, the JSONL
   `maxLineBytes`); an oversize line, invalid UTF-8 or JSON, a JSON array (batch; v1 does not define one), a non-2.0
   envelope, a response whose `id` the client never sent, a notification or request for another `sessionId`, or more
   than 8 unanswered agent-to-client requests (Proposed) ends the run `OUTPUT_PROTOCOL_ERROR` (kill the group, keep
   the captured data), never silently truncated (NFR-SEC-06). The client writes only messages it built itself, one
   per line, with no embedded newline; a failed write to stdin is treated as the process ending. Stderr is captured
   as an artifact and never parsed as protocol (FR-EXE-05, [ACP-TR]). Every received line is in the raw stdout
   artifact; messages the client sends are recorded in a `provider_stdin` artifact after the redactor (ADR-0026
   item 3) has run.
4. **Timeouts.** The run's wall-clock and idle timeouts and `killGraceMs` apply unchanged (FR-EXE-01). Added bounds,
   Proposed targets: `initialize` answered within 30 s (the preflight probe target), session setup (`session/new`,
   `session/resume` or `session/load`, which may start MCP servers) within 60 s; missing either ends the run
   `PROCESS_TIMEOUT`. Idle time counts stdout bytes as for JSONL.
5. **`initialize` and version.** The client sends `protocolVersion: 1`, `clientInfo` (`switchboard` and its version)
   and `clientCapabilities` with `fs.readTextFile: false`, `fs.writeTextFile: false`, `terminal: false` and nothing
   else (no `auth.terminal`, no `elicitation`, no `session.*` extensions). An answer with any other
   `protocolVersion` ends the run `OUTPUT_PROTOCOL_ERROR` (v2 is draft [ACP-V2]; supporting it is a later change). The
   agent's capabilities and the ids and types of its `authMethods` (never any other auth data) are recorded in an
   `acp_initialized` run event. The probe (FR-ADP-02) may run `initialize` alone as its `command` step, if an adapter
   task shows it makes no model call (Unverified per provider).
6. **Authentication: never by the controller.** The client never calls `authenticate` (or v2 `auth/login`) or
   `logout`, and never launches a `terminal` auth method, whatever `authMethods` lists (FR-AUTH-01, ADR-0003): each
   would start or change a provider login. A `-32000` error on any request, or an `auth_required` error object, ends
   the run `AUTH_REQUIRED` naming the provider's native login command (FR-AUTH-02; for example `grok login`,
   `kimi login`). The operator logs in natively, outside Switchboard. Whether a provider's ACP server reuses the native
   CLI's login is Unverified per provider (secondhand reports say Google's separate server does not, TDD §4.4.4).
   `authPreflight` stays the provider's status command or a harmless headless call (LLD §2).
7. **Session start and resume.**
   1. A new run sends `session/new` with `cwd` = the canonical worktree path and `mcpServers: []`. The returned
      `sessionId` becomes the `session_bound` event (FR-ADP-04: structured output only).
   2. A resumed run (FR-SES-03) uses `session/resume` when the agent advertised `sessionCapabilities.resume`,
      otherwise `session/load` when it advertised `loadSession: true`, with the run's own worktree as `cwd`. Updates
      replayed by `session/load` before its response are counted and kept in the raw artifact but are not turned into
      this run's events. If neither capability is advertised the run fails before any prompt with `TOOL_FAILURE`
      (detail `acp_resume_unsupported`). Whether a provider accepts a different `cwd` on resume: Unverified per
      provider.
   3. `mcpServers` carries the controller's tool shim (ADR-0026) only when all hold: the adapter's `gitCapabilities`
      offers the channel for this run (`offersChannel`, ADR-0033 item 1 pattern); a per-provider ADR has accepted that
      provider's ACP channel (ADR-0035, Consequences: a new provider's injected channel needs its own ADR); and the run
      is an approved bypass run (`privileged`, scope sets `bypass`, `bypassApproved`), as for Claude Code under
      ADR-0029 and ADR-0033, until that per-provider ADR shows the shim's tools can be approved by item 9's
      profile-derived answers. The entry is a stdio server: `command` the daemon's Node executable, `args` the rest of
      `ShimSpec.command`, `env: []`. The token stays only in the agent's process environment (ADR-0026 item 3); if the
      provider does not pass its environment to stdio MCP servers (Unverified per provider) the shim has no token and
      every call is refused, so the adapter stays `finalize-only`. Operator, repository or user MCP definitions are
      never forwarded. Passing the token value in `env` over the stdin pipe would change ADR-0026's token path and is
      not decided here (open item).
8. **Prompt, updates, cancel.**
   1. `session/prompt` carries one `text` content block (the compiled task text). No other content block type is sent.
   2. `session/update` mapping to `NormalizedEvent` (LLD §2): `agent_message_chunk` text joined per `messageId` into a
      bounded `message`; `agent_thought_chunk` dropped (NFR-PRIV-02); `user_message_chunk` ignored; `tool_call` and
      `tool_call_update` to `tool_call` (`kind` `read` and `search` to `read`; `edit`, `delete`, `move` to `edit`;
      `execute` to `shell`; everything else to `other`; `name`, else `title`, bounded), with `denied: true` for a call
      the client rejected; `usage_update` to `usage` (`used`, `size`, `cost` as reported, `provider_reported`);
      `current_mode_update` checked under item 10; `plan`, `available_commands_update`, `config_option_update`,
      `session_info_update` recorded as `unknown` with their type; any other variant `unknown` (never trusted).
   3. The `session/prompt` result ends the turn: `end_turn` gives `result` with `ok: true` (subject to the
      permission-denied rule below); `max_tokens`, `max_turn_requests` and `refusal` give `result` with `ok: false`
      and are classified `TOOL_FAILURE` unless the adapter maps them otherwise (Proposed); `cancelled` gives
      `CANCELLED` when the controller cancelled, otherwise `TOOL_FAILURE`. An error response gives `provider_error`
      with the JSON-RPC code as category, classified by the adapter (`-32000` is `AUTH_REQUIRED`, item 6). A denied
      permission emits `permission_denied`, so the run ends `PERMISSION_BLOCKED` as on the JSONL adapters (FR-POL-05).
   4. After the result, the client closes the agent's stdin, waits up to `killGraceMs` for exit, then sends the
      SIGTERM-then-SIGKILL sequence to the group. The exit status after a result is recorded but does not decide the
      outcome; an exit before a result is `PROCESS_CRASH`.
   5. Cancel (operator, caller, or the wall-clock or idle timer): the client answers every pending permission request
      `{"outcome":"cancelled"}` (as [ACP-PT] requires), sends `session/cancel`, waits up to `killGraceMs` for the
      `cancelled` result, then kills the group as for JSONL. The adapter's optional `cancel` hook is this sequence; the
      supervisor's group kill never depends on the agent's cooperation.
9. **Permission requests: answered from the compiled profile only, deny by default.**
   1. Every `session/request_permission` is answered by the client, at once, from `decidePermission(request,
      snapshot)`: a pure function of the frozen policy snapshot (profile, worktree, read-only contexts, `bypassApproved`
      and the approved scope) and the request. Nothing from the orchestrator, the repository, the agent's text or an
      earlier answer is an input. If the function throws or has not returned within 1 s (Proposed bound), the answer
      is a rejection. An unanswered request is never left pending: Cursor documents that tool execution blocks until it
      is answered (TDD §4.5.2).
   2. **Allow** selects the first option whose `kind` is `allow_once`, and only when all of these hold: `kind` of the
      tool call is present and in the set the profile allows (`read` and `search` for any profile; `edit`, `delete`,
      `move` only with `fileAccess` `worktree` or `scoped` on a writable workspace; `execute` only with `shell: broad`,
      or with `shell: allowlist` when an adapter-declared parser turns the request into an argv that equals an
      allowlist entry, otherwise not; `fetch` only with network not `off`, and for `allowlist` only when an
      adapter-declared parser yields a host on the list); every reported location is an absolute path that, after
      lexical normalisation and resolution of its longest existing prefix, lies inside the worktree (or, for `read` and
      `search`, a declared read-only context); and a request of a kind that names files (`read`, `edit`, `delete`,
      `move`) reports at least one location. `think`, `switch_mode`, `other`, a missing or unknown kind, and any request
      without a `toolCall` are rejected.
   3. **Reject** selects the first option whose `kind` is `reject_once`. If the agent offered none, the client does not
      pick `reject_always` (it may persist a rule in the provider's own state, FR-POL-08) or an allow option; it answers
      `cancelled`, sends `session/cancel` and the run ends `PERMISSION_BLOCKED`. **`allow_always` is never selected**,
      in any profile, including an approved bypass run: a remembered grant would outlive the run and the snapshot.
   4. **Bypass-class answer.** A decision rule that selects allow for every request regardless of kind or location is
      bypass-class under FR-POL-03 (an equivalent of `--always-approve`). It is reachable only when the snapshot is an
      approved `privileged` scope that sets `bypass` with `bypassApproved` true (ADR-0017), and then still selects only
      `allow_once`. **Open for zemdregon (open item 1):** whether that rule is the bypass answer, and whether it should
      still reject requests whose structured subject is recognisably a Git write, as defence in depth beside the
      provider's own deny rules (owner decision 22 keeps Git-write denial in bypass runs; agent-reported kinds cannot
      make that complete). Until answered, no adapter may compile an approved bypass run on `acp-stdio`; that case is
      `Ineligible` with `PROFILE_UNSUPPORTED`.
   5. **The answer is never the only control.** The agent reports `kind`, `locations` and `rawInput` itself; the
      specification calls option kinds "a hint" and tool names non-authorising [ACP-TC]. So the answers only narrow:
      an adapter must still compile every profile into the provider's own native controls (FR-POL-02), and profile
      eligibility does not count the permission answers as a control unless a per-provider ADR shows the reported
      fields come from the agent runtime, not from the model.
   6. Each decision is an `acp_permission` run event with the tool kind, the decision, a reason code, the option kind
      selected and the location count; `rawInput` and titles stay only in the raw artifact. At most 256 such events per
      run; the rest are counted in the final one.
10. **Modes and configuration options.** The client never calls `session/set_mode` or `session/set_config_option`
    except with a value the adapter compiled into the `acp` plan for the profile. Adapters declare their provider's
    bypass-class mode ids and option values (for example an auto-approve mode) beside their bypass-class flags
    (ADR-0035 item 2, additive only); the pre-spawn audit refuses a plan that selects one outside the approved bypass
    case. If the agent reports a `current_mode_update` to a declared bypass-class mode in a run that is not an
    approved bypass run, the client cancels and the run ends `PERMISSION_BLOCKED` (detail `acp_bypass_mode`).
11. **No client capabilities.** Because item 5 advertises none, an `fs/*`, `terminal/*` or `elicitation/create`
    request, any `_`-prefixed extension method and any provider method (for example Cursor's `cursor/ask_question`,
    `cursor/create_plan`) is answered at once with JSON-RPC error `-32601` (method not found) and an
    `acp_request_refused` event; the agent uses its own tools under its own native controls. If a provider turns out
    to require a client capability, it is ineligible (`CAPABILITY_MISSING`) until a new ADR decides it: serving `fs` or
    `terminal` would make the controller read, write or execute for the agent, a new trust boundary. What Cursor does
    after `-32601` to its blocking extension methods is Unverified (T4.41).
12. **Reconciliation** (FR-EXE-06) is unchanged: `pid`, `pgid` and start ticks are persisted before any output is read,
    and an orphaned ACP agent is terminated like a JSONL one.

**Conformance plan for T4.8 (no code in this task).** A scripted fake ACP agent beside the M1 fake CLI
(`src/adapters/fake/`), driven by a fixture that lists what it sends and what it expects, run through the real
supervisor and client with the fake adapter's `acp-stdio` mode (a test-only registry entry, ADR-0035 item 4). Cases,
each with no provider installed:

| Case | Expected |
| --- | --- |
| Handshake | `initialize` has `protocolVersion: 1`, `fs` and `terminal` false, no `auth`; `session/new` has the worktree `cwd` and `mcpServers: []` |
| Version 2 answer; no answer to `initialize` | `OUTPUT_PROTOCOL_ERROR`; `PROCESS_TIMEOUT` |
| Streamed updates | `session_bound`, `message` (thought chunks dropped), `tool_call`, `usage`, `result` in order; unknown variant gives `unknown` |
| Stop reasons; error response; `-32000` | Mapping of item 8.3; `AUTH_REQUIRED`, and the fake records no `authenticate` or `logout` |
| Cancel | Pending permission answered `cancelled`, `session/cancel` sent, group empty after `killGraceMs` even if the fake ignores it |
| Permission outside the profile | `reject_once` selected; `tool_call` `denied`; run `PERMISSION_BLOCKED` |
| Permission inside the profile | `allow_once` selected; never `allow_always`, even when it is the only allow option |
| No reject option | `cancelled` answer, `session/cancel`, `PERMISSION_BLOCKED` |
| Location outside the worktree, via `..` or a symlink | Rejected |
| Allow-everything rule | Refused unless `bypassApproved` (and only after open item 1 is answered) |
| `fs/*`, `terminal/*`, `_x`, `cursor/ask_question` | `-32601` at once; run continues |
| Oversize line, invalid JSON, batch array, unknown response id, wrong `sessionId`, too many pending requests | `OUTPUT_PROTOCOL_ERROR`, group killed |
| Resume | `session/resume` preferred, `session/load` replay not re-emitted, neither advertised gives `acp_resume_unsupported` |
| `current_mode_update` to a declared bypass mode | `PERMISSION_BLOCKED` |
| Environment, stderr, exit before result | Only allowlisted names; stderr captured and not parsed; `PROCESS_CRASH` |

## Alternatives considered

- **A long-lived ACP agent shared by runs (one process, many sessions).** Rejected: FR-EXE-04 defers persistent
  transports, crash and orphan handling (FR-EXE-06) are per process, and one session's permission or MCP state could
  leak into another run.
- **Advertise `fs` and `terminal` and serve them from the controller.** Rejected: the controller would execute commands
  and write files on the agent's behalf, a new trust boundary that the profile compilers do not cover; v2 removes
  these methods anyway [ACP-V2].
- **Call `authenticate` with an `agent` method, or run a `terminal` method.** Rejected: it starts a provider login
  (FR-AUTH-01, ADR-0003).
- **Leave permission requests unanswered or answer them from the provider's own settings.** Rejected: an unanswered
  request blocks the agent (Cursor, TDD §4.5.2) until the idle timer, and provider settings are global configuration
  (FR-POL-08).
- **Choose `allow_always` to reduce repeated requests.** Rejected: it outlives the run and may persist in provider
  state.
- **Use an ACP library (for example the official TypeScript SDK).** Not chosen now: the client needs few methods and
  strict limits the library would have to be shown to enforce; a new dependency is a technology-stack change (ADR).
  T4.8 may revisit it with an ADR.
- **Negotiate v2.** Deferred: draft [ACP-V2]; one GitHub comment reports a Google build answering protocol 2
  (TDD §4.4.4, Unverified).

## Consequences

- LLD §2 gains the `acp` plan on `Invocation`, the `decidePermission` contract and the ACP event types; LLD §8 gains
  the `acp-stdio` supervisor details. No code changes with this ADR; T4.8 implements it.
- Under ACP the controller, not a flag, answers permission requests: R-62. Item 9.5 keeps native controls primary, so
  a profile that only ACP answers could satisfy stays ineligible.
- Grok Build, Cursor and OpenCode keep JSONL as their M4 transport; this ADR only makes the ACP fallback buildable.
- New run event types: `acp_initialized`, `acp_permission`, `acp_request_refused`.
- An ACP adapter that needs the bypass case waits for open item 1.

## Open items (for the orchestrator or zemdregon)

1. **For zemdregon:** the permission answer in an approved bypass run (item 9.4). The orchestrator should record it as
   a question in ROADMAP §7 (no number is assigned here, to avoid colliding with concurrent edits).
2. Reconcile TDD §4.5.2's "persistent process" sentence with item 2 (orchestrator).
3. The shim token path over ACP (item 7.3): environment inheritance per provider is Unverified; passing the value in
   `env` would amend ADR-0026 item 3 (orchestrator, per-provider channel ADR).
4. The separate Antigravity ACP server: any adapter for it needs T4.31 (C14 to C17) and an answer to Q-59 first.
5. All numeric bounds above are Proposed targets, not measured.

## Revisit when

A provider's live leg shows behaviour this ADR assumed from the specification (blocking on a refused extension method,
honouring `reject_once`, inheriting its environment into stdio MCP servers); ACP v2 leaves draft; a provider requires a
client capability; or open item 1 is answered.
