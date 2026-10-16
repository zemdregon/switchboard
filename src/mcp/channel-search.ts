/**
 * T12.9 (FR-RAG-13, LLD §14.7, ADR-0026, ADR-0031): the T12.6 `search_project_context` handler behind the per-run tool
 * channel. `serve` hands this port to the `COMP-GIT` channel service, which offers the tool only when
 * {@link ChannelSearchPort.offeredFor} is true for the run's project when the channel opens, and passes the project id
 * it bound at open (never one from the agent's request).
 *
 * Same handler, same bounds: the project is resolved from the current configuration at every call and searched with
 * {@link searchProjectContext} exactly as the MCP tool does (scope rules, `GLOBAL_NOT_AVAILABLE`, `unavailable` with
 * `NOT_BUILT` when the project has no index, result count and size bounds). The only differences (Delegated, T12.9):
 * the `rag_record` row carries the run id, a scope the project may not use is the channel's `INVALID_ARGUMENTS`, and a
 * project that is no longer configured is `PROJECT_UNAVAILABLE` rather than another project's data.
 */
import type { ResolvedProject } from "../config/index.js";
import type { ChannelSearchPort } from "../git/channel.js";
import { type DynamicProjectStore, toResolved } from "../projects/index.js";
import { ToolError } from "./errors.js";
import {
  type SearchContextDeps,
  type SearchProject,
  searchEnabledFor,
  searchProjectContext,
} from "./search-context.js";

/** Resolves a project id to the project as currently configured; undefined when it is unknown or not in force. */
export type SearchProjectResolver = (projectId: string) => SearchProject | undefined;

export function createChannelSearchPort(deps: SearchContextDeps, projectFor: SearchProjectResolver): ChannelSearchPort {
  return {
    offeredFor: (projectId) => {
      const project = projectFor(projectId);
      return project !== undefined && searchEnabledFor(deps.settings, project);
    },
    search: async ({ runId, projectId, query, limit, scope }) => {
      const project = projectFor(projectId);
      if (project === undefined) return { ok: false, code: "PROJECT_UNAVAILABLE" };
      const record = deps.record;
      try {
        const result = await searchProjectContext(
          { ...deps, ...(record !== undefined ? { record: (r) => record({ ...r, runId }) } : {}) },
          project,
          { query, ...(limit !== undefined ? { limit } : {}), ...(scope !== undefined ? { scope } : {}) },
        );
        return { ok: true, result: { ...result } };
      } catch (err) {
        if (err instanceof ToolError && err.code === "INVALID_REQUEST") return { ok: false, code: "INVALID_ARGUMENTS" };
        throw err;
      }
    },
  };
}

/** The configured project with that id, else a dynamic project's revision in force (as `innerSettingResolver`). */
export function searchProjectResolver(
  projects: readonly ResolvedProject[],
  store: Pick<DynamicProjectStore, "state">,
): SearchProjectResolver {
  return (projectId) => {
    const configured = projects.find((p) => p.id === projectId);
    if (configured !== undefined) return configured;
    const dynamic = store.state(projectId)?.inForce?.definition;
    return dynamic !== undefined ? toResolved(dynamic) : undefined;
  };
}
