/**
 * `switchboard git push <meta-session-or-run-id> [--json]` (T9.6; FR-GIT-05, FR-GIT-06, FR-WS-05; FRD WF-12; LLD
 * §12.6; ADR-0028). The operator route to publication: pushes the meta-session's publish ref under exactly the same
 * rules as the agent `push` tool (policy `branch`, configured remote name and prefix, controller commits only, never
 * forced, never the default or a checked-out branch, refused after a Git policy violation), except the BR-31
 * credential-reach rule, which is about the agent and does not apply to the operator.
 *
 * Locking (ADR-0005, same as `gc --apply`): the push is a side effect with the operator's Git configuration, so this
 * process performs it itself while holding the data-directory lock, and refuses (`LockError`) while a `serve` daemon
 * holds it. Nothing is queued for the daemon: the daemon is not the operator, and its environment is not necessarily the
 * operator's shell (SSH agent, credential helper). Every attempt that reaches a meta-session is recorded in `git_push`
 * and as a `git_push` run event; the output names the remote, the ref and SHAs, never a URL.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { GitPusher, PushError, type PushResult, pushContextResolver } from "../git/push.js";
import { createIdGenerator } from "../ids/index.js";
import { LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import { type CliIo, JSON_SCHEMA_VERSION } from "./io.js";
import { UnknownRunError } from "./operator.js";

export interface GitPushReport {
  readonly schema_version: number;
  readonly meta_session_id: string;
  readonly push_id: string;
  readonly outcome: PushResult["outcome"];
  readonly reason: string;
  readonly pushed: boolean;
  /** Remote NAME (never a URL); empty when the attempt was refused before a valid name existed. */
  readonly remote: string;
  readonly ref: string;
  readonly head_sha: string;
  readonly commits: readonly string[];
  /** The run whose events hold the `git_push` record (`runs show <run>`). */
  readonly recorded_on_run: string;
}

/** Thrown when the meta-session or run id is not in the ledger. */
export class UnknownTargetError extends UnknownRunError {}

export async function runGitPush(io: CliIo, argv: readonly string[], id: string): Promise<GitPushReport> {
  const config = loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
  if (!existsSync(path.join(config.dataDir, LEDGER_FILE_NAME))) throw new UnknownTargetError(`unknown id ${id}`);
  const lock = acquireDataDirLock(config.dataDir); // LockError while a serve daemon holds it
  try {
    const db = openLedger(config.dataDir);
    try {
      const sessionId = resolveSession(db, id);
      const pusher = new GitPusher({
        db,
        resolveContext: pushContextResolver(config.projects),
        sourceEnv: io.env,
        ids: createIdGenerator(),
        ...(io.now ? { now: io.now } : {}),
      });
      let r: PushResult;
      try {
        r = await pusher.push({ metaSessionId: sessionId, requestedBy: "operator" });
      } catch (err) {
        if (err instanceof PushError) throw new UnknownTargetError(err.message);
        throw err;
      }
      return {
        schema_version: JSON_SCHEMA_VERSION,
        meta_session_id: sessionId,
        push_id: r.pushId,
        outcome: r.outcome,
        reason: r.reason,
        pushed: r.pushed,
        remote: r.remote,
        ref: r.ref,
        head_sha: r.headSha,
        commits: r.commits,
        recorded_on_run: r.eventRunId,
      };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

function resolveSession(db: ReturnType<typeof openLedger>, id: string): string {
  if (id.startsWith("run_")) {
    const row = db.prepare("SELECT meta_session_id FROM run WHERE id = ?").get(id) as
      | { meta_session_id: string }
      | undefined;
    if (!row) throw new UnknownTargetError(`unknown run ${id}`);
    return row.meta_session_id;
  }
  if (id.startsWith("sess_")) {
    const row = db.prepare("SELECT id FROM meta_session WHERE id = ?").get(id) as { id: string } | undefined;
    if (!row) throw new UnknownTargetError(`unknown meta-session ${id}`);
    return row.id;
  }
  throw new UnknownTargetError(
    `expected a meta-session id (sess_...) or a run id (run_...), got ${JSON.stringify(id)}`,
  );
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  POLICY_NONE: "the context's push policy is none (set push.policy to branch to allow pushes)",
  NO_PROJECT: "the meta-session has no project, so it has no push policy",
  CONTEXT_UNKNOWN: "the meta-session's project is no longer in the configuration",
  GIT_POLICY_VIOLATION: "a run of this meta-session has a recorded Git policy violation (see runs show)",
  REMOTE_INVALID: "push.remote is not a valid remote name",
  PREFIX_INVALID: "push.branch_prefix does not give a valid branch name",
  CONTEXT_MISMATCH: "the meta-session's repository is not the context's configured repository",
  REMOTE_UNKNOWN: "the configured remote is not defined in the repository",
  NOTHING_TO_PUSH: "the publish ref has no commit to push",
  PUBLISH_HISTORY_UNVERIFIED: "the publish ref holds a commit the controller did not make for this meta-session",
  TARGET_PROTECTED: "the target is the default branch or a checked-out branch",
  REPO_CONFIG_UNSAFE: "the repository's own configuration sets a key that runs a program or redirects the push",
  REMOTE_URL_CREDENTIALS: "the remote's URL carries credentials; use a credential helper or SSH agent instead",
  REMOTE_TRANSPORT_NOT_ALLOWED: "the remote's transport is not https, ssh or file",
  NON_FAST_FORWARD: "the remote branch has commits the publish ref does not (never forced)",
  REMOTE_HOOK_DECLINED: "a hook on the remote declined the push",
  REMOTE_REJECTED: "the remote rejected the push",
  CREDENTIALS_UNAVAILABLE: "Git found no usable credentials (configure your SSH agent or credential helper)",
  REMOTE_UNREACHABLE: "the remote could not be reached",
  TIMEOUT: "the push timed out",
  GIT_FAILED: "Git failed in the controller",
};

export function renderGitPush(r: GitPushReport): string {
  const target = r.ref ? `${r.remote || "-"} ${r.ref}` : "-";
  if (r.pushed) {
    const what = r.reason === "UP_TO_DATE" ? "already up to date" : `pushed ${r.commits.length} commit(s)`;
    return `${r.meta_session_id}: ${what} to ${target} at ${r.head_sha} [push ${r.push_id}; recorded on ${r.recorded_on_run}]\n`;
  }
  return (
    `${r.meta_session_id}: push ${r.outcome === "REFUSED_POLICY" ? "refused" : "failed"} (${r.reason}): ` +
    `${REASON_TEXT[r.reason] ?? "see runs show"} [target ${target}; push ${r.push_id}; recorded on ${r.recorded_on_run}]\n`
  );
}
