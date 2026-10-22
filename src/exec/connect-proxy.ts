/**
 * Allowlisting HTTPS CONNECT proxy for the project setup step (ADR-0071). The controller starts one per setup run,
 * listening on a Unix socket (production: the only way out of the setup sandbox's empty network namespace) or on a
 * loopback TCP port, and stops it when the step ends. Delegated choices (fail closed):
 *
 * - **CONNECT only, port 443 only.** The first request line must be `CONNECT <host>:443 HTTP/1.x`; any other method is
 *   `405`, any other port or a host that is not exactly (case-insensitively) in the allowlist is `403`. No plain HTTP
 *   is forwarded, so the proxy never sees or rewrites request content: TLS runs end to end between the client and the
 *   registry.
 * - **Name resolution here.** The proxy resolves the allowed name itself and connects only to an address that is
 *   public unicast ({@link isPublicAddress}: not loopback, private, link-local, CGNAT, unique-local, multicast or
 *   unspecified), so an allowed name that resolves to the controller's host or the local network is refused (`502`).
 *   Tests inject the resolver, the address rule and the dialler.
 * - **Bounds.** Request head at most {@link MAX_HEAD_BYTES} bytes and {@link HEAD_TIMEOUT_MS}; at most
 *   {@link MAX_TUNNELS} concurrent tunnels; an idle tunnel is closed after {@link TUNNEL_IDLE_MS}.
 * - **Records.** Only counts (allowed, refused) are kept; never a requested name (it is client-chosen text).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export const MAX_HEAD_BYTES = 8 * 1024;
export const HEAD_TIMEOUT_MS = 10_000;
export const MAX_TUNNELS = 64;
export const TUNNEL_IDLE_MS = 5 * 60_000;
export const CONNECT_PORT = 443;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export interface ConnectProxyOptions {
  /** Allowed hostnames (compared lower case, exact match; no wildcards). */
  readonly hosts: readonly string[];
  /** Where to listen: a Unix socket path, or loopback TCP (`port` 0 picks one). */
  readonly listen: { readonly path: string } | { readonly port: number };
  /** Name resolution; defaults to `dns.lookup` with every address. */
  readonly lookup?: (host: string) => Promise<readonly ResolvedAddress[]>;
  /** Which resolved addresses may be dialled; defaults to {@link isPublicAddress}. */
  readonly allowAddress?: (address: string, family: number) => boolean;
  /** Opens the upstream connection; defaults to `net.connect`. */
  readonly dial?: (address: string, port: number) => net.Socket;
}

export interface ConnectProxyStats {
  readonly allowed: number;
  readonly refused: number;
}

export interface ConnectProxy {
  /** The socket path or the loopback port actually listened on. */
  readonly address: string | number;
  stats(): ConnectProxyStats;
  /** Stops listening and destroys every open connection. Idempotent. */
  close(): Promise<void>;
}

// One list per family: a BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules as well.
const PRIVATE_V4 = new net.BlockList();
const PRIVATE_V6 = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE_V4.addSubnet(a, p, "ipv4");
}
for (const [a, p] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE_V6.addSubnet(a, p, "ipv6");
}

/** True for a public unicast address (see the module comment). An unparsable address is not public. */
export function isPublicAddress(address: string, family: number): boolean {
  if (net.isIP(address) !== (family === 6 ? 6 : 4)) return false;
  return family === 6 ? !PRIVATE_V6.check(address, "ipv6") : !PRIVATE_V4.check(address, "ipv4");
}

const defaultLookup = async (host: string): Promise<readonly ResolvedAddress[]> =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((r) => ({ address: r.address, family: r.family }));

const REQUEST_LINE = /^CONNECT ([A-Za-z0-9.-]{1,253}):(\d{1,5}) HTTP\/1\.[01]$/;

function reply(socket: net.Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/** Starts the proxy; resolves once it listens. */
export async function startConnectProxy(opts: ConnectProxyOptions): Promise<ConnectProxy> {
  const allowed = new Set(opts.hosts.map((h) => h.toLowerCase()));
  const lookup = opts.lookup ?? defaultLookup;
  const allowAddress = opts.allowAddress ?? isPublicAddress;
  const dial = opts.dial ?? ((address: string, port: number) => net.connect({ host: address, port }));
  const open = new Set<net.Socket>();
  let tunnels = 0;
  let allowedCount = 0;
  let refusedCount = 0;
  const refuse = (socket: net.Socket, status: string) => {
    refusedCount++;
    reply(socket, status);
  };

  const handle = (client: net.Socket): void => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => refuse(client, "408 Request Timeout"), HEAD_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEAD_BYTES) {
          clearTimeout(timer);
          client.off("data", onData);
          refuse(client, "431 Request Header Fields Too Large");
        }
        return;
      }
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      if (end > MAX_HEAD_BYTES) {
        refuse(client, "431 Request Header Fields Too Large");
        return;
      }
      const rest = head.subarray(end + 4);
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      if (!line.startsWith("CONNECT ")) {
        refuse(client, "405 Method Not Allowed");
        return;
      }
      const m = REQUEST_LINE.exec(line);
      const host = m?.[1]?.toLowerCase();
      if (m === null || host === undefined || Number(m[2]) !== CONNECT_PORT || !allowed.has(host)) {
        refuse(client, "403 Forbidden");
        return;
      }
      if (tunnels >= MAX_TUNNELS) {
        refuse(client, "503 Service Unavailable");
        return;
      }
      void tunnel(client, host, rest);
    };
    client.on("data", onData);
  };

  const tunnel = async (client: net.Socket, host: string, rest: Buffer): Promise<void> => {
    tunnels++;
    client.once("close", () => tunnels--);
    let target: ResolvedAddress | undefined;
    try {
      target = (await lookup(host)).find((a) => allowAddress(a.address, a.family));
    } catch {
      target = undefined;
    }
    if (target === undefined || client.destroyed) return refuse(client, "502 Bad Gateway");
    let established = false;
    const upstream = dial(target.address, CONNECT_PORT);
    open.add(upstream);
    upstream.on("close", () => {
      open.delete(upstream);
      if (established) client.destroy();
    });
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => {
      if (!established && !client.writableEnded) refuse(client, "502 Bad Gateway");
      upstream.destroy();
    });
    upstream.once("connect", () => {
      established = true;
      allowedCount++;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) upstream.write(rest);
      client.setTimeout(TUNNEL_IDLE_MS, () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };

  const server = net.createServer(handle);
  server.maxConnections = MAX_TUNNELS * 2;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if ("path" in opts.listen) server.listen(opts.listen.path, () => resolve());
    else server.listen(opts.listen.port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const address = typeof addr === "string" ? addr : (addr?.port ?? 0);
  let closed: Promise<void> | undefined;
  return {
    address,
    stats: () => ({ allowed: allowedCount, refused: refusedCount }),
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of open) s.destroy();
      });
      return closed;
    },
  };
}
