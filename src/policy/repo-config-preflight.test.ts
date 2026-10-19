import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REPO_CONFIG_MAX_ENTRIES,
  REPO_CONFIG_MAX_VISITED,
  repoConfigKind,
  scanRepoConfig,
} from "./repo-config-preflight.js";

const CANARY = "SB-CANARY-REPO-CONFIG-7f3a";
let root: string;
let repo: string;

const put = (rel: string, body = `${CANARY}\n`) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), body);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-repocfg-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scanRepoConfig (T3.25, FR-POL-11, LLD §20.10)", () => {
  it("lists each FR-POL-11 path with its kind and no content", () => {
    put(".claude/settings.json", `{"env":{"ANTHROPIC_BASE_URL":"http://${CANARY}"}}\n`);
    put(".mcp.json");
    put(".cursor/mcp.json");
    put(".vscode/tasks.json");
    put(".vscode/settings.json");
    put(".envrc");
    put(".env", `OPENAI_BASE_URL=http://${CANARY}\n`);
    put(".env.local");
    put(".codex/config.toml");
    put("opencode.json");
    put("README.md");
    put("src/index.ts");
    const seen = scanRepoConfig(repo);
    expect(seen).toEqual({
      entries: [
        { path: ".claude", kind: "claude_config" },
        { path: ".cursor", kind: "cursor_config" },
        { path: ".env", kind: "env_file" },
        { path: ".env.local", kind: "env_file" },
        { path: ".envrc", kind: "envrc" },
        { path: ".mcp.json", kind: "mcp_config" },
        { path: "opencode.json", kind: "provider_config" },
        { path: ".codex/config.toml", kind: "provider_config" },
        { path: ".vscode/tasks.json", kind: "vscode_tasks" },
      ],
      truncated: false,
    });
    expect(JSON.stringify(seen)).not.toContain(CANARY);
  });

  it("finds nested configuration and skips .git/ and node_modules/", () => {
    put("packages/web/.env");
    put("packages/web/.vscode/tasks.json");
    put(".git/.env");
    put("node_modules/pkg/.mcp.json");
    expect(scanRepoConfig(repo).entries).toEqual([
      { path: "packages/web/.env", kind: "env_file" },
      { path: "packages/web/.vscode/tasks.json", kind: "vscode_tasks" },
    ]);
  });

  it("does not follow symlinks: a link is listed by name and never entered", () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, ".mcp.json"), `${CANARY}\n`);
    writeFileSync(path.join(outside, "secret.env"), `${CANARY}\n`);
    symlinkSync(outside, path.join(repo, "linked"));
    symlinkSync(path.join(outside, "secret.env"), path.join(repo, ".env"));
    symlinkSync(outside, path.join(repo, ".claude"));
    const seen = scanRepoConfig(repo);
    expect(seen.entries).toEqual([
      { path: ".claude", kind: "claude_config", symlink: true },
      { path: ".env", kind: "env_file", symlink: true },
    ]);
    expect(JSON.stringify(seen)).not.toContain("linked");
    expect(JSON.stringify(seen)).not.toContain(CANARY);
  });

  it("caps the depth at four path segments and marks the walk truncated", () => {
    put("a/b/c/.env");
    put("a/b/c/d/.env");
    expect(scanRepoConfig(repo)).toEqual({ entries: [{ path: "a/b/c/.env", kind: "env_file" }], truncated: true });
  });

  it("caps the entries at 200 and marks the walk truncated", () => {
    for (let i = 0; i < REPO_CONFIG_MAX_ENTRIES + 20; i++) put(`p${String(i).padStart(3, "0")}/.env`, "");
    const seen = scanRepoConfig(repo);
    expect(seen.entries).toHaveLength(REPO_CONFIG_MAX_ENTRIES);
    expect(seen.truncated).toBe(true);
  });

  it("caps the directory entries visited at 5,000 and marks the walk truncated", () => {
    for (let i = 0; i < REPO_CONFIG_MAX_VISITED + 10; i++) writeFileSync(path.join(repo, `f${i}`), "");
    put("zz/.env");
    expect(scanRepoConfig(repo)).toEqual({ entries: [], truncated: true });
  });

  it("returns an empty record for a directory it cannot read", () => {
    expect(scanRepoConfig(path.join(root, "missing"))).toEqual({ entries: [], truncated: false });
  });

  it("classifies by name and parent only", () => {
    expect(repoConfigKind("", ".envrc")).toBe("envrc");
    expect(repoConfigKind("", ".environment")).toBeUndefined();
    expect(repoConfigKind("", "tasks.json")).toBeUndefined();
    expect(repoConfigKind(".grok", "config.toml")).toBe("provider_config");
    expect(repoConfigKind("cfg", "config.toml")).toBeUndefined();
    expect(repoConfigKind(".gemini", "settings.json")).toBe("provider_config");
  });
});
