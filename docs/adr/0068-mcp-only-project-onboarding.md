# ADR-0068: MCP-only project onboarding: clone by URL, approval kinds over MCP, onboarding decisions, one workspace refusal

- Status: Accepted (built 2026-10-20)
- Date: 2026-10-20
- Decided by: Linus (design authority) under owner ruling 2026-10-20 07:22 CDT, relayed by Linus: "fix MCP project
  onboarding and run visibility, then onboard digifender-llc/whumpo-website over MCP only. If you can't do this solely
  over MCP then we have coded something wrong." The ruling sets the goal; the mechanisms below are Linus's design under
  it, and the coder's detail choices are **Delegated**. Zemdregon did not approve any detail line by line.
- Amends: [ADR-0030](0030-dynamic-project-revisions-and-approval.md) item 4 (a project's repository must already exist
  on the host: the `projects validate` filesystem rules require an existing Git repository, and no tool fetches one;
  ADR-0030 has no separate "no clone" item) and item 5 (the sentence "Only `switchboard projects approve ...` decides").
  Their decision text is not edited; both status lines point here.
- Reconciles: [ADR-0047](0047-approval-proxy-over-mcp.md). It records that the `dynamic_project` and `push_revision`
  proxy kinds are in use and accepted under the 2026-10-20 ruling, and adds `approval_proxy_kinds`. ADR-0047's
  `privileged_scope` proxying stays exactly as that ADR says.
- Related: FR-PRJ-10, FR-CTL-08, FR-CTL-13, FR-POL-10, FR-MCP-06, FRD BR-32, HLD TB-9,
  [ADR-0003](0003-no-credential-handling.md), [ADR-0005](0005-sqlite-ledger.md),
  [ADR-0028](0028-controller-push-and-credential-reach.md), R-65.

## Context

An MCP-only test against production on 2026-10-20 (onboarding `digifender-llc/whumpo-website` with no terminal) found
four problems:

1. **Project tools need a pre-cloned repository.** `create_project` and `update_project` take a `path` that must be an
   existing Git repository under an allowed root (ADR-0030 item 4). A client with no shell on the host cannot make one.
2. **Approval was CLI only.** A new revision that waits (ADR-0030 item 5) could be decided only by
   `switchboard projects approve`, so an MCP-only flow stopped at `PENDING_APPROVAL`. ADR-0047 added approval over MCP
   but offers all kinds or nothing, and the messages still pointed at the CLI alone.
3. **`request_decision` was impossible for a project that does not exist yet.** It required a project the client may
   use, so an orchestrator could not ask the operator "may I onboard this repository?" before onboarding it.
4. **A `workspace_path` existence oracle.** `delegate_task` answered "workspace does not exist" before it checked the
   allowed roots, so a client could probe which paths exist on the host (FR-POL-10).

## Decision

1. **Configuration `project_sources`** (top level, optional, strict):
   `{ "clone_root", "allowed_hosts"?, "allowed_owners" }`. `clone_root` is absolute, exists, resolves under an allowed
   root and is not inside `data_dir`. `allowed_hosts` defaults to `["github.com"]` (lower-case host names).
   `allowed_owners` is required and non-empty, matched case-insensitively. Without `project_sources` every `clone_url`
   is refused (`CLONE_NOT_CONFIGURED`). Code: `src/config/schema.ts`, `src/config/load.ts` (`resolveProjectSources`).
