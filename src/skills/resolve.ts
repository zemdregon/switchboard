/**
 * Skill resolution, LLD §19.5 steps 2 to 4 (T16.9; FR-SKL-03, FR-SKL-04, FR-SKL-08, ADR-0056).
 *
 * Pure and deterministic: it reads a catalogue snapshot handed in by the caller and writes nothing. `list_skills`
 * (T16.9) uses it for `defaults`; admission (T16.4) is meant to call the same function for its steps 2 to 4 so that
 * the two cannot disagree, then apply step 5 (caps) and step 6 (rows and the `skill_resolved` event) itself.
 *
 * Delegated readings (T16.9, 2026-10-17, not owner-approved):
 * - A `revoked` version is never usable, even where step 4 would allow a draft ("newest version at all" skips it).
 * - When the same name appears more than once, the first occurrence keeps the position, the first explicit `@n` (in
 *   candidate order) supplies the version and the source, and the entry counts as requested if any occurrence came
 *   from the request, so a requested name can never be skipped as a default (fail closed).
 * - Step 4's gates are applied in the LLD order; the first failing gate is the reason.
 */

import type Database from "better-sqlite3";
import type { TrustProfile } from "../ledger/index.js";
import { listSkillVersions, type SkillOrigin, skillState } from "./ledger.js";
import type { SkillVersionState } from "./state.js";

/** LLD §19.2 `run_skill.source`, without `continued` (step 1 is not resolution). */
export type SkillSource = "global_default" | "global_role" | "project_default" | "project_role" | "request";

/** The three profiles LLD §19.5 step 4 treats as untrusted. */
const UNTRUSTED: ReadonlySet<TrustProfile> = new Set(["inspect-untrusted", "edit-untrusted", "test-sandboxed"]);

export function isUntrustedProfile(profile: TrustProfile): boolean {
  return UNTRUSTED.has(profile);
}

/** One stored version as resolution sees it. */
export interface CatalogVersion {
  readonly version: number;
  readonly state: SkillVersionState;
  readonly origin: SkillOrigin;
  readonly sha256: string;
  /** `skill_version.size_bytes`, for the T16.4 run cap; `readCatalogEntry` always sets it. */
  readonly sizeBytes?: number;
}

/** One name with its derived state; `versions` ascending. */
export interface CatalogEntry {
  readonly name: string;
  readonly retired: boolean;
  readonly versions: readonly CatalogVersion[];
}

/** Catalogue lookup; `undefined` for a name with no stored version. */
export type SkillCatalog = (name: string) => CatalogEntry | undefined;

/** Read one name's catalogue entry from the T16.1 store (read-only). */
export function readCatalogEntry(db: Database.Database, name: string): CatalogEntry | undefined {
  const rows = listSkillVersions(db, name);
  if (rows.length === 0) return undefined;
  const state = skillState(db, name);
  const byVersion = new Map(state.versions.map((v) => [v.version, v.state]));
  return {
    name,
    retired: state.retired,
    versions: rows.map((r) => ({
      version: r.version,
      state: byVersion.get(r.version) ?? "draft",
      origin: r.origin,
      sha256: r.sha256,
      sizeBytes: r.size_bytes,
    })),
  };
}

/** A memoising catalogue over the store, for one call. */
export function storeCatalog(db: Database.Database): SkillCatalog {
  const cache = new Map<string, CatalogEntry | undefined>();
  return (name) => {
    if (!cache.has(name)) cache.set(name, readCatalogEntry(db, name));
    return cache.get(name);
  };
}

/** What gates a version for one client and profile (LLD §19.5 step 4). */
export interface SkillGate {
  readonly profile: TrustProfile;
  readonly allowDraftInTrusted: boolean;
  /** `mcp_clients[].skills`; absent means every name. */
  readonly clientSkills?: readonly string[];
}

/** Whether `name` is inside the client's allow-list (`mcp_clients[].skills`, LLD §19.3). */
export function skillVisible(name: string, clientSkills: readonly string[] | undefined): boolean {
  return clientSkills === undefined || clientSkills.includes(name);
}

