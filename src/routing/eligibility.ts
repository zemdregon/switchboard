/**
 * Stage-1 routing: the hard eligibility filter (FR-RTE-01, ADR-0008, FRD BR-1..BR-5). Pure and deterministic: it takes
 * facts and returns a decision; it never performs I/O. `collect.ts` gathers the facts.
 *
 * M2 scope (ROADMAP T2.3): enablement, client trust ceiling, platform, binary/probe, compliance manifest and version
 * gate, auth state, and adapter-compiled profile/capability support. Quota, concurrency, circuit-open and scoring are
 * M6/M7 and are not modelled here (BR-3 maps them to QUOTA_EXHAUSTED / ELIGIBILITY_NONE when they arrive).
 *
 * T3.7 (profile-aware eligibility): per-profile support is the adapter's own `compile` verdict for the requested
 * profile (the resolved snapshot, overrides included; see `compileCheck` in `collect.ts`), plus a host-platform rule
 * for sandbox-dependent profiles (`PROFILE_PLATFORM_UNVERIFIED`, Proposed). `list_capabilities` reports the same
 * verdicts per profile as `supported_profiles`.
 *
 * Reason vocabulary follows FRD BR-3, not the LLD `Ineligible.reason` enum: BR-3 lists "no manifest" separately from
 * `ADAPTER_VERSION_UNVERIFIED`, while `registry.gate` returns `ADAPTER_VERSION_UNVERIFIED` for both. Proposed: the
 * filter distinguishes the two using the gate evidence (`validatedRange === null` means no valid manifest).
 */
import type { FailureCode } from "../adapters/failure.js";
import type { VersionGateResult } from "../adapters/manifest/index.js";
import type { AuthResult, Ineligible, ProviderId, TrustProfile } from "../adapters/types.js";

/** Ascending privilege order (SRS FR-POL-01 table order; matches `TRUST_PROFILES` in config). */
export const TRUST_PROFILE_ORDER: readonly TrustProfile[] = [
  "inspect-untrusted",
  "edit-untrusted",
  "test-sandboxed",
  "trusted-development",
  "privileged",
];

export type EligibilityReasonCode =
  /** Request-level: the caller asked for more than its client may use (LLD §3 mapping: PERMISSION_BLOCKED). */
  | "CLIENT_TRUST_CEILING_EXCEEDED"
  | "PROVIDER_DISABLED"
  | "ADAPTER_NOT_REGISTERED"
  | "PLATFORM_UNSUPPORTED"
  | "BINARY_MISSING"
  | "PROBE_FAILED"
  | "NO_MANIFEST"
  | "ADAPTER_VERSION_UNVERIFIED"
  | "AUTH_REQUIRED"
  | "AUTH_UNKNOWN"
  | "PROFILE_UNSUPPORTED"
  | "CAPABILITY_MISSING"
  /**
   * T3.7 (Proposed): the requested profile depends on a sandbox whose behaviour on this host platform is unverified
   * (see {@link profilePlatformSupported}). Per-profile, like the compile reasons; maps to ELIGIBILITY_NONE (BR-3).
   */
  | "PROFILE_PLATFORM_UNVERIFIED";

export interface EligibilityReason {
  code: EligibilityReasonCode;
  detail: string;
  /** Machine-readable facts the reason was derived from. JSON-serialisable; never contains credentials. */
  evidence: Record<string, unknown>;
}

/** FRD BR-3 mapping from eligibility reason to the failure taxonomy code for `require_provider`. */
export function failureCodeForReason(code: EligibilityReasonCode): FailureCode {
  switch (code) {
    case "AUTH_REQUIRED":
      return "AUTH_REQUIRED";
    case "ADAPTER_VERSION_UNVERIFIED":
      return "ADAPTER_VERSION_UNVERIFIED";
    case "CLIENT_TRUST_CEILING_EXCEEDED":
      return "PERMISSION_BLOCKED";
    default:
      return "ELIGIBILITY_NONE";
  }
}

/**
 * LLD §2 "Ineligible to failure code" (FRD BR-3): the taxonomy code for an adapter `Ineligible` reason. Used where an
 * adapter refuses outside the filter, e.g. a race-time compile at dispatch (T3.7).
 */
export function failureCodeForIneligible(reason: Ineligible["reason"]): FailureCode {
  return failureCodeForReason(reasonCodeForIneligible(reason));
}

