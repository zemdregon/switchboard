# switchboard

Design research for a headless controller that would orchestrate existing AI
coding-agent CLIs through their documented, non-interactive interfaces.

**Status: docs stage.** This repository currently contains research and
architecture documents only. There is no application code, no package, and no
runnable release.

## Contents

| Path | What it is |
| --- | --- |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | The canonical plan: scope, milestones, status and the next task. Start here. |
| [`AGENTS.md`](AGENTS.md) | Instructions for AI coding agents working in this repository (`CLAUDE.md` imports it). |
| [`docs/requirements/`](docs/requirements/) | Business, product and functional requirements, and the SRS that holds every requirement ID. |
| [`docs/design/`](docs/design/) | High-level, software, technical and low-level design. |
| [`docs/adr/`](docs/adr/README.md) | Architecture decision records. |
| [`docs/research/`](docs/research/) | The original blueprint and the 2026-10-12 verified research it is checked against. |
| `LICENSE` | Apache License 2.0. |

The verified research concludes that the original blueprint should not be
implemented literally; the roadmap records each conflict between the two and
how it was resolved. Provider CLI details are dated October 2026 and may change;
re-check them before relying on them.

## Working on the docs

- Documents live under `docs/`. Changes there are reviewed like any other PR.
- `node scripts/check-docs.mjs` checks links, anchors, requirement IDs and
  roadmap coverage across the specification set.
- Markdown is checked by the `docs-lint` GitHub Actions workflow. The blocking
  job covers Markdown outside `docs/`. The `docs/` job is advisory for now.
- Contribution steps and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).
- To report a security concern, see [SECURITY.md](SECURITY.md).
