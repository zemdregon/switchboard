#!/usr/bin/env node
// Checks the documentation set for broken relative links, broken heading
// anchors, undefined requirement IDs, roadmap/SRS milestone mismatches,
// roadmap task status markers (NFR-MAINT-04, T8.8), and README reference
// completeness: every MCP tool in the src/mcp/schemas.ts tool-name lists and
// every top-level CLI command in the src/cli/main.ts dispatch (except
// tool-shim) must have a row in README's MCP tools and command reference
// tables.
// Usage: node scripts/check-docs.mjs   (exit code 1 on any error)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

export const VALID_TASK_STATUSES = [
  "Done",
  "Partial",
  "In progress",
  "Planned",
  "Blocked",
  "Deferred",
];

export function formatMilestoneTable(milestoneCounts, totals, order) {
  const cols = ["Done", "Partial", "In progress", "Planned", "Blocked", "Deferred"];
  const out = [];
  out.push("== Task counts by milestone ==");
  out.push(`MS  ` + cols.map((c) => c.slice(0, 8).padStart(9)).join("") + "Total".padStart(7));
  for (const m of order) {
    const c = milestoneCounts.get(m) || {};
    const sum = cols.reduce((acc, col) => acc + (c[col] || 0), 0);
    out.push(`${m.padEnd(4)}` + cols.map((col) => String(c[col] || 0).padStart(9)).join("") + String(sum).padStart(7));
  }
  const allSum = cols.reduce((acc, col) => acc + (totals[col] || 0), 0);
  out.push(`ALL ` + cols.map((col) => String(totals[col] || 0).padStart(9)).join("") + String(allSum).padStart(7));
  return out.join("\n");
}

export function checkRoadmapTaskStatuses(roadmapText, roadmapFile = "docs/ROADMAP.md") {
  const errors = [];
  const lines = roadmapText.split("\n");
  const statusRegexPart = VALID_TASK_STATUSES.join("|");
  const boldValidPattern = (e) =>
    new RegExp(`\\*\\*${e} status[^:]*:\\*{0,2}\\s*\\**(${statusRegexPart})\\b|\\*\\*${e}[ :]*\\**\\s*(${statusRegexPart})\\b`);
  const markerValidPattern = new RegExp(`\\*\\*Status:?\\*?\\*?:? ?\\**(${statusRegexPart})\\b|\\*Status:\\*\\s*\\**(${statusRegexPart})\\b`);
  const markerAnyPattern = /(?:\*\*Status:?\*?\*?:? ?\**|\*Status:\*\s*\*+)([A-Za-z][A-Za-z0-9_-]*)/;

  let cur = null;
  const sec = new Map();
  const ids = [];
  const firstRows = new Map();

  for (const l of lines) {
    const mMilestone = /^### 6\.\d+\s+(M\d+)/.exec(l);
    if (mMilestone) cur = mMilestone[1];
    if (l.startsWith("## 7.")) cur = null;
    const mTask = /^\|\s*(T\d+\.\d+[a-z]?)\s*\|/.exec(l);
    if (mTask && cur && !sec.has(mTask[1])) {
      const id = mTask[1];
      sec.set(id, cur);
      ids.push(id);
      firstRows.set(id, l);
    }
  }

  const res = {};
  for (const t of ids) {
    const e = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let st = null;
    let unknownCandidate = null;

    // 1. Whole-file bold-mention (later mentions win)
    const bValid = boldValidPattern(e);
    for (const l of lines) {
      const m = bValid.exec(l);
      if (m) {
        st = m[1] || m[2];
      }
    }

    // 2. Row marker in first occurrence row
    if (!st) {
      const row = firstRows.get(t);
      const rowNoCode = row.replace(/`[^`]*`/g, "");
      const mValid = markerValidPattern.exec(rowNoCode);
      if (mValid) {
        st = mValid[1] || mValid[2];
        unknownCandidate = null;
      } else {
        const mAny = markerAnyPattern.exec(rowNoCode);
        if (mAny) {
          const raw = mAny[1].trim().split(/[\s*(]/)[0];
          if (!VALID_TASK_STATUSES.includes(raw)) {
            unknownCandidate = raw;
          }
        }
      }
    }

    if (st) {
      res[t] = st;
    } else if (unknownCandidate) {
      errors.push(`${roadmapFile}: task ${t} in ${sec.get(t)} has unknown status "${unknownCandidate}"`);
    } else {
      errors.push(`${roadmapFile}: task ${t} in ${sec.get(t)} missing status marker`);
    }
  }

  const order = [...new Set(sec.values())].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const milestoneCounts = new Map();
  const totals = {};
  for (const s of VALID_TASK_STATUSES) totals[s] = 0;

  for (const m of order) {
    const c = {};
    for (const s of VALID_TASK_STATUSES) c[s] = 0;
    for (const t of ids) {
      if (sec.get(t) === m && res[t]) {
        c[res[t]] = (c[res[t]] || 0) + 1;
        totals[res[t]] = (totals[res[t]] || 0) + 1;
      }
    }
    milestoneCounts.set(m, c);
  }

  const table = formatMilestoneTable(milestoneCounts, totals, order);

  return {
    errors,
    ids,
    sec,
    statuses: res,
    milestoneCounts,
    totals,
    order,
    table,
  };
}

/** Tool-name lists published by src/mcp/schemas.ts (the check reads them all). */
export const README_TOOL_LISTS = [
  "TOOL_NAMES",
  "PROJECT_TOOL_NAMES",
  "SEARCH_TOOL_NAMES",
  "WORK_QUEUE_TOOL_NAMES",
  "SKILL_TOOL_NAMES",
  "PUBLISH_TOOL_NAMES",
];

/** Every tool name in the `export const <LIST> = [...]` arrays of the schemas source text. */
export function extractToolNames(schemasText) {
  const out = [];
  for (const name of README_TOOL_LISTS) {
    const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`).exec(schemasText);
    if (!m) continue;
    for (const q of m[1].matchAll(/"([^"]+)"/g)) out.push(q[1]);
  }
  return out;
}

