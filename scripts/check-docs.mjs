#!/usr/bin/env node
// Checks the documentation set for broken relative links, broken heading
// anchors, undefined requirement IDs, roadmap/SRS milestone mismatches,
// and roadmap task status markers (NFR-MAINT-04, T8.8).
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
