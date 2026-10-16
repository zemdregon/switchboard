/**
 * Operator CLI commands for schedules (LLD §18.5, FR-OPS-01, FR-QUE-02):
 * `switchboard schedule list|show|enable|disable|approve|deny|create`.
 */

import { loadConfig } from "../config/index.js";
import { createLedger, openLedger, type ScheduleApprovalState, type ScheduleRow } from "../ledger/index.js";
import { computeNextFireUtc } from "../schedule/cron.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";

export class UnknownScheduleError extends Error {
  override readonly name = "UnknownScheduleError";
}

export interface ScheduleItemView {
  id: string;
  project_id: string;
  creator_client_id: string;
  cron_expr: string;
  enabled: boolean;
  approval_state: ScheduleApprovalState;
  last_fire_at: string | null;
  created_at: string;
  disabled_at: string | null;
  next_fire_utc: string | null;
  template?: Record<string, unknown>;
}

export interface ScheduleListReport {
  schema_version: number;
  schedules: ScheduleItemView[];
}

export interface ScheduleDetailReport {
  schema_version: number;
  schedule: ScheduleItemView;
}

export interface ScheduleMutationReport {
  schema_version: number;
  action: "enable" | "disable" | "approve" | "deny" | "create";
  id: string;
  outcome: string;
  schedule?: ScheduleItemView;
}

function rowToView(row: ScheduleRow, now: Date, includeTemplate = false): ScheduleItemView {
  let nextFireIso: string | null = null;
  try {
    const next = computeNextFireUtc(row.cron_expr, now);
    if (next !== undefined) nextFireIso = next.toISOString();
  } catch {
    // Leave next_fire_utc as null on computation error
  }

  let template: Record<string, unknown> | undefined;
  if (includeTemplate) {
    try {
      template = JSON.parse(row.template_json) as Record<string, unknown>;
    } catch {
      template = { raw: row.template_json };
    }
  }

  return {
    id: row.id,
    project_id: row.project_id,
    creator_client_id: row.creator_client_id,
    cron_expr: row.cron_expr,
    enabled: row.enabled === 1,
    approval_state: row.approval_state,
    last_fire_at: row.last_fire_at,
    created_at: row.created_at,
    disabled_at: row.disabled_at,
    next_fire_utc: nextFireIso,
    ...(template !== undefined ? { template } : {}),
  };
}

function openCliLedger(io: CliIo, argv: readonly string[]) {
  const dataDir = loadConfig({
    argv,
    env: io.env,
    ...(io.homedir !== undefined ? { homedir: io.homedir } : {}),
  }).dataDir;
  const db = openLedger(dataDir);
  const ledger = createLedger(db, io.now ? { now: io.now } : {});
  return { db, ledger };
}

export function listSchedules(
  io: CliIo,
  argv: readonly string[],
  opts: { projectId?: string } = {},
): ScheduleListReport {
  const { db, ledger } = openCliLedger(io, argv);
  try {
    const now = io.now ? new Date(io.now()) : new Date();
    const rows = ledger.listSchedules({ ...(opts.projectId ? { projectId: opts.projectId } : {}) });
    return {
      schema_version: JSON_SCHEMA_VERSION,
      schedules: rows.map((r) => rowToView(r, now)),
    };
  } finally {
    db.close();
  }
}

export function showSchedule(io: CliIo, argv: readonly string[], id: string): ScheduleDetailReport {
  const { db, ledger } = openCliLedger(io, argv);
  try {
    const now = io.now ? new Date(io.now()) : new Date();
    const row = ledger.getSchedule(id);
    if (row === undefined) {
      throw new UnknownScheduleError(`unknown schedule ${id}`);
    }
    return {
      schema_version: JSON_SCHEMA_VERSION,
      schedule: rowToView(row, now, true),
    };
  } finally {
    db.close();
  }
}

export function enableSchedule(io: CliIo, argv: readonly string[], id: string): ScheduleMutationReport {
  const { db, ledger } = openCliLedger(io, argv);
  try {
    const now = io.now ? new Date(io.now()) : new Date();
    const existing = ledger.getSchedule(id);
    if (existing === undefined) {
      throw new UnknownScheduleError(`unknown schedule ${id}`);
    }
    if (existing.approval_state === "PENDING_APPROVAL") {
      throw new UsageError(
        `schedule ${id} requires operator approval before enabling (run: switchboard schedule approve ${id})`,
      );
    }
    if (existing.approval_state === "REJECTED") {
      throw new UsageError(`schedule ${id} was rejected and cannot be enabled`);
    }
    const updated = ledger.enableSchedule(id);
    return {
      schema_version: JSON_SCHEMA_VERSION,
      action: "enable",
      id,
      outcome: "enabled",
      ...(updated ? { schedule: rowToView(updated, now) } : {}),
    };
  } finally {
    db.close();
  }
}

export function disableSchedule(io: CliIo, argv: readonly string[], id: string): ScheduleMutationReport {
  const { db, ledger } = openCliLedger(io, argv);
  try {
    const now = io.now ? new Date(io.now()) : new Date();
    const existing = ledger.getSchedule(id);
    if (existing === undefined) {
      throw new UnknownScheduleError(`unknown schedule ${id}`);
    }
    const updated = ledger.disableSchedule(id);
    return {
      schema_version: JSON_SCHEMA_VERSION,
      action: "disable",
      id,
      outcome: "disabled",
      ...(updated ? { schedule: rowToView(updated, now) } : {}),
    };
  } finally {
    db.close();
  }
}

