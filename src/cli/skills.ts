/**
 * `switchboard skills list|show|add|approve|revoke|retire|unretire|diff` (T16.2; FR-SKL-09, FR-OPS-01, LLD §19.10,
 * ADR-0056 items 2 and 3).
 *
 * ADR-0005: the commands are short-lived and write only operator records (`skill_version`, `skill_event`) and the
 * content file `<data_dir>/skills/<sha256>.md`. They need no data-directory lock: both tables are append-only and a
 * running daemon only reads them at admission. `list`, `show` and `diff` open the ledger read-only and never create it.
 *
 * Exit codes: an `add` refusal is 65 with one reason (LLD §19.1); `SKILL_UNCHANGED` is 0 with a message. Unknown names
 * and versions are `NOT_FOUND` (1); a malformed `<name>@<n>` or a note over 280 characters is a usage error (2).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import {
  type AddSkillResult,
  addSkill,
  addSkillOptionsFromLimits,
  appendSkillEvent,
  collectConfiguredSkillRefs,
  getSkillVersion,
  hasSkillTables,
  listSkillEvents,
  listSkillNames,
  listSkillVersions,
  MAX_NOTE_CHARS,
  newestSkillVersion,
  readSkillContent,
  runsWithFailedSkillRemoval,
  SKILL_NAME,
  type SkillEventRow,
  type SkillStoreCounts,
  type SkillVersionRow,
  type SkillVersionState,
  skillState,
  skillStoreCounts,
  unifiedDiff,
  unresolvedConfiguredSkills,
} from "../skills/index.js";
import type { DoctorCheck } from "./doctor.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";

/** `add` refusal exit code (LLD §19.1; sysexits `EX_DATAERR`). */
export const SKILL_REFUSED_EXIT = 65;

/** Hash prefix length in text output, the same 12 hex as the `switchboard.skills.hashes` span attribute (LLD §19.11). */
const HASH_PREFIX = 12;

export class UnknownSkillError extends Error {
  override readonly name = "UnknownSkillError";
}

export interface SkillsFlags {
  readonly all?: boolean;
  readonly body?: boolean;
  readonly file?: string;
  readonly fromRepository?: boolean;
  readonly note?: string;
}

/** What `main` writes: `data` with `--json`, else `text` (to stderr when `code` is not 0). */
export interface SkillsOutcome {
  readonly code: number;
  readonly data: Record<string, unknown>;
  readonly text: string;
}

const SKILL_REF = /^([a-z][a-z0-9-]{1,47})@([1-9][0-9]{0,5})$/u;

function parseName(arg: string | undefined, what: string): string {
  if (arg === undefined || !SKILL_NAME.test(arg))
    throw new UsageError(`${what} requires a skill name (${SKILL_NAME.source})`);
  return arg;
}

function parseRef(arg: string | undefined, what: string): { name: string; version: number } {
  const m = arg === undefined ? null : SKILL_REF.exec(arg);
  if (!m) throw new UsageError(`${what} requires <name>@<n>`);
  return { name: m[1] as string, version: Number(m[2]) };
}

/** `show` takes `<name>` or `<name>@<n>`. */
function parseOptionalRef(arg: string | undefined): { name: string; version?: number } {
  if (arg?.includes("@")) return parseRef(arg, "skills show");
  return { name: parseName(arg, "skills show") };
}

