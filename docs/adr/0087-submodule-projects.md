# ADR-0087: Umbrella projects with Git submodules, linked publication and ordered merge over MCP

- Status: Accepted (built 2026-10-21). Narrows [ADR-0022](0022-nested-repositories-excluded-from-controller-git.md)
  for declared submodules of an opted-in context; extends [ADR-0068](0068-mcp-only-project-onboarding.md),
  [ADR-0069](0069-mcp-publish-run-and-dynamic-project-push.md), [ADR-0070](0070-mcp-merge-run-pr.md) and
  [ADR-0074](0074-fresh-base-for-cloned-projects-and-session-rebase.md).
- Date: 2026-10-21
- Decided by: Delegated (agent), from an operator task for zemdregon ("every step for an umbrella-with-submodules
  project must be possible solely over Switchboard's MCP surfaces; anything that is not is a Switchboard bug"), under
  [owner decision 25](../ROADMAP.md#42-owner-decisions). The task named the shape of the `submodules` setting, the
  hardening of submodule fetches, controller-made submodule commits, the ordered merge with gitlinks re-pointed to the
  merged commits and the opt-in `all_reported` check policy. Every detail below is the coder's, not owner-approved.
  Nothing here changes bypass runs, the Git-write denial (the agent still cannot run `git submodule`) or worktree
  isolation.
- Related: FR-PRJ-11, FR-PRJ-12, FR-GIT-14, FR-GIT-15, FR-SUB-03, FRD BR-59, BR-60,
  [LLD §3.4.17](../design/LLD.md#3417-submodule-projects-adr-0087), [ROADMAP T9.22](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks),
  Q-116, Q-117, Q-118.

## Context

Muxcore-Media/umbrella is a repository of 109 submodules (106 distinct repositories plus the `core` wiki; three
repositories are referenced by two paths each; default branches are mixed `main` and `master`; no repository has
branch protection or required checks). Onboarding it over MCP (2026-10-20, `~/operator-runs/umbrella/assessment.md`)
found eleven gaps, G1 to G11:

- G1 `project_sources` owners could only be changed by editing the operator configuration and restarting.
- G2 `list_projects` did not show identity, push remote and branch prefix, signing, `finalize_commit` or `base_ref`.
- G3 the clone, run worktrees, `refresh_project_base` and `rebase_session` never initialise submodules.
- G4 the controller excludes every nested repository (ADR-0022), so an edit inside a submodule is never committed and a
  gitlink bump cannot be committed.
- G5 the pre-push secret scan covers the umbrella only.
- G6 `publish_run` pushes one branch to one remote and opens one pull request.
- G7 no ordered merge: submodule pull requests first, then the umbrella with its gitlinks re-pointed to the merged
  commits (a squash or rebase merge changes the SHAs).
- G8 the merge gate refuses `no_required_checks` on a repository without branch protection, which is every Muxcore
  repository.
- G9 per-submodule default branches and duplicate-URL paths are not modelled.
- G10 every submodule repository must pass `project_sources` as the umbrella does.
- G11 `core.wiki` is a GitHub wiki: it has no pull requests.

Project contexts are not a fit (at most 32 per project, each its own primary-less read-only mount; only the primary
context gets a worktree), so submodules are modelled inside the primary context.

## Decision

### 1. Opt-in setting (FR-PRJ-11)

A repository context may set `submodules: { mode: "off" | "recursive", writable_paths?: string[], exclude?: string[] }`.
Absent or `mode: "off"` is today's behaviour exactly (ADR-0022 for every nested repository). Rules (structure,
`INVALID_REQUEST`):

- only the primary context may set `mode: "recursive"` (`SUBMODULES_PRIMARY_ONLY`): only it gets a worktree;
- `writable_paths` and `exclude` hold at most 512 worktree-relative POSIX paths each (no leading `/`, no empty, `.` or
  `..` segment, no `.git` segment, no control character); `writable_paths` may instead be exactly `["*"]`, every
  declared submodule that is not excluded and not a wiki;
- `writable_paths` needs `mode: "recursive"` and a writable primary context; a path both writable and excluded is
  refused (`SUBMODULE_PATH_CONFLICT`).

A wiki (a repository name ending in `.wiki`) is never writable, whatever `writable_paths` says (G11). **Delegated**:
`create_project` and `update_project` read the umbrella's `.gitmodules` at `base_ref` and refuse a `writable_paths`
entry that names no declared submodule (`SUBMODULE_PATH_UNKNOWN`) or names a wiki (`SUBMODULE_WIKI_READ_ONLY`).

Approval (FR-PRJ-10): a revision whose `writable_paths` is non-empty waits for approval with the new reason
`submodule_write` (a push-kind reason, like `push_policy`, so the approval proxy lists it as `push_revision`). Turning
on `mode: "recursive"` alone only reads from allowlisted sources and needs no approval, as ADR-0074 decided for a
`clone_url` base remote.

### 2. Sources: every submodule URL passes `project_sources` (G10)

The controller never runs `git submodule` and never lets Git follow a `.gitmodules` URL. It reads the manifest itself
from the umbrella commit: gitlinks from `git ls-tree -r -z --full-tree <commit>` (mode `160000`) and names, paths and
URLs from `git config --blob <commit>:.gitmodules --no-includes -z --list`. Every gitlink that is not excluded must be
declared, and its URL must be `https://<host>/<owner>/<repo>[.git]` by the ADR-0068 rules (or `../<repo>[.git]`,
resolved against the umbrella's own source), with host and owner in the effective `project_sources` (item 8). Anything
else refuses the operation that read the manifest with a closed reason (`SUBMODULE_URL_INVALID`,
`SUBMODULE_SOURCE_NOT_ALLOWED`, `SUBMODULE_UNDECLARED`, `SUBMODULE_PATH_UNSAFE`, `SUBMODULE_MANIFEST_TOO_LARGE`) and
the offending path (never the URL text). Bound: 1024 submodules (**Delegated**).

### 3. Shared object stores, run worktrees, refresh and rebase (G3, G9)

- **Store.** Each distinct submodule repository has one clone at its ADR-0068 clone target
  `<clone_root>/<host>/<owner>/<repo>`, made with the ADR-0068 clone rules plus `--no-checkout`,
  `-c protocol.allow=never -c protocol.https.allow=always`, `submodule.recurse=false`, `fetch.recurseSubmodules=false`
  and hooks off. Two paths that reference one repository share one store. Stores persist between runs (the cache).
- **Commit presence.** Before use, each needed gitlink SHA is looked up in its store (`cat-file -e`); only a missing one
  causes a fetch of the store's `origin` branches, then, still missing, of the SHA itself; still missing is
  `SUBMODULE_COMMIT_MISSING`. Fetches of different stores run in parallel, at most 8 at a time (**Delegated**); fetches
  into one store are serialised.
- **Run worktree.** After `git worktree add` of the umbrella (unchanged), each declared, non-excluded submodule path is
  checked out at the umbrella base commit's gitlink SHA as a detached linked worktree of its store
  (`git -C <store> worktree add --detach <run worktree>/<path> <sha>`), through the hardened helper with a scrubbed
  environment, so no global or system filter, hook or fsmonitor runs. A manifest of the attached paths, with each
  path's admin directory name in its store, is kept beside the run worktree under the data directory; removal (`gc`,
  rollback, partial-worktree repair) detaches them, removing only each recorded admin directory, and prunes the
  stores. Nothing resolves a path through the agent-writable run worktree (admin directories are matched lexically),
  so a path replaced by a link into another run's worktree never selects that run's admin directory. Before every
  controller Git call inside a submodule worktree its `.git` link is verified against the store's worktree record (as
  `src/workspace/git-link.ts` does for the run worktree), and the call then names the verified admin directory and
  worktree explicitly (`--git-dir`, `--work-tree`); a tampered link is not used (`submodule_link_invalid` warning,
  nothing committed from that path; fail closed).
- **Checkpoints.** A run's checkpoint also checkpoints each changed writable submodule worktree in its store (controller
  identity, detached commit kept by a `refs/switchboard/checkpoints/...` ref) and records the new gitlink in the
  umbrella checkpoint, so a continued meta-session starts with its submodule edits. Changes in a read-only submodule
  are not carried (`submodule_changes_skipped` warning).
