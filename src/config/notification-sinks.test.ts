/**
 * T14.9 (FR-CTL-10, LLD §3.4.9, ADR-0048): `notification_sinks[]` loads off by default, resolves both kinds, refuses
 * anything but HTTPS, and never echoes a configured URL, topic or token in an error.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SINK_MAX_PER_MINUTE, loadConfig, SINK_EVENT_KINDS } from "./index.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-sinkcfg-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const CANARY = "canary-sink-9f3c2a";
const load = (sinks?: unknown) => {
  const p = path.join(tmp, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: 1,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
      ...(sinks !== undefined ? { notification_sinks: sinks } : {}),
    }),
  );
  return loadConfig({ configPath: p });
};
const errorOf = (sinks: unknown): string => {
  try {
    load(sinks);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the config to be refused");
};

describe("notification_sinks config (T14.9)", () => {
  it("is off when absent or empty", () => {
    expect(load().notificationSinks).toEqual([]);
    expect(load([]).notificationSinks).toEqual([]);
  });

  it("resolves a webhook and an ntfy sink with their defaults", () => {
    const [w, n] = load([
      { id: "grok-bot", kind: "webhook", url: `https://hooks.example.test/${CANARY}` },
      {
        id: "phone",
        kind: "ntfy",
        ntfy: { server: "https://ntfy.example.test", topic: "sb-ops", token: `tk_${CANARY}` },
        events: ["run_terminal", "needs_attention"],
        max_per_minute: 3,
      },
    ]).notificationSinks;
    expect(w).toMatchObject({ id: "grok-bot", kind: "webhook", url: `https://hooks.example.test/${CANARY}` });
    expect(w?.authorization).toBeUndefined();
    expect(w?.maxPerMinute).toBe(DEFAULT_SINK_MAX_PER_MINUTE);
    expect([...(w?.events ?? [])]).toEqual([...SINK_EVENT_KINDS]);
    expect(n).toMatchObject({
      id: "phone",
      kind: "ntfy",
      url: "https://ntfy.example.test/",
      topic: "sb-ops",
      token: `tk_${CANARY}`,
      maxPerMinute: 3,
    });
    expect([...(n?.events ?? [])]).toEqual(["run_terminal", "needs_attention"]);
  });

  it("resolves a webhook sink with an authorization header value (FR-CTL-12)", () => {
    const [w] = load([
      {
        id: "secure-hook",
        kind: "webhook",
        url: "https://hooks.example.test/secure",
        authorization: `Bearer ${CANARY}`,
      },
    ]).notificationSinks;
    expect(w).toMatchObject({
      id: "secure-hook",
      kind: "webhook",
      url: "https://hooks.example.test/secure",
      authorization: `Bearer ${CANARY}`,
    });
  });

  it.each([
    ["plain http", `http://hooks.example.test/${CANARY}`, /url: must use https/],
    ["plain http on loopback", `http://127.0.0.1:8080/${CANARY}`, /url: must use https/],
    ["userinfo", `https://user:${CANARY}@hooks.example.test/x`, /url: must not contain userinfo/],
    ["a query", `https://hooks.example.test/x?key=${CANARY}`, /url: must not have a query or fragment/],
    ["not a URL", `not a url ${CANARY}`, /url: not a valid URL/],
  ])("refuses a webhook url with %s and does not echo it", (_, url, re) => {
    const msg = errorOf([{ id: "w", kind: "webhook", url }]);
    expect(msg).toMatch(re);
    expect(msg).not.toContain(CANARY);
  });

  it("refuses an ntfy server that is not https without echoing the server, topic or token", () => {
    const msg = errorOf([
      { id: "n", kind: "ntfy", ntfy: { server: `http://${CANARY}.example.test`, topic: "t", token: CANARY } },
    ]);
    expect(msg).toMatch(/\$\.notification_sinks\[0\]\.ntfy\.server: must use https/);
    expect(msg).not.toContain(CANARY);
  });

  it("refuses an invalid ntfy topic without echoing it", () => {
    const msg = errorOf([
      { id: "n", kind: "ntfy", ntfy: { server: "https://ntfy.example.test", topic: `a/${CANARY}` } },
    ]);
    expect(msg).toMatch(/\$\.notification_sinks\[0\]\.ntfy\.topic: must match pattern/);
    expect(msg).not.toContain(CANARY);
  });

  it("refuses an ntfy sink with authorization without echoing it", () => {
    const msg = errorOf([
      {
        id: "n",
        kind: "ntfy",
        ntfy: { server: "https://ntfy.example.test", topic: "t", token: "tok" },
        authorization: CANARY,
      },
    ]);
    expect(msg).toMatch(/\$\.notification_sinks\[0\]\.authorization: only for kind webhook/);
    expect(msg).not.toContain(CANARY);
  });

  it.each([
    [[{ id: "w", kind: "webhook" }], /\[0\]\.url: required for kind webhook/],
    [[{ id: "n", kind: "ntfy" }], /\[0\]\.ntfy: required for kind ntfy/],
    [
      [{ id: "w", kind: "webhook", url: "https://a.test/x", ntfy: { server: "https://b.test", topic: "t" } }],
      /\[0\]\.ntfy: only for kind ntfy/,
    ],
    [
      [{ id: "n", kind: "ntfy", url: "https://a.test/x", ntfy: { server: "https://b.test", topic: "t" } }],
      /\[0\]\.url: only for kind webhook/,
    ],
    [
      [
        {
          id: "n",
          kind: "ntfy",
          ntfy: { server: "https://a.test", topic: "t" },
          authorization: "Bearer secret",
        },
      ],
      /\[0\]\.authorization: only for kind webhook/,
    ],
    [
      [{ id: "w", kind: "webhook", url: "https://a.test/x", authorization: "" }],
      /\[0\]\.authorization: must NOT have fewer than 1 characters/,
    ],
    [
      [{ id: "w", kind: "webhook", url: "https://a.test/x", authorization: "a".repeat(513) }],
      /\[0\]\.authorization: must NOT have more than 512 characters/,
    ],
    [
      [
        { id: "w", kind: "webhook", url: "https://a.test/x" },
        { id: "w", kind: "webhook", url: "https://a.test/y" },
      ],
      /\[1\]\.id: used by more than one sink/,
    ],
    [[{ id: "w", kind: "email", url: "https://a.test/x" }], /\[0\]\.kind: must be one of webhook, ntfy/],
    [
      [{ id: "w", kind: "webhook", url: "https://a.test/x", events: ["run_started"] }],
      /\[0\]\.events\[0\]: must be one of/,
    ],
    [[{ id: "w", kind: "webhook", url: "https://a.test/x", events: [] }], /\[0\]\.events: must NOT have fewer/],
    [[{ id: "w", kind: "webhook", url: "https://a.test/x", max_per_minute: 0 }], /\[0\]\.max_per_minute: must be >= 1/],
    [[{ id: "w", kind: "webhook", url: "https://a.test/x", secret: "x" }], /\[0\]\.secret: unknown key/],
  ])("refuses %j", (sinks, re) => {
    expect(errorOf(sinks)).toMatch(re);
  });
});