function checkNoteFlag(note: string | undefined): void {
  if (note === undefined) return;
  if ([...note].length > MAX_NOTE_CHARS) throw new UsageError(`--note is at most ${MAX_NOTE_CHARS} characters`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an operator note is one line of text
  if (/[\u0000-\u001F\u007F]/u.test(note)) throw new UsageError("--note must be one line without control characters");
}

function config(io: CliIo, argv: readonly string[]): ResolvedConfig {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
}

/** Read-only handle, or undefined when there is no ledger or it predates the skill tables. Never creates files. */
function openReadOnly(dataDir: string): Database.Database | undefined {
  const file = path.join(dataDir, LEDGER_FILE_NAME);
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  if (!hasSkillTables(db)) {
    db.close();
    return undefined;
  }
  return db;
}

function withRead<T>(
  io: CliIo,
  argv: readonly string[],
  empty: () => T,
  fn: (db: Database.Database, dataDir: string) => T,
): T {
  const dataDir = config(io, argv).dataDir;
  const db = openReadOnly(dataDir);
  if (!db) return empty();
  try {
    return fn(db, dataDir);
  } finally {
    db.close();
  }
}

/** The configured project context roots and `allowed_roots` entries (LLD §19.1 `SKILL_REPOSITORY_SOURCE`). */
export function repositoryRoots(cfg: ResolvedConfig): string[] {
  return [...cfg.allowedRoots, ...cfg.projects.flatMap((p) => p.contexts.map((c) => c.path))];
}

const ok = (data: Record<string, unknown>, text: string): SkillsOutcome => ({
  code: 0,
  data: { schema_version: JSON_SCHEMA_VERSION, ...data },
  text,
});

export interface SkillListEntry {
  name: string;
  version: number;
  state: SkillVersionState;
  retired: boolean;
  origin: string;
  size_bytes: number;
  sha256: string;
}

function listSkills(io: CliIo, argv: readonly string[], all: boolean): SkillsOutcome {
  const skills = withRead<SkillListEntry[]>(
    io,
    argv,
    () => [],
    (db) => {
      const out: SkillListEntry[] = [];
      for (const name of listSkillNames(db)) {
        const st = skillState(db, name);
        if (st.retired && !all) continue;
        const v = newestSkillVersion(db, name) as SkillVersionRow;
        out.push({
          name,
          version: v.version,
          state: st.versions.find((x) => x.version === v.version)?.state ?? "draft",
          retired: st.retired,
          origin: v.origin,
          size_bytes: v.size_bytes,
          sha256: v.sha256,
        });
      }
      return out;
    },
  );
  const text =
    skills.length === 0
      ? "no skills\n"
      : `${skills
          .map(
            (s) =>
              `${s.name}@${s.version}  ${s.state}${s.retired ? " (retired)" : ""}  ${s.origin}  ${s.size_bytes} bytes  ${s.sha256.slice(0, HASH_PREFIX)}`,
          )
          .join("\n")}\n`;
  return ok({ skills }, text);
}

interface ShownVersion extends Omit<SkillVersionRow, "applies_to"> {
  applies_to: string[] | null;
  state: SkillVersionState;
}

function bodyOf(text: string): string {
  // Canonical text is `---\n<front matter>---\n<body>` (LLD §19.1); the front matter has no `---` line of its own.
  const close = text.indexOf("\n---\n");
  return close < 0 ? text : text.slice(close + 5);
}

function showSkill(io: CliIo, argv: readonly string[], arg: string | undefined, withBody: boolean): SkillsOutcome {
  const ref = parseOptionalRef(arg);
  const detail = withRead(
    io,
    argv,
    () => undefined,
    (db, dataDir) => {
      const st = skillState(db, ref.name);
      if (st.versions.length === 0) return undefined;
      const rows = listSkillVersions(db, ref.name).filter(
        (v) => ref.version === undefined || v.version === ref.version,
      );
      if (rows.length === 0) return undefined;
      const versions: ShownVersion[] = rows.map((v) => ({
        ...v,
        applies_to: v.applies_to === null ? null : (JSON.parse(v.applies_to) as string[]),
        state: st.versions.find((x) => x.version === v.version)?.state ?? "draft",
      }));
      const events: SkillEventRow[] = listSkillEvents(db, ref.name).filter(
        (e) => ref.version === undefined || e.version === null || e.version === ref.version,
      );
      const shown = versions[versions.length - 1] as ShownVersion;
      return {
        name: ref.name,
        retired: st.retired,
        versions,
        events,
        ...(withBody ? { body_version: shown.version, body: bodyOf(readSkillContent(dataDir, shown.sha256)) } : {}),
      };
    },
  );
  if (!detail) throw new UnknownSkillError(`unknown skill ${arg ?? ""}`);
  const lines = [`Skill ${detail.name}${detail.retired ? " (retired)" : ""}`];
  for (const v of detail.versions) {
    lines.push(
      `  @${v.version}  ${v.state}  ${v.origin}  ${v.size_bytes} bytes  sha256 ${v.sha256}  ${v.created_at}`,
      `      description: ${v.description}`,
      `      providers:   ${v.applies_to === null ? "all" : v.applies_to.join(", ")}`,
    );
  }
  lines.push("", "Events:");
  for (const e of detail.events) {
    lines.push(
      `  ${String(e.id).padStart(3)}  ${e.at}  ${e.kind}${e.version === null ? "" : ` @${e.version}`}  by ${e.actor}${e.note === null ? "" : `  note: ${e.note}`}`,
    );
  }
  let text = `${lines.join("\n")}\n`;
  if (detail.body !== undefined) text += `\nBody (@${detail.body_version}):\n${detail.body}`;
  return ok(detail, text);
}

function addOutcome(r: AddSkillResult): SkillsOutcome {
  if (r.kind === "refused") {
    return {
      code: SKILL_REFUSED_EXIT,
      data: { schema_version: JSON_SCHEMA_VERSION, error: { code: "REFUSED", reason: r.reason, message: r.message } },
      text: `switchboard: skills add refused: ${r.reason}: ${r.message}\n`,
    };
  }
  if (r.kind === "unchanged") {
    return ok(
      { outcome: "unchanged", reason: r.reason, name: r.name, version: r.version, sha256: r.sha256 },
      `${r.message} (${r.reason})\n`,
    );
  }
  return ok(
    { outcome: "added", name: r.name, version: r.version, sha256: r.sha256, origin: r.origin },
    `${r.name}@${r.version}\n`,
  );
}

function add(io: CliIo, argv: readonly string[], rest: readonly string[], flags: SkillsFlags): SkillsOutcome {
  if (rest.length !== 1) throw new UsageError("skills add requires exactly one skill name");
  const name = parseName(rest[0], "skills add");
  if (flags.file === undefined || flags.file === "") throw new UsageError("skills add requires --file <path>");
  checkNoteFlag(flags.note);
  const cfg = config(io, argv);
  const file = path.resolve(flags.file);
  if (!existsSync(file)) throw new Error(`skill source ${flags.file} does not exist`);
  const db = openLedger(cfg.dataDir);
  try {
    const result = addSkill(
      db,
      cfg.dataDir,
      {
        name,
        file,
        ...(flags.fromRepository === true ? { fromRepository: true } : {}),
        ...(flags.note !== undefined ? { note: flags.note } : {}),
      },
      addSkillOptionsFromLimits(cfg.skills, {
        repositoryRoots: repositoryRoots(cfg),
        sanitizePatterns: cfg.sanitizePatterns,
        ...(io.now ? { now: io.now } : {}),
      }),
    );
    return addOutcome(result);
  } finally {
    db.close();
  }
}

type EventKind = "approved" | "revoked" | "retired" | "unretired";

function record(
  io: CliIo,
  argv: readonly string[],
  kind: EventKind,
  target: { name: string; version?: number },
  note: string | undefined,
): SkillsOutcome {
  checkNoteFlag(note);
  const dataDir = config(io, argv).dataDir;
  // A write needs an existing store: there is nothing to approve or retire in a ledger with no skill tables.
  const probe = openReadOnly(dataDir);
  const known =
    probe !== undefined &&
    (target.version === undefined
      ? newestSkillVersion(probe, target.name) !== undefined
      : getSkillVersion(probe, target.name, target.version) !== undefined);
  probe?.close();
  const label = target.version === undefined ? target.name : `${target.name}@${target.version}`;
  if (!known) throw new UnknownSkillError(`unknown skill ${label}`);
  const db = openLedger(dataDir);
  try {
    const e = appendSkillEvent(db, {
      name: target.name,
      kind,
      ...(target.version !== undefined ? { version: target.version } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(io.now ? { at: io.now().toISOString() } : {}),
    });
    const st = skillState(db, target.name);
    const state =
      target.version === undefined
        ? st.retired
          ? "retired"
          : "active"
        : (st.versions.find((v) => v.version === target.version)?.state ?? "draft");
    const tail =
      kind === "revoked"
        ? "; runs already admitted keep their delivery"
        : kind === "retired"
          ? "; it resolves to nothing for new runs"
          : "";
    return ok({ event: e, state }, `${label}: ${kind} (now ${state})${tail}\n`);
  } finally {
    db.close();
  }
}

function diff(io: CliIo, argv: readonly string[], rest: readonly string[]): SkillsOutcome {
  if (rest.length !== 2) throw new UsageError("skills diff requires <name>@<a> <name>@<b>");
  const a = parseRef(rest[0], "skills diff");
  const b = parseRef(rest[1], "skills diff");
  if (a.name !== b.name) throw new UsageError("skills diff compares two versions of one name");
  const result = withRead(
    io,
    argv,
    () => undefined,
    (db, dataDir) => {
      const va = getSkillVersion(db, a.name, a.version);
      const vb = getSkillVersion(db, b.name, b.version);
      if (!va) return { missing: `${a.name}@${a.version}` };
      if (!vb) return { missing: `${b.name}@${b.version}` };
      return {
        diff: unifiedDiff(
          readSkillContent(dataDir, va.sha256),
          readSkillContent(dataDir, vb.sha256),
          `${a.name}@${a.version}`,
          `${b.name}@${b.version}`,
        ),
      };
    },
  );
  if (result === undefined) throw new UnknownSkillError(`unknown skill ${a.name}`);
  if ("missing" in result) throw new UnknownSkillError(`unknown skill ${result.missing}`);
  return ok(
    { name: a.name, from: a.version, to: b.version, identical: result.diff === "", diff: result.diff },
    result.diff === "" ? `${a.name}@${a.version} and @${b.version} have identical canonical text\n` : result.diff,
  );
}

export function runSkillsCommand(
  io: CliIo,
  argv: readonly string[],
  sub: string | undefined,
  rest: readonly string[],
  flags: SkillsFlags,
): SkillsOutcome {
  const only = (flag: boolean, name: string, cmds: readonly string[]) => {
    if (flag && !cmds.includes(sub ?? ""))
      throw new UsageError(`${name} is only valid with skills ${cmds.join(" or ")}`);
  };
  only(flags.all === true, "--all", ["list"]);
  only(flags.body === true, "--body", ["show"]);
  only(flags.file !== undefined, "--file", ["add"]);
  only(flags.fromRepository === true, "--from-repository", ["add"]);
  only(flags.note !== undefined, "--note", ["add", "approve", "revoke"]);
  switch (sub) {
    case "list":
      if (rest.length > 0) throw new UsageError("skills list takes no arguments");
      return listSkills(io, argv, flags.all === true);
    case "show":
      if (rest.length !== 1) throw new UsageError("skills show requires exactly one <name>[@n]");
      return showSkill(io, argv, rest[0], flags.body === true);
    case "add":
      return add(io, argv, rest, flags);
    case "approve":
    case "revoke":
      if (rest.length !== 1) throw new UsageError(`skills ${sub} requires exactly one <name>@<n>`);
      return record(
        io,
        argv,
        sub === "approve" ? "approved" : "revoked",
        parseRef(rest[0], `skills ${sub}`),
        flags.note,
      );
    case "retire":
    case "unretire":
      if (rest.length !== 1) throw new UsageError(`skills ${sub} requires exactly one skill name`);
      return record(
        io,
        argv,
        sub === "retire" ? "retired" : "unretired",
        { name: parseName(rest[0], `skills ${sub}`) },
        undefined,
      );
    case "diff":
      return diff(io, argv, rest);
    default:
      throw new UsageError(
        `unknown skills subcommand ${JSON.stringify(sub ?? "")}; expected list, show, add, approve, revoke, retire, unretire or diff`,
      );
  }
}

/**
 * The `doctor` skills line (LLD §19.10): enabled or not, approved and draft version counts, configured names that do
 * not resolve, and runs with `removal = 'failed'`. Read-only. A warning, never a failure: an unresolved name is a
 * configuration warning (LLD §19.3) and a failed removal is already a needs-attention run.
 */
export function skillsDoctorCheck(cfg: ResolvedConfig): DoctorCheck {
  const sites = collectConfiguredSkillRefs({
    defaults: cfg.skills.defaults,
    roles: cfg.skills.roles,
    projects: cfg.projects.map((p) => (p.skills !== undefined ? { skills: p.skills } : {})),
    clients: [...cfg.mcpClients.values()].map((c) => (c.skills !== undefined ? { skills: c.skills } : {})),
  });
  let counts: SkillStoreCounts = { names: 0, retired_names: 0, versions: { draft: 0, approved: 0, revoked: 0 } };
  let unresolved: { at: string; ref: string; reason: string }[] = sites.map((s) => ({ ...s, reason: "unknown" }));
  let failed: string[] = [];
  let db: Database.Database | undefined;
  try {
    db = openReadOnly(cfg.dataDir);
    if (db) {
      counts = skillStoreCounts(db);
      unresolved = unresolvedConfiguredSkills(db, sites);
      failed = runsWithFailedSkillRemoval(db);
    }
  } catch (err) {
    return {
      id: "skills",
      label: "Skills",
      status: "warn",
      detail: `cannot read the skill store: ${(err as Error).message.split("\n")[0]}`,
    };
  } finally {
    db?.close();
  }
  const parts = [
    cfg.skills.enabled ? "enabled" : "disabled",
    `${counts.versions.approved} approved and ${counts.versions.draft} draft version(s)` +
      (counts.retired_names > 0 ? `, ${counts.retired_names} retired name(s)` : ""),
  ];
  if (unresolved.length > 0) {
    parts.push(
      `${unresolved.length} configured name(s) do not resolve: ${unresolved.map((u) => `${u.at} ${u.ref} (${u.reason})`).join(", ")}`,
    );
  }
  if (failed.length > 0) parts.push(`skill removal failed in run(s): ${failed.join(", ")}`);
  return {
    id: "skills",
    label: "Skills",
    status: unresolved.length > 0 || failed.length > 0 ? "warn" : "ok",
    detail: parts.join("; "),
  };
}
