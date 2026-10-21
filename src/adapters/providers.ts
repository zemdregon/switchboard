/**
 * Provider registry table (T4.1; NFR-MAINT-01, FR-POL-03, FR-ADP-01; LLD §2 "Provider ids"; ADR-0035). The single place
 * a provider is named. Everything below is derived from {@link BUILTIN_PROVIDERS}:
 * - the adapter id type `ProviderId` (`./types.ts`) and the config id type and list `PROVIDER_IDS`
 *   (`src/config/schema.ts`), with the `providers.<id>` and `allowed_providers` parts of the config schema;
 * - `CONFIG_TO_ADAPTER_ID` (`src/routing/collect.ts`) and the runtime lookups {@link adapterIdForConfigId} and
 *   {@link configIdForAdapterId};
 * - the provider-name aliases (ADR-0076): {@link canonicalProviderId} (canonical name = adapter id) and
 *   {@link configIdForProviderName}, which every provider-name input boundary uses to accept either spelling;
 * - the adapters `serve` registers (`buildRegistry`) and `doctor` probes (`defaultAdapters`, with its labels);
 * - the bypass-class flags the argv audit refuses on top of the shared `BYPASS_FLAGS` ({@link declaredBypassFlags}),
 *   and the short spellings and flag values it refuses ({@link declaredBypassShortFlags},
 *   {@link declaredBypassValues}; ADR-0037), the latter two only from entries that have an adapter (`create`);
 * - the provider-scoped bypass-class flags the argv audit refuses only in the owning provider's argv, or in every argv
 *   whose provider the audit does not know ({@link scopedBypassFlags}; ADR-0049 item 1, Q-95, T4.62).
 *
 * Adding an adapter: its module, manifest and fixtures, plus one entry here. Per-adapter modules are not re-exported
 * from `./index.ts`; Claude Code and Codex stay exported there for the code that already imports them.
 *
 * Module-evaluation rule (load-bearing): `./audit.ts` imports this module and the Claude adapter imports `./audit.ts`,
 * so the import graph has a cycle. This module may touch the adapter modules' bindings only inside `create` closures,
 * never at top level, so whichever module is loaded first, nothing here reads an uninitialised binding. The bypass
 * flags are therefore literal data in each entry, with their source.
 *
 * Runtime registration ({@link registerProvider}) exists so a test can register a scratch adapter from a fixture
 * module with no source edit (the T4.1 "Done when"). It can only add: it refuses an id or config id already in use,
 * a test-only entry, and malformed flags, short flags or values; the shared `BYPASS_FLAGS` and every built-in
 * declaration stay in force.
 * Its static limit: TypeScript's `ProviderId` is the built-in union, so a runtime id needs a cast (tests only).
 */
import { AntigravityAdapter } from "./antigravity/adapter.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";
import { CursorAdapter } from "./cursor/adapter.js";
import { FakeAdapter, type FakeScenario } from "./fake/adapter.js";
import { GrokAdapter } from "./grok/adapter.js";
import { KimiAdapter } from "./kimi/adapter.js";
import { MuseAdapter } from "./muse/adapter.js";
import { OpenCodeAdapter } from "./opencode/adapter.js";
import type { AcpDeclarations, ProviderAdapter, ProviderId, ResumeCwd } from "./types.js";

/** What `serve` and `doctor` pass to an entry's factory. Fields are named after the provider they configure. */
export interface ProviderFactoryOptions {
  /** `providers.claude-code.git_channel` (T9.4b, ADR-0029, ADR-0033); only the Claude Code factory reads it. */
  readonly claudeGitChannel?: boolean;
  /** Test-only fake scenario (`serve`'s fake switch); only the fake factory reads it. */
  readonly fakeScenario?: FakeScenario;
}

/**
 * A bypass-class setting given as the value of a flag (ADR-0037): the audit refuses `<flag> <value>` (two argv words)
 * and `<flag>=<value>`; the value is compared case-insensitively (`toLowerCase`; Delegated: deliberately over-refuses).
 */
export interface BypassValue {
  /** The flag that takes the value, `-x` or `--name` (same shape as `bypassFlags`). */
  readonly flag: string;
  /** The bypass-class value: non-empty, at most 128 characters, no whitespace or control characters. */
  readonly value: string;
}

