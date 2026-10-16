import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_SPAN_ATTRIBUTE_KEYS, allowlistedAttributes } from "./allowlist.js";
import { type CompletedSpan, createTelemetry } from "./index.js";
import { delegateSpan, spawnSpan } from "./spans.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function collector() {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => {
      body += part;
    });
    request.on("end", () => {
      bodies.push(body);
      response.end("{}");
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

const PLANTED = "PLANTED-OBJECTIVE-7f3c refactor the payment module";

/** An internal builder that (wrongly) sets forbidden keys next to allowlisted ones. */
function leakySpawnSpan(now: number): CompletedSpan {
  const attributes: Record<string, string | number | boolean> = {
    "run.id": "run_1",
    provider: "fake",
    duration_ms: 5,
    objective: PLANTED,
    "process.command_line": `fake-cli --prompt ${PLANTED}`,
    "env.HOME": "/home/operator",
  };
  return { name: "provider.spawn", startTime: now, endTime: now + 5, attributes };
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

describe("span attribute allowlist (T8.4)", () => {
  it("keeps allowlisted scalar keys and drops every other key", () => {
    const kept = allowlistedAttributes({
      "run.id": "run_1",
      "inner.tokens_in": 12,
      "exit.signal": "SIGTERM",
      objective: PLANTED,
      "Run.Id": "case variant",
      "run.id.extra": "suffix variant",
    });
    expect(kept).toEqual({ "run.id": "run_1", "inner.tokens_in": 12, "exit.signal": "SIGTERM" });
  });

  it("drops non-scalar and non-finite values even on allowlisted keys", () => {
    expect(
      allowlistedAttributes({ "run.id": ["a"], provider: { nested: PLANTED }, duration_ms: Number.NaN, model: null }),
    ).toBeUndefined();
    expect(allowlistedAttributes(undefined)).toBeUndefined();
    expect(allowlistedAttributes("run.id")).toBeUndefined();
  });

  it("fails closed when reading attributes throws", () => {
    const hostile = {
      "run.id": "run_1",
      get provider(): string {
        throw new Error(PLANTED);
      },
    };
    expect(allowlistedAttributes(hostile)).toBeUndefined();
  });

  it("matches the key list documented in LLD §7 and §13.8", () => {
    const lld = readFileSync(new URL("../../docs/design/LLD.md", import.meta.url), "utf8");
    const core = /\*\*Allowed attributes[\s\S]*?(?=\*\*Forbidden)/.exec(lld)?.[0] ?? "";
    const inner = /\*\*Span `inner\.call`\*\*[\s\S]*?(?=Forbidden:)/.exec(lld)?.[0] ?? "";
    const documented = new Set([
      ...backticked(core).filter((key) => /^[a-z_]+(\.[a-z0-9_]+)*$/.test(key)),
      ...backticked(inner).filter((key) => key.startsWith("inner.") && key !== "inner.call"),
    ]);
    expect(documented.size).toBeGreaterThan(20);
    expect([...ALLOWED_SPAN_ATTRIBUTE_KEYS].sort()).toEqual([...documented].sort());
  });

  it("every key the T8.2 builders can emit is allowlisted, so the filter never drops a legitimate attribute", () => {
    const common = { runId: "run_1", sessionId: "ses_1", trustProfile: "read_only", model: "m", attempt: 2 };
    const spans = [
      delegateSpan(0, 1, { ...common, provider: "fake", terminalState: "FAILED", failureCode: "PROCESS_CRASH" }),
      spawnSpan(0, 1, {
        ...common,
        provider: "fake",
        adapterVersion: "1.0.0",
        transport: "subprocess-jsonl",
        exitCode: 1,
        exitSignal: "SIGTERM",
      }),
    ];
    for (const span of spans) {
      expect(Object.keys(span.attributes ?? {}).length).toBeGreaterThan(5);
      expect(allowlistedAttributes(span.attributes)).toEqual(span.attributes);
    }
  });

  it("a disallowed key planted on an internal span builder never reaches the exporter", async () => {
    const capture = await collector();
    const telemetry = createTelemetry({ telemetry: { otlpEndpoint: capture.endpoint } });
    cleanup.push(() => telemetry.close());
    telemetry.recordSpan(leakySpawnSpan(Date.now()));
    await vi.waitFor(() => expect(capture.bodies).toHaveLength(1), { timeout: 5000 });
    const body = capture.bodies[0] ?? "";
    const span = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0] as { attributes: { key: string }[] };
    expect(span.attributes.map((attribute) => attribute.key).sort()).toEqual(["duration_ms", "provider", "run.id"]);
    expect(body).not.toContain("PLANTED-OBJECTIVE-7f3c");
    expect(body).not.toContain("/home/operator");
  });
});
