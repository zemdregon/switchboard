# Live checks 2026-10-19: Codex native resume (T5.12 cells 1 to 5) and the T5.11 live pair, Codex in a container

Status: research input (historical record once written). Run by an agent (Claude Opus 5.5, Delegated) on the
operator's Ampere server (Ubuntu 26.04.1, aarch64) through the operator's `live-run-ext.sh` channel. Everything here was
**observed** on 2026-10-19 unless it is labelled an inference. The roadmap owns status
([ROADMAP §6.9](../ROADMAP.md#69-m5-continuity-tasks)). Verdicts are Delegated findings, not owner decisions. The cells
are those of ROADMAP T5.12 and [TDD §4.10](../design/TDD.md#410-native-resume-inventory-t50). The Claude Code half of
T5.12 is in [live-checks-2026-10-17-claude.md](live-checks-2026-10-17-claude.md).

## Where Codex ran (decision 71)

- **Codex ran inside a container, never on the host.** Under ROADMAP §4.2 decision 71, the ext channel runs every
  Codex call through an operator shim outside the repository. The shim runs the pinned argv verbatim as `codex` in
  `docker run --rm -i --init --user 0`, with the network on. The host Codex login (whose quota stop runs to
  2026-10-22) was not used.
- **Image:** `sb-live-codex:t10.0-git` (image id `sha256:5194070ba225…`). It is built `FROM sb-login-codex:t10.0` (the
  T10.0 login image, codex-cli **0.162.0**, inside the manifest range `>=0.162.0 <0.163.0`) and adds only `git`
  (2.39.5). **The Git-free login image `sb-login-codex:t10.0` was not used for these runs.** It was not rebuilt or
  changed (its id is still `sha256:3d3beb541bd4…`). It was used only for the no-model `codex login status` probe before
  the runs, which printed `Logged in using ChatGPT`.
- **Login:** the `sb-login-codex` volume, mounted at `/root/.codex` with `CODEX_HOME=/root/.codex`. This is the
  `container-login.sh` form; the orchestrator's form, `-v sb-login-codex:/root -e CODEX_HOME=/root`, holds the same
  volume content. No credential file was read, copied or printed. Codex itself writes its session files under its
  `CODEX_HOME`, which is how a resume in a second container finds the thread.
- **Host mounts:** exactly one directory per call, at the same path, with `-w` set to the real path of the cwd. For
  the resume cells this was the run's throwaway `r/` directory, which holds the repository, its second worktree and
  the empty directory, so cell 2's worktree `.git` file resolves. For the pair it was the script's `mkdtemp` directory
  (`switchboard-pair-*`), which holds the repository and the `data_dir` worktrees. `$HOME`, the temp root and every
  credential path were never mounted.
- **Model:** every model call was pinned by the channel to the operator's cheapest Codex model with low reasoning
  effort. The channel recorded 8 pinned calls for the resume check and 1 for the pair, with 0 refused.

## Method (resume cells)

- **Workspace:** a throwaway Git repository with one commit (`R`), a second worktree of it (`WT`) and an unrelated empty
  directory (`E`). All of them were in a temporary directory that was removed afterwards.
- **Fixed argv:** the adapter's form, `codex exec --json <flags> [resume <id>]`, with the prompt on stdin.
  `RO` = `--sandbox read-only --ignore-user-config --ignore-rules`. No bypass flag was used.
- **Recorded:** the exit code, the `thread.started` id, the event types, the status and exit code of each command
  item, error strings, and whether the probe file exists. No transcript text was kept. Thread ids are replaced by
  stable placeholders (`<id-1>`, …), so "same id" stays visible without the id itself.
- **What this is not:** these turns are plain CLI turns, not Switchboard's compiled argv (which compiles the same
  flags, see the TDD §4.10 note on what Switchboard emits on resume).

## Results (resume cells, codex-cli 0.162.0)

| Cell | Turn | Directory | Flags | Exit | `thread.started` id | Command items | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1a new | `R` | `RO` | 0 | `<id-1>` | none | `turn.completed` |
| 1 | 1b `resume <id-1>` | `R` | `RO` | 0 | `<id-1>` | none | `turn.completed`; **same id returned** |
| 2 | 2a `resume <id-1>` | `WT` (second worktree) | `RO` | 0 | `<id-1>` | none | `turn.completed`; **session found** |
| 2 | 2b `resume <id-1>` | `E` (unrelated empty dir) | `RO` + `--skip-git-repo-check` | 0 | `<id-1>` | none | `turn.completed`; **session found** |
| 3 | 3a new: "create c3.txt" | `R` | `RO` | 0 | `<id-2>` | 1, `failed`, exit 1 | no file |
| 3 | 3b `resume <id-2>`, same request, **`--sandbox` omitted** | `R` | `--ignore-user-config --ignore-rules` | 0 | `<id-2>` | 1, `failed`, exit 1 | `c3.txt` **not created** |
| 4 | 4 `resume <id-2>`: "create c4.txt" | `R` | **`--sandbox workspace-write`** `--ignore-user-config --ignore-rules` | 0 | `<id-2>` | 1, `failed`, exit 1 | `c4.txt` **not created** |
| 5 | 5 `resume` of an unknown id | `R` | `RO` | **1** | none | none | no JSONL event; stderr `Error: thread/resume: thread/resume failed: no rollout found for thread id <id-3> (code -32600)` |

Each turn's stderr began with `Reading prompt from stdin...`. After all cells the throwaway repository had only
`refs/heads/main` and `refs/heads/wt`, so no commit or ref was made.

## Results (T5.11 live pair, `SWITCHBOARD_LIVE_PAIR=claude:codex`)

Claude Code 2.1.294 (host login) took the first run, and Codex (in the container, as above) continued it from the
handoff bundle through `continue_task`. The script reported **7 held, 1 failed, 0 not checked** and exited 1:

| Check | Result | Detail |
| --- | --- | --- |
| P-0 both providers installed, in range, logged in | HELD | probe, gate and auth (codex-cli 0.162.0, auth OK) |
| P-1 `delegate_task` to Claude is admitted and succeeds | HELD | `SUCCEEDED` |
| P-2 `continue_task` naming Codex is a handoff from Claude | HELD | `provider_named`, `provider_preference` |
| P-3 the Codex run succeeds from the bundle | HELD | `SUCCEEDED` |
| P-4 the handoff run's envelope names a `handoff_view` artifact | HELD | |
| P-5 `get_artifacts` returns the `handoff_view` with a SHA-256 | HELD | |
| P-6 one binding per provider, Claude first and Codex second | HELD | |
| P-7 `PAIR-B.md` written by Codex is on the newest result branch | **FAILED** | missing |

The Codex run was compiled for `edit-untrusted` (`--sandbox workspace-write --ignore-user-config --ignore-rules`, no
bypass flag). It ended `SUCCEEDED`, but the file it was asked to write did not land.

## Why no sandboxed Codex write succeeded (inference, not observed from Codex's own error text)

Inside the container, every command that Codex ran under its sandbox failed with exit 1: in cell 3a (read-only, where
this is expected), in 3b, in 4 (`workspace-write`) and in the pair's `workspace-write` run (P-7). A diagnostic with no
provider CLI and no model call found that codex-cli 0.162.0 ships a vendored `bwrap`
(`@openai/codex-linux-arm64/vendor/…/codex-resources/bwrap`). It also found that the container cannot create a user
namespace: `unshare -U true` fails with `Operation not permitted`, under rootless Docker's default seccomp profile, and
the host has `kernel.apparmor_restrict_unprivileged_userns = 1`. bubblewrap needs a user namespace. So the most likely
cause is that Codex's Linux sandbox cannot start in this container, and every sandboxed command fails whatever
`--sandbox` value is in force. Codex's command output was not captured, so this cause is an **inference**. It means
that cells 3 and 4 and P-7 do not show anything about resume semantics. They show that the container did not allow a
sandboxed write. The container was not given extra privileges (no `--privileged`, no seccomp or AppArmor change) to
work around this, because that would weaken a security boundary without a ruling.

## Verdicts (T5.12, Codex)

| Cell | Verdict | Reason |
| --- | --- | --- |
| 1 Resume from the same directory | **PASS** | Same thread id returned, exit 0. The adapter's form (exec-level flags before `resume <id>`, prompt on stdin) works on 0.162.0 |
| 2 Second worktree and unrelated empty directory | **PASS** | The session was found from both (same id, exit 0), so it is not tied to the cwd. The empty directory needs `--skip-git-repo-check`, which Switchboard never compiles because its runs are always in a worktree |
| 3 Sandbox flag of the first run omitted, same denied request | **FAIL** | The cell ran, and 3b's write failed like 3a's (no file). This does not show whether the first run's read-only mode still applies: in this container no sandboxed write succeeded, not even under `workspace-write` (cell 4, P-7), and Codex's default sandbox without the flag was not observed separately |
| 4 Different flags on resume (`--sandbox workspace-write`) | **FAIL** | The cell ran, and no `c4.txt` was created. "Which set applies" is not answered, for the same container reason. This is not evidence that the first run's sandbox carries over |
| 5 Unknown id | **PASS** | Exit 1, no JSONL event, stderr `thread/resume failed: no rollout found for thread id <id> (code -32600)` |
| T5.11 live pair (claude → codex) | **FAIL** | P-0 to P-6 held and P-7 failed: the Codex run succeeded from the handoff bundle, but its file write did not land (most likely the sandbox, as above) |

**TDD §4.10 cells (Codex 0.162.0):** resume form, observed (cell 1). Tied to the working directory: **No** (cell 2),
so the adapter now declares `resumeCwd: 'independent'`. Sandbox and permission flags on resume: **not established**
(cells 3 and 4 FAIL for the container reason). The adapter keeps re-sending every policy flag on every resume, which
it does by construction (fail closed, NFR-SEC-06). Unknown id: exit 1 with the stderr text above.

**What would answer cells 3 and 4 and P-7:** a re-run where Codex's sandbox can start. That could be the host login
after its quota reset, or a container with a user-namespace allowance. The second option changes a security posture
and needs a ruling first. This residual is listed in ROADMAP §6.9.2.

## Budget

There were two channel runs, one for each check, and no retry. `resume codex`: exit 0, 53 s, 8 model calls. `pair`:
exit 1, 33 s, 1 Codex model call and 1 Claude model call. No limit text was detected and no `live-limit-until` marker
was written.
