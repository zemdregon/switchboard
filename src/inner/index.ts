/**
 * Inner-agent service (COMP-INN; T11.1; FR-INN-01, FR-INN-05, FR-INN-06, ADR-0016). This task delivers only the shell: the
 * disabled-by-default path and the port. The call pipeline (redaction, validation, fallback, `inner_call` rows) is T11.2,
 * the `http` backend T11.3, and each task contract its own task.
 *
 * Authority boundary (FR-INN-06): NOTHING under `src/policy/`, `src/adapters/`, the retry and failure-classification
 * logic, the push path or the sanitiser rule table may import this directory; `src/inner/import-boundary.test.ts` fails if
 * one does. Callers receive the service by injection and always have a deterministic fallback.
 */
import type { InnerAgentSettings, InnerTask } from "./config.js";
import { createHttpBackend } from "./http-backend.js";
import {
  createInnerPipeline,
  type InnerCallInput,
  type InnerCallResult,
  type InnerPipeline,
  type InnerTaskContract,
  type PipelineDeps,
} from "./pipeline.js";
import type { InnerBackend } from "./port.js";

export * from "./breaker.js";
export * from "./commit-message.js";
export * from "./config.js";
export * from "./fake-backend.js";
export * from "./http-backend.js";
export * from "./pipeline.js";
export * from "./port.js";
export * from "./truncate.js";

/**
 * Product and vendor names of the roadmap's provider list, scrubbed from every prompt in addition to the configured
 * provider ids (LLD §13.4 step 2b, FR-INN-10 "no provider name"). Delegated (T11.4): the LLD says "the configured provider
 * names"; config ids such as `claude-code` alone would miss the bare product name. Matched as whole words, case-insensitive.
 */
export const PROMPT_PROVIDER_NAMES: readonly string[] = [
  "claude",
  "anthropic",
  "codex",
  "openai",
  "gemini",
  "antigravity",
  "cursor",
  "grok",
  "kimi",
  "opencode",
];

/**
 * - `off`: no `inner_agent` section, or `enabled: false` (FR-INN-01). Every task uses its fallback.
 * - `no_backend`: enabled, but no backend object was supplied (the `http` backend arrives with T11.3, the `cli` kind with
 *   T11.13). Every task uses its fallback.
 * - `ready`: enabled with a backend.
 */
export type InnerAgentState = "off" | "no_backend" | "ready";

export interface InnerAgentService {
  readonly state: InnerAgentState;
  readonly settings: InnerAgentSettings | undefined;
  readonly backend: InnerBackend | undefined;
  /** True only when the master switch, the backend and the task's own switch are all on (FR-INN-05: none by default). */
  taskEnabled(task: InnerTask): boolean;
  /**
   * Run one task call through the pipeline (T11.2, LLD §13.4). Never throws; always yields either the validated value or
   * the contract's deterministic fallback. With the agent off, or the task not enabled, it yields the fallback and
   * writes nothing.
   */
  call<T, F>(contract: InnerTaskContract<T, F>, input: InnerCallInput): Promise<InnerCallResult<T, F>>;
  /** Circuit state of the backend; `closed` while there is no backend. */
  readonly breakerState: InnerPipeline["breakerState"];
}

/** Optional collaborators of the pipeline (everything in {@link PipelineDeps} except settings and backend). */
export type InnerAgentDeps = Partial<Omit<PipelineDeps, "settings">>;

export function createInnerAgent(
  settings: InnerAgentSettings | undefined,
  deps: InnerAgentDeps = {},
): InnerAgentService {
  const backend = settings?.enabled === true ? deps.backend : undefined;
  const state: InnerAgentState = settings?.enabled !== true ? "off" : backend === undefined ? "no_backend" : "ready";
  // FR-INN-15: the shared-subscription label is injected here, from configuration, so the pipeline and every caller stay
  // unaware of provider usage and nothing outside the ledger's one transaction ever writes a usage figure.
  const shared = settings?.backend?.sharesSubscriptionWith ?? null;
  const inner = deps.ledger;
  const ledger: PipelineDeps["ledger"] =
    inner !== undefined && shared !== null
      ? { recordInnerCall: (row, events) => inner.recordInnerCall(row, { ...events, sharedSubscriptionWith: shared }) }
      : inner;
  const pipeline =
    state === "ready" && settings !== undefined && backend !== undefined
      ? createInnerPipeline({ ...deps, ...(ledger !== undefined ? { ledger } : {}), settings, backend })
      : undefined;
  return {
    state,
    settings,
    backend,
    taskEnabled: (task) => state === "ready" && settings?.tasks[task].enabled === true,
    async call(contract, input) {
      if (pipeline !== undefined) return pipeline.call(contract, input);
      return {
        accepted: false,
        fallback: contract.fallback(),
        outcome: "no_call",
        reason: undefined,
        call_id: undefined,
      };
    },
    get breakerState() {
      return pipeline?.breakerState ?? "closed";
    },
  };
}

/**
 * Build the service from resolved settings, constructing the `http` backend the configuration names (T11.3). The `cli`
 * kind has no implementation yet (T11.13), so it stays `no_backend`. A test or tool may still hand in its own backend.
 */
export function createConfiguredInnerAgent(
  settings: InnerAgentSettings | undefined,
  deps: InnerAgentDeps = {},
): InnerAgentService {
  const b = settings?.enabled === true ? settings.backend : undefined;
  const backend = deps.backend ?? (b?.kind === "http" && b.baseUrl !== undefined ? createHttpBackend(b) : undefined);
  return createInnerAgent(settings, { ...deps, ...(backend !== undefined ? { backend } : {}) });
}
