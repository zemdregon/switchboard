/**
 * `COMP-GIT` tool service: the controller side of the per-run injected tool channel (FR-GIT-02, LLD §12.1, §12.2;
 * ADR-0014, ADR-0026; T9.4). For one RUNNING run it owns a Unix domain socket in a controller-owned directory, a random
 * one-run capability token, and the dispatch of `commit` calls to {@link GitPublisher.commit} (T9.3).
 *
 * Trust boundary (TB-7, HLD): everything arriving on the socket is untrusted. Each call is re-checked in this order and
 * refused with a code and NO side effect other than a `git_tool_denied` run event (code only, never content or token):
 *
 *   1. framing: one line, at most {@link MAX_REQUEST_BYTES}, within the read timeout;
 *   2. rate limit per channel (every request counts, refused ones too), then a JSON object of the exact shape;
 *   3. channel still open; token equal to this run's (SHA-256 digests compared with `timingSafeEqual`);
 *   4. tool offered on this channel (`commit` always; `push` only when the run was offered it at open, T9.6;
 *      `search_project_context` only when retrieval was on for the run's project at open, T12.9);
 *   5. arguments: `commit` takes exactly `message` (1..8192 characters) and optional `paths` (1..256 strings of at
 *      most 4096); `push` takes none (an empty object); `search_project_context` takes `query`, `limit`, `scope`;
 *   6. run exists, is RUNNING, and still has the meta-session and worktree the token was bound to;
 *   7. `commit`: the commit library re-checks state and lease, refuses paths outside the worktree
 *      (`PATH_OUTSIDE_WORKTREE`, `PATH_REFUSED`), sanitises the message and writes provenance (FR-GIT-04, FR-GIT-07);
 *      with `sign` (T9.10) it signs with the operator's setup after the BR-31 rule passes, else `SIGNING_FAILED`.
 *      `push` (T9.6, ADR-0028): at most {@link ChannelLimits.maxPushesPerChannel} attempts per channel; the BR-31
 *      credential-reach rule is evaluated again from the run's frozen policy snapshot; then {@link GitPusher.push}
 *      applies the policy, violation, ref and never-force rules and records every attempt in `git_push`.
 *
 * Secrets: the token is created here, returned once (for the shim's environment) and kept in memory only as its
 * SHA-256 digest. It is never written to the ledger, an artifact, a log line or the file system. The artifact redactor
 * recognises its prefix (`src/artifacts/redact.ts`), so a provider that prints it does not persist it.
 *
 * Commit-message task (T11.4, FR-INN-10, LLD §12.1): with an inner-agent service whose `commit_message` task is
 * enabled with a mode other than `never`, and a project setting other than `off` when the channel opens, the channel is
 * opened with `message` optional (the shim gets `--message-optional`) and every `commit` call hands the commit library a
 * {@link CommitMessageTask} whose project setting is resolved again at call time (a later `off` or `local_only` then
 * denies the draft in the inner pipeline's privacy gate, LLD §13.5). Without that, nothing here changes: the schema,
 * the argument check and the library call are exactly as before. The service never sees the agent's message, and the
 * library sanitises whatever it returns before Git sees it.
 *
 * Project search (T12.9; FR-RAG-13, LLD §14.7, ADR-0026): with a {@link ChannelSearchPort} that reports retrieval on for
 * the run's project when the channel opens, the channel also offers the read-only `search_project_context` tool. Its
 * calls pass steps 1 to 4 and 6 like any other; step 5 takes exactly `query` (1..{@link MAX_QUERY_LENGTH} characters)
 * and optional `limit` (1..{@link MAX_SEARCH_LIMIT}) and `scope`, so a call naming a `project`, a `path` or anything
 * else is `INVALID_ARGUMENTS`; step 7 hands the port the project id bound at open, never one from the request. The port
 * is the T12.6 handler wired in `serve`: this module does not import the retrieval service (FR-RAG-07 import
 * boundary), and the snippets it relays are untrusted data that reach no decision here. Without a port, or with
 * retrieval off for the project, the tool list, the shim argv and the channel file are exactly as before.
 *
 * Channel files (T9.4b, ADR-0029): `OpenChannel.writeFile` writes one of `CHANNEL_FILE_NAMES` (the Claude Code
 * `--mcp-config` definition) into the same private directory, `0600`, exclusive create, no link following; it never
 * holds the token and is removed with the socket.
 *
 * Peer credentials: Node.js exposes no `SO_PEERCRED`, so the peer process is not identified (documented absence,
 * ADR-0026). The controls are the `0700` directory owned by the controller's user, the `0600` socket and the token. A
 * process of the same OS user that can read the provider's environment can use the token while the run is RUNNING; that
 * is the same reach the agent itself has and is why the token is per run and dies with the run.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open as openFile, rmdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ShimSpec } from "../adapters/types.js";
import type { ProjectInnerSetting } from "../config/inner-agent.js";
import { commitMessageMode, createCommitMessageTask, type InnerAgentService } from "../inner/index.js";
import { createLedger, type Ledger } from "../ledger/index.js";
import { bypassApprovedFor } from "../lifecycle/approval.js";
import { CommitError, type GitPublisher } from "./commit.js";
import { credentialReachFromJson, signingReachFromJson } from "./credential-reach.js";
import type { GitPusher } from "./push.js";
import { describeSecretScanFindings, SECRET_SCAN_FIX_HINT, secretScanFindings } from "./secret-scan.js";
import {
  CHANNEL_FILE_NAMES,
  type ChannelErrorCode,
  isTokenShaped,
  MAX_COMMIT_PATH_CHARS,
  MAX_COMMIT_PATHS,
  MAX_QUERY_LENGTH,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SEARCH_LIMIT,
  MAX_SOCKET_PATH_BYTES,
  MAX_TOOL_MESSAGE_CHARS,
  MESSAGE_OPTIONAL_FLAG,
  PROTOCOL_VERSION,
  SEARCH_TOOL,
  TOKEN_PREFIX,
  TOKEN_RANDOM_BYTES,
  TOOL_TOKEN_ENV,
  type ToolName,
  type ToolResponse,
} from "./tool-protocol.js";

/** Run event types written by the service (no token, no message text, no path content). */
export const GIT_CHANNEL_OPENED = "git_channel_opened";
export const GIT_CHANNEL_CLOSED = "git_channel_closed";
export const GIT_TOOL_DENIED = "git_tool_denied";

