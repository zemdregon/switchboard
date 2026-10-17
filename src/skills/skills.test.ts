import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import {
  createLedger,
  currentSchemaVersion,
  LEDGER_FILE_NAME,
  MIGRATIONS,
  migrate,
  openLedger,
} from "../ledger/index.js";
import { BODY_CANARY, REFUSAL_FIXTURES, source, VALID } from "./fixtures/sources.js";
import {
  type AddSkillOptions,
  addSkill,
  appendSkillEvent,
  canonicalText,
  deriveSkillState,
  listSkillEvents,
  listSkillVersions,
  newestApprovedVersion,
  readSkillContent,
  SkillLedgerError,
  skillContentPath,
  skillState,
  skillsDir,
  validateSkillSource,
} from "./index.js";

let root: string;
let dataDir: string;
let operatorDir: string;
let repoRoot: string;
let db: Database.Database | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sb-skills-"));
  dataDir = path.join(root, "data");
  operatorDir = path.join(root, "operator");
  repoRoot = path.join(root, "repo");
  mkdirSync(operatorDir);
  mkdirSync(repoRoot);
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

function write(name: string, content: string | Buffer, dir = operatorDir): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

const OPTS: AddSkillOptions = { repositoryRoots: [] };
const optsWithRepo = (): AddSkillOptions => ({ repositoryRoots: [repoRoot] });

function skillRows(d: Database.Database): { versions: unknown[]; events: unknown[] } {
  return {
    versions: d.prepare("SELECT * FROM skill_version").all(),
    events: d.prepare("SELECT * FROM skill_event").all(),
  };
}

function storedFiles(): string[] {
  return existsSync(skillsDir(dataDir)) ? readdirSync(skillsDir(dataDir)) : [];
}

