import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../adapters/claude/adapter.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { ProbeOutput, ProbeResult, ProbeRunner } from "../adapters/types.js";
import { loadConfig } from "../config/index.js";
import { type CollectDeps, type EligibilityRequest, evaluateEligibility } from "../routing/index.js";
import { ModelRegistry } from "./index.js";

// T4.5 (FR-ADP-05, LLD §2.1). All model values here are synthetic placeholders; no provider is run.

const CLAUDE = "/opt/synthetic/bin/claude"; // never executed
const HELP =
  "-p, --print\n--output-format stream-json\n--permission-mode dontAsk\n--permission-prompts\n--tools\n--allowedTools\n--disallowedTools\n--safe-mode\n--restricted\n--strict-mcp-config\n--resume\n";
const table: Record<string, Partial<ProbeOutput>> = {
  [`${CLAUDE} --version`]: { stdout: "2.1.296 (Claude Code)\n" },
  [`${CLAUDE} --help`]: { stdout: HELP },
  [`${CLAUDE} auth status --json`]: { stdout: '{"loggedIn":true}' },
};
const runner: ProbeRunner = async (argv) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...table[argv.join(" ")],
});

/** The real Claude adapter whose probe also reports a listing, standing in for a provider listing command. */
class ListingClaude extends ClaudeAdapter {
  listed: string[] | undefined;
  constructor() {
    super({ binaryPath: CLAUDE });
  }
  override async probe(r: ProbeRunner): Promise<ProbeResult> {
    const p = await super.probe(r);
    return this.listed === undefined ? p : { ...p, modelsListed: [...this.listed] };
  }
}

const adapter = new ListingClaude();
const gate: CollectDeps["gate"] = (id) => ({
  eligible: true,
  evidence: { provider: id, observedVersion: "x", validatedRange: "x", validatedCliVersion: "x" },
});
const ask = (models: ModelRegistry | undefined, model: string | undefined) => {
  const req: EligibilityRequest = {
    candidates: ["claude"],
    trustProfile: "edit-untrusted",
    clientMaxProfile: "edit-untrusted",
    profile: {
      name: "edit-untrusted",
      fileAccess: "worktree",
      shell: "none",
      network: "off",
      repoConfig: "disabled",
      bypassApproved: false,
    },
    requirements: { network: "off", writable: true, ...(model !== undefined ? { model } : {}) },
    cwd: "/tmp/synthetic-worktree",
  };
  return evaluateEligibility(req, {
    registry: new AdapterRegistry().register(adapter),
    runner,
    platform: "linux",
    gate,
    ...(models ? { models } : {}),
  });
};

describe("ModelRegistry (T4.5)", () => {
  it("is unrestricted without data and passes a model through (backward compatible default)", () => {
    const r = new ModelRegistry();
    expect(r.resolve("claude", "anything-1")).toEqual({ ok: true, model: "anything-1", source: "unrestricted" });
    expect(new ModelRegistry(new Map([["claude", { context_limits: { "m-a": 10 } }]])).restricted("claude")).toBe(
      false,
    );
  });

  it("resolves configured ids, aliases and listed ids, and refuses the rest with a reason", () => {
    const r = new ModelRegistry(new Map([["claude", { ids: ["m-a"], aliases: { fast: "m-b" } }]]));
    expect(r.resolve("claude", "m-a")).toMatchObject({ ok: true, model: "m-a", source: "config" });
    expect(r.resolve("claude", "fast")).toMatchObject({ ok: true, model: "m-b", source: "alias" });
    const no = r.resolve("claude", "m-z");
    expect(no.ok).toBe(false);
    expect(JSON.stringify(no)).toContain("not in the claude model registry");
    r.refresh("claude", ["m-z", "bad id"]);
    expect(r.resolve("claude", "m-z")).toMatchObject({ ok: true, source: "listing" });
    expect(r.known("claude").sort()).toEqual(["m-a", "m-b", "m-z"]);
  });

  it("refresh replaces the listing, keeps it on undefined and clears it on an empty array", () => {
    const r = new ModelRegistry();
    r.refresh("p", ["a1"]);
    r.refresh("p", undefined);
    expect(r.known("p")).toEqual(["a1"]);
    r.refresh("p", ["b1"]);
    expect(r.known("p")).toEqual(["b1"]);
    r.refresh("p", []);
    expect(r.restricted("p")).toBe(false);
  });

  it("returns an operator-stated context limit and none otherwise", () => {
    const r = new ModelRegistry(new Map([["p", { ids: ["m-a"], context_limits: { "m-a": 1234 } }]]));
    expect(r.contextLimit("p", "m-a")).toBe(1234);
    expect(r.contextLimit("p", "m-b")).toBeUndefined();
    expect(r.contextLimit("p", "__proto__")).toBeUndefined();
  });

  it("returns operator-stated capability and models meeting capability floor (T7.8)", () => {
    const r = new ModelRegistry(
      new Map([
        [
          "p",
          {
            ids: ["m-low", "m-med", "m-high"],
            aliases: { fast: "m-low", smart: "m-high" },
            capabilities: { "m-low": "low", "m-med": "medium", "m-high": "high" },
          },
        ],
      ]),
    );
    expect(r.capability("p", "m-low")).toBe("low");
    expect(r.capability("p", "m-med")).toBe("medium");
    expect(r.capability("p", "m-high")).toBe("high");
    // Alias lookup
    expect(r.capability("p", "fast")).toBe("low");
    expect(r.capability("p", "smart")).toBe("high");
    expect(r.capability("p", "unknown")).toBeUndefined();

    // Floor filtering
    expect(r.modelsMeetingCapability("p", "high")).toEqual(["m-high"]);
    expect(r.modelsMeetingCapability("p", "medium")).toEqual(["m-med", "m-high"]);
    expect(r.modelsMeetingCapability("p", "low")).toEqual(["m-low", "m-med", "m-high"]);
    expect(r.modelsMeetingCapability("unknown-p", "low")).toEqual([]);
  });
});

