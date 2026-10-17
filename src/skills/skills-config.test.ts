/**
 * Configured-name warnings and store limit wiring (T16.3; LLD §19.3). Reads the T16.1 store. No provider CLI.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../ledger/index.js";
import { source } from "./fixtures/sources.js";
import {
  type AddSkillOptions,
  addSkill,
  addSkillOptionsFromLimits,
  appendSkillEvent,
  collectConfiguredSkillRefs,
  type SkillConfigView,
  unresolvedConfiguredSkills,
} from "./index.js";

let root: string;
let dataDir: string;
let operatorDir: string;
let db: Database.Database | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sb-skills-cfg-"));
  dataDir = path.join(root, "data");
  operatorDir = path.join(root, "operator");
  mkdirSync(operatorDir);
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
});

function ledger(): Database.Database {
  db = openLedger(dataDir);
  return db;
}

function write(name: string, content: string): string {
  const file = path.join(operatorDir, name);
  writeFileSync(file, content);
  return file;
}

const OPTS: AddSkillOptions = { repositoryRoots: [] };

function addNamed(d: Database.Database, name: string, body: string) {
  const file = write(`${name}.md`, source(`${body}\n`, { name }));
  return addSkill(d, dataDir, { name, file }, OPTS);
}

function eventCount(d: Database.Database): number {
  return (d.prepare("SELECT COUNT(*) AS n FROM skill_event").get() as { n: number }).n;
}

describe("unresolved configured names", () => {
  it("an empty configuration list resolves", () => {
    const d = ledger();
    const view: SkillConfigView = { defaults: [], roles: {}, projects: [{}], clients: [{}] };
    const before = eventCount(d);
    expect(collectConfiguredSkillRefs(view)).toEqual([]);
    expect(unresolvedConfiguredSkills(d, [])).toEqual([]);
    expect(eventCount(d)).toBe(before);
  });

  it("unknown, draft, missing pin, revoked and retired names are warnings and not writes", () => {
    const d = ledger();
    expect(addNamed(d, "security-review", "one").kind).toBe("added");
    const view: SkillConfigView = {
      defaults: ["security-review", "missing-name", "security-review@2", "security-review@1"],
      roles: { reviewer: ["security-review", "security-review@9"] },
      projects: [{}, { skills: { defaults: ["other-skill"], roles: { steward: ["security-review@1"] } } }],
      clients: [{}, { skills: ["no-such-skill"] }, { skills: ["security-review"] }],
    };
    const sites = collectConfiguredSkillRefs(view);
    expect(sites.map((s) => s.at)).toEqual([
      "$.skills.defaults[0]",
      "$.skills.defaults[1]",
      "$.skills.defaults[2]",
      "$.skills.defaults[3]",
      "$.skills.roles.reviewer[0]",
      "$.skills.roles.reviewer[1]",
      "$.projects[1].skills.defaults[0]",
      "$.projects[1].skills.roles.steward[0]",
      "$.mcp_clients[1].skills[0]",
      "$.mcp_clients[2].skills[0]",
    ]);
    // Draft only: the name exists and no version is approved.
    expect(unresolvedConfiguredSkills(d, sites).map((r) => [r.at, r.reason])).toEqual([
      ["$.skills.defaults[0]", "unapproved"],
      ["$.skills.defaults[1]", "unknown"],
      ["$.skills.defaults[2]", "version_unknown"],
      ["$.skills.defaults[3]", "unapproved"],
      ["$.skills.roles.reviewer[0]", "unapproved"],
      ["$.skills.roles.reviewer[1]", "version_unknown"],
      ["$.projects[1].skills.defaults[0]", "unknown"],
      ["$.projects[1].skills.roles.steward[0]", "unapproved"],
      ["$.mcp_clients[1].skills[0]", "unknown"],
      ["$.mcp_clients[2].skills[0]", "unapproved"],
    ]);

    appendSkillEvent(d, { name: "security-review", version: 1, kind: "approved" });
    const approved = unresolvedConfiguredSkills(d, sites);
    expect(approved.map((r) => r.at)).toEqual([
      "$.skills.defaults[1]",
      "$.skills.defaults[2]",
      "$.skills.roles.reviewer[1]",
      "$.projects[1].skills.defaults[0]",
      "$.mcp_clients[1].skills[0]",
    ]);
    expect(approved.map((r) => r.reason)).toEqual([
      "unknown",
      "version_unknown",
      "version_unknown",
      "unknown",
      "unknown",
    ]);

    appendSkillEvent(d, { name: "security-review", version: 1, kind: "revoked" });
    expect(unresolvedConfiguredSkills(d, [{ at: "$.skills.defaults[0]", ref: "security-review" }])).toEqual([
      { at: "$.skills.defaults[0]", ref: "security-review", name: "security-review", reason: "unapproved" },
    ]);
    expect(unresolvedConfiguredSkills(d, [{ at: "$.skills.defaults[3]", ref: "security-review@1" }])[0]?.reason).toBe(
      "unapproved",
    );

    appendSkillEvent(d, { name: "security-review", version: 1, kind: "approved" });
    expect(addNamed(d, "security-review", "two").kind).toBe("added");
    // A later draft does not hide the newest approved version. The pin of the draft does not resolve.
    expect(unresolvedConfiguredSkills(d, [{ at: "$.skills.defaults[0]", ref: "security-review" }])).toEqual([]);
    expect(unresolvedConfiguredSkills(d, [{ at: "$.skills.defaults[2]", ref: "security-review@2" }])[0]?.reason).toBe(
      "unapproved",
    );

    const before = eventCount(d);
    appendSkillEvent(d, { name: "security-review", kind: "retired" });
    const retired = unresolvedConfiguredSkills(d, sites);
    expect(retired.filter((r) => r.name === "security-review").map((r) => r.reason)).toEqual([
      "retired",
      "retired",
      "retired",
      "retired",
      "retired",
      "retired",
      "retired",
    ]);
    expect(eventCount(d)).toBe(before + 1);
  });
});

describe("store limits follow the resolved keys", () => {
  it("max_body_bytes from the resolved keys refuses a body the default would store", () => {
    const file = write("small.md", source("0123456789\n"));
    const input = { name: "security-review", file };
    const wide = ledger();
    expect(addSkill(wide, dataDir, input, OPTS).kind).toBe("added");
    wide.close();
    db = undefined;
    rmSync(dataDir, { recursive: true, force: true });
    const narrow = ledger();
    const wired = addSkillOptionsFromLimits({ maxBodyBytes: 8, maxNames: 64 }, { repositoryRoots: [] });
    expect(addSkill(narrow, dataDir, input, wired)).toMatchObject({ kind: "refused", reason: "SKILL_SIZE" });
  });

  it("max_names from the resolved keys refuses a new name past the cap", () => {
    const d = ledger();
    const wired = addSkillOptionsFromLimits({ maxBodyBytes: 32_768, maxNames: 1 }, { repositoryRoots: [] });
    const first = write("one.md", source("one\n", { name: "security-review" }));
    const second = write("two.md", source("two\n", { name: "other-skill" }));
    expect(addSkill(d, dataDir, { name: "security-review", file: first }, wired).kind).toBe("added");
    expect(addSkill(d, dataDir, { name: "other-skill", file: second }, wired)).toMatchObject({
      kind: "refused",
      reason: "SKILL_LIMIT",
    });
    expect(addNamed(d, "other-skill", "two more").kind).toBe("added");
  });
});
