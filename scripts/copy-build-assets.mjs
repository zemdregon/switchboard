// Copies non-TypeScript runtime assets that tsc does not emit (the fake provider CLI used by `doctor` in M1).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

for (const rel of ["adapters/fake/cli.mjs"]) {
  mkdirSync(dirname(`dist/${rel}`), { recursive: true });
  copyFileSync(`src/${rel}`, `dist/${rel}`);
}
