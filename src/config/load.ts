import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv } from "ajv";
import { configProviderIds } from "../adapters/providers.js";
import { validateOperatorPatterns } from "../git/safe-pattern.js";
import { compileSecretScanAllow, type SecretScanAllowEntry, SecretScanAllowError } from "../git/secret-scan.js";
import type { ModelConfig } from "../models/registry.js";
import { ProfileOverrideError, validateProfileOverrides } from "../policy/profiles.js";
import type { ProfileOverride, ProfileOverrides } from "../policy/types.js";
import { BriefError, briefBlockTokens, readBriefFile } from "../projects/brief.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_MAX_RUN_BYTES,
} from "../skills/limits.js";
import { type CapacitySettings, checkCapacity, resolveCapacity } from "./capacity.js";
import { type CiTriggerSettings, checkCiTrigger, resolveCiTrigger } from "./ci-trigger.js";
import { type ControlPlaneSettings, checkControlPlane, resolveControlPlane } from "./control-plane.js";
import { ConfigError } from "./errors.js";
import { checkHttpTransport, type HttpTransportSettings, resolveHttpTransport } from "./http-transport.js";
import { checkInnerAgent, type InnerAgentSettings, resolveInnerAgent } from "./inner-agent.js";
import {
  checkNotificationSinks,
  type NotificationSinkSettings,
  resolveNotificationSinks,
} from "./notification-sinks.js";
import {
  checkProjects,
  type ResolvedProject,
  type ResolvedSkillAssignment,
  resolveProjects,
  resolveSkillAssignment,
} from "./projects.js";
import { checkRag, type RagSettings, resolveRag } from "./rag.js";
import {
  checkRouting,
  type ResolvedModelGroups,
  type RoutingSettings,
  resolveModelGroups,
  resolveRouting,
} from "./routing.js";
import {
  APPROVAL_PROXY_KINDS,
  type ApprovalProxyKind,
  currentConfigSchema,
  DEFAULT_CONTINUITY_MAX_BUNDLE_BYTES,
  DEFAULT_CONTINUITY_MAX_DIFF_EXCERPT_BYTES,
  DEFAULT_CONTINUITY_MAX_TEXT_CHARS,
  DEFAULT_PREFLIGHT_TTL_SECONDS,
  DEFAULT_PRIVILEGED_APPROVAL,
  DEFAULT_PROJECT_SOURCE_HOSTS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RETENTION_INTERVAL,
  DEFAULT_SKILL_DELIVERY,
  DEFAULT_TOOL_PROFILE,
  memberProviderIds,
  type PrivilegedApprovalMode,
  type SkillDelivery,
  type SwitchboardConfig,
  type ToolProfile,
  type TrustProfile,
} from "./schema.js";

export { ConfigError } from "./errors.js";

/** Defaults: NFR-PERF-03 (4 global, 1 per provider; proposed targets). */
export const DEFAULT_GLOBAL_CONCURRENCY = 4;
export const DEFAULT_PER_PROVIDER_CONCURRENCY = 1;
/** Assumption (Delegated, T3.22): `limits.verification_slots` when another `limits.verification_*` key is set. */
export const DEFAULT_VERIFICATION_SLOTS = 2;
/** Assumption (Delegated, T3.22): `limits.verification_nice` when another `limits.verification_*` key is set. */
export const DEFAULT_VERIFICATION_NICE = 10;

/** T3.22 (FR-EXE-09): the resolved verification limiter (the lifecycle's `VerificationLimits`). */
export interface ResolvedVerificationLimits {
  slots: number;
  nice: number;
  env: Record<string, string>;
}

/** T3.22: `limits.verification_*` → the lifecycle's limiter, or nothing when no such key is set. */
function resolveVerificationLimits(limits: SwitchboardConfig["limits"]): {
  verificationLimits?: ResolvedVerificationLimits;
} {
  const { verification_slots: slots, verification_nice: nice, verification_env: env } = limits ?? {};
  if (slots === undefined && nice === undefined && env === undefined) return {};
  return {
    verificationLimits: {
      slots: slots ?? DEFAULT_VERIFICATION_SLOTS,
      nice: nice ?? DEFAULT_VERIFICATION_NICE,
      env: { ...env },
    },
  };
}

