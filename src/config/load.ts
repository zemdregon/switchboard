import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv } from "ajv";
import { configProviderIds } from "../adapters/providers.js";
import { validateOperatorPatterns } from "../git/safe-pattern.js";
import type { ModelConfig } from "../models/registry.js";
import { ProfileOverrideError, validateProfileOverrides } from "../policy/profiles.js";
import type { ProfileOverride, ProfileOverrides } from "../policy/types.js";
import { type CapacitySettings, checkCapacity, resolveCapacity } from "./capacity.js";
import { ConfigError } from "./errors.js";
import { checkHttpTransport, type HttpTransportSettings, resolveHttpTransport } from "./http-transport.js";
import { checkInnerAgent, type InnerAgentSettings, resolveInnerAgent } from "./inner-agent.js";
import { checkProjects, type ResolvedProject, resolveProjects } from "./projects.js";
import { type RoutingSettings, resolveRouting } from "./routing.js";
import {
  currentConfigSchema,
  DEFAULT_CONTINUITY_MAX_BUNDLE_BYTES,
  DEFAULT_CONTINUITY_MAX_DIFF_EXCERPT_BYTES,
  DEFAULT_CONTINUITY_MAX_TEXT_CHARS,
  DEFAULT_PREFLIGHT_TTL_SECONDS,
  DEFAULT_PRIVILEGED_APPROVAL,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RETENTION_INTERVAL,
  type PrivilegedApprovalMode,
  type SwitchboardConfig,
  type TrustProfile,
} from "./schema.js";

export { ConfigError } from "./errors.js";

/** Defaults: NFR-PERF-03 (4 global, 1 per provider; proposed targets). */
export const DEFAULT_GLOBAL_CONCURRENCY = 4;
export const DEFAULT_PER_PROVIDER_CONCURRENCY = 1;

export interface ResolvedConfig {
  /** Absolute path of the config file that was loaded. */
  configPath: string;
  /** Canonical (realpath) data directory; created by the caller, not here. */
  dataDir: string;
  /** Canonical allowed workspace roots (FR-POL-10). */
  allowedRoots: string[];
  mcpClients: ReadonlyMap<string, ResolvedMcpClient>;
  limits: { globalConcurrency: number; perProviderConcurrency: number };
  /** Keyed by config provider id. `concurrency` is the T6.9 per-provider slot limit, absent when not set. */
  providers: ReadonlyMap<string, { enabled: boolean; weight: number | undefined; concurrency?: number }>;
  /** `providers.<id>.models` blocks (T4.5, FR-ADP-05, LLD §2.1), keyed by config provider id; only providers that set one. */
  providerModels: ReadonlyMap<string, ModelConfig>;
  /** Retention (NFR-DATA-01, FR-WS-07; T3.12 consumes it). `intervalMs` is the GC pass period. */
  retention: { days: number; intervalMs: number };
  /**
   * True only when the config sets `retention.days` itself (T3.12, Proposed, Delegated). The 30 day default is a value,
   * not a switch: with this false, `serve` and `switchboard gc --apply` collect nothing. `retention.interval` alone
   * does not enable collection.
   */
  retentionEnabled: boolean;
  /**
   * `providers.claude-code.git_channel` (T9.4b, ADR-0029 item 7): true only when the config sets it to true. Default
   * false. UNSUPPORTED until the ADR-0029 live checks pass; `serve` logs a warning when it is on.
   */
  claudeCodeGitChannel: boolean;
  /** Adapter preflight cache TTL in milliseconds (NFR-PERF-02, T3.21); 0 disables the cache. */
  preflightTtlMs: number;
  /** Validated `profiles.<name>` overrides in COMP-POL's camelCase form (owner decision 12); empty when none. */
  profileOverrides: ProfileOverrides;
  /** Validated `projects[]` (FR-PRJ-01; T9.1); empty when the config has none. Paths are as written, not yet canonical. */
  projects: ResolvedProject[];
  /** Validated `git.sanitize_patterns` (FR-GIT-04; T9.3): sources in the safe subset, in configuration order. */
  sanitizePatterns: string[];
  /**
   * Validated `inner_agent` (T11.1; FR-INN-01, LLD §13.1), defaulted. Present only when the config has the section; absent
   * means no inner agent and every behaviour is as before.
   */
  innerAgent?: InnerAgentSettings;
  /**
   * Handoff bundle bounds (T5.6; ADR-0038 item 5.5, LLD §15.4), always set, defaulted per key. Snake case on purpose: it
   * is passed as is to the bundle builder, which records it in the bundle's `bounds`.
   */
  continuity: { max_bundle_bytes: number; max_diff_excerpt_bytes: number; max_text_chars: number };
  /** Capacity and resilience settings (M6, T6.2; LLD §16.1), always set, defaulted per key. */
  capacity: CapacitySettings;
  /** Routing settings (M7, T7.1; LLD §17.1), always set, defaulted per key. */
  routing: RoutingSettings;
  /**
   * Validated `transport.http` (T13.1; FR-MCP-12, ADR-0041). Absent unless the section sets `enabled: true`; absent
   * means `serve` opens no listener.
   */
  httpTransport?: HttpTransportSettings;
}

