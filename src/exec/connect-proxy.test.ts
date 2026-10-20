/**
 * ADR-0071: the allowlisting CONNECT proxy against a local upstream listener, with fake name resolution (no network).
 */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConnectProxy, isPublicAddress, startConnectProxy } from "./connect-proxy.js";

let upstream: net.Server;
let upstreamPort: number;
let dialled: { address: string; port: number }[];
let proxy: ConnectProxy | undefined;
let dir: string;

beforeEach(async () => {
  dialled = [];
  dir = mkdtempSync(path.join(tmpdir(), "sb-proxy-"));
  // The "registry": echoes what it receives, prefixed, so a tunnel is observable end to end.
  upstream = net.createServer((s) => s.on("data", (d) => s.write(`echo:${d.toString()}`)));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** Fake resolution: the allowed names resolve to loopback; the dialler redirects port 443 to the local listener. */
const fakes = {
  lookup: async (host: string) => (host === "nowhere.example" ? [] : [{ address: "127.0.0.1", family: 4 }]),
  dial: (address: string, port: number) => {
    dialled.push({ address, port });
    return net.connect({ host: address, port: upstreamPort });
  },
};

/** Sends `head` (and then `then`, once a 200 arrives) to the proxy; resolves with everything read until close. */
function talk(target: { path: string } | { port: number }, head: string, then?: string): Promise<string> {
  return new Promise((resolve) => {
    const s = "path" in target ? net.connect(target.path) : net.connect(target.port, "127.0.0.1");
    let got = "";
    s.on("connect", () => s.write(head));
    s.on("data", (d) => {
      got += d.toString();
      if (then !== undefined && got.startsWith("HTTP/1.1 200") && !got.includes("echo:")) s.write(then);
      if (got.includes("echo:")) s.end();
    });
    s.on("close", () => resolve(got));
    s.on("error", () => resolve(got));
  });
}

describe("connect proxy (ADR-0071)", () => {
  it("tunnels CONNECT to an allowed host on 443 and dials the resolved address", async () => {
    proxy = await startConnectProxy({
      hosts: ["registry.npmjs.org"],
      listen: { path: path.join(dir, "p.sock") },
      ...fakes,
      allowAddress: () => true,
    });
    const got = await talk(
      { path: proxy.address as string },
      "CONNECT Registry.NPMJS.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n",
      "hello",
    );
    expect(got.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true);
    expect(got).toContain("echo:hello");
    expect(dialled).toEqual([{ address: "127.0.0.1", port: 443 }]);
    expect(proxy.stats()).toEqual({ allowed: 1, refused: 0 });
  });

  it("refuses an unlisted host, another port, a non-CONNECT method and a malformed line; nothing is dialled", async () => {
    proxy = await startConnectProxy({
      hosts: ["registry.npmjs.org"],
      listen: { port: 0 },
      ...fakes,
      allowAddress: () => true,
    });
    const port = proxy.address as number;
    expect(await talk({ port }, "CONNECT evil.example:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403 /);
    expect(await talk({ port }, "CONNECT registry.npmjs.org:80 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403 /);
    expect(await talk({ port }, "CONNECT registry.npmjs.org.evil.example:443 HTTP/1.1\r\n\r\n")).toMatch(
      /^HTTP\/1\.1 403 /,
    );
    expect(await talk({ port }, "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403 /);
    expect(await talk({ port }, "GET http://registry.npmjs.org/ HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 405 /);
    expect(await talk({ port }, "CONNECT registry.npmjs.org:443\r\n\r\n")).toMatch(/^HTTP\/1\.1 403 /);
    expect(await talk({ port }, `CONNECT ${"a".repeat(9000)}`)).toMatch(/^HTTP\/1\.1 431 /);
    expect(dialled).toEqual([]);
    expect(proxy.stats()).toEqual({ allowed: 0, refused: 7 });
  });

  it("by default refuses an allowed name that resolves to a loopback or private address (502)", async () => {
    proxy = await startConnectProxy({
      hosts: ["registry.npmjs.org", "nowhere.example"],
      listen: { port: 0 },
      ...fakes,
    });
    const port = proxy.address as number;
    expect(await talk({ port }, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 502 /);
    expect(await talk({ port }, "CONNECT nowhere.example:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 502 /);
    expect(dialled).toEqual([]);
  });

  it("classifies addresses: only public unicast is dialled", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isPublicAddress(a, 4)).toBe(false);
    }
    for (const a of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::"]) expect(isPublicAddress(a, 6)).toBe(false);
    expect(isPublicAddress("104.16.1.34", 4)).toBe(true);
    expect(isPublicAddress("2606:4700::6810:122", 6)).toBe(true);
    expect(isPublicAddress("not-an-ip", 4)).toBe(false);
  });
});
