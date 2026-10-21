# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Milestone scope, sequencing and completion are owned by [roadmap §6](docs/ROADMAP.md#6-milestones);
this file summarises releases, not the specification set.

## [Unreleased]

Nothing has been released yet (`package.json` is still pre-1.0 `0.0.0`). What exists today,
by milestone (one line per `Done` milestone; evidence in roadmap §6):

- M0 Documentation baseline (`Done`): the requirements and design document set exists and
  `node scripts/check-docs.mjs` enforces it.
- M1 Foundation (`Done`): SQLite ledger with forward-only migrations, the run lifecycle state machine,
  and a fake provider adapter with tests.
- M6 Capacity and resilience (`Done`, on fakes): fault-injection acceptance tests for rate-limit,
  overload, quota and pacing behaviour.
- M7 Routing (`Done`, on fakes): deterministic replay, closed-list affinity switching, and model groups.
- M13 Network MCP transport (`Done`, with tests): OAuth 2.1 PKCE over Streamable HTTP.
- M15 Project queue, schedules and CI triggers (`Done`, on fakes): creator ceilings, enabled-only
  schedules, and published-branch CI triggers.
- M16 Switchboard-controlled skills (`Done`, on fakes): skill store, admission, prompt-prefix delivery,
  and native-delivery leak guards.
- M9 umbrella projects with Git submodules over MCP (ADR-0080, ROADMAP T9.22, in progress): opt-in
  `submodules` per project, `request_project_source`, the effective definition in `list_projects`,
  controller-made submodule commits, linked publication, ordered merge and `merge_policy.checks: all_reported`.

Several milestones are `Partial`, not `Done`: M2, M3, M4, M5, M8, M9, M10, M11, M12 and M14.
Their fake and synthetic suites pass, but the remaining legs are live provider checks that are
operator-only: they need native provider logins and real CLI runs on the operator's machine and
never run in CI.
