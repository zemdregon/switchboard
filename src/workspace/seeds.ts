/**
 * Dependency seeds (T9.13; FR-WS-10, LLD §5.1, ADR-0057). A project may declare ignored directories (`node_modules`, a
 * virtual environment) together with the lockfile they derive from and the argv that produces them. The controller
 * builds each one once per key in a store under `<data_dir>/seeds/` and fills it into a run's fresh worktree before the
 * provider starts. Every choice below is Delegated (agent work, not owner-approved):
 *
 * - **Key.** SHA-256 of the canonical JSON of the lockfile blob's SHA-256 at the base checkpoint (read with
 *   `git cat-file`, never from the worktree), the project and seed ids, the install argv, the build profile and the
 *   environment. A changed lockfile is a new key.
 * - **Build.** On a scratch worktree of the base checkpoint (`git worktree add --detach`), never on a run's worktree, so
 *   nothing an agent wrote can reach an entry; spawned through the verification stage's runner (argv, no shell, own
 *   process group, the verification environment, slot, niceness and confinement). The profile is the run's, lowered to
 *   `trusted-development` for `privileged`. Concurrent runs needing one key share one build (single flight).
 * - **Populate (Q-103 Delegated default).** `host`: a copy-on-write clone of each file where the filesystem supports
 *   one, otherwise a private byte copy; never a hardlink and never a symlink into the store, under any profile.
 *   `container`: no copy, one read-only bind mount of the entry (`containerMounts`).
 * - **Degrade, never fail.** Any problem records one `seed_failed` event with a reason code and the run proceeds with
 *   an unseeded directory. Nothing here throws to the caller or changes a run's state.
 * - **Bounded store.** LRU eviction to `seed_store_mb` and `seed_entries_per_seed`, mark-first (ADR-0054 order), never
 *   an entry that is building or used by a non-terminal run.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { type ArtifactStore, defaultRedactor } from "../artifacts/index.js";
import { type SeedSpec, seedPathProblem } from "../config/projects.js";
import { type OuterSandboxAvailability, procStartTicks } from "../exec/index.js";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import type { TrustProfile } from "../ledger/index.js";
import {
  startVerification,
  type VerificationCommandResult,
  type VerificationLimits,
  verificationEnvAllowlist,
} from "../lifecycle/verification.js";
import type { DiskReclaimer, ReclaimContext, ReclaimOutcome } from "./gc.js";
import { git } from "./git.js";
import { serialisedWorktreeCreate } from "./manager.js";

export { DEFAULT_SEED_TIMEOUT_SECONDS, type SeedSpec, seedPathProblem, seedPathWithin } from "../config/projects.js";

export type SeedEnvironment =
  | { readonly kind: "host"; readonly platform: string; readonly arch: string }
  | { readonly kind: "container"; readonly imageDigest: string };

export type SeedFailureReason =
  | "lockfile_missing"
  | "not_ignored"
  | "build_failed"
  | "build_timeout"
  | "build_error"
  | "unsafe_entry"
  | "store_full"
  | "populate_failed"
  | "wait_timeout"
  | "cancelled";

export type SeedMethod = "clone" | "copy" | "mount" | "existing";

export interface SeedMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: true;
}

export type SeedOutcome =
  | {
      readonly ok: true;
      readonly seedKey: string;
      readonly method: SeedMethod;
      readonly built: boolean;
      readonly bytes: number;
      /** container only: the read-only bind mount the environment adds after the worktree mount. */
      readonly mount?: SeedMount;
    }
  | { readonly ok: false; readonly reason: SeedFailureReason };

export interface SeedRun {
  readonly runId: string;
  readonly projectId: string;
  readonly profile: TrustProfile;
  readonly baseCommit: string;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly environment: SeedEnvironment;
  readonly signal?: AbortSignal;
}

/** The port the workspace manager and the early disk sweep use (LLD §5.1). */
export interface SeedStore {
  /** Resolve or build (single flight), then populate the run's worktree. Never throws; never fails the run. */
  seed(run: SeedRun, spec: SeedSpec): Promise<SeedOutcome>;
  /** LRU eviction of unused ready entries: to the configured bounds, or with `ctx` until `ctx.enough()`. */
  evict(ctx?: ReclaimContext): Promise<ReclaimOutcome>;
  /** Remove the private copies (method clone or copy) in worktrees of idle runs; never a leased worktree. */
  removeIdleCopies(ctx: ReclaimContext): Promise<ReclaimOutcome>;
  /** The read-only bind mounts recorded for a `container` run (method `mount`), in seeding order. */
  containerMounts(runId: string): SeedMount[];
  /** Startup reconciliation (LLD §5.1, WF-8). */
  reconcile(): Promise<void>;
}

/** `run_event` types (payloads closed: no argv, no output, no path outside the worktree). */
export const SEED_APPLIED_EVENT = "seed_applied";
export const SEED_FAILED_EVENT = "seed_failed";

