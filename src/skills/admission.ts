/**
 * Skill admission, LLD §19.5 steps 1 to 6 (T16.4; FR-SKL-03, FR-SKL-04, FR-SKL-07, ADR-0056 items 3 to 5, FRD BR-52,
 * BR-53, V15, C8).
 *
 * `resolveRunSkills` is pure (TDD §3.16.2 property 8): steps 1 to 5 over a catalogue snapshot and the previous run's
 * rows, both handed in. Steps 2 to 4 are `resolveSkills` (`./resolve.ts`), the function `list_skills` uses, so the two
 * cannot disagree. `admitRunSkills` reads the store and `recordRunSkills` writes the rows; `skillAdmissionPort` wraps
 * both as the lifecycle's structurally typed `SkillAdmissionPort`, which it calls inside its admission transaction on the
 * ledger's own database handle. The lifecycle does not import this module (`./import-boundary.test.ts`).
 *
 * Delegated readings (T16.4, 2026-10-17, not owner-approved):
 * - Step 1 copies the previous run's rows only when the continuation carries none of the three fields. A copied entry
 *   that fails the step 4 re-check (a lower profile, a revoked or retired version, a client allow-list change) is
 *   skipped with an event, as a configured default is: it was not requested by this request, so it cannot fail it.
 *   The re-check also requires the stored hash to be unchanged (fail closed).
 * - Step 5's byte cap sums `skill_version.size_bytes`, the stored canonical file (front matter and body). That is at
 *   least the body, so the cap can only be stricter than "bytes of bodies", and admission reads no content file.
 * - `run_skill.delivery` is NOT NULL in migration 0021, but delivery is decided at dispatch (§19.6, T16.5 and T16.6).
 *   Admission writes the default mode `prompt_prefix` with `delivered_at` NULL; a row whose `delivered_at` is NULL has
 *   not been delivered, and `get_run` shows its delivery as `null`.
 * - A run with no resolved entry and no skipped default gets no `skill_resolved` event, so a run without skills writes
 *   the same rows whether or not `skills.enabled` is true.
 */

import type Database from "better-sqlite3";
import type { TrustProfile } from "../ledger/index.js";
import {
  type CatalogVersion,
  resolveSkills,
  type SkillCatalog,
  type SkillGate,
  type SkillGateReason,
  type SkillLists,
  type SkillSource,
  skillVisible,
  storeCatalog,
  versionGate,
} from "./resolve.js";

/** LLD §19.2 `run_skill.source`. */
export type RunSkillSource = SkillSource | "continued";

/** LLD §19.4 request fields, as validated by the tool schema. */
export interface SkillRequestFields {
  readonly skills?: readonly string[];
  readonly role?: string;
  readonly skill_defaults?: "apply" | "omit";
}

/** The three field names, for the `SKILLS_DISABLED` refusal and the stored request. */
export const SKILL_REQUEST_FIELDS = ["skills", "role", "skill_defaults"] as const;

/** The fields present in `args`, in a fixed order; empty when the request carries none. */
export function skillRequestFields(args: Readonly<Record<string, unknown>>): SkillRequestFields {
  return {
    ...(args.skills !== undefined ? { skills: [...(args.skills as string[])] } : {}),
    ...(args.role !== undefined ? { role: args.role as string } : {}),
    ...(args.skill_defaults !== undefined ? { skill_defaults: args.skill_defaults as "apply" | "omit" } : {}),
  };
}

export function hasSkillFields(fields: SkillRequestFields): boolean {
  return fields.skills !== undefined || fields.role !== undefined || fields.skill_defaults !== undefined;
}

/** The `skills.*` keys admission reads (a `ResolvedSkills` satisfies it). */
export interface SkillAdmissionSettings extends SkillLists {
  readonly allowDraftInTrusted: boolean;
  readonly maxPerRun: number;
  readonly maxRunBytes: number;
}

/**
 * What a submission carries when `skills.enabled` is true. `db` must be the ledger's own handle: the reads and the
 * `run_skill` inserts run inside the lifecycle's `BEGIN IMMEDIATE` admission transaction.
 */
export interface SkillAdmission {
  readonly db: Database.Database;
  readonly settings: SkillAdmissionSettings;
  /** `projects[].skills`; absent for no project or a project without the key. */
  readonly project?: SkillLists;
  /** `mcp_clients[].skills`; absent means every name. */
  readonly clientSkills?: readonly string[];
  readonly fields: SkillRequestFields;
}

/** One resolved entry, in position order. */
export interface AdmittedSkill {
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly source: RunSkillSource;
}