export interface ResolvedMcpClient {
  readonly id: string;
  readonly maxTrustProfile: TrustProfile;
  /**
   * `privileged_approval` (ADR-0019, default `required`). `not_required` admits this client's `privileged` requests to
   * QUEUED under an approval written APPROVED by client policy; it is valid only with a `privileged` ceiling.
   * `loadConfig` always sets it; a hand-built entry without it is read as `required` (fail closed).
   */
  readonly privilegedApproval?: PrivilegedApprovalMode;
  /**
   * `projects` (FR-PRJ-06, T9.2): the project ids the client may use. `loadConfig` always sets it (empty when the entry
   * has none); a hand-built entry without it is read as no project (fail closed).
   */
  readonly projects?: readonly string[];
  /**
   * `manage_projects` (FR-PRJ-10, T9.9): offers `create_project`, `update_project` and `delete_project`. `loadConfig`
   * always sets it (default false); a hand-built entry without it is read as false (fail closed).
   */
  readonly manageProjects?: boolean;
  /**
   * `max_push_policy` (FR-PRJ-10, T9.9): the widest push policy a dynamic project of this client may declare. `loadConfig`
   * always sets it (default `none`); a hand-built entry without it is read as `none` (fail closed).
   */
  readonly maxPushPolicy?: "none" | "branch";
}

const INTERVAL_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses a validated `<n>m|h|d` interval into milliseconds. */
export function parseRetentionInterval(text: string): number {
  const m = /^([1-9][0-9]*)([mhd])$/.exec(text);
  if (!m) throw new ConfigError(`Invalid config:\n  $.retention.interval: must look like 30m, 12h or 7d`);
  return Number(m[1]) * INTERVAL_UNIT_MS[m[2] as "m" | "h" | "d"];
}

function toOverrides(cfg: SwitchboardConfig): ProfileOverrides {
  const out: ProfileOverrides = {};
  for (const [name, o] of Object.entries(cfg.profiles ?? {})) {
    const ov: ProfileOverride = {};
    if (o.file_access !== undefined) ov.fileAccess = o.file_access;
    if (o.shell !== undefined) ov.shell = o.shell;
    if (o.shell_allowlist !== undefined) ov.shellAllowlist = [...o.shell_allowlist];
    if (o.network !== undefined) ov.network = o.network;
    if (o.network_allowlist !== undefined) ov.networkAllowlist = [...o.network_allowlist];
    if (o.repo_config !== undefined) ov.repoConfig = o.repo_config;
    out[name as keyof ProfileOverrides] = ov;
  }
  return out;
}

export interface ResolveEnv {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  homedir?: string;
}

/**
 * Config validator over {@link currentConfigSchema} (T4.1): compiled once for the built-in provider ids, and again,
 * with a fresh Ajv (the schema `$id` is fixed), only when a provider is registered or removed at runtime.
 */
