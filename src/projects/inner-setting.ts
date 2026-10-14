import { effectiveInnerSetting, type ProjectInnerSetting, type ResolvedProject } from "../config/index.js";
import { toResolved } from "./rules.js";
import type { DynamicProjectStore } from "./store.js";

/**
 * T11.4 (LLD §13.1, FR-INN-16; the T11.3 note): resolves a run's effective project/context `inner_agent` setting from
 * the CURRENT configuration, or, for a project an orchestrator created (FR-PRJ-10), from its revision in force. It is
 * computed on demand, not frozen in the policy snapshot, so an operator or orchestrator that restricts a project stops
 * further drafts of a running run. A project found in neither (removed from configuration, deleted, never approved)
 * reads as `off` (fail closed; Delegated).
 */
export function innerSettingResolver(
  projects: readonly ResolvedProject[],
  store: Pick<DynamicProjectStore, "state">,
): (projectId: string, contextId: string) => ProjectInnerSetting {
  return (projectId, contextId) => {
    const configured = projects.find((p) => p.id === projectId);
    if (configured !== undefined) return effectiveInnerSetting(configured, contextId);
    const dynamic = store.state(projectId)?.inForce?.definition;
    return dynamic !== undefined ? effectiveInnerSetting(toResolved(dynamic), contextId) : "off";
  };
}
