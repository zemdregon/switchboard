/**
 * T7.13 and T6.13 follow-up (mcp-test-results 20261017T204625Z G5, note 2): the test-only fake adapter id may be named in
 * `model_groups.<g>.members[].provider` and `capacity.subscriptions.<s>.providers[]` only when that adapter is
 * registered (`serve`'s test-only switch, passed to `loadConfig` as `testFakeAdapter`). Without it every message is
 * byte-identical to before, and no other part of the schema (`providers`, `allowed_providers`) learns `fake`.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configProviderIds } from "../adapters/providers.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { defaultAdapters, renderDoctor, resolveGroupMemberForDoctor, runDoctor } from "../cli/doctor.js";
import type { CliIo } from "../cli/io.js";
import { TEST_FAKE_ADAPTER_ENV, TEST_FAKE_ADAPTER_VALUE } from "../cli/serve.js";
import { ModelRegistry } from "../models/registry.js";
import { checkCapacity } from "./capacity.js";
import { ConfigError } from "./errors.js";
import { loadConfig } from "./load.js";
import { configSchema, currentConfigSchema, memberProviderIds } from "./schema.js";

const GROUP = { "dev-fake": { members: [{ provider: "fake", model: "fake-model-1" }] } };
const SUBSCRIPTION = {
  subscriptions: {
    "dev-fake-sub": { providers: ["fake"], windows: [{ id: "h1", length_seconds: 3600, reset: { kind: "rolling" } }] },
  },
  pacing: { mode: "score" },
};
const BUILTIN_ENUM = "claude-code, codex, grok-build, antigravity, cursor, opencode, kimi-code, muse-code";

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-fake-groups-")));
  configPath = path.join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(extra: Record<string, unknown>): string {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: path.join(dir, "data"),
      allowed_roots: [dir],
      mcp_clients: [{ id: "c", max_trust_profile: "edit-untrusted" }],
      ...extra,
    }),
  );
  return configPath;
}

function messageOf(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("fake in model_groups and capacity.subscriptions only with the test-only adapter (T7.13, T6.13)", () => {
  it("without the test-only adapter the messages are byte-identical to before", () => {
    write({ model_groups: GROUP });
    const groupMessage =
      `Invalid config file ${configPath}:\n` +
      `  $.model_groups.dev-fake.members[0].provider: must be one of ${BUILTIN_ENUM}`;
    expect(messageOf(() => loadConfig({ configPath }))).toBe(groupMessage);
    expect(messageOf(() => loadConfig({ configPath, testFakeAdapter: false }))).toBe(groupMessage);

    write({ capacity: SUBSCRIPTION });
    const subMessage = `Invalid config:\n  $.capacity.subscriptions.dev-fake-sub.providers[0]: "fake" is not a configured provider id`;
    expect(messageOf(() => loadConfig({ configPath }))).toBe(subMessage);
    expect(messageOf(() => loadConfig({ configPath, testFakeAdapter: false }))).toBe(subMessage);

    // The schema and the id list are the very objects used before.
    expect(currentConfigSchema().schema).toBe(configSchema);
    expect(currentConfigSchema({ testFakeAdapter: false }).schema).toBe(configSchema);
    expect(memberProviderIds(false)).toEqual(configProviderIds());
    expect(checkCapacity(SUBSCRIPTION as never)).toEqual(
      checkCapacity(SUBSCRIPTION as never, memberProviderIds(false)),
    );
  });

  it("with it, a fake member and a subscription over fake load and resolve to the fake adapter id", () => {
    write({ model_groups: GROUP, capacity: SUBSCRIPTION });
    const cfg = loadConfig({ configPath, testFakeAdapter: true });
    expect(cfg.modelGroups).toEqual({ "dev-fake": { members: [{ provider: "fake", model: "fake-model-1" }] } });
    expect(cfg.capacity.subscriptions).toEqual([
      expect.objectContaining({ name: "dev-fake-sub", providers: ["fake"], adapterIds: ["fake"] }),
    ]);
    expect(cfg.capacity.pacing?.mode).toBe("score");
    expect(memberProviderIds(true)).toEqual([...configProviderIds(), "fake"]);
  });

  it("with it, only fake is added: unknown names, providers.fake and allowed_providers fake are still refused", () => {
    // ADR-0076: an adapter id is an accepted spelling and loads as the config id; an unknown name is still refused.
    write({ model_groups: { g: { members: [{ provider: "grok", model: "m" }] } } });
    expect(loadConfig({ configPath, testFakeAdapter: true }).modelGroups).toEqual({
      g: { members: [{ provider: "grok-build", model: "m" }] },
    });
    write({ model_groups: { g: { members: [{ provider: "nope", model: "m" }] } } });
    expect(messageOf(() => loadConfig({ configPath, testFakeAdapter: true }))).toBe(
      `Invalid config file ${configPath}:\n  $.model_groups.g.members[0].provider: must be one of ${BUILTIN_ENUM}, fake`,
    );
    write({
      capacity: { subscriptions: { s: { ...SUBSCRIPTION.subscriptions["dev-fake-sub"], providers: ["nope"] } } },
    });
    expect(messageOf(() => loadConfig({ configPath, testFakeAdapter: true }))).toBe(
      `Invalid config:\n  $.capacity.subscriptions.s.providers[0]: "nope" is not a configured provider id`,
    );
    write({ providers: { fake: { enabled: true } } });
    expect(messageOf(() => loadConfig({ configPath, testFakeAdapter: true }))).toMatch(/providers/);
    write({
      projects: [
        {
          id: "p",
          name: "P",
          allowed_providers: ["fake"],
          contexts: [{ id: "main", kind: "repository", path: dir, base_ref: "main" }],
        },
      ],
    });
    expect(messageOf(() => loadConfig({ configPath, testFakeAdapter: true }))).toMatch(/allowed_providers/);
  });
});

describe("doctor reads the same config serve would (T7.13 doctor model-group lines)", () => {
  function io(env: Record<string, string>): { io: CliIo; out: () => string } {
    const out: string[] = [];
    return {
      io: {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => undefined },
        env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
        user: "tester",
        adapters: new AdapterRegistry(),
      } as CliIo,
      out: () => out.join(""),
    };
  }

  it("refuses the fake group without the switch and lists it with the switch", async () => {
    write({ model_groups: GROUP });
    const off = await runDoctor(io({}).io, ["--config", configPath]);
    expect(off.checks.find((c) => c.id === "config")?.status).toBe("fail");
    const on = await runDoctor(io({ [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE }).io, ["--config", configPath]);
    expect(on.checks.find((c) => c.id === "config")?.status).toBe("ok");
    expect(on.model_groups?.[0]?.members.map((m) => `${m.provider}/${m.model}`)).toEqual(["fake/fake-model-1"]);
    expect(renderDoctor(on)).toContain("fake/fake-model-1:");
  });

  it("a fake member is looked up under its own id, so a registered fake is not ADAPTER_NOT_REGISTERED", () => {
    write({ model_groups: GROUP });
    const cfg = loadConfig({ configPath, testFakeAdapter: true });
    const models = new ModelRegistry();
    const member = { provider: "fake", model: "fake-model-1" };
    expect(resolveGroupMemberForDoctor(member, cfg, defaultAdapters(), models).code).not.toBe("ADAPTER_NOT_REGISTERED");
    expect(resolveGroupMemberForDoctor(member, cfg, new AdapterRegistry(), models).code).toBe("ADAPTER_NOT_REGISTERED");
  });

  it("a config-id member (grok-build) is looked up as adapter grok and disabled by providers.grok-build", () => {
    const member = { provider: "grok-build", model: "grok-mini" };
    const models = new ModelRegistry();
    write({ model_groups: { g: { members: [member] } } });
    const on = loadConfig({ configPath });
    expect(resolveGroupMemberForDoctor(member, on, defaultAdapters(), models).code).not.toBe("ADAPTER_NOT_REGISTERED");
    write({ model_groups: { g: { members: [member] } }, providers: { "grok-build": { enabled: false } } });
    const off = loadConfig({ configPath });
    expect(resolveGroupMemberForDoctor(member, off, defaultAdapters(), models).code).toBe("PROVIDER_DISABLED");
  });
});