/** A configured default (or a continued entry) that failed a gate: `skill_resolved.skipped`. */
export interface SkippedSkill {
  readonly name: string;
  readonly reason: SkillGateReason;
}

export interface RunSkillSet {
  readonly entries: readonly AdmittedSkill[];
  readonly skipped: readonly SkippedSkill[];
}

export type SkillAdmissionReason = SkillGateReason | "SKILL_RUN_LIMIT";

/** A refused request (V15, C8). Nothing is written: it is thrown inside the admission transaction. */
export class SkillAdmissionError extends Error {
  override readonly name = "SkillAdmissionError";
  readonly code: "INVALID_REQUEST" | "PERMISSION_BLOCKED";
  readonly details: { readonly reason: SkillAdmissionReason; readonly skill?: string };
  constructor(reason: SkillAdmissionReason, message: string, skill?: string) {
    super(message);
    this.code = reason === "SKILL_UNKNOWN" || reason === "SKILL_RUN_LIMIT" ? "INVALID_REQUEST" : "PERMISSION_BLOCKED";
    this.details = { reason, ...(skill !== undefined ? { skill } : {}) };
  }
}

const REFUSAL_MESSAGE: Record<SkillGateReason, string> = {
  SKILL_UNKNOWN: "is unknown, retired or has no usable version",
  SKILL_NOT_PERMITTED: "is not in this client's skill list",
  SKILL_NOT_APPROVED: "is not an approved version usable under this trust profile",
  SKILL_REPOSITORY_ORIGIN: "was imported from a repository path and is refused under an untrusted profile",
};

/** A previous run's row as step 1 copies it. */
export interface PreviousRunSkill {
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
}

export interface ResolveRunSkillsInput {
  readonly settings: SkillAdmissionSettings;
  readonly project?: SkillLists;
  readonly clientSkills?: readonly string[];
  readonly fields: SkillRequestFields;
  /** The new run's trust profile. */
  readonly profile: TrustProfile;
  /** A continuation's previous run rows (step 1); absent for a new meta-session. */
  readonly previous?: readonly PreviousRunSkill[];
}

/** Step 1: copy and re-check; failures are skipped, never refused. */
function continued(previous: readonly PreviousRunSkill[], gate: SkillGate, catalog: SkillCatalog): RunSkillSet {
  const entries: AdmittedSkill[] = [];
  const skipped: SkippedSkill[] = [];
  for (const row of previous) {
    const entry = catalog(row.name);
    const v: CatalogVersion | undefined = entry?.versions.find((x) => x.version === row.version);
    let reason: SkillGateReason | undefined;
    if (entry === undefined || entry.retired || v === undefined || v.sha256 !== row.sha256) reason = "SKILL_UNKNOWN";
    else if (!skillVisible(row.name, gate.clientSkills)) reason = "SKILL_NOT_PERMITTED";
    else reason = versionGate(v, gate);
    if (reason === undefined) entries.push({ ...row, source: "continued" });
    else skipped.push({ name: `${row.name}@${row.version}`, reason });
  }
  return { entries, skipped };
}

/**
 * LLD §19.5 steps 1 to 5. Pure: the same input and catalogue always give the same set. Throws
 * {@link SkillAdmissionError} for a requested name that fails a gate and for the caps.
 */
export function resolveRunSkills(input: ResolveRunSkillsInput, catalog: SkillCatalog): RunSkillSet {
  const gate: SkillGate = {
    profile: input.profile,
    allowDraftInTrusted: input.settings.allowDraftInTrusted,
    ...(input.clientSkills !== undefined ? { clientSkills: input.clientSkills } : {}),
  };
  if (input.previous !== undefined && !hasSkillFields(input.fields)) return continued(input.previous, gate, catalog);

  const resolution = resolveSkills(
    {
      ...gate,
      global: input.settings,
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.fields.role !== undefined ? { role: input.fields.role } : {}),
      ...(input.fields.skill_defaults !== undefined ? { skillDefaults: input.fields.skill_defaults } : {}),
      ...(input.fields.skills !== undefined ? { requested: input.fields.skills } : {}),
    },
    catalog,
  );
  const refused = resolution.refused;
  if (refused !== undefined) {
    throw new SkillAdmissionError(
      refused.reason,
      `skill ${refused.ref} ${REFUSAL_MESSAGE[refused.reason]}`,
      refused.ref,
    );
  }

  // Step 5: the caps.
  const { maxPerRun, maxRunBytes } = input.settings;
  if (resolution.entries.length > maxPerRun) {
    throw new SkillAdmissionError(
      "SKILL_RUN_LIMIT",
      `the run resolves ${resolution.entries.length} skills; skills.max_per_run is ${maxPerRun}`,
    );
  }
  let bytes = 0;
  for (const e of resolution.entries) {
    bytes += catalog(e.name)?.versions.find((x) => x.version === e.version)?.sizeBytes ?? 0;
  }
  if (bytes > maxRunBytes) {
    throw new SkillAdmissionError(
      "SKILL_RUN_LIMIT",
      `the run's skills total ${bytes} bytes; skills.max_run_bytes is ${maxRunBytes}`,
    );
  }
  return {
    entries: resolution.entries.map((e) => ({ name: e.name, version: e.version, sha256: e.sha256, source: e.source })),
    skipped: resolution.skipped.map((s) => ({ name: s.ref, reason: s.reason })),
  };
}

