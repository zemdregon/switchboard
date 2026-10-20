/**
 * Switchboard-side check of each provider tool call (Q-62 to Q-65, ADR-0039), independent of whether the provider's own
 * deny rules, sandbox or environment settings were honoured. Adapters attach the command line (shell tools) or the path
 * (file tools) of a `tool_call` as the transient `command` / `target`; `startAdapterRun` evaluates it with
 * {@link guardToolCall}, records the verdict as `violation` and drops `command` before the event is stored, so command
 * text is still never persisted (NFR-PRIV-02).
 *
 * - `git_write` (FR-GIT-01): the parsed command can create commits, move refs or push. Always enforced, bypass runs
 *   included (the owner keeps Git-write denial in bypass, ADR-0017); classified `PERMISSION_BLOCKED`. One exception
 *   (operator request, 2026-10-20): a privileged run (`runCommits` set) may `git add` and `git commit` in its own
 *   worktree ({@link RunCommitScope}); the FR-GIT-03 ref check then accepts those commits on the run branch.
 * - `provider_state` (FR-AUTH-01): the call names a path under a provider config or credential directory. Enforced for
 *   every run except an approved bypass run (owner decision 25 restricts nothing about bypass); classified
 *   `SANDBOX_VIOLATION`.
 *
 * Only `write` verdicts of {@link gitWriteInCommand} count; `uncertain` ones are left to the FR-GIT-03 ref snapshot.
 */
import { commandReachesProviderState, pathReachesProviderState } from "../policy/provider-state.js";
import { gitWriteInCommand, type RunCommitScope } from "./git-write.js";
import type { NormalizedEvent } from "./types.js";

export interface ToolViolation {
  readonly kind: "git_write" | "provider_state";
  readonly reason: string;
}

export interface ToolGuardContext {
  readonly cwd: string;
  readonly home?: string;
  /** True only for a run whose bypass the controller verified (`bypassPermitted`). */
  readonly bypass: boolean;
  /**
   * Set only for a privileged run: its worktree and the shell directory followed across this run's tool calls, so
   * `git add` / `git commit` there are not Git writes. Mutable: each shell call's `cd` updates `cwd`.
   */
  readonly runCommits?: RunCommitScope;
}

/**
 * Check one `tool_call` event. Returns the event as it is to be stored: `command` removed, `violation` set when a
 * check fired.
 */
export function guardEvent(ev: NormalizedEvent, ctx: ToolGuardContext): NormalizedEvent {
  if (ev.kind !== "tool_call") return ev;
  const { command: _command, ...rest } = ev;
  const violation = guardToolCall(ev, ctx);
  return violation === undefined ? rest : { ...rest, violation };
}

export function guardToolCall(
  call: { tool: "read" | "edit" | "shell" | "other"; command?: string | undefined; target?: string | undefined },
  ctx: ToolGuardContext,
): ToolViolation | undefined {
  // A shell tool's command line is `command` (transient) or, for adapters that keep it, the clipped `target`.
  const command = call.tool === "shell" ? (call.command ?? call.target) : undefined;
  if (command !== undefined) {
    const git = gitWriteInCommand(command, ctx.runCommits);
    if (git?.level === "write") return { kind: "git_write", reason: git.reason };
  }
  if (ctx.bypass) return undefined;
  const opts = { cwd: ctx.cwd, ...(ctx.home !== undefined ? { home: ctx.home } : {}) };
  const hit =
    command !== undefined
      ? commandReachesProviderState(command, opts)
      : call.target !== undefined
        ? pathReachesProviderState(call.target, opts)
        : undefined;
  return hit === undefined ? undefined : { kind: "provider_state", reason: `names ${hit}` };
}
