/**
 * Thin async fact collector for the eligibility filter (T2.3). It reuses the adapters' own `probe`, `authPreflight`
 * and `compile` and the registry's `gate`; nothing here decides eligibility (that is `filterEligible`). Every
 * dependency is injectable for tests.
 *
 * Probing order mirrors lifecycle PREFLIGHT (WF-6): probe, then auth. Auth is only run when the provider is enabled,
 * the binary probed fully and the version gate passed, so an unvalidated binary is never asked anything beyond
 * `probe`. `compile` is pure and runs after a successful probe (adapters resolve their binary path in `probe`).
 */
import type { PreflightCache } from "../adapters/preflight-cache.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type {
  AuthResult,
  CompileRequest,
  Ineligible,
  ProbeRunner,
  ProviderAdapter,
  ProviderId,
  ResolvedProfile,
  TrustProfile,
} from "../adapters/types.js";
import type { ProviderId as ConfigProviderId, SwitchboardConfig } from "../config/index.js";
import {
  type CapabilityRequirements,
  type EligibilityDecision,
  type EligibilityInput,
  filterEligible,
  type ProviderFacts,
} from "./eligibility.js";

/**
 * Proposed: config provider ids (`claude-code`, `grok-build`, `kimi-code`) differ from adapter ids (`claude`, `grok`,
 * `kimi`). The docs do not define the mapping; this table is the single place it lives.
 */
export const CONFIG_TO_ADAPTER_ID: Readonly<Record<ConfigProviderId, ProviderId>> = {
  "claude-code": "claude",
  codex: "codex",
  "grok-build": "grok",
  antigravity: "antigravity",
  cursor: "cursor",
  opencode: "opencode",
  "kimi-code": "kimi",
};

/**
 * Proposed default: a provider is enabled unless config sets `providers.<id>.enabled` to false. Fail-closed gating
 * comes from the manifest/version gate, not from this default. Providers absent from the config map (e.g. `fake`)
 * follow the same default.
 */
export function isProviderEnabled(config: Pick<SwitchboardConfig, "providers"> | undefined, id: ProviderId): boolean {
  const entry = (Object.entries(CONFIG_TO_ADAPTER_ID) as [ConfigProviderId, ProviderId][]).find(([, a]) => a === id);
  if (!entry) return true;
  return config?.providers?.[entry[0]]?.enabled !== false;
}

export interface EligibilityRequest {
  /** Candidate providers in configured order. */
  candidates: readonly ProviderId[];
  requiredProvider?: ProviderId;
  trustProfile: TrustProfile;
  clientMaxProfile: TrustProfile;
  /** Resolved policy for `trustProfile` (COMP-POL snapshot). */
  profile: ResolvedProfile;
  requirements: CapabilityRequirements;
  /** Workspace cwd used only to build the pure compile request. */
  cwd: string;
}

export interface CollectDeps {
  registry: AdapterRegistry;
  runner: ProbeRunner;
  config?: Pick<SwitchboardConfig, "providers">;
  platform?: string;
  /** Override for tests or for providers without a manifest (e.g. `fake`). Defaults to `registry.gate`. */
  gate?: AdapterRegistry["gate"];
  manifestDir?: string;
  supportedPlatforms?: (id: ProviderId) => readonly string[] | undefined;
  isEnabled?: (id: ProviderId) => boolean;
  /** NFR-PERF-02: when set, `probe` and `authPreflight` go through this cache (successes only). */
  preflight?: PreflightCache;
}

export async function collectFacts(req: EligibilityRequest, deps: CollectDeps): Promise<EligibilityInput> {
  const platform = deps.platform ?? process.platform;
  const ids = req.requiredProvider !== undefined ? [req.requiredProvider] : [...new Set(req.candidates)];
  const facts = await Promise.all(ids.map((id) => collectOne(id, req, deps, platform)));
  return {
    candidates: req.candidates,
    ...(req.requiredProvider !== undefined ? { requiredProvider: req.requiredProvider } : {}),
    trustProfile: req.trustProfile,
    clientMaxProfile: req.clientMaxProfile,
    requirements: req.requirements,
    platform,
    facts,
  };
}

async function collectOne(
  id: ProviderId,
  req: EligibilityRequest,
  deps: CollectDeps,
  platform: string,
): Promise<ProviderFacts> {
  const adapter: ProviderAdapter | undefined = deps.registry.get(id);
  const enabled = deps.isEnabled ? deps.isEnabled(id) : isProviderEnabled(deps.config, id);
  const supportedPlatforms = deps.supportedPlatforms?.(id);
  const base: ProviderFacts = {
    provider: id,
    registered: adapter !== undefined,
    enabled,
    ...(supportedPlatforms !== undefined ? { supportedPlatforms } : {}),
  };
  // Do not execute anything for a provider that is already excluded by configuration or platform.
  if (!adapter || !enabled || (supportedPlatforms !== undefined && !supportedPlatforms.includes(platform))) return base;

  const probe = deps.preflight ? await deps.preflight.probe(adapter, deps.runner) : await adapter.probe(deps.runner);
  const facts: ProviderFacts = {
    ...base,
    probe: { steps: probe.steps, binaryVersion: probe.binaryVersion },
  };
  if (probe.steps.some((s) => !s.ok)) return facts;

  const gate = deps.gate
    ? deps.gate(id, probe.binaryVersion, deps.manifestDir)
    : deps.registry.gate(id, probe.binaryVersion, deps.manifestDir);
  facts.gate = gate;
  if (gate.eligible) {
    const auth: AuthResult = deps.preflight
      ? await deps.preflight.authPreflight(adapter, deps.runner)
      : await adapter.authPreflight(deps.runner);
    facts.auth = auth;
  }
  facts.compile = compileCheck(adapter, req.profile, req.requirements, req.cwd);
  return facts;
}

/**
 * The adapter's own pure `compile` verdict for one resolved profile (T3.7). The single place the eligibility filter
 * and `list_capabilities` (`supported_profiles`) ask an adapter whether it can compile a profile, so the two never
 * disagree. No I/O; the adapter's binary path comes from an earlier `probe`.
 */
export function compileCheck(
  adapter: ProviderAdapter,
  profile: ResolvedProfile,
  requirements: CapabilityRequirements,
  cwd: string,
): { ok: true } | Ineligible {
  const compileReq: CompileRequest = {
    runId: "route-check",
    objective: "eligibility check",
    constraints: [],
    workspace: { cwd, writable: requirements.writable },
    ...(requirements.model !== undefined ? { model: requirements.model } : {}),
  };
  const inv = adapter.compile(compileReq, profile);
  return "ineligible" in inv ? inv : { ok: true };
}

/**
 * Proposed (T3.7): the capability requirements for a profile with nothing beyond its resolved snapshot; the same
 * derivation `RunLifecycle.checkEligibility` uses (`writable` unless `inspect-untrusted`).
 */
export function requirementsFor(trustProfile: TrustProfile, profile: ResolvedProfile): CapabilityRequirements {
  return {
    network: profile.network,
    writable: trustProfile !== "inspect-untrusted",
    ...(profile.shellAllowlist ? { shellAllowlist: profile.shellAllowlist } : {}),
  };
}

/** Collect facts and run the filter. T2.4 calls this once per `delegate_task` before queueing. */
export async function evaluateEligibility(req: EligibilityRequest, deps: CollectDeps): Promise<EligibilityDecision> {
  return filterEligible(await collectFacts(req, deps));
}