2. **A repository context takes exactly one of `path` and `clone_url`** in `create_project` and `update_project`
   (MCP only; the schema is a `oneOf` in `src/mcp/schemas.ts`, `mcpProjectDefinition`; configuration files still
   require `path`).
   - **URL rule** (`parseRepositoryUrl`, `src/projects/clone.ts`): only `https://<host>/<owner>/<repo>`, with an
     optional `.git` and an optional trailing slash. Refused: user information, a port, a query, a fragment,
     percent-encoding, any other scheme (http, ssh, git, file, scp-style), `.` or `..` segments, owner or repo
     characters outside `[A-Za-z0-9._-]`, a leading `-`, and anything longer than 512 characters.
   - **Target** `<clone_root>/<host>/<owner lower>/<repo lower, without .git>`. A missing target is cloned with
     `git clone --no-recurse-submodules -- https://<host>/<owner>/<repo>.git <temporary directory beside the target>`
     and renamed into place; a failed clone removes only its own temporary directory.
   - **An existing target** must be a real directory (not a symlink) and the top level of a Git repository whose
     `origin` URL normalizes to the same host, owner and repo (case-insensitive). Then a best-effort `git fetch
     origin` runs and the repository is reused. Anything else is `CLONE_TARGET_CONFLICT` and the target is never
     deleted or overwritten.
   - **Git invocation.** No shell; the server's own environment (the operator's credential helper or `gh` login) plus
     `GIT_TERMINAL_PROMPT=0`; stdin closed; every call carries `-c core.fsmonitor=false -c core.hooksPath=/dev/null`
     (Delegated defence in depth); timeout 300 s (**Assumption**).
   - **Order of checks:** schema, control characters, id ownership, `clone_url` parse and allowlist (the planned target
     stands in for `path`), structure, client limits, quotas, clone or reuse (the only side effect), the filesystem
     checks (unchanged from ADR-0030), approval reasons, write.
   - **Error codes** (closed; git's stderr is never returned): `CLONE_URL_INVALID` (`INVALID_REQUEST`),
     `CLONE_SOURCE_NOT_ALLOWED`, `CLONE_NOT_CONFIGURED` and `CLONE_TARGET_CONFLICT` (`PERMISSION_BLOCKED`), and
     `CLONE_FAILED` (`TOOL_FAILURE`, `retryable: true`, message "repository could not be cloned with the server's git
     credentials; the operator may need to grant access"). `ToolError.retryable` gained an override for this
     (`src/mcp/errors.ts`).
   - **Stored and shown.** The revision definition keeps the resolved `path` plus the normalized `clone_url`
     (`https://host/Owner/repo`, no `.git`). `list_projects` context items gain `source_url` (the normalized URL, never
     a path). The `project_event` payload of every create or update call carrying a `clone_url` gains `clone`
     (`cloned | reused | failed | refused`) and `clone_sources` (`["host/owner/repo"]`, lower case). Code:
     `src/mcp/project-tools.ts`.
3. **Approval kinds over MCP.** `mcp_clients[].approval_proxy_kinds` is a non-empty, unique subset of
   `privileged_scope | dynamic_project | push_revision`; the default is all three (ADR-0047 behaviour); the loader
   refuses it without `approval_proxy: true`. `list_pending_approvals` lists and `decide_approval` decides only those
   kinds; any other kind is refused with the existing single refusal message (no oracle). Code:
   `src/control/approval-proxy.ts` (`proxyKinds`). The production plan for the `grok-bot` client is `approval_proxy:
   true`, `approval_proxy_targets: ["grok-bot"]`, `approval_proxy_kinds: ["dynamic_project", "push_revision"]`: it
   approves its own project revisions and never a privileged run. The `PENDING_APPROVAL` message of `create_project`
   and the `approval_required` message of `delegate_task` now say: "approve it with decide_approval from an approver
   client (list_pending_approvals), or the operator runs `switchboard projects approve`". The orchestrator tool profile
   lists the two approval tools whenever `approval_proxy` is true.
4. **`request_decision` may carry `onboarding: { repository_url }`.** With it, `project_id` is the *proposed* id: it is
   well-formed; it is not a configured id or another client's dynamic project (one message, `PERMISSION_BLOCKED`,
   reason `NOT_MANAGEABLE`); it is not a deleted project (`INVALID_REQUEST`, `ID_DELETED`) and has no approved revision
   (`INVALID_REQUEST`, `PROJECT_EXISTS`); it may be unknown or this client's own `PENDING_APPROVAL` or `REJECTED`
   project. The URL goes through the same parser (`CLONE_URL_INVALID`); the allowlist (`CLONE_SOURCE_NOT_ALLOWED`)
   applies only when `project_sources` is configured. Delegated: `onboarding` cannot be combined with `work_item_id`
   or `enqueue`. Without `onboarding` the old rule stands. The decision row records the normalized URL in the new
   column `decision_request.onboarding_url` (item 6). `request_decision`, `list_decisions`, `decide` and `switchboard
   decisions list` show `onboarding: { repository_url }` when present; `list_decisions` accepts the proposed id as the
   `project_id` filter and `get_digest` shows the open onboarding decision under the proposed id. Sinks are told only
   the project id, as before.
5. **One workspace refusal (FR-POL-10).** `checkWorkspace` in `src/lifecycle/lifecycle.ts` answers every failure for
   `workspace_path` (outside the roots, missing, not a directory, not a Git repository for a write-capable profile,
   repository root outside the roots) with one `INVALID_REQUEST` message, `NOT_AN_ALLOWED_WORKSPACE`: "workspace_path
   is not an allowed workspace (an existing directory under an allowed root; a Git repository for write-capable
   profiles)". `realpath` is still taken of the raw path (no lexical `..` normalisation, so `link/..` resolves through
   the link).
