# ADR-0071: Per-project dependency setup step run by the controller

- Status: Accepted (built 2026-10-20).
- Date: 2026-10-20
- Decided by: Linus (design authority), 2026-10-20. The design below is Linus's; the refinements marked **Delegated**
  were made while building it and are not owner-approved.
- Related: FR-PRJ-10, FR-WS-10, FR-EXE-08, FR-EXE-07, FR-POL-06, NFR-SEC-01,
  [ADR-0057](0057-dependency-seed-store.md) (dependency seeds, the configuration-only precedent),
  [ADR-0051](0051-outer-sandbox-detection-and-fail-closed-requirement.md) (the outer sandbox), [ADR-0030](0030-dynamic-project-revisions-and-approval.md)
  (dynamic projects and their approval),
  [LLD §5.3](../design/LLD.md#53-project-setup-step-adr-0071),
  [ROADMAP T9.18](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks).

## Context

Runs in the dynamic project whumpo-website (a pnpm workspace with `packageManager: pnpm@11.19.0` and a
`pnpm-lock.yaml`) start in fresh worktrees with no installed dependencies. A `trusted-development` agent correctly may
not run `pnpm install` (its network is off), pnpm is not installed on the host (corepack is), and dependency seeds
(ADR-0057) are configuration-file only and cannot be declared by an MCP-only project. Every run that tests therefore
failed. The operator needs a controlled install step that an MCP-only project can request, that waits for approval,
and that does not widen what the agent itself may do.

## Decision

1. **Project field `setup`** (configured projects and dynamic definitions, so `create_project` / `update_project` set
   it and `list_projects` shows it, defaults filled in):
   `setup: { commands: string[][], network?: { hosts?: string[] }, cache?: "pnpm" | "npm" | "none",
   timeout_seconds?: integer, env?: { CI?, NODE_ENV?, NO_COLOR? } }`. Commands are argv arrays, no shell, 1 to 8
   commands of 1 to 32 non-empty strings of at most 1024 characters without NUL. `network.hosts` defaults to
   `["registry.npmjs.org"]`, at most 8, each a lower-case DNS name of two or more labels whose last label starts with a
   letter (no IP literal, port, wildcard or trailing dot). `cache` defaults to `"none"`. `timeout_seconds` defaults to
   600, at most 1800. `env` is the closed allowlist `CI`, `NODE_ENV`, `NO_COLOR` with values of at most 64 characters
   from `[A-Za-z0-9._-]`. **Delegated:** `setup` is refused on a `container` project (the sandbox and proxy below are
   host mechanisms; refused rather than ignored).
2. **Approval.** In a dynamic project, a `setup` that is new or differs (after defaults) from the revision in force
   waits for the operator with the new `approval_needed` reason `project_setup` (FR-PRJ-10), approvable with
   `decide_approval` by an approval proxy whose kinds include `dynamic_project`, or `switchboard projects approve`.
   Removing it narrows and needs no approval; the same setup with defaults spelled out is not a change.
3. **Frozen at admission.** `delegate_task`, `continue_task` and queued admission copy the in-force setup into the run's
   project snapshot (`policy_snapshot_json.project.setup`), so a later edit or a revision awaiting approval cannot change
   what a run executes. A read-only critic run gets none (**Delegated**).
4. **When.** The lifecycle runs the step after the worktree is prepared (after rebase preparation and the ref
   snapshot) and before anything else reads the worktree or the agent is spawned, for every run with a worktree whose
   snapshot has `setup` (`delegate_task`, `continue_task` and new runs of a meta-session). It is skipped when a marker
   in the worktree's own Git directory (`<git-dir>/switchboard-setup.json`, outside the worktree, so an agent cannot
   write it) records a successful step for the same lockfile hash (SHA-256 over the root `pnpm-lock.yaml`,
   `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`, `bun.lockb`, each its bytes' SHA-256 or
   absent) and setup hash (SHA-256 of the canonical frozen setup). A run without a worktree (`inspect-untrusted`) gets
   no step.
5. **Runner.** The verification stage's runner (`startVerification`, `src/lifecycle/verification.ts`): argv, no shell,
   own process group, stdin closed, fail fast, the whole step bounded by `timeout_seconds`, pid and process group
   recorded before output is read (reconciliation kills an orphaned step), each stream captured up to 256 KiB
   (**Delegated**).
6. **Network: what is enforced.** Each command runs under bubblewrap (`src/exec/setup-sandbox.ts`) with every namespace
   unshared, so its network namespace has only loopback. A small Node.js bridge started inside the sandbox ahead of the
   command listens on `127.0.0.1` and forwards to the controller's per-step allowlisting CONNECT proxy
   (`src/exec/connect-proxy.ts`) over a Unix socket bound into the sandbox, and sets `HTTPS_PROXY`, `HTTP_PROXY`, their
   lower-case forms, `npm_config_https_proxy` and `npm_config_proxy` for the command. The proxy accepts only
   `CONNECT <host>:443` for a listed host (exact, case-insensitive), resolves the name itself and dials only a public
   unicast address (not loopback, private, link-local, CGNAT, unique-local, multicast or unspecified); everything else
   is refused (`403`, `405`, `431`, `502`, `503`). Enforced: a setup command cannot open a TCP or UDP connection to
   anything but the proxy (the kernel refuses it, `ENETUNREACH`), cannot resolve names itself, and through the proxy
   reaches only TLS endpoints on port 443 of the listed names. **Not enforced:** what is sent inside an allowed TLS
   tunnel (the proxy does not terminate TLS), so a hostile install script could still upload data to an allowed host
   (for example publish to the npm registry with a token it obtained elsewhere); the step has no CPU or memory limit
   beyond the timeout; Unix sockets in directories that stay visible (see item 7) are reachable. Without a usable
   bubblewrap the step fails `sandbox_unavailable`; it never runs unconfined (**Delegated**, fail closed).
