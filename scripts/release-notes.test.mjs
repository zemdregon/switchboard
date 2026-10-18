/**
 * Tests for scripts/release-notes.mjs (release workflow): the extractor finds
 * a version's section, reports a missing version with a non-zero exit, and
 * handles the Unreleased section.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractReleaseNotes } from "./release-notes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "release-notes.mjs");

function createFixtureChangelog() {
  return [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Something not yet released.",
    "",
    "## [1.2.3] - 2026-10-01",
    "",
    "### Fixed",
    "",
    "- A released fix.",
    "",
    "- Another released fix.",
    "",
    "## [1.2.2] - 2026-09-01",
    "",
    "### Fixed",
    "",
    "- An older fix.",
    "",
    "[Unreleased]: https://example.com/compare/v1.2.3...HEAD",
    "[1.2.3]: https://example.com/compare/v1.2.2...v1.2.3",
    "[1.2.2]: https://example.com/releases/tag/v1.2.2",
    "",
  ].join("\n");
}

test("extractReleaseNotes finds a released version section", () => {
  const notes = extractReleaseNotes(createFixtureChangelog(), "1.2.3");
  assert.match(notes, /A released fix\./);
  assert.match(notes, /Another released fix\./);
  assert.doesNotMatch(notes, /An older fix\./);
  assert.doesNotMatch(notes, /Something not yet released\./);
});

test("extractReleaseNotes excludes link-reference definitions", () => {
  const notes = extractReleaseNotes(createFixtureChangelog(), "1.2.2");
  assert.match(notes, /An older fix\./);
  assert.doesNotMatch(notes, /example\.com/);
});

test("extractReleaseNotes finds the Unreleased section", () => {
  const notes = extractReleaseNotes(createFixtureChangelog(), "Unreleased");
  assert.match(notes, /Something not yet released\./);
  assert.doesNotMatch(notes, /A released fix\./);
});

test("extractReleaseNotes returns null for a missing version", () => {
  assert.equal(extractReleaseNotes(createFixtureChangelog(), "9.9.9"), null);
});

test("CLI prints the section and exits non-zero for a missing version", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "release-notes-test-"));
  try {
    const changelogFile = path.join(tempDir, "CHANGELOG.md");
    writeFileSync(changelogFile, createFixtureChangelog());

    const found = execFileSync(process.execPath, [SCRIPT, "1.2.3", "--changelog", changelogFile], {
      encoding: "utf8",
    });
    assert.match(found, /A released fix\./);
    assert.doesNotMatch(found, /An older fix\./);

    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, "9.9.9", "--changelog", changelogFile], { stdio: "pipe" }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /no section for version "9\.9\.9"/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
