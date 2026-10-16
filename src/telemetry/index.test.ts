import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetry } from "./index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function collector(stall = false) {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => {
      body += part;
    });
    request.on("end", () => {
      bodies.push(body);
      if (!stall) response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { bodies, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces` };
}

describe("lazy OTLP transport (T8.1)", () => {
  it("does not export or initialize a transport without an endpoint", async () => {
    const capture = await collector();
    const telemetry = createTelemetry({});
    telemetry.recordSpan({ name: "provider.spawn", startTime: Date.now(), endTime: Date.now() });
    await telemetry.close();
    expect(capture.bodies).toEqual([]);
  });

  it("initializes the real exporter on first export without blocking the caller", async () => {
    const capture = await collector();
    const telemetry = createTelemetry({ telemetry: { otlpEndpoint: capture.endpoint } });
    cleanup.push(() => telemetry.close());
    expect(capture.bodies).toEqual([]);
    const now = Date.now();
    expect(telemetry.recordSpan({ name: "provider.spawn", startTime: now, endTime: now + 1 })).toBeUndefined();
    await vi.waitFor(() => expect(capture.bodies).toHaveLength(1), { timeout: 5000 });
    expect(JSON.parse(capture.bodies[0] ?? "").resourceSpans[0].scopeSpans[0].spans[0].name).toBe("provider.spawn");
  });

  it("a stalled collector never blocks submission and shutdown is bounded by the export timeout", async () => {
    const capture = await collector(true);
    const telemetry = createTelemetry({ telemetry: { otlpEndpoint: capture.endpoint } });
    cleanup.push(() => telemetry.close());
    const now = Date.now();
    telemetry.recordSpan({ name: "provider.spawn", startTime: now, endTime: now });
    await vi.waitFor(() => expect(capture.bodies).toHaveLength(1), { timeout: 5000 });
    // The collector received the first export but deliberately never responded.
    expect(telemetry.recordSpan({ name: "run.finalize", startTime: now, endTime: now })).toBeUndefined();
    const closing = telemetry.close();
    const deadline = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timed out"), 3000);
      void closing.finally(() => clearTimeout(timer));
    });
    expect(await Promise.race([closing.then(() => "closed"), deadline])).toBe("closed");
  });

  it("ignores collector failure and stops accepting spans after close", async () => {
    const telemetry = createTelemetry({ telemetry: { otlpEndpoint: "http://127.0.0.1:1/v1/traces" } });
    const now = Date.now();
    telemetry.recordSpan({ name: "provider.spawn", startTime: now, endTime: now });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(telemetry.close()).resolves.toBeUndefined();
    telemetry.recordSpan({ name: "provider.spawn", startTime: now, endTime: now });
  });
});
