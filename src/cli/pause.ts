/**
 * `switchboard pause` / `switchboard resume` (T14.6; FR-CTL-05, FR-OPS-01, LLD §3.4.4): the operator-only pause of
 * every project. Names are the LLD's Proposed ones. Not an MCP tool: a client pauses only its own projects
 * (`pause_project`), never the deployment.
 *
 * ADR-0005 operator write, as `runs cancel` and `approve`: take the data-directory lock; if it is free no daemon exists
 * and (while holding it, so none can start) the `'*'` row is set at once; if a live daemon holds it, only the
 * append-only request is recorded and the daemon applies it on its next operator poll (`src/control/pause.ts`). Either
 * way the request event is the audit record, with the OS user as `requested_by`.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { GLOBAL_PAUSE_SCOPE, type PauseRequestOutcome, requestGlobalPause } from "../control/pause.js";
import { createLedger, LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import { type CliIo, JSON_SCHEMA_VERSION } from "./io.js";

/** `pause` / `resume --json` (T14.6). Stable keys. */
export type PauseReport = {
  schema_version: number;
  command: "pause" | "resume";
  /** `'*'`: every project (the only scope the CLI offers). */
  scope: string;
  outcome: PauseRequestOutcome;
  /** The global flag after this command; under a daemon it changes only once the daemon applies the request. */
  paused: boolean;
  daemon_running: boolean;
  request_event_id: string;
  requested_by: string;
  requested_at: string;
};

export function pauseAll(io: CliIo, argv: readonly string[], command: "pause" | "resume"): PauseReport {
  const dataDir = loadConfig({
    argv,
    env: io.env,
    ...(io.homedir !== undefined ? { homedir: io.homedir } : {}),
  }).dataDir;
  let lock: ReturnType<typeof acquireDataDirLock> | undefined;
  let daemon = false;
  try {
    lock = acquireDataDirLock(dataDir);
  } catch (err) {
    if (!(err instanceof LockError) || inspectDataDirLock(dataDir).state !== "held") throw err;
    daemon = true;
  }
  // No daemon and no ledger yet: create it, so a pause recorded before the first `serve` holds from its first request.
  const db = openLedger(dataDir);
  try {
    if (!daemon && !existsSync(path.join(dataDir, LEDGER_FILE_NAME))) throw new Error("ledger was not created");
    const ledger = createLedger(db, io.now ? { now: io.now } : {});
    const r = requestGlobalPause(ledger, { paused: command === "pause", requestedBy: osUser(io), direct: !daemon });
    return {
      schema_version: JSON_SCHEMA_VERSION,
      command,
      scope: GLOBAL_PAUSE_SCOPE,
      outcome: r.outcome,
      paused: r.paused,
      daemon_running: daemon,
      request_event_id: r.requestEventId,
      requested_by: r.requestedBy,
      requested_at: r.requestedAt,
    };
  } finally {
    db.close();
    lock?.release();
  }
}

export function renderPause(r: PauseReport): string {
  const what =
    r.outcome === "requested"
      ? `${r.command} of all projects recorded; the serve daemon will apply it on its next operator poll`
      : r.command === "pause"
        ? "all projects paused (no daemon was running; applied directly): no new run is admitted until resume"
        : "all projects resumed (no daemon was running; applied directly)";
  return `${what} [requested by ${r.requested_by} at ${r.requested_at}; paused now: ${r.paused}]\n`;
}

function osUser(io: CliIo): string {
  if (io.user !== undefined) return io.user;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}
