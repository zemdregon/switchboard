// Pack smoke test: `npm pack` produces an installable tarball.
//
// What it does:
//   1. Runs `npm pack --json` into a temp dir (the `prepack` script rebuilds
//      `dist/` first, so this also proves the build the tarball ships works).
//   2. Asserts the file list contains `dist/cli/bin.js` and every other asset
//      the installed package needs at runtime, and contains no source, tests,
//      docs or repository metadata.
//   3. Asserts the unpacked size stays under a ceiling (catches an accidental
//      `src/` or `docs/` inclusion through a `files` regression).
//   4. `npm install`s the tarball into a second temp dir and runs the
//      installed `switchboard --help`, asserting exit 0.
//   5. Cleans up both temp dirs.
//
// The file-list rules live in `assessPackFileList`, a pure function covered by
// `test/pack-smoke.test.ts`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Package-relative paths (the `package/` tarball prefix stripped) the tarball must contain. */
export const REQUIRED_PACKAGE_FILES = [
  "package.json",
  "dist/cli/bin.js",
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

/**
 * Unpacked-size ceiling in bytes. Derived from the measured payload on
 * 2026-10-18: 610 files, 5,195,419 bytes unpacked (dist with sourcemaps plus
 * package.json, README.md, LICENSE and SECURITY.md), plus ~50% headroom for
 * normal growth: 5,195,419 * 1.5 = 7,793,129, rounded to 7,800,000. Small
 * enough that a `files` regression pulling in `src/`, `test/` or `docs/`
 * (which roughly doubles the payload) fails loudly.
 */
export const UNPACKED_SIZE_CEILING_BYTES = 7_800_000;

/**
 * Pure file-list check. `files` are tarball entry paths (npm's `--json`
 * output lists them without the `package/` prefix; the strip below keeps this
 * working if a future npm version prefixes them again). Returns one
 * human-readable error per violation (empty when the list is acceptable).
 */
export function assessPackFileList(files) {
  const errors = [];
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!files.includes(required)) errors.push(`missing required file: ${required}`);
  }
  for (const f of files) {
    if (/(^|\/)src\//.test(f)) errors.push(`must not ship sources: ${f}`);
    else if (/(^|\/)test\//.test(f)) errors.push(`must not ship tests: ${f}`);
    else if (/(^|\/)docs\//.test(f)) errors.push(`must not ship docs: ${f}`);
    else if (/(^|\/)\.github\//.test(f)) errors.push(`must not ship workflows: ${f}`);
    else if (/\.test\.[^/]+$/.test(f)) errors.push(`must not ship test files: ${f}`);
    else if (/(^|\/)(AGENTS|CLAUDE)\.md$/.test(f)) errors.push(`must not ship agent instructions: ${f}`);
  }
  return errors;
}

/** Returns an error string when `unpackedBytes` exceeds the ceiling, else null. */
export function checkUnpackedSize(unpackedBytes) {
  if (unpackedBytes > UNPACKED_SIZE_CEILING_BYTES) {
    return `unpacked size ${unpackedBytes} bytes exceeds ceiling ${UNPACKED_SIZE_CEILING_BYTES} bytes`;
  }
  return null;
}

function run(cmd, args, opts) {
  // A lifecycle child inherits the outer npm run's config as npm_config_*
  // variables; npm_config_allow_scripts would read as a CLI/env policy and
  // make npm 11 refuse the project-scoped install outright (EALLOWSCRIPTS).
  // Drop it: the throwaway install dir declares its own allowScripts.
  const env = { ...process.env, ...opts?.env };
  delete env.npm_config_allow_scripts;
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts, env });
}

function main() {
  const packDir = mkdtempSync(path.join(tmpdir(), "sb-pack-"));
  const installDir = mkdtempSync(path.join(tmpdir(), "sb-pack-install-"));
  try {
    const packOut = run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: REPO_ROOT });
    const entries = JSON.parse(packOut);
    if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0]?.files)) {
      throw new Error(`unexpected npm pack --json output: ${packOut.slice(0, 500)}`);
    }
    const entry = entries[0];
    const tarball = path.join(packDir, entry.filename);
    const files = entry.files.map((f) => f.path.replace(/^package\//, ""));
    const unpackedBytes = entry.files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    const tarballBytes = statSync(tarball).size;
    console.log(
      `tarball: ${entry.filename}: ${files.length} files, ${tarballBytes} bytes packed, ${unpackedBytes} bytes unpacked`,
    );

    const failures = assessPackFileList(files);
    const sizeError = checkUnpackedSize(unpackedBytes);
    if (sizeError !== null) failures.push(sizeError);
    if (failures.length > 0) {
      for (const f of failures) console.error(`pack-smoke: ${f}`);
      throw new Error(`pack file list rejected (${failures.length} problem(s))`);
    }

    try {
      // npm 11 denies install scripts in project-scoped installs by default;
      // better-sqlite3 needs its install script (prebuilt binary or compile).
      // Opt in inside the throwaway install dir only, never in user config:
      // the install below runs with cwd set to the throwaway dir so its
      // package.json (with exactly this allowlist) is the project npm reads.
      // Kept to exactly the dependency that needs it: anything else asking
      // for an install script fails loudly here instead of running silently.
      writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({
          name: "sb-pack-smoke",
          version: "1.0.0",
          private: true,
          allowScripts: { "better-sqlite3": true },
        }),
      );
      run("npm", ["install", "--no-save", "--no-audit", "--no-fund", tarball], {
        cwd: installDir,
      });
    } catch (e) {
      throw new Error(
        `npm install of ${entry.filename} failed. The tarball requires its dependencies at install time ` +
          `(notably better-sqlite3, which needs a prebuilt binary for this platform or a C++ compiler). ` +
          `Install output: ${(e.stderr ?? e.message ?? String(e)).toString().slice(-2000)}`,
      );
    }
    const installedBin = path.join(installDir, "node_modules", ".bin", "switchboard");
    // Only --help is exercised: the CLI has no --version flag, and adding
    // one is out of scope for this packaging task.
    const help = run(installedBin, ["--help"]);
    if (!help.includes("Usage: switchboard")) {
      throw new Error(`installed switchboard --help did not print usage (first 200 chars: ${help.slice(0, 200)})`);
    }
    console.log(`pack-smoke: PASS (${entry.filename} installs and --help exits 0)`);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
}

// Only run when executed directly (`node scripts/pack-smoke.mjs` /
// `npm run pack:smoke`); importing the pure helpers (e.g. from the vitest
// suite) must not trigger a pack + install.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
