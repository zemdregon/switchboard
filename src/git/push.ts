/**
 * Controller-side publication (FR-GIT-05, FR-GIT-06, FR-GIT-08, FR-WS-05; FRD BR-29, BR-31, WF-12; LLD §12.6; ADR-0014,
 * ADR-0028; T9.6). Pushes ONE ref: the meta-session's local publish ref (`refs/heads/switchboard/pub/<sess>`, ADR-0025)
 * to the context's configured remote as `refs/heads/<push.branch_prefix><sess>`, with an explicit
 * `<sha>:<ref>` refspec that never starts with `+`, so Git itself refuses a non-fast-forward. Nothing else can reach a
 * remote through this module: not the operator's checked-out branch or the default branch, not run branches or
 * checkpoint commits (every commit pushed must have a `git_commit` provenance row of this meta-session), not tags or
 * notes (the destination is always under `refs/heads/`; `--no-follow-tags`, `push.followTags=false`).
 *
 * Every attempt, accepted or refused, is recorded: one `git_push` row and one `git_push` run event in one transaction
 * (`Ledger.recordGitPush`). Records hold the remote NAME, the target ref, SHAs and a reason code from a fixed vocabulary
 * ({@link PushReason}); never a URL, never Git's output (which can echo a URL or a remote hook's text).
 *
 * Trust boundary (ADR-0028). Only the final `git push` runs with the operator's own Git configuration, because that is
 * where the operator's SSH agent and credential helper live (FR-GIT-06: "through the operator's existing Git
 * configuration"). Every other Git call here, including every check, uses the hardened helper of
 * `src/workspace/git.ts` (no global or system configuration, no hooks, no inherited `GIT_*`). The push itself gets:
 *
 * - an environment built from an allowlist ({@link PUSH_ENV_ALLOWLIST}: where the operator's configuration, SSH agent,
 *   credential-helper session bus and proxy are found) plus `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`; no inherited
 *   `GIT_*` variable (so no `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_CONFIG_*`), no `SSH_ASKPASS`, no `DISPLAY`;
 * - its own session (`detached`, so no controlling terminal: SSH cannot prompt on `/dev/tty`), standard input closed,
 *   and a timeout that kills the whole process group;
 * - `-c` overrides at command scope ({@link PUSH_CONFIG}): hooks off, `push.default=nothing`, no tag following, no
 *   signing, no submodule recursion, and only the `https`, `ssh` and `file` transports;
 * - `push --porcelain --no-verify --no-follow-tags --no-signed --recurse-submodules=no -- <remote> <sha>:<ref>`.
 *
 * Before that push, the repository's OWN configuration (local and worktree scope, which any agent that ever had a
 * shell in a worktree of the repository could have written) must not set a key that makes Git run a program or
 * redirect or weaken the transport ({@link UNSAFE_REPO_CONFIG_PATTERN}); the configured push URLs must use an allowed
 * transport and carry no credentials. The controller never reads, prints or stores a credential: it never asks for
 * one, keeps no Git output, and holds the push URL only in memory to classify it.
 */
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { primaryContext, type ResolvedProject } from "../config/projects.js";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import { createLedger, type GitPushRow, type Ledger } from "../ledger/index.js";
import { git, gitText } from "../workspace/git.js";
import type { CredentialReach } from "./credential-reach.js";
import { DEFAULT_PUBLISH_PREFIX, isRunBranchRef, publishRefFor } from "./publish-ref.js";
import { isBranchPrefix, isRemoteName } from "./push-names.js";

export { isBranchPrefix, isRemoteName } from "./push-names.js";