/** Assumptions (LLD §5.1, Delegated). */
export const DEFAULT_SEED_STORE_MB = 10240;
export const DEFAULT_SEED_ENTRIES_PER_SEED = 3;
/** The build's environment allowlist before the verification filter (PATH and HOME, as every adapter's base list). */
export const SEED_BUILD_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const KEY_RE = /^[0-9a-f]{64}$/;
const TERMINAL_STATES = "('SUCCEEDED','FAILED','CANCELLED')";
/** A copy-on-write clone refused by the filesystem: fall back to a private copy for the rest of the seed. */
const CLONE_FALLBACK = new Set(["ENOTSUP", "EXDEV", "EINVAL", "EOPNOTSUPP", "ENOSYS", "EPERM"]);

/** The entry key (LLD §5.1 "Key"): hex SHA-256 of a fixed-order JSON object. */
export function seedKey(k: {
  readonly projectId: string;
  readonly seedId: string;
  readonly lockfileSha256: string;
  readonly install: readonly string[];
  readonly profile: TrustProfile;
  readonly environment: SeedEnvironment;
}): string {
  const environment =
    k.environment.kind === "host"
      ? { kind: "host", platform: k.environment.platform, arch: k.environment.arch }
      : { kind: "container", image_digest: k.environment.imageDigest };
  const canonical = JSON.stringify({
    v: 1,
    project_id: k.projectId,
    seed_id: k.seedId,
    lockfile_sha256: k.lockfileSha256,
    install_argv: [...k.install],
    profile: k.profile,
    environment,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** A seed build is a controller command: never under a privileged scope or bypass (ADR-0057 item 3). */
export function seedBuildProfile(profile: TrustProfile): TrustProfile {
  return profile === "privileged" ? "trusted-development" : profile;
}

/** The host's seed environment. */
export function hostSeedEnvironment(): SeedEnvironment {
  return { kind: "host", platform: process.platform, arch: process.arch };
}

/** What a build spawns. `confinable`: the verification outer sandbox may wrap it (false for a container build). */
export interface SeedBuildCommand {
  readonly argv: readonly string[];
  readonly envAllowlist: readonly string[];
  readonly confinable: boolean;
}

export interface SeedBuildContext {
  readonly runId: string;
  readonly projectId: string;
  readonly seedKey: string;
  readonly scratch: string;
  readonly spec: SeedSpec;
  readonly profile: TrustProfile;
  readonly environment: SeedEnvironment;
}

/** Turns a build into the command to spawn. Throwing records `build_error`. */
export type SeedCommandFactory = (ctx: SeedBuildContext) => Promise<SeedBuildCommand>;

/** The host builder: the install argv as declared. */
export const hostSeedCommand: SeedCommandFactory = async (ctx) => ({
  argv: ctx.spec.install,
  envAllowlist: SEED_BUILD_ENV_ALLOWLIST,
  confinable: true,
});

export interface SeedStoreOptions {
  readonly db: Database.Database;
  readonly artifacts: ArtifactStore;
  /** Controller data directory; the store is `<dataDir>/seeds/`. */
  readonly dataDir: string;
  /** `limits.seed_store_mb` in bytes. */
  readonly maxBytes: number;
  /** `limits.seed_entries_per_seed`. */
  readonly entriesPerSeed: number;
  /** The verification limiter (FR-EXE-09); a build takes a slot like a verification command. */
  readonly verificationLimits?: VerificationLimits | undefined;
  /** Confined verification (FR-EXE-08): a host build runs in the outer sandbox, failing closed without it. */
  readonly confined?: boolean | undefined;
  readonly outerSandbox?: OuterSandboxAvailability | undefined;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Builders per environment kind. `container` absent: a container seed records `build_error`. */
  readonly commands?: { readonly host?: SeedCommandFactory; readonly container?: SeedCommandFactory };
  readonly redact?: (b: Buffer) => Buffer;
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
  /** Test seam: `copy` skips the copy-on-write attempt. Default `auto`. */
  readonly cloneMode?: "auto" | "copy";
}

interface SeedRow {
  seed_key: string;
  project_id: string;
  seed_id: string;
  state: "building" | "ready" | "evicting";
  builder_pid: number | null;
  builder_pgid: number | null;
  builder_start_ticks: string | null;
  size_bytes: number | null;
}

type BuildResult = { readonly ok: true } | { readonly ok: false; readonly reason: SeedFailureReason };

class SeedFailure extends Error {
  constructor(readonly reason: SeedFailureReason) {
    super(reason);
  }
}

/** "Not in use": no use row of a non-terminal run names the entry (LLD §5.1, Eviction). `s` is the entry row. */
const notInUse = (s: string): string =>
  `NOT EXISTS (SELECT 1 FROM dependency_seed_use u JOIN run r ON r.id = u.run_id
     WHERE u.seed_key = ${s}.seed_key AND r.state NOT IN ${TERMINAL_STATES})`;

export function createSeedStore(opts: SeedStoreOptions): SeedStore {
  return new LedgerSeedStore(opts);
}

class LedgerSeedStore implements SeedStore {
  private readonly db: Database.Database;
  private readonly ids: IdGenerator;
  private readonly now: () => Date;
  private readonly root: string;
  /** Single flight: builds in progress in this controller, by key. One controller owns a data directory. */
  private readonly building = new Map<string, Promise<BuildResult>>();
  /** Evictions in progress, by key: a resolve of the same key waits for the removal before it builds. */
  private readonly evicting = new Map<string, Promise<void>>();
  private rootChecked = false;

  constructor(private readonly opts: SeedStoreOptions) {
    this.db = opts.db;
    this.ids = opts.ids ?? defaultIds;
    this.now = opts.now ?? (() => new Date());
    this.root = path.join(opts.dataDir, "seeds");
  }

  async seed(run: SeedRun, spec: SeedSpec): Promise<SeedOutcome> {
    try {
      return await this.seedOrThrow(run, spec);
    } catch (err) {
      const reason = err instanceof SeedFailure ? err.reason : "build_error";
      this.event(run.runId, SEED_FAILED_EVENT, { seed_id: spec.id, reason });
      return { ok: false, reason };
    }
  }

  private async seedOrThrow(run: SeedRun, spec: SeedSpec): Promise<SeedOutcome> {
    if (seedPathProblem(spec.lockfile) !== undefined) throw new SeedFailure("lockfile_missing");
    if (seedPathProblem(spec.directory) !== undefined) throw new SeedFailure("populate_failed");
    if (run.signal?.aborted) throw new SeedFailure("cancelled");
    const lockfileSha256 = await lockfileBlobSha256(run.repoRoot, run.baseCommit, spec.lockfile);
    if (lockfileSha256 === null) throw new SeedFailure("lockfile_missing");
    if (!(await isIgnored(run.repoRoot, run.baseCommit, run.worktreePath, spec.directory))) {
      throw new SeedFailure("not_ignored");
    }

    const profile = seedBuildProfile(run.profile);
    const key = seedKey({
      projectId: run.projectId,
      seedId: spec.id,
      lockfileSha256,
      install: spec.install,
      profile,
      environment: run.environment,
    });
    const target = await this.targetIn(run.worktreePath, spec.directory);
    let present = await lstat(target).catch(() => null);
    // The empty mountpoint an earlier container run of this worktree left behind is not a seeded directory.
    if (run.environment.kind === "container" && present?.isDirectory() && (await readdir(target)).length === 0) {
      present = null;
    }
    if (present !== null) {
      if (present.isSymbolicLink() || !present.isDirectory()) throw new SeedFailure("populate_failed");
      // A native resume in its existing worktree (LLD §15.6) keeps what is there (LLD §5.1 step 2).
      this.recordUse(run, key, spec.directory, "existing");
      this.event(run.runId, SEED_APPLIED_EVENT, {
        seed_id: spec.id,
        seed_key: key,
        method: "existing",
        built: false,
        bytes: 0,
      });
      return { ok: true, seedKey: key, method: "existing", built: false, bytes: 0 };
    }

    await this.ensureRoot();
    // The use row is written when the entry is resolved, so no eviction can take it before it is populated.
    const claim: SeedMethod = run.environment.kind === "container" ? "mount" : "copy";
    const built = await this.resolve(run, spec, key, lockfileSha256, profile, claim);
    const entry = path.join(this.root, key);
    const bytes = this.row(key)?.size_bytes ?? 0;
    let method: SeedMethod;
    let mount: SeedMount | undefined;
    if (run.environment.kind === "container") {
      method = "mount";
      mount = { source: entry, target, readOnly: true };
    } else {
      try {
        method = await populateCopy(entry, target, this.opts.cloneMode ?? "auto");
      } catch {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        this.dropUse(run.runId, key);
        throw new SeedFailure("populate_failed");
      }
    }
    this.recordUse(run, key, spec.directory, method);
    this.event(run.runId, SEED_APPLIED_EVENT, { seed_id: spec.id, seed_key: key, method, built, bytes });
    return { ok: true, seedKey: key, method, built, bytes, ...(mount !== undefined ? { mount } : {}) };
  }

  /** A ready entry for `key`: used as is, waited for, or built by this run. Returns whether this run built it. */
  private async resolve(
    run: SeedRun,
    spec: SeedSpec,
    key: string,
    lockfileSha256: string,
    profile: TrustProfile,
    claim: SeedMethod,
  ): Promise<boolean> {
    for (;;) {
      const pendingEviction = this.evicting.get(key);
      if (pendingEviction !== undefined) await pendingEviction.catch(() => undefined);
      const inflight = this.building.get(key);
      if (inflight !== undefined) {
        const r = await waitFor(inflight, spec.timeoutMs, run.signal);
        if (r === "timeout") throw new SeedFailure("wait_timeout");
        if (r === "cancelled") throw new SeedFailure("cancelled");
        // The builder's own cancel is not this run's: build it here instead.
        if (!r.ok && r.reason !== "cancelled") throw new SeedFailure(r.reason);
        continue;
      }
      const decision = this.db
        .transaction((): "use" | "build" | "evicting" => {
          const row = this.row(key);
          if (row?.state === "ready") {
            this.recordUse(run, key, spec.directory, claim);
            return "use";
          }
          if (row?.state === "evicting") return "evicting";
          if (row === undefined) {
            this.db
              .prepare(
                `INSERT INTO dependency_seed (seed_key, project_id, seed_id, lockfile_sha256, profile, environment,
                   state, builder_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'building', ?, ?)`,
              )
              .run(
                key,
                run.projectId,
                spec.id,
                lockfileSha256,
                profile,
                JSON.stringify(run.environment),
                run.runId,
                this.now().toISOString(),
              );
          } else {
            // `building` with no build in this controller: its builder is gone (reconcile kills a recorded orphan).
            this.db
              .prepare(
                `UPDATE dependency_seed SET builder_run_id = ?, builder_pid = NULL, builder_pgid = NULL,
                   builder_start_ticks = NULL WHERE seed_key = ?`,
              )
              .run(run.runId, key);
          }
          return "build";
        })
        .immediate();
      if (decision === "use") {
        if (await isRealDirectory(path.join(this.root, key))) return false;
        // The row says ready but the directory is gone: drop the row and build again.
        this.dropUse(run.runId, key);
        this.db.prepare("DELETE FROM dependency_seed WHERE seed_key = ? AND state = 'ready'").run(key);
        continue;
      }
      if (decision === "evicting") {
        // A row left `evicting` (an interrupted eviction) rolls forward; it is never used.
        await this.finishEviction(key);
        continue;
      }
      const promise = this.build(run, spec, key, profile);
      this.building.set(key, promise);
      let result: BuildResult;
      try {
        result = await promise;
      } finally {
        this.building.delete(key);
      }
      if (!result.ok) throw new SeedFailure(result.reason);
      this.recordUse(run, key, spec.directory, claim);
      await this.evict().catch(() => undefined);
      return true;
    }
  }

  private async build(run: SeedRun, spec: SeedSpec, key: string, profile: TrustProfile): Promise<BuildResult> {
    const scratch = path.join(this.root, ".build", randomUUID());
    let result: BuildResult = { ok: false, reason: "build_error" };
    try {
      result = await this.buildIn(run, spec, key, profile, scratch);
    } catch (err) {
      result = { ok: false, reason: err instanceof SeedFailure ? err.reason : "build_error" };
    } finally {
      await removeScratch(run.repoRoot, scratch);
      if (!result.ok) {
        this.db.prepare("DELETE FROM dependency_seed WHERE seed_key = ? AND state = 'building'").run(key);
      }
    }
    return result;
  }

  private async buildIn(
    run: SeedRun,
    spec: SeedSpec,
    key: string,
    profile: TrustProfile,
    scratch: string,
  ): Promise<BuildResult> {
    await mkdir(path.dirname(scratch), { recursive: true, mode: 0o700 });
    await serialisedWorktreeCreate(run.repoRoot, async () => {
      await git(["worktree", "add", "--detach", scratch, run.baseCommit], { cwd: run.repoRoot });
    });
    const factory =
      run.environment.kind === "container"
        ? this.opts.commands?.container
        : (this.opts.commands?.host ?? hostSeedCommand);
    if (factory === undefined) return { ok: false, reason: "build_error" };
    const command = await factory({
      runId: run.runId,
      projectId: run.projectId,
      seedKey: key,
      scratch,
      spec,
      profile,
      environment: run.environment,
    });
    const verification = startVerification({
      commands: [command.argv],
      cwd: scratch,
      envAllowlist: verificationEnvAllowlist(command.envAllowlist),
      ...(this.opts.baseEnv !== undefined ? { baseEnv: this.opts.baseEnv } : {}),
      wallClockMs: spec.timeoutMs,
      limits: this.opts.verificationLimits,
      confined: command.confinable && this.opts.confined === true,
      outerSandbox: this.opts.outerSandbox,
      onSpawn: (_index, info) => {
        // Before any output is read, so reconciliation can kill an orphaned build.
        const ticks = procStartTicks(info.pid);
        this.db
          .prepare(
            "UPDATE dependency_seed SET builder_pid = ?, builder_pgid = ?, builder_start_ticks = ? WHERE seed_key = ?",
          )
          .run(info.pid, info.pgid, ticks === null ? null : String(ticks), key);
      },
    });
    const onAbort = (): void => void verification.cancel();
    run.signal?.addEventListener("abort", onAbort, { once: true });
    let done: Awaited<typeof verification.done>;
    try {
      done = await verification.done;
    } finally {
      run.signal?.removeEventListener("abort", onAbort);
    }
    const cmd = done.commands[0];
    const reason = buildFailure(done.outcome, cmd);
    await this.storeLog(run.runId, spec.id, key, reason ?? "passed", cmd);
    if (reason !== undefined) return { ok: false, reason };

    const produced = path.join(scratch, spec.directory);
    const size = await checkEntry(produced);
    if (size > this.opts.maxBytes) return { ok: false, reason: "store_full" };
    const tmp = path.join(this.root, ".tmp", randomUUID());
    await mkdir(path.dirname(tmp), { recursive: true, mode: 0o700 });
    await rename(produced, tmp);
    const entry = path.join(this.root, key);
    try {
      await makeReadOnly(tmp, false);
      await removeTree(entry);
      await rename(tmp, entry);
      await chmod(entry, 0o555);
    } catch (err) {
      await removeTree(tmp);
      throw err;
    }
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE dependency_seed SET state = 'ready', size_bytes = ?, ready_at = ?, last_used_at = ?,
           builder_pid = NULL, builder_pgid = NULL, builder_start_ticks = NULL WHERE seed_key = ?`,
      )
      .run(size, now, now, key);
    return { ok: true };
  }

  async evict(ctx?: ReclaimContext): Promise<ReclaimOutcome> {
    const notes: string[] = [];
    let reclaimed = 0;
    const tried = new Set<string>();
    for (;;) {
      if (ctx?.enough()) break;
      const victim = (ctx === undefined ? this.overBoundVictims() : this.lruUnused()).find((k) => !tried.has(k));
      if (victim === undefined) break;
      tried.add(victim);
      const r = await this.evictOne(victim, notes);
      if (r === "failed") break;
      if (r === "evicted") reclaimed += 1;
    }
    return { reclaimed, notes };
  }

  /** Unused entries whose removal brings the store toward its bounds, in eviction order; empty when within them. */
  private overBoundVictims(): string[] {
    const unused = this.lruUnused();
    const counts = this.db
      .prepare("SELECT project_id, seed_id, COUNT(*) AS n FROM dependency_seed WHERE state != 'evicting' GROUP BY 1, 2")
      .all() as { project_id: string; seed_id: string; n: number }[];
    const over = new Set(
      counts.filter((c) => c.n > this.opts.entriesPerSeed).map((c) => `${c.project_id}\0${c.seed_id}`),
    );
    const perSeed = unused.filter((key) => {
      const r = this.row(key);
      return r !== undefined && over.has(`${r.project_id}\0${r.seed_id}`);
    });
    if (perSeed.length > 0) return perSeed;
    const total = (
      this.db
        .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM dependency_seed WHERE state != 'evicting'")
        .get() as { n: number }
    ).n;
    return total > this.opts.maxBytes ? unused : [];
  }

  /** Ready entries not in use, least recently used first. */
  private lruUnused(): string[] {
    return (
      this.db
        .prepare(
          `SELECT s.seed_key AS k FROM dependency_seed s WHERE s.state = 'ready' AND ${notInUse("s")}
           ORDER BY COALESCE(s.last_used_at, s.created_at), s.created_at, s.seed_key`,
        )
        .all() as { k: string }[]
    ).map((r) => r.k);
  }

  /** ADR-0054 order: intent (with the re-check) in one transaction, then the removal, then the outcome. */
  private async evictOne(key: string, notes: string[]): Promise<"evicted" | "skipped" | "failed"> {
    const marked = this.db
      .prepare(
        `UPDATE dependency_seed SET state = 'evicting', evict_intent_at = ?
         WHERE seed_key = ? AND state = 'ready' AND ${notInUse("dependency_seed")}`,
      )
      .run(this.now().toISOString(), key);
    if (marked.changes === 0) return "skipped"; // in use again since it was picked
    try {
      await this.finishEviction(key);
      return "evicted";
    } catch (err) {
      notes.push(`seed entry ${key.slice(0, 12)} could not be removed: ${errorText(err)}`);
      return "failed";
    }
  }

  private finishEviction(key: string): Promise<void> {
    const existing = this.evicting.get(key);
    if (existing !== undefined) return existing;
    const p = (async () => {
      if (!KEY_RE.test(key)) throw new Error("refused: not a seed key");
      await removeTree(path.join(this.root, key));
      this.db.prepare("DELETE FROM dependency_seed WHERE seed_key = ? AND state = 'evicting'").run(key);
    })().finally(() => this.evicting.delete(key));
    this.evicting.set(key, p);
    return p;
  }

  async removeIdleCopies(ctx: ReclaimContext): Promise<ReclaimOutcome> {
    const notes: string[] = [];
    let reclaimed = 0;
    const rows = this.db
      .prepare(
        `SELECT u.run_id, u.seed_key, u.worktree_path, u.directory FROM dependency_seed_use u
         JOIN run r ON r.id = u.run_id
         WHERE u.method IN ('clone','copy') AND u.removed_at IS NULL AND r.state IN ${TERMINAL_STATES}
         ORDER BY u.populated_at, u.run_id, u.seed_key`,
      )
      .all() as { run_id: string; seed_key: string; worktree_path: string; directory: string }[];
    const worktreesRoot = path.resolve(this.opts.dataDir, "worktrees");
    for (const u of rows) {
      if (ctx.enough()) break;
      if (ctx.leasedWorktrees.has(u.worktree_path)) continue;
      // A later run in the same path (a native resume in place) that is not terminal holds it too.
      const live = this.db
        .prepare(`SELECT 1 FROM run WHERE worktree_path = ? AND state NOT IN ${TERMINAL_STATES} LIMIT 1`)
        .get(u.worktree_path);
      if (live !== undefined) continue;
      try {
        if (!path.resolve(u.worktree_path).startsWith(`${worktreesRoot}${path.sep}`)) {
          throw new Error("refused: the worktree is not under the controller's worktree directory");
        }
        if (seedPathProblem(u.directory) !== undefined) throw new Error("refused: invalid seeded directory");
        const target = await this.targetIn(u.worktree_path, u.directory).catch(() => null);
        if (target !== null) await removeTree(target);
        this.db
          .prepare("UPDATE dependency_seed_use SET removed_at = ? WHERE run_id = ? AND seed_key = ?")
          .run(this.now().toISOString(), u.run_id, u.seed_key);
        reclaimed += 1;
      } catch (err) {
        notes.push(`seeded directory of ${u.run_id} could not be removed: ${errorText(err)}`);
      }
    }
    return { reclaimed, notes };
  }

  containerMounts(runId: string): SeedMount[] {
    const rows = this.db
      .prepare(
        `SELECT seed_key, worktree_path, directory FROM dependency_seed_use WHERE run_id = ? AND method = 'mount'
         ORDER BY populated_at, rowid`,
      )
      .all(runId) as { seed_key: string; worktree_path: string; directory: string }[];
    return rows
      .filter((r) => KEY_RE.test(r.seed_key) && seedPathProblem(r.directory) === undefined)
      .map((r) => ({
        source: path.join(this.root, r.seed_key),
        target: path.join(r.worktree_path, r.directory),
        readOnly: true as const,
      }));
  }

  async reconcile(): Promise<void> {
    const stale = this.db
      .prepare(
        "SELECT seed_key, builder_pid, builder_pgid, builder_start_ticks FROM dependency_seed WHERE state = 'building'",
      )
      .all() as Pick<SeedRow, "seed_key" | "builder_pid" | "builder_pgid" | "builder_start_ticks">[];
    for (const r of stale) {
      if (this.building.has(r.seed_key)) continue;
      if (r.builder_pid !== null && r.builder_pgid !== null && r.builder_start_ticks !== null) {
        // Only the recorded process (pid and start time match), never a reused pid (LLD §8).
        const ticks = procStartTicks(r.builder_pid);
        if (ticks !== null && String(ticks) === r.builder_start_ticks) {
          try {
            process.kill(-r.builder_pgid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
      this.db.prepare("DELETE FROM dependency_seed WHERE seed_key = ? AND state = 'building'").run(r.seed_key);
    }
    const evicting = this.db.prepare("SELECT seed_key FROM dependency_seed WHERE state = 'evicting'").all() as {
      seed_key: string;
    }[];
    for (const r of evicting) await this.finishEviction(r.seed_key).catch(() => undefined);
    if (!(await isRealDirectory(this.root))) return;
    // Scratch worktrees and half-published entries; their repositories' registrations go at the next prune.
    for (const sub of [".build", ".tmp"]) {
      const dir = path.join(this.root, sub);
      for (const name of await readdir(dir).catch(() => [] as string[])) await removeTree(path.join(dir, name));
    }
    // Entry directories without a row (a crash between the rename and the row update) are never in use.
    const known = new Set(
      (this.db.prepare("SELECT seed_key FROM dependency_seed").all() as { seed_key: string }[]).map((r) => r.seed_key),
    );
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (KEY_RE.test(name) && !known.has(name) && !this.building.has(name)) {
        await removeTree(path.join(this.root, name)).catch(() => undefined);
      }
    }
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private row(key: string): SeedRow | undefined {
    return this.db.prepare("SELECT * FROM dependency_seed WHERE seed_key = ?").get(key) as SeedRow | undefined;
  }

  /** `<dataDir>/seeds/` (0700), refused when it or the data directory is a symlink. */
  private async ensureRoot(): Promise<void> {
    if (this.rootChecked) return;
    const data = await lstat(this.opts.dataDir).catch(() => null);
    if (data?.isSymbolicLink()) throw new SeedFailure("build_error");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const st = await lstat(this.root);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SeedFailure("build_error");
    this.rootChecked = true;
  }

  /** `<worktree>/<directory>`, refused when a component between them is a symlink (the target itself may be absent). */
  private async targetIn(worktreePath: string, directory: string): Promise<string> {
    const root = await realpath(worktreePath);
    if (root !== path.resolve(worktreePath)) throw new SeedFailure("populate_failed");
    let cur = root;
    for (const part of directory.split("/").slice(0, -1)) {
      cur = path.join(cur, part);
      const st = await lstat(cur).catch(() => null);
      if (st === null) break;
      if (st.isSymbolicLink() || !st.isDirectory()) throw new SeedFailure("populate_failed");
    }
    return path.join(root, directory);
  }

  private recordUse(run: SeedRun, key: string, directory: string, method: SeedMethod): void {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO dependency_seed_use (run_id, seed_key, worktree_path, directory, method, populated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id, seed_key) DO UPDATE SET method = excluded.method, populated_at = excluded.populated_at,
             removed_at = NULL`,
        )
        .run(run.runId, key, run.worktreePath, directory, method, now);
      this.db.prepare("UPDATE dependency_seed SET last_used_at = ? WHERE seed_key = ?").run(now, key);
    })();
  }

  private dropUse(runId: string, key: string): void {
    this.db.prepare("DELETE FROM dependency_seed_use WHERE run_id = ? AND seed_key = ?").run(runId, key);
  }

  private event(runId: string, type: string, payload: Record<string, unknown>): void {
    try {
      this.db
        .transaction(() => {
          const seq = this.db
            .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_event WHERE run_id = ?")
            .get(runId) as { n: number };
          this.db
            .prepare("INSERT INTO run_event (id, run_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
            .run(this.ids.id("evt"), runId, seq.n, this.now().toISOString(), type, JSON.stringify(payload));
        })
        .immediate();
    } catch {
      // An event that cannot be written never fails the run (degrade, ADR-0057 item 6).
    }
  }

  /** The `seed_log` artifact of the triggering run (version 1; output redacted, no argv; LLD §5.1). */
  private async storeLog(
    runId: string,
    seedId: string,
    key: string,
    outcome: string,
    cmd: VerificationCommandResult | undefined,
  ): Promise<void> {
    try {
      const redact = this.opts.redact ?? defaultRedactor;
      const text = (b: Buffer) => redact(b).toString("utf8");
      const body = Buffer.from(
        JSON.stringify({
          v: 1,
          seed_id: seedId,
          seed_key: key,
          outcome,
          exit_code: cmd?.exitCode ?? null,
          signal: cmd?.signal ?? null,
          duration_ms: cmd?.durationMs ?? 0,
          stdout: cmd ? text(cmd.stdout) : "",
          stderr: cmd ? text(cmd.stderr) : "",
          stdout_truncated: cmd?.stdoutTruncated ?? false,
          stderr_truncated: cmd?.stderrTruncated ?? false,
        }),
        "utf8",
      );
      const stored = await this.opts.artifacts.put(body);
      const run = this.db.prepare("SELECT meta_session_id FROM run WHERE id = ?").get(runId) as
        | { meta_session_id: string }
        | undefined;
      this.db
        .prepare(
          `INSERT INTO artifact (id, run_id, meta_session_id, kind, sha256, size_bytes, media_type, created_at)
           VALUES (?, ?, ?, 'seed_log', ?, ?, 'application/json', ?)`,
        )
        .run(
          this.ids.id("art"),
          runId,
          run?.meta_session_id ?? null,
          stored.sha256,
          stored.sizeBytes,
          this.now().toISOString(),
        );
    } catch {
      // The log is a record, not a condition of the seed.
    }
  }
}

function buildFailure(
  outcome: "passed" | "failed" | "cancelled" | "timeout",
  cmd: VerificationCommandResult | undefined,
): SeedFailureReason | undefined {
  if (outcome === "passed" && cmd?.outcome === "passed") return undefined;
  switch (cmd?.outcome) {
    case "timeout":
      return "build_timeout";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "build_failed";
    default:
      return outcome === "timeout" ? "build_timeout" : outcome === "cancelled" ? "cancelled" : "build_error";
  }
}

async function waitFor<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<T | "timeout" | "cancelled"> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
      new Promise<"cancelled">((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) resolve("cancelled");
        onAbort = () => resolve("cancelled");
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/** SHA-256 of the lockfile blob at `commit`, or null when the commit has no such blob. Never reads the worktree. */
async function lockfileBlobSha256(repoRoot: string, commit: string, lockfile: string): Promise<string | null> {
  const spec = `${commit}:${lockfile}`;
  const type = await git(["cat-file", "-t", spec], { cwd: repoRoot, okCodes: [1, 128] });
  if (type.code !== 0 || type.stdout.toString("utf8").trim() !== "blob") return null;
  const blob = await git(["cat-file", "blob", spec], { cwd: repoRoot });
  return createHash("sha256").update(blob.stdout).digest("hex");
}

/**
 * The directory is ignored in the run's worktree (`git check-ignore`, asked as a directory so `name/` patterns match
 * while it does not exist yet) and the base checkpoint tracks nothing under it, so seeding it never shows up in the
 * status, the post-run checkpoint or the diff (ADR-0006).
 */
async function isIgnored(repoRoot: string, commit: string, worktreePath: string, directory: string): Promise<boolean> {
  const r = await git(["check-ignore", "-q", "--", `${directory}/`], { cwd: worktreePath, okCodes: [1] });
  if (r.code !== 0) return false;
  const tracked = await git(["ls-tree", "-r", "--name-only", "-z", commit, "--", directory], { cwd: repoRoot });
  return tracked.stdout.length === 0;
}

async function isRealDirectory(p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null);
  return st?.isDirectory() === true && !st.isSymbolicLink();
}

/**
 * Publish checks (LLD §5.1 "Publish"): the produced path is a real directory; every symlink in it is relative and
 * resolves inside it; no device, FIFO or socket; set-user-ID and set-group-ID bits cleared. Returns the total size.
 */
async function checkEntry(dir: string): Promise<number> {
  const top = await lstat(dir).catch(() => null);
  if (top === null || top.isSymbolicLink() || !top.isDirectory()) throw new SeedFailure("build_failed");
  let total = 0;
  const walk = async (cur: string): Promise<void> => {
    for (const name of await readdir(cur)) {
      const p = path.join(cur, name);
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        const t = await readlink(p);
        const resolved = path.resolve(path.dirname(p), t);
        if (path.isAbsolute(t) || !(resolved === dir || resolved.startsWith(`${dir}${path.sep}`))) {
          throw new SeedFailure("unsafe_entry");
        }
        continue;
      }
      if (!st.isDirectory() && !st.isFile()) throw new SeedFailure("unsafe_entry");
      if ((st.mode & 0o6000) !== 0) await chmod(p, st.mode & 0o1777);
      if (st.isDirectory()) await walk(p);
      else total += st.size;
    }
  };
  await walk(dir);
  return total;
}

