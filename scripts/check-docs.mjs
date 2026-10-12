#!/usr/bin/env node
// Checks the documentation set for broken relative links, broken heading
// anchors, undefined requirement IDs, and roadmap/SRS milestone mismatches.
// Usage: node scripts/check-docs.mjs   (exit code 1 on any error)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const errors = [];
const err = (file, msg) => errors.push(`${relative(root, file)}: ${msg}`);

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
const roadmapPath = join(root, "docs/ROADMAP.md");
if (existsSync(roadmapPath)) {
  const listed = new Map();
  for (const line of readFileSync(roadmapPath, "utf8").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (/^M\d+$/.test(cells[1] ?? "")) listed.set(cells[1], expandIds(cells[5] ?? ""));
  }
  for (const [id, { priority, milestone }] of defined) {
    if (priority === "Deferred" || priority === "Withdrawn") continue;
    const first = /M\d+/.exec(milestone ?? "")?.[0];
    if (!first) continue;
    if (!listed.get(first)?.has(id)) err(roadmapPath, `${id} (first delivery ${first}) missing from milestone ${first} row`);
  }
  for (const [m, ids] of listed) {
    for (const id of ids) if (!defined.has(id)) err(roadmapPath, `milestone ${m} lists undefined ${id}`);
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

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} documentation error(s).`);
  process.exit(1);
}
console.log(`Docs OK: ${files.length} markdown files, ${defined.size} requirements.`);
