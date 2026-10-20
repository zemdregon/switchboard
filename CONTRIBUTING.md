# Contributing

Thanks for looking at switchboard. The project is pre-release: the specification set
and the M1 foundation are done, M2 (Claude Code and Codex adapters plus the MCP
slice) and M3 (isolation) are `Partial`, and parts of M9 (projects and controlled
commits) are implemented (see the [roadmap](docs/ROADMAP.md#6-milestones) for the
status of each). Contributions are code, tests, or documentation edits.

## Before you start

- Open an issue for anything beyond a typo or a small factual fix, so the
  direction can be agreed first (use the "Bug report" template for something
  broken, the "Feature or docs request" template for anything else).
- Participation follows the [code of conduct](CODE_OF_CONDUCT.md).
- Keep claims about third-party tools dated and sourced. Provider CLI flags,
  permission modes, and terms change; say when you verified them.

## Making a change

1. Create a branch from `main`. Read [AGENTS.md](AGENTS.md) and the
   [roadmap](docs/ROADMAP.md) first; they say which document owns what.
2. Make your edits. Keep each document focused on one topic. Update the
   documents your change affects in the same change (see [AGENTS.md](AGENTS.md)).
3. If you changed code, run the checks (Node.js 22 or newer and Git are required):

   ```sh
   npm ci
   npm run build
   npm run typecheck
   npm run lint
   npm test
   ```

   `npm test` never calls a real provider. `npm run test:live` is an opt-in smoke
   test against a provider CLI you have installed and logged in to natively; it is
   skipped unless `SWITCHBOARD_LIVE_TESTS=1` is set (see the
   [README](docs/guide/live-testing.md#optional-live-smoke-test)). `npm run pack:smoke` checks
that `npm pack` produces an installable tarball.
4. Check your Markdown and the documentation set locally:

   ```sh
   npx --yes markdownlint-cli2@0.23.3 "**/*.md"
   npx --yes markdown-link-check@3.13.7 --quiet README.md CONTRIBUTING.md SECURITY.md
   node scripts/check-docs.mjs
   ```

   The same checks run in the `docs-lint` workflow on every pull request.
5. Open a pull request. Fill in the PR template.

## Releasing

The project is pre-1.0 and nothing has been published to a package registry yet.
To cut a release:

1. Bump `version` in `package.json` and move the `CHANGELOG.md`
   `[Unreleased]` section into a new `## [X.Y.Z]` section.
2. Push a tag named `vX.Y.Z` (it must equal `v` plus the `package.json`
   version; the workflow fails otherwise).
3. The `release` workflow (`.github/workflows/release.yml`) re-runs typecheck,
   lint, tests, the build and the pack smoke test, then drafts a GitHub release
   carrying the `npm pack` tarball and the matching CHANGELOG section as its
   notes. A maintainer reviews and publishes the draft by hand.

Publishing to npm is not set up: there is no `npm publish` step and no
`NPM_TOKEN` secret. Publishing the package is an owner decision for later.

## Scope notes

- Markdown lint is blocking for every Markdown file, including `docs/`. A lint
  finding in `docs/` fails the pull request like one anywhere else, so keep
  line-wrapping and formatting fixes separate from content changes where you can.
- Open an issue before adding a dependency or changing the build tooling, and
  before changing a component boundary, persistence format, trust boundary or
  external interface; those need an ADR (see [AGENTS.md](AGENTS.md)).
- Work that is not on the roadmap is not in scope yet; propose it first.
- Adding a provider adapter follows the checklist in
  [TDD §4.9](docs/design/TDD.md#49-adapter-addition-checklist-t42); write no provider fact from memory.

## Review

Pull requests are reviewed by the code owners listed in
[`.github/CODEOWNERS`](.github/CODEOWNERS). Review turnaround is not guaranteed.