6. **Persistence.** Migration `0032_decision_onboarding` (`src/ledger/migrations/0032_decision_onboarding.ts`) adds
   the nullable column `decision_request.onboarding_url` with `ALTER TABLE ... ADD COLUMN`, `CHECK` that a value starts
   with `https://` and is 9 to 512 characters. It is additive and forward-only (ADR-0005). `project_id` never had a
   foreign key (migration 0030), so nothing else changes.

## Consequences

- An MCP-only client can go from nothing to a working project: `request_decision` with `onboarding`, `create_project`
  with `clone_url`, `list_pending_approvals`, `decide_approval`, `list_projects`, `delegate_task`. The test
  `src/mcp/mcp-onboarding.test.ts` runs that path against a local fixture remote.
- **Trust boundary.** Switchboard clones with the operator's Git credentials by running `git` in the server's own
  environment (credential helper, `gh` login). It never reads, stores, logs or passes a credential (ADR-0003), and
  `GIT_TERMINAL_PROMPT=0` with a closed stdin means git cannot ask for one. A clone failure is the generic `CLONE_FAILED`;
  the operator may need to grant the server's identity access to the repository. The allowlist (`allowed_hosts`,
  `allowed_owners`) bounds which remotes a model-driven client can make the server contact; it is operator
  configuration, never settable over MCP.
- Cloned repository content is untrusted, as is any repository. The hook and fsmonitor settings stop the clone and
  fetch from running repository-supplied programs; later runs keep the profile, Git-write denial and worktree
  isolation they always had.
- `approval_proxy_kinds` lets an operator give a chat client project approval without privileged approval. Deployments
  that set nothing keep ADR-0047's behaviour (all three kinds).
- The ledger schema version rises by one (migration 0032). Old binaries refuse a newer schema as for any migration.
- The workspace refusal is less specific than before: a client with a genuine typo no longer learns which check failed.
  That is the point of FR-POL-10; the operator sees the cause in the controller's own logs.

## Residual risks

- **Self-approval by a model-driven client (R-83).** An operator who sets `approval_proxy_targets` to the client itself
  lets a model approve its own project revisions, including `push_policy: branch` within `max_push_policy`.
  Mitigations: the kinds exclude `privileged_scope` when the operator lists only the two project kinds;
  `max_push_policy`, the trust caps, the pre-push secret scan and the Git-write denial still apply; every decision is
  audited with `decided_by = mcp_proxy:<client_id>`; the sinks announce it (ADR-0047 item 2).
- **Clone sources.** Allowed owners and hosts are the only filter; a repository under an allowed owner is trusted as
  far as any repository is. The operator should list only owners they control.
- **Temporary race.** `rename(2)` could replace an *empty* directory that another process creates at the target
  between the existence check and the rename. A non-empty directory is never replaced.

## Alternatives considered

- **Operator pre-clones repositories (status quo).** Rejected by the ruling: onboarding must work over MCP alone.
- **Any URL, or `ssh`/`file` URLs.** Rejected: the server would contact arbitrary hosts or read local paths on a
  client's behalf. Only `https` URLs on an allowlist are accepted.
- **Pass a token to git.** Rejected: ADR-0003. The operator's credential helper is the only credential path.
- **A dedicated onboarding tool.** Rejected: `create_project` already owns the revision, approval and audit machinery;
  a second tool would duplicate it.
- **Refuse `request_decision` for unknown projects and have the client create the project first.** Rejected: the whole
  point is to ask before creating, and a created project would already have cloned the repository.

## Revisit when

- A provider or host other than `github.com` is needed, or the operator wants per-owner host rules.
- A compromised or prompt-injected approver is observed, or the owner asks to restrict self-approval (R-83).
