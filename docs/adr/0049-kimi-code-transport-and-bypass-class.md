# ADR-0049: Kimi Code transport and bypass class (clears B-1)

- Status: Accepted
- Date: 2026-10-15
- Decided by: Delegated (Linus, 2026-10-15, ROADMAP T4.61), under the owner's instruction of the same day: "You pick
  bypass flag stuff, the only thing that matters is that bypass mode stays unrestricted. For the more restricted modes
  you pick the best paths forward." Not a zemdregon quote; the bypass-class reading below applies existing
  [ADR-0017](0017-approved-privileged-scope-bypass.md) and FR-POL-03 and narrows nothing they allow.
- Amends: none. [ADR-0017](0017-approved-privileged-scope-bypass.md), ADR-0036, ADR-0037, ADR-0041 and Q-66/Q-67 stand.
- Related: FR-ADP-09, FR-POL-03, FR-GIT-01, FR-GIT-02, [TDD §4.7](../design/TDD.md#47-kimi-code-m4-blocked-by-b-1),
  [live checks 2026-10-15 (Kimi Code)](../research/live-checks-2026-10-15-kimi.md),
  [ADR-0036](0036-per-run-acp-stdio-client.md), [ADR-0039](0039-switchboard-side-tool-call-guard.md)

## Context

Kimi Code CLI 2.1.1 has two automation surfaces. `kimi -p` runs one prompt and is **always Never Ask**: it cannot be
combined with `--plan`, `--yolo` or `--auto` (observed: `error: Cannot combine --prompt with --plan.`, exit 1), so a
human approval is never requested. `kimi acp` serves ACP over stdio and offers session modes `default` ("Manual
approvals; tools execute normally."), `plan` ("Read-only planning; no tool execution."), `auto` and `yolo`, accepts
`mcpServers` in `session/new`, and answers a logged-out `session/new` with `-32000` (observed 2026-10-15). No OS
sandbox, per-run permission-rule flag or per-run MCP flag exists for `-p`.

## Decision

1. **`kimi -p` is bypass-class.** Its Never Ask policy is equivalent to a bypass flag under FR-POL-03, even though no
   bypass flag appears in its argv. The Kimi registry entry declares `-p` and `--prompt` (and `--yolo`, `-y`, `--auto`,
   `--plan`, which `-p` rejects anyway) as `bypassFlags`, so the argv audit refuses them in every run except an
   approved `privileged` scope that sets `bypass` (ADR-0017, FR-POL-09). Inside that scope the compile is exactly
   `kimi -m <model> -p <prompt> --output-format stream-json` with **no deny rules, tool lists, agent file or other
   restriction added**: a bypass run stays unrestricted, as the owner requires. Resume inside that scope is
   `--session <id>` or `--continue` with `-p`, again with no added brakes.
2. **Restricted (non-bypass) runs use ACP**, `kimi acp` through the per-run ACP client of ADR-0036 (no `fs` or
   `terminal` client capability, never `authenticate`): `session/new` with the controller's `mcpServers` (the
   injected-tool channel, FR-GIT-02, no bypass flag), the session mode set to `plan` for read-only profiles and left at
   `default` for workspace-write profiles, and every `session/request_permission` answered by the controller under the
   ADR-0039 tool-call guard (Git writes refused, `reject_once` otherwise). The controller never sends `session/set_mode`
   with `auto` or `yolo` and never answers `allow_always` outside the privileged scope (those are bypass-class too).
3. **Eligibility is fail-closed.** Profiles that need OS confinement are `Ineligible` for Kimi (no sandbox exists).
   If T4.68's live check shows that `default` mode does not raise `session/request_permission` for a tool call, or
   that the request does not carry the tool name and arguments, the restricted profiles become `Ineligible` and Kimi
   is privileged-only; the manifest then says so. Nothing in the restricted path is enabled until T4.68 passes
   (FR-ADP-09: the manifest's range admits no version before that).
4. **Auth preflight** is the ACP probe: `initialize`, then `session/new` in a scratch directory; `-32000` is
   `AUTH_REQUIRED` (naming `kimi login`), any other failure is `UNKNOWN` (fail closed). It needs no model call. No
   credential path is read. A probe session persists in Kimi's data directory (live-check row 12), so the probe is
   run once per preflight window, not per run.
5. **Git writes**: declared `none-documented` for `-p` (deny rules in `config.toml` are documented but unobserved and
   editing the user's config is forbidden); for ACP the controller's guard is the denial, to be observed at T4.68.
   Kimi stays finalize-only (FR-GIT-09) for `-p`.

## Alternatives considered

- **Treat `-p` as non-bypass because static deny rules still apply.** Rejected: no human or controller approval
  exists, and the deny rules would live in the user's `config.toml`.
- **ACP for the privileged scope too.** Allowed later by T4.62 if it is simpler (`yolo` mode), but not required: the
  owner's requirement is only that bypass stays unrestricted, which `-p` satisfies.
- **Keep Kimi disabled for restricted modes.** Kept as the fail-closed fallback in item 3.

## Consequences

- B-1 clears (Delegated); T4.62 to T4.67 and T4.69 are unblocked as Planned, T4.68 stays operator-only.
- The registry entry for Kimi declares `-p`/`--prompt` as bypass-class; any compile that includes them outside the
  approved scope is refused before spawn.
- Cells needing a model call (stream-json shapes, exit codes, permission round trip) remain `Unverified: T4.68`.

## Revisit when

- T4.68 observes the permission round trip, the `-p` exit codes or the `stream-json` records.
- A Kimi release adds a non-bypass headless mode or a per-run permission-rule flag.
