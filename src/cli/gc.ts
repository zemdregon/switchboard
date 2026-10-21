/**
 * `switchboard gc [--apply]` (T3.12; FR-WS-07, NFR-DATA-01, LLD §5). Operator command around the retention GC core in
 * `src/workspace/gc.ts`. Proposed (Delegated, not owner-approved) safety defaults:
 *
 * - The default is a DRY RUN: it lists what would be collected and changes nothing (no lock, ledger opened read-only).
 * - `--apply` collects, and only when the config sets `retention.days` (`retentionEnabled`); the 30 day default is a
 *   value, not a switch. It refuses (LockError) while a `serve` daemon holds the data-directory lock, and holds the
 *   lock itself while it runs, so no daemon can start mid-collection (ADR-0005).
 * - T10.3 (FR-PRJ-09): when a configured project is `container`, `--apply` also removes the containers of each collected
 *   meta-session's runs, before its worktrees. A runtime that does not answer is skipped with `container_runtime`
 *   saying so (its containers are swept at the next `serve` start, T10.2); a runtime that answers but fails to remove
 *   stops that unit, keeping its worktrees for the next pass.
 * - `--apply` also collects orphans (`collectOrphans`, ADR-0054): the first pass that sees one only marks it; a later
 *   pass removes it once the mark is older than `retention.days`. The dry run only reports them.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ArtifactStore } from "../artifacts/index.js";
import { ConfigError, loadConfig, type ResolvedConfig } from "../config/index.js";
import { type ContainerRuntime, createDockerRuntime } from "../environment/index.js";
import { LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import {
  collectOrphans,
  findOrphans,
  type GcPlan,
  type GcResult,
  planRetentionGc,
  runRetentionGc,
} from "../workspace/index.js";
import { type CliIo, JSON_SCHEMA_VERSION } from "./io.js";

export interface GcReport {
  readonly schema_version: number;
  readonly mode: "dry-run" | "apply";
  readonly retention_days: number;
  /** False when the config does not set `retention.days`: `--apply` is then refused. */
  readonly retention_configured: boolean;
  readonly cutoff: string;
  /** Units that qualify (dry run) or qualified at the start of the pass (apply). */
  readonly units: {
    session_id: string;
    last_activity: string;
    worktrees: number;
    branches: string[];
  }[];
  /** Apply only. */
  readonly collected?: {
    session_id: string;
    containers_removed: string[];
    worktrees_removed: number;
    branches_deleted: string[];
    artifact_files_deleted: number;
    artifact_files_kept: number;
    warnings: string[];
  }[];
  readonly errors?: { session_id: string; step: string; message: string }[];
  /** Apply only, when a `container` project is configured but no runtime answered: containers were not removed. */
  readonly container_runtime?: string;
  /** Orphans the sweep reports after this command (for `--apply`: what is left after removal). */
  readonly orphans: { worktrees: string[]; branches: { repo_root: string; branch: string }[] };
  /** Apply only: orphan removal (LLD §5). An orphan is removed once it has been marked for `retention_days`. */
  readonly orphans_collected?: {
    marked: number;
    waiting: number;
    worktrees_removed: string[];
    branches_removed: { repo_root: string; branch: string }[];
    warnings: string[];
    errors: { target: string; step: string; message: string }[];
  };
}

const toUnits = (plan: GcPlan): GcReport["units"] =>
  plan.units.map((u) => ({
    session_id: u.sessionId,
    last_activity: u.lastActivity,
    worktrees: u.worktrees,
    branches: u.branches,
  }));

