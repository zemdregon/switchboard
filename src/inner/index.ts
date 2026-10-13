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
import type { InnerBackend } from "./port.js";

export * from "./config.js";
export * from "./fake-backend.js";
export * from "./port.js";

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
}

export function createInnerAgent(
  settings: InnerAgentSettings | undefined,
  deps: { backend?: InnerBackend } = {},
): InnerAgentService {
  const backend = settings?.enabled === true ? deps.backend : undefined;
  const state: InnerAgentState = settings?.enabled !== true ? "off" : backend === undefined ? "no_backend" : "ready";
  return {
    state,
    settings,
    backend,
    taskEnabled: (task) => state === "ready" && settings?.tasks[task].enabled === true,
  };
}
