# Security and trust

Trust profiles, the security model and the single-operator, own-accounts position. Part of the [Switchboard guide](README.md).

## Trust profiles

A trust profile says what a delegated agent may do ([ADR-0004](../adr/0004-trust-profiles-no-bypass-flags.md)). Each
adapter compiles the profile into the provider's own permission and sandbox controls.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | yes | Read-only file access, network off, repository-provided config disabled. Claude Code gets no shell. Codex runs commands inside its read-only native sandbox (see below). |
| `edit-untrusted` | yes | Edits inside an isolated Git worktree, network off, repository config disabled. Claude Code gets no shell, because the shell allowlist is empty. Codex runs commands inside its `workspace-write` native sandbox (see below). |
| `test-sandboxed` | no | Both adapters refuse it (`PROFILE_UNSUPPORTED`, reported as `ELIGIBILITY_NONE`): neither provider shows confinement for it yet (`src/adapters/claude/adapter.ts`, `src/adapters/codex/adapter.ts`). |
| `trusted-development` | only some settings | Each adapter compiles the settings it can express (for example Codex only with a `broad` shell) and refuses the rest with `ELIGIBILITY_NONE`; `list_capabilities` shows which profiles each provider supports on this host. |
| `privileged` | yes, per provider | Above the client's `max_trust_profile`: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or, for a client with `privileged_approval: "not_required"`, starts at once). An approved run is compiled by its provider's adapter from the approved scope; a provider that cannot express the scope fails the run `ELIGIBILITY_NONE` before any process starts. |

A request above the client's `max_trust_profile` also fails `PERMISSION_BLOCKED`.

**Verification commands.** `delegate_task` may pass `verification_commands`, a list of argv arrays such as
`[["npm", "test"]]`. After the agent finishes successfully, Switchboard runs them one after another in the run's
worktree, with no shell (`;`, `$( )` and `*` are passed literally), the run's environment allowlist (no `GIT_*`,
SSH-agent or GnuPG variables) and the run's wall-clock limit. The first command that fails, times out or cannot start
ends the run `FAILED` with `TEST_FAILURE`; the agent's own summary is kept. `get_run` shows each command's outcome and
exit code, and `get_artifacts` returns the full output as a `test_report` (at most 1 MiB per stream, secret patterns
redacted). Since T8.10 each stored report also records the commit and tree the commands ran on (`head_sha`, null when
the worktree differs, and `tree_sha`); `get_run` exposes the newest pin as `verification.verified_at_sha`/`tree_sha`
with `stale` when the run's published ref has since moved, and a run of the example `docs-alignment` skill stores its
report as a `docs_alignment` artifact ([LLD §20.6][t810]). `cancel_run` stops a running command, and a controller
restart ends the run `PROCESS_CRASH` without running
the commands again. They are refused under `inspect-untrusted`. **They run on your host as your user, outside any
provider sandbox** (ROADMAP owner decision 11, R-24): they can read your files and use the network. Supply them only for
repositories you trust. A Git ref they move is reported as a policy violation and controller refs are put back, but a
push they make cannot be seen. **Optional confinement:** set `SWITCHBOARD_CONFINED_VERIFICATION=1` in `serve`'s
environment (there is no config key yet) and the commands run inside bubblewrap instead: the worktree stays writable,
the rest of the host is read-only and every namespace, network included, is unshared. Without a working `bwrap` the
commands do not run and the run ends `TEST_FAILURE`; they never fall back to running unconfined. `doctor` reports
whether bubblewrap is usable. Confinement does not hide files your user can read (ROADMAP T3.11, ADR-0051).

[t810]: ../design/LLD.md#206-head-pinned-verification-evidence-and-the-docs-alignment-skill-fr-exe-10-fr-skl-11-t810

