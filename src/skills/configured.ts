/**
 * Configured skill names that do not resolve (T16.3; LLD §19.3).
 *
 * An unknown or unapproved name is a warning, not a startup failure: the operator adds skills after the config exists.
 * This helper is the input to the T16.2 `doctor` line. It only reads the T16.1 store. It does not admit a run and it
 * does not write a row.
 *
 * A name resolves when it is not retired and the pin (or, with no pin, the newest approved version) is `approved`.
 * A draft, a revoked version, a missing pin and a retired name do not resolve. `skills.allow_draft_in_trusted` is an
 * admission gate (T16.4), not a reason to hide the warning.
 */

import type Database from "better-sqlite3";
import { getSkillVersion, skillState } from "./ledger.js";
import { newestApprovedVersion, type SkillNameState } from "./state.js";

/** One configured reference, as written (`name` or `name@n`), with the JSON path the doctor can print. */
export interface ConfiguredSkillSite {
  readonly at: string;
  readonly ref: string;
}

/**
 * The configured lists. `clients[].skills` absent means every approved name, so those clients contribute no sites.
 * Project entries without `skills` contribute none either.
 */
export interface SkillConfigView {
  readonly defaults: readonly string[];
  readonly roles: Readonly<Record<string, readonly string[]>>;
  readonly projects: readonly {
    readonly skills?: {
      readonly defaults: readonly string[];
      readonly roles: Readonly<Record<string, readonly string[]>>;
    };
  }[];
  readonly clients: readonly { readonly skills?: readonly string[] }[];
}

/** Why a configured name does not resolve. The doctor (T16.2) prints `at`, `ref` and this reason. */
export type UnresolvedSkillReason = "unknown" | "retired" | "version_unknown" | "unapproved";

export interface UnresolvedConfiguredSkill {
  readonly at: string;
  readonly ref: string;
  readonly name: string;
  readonly version?: number;
  readonly reason: UnresolvedSkillReason;
}

/** LLD §19.1 name, optionally pinned the way LLD §19.4 pins a request name. */
const SKILL_REF = /^([a-z][a-z0-9-]{1,47})(?:@([1-9][0-9]{0,5}))?$/u;

function parseRef(ref: string): { name: string; version?: number } {
  const m = SKILL_REF.exec(ref);
  if (!m || m[1] === undefined) return { name: ref };
  if (m[2] === undefined) return { name: m[1] };
  return { name: m[1], version: Number(m[2]) };
}

/** Every configured name, in configuration order: global, then each project, then each client. */
export function collectConfiguredSkillRefs(view: SkillConfigView): ConfiguredSkillSite[] {
  const out: ConfiguredSkillSite[] = [];
  for (const [i, ref] of view.defaults.entries()) out.push({ at: `$.skills.defaults[${i}]`, ref });
  for (const [role, names] of Object.entries(view.roles)) {
    for (const [i, ref] of names.entries()) out.push({ at: `$.skills.roles.${role}[${i}]`, ref });
  }
  for (const [pi, project] of view.projects.entries()) {
    const skills = project.skills;
    if (skills === undefined) continue;
    for (const [i, ref] of skills.defaults.entries()) {
      out.push({ at: `$.projects[${pi}].skills.defaults[${i}]`, ref });
    }
    for (const [role, names] of Object.entries(skills.roles)) {
      for (const [i, ref] of names.entries()) out.push({ at: `$.projects[${pi}].skills.roles.${role}[${i}]`, ref });
    }
  }
  for (const [ci, client] of view.clients.entries()) {
    if (client.skills === undefined) continue;
    for (const [i, ref] of client.skills.entries()) out.push({ at: `$.mcp_clients[${ci}].skills[${i}]`, ref });
  }
  return out;
}

function classify(
  db: Database.Database,
  site: ConfiguredSkillSite,
  cache: Map<string, SkillNameState>,
): UnresolvedConfiguredSkill | undefined {
  const { name, version } = parseRef(site.ref);
  let state = cache.get(name);
  if (state === undefined) {
    state = skillState(db, name);
    cache.set(name, state);
  }
  const base = { at: site.at, ref: site.ref, name, ...(version !== undefined ? { version } : {}) };
  if (state.versions.length === 0) return { ...base, reason: "unknown" };
  if (state.retired) return { ...base, reason: "retired" };
  if (version !== undefined) {
    if (getSkillVersion(db, name, version) === undefined) return { ...base, reason: "version_unknown" };
    const found = state.versions.find((v) => v.version === version);
    if (found?.state !== "approved") return { ...base, reason: "unapproved" };
    return undefined;
  }
  if (newestApprovedVersion(state) === undefined) return { ...base, reason: "unapproved" };
  return undefined;
}

/**
 * Configured names that do not resolve against the skill store. Read-only. An empty view, or a view whose every name
 * resolves, returns an empty list. Startup does not call this and does not fail on the result.
 */
export function unresolvedConfiguredSkills(
  db: Database.Database,
  sites: readonly ConfiguredSkillSite[],
): UnresolvedConfiguredSkill[] {
  const cache = new Map<string, SkillNameState>();
  const out: UnresolvedConfiguredSkill[] = [];
  for (const site of sites) {
    const row = classify(db, site, cache);
    if (row !== undefined) out.push(row);
  }
  return out;
}
