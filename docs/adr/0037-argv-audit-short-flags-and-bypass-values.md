# ADR-0037: The argv audit also refuses declared short spellings, flag clusters and bypass-class flag values

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions). Not a zemdregon quote and
  not owner-approved. The change only adds forms the audit refuses outside the approved bypass case and admits them in
  that case exactly as `BYPASS_FLAGS` entries, so what an approved bypass run may do is unchanged and AGENTS.md lets
  an agent decide it.
- Amends: [ADR-0035](0035-provider-registry-table-and-declared-bypass-flags.md) (decision item 2 and its "Revisit
  when" on flag values). ADR-0035's decision stands; this ADR adds to it.
- Related: FR-POL-03, NFR-MAINT-01, [ADR-0004](0004-trust-profiles-no-bypass-flags.md),
  [ADR-0017](0017-approved-privileged-scope-bypass.md), ROADMAP T4.1 (audit gaps found by the 2026-10-13 spikes),
  T3.17, [LLD §2](../design/LLD.md#2-adapter-contract), [TDD §4.3](../design/TDD.md#43-grok-build-m4) to
  [§4.8](../design/TDD.md#48-muse-code-m4)

## Context

After T4.1 the argv audit (`src/adapters/audit.ts`) refuses flag names only, as `--flag` or `--flag=value`. The M4
documentation spikes found bypass-class spellings that this misses (ROADMAP §6.8, T4.1 row, "Audit gaps"):

- **Short spellings.** Cursor documents `-f` as the short form of `--force` ([TDD §4.5](../design/TDD.md#45-cursor-cli-m4));
  `-f` would pass. Whether Cursor accepts a combined cluster such as `-pf` is Unverified: T4.41.
- **Values.** Some bypass-class settings are the value of a flag that is needed for other values: Cursor
  `--sandbox disabled` (§4.5), Grok Build `--permission-mode bypassPermissions` and a catch-all `allow` rule
  ([TDD §4.3.1](../design/TDD.md#431-grok-build-native-controls-per-profile-and-platform-t420)), Claude Code
  `--permission-mode bypassPermissions` ([TDD §4.1.1](../design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30)
  "Bypass flag availability"), Muse Code `--approval-mode never` and `--sandbox-network unrestricted`
  ([TDD §4.8](../design/TDD.md#48-muse-code-m4)). The Claude Code adapter never emits `bypassPermissions`, but only
  its compile tests said so; the pre-spawn audit did not check it.
- **Environment and configuration.** Some are carried outside argv: OpenCode's inline permission (`"allow"` as a whole
  or `"*": "allow"`) in `OPENCODE_PERMISSION` or `OPENCODE_CONFIG_CONTENT`
  ([TDD §4.6](../design/TDD.md#46-opencode-m4) and §4.6.2), Grok Build's `auto_allow_bash` and
  `GROK_SANDBOX_AUTO_ALLOW_BASH` (§4.3.1), Antigravity's `toolPermission` `always-proceed` in `settings.json`
  ([TDD §4.4.2](../design/TDD.md#442-antigravity-native-controls-per-profile-and-platform-t430)) and Cursor's config
  `approvalMode` `unrestricted` (§4.5).

The audit is a security control (T3.17), so it must fail closed on the spellings that can be seen in argv.

## Decision

1. **Two new declarations in the provider registry table** (`ProviderEntry` in `src/adapters/providers.ts`), both
   optional static data with their source in a comment beside them:
   - `bypassShortFlags`: short spellings `-x` (one dash, one letter or digit);
   - `bypassValues`: `{ flag, value }` pairs, `flag` of the `bypassFlags` shape (`-x` or `--name`, no `=`), `value`
     1 to 128 characters with no whitespace or control characters, no other keys.
   Malformed entries are refused by registration exactly as malformed `bypassFlags` (nothing changes); built-in
   arrays and value objects are frozen at load; a runtime registration is copied and frozen. A declaration can only
   add: nothing removes or admits a hit.
2. **Counted only with an adapter.** Short flags and values of an entry count only while the entry has a factory
   (`create`). A reserved entry's declaration is recorded data with no effect on any run until its adapter task adds
   the factory; the scratch adapter fixture shows the effect in tests. `bypassFlags` keep ADR-0035's rule (every
   registered entry, with or without a factory), unchanged.
3. **What the audit now matches**, in `argv` and in `policyFlags`, before spawn, refused unless the run's context is
   an approved `privileged` scope that sets `bypass` (ADR-0017, unchanged):
   - every flag of `bypassClassFlags()` as before: bare or `flag=value`, byte for byte the same hits;
   - otherwise, a single-dash word of letters and digits with an optional `=value` (`-f`, `-f=1`, `-pf`, `-fp`)
     whose letters include a short flag that is declared (or a `-x` in `bypassClassFlags()`, none today). This is a
     **deliberate over-refusal**: the audit does not know which letters take a value (in `-mf` the `f` may be the
     value of `-m`) or whether the CLI accepts clusters at all, and refuses the word either way;
   - a declared value as two argv words (`--flag value`, the flag word followed directly by the value word) or one
     (`--flag=value`), the value compared case-insensitively (JavaScript `toLowerCase`; also an over-refusal, since a
     CLI may reject another case). Pairs are read within one list: argv, then `policyFlags`.
   A value hit is reported as `<flag> <value>` (declared spelling) in `BypassFlagError` and the audit result; hits
   keep argv order, then `policyFlags` order, each once.
4. **First declarations** (Proposed where the spike marked them Proposed; all except Claude Code's are inert until
   their adapter exists):
   - Claude Code: value `--permission-mode bypassPermissions` (TDD §4.1.1, `claude --help` 2.1.296). Active now; the
     adapter never emits it, so no compiled argv changes.
   - Grok Build: values `--permission-mode bypassPermissions`, and the catch-all allow rules `--allow *`,
     `--allow **`, `--allowed-tools *`, `--allowed-tools **` (TDD §4.3.1; `--allowed-tools` is a documented alias of
     `--allow`; the catch-all is Proposed). Its long flags are already shared `BYPASS_FLAGS`.
   - Cursor: short `-f`; value `--sandbox disabled` (TDD §4.5; Proposed, Unverified: T4.41).
   - Antigravity, OpenCode, Kimi Code: none of these forms (their bypass-class settings are long flags, already
     shared or declared by their adapter tasks, or are carried outside argv; see Limits).
   - Muse Code is not in the table (ADR-0035): `--approval-mode never` and `--sandbox-network unrestricted` (TDD §4.8,
     Proposed) are declared as `bypassValues` when its adapter module is added (T4.72).
5. **Not declared here**, left to each adapter task because they are long flags that ADR-0035's `bypassFlags` already
   carries and that rule makes active at once: OpenCode `--auto` (§4.6.2), Kimi Code `--auto` and `--plan` (§4.7),
   Cursor `-w`/`--worktree`, `--worktree-base`, `--skip-worktree-setup`, `--plugin-dir`, `--api-key`, `--auth-token`,
   `-H`/`--header`, `--workspace` (§4.5), Muse Code `--disable-approval`, `--disable-sandbox`, `--trust-workspace`
   (§4.8).

## Alternatives considered

- **Match clusters only when the CLI is known to accept them.** Rejected: unknown for Cursor (Unverified: T4.41);
  failing closed costs only a refused argv that the controller itself compiled.
- **Count every entry's short flags and values at once, as `bypassFlags` are counted.** Rejected: a reserved entry's
  `-f` or `--sandbox disabled` would then apply to the Claude Code and Codex argv before any Cursor adapter exists
  (Codex emits `--sandbox` with other values), changing real runs on spike-only evidence.
- **Audit the child environment and configuration files too.** Rejected here: the audit works on argv and
  `policyFlags`; a new environment or configuration audit is a new mechanism (see Limits) and belongs with the adapter
  that sets those variables.
- **A per-adapter parser of its own argv grammar.** Rejected: the audit must stay independent of the adapter that
  compiled the argv (ADR-0035), and grammars are unverified for every M4 provider.

## Consequences

- The four spike gaps visible in argv are closed for declared spellings; Claude Code's `--permission-mode
  bypassPermissions` is refused before spawn today.
- Nothing that was refused or admitted before changes: no compiled Claude Code, Codex or fake argv carries a cluster
  or a declared value (the existing tests pass unchanged).
- An adapter task adds its short flags and values with its entry; its `create` turns them on for every argv, as
  ADR-0035 does for flags.
- Tests: `src/adapters/bypass-forms.test.ts` runs the T3.17 matrix (eight profiles, `bypassApproved` false and true)
  over each form in argv and in `policyFlags` through the scratch fixture
  (`src/adapters/fixtures/scratch-provider.ts`), plus near misses, inert reserved declarations and validation.

## Limits (known, not covered by the argv audit)

- **Environment and configuration.** OpenCode `OPENCODE_PERMISSION`/`OPENCODE_CONFIG_CONTENT` with `"allow"` or
  `"*": "allow"`; Grok Build `GROK_SANDBOX_AUTO_ALLOW_BASH` and `auto_allow_bash`; Antigravity `toolPermission` (and
  `artifactReviewPolicy`) `always-proceed` in `settings.json` (TDD §4.4.2 proposes a detective `init.permission_mode`
  check); Cursor `approvalMode` `unrestricted`. The audit does not read `Invocation.env` or files. Each adapter that
  sets such a variable must keep it out of bypass-class values in its compile, and its tests must show that.
- **Spellings not declared.** Aliases, abbreviations a CLI may accept (`--sandb disabled`), quoting inside a value,
  a value given as a later word of a variadic flag (only the word directly after the flag is read), values inside
  JSON or `-c key=value` settings, and a value pair split between argv and `policyFlags` are not matched.
- **Case.** Flag names are matched exactly; only values ignore case.
- **Evidence.** Every declaration except Claude Code's comes from documentation only; the operator captures
  (T4.21, T4.41, T4.51, T4.71) may add or remove spellings.

## Revisit when

- An operator capture shows another spelling, or that a declared one does not exist.
- An adapter sets bypass-relevant settings through its environment or a file: an environment or configuration audit
  then needs its own ADR.