export const SOCKET_FILE_NAME = "tools.sock";
/** Prefix of a fallback socket directory created with `mkdtemp` when the data-directory path is too long. */
export const FALLBACK_DIR_PREFIX = "sb-git-";

/** Per-channel limits (Proposed, Delegated, ADR-0026). */
export interface ChannelLimits {
  /** Requests accepted per rolling minute (refused requests count too). */
  readonly maxCallsPerMinute: number;
  /** Simultaneous connections; further connects are dropped by the server. */
  readonly maxConnections: number;
  /** Time allowed to send the request line after connecting. */
  readonly requestTimeoutMs: number;
  /** `git_tool_denied` events written per channel; further refusals are only counted (in `git_channel_closed`). */
  readonly maxRefusalEvents: number;
  /** `push` calls that reach the push library per channel (each writes a `git_push` row); later ones are refused. */
  readonly maxPushesPerChannel: number;
}

export const DEFAULT_CHANNEL_LIMITS: ChannelLimits = {
  maxCallsPerMinute: 60,
  maxConnections: 8,
  requestTimeoutMs: 10_000,
  maxRefusalEvents: 32,
  maxPushesPerChannel: 10,
};

/** T12.9: what the channel passes to {@link ChannelSearchPort.search}; `projectId` is the one bound at open. */
export interface ChannelSearchInput {
  readonly runId: string;
  readonly projectId: string;
  readonly query: string;
  readonly limit?: number;
  readonly scope?: "project" | "global" | "both";
}

/**
 * T12.9 (FR-RAG-13): the T12.6 `search_project_context` handler as the channel sees it, structurally typed so that
 * `COMP-GIT` never imports the retrieval service (FR-RAG-07). Wired in `serve` (`src/mcp/channel-search.ts`).
 */
export interface ChannelSearchPort {
  /** Whether retrieval is on for the project (asked once at open; the tool is offered only then). A throw is false. */
  offeredFor(projectId: string): boolean;
  /**
   * Search the project. `ok: true` carries the T12.6 result as is (`status`, `reason`, `results`, ...), including
   * `unavailable` with `NOT_BUILT` when the project has no index; a refusal names a code the channel returns.
   */
  search(
    input: ChannelSearchInput,
  ): Promise<
    { readonly ok: true; readonly result: Record<string, unknown> } | { readonly ok: false; readonly code: string }
  >;
}

export interface GitToolServiceOptions {
  readonly db: Database.Database;
  /** Controller data directory; sockets go under `<dataDir>/runs/<run_id>/` when the path is short enough. */
  readonly dataDir: string;
  readonly publisher: GitPublisher;
  /** Push library (T9.6). Without it no channel offers `push`. */
  readonly pusher?: GitPusher;
  /** argv prefix that starts the shim, ending in the `tool-shim` subcommand; `--socket <path>` is appended. */
  readonly shimCommand: readonly string[];
  /**
   * Short directories, in order of preference, for a socket whose data-directory path exceeds
   * {@link MAX_SOCKET_PATH_BYTES} (for example `$XDG_RUNTIME_DIR`, then the OS temporary directory). A private
   * `sb-git-XXXXXX` directory is created inside the first that works.
   */
  readonly fallbackDirs?: readonly string[];
  readonly limits?: Partial<ChannelLimits>;
  readonly now?: () => Date;
  /**
   * T11.4 (FR-INN-10): the inner-agent service. The `commit_message` task is offered only when it reports the task
   * enabled with a mode other than `never`; absent, or off, the `commit` tool is exactly as before.
   */
  readonly innerAgent?: InnerAgentService;
  /**
   * T11.4 (LLD §13.1, T11.3 note): the effective project/context `inner_agent` setting, resolved from the current
   * configuration at channel open and again at every call. Absent: `inherit`. A throw is read as `off` (fail closed).
   */
  readonly innerSettingFor?: (projectId: string, contextId: string) => ProjectInnerSetting;
  /**
   * T12.9 (FR-RAG-13): read-only project search. Absent: no channel offers `search_project_context`, and everything
   * here is exactly as before.
   */
  readonly search?: ChannelSearchPort;
}

/** Facts bound to the token when the channel opens, frozen at admission (policy snapshot) or at LEASED. */
export interface OpenChannelInput {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly worktreePath: string;
  readonly identity: { readonly name: string; readonly email: string };
  readonly projectId: string;
  readonly contextId: string;
  /** Provider-native session ids known so far, removed from messages by exact match (FR-GIT-04). */
  readonly nativeSessionIds?: () => readonly string[];
  /**
   * T9.6: offer `push` on this channel. The lifecycle sets it only when the frozen snapshot's push policy is `branch`
   * and BR-31 holds at open; ignored when the service has no pusher. Every call re-checks both.
   */
  readonly offerPush?: boolean;
  /**
   * Owner decision 37: set by the lifecycle only when `push` is offered because the controller verified an approved
   * bypass (the exemption from BR-31). Recorded in `git_channel_opened` as `credential_reach: "bypass_exempt"`. It
   * changes only that record: every call re-derives the verdict from the ledger and never reads this field.
   */
  readonly pushReach?: "bypass_exempt";
  /**
   * T9.10 (FR-GIT-10): the run's frozen project snapshot has `sign: true`. Every `commit` call is then signed by the
   * publisher, after the BR-31 rule is evaluated again for that call (`evaluateSigningReach`, with the same
   * controller-verified bypass exemption as `push`); a refusal or failure is `SIGNING_FAILED`.
   */
  readonly sign?: true;
}

