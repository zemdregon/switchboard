# Cursor CLI provider-reported usage (2026-10-21)

*Delegated agent work; not owner-approved.* This note records the sources checked for Cursor CLI's real plan, usage and
limit figures. Each one is either a figure the provider reports or one Switchboard estimates
([BR-50](../requirements/FRD.md)). It is the source for [ADR-0080](../adr/0080-cursor-usage-from-the-cli-usage-command.md)
and `src/adapters/cursor/usage.ts`. CLI: `cursor-agent 2026.10.19-6bbf2c4` (linux arm64) on the operator's Ampere host,
signed in to a Pro account. No account identifier, email or credential is recorded here.

## Sources

| Source | Result | Evidence |
| --- | --- | --- |
| `cursor-agent status --format json` | Login state only | Already used by the auth preflight (`isAuthenticated`). |
| `cursor-agent about --format json` | Plan name only | Keys: `cliVersion`, `latestStatus`, `latestVersion`, `model`, `subscriptionTier` (`"Pro"`), `osPlatform`, `osArch`, `userEmail`, `terminalProgram`, `shell`, `lastRequestId`. No usage, limit or reset. |
| `--print --output-format stream-json` | Per-run tokens only | `result.usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`); a spent quota is the free-text `ActionRequiredError ... You're out of usage` ([limit captures](limit-captures-2026-10-17.md#table)). |
| `--print "/usage"` | Not a command | The CLI bundle's `src/headless.ts` sends print-mode input to the model; slash commands exist only in the interactive interface. Not run, because it would have cost a model call. |
| **Interactive `/usage` slash command** | **Plan, included-usage shares, on-demand state and dollars, reset day** | Bundle `src/usage/usage-command.ts` and `usage-data.ts`: the CLI calls its own dashboard service (`GetCurrentPeriodUsage`, `GetHardLimit`, `GetPlanInfo`; for Enterprise `GetMe`, `GetMonthlyBillingCycle`, `GetAggregatedUsageEvents`) with its own login and renders a panel (`usage-pager.tsx`). There's no model call. Captured on the operator's host (below). |
| Local state (`~/.cursor/agent-cli-state.json`, `cli-config.json`, `statsig-cache.json`) | No usage | Only key names were scanned; nothing related to usage, quota, plan or spend. The CLI's credential file was not opened. |
| Dashboard service called directly, the web dashboard, or the Admin API | Not used | Each needs Switchboard to hold the CLI's token, a browser cookie or an admin API key, which [ADR-0003](../adr/0003-no-credential-handling.md) forbids. |
| HTTP response headers | Not reachable | The CLI does not print them. |
| Cursor's web documentation | Not checked | No web access in this session. The installed CLI's bundle is the primary evidence. |

## Capture

Started in an empty directory with `cursor-agent --mode ask --trust` in a terminal 160 columns wide, then `/usage` and
Enter. The panel, verbatim apart from shortened bars:

```text
 Usage • Pro                                                          Resets Nov 5
 Monthly plan and on-demand usage

 Category        Current             Usage
 Included        100% used           ████████
   Auto          100% used           ████████
   API           100% used           ████████
 On-Demand       Disabled            ————————

 On-demand usage is off

 View in dashboard: cursor.com/dashboard?tab=usage

 Esc to close
```

The same panel can be read without tmux and without a new dependency: run
`script -qfec "stty cols 160 rows 50; exec cursor-agent --mode ask --trust" /dev/null` with stdin piped, type `/usage`,
then press Enter once the slash menu highlights `/usage`. Without `stty`, the pseudo-terminal has no size and the panel
renders one column wide. A read takes about 6 s and makes no model call. The recorded output is the fixture
`src/adapters/cursor/fixtures/usage_pro_exhausted.pty.txt` (only the scratch path is redacted).

Each directory the CLI starts in gets a `~/.cursor/projects/<slug>` entry (a trust marker), so the reader uses one stable,
owner-checked scratch directory rather than a new one per read.

## Rendering facts the parser relies on (bundle `usage-pager.tsx`)

- Percentages are rounded to whole numbers; anything above 0 and below 1 shows as `1%`.
- The reset label is `Resets <Mon> <d>`: the billing-cycle end formatted as a UTC month and day. When the cycle end is
  unknown, the label is `Current period`. So the reset is known to the day, not the instant.
- The on-demand row has four cases: `fixed` (`$U / $L`, detail `$R remaining`), `unlimited` (`$U`, detail
  `No monthly limit` or `No personal limit`), `disabled` (`Disabled` or `$U`, detail `On-demand usage is off`) and
  `unavailable` (`Unavailable` or `$U`, detail `On-demand limit unavailable`).
- Enterprise accounts get a spend view (`Personal spend for the current billing period`, `Current cycle $X`,
  `Previous period $Y`) instead of percentages.
- In place of a panel, the CLI can print: `Usage details are not available for this plan in the CLI.`,
  `Enterprise spend details are not available for this account in the CLI.`, `Not logged in. Run /login first.` and
  `Failed to load usage data: <reason>`.

Only the `disabled` case was captured live. The `fixed`, `unlimited`, `unavailable` and spend cases are synthetic
fixtures built from these strings, and they stay **Unverified** until an account shows them.
