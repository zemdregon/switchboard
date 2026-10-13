/**
 * `switchboard runs list|show|cancel` (FR-OPS-01) and the top-level `approve`/`deny` (T3.4, FR-OPS-02, FRD WF-7).
 * list/show are read-only; cancel, approve and deny write operator records, which they also apply directly only while
 * they hold the data-directory lock (no daemon can be running then, ADR-0005).
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config/index.js";
import { createLedger, type GitCommitRow, LEDGER_FILE_NAME, openLedger, type RunEventRow } from "../ledger/index.js";
import type { OperatorDecision } from "../lifecycle/approval.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";
import { listPendingCancels, requestCancel, requestDecision, UnknownRunError } from "./operator.js";

export interface RunSummary {
  id: string;
  state: string;
  provider: string | null;
  trust_profile: string;
  client_id: string;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunDetail extends RunSummary {
  meta_session_id: string;
  attempt: number;
  failure_detail: string | null;
  branch: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested: boolean;
  /** T9.5 (FR-GIT-03, BR-27): number of `git_policy_violation` events; `runs show` flags the run when non-zero. */
  git_policy_violations: number;
  /** T9.6 (FR-GIT-07, LLD §12.7): provenance of the commits this run published, with their push state. */
  commits: CommitProvenanceView[];
  /** T9.6 (FR-GIT-05): push attempts recorded on this run (agent pushes, and operator pushes of its commits). */
  pushes: PushView[];
  /**
   * T9.7 (FR-GIT-09): the finalize-only result from the run's `git_finalize_commit` event (outcome, reason code or
   * SHA); absent when finalize-only did not apply to the run.
   */
  finalize_commit?: { outcome: string; reason?: string; commit_sha?: string };
}

/**
 * One `git_commit` row as `runs show` presents it (FR-GIT-07). Ids, SHAs, provider facts and the sanitiser's rule
 * counts only: never the message, never a URL. `pushed_to` lists the accepted pushes whose recorded commit list holds
 * this commit (any run of the meta-session).
 */
export interface CommitProvenanceView {
  sha: string;
  tree_sha: string;
  patch_id: string | null;
  origin: string;
  /** T9.7: how the commit was made: `tool` (the injected `commit` tool) or `finalize` (finalize-only, FR-GIT-09). */
  via: "tool" | "finalize";
  publish_ref: string;
  project_id: string;
  context_id: string;
  meta_session_id: string;
  run_id: string;
  provider: string;
  harness: string;
  model: string | null;
  adapter_version_id: string | null;
  adapter_version: string | null;
  tool_event_id: string | null;
  sanitizer: { rules: Record<string, number> };
  created_at: string;
  pushed_to: { push_id: string; remote: string; ref: string; at: string }[];
}

/** One `git_push` row (FR-GIT-05): the remote NAME, target ref, SHA, outcome and reason code; never a URL. */
export interface PushView {
  id: string;
  outcome: string;
  reason: string | null;
  remote: string;
  ref: string;
  head_sha: string;
  requested_by: string;
  run_id: string | null;
  created_at: string;
}

/**
 * The approval covering a `privileged` run (T3.3, LLD §3.1 "What is shown where"): operator CLI only, so it shows what
 * the MCP envelope never does: the full scope, `bypass`, the scope hash, the decision and every run it covers.
 */
export interface ApprovalView {
  id: string;
  status: string;
  /** The run that requested the approval (the one `approve`/`deny` act on, T3.4). */
  requested_by_run: string;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  scope: unknown;
  bypass: boolean;
  scope_hash: string;
  covered_runs: { id: string; state: string; created_at: string }[];
}

export interface RunEventView {
  seq: number;
  ts: string;
  type: string;
  payload: unknown;
}

const SUMMARY_COLS = "id, state, provider, trust_profile, client_id, failure_code, created_at, updated_at";

function dataDirFor(io: CliIo, argv: readonly string[]): string {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) }).dataDir;
}

/** Read-only handle, or undefined when no ledger exists yet. Never migrates or creates files. */
function openReadOnly(dataDir: string): Database.Database | undefined {
  const file = path.join(dataDir, LEDGER_FILE_NAME);
  if (!existsSync(file)) return undefined;
  return new Database(file, { readonly: true, fileMustExist: true });
}

export interface ListOptions {
  state?: string | undefined;
  limit: number;
}

