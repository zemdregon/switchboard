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
import { checkReadmeReference, checkRoadmapTaskStatuses, extractCliCommands, extractToolNames } from "./check-docs.mjs";

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

test("extractToolNames reads every tool-name list in the schemas source", () => {
  const schemas = [
    "export const TOOL_NAMES = [",
    '  "delegate_task",',
    '  "get_run",',
    "] as const;",
    'export const PROJECT_TOOL_NAMES = ["create_project", "delete_project"] as const;',
    'export const SEARCH_TOOL_NAMES = ["search_project_context"] as const;',
    'export const WORK_QUEUE_TOOL_NAMES = ["enqueue_work"] as const;',
    'export const SKILL_TOOL_NAMES = ["list_skills", "get_skill"] as const;',
  ].join("\n");
  assert.deepEqual(extractToolNames(schemas), [
    "delegate_task",
    "get_run",
    "create_project",
    "delete_project",
    "search_project_context",
    "enqueue_work",
    "list_skills",
    "get_skill",
  ]);
});

test("extractCliCommands reads the dispatch cases and skips tool-shim", () => {
  const main = [
    'if (argv[0] === "tool-shim") {',
    "  return runToolShim(argv.slice(1), io);",
    "}",
    "switch (cmd) {",
    '  case "serve": {',
    "    return 0;",
    "  }",
    '  case "approve":',
    '  case "deny": {',
    "    return 0;",
    "  }",
    "  default:",
    "}",
  ].join("\n");
  assert.deepEqual(extractCliCommands(main), ["serve", "approve", "deny"]);
});

const REFERENCE_README = [
  "# Title",
  "",
  "## Run as an MCP server",
  "",
  "### MCP tools",
  "",
  "| Tool | Family | What it does | Availability |",
  "| --- | --- | --- | --- |",
  "| `get_run` | run | One run. | Always |",
  "| `steer_run` | control | A note. | Always |",
  "",
  "### Command reference",
  "",
  "| Command | Purpose | Key options | Details |",
  "| --- | --- | --- | --- |",
  "| `serve --client <id>` | The server. | `--client` | [Server](#run-as-an-mcp-server) |",
  "| `runs list` | Runs. | `--limit` | [Ops](#operator-commands) |",
  "",
  "## Next",
  "",
].join("\n");

test("checkReadmeReference passes when every tool and command has a row", () => {
  assert.deepEqual(
    checkReadmeReference(REFERENCE_README, ["get_run", "steer_run"], ["serve", "runs"], "README.md"),
    [],
  );
});

test("checkReadmeReference failure names the missing MCP tool", () => {
  const errors = checkReadmeReference(REFERENCE_README, ["get_run", "missing_tool"], ["serve"], "README.md");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /MCP tool `missing_tool` missing from the MCP tools table/);
});

test("checkReadmeReference failure names the missing CLI command", () => {
  const errors = checkReadmeReference(REFERENCE_README, ["get_run"], ["serve", "consent"], "README.md");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CLI command `consent` missing from the command reference table/);
});

test("checkReadmeReference ignores the control-plane MCP profile matrix", () => {
  const readme = [
    "# Title",
    "",
    "## Control plane (milestone 14)",
    "",
    "### MCP tools",
    "",
    "| Surface | Orchestrator (default) |",
    "| --- | --- |",
    "| `get_digest`, `list_runs` | yes |",
    "",
    ...REFERENCE_README.split("\n").slice(1),
  ].join("\n");
  assert.deepEqual(checkReadmeReference(readme, ["get_run"], ["serve", "runs"], "README.md"), []);
});
