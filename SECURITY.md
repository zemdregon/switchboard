# Security Policy

## Supported versions

The project is pre-release: nothing has been published to a package registry, and
you build it from source. Only the `main` branch is maintained, and security
fixes apply to it.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- If the repository's **Security** tab shows **Report a vulnerability**, use it.
  This opens a private advisory that only maintainers can see.
- If that option is not available, contact the repository owner,
  @zemdregon (the repository owner on GitHub), by a private GitHub message.

Include what you found, the file or document involved, and steps to reproduce
it if you have them.

## Scope

This repository holds the specification set and application code. Milestone status lives in
[ROADMAP §6](docs/ROADMAP.md#6-milestones): several milestones are `Done` and the rest are `Partial` or earlier,
each with its evidence; read that section, not this file, for the current states. Relevant reports include guidance
or code that would weaken credential handling, permission boundaries, or sandboxing, and exposed secrets or
credentials in the repository history.

## Response times

No response or fix time is promised. The project is maintained on a best-effort
basis.