/** Resolved `project_sources` (ADR-0068). */
export interface ProjectSourcesSettings {
  readonly cloneRoot: string;
  readonly allowedHosts: readonly string[];
  /** Lower case. */
  readonly allowedOwners: readonly string[];
}

export interface ResolvedConfig {
  /** Absolute path of the config file that was loaded. */
  configPath: string;
  /** Canonical (realpath) data directory; created by the caller, not here. */
  dataDir: string;
  /** Canonical allowed workspace roots (FR-POL-10). */
  allowedRoots: string[];
  mcpClients: ReadonlyMap<string, ResolvedMcpClient>;
  /**
   * `minFreeDiskMb` (T3.23, FR-WS-11) is present only when the config sets `limits.min_free_disk_mb`: the floor is off
   * by default and an unset key leaves `limits` exactly as before.
   */
  limits: {
    globalConcurrency: number;
    perProviderConcurrency: number;
    minFreeDiskMb?: number;
    /** T9.13 (FR-WS-10): present only when set; `serve` applies the default only when a project declares a seed. */
    seedStoreMb?: number;
    /** T9.13 (FR-WS-10): as `seedStoreMb`. */
    seedEntriesPerSeed?: number;
  };
  /**
   * T3.22 (FR-EXE-09, LLD §8.1): the verification limiter; undefined unless the config sets a `limits.verification_*`
   * key, so an unconfigured controller verifies exactly as before. Unset keys take the Assumption defaults.
   */
  verificationLimits?: ResolvedVerificationLimits;
  /**
   * T3.24 (FR-CAP-12, LLD §20.2): the host load hold; present only when the config sets `host`, so an unconfigured
   * controller never reads the load average.
   */
  hostLoad?: { maxLoad1: number; resumeLoad1: number };
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
   * false. Supported, bypass-only (owner decision 2026-10-16, ADR-0033); `serve` logs a warning when it is on.
   */
  claudeCodeGitChannel: boolean;
  /** Adapter preflight cache TTL in milliseconds (NFR-PERF-02, T3.21); 0 disables the cache. */
  preflightTtlMs: number;
  /** Validated `profiles.<name>` overrides in COMP-POL's camelCase form (owner decision 12); empty when none. */
  profileOverrides: ProfileOverrides;
  /**
   * `outer_sandbox.required_profiles` (T3.1; LLD §8.4, ADR-0051): profiles refused at admission unless they can run
   * inside the outer sandbox. Empty (the default) changes nothing.
   */
  outerSandboxRequiredProfiles: readonly Exclude<TrustProfile, "privileged">[];
  /**
   * T3.11 (FR-EXE-08, FR-POL-06, decision 11): optional confined verification in the outer sandbox from T3.1.
   * True when opted in (via SWITCHBOARD_CONFINED_VERIFICATION env or programmatic option). Default false.
   */
  confinedVerification: boolean;
  /** Validated `projects[]` (FR-PRJ-01; T9.1); empty when the config has none. Paths are as written, not yet canonical. */
  projects: ResolvedProject[];
  /** Validated `git.sanitize_patterns` (FR-GIT-04; T9.3): sources in the safe subset, in configuration order. */
  sanitizePatterns: string[];
  /** Validated `git.secret_scan.allow` (FR-GIT-11; T9.14): every rule id known, every glob non-empty; empty by default. */
  secretScanAllow: SecretScanAllowEntry[];
  /**
   * Validated `inner_agent` (T11.1; FR-INN-01, LLD §13.1), defaulted. Present only when the config has the section; absent
   * means no inner agent and every behaviour is as before.
   */
  innerAgent?: InnerAgentSettings;
  /**
   * Retrieval index settings (T12.1; FR-RAG-01, LLD §14.1), always set and defaulted. Without `embedding` the feature is
   * inert: every project resolves off (`effectiveProjectRag`) and no store is created.
   */
  rag: RagSettings;
  /**
   * Handoff bundle bounds (T5.6; ADR-0038 item 5.5, LLD §15.4), always set, defaulted per key. Snake case on purpose: it
   * is passed as is to the bundle builder, which records it in the bundle's `bounds`.
   */
  continuity: { max_bundle_bytes: number; max_diff_excerpt_bytes: number; max_text_chars: number };
  /** Capacity and resilience settings (M6, T6.2; LLD §16.1), always set, defaulted per key. */
  capacity: CapacitySettings;
  /** Routing settings (M7, T7.1; LLD §17.1), always set, defaulted per key. */
  routing: RoutingSettings;
  /** Configured model groups (T7.13, T7.14; LLD §17.7), keyed by name; empty when `model_groups` is absent. */
  modelGroups: ResolvedModelGroups;
  /**
   * Control-plane settings (M14; LLD §3.4.6), always set, defaulted per key. T14.4: every unset budget cap is
   * unlimited; T14.5: unset loop-breaker keys take the LLD defaults.
   */
  controlPlane: ControlPlaneSettings;
  /**
   * Validated `transport.http` (T13.1; FR-MCP-12, ADR-0041). Absent unless the section sets `enabled: true`; absent
   * means `serve` opens no listener.
   */
  httpTransport?: HttpTransportSettings;
  /**
   * Validated `notification_sinks[]` (T14.9; FR-CTL-10, LLD §3.4.9, ADR-0048), always set; empty means off and no
   * outbound notification is made. Holds operator destinations and tokens: never log or serialise it (FR-TEL-03).
   */
  notificationSinks: NotificationSinkSettings[];
  /**
   * `project_sources` (ADR-0068): where `create_project` / `update_project` may clone a `clone_url`. Absent unless the
   * config sets the section; absent means every clone is refused. `cloneRoot` is canonical and under an allowed root;
   * hosts are lower case, owners are compared case-insensitively (kept lower case here).
   */
  projectSources?: ProjectSourcesSettings;
  /** `ci_trigger` (T15.3; FR-QUE-03, LLD §18.6), always set; disabled unless the operator turns it on. */
  ciTrigger: CiTriggerSettings;
  /** Validated OTLP settings (LLD §7, LLD §20.13); absent means no export, no per-run receiver, no dependency load. */
  telemetry?: { otlpEndpoint?: string; providerOtlp?: boolean };
  /**
   * Switchboard-controlled skills (T16.3; FR-SKL-03, FR-SKL-04, FR-SKL-08, LLD §19.3). Always set. An absent section
   * resolves to `enabled: false` and the LLD defaults, and no other field of this object changes because of it.
   * Admission (T16.4) is what reads `enabled`; this loader does not.
   */
  skills: ResolvedSkills;
}

