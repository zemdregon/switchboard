# ADR-0028: Controller-side push: the push process's trust boundary, the credential-reach rule and the operator command

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions) (best practice for a
  decision that does not change what a bypass run may do: a bypass run is never offered `push`, BR-31; **amended before
  merge** by [owner decision 37](../ROADMAP.md#42-owner-decisions), see "Amended before merge" below). Not an zemdregon
  quote and not owner-approved. Recorded as owner decision 35 in the roadmap for traceability only. That agents may push
  through the `push` tool is zemdregon's answer to Q-9 ([ADR-0014](0014-tool-only-commits-and-publication.md) item 5); the
  rules (FR-GIT-05, FR-GIT-06, BR-29, BR-31) and the algorithm ([LLD §12.6](../design/LLD.md#126-push-algorithm)) were
  already specified. This ADR records the trust boundary and external interface AGENTS.md requires an ADR for, and the
  mechanisms the specification left open.
- Related: FR-GIT-02, FR-GIT-05, FR-GIT-06, FR-GIT-07, FR-GIT-08, FR-WS-05, FR-POL-06, FR-EXE-07, NFR-SEC-01, FRD
  BR-27, BR-29, BR-31, WF-12, [ADR-0003](0003-no-credential-handling.md), [ADR-0005](0005-sqlite-ledger.md),
  [ADR-0014](0014-tool-only-commits-and-publication.md), [ADR-0025](0025-git-commit-provenance-and-sanitiser.md),
  [ADR-0026](0026-per-run-tool-channel-socket-and-token.md), [ADR-0027](0027-ref-snapshots-and-violation-handling.md),
  ROADMAP T9.6, R-48, R-49, Q-42, Q-44

## Context

Every controller Git call so far runs through the hardened helper (`src/workspace/git.ts`): `GIT_CONFIG_GLOBAL=/dev/null`,
no system configuration, no inherited `GIT_*`, no `HOME`, hooks off, filter and diff drivers neutralised. A push cannot
work that way: FR-GIT-06 says push credentials are used "only by controller-side Git operations through the operator's
existing Git configuration", and that configuration (credential helper, `url.*.insteadOf`, SSH agent, SSH keys) lives in
the operator's global configuration and home directory. So the push is the one controller Git call that must cross back
into the operator's own environment, and it is the call that can send data off the machine with the operator's
credentials. Left open by the specification: which parts of the operator's environment the push may see, how hooks,
prompts, transports and repository-supplied commands are kept out, how BR-31's "a profile without arbitrary shell" maps
to the trust profiles, what the operator command is called and how it interacts with the `serve` lock, how the push
target is resolved given that T9.4 did not freeze the remote (it could have been a URL with credentials), how a push
after a Git policy violation is treated (Q-44), and how the T9.5 ref guard tells the controller's own push from an
agent's.

## Decision

1. **One ref, never forced.** The only push is the meta-session's local publish ref (`refs/heads/switchboard/pub/<sess>`,
   ADR-0025; Q-42 confirmed) to `refs/heads/<push.branch_prefix><sess>` on the configured remote, as the explicit
   refspec `<head sha>:<target>`: the head SHA that was verified, never a ref name, never a leading `+`, no
   `--force`, `--force-with-lease`, `--mirror`, `--all` or `--tags`. Git itself refuses a non-fast-forward; that is
   recorded as `REJECTED_REMOTE` / `NON_FAST_FORWARD`. Before any push: every commit between the session's base commit
   and the head must have a `git_commit` provenance row of this meta-session (so no checkpoint, run-branch or agent
   commit can be published, FR-GIT-08), the target must not be the context's base ref, the remote's `HEAD` branch or any
   branch checked out in the repository or one of its worktrees, and it must pass `git check-ref-format`.
2. **The remote is a name, resolved by Git at push time.** The config loader now refuses a `push.remote` that is not a
   remote name (letters, digits, `.`, `_`, `-`; never a URL) and a `push.branch_prefix` that is not a branch-name prefix,
   without echoing the value. At push time the name must be one of the repository's remotes. The configured push URLs
   are read through the hardened helper only to classify them: an `https` URL with any userinfo, any URL with a
   password, and any transport other than `https`, `ssh` and `file` (for example `http`, `git`, `ext::`) refuse the
   push. The URL is held in memory only; the ledger, events, logs and output hold the remote name, the target ref, SHAs
   and a reason code from a fixed vocabulary. Git's own output (which can echo a URL or a remote hook's text) is never
   stored or printed: it is mapped to a reason by fixed substrings and discarded. The remote and prefix are read from
   the current configuration, not frozen: the policy must be `branch` both in the run's frozen snapshot (to offer the
   tool) and in the current configuration (at every call), the lower of the two.
3. **The push process.** It is the only Git process that sees the operator's configuration:
   - **Environment:** an allowlist copied from the controller's environment (`PATH`, `HOME`, `USER`, `LOGNAME`,
     `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`, `HTTPS_PROXY`/`https_proxy`,
     `ALL_PROXY`/`all_proxy`, `NO_PROXY`/`no_proxy`, `SSL_CERT_FILE`, `SSL_CERT_DIR`): where Git finds the operator's
     global configuration, SSH agent, credential helper session and proxy. Plus `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`.
     No inherited `GIT_*` (so no `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_CONFIG_*`), no `SSH_ASKPASS`, no `DISPLAY`.
   - **No prompts:** its own session (`detached`, no controlling terminal, so SSH cannot prompt on `/dev/tty`), standard
     input closed, a 90-second timeout that kills the process group (Proposed; below the shim's 120 s).
   - **Command-scope configuration** (overrides every file): `core.hooksPath=/dev/null`, `core.fsmonitor=false`,
     `push.default=nothing`, `push.followTags=false`, `push.gpgSign=false`, `push.recurseSubmodules=no`,
     `protocol.allow=never` with `protocol.https.allow`, `protocol.ssh.allow` and `protocol.file.allow` set to `always`.
   - **Arguments:** `push --porcelain --no-verify --no-follow-tags --no-signed --recurse-submodules=no -- <remote>
     <sha>:<target>`, run from the main repository (not the agent's worktree), so a worktree's `config.worktree` is not
     read.
   - **Repository configuration:** the repository's own configuration (`local` and `worktree` scope, including its
     `include` files) is the part an agent that once had a shell in a worktree could have written. If it sets
     `core.sshCommand`, `core.gitProxy`, `core.askPass`, a `credential.*helper`, `remote.*.receivepack`, `uploadpack`,
     `vcs` or `mirror`, `url.*.insteadOf` or `pushInsteadOf`, any `http.*sslVerify`, or any `protocol.*` key, the push is
     refused (`REPO_CONFIG_UNSAFE`); only key names are read, never values. The same keys in the operator's global or
     system configuration are the operator's own and are honoured.
4. **Credential-reach rule (BR-31) for the agent tool.** Evaluated from the run's frozen policy snapshot when the channel
   opens and again at every call (`src/git/credential-reach.ts`). Allowed only for a `host` project whose frozen policy
   is `branch` and whose profile has no arbitrary shell: shell `none`, or `allowlist` with an **empty** allowlist. A
   non-empty allowlist is refused (`shell_allowlist`): the controller cannot prove that an allowlisted program cannot
   read `~/.ssh` or a credential store. `broad` is refused; a `privileged` run is judged by its approved scope's `shell`
   and is refused when the scope or snapshot sets `bypass` without a controller-verified approval (a bypass run skips
   the provider's permission prompts, so nothing the profile names is enforced). *As first written this said "always
   refused when the scope or approval sets `bypass`"; see "Amended before merge" for the exemption of an approved
   bypass run.* A `container` environment is refused until M10 exists. No
   manifest declares credential confinement (the manifest schema has no such field), so that BR-31 route is never
   taken. When withheld, `push` is not offered and a `git_push_withheld` run event records the reason; the run is not
   otherwise affected (this reads FR-GIT-06's "ineligible" as "ineligible for push", as FRD BR-31 states).
5. **Push after a violation (Q-44, fail closed).** Any `git_policy_violation` event in any run of the meta-session
   refuses every later push of that meta-session, from the tool and from the operator command
   (`GIT_POLICY_VIOLATION`). There is no "cleared" state in this stage.
6. **The tool.** `push` (LLD §12.1 schema: no arguments) is offered on the ADR-0026 channel only when item 4 holds and a
   push service is configured; the shim learns the offered tools from `--tools commit[,push]` (the controller still
   refuses a tool it did not offer). A call passes the ADR-0026 checks (token, RUNNING, binding, rate), takes no
   arguments (`INVALID_ARGUMENTS` otherwise), counts against a limit of 10 push attempts per channel
   (`PUSH_LIMIT_REACHED`, Proposed), and then runs items 1 to 5. Results to the agent: `{pushed, ref, head_sha}` or a
   code (`PUSH_NOT_ALLOWED`, `NOTHING_TO_PUSH`, `REMOTE_REJECTED`, `CREDENTIALS_UNAVAILABLE`, `REMOTE_UNREACHABLE`,
   `GIT_FAILED`) with the fixed reason word. Pushes of one meta-session run one at a time in the controller process.
7. **Recording.** Every attempt that reaches a meta-session, accepted or refused, writes one `git_push` row (migration
   0003, ADR-0025; `run_id` NULL for an operator push) and one `git_push` run event (`push_id`, outcome, reason, remote
   name, target ref, head SHA, the covered controller commits, at most 500 listed) in one transaction
   (`Ledger.recordGitPush`). An agent push's event is on the calling run; an operator push's event is on the run of the
   newest published commit. `runs show` joins commits to accepted pushes through that list. Refusals before the push
   library (bad token, arguments, limit) are `git_tool_denied` events as in ADR-0026.
8. **Operator command.** `switchboard git push <sess_...|run_...> [--json]` performs the same push without item 4 (the
   operator is not the agent). Like `gc --apply`, it takes the data-directory lock and refuses while a `serve` daemon
   holds it (ADR-0005): the push is a side effect with the operator's credentials, so it is not queued for the daemon,
   whose environment need not be the operator's shell. Exit 0 when the remote holds the head, 1 otherwise.
9. **Ref guard (amends the expected differences of ADR-0027).** A controller push through a configured remote updates
   `refs/remotes/<remote>/<branch>` locally. At FINALIZING that change is expected exactly when an ACCEPTED `git_push`
   row pushed that SHA to `refs/heads/<branch>` on that remote; any other change to a remote-tracking ref is still a
   violation.

## Alternatives considered

- **Use the hardened helper for the push as well.** Rejected: with no global configuration and no `HOME`, the operator's
  credential helper, SSH agent and `insteadOf` rules are invisible, so no real remote could be reached (FR-GIT-06 says
  the operator's existing configuration is used).
- **Inherit the controller's whole environment for the push.** Rejected: it would pass any `GIT_*` override (for
  example `GIT_SSH_COMMAND`, `GIT_CONFIG_PARAMETERS`), askpass programs and unrelated secrets to a process that talks to
  the network. The allowlist keeps what Git and SSH need to find the operator's setup.
- **Override repository command keys with `-c` instead of refusing.** Rejected: multi-valued keys such as
  `credential.helper` cannot be reset at command scope without also discarding the operator's global helper, and a
  refusal with a clear reason is easier to audit than a silent override.
- **Push to the URL instead of the remote name** (no remote-tracking update, so no ref-guard change). Rejected: it puts
  the URL on the command line (visible in the process list) and drops per-remote settings the operator configured.
- **Treat a non-empty shell allowlist as "without arbitrary shell".** Rejected for now: an allowlist is argv-exact but
  the controller cannot judge whether a listed program can read credentials; fail closed (R-48 records the remaining
  gap for file-read tools).
- **Queue the operator push for the `serve` daemon.** Rejected: the daemon would push with whatever environment it was
  started with, and an operator command that returns before the push is harder to reason about. Kept as an option if
  stopping `serve` to push proves impractical (R-49).

## Consequences

- Host runs with a shell cannot use the agent `push` tool, except an approved bypass run (see "Amended before merge");
  for the others the operator command, or a `container` environment once M10 exists, is the route.
- A repository whose own configuration sets a credential helper, `sshCommand` or `insteadOf` cannot be pushed through
  Switchboard until the operator moves that setting to the global configuration (R-49).
- The operator must stop `serve` to run `switchboard git push` (R-49).
- A meta-session with any recorded violation can never be pushed through Switchboard; the operator can still push the
  publish ref by hand after reviewing it.
- Transport classification and the unsafe-key list are not exhaustive; BR-31 and the transport allowlist are the main
  controls. Verified on Git 2.43.0 with local bare remotes only: no `https` or `ssh` remote, credential helper, SSH agent
  or proxy was exercised (no network).

## Amended before merge (2026-10-13): approved bypass runs are exempt from the credential-reach rule

This ADR was not merged when zemdregon gave this direction (owner decision 37, verbatim: "BR-31. Don't block git operations
on bypass mode"), so it is amended here in an explicit section rather than rewritten; the original text above is
marked where it changed. **zemdregon's words are quoted; the narrow reading below is a Delegated interpretation (agent),
recorded so zemdregon can correct it.**

- **What changes.** In an approved bypass run (scope `bypass` true AND an approval the controller verifies, evaluated by
  `bypassApprovedFor`, the same `evaluateBypass` verdict the argv audit gate uses) the controller-mediated `push` tool is
  offered and accepted regardless of item 4. `evaluateCredentialReach` takes the controller-held fact `approvedBypass`
  (passed by the lifecycle at channel open and by the channel at every call, computed from the ledger's approval row and
  the run's policy snapshot) and returns `ok` with the reason `bypass_exempt`. Policy `branch` and a `host` environment
  are still checked first (policy `none` offers nothing; a `container` snapshot stays refused until M10). The reason is
  written to the `git_channel_opened` event (`credential_reach`), to each `git_push` event (`credential_reach`) and to
  each `git_push` row (`detail`: `<REASON>; credential_reach=bypass_exempt`), so `runs show` displays it.
- **What does not change.** The push is performed only by the controller; the agent never receives credentials and the
  push process's allowlisted environment (item 3) is unchanged. Items 1, 2, 3, 5, 6, 7 and 8 stand: explicit verified
  refspec, never forced, provenance-verified commits only, protected targets refused, repository-config-unsafe refusal,
  the per-channel limit, the Q-44 violation refusal and recording. Owner decision 22 still keeps the provider's Git-write
  denial: the agent cannot run `git commit` or `git push` itself (the `--disallowedTools` Git deny rules and the
  FR-GIT-03 ref snapshots stay), and the operator command is unchanged. Non-bypass runs keep item 4 exactly.
- **Trust boundary.** The exemption derives only from controller-held facts. A snapshot or scope that merely claims
  `bypass` (`bypassApproved` true in a stored snapshot, a scope with `bypass: true` and no verified approval) is still
  refused as `bypass_run`; nothing the agent or an MCP client sends reaches the input (the `push` tool takes no
  arguments, the stored `bypassApproved` is never trusted, FR-POL-03).
- **Plain statement of the cost.** This is the one place a bypass run's agent can reach push credentials by design of the
  owner's choice: an approved bypass agent with a shell can read the operator's push credentials (`~/.ssh`, a credential
  helper's store) while the `push` tool is offered. The controller still never gives them to it. Recorded as R-51
  (accepted by the owner for bypass, not blocking) in the roadmap; R-48 now excludes approved bypass runs from its
  controls.
- **Alternative rejected.** Keeping the withhold and telling bypass runs to use the operator command: it blocks Git
  operations for bypass runs through Switchboard, which is what zemdregon asked not to do.

## Revisit when

M10 delivers container environments (a third BR-31 route), a provider manifest gains a credential-confinement
declaration, an operator needs to push while `serve` runs, a violation needs a "reviewed" state, or Git changes how
`--porcelain` reports a rejection.
