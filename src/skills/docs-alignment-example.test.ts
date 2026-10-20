/**
 * T8.10 (FR-SKL-11, FR-SKL-01, FR-SKL-09, LLD §20.6, §19): `examples/skills/docs-alignment.md` is an ordinary skill
 * file. It goes through the normal skills path, unchanged: `add` validates and stores it as a draft, the operator
 * approves it, and admission resolves it for a run that asks for it; the lifecycle then recognises the pinned entry.
 * It is an example only and is not enabled by default (Linus decision v10 (b)): nothing names it until the operator
 * adds and approves it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger/index.js";
import { admitsDocsAlignment, DOCS_ALIGNMENT_SKILL } from "../lifecycle/docs-alignment.js";
import {
  addSkill,
  appendSkillEvent,
  resolveRunSkills,
  SkillAdmissionError,
  type SkillAdmissionSettings,
  skillResolvedPayload,
  storeCatalog,
} from "./index.js";

const EXAMPLE = path.resolve(import.meta.dirname, "..", "..", "examples", "skills", "docs-alignment.md");

const SETTINGS: SkillAdmissionSettings = {
  defaults: [],
  roles: {},
  allowDraftInTrusted: false,
  maxPerRun: 8,
  maxRunBytes: 65_536,
};

let root: string;
let db: Database.Database;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sb-docs-skill-"));
  db = openLedger(path.join(root, "data"));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const resolve = () =>
  resolveRunSkills(
    { settings: SETTINGS, fields: { skills: [DOCS_ALIGNMENT_SKILL] }, profile: "edit-untrusted" },
    storeCatalog(db),
  );

describe("docs-alignment example skill (T8.10, FR-SKL-11)", () => {
  it("is added, approved and admitted through the normal skills path", () => {
    const added = addSkill(
      db,
      path.join(root, "data"),
      { name: DOCS_ALIGNMENT_SKILL, file: EXAMPLE },
      {
        repositoryRoots: [],
      },
    );
    expect(added).toMatchObject({ kind: "added", name: DOCS_ALIGNMENT_SKILL, version: 1, origin: "operator_file" });

    // A draft is not admitted to an untrusted run: the operator's approval is the gate (FR-SKL-09).
    expect(resolve).toThrow(SkillAdmissionError);

    appendSkillEvent(db, { name: DOCS_ALIGNMENT_SKILL, version: 1, kind: "approved" });
    const set = resolve();
    expect(set.entries).toEqual([
      expect.objectContaining({ name: DOCS_ALIGNMENT_SKILL, version: 1, source: "request" }),
    ]);
    expect(admitsDocsAlignment(skillResolvedPayload(set))).toBe(true);
  });

  it("is not enabled by default: a run that does not ask for it never gets it", () => {
    addSkill(db, path.join(root, "data"), { name: DOCS_ALIGNMENT_SKILL, file: EXAMPLE }, { repositoryRoots: [] });
    appendSkillEvent(db, { name: DOCS_ALIGNMENT_SKILL, version: 1, kind: "approved" });
    const set = resolveRunSkills({ settings: SETTINGS, fields: {}, profile: "edit-untrusted" }, storeCatalog(db));
    expect(set.entries).toEqual([]);
    expect(admitsDocsAlignment(skillResolvedPayload(set))).toBe(false);
  });
});
