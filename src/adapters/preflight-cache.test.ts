import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { collectFacts } from "../routing/collect.js";
import { FakeAdapter } from "./fake/adapter.js";
import { PreflightCache } from "./preflight-cache.js";
import { AdapterRegistry } from "./registry.js";
import { createProbeRunner } from "./run.js";
import type { AuthResult, ProbeResult, ProbeRunner, ProviderAdapter } from "./types.js";

const dir = mkdtempSync(join(tmpdir(), "sb-preflight-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const noRunner: ProbeRunner = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

/** Synthetic adapter: counts probe and auth calls; results are settable. Never spawns anything. */
function countingAdapter(binaryPath: string) {
  const state = {
    probes: 0,
    auths: 0,
    probeOk: true,
    probeThrows: false,
    auth: { state: "OK" } as AuthResult,
  };
  const adapter = {
    id: "fake",
    async probe(): Promise<ProbeResult> {
      state.probes += 1;
      if (state.probeThrows) throw new Error("boom");
      return {
        binaryPath,
        binaryVersion: "1.0.0",
        steps: [
          { step: "binary", ok: state.probeOk },
          { step: "version", ok: true },
        ],
      };
    },
    async authPreflight(): Promise<AuthResult> {
      state.auths += 1;
      return state.auth;
    },
  } as unknown as ProviderAdapter;
  return { adapter, state };
}

describe("PreflightCache (NFR-PERF-02, T3.21)", () => {
  let bin: string;
  let t: number;
  const now = () => t;
  let n = 0;
  beforeEach(() => {
    n += 1;
    bin = join(dir, `cli-${n}`);
    writeFileSync(bin, "#!/bin/sh\n");
    t = 1000;
  });

  it("serves a second probe and auth within the TTL without calling the adapter again", async () => {
    const cache = new PreflightCache({ ttlMs: 60_000, now });
    const { adapter, state } = countingAdapter(bin);
    const a = await cache.probe(adapter, noRunner);
    expect(await cache.authPreflight(adapter, noRunner)).toEqual({ state: "OK" });
    t += 30_000;
    const b = await cache.probe(adapter, noRunner);
    expect(await cache.authPreflight(adapter, noRunner)).toEqual({ state: "OK" });
    expect(b).toBe(a);
    expect(state).toMatchObject({ probes: 1, auths: 1 });
  });

  it("re-probes after the TTL expires", async () => {
    const cache = new PreflightCache({ ttlMs: 60_000, now });
    const { adapter, state } = countingAdapter(bin);
    await cache.probe(adapter, noRunner);
    await cache.authPreflight(adapter, noRunner);
    t += 60_000;
    await cache.probe(adapter, noRunner);
    await cache.authPreflight(adapter, noRunner);
    expect(state).toMatchObject({ probes: 2, auths: 2 });
  });

  it("invalidates probe and auth when the binary changes (mtime, then size)", async () => {
    const cache = new PreflightCache({ ttlMs: 60_000, now });
    const { adapter, state } = countingAdapter(bin);
    await cache.probe(adapter, noRunner);
    await cache.authPreflight(adapter, noRunner);
    utimesSync(bin, new Date(1_000_000), new Date(2_000_000)); // an upgrade touches the file
    await cache.probe(adapter, noRunner);
    await cache.authPreflight(adapter, noRunner);
    expect(state).toMatchObject({ probes: 2, auths: 2 });
    writeFileSync(bin, "#!/bin/sh\necho new version\n"); // size changes
    await cache.probe(adapter, noRunner);
    expect(state.probes).toBe(3);
  });

  it("invalidates when the binary disappears and never caches a binary it cannot stat", async () => {
    const cache = new PreflightCache({ ttlMs: 60_000, now });
    const gone = countingAdapter(join(dir, "does-not-exist"));
    await cache.probe(gone.adapter, noRunner);
    await cache.probe(gone.adapter, noRunner);
    expect(gone.state.probes).toBe(2);
    const { adapter, state } = countingAdapter(bin);
    await cache.probe(adapter, noRunner);
    rmSync(bin);
    await cache.probe(adapter, noRunner);
    expect(state.probes).toBe(2);
  });

  it("does not cache a failed or throwing probe", async () => {
    const cache = new PreflightCache({ ttlMs: 60_000, now });
    const { adapter, state } = countingAdapter(bin);
    state.probeOk = false;
    expect((await cache.probe(adapter, noRunner)).steps.some((s) => !s.ok)).toBe(true);
    await cache.probe(adapter, noRunner);
    expect(state.probes).toBe(2);
    state.probeThrows = true;
    await expect(cache.probe(adapter, noRunner)).rejects.toThrow("boom");
    state.probeThrows = false;
    state.probeOk = true; // the user installed or fixed the CLI: seen on the very next call
    expect((await cache.probe(adapter, noRunner)).steps.every((s) => s.ok)).toBe(true);
    expect(state.probes).toBe(4);
  });

  it("does not cache AUTH_REQUIRED or UNKNOWN, so a login is seen on the next call", async () => {
    const cache = new PreflightCache({ ttlMs: 60_000, now });
    const { adapter, state } = countingAdapter(bin);
    await cache.probe(adapter, noRunner);
    state.auth = { state: "AUTH_REQUIRED", loginCommand: "fake login" };
    expect((await cache.authPreflight(adapter, noRunner)).state).toBe("AUTH_REQUIRED");
    expect((await cache.authPreflight(adapter, noRunner)).state).toBe("AUTH_REQUIRED");
    state.auth = { state: "UNKNOWN", reason: "x" };
    expect((await cache.authPreflight(adapter, noRunner)).state).toBe("UNKNOWN");
    state.auth = { state: "OK" };
    expect(await cache.authPreflight(adapter, noRunner)).toEqual({ state: "OK" });
    expect(state.auths).toBe(4);
    await cache.authPreflight(adapter, noRunner);
    expect(state.auths).toBe(4); // success is cached
  });

  it("does not cache auth without a cached probe entry", async () => {
    const cache = new PreflightCache({ ttlMs: 60_000, now });
    const { adapter, state } = countingAdapter(bin);
    await cache.authPreflight(adapter, noRunner);
    await cache.authPreflight(adapter, noRunner);
    expect(state.auths).toBe(2);
  });

  it("ttl 0 disables caching", async () => {
    const cache = new PreflightCache({ ttlMs: 0, now });
    const { adapter, state } = countingAdapter(bin);
    await cache.probe(adapter, noRunner);
    await cache.probe(adapter, noRunner);
    await cache.authPreflight(adapter, noRunner);
    await cache.authPreflight(adapter, noRunner);
    expect(state).toMatchObject({ probes: 2, auths: 2 });
  });

  it("stores only status results: no credential-shaped data in the cached values", async () => {
    const cache = new PreflightCache({ ttlMs: 60_000, now });
    const { adapter } = countingAdapter(bin);
    const probe = await cache.probe(adapter, noRunner);
    const auth = await cache.authPreflight(adapter, noRunner);
    expect(Object.keys(probe).sort()).toEqual(["binaryPath", "binaryVersion", "steps"]);
    expect(auth).toEqual({ state: "OK" });
  });
});

describe("collectFacts with the preflight cache and the fake adapter (no provider CLI)", () => {
  it("does not re-spawn the fake CLI on a second collection, and does after the cache is cleared", async () => {
    const spawns: string[][] = [];
    const inner = createProbeRunner();
    const runner: ProbeRunner = (argv, opts) => {
      spawns.push([...argv]);
      return inner(argv, opts);
    };
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ scenario: "success" }));
    const preflight = new PreflightCache();
    const gate = (id: string, v: string | null) => ({
      eligible: true as const,
      evidence: { provider: id, observedVersion: v, validatedRange: "t", validatedCliVersion: "t" },
    });
    const profile = {
      name: "edit-untrusted",
      fileAccess: "worktree",
      shell: "allowlist",
      shellAllowlist: [],
      network: "off",
      repoConfig: "disabled",
      bypassApproved: false,
    } as never;
    const req = {
      candidates: ["fake"],
      trustProfile: "edit-untrusted",
      clientMaxProfile: "edit-untrusted",
      profile,
      requirements: { network: "off", writable: true },
      cwd: dir,
    } as never;
    const deps = { registry, runner, gate: gate as never, platform: "linux", preflight };
    const first = await collectFacts(req, deps);
    const afterFirst = spawns.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(first.facts[0]?.auth?.state).toBe("OK");
    const second = await collectFacts(req, deps);
    expect(spawns.length).toBe(afterFirst);
    expect(second.facts[0]?.probe).toEqual(first.facts[0]?.probe);
    preflight.clear();
    await collectFacts(req, deps);
    expect(spawns.length).toBe(afterFirst * 2);
  });
});