- **`refresh_project_base`** additionally makes sure every gitlink of the fetched base is present in its store (the
  bounded parallel fetch) and returns `submodules: { total, present, fetched, missing }`; a missing commit does not undo
  the refresh. **`rebase_session`** replays the umbrella as before; a gitlink both the session and the base changed is
  a `CONFLICT` naming that path (merge-tree cannot merge a submodule whose objects are not in the umbrella's store),
  and after a rebase the new base's gitlinks are made present.

### 4. Controller-made submodule commits (G4, FR-GIT-14)

ADR-0022 stays for every nested repository the agent creates and for every submodule of a context without
`mode: "recursive"`. For a declared submodule path of an opted-in context, the controller (never the agent: the
Git-write detector still blocks `git submodule` and `--recurse-submodules`) commits as follows, in the commit tool and
in `finalize_commit`:

1. For each writable submodule path, the tree of its worktree is written through a temporary index in its store (the
   same plumbing, nested-repository exclusion and skill-path exclusion as the umbrella commit). An unchanged tree is
   skipped.
2. A changed tree becomes one submodule commit with the context's `identity`, the same sanitised message and, as parent,
   the session's previous submodule commit for that repository or the umbrella parent's gitlink. It is kept by the
   store's publish ref `refs/heads/switchboard/pub/<meta-session>` (compare-and-swap) and recorded in the new append-only
   `submodule_commit` table in the same transaction as the umbrella's `git_commit` row.
3. The umbrella commit's temporary index gets the new gitlink (`update-index --cacheinfo 160000,<sha>,<path>`) for
   every path that references that repository (duplicate-URL paths are bumped together, G9). When two such paths
   changed to different trees the commit is refused `PATH_REFUSED` `submodule_duplicate_diverged`; when one changed,
   the other's worktree is moved to the new commit.
4. A changed read-only submodule (a wiki included) keeps its gitlink and is reported (`submodules_skipped`); an explicit
   `paths` entry inside it is refused `submodule_read_only`. An explicit path inside a writable submodule is committed in
   that submodule only.

Signing: `sign: true` signs the umbrella commit as today; submodule commits are signed the same way (the umbrella
repoint commit of item 7 is not signed: a known limit). **Delegated**:
repository-configured filters and hooks never run (scrubbed environment, `driverOverrides` of the store's config).

### 5. Secret scan of every repository (G5)

`publish_run` scans, before any push, the outgoing range of every changed submodule (from its last accepted push of the
same branch when that is an ancestor, else from the base gitlink) and of the umbrella (base commit to publish head).
Any finding refuses the whole publication with the ADR-0075 shape; each finding's `path` is prefixed with the submodule
path, and `details.repos` names the repositories with findings. The umbrella push then scans again, unchanged.

### 6. Linked publication (G6, FR-GIT-15)

`publish_run` on a run whose umbrella head changes gitlinks of writable submodules:

1. checks every changed gitlink is a recorded `submodule_commit` of the meta-session (`SUBMODULE_HISTORY_UNVERIFIED`);
2. scans (item 5);
3. pushes each changed repository's publish tip to `refs/heads/<branch_prefix><meta-session>` of that repository's
   own `https` URL (the store's `origin`), never forced, never to its default branch, with the ADR-0028 push hardening
   and an argv that names no credential; one append-only `submodule_push` row per attempt. An accepted push of the
   same head to the same branch is reused (idempotent);
4. pushes the umbrella exactly as before, only when every submodule push was accepted. The umbrella pusher's own
   policy and repository checks (repository configuration, remote URL and transport, protected target, unknown remote,
   verified history) run without pushing before step 3, so such a refusal comes before any submodule push. Otherwise
   the call is refused `TOOL_FAILURE` (or `PERMISSION_BLOCKED` for a policy refusal) `SUBMODULE_PUSH_FAILED` with
   `details.submodules` naming each repository's outcome; a retry pushes only what is missing;
5. opens or reuses one pull request per changed repository against that repository's default branch (read from the
   store's `origin/HEAD`), then the umbrella pull request, whose body lists every linked pull request. A `gh` failure for
   one repository is reported on that repository and never undoes a push. Rows: `submodule_pull_request`.

The result keeps every existing field and adds `submodules: [{ repo, paths, branch, head_sha, default_branch,
publication, pull_request, pull_request_error? }]`. `get_run`, `list_runs` and `get_digest` publications gain
`linked_pull_requests`, and each linked pull request is a `pull_request_opened` run event with its `repo`.

### 7. Ordered merge and the check policy (G7, G8, FR-SUB-03)

- `merge_policy.checks: "required" | "all_reported"` (default `required`, unchanged). `all_reported` means: at least
  one check ran at the head and every reported check passed (new audited argv **G18**, `gh pr checks <n> --repo <o/r>
  --json bucket`, without `--required`); none reported is the new refusal `no_checks_reported`. Setting `all_reported`
  waits for approval with the new reason `merge_checks`. The default is not weakened.
- For a run with linked submodule pull requests, `merge_run_pr` and the policy poller run one resumable step machine,
  persisted in the append-only `submodule_merge` table (so it survives restarts):
  0. umbrella pre-check, before any submodule merge (a submodule merge cannot be undone): the umbrella's conditions
     that do not depend on the repoint, at the published (pre-repoint) tip, with the gate's own reasons: the ref is not
     superseded; the umbrella pull request is open, not a draft, its head the published tip and its base the base
     branch; the run is verified at that tip and every required report is there;
  1. each linked submodule pull request, in path order, through the gate's checks (open, not draft, head equal to the
     pushed head, base equal to the repository's default branch, mergeable, checks per `merge_policy.checks`), merged
     with G12 pinned to its head; its merge commit is read with the new audited argv **G19** (`gh pr view <n> --repo
     <o/r> --json state,mergeCommit`) and recorded;
  2. when all are merged: the merged commits are fetched into their stores, and the controller writes one umbrella
     commit on the published umbrella tip that sets every changed path's gitlink (duplicates together) to its merged
     commit (`commit-tree`, the context identity, a `git_commit` provenance row), secret-scans and pushes it to the
     umbrella pull request branch (fast-forward, never forced), and records `gitlinks_repointed`;
  3. the umbrella pull request goes through the existing gate at the new head (the run's verification and reports are
     read at the pre-repoint tip, because the repoint commit changes gitlinks only); `check_pending` returns the
     progress and is retried;
  4. the umbrella is merged with G12.
  Each call advances as far as it can and refuses with the step's reason; `details.submodule_merge` carries the phase
  and each repository's state. The state is in `get_run` (`publications[].linked_pull_requests[].merge_state`) and in
  `get_digest` (`ref_events` of kind `submodule_merged`, `gitlinks_repointed`).

### 8. Effective definition and source grants over MCP (G1, G2, FR-PRJ-12)

- `list_projects` contexts gain `base_ref`, `push_remote`, `branch_prefix`, `identity` (`name`, `email`), `sign`,
  `finalize_commit` and `submodules`, for configured and dynamic projects; never a path or a secret.
- New MCP tool `request_project_source { owner, host? }` for a `manage_projects` client: an append-only
  `project_source_request` row and an `approval_pending` announcement. An approver client decides it with
  `decide_approval`; the new approval kind `project_source` is served only to an approver whose
  `approval_proxy_kinds` lists it explicitly (**Delegated**, least privilege: it widens a trust boundary, so an
  existing approver does not gain it silently). The operator decides it with `switchboard projects sources
  approve|reject <id>` too. An approved owner joins the configured `allowed_owners` at once (no restart), for
  `clone_url` and submodule URLs, on hosts already in `allowed_hosts`; a grant never adds a host. Decisions are
  append-only `project_source_decision` rows.

### 9. Persistence

Migration 0037 adds the append-only, `STRICT` tables `submodule_commit`, `submodule_push`, `submodule_pull_request`,
`submodule_merge`, `project_source_request` and `project_source_decision`. Ids, SHAs, `host/owner/repo` keys and
umbrella-relative submodule paths only; never a URL with credentials, a title, a body or `gh` text.

## Alternatives considered

- **`git submodule update --init --recursive`.** Rejected: it follows `.gitmodules` URLs (any protocol Git allows), runs
  per worktree into `<worktree gitdir>/modules` (106 fresh clones per run), and reads repository configuration the
  controller does not control.
- **One project context per submodule.** Rejected: 32 contexts at most, no worktree for non-primary contexts, and the
  gitlink relationship is lost.
- **Let the agent commit in submodules.** Rejected: it needs Git writes in the agent's reach (the detector blocks them by
  design).
- **Treat `no_required_checks` as pass when the repository has none.** Rejected: weakens the default; `all_reported` is
  explicit and approved.

## Consequences

- An umbrella project can be onboarded, run, published and merged over MCP only, once the operator approved the
  revision (and, if needed, the source owner).
- Submodule edits are captured by controller commits and run checkpoints; nested repositories the agent creates are
  still excluded (ADR-0022).
- The first run of a large umbrella clones every store (bounded parallel); later runs fetch only missing commits.
  `refresh_project_base` warms the cache.
- A wiki is read-only. A future ADR may allow pushing wiki changes directly.
- Not covered: nested submodules (a submodule's own `.gitmodules` is ignored: its submodules stay empty, Q-116),
  `ssh` submodule URLs, GitHub Enterprise, a submodule pull request merged by a person before the umbrella step (it is
  accepted when its merge commit is on the default branch), and editing an existing pull request body (Q-117). Open:
  whether `project_source` grants should expire (Q-118).

## Revisit when

A project needs nested submodules, a non-GitHub host, or writable wikis.
