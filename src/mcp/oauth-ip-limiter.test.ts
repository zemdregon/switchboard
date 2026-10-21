/**
 * Per-address lockout for wrong codes and passphrases: the address key, the trusted-header rule (honoured only from a
 * loopback peer), the 10-in-5-minutes / 15-minute lock, and the bounded map.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  addressKey,
  clientAddress,
  IP_LOCK_MS,
  IP_MAX_FAILURES,
  IP_WINDOW_MS,
  IpAttemptLimiter,
  MAX_TRACKED_ADDRESSES,
} from "./oauth-ip-limiter.js";

const req = (remoteAddress: string | undefined, headers: Record<string, string | string[]> = {}) =>
  ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

describe("client address", () => {
  it("keys IPv4 as is, IPv4-mapped IPv6 as IPv4 and other IPv6 by its /64", () => {
    expect(addressKey("203.0.113.9")).toBe("203.0.113.9");
    expect(addressKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("not-an-ip")).toBeUndefined();
    expect(addressKey("")).toBeUndefined();
  });

  it("honours the configured header only from a loopback peer and only for one IP literal", () => {
    const h = "cf-connecting-ip";
    expect(clientAddress(req("127.0.0.1", { [h]: "198.51.100.4" }), h)).toBe("198.51.100.4");
    expect(clientAddress(req("::1", { [h]: "2001:db8::7" }), h)).toBe("2001:db8::7");
    expect(clientAddress(req("::ffff:127.0.0.1", { [h]: "198.51.100.4" }), h)).toBe("198.51.100.4");
    // A direct (non-loopback) caller cannot choose its own key.
    expect(clientAddress(req("203.0.113.5", { [h]: "198.51.100.4" }), h)).toBe("203.0.113.5");
    // Not configured: the header means nothing.
    expect(clientAddress(req("127.0.0.1", { [h]: "198.51.100.4" }), undefined)).toBe("127.0.0.1");
    // A list, garbage or an empty value: the socket peer.
    expect(clientAddress(req("127.0.0.1", { [h]: "198.51.100.4, 10.0.0.1" }), h)).toBe("127.0.0.1");
    expect(clientAddress(req("127.0.0.1", { [h]: "evil" }), h)).toBe("127.0.0.1");
    expect(clientAddress(req("127.0.0.1", { [h]: "" }), h)).toBe("127.0.0.1");
    expect(clientAddress(req("127.0.0.1", { [h]: ["198.51.100.4", "1.2.3.4"] }), h)).toBe("127.0.0.1");
    expect(clientAddress(req(undefined), h)).toBeUndefined();
  });

  it("identifies requests by key, so one header-forwarded address cannot spend another's attempts", () => {
    const limiter = new IpAttemptLimiter("x-client-ip");
    expect(limiter.identify(req("127.0.0.1", { "x-client-ip": "198.51.100.4" }))).toEqual({
      ip: "198.51.100.4",
      key: "198.51.100.4",
    });
    expect(limiter.identify(req("203.0.113.5", { "x-client-ip": "198.51.100.4" })).key).toBe("203.0.113.5");
    expect(limiter.identify(req(undefined)).key).toBe("unknown");
  });
});

describe("IpAttemptLimiter", () => {
  it("locks an address on its tenth failure within five minutes, for fifteen minutes", () => {
    const l = new IpAttemptLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < IP_MAX_FAILURES - 1; i++) expect(l.fail("a", t0 + i * 1000)).toBe(false);
    expect(l.locked("a", t0 + 10_000)).toBe(false);
    expect(l.fail("a", t0 + 10_000)).toBe(true);
    expect(l.locked("a", t0 + 10_000)).toBe(true);
    expect(l.locked("b", t0 + 10_000)).toBe(false);
    expect(l.locked("a", t0 + 10_000 + IP_LOCK_MS - 1)).toBe(true);
    expect(l.locked("a", t0 + 10_000 + IP_LOCK_MS)).toBe(false);
  });

  it("forgets failures older than the window", () => {
    const l = new IpAttemptLimiter();
    for (let i = 0; i < IP_MAX_FAILURES - 1; i++) l.fail("a", i);
    expect(l.fail("a", IP_WINDOW_MS + 100)).toBe(false);
    expect(l.locked("a", IP_WINDOW_MS + 100)).toBe(false);
  });

  it("tracks a bounded number of addresses, keeping locked ones over unlocked ones", () => {
    const l = new IpAttemptLimiter();
    for (let i = 0; i < IP_MAX_FAILURES; i++) l.fail("locked", i);
    expect(l.locked("locked", 100)).toBe(true);
    for (let i = 0; i < MAX_TRACKED_ADDRESSES + 50; i++) l.fail(`k${i}`, 200);
    expect(l.size).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);
    expect(l.locked("locked", 300)).toBe(true);
    // Expired entries are pruned first once the map is full.
    const later = 200 + IP_WINDOW_MS + IP_LOCK_MS;
    l.fail("fresh", later);
    expect(l.size).toBeLessThan(10);
  });
});
