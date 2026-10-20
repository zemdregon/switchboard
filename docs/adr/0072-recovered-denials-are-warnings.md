# ADR-0072: Recovered, non-security permission denials are run warnings, not failures

- Status: Accepted (built 2026-10-20). Amended 2026-10-20 by Linus: the `rule` mapping, see
  [Follow-up](#follow-up-2026-10-20-git-deny-rule-hits-on-local-verbs).
- Date: 2026-10-20
- Decided by: Linus (design authority), 2026-10-20. The ruling (items 1 to 4 below) is Linus's; the exact class
  mapping (item 5) and the details marked **Delegated** were made while building it and are not owner-approved.
- Related: FR-POL-05, FR-GIT-01, FR-GIT-03, FR-AUTH-01, FR-MCP-15,
  [ADR-0039](0039-switchboard-side-tool-call-guard.md) (the tool-call guard),
  [ADR-0066](0066-claude-trusted-development-allowlist-prefix-rules.md) (Claude `trusted-development` allow rules),
  [ADR-0069](0069-mcp-publish-run-and-dynamic-project-push.md) (`publish_run`),
  [LLD §2](../design/LLD.md#2-adapter-contract) (`NormalizedEvent`), [LLD §4](../design/LLD.md#4-failure-taxonomy),
  [ROADMAP T3.26](../ROADMAP.md#65-m3-isolation-tasks).

## Context

Two whumpo-website runs on 2026-10-20 (`run_01M5D1YRABBYPBGFGWZGZHT18C`, `run_01M5D03ET12TRSYNJPTFH0V7MY`; Claude
Code 2.1.294, `trusted-development`) had five shell calls each denied (`system`/`permission_denied`), recovered with
other tools and ended with a successful `result` and exit 0. Switchboard still took T13 with pending
`PERMISSION_BLOCKED` ("denied: Bash"); the post checkpoint kept the work as evidence, the finalize commit was skipped
(`run_not_succeeded`) and the run ended `FAILED`, so `publish_run` could not publish it.

The cause: every adapter's `extractResult` treated any `permission_denied` event as "not clean", and `classifyCommon`
(`src/adapters/failure.ts`) maps the first `permission_denied` to `PERMISSION_BLOCKED`. Under `--permission-mode
dontAsk` (fail closed, ADR-0015) a command outside the allow rules is denied rather than asked, so an agent that tries a
command the profile does not allow, and then works around it, failed the whole run.

## Decision

1. **A recovered denial does not, on its own, fail a run.** When the provider otherwise reported success (clean
   expected exit, final `result` ok, no `provider_error` or `sandbox_violation`), no `tool_call` carries a tool-call
   guard verdict (ADR-0039) and every `permission_denied` event is of the recoverable class `profile`, the adapter
   result is a success. Verification, when configured, still runs and decides as before (T11/T14). The run then
   finalizes normally (finalize-only commit, publishable by `publish_run`).
2. **The denials are recorded as warnings.** The adapter result carries `warnings: [{ code:
   "PERMISSION_DENIED_RECOVERED", tool, count }]` (one entry per tool name, closed code, tool name matching
   `^[A-Za-z0-9_.:-]{1,64}$` or else `unknown`, never agent text). The lifecycle stores them on the `SUCCEEDED`
   transition's payload, and the run envelope (`get_run`, `list_runs`, `get_digest`) shows them as `result.warnings`
   (re-checked against the closed shape on read). A `permission_denied` provider event records its class (`denial`)
   beside `kind`, nothing else.
3. **Security-class denials still fail the run, as today.** Any of the following keeps the run `FAILED` with the code
   it has today (`PERMISSION_BLOCKED`, or `SANDBOX_VIOLATION` for a guard's provider-state verdict):
   - a denial whose class is not `profile`: `git_write` (a Switchboard Git deny rule, FR-GIT-01), `outside_worktree`
     (a file tool outside the worktree or allowed roots), or **no class at all (unknown: fail closed)**;
   - a `tool_call` the tool-call guard flagged: a Git write (`git_write`, FR-GIT-01) or a path under a provider
     configuration or credential directory (`provider_state`, FR-AUTH-01) — the credential classification the policy
     layer has (`src/policy/provider-state.ts`);
   - a `sandbox_violation` event (provider or outer sandbox);
   - a security-class refusal the controller itself recorded for the run while it ran: any tool-channel refusal
     (`git_tool_denied`: path outside the worktree, refused push, token or binding mismatch, ...) or any
     `secret_scan_hit` that is not the commit-stage warning (a blocked push) — checked before T12/T13, detail
     `denied: <tool>; tool channel refusal` / `...; secret scan block`;
   - a Git ref change the FR-GIT-03 ref check found at FINALIZING (detail `denied: <tool>; git refs changed`). Without
     recovered denials a ref violation still does not change the outcome (unchanged).
4. **A provider failure after a denial still fails as today.** A non-ok `result`, an unexpected exit code, a timeout,
   a crash or a cancellation is classified exactly as before (`classifyCommon`, so a denial still yields
   `PERMISSION_BLOCKED` first); the denial does not rescue it.
5. **Class mapping (Delegated).** Only an adapter that can positively identify a denial sets its class:
   - Claude Code (`src/adapters/claude/parse.ts`, `claudeDenialClass`), from `system`/`permission_denied`
     `decision_reason_type` (values observed on 2.1.294 in the operator's run streams, 2026-10-20; the `message` text is
     never read): `mode` on `Bash` -> `profile` (a command no allow rule admits, denied by dontAsk); `mode` on any other
     tool -> unclassified (a file-tool write to Git, settings or tool-configuration files that `--restricted` reserves for
     a person would be denied the same way); `rule` -> `git_write` (the only `--disallowedTools` rules Switchboard
     passes are the FR-GIT-01 Git deny rules; *narrowed 2026-10-20, see the Follow-up below*); `other` ->
     `outside_worktree` (seen only for `--restricted` file-tool confinement); `subcommandResults` (a compound command
     one of whose parts was denied; the part's reason is not reported; seen for Git and `gh` deny rules) and anything
     else -> unclassified. A `result.permission_denials` entry
     with no `system` event before it carries no reason and stays unclassified.
   - The fake adapter's JSONL mode takes the class from its plan (test seam).
   - Every other adapter, and every ACP-driven denial, sets no class, so their denials keep failing the run exactly as
     before. Mapping the ACP permission handler's reasons (`kind_not_in_profile`, `execute_not_allowlisted`) to
     `profile` is a possible follow-up, not done here.
6. **Nothing the agent may do widens.** No allow rule, deny rule, flag, sandbox, guard or channel check changes; this
   decision changes only how a recovered denial is classified at run end.

## Consequences

- A Claude run that hit a dontAsk shell denial and recovered now succeeds and can be published; the warning tells the
  orchestrator which tool was denied and how often.
- *(Narrowed 2026-10-20 by the Follow-up below: a deny-rule hit on a read or local ref verb is now recoverable.)*
  A run with a Git deny-rule hit still fails, even when the denied command was a read (`git branch -a`, `git log` in
  a loop: Claude's deny rules are lexical, ADR-0015). Both runs above had one such non-`mode` denial (a `rule` denial in
  the first, an `other` Glob outside the worktree in the second), so under this mapping they would still end `FAILED`;
  whether a lexical Git-rule hit on a command the guard reads as non-writing, or a read-only file tool outside the
  worktree, may be recoverable is open question Q-110 for the design authority ([ROADMAP §7.3](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted)).
- The policy layer's credential classification is provider-state directories only; a shell read of another secret
  (for example `~/.ssh`) denied by dontAsk is a recoverable `profile` denial. Widening that classification is a separate
  change.
- No migration: the warnings live in the terminal transition's payload, which the envelope already reads.

## Follow-up (2026-10-20): Git deny-rule hits on local verbs

- Decided by: Linus (design authority), 2026-10-20. The exact local-verb set, the tokenizer and the bounds are
  **Delegated**, not owner-approved. This narrows item 5's `rule` row; the text above is kept as the original record.

In `run_01M5D1YRABBYPBGFGWZGZHT18C` the single `rule` denial was a Bash loop of `git log -1 ... -- $f` plus
`git branch -a`, which matched the FR-GIT-01 deny rule `Bash(git branch *)`. Claude's deny rules are lexical, so the
rule blocked a read before it ran; nothing was written. Under the ruling, security-class Git denials are pushes and
remote or transport writes and anything that can redirect Git to another repository, not every verb the deny list
happens to match.

For a Claude `rule` denial of `Bash`, the parser looks up the denied `tool_use` by the `permission_denied` event's
`tool_use_id` and reads its `input.command` (`gitDenyRuleSecurityReason` in `src/adapters/git-write.ts`; nothing is
executed). The command is split on `;`, `&`, `|`, newlines, `(`, `)`, `$(` and backticks; in each simple command the
program is the first word after shell keywords (`do`, `then`, ...) and `NAME=value` prefixes.

| `rule` denial on `Bash` whose command ... | Class (as of 2026-10-20) |
| --- | --- |
| only runs `git` with a read subcommand or a local ref or index verb (`branch`, `tag`, `stash`, `checkout`, `switch`, `reset`, `restore`, `add`, `rm`, `mv`, `commit`, `merge`, `cherry-pick`, `revert`, `notes`, `reflog`, and the read-only set of `GIT_READ_ONLY_SUBCOMMANDS`), with only harmless global flags (`--no-pager`, `-P`, ...) | `git_rule_local` (recoverable; warning `GIT_RULE_DENIED_RECOVERED`, tool `Bash`) |
| runs any other Git subcommand (`push`, `send-pack`, `remote`, `fetch`, `pull`, `config`, `update-ref`, `symbolic-ref`, `submodule`, `clone`, `worktree`, `rebase`, `bisect`, an alias, ...) or a dynamic one | `git_write` (fail) |
| uses a Git global option other than the harmless flags (`-C`, `-c`, `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, `--bare`, ...) | `git_write` (fail) |
| runs `gh`, a `git-<name>` program, a dynamic program, sets a `GIT_*` variable, passes `git`/`gh` to another program (`xargs`, `find -exec`) or to a launcher, shell or `eval` | `git_write` (fail) |
| gives a local verb an option that runs a program or writes elsewhere (`-O`, `--output`, `--exec`, `-x`, `--upload-pack`, `--receive-pack`) | `git_write` (fail) |
| cannot be found (no `tool_use` with that id seen, or past the bound of 4096 remembered commands), is empty, longer than 16384 characters, or contains no `git` invocation | `git_write` (fail closed) |
| `rule` on any tool other than `Bash` | `git_write` (fail) |

Unchanged: `mode` on `Bash` -> `profile`; `other` (file tool outside the worktree) -> `outside_worktree`; every
unknown reason, `subcommandResults` and result-only denials -> unclassified (fail). The FR-GIT-03 ref check at
FINALIZING still fails a run with recovered denials when any ref moved, and the tool-call guard, sandbox, channel and
provider-failure rules of items 3 and 4 still apply. `fetch` and `pull` are security-class whatever their arguments
(**Delegated**: simpler and stricter than "with a URL or remote write").
