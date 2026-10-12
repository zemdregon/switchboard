# Architectural Blueprint for a Unified, Headless AI Coding Controller

## Introduction to the CLI-Native Orchestration Paradigm

The rapid proliferation of autonomous AI coding agents has segmented the development ecosystem into highly specialized, proprietary silos. As of late 2026, the most capable models and their respective agentic loops—encompassing environment inspection, multi-step planning, tool execution, and syntax verification—are distributed directly through native command-line interfaces (CLIs). These tools include Anthropic’s Claude Code, Google’s Antigravity (agy), OpenAI’s Codex, Cursor’s CLI, OpenCode Go, xAI’s Grok Build, and Moonshot AI’s Kimi Code. Each of these tools possesses distinct context windows, reasoning topologies, and cost structures.

Directly integrating the underlying large language models (LLMs) via backend APIs fundamentally strips away the proprietary agentic scaffolding, file-editing capabilities, and specialized sandboxing that render these CLI tools effective. Furthermore, attempting to reverse-engineer these CLIs or bypass their consumer authentication flows to harvest their capabilities via direct API access violates the Terms of Service (ToS) governing consumer and professional subscription tiers. Providers explicitly prohibit third-party tools from reusing session credentials or circumventing the intended interactive interfaces unless accessing them through officially documented headless modes.

The architectural imperative, therefore, is the design of a unified, headless AI coding controller that acts as a meta-orchestrator. Strict design constraints must be applied to maintain compliance and operational integrity. First, the controller must have no web interface, except for highly restricted dashboards intended purely for usage monitoring and telemetry visualization. Second, it must completely avoid interacting with OAuth flows or other subscription login interfaces, relying exclusively on the cached host credentials managed by the native CLIs.

This controller must manage the seven target subscriptions purely by wrapping their native CLI executables, parsing their standard output (stdout) and standard error (stderr) streams. It must manage its own model definitions for predictive routing based on task complexity, execute tier-aware load balancing across different provider subscriptions, and maintain persistent cross-provider meta-sessions. Finally, it must expose its entire capability surface as a Model Context Protocol (MCP) or Agent Context Protocol (ACP) server, injecting dynamic routing and delegation tools into the harness of a primary orchestrating agent, such as OpenClaw or Grok Bot.

## Subsystem Integration: The Headless Dispatch Layer

To remain strictly compliant with provider policies, the controller treats each native CLI as an opaque, ephemeral compute node. It achieves this by invoking the CLIs in their respective non-interactive or "headless" modes. This ensures that the proprietary agentic loop—planning, tool execution, and verification—runs to completion using the provider's infrastructure without requiring a human terminal UI.

### Execution Normalization Across Seven Providers

Because each CLI possesses idiosyncratic flags for headless execution, context management, and output formatting, the controller abstracts these differences into a unified internal request object. This object is subsequently translated by provider-specific execution adapters prior to spawning the subprocess.

#### Claude Code (Anthropic)

Claude Code requires the -p (or --print) flag to execute a single prompt non-interactively, returning a standard exit code of 0 on success and a non-zero code on failure. For deterministic and secure execution, particularly in automated environments, the controller appends the --bare flag. This critical parameter skips the auto-discovery of local hooks, auto-memory, MCP servers, and .claude/settings.json configurations, which could otherwise introduce side effects or execute malicious instructions hidden within an untrusted repository.

To programmatically parse the output and track costs, the controller utilizes --output-format json or --output-format stream-json. When utilizing streaming JSON, the controller must also append --verbose and --include-partial-messages to capture token-level deltas and intermediate tool calls. Furthermore, to bypass human-in-the-loop prompts for routine shell executions, the controller passes explicit allowlists via --allowedTools or sets a session-wide policy using --permission-mode dontAsk, which permits safe reads but strictly blocks destructive actions.

#### Grok Build (xAI)

xAI’s Grok Build CLI mirrors several headless conventions found in Claude but introduces a sophisticated architecture centered on parallel subagents bounded by Git worktrees. The controller triggers non-interactive execution via the -p or --single flag, and can supply structured inputs using --prompt-json.

