import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ErrorObject } from "ajv";
import { Ajv } from "ajv";
import { ConfigError } from "./errors.js";
import { configSchema, type SwitchboardConfig, type TrustProfile } from "./schema.js";

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
  mcpClients: ReadonlyMap<string, { id: string; maxTrustProfile: TrustProfile }>;
  limits: { globalConcurrency: number; perProviderConcurrency: number };
  providers: ReadonlyMap<string, { enabled: boolean; weight: number | undefined }>;
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
  }

  return {
    configPath,
    dataDir,
    allowedRoots,
    mcpClients: new Map(cfg.mcp_clients.map((c) => [c.id, { id: c.id, maxTrustProfile: c.max_trust_profile }])),
    limits: {
      globalConcurrency: cfg.limits?.global_concurrency ?? DEFAULT_GLOBAL_CONCURRENCY,
      perProviderConcurrency: cfg.limits?.per_provider_concurrency ?? DEFAULT_PER_PROVIDER_CONCURRENCY,
    },
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
