# Architectural Blueprint for a Unified, Headless AI Coding Controller

Research state: October 12, 2026

## Executive assessment

The central architectural idea is sound: a controller can preserve the proprietary agent harnesses of Claude Code, Grok
Build, Google Antigravity, Codex, Cursor, Kimi Code, and OpenCode by orchestrating their documented CLI or
protocol-native automation surfaces instead of replacing them with raw model API calls. Claude Code, Grok Build,
Antigravity, Codex, Cursor, and OpenCode all document non-interactive or programmatic operation, and several now expose
richer machine interfaces such as JSONL streams, resumable sessions, ACP, or persistent servers.

However, the supplied blueprint should **not be implemented literally**. A number of the concrete flags and assumptions
have changed by October 2026, several proposed permission settings would grant substantially more authority than
necessary, some usage-normalization assumptions cannot reliably infer subscription capacity, and extracting
provider-local transcripts as the canonical cross-provider state layer would create unnecessary brittleness. Kimi is an
especially strong example of version risk: Moonshot archived the legacy Python Kimi CLI on September 23, 2026 and
replaced it with the new Kimi Code CLI; the older documentation now explicitly directs users to migrate.

The most important corrections are these:

| Draft proposition | Research finding | Architectural consequence |
| --- | --- | --- |
| `claude --allowedTools "*"` provides broad unattended access | Current Claude Code explicitly warns that an unanchored allow glob such as `"*"` is skipped; `dontAsk` also **denies** operations that would otherwise prompt rather than granting them. | Build explicit capability rules; never synthesize wildcard permission escalation. |
| Claude `--bare` disables everything including arbitrary settings | `--bare` skips discovered hooks, skills, commands, subagents, plugins, MCP, auto-memory, and `CLAUDE.md`; the documentation does not describe it as a universal “ignore every settings file” switch. | Treat bare mode as an untrusted-repository baseline, not a complete configuration sandbox. |
| Grok uses an `acceptEdits`-style controller policy and `--tools`/`--disallowed-tools` | Current Grok Build documents Ask/Auto/Always-approve permission modes, `--always-approve`, and `--allow`/`--deny`; its sandbox is a separate control. | Separate authorization policy from OS/file sandboxing. |
| Antigravity must use `--dangerously-skip-permissions` for autonomous operation | Antigravity also exposes `toolPermission` modes including `proceed-in-sandbox`, `always-proceed`, and `strict`, plus terminal sandbox controls. | Dangerous skip should be an exceptional compatibility mode, not the normal automation path. |
| Codex is `codex -p`, wrapped into custom JSON, normally with `--yolo` | The documented automation interface is `codex exec`; `--json` natively emits JSONL, sessions resume through `codex exec resume`, and the current docs prefer explicit sandbox configuration over the deprecated `--full-auto` compatibility path. | Use native events and current sandbox flags; eliminate the JSON wrapper. |
| Cursor requires `--trust --approve-mcps --force` as a normal headless bundle | Cursor exposes each independently: `--trust`, `--approve-mcps`, `--force`/`--yolo`, and `--sandbox`; it also natively emits JSON/stream-JSON and supports sessions and ACP. | Trust, MCP approval, command approval, and sandboxing must be independent policy decisions. |
| Kimi Code can be hardcoded around the old Kimi command/model assumptions | The legacy CLI is now archived, and Moonshot's current product surface has moved to Kimi Code; its public Kimi product also now highlights K3. | The Kimi adapter should begin life as version-gated/provisional and derive current capabilities from the installed binary. |
| NCU can translate token/cost telemetry into an accurate percentage of remaining consumer quota | Claude explicitly describes its reported cost figures as client-side estimates that can differ from billing; subscription limits across vendors are not equivalent to API TPM/RPM accounting. | Keep NCU only as an internal scheduling estimate with a confidence level; never present it as provider-authoritative quota unless the provider actually reports remaining capacity. |
| Cross-provider handoff should extract detailed reasoning trajectories from provider transcript files | The CLIs expose documented session identifiers, resumability, tool events, file state, and final results; these are sufficient for a controller-owned state ledger. Claude, for example, directly returns `session_id` and supports `--resume`. | Make Git/files/artifacts and controller events canonical; do not make hidden or provider-specific reasoning text part of the persistence contract. |
| MCP and ACP are effectively interchangeable server surfaces | MCP standardizes connections from AI applications to tools/data/workflows, whereas current coding CLIs such as Grok and Cursor expose ACP specifically as an agent integration surface. | Expose MCP for controller tools; add ACP separately where a full agent/session protocol is desirable. |

The resulting architecture remains recognizably the system proposed in the question, but with a crucial shift: **the
controller should normalize semantics, not pretend that the seven CLIs have identical capabilities**.

It should be an operating-system-level orchestration and policy plane with provider adapters, a canonical state ledger,
sandbox/worktree supervision, routing, quota estimation, and an MCP front end. Native provider sessions remain
provider-owned optimizations beneath that layer.

One other conclusion is important for the compliance objective. The documentation itself contradicts a blanket
assumption that cached subscription authentication is inherently intended only for human terminals. Claude Code
officially supports non-interactive `-p` calls using subscription credentials; Codex documents saved ChatGPT
authentication for `codex exec`; Antigravity headless mode explicitly uses cached credentials; Grok documents cached
authentication for headless/ACP use; and Cursor explicitly describes print mode as intended for scripts and CI. At the
same time, **technical support for automation is not the same thing as a blanket contractual grant for every
third-party, commercial, resale, multi-user, or credential-sharing scenario**. An implementation should therefore
describe itself as using documented automation surfaces, not as providing “absolute ToS compliance.” Contractual
compliance needs to be maintained as a separate, versioned provider-policy review.

