import type { ProviderAdapter, ProviderId } from "./types.js";

/** Adapter registry skeleton. Version gating and enablement (ADR-0009) arrive with M2. */
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
}