/** Reason codes recorded in `git_push.detail` and the event (fixed vocabulary; nothing from Git's output). */
export type PushReason =
  | "ACCEPTED"
  | "UP_TO_DATE"
  | "NO_PROJECT"
  | "CONTEXT_UNKNOWN"
  | "POLICY_NONE"
  | "CREDENTIAL_REACH"
  | "GIT_POLICY_VIOLATION"
  | "REMOTE_INVALID"
  | "PREFIX_INVALID"
  | "CONTEXT_MISMATCH"
  | "REMOTE_UNKNOWN"
  | "NOTHING_TO_PUSH"
  | "PUBLISH_HISTORY_UNVERIFIED"
  | "TARGET_PROTECTED"
  | "REPO_CONFIG_UNSAFE"
  | "REMOTE_URL_CREDENTIALS"
  | "REMOTE_TRANSPORT_NOT_ALLOWED"
  | "NON_FAST_FORWARD"
  | "REMOTE_HOOK_DECLINED"
  | "REMOTE_REJECTED"
  | "CREDENTIALS_UNAVAILABLE"
  | "REMOTE_UNREACHABLE"
  | "TIMEOUT"
  | "GIT_FAILED";

/** Error codes returned to the agent (LLD §12.1 plus `NOTHING_TO_PUSH`, `REMOTE_UNREACHABLE`, `GIT_FAILED`). */
export type PushToolCode =
  | "PUSH_NOT_ALLOWED"
  | "NOTHING_TO_PUSH"
  | "REMOTE_REJECTED"
  | "CREDENTIALS_UNAVAILABLE"
  | "REMOTE_UNREACHABLE"
  | "GIT_FAILED";

export const GIT_PUSH_EVENT = "git_push";

/** Push target of a meta-session's primary context, read from the CURRENT configuration at push time. */
export interface PushContextConfig {
  readonly projectId: string;
  readonly contextId: string;
  /** The context's repository path as configured; must resolve to the meta-session's repository. */
  readonly path: string;
  readonly baseRef: string;
  readonly policy: "none" | "branch";
  readonly remote?: string;
  readonly branchPrefix?: string;
}

/** {@link GitPusherOptions.resolveContext} over the loaded configuration's projects (primary context). */
export function pushContextResolver(
  projects: readonly ResolvedProject[],
): (projectId: string) => PushContextConfig | undefined {
  return (projectId) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const c = primaryContext(project);
    return {
      projectId: project.id,
      contextId: c.id,
      path: c.path,
      baseRef: c.baseRef,
      policy: c.push.policy,
      ...(c.push.remote !== undefined ? { remote: c.push.remote } : {}),
      ...(c.push.branchPrefix !== undefined ? { branchPrefix: c.push.branchPrefix } : {}),
    };
  };
}

export interface GitPusherOptions {
  readonly db: Database.Database;
  /** The primary context of a project in the current configuration, or undefined when the project is gone. */
  readonly resolveContext: (projectId: string) => PushContextConfig | undefined;
  /** Local publish ref prefix; must match the commit library's (default `switchboard/pub/`). */
  readonly publishPrefix?: string;
  /** Environment the allowlisted variables are copied from (default `process.env`). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  /** Wall-clock bound of one `git push` (default {@link DEFAULT_PUSH_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
}

export interface PushRequest {
  readonly metaSessionId: string;
  readonly requestedBy: "agent_tool" | "operator";
  /** The calling run (agent pushes only). */
  readonly runId?: string;
  /** BR-31 verdict for the calling run, evaluated by the channel at call time (agent pushes only). */
  readonly agentReach?: CredentialReach;
}

export interface PushResult {
  readonly pushId: string;
  readonly outcome: GitPushRow["outcome"];
  readonly reason: PushReason;
  /** True when the remote ref now holds `headSha` (pushed now or already up to date). */
  readonly pushed: boolean;
  readonly remote: string;
  readonly ref: string;
  readonly headSha: string;
  /** Controller commits (newest first) that the push covered; empty unless the history was verified. */
  readonly commits: readonly string[];
  /** The run whose events hold the `git_push` record. */
  readonly eventRunId: string;
  readonly toolCode?: PushToolCode;
}

/** Thrown when there is nothing to record against (unknown meta-session, or no run in it). Nothing is written. */
export class PushError extends Error {
  override readonly name = "PushError";
}