/** Adapter `Ineligible.reason` to the filter's BR-3 vocabulary (one-to-one except VERSION_UNVERIFIED). */
export function reasonCodeForIneligible(reason: Ineligible["reason"]): EligibilityReasonCode {
  switch (reason) {
    case "CAPABILITY_MISSING":
      return "CAPABILITY_MISSING";
    case "VERSION_UNVERIFIED":
      return "ADAPTER_VERSION_UNVERIFIED";
    case "NO_MANIFEST":
      return "NO_MANIFEST";
    case "AUTH_REQUIRED":
      return "AUTH_REQUIRED";
    default:
      return "PROFILE_UNSUPPORTED";
  }
}

/**
 * T3.7, Proposed (Delegated): host platforms on which the per-profile compile matrices were evaluated. TDD §4.1.1 and
 * §4.2.1 evaluate Linux cells only; macOS is "not supported yet" (NFR-PORT-02, M4) and Windows is Deferred
 * (NFR-PORT-03).
 */
export const VERIFIED_PROFILE_PLATFORMS: readonly string[] = ["linux"];

/**
 * T3.7, Proposed (Delegated, fail closed): profiles whose confinement rests on a sandbox or on native controls whose
 * behaviour was evaluated on Linux only. Every profile is listed: the untrusted profiles and `test-sandboxed` rely on
 * FR-POL-06 confinement (Q-16) and Codex's native sandbox (owner decision 10); Codex compiles `trusted-development`
 * to `--sandbox workspace-write`; a `privileged` scope's file dimension maps to the same controls. M4 narrows this
 * set per verified cell when the macOS leg runs.
 */
export const SANDBOX_DEPENDENT_PROFILES: readonly TrustProfile[] = [
  "inspect-untrusted",
  "edit-untrusted",
  "test-sandboxed",
  "trusted-development",
  "privileged",
];

/** True when `profile` may be compiled on `platform` at all (before asking the adapter). Pure. */
export function profilePlatformSupported(profile: TrustProfile, platform: string): boolean {
  return !SANDBOX_DEPENDENT_PROFILES.includes(profile) || VERIFIED_PROFILE_PLATFORMS.includes(platform);
}

export interface ProbeFact {
  /** Every probe step with its outcome; a failed `binary` step means the executable is missing. */
  steps: ReadonlyArray<{ step: string; ok: boolean; detail?: string }>;
  binaryVersion: string | null;
}

export interface ProviderFacts {
  provider: ProviderId;
  registered: boolean;
  enabled: boolean;
  /** Platforms the adapter supports; undefined means the adapter declares no platform restriction. */
  supportedPlatforms?: readonly string[];
  /** Undefined when probing was not performed. */
  probe?: ProbeFact;
  /** Result of `registry.gate`; undefined when not evaluated. */
  gate?: VersionGateResult;
  /** Undefined when auth was not checked. Absent while the gate passes is treated as unknown (fail closed). */
  auth?: AuthResult;
  /** Result of `adapter.compile` for the request's profile and requirements; undefined when not evaluated. */
  compile?: { ok: true } | Ineligible;
}

export interface CapabilityRequirements {
  model?: string;
  shellAllowlist?: readonly string[];
  network: "off" | "allowlist" | "policy" | "scoped";
  writable: boolean;
}

export interface EligibilityInput {
  /** Candidate providers in configured order (tie-break order, BR-4). */
  candidates: readonly ProviderId[];
  /** `require_provider` target (BR-2). When set it is the only candidate; nothing is ever substituted. */
  requiredProvider?: ProviderId;
  trustProfile: TrustProfile;
  /** The calling MCP client's `max_trust_profile`. */
  clientMaxProfile: TrustProfile;
  requirements: CapabilityRequirements;
  platform: string;
  facts: readonly ProviderFacts[];
}

export interface ExcludedProvider {
  provider: ProviderId;
  /** First failing constraint, in check order. */
  primary: EligibilityReason;
  reasons: EligibilityReason[];
  /** BR-3 code for the primary reason. */
  failureCode: FailureCode;
}

export type EligibilityOutcome =
  | { kind: "eligible"; providers: ProviderId[] }
  | { kind: "client_ceiling_exceeded"; failureCode: "PERMISSION_BLOCKED"; message: string }
  /** BR-2: error carries the required provider's own reason; no run starts on another provider. */
  | { kind: "required_provider_ineligible"; provider: ProviderId; failureCode: FailureCode; message: string }
  | { kind: "none_eligible"; failureCode: "ELIGIBILITY_NONE"; message: string };

