/** Version gate (ADR-0009, FR-ADP-03, FR-POL-07). Pure; the registry and `doctor` call it with a probed version. */
import type { FailureCode } from "../failure.js";
import type { ComplianceManifest } from "./schema.js";
import { parseVersion, satisfies } from "./semver.js";

export interface VersionEvidence {
  /** Raw probed version string (`ProbeResult.binaryVersion`), null when the probe produced none. */
  observedVersion: string | null;
  validatedRange: string | null;
  validatedCliVersion: string | null;
  provider: string;
}

export type VersionGateResult =
  | { eligible: true; evidence: VersionEvidence }
  | {
      eligible: false;
      code: Extract<FailureCode, "ADAPTER_VERSION_UNVERIFIED">;
      detail: string;
      evidence: VersionEvidence;
    };

export function evaluateVersionGate(
  provider: string,
  manifest: ComplianceManifest | undefined,
  observedVersion: string | null,
): VersionGateResult {
  const evidence: VersionEvidence = {
    observedVersion,
    validatedRange: manifest?.validated_version_range ?? null,
    validatedCliVersion: manifest?.validated_cli_version ?? null,
    provider,
  };
  const no = (detail: string): VersionGateResult => ({
    eligible: false,
    code: "ADAPTER_VERSION_UNVERIFIED",
    detail,
    evidence,
  });
  if (!manifest) return no(`no valid compliance manifest for ${provider}`);
  const v = parseVersion(observedVersion);
  if (!v) return no(`installed ${provider} version unknown or unparseable (observed: ${observedVersion ?? "none"})`);
  if (!satisfies(v, manifest.validated_version_range)) {
    return no(
      `installed ${provider} version ${observedVersion} is outside validated range ${manifest.validated_version_range}`,
    );
  }
  return { eligible: true, evidence };
}
