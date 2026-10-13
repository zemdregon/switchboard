/**
 * Bypass-flag audit over compiled invocations (FR-POL-03, BR-14, AGENTS.md working rules; owner decision 13, ADR-0017,
 * LLD §3.1 "Bypass"; T3.17).
 *
 * `BYPASS_FLAGS` is the shared list; every adapter's declared bypass-class flags (`bypassFlags` in the provider
 * registry table, `./providers.ts`; T4.1, ADR-0035) are added to it, never subtracted ({@link bypassClassFlags}).
 * ADR-0037 adds two forms an adapter declares as data, counted once the entry has an adapter: short spellings, also
 * inside a single-dash cluster ({@link bypassClassShortFlags}), and bypass-class flag values in the `--flag value` and
 * `--flag=value` forms ({@link bypassClassValues}). A hit of any kind is admitted only when the run's context says all
 * three of: the resolved profile is `privileged`, `bypassApproved` is true (computed by the lifecycle from an
 * `APPROVED` approval row, never by an adapter or a request), and the approved scope sets `bypass`. Every other case
 * refuses the flag; with no context at all every flag is refused (the M1/M2 behaviour). The audit is independent of the adapter's own compile
 * gate, so a compile bug cannot by itself put a bypass flag on a spawned argv.
 *
 * The second half of this module (T9.4b, ADR-0029 item 6) audits `--mcp-config` and MCP allow rules: only the
 * controller-written channel definition, in one exact shape, and only in an approved bypass run (ADR-0033, owner
 * decision 41), is admitted (see {@link auditMcpArgs}). The third half checks that a Claude Code argv keeps
 * `--safe-mode` except in the approved bypass cases that omit it on purpose (see {@link auditSafeMode}).
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import { CHANNEL_MCP_CONFIG_FILE, TOOL_SHIM_MCP_SERVER, TOOL_TOKEN_ENV } from "../git/tool-protocol.js";
import {
  acpDeclarations,
  type BypassValue,
  declaredBypassFlags,
  declaredBypassShortFlags,
  declaredBypassValues,
} from "./providers.js";
import type { Invocation, ResolvedProfile } from "./types.js";

export const BYPASS_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
];

/** What the audit needs to know about the run an invocation belongs to (T3.17). */
export interface BypassContext {
  /** The run's resolved profile (policy snapshot): its name and, for `privileged`, the approved scope binding. */
  readonly profile: Pick<ResolvedProfile, "name" | "privilegedScope">;
  /** True only when the lifecycle found an `APPROVED`, hash-matching approval whose scope sets bypass. */
  readonly bypassApproved: boolean;
}

/** True exactly when `ctx` admits a bypass flag: privileged ∧ bypassApproved ∧ scope.bypass. */
export function bypassPermitted(ctx: BypassContext | undefined): boolean {
  return (
    ctx !== undefined &&
    ctx.profile.name === "privileged" &&
    ctx.bypassApproved === true &&
    ctx.profile.privilegedScope?.scope.bypass === true
  );
}

/**
 * The flags the audit refuses (T4.1, ADR-0035): `BYPASS_FLAGS` first, then every flag a registered provider entry
 * declares, without duplicates. Read at call time, so an entry registered at runtime is audited from then on. A
 * declaration can only add to the shared list: nothing here removes or admits a flag.
 */
export function bypassClassFlags(): string[] {
  return [...new Set([...BYPASS_FLAGS, ...declaredBypassFlags()])];
}

/**
 * Short spellings matched inside clusters (ADR-0037): every `-x` in {@link bypassClassFlags} (none today) and every
 * declared short flag of an entry that has an adapter, without duplicates.
 */
export function bypassClassShortFlags(): string[] {
  const short = /^-[A-Za-z0-9]$/;
  return [...new Set([...bypassClassFlags().filter((f) => short.test(f)), ...declaredBypassShortFlags()])];
}

/** Bypass-class flag values of entries that have an adapter (ADR-0037; see `declaredBypassValues`). */
export function bypassClassValues(): BypassValue[] {
  return declaredBypassValues();
}

function matches(arg: string, flags: readonly string[]): string | undefined {
  return flags.find((f) => arg === f || arg.startsWith(`${f}=`));
}

