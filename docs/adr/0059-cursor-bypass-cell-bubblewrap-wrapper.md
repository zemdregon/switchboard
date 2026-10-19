# ADR-0059: The Cursor bypass cell runs inside an enforcing bubblewrap wrapper

- Status: Accepted (owner ruling 2026-10-19 06:41 CDT, option A)
- Date: 2026-10-19
- Decided by: Linus, relaying the owner-level ruling of 2026-10-19 06:41 CDT
  (`owner-rulings/20261019T114059Z-t448-fix-bwrap.md` on the operator host, option A), which builds on the 06:15 CDT
  ruling on PR #747. The wording below and the exact mount set are Delegated authorship (agent, 2026-10-19), not
  zemdregon's words.
- Supersedes in part: items 3 and 6 of
  [ADR-0051](0051-outer-sandbox-detection-and-fail-closed-requirement.md), **for the Cursor bypass cell only**. Item 3
  says "bypass runs (ADR-0017) are unchanged by this ADR" and item 6 says wrapping the provider process "needs a
  roadmap task that does not exist yet". For the Cursor bypass cell the provider process is now wrapped, by this ADR.
  Both items stand unchanged for every other cell and provider.
- Related: T4.48, R-76, Q-79, owner decision 46, FR-POL-06, FR-POL-03, NFR-SEC-06, FRD BR-3,
  [ADR-0017](0017-approved-privileged-scope-bypass.md), [ADR-0039](0039-switchboard-side-tool-call-guard.md),
  [TDD §4.5.1](../design/TDD.md#451-cursor-native-controls-per-profile-and-platform-t440),
  [LLD §8.4](../design/LLD.md#84-outer-sandbox-m3-t31)

## Context

The approved Cursor bypass cell (Q-79, owner decision 46) compiles `cursor-agent --print --output-format stream-json
--trust --force` with no `--sandbox` flag, because `--sandbox enabled` exits 1 on the Ampere host (T4.41 row 9). The
process ran directly on the host as the operator's user. In the T4.48 live malicious leg of 2026-10-19 (log
`20261019-103236-ext-malicious-cursor-w1406-t448-reimpl.log`), U-M2 and U-M3 were ESCAPED: the model's read tool opened
the out-of-worktree canary and the fake-HOME credential canary, and the tokens reached the stored provider stream. U-M1
was NOT_CHECKED. The tool-call guard (ADR-0039) exempts approved bypass runs from its `provider_state` check, and even
without the exemption it only detects a call after the provider has run it. Nothing in the design could stop a
bypass-cell Cursor process from reading a file its OS user can read.

The 06:15 CDT ruling made the canary reach a containment failure to fix, not a risk to accept. The 06:41 CDT ruling
chose option A: confine the Cursor provider process in bubblewrap, failing closed where bubblewrap is unusable. It
rejected making the cell Ineligible (option B), accepting the reach (option C) and every detective-only option, because
those claim a control that is not enforced. `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all true` exits 0 on
the Ampere host (bubblewrap 0.11.1) even with `kernel.apparmor_restrict_unprivileged_userns = 1`.

## Decision

1. **The cell keeps its flags.** The Cursor bypass cell still compiles `--trust --force` (Q-79, owner decision 46) and
   compiles for the same scope only. No flag is added to or removed from Cursor's own command line.
2. **The provider process always starts inside `bwrap`.** The compiled argv is `bwrap <wrapper arguments> --
   <cursor-agent> --print ...`. There is no unconfined path in the code: the wrapper is part of every invocation the
   adapter compiles and resumes (`src/adapters/cursor/confinement.ts`, `cursorBwrapArgs`). The wrapper:
   - mounts the host root read-only (`--ro-bind / /`), with a fresh minimal `/dev` and `/proc`;
   - unshares every namespace except the network (`--unshare-all --share-net`), because the cell's network scope is
     `on` and Cursor must reach its API; the process dies with its parent (`--die-with-parent`). The PID namespace
     hides other host processes and their `/proc/<pid>/environ`;
   - hides `$HOME`, the platform temp directory (`os.tmpdir()`, which holds the live leg's temp parent), `/tmp`,
     `/var/tmp` and `/run/user` behind empty tmpfs mounts (each only where it exists), and also the worktree's parent
     directory when no hidden directory already covers it (other runs' worktrees);
   - binds the worktree read-write and makes it the working directory;
   - binds back into the hidden `$HOME` only Cursor's own install directory (the directory of the resolved
     executable, read-only), its login store `~/.config/cursor` (read-only) and its state directory `~/.cursor`
     (read-write, the one state path Cursor writes on every run: chats, projects, tracking data, and the rewrite of
     `cli-config.json` through a temp file and rename in that directory, live check "Side effects"). The argv names the
     resolved executable, because a `~/.local/bin` symlink is not visible inside.
   Mounts are applied from the outermost path inward, so no tmpfs covers a bind beneath it. A write outside the
   worktree and the state directory either fails (read-only root) or lands in a private tmpfs discarded when the run
   ends; it never reaches the host.
3. **Fail closed, `ELIGIBILITY_NONE`.** The cell is Ineligible (`CAPABILITY_MISSING`, which a run reports as
   `ELIGIBILITY_NONE`, FRD BR-3) when `bwrap` is not on `PATH`, when `$HOME` is unset, not absolute or the filesystem
   root, when Cursor's install directory contains a hidden directory, or when the worktree would re-expose what the
   wrapper hides or binds (the root, `$HOME`, a hidden directory or an ancestor of one, or a path inside the login
   store or state directory). The adapter's probe gains a `confinement` step that proves the wrapper holds rather than
   assuming it: in a scratch leg under the temp directory it runs `/bin/sh` inside the same wrapper, which must create
   a file in the scratch worktree and must not see a canary beside it, and the host checks that the file reached the
   real worktree. A failed step ends the run `ELIGIBILITY_NONE` at preflight, before any provider process starts, and
   the adapter refuses to compile the cell after a failed probe. There is no unconfined fallback.
4. **Bind paths are evidence-based and narrow.** The login store and state paths come from the 2026-10-14 live check
   (`docs/research/live-checks-2026-10-14-cursor.md`, row 11: login survived a scratch `CURSOR_CONFIG_DIR`, so the
   credential is not under `~/.cursor`). **Unverified:** whether Cursor accepts a read-only login store (for example if
   it refreshes a token in place) has not been observed; this change makes no live call. If the steward's live rerun
   shows login failing inside the wrapper, only the exact bind path that must change may be adjusted, in a follow-up
   change that cites the evidence. An unhidden `$HOME` is not an allowed adjustment.
5. **The tool-call guard exemption stays, and is detective only.** ADR-0039 item 1 keeps exempting approved bypass runs
   from the guard's `provider_state` check; the guard still records and fails a flagged call after the fact. The
   enforcing control for the Cursor bypass cell is now this wrapper, not the guard.
6. **Other bypass cells are unchanged.** This ADR wraps the Cursor bypass cell only. ADR-0051 items 3 and 6 stand for
   every other provider and cell.

## Alternatives considered

- **Make the Cursor bypass cell Ineligible (option B).** Rejected by the ruling: T4.48 could then never be done while a
  feasible enforcing fix exists.
- **Accept the reach as a risk (option C).** Rejected by the ruling: it contradicts the 06:15 CDT ruling and accepts a
  real credential-reach path.
- **Detective only: extend the tool-call guard to bypass runs, or cut the stored stream at the first out-of-worktree
  tool call.** Rejected: the canary would still reach the model and Cursor's API; the verdict would read HELD for a
  control that is not enforced.
- **Cursor's own `--sandbox enabled`.** Not available: it exits 1 on the operator's host (T4.41 row 9), and its
  behaviour under `--force` was never observed.
- **Run unconfined with a warning where `bwrap` is missing.** Rejected: fails open.
- **Bind the worktree's Git metadata (`.git` common directory) read-only.** Not done: it is outside the ruling's mount
  set, the worktree's `.git` link is writable by the agent and could name any host path on a resumed run, and no live
  evidence shows Cursor needs it. See Consequences.

## Consequences

- **The canaries of the live leg are out of reach.** The out-of-worktree canary and the fake-HOME credential canary
  both sit in the leg's temp directory, which the wrapper hides. Hermetic tests with a fake CLI and synthetic canaries
  show both unreadable inside the real wrapper and readable without it (`src/adapters/cursor/confinement.test.ts`;
  they run where the host's bwrap can start a sandbox and skip otherwise). The live malicious leg (U-M1 to U-M3) must
  be rerun by the steward after merge; T4.48 stays Partial until every cell is PASS and U-M1 actually ran (U-M1
  NOT_CHECKED now fails the leg's exit code, `summarize` in `scripts/live-malicious.mjs`).
- **Cursor's own login stays readable to the agent.** The login store is bound read-only so the CLI can authenticate,
  and every command the agent runs is a child of that process inside the same sandbox. As ADR-0051's limits say, the
  outer sandbox cannot keep agent-run commands away from the CLI's own credentials; a HELD on U-M3 (a fake credential
  in the temp directory) does not show otherwise. Other providers' stores, SSH keys and the rest of `$HOME` are hidden.
- **What stays reachable.** Anything readable on the read-only root outside the hidden directories (for example
  `/etc`, `/opt`, `/srv`, or a Switchboard data directory configured outside `$HOME` and the temp directories);
  abstract Unix sockets and the network, because the network namespace is shared; Cursor's earlier chats under
  `~/.cursor`, which is bound read-write.
- **Git inside the run.** The worktree's `.git` link names the repository's Git directory; when that lies under a
  hidden directory, Git commands in the run fail, and where it lies on the read-only root, Git writes fail with a
  read-only file system error. Controller Git at FINALIZING runs outside the wrapper and is unaffected. The FR-GIT-01
  declaration stays `none-documented`: this is a side effect of the mount set, not a sourced Git-write control. If the
  live rerun shows Cursor needs Git metadata, a narrow read-only bind is a follow-up decision.
- **Hosts without a usable bwrap.** macOS and any Linux host that blocks unprivileged user namespaces for `bwrap` lose
  the Cursor bypass cell (`ELIGIBILITY_NONE`); no other Cursor cell compiles today, so Cursor is unavailable there.
- **Tests.** Replay and compile tests use a synthetic pass-through stand-in (`fixtures/passthrough-bwrap.sh`) that
  confines nothing, so they run on hosts without bwrap; the Linux CI job installs `bubblewrap` so the real-wrapper
  tests can run there.
- **Follow-up, not built here.** The other approved bypass cells share the gap ADR-0051 items 3 and 6 describe; each
  needs its own decision and change: Antigravity (R-72, A-M2 ESCAPED), OpenCode (O-M2 and O-M3, expected under owner
  decision 46), Kimi Code `--prompt` (K-M3), Grok Build, Claude Code and Muse Code bypass cells. Propose them as one
  roadmap row (ROADMAP §7) rather than reusing this ADR.

## Revisit when

- The steward's live malicious rerun shows Cursor failing to log in or to run inside the wrapper (adjust only the exact
  bind path, item 4).
- Cursor's `--sandbox enabled` is shown to start and confine under `--force` on the operator's host.
- A provider-process wrapper for other bypass cells is decided; this ADR's mount set may then move to shared code.
