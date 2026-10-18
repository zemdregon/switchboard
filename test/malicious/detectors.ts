/**
 * Detectors for the controller leg of the NFR-SEC-03 suite (T3.8). Each one has a positive control in
 * controller.test.ts that plants the thing it looks for and shows it fires.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { type MaliciousFixture, type TokenRole, tg } from "./fixture.js";

/** Roles of every canary token found in `text`. */
export function findTokens(fx: MaliciousFixture, text: string): TokenRole[] {
  return (Object.entries(fx.tokens) as [TokenRole, string][]).filter(([, t]) => text.includes(t)).map(([r]) => r);
}

/**
 * Content hash of a directory tree without following symlinks (names, types, modes, bytes and link targets). Skips a
 * top-level `.git` when `skipGit` is set.
 */
export function treeHash(root: string, skipGit = false): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (skipGit && rel === "" && name === ".git") continue;
      const abs = path.join(dir, name);
      const r = path.posix.join(rel, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) h.update(`L ${r} -> ${readlinkSync(abs)}\n`);
      else if (st.isDirectory()) {
        h.update(`D ${r}\n`);
        walk(abs, r);
      } else {
        h.update(`F ${r} ${(st.mode & 0o777).toString(8)} `);
        h.update(readFileSync(abs));
        h.update("\n");
      }
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** Every regular file's bytes and every symlink's target text in a tree (no link following), concatenated. */
export function treeText(root: string): string {
  if (!existsSync(root)) return "";
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) parts.push(readlinkSync(abs));
      else if (st.isDirectory()) walk(abs);
      else parts.push(readFileSync(abs, "latin1"));
    }
  };
  walk(root);
  return parts.join("\n");
}

/** Refs of a repository (`refname -> objectname`), optionally without the controller's own run branches. */
export function refs(repoOrGitDir: string, opts: { withoutRunBranches?: boolean } = {}): Record<string, string> {
  const out = tg(repoOrGitDir, "for-each-ref", "--format=%(refname) %(objectname)");
  const map: Record<string, string> = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const [name, sha] = line.split(" ") as [string, string];
    if (opts.withoutRunBranches && name.startsWith("refs/heads/switchboard/")) continue;
    map[name] = sha;
  }
  return map;
}

export interface OperatorState {
  readonly refs: Record<string, string>;
  readonly head: string;
  readonly headCommit: string;
  readonly indexEntries: string;
  readonly indexBytes: string;
  readonly status: string;
  readonly files: string;
  readonly config: string;
  readonly hooks: string;
  readonly remoteRefs: Record<string, string>;
}

/**
 * The operator checkout as the controller must leave it (FR-WS-05): refs other than controller run branches, the
 * checked-out branch and commit, the index (entries and raw bytes), status, every working file, `.git/config`,
 * `.git/hooks`, and the refs of the `origin` remote.
 */
export function operatorState(fx: MaliciousFixture): OperatorState {
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  return {
    refs: refs(fx.repo, { withoutRunBranches: true }),
    head: tg(fx.repo, "symbolic-ref", "HEAD"),
    headCommit: tg(fx.repo, "rev-parse", "HEAD"),
    indexEntries: tg(fx.repo, "ls-files", "-s"),
    indexBytes: sha(path.join(fx.repo, ".git", "index")),
    status: tg(fx.repo, "status", "--porcelain=v2", "--untracked-files=all", "--ignored"),
    files: treeHash(fx.repo, true),
    config: readFileSync(path.join(fx.repo, ".git", "config"), "utf8"),
    hooks: treeHash(path.join(fx.repo, ".git", "hooks")),
    remoteRefs: refs(fx.remote),
  };
}

/** Run branches the controller created in the operator repository (must all be `refs/heads/switchboard/...`). */
export function newRefs(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((r) => before[r] === undefined);
}

export const readIfExists = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** Every row of every ledger table, as JSON text (for token scans). */
export function ledgerDump(db: Database.Database): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const dump: Record<string, unknown[]> = {};
  for (const { name } of tables) dump[name] = db.prepare(`SELECT * FROM "${name}"`).all();
  return JSON.stringify(dump);
}

/**
 * T16.11 (TDD §3.16.2 property 6): the names of the captured surfaces (event, span, log, artifact, sink, ...) whose
 * text contains `needle`. Empty means the needle reached none of them.
 */
export function surfacesContaining(capture: Readonly<Record<string, string>>, needle: string): string[] {
  return Object.entries(capture)
    .filter(([, text]) => text.includes(needle))
    .map(([surface]) => surface);
}

/** Every stored artifact of the runs (diff, patch, changed_files, logs, handoff views, ...), as UTF-8 text. */
export async function runArtifactsText(
  ledger: { listArtifactsForRun(runId: string): readonly { sha256: string }[] },
  store: { get(sha256: string): Promise<Buffer> },
  runIds: readonly string[],
): Promise<string> {
  const parts: string[] = [];
  for (const runId of runIds) {
    for (const a of ledger.listArtifactsForRun(runId)) parts.push((await store.get(a.sha256)).toString("utf8"));
  }
  return parts.join("\n");
}

/**
 * Environment names a child reported (fake `env_report` scenario output on stdout) that are outside `allowed`.
 * Returns undefined when the output holds no report (so a missing report cannot pass silently).
 */
/**
 * Names the operating system, not the controller, puts into every process it starts (T4.10): macOS adds
 * `__CF_USER_TEXT_ENCODING` to the environment of each new process whatever `env` was passed to `spawn`.
 */
export const PLATFORM_INJECTED_ENV_NAMES: readonly string[] = ["__CF_USER_TEXT_ENCODING"];

export function envLeaks(stdout: string, allowed: readonly string[]): string[] | undefined {
  for (const line of stdout.split("\n")) {
    try {
      const ev = JSON.parse(line) as { type?: string; text?: string };
      if (ev.type !== "message" || typeof ev.text !== "string") continue;
      const report = JSON.parse(ev.text) as { env_names?: unknown };
      if (!Array.isArray(report.env_names)) continue;
      return (report.env_names as string[]).filter(
        (n) => !allowed.includes(n) && !PLATFORM_INJECTED_ENV_NAMES.includes(n),
      );
    } catch {
      // not a report line
    }
  }
  return undefined;
}
