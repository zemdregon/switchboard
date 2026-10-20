# ADR-0076: Provider name aliases: one canonical name, both spellings accepted

- Status: Accepted (built 2026-10-20).
- Date: 2026-10-20
- Decided by: Delegated agent work, not owner-approved. Every choice below is **Delegated** under the AGENTS.md
  best-practice rule: it does not change what a bypass run may do, the Git-write denial or worktree isolation.
- Related: FR-MCP-03, FR-MCP-09, FR-PRJ-06, FR-PRJ-10, FR-ADP-01, NFR-MAINT-01,
  [ADR-0035](0035-provider-registry-table-and-declared-bypass-flags.md) (the provider registry table),
  [LLD §2 "Provider ids"](../design/LLD.md#2-adapter-contract), [LLD §3.0](../design/LLD.md#30-shared-types),
  [ROADMAP T4.91](../ROADMAP.md#68-m4-adapter-expansion-tasks).

## Context

The provider registry table (`BUILTIN_PROVIDERS`, ADR-0035) gives each provider two ids: the adapter id (`claude`,
`grok`, `kimi`, `muse`), used by the adapter contract, the ledger, routing and the MCP tools, and the config id
(`claude-code`, `grok-build`, `kimi-code`, `muse-code`), used by `providers.<id>` and `allowed_providers`. For
`codex`, `antigravity`, `cursor` and `opencode` they are the same. Callers met the split as a bug: MCP `delegate_task`
refused `routing.provider_preference: "claude-code"` (unknown provider), while `create_project` refused
`allowed_providers: ["claude"]` (schema enum), so one client had to use two spellings of one provider in one session.

## Decision

1. **One canonical provider name: the adapter id.** `claude` is what the ledger, `get_run`, `list_runs`, routing,
   `explain_route`, `get_capacity` and every other output report, exactly as before. The config id (`claude-code`) is
   the provider's **alias**. Reason: every stored row and every output already uses the adapter id, so choosing it
   changes no output and needs no migration.
2. **Both spellings are accepted wherever a provider name is input.** One lookup, derived from the registry table plus
   runtime registrations (`registerProvider`), lives in `src/adapters/providers.ts`: `canonicalProviderId(name)`
   (either spelling to the adapter id), `configIdForProviderName(name)` (either spelling to the config id) and
   `acceptedProviderNames(ids)` (both spellings, for error messages). Matching is exact and case-sensitive (provider
   ids are lower case; `Claude` names nothing). The registration check already keeps the two namespaces disjoint across
   entries, so a name is never ambiguous. Boundaries:
   - MCP `routing.provider_preference` (`delegate_task`, `continue_task`, `enqueue_work`, a decision's enqueue list) is
     normalised in `checkRouting` before the request hash, so the stored request, the route decision and the idempotency
     hash carry the canonical name; queue admission normalises a stored request again on read. An unknown name fails
     `INVALID_REQUEST` naming the accepted spellings of the registered providers.
   - MCP `get_capacity` `provider`; CLI `capacity --provider` and `eval run --provider`.
   - MCP `create_project` and `update_project` `project.allowed_providers`: the published schema's enum lists both
     spellings; after validation the list is stored in the config spelling and de-duplicated.
   - Config files: `providers.<name>` keys, `projects[].allowed_providers[]`, `model_groups.<g>.members[].provider`,
     `capacity.subscriptions.<s>.providers[]` and `inner_agent.backend.shares_subscription_with` are rewritten to the
     config spelling before schema validation (`src/config/provider-names.ts`, run by `validateConfig`).
3. **The loaded config keeps the config spelling.** The config schema, `ResolvedConfig.providers` and
   `allowed_providers` in configured and dynamic projects stay keyed by config id, so every existing config and every
   stored dynamic project revision loads and behaves unchanged; `list_projects` still reports `allowed_providers` as
   stored. This is a persistence detail, not a second canonical name: comparisons go through the lookup.
4. **Duplicates after normalisation** (**Delegated**, fail closed): a list (`["claude", "claude-code"]`) is
   de-duplicated, first position kept; two map keys naming one provider (`providers.claude` and
   `providers.claude-code`) are a config error, because which settings should win would be a guess.
5. **No alias can widen anything.** The project limit check (`checkClientLimits`, disabled providers), the
   `widened_providers` approval reason, the project candidate filter (MCP server and queue admission), serve's
   `enablement`, `isProviderEnabled` and `groupMembersFor` compare canonical names. `isProviderEnabled` treats a
   provider as disabled when any spelling of its key in a raw config map says so.

## Consequences

- One client can use either spelling everywhere; outputs are unchanged.
- Skills' `applies_to_providers` is not normalised: it is stored verbatim as part of a content-addressed skill version
  and is not enforced anywhere today; a future enforcement must compare through `canonicalProviderId`.
- `adapters validate <provider>` already accepted both spellings and is unchanged.
- Tests: `src/adapters/providers.test.ts`, `src/config/provider-names.test.ts`, `src/config/fake-model-groups.test.ts`,
  `src/mcp/project-tools.test.ts` and `src/mcp/mcp.test.ts` (each "ADR-0076").