## Verified provider adapter design

The controller should define a small semantic adapter contract and let each provider implement that contract
differently. The current evidence strongly favors three execution transports rather than forcing everything through the
lowest common denominator:

1. **Ephemeral subprocess + JSON/JSONL**, for Claude, Antigravity, Codex, Cursor, Grok, OpenCode, and likely current
   Kimi.
2. **Persistent stdio agent protocol**, where ACP is officially exposed, notably Grok and Cursor, with Kimi's legacy
   implementation also having documented ACP support.
3. **Persistent local service**, where a tool officially provides one, as OpenCode does through its `serve`/`attach`
   architecture.

That is still “CLI-native” orchestration: the controller launches and supervises the vendor's official executable and
does not recreate its cloud protocol.

A corrected adapter matrix looks like this:

| Adapter | Current documented non-interactive surface | Structured output and continuity | Recommended automation posture |
| --- | --- | --- | --- |
| **Claude Code** | `claude -p`; Anthropic recommends `--bare` for scripted/SDK calls. | `--output-format json` or `stream-json`; token deltas use `--verbose --include-partial-messages`; final stream result contains session metadata; `--resume <session>` and `--continue` are documented. | `--bare`; explicit `--tools`/allow-deny policy; unattended safe baseline `--permission-prompts none` or `dontAsk`, with the understanding that denied operations fail closed. |
| **Grok Build** | `grok -p` / `--single`. | `plain`, `json`, `streaming-json`; sessions stored under Grok's local session state; `--resume`/`--continue`; native `grok agent stdio` ACP. | Explicit `--allow`/`--deny` plus a sandbox profile such as strict/read-only/workspace; avoid Always-approve unless the outer policy explicitly permits it. |
| **Google Antigravity** | `agy -p`, with `--print`/`--prompt` aliases. | `text`, `json`, `stream-json`; result metadata includes a conversation identifier and usage counters. | Prefer `proceed-in-sandbox` or a stricter `toolPermission` policy plus terminal sandboxing over blanket permission bypass. |
| **OpenAI Codex** | `codex exec`. | `--json` emits JSONL events including thread/turn/item/error events and usage; `codex exec resume <SESSION_ID>` or `--last`. | Explicit `--sandbox workspace-write` or stricter policy; use `--ignore-user-config`/`--ignore-rules` for controlled harnesses where appropriate. |
| **Cursor CLI** | `agent -p`. | `text`, `json`, `stream-json`; optional partial deltas; `--resume`, `--continue`; native `agent acp`. | `--sandbox enabled`; `--trust` only after controller trust evaluation; never automatically add `--approve-mcps` or `--force`. |
| **Kimi Code** | The old Kimi CLI is no longer a safe basis for a new adapter; Moonshot directs users to the replacement Kimi Code CLI. | Treat current command/session/output capabilities as runtime-discovered until the new CLI contract is pinned and regression-tested. | Adapter starts disabled on unknown versions; do not bake the old `kimi run`, K2.x model, configuration, or permission assumptions into the controller. |
| **OpenCode** | `opencode run "..."`; CLI is explicitly documented for programmatic use. | `--continue`, `--session`, `--fork`; `serve`, `attach`, session/export commands and ACP support are present in the CLI surface. | `--auto` auto-approves permissions not explicitly denied; build explicit permissions first, then optionally use `--auto`. |

Several details in this matrix deserve special attention.

**Claude Code.** `--bare` is an excellent building block for the untrusted-repository profile because it suppresses
discovery of hooks, skills, custom commands, subagents, installed plugins, MCP servers, auto memory and `CLAUDE.md`.
Claude retains Bash, read and edit capabilities, so bare mode is not itself a sandbox. The original proposal's
`--allowedTools "*"` should be removed: Claude's current permission documentation says unanchored allow globs such as
`"*"` are skipped with a warning. For unattended operation, `dontAsk` is a valuable fail-closed mode because calls that
would have required a prompt are denied; it is specifically **not** an “auto approve” mode.

Claude's JSON is also substantially more useful than merely scraping a UUID-shaped string. The documented pattern is to
read `.session_id` from `--output-format json` and pass it back using `--resume`; Claude can even resume from an
absolute transcript path. The controller should use the structured field and never infer IDs from text with regex.

**Grok Build.** Grok's official architecture now offers a stronger integration point than the proposed subprocess-only
design: its ACP mode runs as `grok agent stdio`, communicating over stdin/stdout while still using the Grok agent
harness and local authentication. This is an ideal downstream transport because the controller gets a durable protocol
without reverse-engineering xAI's cloud service.

Grok's permission and sandbox systems are explicitly distinct. Current documentation offers Ask, Auto and Always-approve
behavior, along with `--allow`/`--deny`; separately, Grok has sandbox profiles and documents Landlock on Linux and
Seatbelt on macOS, with sandboxing off unless enabled. This means an Always-approve agent inside an effective strict
sandbox and an unsandboxed Always-approve agent are radically different security configurations. The controller must
model both dimensions.

The draft also overstates Git worktrees as a mandatory defining property of every Grok execution. Grok does support
session forks and worktree-backed isolation, and sessions preserve prompts, responses, tool calls and file snapshots,
but worktree use should be exposed as an execution capability rather than assumed for every task.

