# ADR-0052: Container environment backend: the environment port over a rootless Docker CLI driver

- Status: Proposed
- Date: 2026-10-16
- Decided by: Delegated (agent, 2026-10-16, under [owner decision 25](../ROADMAP.md#42-owner-decisions); not
  owner-approved). The image rule it implements is zemdregon's ([ADR-0020](0020-container-image-without-git-client.md),
  owner decision 24); the runtime and login mechanism stay Proposed in [ADR-0013](0013-projects-environments-and-contexts.md).
- Related: T10.0, T10.1, T10.2, T10.3, FR-PRJ-04, FR-PRJ-05, FR-PRJ-07, FR-EXE-07, FR-WS-08, NFR-SEC-04, R-8, R-40,
  [LLD §11.3](../design/LLD.md#113-environment-port), [TDD §3.11](../design/TDD.md#311-container-environments),
  [container runtime spike](../research/container-runtime-spike-2026-10-16.md), [ADR-0017](0017-approved-privileged-scope-bypass.md),
  [ADR-0051](0051-outer-sandbox-detection-and-fail-closed-requirement.md)

## Context

T10.1 asks for the environment port of LLD §11.3 with a `container` implementation: mounts, limits, network policy,
labels, teardown, and the refusal of an image that has a Git client. The T10.0 spike observed rootless Docker Engine
29.8.2 on the Ampere operator host (Podman not installed): bind mounts, `--network none`, `--memory` and
`--pids-limit` round-trip through `docker inspect`, container uid 0 is the host user and no other uid can write a host
bind mount, and `node:22-bookworm-slim` has neither `git` nor `gh` on its `PATH`. Provider logins inside a container and
"provider CLI works without a Git client" were not live-checked and stay on the operator's T10.0 checklist. *Update
2026-10-18:* both are now Observed by the operator for all seven providers
([spike
§6](../research/container-runtime-spike-2026-10-16.md#6-operator-in-volume-login-and-prompt-results-2026-10-18)); this
ADR's decision is unchanged.

The lifecycle audits every invocation before spawn (bypass flags, MCP arguments, `--safe-mode`; T3.17, T9.4b, ADR-0033)
and composes the provider's environment from an allowlist (FR-EXE-07). Whatever wraps the provider process in a
container must keep those two properties.

## Decision

1. **The port** (`src/environment/types.ts`) is LLD §11.3's interface: `prepare(run, invocation)`, `teardown(run)`
   (always called, idempotent) and `sweepOrphans(knownRunIds)`. `host` is the identity (`src/environment/host.ts`).
   The lifecycle (`RunLifecycleOptions.environments`) decides the kind from the frozen snapshot's
   `project.environment_kind` before any lease or worktree; a `container` run with no container environment, or a
   resolver answering the wrong kind, is refused `ELIGIBILITY_NONE` (`ENVIRONMENT_UNAVAILABLE`), never run on the
   host. `prepare` runs after the pre-spawn refusals and the Git tool channel, immediately before the audits and the
   spawn; `teardown` runs in the same `finally` as the channel close.
2. **A small runtime port** (`src/environment/runtime.ts`: `info`, `resolveImage`, `scanImageForGitClient`,
   `runArgv`, `inspect`, `remove`, `listByLabel`) with one driver, the Docker CLI (`src/environment/docker-runtime.ts`).
   The driver runs the client with `execFile` (never a shell) and an environment of only the socket and config names
   (`PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`,
   `XDG_RUNTIME_DIR`). **Only a rootless daemon is used** (`docker info` security option `name=rootless`;
   NFR-SEC-04, TDD §3.11); anything else is `CONTAINER_RUNTIME_UNAVAILABLE`.
3. **The provider process is a `docker run` under the supervisor**, not a `create` in `prepare` followed by a
   `start`. The prepared argv is `docker run <runtime flags> <image id> <executable> <provider arguments...>`, so the
   provider's arguments stay in argv unchanged and the existing audits still see them; the container's variables are
   `--env NAME` copies from the client process, whose environment the supervisor composed from the invocation's
   allowlist (FR-EXE-07). The container is created at spawn and removed by `--rm` at exit; `teardown` force-removes it
   by name on every terminal path, which also covers a client killed by the supervisor's `SIGKILL` escalation. Long
   flag spellings only: `-e` and `-w` are bypass-class short flags of a provider and the audit scans the whole argv.
4. **Image** (FR-PRJ-04, ADR-0013, ADR-0020): the project's `image_digest` is frozen into the snapshot
   (`ProjectSnapshot.image_digest`) and resolved among the images already present by image id or repo digest; nothing
   is ever pulled (`CONTAINER_IMAGE_NOT_PRESENT`, `CONTAINER_IMAGE_AMBIGUOUS`). Before any run, a throwaway probe
   container (`--network none`, `--read-only`, no capabilities, labelled, named `switchboard-probe-<run>`) runs a POSIX
   `sh` script that checks every directory of the image's `PATH` for an executable regular file named `git` or `gh`,
   then `command -v` for each, and prints an end marker. A hit is `CONTAINER_IMAGE_HAS_GIT_CLIENT` naming the path;
   a scan without the end marker (no `sh`, timeout, non-zero exit) is `CONTAINER_IMAGE_CHECK_FAILED`. Both start no run.
5. **Mounts** (FR-PRJ-05, FR-WS-08): exactly the run's worktree (writable) and the project's declared read-only
   contexts, each bind-mounted at its own host path (`--mount type=bind`), so `cwd` and any path in the provider's
   arguments stay valid; `--workdir` is the worktree. Nothing else: no home, data directory, Git directory, credential
   store or runtime socket. A path that is relative, not normalised, carries a comma, repeats another or nests inside
   another is refused (`CONTAINER_MOUNT_PATH_INVALID`). The worktree's `.git` pointer file is visible as a file (a
   host path string); the Git directory it names is not mounted.
6. **Identity and hardening**: `--user 0:0` (the spike's finding: under rootless Docker only container uid 0 can
   write a host bind mount, and uid 0 is the unprivileged host user), `--cap-drop ALL`,
   `--security-opt no-new-privileges`, `--init`, `--interactive` (stdin as the supervisor supplies it), no TTY.
7. **Network** (TDD §3.11): profile `off` and an empty allowlist are `--network none`; a non-empty allowlist is
   refused (`CONTAINER_NETWORK_UNENFORCEABLE`: Docker enforces no host allowlist, and the run is not started
   unrestricted under a policy that names hosts); `policy` runs on the runtime's default network with the enforcement
   recorded as the provider's own; a `privileged` scope maps through its `network.mode` (`off` none, `on` default,
   `allowlist` with hosts refused).
8. **Limits** (R-8): `--cpus` and `--memory` (with `--memory-swap` equal, so no swap) from the project; `--pids-limit`
   512 by default (Assumption). A configured `disk_mb` is **not enforced** by this backend (no storage quota on the
   rootless overlay driver) and is recorded as `diskMbNotEnforced`, never claimed.
9. **Labels and events** (FR-PRJ-07): every container carries `switchboard.run`, `switchboard.project` and
   `switchboard.role` (`run` or `probe`). The environment emits `environment` events (`image_checked`, `prepared`,
   `refused`, `removed`, `remove_failed`, `orphan_removed`) to a callback; writing them to the ledger and calling
   `sweepOrphans` at startup are T10.2.
10. **Variables**: allowlisted names are forwarded except host-only ones (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`,
    `PATH`, `TMPDIR`, `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `XDG_*`, `DOCKER_*`, and the rest of
    `HOST_ONLY_ENV`), whose values are host paths or sockets; the image's own values apply. Adapter-declared
    variables are forwarded verbatim. Only names are ever recorded.

## Alternatives considered

- **`docker create` in `prepare`, `docker start --attach` as the supervised process.** Rejected: the audited argv
  would then be `docker start <name>` and the provider's flags would leave the audit's view (the Claude `--safe-mode`
  audit would refuse every container run); `--env` values would be captured at create time from a second process
  environment. Inspection before start is the one advantage; the mount set is controller-built and verified by the
  opt-in test instead.
- **Run the default network for a non-empty allowlist and record it.** Rejected: that starts a run unrestricted under
  a policy that names hosts, the T3.1 precedent (ADR-0051) refuses rather than runs unconfined.
- **Mount a login volume now.** Deferred: the per-provider mount point depends on the operator's T10.0 live result
  (spike §4); the mount set stays exactly FR-PRJ-05's two kinds until then. *Update 2026-10-18:* the T10.0 result
  now gives each provider's store (spike §6); mounting it is still not implemented here.
- **Podman.** Not installed on the operator host; the runtime port keeps it replaceable.

## Consequences

- Host runs are unchanged: with no resolver, or a resolver answering `host`, the identity environment is used.
- MCP and work-queue admission admit a `container` project when `serve` composes `runEnvironments` (a configured
  `container` project); otherwise admission refuses with `ENVIRONMENT_NOT_IMPLEMENTED` before any side effect
  ([PR #554](https://github.com/zemdregon/switchboard/pull/554), `src/mcp/server.ts`, `src/queue/admission.ts`,
  `src/cli/serve.ts`). Live provider CLIs inside the image were checked by the operator (T10.0 Done 2026-10-18;
  spike §6); mounting a login volume is still not implemented here.
- The injected Git tool channel (socket and shim on the host) is not reachable from inside a container; malicious-fixture
  coverage for Git-write attempts under bypass uses the host controller and an image without a Git client (T10.3). A
  mounted channel or an alternate commit path for in-container adapters remains an open design point.
- The provider's probe and auth preflight run against the host binary; inside the image the executable is resolved
  by name on the image's `PATH`. Each provider's start and authentication there was the operator's T10.0 check,
  Observed 2026-10-18 (spike §6).
- Tests: `src/environment/container.test.ts`, `src/environment/docker-runtime.test.ts`,
  `src/lifecycle/environment.test.ts` (fakes), and the opt-in `src/environment/container-docker.test.ts`
  (`SWITCHBOARD_CONTAINER_TESTS=1`, a rootless daemon and a local base image; skipped otherwise, including in CI).