/** A single-dash cluster of letters and digits, with an optional `=value` (`-pf`, `-f=1`); never `--name`. */
const CLUSTER = /^-([A-Za-z0-9]+)(?:=.*)?$/su;

/** The declared short flags whose letter is in `arg`'s cluster, in declaration order (deliberate over-refusal). */
function clusterHits(arg: string, short: readonly string[]): string[] {
  const m = CLUSTER.exec(arg);
  const letters = m?.[1];
  if (letters === undefined) return [];
  return short.filter((f) => letters.includes(f.slice(1)));
}

/** `<flag> <value>` (this word and the next) or `<flag>=<value>`, value compared case-insensitively. */
function valueHits(list: readonly string[], i: number, values: readonly BypassValue[]): string[] {
  const arg = list[i] as string;
  const next = list[i + 1];
  return values
    .filter((v) => {
      const want = v.value.toLowerCase();
      if (arg === v.flag) return next !== undefined && next.toLowerCase() === want;
      return arg.startsWith(`${v.flag}=`) && arg.slice(v.flag.length + 1).toLowerCase() === want;
    })
    .map((v) => `${v.flag} ${v.value}`);
}

/**
 * Every bypass-class hit in argv or policyFlags, whatever the context: a flag of {@link bypassClassFlags} as before
 * (bare or `flag=value`); otherwise a short spelling inside a cluster; and a declared flag value (ADR-0037), reported
 * as `<flag> <value>`. Value pairs are read within one list (argv, then policyFlags), never across the two.
 */
export function findBypassFlags(inv: Pick<Invocation, "argv" | "policyFlags">): string[] {
  const found = new Set<string>();
  const flags = bypassClassFlags();
  const short = bypassClassShortFlags();
  const values = bypassClassValues();
  for (const list of [inv.argv, inv.policyFlags]) {
    for (let i = 0; i < list.length; i += 1) {
      const arg = list[i] as string;
      const hit = matches(arg, flags);
      if (hit) found.add(hit);
      else for (const s of clusterHits(arg, short)) found.add(s);
      for (const v of valueHits(list, i, values)) found.add(v);
    }
  }
  return [...found];
}

/**
 * The bypass flags in argv or policyFlags that `ctx` does not admit: every one found unless {@link bypassPermitted}.
 * Without a context this is every bypass flag present, so `auditInvocation(inv)` is empty exactly when the argv has
 * none.
 */
export function auditInvocation(inv: Pick<Invocation, "argv" | "policyFlags">, ctx?: BypassContext): string[] {
  return bypassPermitted(ctx) ? [] : findBypassFlags(inv);
}

export class BypassFlagError extends Error {
  constructor(readonly flags: readonly string[]) {
    super(`bypass flags refused: ${flags.join(", ")}`);
    this.name = "BypassFlagError";
  }
}

/** Throws {@link BypassFlagError} when the audit refuses any flag (used before every spawn). */
export function assertBypassAudit(inv: Pick<Invocation, "argv" | "policyFlags">, ctx?: BypassContext): void {
  const refused = auditInvocation(inv, ctx);
  if (refused.length > 0) throw new BypassFlagError(refused);
}

// ---- MCP definition audit (T9.4b, ADR-0029 item 6; ADR-0015) ------------------------------------------------------

/** The provider flag that loads MCP server definitions (`claude --help` 2.1.296). Only the channel may emit it. */
export const MCP_CONFIG_FLAG = "--mcp-config";
/** Only MCP servers from `--mcp-config` load (`claude --help` 2.1.296). */
export const STRICT_MCP_CONFIG_FLAG = "--strict-mcp-config";
/** Allow-rule flag spellings in `claude --help` 2.1.296 (`--allowedTools, --allowed-tools`). */
const ALLOW_FLAGS: readonly string[] = ["--allowedTools", "--allowed-tools"];

/**
 * What the controller knows about the injected tool channel of the run an invocation belongs to (T9.4b). Set by the
 * lifecycle from the channel service's own values, never from the adapter's output.
 */
export interface ChannelAuditContext {
  /** Absolute path of the MCP definition the channel service wrote for this run; absent when none was written. */
  readonly mcpConfigPath?: string;
  /** Tools the channel offers (`commit`, and `push` under policy `branch`). */
  readonly toolNames: readonly string[];
}

