# ADR-0057: Dependency seed store: content-hash keyed, built like a verification command, copied never linked

- Status: Proposed
- Date: 2026-10-17
- Decided by: Delegated (agent, 2026-10-17, under [owner decision 25](../ROADMAP.md#42-owner-decisions); not
  owner-approved). Q-103 is answered here only with the Delegated default already recorded in
  [ROADMAP §7](../ROADMAP.md#7-risks-blockers-and-open-questions); it stays open for Linus or zemdregon. No effect on
  bypass runs beyond their worktree gaining a private copy of a seeded directory: the Git-write denial, worktree
  isolation (FR-WS-08) and the compiled provider invocation are unchanged.
- Related: T9.12, T9.13, T3.23, FR-WS-10, FR-WS-01, FR-WS-08, FR-WS-11, FR-EXE-07, FR-EXE-08, FR-EXE-09, FR-PRJ-05,
  Q-103, [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md),
  [ADR-0013](0013-projects-environments-and-contexts.md), [ADR-0052](0052-container-environment-docker-backend.md),
  [ADR-0054](0054-orphan-gc-mark-first-ledger-table.md),
  [LLD §5.1](../design/LLD.md#51-dependency-seeds-fr-ws-10-proposed-t912)

## Context

Every write-capable run gets a fresh Git worktree from a recorded base checkpoint (FR-WS-01, ADR-0006), and every
concurrent run of a project gets its own (FR-WS-08). Ignored directories that a project needs before anything works
(`node_modules`, a virtual environment, a vendored toolchain) are therefore missing in every run, and each agent spends
its first minutes, and its tokens, reinstalling them. FR-WS-10 lets a project declare such a directory once, with the
lockfile it derives from and the command that produces it, and asks the controller to fill it in from a store.

That store is new persistent state at a trust boundary. Its contents are produced by running project code (an install
command reads the repository and usually the network), it outlives the run that built it, and its contents reach later
runs of other meta-sessions, some under a weaker trust profile than the run that built it and some inside containers.
Three ways it could go wrong decide the design:

1. **A run writes through to the store.** Under an untrusted profile on `host` the agent runs as the operator's uid. A
   hardlinked file can have its mode changed and be written through, which changes the store and every other worktree
   holding the same inode; a symlink into the store is the same hole with one more step (Q-103).
2. **A run poisons a later build.** If the store were filled from a run's worktree after the agent had worked there,
   the agent's edits would become every later run's dependencies.
3. **The store becomes a reason to fail.** A broken install, a full disk or a slow registry must not stop delegation;
   the agent can still install for itself as it does today.

## Decision

1. **Project-declared seeds only.** A project lists `dependency_seeds` (id, lockfile path, produced directory, install
   argv, optional timeout) in its configuration (LLD §11.1 shape, detailed in LLD §5.1). Paths are relative to the
   primary context, normalised, never `.git` or outside the worktree; the directory must be Git-ignored at the base
   checkpoint, so seeding never shows up in mutation detection, the post-run checkpoint or the diff (ADR-0006). Nothing
   is ever seeded from what a request or an agent says. A project without the key behaves byte-identically to `main`:
   no store directory, no ledger row, no event, no mount.
2. **Keyed by content, built once from the base checkpoint.** An entry's key is the SHA-256 of the lockfile's content
   at the run's base checkpoint together with the project id, seed id, the install argv, the build's trust profile and
   the environment (`host` and platform, or `container` and image digest). The build runs on a **scratch worktree of
   the base checkpoint** (`git worktree add --detach`), never on a run's worktree, so no agent output can reach an
   entry. Only the declared directory is kept; the scratch worktree is removed. Concurrent runs needing the same key
   share one build (single flight through a ledger row).
3. **The build runs like a verification command.** Argv only, no shell, its own process group, the FR-EXE-07
   environment allowlist minus every `GIT_*` name and the signing and agent variables, the operator's
   `verification_env` additions, a verification slot and niceness (FR-EXE-09), the confinement setting of verification
   (FR-EXE-08), and a time bound. The trust profile is the triggering run's, capped at `trusted-development` (a seed
   build is a controller command and never runs under a `privileged` scope or bypass), and it is part of the key, so an
   entry is only reused by runs of the profile it was built under. `inspect-untrusted` runs are not seeded, as they get
   no verification (FRD V7). For a `container` project the build runs in a container of the project's image with the
   project's network policy, mounting only the scratch worktree, as ADR-0052 mounts a run's worktree.
4. **Populated by copy-on-write clone or private copy, never linked (Q-103 Delegated default).** On `host` the seeded
   directory is a copy-on-write clone of the entry where the filesystem supports one and a private byte copy otherwise;
   no hardlink and no symlink into the store under any profile, trusted ones included. Symlinks inside an entry are
   kept as links only when they resolve inside the seeded directory; an entry with any other symlink, a device, a FIFO
   or a socket fails its build. Set-user-ID and set-group-ID bits are cleared. Entry files are stored read-only as
   defence in depth, which is not a control against the operator's uid.
5. **Read-only mount for `container` environments.** A `container` run receives the entry as one extra read-only bind
   mount at the seeded directory's path inside its worktree mount. It is not the data directory and not another entry;
   no copy is made. This adds one mount class to the set FR-PRJ-05 allows (the run's worktree and declared read-only
   contexts); T9.13 adds the dated SRS note when it builds it.
6. **Degrade, never fail.** A missing lockfile, a directory that is not ignored, a failed or timed-out build, a full
   store or a population error records one `seed_failed` run event (seed id and a reason code, no output) and the run is
   admitted and proceeds with an unseeded directory. Build output goes to a redacted `seed_log` artifact like a
   `test_report`. Seeding never changes a run's terminal state or failure code.
7. **A bounded store with LRU eviction that never removes an entry in use.** The store lives under
   `<data_dir>/seeds/` (`0700`, refused if it or a parent inside the data directory is a symlink). Ledger tables record
   each entry (key, state `building | ready | evicting`, size, last use) and each use (run, worktree, method). Eviction
   is least recently used against an operator-configured total size and a per-seed entry count, in the GC order of
   ADR-0054 (intent row with a re-check, removal, outcome row), and never removes an entry that is building or used by a
   non-terminal run. Ledger migrations are additive (ADR-0005).
8. **Interfaces for the next tasks.** T9.13 implements a `SeedStore` port (resolve or build an entry, populate a
   worktree, give a container mount, release a run's uses, evict) and the lifecycle hook between the pre-run checkpoint
   and spawn. It also registers the early disk-floor sweep's first reclaimer (T3.23, FR-WS-11), named
   `dependency_seeds` in the `seeds` slot of `earlySweepReclaimers`: it removes private copies in idle worktrees first,
   then unused entries, and never touches a leased worktree. LLD §5.1 holds the signatures.

## Consequences

- Runs of a project with a declared seed start with the directory present, once per lockfile hash, profile and
  environment; a changed lockfile builds a new entry and the old one ages out.
- Without copy-on-write support every seeded run pays a full private copy in time and disk; the store does not save
  disk then, only install time and network. The early sweep and LRU eviction bound the cost.
- An entry built under one profile is not reused by another, so a project used under several profiles may hold up to
  one entry per profile per lockfile hash. This is the cost of never feeding a weaker build to a stronger run.
- When verification is confined (network unshared), only installs that need no network succeed; others degrade to
  `seed_failed`. A network exception for seed builds would be a new decision.
- Residual: an install command is arbitrary project code run on the host (as verification commands are, ROADMAP
  R-61); the build can do whatever its trust profile and confinement let it do, and a malicious lockfile or registry
  produces a malicious entry. The store keeps that output from changing between runs, not from being harmful.
- Residual: a `container` run cannot write the seeded directory; an agent that needs to change dependencies there
  must reinstall elsewhere or the project must not declare the seed for container use.