export interface OpenChannel {
  readonly runId: string;
  readonly socketPath: string;
  /** What the adapter needs for `channelArgs`; `env` holds the token. */
  readonly shim: ShimSpec;
  /**
   * T9.4b (ADR-0029 item 1): write one of `CHANNEL_FILE_NAMES` into the channel's private directory with mode `0600`,
   * exclusive create and no link following, and return its absolute path. Refused ({@link ChannelOpenError}) for any
   * other name, a second write of the same name, a closed channel, or contents that look like a token. The file is
   * removed when the channel closes and by {@link GitToolService.sweepStale}.
   */
  writeFile(name: string, contents: string): Promise<string>;
  /** Stop accepting, refuse queued calls, wait for calls in progress, remove the socket and its directory. Idempotent. */
  close(): Promise<void>;
}

export interface SweepReport {
  /** Runs whose leftover socket directory was cleaned up. */
  readonly cleaned: readonly string[];
  /** Runs whose recorded directory was not removed because it failed a safety check or was not empty. */
  readonly skipped: readonly string[];
}

export class ChannelOpenError extends Error {
  override readonly name = "ChannelOpenError";
}

interface ChannelState {
  readonly input: OpenChannelInput;
  readonly tokenDigest: Buffer;
  readonly tools: readonly ToolName[];
  readonly dir: string;
  readonly socketPath: string;
  readonly fallback: boolean;
  readonly server: net.Server;
  readonly sockets: Set<net.Socket>;
  /** Connections whose request line was received and is being answered. */
  readonly dispatching: WeakSet<net.Socket>;
  readonly inFlight: Set<Promise<void>>;
  readonly callTimes: number[];
  /** Absolute paths of the files written by `writeFile` (T9.4b). */
  readonly files: Set<string>;
  /** T11.4: the `commit_message` mode this channel was opened with; undefined means `message` stays required. */
  readonly messageMode: "draft_if_missing" | "always" | undefined;
  closed: boolean;
  closing: Promise<void> | undefined;
  calls: number;
  commits: number;
  pushes: number;
  searches: number;
  refused: number;
  refusalsSuppressed: number;
}

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Codes whose library message is safe and useful to return to the agent as is (it names only the agent's own input). */
const AGENT_MESSAGE_CODES: ReadonlySet<string> = new Set([
  "PATH_OUTSIDE_WORKTREE",
  "PATH_REFUSED",
  "NOTHING_TO_COMMIT",
  "MESSAGE_EMPTY_AFTER_SANITISING",
  "SANITISER_FAILED",
  "INVALID_REQUEST",
  // T11.4: a fixed text asking for a message; it never says why no draft was available.
  "MESSAGE_REQUIRED",
  // T9.10: the message names only a fixed reason code (never Git's or the signing program's output).
  "SIGNING_FAILED",
]);

/** T12.9: refusal codes a {@link ChannelSearchPort} may return; anything else is reported as `INTERNAL_ERROR`. */
const SEARCH_REFUSAL_CODES: ReadonlySet<string> = new Set(["INVALID_ARGUMENTS", "PROJECT_UNAVAILABLE"]);

const GENERIC_MESSAGES: Readonly<Record<string, string>> = {
  MALFORMED_REQUEST: "the request is not a valid tool call",
  REQUEST_TOO_LARGE: "the request is too large",
  REQUEST_TIMEOUT: "the request was not received in time",
  RATE_LIMITED: "too many tool calls; wait and try again",
  PUSH_LIMIT_REACHED: "too many push attempts in this run",
  TOKEN_INVALID: "the tool channel refused this call",
  CHANNEL_CLOSED: "the tool channel is closed",
  UNKNOWN_TOOL: "no such tool",
  RUN_NOT_FOUND: "the run is not known",
  NOT_RUNNING: "the run is not running",
  BINDING_MISMATCH: "the tool channel no longer matches this run",
  LEASE_LOST: "the run no longer holds its workspace lease",
  NO_WORKTREE: "the run has no usable worktree",
  IDENTITY_INVALID: "the configured commit identity is not usable",
  PUBLISH_CONFLICT: "the publish ref kept moving; try again",
  PUBLISH_LINEAGE_VIOLATION: "the commit was refused by a history check",
  GIT_FAILED: "the commit failed in the controller",
  SIGNING_FAILED: "the commit could not be signed; nothing was committed",
  MESSAGE_REQUIRED: "no commit message was given and none could be drafted; call commit again with a message",
  PROJECT_UNAVAILABLE: "the run's project is no longer available for search",
  INTERNAL_ERROR: "the controller could not complete the call",
};

/** `bypassApprovedFor` that fails closed (false) when the ledger rows cannot be evaluated. */
function approvedBypassOf(ledger: Ledger, run: Parameters<typeof bypassApprovedFor>[1]): boolean {
  try {
    return bypassApprovedFor(ledger, run);
  } catch {
    return false;
  }
}

export class GitToolService {
  private readonly ledger: Ledger;
  private readonly limits: ChannelLimits;
  private readonly now: () => Date;
  private readonly channels = new Map<string, ChannelState>();

  constructor(private readonly options: GitToolServiceOptions) {
    if (options.shimCommand.length === 0 || !path.isAbsolute(options.shimCommand[0] as string)) {
      throw new Error("shimCommand must start with an absolute executable path");
    }
    this.now = options.now ?? (() => new Date());
    this.ledger = createLedger(options.db, { now: this.now });
    this.limits = { ...DEFAULT_CHANNEL_LIMITS, ...options.limits };
  }

  /** True when channels can offer `push` (a pusher is configured, T9.6). */
  get pushAvailable(): boolean {
    return this.options.pusher !== undefined;
  }

  /** Number of channels open in this process (tests, shutdown checks). */
  get openCount(): number {
    return this.channels.size;
  }

  /**
   * Create the socket and token for one run and start accepting calls. Call before the provider is spawned; the
   * per-call checks refuse everything until the run is RUNNING. Throws {@link ChannelOpenError} (nothing left behind).
   */
  async open(input: OpenChannelInput): Promise<OpenChannel> {
    if (this.channels.has(input.runId)) throw new ChannelOpenError(`run ${input.runId} already has a tool channel`);
    if (!/^run_[0-9A-Za-z]{1,64}$/u.test(input.runId)) throw new ChannelOpenError("invalid run id");
    // T11.4: decided once per channel, before anything is created; an `off` project keeps `message` required.
    const mode = commitMessageMode(this.options.innerAgent);
    const messageMode =
      mode !== undefined && this.innerSetting(input.projectId, input.contextId) !== "off" ? mode : undefined;
    // T12.9: decided once per channel, like the commit-message mode; a throwing port offers nothing (fail closed).
    const offerSearch = this.searchOffered(input.projectId);
    const { dir, fallback } = await this.socketDir(input.runId);
    const socketPath = path.join(dir, SOCKET_FILE_NAME);
    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")}`;
    // Half-open allowed so a client that ends its side without a newline still gets its refusal; the controller always
    // ends the connection itself after the one answer.
    const server = net.createServer({ allowHalfOpen: true });
    server.maxConnections = this.limits.maxConnections;
    const state: ChannelState = {
      input,
      tokenDigest: digest(token),
      tools: [
        "commit",
        ...(input.offerPush === true && this.options.pusher !== undefined ? (["push"] as const) : []),
        ...(offerSearch ? [SEARCH_TOOL] : []),
      ],
      dir,
      socketPath,
      fallback,
      server,
      sockets: new Set(),
      dispatching: new WeakSet(),
      inFlight: new Set(),
      callTimes: [],
      files: new Set(),
      messageMode,
      closed: false,
      closing: undefined,
      calls: 0,
      commits: 0,
      pushes: 0,
      searches: 0,
      refused: 0,
      refusalsSuppressed: 0,
    };
    server.on("connection", (sock) => this.onConnection(state, sock));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
          server.off("error", reject);
          resolve();
        });
      });
      server.on("error", () => {});
      await chmod(socketPath, 0o600);
      const st = await lstat(socketPath);
      if (!st.isSocket()) throw new Error("socket path is not a socket after listen");
    } catch (err) {
      server.close();
      await removeQuietly(socketPath, dir);
      throw new ChannelOpenError(`could not create the tool socket: ${(err as Error).message}`);
    }
    this.channels.set(input.runId, state);
    this.ledger.appendRunEvent({
      runId: input.runId,
      type: GIT_CHANNEL_OPENED,
      payload: {
        tools: [...state.tools],
        socket_dir: dir,
        fallback,
        ...(state.tools.includes("push") && input.pushReach !== undefined ? { credential_reach: input.pushReach } : {}),
        ...(messageMode !== undefined ? { commit_message: messageMode } : {}),
      },
    });
    return {
      runId: input.runId,
      socketPath,
      shim: {
        command: [
          ...this.options.shimCommand,
          "--socket",
          socketPath,
          "--tools",
          state.tools.join(","),
          ...(messageMode !== undefined ? [MESSAGE_OPTIONAL_FLAG] : []),
        ],
        socketPath,
        dir,
        toolNames: [...state.tools],
        env: { [TOOL_TOKEN_ENV]: token },
      },
      writeFile: (name, contents) => this.writeChannelFile(state, name, contents),
      close: () => this.close(input.runId),
    };
  }

  /** {@link ChannelSearchPort.offeredFor}, failing closed to false. */
  private searchOffered(projectId: string): boolean {
    const port = this.options.search;
    if (port === undefined) return false;
    try {
      return port.offeredFor(projectId) === true;
    } catch {
      return false;
    }
  }

  /** {@link GitToolServiceOptions.innerSettingFor}, failing closed to `off`. */
  private innerSetting(projectId: string, contextId: string): ProjectInnerSetting {
    const resolve = this.options.innerSettingFor;
    if (resolve === undefined) return "inherit";
    try {
      return resolve(projectId, contextId);
    } catch {
      return "off";
    }
  }

  /** {@link OpenChannel.writeFile}. */
  private async writeChannelFile(state: ChannelState, name: string, contents: string): Promise<string> {
    if (!CHANNEL_FILE_NAMES.includes(name)) throw new ChannelOpenError("channel file name not allowed");
    if (state.closed) throw new ChannelOpenError("the tool channel is closed");
    // Defence in depth (FR-POL-08): the token reaches the provider only through its environment.
    if (contents.includes(TOKEN_PREFIX)) throw new ChannelOpenError("channel file contents look like a token");
    const target = path.join(state.dir, name);
    if (state.files.has(target)) throw new ChannelOpenError("channel file already written");
    await assertPrivateDir(state.dir);
    const handle = await openFile(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    state.files.add(target);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    return target;
  }

  /** Close one run's channel (no-op when none is open). */
  async close(runId: string): Promise<void> {
    const state = this.channels.get(runId);
    if (!state) return;
    state.closing ??= this.doClose(state);
    await state.closing;
  }

  /** Close every open channel (controller shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.channels.keys()].map((id) => this.close(id)));
  }

  /**
   * Startup clean-up after a crash (call after reconciliation, before serving): every `git_channel_opened` without a
   * later `git_channel_closed` names a directory whose socket no process serves any more (tokens lived in memory only,
   * so they died with the process). The socket file is unlinked only if it is a socket, and the directory is removed
   * only if it is empty, is the expected `<dataDir>/runs/<run_id>` or an `sb-git-*` directory directly inside one of
   * the configured fallback directories, is not a symbolic link and is owned by this user with no group or other access. Then `git_channel_closed` (`reason: "recovered"`) is appended.
   */
  async sweepStale(): Promise<SweepReport> {
    const rows = this.options.db
      .prepare(
        `SELECT o.run_id AS run_id, o.payload_json AS payload_json FROM run_event o
         WHERE o.type = ? AND NOT EXISTS (
           SELECT 1 FROM run_event c WHERE c.run_id = o.run_id AND c.type = ? AND c.seq > o.seq)
         ORDER BY o.ts, o.seq`,
      )
      .all(GIT_CHANNEL_OPENED, GIT_CHANNEL_CLOSED) as { run_id: string; payload_json: string }[];
    const cleaned: string[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
      if (this.channels.has(row.run_id)) continue;
      let dir: unknown;
      try {
        dir = (JSON.parse(row.payload_json) as { socket_dir?: unknown }).socket_dir;
      } catch {
        dir = undefined;
      }
      const ok = typeof dir === "string" && (await this.safeToRemove(dir, row.run_id));
      if (ok) {
        await removeChannelFiles(dir as string);
        await removeQuietly(path.join(dir as string, SOCKET_FILE_NAME), dir as string);
      }
      const gone = typeof dir === "string" ? !(await exists(dir)) : true;
      (gone ? cleaned : skipped).push(row.run_id);
      this.ledger.appendRunEvent({
        runId: row.run_id,
        type: GIT_CHANNEL_CLOSED,
        payload: { reason: "recovered", removed: gone },
      });
    }
    return { cleaned, skipped };
  }

  // ---- socket directory -----------------------------------------------------------------------------------------

  private async socketDir(runId: string): Promise<{ dir: string; fallback: boolean }> {
    const runsDir = path.join(path.resolve(this.options.dataDir), "runs");
    const preferred = path.join(runsDir, runId);
    if (Buffer.byteLength(path.join(preferred, SOCKET_FILE_NAME)) <= MAX_SOCKET_PATH_BYTES) {
      await mkdir(runsDir, { recursive: true, mode: 0o700 });
      // Never follow a link here: check what `runs` is before tightening it.
      const runs = await lstat(runsDir);
      if (!runs.isDirectory() || runs.isSymbolicLink()) throw new ChannelOpenError(`${runsDir} is not a directory`);
      await chmod(runsDir, 0o700);
      await assertPrivateDir(runsDir);
      try {
        await mkdir(preferred, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Left over from a crash of this same run id: reuse only a private directory we own (checked BEFORE anything
        // inside it is touched), after removing a stale socket and stale channel files (T9.4b).
        await assertPrivateDir(preferred);
        await removeChannelFiles(preferred);
        await removeQuietly(path.join(preferred, SOCKET_FILE_NAME), undefined);
      }
      await assertPrivateDir(preferred);
      return { dir: preferred, fallback: false };
    }
    for (const base of this.options.fallbackDirs ?? []) {
      if (!path.isAbsolute(base)) continue;
      // mkdtemp appends 6 characters; check the final length before creating anything.
      const probe = path.join(base, `${FALLBACK_DIR_PREFIX}XXXXXX`, SOCKET_FILE_NAME);
      if (Buffer.byteLength(probe) > MAX_SOCKET_PATH_BYTES) continue;
      try {
        const dir = await mkdtemp(path.join(base, FALLBACK_DIR_PREFIX));
        await chmod(dir, 0o700);
        await assertPrivateDir(dir);
        return { dir, fallback: true };
      } catch {
        // try the next candidate
      }
    }
    throw new ChannelOpenError(
      `no directory gives a socket path of at most ${MAX_SOCKET_PATH_BYTES} bytes (data directory too long and no usable fallback)`,
    );
  }

  private async safeToRemove(dir: string, runId: string): Promise<boolean> {
    if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) return false;
    const expected = path.join(path.resolve(this.options.dataDir), "runs", runId);
    const fallbackParents = (this.options.fallbackDirs ?? [])
      .filter((d) => path.isAbsolute(d))
      .map((d) => path.resolve(d));
    const isFallback =
      path.basename(dir).startsWith(FALLBACK_DIR_PREFIX) && fallbackParents.includes(path.dirname(dir));
    if (dir !== expected && !isFallback) return false;
    try {
      await assertPrivateDir(dir);
      return true;
    } catch {
      return false;
    }
  }

  // ---- connections --------------------------------------------------------------------------------------------

  private onConnection(state: ChannelState, sock: net.Socket): void {
    if (state.closed) {
      sock.destroy();
      return;
    }
    state.sockets.add(sock);
    sock.on("close", () => state.sockets.delete(sock));
    sock.on("error", () => {});
    let done = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const early = (code: ChannelErrorCode) => {
      if (done) return;
      done = true;
      sock.setTimeout(0);
      sock.pause();
      state.dispatching.add(sock);
      this.dispatchGuarded(state, sock, () => Promise.resolve(this.refuse(state, code, undefined)));
    };
    sock.setTimeout(this.limits.requestTimeoutMs, () => early("REQUEST_TIMEOUT"));
    sock.on("data", (buf: Buffer) => {
      if (done) return;
      const nl = buf.indexOf(10);
      const take = nl === -1 ? buf.length : nl + 1;
      size += take;
      if (size > MAX_REQUEST_BYTES) return early("REQUEST_TOO_LARGE");
      if (nl === -1) {
        chunks.push(buf);
        return;
      }
      chunks.push(buf.subarray(0, nl));
      done = true;
      sock.setTimeout(0);
      sock.pause();
      state.dispatching.add(sock);
      const line = Buffer.concat(chunks);
      this.dispatchGuarded(state, sock, () => this.dispatch(state, line));
    });
    sock.on("end", () => early("MALFORMED_REQUEST"));
  }

  /** Run one dispatch, track it as in flight, write the one-line answer and close the connection. */
  private dispatchGuarded(state: ChannelState, sock: net.Socket, run: () => Promise<ToolResponse>): void {
    const p = run()
      .catch((): ToolResponse => this.refuse(state, "INTERNAL_ERROR", undefined))
      .then((resp) => {
        if (!sock.destroyed) sock.end(`${JSON.stringify(resp)}\n`);
      })
      .finally(() => state.inFlight.delete(p));
    state.inFlight.add(p);
  }

  private async dispatch(state: ChannelState, line: Buffer): Promise<ToolResponse> {
    state.calls += 1;
    // 2. rate limit (before anything parses the request), then shape.
    const t = this.now().getTime();
    while (state.callTimes.length > 0 && (state.callTimes[0] as number) <= t - 60_000) state.callTimes.shift();
    if (state.callTimes.length >= this.limits.maxCallsPerMinute) return this.refuse(state, "RATE_LIMITED", undefined);
    state.callTimes.push(t);

    const req = parseRequest(line);
    if (!req) return this.refuse(state, "MALFORMED_REQUEST", undefined);
    // 3. channel open, token.
    if (state.closed) return this.refuse(state, "CHANNEL_CLOSED", undefined);
    if (!tokenMatches(state.tokenDigest, req.token)) return this.refuse(state, "TOKEN_INVALID", undefined);
    // 4. tool.
    const tool = state.tools.find((n) => n === req.tool);
    if (!tool) return this.refuse(state, "UNKNOWN_TOOL", undefined);
    // 5. arguments.
    if (tool === "push") {
      if (Object.keys(req.arguments).length !== 0) return this.refuse(state, "INVALID_ARGUMENTS", tool);
      return this.dispatchPush(state);
    }
    if (tool === SEARCH_TOOL) {
      const search = parseSearchArguments(req.arguments);
      if ("code" in search) return this.refuse(state, search.code, tool);
      return this.dispatchSearch(state, search);
    }
    const args = parseCommitArguments(req.arguments, state.messageMode !== undefined);
    if ("code" in args) return this.refuse(state, args.code, tool);
    // 6. run state and binding.
    const bound = this.checkRun(state, tool);
    if ("error" in bound) return bound.error;
    // 7. the commit library.
    const innerAgent = this.options.innerAgent;
    const nativeSessionIds = state.input.nativeSessionIds?.() ?? [];
    try {
      const result = await this.options.publisher.commit({
        runId: state.input.runId,
        ...(args.message !== undefined ? { message: args.message } : {}),
        ...(state.messageMode !== undefined && innerAgent !== undefined
          ? {
              messageTask: createCommitMessageTask(innerAgent, {
                mode: state.messageMode,
                runId: state.input.runId,
                metaSessionId: state.input.metaSessionId,
                projectSetting: this.innerSetting(state.input.projectId, state.input.contextId),
                nativeSessionIds,
              }),
            }
          : {}),
        ...(args.paths !== undefined ? { paths: args.paths } : {}),
        identity: state.input.identity,
        projectId: state.input.projectId,
        contextId: state.input.contextId,
        origin: "commit_tool",
        nativeSessionIds,
        // T9.10: BR-31 for signing, evaluated at call time like `push`; the exemption input is the controller's own.
        ...(state.input.sign === true
          ? {
              sign: {
                reach: signingReachFromJson(bound.run.policy_snapshot_json, {
                  approvedBypass: approvedBypassOf(this.ledger, bound.run),
                }),
              },
            }
          : {}),
      });
      state.commits += 1;
      return {
        ok: true,
        result: {
          sha: result.sha,
          files_changed: result.filesChanged,
          // ADR-0087 item 4: present only for a run with attached submodules, so every other result is unchanged.
          ...(result.submodules !== undefined
            ? {
                submodules: result.submodules.map((s) => ({ paths: s.paths, repo: s.repo, commit_sha: s.commitSha })),
                submodules_skipped: (result.submodulesSkipped ?? []).map((s) => ({ path: s.path, reason: s.reason })),
              }
            : {}),
        },
      };
    } catch (err) {
      if (err instanceof CommitError) {
        const message =
          err.code === "PROVENANCE_PENDING" && err.commitSha
            ? `commit ${err.commitSha} is published; the controller completes its record`
            : AGENT_MESSAGE_CODES.has(err.code)
              ? err.message
              : undefined;
        return this.refuse(state, err.code, tool, message, err.refused.length);
      }
      return this.refuse(state, "INTERNAL_ERROR", tool);
    }
  }

  /** Step 6 for any tool: the run exists, is RUNNING and still matches the token's binding. */
  private checkRun(
    state: ChannelState,
    tool: ToolName,
  ): { run: NonNullable<ReturnType<Ledger["getRunRecord"]>> } | { error: ToolResponse } {
    const run = this.ledger.getRunRecord(state.input.runId);
    if (!run) return { error: this.refuse(state, "RUN_NOT_FOUND", tool) };
    if (run.state !== "RUNNING") return { error: this.refuse(state, "NOT_RUNNING", tool) };
    if (run.meta_session_id !== state.input.metaSessionId || run.worktree_path !== state.input.worktreePath) {
      return { error: this.refuse(state, "BINDING_MISMATCH", tool) };
    }
    return { run };
  }

  /**
   * `push` (T9.6, LLD §12.6, ADR-0028): steps 6 and 7 for a push. BR-31 is evaluated again here from the run's frozen
   * snapshot (it was evaluated when the channel opened); the push library re-reads the CURRENT configuration's
   * policy, so an operator who sets `push.policy` back to `none` stops further pushes of a running run.
   */
  private async dispatchPush(state: ChannelState): Promise<ToolResponse> {
    const pusher = this.options.pusher;
    if (!pusher) return this.refuse(state, "UNKNOWN_TOOL", "push");
    const bound = this.checkRun(state, "push");
    if ("error" in bound) return bound.error;
    if (state.pushes >= this.limits.maxPushesPerChannel) return this.refuse(state, "PUSH_LIMIT_REACHED", "push");
    state.pushes += 1;
    try {
      const result = await pusher.push({
        metaSessionId: state.input.metaSessionId,
        requestedBy: "agent_tool",
        runId: state.input.runId,
        // Owner decision 37: the only exemption input is the controller's own approval evaluation, never agent data.
        agentReach: credentialReachFromJson(bound.run.policy_snapshot_json, {
          approvedBypass: approvedBypassOf(this.ledger, bound.run),
        }),
      });
      if (result.pushed) {
        return { ok: true, result: { pushed: true, ref: result.ref, head_sha: result.headSha } };
      }
      // ADR-0075: a secret-scan refusal names each finding (rule id, path, line; never the value) so the agent can fix
      // it; the paths are quoted by `messagePath` in the message and are bounded, so the answer stays small.
      if (result.reason === "SECRET_SCAN_BLOCKED" && result.secretScan !== undefined) {
        const findings = secretScanFindings(result.secretScan);
        return {
          ok: false,
          error: {
            code: result.toolCode ?? "SECRET_SCAN_BLOCKED",
            message: `push refused: SECRET_SCAN_BLOCKED: ${describeSecretScanFindings(findings)}. ${SECRET_SCAN_FIX_HINT}`,
            details: { ...findings },
          },
        };
      }
      // Recorded in `git_push` by the library; the answer names the code and the fixed reason word only.
      return {
        ok: false,
        error: { code: result.toolCode ?? "PUSH_NOT_ALLOWED", message: `push refused: ${result.reason}` },
      };
    } catch {
      return this.refuse(state, "INTERNAL_ERROR", "push");
    }
  }

  /**
   * `search_project_context` (T12.9, FR-RAG-13): steps 6 and 7 for a search. The project is the one bound at open; the
   * answer is the T12.6 result, with trailing results dropped (and `truncated` set) if the line would exceed
   * {@link MAX_RESPONSE_BYTES}. Nothing about the query or the results is recorded here (the port records counts).
   */
  private async dispatchSearch(
    state: ChannelState,
    args: Omit<ChannelSearchInput, "runId" | "projectId">,
  ): Promise<ToolResponse> {
    const port = this.options.search;
    if (!port) return this.refuse(state, "UNKNOWN_TOOL", SEARCH_TOOL);
    const bound = this.checkRun(state, SEARCH_TOOL);
    if ("error" in bound) return bound.error;
    let outcome: Awaited<ReturnType<ChannelSearchPort["search"]>>;
    try {
      outcome = await port.search({ ...args, runId: state.input.runId, projectId: state.input.projectId });
    } catch {
      return this.refuse(state, "INTERNAL_ERROR", SEARCH_TOOL);
    }
    if (!outcome.ok) {
      return this.refuse(state, SEARCH_REFUSAL_CODES.has(outcome.code) ? outcome.code : "INTERNAL_ERROR", SEARCH_TOOL);
    }
    state.searches += 1;
    return { ok: true, result: fitResponse(outcome.result) };
  }

  /** Record the refusal (bounded) and build the answer. Never includes the token or request content. */
  private refuse(
    state: ChannelState,
    code: string,
    tool: ToolName | undefined,
    message?: string,
    refusedPaths?: number,
  ): ToolResponse {
    state.refused += 1;
    if (state.refused <= this.limits.maxRefusalEvents) {
      try {
        this.ledger.appendRunEvent({
          runId: state.input.runId,
          type: GIT_TOOL_DENIED,
          payload: {
            code,
            ...(tool ? { tool } : {}),
            ...(refusedPaths ? { refused_paths: refusedPaths } : {}),
          },
        });
      } catch {
        state.refusalsSuppressed += 1;
      }
    } else {
      state.refusalsSuppressed += 1;
    }
    return { ok: false, error: { code, message: message ?? GENERIC_MESSAGES[code] ?? "the call was refused" } };
  }

  private async doClose(state: ChannelState): Promise<void> {
    state.closed = true;
    // Stop accepting; the callback fires once every connection has ended.
    const serverClosed = new Promise<void>((resolve) => state.server.close(() => resolve()));
    // Connections that have not delivered a request are dropped; a request already being dispatched either sees the
    // closed flag (refused before any side effect) or, if it already passed the checks, finishes inside the library.
    for (const sock of state.sockets) if (!state.dispatching.has(sock)) sock.destroy();
    while (state.inFlight.size > 0) await Promise.allSettled([...state.inFlight]);
    for (const sock of state.sockets) sock.destroy();
    await serverClosed;
    await removeChannelFiles(state.dir);
    await removeQuietly(state.socketPath, state.dir);
    this.channels.delete(state.input.runId);
    try {
      this.ledger.appendRunEvent({
        runId: state.input.runId,
        type: GIT_CHANNEL_CLOSED,
        payload: {
          calls: state.calls,
          commits: state.commits,
          pushes: state.pushes,
          ...(state.searches > 0 ? { searches: state.searches } : {}),
          refused: state.refused,
          ...(state.refusalsSuppressed > 0 ? { refusals_not_recorded: state.refusalsSuppressed } : {}),
          removed: !(await exists(state.dir)),
        },
      });
    } catch {
      // The ledger may be closing; startup sweep finds the open channel and records it then.
    }
  }
}

// ---- helpers ------------------------------------------------------------------------------------------------------

function tokenMatches(expected: Buffer, presented: string): boolean {
  // Hash first so lengths always match and the comparison time does not depend on the presented value.
  const ok = timingSafeEqual(expected, digest(presented));
  return ok && isTokenShaped(presented);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function parseRequest(line: Buffer): { token: string; tool: string; arguments: Record<string, unknown> } | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isPlainObject(doc)) return undefined;
  const keys = Object.keys(doc);
  if (keys.length !== 4 || !["v", "token", "tool", "arguments"].every((k) => keys.includes(k))) return undefined;
  if (doc.v !== PROTOCOL_VERSION || typeof doc.token !== "string" || typeof doc.tool !== "string") return undefined;
  if (doc.token.length > 256 || doc.tool.length > 64 || !isPlainObject(doc.arguments)) return undefined;
  return { token: doc.token, tool: doc.tool, arguments: doc.arguments };
}