**Antigravity.** Google's migration from Gemini CLI to Antigravity makes the proposed `agy` target current, and the
current CLI is designed for terminal, agentic editing and history workflows. Headless behavior is especially
controller-friendly: `agy -p` writes the response to stdout and diagnostics to stderr, uses cached authentication, and
exits with an authentication error rather than waiting for interactive login when credentials are missing.

There is also an authentication detail worth correcting in CI designs. Google's documentation says setting
`GEMINI_API_KEY` by itself is not sufficient for Antigravity API-key mode; the corresponding model provider must be
configured as Gemini. That option can simply remain disabled in a subscription-only controller.

Most importantly, the adapter should not mechanically add `--dangerously-skip-permissions`. Antigravity exposes a
structured `toolPermission` setting with `request-review`, `proceed-in-sandbox`, `always-proceed`, and `strict`, and
provides terminal sandbox controls. Those give the controller safer native choices.

**Codex.** The supplied Codex adapter is the furthest from the current official surface. OpenAI's documented scripting
command is `codex exec`; `--json` already emits JSONL, including thread, turn, item, error, and token-usage events.
There is therefore no architectural reason to invent a “custom JSON stdout wrapper.”

Likewise, the current automated safety posture should not be built around `--yolo`. OpenAI documents explicit sandbox
choices and notes that `--full-auto` is a deprecated compatibility option, with `--sandbox workspace-write` preferred.
`--ignore-user-config` and `--ignore-rules` are also useful in a controller that does not want host configuration
silently changing the execution contract. Codex implements native platform sandboxing using Seatbelt on macOS,
bubblewrap on Linux/WSL2, and its Windows sandbox on Windows.

Codex also supports both ChatGPT-subscription authentication and API-key authentication. Saved CLI authentication is
reused by `codex exec`, while OpenAI's CI guidance warns against broadly exposing `OPENAI_API_KEY`/`CODEX_API_KEY` to
repository-controlled code and recommends scoping credentials tightly. This aligns closely with the proposed “controller
does not perform login” boundary.

**Cursor.** Cursor is now substantially more controller-friendly than the original description implies. Print mode is
explicitly intended for scripts, CI, and automation, with native `json` and `stream-json` formats, sessions, sandboxing,
worktree creation, and a hidden-but-documented `agent acp` command for advanced ACP clients.

`--trust`, `--approve-mcps`, and `--force` are not one logical switch. `--trust` suppresses workspace trust prompting in
headless mode; `--approve-mcps` approves MCP servers; `--force` or `--yolo` force-allows commands unless denied. Cursor
separately exposes `--sandbox enabled|disabled`, including network and path controls in its sandbox subcommands. A
secure adapter must decide each of these independently.

**Kimi.** This adapter must be redesigned around version discovery. On September 23, 2026, Moonshot archived the old
Python `kimi-cli`, stated that it would receive no further fixes or security updates, and directed users to the
next-generation `MoonshotAI/kimi-code`; the migration process preserves configuration and sessions but requires
login/MCP authorization to be redone. The older CLI had ACP and MCP support, but using its command syntax as evidence
for the replacement would be unsafe.

The proposed fixed “Kimi K2.7 Code / 256K / `kimi run` / YOLO equivalent” entry should consequently be removed from the
hardcoded matrix. Moonshot's current consumer surface is already promoting K3, demonstrating why model identity and
context limits belong in a **dynamic model registry**, not in adapter source code.

**OpenCode.** The proposed persistent-worker idea is well aligned with the current product. OpenCode documents `opencode
run` for programmatic invocation, has `serve` and `attach`, supports sessions/forks, exposes ACP support, and provides
`--auto` to approve permissions that are not explicitly denied. The main architectural caveat is that OpenCode can sit
on top of multiple model providers, so the usage ledger must record both the **harness** and the **actual backing
provider/model**. Otherwise the router can accidentally double-count capacity or regard two paths to the same underlying
quota pool as independent resources.

Finally, remove fixed context-window numbers from the execution-adapter table. Context limits are properties of a
particular model/configuration/account at a particular point in time, not stable properties of “Claude Code,” “Cursor,”
or “OpenCode.” Claude's current CLI itself accepts model aliases and full model IDs, while Cursor exposes
`--list-models`; model capability metadata should therefore live in a separately refreshed registry.

## Compliance and authentication boundary

The strongest version of the “controller never handles OAuth” rule is feasible and should be retained.

The controller should **never**:

- initiate provider browser login;
- submit OAuth forms;
- copy or transform access/refresh tokens;
- scrape account dashboards;
- impersonate the native CLI's network protocol;
- patch a CLI to bypass limits;
- move a user's subscription credential from one identity or machine to another behind their back.

Instead, each adapter has an **authentication preflight** that asks the native executable whether it is already usable.
If it is not, the controller returns a normalized `AUTH_REQUIRED` state and stops. The human performs the provider's
normal login independently.

That pattern directly matches several current products. Claude Code provides `claude auth status` as structured JSON
with success/failure exit codes, supports Pro/Max/Teams/Enterprise subscription login, and then stores credentials in
the macOS Keychain or provider-managed credential files depending on platform. Claude also supports separate
`CLAUDE_CONFIG_DIR` locations, which is useful for deliberately isolating different accounts or execution identities.

Codex similarly supports ChatGPT subscription login as well as API-key billing, with cached credentials used by
subsequent CLI executions. Its documentation explicitly warns that `~/.codex/auth.json`, where applicable, contains
sensitive access material and must be treated like a password. Antigravity checks the operating-system credential store
for an existing login and headless execution fails rather than launching an unresolved interactive login flow. Grok ACP
can likewise use its cached local token rather than requiring the controller to implement authentication.

This leads to a better process boundary:

