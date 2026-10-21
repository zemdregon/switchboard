/**
 * Tests for scripts/check-docs.mjs task status markers rule (T8.8, NFR-MAINT-04).
 * Done-when: fixture roadmaps fail for a missing and for an unknown status and pass otherwise;
 * node scripts/check-docs.mjs passes on main after the backfill and its counts equal a hand count
 * for two milestones.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-docs.mjs");
const ROADMAP = path.join(ROOT, "docs", "ROADMAP.md");

const checkDocsMod = await import(`file://${SCRIPT}`);
const { checkRoadmapTaskStatuses, VALID_TASK_STATUSES } = checkDocsMod;

function createFixtureRoadmap(taskRows: string[], extraLines: string[] = []): string {
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

describe("task status markers rule (T8.8, NFR-MAINT-04)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "switchboard-check-docs-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("fixture roadmaps pass when all tasks have valid §6 status markers", () => {
    const content = createFixtureRoadmap([
      "| T1.1 | Project scaffold | FR-1 | — | Empty test passes **Status: Done (2026-10-18).** |",
      "| T1.2 | Config loader | FR-2 | T1.1 | Schema test passes **Status: Planned (2026-10-18).** |",
      "| T1.3 | SQLite ledger | FR-3 | T1.2 | Migration test passes **Status: Partial (2026-10-18).** |",
    ]);
    const res = checkRoadmapTaskStatuses(content, "fixture.md");
    expect(res.errors).toEqual([]);
    expect(res.statuses["T1.1"]).toBe("Done");
    expect(res.statuses["T1.2"]).toBe("Planned");
    expect(res.statuses["T1.3"]).toBe("Partial");

    const m1 = res.milestoneCounts.get("M1");
    expect(m1.Done).toBe(1);
    expect(m1.Planned).toBe(1);
    expect(m1.Partial).toBe(1);
    expect(res.totals.Done).toBe(1);
    expect(res.totals.Planned).toBe(1);
    expect(res.totals.Partial).toBe(1);
  });

  it("fixture roadmaps fail for a missing status marker", () => {
    const content = createFixtureRoadmap([
      "| T1.1 | Project scaffold | FR-1 | — | Empty test passes without marker |",
      "| T1.2 | Config loader | FR-2 | T1.1 | Schema test passes **Status: Done (2026-10-18).** |",
    ]);
    const res = checkRoadmapTaskStatuses(content, "fixture.md");
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain("task T1.1 in M1 missing status marker");
  });

  it("fixture roadmaps fail for an unknown status value", () => {
    const content = createFixtureRoadmap([
      "| T1.1 | Project scaffold | FR-1 | — | Tests pass **Status: BogusStatus (2026-10-18).** |",
    ]);
    const res = checkRoadmapTaskStatuses(content, "fixture.md");
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain('task T1.1 in M1 has unknown status "BogusStatus"');
  });

  it("fixture roadmaps recognize all defined §6 status values", () => {
    expect(VALID_TASK_STATUSES).toEqual(["Done", "Partial", "In progress", "Planned", "Blocked", "Deferred"]);
    const taskRows = VALID_TASK_STATUSES.map(
      (st: string, idx: number) =>
        `| T1.${idx + 1} | Task ${idx + 1} | FR-1 | — | Passes **Status: ${st} (2026-10-18).** |`,
    );
    const content = createFixtureRoadmap(taskRows);
    const res = checkRoadmapTaskStatuses(content, "fixture.md");
    expect(res.errors).toEqual([]);
    for (const [idx, st] of VALID_TASK_STATUSES.entries()) {
      expect(res.statuses[`T1.${idx + 1}`]).toBe(st);
    }
  });

  it("CLI execution on fixture roadmaps exits 0 on valid and 1 on missing/unknown", () => {
    const validFile = path.join(tempDir, "valid.md");
    writeFileSync(
      validFile,
      createFixtureRoadmap(["| T1.1 | Task 1 | FR-1 | — | Passes **Status: Done (2026-10-18).** |"]),
    );
    const validOut = execFileSync(process.execPath, [SCRIPT, validFile], { encoding: "utf8" });
    expect(validOut).toContain("== Task counts by milestone ==");
    expect(validOut).toMatch(/M1\s+1/);

    const missingFile = path.join(tempDir, "missing.md");
    writeFileSync(missingFile, createFixtureRoadmap(["| T1.1 | Task 1 | FR-1 | — | No marker |"]));
    let missingErr: { status?: number; stderr?: string } | null = null;
    try {
      execFileSync(process.execPath, [SCRIPT, missingFile], { stdio: "pipe" });
    } catch (err) {
      missingErr = err as { status?: number; stderr?: string };
    }
    expect(missingErr?.status).toBe(1);
    expect(String(missingErr?.stderr)).toContain("missing status marker");

    const unknownFile = path.join(tempDir, "unknown.md");
    writeFileSync(
      unknownFile,
      createFixtureRoadmap(["| T1.1 | Task 1 | FR-1 | — | Bad status **Status: Invalid (2026-10-18).** |"]),
    );
    let unknownErr: { status?: number; stderr?: string } | null = null;
    try {
      execFileSync(process.execPath, [SCRIPT, unknownFile], { stdio: "pipe" });
    } catch (err) {
      unknownErr = err as { status?: number; stderr?: string };
    }
    expect(unknownErr?.status).toBe(1);
    expect(String(unknownErr?.stderr)).toContain('unknown status "Invalid"');
  });

  it("node scripts/check-docs.mjs passes on current repository and milestone counts match hand counts for M1 and M7", () => {
    const roadmapText = readFileSync(ROADMAP, "utf8");
    const res = checkRoadmapTaskStatuses(roadmapText, "docs/ROADMAP.md");
    expect(res.errors).toEqual([]);
    expect(res.ids.length).toBe(307);

    // Hand count verification for Milestone 1 (M1):
    // 11 tasks (T1.1 through T1.11), all 11 are Done, 0 Partial, 0 Planned, 0 Blocked, 0 Deferred.
    const m1 = res.milestoneCounts.get("M1");
    expect(m1).toBeDefined();
    expect(m1.Done).toBe(11);
    expect(m1.Partial).toBe(0);
    expect(m1.Planned).toBe(0);
    expect(m1.Blocked).toBe(0);
    expect(m1.Deferred).toBe(0);
    expect(m1["In progress"]).toBe(0);

    // Hand count verification for Milestone 7 (M7):
    // 18 tasks (T7.0 through T7.17), all 18 are Done, 0 Partial, 0 Planned, 0 Blocked, 0 Deferred.
    const m7 = res.milestoneCounts.get("M7");
    expect(m7).toBeDefined();
    expect(m7.Done).toBe(18);
    expect(m7.Partial).toBe(0);
    expect(m7.Planned).toBe(0);
    expect(m7.Blocked).toBe(0);
    expect(m7.Deferred).toBe(0);
    expect(m7["In progress"]).toBe(0);

    // Full CLI invocation on documentation set
    const fullOut = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(fullOut).toContain("== Task counts by milestone ==");
    expect(fullOut).toContain("Docs OK:");
  });
});
