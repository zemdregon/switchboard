// Copies non-TypeScript runtime assets that tsc does not emit (the fake provider CLI used by `doctor` in M1, and the compliance manifests loaded at runtime, LLD §6).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

for (const rel of [
  "adapters/fake/cli.mjs",
  "adapters/fake/acp-agent.mjs",
  "adapters/manifests/antigravity.json",
  "adapters/manifests/claude.json",
  "adapters/manifests/codex.json",
  "adapters/manifests/cursor.json",
  "adapters/manifests/grok.json",
  "adapters/manifests/kimi.json",
  "adapters/manifests/muse.json",
  "adapters/manifests/opencode.json",
]) {
  mkdirSync(dirname(`dist/${rel}`), { recursive: true });
  copyFileSync(`src/${rel}`, `dist/${rel}`);
}