/** The exact allow rule for one channel tool: `mcp__switchboard-git__<tool>` (ADR-0029 item 4; form is an Assumption). */
export function channelToolRule(tool: string): string {
  return `mcp__${TOOL_SHIM_MCP_SERVER}__${tool}`;
}

/**
 * Owner decision 26 (ADR-0021): an approved bypass run whose scope sets `repository_config` to `enabled` omits
 * `--strict-mcp-config` so the repository's `.mcp.json` loads. Computed from the run context only (not the adapter).
 */
export function strictMcpExempt(ctx: BypassContext | undefined): boolean {
  return bypassPermitted(ctx) && ctx?.profile.privilegedScope?.scope.repository_config.mode === "enabled";
}

/**
 * ADR-0029 item 6: `--mcp-config` and MCP allow rules are admitted in exactly one shape, and refused in every other.
 * Returns one human-readable problem per violation; empty means the argv passes. Admitted:
 * - at most one `--mcp-config`, in argv only (never in `policyFlags`), followed by exactly one value that equals
 *   `channel.mcpConfigPath` (absolute, normalised, named `CHANNEL_MCP_CONFIG_FILE`), and only with a channel;
 * - `--mcp-config` only when `ctx` admits a bypass ({@link bypassPermitted}; ADR-0033, owner decision 41: the Claude
 *   channel is offered only to an approved bypass run). The adapter's own gate is `offersChannel`; this is the second,
 *   independent check;
 * - `--mcp-config` only when the provider environment carries a non-empty `SWITCHBOARD_TOOL_TOKEN` (`inv.env`): Claude
 *   Code leaves an unset `${VAR}` reference as literal text (live check, PR #41), so the controller must always set it;
 * - `--strict-mcp-config` in argv whenever `--mcp-config` is present, unless {@link strictMcpExempt};
 * - an `mcp__` token (argv words split on commas and whitespace) only as a value of `--allowedTools` and only when it
 *   is exactly {@link channelToolRule} of a tool the channel offers; so no wildcard, no server-wide rule, no other
 *   server, and no MCP rule at all without a channel.
 * Refused always: the `--mcp-config=<value>` form, inline JSON or any other path, a second occurrence.
 */
export function auditMcpArgs(
  inv: Pick<Invocation, "argv" | "policyFlags"> & { readonly env?: Readonly<Record<string, string>> },
  channel?: ChannelAuditContext,
  ctx?: BypassContext,
): string[] {
  const problems: string[] = [];
  const expectedPath = channel?.mcpConfigPath;
  const pathOk =
    expectedPath !== undefined &&
    path.isAbsolute(expectedPath) &&
    path.normalize(expectedPath) === expectedPath &&
    path.basename(expectedPath) === CHANNEL_MCP_CONFIG_FILE;
  for (const arg of [...inv.argv, ...inv.policyFlags]) {
    if (arg.startsWith(`${MCP_CONFIG_FLAG}=`)) problems.push(`${MCP_CONFIG_FLAG}=<value> form refused`);
  }
  if (inv.policyFlags.includes(MCP_CONFIG_FLAG)) problems.push(`${MCP_CONFIG_FLAG} in policyFlags refused`);
  const at = inv.argv.flatMap((a, i) => (a === MCP_CONFIG_FLAG ? [i] : []));
  if (at.length > 1) problems.push(`${MCP_CONFIG_FLAG} given ${at.length} times`);
  if (at.length >= 1) {
    const i = at[0] as number;
    const value = inv.argv[i + 1];
    const next = inv.argv[i + 2];
    if (!pathOk) problems.push(`${MCP_CONFIG_FLAG} without a controller-written channel definition`);
    else if (value !== expectedPath) problems.push(`${MCP_CONFIG_FLAG} value is not this run's channel definition`);
    if (next !== undefined && !next.startsWith("-")) problems.push(`${MCP_CONFIG_FLAG} takes exactly one file`);
    if (!inv.argv.includes(STRICT_MCP_CONFIG_FLAG) && !strictMcpExempt(ctx)) {
      problems.push(`${MCP_CONFIG_FLAG} without ${STRICT_MCP_CONFIG_FLAG}`);
    }
    if (!bypassPermitted(ctx)) problems.push(`${MCP_CONFIG_FLAG} outside an approved bypass run (ADR-0033)`);
    if ((inv.env?.[TOOL_TOKEN_ENV] ?? "") === "") {
      problems.push(`${MCP_CONFIG_FLAG} without ${TOOL_TOKEN_ENV} in the provider environment`);
    }
  }
  const allowed = new Set((channel?.toolNames ?? []).map(channelToolRule));
  for (const list of [inv.argv, inv.policyFlags]) {
    let flag: string | undefined;
    for (const arg of list) {
      if (arg.startsWith("-")) {
        flag = arg;
        continue;
      }
      if (flag === MCP_CONFIG_FLAG && arg === expectedPath) continue;
      for (const token of arg.split(/[\s,]+/u)) {
        if (!token.includes("mcp__")) continue;
        const asAllowRule = flag !== undefined && ALLOW_FLAGS.includes(flag);
        if (!asAllowRule || !allowed.has(token)) problems.push(`MCP rule refused: ${token.slice(0, 120)}`);
      }
    }
  }
  return problems;
}

