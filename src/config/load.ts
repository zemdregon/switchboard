import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ErrorObject } from "ajv";
import { Ajv } from "ajv";
import { ProfileOverrideError, validateProfileOverrides } from "../policy/profiles.js";
import type { ProfileOverride, ProfileOverrides } from "../policy/types.js";
import { ConfigError } from "./errors.js";
import {
  configSchema,
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
  providers: ReadonlyMap<string, { enabled: boolean; weight: number | undefined }>;
  /** Retention (NFR-DATA-01, FR-WS-07; T3.12 consumes it). `intervalMs` is the GC pass period. */
  retention: { days: number; intervalMs: number };
  /**
   * True only when the config sets `retention.days` itself (T3.12, Proposed, Delegated). The 30 day default is a value,
   * not a switch: with this false, `serve` and `switchboard gc --apply` collect nothing. `retention.interval` alone
   * does not enable collection.
   */
  retentionEnabled: boolean;
  /** Adapter preflight cache TTL in milliseconds (NFR-PERF-02, T3.21); 0 disables the cache. */
  preflightTtlMs: number;
  /** Validated `profiles.<name>` overrides in COMP-POL's camelCase form (owner decision 12); empty when none. */
  profileOverrides: ProfileOverrides;
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

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile<SwitchboardConfig>(configSchema);

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
  }

  const profileOverrides = toOverrides(cfg);
  try {
    validateProfileOverrides(profileOverrides);
  } catch (err) {
    if (err instanceof ProfileOverrideError) throw new ConfigError(`Invalid config:\n  ${err.message}`);
    throw err;
  }

  return {
    configPath,
    dataDir,
    allowedRoots,
    mcpClients: new Map(
      cfg.mcp_clients.map((c) => [
        c.id,
        {
          id: c.id,
          maxTrustProfile: c.max_trust_profile,
          privilegedApproval: c.privileged_approval ?? DEFAULT_PRIVILEGED_APPROVAL,
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
    profileOverrides,
    // Proposed: a provider not listed is enabled with no explicit weight; listing it can disable it.
    providers: new Map(
      Object.entries(cfg.providers ?? {}).map(([id, p]) => [id, { enabled: p.enabled ?? true, weight: p.weight }]),
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
