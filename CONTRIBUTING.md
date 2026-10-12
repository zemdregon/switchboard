# Contributing

Thanks for looking at switchboard. The project is at the docs stage, so most
contributions are edits to research and design documents.

## Before you start

- Open an issue (use the "Feature or docs request" template) for anything
  beyond a typo or a small factual fix, so the direction can be agreed first.
- Keep claims about third-party tools dated and sourced. Provider CLI flags,
  permission modes, and terms change; say when you verified them.

## Making a change

1. Create a branch from `main`.
2. Make your edits. Keep each document focused on one topic.
3. Check your Markdown locally:

   ```sh
   npx --yes markdownlint-cli2@0.23.3 "**/*.md" "!docs/**"
   npx --yes markdown-link-check@3.13.7 --quiet README.md CONTRIBUTING.md SECURITY.md
   ```

   The same checks run in the `docs-lint` workflow on every pull request.
4. Open a pull request. Fill in the PR template.

## Scope notes

- Files under `docs/` are not yet held to the blocking lint rules. Their lint
  results are reported by an advisory job. You may fix them, but keep such
  changes separate from content changes.
- Do not add application code, dependencies, or build tooling without first
  discussing it in an issue. Those decisions are not made yet.

## Review

Pull requests are reviewed by the code owners listed in
[`.github/CODEOWNERS`](.github/CODEOWNERS). Review turnaround is not guaranteed.