function draftAllowed(gate: SkillGate): boolean {
  return gate.allowDraftInTrusted && !isUntrustedProfile(gate.profile);
}

export type SkillGateReason =
  | "SKILL_UNKNOWN"
  | "SKILL_NOT_PERMITTED"
  | "SKILL_NOT_APPROVED"
  | "SKILL_REPOSITORY_ORIGIN";

/** Step 4 for one resolved version, the name-level checks having passed (also step 1' re-check, T16.4). */
export function versionGate(v: CatalogVersion, gate: SkillGate): SkillGateReason | undefined {
  if (v.state === "revoked") return "SKILL_NOT_APPROVED";
  if (v.state !== "approved" && !draftAllowed(gate)) return "SKILL_NOT_APPROVED";
  if (v.origin === "repository_path" && isUntrustedProfile(gate.profile)) return "SKILL_REPOSITORY_ORIGIN";
  return undefined;
}

/**
 * The newest version of `entry` this client could inject under `gate`, unpinned or pinned (`list_skills`, LLD §19.9).
 * `undefined` when the name is retired, outside the allow-list or has no version that passes step 4.
 */
export function newestInjectableVersion(entry: CatalogEntry, gate: SkillGate): CatalogVersion | undefined {
  for (let i = entry.versions.length - 1; i >= 0; i--) {
    const v = entry.versions[i] as CatalogVersion;
    if (versionInjectable(entry, v, gate)) return v;
  }
  return undefined;
}

/** Whether this client could inject version `v` of `entry` (pinned) under `gate`: LLD §19.5 step 4 for one version. */
export function versionInjectable(entry: CatalogEntry, v: CatalogVersion, gate: SkillGate): boolean {
  return !entry.retired && skillVisible(entry.name, gate.clientSkills) && versionGate(v, gate) === undefined;
}

/** Step 3's unpinned resolution: the newest approved version, or the newest non-revoked one when a draft is allowed. */
function unpinnedVersion(entry: CatalogEntry, gate: SkillGate): CatalogVersion | undefined {
  const allowDraft = draftAllowed(gate);
  for (let i = entry.versions.length - 1; i >= 0; i--) {
    const v = entry.versions[i] as CatalogVersion;
    if (v.state === "approved" || (allowDraft && v.state === "draft")) return v;
  }
  return undefined;
}

/** LLD §19.4 reference: `name` or `name@n`. */
const SKILL_REF = /^([a-z][a-z0-9-]{1,47})(?:@([1-9][0-9]{0,5}))?$/u;

export function parseSkillRef(ref: string): { name: string; version?: number } | undefined {
  const m = SKILL_REF.exec(ref);
  if (!m || m[1] === undefined) return undefined;
  return m[2] === undefined ? { name: m[1] } : { name: m[1], version: Number(m[2]) };
}

/** Global or project lists, as `ResolvedSkillAssignment` carries them. */
export interface SkillLists {
  readonly defaults: readonly string[];
  readonly roles: Readonly<Record<string, readonly string[]>>;
}

export interface ResolveSkillsInput extends SkillGate {
  readonly global: SkillLists;
  /** `projects[].skills`; absent for no project or a project without the key. */
  readonly project?: SkillLists;
  readonly role?: string;
  /** LLD §19.4 `skill_defaults`; default `apply`. */
  readonly skillDefaults?: "apply" | "omit";
  /** The request's `skills` (T16.4); absent for `list_skills`. */
  readonly requested?: readonly string[];
}

export interface ResolvedSkillEntry {
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly source: SkillSource;
}

export interface SkippedSkillDefault {
  readonly ref: string;
  readonly source: SkillSource;
  readonly reason: SkillGateReason;
}

export interface RefusedSkill {
  readonly ref: string;
  readonly reason: SkillGateReason;
}