/**
 * Filesystem check of the channel definition (defence in depth; the channel service already created it this way): a
 * regular file, not a link, owned by this user, mode without group or other bits, in a directory with the same
 * properties. Returns problems; empty means it passes.
 */
export function checkChannelFile(file: string): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const problems: string[] = [];
  for (const [p, kind] of [
    [file, "file"],
    [path.dirname(file), "directory"],
  ] as const) {
    try {
      const st = lstatSync(p);
      const typeOk = kind === "file" ? st.isFile() : st.isDirectory();
      if (!typeOk || st.isSymbolicLink()) problems.push(`channel ${kind} is not a plain ${kind}`);
      if (uid !== undefined && st.uid !== uid) problems.push(`channel ${kind} is not owned by this user`);
      if ((st.mode & 0o077) !== 0) problems.push(`channel ${kind} is accessible to other users`);
    } catch {
      problems.push(`channel ${kind} is missing`);
    }
  }
  return problems;
}

export class McpConfigAuditError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`MCP definition refused: ${problems.join("; ")}`);
    this.name = "McpConfigAuditError";
  }
}

/**
 * Throws {@link McpConfigAuditError} when {@link auditMcpArgs} finds a problem, or when argv carries the channel
 * definition and {@link checkChannelFile} fails (used before every spawn, after the bypass audit).
 */
export function assertMcpAudit(
  inv: Pick<Invocation, "argv" | "policyFlags"> & { readonly env?: Readonly<Record<string, string>> },
  channel?: ChannelAuditContext,
  ctx?: BypassContext,
): void {
  const problems = auditMcpArgs(inv, channel, ctx);
  if (problems.length === 0 && channel?.mcpConfigPath !== undefined && inv.argv.includes(MCP_CONFIG_FLAG)) {
    problems.push(...checkChannelFile(channel.mcpConfigPath));
  }
  if (problems.length > 0) throw new McpConfigAuditError(problems);
}

// ---- Claude Code `--safe-mode` audit (ADR-0015, ADR-0021, ADR-0033; owner decisions 26, 41) ----------------------

/** Claude Code's flag that keeps repository CLAUDE.md, skills, plugins, hooks and MCP servers off (`claude --help`). */
export const SAFE_MODE_FLAG = "--safe-mode";

/**
 * A Claude Code argv must carry `--safe-mode` (ADR-0015), except in two approved bypass cases
 * ({@link bypassPermitted}):
 * - owner decision 26 (ADR-0021): the scope's `repository_config` is `approved` or `enabled`;
 * - owner decision 41 (ADR-0033): the run carries the injected channel (`--mcp-config`, whose shape
 *   {@link auditMcpArgs} checks), because `--safe-mode` stops that server from starting (live check, PR #41).
 * Every other omission is refused, whatever the adapter compiled. Returns problems; empty means the argv passes.
 */
export function auditSafeMode(inv: Pick<Invocation, "argv">, ctx?: BypassContext): string[] {
  if (inv.argv.includes(SAFE_MODE_FLAG)) return [];
  if (bypassPermitted(ctx)) {
    const repo = ctx?.profile.privilegedScope?.scope.repository_config.mode;
    if (repo === "approved" || repo === "enabled") return [];
    if (inv.argv.includes(MCP_CONFIG_FLAG)) return [];
  }
  return [`${SAFE_MODE_FLAG} missing outside an approved bypass case (ADR-0015, ADR-0021, ADR-0033)`];
}

