# Live checks on the operator's machine, 2026-10-14: Claude Code and Codex (smoke and validate)

Status: research input (historical record once written). Run by an agent (Kimi Code) on the operator's own machine
("Ampere", an Oracle Cloud Ubuntu ARM64 server), with the real provider CLIs, from a fresh clone of `main` at
`f671e9c`. Everything here was **observed** on this host on 2026-10-14; nothing is stated from memory. The roadmap owns
status (see [ROADMAP §6](../ROADMAP.md#6-milestones) and [§7](../ROADMAP.md#7-risks-blockers-and-open-questions)).
Verdicts are Delegated findings, not owner decisions. Companion of
[live-checks-2026-10-13.md](live-checks-2026-10-13.md), which a different host (x86_64) produced.

## Environment

| Item | Value |
| --- | --- |
| OS | Ubuntu 26.04.1 LTS, Linux 7.0.0-1013-oracle aarch64 |
| Node.js / Git | v24.21.0 / 2.53.0 |
| Claude Code | 2.1.294 |
| Codex CLI | codex-cli 0.162.0 |
| Grok Build | 1.0.50 (installed; `grok models` prints "You are not authenticated.") |
| Antigravity (`agy`) | 1.3.0 (`agy models` lists models, so a login works) |
| Cursor CLI (`cursor-agent`) | 2026.10.01-e373342 (`cursor-agent status`: logged in) |
| OpenCode | v2.0.23 (`opencode auth list` shows one stored credential) |
| Kimi Code | 2.1.1 (`kimi provider list` shows `managed:kimi-code`, source `oauth`) |
| Muse Code | not installed |

Login state was checked only with each CLI's own documented status or listing command; no credential file was read, and
no account identifier is recorded here.

## Results

| # | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Baseline `npm ci`, `npm run build`, `npm test` | WORKS | 1691 tests in 71 files passed, 3 skipped, exit 0 (371 s) |
| 2 | Claude live smoke (`SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live`), first attempt | FAILS at the gate | installed 2.1.294 outside the then-recorded range `>=2.1.296 <2.2.0`; C-1 to C-5 HELD, C-V FAILED, C-6 to C-12, G-1, C-G2 NOT_CHECKED (provider never ran) |
| 3 | `switchboard adapters validate claude` (T4.11) | WORKS | probe (5 steps), auth OK, 8 static conformance checks and the one structured-output smoke call passed; the manifest gained `validated_cli_version` `2.1.294`, `validated_on` `2026-10-14`, range `>=2.1.294 <2.2.0` and the dated evidence line; no other line changed |
| 4 | Claude live smoke after check 3 | WORKS | **14 HELD, 0 FAILED, 2 NOT_CHECKED** (C-12, C-G2); run SUCCEEDED; stream: `system/init` x1, `assistant` x2, `rate_limit_event` x1, `user` x1, `result/success` x1; 0 unrecognised, 0 non-JSON; tool `Write`; `SMOKE.md` on the result branch; G-1 HELD (no foreign ref or commit) |
| 5 | **C-10 investigation** (earlier report: "1 unknown event", claude 2.1.296, another host) | NOT REPRODUCED | 0 unknown events in this run's 6-line stream (2.1.294). The earlier run's kept artifacts are not on this host, and the smoke script prints only the COUNT of unknown events plus the native-type and normalized-kind maps — so the specific unknown type cannot be recovered from what is available here. See "C-10 finding" below |
| 6 | Codex live smoke (`SWITCHBOARD_LIVE_PROVIDER=codex`) | FAILS at the gate (expected per README) | installed `codex-cli 0.162.0` outside the recorded range `>=0.162.1 <0.163.0`; X-1 to X-3 HELD, X-V FAILED, X-4 to X-9, G-1, X-G1 NOT_CHECKED (provider never ran) |
| 7 | `switchboard adapters validate codex` (T4.11) | FAILS at the smoke step | probe, auth (`codex login status` exit 0) and 8 static checks ok; smoke: `TOOL_FAILURE (unknown: Reconnecting... 2/5 (workspace routing discovery unauthorized (401)))`; **nothing written** (exit 1, manifest byte-identical — the fail-closed behaviour of T4.4 held). One permitted retry: identical failure |
| 8 | Codex login, diagnosed | LOGIN EXPIRED | a direct `codex exec --sandbox read-only "..."` in a scratch Git repo prints `Failed to refresh token: Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.` while `codex login status` still prints `Logged in using ChatGPT` with exit 0. **Q-10 finding: the exit code of `codex login status` does not detect an expired refresh token.** The operator must re-login natively; no agent may do it |

## C-10 finding (the earlier "1 unknown event in the real stream")

- On this host (claude 2.1.294) the smoke stream held only `system/init`, `assistant`, `user`, `rate_limit_event` and
  `result/success`, all recognised by `src/adapters/claude/parse.ts` (normalised to `session_bound`, `tool_call`,
  `message`, `usage`, `result`). C-10 **HELD**.
- The earlier failure (13 held, 1 failed, 2 not checked, claude 2.1.296, a cloud sandbox) cannot be dissected here: its
  artifacts are not on this host, and the script records only how many events were unknown, not which native type they
  were. The script's "native event types" versus "normalized kinds" listing would identify the type in any future
  failure (a native type present in the first list whose lines all land in `unknown`), so no script change is strictly
  needed — but printing each unknown event's raw type explicitly would make it unmissable (Proposed, not done here).
- **Update, same day: the unknown event was reproduced** in a Claude run through Switchboard that had a tool call
  denied (an approved privileged bypass run on claude 2.1.294 that asked for a shell `git commit` after the commit
  tool; details in `docs/research/live-checks-2026-10-14-channel.md`, a separate PR). The stream's
  line 7 had `type: "system"`, `subtype: "permission_denied"`, and top-level keys `type`, `subtype`, `tool_name`,
  `tool_use_id`, `decision_reason_type`, `message`, `uuid`, `session_id`. `parseClaudeLine` handles only
  `system/init` and falls through to `unknown` (`rawType: "system:permission_denied"`, `src/adapters/claude/parse.ts`
  lines 163 to 170). That one line is the "1 unknown event". The denial itself is not lost: the final `result` event
  carries `permission_denials` (one entry, tool name only), which the parser already maps to `permission_denied`.
- Verdict: **missing event kind, benign.** The unknown event is counted, never trusted, and did not change the run's
  outcome (the run correctly failed `PERMISSION_BLOCKED`); it makes the smoke's C-10 check FAIL whenever a smoke run
  has a denied tool. Proposed (not done here; a parser change needs its own change with a fixture): map
  `system/permission_denied` to a `permission_denied` event carrying `tool_name`, de-duplicated against the `result`
  event's `permission_denials` so a denial is reported once, plus a scrubbed one-line fixture captured from claude
  2.1.294 on 2026-10-14 (keys as above, content removed). No fixture was added because the existing fixtures are
  full-stream replays and splicing a line into one would be an invented stream.

## Limits

- Only one successful Claude run was observed (the smoke's single task); C-12 (error category strings) and C-G2 (deny
  rules against a deliberate Git write) remain NOT_CHECKED, as on 2026-10-13.
- Codex first failed on the expired login (rows 6 to 8); it ran through Switchboard after the re-login, see
  "Codex retry" below.
- `codex exec` on this host also prints `Reading additional input from stdin...` and refuses outside a trusted Git
  directory; the smoke's throwaway repository satisfies that.

## Codex retry (same day, after the operator re-signed in with ChatGPT Plus)

Binary `codex-cli 0.162.0` (unchanged). Nothing was passed a bypass flag.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 9 | Live smoke before validating | FAILS at the gate (as in row 6) | `ADAPTER_VERSION_UNVERIFIED`: 0.162.0 is outside `>=0.162.1 <0.163.0`; the gate was not bypassed |
| 10 | `switchboard adapters validate codex` | PASSED | manifest, probe (5 steps), auth OK, 8 static conformance checks and the one smoke call all `[ok]`; wrote `src/adapters/manifests/codex.json` (`validated_cli_version` 0.162.0, `validated_on` 2026-10-14, range `>=0.162.0 <0.163.0`) |
| 11 | Live smoke after validating | 10 HELD, 0 FAILED, 3 NOT_CHECKED | run SUCCEEDED, 1 changed file, `SMOKE.md` on the result branch; stream: 17 lines, 0 not JSON, 0 unrecognised; native types `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`; item tools `command_execution`, `file_change` |

HELD: X-1, X-2, X-3, X-V, X-5, X-6, X-7, X-8, G-1, E2E. NOT_CHECKED: X-4 (no documented status command; the adapter's
`codex login status` exit-code key is what `validate` used and it reported auth OK), X-9 (needs a failing run), X-G1
(needs a deliberate `git commit` in the sandbox; T9.5).

Notes:

- Validating 0.162.0 *replaces* the 2026-10-13 record of 0.162.1 (that version was seen on a different machine). The new
  range `>=0.162.0 <0.163.0` still includes 0.162.1; the previous `validated_cli_version` is no longer recorded.
- Two unit tests hard-coded manifest strings (`src/mcp/mcp.test.ts` the Claude range, `src/routing/routing.test.ts` the
  Codex range). The Claude one had already been stale since the Claude validate of this day; both expectations now
  match the manifests.
- Unlike the Q-10 finding of row 8, `codex login status` exit 0 coincided with a usable login this time. The earlier
  finding stands: exit 0 alone does not prove a usable login (the validate smoke step is what proved it).
