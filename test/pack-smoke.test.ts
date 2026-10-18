import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const {
  assessPackFileList,
  checkUnpackedSize,
  REQUIRED_PACKAGE_FILES,
  UNPACKED_SIZE_CEILING_BYTES,
}: {
  assessPackFileList: (files: readonly string[]) => string[];
  checkUnpackedSize: (unpackedBytes: number) => string | null;
  REQUIRED_PACKAGE_FILES: readonly string[];
  UNPACKED_SIZE_CEILING_BYTES: number;
} = require("../scripts/pack-smoke.mjs");

const GOOD_LIST = [
  "package.json",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "dist/cli/bin.js",
  "dist/cli/main.js",
  "dist/adapters/fake/cli.mjs",
  "dist/adapters/fake/acp-agent.mjs",
  "dist/adapters/manifests/antigravity.json",
  "dist/adapters/manifests/claude.json",
  "dist/adapters/manifests/codex.json",
  "dist/adapters/manifests/cursor.json",
  "dist/adapters/manifests/grok.json",
  "dist/adapters/manifests/kimi.json",
  "dist/adapters/manifests/muse.json",
  "dist/adapters/manifests/opencode.json",
];

describe("pack-smoke file list", () => {
  it("accepts a complete runtime file list", () => {
    expect(assessPackFileList(GOOD_LIST)).toEqual([]);
  });

  it("rejects a missing runtime asset", () => {
    for (const required of REQUIRED_PACKAGE_FILES) {
      const errors = assessPackFileList(GOOD_LIST.filter((f) => f !== required));
      expect(errors, required).toContain(`missing required file: ${required}`);
    }
  });

  it("rejects sources, tests, docs, workflows and agent instructions", () => {
    const bad = [
      ...GOOD_LIST,
      "src/cli/main.ts",
      "dist/src/cli/main.js",
      "test/pack-smoke.test.ts",
      "src/adapters/fake/cli.test.mjs",
      "docs/ROADMAP.md",
      "docs/design/TDD.md",
      ".github/workflows/ci.yml",
      "AGENTS.md",
      "CLAUDE.md",
    ];
    const errors = assessPackFileList(bad);
    expect(errors).toHaveLength(9);
    expect(errors.join("\n")).toMatch(/must not ship/);
  });

  it("does not flag legitimate dist or root files", () => {
    expect(assessPackFileList([...GOOD_LIST, "dist/adapters/manifest/schema.js", "dist/skills/store.js"])).toEqual([]);
  });

  it("enforces the unpacked-size ceiling", () => {
    expect(checkUnpackedSize(UNPACKED_SIZE_CEILING_BYTES)).toBeNull();
    expect(checkUnpackedSize(UNPACKED_SIZE_CEILING_BYTES + 1)).toMatch(/exceeds ceiling/);
  });
});
