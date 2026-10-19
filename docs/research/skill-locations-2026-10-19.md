# Skill locations 2026-10-19: T16.8 live check of the candidate native skill locations

Status: research input (historical record once written). Run by an agent (Claude Opus 5.5, Delegated) on the
operator's Ampere server (Ubuntu 26.04.1, aarch64) through the operator's `live-run-ext.sh` channel. Everything here was
**observed** on 2026-10-19 unless it is labelled an inference. The roadmap owns status
([ROADMAP §6.16](../ROADMAP.md#616-m16-switchboard-controlled-skills-tasks), T16.8) and decision 70
([ROADMAP §4.2](../ROADMAP.md#42-owner-decisions)) sets the scope: the Claude Code location gets a verdict, and Grok
Build, Cursor and Muse Code are `NOT_CHECKED`. Verdicts are Delegated findings, not owner decisions. The candidates and
the rule are those of [TDD §3.16.1](../design/TDD.md#3161-per-provider-delivery-table) and
[ADR-0056](../adr/0056-switchboard-controlled-skills.md) items 5, 6 and 8.

## Verdicts

| Candidate (TDD §3.16.1) | Cell | Verdict | Reason |
| --- | --- | --- | --- |
| Claude Code: `.claude/skills/switchboard-<name>/SKILL.md` | Approved privileged bypass run, `repository_config` `approved` (no `--safe-mode`) | `NOT_LOADED` | The CLI discovered the skill, but the compiled `--tools` does not offer the `Skill` tool, so the body never reached the model; the canary token was absent and the model replied `NO_SKILL` |
| Grok Build: `.claude/skills/switchboard-<name>/SKILL.md` through the compatibility scanner | Approved bypass, `repository_config` `enabled` | `NOT_CHECKED` | Weekly limit: the last Grok call on this host (`validate grok`, 2026-10-18 11:43Z) failed with `402 Payment Required: Grok Build usage balance exhausted`, and the operator treats Grok as off until the weekly reset |
| Cursor: `.cursor/rules/switchboard-<name>.mdc` | Approved bypass, `--trust` | `NOT_CHECKED` | Out of usage: Cursor returned `ActionRequiredError: out of usage` on `composer-2.5` on 2026-10-19 (operator limit marker until 2026-10-19 05:00Z, no reset given) |
| Muse Code: `.agents/skills/switchboard-<name>/SKILL.md` | Approved bypass, `--trust-workspace` | `NOT_CHECKED` | No `muse` CLI on the host (`command -v muse` finds nothing); its login method is also open (Q-27) |

No cell flips to `native` because of this note (decision 70, ADR-0056 item 8). The Claude cell could not flip anyway:
there is no `LOADED` verdict.

## The Claude Code check

- **Channel:** `live-run-ext.sh skill-location claude --task-id w1261-m16-t168-claude-skill-location-d70-opus`, run
  once on 2026-10-19 at 04:32Z, not retried. Outcome `ok`, exit 0, one model call, no call refused by the model-pin
  wrapper; budget and limit markers checked first; the log is scrubbed by the channel's redaction step.
- **Switchboard:** a fresh clone of `origin/main` at `5ac59b9`, built, then its own `switchboard serve` (MCP client) and
  `switchboard approve`. The run used the `privileged` profile with the scope `files: read-only`, `shell: none`,
  `network: on`, `repository_config: approved`, `bypass: true`. That is the decision-26 cell, which leaves out
  `--safe-mode`. It reached `AWAITING_APPROVAL`, was approved and ended `SUCCEEDED`.
- **The skill file:** the check's driver (`live-ext/skill-location-driver.mjs`, outside the repository) wrote and
  committed `.claude/skills/switchboard-d76a33fd/SKILL.md` in a throwaway canary repository. The file had YAML front
  matter (`name`, `description`), and its body told the model to end its reply with a random token. Switchboard's own
  skill delivery code was not involved: skills stayed disabled in the run's configuration. The prompt named the skill
  but gave neither its path nor the token. The rule was that the token could reach the reply only through the skill
  body, and a non-`Skill` tool call that named the skill would not count as native loading.
- **Compiled argv (from the wrapper's call log):** `claude --model claude-haiku-5-5 -p --output-format stream-json
  --verbose --strict-mcp-config --dangerously-skip-permissions --permission-prompts none --tools
  Read,Grep,Glob,WebFetch --allowedTools Read Grep Glob WebFetch --disallowedTools <Git deny rules>`. There was no
  `--safe-mode` or `--restricted`. Claude Code 2.1.294, inside the manifest range.
- **Observed stream (metadata only):**
  - The `system/init` event listed the skill in `skills` and in `slash_commands`, so the CLI discovered the project
    skill file in this cell.
  - `tools` was `Glob, Grep, Read, WebFetch`, with no `Skill` tool.
  - `permissionMode` was `bypassPermissions`.
  - The model made no tool calls. It took one turn, and the result was `success`.
  - The reply was 8 characters, exactly `NO_SKILL`, and the token was absent.
  - The canary repository's `main` was unchanged, and the skill file was still tracked.
- **Verdict:** `NOT_LOADED`. Discovery is not loading. The body of a project skill reached no model in the shipped
  cell.
- **Inference, not checked:** adding `Skill` to `--tools` would probably let the model load the body. That changes the
  compiled argv, which ADR-0056 item 5 forbids for native delivery, so it is not a candidate under the current rule. The
  cell stays `prompt_prefix`. A future change that wants it would need its own design decision and a new live check.

## Reproducing

The check is operator-only and never runs in CI. Its hermetic test, `live-ext/skill-location.test.sh`, runs the same
channel end to end against a fake `claude` and a locally built Switchboard: 14 assertions covering the LOADED,
NOT_LOADED and read-as-a-file verdicts, the compiled cell without `--safe-mode`, budget denial and provider refusal. It
passed 14 of 14 against the new `live-run-ext.sh` and failed 12 of 14 against the pre-change backup. Both files live in
the operator's `~/operator-runs`, not in this repository.
