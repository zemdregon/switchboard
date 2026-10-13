#!/usr/bin/env node
// Replays a recorded (hand-written, SYNTHETIC) Claude Code stream-json fixture for adapter tests (T2.2, FR-ADP-11).
// Not a provider: it never contacts a model, the network or any credential store.
//
// Usage: replay.mjs --fixture FILE.jsonl [--exit-code N] [--write REL_PATH] [--hang] [--ignore-term] -- <claude argv>
// Lines of FILE.jsonl are written to stdout verbatim, except lines whose JSON has a "_fixture" key (provenance notes),
// which are skipped. "{{SESSION_ID}}" is replaced by the value of --resume in the claude argv, or by a default id.
// The claude argv is checked for the documented headless shape (-p, --output-format stream-json) and the prompt must
// arrive on stdin; otherwise the replay exits 64/65 so a wrong compile cannot pass silently.
import { readFileSync, writeFileSync } from "node:fs";

// A hanging scenario must outlive a controller that died (SIGKILL): ignore EPIPE instead of crashing on a late write.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const all = process.argv.slice(2);
const sep = all.indexOf("--");
const own = sep >= 0 ? all.slice(0, sep) : all;
const claude = sep >= 0 ? all.slice(sep + 1) : [];
const opt = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const fixture = opt(own, "--fixture");
if (!fixture) {
  process.stderr.write("replay: --fixture is required\n");
  process.exit(64);
}
const outputFormat = opt(claude, "--output-format");
if (!claude.includes("-p") || outputFormat !== "stream-json") {
  process.stderr.write("replay: expected claude -p --output-format stream-json\n");
  process.exit(64);
}
const sessionId = opt(claude, "--resume") ?? "00000000-0000-4000-8000-000000000001";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (prompt.trim() === "") {
    process.stderr.write("replay: no prompt on stdin\n");
    process.exit(65);
  }
  const write = opt(own, "--write");
  if (write) writeFileSync(write, "synthetic edit from replay fixture\n"); // relative to cwd, on purpose
  for (const line of readFileSync(fixture, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      if (Object.hasOwn(JSON.parse(line), "_fixture")) continue;
    } catch {
      // malformed lines are part of some fixtures and are replayed verbatim
    }
    process.stdout.write(`${line.replaceAll("{{SESSION_ID}}", sessionId)}\n`);
  }
  if (own.includes("--hang")) {
    if (own.includes("--ignore-term")) process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = Number(opt(own, "--exit-code") ?? 0);
});