export interface EligibilityDecision {
  /** Ordered list of eligible providers (empty when the outcome is not `eligible`). */
  eligible: ProviderId[];
  excluded: ExcludedProvider[];
  requestReason?: EligibilityReason;
  outcome: EligibilityOutcome;
}

export function profileRank(p: TrustProfile): number {
  return TRUST_PROFILE_ORDER.indexOf(p);
}

function checkProvider(f: ProviderFacts, input: EligibilityInput): EligibilityReason[] {
  const r = (
    code: EligibilityReasonCode,
    detail: string,
    evidence: Record<string, unknown> = {},
  ): EligibilityReason => ({
    code,
    detail,
    evidence: { provider: f.provider, ...evidence },
  });
  if (!f.registered) return [r("ADAPTER_NOT_REGISTERED", `no adapter registered for ${f.provider}`)];
  if (!f.enabled) return [r("PROVIDER_DISABLED", `${f.provider} is disabled in config`)];
  if (f.supportedPlatforms !== undefined && !f.supportedPlatforms.includes(input.platform)) {
    return [
      r("PLATFORM_UNSUPPORTED", `${f.provider} does not support platform ${input.platform}`, {
        platform: input.platform,
        supportedPlatforms: [...f.supportedPlatforms],
      }),
    ];
  }

  // Binary and probe: without a usable binary nothing further can be asserted.
  if (f.probe === undefined) return [r("PROBE_FAILED", `${f.provider} was not probed`)];
  const failed = f.probe.steps.filter((s) => !s.ok);
  const binaryStep = f.probe.steps.find((s) => s.step === "binary");
  if (binaryStep === undefined || !binaryStep.ok) {
    return [
      r("BINARY_MISSING", `${f.provider} binary not found or not runnable`, { detail: binaryStep?.detail ?? null }),
    ];
  }
  if (failed.length > 0) {
    return [
      r("PROBE_FAILED", `${f.provider} preflight step ${failed[0]?.step} failed`, {
        failedSteps: failed.map((s) => s.step),
      }),
    ];
  }

  const reasons: EligibilityReason[] = [];

  // Compliance manifest and version gate (FR-ADP-03, FR-POL-07).
  let gatePassed = false;
  if (f.gate === undefined) {
    reasons.push(r("ADAPTER_VERSION_UNVERIFIED", "version gate was not evaluated (fail closed)"));
  } else if (!f.gate.eligible) {
    const noManifest = f.gate.evidence.validatedRange === null;
    reasons.push(
      r(noManifest ? "NO_MANIFEST" : "ADAPTER_VERSION_UNVERIFIED", f.gate.detail, {
        observedVersion: f.gate.evidence.observedVersion,
        validatedRange: f.gate.evidence.validatedRange,
        validatedCliVersion: f.gate.evidence.validatedCliVersion,
      }),
    );
  } else {
    gatePassed = true;
  }

  // Auth (FR-AUTH-02, NFR-SEC-06): only meaningful once the binary is validated; UNKNOWN is ineligible.
  if (gatePassed) {
    if (f.auth === undefined) {
      reasons.push(r("AUTH_UNKNOWN", "auth state not checked (fail closed)"));
    } else if (f.auth.state === "AUTH_REQUIRED") {
      reasons.push(r("AUTH_REQUIRED", `${f.provider} is not logged in`, { loginCommand: f.auth.loginCommand }));
    } else if (f.auth.state === "UNKNOWN") {
      reasons.push(r("AUTH_UNKNOWN", `${f.provider} auth state unknown: ${f.auth.reason}`, { reason: f.auth.reason }));
    }
  }

  // Host platform for the requested profile (T3.7, Proposed): sandbox-dependent profiles only where verified.
  if (!profilePlatformSupported(input.trustProfile, input.platform)) {
    reasons.push(
      r(
        "PROFILE_PLATFORM_UNVERIFIED",
        `${input.trustProfile} on ${input.platform}: the ${f.provider} compile matrix is verified on ` +
          `${VERIFIED_PROFILE_PLATFORMS.join(", ")} only (NFR-PORT-02, M4)`,
        {
          platform: input.platform,
          trustProfile: input.trustProfile,
          verifiedPlatforms: [...VERIFIED_PROFILE_PLATFORMS],
        },
      ),
    );
  }

  // Profile and capability support, as decided by the adapter's pure compile (BR-5: never downgraded).
  if (f.compile === undefined) {
    reasons.push(r("PROFILE_UNSUPPORTED", "adapter compile was not evaluated (fail closed)"));
  } else if ("ineligible" in f.compile) {
    const c = f.compile;
    const evidence = {
      adapterReason: c.reason,
      trustProfile: input.trustProfile,
      requirements: {
        model: input.requirements.model ?? null,
        shellAllowlist: input.requirements.shellAllowlist ? [...input.requirements.shellAllowlist] : null,
        network: input.requirements.network,
        writable: input.requirements.writable,
      },
    };
    // Adapter-side VERSION_UNVERIFIED / NO_MANIFEST / AUTH_REQUIRED keep their meaning; the rest map one-to-one.
    reasons.push(r(reasonCodeForIneligible(c.reason), c.detail, evidence));
  }
  return reasons;
}

