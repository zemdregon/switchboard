# Live checks on Ampere, 2026-10-17: `doctor` with Claude Code and Codex, limit signals, container login state

Status: research input (historical record once written). Run by an agent (Claude Opus 5.5, Delegated) on the
operator's Ampere server, with the real, logged-in provider CLIs. Everything here was **observed** on this host on
2026-10-17 through the operator's `live-run-ext.sh` channel (below). The roadmap owns status
([ROADMAP §6](../ROADMAP.md#6-milestones) and [§7](../ROADMAP.md#7-risks-blockers-and-open-questions)). Verdicts are
Delegated findings, not owner decisions. Earlier runs on this host:
[live-checks-2026-10-14-claude-codex.md](live-checks-2026-10-14-claude-codex.md).

## Environment and method

| Item | Value |
| --- | --- |
| OS / Node.js / Git | Ubuntu 26.04.1, Linux 7.0.0-1013-oracle aarch64 / v24.21.0 / 2.53.0 |
| Claude Code | 2.1.294 (manifest range `>=2.1.294 <2.2.0`) |
| Codex CLI | codex-cli 0.162.0 (manifest range `>=0.162.0 <0.163.0`) |
| Other CLIs found on `PATH` | Grok Build 1.0.50, Antigravity 1.4.0, Cursor 2026.10.16-e3cb207, OpenCode v2.0.23, Kimi Code 2.1.1 |
| Clone | Fresh clone per check, built with `npm run build`, removed afterwards: `main` at `d405a60`, then this PR's branch |
| Channel | The operator's `live-run-ext.sh`: a fixed list of checks, the shared live-run budget and limit markers, output scrubbed of account fields and ids before it is written |
| Model | Each model-calling CLI invocation got the operator's cheapest model through a `PATH` wrapper that only replaces `--model`/`-m` (Claude Code `claude-haiku-5-5`; Codex `-m gpt-6-luna` with low effort). Probe, help and status invocations pass through unchanged. Switchboard's own argv is otherwise untouched |
| Credentials | None read, copied or mounted. The `auth status` key names below are printed by `scripts/live-smoke.mjs`, never their values |

## 1. `doctor` with providers installed (T2.8, M2 "Blocks Done" item 3)

`switchboard doctor --config <file>`, with a temporary data directory, followed the README: the "Configure" minimal
example (`schema_version`, `allowed_roots`, one `mcp_clients` entry). No model call is made (the wrapper saw only
`--version`, `--help`, `auth status --json`, `exec --help` and `login status` for these two CLIs).

| # | Clone | Config | Claude Code | Codex | Result |
| --- | --- | --- | --- | --- | --- |
| 1a | `main` `d405a60` | README minimal | `[ok]` probe ok (2.1.294); auth OK | **`[FAIL]`** probe ok (codex-cli 0.162.0); auth OK; `ADAPTER_VERSION_UNVERIFIED: installed codex version codex-cli 0.162.0 changed since last recorded 0.162.0 (version canary)` | FAILED, exit 1 |
| 1b | `main` `d405a60` | README minimal plus the Troubleshooting step: `providers.<id>.enabled: false` for `grok-build`, `antigravity`, `cursor`, `opencode`, `kimi-code`, `muse-code` | `[ok]` | **`[FAIL]`** (same canary message) | FAILED, exit 1 |
| 2a | this PR | README minimal | `[ok]` probe ok (2.1.294); auth OK | `[ok]` probe ok (codex-cli 0.162.0); auth OK | FAILED, exit 1: only the M4 adapters fail (below) |
| 2b | this PR | as 1b | `[ok]` | `[ok]` | **OK, exit 0** |

**Cause of 1a/1b (fixed here).** On a fresh data directory the version canary (T8.5, `src/adapters/version-canary.ts`)
has no stored row, so its baseline is the manifest's `validated_cli_version` (`0.162.0`). The probe reports Codex's
raw version line (`codex-cli 0.162.0`). The canary compared the two strings exactly and counted the prefix as a version
bump, so an in-range Codex was `Ineligible` in `doctor`, and in `serve` on any new data directory. This PR compares the
parsed versions (`sameVersion`: `x.y.z`, the prerelease flag and build metadata; exact string when either side does
not parse). Tests: `src/adapters/version-canary.test.ts` ("a raw version line matches the manifest's bare
validated_cli_version (codex-cli prefix, T2.8)", "sameVersion compares parsed versions and falls back to exact
strings").

**2a.** The M4 adapters on this host, all as `doctor` reports them (not changed by this PR):

- Grok Build 1.0.50: probe ok, auth `AUTH_REQUIRED` in this run. A later `adapters validate grok` the same day
  reported auth OK, so the `grok models` first-line keying may be unstable.
- Antigravity 1.4.0: probe failed (`output_format`, `flags`). Its `--help` no longer lists `--output-format`, which
  1.3.4 did on 2026-10-14.
- Cursor 2026.10.16-e3cb207 and OpenCode v2.0.23: probe ok, auth OK, `ADAPTER_VERSION_UNVERIFIED`.
- Kimi Code 2.1.1: probe ok, auth `UNKNOWN` ("ACP auth probe was inconclusive (session/new missing, exit 0)").
- Muse Code: not installed.

The `ADAPTER_VERSION_UNVERIFIED` detail names a missing `dist/adapters/manifests/<id>.json`:
`scripts/copy-build-assets.mjs` copies only `claude.json` and `codex.json`. Those manifests admit no version anyway
(`<0.0.0`), so the outcome does not change, only the message. Not fixed here.

So the README's own path (minimal config, then its Troubleshooting step for unvalidated providers) reaches a passing
`doctor` on a machine with Claude Code and Codex installed and logged in. Row 2a's exit 1 is the README's documented
`[FAIL]` for "the version gate rejected the installed version"; it comes from the other CLIs installed on this host,
not from Claude Code or Codex.

## 2. Claude Code: `adapters validate` and the live smoke, again

| Check | Result |
| --- | --- |
| `switchboard adapters validate claude` (one call) | **OK**: manifest, probe, auth, 8 static checks, smoke ("a successful structured result was parsed"), write. Same version, so the manifest diff is only `validated_on` and one evidence line; it is not committed here |
| `SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live` | **14 HELD, 0 FAILED, 2 NOT_CHECKED** (C-12, C-G2), E2E `SUCCEEDED`, `SMOKE.md` on the result branch, G-1 held. Native types `system/init`, `assistant` x2, `rate_limit_event`, `user`, `result/success`; 0 unrecognised. Same counts as 2026-10-14 |

## 3. Limit and usage signals (T6.11, one row per provider)

*Corrected later the same day:* [limit captures 2026-10-17](limit-captures-2026-10-17.md#corrections) found real
limit output for Claude Code (2026-10-15), Cursor CLI and Kimi Code in the operator logs. The rows below are kept as
first written.

Sources, as ROADMAP T6.11 allows: (a) this day's channel runs; (b) the operator logs already on the host (worker,
merge-steward and doc-alignment-gate logs under `~/operator-runs/`). No limit was provoked. Only key names, event types,
exit codes and the provider's own limit wording are recorded.

| Provider | What occurred | Event type / shape | Exit code | Reset or retry field | Used or remaining figure | Structured? | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.294 | No rate limit, overload or quota stop. Every successful run had one non-rejected `rate_limit_event` (types only recorded). The `result` `usage` key names of a 2026-10-17 run: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `output_tokens_details`, `server_tool_use`, `service_tier`, `cache_creation`, `inference_geo`, `iterations`, `speed`, `fallback_credit` | n/a | n/a | not seen | not seen | `usage` yes | usage keys **PASS**; `rate_limit_event` fields, rate limit, overload, quota **NOT_CHECKED** |
| Codex 0.162.0 | **Quota stop** on the first call of the day (`adapters validate codex` smoke, `-m gpt-6-luna`): "You’ve hit your usage limit. … try again at Oct 22nd, 2026 6:19 AM." | not captured (the validate smoke keeps no stream) | not captured (validate exit 1) | free text only ("try again at <date>") | none in the message | unknown | **FAIL** for classification: the adapter mapped it to `TOOL_FAILURE`, category `unknown`, not a quota code. Event type and exit code **NOT_CHECKED** |
| Antigravity (`agy`, version not in those logs) | **Quota stop**, 7 occurrences in worker logs of 2026-10-15 and 2026-10-16 (`w345`, `w350`, `w360`, `w362`, `w375`, `w385`, `w571`), all under `--output-format text` | stderr line `error: Individual quota reached. … Resets in <h>h<m>m<s>s.` and one `AGY_ERROR: {…}` JSON line with keys `short_error`, `status` (`RESOURCE_EXHAUSTED`), `error_code` (`429`), `code_kind` (`http`), `retryable` (`true`), `error_id` | **3** | free text inside `short_error` ("Resets in …"); no reset key | none | status and code yes; reset no | **PASS** (captured); `--output-format json`/stream shape **NOT_CHECKED** |
| Grok Build, Cursor CLI, OpenCode, Kimi Code | No real occurrence found: every match in the logs was synthetic test text (for example `SYNTHETIC: too many requests`) | | | | | | **NOT_CHECKED** |
| Muse Code | Skipped (owner deferral) | | | | | | **NOT_CHECKED** |

Candidate keys for T6.15: Antigravity `AGY_ERROR.status` and `error_code` (taxonomy mapping; the reset is free text, so
it stays unmapped under Q-100); Claude Code cache keys `cache_creation_input_tokens` and `cache_read_input_tokens`. For
Codex there is nothing to map until the stream shape of a quota stop is captured. Its stated reset is 2026-10-22 06:19.
Every other Codex check planned for 2026-10-17 (live smoke, T5.12 resume cells, the T5.11 pair) was refused by the
channel's limit marker and not attempted.

## 4. Login state in a fresh container volume (T10.0)

The image is `node:22-bookworm-slim`, with no Git client. The container ran with `--network none`, uid 0 (rootless
Docker, so it maps to the host user), and a new named volume as `HOME`. Each CLI's own binary or package directory
was bind-mounted read-only. No credential path was mounted. Only version and status commands ran, and the volume was
removed afterwards.

| CLI | `--version` (exit) | Status command (exit) | State |
| --- | --- | --- | --- |
| Claude Code | `2.1.294 (Claude Code)` (0) | `auth status --json` (1) | `loggedIn: false`, `authMethod: none` |
| Codex | `codex-cli 0.162.0` (0) | `login status` (1) | `Not logged in` |
| OpenCode | `opencode v2.0.23` (0) | `auth list` (0) | `No authenticated integrations` |
| Grok Build | `grok 1.0.50` (0) | `models` (0) | `You are not authenticated.` |
| Antigravity | `1.4.0` (0) | `models` (1) | `Error: Please sign in …` |
| Cursor, Kimi Code | not run | | No standalone binary to mount without a package install |

`git` was not on `PATH` in the image. So these five CLIs start and report their own logged-out state with no Git
client and no network. A login inside the volume, and a real task inside the container, were not attempted. Those
need the operator (T10.0 stays `Partial`).

## 5. `adapters validate` for the M4 adapters (T4.28, T4.38, T4.48, T4.68)

Same channel, same day. No model call was made, because each run stopped before the smoke step. Nothing was written.

| Adapter (CLI version) | manifest | probe | auth | conformance | Stops at |
| --- | --- | --- | --- | --- | --- |
| Grok Build (1.0.50) | ok | ok | OK | **FAIL** `compiles` | conformance |
| Antigravity (1.4.0) | ok | **FAIL** `output_format`, `flags (--output-format)` | not run | not run | probe |
| Cursor CLI (2026.10.16-e3cb207) | ok | ok | OK | **FAIL** `compiles` | conformance |
| OpenCode (v2.0.23) | ok | ok | OK | **FAIL** `compiles` | conformance |
| Kimi Code (2.1.1) | ok | ok | **UNKNOWN** (fail closed): "Kimi Code ACP auth probe was inconclusive (session/new missing, exit 0)" | not run | auth |

What this shows:

- **`compiles`.** `adapters validate` compiles its smoke task under `inspect-untrusted`. Grok Build, Cursor, OpenCode,
  Antigravity and Kimi Code are `Ineligible` for every non-privileged profile by design, so the command **cannot pass
  for a bypass-only adapter as built**. Validating them needs a validate path under an approved `privileged` bypass
  scope, or an owner decision. Their live smoke legs need the same: `scripts/live/providers/` has plug-ins only for
  `claude` and `codex`.
- **Antigravity 1.4.0** no longer lists `--output-format` in `--help` (1.3.4 did, 2026-10-14).
- **Kimi Code.** The first live run of Switchboard's ACP auth preflight did not get a `session/new` reply (exit 0). The
  2026-10-15 rows 8 to 10 got a reply in a direct ACP exchange. Cause not investigated.
- **Grok Build.** `doctor` reported auth `AUTH_REQUIRED` at 03:30Z and `adapters validate grok` reported `OK` at 03:34Z.
  The `grok models` first-line keying may be unstable.