Because Grok Build operates directly on the filesystem with high autonomy, the controller explicitly manages its operational boundaries. It utilizes the --tools flag to pass a strict allowlist of permitted actions (e.g., read_file,grep) or the --disallowed-tools flag to remove access to dangerous internal tool IDs like run_terminal_cmd. Alternatively, the controller can rely on a globally defined defaultMode: "acceptEdits" policy to bypass human prompts for non-destructive file modifications. However, the controller must actively mitigate known vulnerabilities in Grok Build's architecture, such as malicious repositories attempting to write to $GROK_HOME/hooks/ via the acceptEdits mode, by strictly sandboxing the execution environment.

#### Antigravity CLI (Gemini / agy)

Google’s Antigravity CLI (agy), which replaced the legacy Gemini CLI, operates as a self-contained Go binary and requires the -p (or --prompt) flag for headless invocation. Unlike Claude Code, an unauthenticated headless run in agy fails immediately with an authentication error rather than hanging in the terminal. The controller relies seamlessly on the host's cached credentials stored via prior interactive logins, or injects a GEMINI_API_KEY for continuous integration (CI) environments.

The controller requests machine-readable streams via --output-format stream-json, which emits an init event, a series of step_update events for tool calls, and concludes with a result event. Crucially, agy does not possess a simple --yolo flag. To achieve full autonomy in the headless pipeline, the controller must pass --dangerously-skip-permissions to authorize tool executions and file writes. This places the burden of sandboxing and security entirely on the controller's overarching validation logic before the subprocess is spawned.

#### Codex CLI (ChatGPT)

OpenAI’s Codex operates via codex exec or codex -p for non-interactive scripting. The controller passes prompts directly to the CLI and parses the standard output. Codex configurations rely on ambient CODEX_API_KEY environment variables. To maintain strict isolation, the controller injects the appropriate key exclusively into the spawned subprocess environment. This ensures that repository code executing alongside the agent cannot access the global credential store, a practice heavily recommended to prevent the accidental exposure of ChatGPT authentication tokens in public repositories.

#### Cursor CLI

Cursor's CLI brings its highly capable models, notably composer-2.5-fast, directly into the terminal environment for scriptable execution. Headless execution requires passing the prompt along with explicit workspace trust flags, specifically --trust --approve-mcps --force. Without these flags, the Cursor CLI will exit with a non-zero code and a "Workspace Trust Required" error when operating in headless mode. The controller manages these flags dynamically based on the project path being analyzed, ensuring that only vetted directories receive trust escalation.

#### Kimi Code (Moonshot AI)

Moonshot AI’s Kimi Code, built for long-horizon software engineering with a 256K context window via the Kimi K2.7 Code model, operates similarly to Claude Code. The controller invokes it non-interactively using the kimi run command. Kimi Code dynamically interprets project constraints by reading .kimi-code/config.toml and localized AGENTS.md files rather than CLAUDE.md. The controller directs Kimi’s behavior by injecting these Markdown files dynamically into the target workspace prior to execution, and manages its autonomy via configuration flags equivalent to YOLO modes.

#### OpenCode Go

OpenCode offers opencode run "prompt" for one-shot scripted execution. Furthermore, the controller can leverage OpenCode’s robust server capabilities by executing opencode serve to instantiate a headless HTTP backend. Rather than spinning up a new binary for every turn, the controller can route tasks to this persistent background process, utilizing opencode attach or interacting via JSON-RPC to maintain a continuous, low-latency session. Unattended permission management is handled via the --auto flag, which auto-approves actions not explicitly denied by the controller's rule set.

### Headless Execution Adapter Matrix

The controller synthesizes the specific requirements of each provider into an operational matrix, ensuring that regardless of which CLI is selected by the routing engine, the execution parameters guarantee non-interactive, parseable, and autonomous behavior.