export function listRuns(io: CliIo, argv: readonly string[], opts: ListOptions): RunSummary[] {
  const db = openReadOnly(dataDirFor(io, argv));
  if (!db) return [];
  try {
    const where = opts.state === undefined ? "" : "WHERE state = ?";
    const args: unknown[] = opts.state === undefined ? [opts.limit] : [opts.state, opts.limit];
    return db
      .prepare(`SELECT ${SUMMARY_COLS} FROM run ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args) as RunSummary[];
  } finally {
    db.close();
  }
}

export function showRun(
  io: CliIo,
  argv: readonly string[],
  runId: string,
): { run: RunDetail; events: RunEventView[]; approval?: ApprovalView } | undefined {
  const db = openReadOnly(dataDirFor(io, argv));
  if (!db) return undefined;
  try {
    const row = db
      .prepare(
        `SELECT ${SUMMARY_COLS}, meta_session_id, attempt, failure_detail, branch, started_at, finished_at
         FROM run WHERE id = ?`,
      )
      .get(runId) as Omit<RunDetail, "cancel_requested"> | undefined;
    if (!row) return undefined;
    const events = (
      db.prepare("SELECT seq, ts, type, payload_json FROM run_event WHERE run_id = ? ORDER BY seq").all(runId) as Pick<
        RunEventRow,
        "seq" | "ts" | "type" | "payload_json"
      >[]
    ).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, payload: JSON.parse(e.payload_json) as unknown }));
    const approval = row.trust_profile === "privileged" ? approvalView(db, runId) : undefined;
    return {
      run: {
        ...row,
        cancel_requested: listPendingCancels(db, runId).length > 0,
        git_policy_violations: events.filter((e) => e.type === "git_policy_violation").length,
        commits: commitProvenance(db, runId, row.meta_session_id),
        pushes: pushesOfRun(db, runId),
        ...finalizeView(events),
      },
      events,
      ...(approval ? { approval } : {}),
    };
  } finally {
    db.close();
  }
}

/** T9.7: the newest `git_finalize_commit` event as `{ finalize_commit }`, or nothing. Codes and SHAs only. */
function finalizeView(events: readonly { type: string; payload: unknown }[]): Pick<RunDetail, "finalize_commit"> {
  const e = events.findLast((x) => x.type === "git_finalize_commit");
  if (!e || typeof e.payload !== "object" || e.payload === null) return {};
  const p = e.payload as { outcome?: unknown; reason?: unknown; commit_sha?: unknown };
  return {
    finalize_commit: {
      outcome: String(p.outcome ?? ""),
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      ...(typeof p.commit_sha === "string" ? { commit_sha: p.commit_sha } : {}),
    },
  };
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** T9.6 (FR-GIT-07, LLD §12.7): the run's `git_commit` rows joined to the adapter version and accepted pushes. */
function commitProvenance(db: Database.Database, runId: string, metaSessionId: string): CommitProvenanceView[] {
  if (!hasTable(db, "git_commit")) return [];
  const rows = db
    .prepare(
      `SELECT c.*, a.binary_version AS adapter_version FROM git_commit c
       LEFT JOIN adapter_version a ON a.id = c.adapter_version_id
       WHERE c.run_id = ? ORDER BY c.created_at, c.id`,
    )
    .all(runId) as (GitCommitRow & { adapter_version: string | null })[];
  if (rows.length === 0) return [];
  const pushedTo = new Map<string, CommitProvenanceView["pushed_to"]>();
  const pushEvents = db
    .prepare(
      `SELECT e.ts, e.payload_json FROM run_event e JOIN run r ON r.id = e.run_id
       WHERE r.meta_session_id = ? AND e.type = 'git_push'
         AND json_extract(e.payload_json, '$.outcome') = 'ACCEPTED'
       ORDER BY e.ts, e.id`,
    )
    .all(metaSessionId) as { ts: string; payload_json: string }[];
  for (const e of pushEvents) {
    const p = JSON.parse(e.payload_json) as { push_id?: unknown; remote?: unknown; ref?: unknown; commits?: unknown };
    if (!Array.isArray(p.commits)) continue;
    const entry = {
      push_id: String(p.push_id ?? ""),
      remote: String(p.remote ?? ""),
      ref: String(p.ref ?? ""),
      at: e.ts,
    };
    for (const sha of p.commits) {
      if (typeof sha !== "string") continue;
      const list = pushedTo.get(sha) ?? [];
      list.push(entry);
      pushedTo.set(sha, list);
    }
  }
  return rows.map((c) => {
    let sanitizer: { rules: Record<string, number> } = { rules: {} };
    try {
      const parsed = JSON.parse(c.sanitizer_json) as { rules?: unknown };
      if (typeof parsed.rules === "object" && parsed.rules !== null) {
        sanitizer = { rules: { ...(parsed.rules as Record<string, number>) } };
      }
    } catch {
      // keep the empty report
    }
    return {
      sha: c.commit_sha,
      tree_sha: c.tree_sha,
      patch_id: c.patch_id,
      origin: c.origin,
      via: c.origin === "finalize_only" ? "finalize" : "tool",
      publish_ref: c.publish_ref,
      project_id: c.project_id,
      context_id: c.context_id,
      meta_session_id: c.meta_session_id,
      run_id: c.run_id,
      provider: c.provider,
      harness: c.harness,
      model: c.model,
      adapter_version_id: c.adapter_version_id,
      adapter_version: c.adapter_version,
      tool_event_id: c.tool_event_id,
      sanitizer,
      created_at: c.created_at,
      pushed_to: pushedTo.get(c.commit_sha) ?? [],
    };
  });
}

/** `git_push` rows whose event is on this run (the run's own agent pushes and operator pushes of its commits). */
function pushesOfRun(db: Database.Database, runId: string): PushView[] {
  if (!hasTable(db, "git_push")) return [];
  return db
    .prepare(
      `SELECT p.id, p.outcome, p.detail AS reason, p.remote, p.ref, p.head_sha, p.requested_by, p.run_id, p.created_at
       FROM git_push p
       WHERE p.id IN (SELECT json_extract(e.payload_json, '$.push_id') FROM run_event e
                      WHERE e.run_id = ? AND e.type = 'git_push')
       ORDER BY p.created_at, p.id`,
    )
    .all(runId) as PushView[];
}

function approvalView(db: Database.Database, runId: string): ApprovalView | undefined {
  const ledger = createLedger(db);
  const run = ledger.getRunRecord(runId);
  if (!run) return undefined;
  let approvalId: unknown;
  try {
    approvalId = (JSON.parse(run.policy_snapshot_json) as { privilegedScope?: { approvalId?: unknown } })
      .privilegedScope?.approvalId;
  } catch {
    approvalId = undefined;
  }
  const row =
    (typeof approvalId === "string" ? ledger.getApproval(approvalId) : undefined) ?? ledger.getApprovalForRun(runId);
  if (!row) return undefined;
  const scope = JSON.parse(row.scope_json) as { bypass?: unknown };
  return {
    id: row.id,
    status: row.status,
    requested_by_run: row.run_id,
    requested_at: row.requested_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    scope,
    bypass: scope.bypass === true,
    scope_hash: row.scope_hash,
    covered_runs: ledger
      .listRunsCoveredByApproval(row.id)
      .map((r) => ({ id: r.id, state: r.state, created_at: r.created_at })),
  };
}

export type CancelReport = {
  schema_version: number;
  run_id: string;
  outcome: "cancelled" | "requested" | "already_requested" | "already_terminal";
  state: string;
  daemon_running: boolean;
  request_event_id: string | null;
};

function osUser(io: CliIo): string {
  if (io.user !== undefined) return io.user;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * Cancel per ADR-0005: take the data-dir lock; if it is free no daemon exists and (while holding it, so none can
 * start) a run without a process is cancelled directly. If a daemon holds it, only the operator record is written.
 */
export function cancelRun(io: CliIo, argv: readonly string[], runId: string): CancelReport {
  return withOperatorLedger(io, argv, runId, (db, ledger, daemon) => {
    const r = requestCancel(db, ledger, runId, {
      requestedBy: osUser(io),
      direct: !daemon,
      ...(io.now ? { now: io.now } : {}),
    });
    return {
      schema_version: JSON_SCHEMA_VERSION,
      run_id: r.runId,
      outcome: r.outcome,
      state: r.state,
      daemon_running: daemon,
      request_event_id: r.requestEventId,
    };
  });
}

/**
 * ADR-0005 operator write: take the data-dir lock if it is free (then no daemon exists, and none can start while the
 * callback runs, so it may apply its record directly); if a live daemon holds it, only records are written.
 */
function withOperatorLedger<T>(
  io: CliIo,
  argv: readonly string[],
  runId: string,
  fn: (db: Database.Database, ledger: ReturnType<typeof createLedger>, daemon: boolean) => T,
): T {
  const dataDir = dataDirFor(io, argv);
  if (!existsSync(path.join(dataDir, LEDGER_FILE_NAME))) throw new UnknownRunError(`unknown run ${runId}`);
  let lock: ReturnType<typeof acquireDataDirLock> | undefined;
  let daemon = false;
  try {
    lock = acquireDataDirLock(dataDir);
  } catch (err) {
    if (!(err instanceof LockError) || inspectDataDirLock(dataDir).state !== "held") throw err;
    daemon = true;
  }
  const db = openLedger(dataDir);
  try {
    return fn(db, createLedger(db, io.now ? { now: io.now } : {}), daemon);
  } finally {
    db.close();
    lock?.release();
  }
}

/** `approve`/`deny --json` (T3.4). Stable keys; `decided_at` is when this command recorded the decision. */
export type DecisionReport = {
  schema_version: number;
  run_id: string;
  decision: "approve" | "deny";
  outcome: "approved" | "denied" | "requested";
  state: string;
  daemon_running: boolean;
  approval_id: string;
  request_event_id: string;
  decided_by: string;
  decided_at: string;
  scope_hash: string;
};

/**
 * `approve <run_id>` / `deny <run_id>` (FR-OPS-02, FRD WF-7, LLD §3.1 "Approve"): records the decision as an operator
 * record and, when no daemon runs, applies it at once (approve: T3 to QUEUED; deny: T19 to CANCELLED). A run that is
 * not a waiting `privileged` run with its own `PENDING` approval, a hash mismatch or a second decision is refused with
 * `ApprovalRefusedError` and nothing is written.
 */
export function decideRun(
  io: CliIo,
  argv: readonly string[],
  runId: string,
  decision: OperatorDecision,
): DecisionReport {
  return withOperatorLedger(io, argv, runId, (db, ledger, daemon) => {
    const r = requestDecision(db, ledger, runId, {
      decision,
      requestedBy: osUser(io),
      direct: !daemon,
      ...(io.now ? { now: io.now } : {}),
    });
    return {
      schema_version: JSON_SCHEMA_VERSION,
      run_id: r.runId,
      decision: decision === "APPROVED" ? "approve" : "deny",
      outcome: r.outcome,
      state: r.state,
      daemon_running: daemon,
      approval_id: r.approvalId,
      request_event_id: r.requestEventId,
      decided_by: r.decidedBy,
      decided_at: r.decidedAt,
      scope_hash: r.scopeHash,
    };
  });
}

export function renderDecision(r: DecisionReport): string {
  const what =
    r.outcome === "requested"
      ? `${r.decision} recorded; the serve daemon (or startup reconciliation) will apply it`
      : r.outcome === "approved"
        ? "approved (no daemon was running; applied directly)"
        : "denied (no daemon was running; applied directly)";
  return `${r.run_id}: ${what} [state ${r.state}; approval ${r.approval_id} by ${r.decided_by} at ${r.decided_at}]\n`;
}

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000) {
    throw new UsageError("--limit must be an integer from 1 to 1000");
  }
  return Number(raw);
}

export function renderRunList(runs: readonly RunSummary[]): string {
  if (runs.length === 0) return "No runs.\n";
  const rows = runs.map((r) => [r.id, r.state, r.provider ?? "-", r.trust_profile, r.created_at]);
  const head = ["ID", "STATE", "PROVIDER", "TRUST", "CREATED"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const fmt = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return `${[fmt(head), ...rows.map(fmt)].join("\n")}\n`;
}

export function renderRun(d: { run: RunDetail; events: RunEventView[]; approval?: ApprovalView }): string {
  const r = d.run;
  const lines = [
    `Run ${r.id}`,
    `  state:       ${r.state}${r.cancel_requested ? " (cancel requested)" : ""}`,
    `  session:     ${r.meta_session_id}`,
    `  provider:    ${r.provider ?? "-"}`,
    `  trust:       ${r.trust_profile}`,
    `  client:      ${r.client_id}`,
    `  attempt:     ${r.attempt}`,
    `  created:     ${r.created_at}`,
    `  started:     ${r.started_at ?? "-"}`,
    `  finished:    ${r.finished_at ?? "-"}`,
  ];
  if (r.failure_code) lines.push(`  failure:     ${r.failure_code}${r.failure_detail ? ` - ${r.failure_detail}` : ""}`);
  if (r.git_policy_violations > 0) {
    lines.push(`  git policy:  VIOLATION (${r.git_policy_violations} git_policy_violation event(s); FR-GIT-03)`);
  }
  if (r.finalize_commit) {
    const f = r.finalize_commit;
    lines.push(
      `  finalize:    ${f.outcome}${f.commit_sha ? ` ${f.commit_sha}` : ""}${f.reason ? ` (${f.reason})` : ""} (finalize-only, FR-GIT-09)`,
    );
  }
  if (r.commits.length > 0) {
    lines.push("", "Commits (provenance, FR-GIT-07):");
    for (const c of r.commits) {
      const rules = Object.entries(c.sanitizer.rules)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(
        `  ${c.sha}  ${c.origin}  via ${c.via}  ${c.created_at}`,
        `    tree ${c.tree_sha}  patch-id ${c.patch_id ?? "-"}  publish ref ${c.publish_ref}`,
        `    project ${c.project_id}  context ${c.context_id}  session ${c.meta_session_id}  run ${c.run_id}`,
        `    provider ${c.provider} (harness ${c.harness})  model ${c.model ?? "-"}  adapter version ${c.adapter_version ?? c.adapter_version_id ?? "-"}`,
        `    sanitiser: ${rules === "" ? "nothing removed" : rules}`,
        `    pushed: ${c.pushed_to.length === 0 ? "no" : c.pushed_to.map((p) => `${p.remote} ${p.ref} (${p.push_id}, ${p.at})`).join("; ")}`,
      );
    }
  }
  if (r.pushes.length > 0) {
    lines.push("", "Pushes (FR-GIT-05):");
    for (const p of r.pushes) {
      lines.push(
        `  ${p.id}  ${p.outcome}${p.reason ? ` (${p.reason})` : ""}  ${p.remote || "-"} ${p.ref || "-"}  head ${p.head_sha || "-"}  by ${p.requested_by}  ${p.created_at}`,
      );
    }
  }
  const a = d.approval;
  if (a) {
    lines.push(
      "",
      `Approval ${a.id}`,
      `  status:      ${a.status}`,
      `  requested:   ${a.requested_at} by run ${a.requested_by_run}`,
      `  decided:     ${a.decided_at ?? "-"}${a.decided_by ? ` by ${a.decided_by}` : ""}`,
      `  bypass:      ${a.bypass ? "yes (provider bypass flag requested)" : "no"}`,
      `  scope hash:  ${a.scope_hash}`,
      `  scope:       ${JSON.stringify(a.scope)}`,
      `  covers runs: ${a.covered_runs.map((c) => `${c.id} (${c.state})`).join(", ") || "-"}`,
    );
  }
  lines.push("", "Events:");
  for (const e of d.events)
    lines.push(`  ${String(e.seq).padStart(3)}  ${e.ts}  ${e.type}  ${JSON.stringify(eventForDisplay(e))}`);
  return `${lines.join("\n")}\n`;
}

/** The LEASED ref snapshot lists up to thousands of refs; the text view shows its digest and counts only. */
function eventForDisplay(e: RunEventView): unknown {
  if (e.type !== "git_ref_snapshot" || typeof e.payload !== "object" || e.payload === null) return e.payload;
  const { refs, ...rest } = e.payload as { refs?: unknown };
  return { ...rest, refs_listed: Array.isArray(refs) ? refs.length : 0 };
}

const OUTCOME_TEXT: Record<CancelReport["outcome"], string> = {
  cancelled: "cancelled (no daemon was running; applied directly)",
  requested: "cancel requested; the serve daemon (or startup reconciliation) will apply it",
  already_requested: "a cancel request is already pending",
  already_terminal: "run is already finished; nothing to cancel",
};

export function renderCancel(r: CancelReport): string {
  return `${r.run_id}: ${OUTCOME_TEXT[r.outcome]} [state ${r.state}]\n`;
}