```text
Human account owner
        │
        │ one-time/periodic provider-native login
        ▼
┌───────────────────────────────┐
│ Provider-owned credential     │
│ store / OS keyring            │
└──────────────┬────────────────┘
               │ read only by provider CLI
               ▼
┌───────────────────────────────┐
│ Native CLI / native ACP agent │
└──────────────┬────────────────┘
               │ JSONL / ACP / exit status
               ▼
┌───────────────────────────────┐
│ Unified controller            │
│ never receives raw credential │
└───────────────────────────────┘
```

There is a subtle security limitation here that deserves explicit treatment: **simply putting the credential and the
repository under the same Unix account does not create meaningful secret isolation**. If an autonomous agent can execute
an arbitrary shell as the same identity that can read a plaintext credential file or query the same user keyring,
malicious repository instructions can potentially target that credential. A dedicated OS user limits host blast radius,
but it does not by itself solve this intra-user secret boundary.

Consequently, provider eligibility for an untrusted task should depend on whether the adapter can meaningfully confine
**agent-executed commands** away from provider credentials. Codex, Grok and Cursor have documented native sandbox
controls; those should be used before adding an outer container or MAC layer. Where a provider cannot provide adequate
separation, the controller should disable arbitrary shell execution for untrusted repositories rather than pretend an
outer “YOLO + Docker” wrapper automatically solves credential exfiltration.

The controller should also maintain a small **Compliance Manifest** independent of the technical adapter:

```json
{
  "provider": "example",
  "validated_cli_version": "x.y.z",
  "validated_on": "2026-10-12",
  "auth_modes_allowed": ["native_cached_subscription"],
  "automation_surface": ["documented_headless"],
  "credential_export_allowed": false,
  "dashboard_scraping_allowed": false,
  "network_protocol_reverse_engineering": false,
  "commercial_multi_user_status": "requires-review",
  "source_revision": "provider-terms-date-or-id"
}
```

This is the appropriate place to encode contractual restrictions after legal/provider review.

The key correction to the draft is therefore semantic: **using the provider's official headless mode is strong technical
evidence that programmatic CLI use is a supported product behavior, but it is not enough to certify every downstream
business arrangement as contractually compliant.** Claude, Codex, Cursor, Antigravity and Grok all document automation
or headless use today.

Binary versions should be treated as part of that compliance boundary as well. Claude's current documentation contains
numerous features gated to specific CLI versions, and Kimi's September 2026 replacement demonstrates how quickly a CLI
contract can disappear. A production controller should therefore probe:

```text
binary existence
→ binary version
→ expected automation command
→ expected output-format support
→ expected sandbox/permission flags
→ auth status
→ harmless structured-output smoke test
```

A provider adapter whose installed binary is outside its validated version interval should enter
`ADAPTER_VERSION_UNVERIFIED`, not silently guess new arguments.

## Meta-session state and cross-provider continuity

The proposed Meta-Session ID is one of the strongest concepts in the blueprint, but the canonical data source should be
inverted.

The original design effectively says:

> provider transcript → extract full trajectory → summarize → become controller state

The more robust design is:

> controller state + Git/files/artifacts → provider-native session as an optimization

Native sessions should still be used aggressively. Claude returns a documented session ID and accepts that ID through
`--resume`. Codex provides `codex exec resume`, including the last-session shortcut. Cursor supports `--resume` and
`--continue`. Grok stores session state locally and exposes explicit resume/continue mechanisms; notably, its
`-s/--session-id` naming behavior should not be confused with resuming an existing session.

A meta-session can therefore keep bindings like:

```text
MetaSession 01J...
 ├─ claude   → native session A
 ├─ codex    → native thread B
 ├─ cursor   → chat C
 ├─ grok     → session D
 └─ current workspace → /worktrees/01J...
```

But the native session is not the truth. The canonical record should be something approximately like:

```json
{
  "meta_session_id": "01J...",
  "objective": "Migrate authentication subsystem to OIDC",
  "constraints": [
    "No schema changes",
    "Node 24",
    "Existing public API must remain compatible"
  ],
  "repository": {
    "root": "/workspace/project",
    "worktree": "/workspace/.controller/01J...",
    "base_commit": "98f...",
    "head_commit": "d41..."
  },
  "decisions": [
    {
      "id": "D17",
      "decision": "Keep refresh tokens server-side",
      "reason_summary": "Preserves existing browser security boundary"
    }
  ],
  "changed_files": [
    "src/auth/session.ts",
    "src/auth/oidc.ts"
  ],
  "verification": {
    "commands": ["npm test", "npm run typecheck"],
    "status": "passed",
    "artifacts": ["artifact://..."]
  },
  "open_work": [
    "Add migration documentation"
  ],
  "provider_bindings": {
    "claude": "native-session-A",
    "codex": "native-thread-B"
  }
}
```

There are four reasons this is superior.

First, **Git and the workspace are cross-provider by construction**. Whether Claude, Codex or Cursor produced the
modification, the actual source file and Git commit are semantically identical. Provider conversation history is not.

Second, it removes dependence on undocumented storage internals. Claude officially exposes session IDs and can resume
sessions, so parsing private `.jsonl` offsets just to discover what the CLI already reports would be unnecessary. Grok
similarly documents session persistence and session operations.

Third, it avoids treating detailed model reasoning as application state. The controller needs observable decisions, tool
calls, errors, file changes, tests and conclusions—not private intermediate reasoning. Claude can stream tool-use and
result structures, and some modes can expose additional subagent material, but the architecture should not depend on
that optional content.

