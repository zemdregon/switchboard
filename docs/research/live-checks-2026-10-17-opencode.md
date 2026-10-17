# Live checks on the operator's machine, 2026-10-17: OpenCode tool-free one-shot (T11.0) and `adapters validate`

Status: research input (historical record once written). Run by an agent (Claude Opus 5.5, Delegated) on the
operator's Ampere server (Ubuntu 26.04.1, aarch64), with the installed, logged-in OpenCode, through the operator's
`live-run-ext.sh` channel. The channel uses a fresh clone of `main` at `d405a60`, the operator's cheapest OpenCode model
(`opencode-go/deepseek-v4.1-flash`), and scrubs captured output before writing it. Everything here was **observed** on
2026-10-17. The roadmap owns status ([ROADMAP §6.6](../ROADMAP.md#66-m11-inner-agent-tasks)). Verdicts are Delegated
findings, not owner decisions. Earlier OpenCode captures:
[live-checks-2026-10-14-opencode.md](live-checks-2026-10-14-opencode.md).

## 1. T11.0: can a one-shot `opencode run` be tool-free? (TDD §4.6.3 item 12)

**Version.** `opencode --version` printed `opencode v2.0.23`, exit 0.

**Flags on this version.** `opencode run --help` (v2.0.23) lists these run flags:

- `--standalone`, `--server`
- `--continue`/`-c`, `--session`/`-s`, `--fork`
- `--model`/`-m`, `--agent`, `--format` (`default`, `json`)
- `--file`/`-f`, `--title`, `--thinking`
- `--auto` ("Auto-approve permissions that are not explicitly denied")

It lists **no `--pure` and no `--dir`**, the v1 spellings the checklist names. No listed flag removes tools.

**Run.** The argv recorded as the TDD asks when `--pure`/`--dir` are absent:

```text
cwd:  an empty directory (not a Git repository, no opencode.json, .opencode, AGENTS.md or CLAUDE.md)
env:  XDG_CONFIG_HOME=<empty directory>   (no global config or global AGENTS.md can load)
      OPENCODE_PERMISSION='{"*":"deny"}' OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_AUTOUPDATE=1
argv: opencode run --format json -m opencode-go/deepseek-v4.1-flash -- "<prompt>"   (stdin /dev/null)
```

`HOME` and the data directory were the operator's real ones, because that is where the native login lives. A scratch
`HOME` would have no login, and no model call could be made.

| # | Prompt | Exit | Stream (`--format json`) | Tool use | Files created in the empty dir |
| --- | --- | --- | --- | --- | --- |
| 1 | one-word answer | 0 | 1 line: `text` | none | 0 |
| 2 | tool-requiring: "List the files in your current working directory using a tool, then reply with the count." | 0 | 5 lines: `step_start` x2, `tool_use` x1, `text` x1, `step_finish` x1 | **`tool_use` `shell`, state `completed`** | 0 |

**Result: no tool-free one-shot on v2.0.23.** A deny-all `OPENCODE_PERMISSION` did not stop the model from calling
and completing the `shell` tool. This is consistent with the 2026-10-14 finding that `OPENCODE_PERMISSION` and
`OPENCODE_CONFIG_CONTENT` were ignored. The documented substitutes for an isolated one-shot do not exist on this
version (`--pure`, `--dir`), and no other flag removes tools. The run events named no provider or model (no `providerID`
or `modelID` in any record).

Not tried:

- `OPENCODE_CONFIG_CONTENT` with a deny-all `permission` block (the 2026-10-14 run found it ignored);
- `--agent plan`;
- `--standalone`;
- a scratch `HOME`.

None of these is a documented tool-free control. Only `--agent plan` is a documented restriction, and it restricts
edits, not tools. So the `cli` kind stays **`Ineligible`** for v2.0.23 (FR-INN-04, Q-26).

## 2. `switchboard adapters validate opencode` (T4.58)

| Step | Result |
| --- | --- |
| manifest | ok (`src/adapters/manifests/opencode.json`) |
| probe | ok: steps binary, version, command, output_format, flags; version `opencode v2.0.23` |
| auth | OK (`opencode auth list --format json --standalone`) |
| conformance | **FAIL**: static checks failed: `compiles` |

No model call was made and nothing was written. The command's conformance subset compiles a task under
`inspect-untrusted`. Every non-privileged OpenCode profile is `Ineligible` by design (the 2026-10-14 checks: no
per-run deny took effect), so `adapters validate opencode` cannot pass as built. Validating a bypass-only adapter needs
either a validate path under an approved `privileged` bypass scope, or an owner decision. T4.58 is unchanged.