describe("eligibility with the model registry (T4.5)", () => {
  it("a model the registry does not hold is Ineligible: CAPABILITY_MISSING with a reason", async () => {
    adapter.listed = undefined;
    const d = await ask(new ModelRegistry(new Map([["claude", { ids: ["m-a"] }]])), "m-z");
    expect(d.eligible).toEqual([]);
    const ex = d.excluded[0];
    expect(ex?.primary.code).toBe("CAPABILITY_MISSING");
    expect(ex?.primary.detail).toMatch(/"m-z" is not in the claude model registry/);
  });

  it("a held model, an alias and an unrestricted provider stay eligible", async () => {
    adapter.listed = undefined;
    const models = new ModelRegistry(new Map([["claude", { ids: ["m-a"], aliases: { fast: "m-b" } }]]));
    expect((await ask(models, "m-a")).eligible).toEqual(["claude"]);
    expect((await ask(models, "fast")).eligible).toEqual(["claude"]);
    expect((await ask(new ModelRegistry(), "whatever-1")).eligible).toEqual(["claude"]);
    expect((await ask(undefined, "whatever-1")).eligible).toEqual(["claude"]);
    expect((await ask(models, undefined)).eligible).toEqual(["claude"]);
  });

  it("a listing refresh changes the registry with no code change", async () => {
    const models = new ModelRegistry();
    adapter.listed = ["m-a"];
    expect((await ask(models, "m-b")).excluded[0]?.primary.code).toBe("CAPABILITY_MISSING");
    expect((await ask(models, "m-a")).eligible).toEqual(["claude"]);
    adapter.listed = ["m-b"]; // the provider's listing changed
    expect((await ask(models, "m-b")).eligible).toEqual(["claude"]);
    expect((await ask(models, "m-a")).excluded[0]?.primary.code).toBe("CAPABILITY_MISSING");
    adapter.listed = undefined;
  });
});

describe("providers.<id>.models config (T4.5)", () => {
  it("is validated strictly", () => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-models-")));
    try {
      const run = (models: unknown) => {
        const p = path.join(tmp, "config.json");
        writeFileSync(
          p,
          JSON.stringify({
            schema_version: 1,
            allowed_roots: [tmp],
            mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
            providers: { "claude-code": { models } },
          }),
        );
        return loadConfig({ configPath: p });
      };
      const ok = run({
        ids: ["m-a"],
        aliases: { fast: "m-a" },
        context_limits: { "m-a": 5000 },
        capabilities: { "m-a": "high" },
      });
      expect(ok.providerModels.get("claude-code")).toEqual({
        ids: ["m-a"],
        aliases: { fast: "m-a" },
        context_limits: { "m-a": 5000 },
        capabilities: { "m-a": "high" },
      });
      expect(() => run({ ids: ["bad id"] })).toThrow();
      expect(() => run({ context_limits: { "m-a": 0 } })).toThrow();
      expect(() => run({ capabilities: { "m-a": "ultra" } })).toThrow();
      expect(() => run({ capabilities: { "bad id": "high" } })).toThrow();
      expect(() => run({ extra: true })).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- model-literal ban (FR-ADP-05; TDD §4.9 item 13) -------------------------------------------------------------------

/** Provider and model-family words that, followed by a version digit or a tier word, read as a model name. */
const FAMILY =
  "claude|gpt|chatgpt|gemini|gemma|grok|kimi|moonshot|sonnet|opus|haiku|composer|llama|mistral|deepseek|qwen|muse|o[134]";
const MODEL_LIKE = new RegExp(
  `\\b(?:${FAMILY})[-_. ]?(?:mini|pro|flash|nano|max|ultra|lite|turbo|preview|latest|[0-9])`,
  "i",
);
/** A context-window-sized number or a 128k/1m style size. */
const LIMIT_LIKE = /\b(?:1_?000_?000|2_?00_?000|128_?000|256_?000|32_?768|65_?536|131_?072|\d{2,4}[kK])\b/;

function adapterSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "fixtures") out.push(...adapterSourceFiles(full));
    } else if (/\.(ts|json)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

function modelLiteralHits(text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    const m = MODEL_LIKE.exec(line) ?? LIMIT_LIKE.exec(line);
    if (m) hits.push(`${i + 1}: ${m[0]}`);
  });
  return hits;
}

describe("no model name or context limit in adapter source (FR-ADP-05, T4.5)", () => {
  it("the detector recognises model-like names and limits", () => {
    expect(modelLiteralHits('const m = "family-sonnet-4";')).not.toEqual([]);
    expect(modelLiteralHits('const m = "gpt-5";')).not.toEqual([]);
    expect(modelLiteralHits("const ctx = 200000;")).not.toEqual([]);
    expect(modelLiteralHits("const ctx = 128k;")).not.toEqual([]);
    expect(modelLiteralHits('const id = "claude-code"; const c = "codex-cli";')).toEqual([]);
  });

  it("finds none in src/adapters (code, comments and manifests; recorded fixtures and tests excluded)", () => {
    const root = path.resolve(import.meta.dirname, "..", "adapters");
    const found = adapterSourceFiles(root).flatMap((f) =>
      modelLiteralHits(readFileSync(f, "utf8")).map((h) => `${path.relative(root, f)}:${h}`),
    );
    expect(found).toEqual([]);
  });
});
