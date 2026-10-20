/**
 * The project setup sandbox (ADR-0071). Setup commands run under bubblewrap with every namespace unshared, so their
 * network namespace has only a loopback interface. Their one way out is a small bridge, started inside the sandbox
 * ahead of the commands, that listens on `127.0.0.1` and forwards each connection to the controller's allowlisting
 * CONNECT proxy ({@link startConnectProxy}) over a Unix socket bound into the sandbox. The bridge sets the proxy
 * variables for its child to its own port, runs the setup command and exits with its status.
 *
 * Filesystem (Delegated, least privilege): the host root read-only, fresh `/dev`, `/proc` and `/tmp`; the operator's
 * home, the controller's data directory and `/run` replaced by empty tmpfs (no credentials, ledger, agent or Docker
 * sockets reachable); then read-only re-binds of the executable search path and the Node.js installation where they
 * were hidden, and writable binds of the worktree, the per-project setup home, the caches and the proxy socket's
 * directory. Repository metadata (`.git`) outside the worktree is not exposed, so setup cannot write Git hooks or config.
 */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * The bridge, run as `node -e BRIDGE_SOURCE <socket> <argv...>` (CommonJS, no dependencies). Any failure to listen or
 * spawn exits 125/127 without running anything else. Signals the bridge receives are passed to the child.
 */
export const SETUP_BRIDGE_SOURCE = `"use strict";
const net = require("node:net");
const { spawn } = require("node:child_process");
const [sock, ...cmd] = process.argv.slice(1);
if (!sock || cmd.length === 0) process.exit(125);
const server = net.createServer((c) => {
  const u = net.connect(sock);
  const done = () => { c.destroy(); u.destroy(); };
  c.on("error", done); u.on("error", done); c.on("close", done); u.on("close", done);
  c.pipe(u); u.pipe(c);
});
server.on("error", () => process.exit(125));
server.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port;
  const env = { ...process.env };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "npm_config_https_proxy", "npm_config_proxy"]) env[k] = url;
  env.NO_PROXY = ""; env.no_proxy = "";
  let child;
  try { child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "inherit", "inherit"], env }); }
  catch { process.exit(127); }
  child.on("error", () => process.exit(127));
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => child.kill(s));
  child.on("exit", (code, signal) => {
    server.close();
    process.exit(code !== null ? code : 128 + (require("node:os").constants.signals[signal] || 1));
  });
});
`;

export interface SetupSandboxLayout {
  /** The run's worktree: the working directory, writable. */
  readonly worktree: string;
  /** Further writable directories (setup home, caches, the proxy socket's directory). */
  readonly writable: readonly string[];
  /** Directories hidden behind an empty tmpfs (operator home, data directory, `/run`). Missing ones are skipped. */
  readonly hidden: readonly string[];
  /** Directories re-exposed read-only when a hidden directory covers them (PATH entries, the Node.js prefix). */
  readonly readable: readonly string[];
}

const canonical = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
const within = (inner: string, outer: string): boolean =>
  inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`);

/** The directories to re-expose read-only: absolute `PATH` entries and the Node.js installation prefix. */
export function setupReadablePaths(searchPath: string | undefined, nodeExecPath: string): string[] {
  const out = new Set<string>();
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    const c = canonical(dir);
    if (c !== undefined && isDir(c)) out.add(c);
  }
  const node = canonical(nodeExecPath);
  if (node !== undefined) out.add(path.dirname(path.dirname(node)));
  return [...out];
}

/** The bubblewrap argv that runs `argv` through the bridge (see the module comment). */
export function wrapSetupSandbox(
  bwrapPath: string,
  layout: SetupSandboxLayout,
  socketPath: string,
  nodeExecPath: string,
  argv: readonly string[],
): string[] {
  const worktree = canonical(layout.worktree) ?? layout.worktree;
  const hidden = [...new Set(layout.hidden.flatMap((p) => canonical(p) ?? []))]
    .filter((p) => p !== "/" && isDir(p))
    .sort((a, b) => a.length - b.length);
  const writable = [worktree, ...layout.writable.map((p) => canonical(p) ?? p)];
  const readable = layout.readable
    .map((p) => canonical(p) ?? p)
    .filter((p) => hidden.some((h) => within(p, h)) && !writable.some((w) => within(p, w)));
  const out = [bwrapPath, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const h of hidden) if (h !== "/tmp") out.push("--tmpfs", h);
  for (const r of readable) out.push("--ro-bind", r, r);
  for (const w of writable) out.push("--bind", w, w);
  out.push("--chdir", worktree, "--unshare-all", "--die-with-parent", "--new-session", "--");
  out.push(nodeExecPath, "-e", SETUP_BRIDGE_SOURCE, socketPath, ...argv);
  return out;
}

/** The bridge without a sandbox (tests only: the same proxy path, no namespace). */
export function bridgeOnly(socketPath: string, nodeExecPath: string, argv: readonly string[]): string[] {
  return [nodeExecPath, "-e", SETUP_BRIDGE_SOURCE, socketPath, ...argv];
}