/** One provider: static data plus, once its adapter module exists, a factory. */
export interface ProviderEntry {
  /** Adapter id (`ProviderId`): used by the adapter contract, the ledger and the MCP tools. */
  readonly id: string;
  /** Config id (`providers.<id>`, `allowed_providers`). Absent only for the test-only fake, which no config enables. */
  readonly configId?: string;
  /** `real` provider CLI, or `test` stand-in (registered by `serve` only behind the test-only switch). */
  readonly kind: "real" | "test";
  /** `doctor` label; absent means `<id> (real provider)`. */
  readonly label?: string;
  /**
   * The provider's bypass-class flags ("or equivalents", FR-POL-03) with their source. The argv audit refuses each of
   * them, as a bare flag or as `flag=value`, exactly as it refuses the shared `BYPASS_FLAGS`: everywhere except an
   * approved `privileged` scope that sets `bypass` (ADR-0017, ADR-0035). Adds to the shared list; removes nothing.
   */
  readonly bypassFlags: readonly string[];
  /**
   * Short bypass-class spellings (`-x`, ADR-0037). The audit refuses each one alone, as `-x=value`, and inside any
   * single-dash cluster of letters and digits (`-px`, `-xp`): deliberate over-refusal, since whether the CLI accepts a
   * cluster is not known. Counted only while the entry has `create` (no effect before its adapter exists).
   */
  readonly bypassShortFlags?: readonly string[];
  /** Bypass-class flag values (ADR-0037); counted only while the entry has `create`, as `bypassShortFlags`. */
  readonly bypassValues?: readonly BypassValue[];
  /**
   * Bypass-class flags that are ordinary flags in another provider's CLI (ADR-0049 item 1, Q-95, T4.62): Kimi Code's
   * `-p`/`--prompt` is Never Ask, while Claude Code's `-p` and Antigravity's `--prompt` are their prompt flags. The
   * argv audit refuses each one only in argv compiled for this entry's id, and in argv whose provider id it does not
   * know (every entry's scoped list then applies; fail closed), outside the approved bypass case, as a bare flag, as
   * `flag=value` and, for a short `-x`, anywhere in the letters that open a single-dash word (`-xvalue`, `-yx`;
   * deliberate over-refusal). The shared list and the other declarations still apply to every argv; this only adds.
   */
  readonly providerScopedBypassFlags?: readonly string[];
  /**
   * ACP facts (ADR-0036 items 9 and 10; LLD §2 `AcpDeclarations`): bypass-class mode ids and config option values,
   * refused in an `acp` plan outside the approved bypass case, and optional parsers that only narrow permission answers.
   * Additive only, like the flags.
   */
  readonly acp?: AcpDeclarations;
  /**
   * T5.7 (ADR-0038 item 6.3, LLD §15.6): the provider's `resumeCwd` value from TDD §4.10, kept here so the table names
   * it for every provider, including reserved ones whose adapter does not exist yet (data only until `create`). An
   * adapter's own `resumeCwd` is what the lifecycle reads; a registry test requires the two to agree for every entry
   * with `create`. Absent is handled as `unverified`.
   */
  readonly resumeCwd?: ResumeCwd;
  /** Absent while the provider has no adapter module yet (reserved id: accepted in config, never registered). */
  readonly create?: (opts: ProviderFactoryOptions) => ProviderAdapter;
}

/**
 * The built-in table, in the order `serve` registers adapters and config ids are listed. Reserved entries (no
 * `create`) keep the config and adapter ids the code accepted before T4.1; each provider's spike (`T4.n0`) adds its
 * sourced bypass-class flags, and its `T4.n2` task adds `create`. No id is added for a provider without an adapter
 * task (LLD §2 "Provider ids").
 */
