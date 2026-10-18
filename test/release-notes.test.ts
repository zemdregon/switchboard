/**
 * Tests for scripts/release-notes.mjs (release workflow): the extractor finds
 * a version's section in a fixture changelog, reports a missing version with a
 * non-zero exit, handles the Unreleased section, and the repository CHANGELOG
 * keeps an Unreleased section for the workflow to read.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "release-notes.mjs");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

const releaseNotesMod = await import(`file://${SCRIPT}`);
const { extractReleaseNotes } = releaseNotesMod;

function createFixtureChangelog(): string {
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

describe("release-notes extractor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "switchboard-release-notes-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds a released version section without neighbours or link definitions", () => {
    const notes = extractReleaseNotes(createFixtureChangelog(), "1.2.3");
    expect(notes).toMatch(/A released fix\./);
    expect(notes).toMatch(/Another released fix\./);
    expect(notes).not.toMatch(/An older fix\./);
    expect(notes).not.toMatch(/Something not yet released\./);
    expect(notes).not.toMatch(/example\.com/);
  });

  it("finds the Unreleased section", () => {
    const notes = extractReleaseNotes(createFixtureChangelog(), "Unreleased");
    expect(notes).toMatch(/Something not yet released\./);
    expect(notes).not.toMatch(/A released fix\./);
  });

  it("returns null for a missing version", () => {
    expect(extractReleaseNotes(createFixtureChangelog(), "9.9.9")).toBeNull();
  });

  it("CLI prints the section and exits non-zero for a missing version", () => {
    const changelogFile = path.join(tempDir, "CHANGELOG.md");
    writeFileSync(changelogFile, createFixtureChangelog());

    const found = execFileSync(process.execPath, [SCRIPT, "1.2.3", "--changelog", changelogFile], {
      encoding: "utf8",
    });
    expect(found).toMatch(/A released fix\./);
    expect(found).not.toMatch(/An older fix\./);

    let missingErr: { status?: number; stderr?: string } | null = null;
    try {
      execFileSync(process.execPath, [SCRIPT, "9.9.9", "--changelog", changelogFile], { stdio: "pipe" });
    } catch (err) {
      missingErr = err as { status?: number; stderr?: string };
    }
    expect(missingErr?.status).toBe(1);
    expect(String(missingErr?.stderr)).toContain('no section for version "9.9.9"');
  });

  it("repository CHANGELOG.md keeps an Unreleased section", () => {
    const text = readFileSync(CHANGELOG, "utf8");
    const notes = extractReleaseNotes(text, "Unreleased");
    expect(notes).not.toBeNull();
    expect(notes).toMatch(/M1/);
  });
});
