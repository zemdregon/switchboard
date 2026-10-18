/**
 * Tests for scripts/check-docs.mjs roadmap task status markers rule (T8.8, NFR-MAINT-04).
 * Done-when: Fixture roadmaps fail for a missing and for an unknown status and pass otherwise;
 * node scripts/check-docs.mjs passes on main after the backfill and its counts equal a hand count for two milestones.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRoadmapTaskStatuses } from "./check-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-docs.mjs");

function createFixtureRoadmap(taskRows, extraLines = []) {
  return [
    "# ROADMAP fixture",
    "",
    "## 6. Milestones",
    "",
    "### 6.1 M1 Foundation: tasks",
    "",
    "| Task | Objective | References | Depends on | Done when |",
    "| --- | --- | --- | --- | --- |",
    ...taskRows,
    "",
    ...extraLines,
    "## 7. Risks, blockers and open questions",
    "",
  ].join("\n");
}

test("checkRoadmapTaskStatuses passes when all tasks have valid status markers", () => {
  const content = createFixtureRoadmap([
    "| T1.1 | Project scaffold | FR-1 | — | Empty test passes **Status: Done (2026-10-18).** |",
    "| T1.2 | Config loader | FR-2 | T1.1 | Schema test passes **Status: Planned (2026-10-18).** |",
  ]);
  const res = checkRoadmapTaskStatuses(content, "fixture.md");
  assert.equal(res.errors.length, 0);
  assert.equal(res.statuses["T1.1"], "Done");
  assert.equal(res.statuses["T1.2"], "Planned");
  assert.equal(res.milestoneCounts.get("M1").Done, 1);
  assert.equal(res.milestoneCounts.get("M1").Planned, 1);
  assert.equal(res.totals.Done, 1);
  assert.equal(res.totals.Planned, 1);
});

test("checkRoadmapTaskStatuses fails when a task is missing a status marker", () => {
  const content = createFixtureRoadmap(["| T1.1 | Project scaffold | FR-1 | — | Empty test passes without a marker |"]);
  const res = checkRoadmapTaskStatuses(content, "fixture.md");
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /task T1\.1 in M1 missing status marker/);
});

test("checkRoadmapTaskStatuses fails when a task has an unknown status value", () => {
  const content = createFixtureRoadmap([
    "| T1.1 | Project scaffold | FR-1 | — | Tests pass **Status: Unknown (2026-10-18).** |",
  ]);
  const res = checkRoadmapTaskStatuses(content, "fixture.md");
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /task T1\.1 in M1 has unknown status "Unknown"/);
});

test("checkRoadmapTaskStatuses recognizes whole-file bold mention statuses", () => {
  const content = createFixtureRoadmap(
    ["| T1.1 | Project scaffold | FR-1 | — | Tests pass |"],
    ["**T1.1 status (2026-10-18; Delegated): Done** on fakes"],
  );
  const res = checkRoadmapTaskStatuses(content, "fixture.md");
  assert.equal(res.errors.length, 0);
  assert.equal(res.statuses["T1.1"], "Done");
});

test("CLI execution on fixture roadmaps enforces status markers and exits with code 1 on errors", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "check-docs-test-"));
  try {
    const validFile = path.join(tempDir, "valid.md");
    writeFileSync(
      validFile,
      createFixtureRoadmap(["| T1.1 | Task 1 | FR-1 | — | Passes **Status: Done (2026-10-18).** |"]),
    );
    const validOut = execFileSync(process.execPath, [SCRIPT, validFile], { encoding: "utf8" });
    assert.match(validOut, /== Task counts by milestone ==/);
    assert.match(validOut, /M1\s+1/);

    const missingFile = path.join(tempDir, "missing.md");
    writeFileSync(missingFile, createFixtureRoadmap(["| T1.1 | Task 1 | FR-1 | — | Missing marker |"]));
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, missingFile], { stdio: "pipe" }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /missing status marker/);
        return true;
      },
    );

    const unknownFile = path.join(tempDir, "unknown.md");
    writeFileSync(
      unknownFile,
      createFixtureRoadmap(["| T1.1 | Task 1 | FR-1 | — | Bad status **Status: Invalid (2026-10-18).** |"]),
    );
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, unknownFile], { stdio: "pipe" }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /unknown status "Invalid"/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