export interface SkillResolution {
  /** Entries in resolved order (step 3 positions), after step 4. */
  readonly entries: readonly ResolvedSkillEntry[];
  /** Configured defaults that failed a gate (`skill_resolved.skipped`); never a requested name. */
  readonly skipped: readonly SkippedSkillDefault[];
  /** The first requested name that failed a gate; the request must then be refused (T16.4). */
  readonly refused?: RefusedSkill;
}

/** `roles[role]` without reading an inherited property such as `constructor`. */
function roleList(lists: SkillLists | undefined, role: string | undefined): readonly string[] {
  if (lists === undefined || role === undefined || !Object.hasOwn(lists.roles, role)) return [];
  return lists.roles[role] ?? [];
}

interface Candidate {
  readonly ref: string;
  readonly source: SkillSource;
}

/** LLD §19.5 step 2: the candidate list in source order. */
function candidates(input: ResolveSkillsInput): Candidate[] {
  const out: Candidate[] = [];
  const add = (refs: readonly string[], source: SkillSource) => {
    for (const ref of refs) out.push({ ref, source });
  };
  if ((input.skillDefaults ?? "apply") === "apply") {
    add(input.global.defaults, "global_default");
    add(roleList(input.global, input.role), "global_role");
    add(input.project?.defaults ?? [], "project_default");
    add(roleList(input.project, input.role), "project_role");
  }
  add(input.requested ?? [], "request");
  return out;
}

/** LLD §19.5 steps 2 to 4. Writes nothing; the same input and catalogue always give the same result. */
export function resolveSkills(input: ResolveSkillsInput, catalog: SkillCatalog): SkillResolution {
  // Step 3: de-duplicate by name.
  interface Slot {
    name: string;
    first: Candidate;
    pinned?: { version: number; candidate: Candidate };
    requested: boolean;
  }
  const slots = new Map<string, Slot>();
  const unparsable: Candidate[] = [];
  for (const c of candidates(input)) {
    const ref = parseSkillRef(c.ref);
    if (ref === undefined) {
      unparsable.push(c);
      continue;
    }
    let slot = slots.get(ref.name);
    if (slot === undefined) {
      slot = { name: ref.name, first: c, requested: false };
      slots.set(ref.name, slot);
    }
    if (c.source === "request") slot.requested = true;
    if (ref.version !== undefined && slot.pinned === undefined) slot.pinned = { version: ref.version, candidate: c };
  }

  const entries: ResolvedSkillEntry[] = [];
  const skipped: SkippedSkillDefault[] = [];
  let refused: RefusedSkill | undefined;
  const reject = (slot: Slot, reason: SkillGateReason) => {
    const c = slot.pinned?.candidate ?? slot.first;
    if (slot.requested) refused ??= { ref: slot.pinned?.candidate.ref ?? slot.name, reason };
    else skipped.push({ ref: c.ref, source: c.source, reason });
  };
  // A configuration or request reference that does not parse cannot name a skill: unknown.
  for (const c of unparsable) {
    if (c.source === "request") refused ??= { ref: c.ref, reason: "SKILL_UNKNOWN" };
    else skipped.push({ ref: c.ref, source: c.source, reason: "SKILL_UNKNOWN" });
  }

  // Step 4, in resolved order.
  for (const slot of slots.values()) {
    const entry = catalog(slot.name);
    if (entry === undefined || entry.retired) {
      reject(slot, "SKILL_UNKNOWN");
      continue;
    }
    const version =
      slot.pinned === undefined
        ? unpinnedVersion(entry, input)
        : entry.versions.find((v) => v.version === slot.pinned?.version);
    if (version === undefined) {
      reject(slot, "SKILL_UNKNOWN");
      continue;
    }
    if (!skillVisible(slot.name, input.clientSkills)) {
      reject(slot, "SKILL_NOT_PERMITTED");
      continue;
    }
    const reason = versionGate(version, input);
    if (reason !== undefined) {
      reject(slot, reason);
      continue;
    }
    entries.push({
      name: slot.name,
      version: version.version,
      sha256: version.sha256,
      source: (slot.pinned?.candidate ?? slot.first).source,
    });
  }
  return { entries, skipped, ...(refused !== undefined ? { refused } : {}) };
}