/** `a-w` on every file and directory below `dir` (and `dir` itself when `self`). Defence in depth only. */
async function makeReadOnly(dir: string, self: boolean): Promise<void> {
  for (const name of await readdir(dir)) {
    const p = path.join(dir, name);
    const st = await lstat(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) await makeReadOnly(p, true);
    else await chmod(p, st.mode & 0o5555);
  }
  if (self) {
    const st = await lstat(dir);
    await chmod(dir, st.mode & 0o5555);
  }
}

/** Remove a tree that may hold read-only directories; a symlink is unlinked, never followed. */
async function removeTree(p: string): Promise<void> {
  const st = await lstat(p).catch(() => null);
  if (st === null) return;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    await rm(p, { force: true });
    return;
  }
  const restore = async (d: string): Promise<void> => {
    await chmod(d, 0o700).catch(() => undefined);
    for (const name of await readdir(d).catch(() => [] as string[])) {
      const c = path.join(d, name);
      const cst = await lstat(c).catch(() => null);
      if (cst?.isDirectory() && !cst.isSymbolicLink()) await restore(c);
    }
  };
  await restore(p);
  await rm(p, { recursive: true, force: true });
}

async function removeScratch(repoRoot: string, scratch: string): Promise<void> {
  await git(["worktree", "remove", "--force", scratch], { cwd: repoRoot, okCodes: [128] }).catch(() => undefined);
  await removeTree(scratch).catch(() => undefined);
  await git(["worktree", "prune"], { cwd: repoRoot }).catch(() => undefined);
}