export const BUILTIN_PROVIDERS = [
  {
    id: "claude",
    configId: "claude-code",
    kind: "real",
    label: "Claude Code (real provider)",
    // `claude --help` 2.1.296 (TDD §4.1.1 "Bypass flag availability", [H]): `--dangerously-skip-permissions` ("Bypass
    // all permission checks") and `--allow-dangerously-skip-permissions`. The mode value `bypassPermissions` is a
    // value of `--permission-mode`, not a flag; the adapter never emits it (see its header).
    bypassFlags: ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"],
    // Same source: the `--permission-mode` choice `bypassPermissions` (which `--restricted` "refuses"). The adapter
    // never emits it; before ADR-0037 only its compile tests said so, now the pre-spawn audit refuses it too.
    bypassValues: [{ flag: "--permission-mode", value: "bypassPermissions" }],
    // TDD §4.10: "Tied to the working directory" is `No` (T5.12 cell 2, 2.1.294; docs/research/live-checks-2026-10-17-claude.md).
    resumeCwd: "independent",
    create: (o: ProviderFactoryOptions): ProviderAdapter =>
      new ClaudeAdapter({ gitChannel: o.claudeGitChannel === true }),
  },
  {
    id: "codex",
    configId: "codex",
    kind: "real",
    label: "Codex (real provider)",
    // [R2] L28, L125 (`--yolo`, not to be built around) and L126 (`--full-auto`, deprecated compatibility option).
    // `codex exec --help` of codex-cli 0.162.0 (2026-10-20, ADR-0077): `--dangerously-bypass-approvals-and-sandbox`
    // ("Skip all confirmation prompts and execute commands without sandboxing"), emitted only in the approved bypass
    // cell; `--sandbox danger-full-access` is the same widening as a flag value. The adapter never emits that value.
    bypassFlags: ["--yolo", "--full-auto", "--dangerously-bypass-approvals-and-sandbox"],
    bypassValues: [
      { flag: "--sandbox", value: "danger-full-access" },
      { flag: "-s", value: "danger-full-access" },
    ],
    // TDD §4.10: "Tied to the working directory" is `No` (T5.12 cell 2, codex-cli 0.162.0;
    // docs/research/live-checks-2026-10-19-codex-container-resume.md).
    resumeCwd: "independent",
    create: (): ProviderAdapter => new CodexAdapter(),
  },
  {
    id: "grok",
    configId: "grok-build",
    kind: "real",
    // Its long bypass flags (`--always-approve`, `--yolo`, `--dangerously-skip-permissions`) are shared `BYPASS_FLAGS`.
    bypassFlags: [],
    // TDD §4.3.1 "Bypass-class flags" ([CLI], [ENT], [PERM]; documentation only, Unverified: T4.21): the mode value
    // `bypassPermissions`; a catch-all `allow` rule (`*`, `**`; Proposed), also through `--allowed-tools`, which [CL]
    // 1.0.51 documents as an alias of `--allow`. Active since the adapter (T4.22) added `create` (ADR-0037).
    bypassValues: [
      { flag: "--permission-mode", value: "bypassPermissions" },
      { flag: "--allow", value: "*" },
      { flag: "--allow", value: "**" },
      { flag: "--allowed-tools", value: "*" },
      { flag: "--allowed-tools", value: "**" },
    ],
    // TDD §4.10: `Unverified: T5.12` (`-r <id>` resumed from a second directory in the 2026-10-14 live check).
    resumeCwd: "unverified",
    create: (): ProviderAdapter => new GrokAdapter(),
  },
  {
    id: "antigravity",
    configId: "antigravity",
    kind: "real",
    // TDD §4.4.2: `--dangerously-skip-permissions` is shared; `always-proceed` is a settings value the audit cannot see.
    // `agy`'s parser reports unknown flags with one dash (`-output-format`, T4.41 live check C3), as Go's `flag` package
    // does, which accepts `-name` for `--name`; so the one-dash spelling is declared too (ADR-0045; Proposed, the
    // spelling itself was not run). Also refused outside an approved bypass run (Proposed, T4.32): `--remote-control`
    // (opens a remote-control tunnel, [CL v1.2.6]), the hidden `--gemini_dir` (a per-run state and credential directory,
    // live check C17) and `--add-dir` (widens the workspace), each in both spellings. The adapter emits none of them.
    // Active since the adapter (T4.32) added `create`.
    bypassFlags: [
      "-dangerously-skip-permissions",
      "--remote-control",
      "-remote-control",
      "--gemini_dir",
      "-gemini_dir",
      "--add-dir",
      "-add-dir",
    ],
    // TDD §4.10 ([RS]): "Histories are scoped to the working directory", so `bound`.
    resumeCwd: "bound",
    create: (): ProviderAdapter => new AntigravityAdapter(),
  },
  {
    id: "cursor",
    configId: "cursor",
    kind: "real",
    // `--force`, `--yolo` and `--approve-mcps` are shared `BYPASS_FLAGS`. TDD §4.5 "Bypass-class flags" ([C1]) and the
    // T4.41 live check (`--help` of 2026.10.12-d47ca18 lists each; Proposed, T4.42): `--auto-review` widens approval;
    // the worktree, workspace, directory and plugin flags widen what code a run touches; `--api-key`, `--auth-token`,
    // `-H`/`--header` and `-e`/`--endpoint` carry credentials or redirect requests. The adapter emits none of them; the
    // audit refuses each outside an approved privileged bypass run, like `-f` (short `--force`) and `--sandbox disabled`.
    // Active since the adapter (T4.42) added `create` (ADR-0037).
    bypassFlags: [
      "--auto-review",
      "--worktree",
      "--worktree-base",
      "--skip-worktree-setup",
      "--workspace",
      "--add-dir",
      "--plugin-dir",
      "--api-key",
      "--auth-token",
      "--header",
      "--endpoint",
    ],
    bypassShortFlags: ["-f", "-w", "-H", "-e"],
    bypassValues: [{ flag: "--sandbox", value: "disabled" }],
    // TDD §4.10: `Unverified: T4.41` (`--resume <id>` resumed from a second directory in the 2026-10-14 live check).
    resumeCwd: "unverified",
    create: (): ProviderAdapter => new CursorAdapter(),
  },
  {
    id: "opencode",
    configId: "opencode",
    kind: "real",
    // TDD §4.6.2 ([D-cli], [D-perm]; `run --help` of v2.0.23 in the T4.51 live check lists it): `--auto` "Auto-approve
    // permissions that are not explicitly denied", bypass-class (Proposed, fail closed; the adapter never emits it,
    // Q-83). The inline `allow` permission travels in `OPENCODE_PERMISSION`/`OPENCODE_CONFIG_CONTENT`, which the argv
    // audit does not see (ADR-0037 limits); the adapter sets neither. Active since the adapter (T4.52) added `create`.
    bypassFlags: ["--auto"],
    // TDD §4.10: `Unverified: T4.51` (`--session <id>` resumed from another directory in the 2026-10-14 live check).
    resumeCwd: "unverified",
    create: (): ProviderAdapter => new OpenCodeAdapter(),
  },
  {
    id: "kimi",
    configId: "kimi-code",
    kind: "real",
    // ADR-0049 item 1 and TDD §4.7 ([K1]; `--help` of 2.1.1 in the T4.61 live check lists each): `--auto` (Never Ask)
    // and `--plan` (which `-p` rejects anyway); `--yolo` is a shared `BYPASS_FLAGS` entry and `-y` its short spelling.
    // Active since the adapter (T4.62) added `create`.
    bypassFlags: ["--auto", "--plan"],
    bypassShortFlags: ["-y"],
    // ADR-0049 item 1 (same source): `-p`/`--prompt` is always Never Ask, so bypass-class, but Claude Code's `-p` and
    // Antigravity's `--prompt` are ordinary flags in their runs; so they are refused only in Kimi argv (and in argv of
    // an unknown provider), outside the approved bypass run whose compile emits `--prompt=<prompt>` (Q-95, T4.62).
    providerScopedBypassFlags: ["-p", "--prompt"],
    // ADR-0049 item 2 (modes observed in `session/new`, T4.61 row 9): `auto` and `yolo` as a mode id or as the value of
    // the `mode` config option are refused in an ACP plan outside the approved bypass case.
    acp: {
      bypassModeIds: ["auto", "yolo"],
      bypassConfigValues: [
        { configId: "mode", value: "auto" },
        { configId: "mode", value: "yolo" },
      ],
    },
    // TDD §4.10: `Unverified: T4.68` (where the session id appears and resume from another directory).
    resumeCwd: "unverified",
    create: (): ProviderAdapter => new KimiAdapter(),
  },
  {
    id: "muse",
    configId: "muse-code",
    kind: "real",
    // TDD §4.8 "Bypass-class flags" ([M-perm], [M-ext], confirmed; [M-log] for `--trust-workspace`): `--disable-approval`,
    // `--disable-sandbox` and `--trust-workspace`; `--yolo` is a shared `BYPASS_FLAGS` entry. The adapter emits only
    // `--trust-workspace`, and only in an approved bypass run with repository configuration `enabled` (T4.72).
    bypassFlags: ["--disable-approval", "--disable-sandbox", "--trust-workspace"],
    // TDD §4.8 (Proposed, ADR-0037): `--approval-mode never` and `--sandbox-network unrestricted` widen a run; the
    // deprecated alias `enabled` ([M-perm], [M-log]) names no stated target, so it is refused too (deliberate
    // over-refusal, Delegated). Active since the adapter (T4.72) added `create`.
    bypassValues: [
      { flag: "--approval-mode", value: "never" },
      { flag: "--sandbox-network", value: "unrestricted" },
      { flag: "--sandbox-network", value: "enabled" },
    ],
    // TDD §4.10 ([M-ext]): `--allow-workspace-switch` is needed when the workspace differs, so `bound`.
    resumeCwd: "bound",
    create: (): ProviderAdapter => new MuseAdapter(),
  },
  {
    id: "fake",
    kind: "test",
    label: "fake adapter (test stand-in, not a real provider)",
    bypassFlags: [],
    // T4.8: the fake ACP agent's made-up bypass-class mode and option value, so the plan audit and the
    // `current_mode_update` check (ADR-0036 item 10) are exercised without a provider.
    acp: {
      bypassModeIds: ["fake-bypass-mode"],
      bypassConfigValues: [{ configId: "fake-approval", value: "never-ask" }],
    },
    // Test stand-in: the default fake declares `bound`; tests build `independent` and `unverified` variants.
    resumeCwd: "bound",
    create: (o: ProviderFactoryOptions): ProviderAdapter =>
      new FakeAdapter(o.fakeScenario !== undefined ? { scenario: o.fakeScenario } : {}),
  },
] as const;
// Annotated factories and this separate check (not `satisfies`) keep the inferred table type free of `ProviderAdapter`,
// whose `id` is derived from this table (a `satisfies` here makes the type circular).
const BUILTIN_ENTRIES: readonly ProviderEntry[] = BUILTIN_PROVIDERS;