export function filterEligible(input: EligibilityInput): EligibilityDecision {
  // BR-2: a required provider is the only candidate; the candidate list is ignored (no silent substitution).
  const candidates = input.requiredProvider !== undefined ? [input.requiredProvider] : dedupe(input.candidates);
  const byId = new Map(input.facts.map((f) => [f.provider, f] as const));

  // Request-level hard constraint: caller above its client's ceiling (LLD §3: PERMISSION_BLOCKED). Rank -1 (unknown
  // profile) on either side fails closed.
  const reqRank = profileRank(input.trustProfile);
  const maxRank = profileRank(input.clientMaxProfile);
  if (reqRank < 0 || maxRank < 0 || reqRank > maxRank) {
    const detail = `trust profile ${input.trustProfile} exceeds the client maximum ${input.clientMaxProfile}`;
    const evidence = { requested: input.trustProfile, clientMax: input.clientMaxProfile };
    const reason: EligibilityReason = { code: "CLIENT_TRUST_CEILING_EXCEEDED", detail, evidence };
    return {
      eligible: [],
      excluded: candidates.map((provider) => ({
        provider,
        primary: reason,
        reasons: [reason],
        failureCode: "PERMISSION_BLOCKED",
      })),
      requestReason: reason,
      outcome: { kind: "client_ceiling_exceeded", failureCode: "PERMISSION_BLOCKED", message: detail },
    };
  }

  const eligible: ProviderId[] = [];
  const excluded: ExcludedProvider[] = [];
  for (const provider of candidates) {
    const facts = byId.get(provider) ?? { provider, registered: false, enabled: false };
    const reasons = checkProvider(facts, input);
    const primary = reasons[0];
    if (primary === undefined) eligible.push(provider);
    else excluded.push({ provider, primary, reasons, failureCode: failureCodeForReason(primary.code) });
  }

  if (input.requiredProvider !== undefined) {
    const ex = excluded[0];
    if (ex !== undefined) {
      return {
        eligible,
        excluded,
        outcome: {
          kind: "required_provider_ineligible",
          provider: ex.provider,
          failureCode: ex.failureCode,
          message: `required provider ${ex.provider} is ineligible: ${ex.primary.code}: ${ex.primary.detail}`,
        },
      };
    }
  } else if (eligible.length === 0) {
    const why = excluded.map((e) => `${e.provider}: ${e.primary.code}`).join("; ");
    return {
      eligible,
      excluded,
      outcome: {
        kind: "none_eligible",
        failureCode: "ELIGIBILITY_NONE",
        message: `no provider is eligible${why ? ` (${why})` : ""}`,
      },
    };
  }
  return { eligible, excluded, outcome: { kind: "eligible", providers: [...eligible] } };
}

function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Proposed: serialisation for the append-only `route_decision` row (LLD §1: "M2 writes eligibility only"). The table
 * requires a `run_id` FK, so the caller (T2.4, after creating the run) inserts it; this filter stays pure.
 */
export function toRouteDecisionJson(input: EligibilityInput, decision: EligibilityDecision) {
  return {
    features_json: JSON.stringify({
      trust_profile: input.trustProfile,
      client_max_profile: input.clientMaxProfile,
      platform: input.platform,
      required_provider: input.requiredProvider ?? null,
      requirements: input.requirements,
    }),
    candidates_json: JSON.stringify([
      ...decision.eligible.map((provider) => ({ provider, eligible: true, reasons: [], score: null })),
      ...decision.excluded.map((e) => ({ provider: e.provider, eligible: false, reasons: e.reasons, score: null })),
    ]),
    selected_provider: null as string | null, // selection is stage 2 (M7) or the caller's tie-break (BR-4)
    reasons_json: JSON.stringify({ outcome: decision.outcome, request_reason: decision.requestReason ?? null }),
  };
}
