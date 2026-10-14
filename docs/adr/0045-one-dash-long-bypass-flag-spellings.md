# ADR-0045: Declared bypass-class flags may use one-dash long spellings and underscores

- Status: Accepted
- Date: 2026-10-14
- Decided by: Delegated (agent, 2026-10-14, ROADMAP T4.32), under [owner decision 25](../ROADMAP.md#42-owner-decisions).
  Not a zemdregon quote and not owner-approved. The change only lets an adapter declare more spellings that the audit
  refuses outside the approved bypass case and admits inside it exactly as `BYPASS_FLAGS` entries, so what an approved
  bypass run may do is unchanged and AGENTS.md lets an agent decide it.
- Amends: [ADR-0035](0035-provider-registry-table-and-declared-bypass-flags.md) (the `bypassFlags` shape) and
  [ADR-0037](0037-argv-audit-short-flags-and-bypass-values.md) (decision item 1, the `flag` of a `bypassValues` pair).
  Their decisions stand; this ADR widens one validation pattern.
- Related: FR-POL-03, NFR-MAINT-01, [ADR-0017](0017-approved-privileged-scope-bypass.md), ROADMAP T4.32,
  [TDD §4.4](../design/TDD.md#44-antigravity-agy-m4), [live checks 2026-10-14 (Antigravity)](../research/live-checks-2026-10-14-antigravity.md)

## Context

The provider registry table refuses a declared bypass-class flag unless it is `-x` (one dash, one letter or digit) or
`--name` (two dashes; letters, digits and `-`). The Antigravity live check (T4.31, `agy` 1.3.4) found two spellings
outside that shape:

- `agy` reports an unknown flag as `flags provided but not defined: -output-format` (row C3), the way Go's `flag`
  package does. That package accepts `-name` and `--name` alike, so `-dangerously-skip-permissions` is very likely the
  same flag as `--dangerously-skip-permissions`. The audit matches argv words byte for byte, so the one-dash spelling
  would pass it. Whether `agy` accepts it was not run (bypass-class, operator rule).
- The hidden per-run state and credential directory flag is `--gemini_dir` (row C17), with an underscore.

The Antigravity adapter emits neither, but the audit exists to catch a compile bug or a hostile change before spawn
(T3.17), so it must be able to hold these spellings.

## Decision

1. The registry's flag shape becomes: `-x`, or one or two dashes followed by a letter or digit and then letters,
   digits, `-` or `_` (`/^(?:-[A-Za-z0-9]|-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)$/`). Three dashes, a lone dash, a value part
   (`=`) and whitespace stay refused. The same shape applies to the `flag` of a `bypassValues` pair.
2. Matching is unchanged: a declared flag is refused bare or as `flag=value`, wherever it appears in `argv` or
   `policyFlags`, unless the run is an approved `privileged` scope that sets `bypass`. A one-dash long declaration is
   not a short flag: it is never matched inside a single-dash cluster (ADR-0037's cluster rule stays limited to `-x`).
3. An adapter whose CLI may accept one-dash long names declares both spellings of each bypass-class flag it knows. The
   Antigravity entry (T4.32) declares `-dangerously-skip-permissions` (the two-dash form is a shared `BYPASS_FLAGS`
   entry) and both spellings of `--remote-control`, `--gemini_dir` and `--add-dir`.

## Alternatives considered

- **Normalise every one-dash long word to two dashes before matching.** Rejected: it would change what the audit
  matches for every provider, including Claude Code and Codex whose parsers do not take one-dash long names, and could
  turn a harmless value word into a hit.
- **Leave it as a recorded limit.** Rejected: the spelling is visible in argv, so the audit can refuse it at no cost.

## Consequences

- One more spelling of the Antigravity bypass flag is refused before spawn; nothing that was refused is now admitted.
- A runtime registration may now declare one-dash long flags; the registration tests cover the refused shapes.

## Revisit when

- An operator capture shows which spellings `agy` really accepts (then drop any that it refuses, or add others).
- A provider's parser accepts abbreviations or other spellings the audit cannot enumerate; that needs its own design.