type Builtin = (typeof BUILTIN_PROVIDERS)[number];
/** Adapter ids of the built-in table (`ProviderId` in `./types.ts`). */
export type BuiltinProviderId = Builtin["id"];
/** Config ids of the built-in table (`ProviderId` in `src/config/schema.ts`). */
export type ConfigProviderId = Extract<Builtin, { readonly configId: string }>["configId"];

/** Config ids of the built-in table, in table order. */
export const BUILTIN_CONFIG_PROVIDER_IDS: readonly ConfigProviderId[] = Object.freeze(
  BUILTIN_PROVIDERS.flatMap((e) => ("configId" in e ? [e.configId] : [])),
);

/** Config id to adapter id for the built-in table (LLD §2 "Provider ids"). */
export const BUILTIN_CONFIG_TO_ADAPTER_ID: Readonly<Record<ConfigProviderId, BuiltinProviderId>> = Object.freeze(
  Object.fromEntries(BUILTIN_PROVIDERS.flatMap((e) => ("configId" in e ? [[e.configId, e.id]] : []))) as Record<
    ConfigProviderId,
    BuiltinProviderId
  >,
);

// ---- validation and runtime registration -------------------------------------------------------------------------

/** Id shape (Delegated): lower-case, starts with a letter, at most 32 characters; covers every built-in id. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * Flag shape (Delegated): `-x`, `--name` or, for parsers that accept one dash before a long name, `-name` (ADR-0045);
 * names may hold `-` and `_`; no value part (`=`), no whitespace. The audit also matches `flag=value`.
 */