let compiled: { readonly generation: number; readonly validate: ValidateFunction<SwitchboardConfig> } | undefined;
function validator(): ValidateFunction<SwitchboardConfig> {
  const { generation, schema } = currentConfigSchema();
  if (compiled?.generation !== generation) {
    compiled = { generation, validate: new Ajv({ allErrors: true, strict: true }).compile<SwitchboardConfig>(schema) };
  }
  return compiled.validate;
}

/** Resolution order: --config, SWITCHBOARD_CONFIG, $XDG_CONFIG_HOME/switchboard/config.json (TDD §3.1). */
export function resolveConfigPath({ argv = [], env = process.env, homedir = os.homedir() }: ResolveEnv = {}): string {
  let fromFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--config") {
      fromFlag = argv[i + 1];
      if (fromFlag === undefined || fromFlag === "") throw new ConfigError("--config requires a path");
    } else if (a.startsWith("--config=")) {
      fromFlag = a.slice("--config=".length);
      if (fromFlag === "") throw new ConfigError("--config requires a path");
    }
  }
  const chosen = fromFlag ?? (env.SWITCHBOARD_CONFIG || undefined);
  if (chosen !== undefined) return path.resolve(chosen);
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir, ".config");
  return path.join(base, "switchboard", "config.json");
}

/** Default data dir: $XDG_DATA_HOME/switchboard (TDD §3.1). */
export function defaultDataDir(env: Record<string, string | undefined> = process.env, homedir = os.homedir()): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir, ".local", "share");
  return path.join(base, "switchboard");
}

function jsonPath(e: ErrorObject): string {
  let p = e.instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((acc, s) => (/^\d+$/.test(s) ? `${acc}[${s}]` : `${acc}.${s}`), "$");
  if (e.keyword === "required") p += `.${String(e.params.missingProperty)}`;
  if (e.keyword === "additionalProperties") p += `.${String(e.params.additionalProperty)}`;
  return p;
}

function describe(e: ErrorObject): string {
  const where = jsonPath(e);
  switch (e.keyword) {
    case "required":
      return `${where}: required property is missing`;
    case "additionalProperties":
      return `${where}: unknown key (not permitted)`;
    case "enum":
      return `${where}: must be one of ${(e.params.allowedValues as unknown[]).map(String).join(", ")}`;
    case "const":
      return `${where}: must equal ${JSON.stringify(e.params.allowedValue)}`;
    default:
      return `${where}: ${e.message ?? "invalid"}`;
  }
}

/** Validate parsed JSON; throws ConfigError listing every violation with its JSON path (NFR-SEC-05, NFR-SEC-06). */
export function validateConfig(value: unknown, source = "config"): SwitchboardConfig {
  const validate = validator();
  if (validate(value)) return value;
  const lines = (validate.errors ?? []).map(describe);
  throw new ConfigError(`Invalid ${source}:\n${lines.map((l) => `  ${l}`).join("\n")}`);
}

