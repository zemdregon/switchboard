/**
 * ADR-0076: a config file accepts either spelling of a provider name (`claude` or `claude-code`) wherever it names a
 * provider; the loaded config holds the config spelling, existing configs load unchanged, two keys naming one
 * provider are refused, and an alias can never re-enable or bypass a disabled provider.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderId } from "../adapters/index.js";
import { enablement } from "../cli/serve.js";
import { isProviderEnabled } from "../routing/collect.js";
import { ConfigError } from "./errors.js";
import { loadConfig } from "./load.js";
import { normaliseConfigProviderNames } from "./provider-names.js";
import type { SwitchboardConfig } from "./schema.js";

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-provider-names-")));
  configPath = path.join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(extra: Record<string, unknown>): void {
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
}
const project = (allowed: string[]) => ({
  id: "pp",
  name: "P",
  allowed_providers: allowed,
  contexts: [{ id: "main", kind: "repository", path: dir, base_ref: "main" }],
});
const FAKE_OFF = { enabled: false };

describe("config provider names (ADR-0076)", () => {
  it("an alias key loads as the config spelling, with its settings, and the config spelling still loads unchanged", () => {
    write({ providers: { claude: { enabled: false, git_channel: true }, grok: { weight: 0.5 } } });
    const cfg = loadConfig({ configPath });
    expect([...cfg.providers.keys()].sort()).toEqual(["claude-code", "grok-build"]);
    expect(cfg.providers.get("claude-code")?.enabled).toBe(false);
    expect(cfg.providers.get("grok-build")?.weight).toBe(0.5);

    write({ providers: { "claude-code": { enabled: false } } });
    expect(loadConfig({ configPath }).providers.get("claude-code")?.enabled).toBe(false);
  });

  it("two keys naming one provider are a config error (fail closed)", () => {
    write({ providers: { claude: { enabled: true }, "claude-code": { enabled: false } } });
    expect(() => loadConfig({ configPath })).toThrow(ConfigError);
    expect(() => loadConfig({ configPath })).toThrow(
      /\$\.providers\.claude-code: names the same provider as \$\.providers\.claude/,
    );
  });

  it("allowed_providers takes either spelling and de-duplicates after normalising", () => {
    write({ projects: [project(["claude", "claude-code", "codex", "kimi"])] });
    expect(loadConfig({ configPath }).projects[0]?.allowedProviders).toEqual(["claude-code", "codex", "kimi-code"]);
    write({ projects: [project(["nope"])] });
    expect(() => loadConfig({ configPath })).toThrow(/allowed_providers/);
  });

  it("model_groups members, capacity subscriptions and shares_subscription_with take the alias too", () => {
    const { value, problems } = normaliseConfigProviderNames({
      model_groups: { g: { members: [{ provider: "claude", model: "m" }] } },
      capacity: { subscriptions: { s: { providers: ["claude", "claude-code", "fake"] } } },
      inner_agent: { backend: { shares_subscription_with: "grok" } },
    });
    expect(problems).toEqual([]);
    expect(value).toEqual({
      model_groups: { g: { members: [{ provider: "claude-code", model: "m" }] } },
      capacity: { subscriptions: { s: { providers: ["claude-code", "fake"] } } },
      inner_agent: { backend: { shares_subscription_with: "grok-build" } },
    });
  });

  it("an alias of a disabled provider is still disabled, in serve's enablement and in isProviderEnabled", () => {
    write({ providers: { claude: FAKE_OFF } });
    const cfg = loadConfig({ configPath });
    const on = enablement(cfg, { enabled: false });
    expect(on("claude")).toBe(false);
    expect(on("claude-code" as ProviderId)).toBe(false);
    expect(on("codex")).toBe(true);

    // A raw config map in either spelling, asked under either spelling (callers that skip validateConfig).
    for (const key of ["claude", "claude-code"]) {
      const raw = { providers: { [key]: FAKE_OFF } } as unknown as Pick<SwitchboardConfig, "providers">;
      expect(isProviderEnabled(raw, "claude"), key).toBe(false);
      expect(isProviderEnabled(raw, "claude-code" as ProviderId), key).toBe(false);
      expect(isProviderEnabled(raw, "codex"), key).toBe(true);
    }
  });
});