const FLAG_PATTERN = /^(?:-[A-Za-z0-9]|-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)$/;
/** Short flag shape (ADR-0037): one dash, one letter or digit. */
const SHORT_FLAG_PATTERN = /^-[A-Za-z0-9]$/;
/** Value shape (ADR-0037, Delegated): 1 to 128 characters, no whitespace or control characters. */
const VALUE_PATTERN = /^[^\s\p{Cc}]{1,128}$/u;

function valueProblems(v: unknown): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [`malformed bypass value ${JSON.stringify(v)}`];
  const o = v as Record<string, unknown>;
  const keysOk = Object.keys(o).every((k) => k === "flag" || k === "value");
  const ok =
    keysOk &&
    typeof o.flag === "string" &&
    FLAG_PATTERN.test(o.flag) &&
    typeof o.value === "string" &&
    VALUE_PATTERN.test(o.value);
  return ok ? [] : [`malformed bypass value ${JSON.stringify(v)}`];
}

/** ACP declarations (T4.8, Delegated shape check): lists of 1 to 128 character strings without control characters. */
function acpProblems(acp: AcpDeclarations): string[] {
  const okString = (v: unknown) => typeof v === "string" && /^[^\p{Cc}]{1,128}$/u.test(v);
  const problems: string[] = [];
  if (!Array.isArray(acp.bypassModeIds) || !acp.bypassModeIds.every(okString)) {
    problems.push("malformed acp.bypassModeIds");
  }
  if (
    !Array.isArray(acp.bypassConfigValues) ||
    !acp.bypassConfigValues.every(
      (v) => typeof v === "object" && v !== null && okString(v.configId) && okString(v.value),
    )
  ) {
    problems.push("malformed acp.bypassConfigValues");
  }
  return problems;
}