Fourth, it makes retries and failover transactional. A run can be associated with a Git base commit, an isolated
worktree and a set of produced artifacts. The controller can determine exactly whether a failed invocation changed files
before deciding whether retry is safe.

**Lossy Context Compaction is still valuable**, but its input should be controller-owned evidence. The handoff bundle
should contain:

```text
Goal
Constraints
Architecture decisions
Current Git base/head
Changed-file list
Relevant diff excerpts
Latest compiler/test diagnostics
Known failures already attempted
Outstanding tasks
Exact paths the next agent should inspect
```

The new provider is then instructed to inspect the current repository itself before continuing. This is much more robust
than trying to serialize Provider A's conversational syntax into Provider B.

It also permits **incremental compaction**. Instead of repeatedly summarizing a huge conversation, store immutable
decision/events and periodically build a materialized “handoff view.” That view can be regenerated if the summarizer
makes a mistake.

SQLite is a strong default for this controller because the workload is local, relational, highly transactional and not
especially large. RocksDB only becomes compelling if the event volume or write topology justifies losing SQL's simpler
relational model. A reasonable schema is:

```text
meta_session
provider_binding
run
run_event
decision
artifact
workspace_checkpoint
usage_observation
provider_health
route_decision
adapter_version
```

Use an append-only `run_event` table for auditability and materialized current-state tables for fast routing.

A session transition then becomes deterministic:

```text
Provider A completes
      │
      ▼
Capture final structured event
      │
      ▼
Compute Git/file/test checkpoint
      │
      ▼
Merge new explicit facts/decisions
      │
      ▼
Build compact handoff view
      │
      ├──── same provider ────► native --resume
      │
      └──── new provider ─────► new native session + handoff context
```

Claude's own checkpointing feature demonstrates the value of treating file state independently from prose conversation:
current Claude Code keeps file snapshots tied to session checkpoints and allows rewind after resumption. The controller
should generalize that principle across providers rather than try to force every vendor's transcript format into one
database.

## Routing, capacity, and resilience

The high-level three-axis taxonomy in the proposal—context volume, tool/autonomy complexity, reasoning depth—is a good
starting feature vector. The weak part is hardcoding “low = Kimi/Gemini, medium = Cursor/OpenCode, high = Claude/Grok.”

That mapping will decay quickly. In September 2026 alone Anthropic introduced Opus 5.5 and Sonnet 5.5, xAI released Grok
4.7, and Moonshot subsequently changed its Kimi CLI generation and current Kimi product positioning. The routing policy
must learn against **installed provider/model capabilities**, not brand stereotypes.

A better router has two stages.

**Hard eligibility comes first.** A provider is eliminated if it cannot satisfy any mandatory requirement:

```text
trusted workspace requirement
write permission requirement
shell requirement
network requirement
sandbox strength
minimum model/context capability
required MCP/tool availability
platform compatibility
known auth state
known quota exhaustion
maximum concurrency
provider health
```

Only eligible candidates enter scoring.

**Then rank eligible candidates empirically.** A useful first production formula is:

$$
S(p,t)=
w_q\hat P(\mathrm{success}\mid p,t)
-w_l\hat L(p,t)
-w_cR_{\mathrm{capacity}}(p)
-w_sR_{\mathrm{security}}(p,t)
-w_hC_{\mathrm{handoff}}(p,t)
-w_mC_{\mathrm{money}}(p,t)
$$

where task $t$ supplies observed repository/task features and provider $p$ includes the exact harness/model/version.

The controller should begin with manually calibrated weights and collect outcomes. Once enough data exists, a
contextual-bandit router is a better match than Item Response Theory as the main online decision system. Current routing
research such as MixLLM explicitly frames query-to-LLM selection as a contextual-bandit problem balancing quality, cost,
latency and a changing model population.

IRT can still be useful offline: run a controlled task suite against each adapter, infer a latent task-difficulty scale,
and use that as one router feature. It should not be the sole control algorithm because real tasks involve constraints
that are not one-dimensional “difficulty”: sandboxing, shell behavior, codebase size, language support, latency and
subscription availability matter independently.

The capacity system needs a similar conceptual correction.

Claude's `json` result can report `total_cost_usd` and per-model estimates, but Anthropic explicitly labels these
client-side estimates and notes that they can differ from the actual bill. Codex JSONL exposes token usage, but token
usage does not automatically tell the controller how much ChatGPT subscription capacity remains. Antigravity provides
structured usage information and has explicit usage/credit surfaces, but again the controller should record exactly what
Google reports rather than convert every number into a falsely precise universal percentage.

An internal NCU concept can survive if it is redefined as a **scheduler estimate**, not a synthetic claim about provider
quota:

```json
{
  "provider": "claude",
  "capacity_score": 0.63,
  "confidence": 0.42,
  "source": [
    "recent_success_rate",
    "observed_rate_limit_events",
    "rolling_usage_estimate"
  ],
  "explicit_remaining": null,
  "reset_at": null,
  "concurrency_available": 2,
  "throttle_risk": 0.18,
  "last_updated": "2026-10-12T..."
}
```

If a provider actually returns “17% remaining until 14:00,” `explicit_remaining` can contain it with high confidence. If
it does not, the controller should not invent “17%.”

This also changes traffic shaping.

A token bucket is excellent when a provider contract actually gives the client TPM/RPM limits. It is much less
meaningful when the resource is an opaque, dynamically throttled subscription. For subscription CLIs, the default should
instead be:

```text
Controller-wide bounded priority queue
        │
        ├─ provider concurrency semaphore
        ├─ rolling latency/error estimator
        ├─ capacity-confidence gate
        ├─ circuit breaker
        └─ optional provider-specific rate gate
```

