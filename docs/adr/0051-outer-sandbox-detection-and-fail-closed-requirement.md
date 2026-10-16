# ADR-0051: Outer sandbox: detection, an opt-in requirement that fails closed, and its limits

- Status: Proposed
- Date: 2026-10-16
- Decided by: Delegated (agent, 2026-10-16, under [owner decision 25](../ROADMAP.md#42-owner-decisions); not
  owner-approved). Q-22 stays open for zemdregon; nothing here makes the outer sandbox a required dependency.
- Related: T3.1, T3.11, R-8, R-10, R-23, FR-POL-06, FR-EXE-08, NFR-SEC-06, Q-22, owner decisions 10 and 11,
  [TDD §3.4](../design/TDD.md#34-security-engineering), [LLD §8.4](../design/LLD.md#84-outer-sandbox-m3-t31),
  [ADR-0004](0004-trust-profiles-no-bypass-flags.md), [ADR-0017](0017-approved-privileged-scope-bypass.md)

## Context

T3.1 asks for an evaluation of an outer sandbox around the provider process and around verification commands: bubblewrap,
Landlock and `prlimit`, with availability detection and a fail-closed rule where a profile or the configuration requires
it. The motivating gaps are R-8 (no per-run CPU, memory or disk limit), R-10 (Claude Code has no documented native
sandbox, so it is `Ineligible` for `test-sandboxed`), R-23 (a Codex run could read `~/.codex` under its own sandbox) and
FR-POL-06 (no arbitrary shell for an untrusted profile unless commands are kept away from the provider's credentials).
Owner decisions 10 and 11 make the outer sandbox optional hardening, not a prerequisite (Q-22).

Host facts checked on the Ampere operator host on 2026-10-16 (Ubuntu 26.04, kernel 7.0, aarch64): `/usr/bin/bwrap`
reports `bubblewrap 0.11.1`; `/usr/bin/prlimit` reports `prlimit from util-linux 2.41.3`; `/sys/kernel/security/lsm`
lists `landlock`; `kernel.apparmor_restrict_unprivileged_userns = 1`, yet `bwrap --ro-bind / / --dev /dev --proc /proc
--unshare-all --die-with-parent true` exits 0 there. CI runners and other hosts may have none of these.

## Decision

1. **Mechanisms.** bubblewrap provides the filesystem view (read-only root, the run's worktree writable, chosen paths
   hidden) and the namespaces; `prlimit` provides per-process resource limits for R-8. Landlock is evaluated, detected
   and reported, but not applied: Node.js exposes no Landlock system call, applying it needs a native helper this
   project does not have, and bubblewrap's mount namespace already gives the filesystem view. The Landlock ABI version
   is reported as unknown rather than guessed.
2. **Detection is a working probe, never an assumption** (`src/exec/outer-sandbox.ts`). A mechanism is available only
   when it is shown working on this host: `bwrap` and `prlimit` are looked up on the daemon's `PATH` and each runs `true`
   (bubblewrap with every namespace unshared, so a host that blocks unprivileged user namespaces reports it as
   unavailable); Landlock counts as available when the kernel's active LSM list names it. Not Linux, not on `PATH`, a
   failing or timed-out probe (5 s) or an unreadable LSM list all give "unavailable" with a reason. Detection never
   throws.
3. **Configuration.** `outer_sandbox.required_profiles` lists the non-privileged profiles that must not run without the
   outer sandbox ([LLD §8.4](../design/LLD.md#84-outer-sandbox-m3-t31)). It is empty by default, so nothing changes for
   a configuration that does not set it. `privileged` cannot be listed: bypass runs (ADR-0017) are unchanged by this ADR.
4. **Fail closed at admission.** A listed profile is refused by the profile resolver before any run row, worktree or
   process exists, with the existing code `ELIGIBILITY_NONE` (FRD BR-3, "profile unsupported"); no new taxonomy code
   is added, so [LLD §4](../design/LLD.md#4-failure-taxonomy) is unchanged. The message names the reason:
   `OUTER_SANDBOX_UNAVAILABLE` when bubblewrap or `prlimit` is missing (with each probe's result), otherwise
   `OUTER_SANDBOX_NOT_ENFORCED`. **This build wraps no process in the outer sandbox**, so until wrapping lands a listed
   profile is refused even on a host where both tools work: a run is never started unconfined under a configuration
   that requires confinement, and Switchboard claims no control it does not enforce. `list_capabilities` leaves a
   refused profile out of `supported_profiles`.
5. **`doctor` reports availability** of each mechanism on every run (check `outer_sandbox`): `ok` when no profile
   requires it, `fail` when a listed profile's mechanism is missing, `warn` when everything is present but runs are
   still refused because they are not yet wrapped. `serve` detects once at startup, only when the list is not empty,
   and logs a warning naming the profiles.
6. **Wrapping is follow-up work.** Verification commands are wrapped by T3.11. Wrapping the provider process itself
   needs a roadmap task that does not exist yet (*Proposed*); when either lands, the `OUTER_SANDBOX_NOT_ENFORCED`
   refusal is replaced by the wrapped run for that path only.

## Limits (what the outer sandbox cannot do)

- **Credentials the CLI itself needs.** A provider CLI must read its own login (for example `~/.claude` or `~/.codex`)
  and send it to the provider. The sandbox has to expose that store to the CLI process, and every command the agent
  runs is a child of that process inside the same sandbox. The outer sandbox therefore cannot keep agent-run commands
  away from the CLI's credentials; it can only hide other files (SSH keys, other providers' stores, Git push
  credentials). FR-POL-06's credential gap for a CLI's own store stays with the provider's native sandbox and the live
  checks (T3.9).
- **Network use it cannot tell apart.** The CLI needs the network to reach its provider. bubblewrap's network control is
  all or nothing (`--unshare-net` also cuts the provider off), so it cannot distinguish provider API traffic from an
  agent command sending data elsewhere. Landlock's network rules are by TCP port, not by host (Assumption, from the
  kernel documentation; not verified here). A per-host filter would need a proxy and is out of scope.
- **Resource limits are per process.** `prlimit` sets `RLIMIT_*` values on one process tree: `RLIMIT_FSIZE` bounds one
  file, not a run's total disk use, and `RLIMIT_NPROC` counts every process of the user, not of the run. R-8's per-run
  disk quota is not solved by `prlimit` alone.
- **Linux only.** macOS has none of these mechanisms; every mechanism reports unavailable there, and a listed profile
  is refused.

## Alternatives considered

- **Make the outer sandbox required for some profiles by default.** Rejected: owner decisions 10 and 11 make it optional
  and Q-22 is open; a default requirement would refuse runs on every host without the tools.
- **Run unconfined with a warning when a required mechanism is missing.** Rejected: fails open; the roadmap row asks for
  the opposite.
- **Accept a listed profile when the tools are present, before any wrapping exists.** Rejected: it would claim a control
  that is not enforced.
- **A new taxonomy code such as `SANDBOX_UNAVAILABLE`.** Rejected: BR-3 already maps an unsupported profile to
  `ELIGIBILITY_NONE`, and a new code needs an LLD §4 change for no client benefit; the reason is in the message.
- **Apply Landlock through a helper binary.** Deferred: a new native dependency for a control that bubblewrap already
  covers on the filesystem side.

## Consequences

- An operator can make a profile unusable on a host that lacks the outer sandbox, and `doctor` says why.
- With the requirement set, listed profiles are refused on every host until the wrapping tasks land; this is deliberate.
- R-8, R-10, R-23 and the FR-POL-06 gap are not closed by this ADR; it records the mechanism choice, the detection and
  the limits that any later wrapping inherits.
