# ADR-0080: Cursor usage read from the CLI's own `/usage` command in a pseudo-terminal

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21: show real, provider-reported usage for every
  provider), not owner-approved. The details marked **Delegated** were chosen while building it.
- Related: FR-CAP-13, FR-AUTH-02, FRD BR-50,
  [ADR-0079](0079-provider-reported-usage-reader.md) (the `readProviderUsage` adapter hook and the `provider_usage`
  block this fills for Cursor), [ADR-0003](0003-no-credential-handling.md) (no credential handling),
  [ADR-0007](0007-capacity-as-confidence-estimate.md) (capacity is an estimate; this figure is not),
  [research note](../research/cursor-usage-2026-10-21.md),
  [ROADMAP T6.18](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).

## Context

Cursor CLI's headless output reports per-run token counts and, once the quota is spent, a free-text
`You're out of usage` error. It reports no plan, share used, on-demand limit or reset. The CLI has no non-interactive
usage command: `status` and `about --format json` give the login state and plan name only, and print mode sends a
`/usage` line to the model as a prompt. The interactive interface does have a `/usage` slash command. That command calls
Cursor's dashboard service with the CLI's own login and renders the plan, the included-usage share (total, Auto, API),
the on-demand state and dollars, and the billing-cycle reset day (research note). Every other route to the same figures
(the dashboard service called directly, the web dashboard, the Admin API) would need Switchboard to hold a token, a
cookie or an API key, which ADR-0003 forbids.

## Decision

1. **Cursor's `readProviderUsage` runs `/usage` in a pseudo-terminal.** It spawns `script(1)` (util-linux
   `script -qfec <cmd> /dev/null`; BSD `script -q /dev/null sh -c <cmd>` on macOS, an **Assumption** not run on a Mac).
   `<cmd>` is `stty cols 160 rows 50; exec cursor-agent [launcher args] --mode ask --trust`, with each argument
   single-quoted. The reader waits for the prompt box, types `/usage`, and presses Enter only once the slash menu
   highlights `/usage`. A slow start therefore can't submit the text as a prompt. It reads the panel, then sends Escape
   and Ctrl-C and stops the process (SIGTERM after 1 s, SIGKILL after 3 s). No model is called. No new dependency:
   `script(1)` is part of the base system on both platforms.
2. **The CLI authenticates itself; Switchboard reads only the screen.** No credential, cookie, configuration or state
   file of Cursor's is opened. The raw screen is parsed in memory and never stored, logged or returned. Only the parsed
   figures leave the reader.
3. **One stable scratch directory (Delegated).** The CLI starts in `<tmpdir>/switchboard-cursor-usage-<uid>`: mode 0700,
   empty, reused, and refused when it is a symbolic link, not a directory, or owned by another user. Reason: Cursor
   records a project entry (a trust marker) for each directory it starts in, so a new directory per read would add one
   entry to the operator's `~/.cursor/projects` per read. `--mode ask` keeps the session read-only, and `--trust` covers
   only this empty directory (neither is a bypass flag).
4. **The report, every figure as shown (BR-50).** `source: "provider_reported"` with `plan`, and windows `included`,
   `included:auto` and `included:api`. Each window has `used_fraction` (the shown whole percentage / 100) and
   `remaining_fraction` (1 − used), `window_seconds: null` (the cycle length isn't shown), and `resets_at` (the start
   of the shown UTC reset day, the next one on or after today) with `reset_precision: "day"`. The report also carries
   the verbatim `reset_label`, `on_demand` (`fixed` / `unlimited` / `disabled` / `unavailable`, with used, limit and
   remaining dollars where shown), and `spend` for the Enterprise spend view.
5. **`limit_reached` from the shown figures (Delegated).** It is true when included usage is 100% and on-demand use is
   `disabled`, or is `fixed` with nothing remaining. It is false when included usage is below 100% or on-demand use is
   `unlimited`. It is null otherwise. Reason: this is the condition under which the CLI answers `You're out of usage`,
   per the 2026-10-17 capture against the same account state.
6. **Failure is `unknown`, never headroom.** The result is `source: "unknown"` with a short reason when: the binary is
   missing, `script(1)` can't start, the CLI exits first, the menu never shows `/usage`, nothing appears within 30 s
   (**Proposed**), or the CLI prints one of its own messages (not logged in, not available for this plan, failed to
   load). The ADR-0079 per-process cache bounds how often the CLI is started.
7. **Not wired into pacing.** The figures are shown on the capacity surfaces only. They don't enter `USAGE_KEYS`,
   `capacity_score`, routing or the pacing gate, because ADR-0079 keeps the projection a pure function of the ledger. A
   later task may declare them once a subscription for Cursor is configured.

## Consequences

- `get_capacity`, `switchboard capacity` and `doctor` show Cursor's real plan, included-usage shares, on-demand state
  and reset day.
- The reader depends on the CLI's rendered text. A CLI release that changes the panel gives `unknown` (or a panel not
  recognised), never a wrong figure: each figure is matched by its own label. The recorded fixture pins the 2026.10.19
  rendering.
- A read takes about 6 s and starts one CLI process. With the ADR-0079 cache, that happens at most once per cache
  period per server process.
- The on-demand `fixed`, `unlimited` and `unavailable` cases and the Enterprise spend view are parsed from the
  renderer's strings, not from a live capture. They stay Unverified until an account shows them.
