import { statfsSync } from "node:fs";
import { join } from "node:path";

/**
 * Free-disk floor (T3.23; FR-WS-11, NFR-DATA-01, R-8). The probe is a port so tests inject a value and production reads
 * `statfs`. The floor is a pacing gate (BR-51): below it, new runs are held in `QUEUED`, never failed or refused.
 */

/** Reads free space. Synchronous on purpose: the lifecycle asks inside its dispatch transaction. */
export interface DiskProbe {
  /** Bytes available to the (unprivileged) controller on the filesystem holding `path`. Throws when `path` is unreadable. */
  freeBytes(path: string): number;
}

/** The production probe: `statfs` of each path (`bavail * bsize`, the space an unprivileged process may use). */
export const statfsDiskProbe: DiskProbe = {
  freeBytes(path: string): number {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  },
};

export interface DiskFloor {
  /** `limits.min_free_disk_mb` in bytes. */
  readonly minFreeBytes: number;
  /** Paths whose filesystems are checked: the data directory and the worktree root (FR-WS-11). */
  readonly paths: readonly string[];
  readonly probe: DiskProbe;
}

export interface DiskFloorStatus {
  readonly minFreeBytes: number;
  /** Lowest free space over the readable paths; `null` when no path could be probed. */
  readonly freeBytes: number | null;
  /** The path whose filesystem had the lowest free space; `null` when none could be probed. */
  readonly path: string | null;
  /** True only when a probe succeeded and the lowest free space is under the floor. */
  readonly below: boolean;
  /** Paths the probe could not read (a missing worktree root before the first run is normal). */
  readonly unreadable: string[];
}

/**
 * Compare the lowest free space over `floor.paths` with the floor. A path the probe cannot read is skipped and listed;
 * when none can be read the floor is not assessable and `below` is false (the gate never blocks on its own failure:
 * the floor never fails a run, FR-WS-11; `doctor` shows the unreadable paths).
 */
export function assessDiskFloor(floor: DiskFloor): DiskFloorStatus {
  let freeBytes: number | null = null;
  let lowest: string | null = null;
  const unreadable: string[] = [];
  for (const p of floor.paths) {
    let free: number;
    try {
      free = floor.probe.freeBytes(p);
    } catch {
      unreadable.push(p);
      continue;
    }
    if (!Number.isFinite(free) || free < 0) {
      unreadable.push(p);
      continue;
    }
    if (freeBytes === null || free < freeBytes) {
      freeBytes = free;
      lowest = p;
    }
  }
  return {
    minFreeBytes: floor.minFreeBytes,
    freeBytes,
    path: lowest,
    below: freeBytes !== null && freeBytes < floor.minFreeBytes,
    unreadable,
  };
}

export const MB = 1024 * 1024;

/** Whole megabytes for operator-facing text (`doctor`, log lines). */
export function formatMb(bytes: number): string {
  return `${Math.floor(bytes / MB)} MB`;
}

/** The filesystems FR-WS-11 names: the data directory and the worktree root under it (which may not exist yet). */
export function diskFloorPaths(dataDir: string): string[] {
  return [dataDir, join(dataDir, "worktrees")];
}