function entryProblems(entry: ProviderEntry, others: readonly ProviderEntry[]): string[] {
  const problems: string[] = [];
  if (!ID_PATTERN.test(entry.id)) problems.push(`id ${JSON.stringify(entry.id)} does not match ${ID_PATTERN.source}`);
  if (entry.configId !== undefined && !ID_PATTERN.test(entry.configId)) {
    problems.push(`config id ${JSON.stringify(entry.configId)} does not match ${ID_PATTERN.source}`);
  }
  if (entry.kind !== "real" && entry.kind !== "test") problems.push(`kind must be real or test`);
  if (entry.kind === "test" && entry.configId !== undefined) problems.push("a test-only entry has no config id");
  if (entry.kind === "real" && entry.configId === undefined) problems.push("a real provider needs a config id");
  if (!Array.isArray(entry.bypassFlags)) problems.push("bypassFlags must be an array");
  else {
    for (const f of entry.bypassFlags) {
      if (typeof f !== "string" || !FLAG_PATTERN.test(f)) problems.push(`malformed bypass flag ${JSON.stringify(f)}`);
    }
  }
  if (entry.bypassShortFlags !== undefined) {
    if (!Array.isArray(entry.bypassShortFlags)) problems.push("bypassShortFlags must be an array");
    else {
      for (const f of entry.bypassShortFlags) {
        if (typeof f !== "string" || !SHORT_FLAG_PATTERN.test(f)) {
          problems.push(`malformed bypass short flag ${JSON.stringify(f)}`);
        }
      }
    }
  }
  if (entry.bypassValues !== undefined) {
    if (!Array.isArray(entry.bypassValues)) problems.push("bypassValues must be an array");
    else for (const v of entry.bypassValues as unknown[]) problems.push(...valueProblems(v));
  }
  if (entry.providerScopedBypassFlags !== undefined) {
    if (!Array.isArray(entry.providerScopedBypassFlags)) problems.push("providerScopedBypassFlags must be an array");
    else {
      for (const f of entry.providerScopedBypassFlags) {
        if (typeof f !== "string" || !FLAG_PATTERN.test(f)) {
          problems.push(`malformed provider-scoped bypass flag ${JSON.stringify(f)}`);
        }
      }
    }
  }
  if (entry.acp !== undefined) problems.push(...acpProblems(entry.acp));
  if (entry.resumeCwd !== undefined && !["bound", "independent", "unverified"].includes(entry.resumeCwd)) {
    problems.push(`malformed resumeCwd ${JSON.stringify(entry.resumeCwd)}`);
  }
  const ids = new Set(others.flatMap((o) => [o.id, ...(o.configId !== undefined ? [o.configId] : [])]));
  // Ids and config ids share one namespace across entries (`codex` is both for one provider, which is allowed).
  if (ids.has(entry.id)) problems.push(`id ${entry.id} is already registered`);
  if (entry.configId !== undefined && entry.configId !== entry.id && ids.has(entry.configId)) {
    problems.push(`config id ${entry.configId} is already registered`);
  }
  return problems;
}

