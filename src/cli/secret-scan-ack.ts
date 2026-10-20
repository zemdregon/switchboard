/**
 * `switchboard git ack-secret-scan <gps_id> [--json]` (T9.14; FR-GIT-11, FR-CTL-03; LLD §20.9; ADR-0061 amendment
 * 2026-10-20). The operator acknowledges a push the pre-push secret scan refused: one `secret_scan_acknowledged
 * {push_id, acknowledged_by, ref, head_sha}` run event on the run that owns the refusal, which clears the derived
 * `secret_scan_blocked` flag until the next refusal. It never allows a push: the scan refuses the same content again, in
 * every profile. Operator CLI only; no MCP tool, HTTP route or request field reaches this module.
 *
 * Checks, in order, before any write and in the same `BEGIN IMMEDIATE` transaction as the write (so two concurrent
 * acknowledgements write one event): unknown id `NOT_FOUND`; a row that is not a `SECRET_SCAN_BLOCKED` refusal, or
 * whose `git_push` event is missing or unreadable, `REFUSED` (fail closed); already acknowledged: exit 0, nothing
 * written; a newer secret-scan refusal of the same meta-session and ref: `REFUSED` (only the latest is acknowledged).
 *
 * Locking (ADR-0005, as `approve`, `deny` and `cancel`): the data-directory lock is held when it is free; while a live
 * `serve` daemon holds it the single event is written without it. No Git runs and nothing is asked of the daemon.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { SECRET_SCAN_ACKNOWLEDGED_EVENT, secretScanBlockedFromPushEvents } from "../git/secret-scan.js";
import { createLedger, LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";
import { UnknownRunError } from "./operator.js";

export interface SecretScanAckReport {
  readonly schema_version: number;
  readonly push_id: string;
  readonly outcome: "acknowledged" | "already_acknowledged";
  readonly meta_session_id: string;
  /** The run whose events hold the refusal and the acknowledgement. */
  readonly recorded_on_run: string;
  readonly ref: string;
  readonly head_sha: string;
  readonly acknowledged_by: string;
  /** The new event's id; null when it was already acknowledged (nothing written). */
  readonly event_id: string | null;
  /** Whether `secret_scan_blocked` is still derived for the meta-session (a newer refusal is not acknowledged). */
  readonly still_blocked: boolean;
  readonly daemon_running: boolean;
}

/** Thrown for an unknown `git_push` id (`NOT_FOUND`). */
export class UnknownPushError extends UnknownRunError {}

/** Thrown when the row is not the latest secret-scan refusal of its meta-session and ref (`REFUSED`). */
export class SecretScanAckRefusedError extends Error {
  override readonly name = "SecretScanAckRefusedError";
}

const PUSH_ID = /^gps_[A-Za-z0-9]+$/u;

interface PushEvent {
  readonly id: string;
  readonly run_id: string;
  readonly payload: Record<string, unknown> | undefined;
}