| Target Provider | Headless Invocation | Autonomy / Guardrail Flags | Structured Output Mechanism | Stated Context Window |
|---|---|---|---|---|
| Claude Code | claude -p | --allowedTools "*" --bare | --output-format stream-json | 1,000,000 Tokens |
| Grok Build | grok -p | acceptEdits mode configuration | --output-format json | 500,000 Tokens |
| Antigravity | agy -p | --dangerously-skip-permissions | --output-format stream-json | 1,000,000+ Tokens |
| Codex CLI | codex exec | --yolo | Custom JSON stdout wrapper | 128,000 Tokens |
| Cursor CLI | agent --prompt | --trust --approve-mcps | Parsed text/JSON streams | Model-dependent |
| Kimi Code | kimi run | --yolo equivalent | JSONL streaming support | 256,000 Tokens |
| OpenCode | opencode run | --auto | JSON/Stream | Pluggable models |

## Universal Meta-Session Management and Context Continuity

A primary constraint of utilizing disparate, proprietary CLIs is the profound fragmentation of session context. If a user or the primary orchestrating agent begins a task utilizing Claude Code for initial architectural scaffolding, and the task's mathematical complexity subsequently necessitates Codex for deep algorithmic generation, the native CLIs possess no inherent mechanism to share state. An entirely new session would typically start with zero historical context.

To resolve this limitation without violating ToS or attempting to reverse-engineer proprietary cloud syncing protocols, the controller implements a persistent Meta-Session State Machine.

### Abstracting the Session ID

Instead of exposing the underlying CLI's native UUID or session string to the primary orchestrator, the controller generates a cryptographic Meta-Session ID. This ID serves as a pointer in a high-performance local embedded database (such as SQLite or RocksDB) that maps to the physical, local session states of the respective CLIs.

When a prompt is dispatched by the orchestrator under a specific Meta-Session ID:

- The controller inspects the internal ledger and maps the Meta-Session ID to the currently active provider (e.g., claude).
- It retrieves the native session_id required by that provider. For Claude Code, this involves parsing the output for a UUID-shaped string; for Antigravity, it requires threading a conversation ID.
- It appends the corresponding resumption flag—such as `--resume <session_id>` or -c—to the headless invocation, ensuring the provider natively reloads its own transcript and maintains its internal memory.

### Lossy Context Compaction and State Handoff

The core innovation of the meta-session architecture is State Handoff. When the controller's routing algorithm determines that a session must transition from Provider A (e.g., Claude Code) to Provider B (e.g., Codex), the raw session ID cannot simply be ported across binaries.

The controller achieves seamless continuity through a highly structured technique known as Lossy Context Compaction. This process translates the proprietary memory structures of one CLI into the generic input context of another:

- **Transcript Extraction:** The controller locates the physical transcript file of the outgoing CLI. For Claude Code, this involves locating the .jsonl files stored under ~/.claude/projects/ or the central history.jsonl, reading them securely by tracking byte offsets to capture only the newest turns. For Grok Build, it involves extracting the session state from ~/.grok/sessions/.
- **Trajectory Summarization:** The controller initiates a rapid, low-latency summarization pass using a lightweight internal model or a fast-tier provider (such as Gemini Flash). This pass condenses the Agent Trajectory—the exact sequence of tool calls, reasoning steps, stdout logs, and file modifications undertaken by the previous agent—into a dense semantic summary.
- **Structured Fact Merging:** Simple prose summarization degrades rapidly. To prevent the permanent destruction of vital code constraints, the compaction algorithm merges newly discovered facts into a structured JSON representation of the project state. This preserves the full decision history while keeping the summary token-efficient.
- **State Injection:** The newly generated JSON summary, alongside the exact paths of the files currently under modification, is injected into Provider B as a synthetic "first turn". The controller achieves this by appending the summary to the system prompt via flags like --append-system-prompt (Claude), custom rules flags (Grok), or injecting temporary .md context files into the workspace (Kimi).

This lossy compression permanently destroys the exact conversational syntax and verbatim logs of the previous turns, which were specific to the prior CLI's tooling. However, it preserves the critical semantic state, allowing the newly invoked Codex or Cursor agent to seamlessly continue the architectural work initiated by Claude without encountering context starvation or repeating previous mistakes.

## Intelligent Predictive Routing and Task Taxonomy

