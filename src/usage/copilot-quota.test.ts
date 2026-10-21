/**
 * ADR-0081: the usage-only `copilot` quota. The parser over the recorded, redacted `gh api /copilot_internal/user`
 * answer, and the reader over an injected `gh` runner. No real `gh` runs here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ghEnv } from "../ci/gh-argv.js";
import type { GhRunner, GhRunResult } from "../ci/gh-port.js";
import { createCopilotQuotaReader, type ProviderQuotaReport, parseCopilotQuota } from "./copilot-quota.js";

const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "copilot-internal-user.free.redacted.json"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: the fixture is untyped JSON mutated per case
type Json = Record<string, any>;

const READ_AT = new Date("2026-10-21T03:00:00.000Z");

const EXPECTED: ProviderQuotaReport = {
  provider: "copilot",
  usage_only: true,
  status: "ok",
  source: "provider_reported",
  via: "gh api /copilot_internal/user",
  observed_at: "2026-10-21T02:38:27.836Z",
  plan: "individual",
  sku: "free_limited_copilot",
  reset_at: { at: "2026-11-01T00:00:00.000Z", source: "provider_reported" },
  quotas: [
    {
      id: "premium_interactions",
      unit: "premium_requests",
      unlimited: false,
      entitlement: 0,
      remaining: 0,
      used: 0,
      percent_remaining: 0,
      overage_count: 0,
      overage_permitted: false,
      reset_at: "2026-11-01T00:00:00.000Z",
    },
    {
      id: "chat",
      unit: "chat_requests",
      unlimited: false,
      entitlement: 200,
      remaining: 27.7,
      used: 172.3,
      percent_remaining: 13.8,
      overage_count: 0,
      overage_permitted: false,
      reset_at: "2026-11-01T00:00:00.000Z",
    },
    {
      id: "completions",
      unit: "code_completions",
      unlimited: false,
      entitlement: 2000,
      remaining: 2000,
      used: 0,
      percent_remaining: 100,
      overage_count: 0,
      overage_permitted: false,
      reset_at: "2026-11-01T00:00:00.000Z",
    },
  ],
};

const unavailable = (reason: string, at = READ_AT) => ({
  provider: "copilot",
  usage_only: true,
  status: "unavailable",
  source: "unknown",
  via: "gh api /copilot_internal/user",
  observed_at: at.toISOString(),
  reason,
});

function fixtureWith(mutate: (u: Json) => void): string {
  const u = JSON.parse(FIXTURE) as Json;
  mutate(u);
  return JSON.stringify(u);
}

describe("parseCopilotQuota (ADR-0081)", () => {
  it("reads the recorded answer through the allowlist only", () => {
    const report = parseCopilotQuota(FIXTURE, READ_AT);
    expect(report).toEqual(EXPECTED);
    const text = JSON.stringify(report);
    for (const leak of ["login", "redacted", "analytics", "tracking", "endpoints", "example.invalid", '"id":1']) {
      expect(text).not.toContain(leak);
    }
    expect(text).not.toMatch(/organization|enterprise|assigned_date|credits_used|quota_id|has_quota/);
  });

  it("an unlimited snapshot has no figures", () => {
    const report = parseCopilotQuota(
      fixtureWith((u) => {
        u.quota_snapshots.chat = { unlimited: true, overage_count: 0, overage_permitted: false, entitlement: 0 };
      }),
      READ_AT,
    );
    expect(report.status === "ok" && report.quotas[1]).toEqual({
      id: "chat",
      unit: "chat_requests",
      unlimited: true,
      entitlement: null,
      remaining: null,
      used: null,
      percent_remaining: null,
      overage_count: 0,
      overage_permitted: false,
      reset_at: "2026-11-01T00:00:00.000Z",
    });
  });

  it("skips absent snapshots, falls back to the integer remaining and to the read time", () => {
    const report = parseCopilotQuota(
      fixtureWith((u) => {
        delete u.quota_snapshots.premium_interactions;
        delete u.quota_snapshots.completions;
        delete u.quota_snapshots.chat.quota_remaining;
        delete u.quota_snapshots.chat.timestamp_utc;
        delete u.quota_snapshots.chat.percent_remaining;
        delete u.quota_reset_date_utc;
        u.access_type_sku = "Free Limited!";
      }),
      READ_AT,
    );
    expect(report).toMatchObject({
      status: "ok",
      observed_at: READ_AT.toISOString(),
      sku: null,
      reset_at: { at: "2026-11-01T00:00:00.000Z", source: "provider_reported" },
      quotas: [{ id: "chat", remaining: 27, used: 173, percent_remaining: null }],
    });
  });

  it("no quota_snapshots, or none known, is no_quota", () => {
    expect(
      parseCopilotQuota(
        fixtureWith((u) => delete u.quota_snapshots),
        READ_AT,
      ),
    ).toEqual(unavailable("no_quota"));
    expect(
      parseCopilotQuota(
        fixtureWith((u) => (u.quota_snapshots = { other: {} })),
        READ_AT,
      ),
    ).toEqual(unavailable("no_quota"));
  });

  it("garbage and malformed snapshots are unparseable", () => {
    for (const bad of ["", "not json", "[]", "null", '"x"', '{"quota_snapshots": []}']) {
      expect(parseCopilotQuota(bad, READ_AT)).toEqual(unavailable("unparseable"));
    }
    const malformed = [
      (u: Json) => (u.quota_snapshots.chat.entitlement = "200"),
      (u: Json) => (u.quota_snapshots.chat.unlimited = "no"),
      (u: Json) => delete u.quota_snapshots.chat.unlimited,
      (u: Json) => delete u.quota_snapshots.chat.entitlement,
      (u: Json) => (u.quota_snapshots.chat.overage_count = -1),
      (u: Json) => {
        delete u.quota_snapshots.chat.quota_remaining;
        delete u.quota_snapshots.chat.remaining;
      },
      (u: Json) => (u.quota_snapshots.chat = "x"),
    ];
    for (const m of malformed) expect(parseCopilotQuota(fixtureWith(m), READ_AT)).toEqual(unavailable("unparseable"));
    // JSON cannot carry Infinity; a huge literal parses to it and is refused.
    expect(parseCopilotQuota(FIXTURE.replace('"entitlement": 200', '"entitlement": 1e999'), READ_AT)).toEqual(
      unavailable("unparseable"),
    );
  });
});

describe("createCopilotQuotaReader (ADR-0081)", () => {
  type Call = { binary: string; argv: readonly string[]; env: Record<string, string>; timeoutMs: number };

  function fakeRunner(result: GhRunResult | (() => Promise<GhRunResult>)) {
    const calls: Call[] = [];
    const runner: GhRunner = (binary, argv, { env, timeoutMs }) => {
      calls.push({ binary, argv, env, timeoutMs });
      return typeof result === "function" ? result() : Promise.resolve(result);
    };
    return { runner, calls };
  }

  it("runs exactly `gh api /copilot_internal/user` with the allowlisted environment", async () => {
    const { runner, calls } = fakeRunner({ exitCode: 0, stdout: FIXTURE });
    const sourceEnv = { PATH: "/usr/bin", HOME: "/home/op", GH_TOKEN: "t", SECRET_THING: "s" };
    const read = createCopilotQuotaReader({ runner, binary: "/opt/gh", sourceEnv, now: () => READ_AT });
    expect(await read()).toEqual(EXPECTED);
    expect(calls).toEqual([
      { binary: "/opt/gh", argv: ["api", "/copilot_internal/user"], env: ghEnv(sourceEnv), timeoutMs: 10_000 },
    ]);
    expect(calls[0]?.env).not.toHaveProperty("SECRET_THING");
  });

  it("maps every gh failure to a fixed reason and never throws", async () => {
    const cases: [GhRunResult | (() => Promise<GhRunResult>), string][] = [
      [{ exitCode: null, stdout: "", notFound: true }, "gh_missing"],
      [{ exitCode: 4, stdout: "" }, "auth_required"],
      [{ exitCode: null, stdout: "", timedOut: true }, "timeout"],
      [{ exitCode: 1, stdout: '{"message":"Not Found"}' }, "gh_failed"],
      [() => Promise.reject(new Error("boom with secret text")), "gh_failed"],
      [{ exitCode: 0, stdout: "<html>" }, "unparseable"],
    ];
    for (const [result, reason] of cases) {
      const { runner } = fakeRunner(result);
      const report = await createCopilotQuotaReader({ runner, now: () => READ_AT })();
      expect(report).toEqual(unavailable(reason));
      expect(JSON.stringify(report)).not.toMatch(/Not Found|boom|html/);
    }
  });

  it("caches ok and unavailable reports for the TTL, then reads again", async () => {
    let t = READ_AT.getTime();
    const now = () => new Date(t);
    const { runner, calls } = fakeRunner({ exitCode: 4, stdout: "" });
    const read = createCopilotQuotaReader({ runner, now, ttlMs: 1000 });
    expect((await read()).status).toBe("unavailable");
    t += 999;
    await read();
    expect(calls).toHaveLength(1);
    t += 1;
    await read();
    expect(calls).toHaveLength(2);

    const ok = fakeRunner({ exitCode: 0, stdout: FIXTURE });
    const readOk = createCopilotQuotaReader({ runner: ok.runner, now });
    await readOk();
    t += 59_999;
    expect(await readOk()).toEqual(EXPECTED);
    expect(ok.calls).toHaveLength(1);
    t += 1;
    await readOk();
    expect(ok.calls).toHaveLength(2);
  });

  it("concurrent callers share one gh call", async () => {
    let release: (r: GhRunResult) => void = () => undefined;
    const { runner, calls } = fakeRunner(
      () =>
        new Promise<GhRunResult>((resolve) => {
          release = resolve;
        }),
    );
    const read = createCopilotQuotaReader({ runner, now: () => READ_AT });
    const a = read();
    const b = read();
    release({ exitCode: 0, stdout: FIXTURE });
    expect(await a).toEqual(EXPECTED);
    expect(await b).toBe(await a);
    expect(calls).toHaveLength(1);
  });
});
