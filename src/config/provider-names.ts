/**
 * ADR-0076 (LLD §2 "Provider ids"): config files accept either spelling of a provider name, the canonical name (the
 * adapter id, `claude`) or its alias (the config id, `claude-code`), wherever they name a provider. The loaded config
 * keeps its existing spelling, the config id, so every config that loaded before loads unchanged and nothing after
 * this pass sees an alias. `validateConfig` runs this before the schema, on a copy of the parsed JSON.
 *
 * Places rewritten (each only when its shape is the documented one; anything else is left for the schema to refuse):
 * - `providers.<name>` keys. Two keys naming one provider (`providers.claude` and `providers.claude-code`) are a config
 *   error (Delegated, fail closed: which settings win would be a guess).
 * - `projects[].allowed_providers[]`, `capacity.subscriptions.<s>.providers[]`: rewritten and de-duplicated (first
 *   position kept), so `["claude", "claude-code"]` is `["claude-code"]`.
 * - `model_groups.<g>.members[].provider` and `inner_agent.backend.shares_subscription_with`: rewritten.
 *
 * A name with no config id (unknown, or the test-only `fake`) is left as written, so the schema and the later checks
 * report it exactly as before.
 */
import { configIdForProviderName } from "../adapters/providers.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Config spelling of `name` when it is a string naming a provider with a config id, else `name` unchanged. */
function toConfigId(name: unknown): unknown {
  return typeof name === "string" ? (configIdForProviderName(name) ?? name) : name;
}

/** Rewrites a list of names in place of a copy and drops later duplicates; a non-array is returned unchanged. */
function normaliseList(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  const out: unknown[] = [];
  for (const item of list) {
    const v = toConfigId(item);
    if (typeof v === "string" && out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

export interface ProviderNameNormalisation {
  /** The rewritten copy (the input itself is never changed). */
  readonly value: unknown;
  /** Config errors, `$.path: message`, one per refused duplicate. */
  readonly problems: readonly string[];
}

/** ADR-0076: rewrite every provider name in a parsed config to its config spelling (see the module comment). */
export function normaliseConfigProviderNames(parsed: unknown): ProviderNameNormalisation {
  if (!isRecord(parsed)) return { value: parsed, problems: [] };
  const cfg = structuredClone(parsed) as Record<string, unknown>;
  const problems: string[] = [];

  if (isRecord(cfg.providers)) {
    const out: Record<string, unknown> = {};
    const firstKey = new Map<string, string>();
    for (const [key, entry] of Object.entries(cfg.providers)) {
      const id = toConfigId(key) as string;
      const prior = firstKey.get(id);
      if (prior !== undefined) {
        problems.push(
          `$.providers.${key}: names the same provider as $.providers.${prior}; give its settings once (ADR-0076)`,
        );
        continue;
      }
      firstKey.set(id, key);
      out[id] = entry;
    }
    cfg.providers = out;
  }

  if (Array.isArray(cfg.projects)) {
    cfg.projects = cfg.projects.map((p) =>
      isRecord(p) && p.allowed_providers !== undefined
        ? { ...p, allowed_providers: normaliseList(p.allowed_providers) }
        : p,
    );
  }

  if (isRecord(cfg.model_groups)) {
    const groups: Record<string, unknown> = {};
    for (const [name, g] of Object.entries(cfg.model_groups)) {
      groups[name] =
        isRecord(g) && Array.isArray(g.members)
          ? {
              ...g,
              members: g.members.map((m) =>
                isRecord(m) && "provider" in m ? { ...m, provider: toConfigId(m.provider) } : m,
              ),
            }
          : g;
    }
    cfg.model_groups = groups;
  }

  if (isRecord(cfg.capacity) && isRecord(cfg.capacity.subscriptions)) {
    const subs: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(cfg.capacity.subscriptions)) {
      subs[name] = isRecord(s) && s.providers !== undefined ? { ...s, providers: normaliseList(s.providers) } : s;
    }
    cfg.capacity = { ...cfg.capacity, subscriptions: subs };
  }

  if (isRecord(cfg.inner_agent) && isRecord(cfg.inner_agent.backend)) {
    const b = cfg.inner_agent.backend;
    if (b.shares_subscription_with !== undefined) {
      cfg.inner_agent = {
        ...cfg.inner_agent,
        backend: { ...b, shares_subscription_with: toConfigId(b.shares_subscription_with) },
      };
    }
  }

  return { value: cfg, problems };
}