**Verification slots.** Set any `limits.verification_*` key (ROADMAP T3.22, FR-EXE-09) and the verification commands of
every run on this host share that many slots (default 2): a run with no free slot waits in `VERIFYING` (recorded as a
`verification_wait` run event) inside its wall-clock limit, runs its commands at the lower `limits.verification_nice`
priority (default 10), and passes `limits.verification_env` variables through the allowlist. With no such key set,
verification behaves exactly as above. Detail:
[LLD §8.1](../design/LLD.md#81-verification-stage-m3-t310).

**Codex and the shell.** Codex has no command allowlist that Switchboard can set, so under both untrusted profiles the
Codex agent can run shell commands inside Codex's own sandbox. Whether that sandbox keeps those commands away from
Codex's credential store (`~/.codex`) and other files your user can read has **not been verified**. If you delegate
untrusted repositories, prefer Claude Code, or set `providers.codex.enabled` to `false`, until the live check planned
for milestone 3 settles it (ROADMAP R-23). A first live check on 2026-10-13 (not yet the operator's T3.9 suite)
found that, under `--sandbox workspace-write`, a canary file outside the workspace **could be read** and `/tmp` **could
be written**, while writes elsewhere, the network, Unix sockets and Git metadata were blocked
([live checks](../research/live-checks-2026-10-13.md), check 12).

**Profile overrides.** `profiles.<name>` in the config may loosen a profile's defaults, but only explicitly, with the
change recorded in every run's policy snapshot and reported by `doctor`. **Known limit:** a `profiles.edit-untrusted`
override that loosens `network` or `repo_config` is not enforced. Claude Code still runs `edit-untrusted` with the
network off (at the tool level) and repository configuration disabled, whatever the override says; Codex refuses such a
run (`ELIGIBILITY_NONE`). Use `trusted-development` or a `privileged` scope for that work (ROADMAP owner decision 20).

**Privileged runs.** A `privileged` request carries a machine-readable `privileged_scope` (file access, shell commands,
network hosts and repository configuration, plus a `bypass` setting that defaults to off) and waits for
`switchboard approve <run_id>`. A provider bypass flag such as `--dangerously-skip-permissions` is passed only when the
approved scope explicitly sets `bypass` ([ADR-0017](../adr/0017-approved-privileged-scope-bypass.md)). For Claude
Code an approved bypass run drops `--restricted`, which refuses bypass, and keeps the other isolation flags
([ADR-0018](../adr/0018-claude-bypass-omits-restricted.md)). Claude's Git deny rules held under bypass in a live
check on 2026-10-13 (six commit and ref spellings, directly and through `serve` with an approved scope; checks 14 and
16 in [the live checks](../research/live-checks-2026-10-13.md)), and the T3.9 Claude legs on 2026-10-18 and
2026-10-19 held C-G2 at the outcome level only (an `edit-untrusted` commit task left `main` and the refs unchanged,
but no `Bash` was in `--tools`, so the deny-rule matcher itself was not exercised; the 2026-10-19 C-M3 rerun under
an approved bypass scope with `Bash` and the Git deny rules left the refs unchanged at the outcome level, but the
commit attempt itself was not confirmed, and the same run printed an out-of-worktree canary — `ESCAPED`, recorded
as ROADMAP R-74; see
[the live checks](../research/live-checks-2026-10-19-t39-malicious.md) and ROADMAP T3.9), so the
deny-rules-under-bypass claim still rests on the 2026-10-13 checks of one version (ROADMAP R-38). That gap concerns
agents running on your host.
Container environments (milestone 10, **`Partial` on `main`**) are meant to close it: their image has no Git client,
they mount neither the repository's Git directory nor any credentials, and Switchboard makes commits and pushes on the
host through its own tools (ROADMAP owner decision 24). The malicious-fixture container leg and validate/GC checks are
in CI; MCP admission for a `container` project is wired on fakes
([PR #554](https://github.com/zemdregon/switchboard/pull/554)). See
[Container environments (milestone 10)](advanced-features.md#container-environments-milestone-10). Host-run agents
remain supported.
Claude Code compiles a privileged scope only with the network `on`: it has no network control for commands, so a scope
asking for network `off` is refused. Codex does
not run `bypass: true` scopes yet (its bypass option is not documented in the sources the adapter relies on), and
neither provider compiles every scope: `list_capabilities` shows whether a provider compiles `privileged` at all, and a
scope it cannot express fails `ELIGIBILITY_NONE`. Approvals never expire: once approved, later `continue_task` runs of
the same meta-session reuse the approved scope without asking again, so approve only scopes you are content to leave
open for that session. A different scope or a new task asks again.

**Skipping the approval for a client you trust.** The loose modes are meant for operators who want them; the defaults
stay strict for everyone else. Setting `"privileged_approval": "not_required"` on an `mcp_clients` entry whose
`max_trust_profile` is `privileged` lifts the per-scope approval for that client only: its `privileged` requests are
validated, hashed and recorded as usual, then start at once under an approval recorded as decided by
`client_policy:<client id>` ([ADR-0019](../adr/0019-per-client-privileged-approval.md)). Git-write denial and the
run's isolated worktree still apply. Anything that can launch that client's `serve --client` session can then run
privileged work, including bypass scopes, without you reviewing it (ROADMAP R-39), so use it only for an orchestrator
you control. `approve` and `deny` keep working for clients left at `"required"`.

## Security model

- **No credential handling.** Switchboard never reads, copies, logs or exports provider credentials, and does not start
  logins. Probe commands (`doctor`, version and auth checks) run with only `PATH` and `HOME` in their environment.
- **Worktrees.** Edits happen in an isolated Git worktree under the data directory, never directly in your checkout, and
  only for paths under `allowed_roots`.
- **Untrusted profiles by default.** Both available profiles keep the network off and disable repository-provided
  configuration.
- **No bypass flags.** Switchboard does not pass flags such as `--dangerously-skip-permissions`, `--yolo`, `--force` or
  `--full-auto` to provider CLIs, and tests audit this. The one exception is an approved `privileged` scope that
  explicitly sets `bypass` (approved by you, or by a client's `privileged_approval: "not_required"`; see Trust
  profiles).
- **Pushes only through Switchboard's own tool or command.** Agents cannot push; a push-enabled context (off by default)
  pushes one branch, never forced, from the controller with your Git setup, and never hands a credential to an agent.
- **Submodules (opt-in).** With `submodules.mode: "recursive"` the controller, not Git, reads `.gitmodules`; every
  submodule URL must be `https` (or relative to the umbrella's own source) with a host and owner in `project_sources`,
  or the operation is refused with a path-only message. Submodule clones and checkouts run with protocols limited to
  `https`, submodule recursion and hooks off and a scrubbed environment, so repository configuration cannot run code.
  Agents still cannot run `git submodule`; the controller commits and pushes submodules itself, only for paths you
  approved as writable, scans every changed repository for secrets before any push, and never makes a wiki writable. A
  `project_source` grant widens the owner allowlist, so it is opt-in per approver client
  ([ADR-0079](../adr/0079-submodule-projects.md)).
- **Inner-agent privacy.** The inner agent is off by default and is the one place the controller process itself calls
  out. A backend is `local` only if every address it resolves to is loopback; a `remote` backend is unused until you set
  `allow_remote`, and a task that sends repository content (diffs, log excerpts) to a remote backend needs its own
  `allow_source_content`. A project can only restrict it (`off` or `local_only`). Prompts are redacted first, bodies are
  never logged, and nothing it returns reaches a policy, approval or failure decision. Its calls are recorded separately
  as `inner_agent` usage observations and never counted as provider usage or capacity; only a declared
  `shares_subscription_with` records one labelled observation per call against that provider (and `doctor` warns).
- **Retrieval privacy.** The retrieval index is off by default and uses the same locality gates for its embedding
  backend. Chunk text and MCP search results are untrusted reference data; they never reach profile compilation,
  eligibility, approvals, routing, commit or push logic, and a retrieval failure never fails a run. Ledger rows for
  index and search hold counts, ids and hashes only.
- **Run artifacts on disk.** Diffs, verification output and other admitted-run payloads are content-addressed under
  `<data_dir>/artifacts/` as mode `0600` with `0700` shard directories, with secret patterns redacted before write.
  `ArtifactStore` creates and `chmod`s each directory level so a restrictive process umask cannot leave a non-traversable
  tree that makes the next `put` fail ([PR #616](https://github.com/zemdregon/switchboard/pull/616);
  `src/artifacts/artifacts.test.ts`, "succeeds and creates traversable directories under a hostile umask").
- **Fail closed.** An invalid config, an unknown client id, an unverified CLI version or an unavailable profile refuses
  to run rather than weakening anything.

This is a summary of design intent and the implemented checks, not a security guarantee. The controller side is tested
against hostile repository content in CI with a fake provider (`test/malicious/`, ROADMAP T3.8); the isolation of the
real provider CLIs is partly covered by the operator's live leg (ROADMAP T3.9, `Done` 2026-10-19: Claude C-G2 `HELD`
at the outcome level, C-M3 `ESCAPED` (ROADMAP R-74), Codex X-G1 `HELD` and X-M2 `HELD` at the outcome level).
Report vulnerabilities as described in [SECURITY.md](../../SECURITY.md).

## Single operator, your own accounts

Switchboard is designed for **one operator on one machine**, using that operator's own provider logins
([ADR-0011](../adr/0011-single-operator-local-deployment.md), [ADR-0003](../adr/0003-no-credential-handling.md)).
It is not a hosted service, not multi-user, and must not be used to share a login between people.

Switchboard drives the CLIs through the headless interfaces they document. That is a technical statement, not a legal
one. **This project does not claim that any use of it complies with any provider's terms of service.** Whether your use
is allowed under the terms of Anthropic, OpenAI or any other provider is your responsibility; read their current terms.
Commercial, resale, multi-user or credential-sharing use needs your own policy review first.