export class IsolationAuditError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`isolation flags refused: ${problems.join("; ")}`);
    this.name = "IsolationAuditError";
  }
}

/** Throws {@link IsolationAuditError} when {@link auditSafeMode} finds a problem (used before every Claude spawn). */
export function assertSafeModeAudit(inv: Pick<Invocation, "argv">, ctx?: BypassContext): void {
  const problems = auditSafeMode(inv, ctx);
  if (problems.length > 0) throw new IsolationAuditError(problems);
}

// ---- ACP plan audit (ADR-0036 items 3, 7.3 and 10; LLD §2 "Rules"; T4.8) -----------------------------------------

/**
 * Pre-spawn checks of an `acp-stdio` invocation's plan, independent of the adapter's own compile gate (FR-POL-03).
 * Returns problems; empty means it passes. Refused:
 * - an `acp-stdio` invocation without an `acp` plan, with an output format other than `acp`, with stdin text (the client
 *   owns stdin) or with a protocol version other than 1; an `acp` plan on any other transport;
 * - any `mcpServers` entry: ADR-0036 item 7.3 needs a per-provider ADR accepting that provider's ACP channel, and none
 *   exists yet (Delegated, fail closed);
 * - a `modeId` among the provider's declared bypass-class mode ids, or a `configOptions` pair among its declared
 *   bypass-class values (both compared case-insensitively, deliberate over-refusal as in ADR-0037), except in the
 *   approved bypass case ({@link bypassPermitted}).
 */
export function auditAcpPlan(
  inv: Pick<Invocation, "transport" | "outputFormat" | "stdin" | "acp">,
  adapterId: string,
  ctx?: BypassContext,
): string[] {
  const problems: string[] = [];
  if (inv.transport !== "acp-stdio") {
    if (inv.acp !== undefined) problems.push("acp plan on a transport other than acp-stdio");
    return problems;
  }
  const plan = inv.acp;
  if (plan === undefined) return ["acp-stdio invocation without an acp plan"];
  if (inv.outputFormat !== "acp") problems.push(`acp-stdio output format ${inv.outputFormat}`);
  if (inv.stdin?.kind === "text") problems.push("acp-stdio invocation with stdin text (the client owns stdin)");
  if (plan.protocolVersion !== 1) problems.push(`acp protocol version ${String(plan.protocolVersion)}`);
  if (plan.mcpServers.length > 0) {
    problems.push("acp mcpServers refused: no provider ACP channel is accepted by an ADR (ADR-0036 item 7.3)");
  }
  if (!bypassPermitted(ctx)) {
    const decl = acpDeclarations(adapterId);
    const lower = (v: string) => v.toLowerCase();
    if (
      plan.modeId !== undefined &&
      (decl?.bypassModeIds ?? []).some((m) => lower(m) === lower(plan.modeId as string))
    ) {
      problems.push(`acp mode ${plan.modeId.slice(0, 64)} is bypass-class`);
    }
    for (const o of plan.configOptions ?? []) {
      const hit = (decl?.bypassConfigValues ?? []).some(
        (v) => lower(v.configId) === lower(o.configId) && lower(v.value) === lower(o.value),
      );
      if (hit) problems.push(`acp config option ${o.configId.slice(0, 64)}=${o.value.slice(0, 64)} is bypass-class`);
    }
  }
  return problems;
}

export class AcpPlanAuditError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`acp plan refused: ${problems.join("; ")}`);
    this.name = "AcpPlanAuditError";
  }
}

/** Throws {@link AcpPlanAuditError} when {@link auditAcpPlan} finds a problem (used before every spawn). */
export function assertAcpPlanAudit(
  inv: Pick<Invocation, "transport" | "outputFormat" | "stdin" | "acp">,
  adapterId: string,
  ctx?: BypassContext,
): void {
  const problems = auditAcpPlan(inv, adapterId, ctx);
  if (problems.length > 0) throw new AcpPlanAuditError(problems);
}
