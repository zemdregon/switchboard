import { describe, expect, it, vi } from "vitest";
import { type HttpTransportSettings, isLoopbackAddress, resolveHttpTransport } from "../config/index.js";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  startHttpTransport,
} from "./http.js";

const settings = (port = 0, allowed_origins: string[] = []): HttpTransportSettings =>
  resolveHttpTransport({
    enabled: true,
    public_url: "https://sb.example.test/mcp",
    port,
    allowed_origins,
  }) as HttpTransportSettings;

describe("network transport off (FR-MCP-12)", () => {
  it("creates no server and opens no listener when the option is off", async () => {
    const createServer = vi.fn();
    expect(await startHttpTransport(undefined, { createServer })).toBeUndefined();
    expect(createServer).not.toHaveBeenCalled();
    expect(resolveHttpTransport(undefined)).toBeUndefined();
    expect(
      resolveHttpTransport({ enabled: false, public_url: "https://sb.example.test/mcp", port: 1 }),
    ).toBeUndefined();
  });
});

describe("loopback detection", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.5.6.7", true],
    ["::1", true],
    ["0.0.0.0", false],
    ["::", false],
    ["10.0.0.1", false],
    ["::ffff:127.0.0.1", true],
    ["localhost", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLoopbackAddress(host)).toBe(expected);
  });
});

describe("metadata documents (RFC 9728, RFC 8414)", () => {
  it("binds the resource to the public MCP URL and names the embedded issuer", () => {
    const s = settings();
    expect(s).toMatchObject({ bind: "127.0.0.1", issuer: "https://sb.example.test", mcpPath: "/mcp" });
    expect(protectedResourceMetadataUrl(s.resource)).toBe(
      "https://sb.example.test/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResourceMetadata(s)).toEqual({
      resource: "https://sb.example.test/mcp",
      authorization_servers: ["https://sb.example.test"],
      bearer_methods_supported: ["header"],
      resource_name: "Switchboard",
    });
    const as = authorizationServerMetadata(s);
    expect(as.issuer).toBe("https://sb.example.test");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.response_types_supported).toEqual(["code"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.grant_types_supported).not.toContain("implicit");
    expect(as.grant_types_supported).not.toContain("password");
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      expect(String(as[key]).startsWith("https://sb.example.test/")).toBe(true);
    }
  });
});

describe("listener (T13.1 skeleton)", () => {
  it("serves both metadata documents, challenges the MCP endpoint, and closes", async () => {
    const s = settings();
    const listener = await startHttpTransport(s);
    if (!listener) throw new Error("expected a listener");
    const base = `http://127.0.0.1:${listener.address.port}`;
    try {
      expect(listener.address.address).toBe("127.0.0.1");

      for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const r = await fetch(`${base}${p}`);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("application/json");
        expect(await r.json()).toEqual(protectedResourceMetadata(s));
      }
      const as = await fetch(`${base}/.well-known/oauth-authorization-server`);
      expect(as.status).toBe(200);
      const asDoc = (await as.json()) as Record<string, unknown>;
      expect(asDoc).toEqual(authorizationServerMetadata(s));
      expect([asDoc.issuer]).toEqual(protectedResourceMetadata(s).authorization_servers);

      const token = "sb-test-token-value-0123456789";
      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(mcp.status).toBe(401);
      expect(mcp.headers.get("www-authenticate")).toBe(
        'Bearer resource_metadata="https://sb.example.test/.well-known/oauth-protected-resource/mcp"',
      );
      const body = await mcp.text();
      expect(body).not.toContain(token);
      expect([...mcp.headers.values()].join("\n")).not.toContain(token);

      const post = await fetch(`${base}/.well-known/oauth-authorization-server`, { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
      expect((await fetch(`${base}/token`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${base}/`)).status).toBe(404);
      const head = await fetch(`${base}/.well-known/oauth-authorization-server`, { method: "HEAD" });
      expect(head.status).toBe(200);
    } finally {
      await listener.close();
    }
    await expect(fetch(`${base}/.well-known/oauth-protected-resource`)).rejects.toThrow();
  });

  it("refuses an unlisted Origin with 403 on every path before routing (T13.2)", async () => {
    const listener = await startHttpTransport(settings(0, ["https://app.example.test"]));
    if (!listener) throw new Error("expected a listener");
    const base = `http://127.0.0.1:${listener.address.port}`;
    try {
      const paths = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/mcp", "/x"];
      for (const p of paths) {
        for (const origin of [
          "https://evil.example.test",
          "null",
          "https://app.example.test:8443",
          "http://app.example.test",
        ]) {
          const r = await fetch(`${base}${p}`, { headers: { origin } });
          expect(r.status, `${origin} ${p}`).toBe(403);
          expect(await r.json()).toEqual({ error: "forbidden_origin" });
          expect(r.headers.get("access-control-allow-origin")).toBeNull();
        }
      }
      // DNS rebinding: a page on an attacker host resolved to loopback still sends its own Origin.
      const rebind = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { origin: "http://rebind.attacker.test:1234", "content-type": "application/json" },
        body: "{}",
      });
      expect(rebind.status).toBe(403);
      // A listed Origin and a request without one reach routing.
      expect(
        (
          await fetch(`${base}/.well-known/oauth-protected-resource`, {
            headers: { origin: "https://app.example.test" },
          })
        ).status,
      ).toBe(200);
      expect(
        (await fetch(`${base}/mcp`, { method: "POST", headers: { origin: "https://app.example.test" } })).status,
      ).toBe(401);
      expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(200);
    } finally {
      await listener.close();
    }
  });

  it("refuses every Origin-bearing request when no origin is configured", async () => {
    const listener = await startHttpTransport(settings());
    if (!listener) throw new Error("expected a listener");
    try {
      const r = await fetch(`http://127.0.0.1:${listener.address.port}/.well-known/oauth-protected-resource`, {
        headers: { origin: "https://sb.example.test" },
      });
      expect(r.status).toBe(403);
    } finally {
      await listener.close();
    }
  });

  it("rejects when the port is taken, so serve fails closed", async () => {
    const first = await startHttpTransport(settings());
    if (!first) throw new Error("expected a listener");
    try {
      await expect(startHttpTransport(settings(first.address.port))).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close();
    }
  });
});
