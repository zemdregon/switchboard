# Per-adapter live-input / steer documentation spike (T14.7), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Findings are **Proposed**
  until implementation tasks cite them with tests or live verification.
- Used by: [ROADMAP](../ROADMAP.md) T14.7, FR-CTL-04, FR-SES-03, FRD BR-7, [LLD §2](../design/LLD.md#2-adapter-contract),
  [LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05).
- Scope: For each M4 adapter on `main` (Grok Build, Antigravity, Cursor, OpenCode, Claude Code, Codex), record whether
  **documented** automation supports mid-run user input, resume-with-note, or equivalent steering at a boundary. No
  provider CLI was invoked for this spike; evidence is primary vendor or ACP documentation and existing repository
  research notes only.
- Related: [control-plane discovery](orchestration-layer-discovery-2026-10-15.md) (steer motivation),
  [ACP vs headless memo](acp-vs-headless-evaluation-2026-10-15.md) (transport and steering comparison). Does not
  supersede [ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md), [ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md),
  or [ADR-0036](../adr/0036-per-run-acp-stdio-client.md).

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15 (live-check notes, TDD, prior memos).
- **Verified (primary):** vendor or ACP project documentation cited by URL; not re-fetched in this spike unless noted.
- **Secondary:** forum threads or third-party summaries cited in repo research.
- **Unverified:** no primary doc or live check in repo; called out explicitly.
- **Inferred:** author judgement from the sources above.

## Requirement and contract mapping

| ID | What steering must satisfy | How this spike uses it |
| --- | --- | --- |
| [FR-CTL-04](../requirements/SRS.md) | `steer_run(run_id, note)` delivers the note at the next boundary as **live input** when the adapter declares it; otherwise stop at a boundary and continue the **same native session** with the note | Per-adapter table below proposes `liveInput` and the native mechanism |
| [FR-SES-03](../requirements/SRS.md) | Same-provider continuation uses native resume with the stored native session id | All six adapters document resume on the headless surfaces Switchboard already compiles; live-check notes confirm ids round-trip for M4 providers |
| [FRD BR-7](../requirements/FRD.md) | Automatic retry only for specific failure codes on an unchanged worktree; otherwise roll back or **native resume, never replay** | Steering is a **continuation** (new user text in the same binding), not a retry of the original `request_hash` and not a successor run under BR-7 |
| [LLD §2](../design/LLD.md#2-adapter-contract) | `resumeArgs(binding, …)` continues a session; cancel is optional | Boundary-resume steering compiles a **new** invocation via `resumeArgs` with the steer note folded into `objective` or constraints (exact shaping is T14.7 implementation, Proposed) |
| [LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05) | Ledger records `steer_requested`; `liveInput: true` in §2 selects live delivery | **Gap (Verified repo):** §3.4.4 references `liveInput` in §2, but the §2 TypeScript block does not yet declare it; add the field when implementing T14.7 |

**Boundary (Proposed)** — [ACP vs headless memo](acp-vs-headless-evaluation-2026-10-15.md) §7.

- End of a tool call or turn (`tool_call`, `step_finish`, `result` on JSONL, or ACP idle).
- Supervisor stops without replaying the prior prompt.
- **Live input:** the same OS process or ACP session accepts new user text with the same native session id.

## Switchboard today vs M14 target

| Topic | As built on `main` (Verified repo) | M14 `steer_run` target |
| --- | --- | --- |
| Intervention | `cancel_run` only; provider elicitation refused (`-32601`) per discovery note | `steer_run` plus pause (T14.6) |
| Transport | Ephemeral headless subprocess per run (`subprocess-jsonl`) for all six adapters | Unchanged default per [ACP vs headless memo](acp-vs-headless-evaluation-2026-10-15.md) §2 |
| Resume | `resumeArgs` compiled for each adapter (M2/M4 tests on synthetics) | Reused for **boundary-resume** steering |
| Live input | Not implemented | Claude: documented stream-json queueing (pending S1 live verify); Codex: optional later via `codex-acp` / app-server (S2); others: boundary-resume |

## Summary table (Proposed `liveInput` for Switchboard)

| Adapter `ProviderId` | Config id | Documented mid-run / live input on **current** headless transport | Documented resume-with-new-user-text (same session) | Proposed Switchboard `liveInput` | Proposed M14 steering mode |
| --- | --- | --- | --- | --- | --- |
| `claude` | `claude-code` | **Yes** stream-json queue (`priority`, `interrupt`); not on today's `-p` | `--resume` (TDD §4.1) | `true` after S1 transport; else `false` | Live or boundary-resume |
| `codex` | `codex` | **No** on `codex exec --json` | `codex exec resume <SESSION_ID>` (Verified repo: TDD §4.2) | `false` on default transport | Boundary-resume; optional future `true` via `codex-acp` / `turn/steer` (S2) |
| `grok` | `grok-build` | **No** on `grok -p` one-shot; multi-turn `--input-format stream-json` is documented in places but **not** Switchboard's transport (FR-EXE-04) | `-r <sessionId>` (Verified repo: [live-checks-2026-10-14-grok.md](live-checks-2026-10-14-grok.md)) | `false` | Boundary-resume |
| `antigravity` | `antigravity` | **No** on `agy -p` one-shot; `--input-format stream-json` exists in CLI help for multi-turn but deferred (TDD §4.4) | `--conversation <id>` (Verified repo: [live-checks-2026-10-14-antigravity.md](live-checks-2026-10-14-antigravity.md) C9) | `false` | Boundary-resume |
| `cursor` | `cursor` | **No** on `agent -p` one-shot | `--resume <chatId>` (Verified repo: [live-checks-2026-10-14-cursor.md](live-checks-2026-10-14-cursor.md) 8a–8c) | `false` | Boundary-resume |
| `opencode` | `opencode` | **No** on `opencode run --format json`; serve HTTP API documents `prompt_async` (persistent service — FR-EXE-04 deferred) | `--session <id>` (Verified repo: [live-checks-2026-10-14-opencode.md](live-checks-2026-10-14-opencode.md)) | `false` | Boundary-resume |

ACP `_session/steering` is **not** in the ACP spec ([memo](acp-vs-headless-evaluation-2026-10-15.md) §4).

Out of scope for the headless-first matrix unless a future ADR moves transport.

## Per-adapter detail

### Claude Code (`claude`)

**Switchboard transport:** `claude -p --output-format stream-json` (ephemeral), TDD §4.1.

| Mechanism | Documented? | Source | Notes |
| --- | --- | --- | --- |
| Mid-run user messages while the process stays up | **Yes** | Verified (primary): [Agent SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input), [streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode); summarized in [ACP vs headless memo](acp-vs-headless-evaluation-2026-10-15.md) §5.1 | Requires `--input-format stream-json` with a long-lived process, not the single-prompt `-p` exit used today |
| `interrupt` control | **Yes** | Same sources; memo §5.1 | Receipt-based cancel of in-flight work; distinct from `steer_run` note delivery but relevant at boundaries |
| Resume same session with new prompt | **Yes** | Verified (repo): TDD §4.1 `--resume`, `--session-id` | [live-checks-2026-10-14-claude-codex.md](live-checks-2026-10-14-claude-codex.md) covers Codex heavily; Claude resume argv is in TDD |
| ACP `_session/steering` | **Extension only** | Verified (repo): memo §5.1, §6 probe | Switchboard does not plan the Claude ACP adapter for M14 |

**Gaps:** CLI stream-json `priority: next` at a tool boundary — **Unverified** (spike S1).

**FR-CTL-04 / BR-7:** boundary-resume uses `resumeArgs` with the note; not a blind replay of the original objective
([ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md)).

### Codex (`codex`)

**Switchboard transport:** `codex exec --json` (ephemeral), TDD §4.2.

| Mechanism | Documented? | Source | Notes |
| --- | --- | --- | --- |
| Mid-run steer on `codex exec` | **No** | Verified (repo): [ACP vs headless memo](acp-vs-headless-evaluation-2026-10-15.md) §5.2 | One-shot exec completes the turn and exits |
| `turn/steer` on `codex app-server` | **Yes** | Verified (primary): OpenAI Codex app-server docs (cited memo §5.2, §11) | Experimental; needs `expectedTurnId` |
| `codex exec resume` | **Yes** | Verified (repo): TDD §4.2 | Primary boundary-resume path for M14 |
| ACP `codex-acp` steering extension | **Advertised** | Verified (repo): memo §5.2, §6 probe | Auth-gated; spike S2 before adoption |

**Gaps:** Sandbox and MCP behaviour on `codex-acp` vs exec — **Unverified** (S2).

### Grok Build (`grok`)

**Switchboard transport:** `grok -p --output-format streaming-json` (ephemeral), TDD §4.3.

| Mechanism | Documented? | Source | Notes |
| --- | --- | --- | --- |
| Mid-run input on `-p` | **No** | Verified (repo): memo §5.3; [live-checks-2026-10-14-grok.md](live-checks-2026-10-14-grok.md) | Each `-p` invocation is one headless run |
| `grok agent stdio` (ACP) | Partial | Verified (primary): xAI headless docs (memo §5.3, §11) | No profile flags on ACP help; not default transport |
| Resume `-r <id>` | **Yes** | Verified (repo): live-check 14a–14b | `resumeCwd: 'independent'` per live check |
| Multi-turn `--input-format stream-json` | **Unverified for Switchboard** | Verified (repo): TDD §4.3 defers persistent transport | Would be prerequisite for live steering without ACP |

### Antigravity (`antigravity`)

**Switchboard transport:** `agy -p --output-format stream-json` (ephemeral), TDD §4.4.

| Mechanism | Documented? | Source | Notes |
| --- | --- | --- | --- |
| Mid-run on `-p` | **No** | Verified (repo): TDD §4.4 transport decision | One process per print invocation |
| `--input-format stream-json` multi-turn | Documented in CLI | Verified (repo): TDD §4.4, live-check C2 | Not used; FR-EXE-04 defers |
| Resume `--conversation <id>` | **Yes** | Verified (repo): [live-checks-2026-10-14-antigravity.md](live-checks-2026-10-14-antigravity.md) C9 | Unknown id can silently start a new conversation (hazard for steer if id wrong) |
| Native `agy acp` | **No** | Verified (repo): live-check C2 | Separate Google ACP binary; auth gap (C16) |

### Cursor (`cursor`)

**Switchboard transport:** `agent -p --output-format stream-json` (ephemeral), TDD §4.5.

| Mechanism | Documented? | Source | Notes |
| --- | --- | --- | --- |
| Mid-run on print mode | **No** | Verified (repo): memo §5.4 | Process exits after result |
| `--resume <chatId>` with new prompt | **Yes** | Verified (repo): [live-checks-2026-10-14-cursor.md](live-checks-2026-10-14-cursor.md) 8a–8c | Same `session_id` across resumes |
| ACP `cursor/ask_question` | Blocks for user answer | Verified (primary): Cursor ACP docs (memo §5.4) | Elicitation, not orchestrator `steer_run` |
| ACP `session/load` / MCP on ACP | **Unverified / reported broken** | Secondary: memo §5.4 forum refs | Headless remains default |

### OpenCode (`opencode`)

**Switchboard transport:** `opencode run --format json` (ephemeral), TDD §4.6.

| Mechanism | Documented? | Source | Notes |
| --- | --- | --- | --- |
| Mid-run on `opencode run` | **No** | Verified (repo): memo §5.5 | Talks to background serve but run is one shot |
| `opencode serve` `prompt_async` | **Yes** (HTTP API) | Verified (primary): opencode.ai server docs (memo §5.5) | FR-EXE-04 defers `local-service` transport |
| Resume `--session <id>` | **Yes** | Verified (repo): [live-checks-2026-10-14-opencode.md](live-checks-2026-10-14-opencode.md) | Permission set on resume: NOT_RUN in live check |
| `opencode acp` steering | **No** | Verified (repo): memo §5.5 probe | Resume/list only |

## Proposed adapter contract addition (LLD §2)

**Proposed (Delegated, not in §2 TypeScript yet):**

```ts
/** FR-CTL-04: true only when documented in-turn input exists on the adapter's chosen transport. */
readonly liveInput: boolean;
/** Optional: steer note delivery hook; default boundary-resume via resumeArgs. */
steerAtBoundary?(handle: TransportHandle, note: string): Promise<'delivered' | 'stop_for_resume'>;
```

Fake adapter (T14.7 implementation): must support boundary-resume with ledger `steer_requested` and same synthetic
native session id; optional fake live-input path for tests when `liveInput: true`.

## Follow-on verification (not done in this spike)

| Spike | Provider | Question | Live? |
| --- | --- | --- | --- |
| S1 | Claude Code | Stream-json `priority: next` at tool boundary | One operator run via `~/operator-runs/live-run.sh` when budget allows |
| S2 | Codex | `codex-acp` steering and sandbox | Same |
| S4 | Grok | ACP sandbox and `mcpServers` | Same |
| S5 | OpenCode | ACP `request_permission` | Same |

Per AGENTS.md, no direct provider CLI invocation from this worker; live steps are operator-only.

## Proposed ADR

None required for documentation-only findings.

Transport choices remain in [ACP vs headless memo](acp-vs-headless-evaluation-2026-10-15.md) §8 (Proposed, not accepted).

A future ADR may fix Claude long-lived stream-json and optional Codex ACP steering if S1/S2 pass.

## Primary source index (cited via repo memos or TDD)

- Claude Code headless and SDK: <https://code.claude.com/docs/en/headless>, <https://code.claude.com/docs/en/agent-sdk/user-input>
- Codex: <https://developers.openai.com/codex/noninteractive>, app-server and CLI reference (memo §11)
- Grok: <https://docs.x.ai/docs/build/cli/headless-scripting> (memo §11)
- Cursor CLI: <https://cursor.com/docs/cli/overview>, ACP: <https://cursor.com/docs/cli/acp>
- OpenCode: <https://opencode.ai/docs/server> (memo §11)
- Antigravity: <https://antigravity.google/docs/cli/reference/> (TDD §4.4, live-check)
- ACP v1/v2: <https://agentclientprotocol.com/protocol/v1/overview>, v2 prompt RFD (memo §4)
