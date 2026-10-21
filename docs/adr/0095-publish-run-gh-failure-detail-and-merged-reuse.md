# ADR-0095: `publish_run` returns a sanitised `gh` failure detail and reuses an already merged pull request

- Status: Accepted (built 2026-10-21). Amends [ADR-0069](0069-mcp-publish-run-and-dynamic-project-push.md) in part
  ("stderr is never read" for the pull-request port; "an open pull request for the branch is reused"). The rest of
  ADR-0069 stands.
- Date: 2026-10-21
- Decided by: **Delegated** (agent, operator task `fix/publish-gh-failed`, 2026-10-21); not owner-approved. It does not
  change what a bypass run may do (owner decision 25).
- Related: FR-GIT-12, [LLD §3.4.12](../design/LLD.md#3412-publish_run-and-publications-fr-git-12-adr-0069),
  [ADR-0050](0050-ci-status-via-operator-gh-cli.md), [ADR-0087](0087-submodule-projects.md), ROADMAP T9.24.

## Context

On 2026-10-21 MCP `publish_run` for three whumpo-website runs (client `grok-bot`) returned `pull_request: null` with
`pull_request_error: "GH_FAILED"` and nothing else. Because the port never read `gh`'s stderr, the cause could not be
seen from the result, the ledger or the log. Reproducing the call with the service's argv and allowlisted environment
showed `gh` was logged in and allowed. The failure was in the state of the runs:

1. Each run had already been published and its pull request (#321, #322, #323) squash-merged through `merge_run_pr`.
   GitHub then deleted the head branch.
2. A second `publish_run` reused the recorded ACCEPTED push, so nothing was pushed again. G14 (`gh pr view <branch>`)
   found the merged pull request. ADR-0069 reuses only an `OPEN` one, so the controller ran G13 (`gh pr create`) for a
   branch that no longer existed. GitHub refused it: `GraphQL: Head sha can't be blank, Base sha can't be blank, No
   commits between main and <branch>, Head ref must be a branch (createPullRequest)`, exit 1.

## Decision

1. **Merged reuse.** When G14 reports `MERGED` for the branch and this meta-session's ledger already has a
   `pull_request` row (umbrella) or `submodule_pull_request` row (linked repository) with that number, repository and
   the publication's head, `publish_run` returns that pull request as `{ number, url, draft, reused: true, merged: true
   }` and calls no G13. No new row is written. A merged pull request that the controller did not record for that head
   (for example, new commits after the merge) still leads to G13, as before. `CLOSED` is unchanged.
2. **Failure detail.** `execGh` keeps the tail of stderr, at most 4096 characters, only when `gh` exits non-zero. The
   pull-request port (G13, G14, G16, G17) turns a non-zero exit that is not `AUTH_REQUIRED` into `GH_FAILED` with
   `{ exit_code, reason, message }`:
   - `reason` comes from a closed list: `HEAD_BRANCH_MISSING`, `BASE_BRANCH_MISSING`, `NO_COMMITS`,
     `PULL_REQUEST_EXISTS`, `RATE_LIMITED`, `PERMISSION_DENIED`, `NOT_FOUND`, `NETWORK`, `VALIDATION_FAILED` or
     `UNKNOWN`. It is chosen by the first matching pattern, and the head checks come first.
   - `message` is the stderr after the secret rules of `src/artifacts/redact.ts`. Non-printable characters are
     removed, lines are joined with ` | `, and the text is capped at 300 characters. It then goes through the `get_run`
     outbound scrubber (paths outside allowed roots).
   - `publish_run` returns it as `pull_request_error_detail`, both top level and on a `submodules[]` entry, next to the
     unchanged closed `pull_request_error`. The detail is returned only. It is not written to the ledger or the log.
3. The CI status port (`GhCiStatusPort`) still ignores stderr; its errors stay closed codes.

## Consequences

- An operator or orchestrator can tell a missing branch from a permission or rate-limit failure without reproducing
  the call. A client that keeps re-publishing merged runs gets the merged pull request instead of an error.
- `gh` output now reaches an MCP client in a bounded, redacted form. GitHub's error text can quote branch names and the
  repository name, which the caller already knows. The redaction rules are a best-effort safety net (as in FR-TEL-03);
  `gh` is run without token variables (ADR-0050), so a token in stderr is not expected.
- The output schema gains the optional `merged` (const `true`) and `pull_request_error_detail`. Existing clients that
  ignore unknown optional fields are unaffected.

## Alternatives considered

- **Return the raw stderr.** Rejected: unbounded, and it could carry control sequences or secrets.
- **Return only the closed reason.** Rejected: an unclassified failure would again be opaque. The capped, redacted
  excerpt is the least that lets the caller act.
- **Add `headRefOid` to G14 to compare the merged head without the ledger.** Rejected for now: that widens the audited
  argv, and the ledger already records every pull request this controller opened, with its head.