describe("skill source validation (LLD §19.1 refusals)", () => {
  for (const f of REFUSAL_FIXTURES) {
    it(`refuses ${f.label} with ${f.reason}, writing no file and no row`, () => {
      const d = ledger();
      const file = write("skill.md", f.bytes);
      const result = addSkill(
        d,
        dataDir,
        { name: "security-review", file },
        {
          repositoryRoots: [],
          ...(f.maxBodyBytes !== undefined ? { maxBodyBytes: f.maxBodyBytes } : {}),
          ...(f.sanitizePatterns ? { sanitizePatterns: f.sanitizePatterns } : {}),
        },
      );
      expect(result).toMatchObject({ kind: "refused", reason: f.reason });
      expect(skillRows(d)).toEqual({ versions: [], events: [] });
      expect(storedFiles()).toEqual([]);
      const message = JSON.stringify(result);
      if (f.secret) expect(message).not.toContain(f.secret);
      expect(message).not.toContain("Use ");
    });
  }

  it("refuses a source inside a repository root without --from-repository (SKILL_REPOSITORY_SOURCE)", () => {
    const d = ledger();
    const file = write("skill.md", VALID, repoRoot);
    expect(addSkill(d, dataDir, { name: "security-review", file }, optsWithRepo())).toMatchObject({
      kind: "refused",
      reason: "SKILL_REPOSITORY_SOURCE",
    });
    expect(skillRows(d)).toEqual({ versions: [], events: [] });
    expect(storedFiles()).toEqual([]);
  });

  it("resolves symlinks: an operator-path link to a repository file is a repository source", () => {
    const d = ledger();
    const target = write("skill.md", VALID, repoRoot);
    const link = path.join(operatorDir, "link.md");
    symlinkSync(target, link);
    expect(addSkill(d, dataDir, { name: "security-review", file: link }, optsWithRepo())).toMatchObject({
      reason: "SKILL_REPOSITORY_SOURCE",
    });
    expect(storedFiles()).toEqual([]);
  });

  it("adds a repository source with --from-repository as origin repository_path", () => {
    const d = ledger();
    const file = write("skill.md", VALID, repoRoot);
    const r = addSkill(d, dataDir, { name: "security-review", file, fromRepository: true }, optsWithRepo());
    expect(r).toMatchObject({ kind: "added", version: 1, origin: "repository_path" });
    expect(listSkillVersions(d, "security-review")[0]?.origin).toBe("repository_path");
  });

  it("refuses a new name beyond skills.max_names (SKILL_LIMIT), but a new version of a known name is allowed", () => {
    const d = ledger();
    const add = (name: string, body: string) =>
      addSkill(d, dataDir, { name, file: write(`${name}.md`, source(body, { name })) }, { ...OPTS, maxNames: 2 });
    expect(add("skill-a", "a\n").kind).toBe("added");
    expect(add("skill-b", "b\n").kind).toBe("added");
    const before = skillRows(d);
    const filesBefore = storedFiles();
    expect(add("skill-c", "c\n")).toMatchObject({ kind: "refused", reason: "SKILL_LIMIT" });
    expect(skillRows(d)).toEqual(before);
    expect(storedFiles()).toEqual(filesBefore);
    expect(add("skill-a", "a2\n")).toMatchObject({ kind: "added", version: 2 });
    // A retired name frees its slot.
    appendSkillEvent(d, { name: "skill-b", kind: "retired" });
    expect(add("skill-c", "c\n")).toMatchObject({ kind: "added", version: 1 });
  });

  it("accepts the LLD example and re-serialises the front matter in the documented order", () => {
    const r = validateSkillSource(Buffer.from(VALID), { expectedName: "security-review" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.appliesTo).toEqual(["claude-code", "codex"]);
    expect(
      r.text.startsWith(
        "---\nname: security-review\ndescription: Review the change before it is published.\n" +
          "applies_to_providers: [claude-code, codex]\n---\n# Security review\n",
      ),
    ).toBe(true);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/u);
    // The canonical text validates to itself (a stored file is a valid source with the same hash).
    const again = validateSkillSource(Buffer.from(r.text));
    expect(again.ok && again.sha256).toBe(r.sha256);
  });

  it("canonical front matter is a fixed point for quoted descriptions", () => {
    for (const description of [
      '"  Check: #1 risk  "',
      "'say \"no\" #2'",
      '"it\'s fine"',
      '"  padded  "',
      "plain: value#x",
    ]) {
      const r = validateSkillSource(Buffer.from(source("body\n", { description })));
      if (!r.ok) throw new Error(`${description}: ${r.reason}`);
      const again = validateSkillSource(Buffer.from(r.text));
      expect(again.ok && again.text, description).toBe(r.text);
    }
  });
});

describe("canonicalisation (LLD §19.1)", () => {
  const base = source("# Title\n\nLine one\nLine two\n");
  const variants: Record<string, string | Buffer> = {
    CRLF: base.replace(/\n/gu, "\r\n"),
    CR: base.replace(/\n/gu, "\r"),
    BOM: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(base)]),
    "trailing spaces and tabs": base.replace(/\n/gu, "  \t\n"),
    "extra final newlines": `${base}\n\n\n`,
    "no final newline": base.slice(0, -1),
  };

  it("hashes every variant identically", () => {
    const ref = validateSkillSource(Buffer.from(base));
    if (!ref.ok) throw new Error(ref.reason);
    for (const [label, v] of Object.entries(variants)) {
      const r = validateSkillSource(Buffer.isBuffer(v) ? v : Buffer.from(v));
      expect(r.ok && r.sha256, label).toBe(ref.sha256);
    }
    expect(canonicalText(Buffer.from("a \r\nb\t\r\n\r\n"))).toBe("a\nb\n");
  });

  it("adds no version for the same text with CRLF, a BOM or trailing spaces (SKILL_UNCHANGED)", () => {
    const d = ledger();
    const first = addSkill(d, dataDir, { name: "security-review", file: write("s.md", base) }, OPTS);
    expect(first).toMatchObject({ kind: "added", version: 1 });
    for (const [label, v] of Object.entries(variants)) {
      const r = addSkill(d, dataDir, { name: "security-review", file: write(`v.md`, v) }, OPTS);
      expect(r, label).toMatchObject({ kind: "unchanged", reason: "SKILL_UNCHANGED", version: 1 });
    }
    expect(listSkillVersions(d, "security-review")).toHaveLength(1);
    expect(listSkillEvents(d, "security-review").map((e) => e.kind)).toEqual(["added"]);
    expect(storedFiles()).toHaveLength(1);
  });

  it("a changed body adds the next version; returning to old content adds a version that reuses the file", () => {
    const d = ledger();
    const a = source("A\n");
    const b = source("B\n");
    expect(addSkill(d, dataDir, { name: "security-review", file: write("a.md", a) }, OPTS)).toMatchObject({
      version: 1,
    });
    expect(addSkill(d, dataDir, { name: "security-review", file: write("b.md", b) }, OPTS)).toMatchObject({
      version: 2,
    });
    const third = addSkill(d, dataDir, { name: "security-review", file: write("a.md", a) }, OPTS);
    expect(third).toMatchObject({ kind: "added", version: 3 });
    const v = listSkillVersions(d, "security-review");
    expect(v[2]?.sha256).toBe(v[0]?.sha256);
    expect(storedFiles()).toHaveLength(2);
  });
});