The controller does not rely on static, hardcoded rules for selecting which CLI to invoke. Instead, it utilizes Predictive LLM Routing based on Item Response Theory and multi-level task profile guidance. By treating the selection of an agentic subscriber as a sequential decision process, the controller optimizes for cost, execution latency, and specific reasoning capabilities on a per-turn basis.

### Dynamic Task Complexity Classification

When the primary orchestrator sends a task to the controller, the controller's routing engine intercepts the prompt and evaluates it against a predefined taxonomy of tasks. A lightweight, high-speed classifier scores the incoming prompt across three primary dimensions:

- **Context Volume Requirements:** Does the task require reading an entire monolithic repository to understand disparate dependencies, or is it isolated to a localized refactoring of a single file?
- **Tool Complexity and Autonomy:** Will the task require extensive shell execution, iterative compilation testing, and parallel Git worktrees to evaluate solutions?
- **Reasoning Depth:** Is the prompt asking for a trivial regex substitution, or does it demand the implementation of a novel cryptographic algorithm requiring deep logical chains?

Based on these dimensions, the controller assigns a normalized complexity score and intelligently routes the task to the most appropriate CLI subscription:

- **Low Complexity (Routine refactoring, log analysis, documentation):** Routed to Kimi Code or Gemini Antigravity (specifically the Gemini Flash model tiers). These models are optimized for high-speed, repetitive tasks, preserving the expensive subscription quotas of heavier models.
- **Medium Complexity (Standard feature implementation, API integration):** Routed to Cursor CLI (Composer 2.5) or OpenCode. These tools are tuned for rapid, interactive-style code generation and excel at executing well-defined structural changes across a few files.
- **High Complexity (Architecture design, massive codebase migrations, deep debugging):** Routed to Claude Code (Opus/Sonnet) or Grok Build (Grok 4.7). These models leverage massive context windows (up to 1M tokens for Claude) and sophisticated parallel subagent architectures (Grok Build’s isolated worktrees) to manage highly complex state over extended horizons.

### Tier-Aware Subscription Capacity Normalization

Implementing load balancing across arbitrary API keys is a well-understood paradigm. However, executing load balancing across consumer and professional CLI subscriptions requires a fundamentally novel approach. The usage limits for these subscriptions are highly asymmetric, opaque, and constantly shifting based on network load. As explicitly recognized in the controller's core requirements, a "20% available usage" metric on a Claude Pro Max 20x tier represents vastly more raw compute potential than a 20% limit on a ChatGPT Plus tier.

To manage this complex reality, the controller implements a Capacity Normalization Ledger. Because the controller operates without logging into web interfaces or scraping OAuth dashboards, it monitors usage purely through the feedback provided directly by the CLIs in their stdout and stderr streams.

For instance, Claude Code emits a total_cost_usd estimate in its JSON output, and agy provides metadata counters for cumulative session limits and turns. The controller's ledger translates these disparate, provider-specific metrics into a unified internal currency called Normalized Compute Units (NCU).

- **Baseline Mapping:** The controller maps the known maximum limits of a specific subscription tier (e.g., Anthropic's stated usage caps for Max 20x, or xAI's limits for SuperGrok Heavy) to a baseline NCU capacity pool.
- **Consumption Tracking:** After every headless run, the controller aggressively parses the token usage, duration, and cost output from the returned JSON response.
- **Ledger Deduction:** This parsed usage is algorithmically weighted and subtracted from the corresponding subscription's NCU bucket.

When a high-complexity task arrives, the predictive router checks the current NCU levels across all providers. If the ledger indicates that the Claude Max 20x tier is nearing its dynamic throttle threshold (e.g., dropping below 15% available NCU), the controller preemptively and seamlessly routes the task to Grok Build (SuperGrok Heavy tier). This tier-aware load balancing prevents catastrophic 429 Too Many Requests errors mid-generation and ensures maximum utilization of all paid subscriptions without manual intervention.

## Traffic Shaping, API Rate Limiting, and Resilience

Because the controller acts as an autonomous bridge between an aggressive upstream orchestrator (like OpenClaw) and downstream CLI wrappers that are heavily constrained by provider-level rate limits, it must implement rigorous traffic shaping to protect both the local host system and the remote APIs.

