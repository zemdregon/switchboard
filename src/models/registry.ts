/**
 * Model registry (FR-ADP-05, T4.5, LLD §2.1). Model identities, aliases and context limits come from operator
 * configuration (`providers.<id>.models`) and from the provider's own listing (`ProbeResult.modelsListed`), refreshed in
 * memory on every probe. Nothing here, and nothing in adapter source, names a model. No persistence: a restart rebuilds
 * the registry from the file and the next probe (no ledger table, so no ADR).
 *
 * Delegated default (backward compatible): a provider with no configured ids, no alias and no listing is
 * *unrestricted*, so a requested model passes through unchanged and the adapter's own `compile` decides.
 */

/** Assumption (LLD §2.1): plain-identifier shape; also keeps option-like values out of argv. */
export const MODEL_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$";
const MODEL_ID_RE = new RegExp(MODEL_ID_PATTERN);
/** Cap on the part of a request echoed in a reason. */
const ECHO_MAX = 80;

export type ModelCapability = "low" | "medium" | "high";
export const CAPABILITY_ORDER: readonly ModelCapability[] = ["low", "medium", "high"];

export function capabilityMeetsFloor(declared: ModelCapability | undefined, floor: ModelCapability): boolean {
  if (declared === undefined) return false;
  const declRank = CAPABILITY_ORDER.indexOf(declared);
  const floorRank = CAPABILITY_ORDER.indexOf(floor);
  return declRank >= 0 && floorRank >= 0 && declRank >= floorRank;
}

/** One provider's `providers.<id>.models` block, as validated by the config schema. */
export interface ModelConfig {
  readonly ids?: readonly string[];
  readonly aliases?: Readonly<Record<string, string>>;
  readonly context_limits?: Readonly<Record<string, number>>;
  readonly capabilities?: Readonly<Record<string, ModelCapability>>;
}

export type ModelResolution =
  | { readonly ok: true; readonly model: string; readonly source: "unrestricted" | "config" | "alias" | "listing" }
  | { readonly ok: false; readonly detail: string };

export class ModelRegistry {
  readonly #config = new Map<string, ModelConfig>();
  readonly #listing = new Map<string, ReadonlySet<string>>();

  /** `config` is keyed by adapter id (the caller maps config provider ids). */
  constructor(config: ReadonlyMap<string, ModelConfig> = new Map()) {
    for (const [id, c] of config) this.#config.set(id, c);
  }

  /**
   * Refresh rule (LLD §2.1): `undefined` keeps the previous listing; an array replaces it (empty clears it). Entries
   * that are not plain identifiers are dropped.
   */
  refresh(provider: string, listed: readonly string[] | undefined): void {
    if (listed === undefined) return;
    this.#listing.set(provider, new Set(listed.filter((m) => MODEL_ID_RE.test(m))));
  }

  /** Every id the registry holds for a provider: configured ids, alias targets and the current listing. */
  known(provider: string): string[] {
    const c = this.#config.get(provider);
    return [
      ...new Set([
        ...(c?.ids ?? []),
        ...Object.values(c?.aliases ?? {}),
        ...Object.keys(c?.capabilities ?? {}),
        ...(this.#listing.get(provider) ?? []),
      ]),
    ];
  }

  /** True when the provider has registry data, so an unknown model is refused. */
  restricted(provider: string): boolean {
    return this.known(provider).length > 0;
  }

  resolve(provider: string, requested: string): ModelResolution {
    if (!this.restricted(provider)) return { ok: true, model: requested, source: "unrestricted" };
    const c = this.#config.get(provider);
    const aliased = c?.aliases !== undefined && Object.hasOwn(c.aliases, requested) ? c.aliases[requested] : undefined;
    if (aliased !== undefined) return { ok: true, model: aliased, source: "alias" };
    if (c?.ids?.includes(requested)) return { ok: true, model: requested, source: "config" };
    if (c?.capabilities !== undefined && Object.hasOwn(c.capabilities, requested)) {
      return { ok: true, model: requested, source: "config" };
    }
    if (this.#listing.get(provider)?.has(requested)) return { ok: true, model: requested, source: "listing" };
    const echo = requested.length > ECHO_MAX ? `${requested.slice(0, ECHO_MAX)}...` : requested;
    const listed = this.#listing.get(provider)?.size ?? 0;
    return {
      ok: false,
      detail:
        `model ${JSON.stringify(echo)} is not in the ${provider} model registry ` +
        `(${c?.ids?.length ?? 0} configured ids, ${Object.keys(c?.aliases ?? {}).length} aliases, ${listed} listed)`,
    };
  }

  /** Operator-stated context limit in tokens, or undefined. Switchboard supplies no default (FR-ADP-05). */
  contextLimit(provider: string, model: string): number | undefined {
    const limits = this.#config.get(provider)?.context_limits;
    return limits !== undefined && Object.hasOwn(limits, model) ? limits[model] : undefined;
  }

  /** Operator-stated capability tier, or undefined (FR-RTE-01, T7.8). Switchboard supplies no default. */
  capability(provider: string, model: string): ModelCapability | undefined {
    const c = this.#config.get(provider);
    if (!c?.capabilities) return undefined;
    if (Object.hasOwn(c.capabilities, model)) return c.capabilities[model];
    const target = c.aliases !== undefined && Object.hasOwn(c.aliases, model) ? c.aliases[model] : undefined;
    if (target !== undefined && Object.hasOwn(c.capabilities, target)) {
      return c.capabilities[target];
    }
    if (c.aliases !== undefined) {
      for (const [alias, tgt] of Object.entries(c.aliases)) {
        if (tgt === model && Object.hasOwn(c.capabilities, alias)) {
          return c.capabilities[alias];
        }
      }
    }
    return undefined;
  }

  /**
   * Models declared for the provider whose operator-declared capability meets or exceeds the floor (T7.8).
   * Evaluated in configured ids order, then any other models with declared capability.
   */
  modelsMeetingCapability(provider: string, floor: ModelCapability): string[] {
    const c = this.#config.get(provider);
    if (!c?.capabilities) return [];
    const result: string[] = [];
    const seen = new Set<string>();

    const checkAndAdd = (rawId: string) => {
      const resolved = this.resolve(provider, rawId);
      const m = resolved.ok ? resolved.model : rawId;
      if (!seen.has(m) && capabilityMeetsFloor(this.capability(provider, m), floor)) {
        seen.add(m);
        result.push(m);
      }
    };

    for (const id of c.ids ?? []) {
      checkAndAdd(id);
    }
    for (const id of Object.keys(c.capabilities)) {
      checkAndAdd(id);
    }
    return result;
  }
}