7. **Filesystem and environment** (**Delegated**, least privilege). Inside the sandbox the host root is read-only;
   `/dev`, `/proc` and `/tmp` are fresh; the operator's home (`HOME` of the controller), the controller's data
   directory and `/run` are replaced by empty tmpfs (no provider logins, `auth.json`, keys, ledger, SSH agent, Docker or
   controller sockets); `PATH` entries and the Node.js installation that those hide are re-bound read-only; the worktree,
   the per-project setup home `<data_dir>/setup/<project>/home`, `<data_dir>/caches` and the proxy socket's directory
   are writable. Repository metadata outside the worktree is not exposed, so setup cannot write Git hooks or
   configuration. The environment is built, not inherited: `PATH` (the controller's), `HOME` and the XDG directories
   under the setup home, `TMPDIR=/tmp`, `COREPACK_HOME=<data_dir>/caches/corepack`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
   `COREPACK_ENABLE_AUTO_PIN=0`, `NODE_USE_ENV_PROXY=1` (Node.js `fetch`, which corepack 0.36 uses, honours the proxy
   variables only with it), `npm_config_update_notifier`, `npm_config_fund` and `npm_config_audit` off, the cache
   variables of item 8, the `setup.env` values and the bridge's proxy variables. No operator variable, token, SSH agent
   or Git credential reaches a command.
8. **Cache.** `cache: "pnpm"` sets `npm_config_store_dir`, `pnpm_config_store_dir` and `PNPM_STORE_DIR` to
   `<data_dir>/caches/pnpm-store`, shared by every project and run; `"npm"` sets `npm_config_cache` to
   `<data_dir>/caches/npm`; `COREPACK_HOME` is always under `<data_dir>/caches`. The caches are not bounded by retention
   or GC in this change (no existing hook covers a shared content store without per-run ownership); see Consequences.
9. **Outputs never committed.** A successful step must leave the non-ignored `git status` of the worktree exactly as it
   found it; otherwise it fails `outputs_not_ignored`. So setup output (`node_modules`) is always ignored by Git and can
   reach no checkpoint, diff, commit-tool commit or finalize-only commit, all of which stage with `git add -A` and
   therefore honour `.gitignore`. The agent's own later changes are unaffected.
10. **Outcome.** Run events `workspace_setup` with `phase` `skipped` (`reason: marker_match`), `started` (counts, cache,
    timeout), `command_started` (index, pid, pgid), and `succeeded`, `failed` or `cancelled` (duration, exit codes,
    `confined`, proxy allowed/refused counts, the artifact id, and for `failed` a reason code), never argv, a path, a
    hostname or output. The redacted output (argv, exit status, stdout and stderr per command) is the `setup_log`
    artifact (migration 0034 widens `artifact.kind`), readable over MCP `get_artifacts` as untrusted text. A failed or
    timed-out step ends the run FAILED `TOOL_FAILURE` before spawn, `details.reason` `SETUP_FAILED` or `SETUP_TIMEOUT`
    and `setup_reason` one of `command_failed`, `timeout`, `sandbox_unavailable`, `outputs_not_ignored`,
    `internal_error`, `unavailable`; `get_run` shows the code and a detail naming the reason. `started_at` stays unset,
    so the provider's breaker classifies the run neutral (LLD §16.4) and capacity does not count it against the
    provider. A run with `setup` on a controller with no setup runner fails closed (`unavailable`).
11. **Agent trust unchanged.** Profiles, the agent's network policy and allowed commands are untouched; nothing the
    step does widens the agent.

## Consequences

- MCP-only projects can install dependencies before the agent starts, with one operator approval per new or changed
  setup. For whumpo-website the recommended value is `{ "commands": [["corepack", "pnpm", "install",
  "--frozen-lockfile"]], "network": { "hosts": ["registry.npmjs.org"] }, "cache": "pnpm" }`; corepack 0.36 downloads
  pnpm from `https://registry.npmjs.org` (its default registry), so no other host is needed. Checked once by hand on
  the build host, 2026-10-20 (not in CI): the built runner, confined in bubblewrap with only `registry.npmjs.org`
  allowed, ran `corepack pnpm --version` (printed `11.19.0`) and `corepack pnpm install` of one package into the
  shared store; the proxy tunnelled 2 connections and refused none. whumpo-website itself was not installed (its
  dependency tree may need other hosts, for example a git-hosted dependency, which would be refused).
- Hosts without a working unprivileged bubblewrap (macOS, hardened CI runners) cannot use the step; those runs fail
  `sandbox_unavailable`. A macOS mechanism is an open question (ROADMAP §7).
- The run holds its provider slot and worktree lease while the step runs (up to 30 minutes).
- `<data_dir>/caches` grows without bound until GC covers it (Proposed follow-up; operators can delete it while no
  setup runs). The setup home `<data_dir>/setup/<project>` is kept across runs and is not removed with the project.
- Dependency seeds (ADR-0057) are unchanged and remain configuration-file only.
