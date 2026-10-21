# ADR-0069: MCP `publish_run`, pull requests through the operator's `gh`, and push from approved dynamic projects

- Status: Accepted (built 2026-10-20).
- Amended by [ADR-0078](0078-mcp-close-pr.md) (2026-10-21): MCP `close_pr` may close a pull request `publish_run`
  created, with one controller-built comment linking its replacement; "no edit, no comment" otherwise stands.
- Date: 2026-10-20
- Decided by: Linus (design authority) under owner ruling 2026-10-20 ([owner decision 78](../ROADMAP.md#42-owner-decisions)).
  The ruling sets the goal ("fix MCP project onboarding and run visibility, then onboard digifender-llc/whumpo-website
  over MCP only. If you can't do this solely over MCP then we have coded something wrong."); the details below are
  Linus's, not owner-approved individually.
- Supersedes: the Q-46 answer of [owner decision 62](../ROADMAP.md#42-owner-decisions) (push from an approved dynamic
  project refused by design) for approved dynamic projects whose in-force revision sets push policy `branch`. Decision
  62's Q-55 answer is unchanged.
- Related: FR-GIT-05, FR-GIT-06, FR-GIT-11, FR-GIT-12, FR-PRJ-10, FR-MCP-15, FR-QUE-01, FR-QUE-08, FRD BR-31,
  [ADR-0028](0028-controller-push-and-credential-reach.md), [ADR-0030](0030-dynamic-project-revisions-and-approval.md),
  [ADR-0050](0050-ci-status-via-operator-gh-cli.md), [ADR-0061](0061-pre-push-secret-scan-blocks-every-run.md),
  [LLD §3.4.12](../design/LLD.md#3412-publish_run-and-publications-fr-git-12-adr-0069),
  [ROADMAP T9.17](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks).

## Context

Publishing a finished run (pushing its branch and opening a pull request) needed the operator CLI
(`switchboard git push`) or a privileged bypass run whose agent called the `push` tool. An MCP-only orchestrating client
had no way to publish, and nothing in Switchboard opened a pull request, so it never got a pull request link. The owner
ruling of 2026-10-20 requires onboarding a repository over MCP only, branch and pull request included.

Separately, an approved dynamic project (ADR-0030) could never push: both push routes resolved push targets from the
configuration only, refusing `CONTEXT_UNKNOWN` (owner decision 62, Q-46). A dynamic project's in-force revision that
sets push policy `branch` has been approved by the operator for exactly that (`projects approve`, approval reason
`push_policy`, FR-PRJ-10), so the refusal blocked the only push-enabled projects an MCP client can create.

## Decision

1. **Push targets resolve from configuration, then the dynamic store** (`projectPushContextResolver`,
   `src/git/push.ts`). A configured project of the id wins, as at admission. Otherwise the dynamic project's IN-FORCE
   revision is read at push time; it resolves only when the project is not deleted, a revision is in force (a pending,
   rejected or never-approved create has none), and the creating client is still configured with `manage_projects` and
   `max_push_policy: branch`. Anything else is `CONTEXT_UNKNOWN` before any Git call (fail closed). The revision's own
   policy is used as is, so an in-force `none` is `POLICY_NONE`. The daemon (agent `push` tool and `publish_run`) and
   `switchboard git push` use the same resolver. Every other push rule (ADR-0028) is unchanged.
2. **New MCP tool `publish_run { run_id, open_pull_request = true, draft = false }`** (LLD §3.4.12). It is listed only
   for a client whose `max_push_policy` is `branch` (which the configuration allows only with `manage_projects`) and
   only when the server has the publish port (`serve`); a `console` profile never lists it. Ownership is exactly
   `get_run`'s: another client's or another HTTP subject's run is `unknown run`. The project must still be the
   client's (a configured project in its `projects` list, or a dynamic project it created) and its primary context's
   policy must be `branch`. The run must be `SUCCEEDED` and have a controller commit (`git_commit` row) of its own.
3. **The push is the controller's, not the agent's.** `publish_run` calls the same `GitPusher` as `switchboard git
   push` (never forced, configured remote and prefix, controller commits only, never the default or a checked-out
   branch, refused after a Git policy violation or with a skill file present), with
   `requested_by = mcp_client:<client id>`. BR-31 (credential reach) is a rule about the agent's `push` tool and does
   not apply, exactly as for the operator route; BR-31 and the agent `push` tool are unchanged. The pre-push secret
   scan of ADR-0061 runs and blocks as for every push (`PERMISSION_BLOCKED`, `details.reason: SECRET_SCAN_BLOCKED`);
   nothing in the request can change that. `serve` shares one pusher between the agent tool and `publish_run`, so
   pushes of one meta-session run one at a time.
4. **Idempotent.** When the meta-session already has an ACCEPTED push of the current publish head to the current target
   (remote and ref), nothing is pushed again and that push is returned (`publication.reused: true`).
5. **Pull requests through the operator's `gh`** (ADR-0050 port, audited argv): G14 `gh pr view <branch> --repo
   <owner>/<repo> --json number,state,url` first, and an `OPEN` pull request is reused; otherwise G13 `gh pr create
   --repo <owner>/<repo> --head <branch> --base <base> --title <t> --body <b> [--draft]`. `owner/repo` comes from the
   push URL of the context's push remote (`https://github.com/`, `ssh://git@github.com/` or `git@github.com:` forms);
   any other host is `REMOTE_NOT_GITHUB`. `--base` is the context's `base_ref` as a branch name. `gh` runs with the
   operator's stored login and the `ghEnv` allowlist (never a token variable); its binary is `ci_trigger.gh_binary`
   (default `gh`) even when the CI trigger is off. stderr is never read; stdout only through the parsers, which accept a
   URL only in the exact `https://github.com/<owner>/<repo>/pull/<n>` shape of the expected repository.
6. **Controller-built text.** Title `switchboard: <text>`, where the text is the run's `pr_draft` artifact title
   (inner-agent text) without control characters and capped at 120 characters, or the run id. Body: a controller
   footer (run, meta-session, provider, project, head SHA), then the `pr_draft` body capped at 16 KiB under a heading
   that labels it agent-written and untrusted.
7. **A `gh` failure never undoes the push.** The result then has `pull_request: null` and a closed
   `pull_request_error` (`GH_MISSING`, `AUTH_REQUIRED`, `TIMEOUT`, `GH_FAILED`, `PARSE_FAILED`, `REMOTE_NOT_GITHUB`,
   `BASE_INVALID`).
8. **Persistence: an append-only `pull_request` table plus a run event** (migration 0033, ADR-0005 rules). One row per
   pull request opened (`created`) or reused (`reused`, recorded once per number and head): run, meta-session, the
   `git_push` row it follows, requesting client, `owner/repo`, number, URL, head branch, base branch, head SHA, draft
   flag. The same transaction appends a `pull_request_opened` run event with those facts. A table rather than events
   alone because the envelope and idempotency need indexed lookups per run and meta-session; never a title or body.
   Migration 0033 also rebuilds `git_push` so `requested_by` takes `mcp_client:<id>` (case-sensitive `GLOB`).
9. **Publications in the envelope.** `get_run`, `list_runs` and `get_digest` (finished runs) envelopes of the caller's
   own runs carry `publications: [{ branch, head_sha, pushed_at, pull_request_url?, pull_request_number? }]` when the
   run has an accepted push recorded on it. This is a deliberate exception to the envelope's "no branch names": the
   remote branch is `<branch_prefix><meta-session id>`, never a run branch or path.
10. **Queued admission failure reasons are closed.** The `admission_failed` event's `reason` and `stage` are closed
    codes (`ADMISSION_FAILURE_REASONS`, `ADMISSION_STAGES`, `src/queue/admission.ts`), never error text; the scrubbed
    `message` stays. Recorded here because it is part of the same owner-ruling fix set (LLD §18.4 item 6).

## Alternatives

- **Let the agent push and open the pull request.** Rejected: it needs credentials in the agent's reach (BR-31) or a
  bypass run, and an agent-run `gh` is outside the audited argv.
- **Keep dynamic projects unpushable and require a configured project.** Rejected by the owner ruling (MCP-only
  onboarding). Approval of a `branch` revision already is the operator's push consent.
- **Pull-request facts as run events only.** Rejected for lookups (see 8); the event is kept for the timeline.
- **Pass the body through a file or stdin.** Not needed: one argv cell, no shell, bounded, never starting with `-`.

## Consequences

- An MCP-only client can onboard a repository (`create_project`, operator approval of the push revision), delegate,
  and publish with a pull request link, without the operator CLI. The operator's GitHub login opens the pull request.
- `publish_run` is a new outward-facing write with the operator's credentials, reachable by any client configured with
  `max_push_policy: branch`. It is bounded by the same push rules and secret scan as the operator route, and by the
  closed `gh` argv.
- A dynamic project's push now depends on the creator's current configuration: lowering `max_push_policy` or removing
  `manage_projects` stops pushes at once. ADR-0030's decision text is unchanged; its status line notes this ADR.
- The `gh pr view` / `gh pr create` argv and the parsers are Assumptions against `gh` as documented; no live `gh` call
  was made while building this (tests use a fake port and a fake runner).
- FRD BR-38 and SRS FR-INN-11 ("Switchboard never opens a pull request") get dated notes: the inner `pr_draft` task
  stays artifact-only; only `publish_run`, at an MCP client's explicit request, opens or reuses a pull request (never
  edits or comments). The `src/inner/pr-draft.test.ts` pin allows exactly `src/ci/gh-argv.ts`.
- Not covered: GitHub Enterprise hosts, a fork-based `--head owner:branch`, editing an existing pull request's text.

## Amendment 2026-10-20 (Linus, design authority): the run's own proposed pull request text

Production has no `pr_draft` artifact (the inner agent is off), so decision 6 titled real pull requests
`switchboard: run_<id>` with a metadata-only body although the run's result summary proposed a title and description.
Decision 6 is amended as follows; the rest of this ADR stands.

- **Source order.** The newest `pr_draft` artifact with a non-empty title or body, else a proposal extracted from the
  run's stored result summary exactly as `get_run` returns it (`result.summary`, scrubbed). Extraction
  (`extractProposal`, `src/mcp/publish.ts`): the first level 1/2 ATX heading that follows a thematic break line (`---`,
  `***`, `___`; blank lines between allowed), else a level 1/2 heading on the summary's first non-blank line; the
  heading text is the title and everything after the heading line is the body. Lines inside fenced code blocks are
  neither breaks nor headings. Otherwise there is no proposal; a title is never invented from prose.
- **Sanitising.** As before (control characters removed, title whitespace collapsed and capped at 120 characters, body
  capped at 16 KiB), plus: emphasis or code markers wrapping the whole title and a trailing period (not an ellipsis)
  are removed; an `@` before a user or team name (not inside a word, so email addresses stay) becomes the fullwidth
  `＠` (U+FF20) in the title and body, which GitHub neither links nor notifies, chosen as the simplest safe rewrite (no
  zero-width characters, no code spans). This also applies inside code blocks in the description. The description is
  capped so the controller footer always fits under the 20 KiB body limit, and a fenced block or HTML comment it
  leaves open is closed so the footer renders.
- **Layout.** Title `switchboard: <proposed title>` (the prefix still marks controller-opened pull requests). Body: the
  proposed description first, then a `---` line, a one-line label that the text above was written by the run's agent
  (untrusted, not reviewed by Switchboard; from the `pr_draft` artifact or from the run's result summary), then the
  controller footer (run, meta-session, provider, project, head). With no proposal the body is the footer alone.
- **Unchanged.** A reused open pull request is never edited.

Evidence: `src/mcp/publish-text.test.ts`, `src/mcp/publish-run.test.ts`.
