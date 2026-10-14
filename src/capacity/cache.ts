/**
 * FR-CAP-08 cache observations and switch counts (M6, T6.7; LLD §3.2 "Cache and switch accounting", §16.8, ADR-0032
 * item 8). Evidence for the operator, never a claim of cache hits. Pure: callers pass rows.
 *
 * Cache keys are mapped only where a source shows them AND an adapter stores them under that name
 * (docs/research/capacity-signals-2026-10-14.md). Today that is Grok Build: its parser copies the `usage` object of the
 * `end` event flat into `metrics_json` (`src/adapters/grok/adapter.ts`), and live check 4a
 * (docs/research/live-checks-2026-10-14-grok.md) observed `cache_read_input_tokens` and `cache_creation_input_tokens`
 * in `--output-format json`; that the `streaming-json` `end.usage` uses the same names is an Assumption. Every other
 * provider has no mapping (absent, never zero) until its adapter and a source exist: Cursor, Antigravity and OpenCode
 * report cache counts but have no adapter yet; Codex's key is in synthetic fixtures only; Claude Code's is unknown.
 */

export interface CacheKeyMap {
  readonly read?: string;
  readonly creation?: string;
  /** Where the key names come from. */
  readonly source: string;
}

export const CACHE_KEYS: Readonly<Record<string, CacheKeyMap>> = Object.freeze({
  grok: Object.freeze({
    read: "cache_read_input_tokens",
    creation: "cache_creation_input_tokens",
    source: "live-checks-2026-10-14-grok.md check 4a (json output; streaming end.usage names assumed identical)",
  }),
});

export interface CacheObservation {
  /** Sum of the reported read counts over rows that hold the key; null when no row did. */
  read: number | null;
  /** Sum of the reported creation counts; null when no row held the key (or the provider reports none). */
  creation: number | null;
  /** Rows that held at least one mapped key. */
  rows: number;
  source: "provider_reported";
  key_names: string[];
  key_source: string;
}

/** The `cache` block of one provider, or undefined when no sourced key exists or no row in the window holds one. */
export function cacheObservation(
  provider: string,
  usage: readonly { metrics: Readonly<Record<string, unknown>> }[],
): CacheObservation | undefined {
  const map = CACHE_KEYS[provider];
  if (map === undefined) return undefined;
  let read: number | null = null;
  let creation: number | null = null;
  let rows = 0;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  for (const row of usage) {
    const r = map.read === undefined ? undefined : num(row.metrics[map.read]);
    const c = map.creation === undefined ? undefined : num(row.metrics[map.creation]);
    if (r === undefined && c === undefined) continue;
    rows++;
    if (r !== undefined) read = (read ?? 0) + r;
    if (c !== undefined) creation = (creation ?? 0) + c;
  }
  if (rows === 0) return undefined;
  return {
    read,
    creation,
    rows,
    source: "provider_reported",
    key_names: [map.read, map.creation].filter((k): k is string => k !== undefined),
    key_source: map.source,
  };
}

/** One started run as the switch counter sees it, oldest first within a project. */
export interface SwitchRun {
  projectKey: string;
  provider: string;
  model: string | null;
  /** `route_decision.reasons_json.affinity.affinity_switch_reason` when M7 recorded one. */
  switchReason: string | null;
}

export interface ProjectSwitchCounts {
  project_key: string;
  runs: number;
  kept: number;
  switched: Record<string, number>;
}

/**
 * Per project, the runs after the first that kept the previous run's provider and model, and those that switched,
 * grouped by the recorded `affinity_switch_reason` (`unrecorded` until M7 writes one). Projects sorted by key.
 */
export function switchCounts(runs: readonly SwitchRun[]): ProjectSwitchCounts[] {
  const byProject = new Map<string, SwitchRun[]>();
  for (const r of runs) byProject.set(r.projectKey, [...(byProject.get(r.projectKey) ?? []), r]);
  return [...byProject.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([projectKey, list]) => {
      const switched: Record<string, number> = {};
      let kept = 0;
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1] as SwitchRun;
        const cur = list[i] as SwitchRun;
        if (prev.provider === cur.provider && prev.model === cur.model) kept++;
        else {
          const reason = cur.switchReason ?? "unrecorded";
          switched[reason] = (switched[reason] ?? 0) + 1;
        }
      }
      return { project_key: projectKey, runs: list.length, kept, switched };
    });
}