function canonical(p: string, label: string, baseDir: string): string {
  const abs = path.resolve(baseDir, p);
  try {
    return realpathSync(abs);
  } catch (err) {
    throw new ConfigError(
      `${label}: cannot resolve ${JSON.stringify(p)} (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
}

/** Load, validate and canonicalize the config. Fails closed on any problem (NFR-SEC-06). */
export function loadConfig(opts: ResolveEnv & { configPath?: string } = {}): ResolvedConfig {
  const configPath = opts.configPath ? path.resolve(opts.configPath) : resolveConfigPath(opts);
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${configPath}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  const cfg = validateConfig(parsed, `config file ${configPath}`);
  const baseDir = path.dirname(configPath);

  const allowedRoots = cfg.allowed_roots.map((r, i) => canonical(r, `$.allowed_roots[${i}]`, baseDir));
  // Proposed: the data dir may not exist yet, so canonicalize its nearest existing ancestor and re-append the rest.
  const rawData = cfg.data_dir ?? defaultDataDir(opts.env, opts.homedir);
  const dataDir = canonicalAllowMissing(path.resolve(baseDir, rawData));

  const ids = new Set<string>();
  for (const [i, c] of cfg.mcp_clients.entries()) {
    if (ids.has(c.id))
      throw new ConfigError(`Invalid config: $.mcp_clients[${i}].id: duplicate client id ${JSON.stringify(c.id)}`);
    ids.add(c.id);
    // ADR-0019 (Proposed, fail closed): lifting the per-scope approval means nothing below a privileged ceiling, so a
    // `not_required` there is a configuration mistake rather than a silent no-op.
    if (c.privileged_approval === "not_required" && c.max_trust_profile !== "privileged") {
      throw new ConfigError(
        `Invalid config: $.mcp_clients[${i}].privileged_approval: not_required applies only to a client whose ` +
          `max_trust_profile is privileged (client ${JSON.stringify(c.id)} has ${c.max_trust_profile}); remove it or ` +
          "set it to required",
      );
    }
    // T9.9 (Delegated, fail closed): a push ceiling for dynamic projects means nothing without manage_projects.
    if (c.max_push_policy !== undefined && c.max_push_policy !== "none" && c.manage_projects !== true) {
      throw new ConfigError(
        `Invalid config: $.mcp_clients[${i}].max_push_policy: applies only to a client with manage_projects: true ` +
          `(client ${JSON.stringify(c.id)}); remove it or set manage_projects`,
      );
    }
  }

  // FR-PRJ-06 (T9.2): a client's project list may only name configured projects (NFR-SEC-06: unknown id aborts startup).
  const projectIds = new Set((cfg.projects ?? []).map((p) => p.id));
  for (const [i, c] of cfg.mcp_clients.entries()) {
    for (const [j, id] of (c.projects ?? []).entries()) {
      if (!projectIds.has(id)) {
        throw new ConfigError(
          `Invalid config: $.mcp_clients[${i}].projects[${j}]: unknown project id ${JSON.stringify(id)} ` +
            `(client ${JSON.stringify(c.id)}); define it in projects[] or remove it`,
        );
      }
    }
  }

  const profileOverrides = toOverrides(cfg);
  try {
    validateProfileOverrides(profileOverrides);
  } catch (err) {
    if (err instanceof ProfileOverrideError) throw new ConfigError(`Invalid config:\n  ${err.message}`);
    throw err;
  }

  const patternErrors = validateOperatorPatterns(cfg.git?.sanitize_patterns ?? []);
  if (patternErrors.length > 0) {
    throw new ConfigError(
      `Invalid config:\n${patternErrors.map((l) => `  $.git.sanitize_patterns${l.startsWith("[") ? "" : ": "}${l}`).join("\n")}`,
    );
  }

  const projectErrors = checkProjects(cfg);
  if (projectErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${projectErrors.map((l) => `  ${l}`).join("\n")}`);
  }

  const innerErrors = checkInnerAgent(cfg.inner_agent, configProviderIds());
  if (innerErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${innerErrors.map((l) => `  ${l}`).join("\n")}`);
  }

  const httpErrors = checkHttpTransport(cfg.transport?.http);
  // T13.4 (FR-MCP-14, Q-77): every HTTP mapping names a configured MCP client whose privileged runs still need the
  // operator's approval (a remote client never gets `privileged_approval: not_required`).
  const mcpById = new Map(cfg.mcp_clients.map((c) => [c.id, c]));
  const httpTargets: [string, string][] = [
    ...(cfg.transport?.http?.clients ?? []).map((c, i): [string, string] => [`clients[${i}].mcp_client`, c.mcp_client]),
    ...(cfg.transport?.http?.default_mcp_client !== undefined
      ? [["default_mcp_client", cfg.transport.http.default_mcp_client] as [string, string]]
      : []),
  ];
  for (const [where, id] of httpTargets) {
    const entry = mcpById.get(id);
    if (entry === undefined) httpErrors.push(`$.transport.http.${where}: unknown mcp_clients id ${JSON.stringify(id)}`);
    else if (where === "default_mcp_client" && entry.max_trust_profile === "privileged") {
      httpErrors.push(
        `$.transport.http.default_mcp_client: ${JSON.stringify(id)} has a privileged ceiling; map each OAuth client ` +
          "to a privileged entry explicitly in transport.http.clients instead",
      );
    } else if (entry.privileged_approval === "not_required") {
      httpErrors.push(
        `$.transport.http.${where}: ${JSON.stringify(id)} has privileged_approval not_required; an HTTP client's ` +
          "privileged runs must wait for the operator (FR-MCP-14)",
      );
    }
  }
  if (httpErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${httpErrors.map((l) => `  ${l}`).join("\n")}`);
  }
  const httpTransport = resolveHttpTransport(cfg.transport?.http);

  const capacityErrors = checkCapacity(cfg.capacity);
  if (capacityErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${capacityErrors.map((l) => `  ${l}`).join("\n")}`);
  }

  return {
    configPath,
    dataDir,
    ...(httpTransport !== undefined ? { httpTransport } : {}),
    projects: resolveProjects(cfg),
    sanitizePatterns: [...(cfg.git?.sanitize_patterns ?? [])],
    ...(cfg.inner_agent !== undefined ? { innerAgent: resolveInnerAgent(cfg.inner_agent) } : {}),
    allowedRoots,
    mcpClients: new Map(
      cfg.mcp_clients.map((c) => [
        c.id,
        {
          id: c.id,
          maxTrustProfile: c.max_trust_profile,
          privilegedApproval: c.privileged_approval ?? DEFAULT_PRIVILEGED_APPROVAL,
          projects: [...(c.projects ?? [])],
          manageProjects: c.manage_projects === true,
          maxPushPolicy: c.max_push_policy ?? "none",
        },
      ]),
    ),
    limits: {
      globalConcurrency: cfg.limits?.global_concurrency ?? DEFAULT_GLOBAL_CONCURRENCY,
      perProviderConcurrency: cfg.limits?.per_provider_concurrency ?? DEFAULT_PER_PROVIDER_CONCURRENCY,
    },
    retention: {
      days: cfg.retention?.days ?? DEFAULT_RETENTION_DAYS,
      intervalMs: parseRetentionInterval(cfg.retention?.interval ?? DEFAULT_RETENTION_INTERVAL),
    },
    retentionEnabled: cfg.retention?.days !== undefined,
    preflightTtlMs: (cfg.timeouts?.preflight_ttl_seconds ?? DEFAULT_PREFLIGHT_TTL_SECONDS) * 1000,
    continuity: {
      max_bundle_bytes: cfg.continuity?.max_bundle_bytes ?? DEFAULT_CONTINUITY_MAX_BUNDLE_BYTES,
      max_diff_excerpt_bytes: cfg.continuity?.max_diff_excerpt_bytes ?? DEFAULT_CONTINUITY_MAX_DIFF_EXCERPT_BYTES,
      max_text_chars: cfg.continuity?.max_text_chars ?? DEFAULT_CONTINUITY_MAX_TEXT_CHARS,
    },
    capacity: resolveCapacity(cfg.capacity),
    routing: resolveRouting(cfg.routing),
    claudeCodeGitChannel: cfg.providers?.["claude-code"]?.git_channel === true,
    profileOverrides,
    // Proposed: a provider not listed is enabled with no explicit weight; listing it can disable it.
    providers: new Map(
      Object.entries(cfg.providers ?? {}).map(([id, p]) => [
        id,
        {
          enabled: p.enabled ?? true,
          weight: p.weight,
          ...(p.concurrency !== undefined ? { concurrency: p.concurrency } : {}),
        },
      ]),
    ),
    providerModels: new Map(
      Object.entries(cfg.providers ?? {}).flatMap(([id, p]) =>
        p.models !== undefined ? [[id, p.models] as const] : [],
      ),
    ),
  };
}

function canonicalAllowMissing(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigError(
          `$.data_dir: cannot resolve ${JSON.stringify(abs)} (${(err as NodeJS.ErrnoException).code ?? "error"})`,
        );
      }
      const parent = path.dirname(cur);
      if (parent === cur) throw new ConfigError(`$.data_dir: cannot resolve ${JSON.stringify(abs)}`);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** FR-POL-10: path-prefix-with-separator check of an already-canonical workspace path against canonical roots. */
export function isUnderAllowedRoot(canonicalPath: string, roots: readonly string[]): boolean {
  return roots.some((r) => canonicalPath === r || canonicalPath.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}
