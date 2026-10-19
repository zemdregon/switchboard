# ADR-0013: Projects own environments and contexts

- Status: Accepted (the concept and orchestrator-managed projects); the container mechanism (rootless runtime,
  in-volume native login) Accepted 2026-10-18 on the T10.0 operator results (Delegated; see
  [Operator live findings](#operator-live-findings-2026-10-18-t100)); the container image rule is amended by
  [ADR-0020](0020-container-image-without-git-client.md)
- Date: 2026-10-12
- Decided by: zemdregon (projects as first-class, an environment plus contexts, environments likely containers; message
  of 2026-10-12). Delegated (agent, 2026-10-12) for the mechanism: config-defined projects, two environment kinds, the
  ceiling rule and milestone placement. zemdregon answered Q-7 "yes" (2026-10-12): the orchestrator may create and change
  projects over MCP; the gating below is Delegated. zemdregon left Q-6 to the agent ("the rest you pick"): the container
  runtime and login mechanism below are Delegated and Proposed.
- Related: FR-PRJ-01–10, FR-WS-01–02, FR-POL-06, FR-POL-10, FR-MCP-06, [ADR-0004](0004-trust-profiles-no-bypass-flags.md),
  [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md), [ADR-0011](0011-single-operator-local-deployment.md)

## Context

Until now a delegation named a bare `workspace_path`. zemdregon wants Switchboard to manage *projects*: the environment
the coding agents operate from, likely a container of some kind, and the *contexts* of that project, such as repositories.
A bare path says nothing about where the agent runs, which repositories belong together, or what ceiling applies to a
given body of work, and it gives the orchestrator no stable thing to refer to.

Two existing constraints matter. [R2] reports that a dedicated OS user does not isolate provider credentials from a
same-user agent shell, so an outer sandbox is an open evaluation ([TDD §3.4](../design/TDD.md#34-security-engineering),
risk R-8, R-10). And FR-AUTH-01 forbids moving credentials between identities or machines, which a container environment
could be tempted to do to give the provider CLI its login.

## Decision

- A **project** is a named, operator-defined unit with one **environment** and one or more **contexts**. Operator
  projects are
  defined in the schema-validated configuration; *dynamic* projects are created by an orchestrator over MCP (below).
  Both are snapshotted into every run's policy snapshot. The ledger stores the project ID on meta-sessions and runs, and
  append-only `project_revision` rows for dynamic projects.
- **Environment kinds:** `host` (today's behaviour: the provider process runs directly on the operator's machine under
  its native sandbox) and `container` (the provider process runs in a controller-managed container that mounts only the
  run's worktree and declared read-only contexts). `host` ships first; `container` follows once the runtime and the
  provider-login question are settled.
- **Context kinds:** only `repository` (a local Git repository under an allowed root). The schema is extensible; an
  unknown kind fails validation.
- **Relationships.** The workspace manager still creates one worktree per write-capable run and owns the lease
  ([ADR-0006](0006-worktree-checkpoints-no-blind-replay.md)); the project supplies the repository, base ref and
  environment, and a container mounts the worktree. A meta-session belongs to one project for its whole life. A project
  may cap the trust profile and the providers; the effective ceiling is the lower of the client's and the project's
  ([ADR-0004](0004-trust-profiles-no-bypass-flags.md)). A container never relaxes a profile by itself: it can make an
  adapter eligible for a profile only if its manifest declares credential confinement in container mode and the
  malicious-fixture suite passes (FR-POL-02, FR-POL-06).
- **Orchestrator-managed projects (Q-7: yes).** A client entry with `manage_projects` (default off) may call
  `create_project`, `update_project` and `delete_project` for dynamic projects. It can never touch configured projects.
  The limits are the client's own: paths under allowed roots, ceiling, providers and push policy no wider than its entry
  (`max_push_policy`, default `none`). A `container` environment, any push policy, and any widening stay
  `PENDING_APPROVAL` until the operator approves on the CLI; the approval has no MCP path. Dynamic projects are visible
  only to their creator and the operator, and every call is recorded. This keeps the trust-boundary crossing (mounting
  paths, starting containers, granting push) under the operator's control.
- **Container runtime and logins (Q-6, Delegated, Proposed).** A rootless OCI-compatible runtime (rootless Podman is the
  likely candidate; unverified), driven through its CLI behind the environment port. Provider logins are done by the
  operator running the provider's own login inside the project's container volume once; the controller copies nothing
  (FR-AUTH-01). M10 is unblocked on that basis, with a spike to verify it for each provider. *Update 2026-10-18:*
  verified by the T10.0 operator results (rootless Docker 29.8.2 on the operator host, in-volume native login
  Observed for all seven providers); the mechanism is now
  [Accepted](#operator-live-findings-2026-10-18-t100). The Decision text above is kept as decided; the verification
  conditions and their results are recorded in [Consequences](#consequences) and
  [Operator live findings](#operator-live-findings-2026-10-18-t100).

## Alternatives considered

- **Projects as a label over `workspace_path`.** Rejected: no environment, no ceiling, and nothing to hang container
  isolation on.
- **Orchestrator creates projects with no approval step.** Rejected: creating a project can mount host paths, start
  containers and grant push, which the client ceiling alone does not cover. Hence the approval gate above.
- **Always run in a container.** Rejected for now: provider logins live in each CLI's own store, and getting them into a
  container without the controller copying credentials is only a Proposed mechanism, to be verified in M10. *Update
  2026-10-18:* the mechanism is verified and Accepted on the T10.0 operator results (see
  [Operator live findings](#operator-live-findings-2026-10-18-t100)); the rejection above still stands because the
  container backend mounts no login volume yet (ADR-0052).
- **Rely only on provider-native sandboxes.** Kept for `host`; the container kind exists because [R2] reports uneven
  native sandboxing (Claude Code has none documented).

## Consequences

- Configuration grows a `projects[]` section and each MCP client entry gains a project allowlist.
- A new component, the Project Manager (COMP-PRJ), owns project resolution and, in M10, the container lifecycle.
- Container orphans become a reconciliation concern (FR-PRJ-07), and per-run container limits partly answer risk R-8.
- Still to verify in the M10 spike: that the rootless runtime fits the host, that the provider CLI can live in an
  operator-pinned image, and that each provider's native login works inside the volume and is acceptable under its terms
  (R-2). *Update 2026-10-16:* the first of those is observed on the Ampere host (rootless Docker); the login and
  Git-free CLI questions remain open. See [Spike findings](#spike-findings-2026-10-16-t100). *Update 2026-10-18:*
  all three are met; see [Operator live findings](#operator-live-findings-2026-10-18-t100).

## Spike findings (2026-10-16, T10.0)

Container mechanism **Status stayed Proposed** on 2026-10-16 (Accepted 2026-10-18, [Operator live
findings](#operator-live-findings-2026-10-18-t100)). This section records what T10.0 observed; it does not change the
Decision. Evidence:
[docs/research/container-runtime-spike-2026-10-16.md](../research/container-runtime-spike-2026-10-16.md).
Delegated agent work, not owner-approved. No provider CLI was installed or run.
[PR #523](https://github.com/zemdregon/switchboard/pull/523).

- **Runtime.** This host runs **rootless Docker** Engine 29.8.2 (`Security Options` includes `rootless`;
  `Docker Root Dir` `/home/ubuntu/.local/share/docker`; cgroup v2). Podman is **not installed**. The Proposed
  "rootless Podman" candidate in the Decision is unverified here. The environment port (TDD §3.11) stays a small
  CLI wrapper, so T10.1 can drive rootless Docker on this host without locking the Decision to one runtime.
- **User namespace.** Container uid 0 maps to the host user (uid 1001). Container uid 1000 and uid 1 **cannot
  write host bind mounts** (`Permission denied`). FR-PRJ-05 worktree writes and any in-volume login that writes a
  bind-mounted directory must run as container uid 0. Named volumes were writable by uid 0; other uids were not
  tested on named volumes.
- **Image without a Git client (ADR-0020).** `node:22-bookworm-slim` (already present; not built) has no `git` and
  no `gh` on `PATH`. `command -v git` / `command -v gh` plus a `PATH` directory scan, with `--network none` and
  `--read-only`, is a workable refusal check. Whether each provider CLI *runs* without a Git client was, on
  2026-10-16, **Unverified: operator (T10.0 live)** (Observed 2026-10-18 for all seven providers; see [Operator live
  findings](#operator-live-findings-2026-10-18-t100)). No provider is marked `host`-only.
- **Mounts and limits.** A rw worktree bind, a read-only context bind (write → `Read-only file system`),
  `--network none` (DNS `EAI_AGAIN`, TCP `ENETUNREACH`), `--memory 128m` / `--pids-limit 64` (inspect:
  `Memory=134217728`, `PidsLimit=64`), and `docker rm` at the end all behaved as specified. Spike-prefixed
  containers and the login-stand-in volume were removed. The public slim image was not removed (this spike did
  not create it).
- **In-volume native login.** Documentation-only table in the research note. On 2026-10-16 every provider cell was
  **Unverified: operator (T10.0 live)** (Observed 2026-10-18; see [Operator live
  findings](#operator-live-findings-2026-10-18-t100)). File-based stores (Claude `CLAUDE_CONFIG_DIR` / `~/.claude`, Codex
  `CODEX_HOME` / `~/.codex/auth.json`, Grok `GROK_HOME` / `~/.grok`, Antigravity token file under `$HOME` or
  `--gemini_dir`, Cursor under `HOME` not `CURSOR_CONFIG_DIR` alone, Kimi `KIMI_CODE_HOME/credentials/`, Muse
  `~/.config/muse/auth.json`) look compatible with a volume *if* the operator can complete native login as uid 0
  with network, then reuse the volume on a `--network none` run. OpenCode's default user service may not exist in
  a container (`--standalone` is the documented isolation path). Antigravity's Ampere live check recorded a
  **file** token, not a keyring; that is not treated as `host`-only. Login was not attempted.

## Operator live findings (2026-10-18, T10.0)

The container mechanism moves from Proposed to **Accepted** (Delegated: zemdregon left Q-6 to the agent). Evidence:
[container runtime spike §6](../research/container-runtime-spike-2026-10-16.md#6-operator-in-volume-login-and-prompt-results-2026-10-18)
(Observed by the operator on the Ampere host; no credential read or copied). The Decision is unchanged except that
the runtime observed and implemented is rootless **Docker** (ADR-0052), not Podman; the Decision always allowed any
rootless OCI-compatible runtime.

The three verification conditions in Consequences, each literal:

1. *The rootless runtime fits the host:* met 2026-10-16 (rootless Docker Engine 29.8.2; uid 0 maps to the host user).
2. *The provider CLI can live in an operator-pinned image:* met 2026-10-18. Seven operator-built images from
   `node:22-bookworm-slim` pinned by digest, each holding one provider CLI and no `git`/`gh`; every CLI started,
   reported logged in with `--network none` (Antigravity's model list needs network), and six answered a real prompt.
   Grok Build reached the API and was refused for billing (402 usage balance), so its prompt is Deferred-until-reset;
   that is a quota state, not an image or login failure.
3. *Each provider's native login works inside the volume and is acceptable under its terms (R-2):* login met 2026-10-18
   for Claude Code, Codex, Grok Build, Antigravity, Cursor CLI, OpenCode and Kimi Code (Muse Code skipped, owner
   decision 16). Each login is the operator's own account, run with the provider's own login command in the
   operator's own volume, and the controller copies nothing: the R-2 mitigation ("each user runs their own
   installation with their own logins", ADR-0003, ADR-0011) and FR-AUTH-01 hold. No new terms review was done for
   this change.

No provider is marked `host`-only. Still open and **not** part of this acceptance: mounting a login volume in the
container backend (ADR-0052 defers it) and a live Switchboard run in a `container` project; both stay under M10.

## Revisit when

The M10 spike contradicts the rootless-runtime or in-volume-login choice, an orchestrator needs approval-free project
creation, or a second context kind is wanted.
