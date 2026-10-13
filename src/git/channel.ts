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
 *   4. tool offered on this channel (`commit` only until T9.6 adds `push`);
 *   5. arguments: exactly `message` (1..8192 characters) and optional `paths` (1..256 strings of at most 4096);
 *   6. run exists, is RUNNING, and still has the meta-session and worktree the token was bound to;
 *   7. the commit library re-checks state and lease, refuses paths outside the worktree (`PATH_OUTSIDE_WORKTREE`,
 *      `PATH_REFUSED`), sanitises the message and writes provenance (FR-GIT-04, FR-GIT-07).
 *
 * Secrets: the token is created here, returned once (for the shim's environment) and kept in memory only as its
 * SHA-256 digest. It is never written to the ledger, an artifact, a log line or the file system. The artifact redactor
 * recognises its prefix (`src/artifacts/redact.ts`), so a provider that prints it does not persist it.
 *
 * Peer credentials: Node.js exposes no `SO_PEERCRED`, so the peer process is not identified (documented absence,
 * ADR-0026). The controls are the `0700` directory owned by the controller's user, the `0600` socket and the token. A
 * process of the same OS user that can read the provider's environment can use the token while the run is RUNNING; that
 * is the same reach the agent itself has and is why the token is per run and dies with the run.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rmdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ShimSpec } from "../adapters/types.js";
import { createLedger, type Ledger } from "../ledger/index.js";
import { CommitError, type GitPublisher } from "./commit.js";
import {
  type ChannelErrorCode,
  isTokenShaped,
  MAX_COMMIT_PATH_CHARS,
  MAX_COMMIT_PATHS,
  MAX_REQUEST_BYTES,
  MAX_SOCKET_PATH_BYTES,
  MAX_TOOL_MESSAGE_CHARS,
  PROTOCOL_VERSION,
  TOKEN_PREFIX,
  TOKEN_RANDOM_BYTES,
  TOOL_NAMES,
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
}

export const DEFAULT_CHANNEL_LIMITS: ChannelLimits = {
  maxCallsPerMinute: 60,
  maxConnections: 8,
  requestTimeoutMs: 10_000,
  maxRefusalEvents: 32,
};

export interface GitToolServiceOptions {
  readonly db: Database.Database;
  /** Controller data directory; sockets go under `<dataDir>/runs/<run_id>/` when the path is short enough. */
  readonly dataDir: string;
  readonly publisher: GitPublisher;
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
}

export interface OpenChannel {
  readonly runId: string;
  readonly socketPath: string;
  /** What the adapter needs for `channelArgs`; `env` holds the token. */
  readonly shim: ShimSpec;
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
  closed: boolean;
  closing: Promise<void> | undefined;
  calls: number;
  commits: number;
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
]);

const GENERIC_MESSAGES: Readonly<Record<string, string>> = {
  MALFORMED_REQUEST: "the request is not a valid tool call",
  REQUEST_TOO_LARGE: "the request is too large",
  REQUEST_TIMEOUT: "the request was not received in time",
  RATE_LIMITED: "too many tool calls; wait and try again",
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
  INTERNAL_ERROR: "the controller could not complete the call",
};

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
      tools: TOOL_NAMES,
      dir,
      socketPath,
      fallback,
      server,
      sockets: new Set(),
      dispatching: new WeakSet(),
      inFlight: new Set(),
      callTimes: [],
      closed: false,
      closing: undefined,
      calls: 0,
      commits: 0,
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
      payload: { tools: [...state.tools], socket_dir: dir, fallback },
    });
    return {
      runId: input.runId,
      socketPath,
      shim: {
        command: [...this.options.shimCommand, "--socket", socketPath],
        socketPath,
        toolNames: [...state.tools],
        env: { [TOOL_TOKEN_ENV]: token },
      },
      close: () => this.close(input.runId),
    };
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
      if (ok) await removeQuietly(path.join(dir as string, SOCKET_FILE_NAME), dir as string);
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
        // inside it is touched), after removing a stale socket.
        await assertPrivateDir(preferred);
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
    const args = parseCommitArguments(req.arguments);
    if ("code" in args) return this.refuse(state, args.code, tool);
    // 6. run state and binding.
    const run = this.ledger.getRunRecord(state.input.runId);
    if (!run) return this.refuse(state, "RUN_NOT_FOUND", tool);
    if (run.state !== "RUNNING") return this.refuse(state, "NOT_RUNNING", tool);
    if (run.meta_session_id !== state.input.metaSessionId || run.worktree_path !== state.input.worktreePath) {
      return this.refuse(state, "BINDING_MISMATCH", tool);
    }
    // 7. the commit library.
    try {
      const result = await this.options.publisher.commit({
        runId: state.input.runId,
        message: args.message,
        ...(args.paths !== undefined ? { paths: args.paths } : {}),
        identity: state.input.identity,
        projectId: state.input.projectId,
        contextId: state.input.contextId,
        origin: "commit_tool",
        nativeSessionIds: state.input.nativeSessionIds?.() ?? [],
      });
      state.commits += 1;
      return { ok: true, result: { sha: result.sha, files_changed: result.filesChanged } };
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
    await removeQuietly(state.socketPath, state.dir);
    this.channels.delete(state.input.runId);
    try {
      this.ledger.appendRunEvent({
        runId: state.input.runId,
        type: GIT_CHANNEL_CLOSED,
        payload: {
          calls: state.calls,
          commits: state.commits,
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

function parseCommitArguments(
  args: Record<string, unknown>,
): { message: string; paths?: string[] } | { code: "INVALID_ARGUMENTS" | "MESSAGE_TOO_LONG" } {
  for (const k of Object.keys(args)) if (k !== "message" && k !== "paths") return { code: "INVALID_ARGUMENTS" };
  const { message, paths } = args;
  if (typeof message !== "string" || message.length === 0) return { code: "INVALID_ARGUMENTS" };
  if (message.length > MAX_TOOL_MESSAGE_CHARS) return { code: "MESSAGE_TOO_LONG" };
  if (paths === undefined) return { message };
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_COMMIT_PATHS) {
    return { code: "INVALID_ARGUMENTS" };
  }
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0 || p.length > MAX_COMMIT_PATH_CHARS) {
      return { code: "INVALID_ARGUMENTS" };
    }
  }
  return { message, paths: paths as string[] };
}

/** The directory must be a real directory (not a link), owned by this user, with no group or other access. */
async function assertPrivateDir(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new ChannelOpenError(`${dir} is not a directory`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw new ChannelOpenError(`${dir} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) throw new ChannelOpenError(`${dir} is accessible to other users`);
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
