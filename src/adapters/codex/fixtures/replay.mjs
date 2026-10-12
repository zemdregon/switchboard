#!/usr/bin/env node
// Recorded-fixture replay standing in for the codex binary in tests (T2.2, FR-ADP-11, TDD §3.6).
// Needs no real provider, network or credentials and reads no files other than the fixture.
// Usage: replay.mjs <fixture.jsonl> <codex argv...>
//   <codex argv> = `--version` | `exec --help` | `exec --json ...flags [resume <id>]` (prompt on stdin)
// The fixture's first line is {"_fixture": {...}} metadata (synthetic flag, exit code, optional file write, hang,
// requireResume); the remaining lines are written to stdout verbatim, with __RESUME_ID__ replaced by the resume id.
// The synthetic version and help text below are test data, not a claim about the real CLI.
import { readFileSync, writeFileSync } from "node:fs";

// Mirrors BYPASS_FLAGS in src/adapters/audit.ts: the replay refuses to run if any appear (defence in depth).
const BYPASS = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
];

const [fixturePath, ...args] = process.argv.slice(2);
const fail = (msg, code) => {
  process.stderr.write(`replay: ${msg}\n`);
  process.exit(code);
};
if (!fixturePath) fail("missing fixture path", 64);

if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.1 (SYNTHETIC replay, not a real version)\n");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write("SYNTHETIC help: --json --sandbox <MODE> --ignore-user-config --ignore-rules\n");
  process.exit(0);
}
if (args[0] !== "exec" || !args.includes("--json")) fail(`unexpected argv: ${args.join(" ")}`, 64);
const bypass = args.filter((a) => BYPASS.some((f) => a === f || a.startsWith(`${f}=`)));
if (bypass.length > 0) fail(`bypass flag refused: ${bypass.join(" ")}`, 64);

const [metaLine, ...lines] = readFileSync(fixturePath, "utf8").split("\n");
const meta = JSON.parse(metaLine)._fixture;
if (meta?.synthetic !== true) fail("fixture metadata missing", 64);

const r = args.indexOf("resume");
const resumeId = r >= 0 ? args[r + 1] : undefined;
if (meta.requireResume && !resumeId) fail("resume fixture invoked without `resume <id>`", 64);

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  prompt += c;
});
process.stdin.on("end", () => {
  if (prompt.trim() === "") fail("no prompt on stdin", 65);
  if (meta.write) writeFileSync(meta.write.path, meta.write.content); // relative to cwd (the run worktree)
  for (const line of lines) {
    if (line === "") continue;
    process.stdout.write(`${resumeId ? line.replaceAll("__RESUME_ID__", resumeId) : line}\n`);
  }
  if (meta.hang) {
    if (meta.hang === "ignore_term") process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = meta.exit ?? 0;
});