### Token Bucket vs. Leaky Bucket Enforcement

The controller employs a sophisticated, dual-algorithm approach to traffic management, recognizing that inbound request shaping requires a different mathematical model than outbound provider compliance.

**Inbound Traffic Shaping (Leaky Bucket Algorithm):**

To protect the local compute environment from CPU starvation, memory exhaustion, and disk I/O bottlenecks caused by spawning dozens of concurrent Node.js, Python, or Go binaries, the controller applies a Leaky Bucket algorithm to incoming requests from the orchestrator. In this model, incoming requests enter a strict queue (the bucket) and are dispatched (leaked) to the execution engine at a constant, predictable rate. This algorithm effectively smooths out sudden bursts of traffic—such as an orchestrator attempting to launch 50 parallel code reviews across a monorepo simultaneously—ensuring that the local host machine maintains stability and steady throughput.

**Outbound Provider Compliance (Token Bucket Algorithm):**

To manage the logical constraints imposed by the external LLM providers, the controller uses a Token Bucket algorithm. Providers meter their usage stringently in tokens per minute (TPM) and requests per minute (RPM). The token bucket is the mathematically optimal choice for outbound compliance because it allows for controlled, short-term bursts of traffic (up to the bucket's maximum capacity) while strictly enforcing a long-term average refill rate that perfectly matches the provider's stated API limits.

Crucially, rather than merely tracking the number of requests, the controller's token bucket tracks estimated tokens. If a task is estimated to require a massive 50,000 output tokens, the bucket must possess sufficient token capacity before the CLI subprocess is even permitted to spawn, preventing wasted compute on aborted runs.

### Exponential Backoff and Jitter

Despite rigorous local rate limiting and NCU tracking, provider APIs may still enforce unpredictable dynamic throttling based on global network load, returning 429 Too Many Requests HTTP errors. If a CLI encounters this error during a headless run, it will typically exit with a hard failure code.

To mask these transient failures from the primary orchestrator, the controller intercepts the specific failure codes and applies a robust mechanism of Exponential Backoff with Jitter.

- **Exponential Backoff:** Upon encountering a rate limit failure, the controller waits a short, initial duration, and then retries the CLI invocation. If the command fails a second time, the wait time increases exponentially (e.g., 2 seconds, 4 seconds, 8 seconds, 16 seconds). This progressive delay allows the provider's rate windows sufficient time to reset without hammering their servers.
- **Jitter (Randomized Variance):** Merely applying backoff is insufficient in highly parallel systems. The controller applies a mathematically randomized variance (jitter) to the wait time. If the orchestrator triggers multiple parallel subagents that happen to hit a rate limit simultaneously, jitter ensures that they do not all attempt to retry at the exact same millisecond. Doing so would cause a "thundering herd" effect, immediately triggering a secondary 429 ban.

By handling these intricacies internally, the controller transforms fatal provider limits into simple, manageable latency, maintaining the illusion of infinite, continuous availability for the upstream orchestrator.

## Orchestrator Exposure via Model Context Protocol (MCP) and Agent Context Protocol (ACP)

To function as a modular, universally compatible subsystem rather than an isolated, monolithic application, the controller exposes its entire operational surface via the Model Context Protocol (MCP) and the Agent Context Protocol (ACP). This critical design choice allows any standard primary coding orchestrator, such as OpenClaw or an instance of Grok Bot, to connect to the controller over standard stdio or JSON-RPC as if it were a simple tool server.

### The Process Boundary Advantage and Context Starvation

A critical architectural decision in modern agentic system design is determining whether capabilities should be exposed as direct function calls within the agent's memory (Step 1 or Step 2 integrations) or isolated in external servers across a strict process boundary (Step 3 MCP integrations).

By encapsulating the seven complex subscription CLIs behind an MCP server boundary, the controller guarantees strict process isolation. This isolation is the primary defense against Context Starvation. If the primary orchestrator were forced to load the individual tool schemas, command line arguments, configuration matrixes, and parsing logic for all seven CLIs directly into its own system prompt, it would consume an enormous percentage of its context window before any actual logical reasoning even began.

By utilizing MCP, the orchestrator is presented only with a streamlined set of high-level tools. The MCP server (the controller) handles all the complex data mapping, CLI spawning, and output parsing internally. It then returns highly summarized, structured success/failure envelopes back to the orchestrator, freeing up to 96% of the orchestrator's valuable context window for actual architectural problem-solving.

### Tool Injection and Dynamic Orchestrator Capabilities

When a primary orchestrator like OpenClaw establishes a connection to the controller, the controller dynamically injects a powerful suite of specialized tools directly into the orchestrator's harness. These injected tools bridge the gap between high-level intent and low-level CLI execution:

| Tool Name | Injected Capability / Function |
|---|---|
| delegate_coding_task | The primary execution vector. The orchestrator passes a prompt, directory path, and an optional requested capability tier. The controller handles routing, spawns the CLI, executes the task, and returns a unified diff or semantic summary. |
| view_subscription_usage | Allows the orchestrator to query the controller's Capacity Normalization Ledger. This returns the current Normalized Compute Unit (NCU) levels across Claude, Grok, Codex, etc. |
| expose_routing_tier | Exposes the controller's internal taxonomy and scoring matrix to the orchestrator, allowing the orchestrator to understand why certain models are selected for specific tasks. |
| force_route_to_tier | Permits the orchestrator to bypass automatic routing. If a task strictly requires the 1M token context of Claude Opus, the orchestrator can force execution on that specific provider regardless of the controller's default score. |
| start_parallel_subagents | Leverages capabilities inherent in specific CLIs, such as Grok Build's Git worktree isolation, allowing the orchestrator to dispatch parallel research or refactoring tasks, and return an aggregated result. |

### Example Orchestration Scenario

Consider a scenario where the primary orchestrator is an OpenClaw instance, currently running Anthropic's Claude 3.5 Sonnet as its reasoning engine. The user asks the orchestrator to conduct a massive, multi-repository migration from React to Next.js.

The Sonnet agent evaluates the request. It first invokes the view_subscription_usage tool injected by the controller. The controller returns the telemetry chart, indicating that the Claude Max 20x subscription is currently sitting at 18% available NCU capacity, while the Cursor Pro subscription has abundant capacity.

Based on this real-time usage data and the complexity of the task, the Sonnet agent formulates a plan. Instead of consuming the remaining Claude Max 20x compute, the Sonnet orchestrator invokes the delegate_coding_task tool, explicitly passing parameters to start a specialized subagent on Cursor composer-2.5-fast to handle the repetitive component rewriting, while reserving the remaining Claude quota for the highly complex routing logic overhaul. The controller receives this instruction via MCP, spawns the Cursor CLI with the necessary --trust flags, monitors the execution, and returns the successfully refactored files back to the OpenClaw orchestrator.

### OpenClaw Integration Architecture

In a robust production deployment, the controller is designed to sit directly beneath a Tier 1 orchestrator like OpenClaw. OpenClaw utilizes a sophisticated "Lane Queue" architecture, serializing execution on a per-session basis to prevent race conditions and context leakage when manipulating shared conversational state.

The controller perfectly complements this architectural pattern. OpenClaw handles the messy realities of user intake across multiple channels (e.g., Slack, WhatsApp, GitHub PR comments), normalizes the messages, and places them into a structured session lane. When the OpenClaw agent decides it needs to execute code or delegate a sub-task, it calls the controller via the standardized MCP interface.

The controller, operating entirely outside OpenClaw's primary process, manages the raw, potentially unstable execution of claude -p or grok -p, applies the necessary rate-limiting backoffs, and returns a clean result. This strict process isolation ensures that a catastrophic failure deep within a specific CLI—such as an unhandled exception or memory leak in Kimi Code—returns a structured error envelope over the SSE/stdio stream. It fails closed, dropping the specific task, but completely preventing the parent OpenClaw gateway from crashing.

## Security, Sandboxing, and Telemetry Infrastructure

The fundamental nature of delegating autonomous, unprompted code execution to third-party CLIs introduces massive security vectors into the host environment. The controller serves as the ultimate perimeter defense, enforcing strict governance and observability over tools that otherwise default to dangerously high levels of autonomy.

### Permission Normalization and Fail-Closed Guardrails

Each of the seven managed CLIs possesses radically different, and often incompatible, permission paradigms. The controller resolves this by normalizing these paradigms into a unified, fail-closed security matrix before any subprocess is spawned:

- **Claude Code:** Supports sophisticated --permission-mode and --allowedTools flags. The controller forces --permission-mode dontAsk in any untrusted repository environment. This guarantees that the CLI will refuse to execute any shell command outside a strict allow-list, failing gracefully rather than hanging indefinitely while waiting for a human prompt.
- **Grok Build:** Utilizes an acceptEdits mode to auto-approve file writes, but theoretically halts on shell commands. Because this mode is configured via settings files rather than flags, the controller must dynamically manipulate the ~/.grok/config.toml file to enforce this mode. This ensures that malicious code ingested by the agent cannot silently execute arbitrary shell scripts.
- **Gemini (agy) & Codex:** These CLIs rely heavily on blunt instruments like --dangerously-skip-permissions and --yolo respectively, to achieve automation. Because these flags grant the agent near-total system access, the controller absolutely must wrap these specific executions in OS-level sandboxes—such as containerized Docker environments, macOS Seatbelt profiles, or Linux Landlock policies—prior to invoking the CLI. This prevents any potential lateral movement if the agent is manipulated by a prompt injection attack hidden in the codebase.

### Telemetry Injection via CLI Hooks

To achieve complete observability and monitor usage without having a web interface, and without modifying the provider's proprietary binaries, the controller exploits the undocumented "Hook" systems built into several of the CLIs.

For instance, Claude Code supports lifecycle hooks such as PreToolUse and Stop. The controller dynamically registers a global hook by injecting a command into ~/.claude/settings.json immediately prior to execution.

- **PreToolUse Blocking Gate:** The controller can inspect the JSON payload of every intended bash command before the CLI executes it. If the command attempts to delete critical system directories (e.g., rm -rf /), the controller's injected hook script intercepts the payload, evaluates it against a hardcoded denylist, and exits with a non-zero status. This definitively blocks the execution at runtime before the CLI can proceed, providing a programmatic safety net that supersedes the LLM's own judgment.
- **Stop Hook Telemetry:** After every response generated by the CLI, the controller uses the Stop hook to read the session_id and parse the new bytes appended to the .jsonl transcript. This data is converted on-the-fly into OpenTelemetry-compatible traces and shipped to a central logging system (such as OpenObserve). This architecture provides the primary orchestrator with real-time, granular visibility into token usage, latency, and tool-call frequency across all seven subscriptions, satisfying the requirement for usage monitoring without ever requiring OAuth or web logins.

## Architectural Synthesis

The construction of a meta-controller for disparate AI coding subscriptions requires a fundamental shift in engineering paradigms, moving away from simple API integrations toward complex, headless CLI orchestration. By leveraging the specific headless execution modes of Claude Code, Grok Build, Codex, Gemini Antigravity, Cursor CLI, OpenCode Go, and Kimi Code, the controller successfully maintains absolute compliance with provider Terms of Service while simultaneously extracting the full, unbridled power of their proprietary agentic loops and specialized models.

Through the implementation of sophisticated cross-provider meta-session management utilizing lossy context compaction, the architecture effectively eliminates the contextual silos that typically separate different AI models. Furthermore, the integration of Item Response Theory-based predictive routing, combined with tier-aware NCU capacity tracking, ensures that complex software engineering tasks are mathematically matched with the most appropriate reasoning engines. This maximizes execution speed, minimizes compute costs, and completely avoids catastrophic rate limits.

Ultimately, by exposing this entire, complex architecture as a standardized MCP/ACP server, the controller acts as a highly resilient, entirely transparent infrastructure layer. It absorbs the extreme complexity of permission normalization, backoff algorithms, transcript parsing, and token bucket rate limiting. This profound decoupling allows primary orchestrators like OpenClaw to focus entirely on higher-order multi-agent logic and human-AI collaboration, establishing a robust standard for production-grade autonomous engineering pipelines.
