import type Database from "better-sqlite3";
import { listSkillNames, skillState } from "./ledger.js";
import type { SkillVersionState } from "./state.js";

/**
 * Read helpers for the operator CLI (T16.2; FR-SKL-09, LLD §19.10): `doctor`, `runs show` and `skills`. Read-only; a
 * ledger from before migration 0021 has no skill tables, which reads as an empty store.
 */

export function hasSkillTables(db: Database.Database): boolean {
  const n = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('skill_version', 'skill_event', 'run_skill')",
    )
    .get() as { n: number };
  return n.n === 3;
}

/** One `run_skill` row as `runs show` lists it (name, version, hash, mode, removal). */
export interface RunSkillView {
  readonly position: number;
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly source: string;
  /** `prompt_prefix`, `native` or `skipped` (the delivery mode). */
  readonly delivery: string;
  readonly native_path: string | null;
  readonly removal: string | null;
}

export function listRunSkills(db: Database.Database, runId: string): RunSkillView[] {
  if (!hasSkillTables(db)) return [];
  return db
    .prepare(
      `SELECT position, name, version, sha256, source, delivery, native_path, removal
       FROM run_skill WHERE run_id = ? ORDER BY position`,
    )
    .all(runId) as RunSkillView[];
}

/** Runs with at least one skill whose removal failed (LLD §19.10 `doctor` line), oldest first. */
export function runsWithFailedSkillRemoval(db: Database.Database): string[] {
  if (!hasSkillTables(db)) return [];
  return (
    db.prepare("SELECT DISTINCT run_id FROM run_skill WHERE removal = 'failed' ORDER BY run_id").all() as {
      run_id: string;
    }[]
  ).map((r) => r.run_id);
}

export interface SkillStoreCounts {
  readonly names: number;
  readonly retired_names: number;
  readonly versions: Readonly<Record<SkillVersionState, number>>;
}

/** Stored versions by derived state, over every name (retired names included), and the name counts. */
export function skillStoreCounts(db: Database.Database): SkillStoreCounts {
  const versions: Record<SkillVersionState, number> = { draft: 0, approved: 0, revoked: 0 };
  let names = 0;
  let retired = 0;
  if (!hasSkillTables(db)) return { names, retired_names: retired, versions };
  for (const name of listSkillNames(db)) {
    const s = skillState(db, name);
    names++;
    if (s.retired) retired++;
    for (const v of s.versions) versions[v.state]++;
  }
  return { names, retired_names: retired, versions };
}