export async function runGcCommand(
  io: CliIo,
  argv: readonly string[],
  opts: { readonly apply: boolean; readonly makeRuntime?: () => ContainerRuntime },
): Promise<GcReport> {
  const config: ResolvedConfig = loadConfig({
    argv,
    env: io.env,
    ...(io.homedir ? { homedir: io.homedir } : {}),
  });
  if (opts.apply && !config.retentionEnabled) {
    throw new ConfigError(
      "retention is not configured: set retention.days in the config to enable collection (nothing was changed)",
    );
  }
  const now = (io.now ?? (() => new Date()))();
  const days = config.retention.days;
  const file = path.join(config.dataDir, LEDGER_FILE_NAME);

  if (!opts.apply) {
    if (!existsSync(file)) {
      return emptyReport("dry-run", config, days, now);
    }
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const plan = planRetentionGc({ db, days, now });
      const orphans = await findOrphans({ db, dataDir: config.dataDir });
      return {
        schema_version: JSON_SCHEMA_VERSION,
        mode: "dry-run",
        retention_days: days,
        retention_configured: config.retentionEnabled,
        cutoff: plan.cutoff,
        units: toUnits(plan),
        orphans: orphanView(orphans),
      };
    } finally {
      db.close();
    }
  }

  if (!existsSync(file)) return emptyReport("apply", config, days, now);
  const lock = acquireDataDirLock(config.dataDir); // LockError while a serve daemon holds it
  try {
    const db = openLedger(config.dataDir);
    try {
      let containerRuntime: ContainerRuntime | undefined;
      let runtimeSkipped: string | undefined;
      if (config.projects.some((p) => p.environment.kind === "container")) {
        const runtime = (opts.makeRuntime ?? createDockerRuntime)();
        const info = await runtime.info();
        if (info.available) containerRuntime = runtime;
        else runtimeSkipped = `skipped, no container runtime answered: ${info.detail}`;
      }
      const plan = planRetentionGc({ db, days, now });
      // ADR-0087 item 3: submodule worktrees are detached through their attach records (stores under clone_root).
      const cloneRoot = config.projectSources?.cloneRoot;
      const result: GcResult = await runRetentionGc({
        ...(containerRuntime !== undefined ? { containerRuntime } : {}),
        db,
        artifacts: new ArtifactStore(path.join(config.dataDir, "artifacts")),
        dataDir: config.dataDir,
        days,
        now,
        ...(cloneRoot !== undefined ? { cloneRoot } : {}),
      });
      const o = await collectOrphans({
        db,
        dataDir: config.dataDir,
        days,
        now,
        ...(cloneRoot !== undefined ? { cloneRoot } : {}),
      });
      const orphans = await findOrphans({ db, dataDir: config.dataDir });
      return {
        schema_version: JSON_SCHEMA_VERSION,
        mode: "apply",
        retention_days: days,
        retention_configured: true,
        cutoff: result.cutoff,
        units: toUnits(plan),
        collected: result.collected.map((c) => ({
          session_id: c.sessionId,
          containers_removed: c.containersRemoved,
          worktrees_removed: c.worktreesRemoved,
          branches_deleted: c.branchesDeleted,
          artifact_files_deleted: c.artifactFilesDeleted,
          artifact_files_kept: c.artifactFilesKept,
          warnings: c.warnings,
        })),
        errors: result.errors.map((e) => ({ session_id: e.sessionId, step: e.step, message: e.message })),
        ...(runtimeSkipped !== undefined ? { container_runtime: runtimeSkipped } : {}),
        orphans: orphanView(orphans),
        orphans_collected: {
          marked: o.marked,
          waiting: o.waiting,
          worktrees_removed: o.removedWorktrees,
          branches_removed: o.removedBranches.map((b) => ({ repo_root: b.repoRoot, branch: b.branch })),
          warnings: o.warnings,
          errors: o.errors,
        },
      };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

function orphanView(o: Awaited<ReturnType<typeof findOrphans>>): GcReport["orphans"] {
  return {
    worktrees: o.worktrees,
    branches: o.branches.map((b) => ({ repo_root: b.repoRoot, branch: b.branch })),
  };
}

function emptyReport(mode: GcReport["mode"], config: ResolvedConfig, days: number, now: Date): GcReport {
  return {
    schema_version: JSON_SCHEMA_VERSION,
    mode,
    retention_days: days,
    retention_configured: config.retentionEnabled,
    cutoff: new Date(now.getTime() - days * 86_400_000).toISOString(),
    units: [],
    ...(mode === "apply" ? { collected: [], errors: [] } : {}),
    orphans: { worktrees: [], branches: [] },
  };
}

export function renderGc(r: GcReport): string {
  const lines = [
    `switchboard gc (${r.mode === "dry-run" ? "dry run: nothing is changed; pass --apply to collect" : "apply"})`,
    "",
    `Retention: ${r.retention_days} days${r.retention_configured ? "" : " (default; retention.days is not set, so --apply is refused)"}; cutoff ${r.cutoff}`,
  ];
  lines.push(
    r.mode === "dry-run"
      ? `${r.units.length} meta-session(s) would be collected${r.units.length ? ":" : "."}`
      : `${r.collected?.length ?? 0} of ${r.units.length} meta-session(s) collected${r.units.length ? ":" : "."}`,
  );
  for (const u of r.units) {
    lines.push(
      `  ${u.session_id}  last activity ${u.last_activity}  ${u.worktrees} worktree(s), ${u.branches.length} branch(es)`,
    );
  }
  for (const c of r.collected ?? []) {
    lines.push(
      `  collected ${c.session_id}: ${c.containers_removed.length ? `${c.containers_removed.length} container(s), ` : ""}${c.worktrees_removed} worktree(s), ${c.branches_deleted.length} branch(es), ${c.artifact_files_deleted} artifact file(s) removed, ${c.artifact_files_kept} kept`,
    );
    for (const w of c.warnings) lines.push(`    warning: ${w}`);
  }
  if (r.container_runtime !== undefined) lines.push(`  containers: ${r.container_runtime}`);
  for (const e of r.errors ?? [])
    lines.push(`  ERROR ${e.session_id} at ${e.step}: ${e.message} (re-run to roll forward)`);
  const oc = r.orphans_collected;
  if (oc) {
    const removed = oc.worktrees_removed.length + oc.branches_removed.length;
    lines.push(
      "",
      `Orphans: ${removed} removed, ${oc.marked} newly marked, ${oc.waiting} waiting out the ${r.retention_days} day retention`,
    );
    for (const w of oc.worktrees_removed) lines.push(`  removed worktree directory ${w}`);
    for (const b of oc.branches_removed) lines.push(`  removed branch ${b.branch} in ${b.repo_root}`);
    for (const w of oc.warnings) lines.push(`  warning: ${w}`);
    for (const e of oc.errors) lines.push(`  ERROR ${e.target} at ${e.step}: ${e.message} (re-run to roll forward)`);
  }
  const n = r.orphans.worktrees.length + r.orphans.branches.length;
  if (n > 0) {
    lines.push(
      "",
      r.mode === "dry-run"
        ? `Orphans (--apply marks them and removes each once marked for ${r.retention_days} days): ${n}`
        : `Orphans remaining: ${n}`,
    );
    for (const w of r.orphans.worktrees) lines.push(`  worktree directory ${w}`);
    for (const b of r.orphans.branches) lines.push(`  branch ${b.branch} in ${b.repo_root}`);
  }
  return `${lines.join("\n")}\n`;
}
