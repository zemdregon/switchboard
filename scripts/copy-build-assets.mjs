// Copies non-TypeScript runtime assets that tsc does not emit (the fake provider CLI used by `doctor` in M1, and the compliance manifests loaded at runtime, LLD §6).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

for (const rel of [
  "adapters/fake/cli.mjs",
  "adapters/fake/acp-agent.mjs",
  "adapters/manifests/claude.json",
  "adapters/manifests/codex.json",
]) {
  mkdirSync(dirname(`dist/${rel}`), { recursive: true });
  copyFileSync(`src/${rel}`, `dist/${rel}`);
}