/** A previous run's rows, in position order (step 1's input). */
export function previousRunSkills(db: Database.Database, runId: string): PreviousRunSkill[] {
  return db
    .prepare("SELECT name, version, sha256 FROM run_skill WHERE run_id = ? ORDER BY position")
    .all(runId) as PreviousRunSkill[];
}

/** Steps 1 to 5 against the store; `previousRunId` is the continuation's previous run. Writes nothing. */
export function admitRunSkills(
  admission: SkillAdmission,
  ctx: { readonly profile: TrustProfile; readonly previousRunId?: string },
): RunSkillSet {
  return resolveRunSkills(
    {
      settings: admission.settings,
      ...(admission.project !== undefined ? { project: admission.project } : {}),
      ...(admission.clientSkills !== undefined ? { clientSkills: admission.clientSkills } : {}),
      fields: admission.fields,
      profile: ctx.profile,
      ...(ctx.previousRunId !== undefined ? { previous: previousRunSkills(admission.db, ctx.previousRunId) } : {}),
    },
    storeCatalog(admission.db),
  );
}

/** Step 6's rows: one per entry, `delivery` the default until dispatch records it (see the module comment). */
export function recordRunSkills(db: Database.Database, runId: string, set: RunSkillSet): void {
  const insert = db.prepare(
    `INSERT INTO run_skill (run_id, position, name, version, sha256, source, delivery)
     VALUES (?, ?, ?, ?, ?, ?, 'prompt_prefix')`,
  );
  set.entries.forEach((e, i) => {
    insert.run(runId, i, e.name, e.version, e.sha256, e.source);
  });
}

/** LLD §19.11 `skill_resolved` payload: names, versions, hashes and sources; never a body or description. */
export function skillResolvedPayload(set: RunSkillSet): object {
  return {
    entries: set.entries.map((e) => ({ name: e.name, version: e.version, sha256: e.sha256, source: e.source })),
    skipped: set.skipped.map((s) => ({ name: s.name, reason: s.reason })),
  };
}

/** The lifecycle's `SkillAdmissionPort` over the store (structurally typed there; see the module comment). */
export function skillAdmissionPort(admission: SkillAdmission): {
  readonly fields: SkillRequestFields;
  resolve(ctx: { readonly profile: TrustProfile; readonly previousRunId?: string }): {
    readonly event?: object;
    write(runId: string): void;
  };
} {
  return {
    fields: admission.fields,
    resolve(ctx) {
      const set = admitRunSkills(admission, ctx);
      const empty = set.entries.length === 0 && set.skipped.length === 0;
      return {
        ...(empty ? {} : { event: skillResolvedPayload(set) }),
        write: (runId) => recordRunSkills(admission.db, runId, set),
      };
    },
  };
}

/** `get_run`'s view of a run's skills (FR-SKL-07): metadata only, never text; `delivery` is null until dispatch. */
export interface RunSkillMetadata {
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly source: RunSkillSource;
  readonly delivery: "prompt_prefix" | "native" | "skipped" | null;
}

export function runSkillMetadata(db: Database.Database, runId: string): RunSkillMetadata[] {
  const rows = db
    .prepare(
      `SELECT name, version, sha256, source, delivery, delivered_at FROM run_skill WHERE run_id = ? ORDER BY position`,
    )
    .all(runId) as (Omit<RunSkillMetadata, "delivery"> & {
    delivery: "prompt_prefix" | "native" | "skipped";
    delivered_at: string | null;
  })[];
  return rows.map((r) => ({
    name: r.name,
    version: r.version,
    sha256: r.sha256,
    source: r.source,
    delivery: r.delivered_at === null ? null : r.delivery,
  }));
}
