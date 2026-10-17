/**
 * Operator CLI for skills (T16.2; FR-SKL-09, FR-OPS-01, LLD §19.10, ADR-0005). Every test runs `main` against a
 * temporary data directory; no provider CLI is installed or called.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry } from "../adapters/index.js";
import { createLedger, LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { BODY_CANARY, source } from "../skills/fixtures/sources.js";
import { unifiedDiff } from "../skills/index.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let tmp: string;
let dataDir: string;
let configPath: string;
let repos: string;
let contextDir: string;
let operatorDir: string;

const PIN = new Date("2026-10-17T00:00:00.000Z");

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [repos],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      projects: [
        {
          id: "web-app",
          name: "Web app",
          contexts: [{ id: "main", kind: "repository", path: contextDir, base_ref: "main" }],
        },
      ],
      ...extra,
    }),
  );
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-skills-cli-")));
  repos = path.join(tmp, "repos");
  contextDir = path.join(tmp, "context-repo");
  operatorDir = path.join(tmp, "operator");
  for (const d of [repos, contextDir, operatorDir]) mkdirSync(d);
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeConfig();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[], extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "tester",
    now: () => PIN,
    ...extra,
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

function writeSource(name: string, body: string, dir = operatorDir, front: Record<string, string> = {}): string {
  const file = path.join(dir, `${name}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, source(body, { name, ...front }));
  return file;
}

/** Every row of every table, plus the data directory's files outside the ledger (the "ledger diff"). */
function snapshot(): { tables: Record<string, unknown[]>; files: string[] } {
  const db = new Database(path.join(dataDir, LEDGER_FILE_NAME), { readonly: true });
  try {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    const tables: Record<string, unknown[]> = {};
    for (const n of names) tables[n] = db.prepare(`SELECT * FROM "${n}"`).all();
    const files = (readdirSync(dataDir, { recursive: true }) as string[])
      .filter((f) => !f.startsWith(LEDGER_FILE_NAME))
      .sort();
    return { tables, files };
  } finally {
    db.close();
  }
}

function changedTables(a: Record<string, unknown[]>, b: Record<string, unknown[]>): string[] {
  return Object.keys({ ...a, ...b })
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();
}

/** Create the ledger first so a snapshot before the first command is possible. */
function initLedger(): void {
  openLedger(dataDir).close();
}

