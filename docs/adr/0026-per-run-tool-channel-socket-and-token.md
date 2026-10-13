# ADR-0026: Per-run tool channel: `tool-shim`, Unix socket, capability token and `GitCapabilities`

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions) (best practice for a
  decision that does not change what a bypass run may do). Not an Ender quote and not owner-approved. Recorded as owner
  decision 33 in the roadmap for traceability only. The channel itself was already proposed in
  [ADR-0014](0014-tool-only-commits-and-publication.md) item 2 and [LLD §12.2](../design/LLD.md#122-channel); this ADR
  records the trust boundary and external interface AGENTS.md requires an ADR for, and the mechanisms the LLD left open.
- Related: FR-GIT-01, FR-GIT-02, FR-GIT-04, FR-GIT-07, FR-POL-03, FR-POL-08, FR-EXE-07, FR-TEL-03, NFR-SEC-01,
  [ADR-0014](0014-tool-only-commits-and-publication.md), [ADR-0015](0015-claude-untrusted-isolation-flags.md),
  [ADR-0024](0024-project-id-columns-and-project-snapshot.md), [ADR-0025](0025-git-commit-provenance-and-sanitiser.md),
  ROADMAP T9.4, R-18, R-46, Q-40, Q-41, Q-43

## Context

T9.3 built the controller-side commit library. An agent can reach it only through a channel that crosses from the
agent's process tree into the controller: HLD trust boundary TB-7. LLD §12.2 sketched `switchboard tool-shim --socket
<path>`, a socket under `<data_dir>/runs/<run_id>/` (directory `0700`, socket `0600`) and a token in the shim's
environment, and left open: the wire format, the token's strength and storage, the order of checks, limits, what
happens when the socket path is too long (T9.0 saw a 108-byte kernel limit; on this host Node 22.22.0 accepted a
251-byte path in `listen()` and left no file at it, so a long path is not refused, it silently goes elsewhere), what a
crash leaves behind, and which run facts the channel uses. The T9.0 spike also found that no real provider's channel
behaviour is verified: Claude Code's per-run form is `--mcp-config`, which ADR-0015 and the argv audit bar (Q-40), and
Codex is not installed.

## Decision

1. **Shim.** `switchboard tool-shim --socket <path>` is an internal subcommand (not in `--help`), dispatched before the
   operator argument parser. It serves MCP on stdio (`commit` only, with the LLD §12.1 schema) and forwards each call as
   one line of JSON over a fresh connection to the socket. It imports only `src/git/tool-protocol.ts` from the
   controller (constants, no Git, no ledger) and holds one secret: the token, read from `SWITCHBOARD_TOOL_TOKEN` and
   deleted from its environment at start. `push` is not offered until T9.6.
2. **Wire format.** One request per connection: `{"v":1,"token":...,"tool":...,"arguments":{...}}\n`, answered by one
   line `{"ok":true,"result":{"sha","files_changed"}}` or `{"ok":false,"error":{"code","message"}}`, then the
   controller closes. Requests are at most 2 MiB and must arrive within 10 s.
3. **Token.** `sbt1_` plus 32 bytes from `crypto.randomBytes` in base64url (256 bits), one per run. The controller keeps
   only its SHA-256 digest in memory and compares digests with `timingSafeEqual`. The token reaches the provider only in
   `Invocation.env` (never argv, never a file), is never written to the ledger, an artifact, a log line or the file
   system, and the artifact redactor removes anything with its shape. It is bound to the run id, meta-session and
   worktree path recorded when the channel opened; a call is refused if the run's record no longer matches.
4. **Checks per call, in order, each refusing with no side effect except a `git_tool_denied` run event (code only):**
   size and framing; rate limit (60 per rolling minute per channel, every request counts); exact request shape; channel
   open; token; tool offered; arguments (exactly `message` of 1 to 8192 characters and optional `paths`, 1 to 256 strings
   of at most 4096); run exists, is RUNNING and matches the binding; then `GitPublisher.commit` (state, lease, path
   refusals, sanitiser, provenance, ADR-0025). At most 32 refusal events per channel; the rest are counted in
   `git_channel_closed`. At most 8 simultaneous connections. Messages returned to the agent are fixed texts except for
   path, empty-message and sanitiser refusals, which describe only the agent's own input.
5. **Socket placement.** `<data_dir>/runs/<run_id>/tools.sock` when that path is at most 100 bytes (the kernel limit is
   108 including the terminating NUL); otherwise a `mkdtemp` directory `sb-git-XXXXXX` directly inside the first usable
   fallback directory (`$XDG_RUNTIME_DIR`, then the OS temporary directory). Every directory is checked with `lstat`
   (real directory, not a link, owned by this user, no group or other bits) before use; the socket is `chmod 0600` and
   checked to be a socket. If nothing fits, the channel is not opened and the run fails `TOOL_FAILURE` before spawn.
6. **Peer credentials.** Node.js has no `SO_PEERCRED`; the peer process is not identified. The controls are the private
   directory, the socket mode and the token. A process of the same OS user that can read the provider's environment
   can use the token while the run is RUNNING: the same reach the agent already has (R-46).
7. **Lifetime.** The lifecycle opens the channel after the compile and immediately before spawn, appends the adapter's
   `channelArgs` to the compiled invocation (the argv audit runs over the result), and closes it in a `finally` as soon
   as the provider process has exited, before FINALIZING: no new connections, idle connections dropped, calls already
   past the checks finish, socket and directory removed, `git_channel_closed` appended. `git_channel_opened` records
   the socket directory (not the token). At `serve` start, after reconciliation, `GitPublisher.recover()` runs, then a
   sweep closes every channel left open by a crash: it unlinks only a socket and removes only an empty directory that is
   `<data_dir>/runs/<run_id>` or an `sb-git-*` directory inside a configured fallback directory and passes the
   ownership and mode checks, and appends `git_channel_closed` (`reason: "recovered"`).
8. **When the channel is offered.** Only for a write-capable run (a worktree) whose frozen policy snapshot has a
   project in a `host` environment with a writable primary context and a commit identity, and whose adapter declares
   `gitCapabilities.commitChannel = "injected"`. Otherwise nothing is started; a project run that misses one of these
   gets a `git_channel_not_offered` event with a reason code.
9. **Policy snapshot freeze (Q-41).** The project block of the policy snapshot gains `writable`, `identity` (when
   configured) and `push.policy`; the channel uses only these frozen facts, so a configuration edit after admission does
   not change a run's commit identity. The push remote and branch prefix are not frozen: the schema does not restrict
   `remote` to a remote name, so it could hold a URL with credentials, which must not reach the ledger. No new column.
10. **`GitCapabilities`.** Added to the adapter contract as LLD §2 proposed, plus a `detail` reason. The fake adapter
    declares `injected` (shim command in argv `--tool-channel`, token in the environment). Claude Code and Codex
    declare `none` with the reason (Q-40 and unverified live behaviour; Codex not installed); their argv is unchanged.
    The LLD rule that a `none` adapter is ineligible for write-capable profiles without the finalize-only opt-in is not
    enforced yet (Q-43).
11. **Effect on bypass mode: none.** No adapter that can run an approved bypass scope declares a channel, so no bypass
    run gets a socket or token; no flag, approval, Git-write denial or worktree rule changes.

## Alternatives considered

- **Token in argv or in a definition file.** Rejected: argv is visible to every local user through `ps`, and a file
  is one more place a secret could persist. The environment is readable only by the same user (and root).
- **One long-lived connection per shim with a hello message.** Rejected for now: one request per connection keeps every
  call independently checked and makes "stale" and "closed" unambiguous; the cost is one local connect per call.
- **Abstract-namespace Unix sockets (no file, no length limit).** Rejected: no file-system permissions apply, so any
  local process could connect and the token would be the only control; Linux-only.
- **Serialising commits per run.** Rejected: the commit library's compare-and-swap already handles concurrent calls,
  and the test of two concurrent commits shows the retry.
- **Freezing the whole push block.** Rejected for the remote (credential risk above); T9.6 decides how the push
  target is resolved.

## Consequences

- New trust boundary implementation (TB-7) and external interface (the `tool-shim` subcommand and the wire format).
- New run event types: `git_channel_opened`, `git_channel_closed`, `git_tool_denied`, `git_channel_not_offered`.
- Only the fake adapter can commit through the tool; real providers still produce diffs only, until Q-40 and live
  checks allow a channel or T9.7 adds finalize-only.
- A run whose socket cannot be placed fails before spawn rather than running without the tool it was configured for.
- Policy snapshots written before this change have no `identity`; their runs (already finished) are unaffected, and a
  continuation gets a fresh snapshot.

## Revisit when

Q-40 is decided and a live check shows a provider can take the channel without a bypass flag, Node.js gains a peer
credential API, T9.6 adds `push`, or a provider sandbox turns out to block the connect (then that adapter is
`finalize-only`).