/** Proposed (Delegated, ADR-0028): below the shim's 120 s call timeout. */
export const DEFAULT_PUSH_TIMEOUT_MS = 90_000;
/** Most commits a push may cover; longer histories are refused (Proposed). */
export const MAX_PUSH_COMMITS = 10_000;
/** Most commit SHAs listed in one `git_push` event (the count is always recorded). */
export const MAX_EVENT_COMMITS = 500;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Variables copied from the controller's environment into the push (ADR-0028). Where Git finds the operator's global
 * configuration (`HOME`, `XDG_CONFIG_HOME`), SSH agent (`SSH_AUTH_SOCK`), user identity for SSH (`USER`, `LOGNAME`), a
 * credential helper's session bus (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`), HTTPS proxy and CA settings, and
 * `PATH`. They are passed to the controller's own `git` child only, never to an agent, and never recorded.
 */
export const PUSH_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** Command-scope configuration of the push (command scope overrides every configuration file). */
export const PUSH_CONFIG: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "push.default=nothing",
  "-c",
  "push.followTags=false",
  "-c",
  "push.gpgSign=false",
  "-c",
  "push.recurseSubmodules=no",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "protocol.file.allow=always",
];

/**
 * Keys that, in the repository's own configuration, make the push run a program, redirect it or weaken its transport
 * (POSIX ERE over Git's canonical key names; a subsection keeps its case, which `.*` matches). Their presence at
 * `local` or `worktree` scope refuses the push (`REPO_CONFIG_UNSAFE`); the same keys in the operator's global or system
 * configuration are the operator's own and are honoured. Not exhaustive (ADR-0028): the BR-31 rule and the transport
 * allowlist are the main controls.
 */
export const UNSAFE_REPO_CONFIG_PATTERN = String.raw`^(core\.(sshcommand|gitproxy|askpass)|credential\.(.*\.)?helper|remote\..*\.(receivepack|uploadpack|vcs|mirror)|url\..*\.(insteadof|pushinsteadof)|http\.(.*\.)?sslverify|protocol\..*)$`;

/** The push environment: allowlisted variables only, then the fixed Git settings. */
export function pushEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PUSH_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string" && v !== "") env[key] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  return env;
}

/** argv of the push (after `git`). Throws on anything that is not a plain fast-forward-only branch update. */
export function pushArgs(remote: string, sha: string, ref: string): string[] {
  if (!isRemoteName(remote)) throw new Error("invalid remote name");
  if (!isFullSha(sha)) throw new Error("invalid commit id");
  if (!ref.startsWith("refs/heads/") || ref.includes(":") || ref.startsWith("+")) throw new Error("invalid target ref");
  return [
    ...PUSH_CONFIG,
    "push",
    "--porcelain",
    "--no-verify",
    "--no-follow-tags",
    "--no-signed",
    "--recurse-submodules=no",
    "--",
    remote,
    `${sha}:${ref}`,
  ];
}

/** Remote target ref of a meta-session: `refs/heads/<branchPrefix><sess>`. */
export function remoteTargetRef(branchPrefix: string, metaSessionId: string): string {
  return `refs/heads/${branchPrefix}${metaSessionId}`;
}

export type RemoteUrlClass = "ok" | "credentials" | "transport";

/**
 * Classify one configured push URL without regular expressions. Allowed: `https://`, `ssh://` (and `git+ssh://`,
 * `ssh+git://`), `file://`, scp-like `[user@]host:path`, and local paths. Refused: any other scheme (`http`, `git`,
 * `ext::` and other remote helpers) as `transport`; any `https` userinfo (tokens are commonly carried as the user name)
 * and any password in other forms as `credentials`. The URL itself is never returned or recorded.
 */
export function classifyRemoteUrl(url: string): RemoteUrlClass {
  if (url.includes("::")) return "transport";
  const sep = url.indexOf("://");
  if (sep !== -1) {
    const scheme = url.slice(0, sep).toLowerCase();
    if (!["https", "ssh", "git+ssh", "ssh+git", "file"].includes(scheme)) return "transport";
    const rest = url.slice(sep + 3);
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const at = authority.lastIndexOf("@");
    if (at === -1) return "ok";
    const userinfo = authority.slice(0, at);
    if (scheme === "https" || userinfo.includes(":")) return "credentials";
    return "ok";
  }
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  const scpLike = colon !== -1 && (slash === -1 || colon < slash);
  if (!scpLike) return "ok"; // a local path
  const at = url.lastIndexOf("@");
  if (at !== -1 && url.slice(0, at).includes(":")) return "credentials";
  return "ok";
}