/**
 * A private, writable copy of `entry` at `target` (Q-103 Delegated default): directories created, regular files cloned
 * copy-on-write where the filesystem supports it and byte-copied otherwise (the whole seed falls back at the first
 * refusal), symlinks recreated with their relative target. Never `link`, never a symlink into the store.
 */
async function populateCopy(entry: string, target: string, mode: "auto" | "copy"): Promise<"clone" | "copy"> {
  let clone = mode === "auto";
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const walk = async (src: string, dst: string): Promise<void> => {
    const st = await lstat(src);
    await mkdir(dst, { mode: 0o700 });
    for (const name of await readdir(src)) {
      const s = path.join(src, name);
      const d = path.join(dst, name);
      const cst = await lstat(s);
      if (cst.isSymbolicLink()) {
        await symlink(await readlink(s), d);
      } else if (cst.isDirectory()) {
        await walk(s, d);
      } else if (cst.isFile()) {
        if (clone) {
          try {
            await copyFile(s, d, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE);
          } catch (err) {
            if (!CLONE_FALLBACK.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
            clone = false;
            await rm(d, { force: true });
            await copyFile(s, d, fsConstants.COPYFILE_EXCL);
          }
        } else {
          await copyFile(s, d, fsConstants.COPYFILE_EXCL);
        }
        await chmod(d, (cst.mode & 0o1777) | 0o200);
      } else {
        throw new Error("unsupported file type in a seed entry");
      }
    }
    await chmod(dst, (st.mode & 0o1777) | 0o700);
  };
  await walk(entry, target);
  return clone ? "clone" : "copy";
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Seed every declared directory of a run's fresh worktree, in declaration order (LLD §5.1 "When a run is seeded").
 * `inspect-untrusted` is never seeded (no worktree, and no verification either, FRD V7). Returns the container mounts.
 */
export async function seedWorktree(store: SeedStore, run: SeedRun, specs: readonly SeedSpec[]): Promise<SeedMount[]> {
  if (run.profile === "inspect-untrusted" || specs.length === 0) return [];
  const mounts: SeedMount[] = [];
  for (const spec of specs) {
    const r = await store.seed(run, spec);
    if (r.ok && r.mount !== undefined) mounts.push(r.mount);
  }
  return mounts;
}

/**
 * The early disk-floor sweep's first reclaimer (T3.23, FR-WS-11): `earlySweepReclaimers({ ..., seeds })`. Private
 * copies in idle worktrees first, then unused entries, least recently used first; never a leased worktree or an entry
 * in use.
 */
export function seedReclaimer(store: SeedStore): DiskReclaimer {
  return {
    name: "dependency_seeds",
    async reclaim(ctx) {
      const copies = await store.removeIdleCopies(ctx);
      if (ctx.enough()) return copies;
      const entries = await store.evict(ctx);
      return { reclaimed: copies.reclaimed + entries.reclaimed, notes: [...copies.notes, ...entries.notes] };
    },
  };
}
