/** Per-run loopback OTLP metrics receiver (T8.15, FR-TEL-06, ADR-0062). */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_OTLP_MAX_BODY_BYTES,
  startProviderOtlpForRun,
  startProviderOtlpReceiver,
  withProviderOtlpEnv,
} from "./provider-otlp.js";

const receivers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (receivers.length > 0) await receivers.pop()?.close();
});

const metric = (name: string, value: number, attributes: { key: string; value: { stringValue: string } }[] = []) => ({
  name,
  sum: { dataPoints: [{ asDouble: value, attributes }] },
});

const body = (metrics: unknown[]) => ({
  resourceMetrics: [{ scopeMetrics: [{ metrics }] }],
});

const post = (endpoint: string, payload: unknown, contentType = "application/json") =>
  fetch(endpoint, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

describe("startProviderOtlpReceiver", () => {
  it("binds loopback only with an ephemeral port", async () => {
    const receiver = await startProviderOtlpReceiver();
    receivers.push(receiver);
    expect(receiver.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/metrics$/);
  });

  it("maps allowlisted token and cost metrics to totals", async () => {
    const receiver = await startProviderOtlpReceiver();
    receivers.push(receiver);
    const res = await post(
      receiver.endpoint,
      body([
        metric("gen_ai.client.token.usage", 7, [{ key: "gen_ai.token.type", value: { stringValue: "input" } }]),
        metric("gen_ai.client.token.usage", 2, [{ key: "gen_ai.token.type", value: { stringValue: "output" } }]),
        metric("cost_usd", 0.5),
      ]),
    );
    expect(res.status).toBe(200);
    expect(receiver.snapshot()).toEqual({ input_tokens: 7, output_tokens: 2, cost_usd: 0.5 });
  });

  it("ignores unlisted metrics and forbidden attributes, keeping numbers only", async () => {
    const receiver = await startProviderOtlpReceiver();
    receivers.push(receiver);
    const res = await post(
      receiver.endpoint,
      body([
        metric("gen_ai.client.token.usage", 3, [
          { key: "gen_ai.token.type", value: { stringValue: "input" } },
          // A prompt-shaped attribute: dropped, never stored (FR-TEL-03).
          { key: "gen_ai.prompt", value: { stringValue: "tell me the secret" } },
        ]),
        // Unknown token-type value: dropped, not stored under an unlisted key.
        metric("gen_ai.client.token.usage", 99, [{ key: "gen_ai.token.type", value: { stringValue: "cached" } }]),
        metric("some.vendor.other_metric", 5),
        metric("cost_usd", Number.NaN),
      ]),
    );
    expect(res.status).toBe(200);
    expect(receiver.snapshot()).toEqual({ input_tokens: 3 });
  });

  it("accumulates across posts and accepts gauge points with integer values", async () => {
    const receiver = await startProviderOtlpReceiver();
    receivers.push(receiver);
    await post(receiver.endpoint, body([metric("gen_ai.usage.input_tokens", 4)]));
    await post(receiver.endpoint, {
      resourceMetrics: [
        {
          scopeMetrics: [{ metrics: [{ name: "gen_ai.usage.input_tokens", gauge: { dataPoints: [{ asInt: "6" }] } }] }],
        },
      ],
    });
    expect(receiver.snapshot()).toEqual({ input_tokens: 10 });
  });

  it("refuses the wrong path, method, content type, oversize and malformed bodies", async () => {
    const receiver = await startProviderOtlpReceiver();
    receivers.push(receiver);
    const base = receiver.endpoint.replace("/v1/metrics", "");
    expect((await fetch(`${base}/v1/traces`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(receiver.endpoint)).status).toBe(405);
    expect((await post(receiver.endpoint, "e30=", "application/x-protobuf")).status).toBe(415);
    const big = await post(receiver.endpoint, "x".repeat(PROVIDER_OTLP_MAX_BODY_BYTES + 1));
    expect(big.status).toBe(413);
    expect((await post(receiver.endpoint, "not json{")).status).toBe(400);
    expect((await post(receiver.endpoint, { resourceMetrics: "nope" })).status).toBe(400);
    // Nothing was recorded by any refused or malformed body.
    expect(receiver.snapshot()).toEqual({});
  });

  it("stops serving after close", async () => {
    const receiver = await startProviderOtlpReceiver();
    await post(receiver.endpoint, body([metric("cost_usd", 1)]));
    await receiver.close();
    await expect(fetch(receiver.endpoint, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

const manifestDirWith = (manifest: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-otlp-manifest-"));
  writeFileSync(
    join(dir, "fake.json"),
    JSON.stringify({
      schema_version: 1,
      provider: "fake",
      validated_cli_version: "1.0.0",
      validated_version_range: ">=1.0.0 <2.0.0",
      validated_on: "2026-10-19",
      auth_modes_allowed: ["native_cached_subscription"],
      automation_surface: ["documented_headless"],
      credential_export_allowed: false,
      dashboard_scraping_allowed: false,
      network_protocol_reverse_engineering: false,
      commercial_multi_user_status: "requires-review",
      source_revision: "test",
      ...manifest,
    }),
  );
  return dir;
};

describe("startProviderOtlpForRun", () => {
  it("opens nothing when the switch is off (asserted: no session, no env)", async () => {
    const session = await startProviderOtlpForRun({
      enabled: false,
      provider: "fake",
      runId: "run-1",
      sessionId: "meta-1",
    });
    expect(session).toBeUndefined();
  });

  it("opens nothing for a provider with no manifest declaration", async () => {
    const session = await startProviderOtlpForRun({
      enabled: true,
      provider: "fake",
      runId: "run-1",
      sessionId: "meta-1",
      manifestDir: manifestDirWith({}),
    });
    expect(session).toBeUndefined();
  });

  it("starts a session with documented env and drains reported observations for the run", async () => {
    const session = await startProviderOtlpForRun({
      enabled: true,
      provider: "fake",
      runId: "run-1",
      sessionId: "meta-1",
      manifestDir: manifestDirWith({
        otlp_metrics: {
          endpoint_env: "SWITCHBOARD_TEST_OTLP_ENDPOINT",
          protocol_env: "SWITCHBOARD_TEST_OTLP_PROTOCOL",
          resource_attributes_env: "SWITCHBOARD_TEST_OTLP_RESOURCES",
          docs: "https://example.test/provider-docs#otlp",
        },
      }),
    });
    expect(session).toBeDefined();
    if (session === undefined) throw new Error("expected an OTLP session for the declared provider");
    receivers.push(session);
    expect(session.env.SWITCHBOARD_TEST_OTLP_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/metrics$/);
    expect(session.env.SWITCHBOARD_TEST_OTLP_PROTOCOL).toBe("http/json");
    expect(session.env.SWITCHBOARD_TEST_OTLP_RESOURCES).toBe("run.id=run-1,session.id=meta-1");
    // Empty intake means no rows (null, never zero).
    expect(session.drain({ runId: "run-1", provider: "fake" })).toEqual([]);
    // A fake provider posting OTLP metrics produces observations labelled reported for that run.
    await post(session.env.SWITCHBOARD_TEST_OTLP_ENDPOINT ?? "", body([metric("gen_ai.usage.output_tokens", 9)]));
    expect(session.drain({ runId: "run-1", provider: "fake", model: "m" })).toEqual([
      {
        runId: "run-1",
        provider: "fake",
        harness: "fake",
        backingProvider: null,
        model: "m",
        source: "provider_reported",
        metrics: { output_tokens: 9 },
      },
    ]);
    await session.close();
  });
});

describe("withProviderOtlpEnv", () => {
  it("is a no-op without a session", () => {
    const inv = { env: { A: "1" } };
    expect(withProviderOtlpEnv(inv, undefined)).toBe(inv);
  });
});