describe("content store (LLD §19.2)", () => {
  it("writes <data_dir>/skills/<sha256>.md 0600 in a 0700 directory, with no temporary file left", () => {
    const d = ledger();
    const r = addSkill(d, dataDir, { name: "security-review", file: write("s.md", VALID), note: "first" }, OPTS);
    if (r.kind !== "added") throw new Error(r.kind);
    const file = skillContentPath(dataDir, r.sha256);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(skillsDir(dataDir)).mode & 0o777).toBe(0o700);
    expect(storedFiles()).toEqual([`${r.sha256}.md`]);
    const text = readSkillContent(dataDir, r.sha256);
    expect(text).toContain(BODY_CANARY);
    expect(readFileSync(file, "utf8")).toBe(text);
    const row = listSkillVersions(d, "security-review")[0];
    expect(row).toMatchObject({
      version: 1,
      sha256: r.sha256,
      size_bytes: Buffer.byteLength(text),
      description: "Review the change before it is published.",
      applies_to: '["claude-code","codex"]',
      origin: "operator_file",
    });
    expect(listSkillEvents(d, "security-review")).toMatchObject([
      { version: 1, kind: "added", actor: "operator_cli", note: "first" },
    ]);
  });

  it("no ledger row or result holds the skill body (FR-SKL-10)", () => {
    const d = ledger();
    const r = addSkill(d, dataDir, { name: "security-review", file: write("s.md", VALID) }, OPTS);
    appendSkillEvent(d, { name: "security-review", version: 1, kind: "approved" });
    const dump = JSON.stringify([
      r,
      d.prepare("SELECT * FROM skill_version").all(),
      d.prepare("SELECT * FROM skill_event").all(),
    ]);
    expect(dump).not.toContain(BODY_CANARY);
  });

  it("detects a stored file that no longer matches its hash", () => {
    const d = ledger();
    const r = addSkill(d, dataDir, { name: "security-review", file: write("s.md", VALID) }, OPTS);
    if (r.kind !== "added") throw new Error(r.kind);
    writeFileSync(skillContentPath(dataDir, r.sha256), "tampered\n");
    expect(() => readSkillContent(dataDir, r.sha256)).toThrow(/does not match its hash/u);
  });
});

