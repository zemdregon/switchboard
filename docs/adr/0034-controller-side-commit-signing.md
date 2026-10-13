# ADR-0034: Controller-side commit signing: the signing step's trust boundary and repository configuration

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions). Not a zemdregon quote and
  not owner-approved. That published commits may be signed is zemdregon's answer to Q-9 ("yes", owner decision 9); the
  rule (FR-GIT-10, FRD BR-33) and the outline ([LLD §12.3.1](../design/LLD.md#1231-signing-fr-git-10)) were already
  specified with the mechanism delegated. This ADR records the credential boundary AGENTS.md requires an ADR for, and
  the mechanisms the specification left open. Applying the owner decision 37 exemption to signing was a Delegated
  reading; zemdregon answered **Yes** (2026-10-13, in chat: "Q-56 yes"), see
  [Q-56](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted): the exemption also covers
  signing, and in an approved bypass run the agent may reach the signing key, the same rule as push.
- Related: FR-GIT-06, FR-GIT-10, FR-EXE-07, NFR-SEC-01, FRD BR-31, BR-33, [ADR-0003](0003-no-credential-handling.md),
  [ADR-0014](0014-tool-only-commits-and-publication.md), [ADR-0025](0025-git-commit-provenance-and-sanitiser.md),
  [ADR-0028](0028-controller-push-and-credential-reach.md), ROADMAP T9.10, R-15, R-60, Q-56

## Context

Until T9.10 every controller Git call except the push ran through the hardened helper (`src/workspace/git.ts`): no
global or system configuration, no inherited `GIT_*`, no `HOME`. A signature cannot be made that way: FR-GIT-10 says the
controller signs "through the operator's existing Git signing configuration", which lives in the operator's global
configuration (`user.signingkey`, `gpg.format`, `gpg.program`) and in the variables that locate the operator's keyring
or agent (`GNUPGHOME`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, the `gpg-agent` socket under `XDG_RUNTIME_DIR`). So signing
makes the controller invoke the operator's signing tooling with the operator's key access: a new credential boundary
crossing, next to the push (ADR-0028). Left open by the specification: which environment the signing step sees, how the
repository's own (untrusted) configuration is kept from choosing the signing program or key, how BR-31 maps to signing,
how failure is reported without key material, and what `projects validate` checks.

## Decision

1. **Where signing happens.** Only in `GitPublisher.commit` (`src/git/commit.ts`), the one controller path that creates
   published commits, used by the agent `commit` tool and by the finalize-only commit; and in `projects validate`. With
   `sign` off (the default) neither path changes: the published commit is made by the hardened helper exactly as before,
   and the operator's signing setup is never consulted, even if it sets `commit.gpgsign = true`.
2. **Environment (allowlist, fail closed).** The signing `git` child gets `PATH`, `HOME`, `USER`, `LOGNAME`,
   `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `GNUPGHOME`, `GPG_AGENT_INFO`, `SSH_AUTH_SOCK` from the controller's
   environment when set, plus `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, the six identity variables, and the controller's own
   `GIT_DIR` and `GIT_OBJECT_DIRECTORY` (item 3). No inherited `GIT_*`, no `DISPLAY`, no askpass variable. It runs in
   its own session (no controlling terminal), with standard input carrying only the message and a 60 s timeout
   (Proposed) that kills the process group. The provider process is unchanged: its adapter's allowlist (`PATH`, and
   `HOME` for Claude Code and Codex) names none of the agent variables, which a test checks with the controller holding
   all of them.
3. **The repository's configuration is never read for signing.** `git commit-tree -S` runs with `GIT_DIR` set to a fresh
   scratch bare repository the controller creates (and removes) and `GIT_OBJECT_DIRECTORY` set to the real repository's
   object store. Git reads the tree and parent from the repository and writes the signed object into it, but the only
   configuration it reads is the operator's global and system files and the empty scratch repository's own. A
   repository-local `gpg.program` therefore cannot run, even if it is written between a check and the signing call.
4. **Repository signing keys are refused, not ignored.** In addition, mirroring `REPO_CONFIG_UNSAFE` (ADR-0028), a
   repository whose own configuration (local or worktree scope, including included files) sets any `gpg.*` key or
   `user.signingkey` is refused before anything is built: `SIGNING_FAILED` with reason `repo_config_unsafe`, and
   `projects validate` reports `SIGNING_CONFIG_UNSAFE`. Rationale: an operator who configured signing per repository
   would otherwise get commits signed with a different (global) key without noticing; refusing is the fail-closed
   choice.
5. **BR-31.** Signing uses `evaluateSigningReach` (`src/git/credential-reach.ts`): the same function body as the push
   rule (`host` environment; a profile without arbitrary shell or an empty allowlist; a privileged run judged by its
   approved scope; an unverified bypass claim refused), minus the push-policy precondition, which concerns `push` only.
   The owner decision 37 exemption is applied unchanged: a run whose approved bypass the controller has verified is
   `ok` with reason `bypass_exempt`. It is evaluated per call from the frozen snapshot and the ledger, as for `push`.
   A refusal is `SIGNING_FAILED` with reason `credential_reach` and the BR-31 reason.
6. **Failure, no fallback.** Any refusal, a non-zero exit, a timeout, a spawn error, or a commit object without a
   `gpgsig`/`gpgsig-sha256` header is `SIGNING_FAILED` to the agent (a fixed message with the reason code) or
   `{outcome: "failed", reason: "SIGNING_FAILED"}` in the finalize-only event. It happens before the
   `git_commit_intent` event, so the compare-and-swap never runs and the publish ref is untouched. A
   `git_commit_signing_failed` run event records `{origin, reason, credential_reach?}` only. Git's and the signing
   program's output is discarded. A signed commit adds `signed: true` to the intent and the `git_commit` event.
7. **What is signed.** The same tree, parent, identity, dates and sanitised message as an unsigned commit; Git adds only
   the signature header. Signing adds nothing about the run, so the signature carries only the operator's key identity.
8. **Snapshot and configuration.** The primary context's `sign` is frozen into the policy snapshot as `sign: true`
   (absent when off) like the identity (Q-41). The configuration loader refuses `sign: true` on a context without an
   `identity` or on a context that is not the primary writable one, as for `finalize_commit`.
9. **`projects validate`.** For each context with `sign: true` whose filesystem checks pass, the repository's own
   configuration is checked (item 4) and one test signature is made on an empty root commit in a throwaway scratch
   repository with the environment the command runs in; failure is `SIGNING_UNAVAILABLE` with the reason code. It runs
   only from `projects validate`; at run time every signed commit fails closed on its own.

## Consequences

- The controller now invokes the operator's signing program with the operator's key access, as it already did for push
  credentials. It never reads, stores, prints or logs a key, passphrase, keyring or agent socket and never runs `gpg` or
  `ssh-keygen` itself; the operator's Git does.
- Signing never depends on anything an agent could have written into the repository's configuration.
- An operator `includeIf "gitdir:..."` that selects a signing key by repository path does not match the scratch
  `GIT_DIR`, so such a key is not used (the commit then fails or is signed with the unconditional key). Conditions that
  do not depend on the repository path are unaffected. Recorded as a limitation in LLD §12.3.1.
- Signed objects are written as loose objects with the controller's umask; a repository `core.sharedRepository` setting
  is not applied to them (Assumption: not needed for a single-operator deployment, ADR-0011).
- Where BR-31 refuses (a `host` run with a shell), a context with `sign: true` cannot publish through the agent tools at
  all; this is stricter than `push`, which leaves the commit and only withholds the push. With approved bypass runs
  exempt (item 5), an agent in such a run may reach the operator's keyring or agent if its shell can (R-60).
- Verified only with GnuPG and a throwaway, unprotected key. SSH, X.509, passphrase-protected and hardware keys, and the
  operator's real agent, are unverified.
