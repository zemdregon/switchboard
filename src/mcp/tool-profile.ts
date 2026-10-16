/**
 * Per-client `tool_profile` (T14.11; FR-CTL-11, LLD §3.4.10, console tool-profile spike 2026-10-15).
 *
 * `orchestrator` (the default) offers every tool the server would already list for the client, unchanged. `console`
 * offers only the closed console set below, plus the approval-proxy tools when the client has `approval_proxy`
 * (regardless of profile, ADR-0047). The same rule filters `tools/list` and guards `tools/call`, so a console client
 * cannot call an orchestrator-only tool by name. A console name the server does not register yet (`steer_run`, T14.7;
 * `pause_project` and `resume_project`, T14.6) is simply absent until its handler lands: this module never invents a
 * descriptor.
 */
import type { ToolProfile } from "../config/index.js";
import { APPROVAL_PROXY_TOOL_NAMES } from "../control/approval-proxy.js";

/** The closed console set, in LLD §3.4.10 order. */
export const CONSOLE_TOOL_NAMES = [
  "get_digest",
  "list_runs",
  "get_run",
  "delegate_task",
  "steer_run",
  "pause_project",
  "resume_project",
] as const;

const CONSOLE_OFFERED: ReadonlySet<string> = new Set([...CONSOLE_TOOL_NAMES, ...APPROVAL_PROXY_TOOL_NAMES]);

/**
 * Whether `profile` lets the client see and call `name`. An absent profile is `orchestrator`, which narrows nothing;
 * the per-client gates (`manage_projects`, retrieval, `approval_proxy`) still decide whether such a tool exists.
 */
export function profileOffers(profile: ToolProfile | undefined, name: string): boolean {
  return profile !== "console" || CONSOLE_OFFERED.has(name);
}

/** The `tools/list` entries `profile` keeps, in their registered order (an orchestrator list is returned as is). */
export function applyToolProfile<T extends { name: string }>(profile: ToolProfile | undefined, tools: T[]): T[] {
  return profile === "console" ? tools.filter((t) => profileOffers(profile, t.name)) : tools;
}