describe("skills add (LLD §19.1, §19.10)", () => {
  it("stores a draft version, prints <name>@<n>, and writes only skill_version, skill_event and the content file", async () => {
    initLedger();
    const before = snapshot();
    const r = await run(["skills", "add", "security-review", "--file", writeSource("security-review", "one\n")]);
    expect(r).toMatchObject({ code: 0, out: "security-review@1\n", err: "" });
    const after = snapshot();
    expect(changedTables(before.tables, after.tables)).toEqual(["skill_event", "skill_version"]);
    expect(after.tables.skill_version).toMatchObject([
      { name: "security-review", version: 1, origin: "operator_file", created_at: PIN.toISOString() },
    ]);
    expect(after.tables.skill_event).toMatchObject([
      { name: "security-review", version: 1, kind: "added", actor: "operator_cli" },
    ]);
    const sha = (after.tables.skill_version as { sha256: string }[])[0]?.sha256;
    const added = after.files.filter((f) => !before.files.includes(f));
    expect(added.sort()).toEqual(["skills", path.join("skills", `${sha}.md`)].sort());

    const second = await run([
      "skills",
      "add",
      "security-review",
      "--file",
      writeSource("security-review", "two\n"),
      "--note",
      "tightened",
      "--json",
    ]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out)).toMatchObject({ outcome: "added", name: "security-review", version: 2 });
  });

  it("SKILL_UNCHANGED exits 0 with a message and adds nothing", async () => {
    const file = writeSource("security-review", "same\n");
    expect((await run(["skills", "add", "security-review", "--file", file])).code).toBe(0);
    const before = snapshot();
    // Trailing spaces and CRLF canonicalise to the same text.
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "  \r\n"));
    const r = await run(["skills", "add", "security-review", "--file", file]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("security-review@1 already has this content; no version added (SKILL_UNCHANGED)");
    expect(snapshot()).toEqual(before);
  });

  it("a refusal exits 65 with one reason and leaves no row and no file", async () => {
    initLedger();
    const before = snapshot();
    const marker = writeSource("security-review", "text [end of operator skills] more\n");
    const r = await run(["skills", "add", "security-review", "--file", marker]);
    expect(r.code).toBe(65);
    expect(r.out).toBe("");
    expect(r.err).toBe(
      "switchboard: skills add refused: SKILL_MARKER: skill contains one of Switchboard's own prompt delimiters\n",
    );
    const j = await run(["skills", "add", "security-review", "--file", marker, "--json"]);
    expect(j.code).toBe(65);
    expect(JSON.parse(j.out)).toEqual({
      schema_version: 1,
      error: {
        code: "REFUSED",
        reason: "SKILL_MARKER",
        message: "skill contains one of Switchboard's own prompt delimiters",
      },
    });
    // The front matter name must equal the CLI name.
    const other = await run(["skills", "add", "other-name", "--file", writeSource("security-review", "x\n")]);
    expect(other.code).toBe(65);
    expect(other.err).toContain("SKILL_FRONT_MATTER_KEY");
    expect(snapshot()).toEqual(before);
  });

  it("refuses a source inside an allowed root or project context without --from-repository, and marks it repository_path with it", async () => {
    initLedger();
    const before = snapshot();
    const inRoot = writeSource("security-review", "repo text\n", repos);
    const inContext = writeSource("ctx-skill", "context text\n", contextDir);
    // A symlink outside every root that resolves into one is refused too (LLD §19.1: after symlinks).
    const link = path.join(operatorDir, "linked.md");
    symlinkSync(inRoot, link);
    for (const [name, file] of [
      ["security-review", inRoot],
      ["ctx-skill", inContext],
      ["security-review", link],
    ] as const) {
      const r = await run(["skills", "add", name, "--file", file]);
      expect(r.code).toBe(65);
      expect(r.err).toContain("SKILL_REPOSITORY_SOURCE");
    }
    expect(snapshot()).toEqual(before);

    const ok = await run(["skills", "add", "security-review", "--file", link, "--from-repository", "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ outcome: "added", origin: "repository_path" });
    const ctx = await run(["skills", "add", "ctx-skill", "--file", inContext, "--from-repository"]);
    expect(ctx).toMatchObject({ code: 0, out: "ctx-skill@1\n" });
    const list = JSON.parse((await run(["skills", "list", "--json"])).out);
    expect(list.skills.map((s: { name: string; origin: string }) => [s.name, s.origin])).toEqual([
      ["ctx-skill", "repository_path"],
      ["security-review", "repository_path"],
    ]);
  });

  it("usage errors: missing --file, a bad name, a note over 280 characters, flags on the wrong subcommand", async () => {
    const file = writeSource("security-review", "x\n");
    expect((await run(["skills", "add", "security-review"])).code).toBe(2);
    expect((await run(["skills", "add", "Bad_Name", "--file", file])).code).toBe(2);
    const long = await run(["skills", "add", "security-review", "--file", file, "--note", "n".repeat(281)]);
    expect(long.code).toBe(2);
    expect(long.err).toContain("--note is at most 280 characters");
    expect((await run(["skills", "add", "security-review", "--file", file, "--note", "n".repeat(280)])).code).toBe(0);
    expect((await run(["skills", "list", "--body"])).code).toBe(2);
    expect((await run(["skills", "retire", "security-review", "--note", "x"])).code).toBe(2);
    expect((await run(["runs", "list", "--all"])).code).toBe(2);
    expect((await run(["skills", "nope"])).code).toBe(2);
    expect((await run(["skills", "add", "security-review", "--file", path.join(tmp, "missing.md")])).code).toBe(1);
  });
});

