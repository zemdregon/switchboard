# Live checks on the operator's machine, 2026-10-17: Claude Code native resume (T5.12 cells 1 to 5)

Status: research input (historical record once written). Run by an agent (Claude Opus 5.5, Delegated) on the
operator's Ampere server (Ubuntu 26.04.1, aarch64), with the installed, logged-in Claude Code **2.1.294**, through the
operator's `live-run-ext.sh resume claude` channel. Everything here was **observed** on 2026-10-17. The roadmap owns
status ([ROADMAP §6.9](../ROADMAP.md#69-m5-continuity-tasks)). Verdicts are Delegated findings, not owner decisions. The
cells are those of ROADMAP T5.12 and [TDD §4.10](../design/TDD.md#410-native-resume-inventory-t50).

## Method

- **Workspace:** a throwaway Git repository with one commit (`R`), a second worktree of it (`WT`), and an unrelated
  empty directory (`E`), all under a temporary directory that was removed afterwards.
- **Fixed argv.** Every turn was `claude -p "<prompt>" --model claude-haiku-5-5 --output-format stream-json --verbose
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'` plus the flags in the table, with stdin `/dev/null`. The model
  is the operator's cheapest Claude model. The empty strict MCP set keeps the operator's account-level MCP servers out of
  the session. No bypass flag was used.
- **Base flags (`RO`):** `--permission-mode dontAsk --disallowedTools "Bash,Edit,Write,NotebookEdit"`.
- **Recorded:** only the `init` and `result` fields shown below, the permission denials' tool names, error strings and
  whether the probe file exists. No transcript text was kept. Session ids are replaced by stable placeholders
  (`<id-1>`, …), so "same id" stays visible without the id itself.
- **What this is not:** these turns are plain CLI turns, not Switchboard's compiled argv (which adds `--safe-mode`,
  `--restricted` and Git deny rules). They answer what the CLI itself does on resume, which is what the TDD §4.10 cells
  ask.

## Results

| Cell | Turn | Directory | Flags | Exit | `init.session_id` / `result.session_id` | `permissionMode` | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1a new | `R` | `RO` | 0 | `<id-1>` / `<id-1>` | `dontAsk` | `success` |
| 1 | 1b resume `<id-1>` | `R` | `RO` | 0 | `<id-1>` / `<id-1>` | `dontAsk` | `success`; **same id returned** |
| 2 | 2a resume `<id-1>` | `WT` (second worktree) | `RO` | 0 | `<id-1>` / `<id-1>` | `dontAsk` | `success`; **session found** |
| 2 | 2b resume `<id-1>` | `E` (unrelated empty dir) | `RO` | 0 | `<id-1>` / `<id-1>` | `dontAsk` | `success`; **session found** |
| 3 | 3a new: "create c3.txt" | `R` | `RO` | 0 | `<id-2>` / `<id-2>` | `dontAsk` | `success`; no denial recorded (Write is not offered); no file |
| 3 | 3b resume `<id-2>`, same request, **`RO` omitted** | `R` | none | 0 | `<id-2>` / `<id-2>` | **`default`** | `success`; `permission_denials: [Write]`; `c3.txt` **not created** |
| 4 | 4 resume `<id-2>`: "create c4.txt" | `R` | `--permission-mode dontAsk --allowedTools Write` | 0 | `<id-2>` / `<id-2>` | `dontAsk` | `success`; `c4.txt` **created** |
| 5 | 5 resume of an unknown id | `R` | `RO` | **1** | none / `<id-3>` | none | `result` `subtype: error_during_execution`, `is_error: true`, `errors: ["No conversation found with session ID: <id-3>"]`; the same text on stderr; no `init` event |

After all cells the throwaway repository had only `refs/heads/main` and `refs/heads/wt`, so no commit or ref was made.

## Verdicts for the TDD §4.10 cells (Claude Code 2.1.294)

| Cell | Verdict |
| --- | --- |
| Resume form | `--resume <session_id>` with the id from `init`/`result` **PASS**: the same id comes back (cell 1) |
| Tied to the working directory | **No**: the session was found from a second worktree and from an unrelated empty directory (cell 2) |
| Permission flags on resume | **Not kept**: each invocation's own flags apply. Resuming without the first run's flags ran in `default` mode (cell 3; Write was denied by the headless `default` mode, not by the first run's deny list). Resuming with an exact `Write` allow rule let Write run (cell 4). So an adapter must re-send its permission flags on every resume; dropping them falls back to the CLI default |
| Sandbox flags on resume | Not applicable: Claude Code has no sandbox flag in this argv (TDD §4.1) |
| Unknown id (FRD WF-2, `classifyFailure`) | exit 1; `result` `error_during_execution` with the error text `No conversation found with session ID: <id>`; no `init` |

Codex (the other half of T5.12) and the T5.11 live pair were **not run**. The first Codex call of the day hit a provider
quota stop whose stated reset is 2026-10-22 06:19 (`live-checks-2026-10-17-claude-codex.md` §3 in
[PR #635](https://github.com/zemdregon/switchboard/pull/635); not a link: the file is not on this branch), and the
channel's limit marker then refused every Codex check.
