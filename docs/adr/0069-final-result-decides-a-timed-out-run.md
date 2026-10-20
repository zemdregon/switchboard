# ADR-0069: A provider's final successful result decides a timed-out run; idle-timeout work raises needs-attention

- Status: Accepted (built 2026-10-20).
- Date: 2026-10-20
- Decided by: Linus decision, Delegated, not owner-approved (agent, 2026-10-20). It does not change bypass runs, the
  Git-write denial or worktree isolation: every check that ran before still runs, and the tool-call guard and the
  adapters' fail-closed rules decide as before.
- Related: FR-EXE-01, FR-CTL-03, [LLD §8](../design/LLD.md#8-run-supervisor-details),
  [LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03),
  [LLD §11.1](../design/LLD.md#111-configuration-shape), [ROADMAP T1.6](../ROADMAP.md#61-m1-foundation-tasks).

## Context

Prod run `run_01M5BZDDH2S2ANYFX32R337ER5` (Claude Code, ROADMAP T15.8) finished its edits and checks. At 06:38:49 the
CLI emitted its `result` event (`subtype: success`, `stop_reason: end_turn`, the summary saying the work was done) but
did not exit: a background shell it had started ("Wait for neighbouring tests to finish") was still running, and
`claude -p` waits for its background tasks. No further stdout came. At 06:43:49, exactly the 5-minute idle window
(`DEFAULT_IDLE_MS`, LLD §8) later, the supervisor's idle timer fired, SIGTERM ended the process (exit 143), and Claude
Code's last lines were `task_notification` / `task_updated` (`killed`) / `background_tasks_changed`. Every adapter's
`extractResult` treats a run as clean only when the process exited by itself, so the run ended `FAILED` /
`PROCESS_TIMEOUT` / `idle timeout`. The diff artifact (30 files) and the rollback's evidence commit were kept, but
nothing was published and the run carried no `needs_attention` reason; the operator salvaged the diff by hand.

The other hypothesis, no stdout while the agent waits on a long foreground command, did not hold for this run: the
captured stream has `tool_progress` lines about every 30 seconds during the earlier waits, which re-armed the timer.

## Decision

1. **The final result decides.** For a `subprocess-jsonl` run that ends with outcome `timeout` (wall-clock or idle),
   `startAdapterRun` asks the adapter's own `extractResult` again over the same events with a clean expected exit
   (`settleAfterFinalResult`, `src/adapters/run.ts`) when the last `result` event is `ok` and only bookkeeping events
   (`unknown`, `usage`) follow it. If that verdict is `ok`, it is the run's result, and `settledAfterResult` names the
   bound that ended the process. The `RUNNING → FINALIZING` transition still records `exit_outcome: "timeout"`, now with
   `settled_after_result: "idle"` or `"wall_clock"`. Any later `message` or `tool_call` (the agent kept working), a
   failed result, a provider error, a denial, a sandbox event or a guard violation anywhere in the run keeps the
   timeout failure. Cancellation, crashes and protocol errors are never settled. The ACP transport already ends a run
   at its result (`complete()`, ADR-0036 item 8.4) and is unchanged.
2. **Idle-timeout work raises needs-attention.** `idle_timeout_work_kept` joins the closed FR-CTL-03 reason list. It
   is derived on read for a `FAILED` run with `PROCESS_TIMEOUT` and the detail `idle timeout` whose newest post-run
   `checkpoint` event reports changed files, while it is the newest run of its meta-session. The run path announces
   it once through `onNeedsAttention`. It ranks just above `failed_after_retry`. Its evidence is what finalization
   already keeps for every failure: the `diff` and `changed_files` artifacts and the rollback's evidence commit. The
   failure stays a failure: nothing is published automatically.
3. **A per-project idle window.** `projects[].timeouts.provider_idle_seconds` (integer 60 to 3600, Assumption bounds;
   configuration file only, not a dynamic project definition, because it widens a resource bound) is frozen into the
   policy snapshot at admission as `project.provider_idle_ms` and replaces the adapter's idle window for that run's
   provider processes, steer turns included. Absent, the default stays 300 seconds (`DEFAULT_IDLE_MS`). The
   wall-clock bound is unchanged.

## Consequences

- A run like the prod run now ends `SUCCEEDED` after the idle window and is published as usual. It still waits out
  that window: Switchboard does not kill a process early because it reported a result (Proposed follow-up, not built).
- A provider whose `result` is not final (more work after it) is not affected: activity after the result keeps the
  timeout. A background process that changed files after the result is part of the post-run checkpoint, as before.
- The closed reason list grows to nine values; MCP output schemas take it from `NEEDS_ATTENTION_PRIORITY`, and the sink
  filter's list was extended with it.
- Rejected: raising `DEFAULT_IDLE_MS`. The evidence shows foreground waits keep the stream alive, and a longer default
  would only delay the same misclassification.