export function runSecretScanAck(io: CliIo, argv: readonly string[], pushId: string): SecretScanAckReport {
  if (!PUSH_ID.test(pushId)) throw new UsageError(`expected a push id (gps_...), got ${JSON.stringify(pushId)}`);
  const config = loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
  if (!existsSync(path.join(config.dataDir, LEDGER_FILE_NAME))) throw new UnknownPushError(`unknown push ${pushId}`);
  let lock: ReturnType<typeof acquireDataDirLock> | undefined;
  let daemon = false;
  try {
    lock = acquireDataDirLock(config.dataDir);
  } catch (err) {
    if (!(err instanceof LockError) || inspectDataDirLock(config.dataDir).state !== "held") throw err;
    daemon = true;
  }
  const db = openLedger(config.dataDir);
  try {
    const ledger = createLedger(db, io.now ? { now: io.now } : {});
    const by = osUser(io);
    const tx = db.transaction((): SecretScanAckReport => {
      const row = db.prepare("SELECT id, outcome, ref, head_sha FROM git_push WHERE id = ?").get(pushId) as
        | { id: string; outcome: string; ref: string; head_sha: string }
        | undefined;
      if (!row) throw new UnknownPushError(`unknown push ${pushId}`);
      const owner = db
        .prepare(
          `SELECT e.id AS id, e.run_id AS run_id, e.payload_json AS payload_json, r.meta_session_id AS meta_session_id
           FROM run_event e JOIN run r ON r.id = e.run_id
           WHERE e.type = 'git_push' AND json_valid(e.payload_json) AND json_extract(e.payload_json, '$.push_id') = ?`,
        )
        .get(pushId) as { id: string; run_id: string; payload_json: string; meta_session_id: string } | undefined;
      const ownerPayload = owner ? parse(owner.payload_json) : undefined;
      if (!owner || ownerPayload === undefined) {
        throw new SecretScanAckRefusedError(`push ${pushId} has no readable git_push event; nothing was acknowledged`);
      }
      if (row.outcome !== "REFUSED_POLICY" || ownerPayload.reason !== "SECRET_SCAN_BLOCKED") {
        throw new SecretScanAckRefusedError(
          `push ${pushId} is not a secret-scan refusal (${row.outcome}); nothing was acknowledged`,
        );
      }
      const sessionId = owner.meta_session_id;
      // Newest first, the order the derivation reads (`listGitPushEventPayloadsForMetaSession`).
      const events: PushEvent[] = (
        db
          .prepare(
            `SELECT e.id AS id, e.run_id AS run_id, e.payload_json AS payload_json FROM run_event e
             JOIN run r ON r.id = e.run_id WHERE r.meta_session_id = ? AND e.type = 'git_push'
             ORDER BY e.ts DESC, e.id DESC`,
          )
          .all(sessionId) as { id: string; run_id: string; payload_json: string }[]
      ).map((e) => ({ id: e.id, run_id: e.run_id, payload: parse(e.payload_json) }));
      const acked = new Set(ledger.listSecretScanAcknowledgedPushIds(sessionId));
      const base = {
        schema_version: JSON_SCHEMA_VERSION,
        push_id: pushId,
        meta_session_id: sessionId,
        recorded_on_run: owner.run_id,
        ref: row.ref,
        head_sha: row.head_sha,
        acknowledged_by: by,
        daemon_running: daemon,
      };
      if (acked.has(pushId)) {
        return {
          ...base,
          outcome: "already_acknowledged",
          event_id: null,
          still_blocked: secretScanBlockedFromPushEvents(
            events.map((e) => e.payload),
            acked,
          ),
        };
      }
      const at = events.findIndex((e) => e.id === owner.id);
      const newer = events
        .slice(0, at < 0 ? 0 : at)
        .find((e) => e.payload?.reason === "SECRET_SCAN_BLOCKED" && e.payload.ref === row.ref);
      if (newer) {
        throw new SecretScanAckRefusedError(
          `push ${pushId} is superseded by the newer secret-scan refusal ${String(newer.payload?.push_id)}; ` +
            "only the latest refusal of a ref can be acknowledged",
        );
      }
      const ev = ledger.appendRunEvent({
        runId: owner.run_id,
        type: SECRET_SCAN_ACKNOWLEDGED_EVENT,
        payload: { push_id: pushId, acknowledged_by: by, ref: row.ref, head_sha: row.head_sha },
      });
      acked.add(pushId);
      return {
        ...base,
        outcome: "acknowledged",
        event_id: ev.id,
        still_blocked: secretScanBlockedFromPushEvents(
          events.map((e) => e.payload),
          acked,
        ),
      };
    });
    return tx.immediate();
  } finally {
    db.close();
    lock?.release();
  }
}

function parse(json: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function osUser(io: CliIo): string {
  if (io.user !== undefined) return io.user;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

export function renderSecretScanAck(r: SecretScanAckReport): string {
  const what = r.outcome === "acknowledged" ? "acknowledged" : "already acknowledged";
  const still = r.still_blocked ? "; secret_scan_blocked is still raised by a newer refusal" : "";
  return (
    `${r.push_id}: ${what} the secret-scan refusal of ${r.ref} at ${r.head_sha} [meta-session ${r.meta_session_id}; ` +
    `recorded on ${r.recorded_on_run}]${still}\n` +
    "The push is still refused while the finding is in the outgoing diff (allowlist it in git.secret_scan.allow or push by hand).\n"
  );
}