describe("append-only skill_version and skill_event (migration 0021 triggers)", () => {
  it("refuses UPDATE, DELETE and INSERT OR REPLACE on both tables", () => {
    const d = ledger();
    addSkill(d, dataDir, { name: "security-review", file: write("s.md", VALID) }, OPTS);
    expect(() => d.prepare("UPDATE skill_version SET description = 'x'").run()).toThrow(/append-only/u);
    expect(() => d.prepare("DELETE FROM skill_version").run()).toThrow(/append-only/u);
    expect(() =>
      d
        .prepare(
          `INSERT OR REPLACE INTO skill_version (name, version, sha256, size_bytes, description, origin, created_at)
           VALUES ('security-review', 1, ?, 1, 'x', 'operator_file', 't')`,
        )
        .run("0".repeat(64)),
    ).toThrow(/append-only/u);
    expect(() => d.prepare("UPDATE skill_event SET kind = 'approved'").run()).toThrow(/append-only/u);
    expect(() => d.prepare("DELETE FROM skill_event").run()).toThrow(/append-only/u);
    expect(listSkillVersions(d, "security-review")).toHaveLength(1);
    expect(listSkillEvents(d, "security-review")).toHaveLength(1);
  });

  it("enforces the LLD §19.2 checks", () => {
    const d = ledger();
    const insert = (version: number, sha: string, origin: string) =>
      d
        .prepare(
          `INSERT INTO skill_version (name, version, sha256, size_bytes, description, origin, created_at)
           VALUES ('n', ?, ?, 1, 'd', ?, 't')`,
        )
        .run(version, sha, origin);
    expect(() => insert(0, "0".repeat(64), "operator_file")).toThrow(/CHECK/u);
    expect(() => insert(1, "abc", "operator_file")).toThrow(/CHECK/u);
    expect(() => insert(1, "0".repeat(64), "mcp")).toThrow(/CHECK/u);
    expect(() =>
      d.prepare("INSERT INTO skill_event (name, kind, actor, at) VALUES ('n', 'edited', 'operator_cli', 't')").run(),
    ).toThrow(/CHECK/u);
  });
});

describe("migration 0021", () => {
  it("applies on a fresh ledger", () => {
    const d = ledger();
    expect(currentSchemaVersion(d)).toBeGreaterThanOrEqual(21); // later migrations (0022, T9.13) may follow
    const names = (
      d.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "skill_version",
        "skill_event",
        "run_skill",
        "skill_version_no_update",
        "skill_version_no_delete",
        "skill_event_no_update",
        "skill_event_no_delete",
      ]),
    );
  });

  it("applies on a ledger at the previous version and keeps its rows", () => {
    mkdirSync(dataDir, { recursive: true });
    const d = new Database(path.join(dataDir, LEDGER_FILE_NAME));
    db = d;
    d.pragma("foreign_keys = ON");
    const upTo20 = MIGRATIONS.filter((m) => m.version <= 20);
    expect(migrate(d, undefined, upTo20)).toEqual(upTo20.map((m) => m.version));
    const l = createLedger(d, { ids: createIdGenerator() });
    const session = l.createMetaSession({ objective: "before 0021" });
    const run = l.createRun({
      metaSessionId: session.id,
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c",
    });
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 21),
      ),
    ).toEqual([21]);
    expect(l.getRun(run.id)?.id).toBe(run.id);
    const insertRunSkill = (runId: string, source: string, delivery: string) =>
      d
        .prepare(
          `INSERT INTO run_skill (run_id, position, name, version, sha256, source, delivery)
           VALUES (?, 0, 'security-review', 1, ?, ?, ?)`,
        )
        .run(runId, "0".repeat(64), source, delivery);
    insertRunSkill(run.id, "request", "prompt_prefix");
    expect(() => insertRunSkill("run_missing", "request", "prompt_prefix")).toThrow(/FOREIGN KEY/u);
    expect(() => insertRunSkill(run.id, "mcp", "prompt_prefix")).toThrow(/CHECK|PRIMARY KEY|UNIQUE/u);
    // run_skill is filled in later (T16.6), so it is not append-only.
    d.prepare("UPDATE run_skill SET removal = 'not_needed' WHERE run_id = ?").run(run.id);
    expect(() => d.prepare("UPDATE run_skill SET removal = 'gone'").run()).toThrow(/CHECK/u);
  });
});