interface SessionRow {
  id: string;
  project_id: string | null;
  repo_root: string | null;
  base_commit: string | null;
}

interface Attempt {
  projectId: string;
  contextId: string;
  remote: string;
  ref: string;
  headSha: string;
  commits: string[];
  reachReason?: string;
}

class Refusal extends Error {
  constructor(readonly reason: PushReason) {
    super(reason);
  }
}

export class GitPusher {
  private readonly ledger: Ledger;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: GitPusherOptions) {
    this.now = options.now ?? (() => new Date());
    this.ledger = createLedger(options.db, { ids: options.ids ?? defaultIds, now: this.now });
  }

  /** Push a meta-session's publish ref (LLD §12.6). Pushes of one meta-session run one at a time in this process. */
  async push(req: PushRequest): Promise<PushResult> {
    const key = req.metaSessionId;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(() => this.pushOnce(req));
    this.locks.set(key, p);
    try {
      return await p;
    } finally {
      if (this.locks.get(key) === p) this.locks.delete(key);
    }
  }

  private async pushOnce(req: PushRequest): Promise<PushResult> {
    const session = this.options.db
      .prepare("SELECT id, project_id, repo_root, base_commit FROM meta_session WHERE id = ?")
      .get(req.metaSessionId) as SessionRow | undefined;
    if (!session) throw new PushError(`unknown meta-session ${req.metaSessionId}`);
    if (req.requestedBy === "agent_tool" && req.runId === undefined) throw new PushError("an agent push needs its run");
    const eventRunId = req.runId ?? this.operatorEventRun(session.id);
    const att: Attempt = {
      projectId: session.project_id ?? "",
      contextId: "",
      remote: "",
      ref: "",
      headSha: "",
      commits: [],
    };
    try {
      const outcome = await this.checkAndPush(req, session, att);
      return this.record(req, att, eventRunId, outcome.outcome, outcome.reason);
    } catch (err) {
      if (err instanceof Refusal) return this.record(req, att, eventRunId, "REFUSED_POLICY", err.reason);
      // A Git check failed (GitError) or anything unexpected: still one record (FR-GIT-05), never the error text.
      return this.record(req, att, eventRunId, "ERROR", "GIT_FAILED");
    }
  }

  private async checkAndPush(
    req: PushRequest,
    session: SessionRow,
    att: Attempt,
  ): Promise<{ outcome: GitPushRow["outcome"]; reason: PushReason }> {
    // 1. Policy and BR-31 (no Git call yet).
    if (session.project_id === null) throw new Refusal("NO_PROJECT");
    const ctx = this.options.resolveContext(session.project_id);
    if (ctx === undefined) throw new Refusal("CONTEXT_UNKNOWN");
    att.contextId = ctx.contextId;
    if (ctx.policy !== "branch") throw new Refusal("POLICY_NONE");
    if (req.requestedBy === "agent_tool") {
      const reach = req.agentReach;
      if (reach === undefined || !reach.ok) {
        att.reachReason = reach && !reach.ok ? reach.reason : "not_evaluated";
        throw new Refusal("CREDENTIAL_REACH");
      }
    }
    // Q-44 (Delegated, fail closed): any recorded Git policy violation in the meta-session refuses publication.
    if (this.hasViolation(session.id)) throw new Refusal("GIT_POLICY_VIOLATION");
    if (!isRemoteName(ctx.remote)) throw new Refusal("REMOTE_INVALID");
    att.remote = ctx.remote;
    if (!isBranchPrefix(ctx.branchPrefix)) throw new Refusal("PREFIX_INVALID");
    att.ref = remoteTargetRef(ctx.branchPrefix, session.id);
    if (!session.repo_root || !session.base_commit) throw new Refusal("NOTHING_TO_PUSH");
    const repo = session.repo_root;

    // 2. Repository and target checks, all through the hardened helper (no operator configuration, no hooks).
    if (!(await samePath(ctx.path, repo))) throw new Refusal("CONTEXT_MISMATCH");
    const fmt = await git(["check-ref-format", att.ref], { cwd: repo, okCodes: [1] });
    if (fmt.code !== 0 || isRunBranchRef(att.ref)) throw new Refusal("PREFIX_INVALID");
    const remotes = (await gitText(["remote"], { cwd: repo })).split("\n").filter((r) => r !== "");
    if (!remotes.includes(att.remote)) throw new Refusal("REMOTE_UNKNOWN");

    const publishRef = publishRefFor(session.id, this.options.publishPrefix ?? DEFAULT_PUBLISH_PREFIX);
    const head = await resolveCommit(repo, publishRef);
    const base = await resolveCommit(repo, session.base_commit);
    if (head === undefined || base === undefined || head === base) throw new Refusal("NOTHING_TO_PUSH");
    att.headSha = head;
    att.commits = await this.verifiedHistory(repo, session.id, head, base);
    if (await this.isProtectedTarget(repo, att.remote, att.ref, ctx.baseRef)) throw new Refusal("TARGET_PROTECTED");
    if (await repoConfigUnsafe(repo)) throw new Refusal("REPO_CONFIG_UNSAFE");
    const urls = (await gitText(["remote", "get-url", "--push", "--all", att.remote], { cwd: repo }))
      .split("\n")
      .filter((u) => u !== "");
    if (urls.length === 0) throw new Refusal("REMOTE_UNKNOWN");
    for (const u of urls) {
      const cls = classifyRemoteUrl(u);
      if (cls === "credentials") throw new Refusal("REMOTE_URL_CREDENTIALS");
      if (cls === "transport") throw new Refusal("REMOTE_TRANSPORT_NOT_ALLOWED");
    }

    // 3. The push, with the operator's own configuration (ADR-0028).
    const run = await runGitPush(
      repo,
      pushArgs(att.remote, head, att.ref),
      pushEnv(this.options.sourceEnv ?? process.env),
      this.options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS,
    );
    return classifyPush(run, att.ref);
  }

  /** Every commit from the base to the head must be a commit this controller published for this meta-session. */
  private async verifiedHistory(repo: string, sessionId: string, head: string, base: string): Promise<string[]> {
    const anc = await git(["merge-base", "--is-ancestor", base, head], { cwd: repo, okCodes: [1] });
    if (anc.code !== 0) throw new Refusal("PUBLISH_HISTORY_UNVERIFIED");
    const listed = (
      await gitText(["rev-list", `--max-count=${MAX_PUSH_COMMITS + 1}`, head, "--not", base], { cwd: repo })
    )
      .split("\n")
      .filter((s) => s !== "");
    if (listed.length === 0 || listed.length > MAX_PUSH_COMMITS) throw new Refusal("PUBLISH_HISTORY_UNVERIFIED");
    const known = new Set(this.ledger.listGitCommitsForMetaSession(sessionId).map((r) => r.commit_sha));
    if (!listed.every((sha) => known.has(sha))) throw new Refusal("PUBLISH_HISTORY_UNVERIFIED");
    return listed;
  }

  /** The default branch (remote `HEAD`, the context's base ref) or any checked-out branch must never be the target. */
  private async isProtectedTarget(repo: string, remote: string, ref: string, baseRef: string): Promise<boolean> {
    const short = ref.slice("refs/heads/".length);
    const names = new Set<string>();
    const strip = (r: string) => (r.startsWith("refs/heads/") ? r.slice("refs/heads/".length) : r);
    names.add(strip(baseRef));
    const mainHead = await git(["symbolic-ref", "-q", "HEAD"], { cwd: repo, okCodes: [1] });
    const mh = mainHead.stdout.toString("utf8").trim();
    if (mh.startsWith("refs/heads/")) names.add(strip(mh));
    const wt = await gitText(["worktree", "list", "--porcelain"], { cwd: repo });
    for (const line of wt.split("\n")) {
      if (line.startsWith("branch refs/heads/")) names.add(line.slice("branch refs/heads/".length));
    }
    const remoteHead = await git(["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`], { cwd: repo, okCodes: [1] });
    const rh = remoteHead.stdout.toString("utf8").trim();
    const remotePrefix = `refs/remotes/${remote}/`;
    if (rh.startsWith(remotePrefix)) names.add(rh.slice(remotePrefix.length));
    return names.has(short);
  }

  private hasViolation(sessionId: string): boolean {
    const row = this.options.db
      .prepare(
        `SELECT 1 FROM run_event e JOIN run r ON r.id = e.run_id
         WHERE r.meta_session_id = ? AND e.type = 'git_policy_violation' LIMIT 1`,
      )
      .get(sessionId);
    return row !== undefined;
  }

  /** For an operator push: the run of the newest published commit, else the newest run of the meta-session. */
  private operatorEventRun(sessionId: string): string {
    const commits = this.ledger.listGitCommitsForMetaSession(sessionId);
    const newest = commits[commits.length - 1];
    if (newest) return newest.run_id;
    const run = this.options.db
      .prepare("SELECT id FROM run WHERE meta_session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(sessionId) as { id: string } | undefined;
    if (!run) throw new PushError(`meta-session ${sessionId} has no run to record the push against`);
    return run.id;
  }

  private record(
    req: PushRequest,
    att: Attempt,
    eventRunId: string,
    outcome: GitPushRow["outcome"],
    reason: PushReason,
  ): PushResult {
    const pushed = outcome === "ACCEPTED";
    const commits = pushed || outcome === "REJECTED_REMOTE" || outcome === "ERROR" ? att.commits : [];
    const { row } = this.ledger.recordGitPush({
      runId: req.requestedBy === "agent_tool" ? (req.runId ?? null) : null,
      eventRunId,
      projectId: att.projectId,
      contextId: att.contextId,
      remote: att.remote,
      ref: att.ref,
      headSha: att.headSha,
      outcome,
      detail: reason,
      requestedBy: req.requestedBy,
      eventPayload: {
        outcome,
        reason,
        requested_by: req.requestedBy,
        remote: att.remote,
        ref: att.ref,
        head_sha: att.headSha,
        commit_count: commits.length,
        commits: commits.slice(0, MAX_EVENT_COMMITS),
        ...(commits.length > MAX_EVENT_COMMITS ? { commits_truncated: true } : {}),
        ...(att.reachReason !== undefined ? { credential_reach: att.reachReason } : {}),
      },
    });
    const toolCode = toolCodeFor(outcome, reason);
    return {
      pushId: row.id,
      outcome,
      reason,
      pushed,
      remote: att.remote,
      ref: att.ref,
      headSha: att.headSha,
      commits,
      eventRunId,
      ...(toolCode !== undefined ? { toolCode } : {}),
    };
  }
}

function toolCodeFor(outcome: GitPushRow["outcome"], reason: PushReason): PushToolCode | undefined {
  if (outcome === "ACCEPTED") return undefined;
  if (outcome === "REFUSED_POLICY") return reason === "NOTHING_TO_PUSH" ? "NOTHING_TO_PUSH" : "PUSH_NOT_ALLOWED";
  if (outcome === "REJECTED_REMOTE") return "REMOTE_REJECTED";
  if (reason === "CREDENTIALS_UNAVAILABLE") return "CREDENTIALS_UNAVAILABLE";
  if (reason === "REMOTE_UNREACHABLE" || reason === "TIMEOUT") return "REMOTE_UNREACHABLE";
  if (reason === "REMOTE_TRANSPORT_NOT_ALLOWED") return "PUSH_NOT_ALLOWED";
  return "GIT_FAILED";
}

function isFullSha(s: string): boolean {
  if (s.length !== 40) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

async function resolveCommit(repo: string, rev: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], {
    cwd: repo,
    okCodes: [1],
  });
  const sha = r.stdout.toString("utf8").trim();
  return r.code === 0 && isFullSha(sha) ? sha : undefined;
}

async function samePath(a: string, b: string): Promise<boolean> {
  if (!path.isAbsolute(a)) return false;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/** True when the repository's own (`local` or `worktree` scope) configuration sets an unsafe key. Names only, no values. */
export async function repoConfigUnsafe(repo: string): Promise<boolean> {
  const r = await git(["config", "-z", "--show-scope", "--name-only", "--get-regexp", UNSAFE_REPO_CONFIG_PATTERN], {
    cwd: repo,
    okCodes: [1],
  });
  if (r.code === 1) return false;
  const parts = r.stdout.toString("utf8").split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    if (scope !== "command") return true; // global and system are off in the hardened helper: local, worktree
  }
  return false;
}

export interface GitPushRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: boolean;
}

