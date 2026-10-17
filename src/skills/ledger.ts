import type Database from "better-sqlite3";
import { deriveSkillState, type SkillEventFact, type SkillEventKind, type SkillNameState } from "./state.js";

/**
 * Ledger helpers for `skill_version` and `skill_event` (T16.1; LLD §19.2, ADR-0056 item 11). Both tables are
 * append-only (migration 0021 triggers); this module only inserts and reads. No row holds skill text.
 */

export const SKILL_ACTOR_OPERATOR_CLI = "operator_cli";
export const MAX_NOTE_CHARS = 280;

export type SkillOrigin = "operator_file" | "repository_path";

export interface SkillVersionRow {
  name: string;
  version: number;
  sha256: string;
  size_bytes: number;
  description: string;
  /** JSON array of provider ids, or `null` for every provider. */
  applies_to: string | null;
  origin: SkillOrigin;
  created_at: string;
}

export interface SkillEventRow {
  id: number;
  name: string;
  version: number | null;
  kind: SkillEventKind;
  actor: string;
  note: string | null;
  at: string;
}

export class SkillLedgerError extends Error {
  override readonly name = "SkillLedgerError";
}

const VERSION_COLS = "name, version, sha256, size_bytes, description, applies_to, origin, created_at";
const EVENT_COLS = "id, name, version, kind, actor, note, at";
// biome-ignore lint/suspicious/noControlCharactersInRegex: an operator note is one line of text
const NOTE_CONTROL = /[\u0000-\u001F\u007F]/u;

export function newestSkillVersion(db: Database.Database, name: string): SkillVersionRow | undefined {
  return db
    .prepare(`SELECT ${VERSION_COLS} FROM skill_version WHERE name = ? ORDER BY version DESC LIMIT 1`)
    .get(name) as SkillVersionRow | undefined;
}

export function getSkillVersion(db: Database.Database, name: string, version: number): SkillVersionRow | undefined {
  return db.prepare(`SELECT ${VERSION_COLS} FROM skill_version WHERE name = ? AND version = ?`).get(name, version) as
    | SkillVersionRow
    | undefined;
}

export function listSkillVersions(db: Database.Database, name: string): SkillVersionRow[] {
  return db
    .prepare(`SELECT ${VERSION_COLS} FROM skill_version WHERE name = ? ORDER BY version`)
    .all(name) as SkillVersionRow[];
}

export function listSkillNames(db: Database.Database): string[] {
  return (db.prepare("SELECT DISTINCT name FROM skill_version ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

export function listSkillEvents(db: Database.Database, name: string): SkillEventRow[] {
  return db.prepare(`SELECT ${EVENT_COLS} FROM skill_event WHERE name = ? ORDER BY id`).all(name) as SkillEventRow[];
}

/** Derived state of one name (draft / approved / revoked per version, retired per name). */
export function skillState(db: Database.Database, name: string): SkillNameState {
  const events: SkillEventFact[] = listSkillEvents(db, name);
  return deriveSkillState(
    name,
    listSkillVersions(db, name).map((v) => v.version),
    events,
  );
}

/** Names with at least one version whose newest name-level event is not `retired` (the `skills.max_names` count). */
export function countActiveSkillNames(db: Database.Database): number {
  return listSkillNames(db).filter((n) => !skillState(db, n).retired).length;
}

export function checkNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  if ([...note].length > MAX_NOTE_CHARS) throw new SkillLedgerError(`note is over ${MAX_NOTE_CHARS} characters`);
  if (NOTE_CONTROL.test(note)) throw new SkillLedgerError("note must be one line without control characters");
  return note;
}

export interface SkillEventInput {
  name: string;
  /** Required for `approved` and `revoked`; must be absent for `retired` and `unretired`. */
  version?: number;
  kind: Exclude<SkillEventKind, "added">;
  note?: string;
  actor?: string;
  at?: string;
}

/**
 * Append one operator audit event for an existing name or version. `added` is written only by `addSkill`, together
 * with its `skill_version` row. Re-approving an approved version is allowed (the newest event decides).
 */
export function appendSkillEvent(db: Database.Database, input: SkillEventInput): SkillEventRow {
  const note = checkNote(input.note);
  const nameLevel = input.kind === "retired" || input.kind === "unretired";
  return db
    .transaction(() => {
      if (nameLevel) {
        if (input.version !== undefined)
          throw new SkillLedgerError(`${input.kind} is a name-level event; omit the version`);
        if (newestSkillVersion(db, input.name) === undefined) throw new SkillLedgerError("unknown skill name");
      } else {
        if (input.version === undefined) throw new SkillLedgerError(`${input.kind} needs a version`);
        if (getSkillVersion(db, input.name, input.version) === undefined)
          throw new SkillLedgerError("unknown skill version");
      }
      const info = db
        .prepare("INSERT INTO skill_event (name, version, kind, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          input.name,
          nameLevel ? null : (input.version ?? null),
          input.kind,
          input.actor ?? SKILL_ACTOR_OPERATOR_CLI,
          note,
          input.at ?? new Date().toISOString(),
        );
      return db
        .prepare(`SELECT ${EVENT_COLS} FROM skill_event WHERE id = ?`)
        .get(info.lastInsertRowid) as SkillEventRow;
    })
    .immediate();
}