describe("state derivation from events (LLD §19.2)", () => {
  it("pure: draft until approved; the newest approved/revoked event decides; retired per name", () => {
    const ev = (
      id: number,
      kind: "added" | "approved" | "revoked" | "retired" | "unretired",
      version: number | null,
    ) => ({
      id,
      name: "s",
      version,
      kind,
    });
    const events = [
      ev(1, "added", 1),
      ev(2, "added", 2),
      ev(3, "approved", 1),
      ev(4, "approved", 2),
      ev(5, "revoked", 2),
    ];
    const state = deriveSkillState("s", [2, 1], events);
    expect(state).toEqual({
      name: "s",
      retired: false,
      versions: [
        { version: 1, state: "approved" },
        { version: 2, state: "revoked" },
      ],
    });
    expect(newestApprovedVersion(state)).toBe(1);
    expect(deriveSkillState("s", [1, 2, 3], [...events, ev(6, "added", 3)]).versions[2]?.state).toBe("draft");
    // Order is by id, not by array position.
    expect(deriveSkillState("s", [2], [ev(9, "approved", 2), ev(7, "revoked", 2)]).versions[0]?.state).toBe("approved");
    const retired = deriveSkillState("s", [1, 2], [...events, ev(6, "retired", null)]);
    expect(retired.retired).toBe(true);
    expect(newestApprovedVersion(retired)).toBeUndefined();
    expect(deriveSkillState("s", [1], [...events, ev(6, "retired", null), ev(7, "unretired", null)]).retired).toBe(
      false,
    );
    // Events of another name are ignored.
    expect(deriveSkillState("t", [1], events).versions[0]?.state).toBe("draft");
  });

  it("ledger: state follows appended events exactly", () => {
    const d = ledger();
    addSkill(d, dataDir, { name: "security-review", file: write("a.md", source("A\n")) }, OPTS);
    addSkill(d, dataDir, { name: "security-review", file: write("b.md", source("B\n")) }, OPTS);
    const states = () => skillState(d, "security-review").versions.map((v) => v.state);
    expect(states()).toEqual(["draft", "draft"]);
    appendSkillEvent(d, { name: "security-review", version: 2, kind: "approved", note: "looks good" });
    expect(states()).toEqual(["draft", "approved"]);
    expect(newestApprovedVersion(skillState(d, "security-review"))).toBe(2);
    appendSkillEvent(d, { name: "security-review", version: 2, kind: "revoked" });
    expect(states()).toEqual(["draft", "revoked"]);
    appendSkillEvent(d, { name: "security-review", version: 1, kind: "approved" });
    expect(newestApprovedVersion(skillState(d, "security-review"))).toBe(1);
    appendSkillEvent(d, { name: "security-review", kind: "retired" });
    expect(skillState(d, "security-review").retired).toBe(true);
    expect(newestApprovedVersion(skillState(d, "security-review"))).toBeUndefined();
    appendSkillEvent(d, { name: "security-review", kind: "unretired" });
    expect(skillState(d, "security-review").retired).toBe(false);
    expect(listSkillEvents(d, "security-review").map((e) => [e.kind, e.version])).toEqual([
      ["added", 1],
      ["added", 2],
      ["approved", 2],
      ["revoked", 2],
      ["approved", 1],
      ["retired", null],
      ["unretired", null],
    ]);
  });

  it("refuses events for unknown names or versions, misplaced versions and bad notes", () => {
    const d = ledger();
    addSkill(d, dataDir, { name: "security-review", file: write("a.md", VALID) }, OPTS);
    expect(() => appendSkillEvent(d, { name: "nope", kind: "retired" })).toThrow(SkillLedgerError);
    expect(() => appendSkillEvent(d, { name: "security-review", version: 9, kind: "approved" })).toThrow(
      SkillLedgerError,
    );
    expect(() => appendSkillEvent(d, { name: "security-review", kind: "approved" })).toThrow(SkillLedgerError);
    expect(() => appendSkillEvent(d, { name: "security-review", version: 1, kind: "retired" })).toThrow(
      SkillLedgerError,
    );
    expect(() =>
      appendSkillEvent(d, { name: "security-review", version: 1, kind: "approved", note: "n".repeat(281) }),
    ).toThrow(SkillLedgerError);
    expect(() =>
      appendSkillEvent(d, { name: "security-review", version: 1, kind: "approved", note: "two\nlines" }),
    ).toThrow(SkillLedgerError);
    expect(listSkillEvents(d, "security-review")).toHaveLength(1);
  });
});
