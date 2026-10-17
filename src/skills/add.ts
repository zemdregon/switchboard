import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  type CanonicalSkill,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  refusal,
  type SkillRefusal,
  validateSkillSource,
} from "./format.js";
import {
  checkNote,
  countActiveSkillNames,
  newestSkillVersion,
  SKILL_ACTOR_OPERATOR_CLI,
  type SkillOrigin,
} from "./ledger.js";
import { discardUnreferenced, writeSkillContent } from "./store.js";

/**
 * `add` for one skill version (T16.1; FR-SKL-01, FR-SKL-02, FR-SKL-10; LLD §19.1, §19.2; ADR-0056 items 1 to 3, 10, 11).
 * The operator CLI (T16.2) maps the result to output and exit codes; the configuration keys (T16.3) arrive as options.
 *
 * Order: repository-source check, content validation, `SKILL_UNCHANGED`, `SKILL_LIMIT`, then the content file, then
 * one IMMEDIATE transaction inserting the `skill_version` row and its `added` event. Every refusal happens before the
 * file is written, so a refused source leaves no file and no row. The checks are repeated inside the transaction; a
 * file this call created for a version that then loses a race is removed again while no row names it.
 */

export interface AddSkillInput {
  /** The CLI `<name>` argument; the front matter `name` must equal it. */
  readonly name: string;
  /** Source path; resolved after symlinks, checked against {@link AddSkillOptions.repositoryRoots} and read from there. */
  readonly file: string;
  /** `--from-repository`: allow a source inside a repository root; the version is then `origin = repository_path`. */
  readonly fromRepository?: boolean;
  readonly note?: string;
  readonly actor?: string;
}

export interface AddSkillOptions {
  /**
   * Configured project context roots and `allowed_roots` entries (LLD §19.1 `SKILL_REPOSITORY_SOURCE`). Injected so the
   * CLI (T16.2) can pass them from the loaded configuration.
   */
  readonly repositoryRoots: readonly string[];
  /** `skills.max_body_bytes` (default 32768) until T16.3 adds the key. */
  readonly maxBodyBytes?: number;
  /** `skills.max_names` (default 64) until T16.3 adds the key. */
  readonly maxNames?: number;
  /** `git.sanitize_patterns`, treated as secret classes (see `ValidateSkillOptions`). */
  readonly sanitizePatterns?: readonly string[];
  readonly now?: () => Date;
}

export interface SkillAdded {
  readonly kind: "added";
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly origin: SkillOrigin;
}

/** LLD §19.1: not an error (exit 0, message only); no version is added. */
export interface SkillUnchanged {
  readonly kind: "unchanged";
  readonly reason: "SKILL_UNCHANGED";
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly message: string;
}

export interface SkillRefused {
  readonly kind: "refused";
  readonly reason: SkillRefusal["reason"];
  readonly message: string;
}

export type AddSkillResult = SkillAdded | SkillUnchanged | SkillRefused;

function refused(r: SkillRefusal): SkillRefused {
  return { kind: "refused", reason: r.reason, message: r.message };
}

function isInside(root: string, target: string): boolean {
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    base = path.resolve(root);
  }
  const rel = path.relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function addSkill(
  db: Database.Database,
  dataDir: string,
  input: AddSkillInput,
  options: AddSkillOptions,
): AddSkillResult {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxNames = options.maxNames ?? DEFAULT_MAX_NAMES;
  const now = options.now ?? (() => new Date());
  const note = checkNote(input.note);

  const source = realpathSync(input.file);
  const inRepository = options.repositoryRoots.some((r) => isInside(r, source));
  if (inRepository && input.fromRepository !== true) {
    return refused(
      refusal(
        "SKILL_REPOSITORY_SOURCE",
        "skill source resolves inside a project context root or allowed root; pass --from-repository to add it",
      ),
    );
  }
  // --from-repository marks the version even outside a root: the operator says it came from a repository (fail closed).
  const origin: SkillOrigin = inRepository || input.fromRepository === true ? "repository_path" : "operator_file";

  // Do not read an arbitrarily large file: canonicalisation can shrink a source only by trailing whitespace and CRs.
  if (statSync(source).size > maxBodyBytes * 4 + 65_536) {
    return refused(refusal("SKILL_SIZE", `skill source file is far over the ${maxBodyBytes}-byte body limit`));
  }
  const checked = validateSkillSource(readFileSync(source), {
    expectedName: input.name,
    maxBodyBytes,
    ...(options.sanitizePatterns ? { sanitizePatterns: options.sanitizePatterns } : {}),
  });
  if (!checked.ok) return refused(checked);
  const skill: CanonicalSkill = checked;

  const gate = (): SkillUnchanged | SkillRefused | { next: number } => {
    const newest = newestSkillVersion(db, skill.name);
    if (newest?.sha256 === skill.sha256) {
      return {
        kind: "unchanged",
        reason: "SKILL_UNCHANGED",
        name: skill.name,
        version: newest.version,
        sha256: skill.sha256,
        message: `${skill.name}@${newest.version} already has this content; no version added`,
      };
    }
    if (newest === undefined && countActiveSkillNames(db) >= maxNames) {
      return refused(refusal("SKILL_LIMIT", `adding '${skill.name}' would exceed skills.max_names (${maxNames})`));
    }
    return { next: (newest?.version ?? 0) + 1 };
  };

  const pre = gate();
  if (!("next" in pre)) return pre;

  const { created } = writeSkillContent(dataDir, skill.sha256, skill.text);
  let result: AddSkillResult;
  try {
    result = db
      .transaction((): AddSkillResult => {
        const g = gate();
        if (!("next" in g)) return g;
        const at = now().toISOString();
        db.prepare(
          `INSERT INTO skill_version (name, version, sha256, size_bytes, description, applies_to, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          skill.name,
          g.next,
          skill.sha256,
          skill.sizeBytes,
          skill.description,
          skill.appliesTo === null ? null : JSON.stringify(skill.appliesTo),
          origin,
          at,
        );
        db.prepare(
          "INSERT INTO skill_event (name, version, kind, actor, note, at) VALUES (?, ?, 'added', ?, ?, ?)",
        ).run(skill.name, g.next, input.actor ?? SKILL_ACTOR_OPERATOR_CLI, note, at);
        return { kind: "added", name: skill.name, version: g.next, sha256: skill.sha256, origin };
      })
      .immediate();
  } catch (err) {
    if (created) discardIfUnreferenced(db, dataDir, skill.sha256);
    throw err;
  }
  if (result.kind !== "added" && created) discardIfUnreferenced(db, dataDir, skill.sha256);
  return result;
}

function discardIfUnreferenced(db: Database.Database, dataDir: string, sha256: string): void {
  if (db.prepare("SELECT 1 FROM skill_version WHERE sha256 = ? LIMIT 1").get(sha256) === undefined) {
    discardUnreferenced(dataDir, sha256);
  }
}
