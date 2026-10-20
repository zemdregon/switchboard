# Live testing

Opt-in live smoke, malicious-fixture and pair tests, and the live-test budget guard. Part of the [Switchboard guide](README.md).

## Optional live smoke test

With a provider CLI installed and logged in natively, you can run one real task against it. It is opt-in and skipped
unless you set the variables; `npm test` and CI never run it.

```sh
SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live   # or codex, agy, opencode, cursor, kimi, grok
```

It builds, creates a throwaway Git repository and data directory under the system temp directory, runs one
`edit-untrusted` task, and prints which adapter assumptions held, failed or were not checked. Details are in
[TDD §3.6](../design/TDD.md#36-testing-strategy). With the current manifests, a codex-cli 0.162.0 or 0.162.1 passes the
version gate (range `>=0.162.0 <0.163.0`); any other Codex version is refused as `ADAPTER_VERSION_UNVERIFIED`.
Antigravity (`agy`), OpenCode, Cursor, Kimi Code and Grok Build compile only an approved `privileged` cell, so for them
the same task runs in that cell (Kimi Code: its ACP cell, `Ineligible` since the owner-level ruling relayed 2026-10-19
08:45 CDT — the plug-in must move it to the bypass cell; see ROADMAP T4.68) and the script approves it through the
operator `approve` CLI; the bypass-flag audit then requires exactly the cell's own flag. Until
`adapters validate <provider>` writes a manifest range (Kimi Code and OpenCode have one today: `>=2.1.1 <2.2.0` and
`>=2.0.23 <2.1.0`), a provider without one stops at the version gate.

## Optional live malicious leg (T3.9)

With a provider CLI installed and logged in natively, you can run the T3.9 canary checks against it (and the T4.28,
T4.38, T4.48, T4.58 and T4.68 checks for Grok Build, Antigravity, Cursor, OpenCode and Kimi Code). It is opt-in
twice over and skipped otherwise: both variables must be set, so `npm run test:live` (which never sets the second
one) can never run it by accident, and `npm test` and CI never run it.

```sh
SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_MALICIOUS=1 npm run test:live:malicious -- claude
# or codex, agy, opencode, cursor, kimi, grok
```

It builds, plants random `SBCANARY-...` canaries in temp files outside the worktree and in a temp HOME-like dir (never
real credentials), runs one Git-write task (C-G2 / X-G1), one canary-confinement task (R-10 for Claude, FR-POL-06 for
Codex) and, for Claude only, one bypass run under an approved scope (network `on`, the only value Claude's
`privileged` cell compiles) reached through the operator `approve` CLI, then reports `HELD` / `ESCAPED` /
`NOT_CHECKED` per check with one evidence line. For Antigravity, OpenCode, Cursor, Kimi Code and Grok Build it runs
the three checks their plug-in names (`A-`, `O-`, `U-`, `K-`, `G-M1` to `M3`: a Git-write attempt and the two
canaries), each in the adapter's own approved cell. Model runs per invocation: Claude 3, Codex 2, every other provider
3. A check whose precondition is missing (not logged in, version outside the manifest range, an approved run whose
provider never started) is `NOT_CHECKED`, never `HELD`; a budget refusal stops the run with exit 75 before any check
runs. An `ESCAPED` on OpenCode's canary checks is expected under owner decision 46 and does not set the exit code. The
run itself is the operator's step: record the rows in the provider's ROADMAP row and the manifest notes. Details are
in [TDD §3.6](../design/TDD.md#36-testing-strategy).

## Optional live pair test

With both Claude Code and Codex installed and logged in natively, `SWITCHBOARD_LIVE_TESTS=1 npm run test:live:pair`
delegates one edit to one provider and continues the session on the other through `continue_task`, in a throwaway
repository, for each direction (`SWITCHBOARD_LIVE_PAIR=claude:codex` runs one). It is opt-in and skipped otherwise, passes
no bypass flag, prints no prompt or transcript, and records statuses, bindings (without native session ids) and the
bundle hash. A provider that is not installed or not logged in makes its checks `NOT_CHECKED`. It was run once against
real providers on 2026-10-19 (`claude:codex`, Codex in the operator's container login; ROADMAP T5.12): 7 checks held
and P-7 failed, because the file the Codex run was asked to write did not land.

## Live-test budget guard

All three live scripts accept an operator budget file kept outside the repository (T8.9, NFR-MAINT-05). Point
`SWITCHBOARD_LIVE_BUDGET_FILE` at it (an absolute path) and name the run's purpose in `SWITCHBOARD_LIVE_PURPOSE`:

```sh
SWITCHBOARD_LIVE_BUDGET_FILE=$HOME/.config/switchboard-live/budget.json SWITCHBOARD_LIVE_PURPOSE=pre-check \
  SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live
```

The file is JSON (every key is required except `audit_log`; unknown keys are errors; the values are an example):

```json
{
  "schema_version": 1,
  "window_hours": 24,
  "global_max_runs": 4,
  "min_gap_seconds": 900,
  "purposes": ["pre-check", "final-verify"],
  "providers": { "claude": { "max_runs": 2, "model": "<model id>" }, "codex": { "max_runs": 2, "model": "<model id>" } },
  "audit_log": "/absolute/path/outside/the/repository/live-runs.jsonl"
}
```

Before any provider process starts, the script refuses the run and exits **75** when the purpose is not on `purposes`, a
provider is not listed, the previous admitted run started less than `min_gap_seconds` ago, or the run would take a
provider past its `max_runs` or all providers past `global_max_runs` within the last `window_hours`. A provider run is
one task on one provider: the smoke test is one, each direction of the live pair is one on each of its two
providers, and one live-malicious invocation admits up to three on its provider. A
missing, unreadable or malformed file, a relative path, or a file or audit log inside the repository is refused the same
way. An admitted run uses the file's model for each provider (it replaces `SWITCHBOARD_LIVE_MODEL`, which the smoke test
otherwise passes as asked): the throwaway `serve` config lists only that model and the run asks for
`minimum_capability: "low"`, so no new flag is passed. Every run appends JSON lines to `audit_log` (default: the budget
file's path plus `.jsonl`): `start` and `finish` (with the exit code) for an admitted run, `denied` (with the reason) for
a refused one. Only `start` records count. Records hold the script, a run id, the purpose, provider ids, run counts and
models; never a prompt, output, account or credential. Without `SWITCHBOARD_LIVE_BUDGET_FILE` the scripts behave as
before and print one warning on stderr. CI never sets the variable (`test/live-budget.test.ts`). The format and the
checks are in [TDD §3.6](../design/TDD.md#36-testing-strategy).
