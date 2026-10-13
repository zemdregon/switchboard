/**
 * Wire contract between the tool shim (`switchboard tool-shim`, run by the agent's provider CLI) and the controller's
 * `COMP-GIT` service over the per-run Unix socket (FR-GIT-02, LLD §12.1, §12.2; ADR-0014, ADR-0026; T9.4).
 *
 * This module is shared by both sides and holds constants and pure helpers only: no Git, no ledger, no socket server.
 * The shim imports nothing else from the controller, so it contains no Git logic and no secret other than the one-run
 * token it reads from its environment.
 *
 * Framing (Proposed, Delegated, ADR-0026): one request per connection. The shim connects, writes ONE line of JSON
 * terminated by `\n`, reads ONE line of JSON back, and the controller closes the connection.
 *
 *   request:  {"v":1,"token":"<token>","tool":"commit","arguments":{...}}
 *   response: {"ok":true,"result":{"sha":"...","files_changed":1}}
 *             {"ok":true,"result":{"pushed":true,"ref":"refs/heads/...","head_sha":"..."}}   (push, T9.6)
 *             {"ok":false,"error":{"code":"NOT_RUNNING","message":"..."}}
 */

/** Environment variable that carries the per-run capability token into the shim (LLD §12.2: "token in the shim's environment"). */
export const TOOL_TOKEN_ENV = "SWITCHBOARD_TOOL_TOKEN";

/** Wire protocol version. */
export const PROTOCOL_VERSION = 1;

/**
 * Token format: a fixed prefix (so the artifact redactor and tests can recognise a leaked token, FR-TEL-03) followed by
 * 32 random bytes (256 bits) in base64url without padding (43 characters).
 */
export const TOKEN_PREFIX = "sbt1_";
export const TOKEN_RANDOM_BYTES = 32;
export const TOKEN_LENGTH = TOKEN_PREFIX.length + 43;

/** Largest request line the controller reads (bytes, including the newline). Proposed: room for 256 paths of 4096 bytes. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** Largest response line the shim accepts (bytes). Responses carry a SHA, a count or a short error. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** LLD §12.1 `commit` limits. */
export const MAX_TOOL_MESSAGE_CHARS = 8192;
export const MAX_COMMIT_PATHS = 256;
/** Same bound as the commit library's own path check (`src/git/commit.ts`). */
export const MAX_COMMIT_PATH_CHARS = 4096;

/**
 * Kernel limit for `sockaddr_un.sun_path` on Linux is 108 bytes including the terminating NUL. Node 22.22.0 silently
 * accepted a 251-byte path in `listen()` and left no file at that path (observed on this host, T9.4), so the controller
 * never relies on the kernel or Node to refuse a long path: it checks against this conservative bound (Proposed).
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/**
 * T9.4b (ADR-0029 item 2; Delegated): the fixed MCP server name under which a provider is given the shim, so its tools
 * are `mcp__switchboard-git__commit` and `mcp__switchboard-git__push` in Claude Code's `mcp__<server>__<tool>` form
 * (that naming is an Assumption, live check). Prefixed with the product name to avoid colliding with a server an
 * operator or repository might define. Shared by the Claude adapter and the argv audit (`src/adapters/audit.ts`).
 */
export const TOOL_SHIM_MCP_SERVER = "switchboard-git";

/**
 * T9.4b (ADR-0029 item 1): the one file name the channel service writes, on request of an adapter, into the run's
 * private channel directory (`0600`, exclusive create, never following a link); removed when the channel closes and by
 * the startup sweep. It holds the per-run MCP definition of the shim and never the token.
 */
export const CHANNEL_MCP_CONFIG_FILE = "mcp-config.json";

/** Every file name the channel service accepts in `OpenChannel.writeFile` (and removes on close and sweep). */
export const CHANNEL_FILE_NAMES: readonly string[] = [CHANNEL_MCP_CONFIG_FILE];

export type ToolName = "commit" | "push";

/**
 * Tool names the shim can serve (T9.6 added `push`). Which of them a run is offered is decided per run by the
 * controller (`push` only under policy `branch` and BR-31) and passed to the shim with `--tools`.
 */
export const TOOL_NAMES: readonly ToolName[] = ["commit", "push"];

/** Parse a `--tools` value (`commit` or `commit,push`); undefined for anything else. */
export function parseToolList(raw: string): ToolName[] | undefined {
  const names = raw.split(",");
  if (names.length === 0 || names.length > TOOL_NAMES.length) return undefined;
  const out: ToolName[] = [];
  for (const n of names) {
    const t = TOOL_NAMES.find((x) => x === n);
    if (t === undefined || out.includes(t)) return undefined;
    out.push(t);
  }
  return out;
}

/** The LLD §12.1 `commit` input schema, served by the shim (every object `additionalProperties: false`). */
export const COMMIT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: MAX_TOOL_MESSAGE_CHARS },
    paths: {
      type: "array",
      minItems: 1,
      maxItems: MAX_COMMIT_PATHS,
      items: { type: "string", minLength: 1, maxLength: MAX_COMMIT_PATH_CHARS },
    },
  },
} as const;

export const COMMIT_DESCRIPTION =
  "Commit changes from your working directory. Give a commit message and, optionally, the worktree-relative paths " +
  "to include (default: all changes). This is the only way to create a commit; Git commands that write history are " +
  "not available to you.";

/** The LLD §12.1 `push` input schema: no arguments, so an agent cannot choose a remote or a ref. */
export const PUSH_INPUT_SCHEMA = { type: "object", additionalProperties: false, properties: {} } as const;

export const PUSH_DESCRIPTION =
  "Publish the commits you made with the commit tool: pushes this session's commits to the remote branch configured " +
  "by the operator. Takes no arguments. Never force-pushes; a rejected or refused push returns an error code.";

/** Error codes the channel itself returns (the commit library's codes are passed through as well). */
export type ChannelErrorCode =
  | "MALFORMED_REQUEST"
  | "PUSH_LIMIT_REACHED"
  | "REQUEST_TOO_LARGE"
  | "REQUEST_TIMEOUT"
  | "RATE_LIMITED"
  | "BUSY"
  | "TOKEN_INVALID"
  | "CHANNEL_CLOSED"
  | "UNKNOWN_TOOL"
  | "INVALID_ARGUMENTS"
  | "MESSAGE_TOO_LONG"
  | "RUN_NOT_FOUND"
  | "NOT_RUNNING"
  | "BINDING_MISMATCH"
  | "INTERNAL_ERROR";

export interface ToolRequest {
  readonly v: number;
  readonly token: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

export type ToolResponse =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** True when `s` has the exact token shape (prefix plus 43 base64url characters). Does not say whether it is valid. */
export function isTokenShaped(s: unknown): s is string {
  if (typeof s !== "string" || s.length !== TOKEN_LENGTH || !s.startsWith(TOKEN_PREFIX)) return false;
  for (let i = TOKEN_PREFIX.length; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 /* - */ || c === 95; /* _ */
    if (!ok) return false;
  }
  return true;
}