A bounded priority queue is preferable to a strict constant-rate leaky bucket for the controller ingress because coding
workloads have different priorities and durations. A ten-second interactive fix should not sit behind twenty hour-scale
repository audits simply because they arrived first.

The controller can still implement a token bucket for a provider when reliable provider limits are known. It just should
not pretend every subscription operates like a metered API key.

**Retry semantics are more important than the precise backoff equation.** The draft assumes that a 429 can be
intercepted and the entire CLI invocation retried after exponential backoff. That is unsafe when an invocation has
already edited files or run side-effecting commands. The first attempt can modify the workspace and then fail during a
later model request. Re-running the original request against the modified state can duplicate work or trigger a
different sequence.

Every write-capable attempt should therefore execute against a checkpointed worktree:

```text
base checkpoint
      │
      ▼
attempt N in isolated worktree
      │
      ├─ success ─────────► commit/checkpoint
      │
      ├─ clean rate limit ► retry after policy
      │
      └─ partial mutation ► rollback or resume native session,
                            never blindly replay
```

Claude's structured error stream even distinguishes categories such as `rate_limit`, `overloaded`, authentication,
billing and server failures, enabling the adapter to make more precise retry decisions.

A normalized failure taxonomy should look more like:

```text
AUTH_REQUIRED
PERMISSION_BLOCKED
SANDBOX_VIOLATION
MODEL_UNAVAILABLE
QUOTA_EXHAUSTED
RATE_LIMIT_TRANSIENT
PROVIDER_OVERLOADED
TOOL_FAILURE
TEST_FAILURE
PROCESS_TIMEOUT
PROCESS_CRASH
OUTPUT_PROTOCOL_ERROR
ADAPTER_VERSION_UNVERIFIED
CANCELLED
```

Only selected classes are retryable.

The promise that backoff can make finite subscriptions look infinitely available should also be removed. A hard quota
remains a hard quota. The correct abstraction is **controlled backpressure**: fail over when policy permits, queue when
a reset is reasonably known, otherwise return `QUOTA_EXHAUSTED` to the orchestrator.

## Security, sandboxing, concurrency, and telemetry

The controller should adopt a small number of explicit **trust profiles** rather than trying to translate one universal
permission mode into each provider.

| Controller trust profile | Files | Shell | Network | Project hooks/MCP/config | Intended use |
| --- | --- | --- | --- | --- | --- |
| `inspect-untrusted` | Read-only workspace | None | Off | Disabled | Unknown repositories, security review |
| `edit-untrusted` | Isolated worktree only | Narrow allowlist | Off by default | Disabled | Automated code edits without arbitrary execution |
| `test-sandboxed` | Isolated worktree | Build/test commands | Allowlisted | Controller-approved only | Normal autonomous engineering |
| `trusted-development` | Workspace/worktree | Broader shell | Policy-based | Allowlisted repo integrations | Known internal repositories |
| `privileged` | Explicit scope | Explicit scope | Explicit scope | Explicit scope | Human/admin-approved exceptional jobs |

Each provider adapter then compiles that profile into the strongest controls it actually supports.

For Claude, an untrusted profile can use `--bare` to prevent repository-discovered hooks, plugins, MCP servers, memory,
and `CLAUDE.md`, and `dontAsk`/explicit tool controls to fail closed.

For Codex, the controller can combine explicit sandboxing with `--ignore-user-config` and `--ignore-rules` where the
desired policy is complete harness control.

For Grok, permission rules and sandbox selection must both be compiled because xAI treats them separately. A strict
sandbox alone does not imply which model tool calls are authorized, and permission approval alone does not provide
filesystem confinement.

For Cursor, `--sandbox enabled` belongs in the security profile, while `--trust`, `--approve-mcps` and `--force` belong
in separate workspace/MCP/command authorization decisions. Cursor's sandbox command even supports additional
writable/read-only paths, blocked patterns and an explicit network switch.

This means the controller should almost never construct commands such as:

```text
--dangerously-skip-permissions
--yolo
--force
--always-approve
--approve-mcps
```

merely because the run is headless. A headless run that encounters a denied operation should normally fail with a
structured policy error. Autonomy and unlimited authority are not synonyms.

The original Claude hook proposal also deserves revision. Claude's hooks are not undocumented; `PreToolUse`, `Stop` and
related lifecycle hooks are part of Anthropic's documented extension mechanism. Claude's stream can additionally expose
hook events.

A `PreToolUse` hook is a useful **supplemental enforcement layer**, but dynamically rewriting global
`~/.claude/settings.json` before every concurrent run is a poor controller primitive. It creates races between sessions
and makes cleanup failure security-relevant. The safer hierarchy is:

```text
outer controller policy
        │
        ▼
OS / provider sandbox
        │
        ▼
native permission rules
        │
        ▼
optional per-run/per-profile hook
        │
        ▼
model tool call
```

Use a dedicated provider configuration namespace or ephemeral per-run configuration wherever the CLI supports one.
Claude, for example, can segregate configurations and credentials through `CLAUDE_CONFIG_DIR`.

Repository-supplied agent configuration must itself be treated as untrusted input. Grok documents project hooks and
trust semantics, while Claude's `--bare` exists specifically to prevent scripted invocations from silently loading
host/project extensions. Cursor's `--approve-mcps` is another obvious example: a controller should not auto-approve
repository MCP servers until their definitions have passed policy inspection.

Concurrency should be governed at the **workspace** layer as well as the provider layer.