export function approveSchedule(io: CliIo, argv: readonly string[], id: string): ScheduleMutationReport {
  const { db, ledger } = openCliLedger(io, argv);
  try {
    const now = io.now ? new Date(io.now()) : new Date();
    const existing = ledger.getSchedule(id);
    if (existing === undefined) {
      throw new UnknownScheduleError(`unknown schedule ${id}`);
    }
    if (existing.approval_state === "APPROVED") {
      return {
        schema_version: JSON_SCHEMA_VERSION,
        action: "approve",
        id,
        outcome: "already_approved",
        schedule: rowToView(existing, now),
      };
    }
    const updated = ledger.approveSchedule(id);
    return {
      schema_version: JSON_SCHEMA_VERSION,
      action: "approve",
      id,
      outcome: "approved",
      ...(updated ? { schedule: rowToView(updated, now) } : {}),
    };
  } finally {
    db.close();
  }
}

export function denySchedule(io: CliIo, argv: readonly string[], id: string): ScheduleMutationReport {
  const { db, ledger } = openCliLedger(io, argv);
  try {
    const now = io.now ? new Date(io.now()) : new Date();
    const existing = ledger.getSchedule(id);
    if (existing === undefined) {
      throw new UnknownScheduleError(`unknown schedule ${id}`);
    }
    const updated = ledger.denySchedule(id);
    return {
      schema_version: JSON_SCHEMA_VERSION,
      action: "deny",
      id,
      outcome: "denied",
      ...(updated ? { schedule: rowToView(updated, now) } : {}),
    };
  } finally {
    db.close();
  }
}

export function createSchedule(
  io: CliIo,
  argv: readonly string[],
  input: { projectId: string; cronExpr: string; template: unknown; enabled?: boolean; creatorClientId?: string },
): ScheduleMutationReport {
  const { db, ledger } = openCliLedger(io, argv);
  try {
    const now = io.now ? new Date(io.now()) : new Date();
    const row = ledger.createSchedule({
      projectId: input.projectId,
      creatorClientId: input.creatorClientId ?? "operator",
      cronExpr: input.cronExpr,
      template: input.template,
      enabled: input.enabled ?? false,
      approvalState: "APPROVED",
    });
    return {
      schema_version: JSON_SCHEMA_VERSION,
      action: "create",
      id: row.id,
      outcome: "created",
      schedule: rowToView(row, now, true),
    };
  } finally {
    db.close();
  }
}

export function renderScheduleList(r: ScheduleListReport): string {
  if (r.schedules.length === 0) {
    return "No schedules found.\n";
  }
  const lines: string[] = [
    "ID".padEnd(30) +
      "PROJECT".padEnd(16) +
      "CRON".padEnd(16) +
      "ENABLED".padEnd(10) +
      "APPROVAL".padEnd(18) +
      "NEXT FIRE (UTC)",
  ];
  for (const s of r.schedules) {
    const enabledStr = s.enabled ? "yes" : "no";
    const nextStr = s.next_fire_utc ? s.next_fire_utc.replace("T", " ").replace(".000Z", "Z") : "-";
    lines.push(
      `${s.id.padEnd(30)}${s.project_id.padEnd(16)}${s.cron_expr.padEnd(16)}${enabledStr.padEnd(10)}${s.approval_state.padEnd(18)}${nextStr}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderScheduleDetail(r: ScheduleDetailReport): string {
  const s = r.schedule;
  const statusStr = s.enabled ? "enabled" : "disabled";
  const lines = [
    `Schedule:     ${s.id}`,
    `Project:      ${s.project_id}`,
    `Creator:      ${s.creator_client_id}`,
    `Cron:         ${s.cron_expr} (UTC)`,
    `Status:       ${statusStr} (${s.approval_state})`,
    `Created:      ${s.created_at}`,
    `Last fire:    ${s.last_fire_at ?? "-"}`,
    `Disabled at:  ${s.disabled_at ?? "-"}`,
    `Next fire:    ${s.next_fire_utc ?? "-"}`,
  ];
  if (s.template !== undefined) {
    lines.push("Template:");
    lines.push(`  ${JSON.stringify(s.template, null, 2).replace(/\n/g, "\n  ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderScheduleMutation(r: ScheduleMutationReport): string {
  switch (r.action) {
    case "enable":
      return `Schedule ${r.id} enabled.\n`;
    case "disable":
      return `Schedule ${r.id} disabled.\n`;
    case "approve":
      return r.outcome === "already_approved"
        ? `Schedule ${r.id} is already approved.\n`
        : `Schedule ${r.id} approved (off by default; run switchboard schedule enable ${r.id} to activate).\n`;
    case "deny":
      return `Schedule ${r.id} denied.\n`;
    case "create":
      return `Schedule ${r.id} created (off by default).\n`;
    default:
      return `Schedule ${r.id} ${r.outcome}.\n`;
  }
}
