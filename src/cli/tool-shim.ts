/**
 * `switchboard tool-shim --socket <path>` (T9.4; FR-GIT-02, LLD §12.2; ADR-0014, ADR-0026). Internal, not an operator
 * command: the provider CLI of one run starts it from the per-run MCP definition the controller supplied.
 *
 * It speaks MCP on stdio to the agent and forwards each `tools/call` as one newline-delimited JSON request over the
 * per-run Unix socket to the controller's `COMP-GIT` service, then relays the one-line answer. It holds no Git logic, no
 * ledger and no configuration: the controller validates everything (token, run state, arguments, paths). Its only
 * secret is the one-run token read from {@link TOOL_TOKEN_ENV}, which it removes from its own environment at start and
 * never prints. stdout carries MCP framing only; diagnostics go to stderr without the token.
 */
import net from "node:net";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  COMMIT_DESCRIPTION,
  COMMIT_INPUT_SCHEMA,
  isTokenShaped,
  MAX_RESPONSE_BYTES,
  MAX_SOCKET_PATH_BYTES,
  PROTOCOL_VERSION,
  TOOL_NAMES,
  TOOL_TOKEN_ENV,
  type ToolResponse,
} from "../git/tool-protocol.js";

/** How long the shim waits for the controller's answer to one call (Proposed: commits are local Git operations). */
export const SHIM_CALL_TIMEOUT_MS = 120_000;

export interface ShimConfig {
  readonly socketPath: string;
  readonly token: string;
}

/** Parse `--socket <path>` and read (then remove) the token from the environment. Throws a plain Error on misuse. */
export function shimConfig(argv: readonly string[], env: Record<string, string | undefined>): ShimConfig {
  if (argv.length !== 2 || argv[0] !== "--socket") throw new Error("usage: switchboard tool-shim --socket <path>");
  const socketPath = argv[1] as string;
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error("tool-shim: --socket must be an absolute path within the socket length limit");
  }
  const token = env[TOOL_TOKEN_ENV];
  delete env[TOOL_TOKEN_ENV];
  if (!isTokenShaped(token)) throw new Error(`tool-shim: ${TOOL_TOKEN_ENV} is missing or malformed`);
  return { socketPath, token };
}

/** One request over a fresh connection; resolves with the controller's answer or a local transport error. */
export function forward(
  cfg: ShimConfig,
  tool: string,
  args: unknown,
  timeoutMs = SHIM_CALL_TIMEOUT_MS,
): Promise<ToolResponse> {
  const local = (code: string, message: string): ToolResponse => ({ ok: false, error: { code, message } });
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (r: ToolResponse) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    const sock = net.createConnection({ path: cfg.socketPath });
    sock.setTimeout(timeoutMs, () => finish(local("CHANNEL_TIMEOUT", "the controller did not answer in time")));
    sock.on("error", () => finish(local("CHANNEL_UNAVAILABLE", "the tool channel is closed or unreachable")));
    sock.on("connect", () => {
      const req = { v: PROTOCOL_VERSION, token: cfg.token, tool, arguments: args ?? {} };
      sock.write(`${JSON.stringify(req)}\n`);
    });
    sock.on("data", (buf: Buffer) => {
      size += buf.length;
      if (size > MAX_RESPONSE_BYTES) return finish(local("CHANNEL_PROTOCOL_ERROR", "response too large"));
      const nl = buf.indexOf(10);
      if (nl === -1) {
        chunks.push(buf);
        return;
      }
      chunks.push(buf.subarray(0, nl));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ToolResponse;
        if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean") throw new Error("shape");
        finish(parsed);
      } catch {
        finish(local("CHANNEL_PROTOCOL_ERROR", "unreadable response from the controller"));
      }
    });
    sock.on("end", () => finish(local("CHANNEL_CLOSED", "the controller closed the connection without an answer")));
  });
}

function toResult(r: ToolResponse): CallToolResult {
  if (r.ok) return { content: [{ type: "text", text: JSON.stringify(r.result) }] };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(r.error) }] };
}

/** Build the stdio MCP server; exported for tests. */
export function createShimServer(cfg: ShimConfig): Server {
  const server = new Server({ name: "switchboard-git-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: COMMIT_DESCRIPTION,
      inputSchema: COMMIT_INPUT_SCHEMA as unknown as { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    toResult(await forward(cfg, req.params.name, req.params.arguments)),
  );
  return server;
}

/** Entry for `main`: serve until stdin closes. Returns the exit code. */
export async function runToolShim(
  argv: readonly string[],
  io: { readonly stderr: { write(chunk: string): unknown }; readonly env: Record<string, string | undefined> },
): Promise<number> {
  let cfg: ShimConfig;
  try {
    cfg = shimConfig(argv, io.env);
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  if (io.env !== process.env) delete process.env[TOOL_TOKEN_ENV];
  const server = createShimServer(cfg);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    // The provider ends the session by closing our stdin; the transport does not report that itself.
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });
  await server.connect(new StdioServerTransport());
  await closed;
  try {
    await server.close();
  } catch {
    // already closed
  }
  process.stdin.destroy();
  return 0;
}