/** Run `git <args>` in its own session with the push environment; output is kept in memory only, bounded. */
export function runGitPush(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<GitPushRun> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("git", [...args], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      if (out.length < MAX_OUTPUT_BYTES) out += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < MAX_OUTPUT_BYTES) err += b.toString("utf8");
    });
    const finish = (r: GitPushRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on("error", () => finish({ code: null, stdout: out, stderr: err, timedOut, spawnError: true }));
    child.on("close", (code) => finish({ code, stdout: out, stderr: err, timedOut, spawnError: false }));
  });
}

/**
 * Map the push result to an outcome and reason. `--porcelain` prints one `<flag>\t<from>:<to>\t<summary>` line per
 * ref on stdout; only the flag and fixed summary words are inspected. Without a status line, standard error is
 * matched against a few fixed phrases of Git and SSH (case-insensitive substrings); the text itself is discarded.
 */
export function classifyPush(run: GitPushRun, ref: string): { outcome: GitPushRow["outcome"]; reason: PushReason } {
  if (run.timedOut) return { outcome: "ERROR", reason: "TIMEOUT" };
  if (run.spawnError) return { outcome: "ERROR", reason: "GIT_FAILED" };
  for (const line of run.stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 3 || !(fields[1] ?? "").endsWith(`:${ref}`)) continue;
    const flag = line.charAt(0);
    const summary = (fields[2] ?? "").toLowerCase();
    if (flag === "=") return { outcome: "ACCEPTED", reason: "UP_TO_DATE" };
    if (flag === " " || flag === "*" || flag === "+") {
      return run.code === 0 ? { outcome: "ACCEPTED", reason: "ACCEPTED" } : { outcome: "ERROR", reason: "GIT_FAILED" };
    }
    if (flag === "!") {
      if (summary.includes("non-fast-forward") || summary.includes("fetch first")) {
        return { outcome: "REJECTED_REMOTE", reason: "NON_FAST_FORWARD" };
      }
      if (summary.includes("hook declined")) return { outcome: "REJECTED_REMOTE", reason: "REMOTE_HOOK_DECLINED" };
      return { outcome: "REJECTED_REMOTE", reason: "REMOTE_REJECTED" };
    }
  }
  const e = run.stderr.toLowerCase();
  const has = (...phrases: string[]) => phrases.some((p) => e.includes(p));
  if (has("transport") && has("not allowed")) return { outcome: "ERROR", reason: "REMOTE_TRANSPORT_NOT_ALLOWED" };
  if (
    has(
      "terminal prompts disabled",
      "could not read username",
      "could not read password",
      "authentication failed",
      "permission denied",
    )
  ) {
    return { outcome: "ERROR", reason: "CREDENTIALS_UNAVAILABLE" };
  }
  if (
    has(
      "could not resolve host",
      "connection refused",
      "connection timed out",
      "host key verification failed",
      "does not appear to be a git repository",
      "could not read from remote repository",
      "unable to access",
    )
  ) {
    return { outcome: "ERROR", reason: "REMOTE_UNREACHABLE" };
  }
  return { outcome: "ERROR", reason: "GIT_FAILED" };
}