describe("skills list, show, approve, revoke, retire, unretire, diff", () => {
  it("list on a data directory without a ledger is empty and creates nothing", async () => {
    const r = await run(["skills", "list"]);
    expect(r).toMatchObject({ code: 0, out: "no skills\n" });
    expect(JSON.parse((await run(["skills", "list", "--json"])).out)).toEqual({ schema_version: 1, skills: [] });
    expect(existsSync(path.join(dataDir, LEDGER_FILE_NAME))).toBe(false);
    expect((await run(["skills", "show", "security-review"])).code).toBe(1);
  });

  it("each state change is an event: output, exit codes and the ledger diff", async () => {
    await run(["skills", "add", "security-review", "--file", writeSource("security-review", "one\n")]);
    await run(["skills", "add", "security-review", "--file", writeSource("security-review", "two\n")]);
    const before = snapshot();

    const steps: [string[], string][] = [
      [
        ["skills", "approve", "security-review@1", "--note", "looked fine"],
        "security-review@1: approved (now approved)\n",
      ],
      [
        ["skills", "revoke", "security-review@1"],
        "security-review@1: revoked (now revoked); runs already admitted keep their delivery\n",
      ],
      [["skills", "approve", "security-review@2"], "security-review@2: approved (now approved)\n"],
      [
        ["skills", "retire", "security-review"],
        "security-review: retired (now retired); it resolves to nothing for new runs\n",
      ],
    ];
    for (const [args, text] of steps) expect(await run(args)).toEqual({ code: 0, out: text, err: "" });
    const mid = snapshot();
    expect(changedTables(before.tables, mid.tables)).toEqual(["skill_event"]);
    expect(mid.files).toEqual(before.files);
    expect(mid.tables.skill_event?.slice(-4)).toMatchObject([
      { version: 1, kind: "approved", note: "looked fine", actor: "operator_cli" },
      { version: 1, kind: "revoked", note: null },
      { version: 2, kind: "approved" },
      { version: null, kind: "retired" },
    ]);

    expect((await run(["skills", "list"])).out).toBe("no skills\n");
    const all = await run(["skills", "list", "--all"]);
    expect(all.out).toMatch(
      /^security-review@2 {2}approved \(retired\) {2}operator_file {2}\d+ bytes {2}[0-9a-f]{12}\n$/u,
    );
    expect(await run(["skills", "unretire", "security-review"])).toEqual({
      code: 0,
      out: "security-review: unretired (now active)\n",
      err: "",
    });
    expect((await run(["skills", "list"])).out).toMatch(/^security-review@2 {2}approved {2}/u);

    // Unknown names and versions are NOT_FOUND (exit 1); a missing @n is a usage error.
    const unknown = await run(["skills", "approve", "security-review@9", "--json"]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.out).error).toEqual({ code: "NOT_FOUND", message: "unknown skill security-review@9" });
    expect((await run(["skills", "retire", "no-such-skill"])).code).toBe(1);
    expect((await run(["skills", "approve", "security-review"])).code).toBe(2);
    expect((await run(["skills", "revoke", "security-review@1", "--note", "x".repeat(281)])).code).toBe(2);
  });

  it("show prints metadata and events and no body without --body", async () => {
    await run([
      "skills",
      "add",
      "security-review",
      "--file",
      writeSource("security-review", `# Review\n\n${BODY_CANARY}\n`),
      "--note",
      "first",
    ]);
    const plain = await run(["skills", "show", "security-review"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("Skill security-review");
    expect(plain.out).toContain("@1  draft  operator_file");
    expect(plain.out).toContain("description: Review the change before it is published.");
    expect(plain.out).toMatch(/added @1 {2}by operator_cli {2}note: first/u);
    expect(plain.out).not.toContain(BODY_CANARY);
    const plainJson = JSON.parse((await run(["skills", "show", "security-review@1", "--json"])).out);
    expect(plainJson).not.toHaveProperty("body");
    expect(JSON.stringify(plainJson)).not.toContain(BODY_CANARY);

    const body = await run(["skills", "show", "security-review@1", "--body"]);
    expect(body.code).toBe(0);
    expect(body.out).toContain(`Body (@1):\n# Review\n\n${BODY_CANARY}\n`);
    expect(body.out).not.toContain("Body (@1):\n---");
    expect(JSON.parse((await run(["skills", "show", "security-review", "--body", "--json"])).out)).toMatchObject({
      body_version: 1,
      body: `# Review\n\n${BODY_CANARY}\n`,
    });
    expect((await run(["skills", "show", "security-review@2"])).code).toBe(1);
  });

  it("diff prints a line diff of two versions' canonical text", async () => {
    await run(["skills", "add", "security-review", "--file", writeSource("security-review", "a\nb\nc\n")]);
    await run(["skills", "add", "security-review", "--file", writeSource("security-review", "a\nB\nc\nd\n")]);
    const r = await run(["skills", "diff", "security-review@1", "security-review@2"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "--- security-review@1",
        "+++ security-review@2",
        "@@ -3,5 +3,6 @@",
        " description: Review the change before it is published.",
        " ---",
        " a",
        "-b",
        "+B",
        " c",
        "+d",
        "",
      ].join("\n"),
    );
    expect((await run(["skills", "diff", "security-review@1", "security-review@1"])).out).toBe(
      "security-review@1 and @1 have identical canonical text\n",
    );
    expect((await run(["skills", "diff", "security-review@1", "security-review@3"])).code).toBe(1);
    expect((await run(["skills", "diff", "security-review@1", "other-name@1"])).code).toBe(2);
  });
});

describe("unifiedDiff", () => {
  it("separates distant changes into hunks and handles empty sides", () => {
    const a = `${Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n")}\n`;
    const b = a.replace("l1\n", "x1\n").replace("l18\n", "x18\n");
    const d = unifiedDiff(a, b, "a", "b");
    expect(d.match(/^@@/gmu)).toHaveLength(2);
    expect(d).toContain("@@ -1,5 +1,5 @@\n l0\n-l1\n+x1\n");
    expect(unifiedDiff("", "x\n", "a", "b")).toBe("--- a\n+++ b\n@@ -0,0 +1,1 @@\n+x\n");
    expect(unifiedDiff("x\n", "x\n", "a", "b")).toBe("");
  });
});

describe("doctor skills line (LLD §19.10)", () => {
  const fakeOnly = () => new AdapterRegistry().register(new FakeAdapter());
  const skillsCheck = async () => {
    const r = await run(["doctor", "--json"], { adapters: fakeOnly() });
    return (JSON.parse(r.out).checks as { id: string; status: string; detail: string }[]).find(
      (c) => c.id === "skills",
    );
  };

  it("says disabled with zero counts when nothing is configured", async () => {
    expect(await skillsCheck()).toEqual({
      id: "skills",
      label: "Skills",
      status: "ok",
      detail: "disabled; 0 approved and 0 draft version(s)",
    });
  });

  it("names configured skills that do not resolve and runs whose skill removal failed", async () => {
    writeConfig({
      skills: {
        enabled: true,
        defaults: ["security-review", "missing-skill"],
        roles: { reviewer: ["security-review@2"] },
      },
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted", skills: ["draft-only"] }],
    });
    // Before any ledger exists every configured name is unknown.
    expect((await skillsCheck())?.detail).toBe(
      "enabled; 0 approved and 0 draft version(s); 4 configured name(s) do not resolve: " +
        "$.skills.defaults[0] security-review (unknown), $.skills.defaults[1] missing-skill (unknown), " +
        "$.skills.roles.reviewer[0] security-review@2 (unknown), $.mcp_clients[0].skills[0] draft-only (unknown)",
    );
    await run(["skills", "add", "security-review", "--file", writeSource("security-review", "one\n")]);
    await run(["skills", "approve", "security-review@1"]);
    await run(["skills", "add", "draft-only", "--file", writeSource("draft-only", "d\n")]);

    const db = openLedger(dataDir);
    const ledger = createLedger(db);
    const s = ledger.createMetaSession({ objective: "o" });
    const runRow = ledger.createRun({
      metaSessionId: s.id,
      state: "SUCCEEDED",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c1",
      provider: "fake",
    });
    const sha = (
      db.prepare("SELECT sha256 FROM skill_version WHERE name = 'security-review'").get() as { sha256: string }
    ).sha256;
    db.prepare(
      `INSERT INTO run_skill (run_id, position, name, version, sha256, source, delivery, native_path, removal)
       VALUES (?, 0, 'security-review', 1, ?, 'global_default', 'native', '.claude/skills/x/SKILL.md', 'failed')`,
    ).run(runRow.id, sha);
    db.close();

    const c = await skillsCheck();
    expect(c?.status).toBe("warn");
    expect(c?.detail).toBe(
      "enabled; 1 approved and 1 draft version(s); 3 configured name(s) do not resolve: " +
        "$.skills.defaults[1] missing-skill (unknown), $.skills.roles.reviewer[0] security-review@2 (version_unknown), " +
        `$.mcp_clients[0].skills[0] draft-only (unapproved); skill removal failed in run(s): ${runRow.id}`,
    );
    // A warning, not a failure.
    expect((await run(["doctor"], { adapters: fakeOnly() })).code).toBe(0);
  });
});

describe("runs show lists the run's skills (LLD §19.10)", () => {
  it("prints name, version, hash prefix, mode and removal from run_skill, and nothing for a run without skills", async () => {
    const db = openLedger(dataDir);
    const ledger = createLedger(db);
    const s = ledger.createMetaSession({ objective: "o" });
    const mk = () =>
      ledger.createRun({
        metaSessionId: s.id,
        state: "SUCCEEDED",
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: `h${Math.random()}`,
        clientId: "c1",
        provider: "fake",
      }).id;
    const withSkills = mk();
    const without = mk();
    const sha1 = "a".repeat(64);
    const sha2 = "b".repeat(64);
    db.prepare(
      `INSERT INTO run_skill (run_id, position, name, version, sha256, source, delivery, native_path, removal)
       VALUES (?, 0, 'security-review', 3, ?, 'global_default', 'prompt_prefix', NULL, 'not_needed'),
              (?, 1, 'style-guide', 1, ?, 'request', 'native', '.claude/skills/style-guide/SKILL.md', 'verified')`,
    ).run(withSkills, sha1, withSkills, sha2);
    db.close();

    const text = await run(["runs", "show", withSkills]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(
      [
        "Skills (FR-SKL-09):",
        `  security-review@3  ${"a".repeat(12)}  prompt_prefix  removal not_needed`,
        `  style-guide@1  ${"b".repeat(12)}  native .claude/skills/style-guide/SKILL.md  removal verified`,
      ].join("\n"),
    );
    const j = JSON.parse((await run(["runs", "show", withSkills, "--json"])).out);
    expect(j.skills).toEqual([
      {
        position: 0,
        name: "security-review",
        version: 3,
        sha256: sha1,
        source: "global_default",
        delivery: "prompt_prefix",
        native_path: null,
        removal: "not_needed",
      },
      {
        position: 1,
        name: "style-guide",
        version: 1,
        sha256: sha2,
        source: "request",
        delivery: "native",
        native_path: ".claude/skills/style-guide/SKILL.md",
        removal: "verified",
      },
    ]);
    const plain = await run(["runs", "show", without, "--json"]);
    expect(JSON.parse(plain.out)).not.toHaveProperty("skills");
    expect((await run(["runs", "show", without])).out).not.toContain("Skills (");
  });
});
