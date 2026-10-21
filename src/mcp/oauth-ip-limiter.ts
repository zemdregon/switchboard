/**
 * Per-address lockout for wrong one-time codes and wrong passphrases on the consent pages (ADR-0041 item 3, LLD §3.3).
 *
 * {@link IP_MAX_FAILURES} wrong attempts within {@link IP_WINDOW_MS} from one client address lock that address out of
 * code and passphrase entry for {@link IP_LOCK_MS} (429). Assumption: the constants mirror the production loopback
 * gate's own limits (max 10, window 5 minutes, lock 15 minutes). The global limits in `oauth-server.ts` (passphrase
 * lockout, pairing-code throttle) stay in force as defence in depth.
 *
 * The client address ({@link clientAddress}): the socket peer, unless `transport.http.client_ip_header` is set AND the
 * socket peer is a loopback address (a reverse proxy on the same host) AND the header holds exactly one IP literal; then
 * that literal. A header from a non-loopback peer is ignored, so a direct caller cannot choose its own key.
 *
 * Delegated (best practice, fail closed):
 * - An IPv4-mapped IPv6 address counts as its IPv4 address; any other IPv6 address is keyed by its /64 prefix, since one
 *   host commonly holds a whole /64.
 * - A success does not clear an address's failures; they age out of the window.
 * - At most {@link MAX_TRACKED_ADDRESSES} addresses are tracked. Expired entries are pruned first; when the map is still
 *   full, the oldest unlocked entry goes, and only if every entry is locked the oldest locked one.
 */
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { isLoopbackAddress } from "../config/http-transport.js";

export const IP_MAX_FAILURES = 10;
export const IP_WINDOW_MS = 5 * 60 * 1000;
export const IP_LOCK_MS = 15 * 60 * 1000;
export const MAX_TRACKED_ADDRESSES = 10_000;

/** `::ffff:a.b.c.d` as `a.b.c.d`; any other value unchanged. */
function unmapIpv4(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m?.[1] !== undefined && net.isIPv4(m[1]) ? m[1] : ip;
}

/** The eight 16-bit groups of an IPv6 literal (no zone), or undefined. */
function ipv6Groups(ip: string): number[] | undefined {
  if (!net.isIPv6(ip)) return undefined;
  let text = ip;
  // An embedded IPv4 tail becomes two groups.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4?.[1] !== undefined) {
    const o = v4[1].split(".").map(Number);
    text = `${text.slice(0, -v4[1].length)}${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const h = head === "" ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(fill).fill("0"), ...t].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

/** The lockout key of an IP literal: IPv4 as is, IPv6 as its /64 prefix. Undefined for anything that is not an IP. */
export function addressKey(ip: string): string | undefined {
  const bare = unmapIpv4(ip.trim());
  if (net.isIPv4(bare)) return bare;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return undefined;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/**
 * The client address of a request: the honoured header's single IP literal from a loopback peer, otherwise the socket
 * peer. Undefined only when the socket has no peer address (a test double); callers then use a fixed key.
 */
export function clientAddress(req: IncomingMessage, headerName: string | undefined): string | undefined {
  const peerRaw = req.socket.remoteAddress;
  const peer = peerRaw === undefined ? undefined : unmapIpv4(peerRaw);
  if (headerName !== undefined && peer !== undefined && isLoopbackAddress(peer)) {
    const value = req.headers[headerName];
    if (typeof value === "string") {
      const candidate = unmapIpv4(value.trim());
      if (net.isIP(candidate) !== 0) return candidate;
    }
  }
  return peer;
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

export class IpAttemptLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly headerName?: string) {}

  /** The address of a request (for the audit log) and its lockout key. */
  identify(req: IncomingMessage): { ip: string | undefined; key: string } {
    const ip = clientAddress(req, this.headerName);
    return { ip, key: (ip !== undefined ? addressKey(ip) : undefined) ?? "unknown" };
  }

  locked(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return e !== undefined && now < e.lockedUntil;
  }

  /** Record a wrong attempt; true when this one starts the address's lockout. */
  fail(key: string, now: number): boolean {
    let e = this.entries.get(key);
    if (e === undefined) {
      this.makeRoom(now);
      e = { failures: [], lockedUntil: 0 };
    } else {
      this.entries.delete(key); // re-insert: Map order is then least recently failed first
    }
    this.entries.set(key, e);
    e.failures = e.failures.filter((t) => now - t < IP_WINDOW_MS);
    e.failures.push(now);
    if (e.failures.length < IP_MAX_FAILURES) return false;
    e.failures = [];
    e.lockedUntil = now + IP_LOCK_MS;
    return true;
  }

  /** Tracked addresses (tests). */
  get size(): number {
    return this.entries.size;
  }

  private makeRoom(now: number): void {
    if (this.entries.size < MAX_TRACKED_ADDRESSES) return;
    for (const [k, e] of this.entries) {
      if (now >= e.lockedUntil && e.failures.every((t) => now - t >= IP_WINDOW_MS)) this.entries.delete(k);
    }
    if (this.entries.size < MAX_TRACKED_ADDRESSES) return;
    let victim: string | undefined;
    for (const [k, e] of this.entries) {
      if (now >= e.lockedUntil) {
        victim = k;
        break;
      }
    }
    victim ??= this.entries.keys().next().value;
    if (victim !== undefined) this.entries.delete(victim);
  }
}