export class ProviderRegistrationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`provider registration refused: ${problems.join("; ")}`);
    this.name = "ProviderRegistrationError";
  }
}

// Built-in table checked once at load (fail closed: a malformed built-in entry stops the process), then frozen so no
// caller can shorten a declared flag list at runtime (defence in depth; the types already say readonly).
{
  const seen: ProviderEntry[] = [];
  for (const e of BUILTIN_ENTRIES) {
    const problems = entryProblems(e, seen);
    if (problems.length > 0) throw new ProviderRegistrationError(problems);
    seen.push(e);
    Object.freeze(e.bypassFlags);
    if (e.bypassShortFlags !== undefined) Object.freeze(e.bypassShortFlags);
    if (e.providerScopedBypassFlags !== undefined) Object.freeze(e.providerScopedBypassFlags);
    if (e.bypassValues !== undefined) {
      for (const v of e.bypassValues) Object.freeze(v);
      Object.freeze(e.bypassValues);
    }
    if (e.acp !== undefined) {
      Object.freeze(e.acp.bypassModeIds);
      for (const v of e.acp.bypassConfigValues) Object.freeze(v);
      Object.freeze(e.acp.bypassConfigValues);
      Object.freeze(e.acp);
    }
    Object.freeze(e);
  }
  Object.freeze(BUILTIN_PROVIDERS);
}

const extra: ProviderEntry[] = [];
let generation = 0;

/**
 * Registers a provider at runtime (tests: the T4.1 scratch adapter). Additive only: refused, with nothing changed,
 * when the entry is test-only, reuses an id or config id, or declares a malformed flag. Returns the function that
 * removes exactly this registration; callers in tests call it in `finally`/`afterEach` so module state does not leak.
 */
export function registerProvider(entry: ProviderEntry): () => void {
  const problems = entryProblems(entry, providerEntries());
  if (entry.kind === "test") problems.push("test-only entries are built in only (the fake adapter)");
  if (problems.length > 0) throw new ProviderRegistrationError(problems);
  const frozen: ProviderEntry = Object.freeze({
    ...entry,
    bypassFlags: Object.freeze([...entry.bypassFlags]),
    ...(entry.bypassShortFlags !== undefined ? { bypassShortFlags: Object.freeze([...entry.bypassShortFlags]) } : {}),
    ...(entry.providerScopedBypassFlags !== undefined
      ? { providerScopedBypassFlags: Object.freeze([...entry.providerScopedBypassFlags]) }
      : {}),
    ...(entry.bypassValues !== undefined
      ? { bypassValues: Object.freeze(entry.bypassValues.map((v) => Object.freeze({ flag: v.flag, value: v.value }))) }
      : {}),
  });
  extra.push(frozen);
  generation += 1;
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const i = extra.indexOf(frozen);
    if (i >= 0) extra.splice(i, 1);
    generation += 1;
  };
}

/** Changes whenever a runtime registration is added or removed (config validation recompiles its schema on change). */
export function providerGeneration(): number {
  return generation;
}

/** Every entry: the built-in table, then runtime registrations in registration order. */
export function providerEntries(): readonly ProviderEntry[] {
  return [...BUILTIN_ENTRIES, ...extra];
}

/** The entry for an adapter id, if any. */
export function providerEntry(id: string): ProviderEntry | undefined {
  return providerEntries().find((e) => e.id === id);
}

/** Config ids of every entry (config validation). */
export function configProviderIds(): string[] {
  return providerEntries().flatMap((e) => (e.configId !== undefined ? [e.configId] : []));
}

/** Adapter id for a config id; undefined when no entry has it. */
export function adapterIdForConfigId(configId: string): string | undefined {
  return providerEntries().find((e) => e.configId === configId)?.id;
}