/**
 * Resolved `skills` (LLD §19.3). Limits are the configured values or the LLD defaults. `allowDraftInTrusted` is the
 * Q-105 Delegated default (`false`) when the key is absent.
 */
export interface ResolvedSkills extends ResolvedSkillAssignment {
  readonly enabled: boolean;
  readonly delivery: SkillDelivery;
  readonly allowDraftInTrusted: boolean;
  readonly maxBodyBytes: number;
  readonly maxPerRun: number;
  readonly maxRunBytes: number;
  readonly maxNames: number;
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
  /**
   * `approval_proxy` (FR-CTL-08, T14.8, ADR-0047): offers `list_pending_approvals` and `decide_approval`. `loadConfig`
   * always sets it (default false); a hand-built entry without it is read as false (fail closed).
   */
  readonly approvalProxy?: boolean;
  /**
   * `approval_proxy_targets` (T14.8): client ids whose pending approvals this proxy may decide. `loadConfig` always sets
   * it with `approvalProxy` (default: the client itself); a hand-built proxy entry without it targets only itself.
   */
  readonly approvalProxyTargets?: readonly string[];
  /**
   * `approval_proxy_kinds` (ADR-0068): the approval kinds this proxy may list and decide. `loadConfig` sets it with
   * `approvalProxy` (default: all three, ADR-0047 as before); a hand-built proxy entry without it means all three.
   */
  readonly approvalProxyKinds?: readonly ApprovalProxyKind[];
  /**
   * `tool_profile` (FR-CTL-11, T14.11, LLD §3.4.10): which tools `tools/list` offers. `loadConfig` always sets it
   * (default `orchestrator`); a hand-built entry without it is read as `orchestrator`, today's set.
   */
  readonly toolProfile?: ToolProfile;
  /**
   * `skills` (FR-SKL-08, T16.3, LLD §19.3): bare names this client may see and inject. Absent means every approved
   * name. Present, including empty, is the allow-list. `loadConfig` sets it only when the config sets the key.
   */
  readonly skills?: readonly string[];
  /**
   * `allow_light` (FR-CAP-12, T3.24, LLD §20.2): this client's `light: true` is honoured during a host load hold.
   * `loadConfig` sets it only when the key is true; absent is read as false (least privilege).
   */
  readonly allowLight?: boolean;
}

