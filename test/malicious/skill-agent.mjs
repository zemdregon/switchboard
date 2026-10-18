#!/usr/bin/env node
// Fake agent for the skills leg of the malicious-fixture suite (T16.11; R-69). Runs in the run worktree before the
// bundled fake CLI (src/adapters/fake/cli.mjs), which then plays its scenario with the same argv and stdin. Probes
// (`--version`, `--auth-status`, `--smoke`) go straight to the fake CLI.
//
// It looks at the native skill files the controller delivered under `.fake/skills/` and reports their names and
// SHA-256 hashes (never their text) as one `message` event `{"skill_report": {"<file>": "<sha256>"}}`. With
// SKILL_AGENT_MODE=copy (set by the test adapter) it also copies each file to `notes/copy-of-<file>`, as an agent that
// can read its skill file could (R-69); the scenario's plan then commits. It never leaves the worktree.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const probe = ["--version", "--auth-status", "--smoke"].some((f) => process.argv.includes(f));
const dir = path.join(".fake", "skills");
const report = {};
if (!probe && existsSync(dir)) {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    report[name] = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (process.env.SKILL_AGENT_MODE === "copy") {
      mkdirSync("notes", { recursive: true });
      copyFileSync(file, path.join("notes", `copy-of-${name}`));
    }
  }
}
if (!probe) {
  process.stdout.write(`${JSON.stringify({ type: "message", text: JSON.stringify({ skill_report: report }) })}\n`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, "..", "..", "src", "adapters", "fake", "cli.mjs")).href);