/** `messageOptional` (T11.4): a missing `message` is accepted; a present one is checked exactly as before. */
function parseCommitArguments(
  args: Record<string, unknown>,
  messageOptional: boolean,
): { message?: string; paths?: string[] } | { code: "INVALID_ARGUMENTS" | "MESSAGE_TOO_LONG" } {
  for (const k of Object.keys(args)) if (k !== "message" && k !== "paths") return { code: "INVALID_ARGUMENTS" };
  const { message, paths } = args;
  if (!(messageOptional && message === undefined)) {
    if (typeof message !== "string" || message.length === 0) return { code: "INVALID_ARGUMENTS" };
    if (message.length > MAX_TOOL_MESSAGE_CHARS) return { code: "MESSAGE_TOO_LONG" };
  }
  const msg = typeof message === "string" ? { message } : {};
  if (paths === undefined) return msg;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_COMMIT_PATHS) {
    return { code: "INVALID_ARGUMENTS" };
  }
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0 || p.length > MAX_COMMIT_PATH_CHARS) {
      return { code: "INVALID_ARGUMENTS" };
    }
  }
  return { ...msg, paths: paths as string[] };
}

/** T12.9: exactly `query` and optional `limit` and `scope` (LLD §14.7 without `project`; `SEARCH_INPUT_SCHEMA`). */
function parseSearchArguments(
  args: Record<string, unknown>,
): Omit<ChannelSearchInput, "runId" | "projectId"> | { code: "INVALID_ARGUMENTS" } {
  for (const k of Object.keys(args))
    if (k !== "query" && k !== "limit" && k !== "scope") return { code: "INVALID_ARGUMENTS" };
  const { query, limit, scope } = args;
  if (typeof query !== "string" || query.length === 0 || query.length > MAX_QUERY_LENGTH) {
    return { code: "INVALID_ARGUMENTS" };
  }
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_SEARCH_LIMIT)
  ) {
    return { code: "INVALID_ARGUMENTS" };
  }
  if (scope !== undefined && scope !== "project" && scope !== "global" && scope !== "both") {
    return { code: "INVALID_ARGUMENTS" };
  }
  return {
    query,
    ...(limit !== undefined ? { limit: limit as number } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

/**
 * T12.9: the search result, with trailing `results` dropped and `truncated: true` set until the whole response line
 * fits {@link MAX_RESPONSE_BYTES} (the shim refuses a longer one). T12.6 already bounds the text, so this only bites on
 * text that JSON escaping grows a lot.
 */
function fitResponse(result: Record<string, unknown>): Record<string, unknown> {
  const size = (r: Record<string, unknown>) =>
    Buffer.byteLength(`${JSON.stringify({ ok: true, result: r })}\n`, "utf8");
  if (size(result) <= MAX_RESPONSE_BYTES) return result;
  const results = Array.isArray(result.results) ? [...result.results] : [];
  let out: Record<string, unknown> = { ...result, truncated: true, results };
  while (results.length > 0 && size(out) > MAX_RESPONSE_BYTES) {
    results.pop();
    out = { ...out, results: [...results] };
  }
  return out;
}

/** The directory must be a real directory (not a link), owned by this user, with no group or other access. */
async function assertPrivateDir(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new ChannelOpenError(`${dir} is not a directory`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw new ChannelOpenError(`${dir} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) throw new ChannelOpenError(`${dir} is accessible to other users`);
}

/** Unlink every `CHANNEL_FILE_NAMES` entry of `dir` that is a regular file (never a link or directory). T9.4b. */
async function removeChannelFiles(dir: string): Promise<void> {
  for (const name of CHANNEL_FILE_NAMES) {
    const file = path.join(dir, name);
    try {
      if ((await lstat(file)).isFile()) await unlink(file);
    } catch {
      // absent
    }
  }
}

/** Unlink the socket (only if it is one), then remove the directory if it is empty. Never recursive. */
async function removeQuietly(socketPath: string, dir: string | undefined): Promise<void> {
  try {
    if ((await lstat(socketPath)).isSocket()) await unlink(socketPath);
  } catch {
    // absent
  }
  if (dir === undefined) return;
  try {
    await rmdir(dir);
  } catch {
    // absent or not empty: leave it
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