The controller should grant exactly one write lease for a normal meta-session worktree. Parallel tasks get separate
worktrees:

```text
Repository
   │
   ├── worktree/session-A
   │      └── Claude task
   │
   ├── worktree/session-B/subtask-1
   │      └── Cursor task
   │
   ├── worktree/session-B/subtask-2
   │      └── Grok task
   │
   └── integration worktree
          └── merge + tests
```

Grok supports worktree-oriented session/fork behavior, and Cursor now directly exposes `--worktree` plus a base-ref
control. The controller should generalize this even for agents that do not natively understand worktrees.

This eliminates reliance on an upstream orchestrator correctly serializing writes. The user-supplied description of an
OpenClaw “Lane Queue” may be a useful upstream pattern, but I could not establish that specific current implementation
claim from an authoritative source in the available research. The controller should therefore enforce its own workspace
leases regardless of whether OpenClaw, Grok Bot, or another host promises per-session serialization.

Telemetry should likewise come primarily from the **wrapper boundary**, not vendor hooks.

Every run already has:

```text
spawn timestamp
binary/version
normalized request
routing decision
stdout structured events
stderr diagnostics
process resource usage
exit/signal
workspace diff
test results
provider-reported usage
retry/circuit-breaker events
```

Those events can be converted directly into OpenTelemetry traces. Hooks are useful only for information or policy checks
that cannot otherwise be observed.

A normalized trace could contain:

```text
controller.delegate
 ├─ route.classify
 ├─ provider.acquire_capacity
 ├─ workspace.create_checkpoint
 ├─ provider.spawn
 │   ├─ agent.tool.read
 │   ├─ agent.tool.edit
 │   ├─ agent.tool.shell
 │   └─ provider.model_turn
 ├─ workspace.diff
 ├─ verification.tests
 └─ run.finalize
```

Raw prompts, credentials, arbitrary environment variables and full shell output should not automatically become
telemetry attributes. Store large logs as access-controlled artifacts and attach hashes/IDs to traces.

The MCP boundary must receive the same threat treatment. MCP's current specification defines a standardized connection
between AI applications and external tools, data and workflows; granting an MCP client a coding delegation tool
therefore places a privileged execution capability behind that tool. OWASP's GenAI security work likewise treats
tool-enabled applications and external integrations as security-sensitive surfaces. Authorization must exist at the
controller even when the upstream agent is trusted.

## MCP, ACP, and the recommended production architecture

The final system should expose **MCP as its control plane** and treat ACP as a complementary agent protocol.

MCP is a natural fit for the upstream orchestrator because the current standard is explicitly designed to let AI
applications consume external tools, workflows and data. A primary agent does not need seven provider schemas; it needs
a handful of controller capabilities.

ACP is valuable in a different place. Grok Build exposes a native ACP server over stdio/JSON-RPC, and Cursor exposes
`agent acp` for custom ACP clients. The controller can therefore act as an **ACP client downstream** while still
exposing simple MCP tools upstream. That preserves the richer session semantics of a native agent without polluting the
primary orchestrator's context with the provider's complete interface.

OpenCode's persistent `serve`/`attach` design represents a third downstream mechanism and can be treated behind the same
adapter contract.

The topology becomes:

```text
                 Primary Orchestrator
             OpenClaw / Grok Bot / other
                          │
                     MCP client
                          │
                          ▼
┌──────────────────────────────────────────────────────┐
│       Unified Headless Coding Controller             │
│                                                      │
│  MCP Tool Surface                                    │
│        │                                             │
│        ▼                                             │
│  Policy / AuthZ ─────► Meta-Session Store            │
│        │                    │                        │
│        ▼                    ▼                        │
│  Task Classifier ───► Routing Engine                 │
│                           │                          │
│            ┌──────────────┼───────────────┐          │
│            ▼              ▼               ▼          │
│        Capacity       Health/Circuit    Security      │
│        Estimator      Breakers           Policy      │
│            └──────────────┬───────────────┘          │
│                           ▼                          │
│                      Scheduler                       │
│                           │                          │
│               Workspace / Worktree Manager           │
│                           │                          │
│                     Run Supervisor                    │
│                           │                          │
│       ┌───────────────────┼───────────────────┐      │
│       ▼                   ▼                   ▼      │
│  subprocess/JSONL    stdio ACP           local svc   │
│       │                   │                   │      │
└───────┼───────────────────┼───────────────────┼──────┘
        │                   │                   │
   Claude / Codex      Grok / Cursor       OpenCode
   Antigravity/...      / Kimi*             serve
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                   Provider-owned harness
                            │
                            ▼
                  Provider cloud service

              Controller-owned observability
                     │
             OpenTelemetry / logs
                     │
          optional read-only dashboard
```

`Kimi*` remains version-gated until the new Kimi Code CLI's automation contract is pinned.

The outward MCP API should be smaller than the one in the draft. A good production surface is:

| MCP tool | Purpose |
| --- | --- |
| `delegate_task` | Start work against a workspace/meta-session with objective, constraints, trust profile and optional routing hints. |
| `continue_task` | Continue an existing meta-session, allowing same-provider native resume or cross-provider handoff. |
| `get_run` | Retrieve normalized state, summary, verification results and artifact references. |
| `cancel_run` | Terminate an active run through the process supervisor. |
| `get_capacity` | Return provider capacity estimates **with source and confidence**, not fabricated exact percentages. |
| `list_capabilities` | Report currently installed/validated adapters, models, sandbox features and version status. |
| `explain_route` | Return the factors responsible for the selected provider without exposing internal model reasoning. |
| `get_artifacts` | Retrieve diff, test report, generated files, or summarized logs associated with a run. |

