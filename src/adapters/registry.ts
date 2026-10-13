import { evaluateVersionGate, tryLoadManifest, type VersionGateResult } from "./manifest/index.js";
import type { ProviderAdapter, ProviderId } from "./types.js";

/** Adapter registry. Version gating (ADR-0009) is `gate`; enablement and eligibility routing arrive with T2.3. */
export class AdapterRegistry {
  readonly #adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    if (this.#adapters.has(adapter.id)) throw new Error(`adapter already registered: ${adapter.id}`);
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.#adapters.get(id);
  }

  has(id: ProviderId): boolean {
    return this.#adapters.has(id);
  }

  list(): ProviderAdapter[] {
    return [...this.#adapters.values()];
  }

  /**
   * Version gate (ADR-0009, FR-ADP-03, FR-POL-07): loads the provider's compliance manifest and checks the probed
   * binary version against `validated_version_range`. A missing or invalid manifest, an unknown or unparseable
   * version, or a version outside the range yields `ADAPTER_VERSION_UNVERIFIED` with the observed version as evidence.
   */
  gate(id: ProviderId, binaryVersion: string | null, manifestDir?: string): VersionGateResult {
    const { loaded, error } = tryLoadManifest(id, manifestDir);
    const result = evaluateVersionGate(id, loaded?.manifest, binaryVersion);
    return !result.eligible && error ? { ...result, detail: `${result.detail}: ${error.message}` } : result;
  }
}