/** Config id for an adapter id; undefined for the test-only fake and unknown ids. */
export function configIdForAdapterId(id: string): string | undefined {
  return providerEntries().find((e) => e.id === id)?.configId;
}

// ---- provider names and aliases (ADR-0076; LLD §2 "Provider ids") ------------------------------------------------

/** The entry either spelling names: its adapter id or its config id. Exact, case-sensitive match (ids are lower case). */
function entryForName(name: string): ProviderEntry | undefined {
  return providerEntries().find((e) => e.id === name || e.configId === name);
}

/**
 * ADR-0076: the canonical provider name for `name`, which may be either spelling of a provider: the adapter id (the
 * canonical name, `claude`) or its config id (the alias, `claude-code`). Undefined when no entry has `name`. Every
 * input boundary that accepts a provider name normalises through this (or {@link configIdForProviderName}); the
 * registration check keeps the two namespaces disjoint across entries, so the answer is never ambiguous. The return
 * type is the built-in union; a runtime-registered id is returned as is (tests only, as `registerProvider` notes).
 */
export function canonicalProviderId(name: string): ProviderId | undefined {
  return entryForName(name)?.id as ProviderId | undefined;
}

/**
 * ADR-0076: the config spelling (`providers.<config id>`, `allowed_providers`) for either spelling of a provider;
 * undefined for an unknown name and for the test-only fake, which has no config id.
 */
export function configIdForProviderName(name: string): string | undefined {
  return entryForName(name)?.configId;
}

/**
 * ADR-0076: both spellings of every provider `ids` names (either spelling; default every entry), canonical name first,
 * each once. A name no entry knows is kept as given (a test registry may hold an adapter outside the table). For the
 * error messages that list the accepted names.
 */
export function acceptedProviderNames(ids?: readonly string[]): string[] {
  const out = new Set<string>();
  const names = ids ?? providerEntries().map((e) => e.id);
  for (const n of names) {
    const e = entryForName(n);
    if (e === undefined) {
      out.add(n);
      continue;
    }
    out.add(e.id);
    if (e.configId !== undefined) out.add(e.configId);
  }
  return [...out];
}

/** The ACP declarations of adapter id `id`, if its entry has any (ADR-0036 items 9 and 10). */
export function acpDeclarations(id: string): AcpDeclarations | undefined {
  return providerEntry(id)?.acp;
}

/** Every adapter-declared bypass-class flag (deduplicated; the argv audit adds these to `BYPASS_FLAGS`). */
export function declaredBypassFlags(): string[] {
  return [...new Set(providerEntries().flatMap((e) => e.bypassFlags))];
}

/**
 * Every declared short bypass-class spelling (`-x`, deduplicated) of the entries that have an adapter (`create`);
 * a reserved entry's declaration is data only until its adapter task adds the factory (ADR-0037).
 */
export function declaredBypassShortFlags(): string[] {
  return [...new Set(providerEntries().flatMap((e) => (e.create !== undefined ? (e.bypassShortFlags ?? []) : [])))];
}

/**
 * Every declared bypass-class flag value of the entries that have an adapter (`create`), deduplicated by flag and
 * lower-cased value (first declaration kept); reserved entries as in {@link declaredBypassShortFlags}.
 */
export function declaredBypassValues(): BypassValue[] {
  const out = new Map<string, BypassValue>();
  for (const e of providerEntries()) {
    if (e.create === undefined) continue;
    for (const v of e.bypassValues ?? []) {
      const key = `${v.flag}\u0000${v.value.toLowerCase()}`;
      if (!out.has(key)) out.set(key, { flag: v.flag, value: v.value });
    }
  }
  return [...out.values()];
}

/**
 * The provider-scoped bypass-class flags (ADR-0049 item 1, Q-95, T4.62) that apply to argv compiled for adapter id
 * `id`: that entry's own list when `id` names an entry, otherwise every entry's list, deduplicated (fail closed: an
 * argv whose provider is unknown is checked against all of them).
 */
export function scopedBypassFlags(id: string): string[] {
  const own = providerEntry(id);
  const from = own !== undefined ? [own] : providerEntries();
  return [...new Set(from.flatMap((e) => e.providerScopedBypassFlags ?? []))];
}