A forced provider is still useful, but it should be an optional field such as:

```json
{
  "routing": {
    "provider_preference": "claude",
    "require_provider": false,
    "minimum_capability": "high"
  }
}
```

rather than an unrestricted `force_route_to_tier` tool that bypasses security and quota policy. Setting
`require_provider=true` should constrain routing but **not** disable authentication, sandbox, workspace or compliance
checks.

A normalized `delegate_task` response should be equally compact:

```json
{
  "run_id": "run_01J...",
  "meta_session_id": "sess_01J...",
  "status": "SUCCEEDED",
  "provider": {
    "adapter": "codex",
    "model": "resolved-at-runtime",
    "native_session_id": "..."
  },
  "route": {
    "reason": [
      "eligible sandbox profile",
      "high recent success on this task class",
      "lower current throttle risk"
    ]
  },
  "result": {
    "summary": "Implemented OIDC refresh-token rotation.",
    "changed_files": 6,
    "tests": {
      "passed": 184,
      "failed": 0
    }
  },
  "artifacts": {
    "diff": "artifact://...",
    "test_report": "artifact://..."
  },
  "usage": {
    "reported": {},
    "estimated": {},
    "capacity_confidence": 0.61
  }
}
```

This achieves the context-efficiency objective without making the unsupported claim that an MCP boundary “frees 96%” of
an orchestrator's context. MCP clearly reduces the amount of provider-specific implementation detail that an upstream
model needs to see, but the exact savings depend on the host, schemas, prompts and task; no universal percentage is
defensible from the evidence reviewed.

The recommended controller internals can then be reduced to seven durable components:

```text
Adapter Registry
      │
      ├── version/capability probes
      └── command/protocol compilation

Policy Engine
      │
      ├── trust profiles
      ├── provider compliance manifest
      └── MCP caller authorization

Session Ledger
      │
      ├── canonical project state
      ├── provider bindings
      └── decisions/artifacts

Workspace Manager
      │
      ├── checkpoints
      ├── worktrees
      └── merge/rollback

Router / Scheduler
      │
      ├── eligibility
      ├── empirical scoring
      ├── capacity estimates
      └── concurrency/backpressure

Execution Supervisor
      │
      ├── subprocess / ACP / service transports
      ├── timeout / cancellation
      ├── sandbox
      └── normalized errors

Telemetry Pipeline
      │
      ├── structured provider events
      ├── controller spans
      ├── usage observations
      └── redacted artifacts
```

The implementation order matters. A router built before the execution semantics are trustworthy will learn from
corrupted data. A capacity model built before provider telemetry is normalized will produce false precision.
Cross-provider summaries built before workspace checkpointing will be impossible to validate.

The production sequence should therefore be:

| Stage | Deliverable | Exit criterion |
| --- | --- | --- |
| **Foundation** | SQLite state model, run IDs, artifact store, process supervisor, worktree manager | A dummy CLI can run transactionally and be cancelled/recovered. |
| **Adapters** | Claude, Codex, Grok, Antigravity, Cursor; then OpenCode and current Kimi | Every adapter passes versioned conformance tests for success, failure, resume, auth-missing and malformed output. |
| **Isolation** | Trust profiles compiled into provider + OS controls | Malicious fixture repositories cannot escape the allowed workspace/network/tool surface. |
| **Continuity** | Native provider resume plus controller-owned cross-provider handoff | Provider A can edit/test; Provider B can continue from canonical state without transcript scraping. |
| **Capacity** | Usage observations, quota states, circuit breakers, adaptive concurrency | Reported vs estimated capacity is distinguishable and throttle behavior fails closed. |
| **Routing** | Static policy first, empirical success/latency model second, contextual learning later | Every routing decision is reproducible and explainable from stored features. |
| **Protocol** | Minimal MCP server, optional ACP gateway | Upstream orchestrator sees only stable high-level controller semantics. |
| **Hardening** | Version pinning, update canaries, telemetry redaction, compliance manifests | Unknown CLI updates cannot silently weaken permissions or change parsing behavior. |

The final architecture is therefore slightly less magical than the initial proposal and significantly more defensible.

The controller should **not** attempt to manufacture one synthetic super-session by copying every vendor's hidden
conversational state. It should create one authoritative engineering session whose shared truths are goals, constraints,
files, Git state, decisions, artifacts, tests and observable agent actions. Native Claude/Codex/Grok/Cursor/etc.
sessions then become accelerators beneath that layer.

It should **not** claim to know exactly how much Claude Max capacity equals how much ChatGPT, Grok, Cursor or Kimi
capacity. It should maintain confidence-weighted observations, learn from throttling, and route conservatively.

It should **not** make “headless” synonymous with “YOLO.” Permission bypasses become explicit exceptional capabilities
beneath a controller-owned trust model.

It should **not** implement every downstream connection as fragile stdout text scraping. Current CLIs already offer
native JSONL, resumable session identifiers, ACP, sandboxes and persistent server modes; using those documented surfaces
remains faithful to the CLI-native design while dramatically improving reliability.

And it should **not** make the upstream orchestrator know anything about those differences. That is exactly where MCP
fits: the current protocol is intended to connect AI applications to external tools and workflows behind a standardized
boundary.

With those corrections, the design is technically viable as a local, headless, provider-preserving meta-orchestrator.
Its strongest production form is not “seven CLIs pretending to be one model.” It is a **policy-governed execution
fabric** in which seven changing agent harnesses are disposable workers beneath stable controller semantics.
