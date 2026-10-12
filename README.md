# switchboard

Design research for a headless controller that would orchestrate existing AI
coding-agent CLIs through their documented, non-interactive interfaces.

**Status: docs stage.** This repository currently contains research and
architecture documents only. There is no application code, no package, and no
runnable release.

## Contents

| Path | What it is |
| --- | --- |
| `docs/research/headless-ai-coding-controller.md` | The original architectural blueprint. It covers the proposed adapter layer for seven agent CLIs, meta-session continuity, predictive routing and capacity handling, MCP/ACP exposure, and security and telemetry. |
| `docs/research/headless-ai-coding-controller-verified-2026-10-12.md` | A follow-up pass dated 2026-10-12 that checks the blueprint against current provider documentation. It records where the original draft is inaccurate and what the adjusted design is. Start here if you read only one file. |
| `LICENSE` | Apache License 2.0. |

The verified document concludes that the original blueprint should not be
implemented literally. Among other points, it finds that some flags and
permission assumptions are out of date, that some proposed permission settings
grant more access than needed, and that provider quota cannot be reliably
inferred from client-side usage estimates. Provider CLI details are dated
October 2026 and may change; re-check them before relying on them.

## Working on the docs

- Documents live under `docs/`. Changes there are reviewed like any other PR.
- Markdown is checked by the `docs-lint` GitHub Actions workflow. The blocking
  job covers Markdown outside `docs/`. The `docs/` job is advisory for now.
- Contribution steps and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).
- To report a security concern, see [SECURITY.md](SECURITY.md).
