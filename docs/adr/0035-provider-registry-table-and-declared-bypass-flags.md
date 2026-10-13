# ADR-0035: One provider registry table; adapters declare bypass-class flags that the argv audit adds

- Status: Accepted; extended 2026-10-13 by [ADR-0037](0037-argv-audit-short-flags-and-bypass-values.md): entries may
  also declare short spellings (matched inside clusters) and bypass-class flag values, counted once the entry has an
  adapter; decision item 2 and the flag-value "Revisit when" item are answered there
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions). Not a zemdregon quote and
  not owner-approved. The change keeps every bypass run's behaviour as it was (it only adds flags the audit refuses
  outside the approved bypass case, and admits them in that case exactly as `BYPASS_FLAGS` entries), so AGENTS.md lets
  an agent decide it.
- Related: NFR-MAINT-01, FR-POL-03, FR-ADP-01, [ADR-0004](0004-trust-profiles-no-bypass-flags.md),
  [ADR-0009](0009-version-gated-adapters.md), [ADR-0017](0017-approved-privileged-scope-bypass.md), ROADMAP T4.1, T3.17,
  [LLD §2](../design/LLD.md#2-adapter-contract)

## Context

NFR-MAINT-01 says a new provider adapter touches only its module, manifest, fixtures and registry entry. Before T4.1 it
also had to edit `ProviderId` (`src/adapters/types.ts`), `PROVIDER_IDS` (`src/config/schema.ts`), `CONFIG_TO_ADAPTER_ID`
(`src/routing/collect.ts`), the registrations in `src/cli/serve.ts` and `src/cli/doctor.ts`, the exports in
`src/adapters/index.ts` and the single `BYPASS_FLAGS` list in `src/adapters/audit.ts` (ROADMAP §6.8). FR-POL-03 bars
the listed bypass flags "or equivalents"; each provider's spike (`T4.n0`) finds that provider's equivalents, and they
must reach the argv audit, a security control (T3.17), without each adapter editing the shared list.

## Decision

1. **One table.** `BUILTIN_PROVIDERS` in `src/adapters/providers.ts` holds one entry per provider: adapter id, config
   id (absent only for the test-only fake), kind (`real` or `test`), `doctor` label, declared bypass-class flags with
   their source, and a factory once the adapter module exists. Reserved entries without a factory keep the ids the code
   accepted before (Grok Build, Antigravity, Cursor, OpenCode, Kimi Code); no id is added for a provider without an
   adapter task (`muse`, `muse-code` arrive with Muse Code's module). Derived from it: `ProviderId`, the config id type
   and `PROVIDER_IDS`, the `providers.<id>` and `allowed_providers` parts of the config schema, `CONFIG_TO_ADAPTER_ID`
   and its runtime lookups, the adapters `serve` registers (table order, the fake only behind the test-only switch) and
   `doctor` probes (test-only entries first, then table order) with their labels. Claude Code and Codex stay exported
   from `src/adapters/index.ts`; new adapter modules are not added there.
2. **Declared flags extend the audit.** The audit refuses the union of the shared `BYPASS_FLAGS` (unchanged) and every
   registered entry's `bypassFlags`, as a bare flag or `flag=value`, in `argv` or `policyFlags`, before spawn, unless
   the run's context is an approved `privileged` scope that sets `bypass` (ADR-0017, unchanged). The union is read at
   call time. An entry can only add: no field removes or admits a flag, and the shared list is never consulted through
   an entry. Flag shape is checked (`-x` or `--name`, no `=`); a malformed entry is refused.
3. **First declarations.** Claude Code: `--dangerously-skip-permissions` and `--allow-dangerously-skip-permissions`
   (`claude --help` 2.1.296, [TDD §4.1.1](../design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30)
   "Bypass flag availability"). The second was never emitted and never audited; it is now refused outside the
   approved bypass case. Codex: `--yolo` and `--full-auto` ([R2] L28, L125, L126; already shared). Others: none until
   their spikes source them.
4. **Runtime registration, additive only.** `registerProvider(entry)` adds an entry and returns its removal function.
   It refuses a test-only entry, an id or config id already in use, and malformed data, changing nothing. It exists so
   a test can register a scratch adapter from a fixture module with no source edit (T4.1). Config validation
   recompiles its schema when the registered set changes; the MCP tool schemas (dynamic project definitions) and the
   static `configSchema` export keep the built-in ids.

## Alternatives considered

- **Flags as a property of each adapter instance, audited per run.** Rejected: the audit would trust the adapter that
  compiled the argv to say which of its flags are dangerous, and another provider's flag on that argv would pass.
  The union refuses every registered provider's flags on every argv (fail closed).
- **Keep editing the shared list per provider.** Rejected: a hot file for every M4 provider group, against
  NFR-MAINT-01, and the provenance of each flag is lost.
- **Data-only table plus a separate factory map.** Rejected: two edits per adapter. The type cycle that suggested it
  (`ProviderAdapter.id` derives from the table) is avoided by annotating each factory's return type.

## Consequences

- Adding an adapter edits its module, manifest, fixtures and one entry; the derived ids, schema, mapping, registrations
  and labels follow. The scratch-adapter test (`src/adapters/providers.test.ts`) shows it for `doctor`,
  `list_capabilities` and config validation.
- `src/adapters/audit.ts` imports the table, whose Claude adapter imports the audit: an import cycle. The table touches
  adapter bindings only inside factories, so any load order works; a test loads the modules in several orders.
- A runtime-registered id is not in the TypeScript `ProviderId` union (it needs a cast); runtime registration is for
  tests. A provider added to the built-in table is in the union.
- The `git_channel` key stays Claude Code only (ADR-0029); a new provider's injected channel needs its own ADR
  (ROADMAP §6.8 conventions).

## Revisit when

- A provider's bypass equivalent is a flag value rather than a flag (Claude Code's `--permission-mode
  bypassPermissions` is one; the adapter never emits it, and the audit matches flag names only).
- Adapters are loaded from outside the source tree (plug-ins): runtime registration would then cross a trust boundary.