const INTERVAL_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses a validated `<n>m|h|d` interval into milliseconds. */
export function parseRetentionInterval(text: string): number {
  const m = /^([1-9][0-9]*)([mhd])$/.exec(text);
  if (!m) throw new ConfigError(`Invalid config:\n  $.retention.interval: must look like 30m, 12h or 7d`);
  return Number(m[1]) * INTERVAL_UNIT_MS[m[2] as "m" | "h" | "d"];
}

/**
 * Resolve `skills` (T16.3, LLD §19.3). An absent section is `enabled: false` and the Assumption defaults. A run total
 * smaller than one body is refused: the LLD gives no range, and this cross-check is Delegated.
 */
export function resolveSkills(cfg: SwitchboardConfig): ResolvedSkills {
  const maxBodyBytes = cfg.skills?.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxRunBytes = cfg.skills?.max_run_bytes ?? DEFAULT_MAX_RUN_BYTES;
  if (maxRunBytes < maxBodyBytes) {
    throw new ConfigError(
      "Invalid config:\n  $.skills.max_run_bytes: must be >= skills.max_body_bytes " +
        `(${maxBodyBytes}); a single skill body cannot exceed the run total`,
    );
  }
  return {
    ...resolveSkillAssignment(cfg.skills),
    enabled: cfg.skills?.enabled === true,
    delivery: cfg.skills?.delivery ?? DEFAULT_SKILL_DELIVERY,
    allowDraftInTrusted: cfg.skills?.allow_draft_in_trusted === true,
    maxBodyBytes,
    maxPerRun: cfg.skills?.max_per_run ?? DEFAULT_MAX_PER_RUN,
    maxRunBytes,
    maxNames: cfg.skills?.max_names ?? DEFAULT_MAX_NAMES,
  };
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
const compiled = new Map<
  boolean,
  { readonly generation: number; readonly validate: ValidateFunction<SwitchboardConfig> }
>();
function validator(testFakeAdapter: boolean): ValidateFunction<SwitchboardConfig> {
  const { generation, schema } = currentConfigSchema({ testFakeAdapter });
  let entry = compiled.get(testFakeAdapter);
  if (entry?.generation !== generation) {
    entry = { generation, validate: new Ajv({ allErrors: true, strict: true }).compile<SwitchboardConfig>(schema) };
    compiled.set(testFakeAdapter, entry);
  }
  return entry.validate;
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
export function validateConfig(
  value: unknown,
  source = "config",
  opts: { readonly testFakeAdapter?: boolean } = {},
): SwitchboardConfig {
  const validate = validator(opts.testFakeAdapter === true);
  if (validate(value)) return value;
  const lines = (validate.errors ?? []).map(describe);
  throw new ConfigError(`Invalid ${source}:\n${lines.map((l) => `  ${l}`).join("\n")}`);
}

/**
 * ADR-0068 (fail closed, NFR-SEC-06): `project_sources` as the schema cannot check it. `clone_root` must be written as
 * an absolute path, resolve (it must exist) under an allowed root and not lie inside the data directory; an owner may
 * not be `.` or `..`. Owners are kept lower case (GitHub owners are case-insensitive).
 */
function resolveProjectSources(
  src: SwitchboardConfig["project_sources"],
  allowedRoots: readonly string[],
  dataDir: string,
  baseDir: string,
): ProjectSourcesSettings | undefined {
  if (src === undefined) return undefined;
  if (!path.isAbsolute(src.clone_root)) {
    throw new ConfigError("Invalid config: $.project_sources.clone_root: must be an absolute path");
  }
  const cloneRoot = canonical(src.clone_root, "$.project_sources.clone_root", baseDir);
  if (!isUnderAllowedRoot(cloneRoot, allowedRoots)) {
    throw new ConfigError("Invalid config: $.project_sources.clone_root: must lie under one of allowed_roots");
  }
  if (isUnderAllowedRoot(cloneRoot, [dataDir])) {
    throw new ConfigError("Invalid config: $.project_sources.clone_root: may not lie inside data_dir");
  }
  for (const [i, o] of src.allowed_owners.entries()) {
    if (o === "." || o === "..") {
      throw new ConfigError(`Invalid config: $.project_sources.allowed_owners[${i}]: not a repository owner`);
    }
  }
  const owners = [...new Set(src.allowed_owners.map((o) => o.toLowerCase()))];
  return {
    cloneRoot,
    allowedHosts: [...(src.allowed_hosts ?? DEFAULT_PROJECT_SOURCE_HOSTS)],
    allowedOwners: owners,
  };
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
export function loadConfig(
  opts: ResolveEnv & {
    configPath?: string;
    confinedVerification?: boolean;
    /**
     * The test-only fake adapter is registered (`serve`'s fake switch, TDD §3.6): `model_groups` members and
     * `capacity.subscriptions.<s>.providers[]` may then also name `fake`. Default false: no config file can name it.
     */
    testFakeAdapter?: boolean;
  } = {},
): ResolvedConfig {
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
  const testFakeAdapter = opts.testFakeAdapter === true;
  const cfg = validateConfig(parsed, `config file ${configPath}`, { testFakeAdapter });
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
    // T14.8 (Delegated, fail closed): approval targets mean nothing without approval_proxy.
    if (c.approval_proxy_targets !== undefined && c.approval_proxy !== true) {
      throw new ConfigError(
        `Invalid config: $.mcp_clients[${i}].approval_proxy_targets: applies only to a client with approval_proxy: ` +
          `true (client ${JSON.stringify(c.id)}); remove it or set approval_proxy`,
      );
    }
    // ADR-0068 (Delegated, fail closed): approval kinds mean nothing without approval_proxy.
    if (c.approval_proxy_kinds !== undefined && c.approval_proxy !== true) {
      throw new ConfigError(
        `Invalid config: $.mcp_clients[${i}].approval_proxy_kinds: applies only to a client with approval_proxy: ` +
          `true (client ${JSON.stringify(c.id)}); remove it or set approval_proxy`,
      );
    }
    // T14.11 (Delegated, fail closed): the console set has no project-admin tools, so manage_projects there would be a
    // silent no-op.
    if (c.tool_profile === "console" && c.manage_projects === true) {
      throw new ConfigError(
        `Invalid config: $.mcp_clients[${i}].tool_profile: console offers no project-admin tools (client ` +
          `${JSON.stringify(c.id)} sets manage_projects: true); remove manage_projects or use orchestrator`,
      );
    }
  }
  // T14.8 (NFR-SEC-06): an approval target must be a configured client; an unknown id aborts startup.
  for (const [i, c] of cfg.mcp_clients.entries()) {
    for (const [j, id] of (c.approval_proxy_targets ?? []).entries()) {
      if (!ids.has(id)) {
        throw new ConfigError(
          `Invalid config: $.mcp_clients[${i}].approval_proxy_targets[${j}]: unknown client id ${JSON.stringify(id)} ` +
            `(client ${JSON.stringify(c.id)}); add it to mcp_clients or remove it`,
        );
      }
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

  const secretScanAllow = (cfg.git?.secret_scan?.allow ?? []).map((e) => ({ rule_id: e.rule_id, path: e.path }));
  try {
    compileSecretScanAllow(secretScanAllow);
  } catch (err) {
    if (err instanceof SecretScanAllowError)
      throw new ConfigError(`Invalid config:\n  $.git.secret_scan.allow${err.message}`);
    throw err;
  }

  const projectErrors = checkProjects(cfg);
  if (projectErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${projectErrors.map((l) => `  ${l}`).join("\n")}`);
  }

  // T5.14 (FR-SES-07, LLD §20.13): each brief file is read once here; any problem aborts startup (fail closed).
  const briefFiles = new Map<string, string>();
  const briefErrors: string[] = [];
  const maxContextTokens = resolveRag(cfg.rag).retrieval.maxContextTokens;
  for (const [i, p] of (cfg.projects ?? []).entries()) {
    if (p.brief_file === undefined) continue;
    const at = `$.projects[${i}].brief_file`;
    const file = path.resolve(baseDir, p.brief_file);
    try {
      const brief = readBriefFile(file, [...allowedRoots, ...p.contexts.map((c) => path.resolve(baseDir, c.path))]);
      const tokens = briefBlockTokens(p.id, brief);
      if (tokens > maxContextTokens) {
        briefErrors.push(
          `${at}: its block needs about ${tokens} tokens; rag.retrieval.max_context_tokens is ${maxContextTokens}`,
        );
      }
      briefFiles.set(p.id, realpathSync(file));
    } catch (err) {
      if (!(err instanceof BriefError)) throw err;
      briefErrors.push(`${at}: ${err.message}`);
    }
  }
  if (briefErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${briefErrors.map((l) => `  ${l}`).join("\n")}`);
  }

  const innerErrors = checkInnerAgent(cfg.inner_agent, configProviderIds());
  if (innerErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${innerErrors.map((l) => `  ${l}`).join("\n")}`);
  }

  const ragErrors = checkRag(cfg.rag, cfg.projects ?? [], allowedRoots);
  if (ragErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${ragErrors.map((l) => `  ${l}`).join("\n")}`);
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

  const routingErrors = checkRouting(cfg.routing);
  if (routingErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${routingErrors.map((l) => `  ${l}`).join("\n")}`);
  }
  const capacityErrors = checkCapacity(cfg.capacity, memberProviderIds(testFakeAdapter));
  if (capacityErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${capacityErrors.map((l) => `  ${l}`).join("\n")}`);
  }
  // T8.15 (FR-TEL-06, LLD §20.13, ADR-0062): per-run loopback OTLP metrics receiver, off unless explicitly on.
  const otlpEndpoint = cfg.telemetry?.otlp_endpoint === "" ? undefined : cfg.telemetry?.otlp_endpoint;
  const providerOtlp = cfg.telemetry?.provider_otlp === true;
  const telemetry =
    otlpEndpoint !== undefined || providerOtlp
      ? { ...(otlpEndpoint ? { otlpEndpoint } : {}), ...(providerOtlp ? { providerOtlp } : {}) }
      : undefined;
  if (otlpEndpoint) {
    let valid = false;
    try {
      const url = new URL(otlpEndpoint);
      valid = ["http:", "https:"].includes(url.protocol) && url.hostname !== "" && otlpEndpoint === otlpEndpoint.trim();
    } catch {
      // Never include the endpoint (it may contain credentials) in a config error.
    }
    if (!valid) throw new ConfigError("$.telemetry.otlp_endpoint: must be an absolute http or https URL");
  }
  const ciErrors = checkCiTrigger(
    cfg.ci_trigger,
    new Map(cfg.mcp_clients.map((c) => [c.id, c])),
    new Set((cfg.projects ?? []).map((p) => p.id)),
  );
  if (ciErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${ciErrors.map((l) => `  ${l}`).join("\n")}`);
  }
  const controlPlaneErrors = checkControlPlane(cfg.control_plane);
  if (controlPlaneErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${controlPlaneErrors.map((l) => `  ${l}`).join("\n")}`);
  }
  // T3.24 (FR-CAP-12): hysteresis needs a resume value strictly below the maximum; anything else is refused (fail closed).
  if (cfg.host !== undefined && !(cfg.host.resume_load1 < cfg.host.max_load1)) {
    throw new ConfigError(
      `Invalid config: $.host.resume_load1: must be lower than $.host.max_load1 (got ${cfg.host.resume_load1} and ` +
        `${cfg.host.max_load1})`,
    );
  }
  const sinkErrors = checkNotificationSinks(cfg.notification_sinks);
  if (sinkErrors.length > 0) {
    throw new ConfigError(`Invalid config:\n${sinkErrors.map((l) => `  ${l}`).join("\n")}`);
  }

  const projectSources = resolveProjectSources(cfg.project_sources, allowedRoots, dataDir, baseDir);

  return {
    configPath,
    dataDir,
    ...(httpTransport !== undefined ? { httpTransport } : {}),
    ...(projectSources !== undefined ? { projectSources } : {}),
    projects: resolveProjects(cfg, briefFiles),
    sanitizePatterns: [...(cfg.git?.sanitize_patterns ?? [])],
    secretScanAllow,
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
          approvalProxy: c.approval_proxy === true,
          ...(c.approval_proxy === true
            ? {
                approvalProxyTargets: [...(c.approval_proxy_targets ?? [c.id])],
                approvalProxyKinds: [...(c.approval_proxy_kinds ?? APPROVAL_PROXY_KINDS)],
              }
            : {}),
          toolProfile: c.tool_profile ?? DEFAULT_TOOL_PROFILE,
          ...(c.skills !== undefined ? { skills: [...c.skills] } : {}),
          ...(c.allow_light === true ? { allowLight: true } : {}),
        },
      ]),
    ),
    limits: {
      globalConcurrency: cfg.limits?.global_concurrency ?? DEFAULT_GLOBAL_CONCURRENCY,
      perProviderConcurrency: cfg.limits?.per_provider_concurrency ?? DEFAULT_PER_PROVIDER_CONCURRENCY,
      ...(cfg.limits?.min_free_disk_mb !== undefined ? { minFreeDiskMb: cfg.limits.min_free_disk_mb } : {}),
      ...(cfg.limits?.seed_store_mb !== undefined ? { seedStoreMb: cfg.limits.seed_store_mb } : {}),
      ...(cfg.limits?.seed_entries_per_seed !== undefined
        ? { seedEntriesPerSeed: cfg.limits.seed_entries_per_seed }
        : {}),
    },
    ...resolveVerificationLimits(cfg.limits),
    ...(cfg.host !== undefined
      ? { hostLoad: { maxLoad1: cfg.host.max_load1, resumeLoad1: cfg.host.resume_load1 } }
      : {}),
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
    rag: resolveRag(cfg.rag),
    routing: resolveRouting(cfg.routing),
    modelGroups: resolveModelGroups(cfg.model_groups),
    controlPlane: resolveControlPlane(cfg.control_plane),
    notificationSinks: resolveNotificationSinks(cfg.notification_sinks),
    ciTrigger: resolveCiTrigger(cfg.ci_trigger),
    ...(telemetry ? { telemetry } : {}),
    claudeCodeGitChannel: cfg.providers?.["claude-code"]?.git_channel === true,
    profileOverrides,
    outerSandboxRequiredProfiles: [...(cfg.outer_sandbox?.required_profiles ?? [])],
    confinedVerification:
      opts.confinedVerification ??
      (opts.env?.SWITCHBOARD_CONFINED_VERIFICATION === "true" ||
        opts.env?.SWITCHBOARD_CONFINED_VERIFICATION === "1" ||
        process.env.SWITCHBOARD_CONFINED_VERIFICATION === "true" ||
        process.env.SWITCHBOARD_CONFINED_VERIFICATION === "1"),
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
    skills: resolveSkills(cfg),
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
