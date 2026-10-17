import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../adapters/registry.js";
import { renderDoctor, resolveGroupMemberForDoctor, runDoctor } from "../cli/doctor.js";
import type { CliIo } from "../cli/io.js";
import { ModelRegistry } from "../models/registry.js";
import { SCORE_TERMS } from "../routing/score.js";
import { loadConfig } from "./load.js";
import {
  DEFAULT_PACING_WEIGHT,
  groupMembersFor,
  modelGroupsOf,
  readModelGroupsFromConfigPath,
  resolveModelGroups,
  resolveRouting,
} from "./routing.js";
import {
  MAX_GROUP_MEMBERS,
  MAX_MODEL_GROUPS,
  MODEL_GROUP_NAME_PATTERN,
  type ModelGroupsConfigInput,
} from "./schema.js";

// T7.13 (FR-RTE-10, ADR-0055, LLD §17.7): Model groups configuration and usage pacing weight.

function makeTempConfig(cfg: Record<string, unknown>): {
  dir: string;
  configPath: string;
  cleanup: () => void;
} {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-model-groups-")));
  const configPath = path.join(dir, "config.json");
  const fullConfig: Record<string, unknown> = {
    schema_version: 1,
    allowed_roots: [dir],
    mcp_clients: [{ id: "test-client", max_trust_profile: "edit-untrusted" }],
    ...cfg,
  };
  writeFileSync(configPath, JSON.stringify(fullConfig, null, 2), "utf8");
  return {
    dir,
    configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeIo(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    env: { ...process.env, ...env },
    user: "tester",
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

describe("model_groups configuration schema (FR-RTE-10, LLD §17.7)", () => {
  it("valid groups load successfully", () => {
    const { configPath, cleanup } = makeTempConfig({
      model_groups: {
        group_alpha: {
          members: [
            { provider: "claude-code", model: "model-a" },
            { provider: "codex", model: "model-b" },
          ],
        },
        group_beta: {
          members: [{ provider: "cursor", model: "model-c" }],
        },
      },
    });
    try {
      const loaded = loadConfig({ configPath });
      expect(loaded).toBeDefined();

      const groups = readModelGroupsFromConfigPath(configPath);
      expect(Object.keys(groups)).toEqual(["group_alpha", "group_beta"]);
      expect(groups.group_alpha?.members).toEqual([
        { provider: "claude-code", model: "model-a" },
        { provider: "codex", model: "model-b" },
      ]);
      expect(groups.group_beta?.members).toEqual([{ provider: "cursor", model: "model-c" }]);
    } finally {
      cleanup();
    }
  });

  it("an unknown provider id is refused", () => {
    const { configPath, cleanup } = makeTempConfig({
      model_groups: {
        test_group: {
          members: [{ provider: "unknown-provider-id", model: "model-a" }],
        },
      },
    });
    try {
      expect(() => loadConfig({ configPath })).toThrow(/model_groups.*provider/);
    } finally {
      cleanup();
    }
  });

  it("a duplicate pair in the same group is refused", () => {
    const { configPath, cleanup } = makeTempConfig({
      model_groups: {
        test_group: {
          members: [
            { provider: "codex", model: "model-a" },
            { provider: "codex", model: "model-a" },
          ],
        },
      },
    });
    try {
      expect(() => loadConfig({ configPath })).toThrow(/duplicate/i);
    } finally {
      cleanup();
    }
  });

  it("same model under different providers is accepted", () => {
    const { configPath, cleanup } = makeTempConfig({
      model_groups: {
        test_group: {
          members: [
            { provider: "claude-code", model: "shared-model" },
            { provider: "codex", model: "shared-model" },
          ],
        },
      },
    });
    try {
      const loaded = loadConfig({ configPath });
      expect(loaded).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("an empty group (empty members array) is refused", () => {
    const { configPath, cleanup } = makeTempConfig({
      model_groups: {
        empty_group: {
          members: [],
        },
      },
    });
    try {
      expect(() => loadConfig({ configPath })).toThrow(/fewer than 1 items|minItems/i);
    } finally {
      cleanup();
    }
  });

  it("a malformed group name is refused", () => {
    const badNames = [
      "", // empty
      "UpperCase", // uppercase forbidden
      "1start_with_digit", // must start with [a-z]
      "-start_with_dash", // must start with [a-z]
      "_start_with_underscore", // must start with [a-z]
      "has space", // spaces forbidden
      "has.dot", // dots forbidden in group name
      "a".repeat(33), // max 32 chars
    ];
    for (const bad of badNames) {
      const { configPath, cleanup } = makeTempConfig({
        model_groups: {
          [bad]: {
            members: [{ provider: "codex", model: "model-a" }],
          },
        },
      });
      try {
        expect(() => loadConfig({ configPath })).toThrow();
      } finally {
        cleanup();
      }
    }
  });

  it("a malformed model is refused", () => {
    const badModels = [
      "", // empty
      "-starts-with-dash", // must start with [A-Za-z0-9]
      ".starts-with-dot", // must start with [A-Za-z0-9]
      "model with spaces", // spaces forbidden
      "m".repeat(129), // max 128 chars
    ];
    for (const bad of badModels) {
      const { configPath, cleanup } = makeTempConfig({
        model_groups: {
          test_group: {
            members: [{ provider: "codex", model: bad }],
          },
        },
      });
      try {
        expect(() => loadConfig({ configPath })).toThrow();
      } finally {
        cleanup();
      }
    }
  });

  it("unknown keys are refused", () => {
    // Unknown key at group level
    const { configPath: path1, cleanup: clean1 } = makeTempConfig({
      model_groups: {
        test_group: {
          members: [{ provider: "codex", model: "model-a" }],
          extra_key: "forbidden",
        },
      },
    });
    try {
      expect(() => loadConfig({ configPath: path1 })).toThrow();
    } finally {
      clean1();
    }

    // Unknown key at member level
    const { configPath: path2, cleanup: clean2 } = makeTempConfig({
      model_groups: {
        test_group: {
          members: [{ provider: "codex", model: "model-a", extra_key: true }],
        },
      },
    });
    try {
      expect(() => loadConfig({ configPath: path2 })).toThrow();
    } finally {
      clean2();
    }
  });

  it("enforces group and member count bounds", () => {
    expect(MAX_MODEL_GROUPS).toBe(32);
    expect(MAX_GROUP_MEMBERS).toBe(32);
    expect(new RegExp(MODEL_GROUP_NAME_PATTERN).test("valid_name-1")).toBe(true);
    expect(new RegExp(MODEL_GROUP_NAME_PATTERN).test("1invalid")).toBe(false);

    // Exceeding 32 members in a group is refused
    const tooManyMembers = Array.from({ length: 33 }, (_, i) => ({
      provider: "codex",
      model: `model-${i}`,
    }));
    const { configPath, cleanup } = makeTempConfig({
      model_groups: {
        overflow_group: { members: tooManyMembers },
      },
    });
    try {
      expect(() => loadConfig({ configPath })).toThrow(/more than 32 items|maxItems/i);
    } finally {
      cleanup();
    }
  });
});

describe("routing.weights.pacing configuration (T7.13, LLD §17.7)", () => {
  it("accepts valid pacing weights in [0, 100]", () => {
    for (const val of [0, 1, 5, 50, 100, 2.5]) {
      const { configPath, cleanup } = makeTempConfig({
        routing: { weights: { pacing: val } },
      });
      try {
        const loaded = loadConfig({ configPath });
        expect(loaded.routing.weights.pacing).toBe(val);
      } finally {
        cleanup();
      }
    }
  });

  it("refuses out-of-range or malformed pacing weights", () => {
    for (const bad of [-1, 101, -0.1, "1" as unknown as number, null as unknown as number]) {
      const { configPath, cleanup } = makeTempConfig({
        routing: { weights: { pacing: bad } },
      });
      try {
        expect(() => loadConfig({ configPath })).toThrow(/routing\.weights\.pacing/);
      } finally {
        cleanup();
      }
    }
  });

  it("defaults pacing weight to 1 per LLD §17.7 when unconfigured", () => {
    expect(DEFAULT_PACING_WEIGHT).toBe(1);
    const resolved = resolveRouting(undefined);
    expect(resolved.weights.pacing ?? DEFAULT_PACING_WEIGHT).toBe(1);
    expect(resolved.weights.pacing).toBeUndefined();

    const { configPath, cleanup } = makeTempConfig({});
    try {
      const loaded = loadConfig({ configPath });
      expect(loaded.routing.weights.pacing ?? DEFAULT_PACING_WEIGHT).toBe(1);
      expect(loaded.routing.weights.pacing).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("refuses unknown keys in routing.weights", () => {
    const { configPath, cleanup } = makeTempConfig({
      routing: { weights: { unknown_term: 1 } },
    });
    try {
      expect(() => loadConfig({ configPath })).toThrow(/routing\.weights/);
    } finally {
      cleanup();
    }
  });
});

describe("doctor model groups reporting (T7.13)", () => {
  it("an unresolvable member is accepted by configuration and shown by doctor with its code", async () => {
    const { configPath, cleanup } = makeTempConfig({
      providers: {
        "claude-code": {
          models: {
            ids: ["placeholder-model-1"],
          },
        },
      },
      model_groups: {
        group_unresolvable: {
          members: [{ provider: "claude-code", model: "unresolvable-model-id" }],
        },
      },
    });
    try {
      // 1. Accepted by configuration
      const loaded = loadConfig({ configPath });
      expect(loaded).toBeDefined();

      // 2. Shown by doctor with its code (CAPABILITY_MISSING)
      const { io } = makeIo({ SWITCHBOARD_CONFIG: configPath });
      const rep = await runDoctor(io, ["--config", configPath]);
      expect(rep.model_groups).toBeDefined();
      expect(rep.model_groups?.length).toBe(1);
      const grp = rep.model_groups?.[0];
      expect(grp?.name).toBe("group_unresolvable");
      expect(grp?.members.length).toBe(1);
      expect(grp?.members[0]?.code).toBe("CAPABILITY_MISSING");
      expect(grp?.members[0]?.status).toBe("unresolvable");

      const rendered = renderDoctor(rep);
      expect(rendered).toContain("Model groups:");
      expect(rendered).toContain("group_unresolvable:");
      expect(rendered).toContain("claude-code/unresolvable-model-id: CAPABILITY_MISSING");
    } finally {
      cleanup();
    }
  });

  it("lists each group with each member's current resolution (resolved id, alias, or stage-1 code)", async () => {
    const { configPath, cleanup } = makeTempConfig({
      providers: {
        "claude-code": {
          models: {
            ids: ["direct-placeholder"],
            aliases: { "fast-alias": "direct-placeholder" },
          },
        },
        codex: {
          // Codex refuses models (reportedModelFlag not_accepted)
          enabled: true,
        },
      },
      model_groups: {
        test_group: {
          members: [
            { provider: "claude-code", model: "direct-placeholder" },
            { provider: "claude-code", model: "fast-alias" },
            { provider: "claude-code", model: "unresolvable-placeholder" },
            { provider: "codex", model: "any-model" },
          ],
        },
      },
    });
    try {
      const { io } = makeIo({ SWITCHBOARD_CONFIG: configPath });
      const rep = await runDoctor(io, ["--config", configPath]);
      expect(rep.model_groups).toBeDefined();
      const members = rep.model_groups?.[0]?.members ?? [];
      expect(members.length).toBe(4);

      // Member 1: resolved id
      expect(members[0]).toMatchObject({
        provider: "claude-code",
        model: "direct-placeholder",
        status: "resolved",
        resolved_id: "direct-placeholder",
        code: null,
      });

      // Member 2: alias
      expect(members[1]).toMatchObject({
        provider: "claude-code",
        model: "fast-alias",
        status: "alias",
        resolved_id: "direct-placeholder",
        alias: "fast-alias",
        code: null,
      });

      // Member 3: unresolvable in registry -> CAPABILITY_MISSING
      expect(members[2]).toMatchObject({
        provider: "claude-code",
        model: "unresolvable-placeholder",
        status: "unresolvable",
        code: "CAPABILITY_MISSING",
      });

      // Member 4: adapter rejects model -> CAPABILITY_MISSING
      expect(members[3]).toMatchObject({
        provider: "codex",
        model: "any-model",
        status: "unresolvable",
        code: "CAPABILITY_MISSING",
      });

      // Text render check
      const rendered = renderDoctor(rep);
      expect(rendered).toContain("claude-code/direct-placeholder: direct-placeholder");
      expect(rendered).toContain("claude-code/fast-alias: alias -> direct-placeholder");
      expect(rendered).toContain("claude-code/unresolvable-placeholder: CAPABILITY_MISSING");
      expect(rendered).toContain("codex/any-model: CAPABILITY_MISSING");
    } finally {
      cleanup();
    }
  });

  it("resolveGroupMemberForDoctor reports PROVIDER_DISABLED when provider is disabled", () => {
    const { configPath, cleanup } = makeTempConfig({
      providers: {
        cursor: { enabled: false },
      },
    });
    try {
      const loaded = loadConfig({ configPath });
      const adapters = new AdapterRegistry();
      const models = new ModelRegistry();
      const result = resolveGroupMemberForDoctor({ provider: "cursor", model: "model-1" }, loaded, adapters, models);
      expect(result.status).toBe("unresolvable");
      expect(result.code).toBe("PROVIDER_DISABLED");
      expect(result.resolution).toBe("PROVIDER_DISABLED");
    } finally {
      cleanup();
    }
  });
});

describe("byte-identical behaviour when model_groups is not configured", () => {
  it("doctor report and rendered output omit model_groups when not configured", async () => {
    const { configPath, cleanup } = makeTempConfig({});
    try {
      const { io } = makeIo({ SWITCHBOARD_CONFIG: configPath });
      const rep = await runDoctor(io, ["--config", configPath]);
      expect(rep.model_groups).toBeUndefined();

      const rendered = renderDoctor(rep);
      expect(rendered).not.toContain("Model groups:");
    } finally {
      cleanup();
    }
  });

  it("resolveRouting keeps all SCORE_TERMS in exact order, with pacing added when configured", () => {
    const unconfigured = resolveRouting(undefined);
    expect(Object.keys(unconfigured.weights)).toEqual([...SCORE_TERMS]);
    for (const term of SCORE_TERMS) {
      expect(unconfigured.weights[term]).toBe(1);
    }
    expect(unconfigured.weights.pacing).toBeUndefined();

    const configured = resolveRouting({ weights: { pacing: 5 } });
    expect(configured.weights.pacing).toBe(5);
    expect(Object.keys(configured.weights).sort()).toEqual([...SCORE_TERMS, "pacing"].sort());
  });

  it("readModelGroupsFromConfigPath returns empty object when section absent", () => {
    const { configPath, cleanup } = makeTempConfig({});
    try {
      expect(readModelGroupsFromConfigPath(configPath)).toEqual({});
      expect(resolveModelGroups(undefined)).toEqual({});
    } finally {
      cleanup();
    }
  });
});

// ---- Source-scan test: no group, tier or model name in source, defaults or fixtures (FR-RTE-10) ----

describe("source scan test: no group, tier or model name in source, defaults or fixtures (FR-RTE-10)", () => {
  // Provider / model-family words matching real models
  const FAMILY =
    "claude|gpt|chatgpt|gemini|gemma|grok|kimi|moonshot|sonnet|opus|haiku|composer|llama|mistral|deepseek|qwen|muse|o[134]";
  const REAL_MODEL_PATTERN = new RegExp(
    `\\b(?:${FAMILY})[-_. ]?(?:mini|pro|flash|nano|max|ultra|lite|turbo|preview|latest|[0-9])`,
    "i",
  );

  // Group / tier names forbidden in production code and defaults
  const FORBIDDEN_GROUP_TIER_PATTERN = /\b(?:flagship|low[-_]cost|high[-_]tier|mid[-_]tier)\b/i;

  function collectProductionAndFixtureFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        files.push(...collectProductionAndFixtureFiles(full));
      } else if (/\.(ts|json)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
        files.push(full);
      }
    }
    return files;
  }

  function scanText(text: string): string[] {
    const violations: string[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) {
        continue;
      }
      const modelMatch = REAL_MODEL_PATTERN.exec(line);
      if (modelMatch) {
        violations.push(`line ${i + 1}: model name match "${modelMatch[0]}"`);
      }
      const groupMatch = FORBIDDEN_GROUP_TIER_PATTERN.exec(line);
      if (groupMatch) {
        violations.push(`line ${i + 1}: group/tier name match "${groupMatch[0]}"`);
      }
    }
    return violations;
  }

  it("positive controls: scanner detects planted model names, group names and tier names", () => {
    expect(scanText('const m = "claude-3-opus";').length).toBeGreaterThan(0);
    expect(scanText('const m = "gpt-4o";').length).toBeGreaterThan(0);
    expect(scanText('const g = "flagship";').length).toBeGreaterThan(0);
    expect(scanText('const g = "low-cost";').length).toBeGreaterThan(0);
    expect(scanText('const g = "low_cost";').length).toBeGreaterThan(0);
    expect(scanText('const placeholder = "model-alpha";').length).toBe(0);
  });

  it("finds no group, tier or model name in src/ (outside test files)", () => {
    const srcDir = path.resolve(import.meta.dirname, "..");
    const files = collectProductionAndFixtureFiles(srcDir);
    expect(files.length).toBeGreaterThan(20);

    const allViolations: { file: string; violation: string }[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const hits = scanText(content);
      for (const h of hits) {
        allViolations.push({ file: path.relative(srcDir, file), violation: h });
      }
    }
    expect(allViolations).toEqual([]);
  });
});

// T7.14 fix: one resolution path for the MCP server and queue admission, and config-to-adapter id mapping.
describe("modelGroupsOf and groupMembersFor (T7.14; FR-RTE-11, LLD §17.7)", () => {
  const raw: ModelGroupsConfigInput = { cheap: { members: [{ provider: "claude-code", model: "haiku-x" }] } };

  it("takes each fallback only when the one before it is absent, reaching the config path", () => {
    const { configPath, cleanup } = makeTempConfig({ model_groups: raw });
    try {
      expect(modelGroupsOf({ modelGroups: {}, model_groups: raw, configPath })).toEqual({});
      expect(modelGroupsOf({ model_groups: raw })).toEqual(resolveModelGroups(raw));
      expect(modelGroupsOf({ configPath })).toEqual(resolveModelGroups(raw));
      expect(modelGroupsOf({})).toEqual({});
    } finally {
      cleanup();
    }
  });

  it("loadConfig resolves model_groups once into ResolvedConfig.modelGroups", () => {
    const { configPath, cleanup } = makeTempConfig({ model_groups: raw });
    try {
      expect(loadConfig({ configPath }).modelGroups).toEqual(resolveModelGroups(raw));
    } finally {
      cleanup();
    }
  });

  it("matches members on adapter ids: claude-code is adapter claude; an unmapped id compares as is", () => {
    const group = { members: [...(resolveModelGroups(raw).cheap?.members ?? []), { provider: "fake", model: "f" }] };
    expect(groupMembersFor(group, "claude")).toEqual([{ provider: "claude-code", model: "haiku-x" }]);
    expect(groupMembersFor(group, "fake")).toEqual([{ provider: "fake", model: "f" }]);
    expect(groupMembersFor(group, "codex")).toEqual([]);
  });
});
