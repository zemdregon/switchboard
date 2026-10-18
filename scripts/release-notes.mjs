#!/usr/bin/env node
// Extracts one version's section from CHANGELOG.md (Keep a Changelog format)
// for the GitHub release workflow.
//
// Usage: node scripts/release-notes.mjs <version> [--changelog <path>]
//   <version> is a section name like "1.2.3" (matches "## [1.2.3] ...") or
//   "Unreleased" (matches "## [Unreleased]"). The section body is printed to
//   stdout. Exits 1 when the section is missing or empty.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the body of the `## [<version>]` section of a Keep a Changelog
 * document, or null when no such section exists. Markdown link-reference
 * definitions (the `[x.y.z]: url` lines at the bottom of the file) are not
 * release notes and are excluded.
 */
export function extractReleaseNotes(changelogText, version) {
  const header = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s|$)`, "m");
  const match = header.exec(changelogText);
  if (match === null) {
    return null;
  }
  const rest = changelogText.slice(match.index + match[0].length);
  const next = /^## \S/m.exec(rest);
  const body = (next === null ? rest : rest.slice(0, next.index))
    .split("\n")
    .filter((line) => !/^\[[^\]]+\]:\s*\S/.test(line))
    .join("\n")
    .trim();
  return body === "" ? null : body;
}

function usage() {
  return "Usage: node scripts/release-notes.mjs <version> [--changelog <path>]";
}

function main(argv) {
  const args = argv.slice(2);
  const version = args[0];
  if (version === undefined || version === "" || version.startsWith("-")) {
    console.error(usage());
    return 1;
  }
  let changelogPath = resolve(ROOT, "CHANGELOG.md");
  const flagIndex = args.indexOf("--changelog");
  if (flagIndex !== -1) {
    const flagValue = args[flagIndex + 1];
    if (flagValue === undefined || flagValue === "") {
      console.error(usage());
      return 1;
    }
    changelogPath = resolve(flagValue);
  }
  let text;
  try {
    text = readFileSync(changelogPath, "utf8");
  } catch (error) {
    console.error(`cannot read changelog ${changelogPath}: ${error.message}`);
    return 1;
  }
  const notes = extractReleaseNotes(text, version);
  if (notes === null) {
    console.error(`no section for version "${version}" in ${changelogPath}`);
    return 1;
  }
  console.log(notes);
  return 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const exitCode = main(process.argv);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