/** Every top-level command of the `switch (cmd)` dispatch in the CLI source text, except tool-shim. */
export function extractCliCommands(mainText) {
  const start = mainText.indexOf("switch (cmd)");
  const body = start === -1 ? mainText : mainText.slice(start);
  const out = [];
  for (const m of body.matchAll(/case "([^"]+)":/g)) {
    if (m[1] === "tool-shim") continue;
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The body lines of the last section titled `heading` whose text contains a
 * table headed by `headerPattern`. README has two "### MCP tools" sections (a
 * profile matrix and the reference table); the header pattern picks the table.
 */
export function findReadmeTable(readmeText, heading, headerPattern) {
  const title = heading.replace(/^#+\s*/, "");
  const sections = [];
  let cur = null;
  for (const line of readmeText.split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (cur) sections.push(cur);
      cur = { title: h[2].trim(), lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) sections.push(cur);
  const cands = sections.filter((s) => s.title === title && headerPattern.test(s.lines.join("\n")));
  return cands.length ? cands[cands.length - 1].lines.join("\n") : null;
}

/**
 * README must give every MCP tool a `| \`tool\`` row in its MCP tools table
 * and every top-level CLI command a `| \`command\`` row in its command
 * reference table. Returns error strings (empty when complete).
 */
export function checkReadmeReference(readmeText, toolNames, cliCommands, readmeFile = "README.md") {
  const errors = [];
  const mcp = findReadmeTable(readmeText, "### MCP tools", /^\|\s*Tool\s*\|/m);
  if (mcp === null) {
    errors.push(`${readmeFile}: missing MCP tools reference table`);
  } else {
    for (const t of toolNames) {
      if (!new RegExp(`^\\|\\s*\`${t}\``, "m").test(mcp)) {
        errors.push(`${readmeFile}: MCP tool \`${t}\` missing from the MCP tools table`);
      }
    }
  }
  const ref = findReadmeTable(readmeText, "### Command reference", /^\|\s*Command\s*\|/m);
  if (ref === null) {
    errors.push(`${readmeFile}: missing command reference table`);
  } else {
    for (const c of cliCommands) {
      if (!new RegExp(`^\\|\\s*\`${c}\\b`, "m").test(ref)) {
        errors.push(`${readmeFile}: CLI command \`${c}\` missing from the command reference table`);
      }
    }
  }
  return errors;
}

export function runDocsCheck({ roadmapPathOverride, taskStatusesOnly = false } = {}) {
  const errors = [];
  const err = (file, msg) => errors.push(`${relative(root, file)}: ${msg}`);

  const targetRoadmap = roadmapPathOverride ? resolve(roadmapPathOverride) : join(root, "docs/ROADMAP.md");

  if (taskStatusesOnly) {
    if (!existsSync(targetRoadmap)) {
      console.error(`Roadmap missing at ${targetRoadmap}`);
      process.exit(1);
    }
    const result = checkRoadmapTaskStatuses(readFileSync(targetRoadmap, "utf8"), relative(root, targetRoadmap));
    if (result.table) console.log(result.table);
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      console.error(`\n${result.errors.length} task status error(s).`);
      process.exit(1);
    }
    return result;
  }

  function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (name.endsWith(".md")) out.push(p);
    }
    return out;
  }

  const stripCode = (text) => text.replace(/```[\s\S]*?```/g, "");

  function slug(heading) {
    return heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/ /g, "-");
  }

  const anchorCache = new Map();
  function anchors(file) {
    if (!anchorCache.has(file)) {
      const seen = new Map();
      const set = new Set();
      for (const line of stripCode(readFileSync(file, "utf8")).split("\n")) {
        const m = /^#{1,6}\s+(.*)$/.exec(line);
        if (!m) continue;
        let s = slug(m[1]);
        const n = seen.get(s) ?? 0;
        seen.set(s, n + 1);
        if (n > 0) s = `${s}-${n}`;
        set.add(s);
      }
      anchorCache.set(file, set);
    }
    return anchorCache.get(file);
  }

  const files = walk(root);

  // 1. Links and anchors.
  for (const file of files) {
    const text = stripCode(readFileSync(file, "utf8")).replace(/`[^`\n]*`/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue; // external URL
      const [path, anchor] = target.split("#");
      const dest = path ? resolve(dirname(file), path) : file;
      if (!existsSync(dest)) {
        err(file, `broken link ${target}`);
        continue;
      }
      if (anchor && dest.endsWith(".md") && !anchors(dest).has(anchor)) {
        err(file, `missing anchor #${anchor} in ${relative(root, dest)}`);
      }
    }
  }

  // 2. Requirement IDs: defined in the SRS, referenced anywhere.
  const srsPath = join(root, "docs/requirements/SRS.md");
  const ID = /\b(?:FR|NFR)-[A-Z]+-\d{2}\b/g;
  const defined = new Map(); // id -> { priority, milestone }
  if (existsSync(srsPath)) {
    for (const line of readFileSync(srsPath, "utf8").split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 4 || !/^(FR|NFR)-[A-Z]+-\d{2}$/.test(cells[1])) continue;
      const priority = cells.find((c) => /^(Must|Should|Could|Deferred|Withdrawn)$/.test(c));
      const milestone = cells[cells.length - 2];
      if (defined.has(cells[1])) err(srsPath, `duplicate requirement ${cells[1]}`);
      defined.set(cells[1], { priority, milestone });
      if (!priority) err(srsPath, `${cells[1]} has no priority`);
      if (priority === "Must" && !/M\d+/.test(milestone)) {
        err(srsPath, `${cells[1]} is Must but has no delivery milestone`);
      }
    }
  } else {
    err(srsPath, "SRS missing");
  }
  for (const file of files) {
    if (file.includes("/docs/research/")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(ID)) {
      if (!defined.has(m[0])) err(file, `undefined requirement ID ${m[0]}`);
    }
  }

  // Expand "FR-WS-01–06, 08" style lists into full IDs.
  function expandIds(cell) {
    const out = new Set();
    let prefix = null;
    for (const tok of cell.split(/,\s*/)) {
      const full = /((?:FR|NFR)-[A-Z]+)-(\d{2})(?:[–-](\d{2}))?/.exec(tok);
      const bare = /^\s*(\d{2})(?:[–-](\d{2}))?/.exec(tok);
      let from, to;
      if (full) [prefix, from, to] = [full[1], full[2], full[3]];
      else if (bare && prefix) [from, to] = [bare[1], bare[2]];
      else continue;
      for (let i = +from; i <= +(to ?? from); i++) out.add(`${prefix}-${String(i).padStart(2, "0")}`);
    }
    return out;
  }

  // 3. Roadmap milestones list every SRS requirement whose first delivery is that milestone.
  if (existsSync(targetRoadmap)) {
    const listed = new Map();
    for (const line of readFileSync(targetRoadmap, "utf8").split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (/^M\d+$/.test(cells[1] ?? "")) listed.set(cells[1], expandIds(cells[5] ?? ""));
    }
    for (const [id, { priority, milestone }] of defined) {
      if (priority === "Deferred" || priority === "Withdrawn") continue;
      const first = /M\d+/.exec(milestone ?? "")?.[0];
      if (!first) continue;
      if (!listed.get(first)?.has(id)) err(targetRoadmap, `${id} (first delivery ${first}) missing from milestone ${first} row`);
    }
    for (const [m, ids] of listed) {
      for (const id of ids) if (!defined.has(id)) err(targetRoadmap, `milestone ${m} lists undefined ${id}`);
    }
  }

  // 4. SDD traceability covers every SRS requirement.
  const sddPath = join(root, "docs/design/SDD.md");
  if (existsSync(sddPath)) {
    const sdd = readFileSync(sddPath, "utf8");
    const section = sdd.split(/^## 5\./m)[1] ?? "";
    const traced = new Set([...section.matchAll(/^\|\s*((?:FR|NFR)-[A-Z]+-\d{2})\s*\|/gm)].map((m) => m[1]));
    for (const id of defined.keys()) if (!traced.has(id)) err(sddPath, `${id} missing from traceability table`);
  }

  // 5. Roadmap task status markers (NFR-MAINT-04, T8.8).
  if (existsSync(targetRoadmap)) {
    const result = checkRoadmapTaskStatuses(readFileSync(targetRoadmap, "utf8"), relative(root, targetRoadmap));
    for (const e of result.errors) errors.push(e);
    if (result.table) {
      console.log(result.table);
    }
  }

  // 6. README reference completeness: every MCP tool in the schemas tool-name
  // lists and every top-level CLI command in the main dispatch (except
  // tool-shim) has a row in README's reference tables.
  const readmePath = join(root, "README.md");
  const schemasPath = join(root, "src/mcp/schemas.ts");
  const mainPath = join(root, "src/cli/main.ts");
  if (existsSync(readmePath) && existsSync(schemasPath) && existsSync(mainPath)) {
    const toolNames = extractToolNames(readFileSync(schemasPath, "utf8"));
    const cliCommands = extractCliCommands(readFileSync(mainPath, "utf8"));
    for (const e of checkReadmeReference(readFileSync(readmePath, "utf8"), toolNames, cliCommands)) {
      errors.push(e);
    }
  } else {
    if (!existsSync(schemasPath)) err(schemasPath, "schemas.ts missing");
    if (!existsSync(mainPath)) err(mainPath, "cli main.ts missing");
  }

  if (errors.length) {
    console.error(errors.join("\n"));
    console.error(`\n${errors.length} documentation error(s).`);
    process.exit(1);
  }
  console.log(`Docs OK: ${files.length} markdown files, ${defined.size} requirements.`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let roadmapPathOverride = null;
  let taskStatusesOnly = false;
  const arg = process.argv[2];
  if (arg) {
    if (arg === "--task-statuses-only" && process.argv[3]) {
      taskStatusesOnly = true;
      roadmapPathOverride = process.argv[3];
    } else {
      taskStatusesOnly = true;
      roadmapPathOverride = arg;
    }
  }
  runDocsCheck({ roadmapPathOverride, taskStatusesOnly });
}
